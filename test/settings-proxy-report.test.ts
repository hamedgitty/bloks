import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { startRemoteProxy } from "../electron/remote.mjs";
import { keyFromToken, open, peek, seal, type RelayRequest } from "../server/relay-crypto.ts";
import { SettingsWindows, type SettingsAdmission } from "../server/settings-windows.ts";
import { serveSettingsReport, attachSettingsWindow, type SettingsReportCaller } from "../server/settings-report-http.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => { resolve = yes; });
  return { promise, resolve };
}
async function until(check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i++) await new Promise<void>((r) => setImmediate(r));
  assert(check(), "bounded fixture IO did not reach expected state");
}
async function jsonBody(req: IncomingMessage) {
  let text = "";
  for await (const chunk of req) text += chunk;
  return JSON.parse(text);
}
async function listen(server: ReturnType<typeof createServer>) {
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
async function close(server: ReturnType<typeof createServer>) {
  server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function fixture() {
  const ui = mkdtempSync(join(tmpdir(), "bloks-settings-proxy-"));
  writeFileSync(join(ui, "index.html"), "<!doctype html><title>Fixture</title>");
  const deviceToken = randomBytes(32).toString("base64url");
  const internal = randomBytes(32).toString("base64url");
  let elapsed = 0;
  let windows = new SettingsWindows({ monotonic: () => elapsed, wall: () => 1_700_000_000_000 + elapsed });
  let revoked = false;
  let dropClose = false;
  let loseOpen = false;
  let gate: { action: string; entered: boolean; wait: ReturnType<typeof deferred> } | null = null;
  const upstream: Array<{ windowKey: string; admission: SettingsAdmission }> = [];
  const requests: string[] = [];
  const streams = new Set<ServerResponse>();
  const workspace = createServer(async (req, res) => {
    const path = new URL(req.url!, "http://fixture").pathname;
    const remote = req.headers["x-fixture-internal"] === internal;
    const caller: SettingsReportCaller = remote ? revoked ? { role: "invalid" }
      : { role: "owner", source: { path: "remote", deviceId: "fixture-device" } }
      : req.headers.authorization === "Bearer fixture-member" ? { role: "member" }
      : req.headers.authorization !== undefined ? { role: "invalid" }
      : { role: "owner", source: { path: "direct", deviceId: null } };
    if (path === "/api/events" && caller.role === "owner") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const dispose = attachSettingsWindow(windows, caller.source, res);
      req.on("close", dispose); return;
    }
    await serveSettingsReport(windows, caller, path, req.method!, () => jsonBody(req), res);
  });
  const workspaceUrl = await listen(workspace);
  const relay = createServer(async (req, res) => {
    if (req.url === "/space/client/stream") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"kind":"hello","online":true}\n\n');
      streams.add(res); req.on("close", () => streams.delete(res)); return;
    }
    if (req.url !== "/space/client/ask") return void res.writeHead(404).end();
    const envelope = peek((await jsonBody(req)).payload);
    const request = envelope && open(keyFromToken(deviceToken, "phone-to-mac"), envelope) as RelayRequest | null;
    if (!request) return void res.writeHead(400).end();
    requests.push(request.path);
    const bytes = request.bodyB64 ? Buffer.from(request.bodyB64, "base64") : Buffer.from("{}");
    const body = JSON.parse(bytes.toString("utf8"));
    let status = 200;
    let result: unknown;
    const held = gate;
    if (held?.action === "report" && !held.entered && request.path === "/api/settings/device-report") {
      held.entered = true; await held.wait.promise;
    }
    if (dropClose && body.action === "close") result = { ok: true };
    else {
      const answer = await fetch(workspaceUrl + request.path, {
        method: request.method, headers: { "content-type": "application/json", "x-fixture-internal": internal }, body: bytes,
      });
      status = answer.status; result = await answer.json();
    }
    if (body.action === "open" && status === 200) upstream.push(result as typeof upstream[number]);
    if (body.action === "open" && loseOpen) { loseOpen = false; res.destroy(); return; }
    if (held && held.action === body.action && !held.entered) { held.entered = true; await held.wait.promise; }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ payload: seal(keyFromToken(deviceToken, "mac-to-phone"), "fixture-device", { status, body: result }) }));
  });
  const relayUrl = await listen(relay);
  const proxy = await startRemoteProxy({ relayUrl, relayToken: "fixture-relay", deviceId: "fixture-device", deviceToken }, { staticDir: ui });
  return {
    origin: `http://127.0.0.1:${proxy.port}`, workspaceUrl, upstream, requests,
    windows: () => windows, advance: (ms: number) => { elapsed += ms; },
    dropClose: () => { dropClose = true; },
    loseOpen: () => { loseOpen = true; },
    gate: (action: string) => { const wait = deferred(); gate = { action, entered: false, wait }; return { entered: () => gate!.entered, release: wait.resolve }; },
    revoke: () => { revoked = true; windows.revoke("fixture-device"); },
    restart: () => { windows = new SettingsWindows({ monotonic: () => elapsed, wall: () => 1_700_000_000_000 + elapsed }); },
    relayReady: () => streams.size > 0,
    broadcastFence: () => {
      const payload = seal(keyFromToken(deviceToken, "mac-to-phone"), "fixture-device", { kind: "fixture-fence" });
      for (const s of streams) s.write(`data: ${JSON.stringify({ kind: "frame", payload })}\n\n`);
    },
    broadcastPrivate: () => {
      const payload = seal(keyFromToken(deviceToken, "mac-to-phone"), "fixture-device", { kind: "settings-report", windowKey: "DO-NOT-FAN-OUT" });
      for (const s of streams) s.write(`data: ${JSON.stringify({ kind: "frame", payload })}\n\n`);
    },
    close: async () => {
      gate?.wait.resolve();
      proxy.stop();
      await close(relay); await close(workspace);
      rmSync(ui, { recursive: true, force: true });
    },
  };
}

