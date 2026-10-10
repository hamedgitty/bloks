// Check-ins: routines that run every so often within hours, rather than
// at a time of day, and the quiet answer they are allowed to give.
//
// As with any routine, most of what matters is when it does NOT run: not
// outside its hours, not on a day it is off, not twice for one slot, and
// not late enough to collide with the next one.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  checkInsOn,
  describe,
  graceFor,
  GRACE_MS,
  isDue,
  isQuiet,
  isQuietReply,
  lastReportNote,
  lastScheduledBefore,
  LAST_REPORT_MAX,
  nextScheduledAfter,
  normalize,
  scheduleProblem,
  type Routine,
} from "../server/routines.ts";
import { startHarness } from "./helpers/server.ts";

const checkIn = (over: Partial<Routine> = {}): Routine => ({
  id: "r1",
  targetId: "bot1",
  targetKind: "agent",
  prompt: "Anything urgent in the inbox?",
  time: "09:00",
  days: [1, 2, 3, 4, 5],
  every: 30,
  activeHours: { from: "09:00", to: "18:00" },
  quiet: true,
  enabled: true,
  createdAt: 0,
  ...over,
});

const at = (iso: string) => new Date(iso);
const hm = (d: Date | null) => (d ? `${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}` : null);

test("a check-in's slots start with its hours and step by its interval, both ends included", () => {
  // 2026-03-17 is a Tuesday
  const slots = checkInsOn(checkIn(), at("2026-03-17T12:00:00"));
  assert.equal(slots.length, 19, "09:00 to 18:00 every half hour");
  assert.equal(hm(slots[0]), "17 09:00");
  assert.equal(hm(slots[1]), "17 09:30");
  assert.equal(hm(slots[18]), "17 18:00");
  // an interval that does not divide the window stops before its end
  const odd = checkInsOn(checkIn({ every: 45, activeHours: { from: "09:00", to: "10:00" } }), at("2026-03-17T12:00:00"));
  assert.deepEqual(odd.map(hm), ["17 09:00", "17 09:45"]);
  // none on a day it is off: 2026-03-22 is a Sunday
  assert.deepEqual(checkInsOn(checkIn(), at("2026-03-22T12:00:00")), []);
  // without hours it runs the whole day from midnight
  const allDay = checkInsOn(checkIn({ every: 360, activeHours: undefined, days: [] }), at("2026-03-22T12:00:00"));
  assert.deepEqual(allDay.map(hm), ["22 00:00", "22 06:00", "22 12:00", "22 18:00"]);
});

test("the last and next check-in keep to its hours and its days", () => {
  const r = checkIn();
  assert.equal(hm(lastScheduledBefore(r, at("2026-03-17T10:10:00"))), "17 10:00");
  assert.equal(hm(nextScheduledAfter(r, at("2026-03-17T10:10:00"))), "17 10:30");
  // exactly on a slot: that slot has happened, and the next is the one after
  assert.equal(hm(lastScheduledBefore(r, at("2026-03-17T10:30:00"))), "17 10:30");
  assert.equal(hm(nextScheduledAfter(r, at("2026-03-17T10:30:00"))), "17 11:00");
  // after hours, the next is tomorrow's first and the last is today's final one
  assert.equal(hm(lastScheduledBefore(r, at("2026-03-17T19:00:00"))), "17 18:00");
  assert.equal(hm(nextScheduledAfter(r, at("2026-03-17T19:00:00"))), "18 09:00");
  // before hours, the last was yesterday evening
  assert.equal(hm(lastScheduledBefore(r, at("2026-03-17T07:00:00"))), "16 18:00");
  // Friday evening waits for Monday morning
  assert.equal(hm(nextScheduledAfter(r, at("2026-03-20T18:30:00"))), "23 09:00");
});

