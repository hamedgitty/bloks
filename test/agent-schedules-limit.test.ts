// Natural scheduler ticks in an isolated workspace, never a live provider.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { controlledChain } from "./helpers/agent-chain.ts";
import { chainRelay } from "./helpers/chain-relay.ts";
import { waitFor } from "./helpers/turns.ts";
import { noticeFor } from "../src/lib/notify.ts";

const post = (body: unknown) => ({ method: "POST", body: JSON.stringify(body) });

test("held schedules resume on their own after a higher limit, without consuming once slots", { timeout: 270_000 }, async (t) => {
  const clockHome = mkdtempSync(join(tmpdir(), "bloks-schedule-clock-"));
  const clockFile = join(clockHome, "offset"); writeFileSync(clockFile, "0");
  const f = await controlledChain(t, {}, {
    // a file URL, so a checkout path with a space in it stays one argument
    NODE_OPTIONS: `--import=${new URL("./helpers/scheduler-clock.mjs", import.meta.url).href}`,
    BLOKS_TEST_CLOCK_FILE: clockFile,
  });
  t.after(() => rmSync(clockHome, { recursive: true, force: true }));
  let offset = 0;
  const tick = async (ms: number) => {
    offset += ms; writeFileSync(clockFile, String(offset));
    await new Promise((resolve) => setTimeout(resolve, 100));
  };
  const runner = await f.hire("Runner"), later = await f.hire("Later"), reader = await f.hire("Reader"), failure = await f.hire("Failure");
  let status = 200;
  const page = createServer((_req, res) => { res.writeHead(status); res.end("Example page"); });
  await new Promise<void>((resolve) => page.listen(0, "127.0.0.1", resolve));
  t.after(() => { page.closeAllConnections(); page.close(); });
  const pageUrl = `http://127.0.0.1:${(page.address() as { port: number }).port}`;
  const dirs = [join(f.home, "first-drops"), join(f.home, "later-drops")];
  dirs.forEach((dir) => mkdirSync(dir));
  const first = (await f.h.json("/api/watchers", post({ botId: reader.id, kind: "folder", target: dirs[0], instruction: "First watcher work", name: "First", every: 1 }))).watcher;
  const second = (await f.h.json("/api/watchers", post({ botId: later.id, kind: "folder", target: dirs[1], instruction: "Later watcher work", name: "Later", every: 1 }))).watcher;
  const bad = (await f.h.json("/api/watchers", post({ botId: failure.id, kind: "page", target: pageUrl, instruction: "Page work", name: "Page", every: 1 }))).watcher;
  for (const w of [first, second, bad]) await f.h.json(`/api/watchers/${w.id}/check`, { method: "POST" });
  const tomorrow = new Date(Date.now() + 86_400_000);
  const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const routine = async (targetId: string, prompt: string) => (await f.h.json("/api/routines", post({ targetId, targetKind: "agent", prompt, time: "09:00", repeat: "once", date: ymd(tomorrow), days: [] }))).routine;
  const a = await routine(runner.id, "First scheduled work"), b = await routine(later.id, "Later scheduled work"), old = await routine(runner.id, "Old disabled work");
  const pushes: Array<{ frames: any[]; wake: unknown }> = [];
  await chainRelay(t, f.h, pushes);
  await f.restart(() => {
  // Keep the first tick in the future until the restarted relay connects.
  const due = new Date(Date.now() + 2 * 60_000);
  const time = `${String(due.getHours()).padStart(2, "0")}:${String(due.getMinutes()).padStart(2, "0")}`;
  const routineFile = join(f.home, ".bloks/routines.json");
  const saved = JSON.parse(readFileSync(routineFile, "utf8"));
  for (const r of saved) {
    r.chain = r.id === b.id ? 30 : 15; r.time = time; r.date = ymd(due); r.scheduledAt = due.getTime() - 60_000;
    if (r.id === old.id) { r.enabled = false; r.lastRunAt = due.getTime(); r.runs = [{ id: "old-attempt", state: "failed", startedAt: due.getTime(), endedAt: due.getTime(), error: "Held by the old code" }]; }
  }
  writeFileSync(routineFile, JSON.stringify(saved));
  const watcherFile = join(f.home, ".bloks/watchers.json");
  const watches = JSON.parse(readFileSync(watcherFile, "utf8"));
  for (const w of watches) { w.chain = w.id === second.id ? 30 : 15; w.lastCheck = due.getTime(); }
  writeFileSync(watcherFile, JSON.stringify(watches));
  });
  assert.ok(await waitFor(async () => (await f.h.json("/api/relay/status")).connected ? true : null), "the restarted synthetic relay did not connect");
  assert.equal((await f.messages(runner)).filter((m) => m.chainHeld).length, 0, "a scheduled hold happened before relay capture was ready");
  writeFileSync(join(dirs[0], "new.txt"), "first"); writeFileSync(join(dirs[1], "new.txt"), "later");
  await tick(8 * 60_000);
  const routines = async () => (await f.h.json("/api/routines")).routines as any[];
  const watchers = async () => (await f.h.json("/api/watchers")).watchers as any[];
  assert.ok(await waitFor(async () => (await watchers()).every((w) => w.lastError?.includes("agents reached the limit of 12 consecutive turns")) ? true : null, 45_000), "watchers did not reach the chain guard");
  // Three clock-driven thirty-second ticks execute the real scheduler path.
  // The minute watcher callback keeps its normal five-minute eligibility test.
  await tick(30_000); await tick(30_000); await tick(30_000);
  for (const id of [a.id, b.id]) {
    const r = (await routines()).find((r) => r.id === id);
    assert.equal(r.enabled, true);
    assert.equal(r.lastRunAt, undefined);
    assert.equal(r.runs.length, 1, "repeated scheduler ticks added hold records");
    assert.equal(typeof r.runs[0].heldSlot, "number");
  }
  const notices = (await f.messages(runner)).filter((m) => m.chainHeld);
  assert.equal(notices.length, 1, "repeated scheduler ticks added hold notices");
  for (const bot of [runner, later, reader, failure]) {
    const stops = (await f.messages(bot)).filter((m) => m.chainHeld);
    assert.equal(stops.length, bot.id === later.id ? 2 : 1, "each skipped routine and watcher must leave its own explanation");
    for (const notice of stops) {
    assert.match(notice.text, /^The (routine|watcher) .*(did not start a scheduled turn|did not look).*: agents reached the limit of 12 consecutive turns\./);
    assert.match(notice.text, /helps prevent repeated messages from using up your plan/);
    assert.match(notice.text, /Change it in Settings > General > Working with agents\./);
    assert.doesNotMatch(notice.text, /Held:|starts the count|manual run|by hand|person.*carr|queued|redeliver/i);
    const frame = await waitFor(() => pushes.find((p) => p.frames.some((frame) => frame.message?.id === notice.id)));
    assert.ok(frame, "the scheduled stop was not delivered to the synthetic phone");
    assert.equal(frame.wake, undefined, "the scheduled stop woke the phone");
    assert.equal(noticeFor(notice, { focused: false, selectedId: "elsewhere", threadId: bot.threadId, bot }), null, "the scheduled stop raised a desktop banner");
    }
  }
  writeFileSync(join(f.home, "finish-all"), "");
  status = 503;
  await f.limit(24);
  await tick(5 * 60_000);
  assert.ok(await waitFor(async () => {
    const rows = await routines(); const w = await watchers();
    return rows.find((r) => r.id === a.id)?.runs?.some((run: any) => run.state === "ok") &&
      w.find((w) => w.id === first.id)?.fires.length === 1 &&
      /503/.test(w.find((w) => w.id === bad.id)?.lastError ?? "") ? true : null;
  }, 90_000), "raising the live limit did not resume the next normal arms");
  let w = await watchers();
  assert.equal(w.find((w) => w.id === first.id).lastError, undefined);
  assert.match(w.find((w) => w.id === bad.id).lastError, /the address answered 503/);
  assert.match(w.find((w) => w.id === second.id).lastError, /^The watcher .*: agents reached the limit of 24 consecutive turns/);
  await f.limit(50);
  await tick(5 * 60_000);
  assert.ok(await waitFor(async () => {
    const rows = await routines(); const watches = await watchers();
    return rows.find((r) => r.id === b.id)?.runs?.some((run: any) => run.state === "ok") &&
      watches.find((w) => w.id === second.id)?.fires.length === 1 ? true : null;
  }, 90_000), "the highest limit did not release the remaining enabled schedules at their next arms");
  w = await watchers();
  assert.equal(w.find((w) => w.id === second.id).lastError, undefined);
  const rows = await routines();
  for (const id of [a.id, b.id]) {
    const r = rows.find((r) => r.id === id);
    assert.equal(r.enabled, false);
    assert.equal(r.runs.filter((run: any) => run.heldSlot === undefined).length, 1, "a once slot dispatched more than once");
  }
  assert.equal(rows.find((r) => r.id === old.id).enabled, false);
  assert.equal(rows.find((r) => r.id === old.id).runs.length, 1);
  assert.ok(!f.turns().some((turn) => turn.text.includes("Old disabled work")), "old disabled history was revived");
});
