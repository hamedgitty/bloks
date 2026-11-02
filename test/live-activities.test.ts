// The rules a phone's Live Activities follow on this side, without a
// server around them (server/live-activities.ts). The whole path, from a
// turn to a push through a relay, is in live-activity-push.test.ts.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LiveActivities, type ActivityPush, type PushResult } from "../server/live-activities.ts";

const token = (n: number) => n.toString(16).padStart(2, "0").repeat(40);
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));

function fixture(opts: { file?: string | null; result?: () => PushResult } = {}) {
  const busy = new Set<string>();
  const devices = [{ id: "phone-a" }];
  const pushes: ActivityPush[] = [];
  const live = new LiveActivities({
    file: opts.file ?? null,
    devices: () => devices,
    running: (lane) => busy.has(lane),
    laneOf: (agent) => [...busy].find((lane) => lane.startsWith(agent)) ?? null,
    turn: (lane) => ({ agentId: lane.split("-")[0], startedAt: 1_000, where: lane, words: { name: `Agent ${lane}`, color: "blue", shape: "star", task: "Example" } }),
    seal: (deviceId, words) => `sealed:${deviceId}:${words.name}${words.question ? `:${words.question}` : ""}`,
    send: async (push) => {
      pushes.push(push);
      return opts.result?.() ?? "ok";
    },
    startDelayMs: 10,
    endDelayMs: 10,
  });
  return { live, busy, devices, pushes };
}

test("the newest turn replaces the oldest past two, and the phone that has one already gets none", async () => {
  const f = fixture();
  f.live.register("phone-a", { env: "sandbox", start: token(1), activities: [{ token: token(2), agentId: "a1", laneId: "a1-lane" }] });
  for (const lane of ["a1-lane", "b2-lane", "c3-lane"]) {
    f.busy.add(lane);
    f.live.started(lane);
    await tick();
  }
  const starts = f.pushes.filter((p) => p.event === "start");
  assert.deepEqual(starts.map((p) => p.agentId), ["b2", "c3"], "the phone already showed a1's turn");
  assert.equal(starts[0].sealed, "sealed:phone-a:Agent b2-lane");
  assert.equal(starts[0].env, "sandbox");
  // the third ended the oldest, the one the phone started itself
  const ended = f.pushes.filter((p) => p.event === "end");
  assert.deepEqual(ended.map((p) => p.token), [token(2)]);
  assert.deepEqual(f.live.describe("phone-a").activities.map((a) => a.agentId), ["b2", "c3"]);
});

test("a lane busy again before the wait is over is the same turn, and keeps its activity", async () => {
  const f = fixture();
  f.busy.add("a1-lane");
  f.live.register("phone-a", { activities: [{ token: token(2), agentId: "a1", laneId: "a1-lane" }] });
  // failed, and asked again a beat later
  f.busy.delete("a1-lane");
  f.live.settled("a1-lane");
  f.busy.add("a1-lane");
  await tick();
  assert.equal(f.pushes.length, 0, "a retried turn lost its activity");
  f.busy.delete("a1-lane");
  f.live.settled("a1-lane");
  await tick();
  assert.deepEqual(f.pushes.map((p) => [p.event, p.token]), [["end", token(2)]]);
  assert.equal(f.pushes[0].env, "production", "a phone that does not say is a production build");
});

test("a token reported after its turn ended is ended at once, and a turn over before the delay starts nothing", async () => {
  const f = fixture();
  f.live.register("phone-a", { start: token(1) });
  f.busy.add("a1-lane");
  f.live.started("a1-lane");
  f.busy.delete("a1-lane");
  f.live.settled("a1-lane");
  await tick();
  assert.equal(f.pushes.length, 0, "a turn over in a moment still put an activity up");

  f.busy.add("b2-lane");
  f.live.started("b2-lane");
  await tick();
  assert.equal(f.pushes.at(-1)?.event, "start");
  // the turn ends before the woken phone reports the new activity's token
  f.busy.delete("b2-lane");
  f.live.settled("b2-lane");
  await tick();
  assert.equal(f.pushes.filter((p) => p.event === "end").length, 0, "nothing to end it with yet");
  f.live.register("phone-a", { activities: [{ token: token(3), agentId: "b2", laneId: "b2-lane" }] });
  await tick();
  assert.deepEqual(f.pushes.filter((p) => p.event === "end").map((p) => p.token), [token(3)]);
});

