import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import { once } from "node:events";
import { SettingsWindows, type SettingsAdmission } from "../server/settings-windows.ts";
import { attachSettingsWindow, serveSettingsReport, type SettingsReportCaller } from "../server/settings-report-http.ts";

async function fixture() {
  let elapsed = 0;
  let bodyReads = 0;
  let closed = 0;
  const windows = new SettingsWindows({ monotonic: () => elapsed, wall: () => 1_700_000_000_000 + elapsed });
  // Deliberately explicit fixture credentials. Application authentication and
  // the real encrypted proxy path still have their own integration checks.
  const caller = (req: IncomingMessage): SettingsReportCaller => {
    const auth = req.headers.authorization;
    if (auth === "Bearer fixture-member") return { role: "member" };
    if (auth === "Bearer fixture-agent") return { role: "agent" };
    if (auth === "Bearer fixture-invite") return { role: "invite" };
    if (auth !== undefined && auth !== "Bearer fixture-owner") return { role: "invalid" };
    return { role: "owner", source: { path: "direct", deviceId: auth ? "fixture-owner-device" : null } };
  };
  const server = createServer(async (req, res) => {
    const path = new URL(req.url!, "http://fixture").pathname;
    const who = caller(req);
    if (path === "/api/events" && who.role === "owner") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"kind":"hello"}\n\n');
      const close = attachSettingsWindow(windows, who.source, res);
      req.on("close", () => { close(); closed++; });
      return;
    }
    if (path === "/inspect" && who.role === "owner") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(windows.inspect()));
      return;
    }
    await serveSettingsReport(windows, who, path, req.method!, async () => {
      bodyReads++;
      let body = "";
      for await (const chunk of req) body += chunk;
      return JSON.parse(body);
    }, res);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    origin, windows, bodyReads: () => bodyReads, closed: () => closed,
    advance: (ms: number) => { elapsed += ms; },
    close: async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); },
  };
}
async function stream(origin: string, token?: string) {
  const stop = new AbortController();
  const response = await fetch(origin + "/api/events", {
    headers: token ? { authorization: `Bearer ${token}` } : {}, signal: stop.signal,
  });
  assert.equal(response.status, 200);
  const reader = response.body!.getReader();
  let buffer = "";
  const decode = new TextDecoder();
  for (;;) {
    const next = await reader.read();
    assert(!next.done);
    buffer += decode.decode(next.value);
    const frames = buffer.split("\n\n").filter((x) => x.startsWith("data: ")).map((x) => JSON.parse(x.slice(6)));
    const control = frames.find((x) => x.kind === "settings-report");
    if (control) return { stop: () => stop.abort(), control: control as { windowKey: string; admission: SettingsAdmission } };
  }
}
async function post(origin: string, path: string, body: unknown, token?: string, method = "POST") {
  return fetch(origin + path, {
    method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: method === "GET" || method === "HEAD" ? undefined : JSON.stringify(body),
  });
}
const data = (theme: string, revision = 1) => ({
  schema: 1, revision, observedAt: 77, values: { "theme.applied": { status: "observed", value: theme } },
});

test("I6 real direct HTTP/SSE owner windows retain separate observations and invalidate observed closure", async (t) => {
  const f = await fixture();
  t.after(f.close);
  const a = await stream(f.origin, "fixture-owner");
  const b = await stream(f.origin, "fixture-owner");
  t.after(a.stop); t.after(b.stop);
  assert.notEqual(a.control.windowKey, b.control.windowKey);
  for (const [window, theme] of [[a, "dark"], [b, "light"]] as const) {
    const res = await post(f.origin, "/api/settings/device-report", { admission: window.control.admission, sequence: 1, snapshot: data(theme) }, "fixture-owner");
    assert.equal(res.status, 200);
    await res.text();
  }
  const inspected = await (await fetch(f.origin + "/inspect")).text();
  for (const window of [a, b]) for (const secret of [window.control.windowKey, window.control.admission.capability]) assert(!inspected.includes(secret));
  assert.deepEqual(f.windows.inspect().windows.map((x) => x.lastReported!.snapshot.values["theme.applied"]), [
    { status: "observed", value: "dark" }, { status: "observed", value: "light" },
  ]);
  a.stop();
  for (let i = 0; i < 50 && !f.closed(); i++) await new Promise<void>((r) => setImmediate(r));
  assert.equal(f.closed(), 1);
  assert.equal(f.windows.inspect().windows[0].transport, "observed-closed");
  assert.equal(f.windows.inspect().windows[0].freshness, "unknown");
  assert(f.windows.inspect().windows[0].lastReported, "observed close must retain useful last value");
  assert.equal(f.windows.inspect().windows[1].freshness, "recent-observation");
  const revive = await post(f.origin, "/api/settings/device-session", { action: "renew", windowKey: a.control.windowKey }, "fixture-owner");
  assert.equal(revive.status, 409);
  await revive.text();
});

