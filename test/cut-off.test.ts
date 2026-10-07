// Turns cut off by Bloks stopping, as the list on disk keeps them, and
// what each one gets when Bloks starts again (server/cut-off.ts; GitHub
// 160). The whole round trip, through a real restart, is in
// restart-recovery.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  carryOnTarget,
  carryOnText,
  cutOffNotice,
  recoveryFor,
  RESTART_TEXT,
  SLEPT_TEXT,
  TurnsInFlight,
  type TurnInFlight,
} from "../server/cut-off.ts";
import { MAX_QUEUED_RECOVERY_MS, MAX_TURNS_IN_FLIGHT } from "../server/limits.ts";

const scratch = (t: { after: (fn: () => void) => void }) => {
  const dir = mkdtempSync(join(tmpdir(), "bloks-cutoff-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "turns-in-flight.json");
};

const turn = (over: Partial<TurnInFlight> = {}): TurnInFlight => ({
  laneId: "lane1",
  botId: "bot1",
  startedAt: 1_000,
  seenAt: 1_000,
  ...over,
});

test("a turn is on disk from its start to its end, and nothing else ever takes it off", (t) => {
  const file = scratch(t);
  const list = new TurnsInFlight(file);
  list.begin({ laneId: "lane1", botId: "bot1", requester: "owner", instanceId: "claude", session: "sess-1", startedAt: 5 }, 5);
  list.tool("lane1", "Bash: npm publish", 6);
  // a crash here: a fresh read of the file is all the next start has
  const after = new TurnsInFlight(file).get("lane1");
  assert.equal(after?.tool, "Bash: npm publish");
  assert.equal(after?.session, "sess-1");
  assert.equal(after?.seenAt, 6);

  list.tool("lane1", null);
  assert.equal(new TurnsInFlight(file).get("lane1")?.tool, undefined, "a call that reported back is not the one in flight");
  list.end("lane1");
  assert.deepEqual(new TurnsInFlight(file).all(), []);
});

test("a stop on the way out is not the turn ending", (t) => {
  // Engines shut down on SIGTERM end their turns as they go. Reading
  // those endings as the turns finishing would make a clean quit the one
  // stop that loses them.
  const file = scratch(t);
  const list = new TurnsInFlight(file);
  list.begin({ laneId: "lane1", botId: "bot1", startedAt: 1 }, 1);
  list.close();
  list.end("lane1");
  assert.equal(new TurnsInFlight(file).all().length, 1);
});

test("Stop is remembered until the turn ends, so a stop Bloks did not live to finish stays a stop", (t) => {
  const file = scratch(t);
  const list = new TurnsInFlight(file);
  list.begin({ laneId: "lane1", botId: "bot1", startedAt: 1 }, 1);
  list.stop("lane1");
  const left = new TurnsInFlight(file).get("lane1")!;
  assert.equal(left.stopped, true);
  assert.equal(recoveryFor(left, 2, { agent: {}, lane: true }), "drop");
});

test("taken off before it is acted on, so a second start never finds it", (t) => {
  const file = scratch(t);
  const list = new TurnsInFlight(file);
  list.begin({ laneId: "lane1", botId: "bot1", startedAt: 1 }, 1);
  const second = new TurnsInFlight(file);
  assert.ok(second.take("lane1"));
  assert.deepEqual(new TurnsInFlight(file).all(), []);
  assert.equal(second.take("lane1"), null);
});

test("a new turn in the lane retires a Continue still waiting there", (t) => {
  const list = new TurnsInFlight(scratch(t));
  list.begin({ laneId: "lane1", botId: "bot1", startedAt: 1 }, 1);
  list.wait("lane1", { noticeId: "n1", threadId: "lane1" }, 2);
  // a waiting one is not running, and its turn ending is not this
  assert.deepEqual(list.running(), []);
  list.end("lane1");
  assert.ok(list.get("lane1")?.waiting);
  const replaced = list.begin({ laneId: "lane1", botId: "bot1", startedAt: 3 }, 3);
  assert.equal(replaced?.waiting?.noticeId, "n1");
  assert.equal(list.get("lane1")?.waiting, undefined);
});

test("what reaches the disk is capped, and junk in the file is dropped", (t) => {
  const file = scratch(t);
  const list = new TurnsInFlight(file);
  list.begin(
    { laneId: "lane1", botId: "bot1", session: "s".repeat(5_000), tool: "t".repeat(5_000), startedAt: 1 } as never,
    1,
  );
  list.tool("lane1", "x".repeat(5_000));
  const kept = JSON.parse(readFileSync(file, "utf8"))[0];
  assert.ok(kept.session.length <= 200);
  assert.ok(kept.tool.length <= 160);
  for (let i = 0; i < MAX_TURNS_IN_FLIGHT + 20; i++) list.begin({ laneId: `l${i}`, botId: "b", startedAt: i }, i);
  assert.equal(new TurnsInFlight(file).all().length, MAX_TURNS_IN_FLIGHT);

  writeFileSync(file, JSON.stringify([null, 7, { laneId: "x" }, { laneId: "ok", botId: "b", startedAt: 1, seenAt: 1, stopped: "yes" }]));
  const read = new TurnsInFlight(file).all();
  assert.equal(read.length, 1);
  assert.equal(read[0].stopped, undefined, "only true is a stop");
});

test("what a turn left behind gets at the next start", () => {
  const now = 10 * MAX_QUEUED_RECOVERY_MS;
  const here = { agent: {}, lane: true };
  assert.equal(recoveryFor(turn({ seenAt: now - 60_000 }), now, here), "continue");
  // gone too long: the person decides, as with a queued message
  assert.equal(recoveryFor(turn({ seenAt: now - MAX_QUEUED_RECOVERY_MS - 1 }), now, here), "ask");
  // a pickup cut off in its turn would otherwise go round every restart
  assert.equal(recoveryFor(turn({ seenAt: now - 60_000, carriedOn: true }), now, here), "ask");
  // never revived: a stop, an archived agent, a lane or agent gone, a
  // workflow step (its run is settled on its own)
  assert.equal(recoveryFor(turn({ seenAt: now, stopped: true }), now, here), "drop");
  assert.equal(recoveryFor(turn({ seenAt: now }), now, { agent: { archivedAt: 5 }, lane: true }), "drop");
  assert.equal(recoveryFor(turn({ seenAt: now }), now, { agent: null, lane: true }), "drop");
  assert.equal(recoveryFor(turn({ seenAt: now }), now, { agent: {}, lane: false }), "drop");
  assert.equal(recoveryFor(turn({ seenAt: now, workflow: true }), now, here), "drop");
});

test("a pickup in a shared room runs for whoever asked, never as the owner by default", () => {
  const target = carryOnTarget(turn({ roomId: "room1", requester: "p_sam" }));
  assert.equal(target.taskId, "lane1");
  assert.equal(target.roomId, "room1");
  assert.equal(target.requester, "p_sam");
  assert.equal(carryOnTarget(turn()).requester, undefined);
});

test("the person reads a notice; the agent is told to check before repeating", () => {
  assert.equal(cutOffNotice("Ivy", "restart"), "Ivy was cut off when Bloks stopped, and is picking up where it left off.");
  assert.equal(cutOffNotice("Ivy", "sleep"), "Ivy was cut off when this computer slept, and is picking up where it left off.");

  const told = carryOnText("restart", { tool: "Bash: npm publish", said: "Actually, do not publish." });
  assert.ok(told.startsWith(RESTART_TEXT));
  assert.match(told, /check what already happened before repeating anything/);
  assert.match(told, /not a new request/);
  // the call whose result nobody saw, by name
  assert.match(told, /Bash: npm publish/);
  assert.match(told, /not known/);
  // and newer words, to read before going on with the older plan
  assert.match(told, /Actually, do not publish\./);
  assert.equal(carryOnText("sleep"), SLEPT_TEXT, "sleep says what it always said");
  // an engine rebuilt under the turn is picked up the same way
  assert.equal(cutOffNotice("Ivy", "reload"), "Ivy was cut off when its engine restarted, and is picking up where it left off.");
  assert.match(carryOnText("reload"), /not a new request/);
});