test("a check-in fires once per slot, and a slot missed by half its interval is left for the next", () => {
  const r = checkIn();
  assert.equal(graceFor(r), 15 * 60_000);
  assert.equal(graceFor(checkIn({ every: 1440 })), GRACE_MS, "a daily check-in keeps the usual window");
  assert.equal(graceFor({ every: undefined }), GRACE_MS, "a time of day is unchanged");

  assert.equal(isDue(r, at("2026-03-17T10:00:20")), true);
  r.lastRunAt = at("2026-03-17T10:00:21").getTime();
  assert.equal(isDue(r, at("2026-03-17T10:00:50")), false, "already served this slot");
  assert.equal(isDue(r, at("2026-03-17T10:30:05")), true, "the next slot runs");

  // a busy lane held the 11:00 one back: still worth it at 11:14, not at 11:16
  const held = checkIn({ lastRunAt: at("2026-03-17T10:30:05").getTime() });
  assert.equal(isDue(held, at("2026-03-17T11:14:00")), true);
  assert.equal(isDue(held, at("2026-03-17T11:16:00")), false);

  // nothing outside its hours, or on a day it is off
  assert.equal(isDue(checkIn(), at("2026-03-17T20:00:00")), false);
  assert.equal(isDue(checkIn(), at("2026-03-22T10:00:10")), false);

  // made in the middle of a slot's window, it waits for the next slot
  const made = at("2026-03-17T10:07:00").getTime();
  assert.equal(isDue(checkIn({ scheduledAt: made }), at("2026-03-17T10:08:00")), false);
  assert.equal(isDue(checkIn({ scheduledAt: made }), at("2026-03-17T10:30:10")), true);
});

test("a check-in is filed with its first slot as its time, always quiet, and nothing it cannot run is stored", () => {
  const clean = normalize({
    targetId: "bot1",
    prompt: "  Anything urgent?  ",
    time: "23:15",
    every: 30,
    activeHours: { from: "9:00", to: "18:00" },
    days: [1, 2, 3, 4, 5],
    durationMin: 60,
  });
  assert.ok(clean);
  assert.equal(clean.every, 30);
  assert.deepEqual(clean.activeHours, { from: "09:00", to: "18:00" });
  assert.equal(clean.time, "09:00", "the first slot stands in for a time of day");
  assert.equal(clean.quiet, true);
  assert.equal(clean.durationMin, undefined, "a check-in is not an appointment on the calendar");
  // without hours, its day starts at midnight
  assert.equal(normalize({ targetId: "b", prompt: "x", every: 60 })?.time, "00:00");

  for (const every of [5, 14, 1441, 30.5, "30", -30]) {
    assert.equal(normalize({ targetId: "b", prompt: "x", every }), null, `${JSON.stringify(every)} is not an interval`);
    assert.match(scheduleProblem({ every }) ?? "", /every 15 to 1440 minutes/);
  }
  for (const activeHours of [{ from: "18:00", to: "09:00" }, { from: "09:00", to: "09:00" }, { from: "9", to: "18:00" }, "09:00-18:00"]) {
    assert.equal(normalize({ targetId: "b", prompt: "x", every: 30, activeHours }), null);
    assert.match(scheduleProblem({ every: 30, activeHours }) ?? "", /within one day/);
  }
  assert.match(scheduleProblem({ every: 30, repeat: "once", date: "2030-01-01" }) ?? "", /cannot also run once/);
  assert.equal(normalize({ targetId: "b", prompt: "x", every: 30, repeat: "once", date: "2030-01-01" }), null);
  // a room's routine speaks every time, so neither shape is for it
  assert.match(scheduleProblem({ every: 30, targetKind: "room" }) ?? "", /for an agent/);
  assert.match(scheduleProblem({ quiet: true, targetKind: "room", time: "09:00" }) ?? "", /for an agent/);
  assert.equal(normalize({ targetId: "room1", targetKind: "room", prompt: "x", every: 30 }), null);
  assert.equal(normalize({ targetId: "room1", targetKind: "room", prompt: "x", time: "09:00", quiet: true }), null);
});

