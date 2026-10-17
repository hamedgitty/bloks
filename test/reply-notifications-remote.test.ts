import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer, type ServerResponse } from "node:http";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startRemoteProxy } from "../electron/remote.mjs";
import { keyFromToken, seal } from "../server/relay-crypto.ts";
import { NoticeDelivery, noticeFor, type Notice } from "../src/lib/notify.ts";

// Real encrypted relay -> loopback proxy -> HTTP/SSE -> production consumer.
// No Electron, provider, account, external network or OS notification.
test("remote live notifications preserve freshness across both reconnect boundaries", async (t) => {
  const folder = mkdtempSync(join(tmpdir(), "bloks-notice-proxy-"));
  writeFileSync(join(folder, "index.html"), "synthetic fixture");
  const token = "synthetic-device-token", deviceId = "fixture-device";
  const key = keyFromToken(token, "mac-to-phone");
  let upstream: ServerResponse | undefined, relayConnections = 0;
  const relay = createServer((_req, res) => {
    upstream = res; relayConnections++;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: {"kind":"hello","online":true}\n\n');
  });
  await new Promise<void>(r => relay.listen(0, "127.0.0.1", r));
  const proxy = await startRemoteProxy({ relayUrl: `http://127.0.0.1:${(relay.address() as { port: number }).port}`, relayToken: "fixture", deviceId, deviceToken: token }, { staticDir: folder });
  const frames: any[] = [], notices: Notice[] = [], delivery = new NoticeDelivery();
  let watched = false, enabled = true, abort: AbortController | undefined, reading: Promise<void> | undefined;
  const wait = async (check: () => boolean, why: string) => {
    const deadline = Date.now() + 5000;
    while (!check() && Date.now() < deadline) await new Promise(r => setTimeout(r, 10));
    assert.ok(check(), why);
  };
  const disconnect = async () => { abort?.abort(); await reading; delivery.reconnect(); };
  const connect = async () => {
    abort = new AbortController();
    const response = await fetch(`http://127.0.0.1:${proxy.port}/api/events`, { signal: abort.signal });
    assert.ok(response.ok);
    const signal = abort.signal, reader = response.body!.getReader();
    reading = (async () => {
      let buffer = ""; const decoder = new TextDecoder();
      try {
        for (;;) {
          const part = await reader.read(); if (part.done) return;
          buffer += decoder.decode(part.value, { stream: true }); let cut;
          while ((cut = buffer.indexOf("\n\n")) >= 0) {
            const block = buffer.slice(0, cut); buffer = buffer.slice(cut + 2);
            if (!block.startsWith("data: ")) continue;
            const frame = JSON.parse(block.slice(6)); frames.push(frame);
            if (frame.kind === "hello") { delivery.hello(frame._seq); continue; }
            const identity = frame.kind === "reply.settled" ? `reply:${frame.threadId}:${frame.botId}:${frame.turnId}`
              : `message:${frame.threadId}:${frame.message?.card?.requestId ?? frame.message?.card?.runId ?? frame.message?.id}`;
            if (!delivery.take(frame._seq, identity)) continue;
            const notice = noticeFor(frame.message, { replySettled: frame.kind === "reply.settled", focused: watched, selectedId: "bot", threadId: "lane", bot: { id: "bot", name: "Helper", notifications: enabled } });
            if (notice) notices.push(notice);
          }
        }
      } catch (error) { if (!signal.aborted) throw error; }
    })();
  };
  const request = { kind: "message", threadId: "lane", message: { id: "request", at: 1, role: "bot", kind: "options", card: { requestId: "r", title: "Choose a date" } } };
  const result = (turnId: string) => ({ kind: "reply.settled", threadId: "lane", botId: "bot", turnId, message: { id: turnId, at: 2, role: "bot", kind: "text", text: "Report ready" } });
  const send = async (frame: unknown, payload = seal(key, deviceId, frame)) => {
    const before = frames.length;
    upstream!.write(`data: ${JSON.stringify({ kind: "frame", payload })}\n\n`);
    await wait(() => frames.length > before, "proxy did not forward the live frame");
    return payload;
  };
  try {
    await connect(); await wait(() => !!upstream && frames.some(f => f.kind === "hello"), "no initial hello");
    let encryptedRequest = "", encryptedResult = "";
    await t.test("live explicit request and settled result both notify", async () => {
      encryptedRequest = await send(request); encryptedResult = await send(result("first"));
      assert.deepEqual(notices.map(n => n.body), ["Choose a date", "Report ready"]);
    });
    await t.test("identical and resealed duplicate events cannot notify twice", async () => {
      await send(request, encryptedRequest); await send(result("first"), encryptedResult);
      await send(request); await send(result("first")); assert.equal(notices.length, 2);
    });
    await t.test("watched receipt stays consumed after attention changes", async () => {
      watched = true; await send(result("watched")); assert.equal(notices.length, 2);
      watched = false; await send(result("watched")); assert.equal(notices.length, 2);
    });
    await t.test("disabled receipt stays consumed after enabling", async () => {
      enabled = false; await send(result("disabled")); assert.equal(notices.length, 2);
      enabled = true; await send(result("disabled")); assert.equal(notices.length, 2);
    });
    await t.test("two genuine short turns with identical text both notify", async () => {
      await send(result("short-one")); await send(result("short-two")); assert.equal(notices.length, 4);
    });
    await t.test("renderer reconnect hello excludes old work and permits fresh events", async () => {
      await disconnect(); const before = frames.length; await connect();
      await wait(() => frames.slice(before).some(f => f.kind === "hello"), "no renderer reconnect hello");
      await send(request, encryptedRequest); await send(result("first"));
      await send(result("watched")); await send(result("disabled")); assert.equal(notices.length, 4);
      await send(result("after-renderer")); assert.equal(notices.length, 5);
    });
    await t.test("upstream hello retains proxy freshness and consumed identities", async () => {
      const before = frames.length; upstream!.write('data: {"kind":"hello","online":true}\n\n');
      await wait(() => frames.length > before, "no forwarded upstream hello");
      await send(request); await send(result("after-renderer")); assert.equal(notices.length, 5);
      await send(result("after-hello")); assert.equal(notices.length, 6);
    });
    await t.test("actual relay reconnect does not turn replay into fresh attention", async () => {
      const before = frames.length, connections = relayConnections; upstream!.end();
      await wait(() => relayConnections > connections && frames.slice(before).some(f => f.kind === "hello"), "relay never reconnected");
      await send(request, encryptedRequest); await send(result("first"), encryptedResult);
      await send(result("after-hello")); assert.equal(notices.length, 6);
      await send(result("after-relay")); assert.equal(notices.length, 7);
    });
    assert.ok(frames.every(f => Number.isSafeInteger(f._seq)), "remote freshness must be explicit");
  } finally {
    await disconnect(); proxy.stop(); relay.closeAllConnections();
    await new Promise<void>(r => relay.close(() => r())); rmSync(folder, { recursive: true, force: true });
  }
});
