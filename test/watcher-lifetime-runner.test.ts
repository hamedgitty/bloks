import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { MAX_TASKS } from "../server/store.ts";
import { FAILS_TO_PAUSE, type WatchKind } from "../server/watchers.ts";
import { startHarness } from "./helpers/server.ts";
import { agentOn, fakeProvider, idle, waitFor } from "./helpers/turns.ts";

const request = (method: string, body?: unknown) => ({ method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
const phoneToken = "fixture-lifetime-phone-token-0123456789";
const city = (locality: string) => ({ locality, country: "Canada", timeZone: "America/Toronto" });
const quote = (s: string) => process.platform === "win32" ? `"${s}"` : `'${s.replaceAll("'", "'\\''")}'`;

async function fixture(t: TestContext, copyGate = false) {
  const home = mkdtempSync(join(tmpdir(), "bloks-watch-lifetime-"));
  mkdirSync(join(home, ".bloks"));
  writeFileSync(join(home, ".bloks", "config.json"), JSON.stringify({
    brief: { enabled: false }, backups: { auto: false },
    remote: { enabled: true, devices: [{ id: "fixture-phone", name: "Fixture phone", hash: createHash("sha256").update(phoneToken).digest("hex"), pairedAt: 1 }] },
  }));
  const provider = await fakeProvider(t); provider.state.answerAtOnce = true;
  const bin = join(home, "bin"), copyStarted = join(home, "copy-started"), copyRelease = join(home, "copy-release");
  if (copyGate) {
    mkdirSync(bin);
    // A test-only cp stand-in holds the real rehearsal clone boundary.
    // Only this harmless executable is in PATH; no installed engine is found.
    writeFileSync(join(bin, "cp"), `#!${process.execPath}
import{existsSync,writeFileSync}from'node:fs';import{execFileSync}from'node:child_process';
writeFileSync(${JSON.stringify(copyStarted)},'started');
const end=Date.now()+15000;while(!existsSync(${JSON.stringify(copyRelease)})&&Date.now()<end)await new Promise(r=>setTimeout(r,20));
if(!existsSync(${JSON.stringify(copyRelease)}))process.exit(1);
execFileSync('/bin/cp',process.argv.slice(2));`, { mode: 0o755 });
  }
  const environment = { HOME: home, ...(copyGate ? { PATH: bin } : {}) };
  let h = await startHarness(environment);
  const bot = await agentOn(h, provider.port, "Lifetime fixture");
  if (copyGate) { const cwd = join(home, "work"); mkdirSync(cwd); writeFileSync(join(cwd, "fixture.txt"), "fixture"); await h.json(`/api/bots/${bot.id}`, request("PATCH", { cwd })); }
  const texts = new Map<string, string>(), errors = new Set<string>(), holds = new Set<string>(), releases = new Map<string, () => void>(), counts = new Map<string, number>();
  const site = createServer((req, res) => {
    const name = req.url!; counts.set(name, (counts.get(name) ?? 0) + 1);
    const finish = () => { res.statusCode = errors.has(name) ? 500 : 200; res.end(texts.get(name) ?? "<p>baseline</p>"); };
    if (holds.has(name)) releases.set(name, finish); else finish();
  });
  await new Promise<void>(r => site.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(site.address() as { port: number }).port}`;
  t.after(async () => {
    writeFileSync(copyRelease, "release"); releases.forEach(r => r()); site.closeAllConnections(); site.close();
    await h.stop(); rmSync(home, { recursive: true, force: true });
  });
  const watchers = async () => (await h.json("/api/watchers")).watchers as any[];
  const get = async (id: string) => (await watchers()).find(w => w.id === id);
  const check = (id: string) => h.json(`/api/watchers/${id}/check`, request("POST"));
  const patch = async (id: string, fields: Record<string, unknown>) => (await h.json(`/api/watchers/${id}`, request("PATCH", fields))).watcher;
  const phone = async (locality: string, ago: number) => {
    const res = await h.fetchRemote("/api/location", { method: "POST", token: phoneToken, body: JSON.stringify({ sharing: "on", background: true, location: { observedAt: Date.now() - ago, place: city(locality), trigger: "moved" } }) });
    assert.equal(res.status, 200, JSON.stringify(res.body));
  };
  let number = 0;
  async function make(kind: WatchKind, fields: Record<string, unknown> = {}) {
    const name = `/target-${++number}`, dir = join(home, `folder-${number}`); mkdirSync(dir);
    const state = join(home, `check-state-${number}.txt`), counter = join(home, `check-count-${number}.txt`), script = join(home, `check-${number}.mjs`);
    writeFileSync(state, "quiet");
    writeFileSync(script, `import{readFileSync,writeFileSync,existsSync}from'node:fs';const count=${JSON.stringify(counter)};writeFileSync(count,String((existsSync(count)?Number(readFileSync(count,'utf8')):0)+1));const value=readFileSync(${JSON.stringify(state)},'utf8');if(value==='error')process.exit(2);if(value==='quiet')process.exit(1);console.log(value);`);
    texts.set(name, kind === "feed" ? "<rss><channel><item><guid>base</guid><title>Baseline</title></item></channel></rss>" : "<p>baseline</p>");
    const target = kind === "folder" ? dir : kind === "check" ? `${quote(process.execPath)} ${quote(script)}` : kind === "place" ? "Toronto" : base + name;
    const { watcher } = await h.json("/api/watchers", request("POST", { botId: bot.id, kind, target, instruction: `Record result ${number}`, ...fields }));
    assert.ok(watcher, h.logs());
    assert.ok(await waitFor(async () => (await get(watcher.id))?.lastCheck));
    return { id: watcher.id as string, name, dir, state, counter, calls: () => kind === "check" ? existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0 : counts.get(name) ?? 0 };
  }
  return {
    home, bot, provider, texts, errors, holds, releases, counts, make, watchers, get, check, patch, phone, copyStarted, copyRelease,
    get h() { return h; },
    async restart() { await h.stop(); h = await startHarness(environment); },
  };
}

test("all five kinds consume once only after dispatch and keep the first terminal reason", { timeout: 120_000 }, async t => {
  const f = await fixture(t);
  await f.phone("Montreal", 25 * 60_000);
  for (const kind of ["check", "page", "feed", "folder", "place"] as const) {
    const w = await f.make(kind, { once: true, until: Date.now() + 60_000 });
    assert.equal((await f.check(w.id)).fired, false, "a baseline/quiet look consumed once");
    assert.equal((await f.get(w.id)).done, undefined);
    if (kind === "check") {
      writeFileSync(w.state, "error"); assert.equal((await f.check(w.id)).fired, false);
      assert.equal((await f.get(w.id)).done, undefined); writeFileSync(w.state, "finding-one");
    } else if (kind === "page") {
      f.errors.add(w.name); assert.equal((await f.check(w.id)).fired, false); f.errors.delete(w.name);
      assert.equal((await f.get(w.id)).done, undefined); f.texts.set(w.name, "<p>finding-one</p>");
    } else if (kind === "feed") f.texts.set(w.name, "<rss><channel><item><guid>fresh</guid><title>Finding</title></item></channel></rss>");
    else if (kind === "folder") writeFileSync(join(w.dir, "finding-one.txt"), "ready");
    else await f.phone("Toronto", 20 * 60_000);
    if (kind !== "place") assert.equal((await f.check(w.id)).fired, true);
    const done = await waitFor(async () => { const current = await f.get(w.id); return current.done ? current : null; });
    assert.ok(done); assert.equal(done.enabled, false); assert.equal(done.done.why, "once"); assert.equal(done.fires.length, 1);
    assert.ok(await idle(f.h, f.bot));
    const at = done.done.at;
    await f.patch(w.id, { name: "Unrelated edit", until: Date.now() + 100 }); await pause(130);
    assert.equal((await f.check(w.id)).fired, false);
    const retained = await f.get(w.id); assert.equal(retained.done.why, "once"); assert.equal(retained.done.at, at); assert.equal(retained.fires.length, 1);
    await f.patch(w.id, { once: false, until: "" });
    assert.equal((await f.get(w.id)).done.why, "once", "clearing flags implicitly reopened a completed lifetime");
  }
});

test("an early dispatch exception leaves once eligible for a successful retry", { timeout: 60_000 }, async t => {
  const f = await fixture(t), w = await f.make("page", { once: true, thread: "Later findings" });
  for(let i=1;i<MAX_TASKS;i++) assert.equal((await f.h.fetch(`/api/bots/${f.bot.id}/tasks`,request("POST",{title:`Fixture ${i}`}))).status,201);
  f.texts.set(w.name, "<p>new result</p>");
  const refused = await f.check(w.id); assert.equal(refused.fired, false); assert.match(refused.note,/too many|at most|close/i);
  assert.equal((await f.get(w.id)).done, undefined); assert.equal((await f.get(w.id)).fires.length, 0);
  const me=(await f.h.json("/api/bots")).bots.find((b:any)=>b.id===f.bot.id);
  assert.equal((await f.h.fetch(`/api/bots/${f.bot.id}/tasks/${me.tasks.at(-1).id}`,request("DELETE"))).status,200);
  assert.equal((await f.check(w.id)).fired, true); assert.equal((await f.get(w.id)).done.why, "once");
});

test("late local results obey an edited deadline, and an old look cannot consume a reopened lifetime", { timeout: 60_000 }, async t => {
  const f = await fixture(t);
  for (const reopen of [false, true]) {
    const w = await f.make("page", { once: true, until: Date.now() + 60_000 });
    f.holds.add(w.name); f.texts.set(w.name, "<p>new result</p>");
    const pending = f.check(w.id);
    assert.ok(await waitFor(() => f.releases.has(w.name) ? true : null));
    await f.patch(w.id, { until: Date.now() + 150 }); await pause(180);
    if (reopen) {
      await f.check(w.id); assert.equal((await f.get(w.id)).done.why, "until");
      const fresh = await f.patch(w.id, { enabled: true, until: Date.now() + 60_000 }); assert.equal(fresh.done, undefined);
    }
    f.holds.delete(w.name); f.releases.get(w.name)!(); f.releases.delete(w.name);
    assert.equal((await pending).fired, false);
    const after = await f.get(w.id); assert.equal(after.fires.length, 0);
    if (reopen) {
      assert.equal(after.enabled, true); assert.equal(after.done, undefined);
      assert.equal((await f.check(w.id)).fired, true); assert.equal((await f.get(w.id)).done.why, "once");
      assert.ok(await idle(f.h, f.bot));
    } else { assert.equal(after.enabled, false); assert.equal(after.done.why, "until"); }
  }
});

test("expiry wins during accepted rehearsal dispatch; old startup cannot complete a reopened lifetime", { timeout: 90_000, skip: process.platform !== "linux" }, async t => {
  const f = await fixture(t, true);
  for (const reopen of [false, true]) {
    rmSync(f.copyStarted,{force:true});rmSync(f.copyRelease,{force:true});
    const w = await f.make("page", { mode:"rehearse", once: true, until: Date.now() + 60_000 });
    f.texts.set(w.name, "<p>accepted finding</p>");
    const pending = f.check(w.id);
    assert.ok(await waitFor(() => existsSync(f.copyStarted) ? true : null), "dispatch never reached real rehearsal copy startup");
    await f.patch(w.id, { until: Date.now() + 120 }); await pause(150); await f.check(w.id);
    const expired = await f.get(w.id); assert.equal(expired.done.why, "until");
    if (reopen) await f.patch(w.id, { enabled: true, until: Date.now() + 60_000 });
    writeFileSync(f.copyRelease,"release");
    assert.equal((await pending).fired, true); assert.ok(await idle(f.h, f.bot));
    const after = await f.get(w.id); assert.equal(after.fires.length, 1, "accepted dispatch history disappeared");
    if (reopen) {
      assert.equal(after.enabled, true); assert.equal(after.done, undefined, "old dispatch completed the new lifetime");
      f.texts.set(w.name, "<p>fresh lifetime finding</p>"); assert.equal((await f.check(w.id)).fired, true); assert.equal((await f.get(w.id)).done.why, "once");
    } else { assert.equal(after.enabled, false); assert.deepEqual(after.done, expired.done, "once overwrote expiry"); }
  }
});

test("accepted queued once work may run after expiry, with no second admission", { timeout: 60_000 }, async t => {
  const f = await fixture(t), w = await f.make("check", { once: true, until: Date.now() + 60_000 });
  f.provider.state.answerAtOnce = false;
  await f.h.json(`/api/bots/${f.bot.id}/messages`, request("POST", { text: "Hold the fixture lane" }));
  assert.ok(await waitFor(() => f.provider.state.held.length ? true : null));
  writeFileSync(w.state, "queued result"); assert.equal((await f.check(w.id)).fired, true);
  const before = await f.get(w.id); assert.equal(before.done.why, "once");
  await f.patch(w.id, { until: Date.now() + 100 }); await pause(130);
  assert.equal((await f.check(w.id)).fired, false); assert.deepEqual((await f.get(w.id)).done, before.done);
  f.provider.state.answerAtOnce = true; f.provider.state.held.splice(0).forEach(release => release());
  assert.ok(await waitFor(() => f.provider.state.calls.some(call => call.includes("queued result")) ? true : null));
  assert.equal((await f.get(w.id)).fires.length, 1);
});

test("all-kind deadlines finish without another target look, persist on restart and require explicit reopening", { timeout: 60_000 }, async t => {
  const f = await fixture(t), made = [];
  for (const kind of ["folder", "page", "feed", "check", "place"] as const) made.push(await f.make(kind, { once: true }));
  for (const w of made) await f.patch(w.id, { until: Date.now() + 150 });
  await pause(200);
  for (const w of made) {
    const calls = w.calls(); assert.equal((await f.check(w.id)).fired, false); assert.equal(w.calls(), calls);
    const done = await f.get(w.id); assert.equal(done.enabled, false); assert.equal(done.done.why, "until");
    const renamed = await f.patch(w.id, { name: "Still finished" }); assert.equal(renamed.until, done.until); assert.deepEqual(renamed.done, done.done);
  }
  await f.restart();
  for (const w of made) {
    assert.equal((await f.get(w.id)).done.why, "until");
    const cleared = await f.patch(w.id, { once: false, until: null }); assert.equal(cleared.done.why, "until"); assert.equal(cleared.enabled, false);
    const reopened = await f.patch(w.id, { enabled: true }); assert.equal(reopened.done, undefined); assert.equal(reopened.until, undefined);
    await f.patch(w.id, { enabled: false });
  }
});

test("startup and the real minute sweep expire paused, archived, failing, busy and approval-held watchers without looks", { timeout: 150_000 }, async t => {
  const f = await fixture(t), made = [];
  for (const kind of ["folder", "page", "feed", "check", "place"] as const) made.push(await f.make(kind, { enabled: false, every: 1440 }));
  // First, a real startup with already expired bounds, before folder arming.
  await f.h.stop();
  const path = join(f.home, ".bloks", "watchers.json"), saved = JSON.parse(readFileSync(path, "utf8"));
  for (const w of saved) { w.enabled = true; w.once = true; w.until = Date.now() - 1; }
  writeFileSync(path, JSON.stringify(saved));
  const counts = made.map(w => w.calls()); await f.restart();
  for (const [i, w] of made.entries()) { assert.equal((await f.get(w.id)).done.why, "until"); assert.equal(w.calls(), counts[i]); }
  for (const w of made) await f.patch(w.id, { enabled: true, until: Date.now() + 120_000 });
  await f.patch(made[1].id, { enabled: false }); // manually paused
  const failing = made[2]; f.errors.add(failing.name);
  for (let i = 0; i < FAILS_TO_PAUSE; i++) await f.check(failing.id);
  assert.ok((await f.get(failing.id)).failing);
  await f.patch(made[3].id, { approved: false }); assert.equal((await f.get(made[3].id)).approvedBy, undefined);
  const { bot: archivedBot } = await f.h.json("/api/bots", request("POST", { name: "Archived fixture" }));
  const { watcher: archived } = await f.h.json("/api/watchers", request("POST", { kind: "page", botId: archivedBot.id, target: (await f.get(made[1].id)).target, instruction: "Archived result", every: 1440 }));
  assert.ok(await waitFor(async () => (await f.get(archived.id))?.lastCheck));
  assert.equal((await f.h.fetch(`/api/bots/${archivedBot.id}`, request("DELETE"))).status, 200);
  assert.equal((await f.get(archived.id)).suspended,"archived");
  const due = Date.now() + 5_000;
  for (const w of [...made, archived]) await f.patch(w.id, { until: due });
  // PATCH deliberately restarts failure counting; put the failing state back.
  for (let i = 0; i < FAILS_TO_PAUSE; i++) await f.check(failing.id);
  assert.ok((await f.get(failing.id)).failing);
  f.provider.state.answerAtOnce = false;
  await f.h.json(`/api/bots/${f.bot.id}/messages`, request("POST", { text: "Keep fixture busy during expiry" }));
  assert.ok(await waitFor(() => f.provider.state.held.length ? true : null));
  const before = made.map(w => w.calls()), archiveCalls = f.counts.get(made[1].name);
  assert.ok(await waitFor(async () => (await f.watchers()).every(w => w.done?.why === "until") ? true : null, 70_000), "the actual minute sweep did not expire held watches");
  for (const [i, w] of made.entries()) { assert.equal(w.calls(), before[i]); assert.equal((await f.get(w.id)).enabled, false); }
  assert.equal(f.counts.get(made[1].name), archiveCalls);
  assert.ok(await waitFor(async () => JSON.parse(readFileSync(path, "utf8")).every((w: any) => w.done?.why === "until") ? true : null));
  f.provider.state.answerAtOnce = true; f.provider.state.held.splice(0).forEach(release => release());
  assert.ok(await idle(f.h, f.bot));
});
