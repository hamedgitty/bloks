// The Mac's outbound line, against a stand-in relay.
//
// The real relay is a separate service; what matters here is the contract
// between them and, more importantly, that a phone arriving down this line
// gets exactly what a phone on the network gets. Not the local surface.
// Everything drives the real harness process through its own API, the way
// the app would: the test plays the relay on one side and the phone's
// crypto on the other.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { after, before, describe, test } from "node:test";

import { deviceKey, open, peek, seal } from "../server/relay-crypto.ts";
import { startHarness, type Harness } from "./helpers/server.ts";

/** A relay just real enough: it holds the agent stream, hands over asks,
 * and keeps whatever comes back. */
function stubRelay() {
  let send: ((frame: unknown) => void) | null = null;
  const results = new Map<string, { status: number; payload: string }>();
  const pushed: Array<{ frames: string[]; wake: string | null }> = [];

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? "").split("?")[0];
    if (path === "/space/agent/stream") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      send = (frame) => res.write(`data: ${JSON.stringify(frame)}\n\n`);
      send({ kind: "hello", spaceId: "space-test" });
      return;
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = body ? JSON.parse(body) : {};
      if (path === "/space/agent/result") {
        results.set(String(parsed.id), { status: Number(parsed.status), payload: String(parsed.payload) });
      }
      if (path === "/space/agent/events") {
        pushed.push({ frames: parsed.frames ?? [], wake: parsed.wake ?? null });
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });

  return {
    server,
    ask: (id: string, payload: string) => send?.({ kind: "ask", id, payload }),
    results,
    pushed,
    get connected() {
      return send !== null;
    },
  };
}

let h: Harness;
let relay: ReturnType<typeof stubRelay>;
let sealKey: Buffer;
let openKey: Buffer;
let deviceId = "";

before(async () => {
  h = await startHarness();

  // pair a device the honest way, so the Mac holds a real digest and the
  // test holds the token only a phone would have
  await h.fetch("/api/pair", { method: "PUT", body: JSON.stringify({ enabled: true }) });
  const started = await h.json("/api/pair/start", { method: "POST" });
  const claimed = await h.json("/api/pair/claim", {
    method: "POST",
    body: JSON.stringify({ code: started.code, device: "A phone" }),
  });
  deviceId = claimed.device.id;
  const digest = createHash("sha256").update(claimed.token as string).digest("hex");
  sealKey = deviceKey(digest, "phone-to-mac");
  openKey = deviceKey(digest, "mac-to-phone");

  // stand the relay up and point the harness at it through its own API,
  // exactly as the settings screen would
  relay = stubRelay();
  await new Promise<void>((r) => relay.server.listen(0, "127.0.0.1", () => r()));
  const port = (relay.server.address() as { port: number }).port;
  const set = await h.fetch("/api/relay", {
    method: "PUT",
    body: JSON.stringify({ url: `http://127.0.0.1:${port}`, agentToken: "agent-token", enabled: true }),
  });
  assert.equal(set.status, 200);
});

after(async () => {
  relay?.server.close();
  await h?.stop();
});

async function waitUntil<T>(check: () => T | undefined | false, timeoutMs = 10_000): Promise<T | undefined> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const value = check();
    if (value) return value as T;
    await new Promise((r) => setTimeout(r, 40));
  }
  return undefined;
}