test("a time of day stays exactly what it was, and may ask to be quiet", () => {
  const plain = normalize({ targetId: "b", prompt: "Brief me", time: "09:00", days: [], activeHours: { from: "09:00", to: "18:00" } });
  assert.ok(plain);
  assert.equal(plain.every, undefined);
  assert.equal(plain.activeHours, undefined, "hours belong to a check-in");
  assert.equal(plain.quiet, undefined, "not quiet unless asked");
  assert.equal(isQuiet({ ...plain }), false);
  assert.equal(describe({ ...plain, id: "r", createdAt: 0 }), "Every day at 09:00");

  const quiet = normalize({ targetId: "b", prompt: "Brief me", time: "09:00", quiet: true });
  assert.equal(quiet?.quiet, true);
  assert.equal(isQuiet(quiet!), true);
  assert.equal(isQuiet({ targetKind: "agent", every: 30 }), true, "a check-in is always quiet");
  assert.equal(isQuiet({ targetKind: "room", quiet: true }), false);
});

test("a check-in reads like something a person would say", () => {
  assert.equal(describe(checkIn()), "Every 30 min, 09:00 to 18:00 on weekdays");
  assert.equal(describe(checkIn({ every: 60, activeHours: undefined, days: [] })), "Every hour");
  assert.equal(describe(checkIn({ every: 120, activeHours: undefined, days: [1] })), "Every 2 hours on Mondays");
  assert.equal(describe(checkIn({ every: 90, days: [0, 6] })), "Every 90 min, 09:00 to 18:00 on weekends");
  assert.equal(describe(checkIn({ every: 15, days: [1, 3] })), "Every 15 min, 09:00 to 18:00 on Mon, Wed");
});

test("only the quiet word, alone, is a quiet answer", () => {
  for (const quiet of ["QUIET", "quiet", " Quiet. ", "QUIET!", "QUIET…", "\nQUIET\n"]) assert.equal(isQuietReply(quiet), true, quiet);
  for (const said of ["QUIET: one thing though", "Quiet day, nothing new", "Not quiet", "", "QUIETLY", undefined]) {
    assert.equal(isQuietReply(said), false, String(said));
  }
});

test("the note about last time is one line, cut where it is long", () => {
  assert.equal(lastReportNote(undefined), null);
  assert.equal(lastReportNote({ at: 1, summary: "  \n " }), null);
  assert.equal(
    lastReportNote({ at: 1, summary: "Two invoices are overdue:\n\n- Acme\n- Globex" }),
    "(Last time this routine reported: Two invoices are overdue: - Acme - Globex)",
  );
  const long = lastReportNote({ at: 1, summary: "word ".repeat(400) })!;
  const said = long.slice("(Last time this routine reported: ".length, -1);
  assert.ok(said.length <= LAST_REPORT_MAX, `${said.length} characters`);
  assert.ok(said.endsWith("…"));
});