test("S1 actual report handler refuses non-owner identities and raw methods before body lookup", async (t) => {
  const f = await fixture(); t.after(f.close);
  for (const token of ["fixture-member", "fixture-agent", "fixture-invite", "unknown-expired"]) {
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
      const res = await post(f.origin, "/api/settings/device-session", { action: "open", secret: "SECRET-REJECTED-BODY" }, token, method);
      assert.equal(res.status, token === "unknown-expired" ? 401 : 403);
      assert(!(await res.text()).includes("SECRET"));
    }
  }
  assert.equal(f.bodyReads(), 0, "non-owner request reached body/report processing");
  for (const method of ["GET", "PUT", "PATCH", "DELETE"]) {
    const res = await post(f.origin, "/api/settings/device-report", {}, "fixture-owner", method);
    assert.equal(res.status, 405); await res.text();
  }
  assert.equal(f.bodyReads(), 0);
  assert.equal(f.windows.inspect().windows.length, 0);
});

test("D2/D3 real session renewal cannot use an expired report capability or accept late generation", async (t) => {
  const f = await fixture(); t.after(f.close);
  const a = await stream(f.origin); t.after(a.stop);
  const first = await post(f.origin, "/api/settings/device-report", { admission: a.control.admission, sequence: 1, snapshot: data("dark") });
  assert.equal(first.status, 200); await first.text();
  f.advance(60_000);
  const late = await post(f.origin, "/api/settings/device-report", { admission: a.control.admission, sequence: 2, snapshot: data("light", 2) });
  assert.equal(late.status, 409); await late.text();
  assert.deepEqual(f.windows.inspect().windows[0].lastReported!.snapshot.values["theme.applied"], { status: "observed", value: "dark" });
  const invalid = await post(f.origin, "/api/settings/device-session", { action: "renew", windowKey: a.control.admission.capability });
  assert.equal(invalid.status, 409); await invalid.text();
  const renew = await post(f.origin, "/api/settings/device-session", { action: "renew", windowKey: a.control.windowKey });
  assert.equal(renew.status, 200);
  const current = (await renew.json()).admission;
  assert.notEqual(current.generation, a.control.admission.generation);
  const accepted = await post(f.origin, "/api/settings/device-report", { admission: current, sequence: 1, snapshot: data("light", 2) });
  assert.equal(accepted.status, 200); await accepted.text();
  assert.equal(f.windows.inspect().windows.length, 1);
});

test("I4 actual report errors omit unknown fields, rejected payloads and private admission material", async (t) => {
  const f = await fixture(); t.after(f.close);
  const a = await stream(f.origin); t.after(a.stop);
  const tooLarge = await post(f.origin, "/api/settings/device-report", {
    admission: a.control.admission, sequence: 1, snapshot: data("dark"), secret: "SECRET-SENTINEL".repeat(2000),
  });
  assert.equal(tooLarge.status, 400);
  const output = await tooLarge.text();
  assert(!output.includes("SECRET"));
  assert(!output.includes(a.control.admission.capability));
  assert.equal(f.windows.inspect().windows[0].lastReported, null);
});