describe("the relay link", () => {
  test("the Mac dials out and holds the line", async () => {
    await waitUntil(() => relay.connected);
    assert.ok(relay.connected, "the harness never dialled the relay");
    const state = await waitUntil(async () => {
      const s = await h.json("/api/relay");
      return s.connected ? s : undefined;
    });
    assert.equal((await state)?.spaceId ?? (state as any)?.spaceId, "space-test");
  });

  test("a phone's sealed request is served, and local-only routes stay local-only", async () => {
    // an ordinary read, the sort a phone makes constantly
    relay.ask("ask-1", seal(sealKey, deviceId, { method: "GET", path: "/api/bots" }));
    const first = await waitUntil(() => relay.results.get("ask-1"));
    assert.equal(first!.status, 200);
    const answer = open(openKey, peek(first!.payload)!) as { status: number; body: any };
    assert.equal(answer.status, 200);
    assert.ok(Array.isArray(answer.body.bots), "the phone got the real answer back");

    // the local-only surface must not open just because the request
    // arrived on loopback: this is the whole point of the relay path. A
    // mutating request needs its freshness stamp to clear the replay gate.
    relay.ask(
      "ask-2",
      seal(sealKey, deviceId, {
        method: "POST",
        path: "/api/pair/start",
        ts: Date.now(),
        nonce: "n-2",
      }),
    );
    const second = await waitUntil(() => relay.results.get("ask-2"));
    const denied = open(openKey, peek(second!.payload)!) as { status: number };
    assert.equal(denied.status, 403, "a relayed phone reached a local-only route");

    // replay: the very same sealed frame, sent twice, is refused the
    // second time. A hostile relay cannot re-run a captured mutation.
    const replayable = seal(sealKey, deviceId, {
      method: "POST",
      path: "/api/bloks",
      body: { name: "x", memberIds: [] },
      ts: Date.now(),
      nonce: "n-replay",
    });
    relay.ask("ask-r1", replayable);
    await waitUntil(() => relay.results.get("ask-r1"));
    relay.ask("ask-r2", replayable);
    const replayed = await waitUntil(() => relay.results.get("ask-r2"));
    const replayBody = open(openKey, peek(replayed!.payload)!) as { status: number };
    assert.equal(replayBody.status, 409, "a replayed mutation was served twice");

    // a stale timestamp is refused even with a fresh nonce
    relay.ask(
      "ask-stale",
      seal(sealKey, deviceId, {
        method: "POST",
        path: "/api/bloks",
        ts: Date.now() - 10 * 60_000,
        nonce: "n-stale",
      }),
    );
    const stale = await waitUntil(() => relay.results.get("ask-stale"));
    assert.equal((open(openKey, peek(stale!.payload)!) as { status: number }).status, 409);

    // a stranger's envelope is answered with nothing at all
    const strangerKey = deviceKey("00".repeat(32), "phone-to-mac");
    relay.ask("ask-3", seal(strangerKey, "not-a-device", { method: "GET", path: "/api/bots" }));
    const third = await waitUntil(() => relay.results.get("ask-3"));
    assert.equal(third!.status, 401);
    assert.equal(third!.payload, "", "an unknown device must not even get ciphertext");

    // a phone's own request reflected back must read as garbage: the
    // directions use different keys, which is the whole defence
    const reflected = open(openKey, peek(seal(sealKey, deviceId, { method: "GET", path: "/api/bots" }))!);
    assert.equal(reflected, null, "a reflected frame decrypted across directions");

    // paths outside the API are refused before anything is dialled
    relay.ask("ask-4", seal(sealKey, deviceId, { method: "GET", path: "/../etc/passwd" }));
    const fourth = await waitUntil(() => relay.results.get("ask-4"));
    assert.equal(fourth!.status, 404);
  });

  test("broadcasts go out sealed, and only an approval asks for a buzz", async (t) => {
    const { createServer: mkFake } = await import("node:http");

    // a fake engine that asks first, so an approval card exists to wake on
    const fake = mkFake((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        if (req.url?.endsWith("/models")) {
          res.writeHead(200, { "content-type": "application/json" });
          return res.end(JSON.stringify({ data: [{ id: "grok-4" }] }));
        }
        const parsed = JSON.parse(body || "{}");
        const toolMsg = (parsed.messages ?? []).find((m: any) => m.role === "tool");
        res.writeHead(200, { "content-type": "application/json" });
        if (!toolMsg) {
          return res.end(
            JSON.stringify({
              choices: [
                {
                  message: {
                    role: "assistant",
                    tool_calls: [
                      {
                        id: "c1",
                        type: "function",
                        function: { name: "ask_user", arguments: JSON.stringify({ question: "Go?", choices: ["Yes"] }) },
                      },
                    ],
                  },
                },
              ],
              usage: { prompt_tokens: 3, completion_tokens: 2 },
            }),
          );
        }
        return res.end(
          JSON.stringify({
            choices: [{ message: { role: "assistant", content: "hello from the engine" } }],
            usage: { prompt_tokens: 4, completion_tokens: 2 },
          }),
        );
      });
    });
    await new Promise<void>((r) => fake.listen(0, "127.0.0.1", () => r()));
    t.after(() => fake.close());

    await h.fetch("/api/providers/grok/connect", {
      method: "POST",
      body: JSON.stringify({
        key: "xai-test-000000000000",
        url: `http://127.0.0.1:${(fake.address() as any).port}`,
      }),
    });
    const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Buzzer" }) });
    await h.fetch(`/api/bots/${bot.id}`, {
      method: "PATCH",
      body: JSON.stringify({ modelSelection: { instanceId: "grok", model: "grok-4" } }),
    });

    relay.pushed.length = 0;
    await h.fetch(`/api/bots/${bot.id}/messages`, {
      method: "POST",
      body: JSON.stringify({ text: "start something worth approving" }),
    });

    // the approval card lands, and exactly that push carries the wake
    const buzz = await waitUntil(() => relay.pushed.find((p) => p.wake === "needs-you"));
    assert.ok(buzz, "an approval card never asked the relay to wake the phone");

    // every frame that left is ciphertext for the paired phone: the
    // typed message must not appear in any pushed payload
    const leaked = relay.pushed.some((p) => p.frames.some((f) => f.includes("approving")));
    assert.equal(leaked, false, "a frame crossed the relay in clear");
    const sample = relay.pushed.find((p) => p.frames.length > 0)!.frames[0];
    const opened = open(openKey, peek(sample)!);
    assert.ok(opened, "the paired phone could not read its own frame");

    // and plenty of ordinary chatter went out with no wake at all
    const quiet = relay.pushed.filter((p) => p.wake === null).length;
    assert.ok(quiet > 0, "ordinary frames should not buzz");

    // settle the card so the harness shuts down clean
    const settled = await waitUntil(async () => {
      const { bots } = await h.json("/api/bots");
      const b = bots.find((x: any) => x.id === bot.id);
      const card = b.messages.find((m: any) => m.kind === "options" && m.card?.requestId);
      return card?.card ?? undefined;
    });
    const card = await settled;
    if (card) {
      await h.fetch(`/api/bots/${bot.id}/respond`, {
        method: "POST",
        body: JSON.stringify({ requestId: (card as any).requestId, behavior: "answer", message: "Yes" }),
      });
    }
  });
});