async function stream(origin: string) {
  const abort = new AbortController();
  const response = await fetch(origin + "/api/events", { signal: abort.signal });
  assert.equal(response.status, 200);
  const reader = response.body!.getReader();
  let buffer = "";
  const decoder = new TextDecoder();
  const frames: Array<Record<string, any>> = [];
  const next = async () => {
    for (;;) {
      const cut = buffer.indexOf("\n\n");
      if (cut >= 0) {
        const line = buffer.slice(0, cut); buffer = buffer.slice(cut + 2);
        if (line.startsWith("data: ")) { const frame = JSON.parse(line.slice(6)); frames.push(frame); return frame; }
        continue;
      }
      const item = await reader.read(); assert(!item.done); buffer += decoder.decode(item.value);
    }
  };
  return {
    stop: () => abort.abort(), next, frames,
    control: async () => { for (;;) { const frame = await next(); if (frame.kind === "settings-report") return frame as { windowKey: string; admission: SettingsAdmission }; } },
  };
}
async function post(origin: string, path: string, body: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(origin + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const value = await response.json(); return { status: response.status, value };
}
async function activate(origin: string, control: { windowKey: string; admission: SettingsAdmission }) {
  if (control.admission) return control;
  const opened = await post(origin, "/api/settings/device-session", { action: "renew", windowKey: control.windowKey });
  assert.equal(opened.status, 200, "remote-window reporting must not depend on workspace direct sseClients");
  assert(opened.value.admission, "remote window has no independently bound admission");
  return { windowKey: control.windowKey, admission: opened.value.admission as SettingsAdmission };
}
const report = (control: { windowKey: string; admission: SettingsAdmission }, theme: string, sequence = 1) => ({
  ...control, sequence, snapshot: { schema: 1, revision: sequence, observedAt: 12, values: { "theme.applied": { status: "observed", value: theme } } },
});

test("D1 joint actual proxy/encrypted fake relay/HTTP isolates two remote windows and hides workspace authority", async (t) => {
  const f = await fixture(); t.after(f.close);
  const direct = await stream(f.workspaceUrl); t.after(direct.stop);
  const directControl = await direct.control();
  assert(directControl.admission);
  const a = await stream(f.origin); t.after(a.stop);
  const b = await stream(f.origin); t.after(b.stop);
  const ca = await activate(f.origin, await a.control()); const cb = await activate(f.origin, await b.control());
  assert.notEqual(ca.windowKey, cb.windowKey);
  for (const up of f.upstream) {
    assert(!JSON.stringify([ca, cb]).includes(up.windowKey), "workspace renewal key escaped the proxy");
    assert(!JSON.stringify([ca, cb]).includes(up.admission.capability), "workspace capability escaped the proxy");
  }
  assert.equal((await post(f.origin, "/api/settings/device-report", report(ca, "dark"))).status, 200);
  assert.equal((await post(f.origin, "/api/settings/device-report", report(cb, "light"))).status, 200);
  const attempts = f.requests.length;
  assert.equal((await post(f.origin, "/api/settings/device-report", { ...report(cb, "dark", 2), admission: ca.admission })).status, 409);
  assert.equal(f.requests.length, attempts, "cross-window substitution reached upstream");
  const forged: Array<Record<string, string>> = [{ authorization: "Bearer fixture-member" }, { "x-bloks-relay": "forged" }, { "x-bloks-relay-device": "forged" }];
  for (const headers of forged) {
    assert.equal((await post(f.origin, "/api/settings/device-report", report(ca, "light", 2), headers)).status, 403);
    assert.equal((await post(f.origin, "/api/settings/device-session", { action: "renew", windowKey: ca.windowKey }, headers)).status, 403);
  }
  assert.equal(f.requests.length, attempts, "presented member/forged attribution was upgraded and forwarded");
  assert.deepEqual(f.windows().inspect().windows.filter((x) => x.source.path === "remote").map((x) => x.lastReported!.snapshot.values["theme.applied"]), [
    { status: "observed", value: "dark" }, { status: "observed", value: "light" },
  ]);
});

test("D1 lost remote close keeps last value while monotonic expiry makes freshness unknown", async (t) => {
  const f = await fixture(); t.after(f.close);
  const a = await stream(f.origin); t.after(a.stop); const ca = await activate(f.origin, await a.control());
  assert.equal((await post(f.origin, "/api/settings/device-report", report(ca, "dark"))).status, 200);
  const before = f.windows().inspect().windows[0].lastReported;
  f.dropClose(); a.stop();
  await until(() => f.requests.filter((x) => x === "/api/settings/device-session").length >= 2);
  f.advance(60_000);
  const after = f.windows().inspect().windows[0];
  assert.equal(after.source.path, "remote");
  assert.equal(after.transport, "unconfirmed");
  assert.equal(after.freshness, "unknown");
  assert.deepEqual(after.lastReported, before);
  assert.equal((await post(f.origin, "/api/settings/device-session", { action: "renew", windowKey: ca.windowKey })).status, 409);
});

test("D2 close during a delayed remote open cannot install authority or keep the returned generation open", async (t) => {
  const f = await fixture(); t.after(f.close);
  const gate = f.gate("open");
  const a = await stream(f.origin); t.after(a.stop);
  const raw = await a.control();
  const pending = post(f.origin, "/api/settings/device-session", { action: "renew", windowKey: raw.windowKey });
  await until(gate.entered);
  assert.equal(f.windows().inspect().windows.length, 1);
  a.stop();
  await new Promise<void>((r) => setImmediate(r));
  gate.release();
  assert.equal((await pending).status, 409);
  await until(() => f.windows().inspect().windows[0].transport === "observed-closed");
  assert.equal(f.requests.filter((x) => x === "/api/settings/device-session").length, 2);
});

test("D2 proxy renewal is serialized; a rejected concurrent request cannot release someone else's latch", async (t) => {
  const f = await fixture(); t.after(f.close);
  const a = await stream(f.origin); t.after(a.stop); const ca = await activate(f.origin, await a.control());
  const gate = f.gate("renew");
  const pending = post(f.origin, "/api/settings/device-session", { action: "renew", windowKey: ca.windowKey });
  await until(gate.entered);
  assert.equal((await post(f.origin, "/api/settings/device-report", report(ca, "dark"))).status, 409);
  assert.equal((await post(f.origin, "/api/settings/device-session", { action: "renew", windowKey: ca.windowKey })).status, 409);
  gate.release();
  const renewed = await pending; assert.equal(renewed.status, 200);
  const current = { windowKey: ca.windowKey, admission: renewed.value.admission };
  assert.equal((await post(f.origin, "/api/settings/device-report", report(ca, "dark"))).status, 409);
  assert.equal((await post(f.origin, "/api/settings/device-report", report(current, "light"))).status, 200);
});

test("I8 actual proxy cannot revive revoked device or restarted workspace report authority", async (t) => {
  const f = await fixture(); t.after(f.close);
  const a = await stream(f.origin); t.after(a.stop); const ca = await activate(f.origin, await a.control());
  assert.equal((await post(f.origin, "/api/settings/device-report", report(ca, "dark"))).status, 200);
  f.revoke();
  assert.equal((await post(f.origin, "/api/settings/device-session", { action: "renew", windowKey: ca.windowKey })).status, 409);
  assert.equal(f.windows().inspect().windows[0].transport, "revoked");
  assert(f.windows().inspect().windows[0].lastReported);
  f.restart();
  assert.equal((await post(f.origin, "/api/settings/device-report", report(ca, "light", 2))).status, 409);
  assert.equal(f.windows().inspect().windows.length, 0);
});


test("D2 ambiguous proxy admission reply leaves one bounded orphan and no automatic retry", async (t) => {
  const f = await fixture(); t.after(f.close);
  f.loseOpen();
  const a = await stream(f.origin); t.after(a.stop); const raw = await a.control();
  const failed = await post(f.origin, "/api/settings/device-session", { action: "renew", windowKey: raw.windowKey });
  assert.equal(failed.status, 409);
  for (let i = 0; i < 40; i++) await new Promise<void>((r) => setImmediate(r));
  assert.equal(f.requests.length, 1, "ambiguous open must not retry on its own");
  assert.equal(f.windows().inspect().windows.length, 1);
  assert.equal(f.windows().inspect().windows[0].freshness, "unknown");
  const current = await activate(f.origin, raw); // a subsequent actual change
  assert.equal(f.windows().inspect().windows.length, 2, "lost reply leaves a disclosed bounded orphan");
  assert.equal((await post(f.origin, "/api/settings/device-report", report(current, "light"))).status, 200);
  assert.equal((await fetch(f.origin + "/")).status, 200, "report admission failure must leave ordinary chat usable");
});

test("D3 delayed proxy report cannot renew its issuance deadline or replace its last accepted value", async (t) => {
  const f = await fixture(); t.after(f.close);
  const a = await stream(f.origin); t.after(a.stop); const ca = await activate(f.origin, await a.control());
  assert.equal((await post(f.origin, "/api/settings/device-report", report(ca, "dark"))).status, 200);
  const before = f.windows().inspect().windows[0].lastReported;
  const gate = f.gate("report");
  const late = post(f.origin, "/api/settings/device-report", report(ca, "light", 2));
  await until(gate.entered); f.advance(60_000); gate.release();
  assert.equal((await late).status, 409);
  assert.equal(f.windows().inspect().windows[0].freshness, "unknown");
  assert.deepEqual(f.windows().inspect().windows[0].lastReported, before);
});


test("F3 relay private controls never fan out to either renderer and both windows can still report", async (t) => {
  const f = await fixture(); t.after(f.close);
  const a = await stream(f.origin); t.after(a.stop);
  const b = await stream(f.origin); t.after(b.stop);
  const ca = await activate(f.origin, await a.control());
  const cb = await activate(f.origin, await b.control());
  await until(f.relayReady);
  f.broadcastPrivate();
  f.broadcastFence(); // ordered ordinary frame proves each stream passed the injected frame
  for (const renderer of [a, b]) {
    for (;;) {
      const frame = await renderer.next();
      assert.notEqual(frame.windowKey, "DO-NOT-FAN-OUT", "relay report capability reached a renderer stream");
      if (frame.kind === "fixture-fence") break;
    }
    assert(!JSON.stringify(renderer.frames).includes("DO-NOT-FAN-OUT"));
  }
  assert.equal((await post(f.origin, "/api/settings/device-report", report(ca, "dark"))).status, 200);
  assert.equal((await post(f.origin, "/api/settings/device-report", report(cb, "light"))).status, 200);
  assert.deepEqual(f.windows().inspect().windows.map((row) => row.lastReported!.snapshot.values["theme.applied"]), [
    { status: "observed", value: "dark" }, { status: "observed", value: "light" },
  ]);
});