test("changing a check-in's interval or hours restarts its slots, and its quiet runs keep the last report", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { spawnSync } = await import("node:child_process");
  // RoutineStore writes under the real data folder, so it runs in a child with its own HOME
  const home = mkdtempSync(join(tmpdir(), "bloks-checkin-store-"));
  try {
    const script = `
      import { RoutineStore } from ${JSON.stringify(new URL("../server/routines.ts", import.meta.url).href)};
      const store = new RoutineStore();
      const r = store.create({ targetId: "b", targetKind: "agent", prompt: "x", time: "09:00", days: [], enabled: true, every: 30, activeHours: { from: "09:00", to: "18:00" }, quiet: true });
      const made = r.scheduledAt;
      const wait = () => new Promise((ok) => setTimeout(ok, 20));
      await wait();
      store.patch(r.id, { every: 30, activeHours: { from: "09:00", to: "18:00" } });
      const sameWhenUnchanged = store.get(r.id).scheduledAt === made;
      store.patch(r.id, { every: 60 });
      const movedOnInterval = store.get(r.id).scheduledAt > made;
      const moved = store.get(r.id).scheduledAt;
      await wait();
      store.patch(r.id, { activeHours: { from: "10:00", to: "18:00" } });
      const movedOnHours = store.get(r.id).scheduledAt > moved;
      const said = store.beginRun(r.id, "lane");
      store.endRun(r.id, said.id, { state: "ok", summary: "Two invoices are overdue." });
      const quiet = store.beginRun(r.id, "lane");
      store.endRun(r.id, quiet.id, { state: "ok", summary: "QUIET", quiet: true });
      const failed = store.beginRun(r.id, "lane");
      store.endRun(r.id, failed.id, { state: "failed", summary: "half a sentence", error: "engine out" });
      const runs = store.get(r.id).runs;
      console.log(JSON.stringify({
        sameWhenUnchanged, movedOnInterval, movedOnHours,
        quietRun: { quiet: runs[1].quiet, state: runs[1].state, summary: runs[1].summary },
        lastReport: store.get(r.id).lastReport.summary,
      }));
    `;
    const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], { env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: "utf8" });
    const result = JSON.parse(run.stdout.trim().split("\n").pop() ?? "{}");
    assert.deepEqual(result, {
      sameWhenUnchanged: true,
      movedOnInterval: true,
      movedOnHours: true,
      quietRun: { quiet: true, state: "ok" },
      lastReport: "Two invoices are overdue.",
    }, run.stderr);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("the routes file a check-in, refuse what cannot run, and turn it back into a time of day", async (t) => {
  const h = await startHarness();
  t.after(() => h.stop());
  const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Watcher" }) });
  const { bot: other } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Helper" }) });
  const { blok } = await h.json("/api/bloks", { method: "POST", body: JSON.stringify({ name: "Ops", memberIds: [bot.id, other.id] }) });
  const post = (body: unknown) => h.fetch("/api/routines", { method: "POST", body: JSON.stringify(body) });

  const made = await post({ targetId: bot.id, targetKind: "agent", prompt: "Anything urgent?", every: 30, activeHours: { from: "09:00", to: "18:00" }, days: [] });
  assert.equal(made.status, 201);
  const { routine } = await made.json();
  assert.equal(routine.summary, "Every 30 min, 09:00 to 18:00");
  assert.equal(routine.quiet, true);
  assert.equal(routine.time, "09:00");
  const listed = (await h.json("/api/routines")).routines.find((r: any) => r.id === routine.id);
  const next = new Date(listed.nextRunAt);
  assert.ok(next.getTime() > Date.now());
  assert.ok(next.getMinutes() % 30 === 0 && next.getHours() >= 9 && next.getHours() <= 18, next.toString());

  const tooOften = await post({ targetId: bot.id, prompt: "x", every: 5 });
  assert.equal(tooOften.status, 400);
  assert.match((await tooOften.json()).error, /every 15 to 1440 minutes/);
  const forRoom = await post({ targetId: blok.id, targetKind: "room", prompt: "x", every: 30 });
  assert.equal(forRoom.status, 400);
  assert.match((await forRoom.json()).error, /for an agent/);

  const back = await h.fetch(`/api/routines/${routine.id}`, { method: "PATCH", body: JSON.stringify({ every: null, time: "08:30" }) });
  assert.equal(back.status, 200);
  const changed = (await back.json()).routine;
  assert.equal(changed.every, undefined);
  assert.equal(changed.activeHours, undefined);
  assert.equal(changed.quiet, undefined, "it was quiet for being a check-in");
  assert.equal(changed.summary, "Every day at 08:30");

  const again = await h.fetch(`/api/routines/${routine.id}`, { method: "PATCH", body: JSON.stringify({ every: 120, days: [1, 2, 3, 4, 5] }) });
  assert.equal((await again.json()).routine.summary, "Every 2 hours on weekdays");
  const once = await h.fetch(`/api/routines/${routine.id}`, { method: "PATCH", body: JSON.stringify({ repeat: "once", date: "2030-01-01" }) });
  assert.equal(once.status, 400);
  assert.match((await once.json()).error, /cannot also run once/);
});