test("a start token Apple retired is dropped", async () => {
  const f = fixture({ result: () => "gone" });
  f.live.register("phone-a", { start: token(1) });
  f.busy.add("a1-lane");
  f.live.started("a1-lane");
  await tick();
  assert.deepEqual(f.live.describe("phone-a"), { start: false, activities: [] });
});

test("waiting changes only when a card does, and only for the card it showed", async () => {
  const f = fixture();
  f.busy.add("a1-lane");
  f.live.register("phone-a", { activities: [{ token: token(2), agentId: "a1", laneId: "a1-lane" }] });
  f.live.waiting("a1-lane", "card-1", true, "Ship the example?");
  f.live.waiting("a1-lane", "card-1", true, "Ship the example?");
  f.live.waiting("elsewhere", "card-9", true, "Not this one");
  f.live.waiting("a1-lane", "card-2", false);
  assert.deepEqual(f.pushes.map((p) => [p.event, p.state, p.sealed]), [["update", "needs-you", "sealed:phone-a:Agent a1-lane:Ship the example?"]]);
  f.live.waiting("a1-lane", "card-1", false);
  assert.deepEqual(f.pushes.at(-1) && [f.pushes.at(-1)!.state, f.pushes.at(-1)!.sealed], ["working", "sealed:phone-a:Agent a1-lane"]);
});

test("a card that comes before a pushed activity's token is shown once the token does", async () => {
  const f = fixture();
  f.live.register("phone-a", { start: token(1) });
  f.busy.add("a1-lane");
  f.live.started("a1-lane");
  await tick();
  f.live.waiting("a1-lane", "card-1", true, "Ship the example?");
  assert.deepEqual(f.pushes.map((p) => p.event), ["start"], "nothing to reach it with yet");
  f.live.register("phone-a", { activities: [{ token: token(2), agentId: "a1", laneId: "a1-lane" }] });
  assert.deepEqual(f.pushes.at(-1) && [f.pushes.at(-1)!.event, f.pushes.at(-1)!.state, f.pushes.at(-1)!.token], ["update", "needs-you", token(2)]);
  assert.equal(f.pushes.at(-1)!.sealed, "sealed:phone-a:Agent a1-lane:Ship the example?");
});

test("tokens survive a restart, the sweep ends what the restart left behind, and an unpaired phone loses everything", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bloks-activities-"));
  try {
    const file = join(dir, "live-activities.json");
    const before = fixture({ file });
    before.busy.add("a1-lane");
    before.live.register("phone-a", { start: token(1), activities: [{ token: token(2), agentId: "a1", laneId: "a1-lane" }] });
    before.live.register("stranger", { start: token(5) });
    assert.doesNotMatch(readFileSync(file, "utf8"), /stranger/, "a device that is not paired handed something over");
    before.live.stop();

    // after the restart nothing is busy: the turn is over, and its
    // activity ends once it has been settled long enough
    const after = fixture({ file });
    assert.deepEqual(after.live.describe("phone-a"), { start: true, activities: [{ agentId: "a1", laneId: "a1-lane", reported: true }] });
    await tick(30);
    after.live.sweep();
    assert.deepEqual(after.pushes.map((p) => [p.event, p.token]), [["end", token(2)]]);

    after.devices.length = 0;
    after.live.sweep();
    assert.equal(readFileSync(file, "utf8"), JSON.stringify({ devices: {} }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an activity quieted before its token came is kept when the person leaves again, not ended or doubled", async () => {
  const f = fixture();
  f.live.register("phone-a", { start: token(1) });
  f.busy.add("a1-lane");
  f.live.started("a1-lane");
  await tick();
  assert.deepEqual(f.pushes.map((p) => p.event), ["start"]);
  // at the computer before the phone reported the activity's token
  f.live.present();
  // and away again, the turn still going
  f.live.away();
  await tick();
  assert.deepEqual(f.pushes.map((p) => p.event), ["start"], "the phone has it already: no second start");
  f.live.register("phone-a", { activities: [{ token: token(2), agentId: "a1", laneId: "a1-lane" }] });
  await tick();
  assert.equal(f.pushes.filter((p) => p.event === "end").length, 0, "the activity the person left with stays up");
});
