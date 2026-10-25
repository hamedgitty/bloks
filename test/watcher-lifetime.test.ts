import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { cleanWatcher, type WatchKind } from "../server/watchers.ts";
import { startHarness } from "./helpers/server.ts";
import { waitFor } from "./helpers/turns.ts";

const kinds: WatchKind[] = ["folder", "page", "feed", "check", "place"];
const future = "2030-01-01T00:00:00Z";
const target = (kind: WatchKind) => kind === "folder" ? "/fixture" : kind === "check" ? "false" : kind === "place" ? "Example City" : "https://example.invalid/";
const raw = (kind: WatchKind) => ({ kind, target: target(kind), botId: "fixture", instruction: "Record fixture", enabled: false });
const request = (method: string, body?: unknown) => ({ method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

for (const kind of kinds) test(`${kind} validates and preserves its lifetime, refusing malformed bounds`, () => {
  const now = Date.parse("2026-01-01T00:00:00Z"), until = Date.parse(future);
  const clean = (fields: Record<string, unknown>) => cleanWatcher({ ...raw(kind), ...fields }, () => true, now);
  const made = clean({ once: true, until: future });
  assert.ok(made.ok);
  assert.equal(made.value.once, true);
  assert.equal(made.value.until, until);
  assert.equal(clean({ until: now }).ok, false, "the deadline boundary was accepted");
  assert.equal(clean({ until: now - 1 }).ok, false);
  const after = clean({ until: now + 1 });
  assert.ok(after.ok && after.value.until === now + 1);
  for (const once of ["true", "false", 1, null, [], {}]) assert.equal(clean({ once }).ok, false);
  for (const until of ["not-a-date", true, false, [future], { date: future }, Infinity, NaN]) assert.equal(clean({ until }).ok, false);
  for (const until of [undefined, null, ""]) {
    const cleared = clean({ once: false, until });
    assert.ok(cleared.ok);
    assert.equal(cleared.value.once, undefined);
    assert.equal(cleared.value.until, undefined);
  }
});

const cli = fileURLToPath(new URL("../bin/bloks.mjs", import.meta.url));
const runCli = (args: string[], home: string, url: string) => new Promise<{ status: number; body: any }>((resolve, reject) => {
  execFile(process.execPath, [cli, ...args], { env: { HOME: home, USERPROFILE: home, PATH: "/nonexistent", BLOKS_URL: url, BLOKS_TOKEN: "blk_fixture" }, timeout: 10_000 }, (error, stdout, stderr) => {
    if (error && typeof error.code !== "number") return reject(error);
    assert.equal(stderr, "");
    try { resolve({ status: error?.code as number ?? 0, body: JSON.parse(stdout) }); } catch (e) { reject(e); }
  });
});

test("actual CLI create and edit transport lifetime for every kind and reject invalid booleans before sending", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "bloks-lifetime-cli-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const calls: Array<{ method?: string; body: any }> = [];
  const server = createServer(async (req, res) => {
    let text = ""; for await (const chunk of req) text += chunk;
    const body = JSON.parse(text); calls.push({ method: req.method, body });
    res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ watcher: { ...body, every: 30 } }));
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise<void>(r => server.close(() => r())));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  for (const kind of kinds) {
    const flags = [`--${kind === "place" ? "arrive" : kind}`, target(kind)];
    for (const args of [["watch", ...flags, "--do", "Record fixture"], ["edit-watch", "fixture", ...flags]]) {
      const made = await runCli([...args, "--once", "--until", future], home, url);
      assert.equal(made.status, 0); assert.equal(calls.at(-1)!.body.once, true); assert.equal(calls.at(-1)!.body.until, future);
      assert.equal(calls.at(-1)!.method, args[0] === "watch" ? "POST" : "PATCH");
      const cleared = await runCli([...args, "--once=false", "--until="], home, url);
      assert.equal(cleared.status, 0); assert.equal(calls.at(-1)!.body.once, false); assert.equal(calls.at(-1)!.body.until, "");
      for (const value of ["yes", "0", ""]) {
        const before = calls.length, bad = await runCli([...args, `--once=${value}`], home, url);
        assert.equal(bad.status, 1); assert.match(bad.body.error, /once.*true or false/); assert.equal(calls.length, before);
      }
    }
  }
});

test("HTTP POST and PATCH retain, clear and validate all-kind lifetimes atomically", async (t) => {
  const h = await startHarness(); t.after(() => h.stop());
  const folder = mkdtempSync(join(tmpdir(), "bloks-lifetime-folder-")); t.after(() => rmSync(folder, { recursive: true, force: true }));
  const site = createServer((_req, res) => res.end("<rss><channel></channel></rss>"));
  await new Promise<void>(r => site.listen(0, "127.0.0.1", r)); t.after(() => { site.closeAllConnections(); site.close(); });
  const url = `http://127.0.0.1:${(site.address() as { port: number }).port}`;
  const { bot } = await h.json("/api/bots", request("POST", { name: "Lifetime fixture" }));
  const saved = () => readFileSync(join(h.home, ".bloks", "watchers.json"), "utf8");
  for (const kind of kinds) {
    const body = { ...raw(kind), botId: bot.id, target: kind === "folder" ? folder : kind === "page" || kind === "feed" ? url : target(kind), once: true, until: future };
    const created = await h.fetch("/api/watchers", request("POST", body)); assert.equal(created.status, 201);
    const { watcher } = await created.json(), path = `/api/watchers/${watcher.id}`;
    assert.equal(watcher.once, true); assert.equal(watcher.until, Date.parse(future));
    assert.ok(await waitFor(async () => (await h.json("/api/watchers")).watchers.find((w: any) => w.id === watcher.id)?.lastCheck));
    const edited = (await h.json(path, request("PATCH", { name: "Renamed" }))).watcher;
    assert.equal(edited.once, true); assert.equal(edited.until, Date.parse(future));
    const stored = JSON.parse(saved()).find((w: any) => w.id === watcher.id);
    assert.equal(stored.once, true); assert.equal(stored.until, Date.parse(future));
    for (const invalid of [{ once: "true" }, { once: null }, { until: [future] }, { until: { date: future } }, { until: true }, { until: "invalid" }, { until: Date.now() - 1 }]) {
      const before = saved();
      for (const [route, method, value] of [[path, "PATCH", { ...invalid, name: "Must not save" }], ["/api/watchers", "POST", { ...body, ...invalid }]] as const) {
        const refused = await h.fetch(route, request(method, value)); assert.equal(refused.status, 400, JSON.stringify(invalid)); assert.equal(saved(), before, "refused request changed saved state");
      }
    }
    const cleared = (await h.json(path, request("PATCH", { once: false, until: "" }))).watcher;
    assert.equal(cleared.once, undefined); assert.equal(cleared.until, undefined);
    await h.json(path, request("PATCH", { once: true, until: future }));
    const switched = (await h.json(path, request("PATCH", { kind: "check", target: "false" }))).watcher;
    assert.equal(switched.once, true); assert.equal(switched.until, Date.parse(future));
  }
});
