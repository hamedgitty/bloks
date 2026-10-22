import assert from "node:assert/strict";
import { test } from "node:test";
import { runElapsed, runSource } from "../src/lib/routineDetails.ts";

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
