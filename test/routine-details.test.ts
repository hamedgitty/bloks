import assert from "node:assert/strict";
import { test } from "node:test";
import { routinePatch, runElapsed, runSource, type RoutineDraft } from "../src/lib/routineDetails.ts";

test("elapsed time uses actual timestamps, in seconds, minutes and hours", () => {
  for (const [elapsed, expected] of [
    [0, "Less than a second"], [3_000, "3 sec"], [60_000, "1 min"],
    [126_000, "2 min 6 sec"], [3_600_000, "1 hr"], [3_726_000, "1 hr 2 min"],
  ] as const) {
    assert.equal(runElapsed({ state: "ok", startedAt: 1000, endedAt: 1000 + elapsed }), expected);
  }
});

test("a running or failed run is not assigned the calendar duration", () => {
  assert.equal(runElapsed({ state: "running", startedAt: 1000 }), "Running");
  assert.equal(runElapsed({ state: "failed", startedAt: 1000, endedAt: 91_000 }), "1 min 30 sec");
});

test("missing or invalid elapsed timestamps are disclosed", () => {
  for (const endedAt of [undefined, NaN, Infinity, 0]) {
    assert.equal(runElapsed({ state: "ok", startedAt: 1000, endedAt }), "Duration unavailable");
  }
  assert.equal(runElapsed({ state: "ok", startedAt: NaN, endedAt: 1000 }), "Duration unavailable");
});

const routine = { targetKind: "agent" as const, targetId: "agent-a" };
const bots = [
  { id: "agent-a", threadId: "current-a", tasks: [{ id: "current-a" }, { id: "source-a" }] },
  { id: "agent-b", threadId: "current-b", tasks: [{ id: "source-b" }] },
];

test("source navigation retains the exact run conversation, not the active one", () => {
  assert.deepEqual(runSource(routine, { threadId: "source-a" }, bots, []), {
    kind: "agent", id: "agent-a", taskId: "source-a",
  });
});

test("legacy or deleted run lanes never guess the current conversation", () => {
  assert.equal(runSource(routine, {}, bots, []), null);
  assert.equal(runSource(routine, { threadId: "deleted" }, bots, []), null);
  assert.equal(runSource(routine, { threadId: "source-a" }, [], []), null);
});

test("a lane owned by another target cannot become this run's source", () => {
  assert.equal(runSource(routine, { threadId: "source-b" }, bots, []), null);
});

test("an existing active conversation remains navigable without a tasks inventory", () => {
  assert.deepEqual(runSource(routine, { threadId: "current-a" }, [bots[0]], []), {
    kind: "agent", id: "agent-a", taskId: "current-a",
  });
  assert.deepEqual(runSource(routine, { threadId: "current-a" }, [{ id: "agent-a", threadId: "current-a" }], []), {
    kind: "agent", id: "agent-a", taskId: "current-a",
  });
});

test("room navigation requires the recorded room and a retained target", () => {
  const room = { targetKind: "room" as const, targetId: "room-a" };
  assert.deepEqual(runSource(room, { threadId: "room-a" }, bots, [{ id: "room-a" }]), { kind: "room", id: "room-a" });
  assert.equal(runSource(room, { threadId: "room-b" }, bots, [{ id: "room-a" }]), null);
  assert.equal(runSource(room, {}, bots, [{ id: "room-a" }]), null);
  assert.equal(runSource(room, { threadId: "room-a" }, bots, []), null);
});

const weekly: RoutineDraft = {
  targetId: "agent-a", targetKind: "agent", name: "Digest", prompt: "Sum it up.",
  time: "09:00", days: [1, 3], durationMin: 30, runsOn: "cloud", thread: "News",
};

test("an edit sends only what changed, and nothing when nothing did", () => {
  assert.deepEqual(routinePatch(weekly, { ...weekly }), {});
  assert.deepEqual(routinePatch(weekly, { ...weekly, days: [3, 1] }), {}, "the same days in another order");
  assert.deepEqual(routinePatch(weekly, { ...weekly, name: "Brief", prompt: "Say it.", time: "07:30" }), {
    name: "Brief", prompt: "Say it.", time: "07:30",
  });
  assert.deepEqual(routinePatch(weekly, { ...weekly, targetId: "agent-b" }), {}, "the target is never sent");
});

test("a field taken away is sent cleared, the way the server clears it", () => {
  const { name: _name, runsOn: _runsOn, thread: _thread, ...bare } = weekly;
  assert.deepEqual(routinePatch(weekly, bare), { name: "", runsOn: null, thread: null });
});

test("changing the kind of schedule clears the old one", () => {
  const once: RoutineDraft = { ...weekly, days: [], repeat: "once", date: "2026-11-02" };
  assert.deepEqual(routinePatch(once, weekly), { days: [1, 3], repeat: "weekly" });

  const { time: _time, durationMin: _duration, ...rest } = weekly;
  const checkIn: RoutineDraft = { ...rest, every: 30, activeHours: { from: "09:00", to: "18:00" } };
  assert.deepEqual(routinePatch(checkIn, { ...weekly, quiet: true }), {
    time: "09:00", durationMin: 30, every: null, activeHours: null, quiet: true,
  });
  assert.deepEqual(routinePatch(weekly, checkIn), { every: 30, activeHours: { from: "09:00", to: "18:00" } });
  assert.deepEqual(routinePatch(checkIn, { ...checkIn, activeHours: undefined }), { activeHours: null }, "all day");
  assert.deepEqual(routinePatch({ ...weekly, quiet: true }, weekly), { quiet: false });
});
