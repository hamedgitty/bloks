import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

function isolated(script: string) {
  const home = mkdtempSync(join(tmpdir(), "bloks-routine-hold-"));
  try {
    return execFileSync(process.execPath, ["--input-type=module", "-e", `
      import assert from "node:assert/strict";
      import { RoutineStore, MAX_ROUTINES, MAX_RUNS, isDue } from ${JSON.stringify(new URL("../server/routines.ts", import.meta.url).href)};
      const store = new RoutineStore();
      const input = { targetId: "example", targetKind: "agent", prompt: "Example work", time: "09:00", days: [], enabled: true };
      ${script}
    `], { env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: "utf8" });
  } finally { rmSync(home, { recursive: true, force: true }); }
}

test("three held ticks record one attempt without consuming a slot; the next slot is new", () => {
  isolated(`
    const routine = store.create({ ...input, repeat: "once", date: "2030-01-08" });
    routine.scheduledAt = 0;
    const slot = new Date("2030-01-08T09:00:00").getTime();
    const before = store.beginRun(routine.id, "lane");
    store.endRun(routine.id, before.id, { state: "ok", summary: "Earlier actual work" });
    assert.equal(store.holdRun(routine.id, slot, "lane", "Held at limit12"), true);
    assert.equal(store.holdRun(routine.id, slot, "lane", "Held at limit12"), false);
    assert.equal(store.holdRun(routine.id, slot, "lane", "Held at limit12"), false);
    assert.equal(routine.runs.length, 2);
    const firstId = routine.runs[0].id;
    assert.equal(routine.enabled, true);
    assert.equal(routine.lastRunAt, undefined);
    assert.equal(isDue(routine, new Date(slot + 60_000)), true);
    assert.equal(store.holdRun(routine.id, slot + 86_400_000, "lane", "Held at limit12"), true);
    assert.notEqual(routine.runs[0].id, firstId);
    assert.equal(routine.runs.length, 2);
    assert.equal(routine.runs[1].id, before.id);
    assert.equal(new RoutineStore().get(routine.id).runs[0].heldSlot, slot + 86_400_000);
    store.markRan(routine.id, slot + 60_000);
    assert.equal(routine.enabled, false);
    assert.equal(isDue(routine, new Date(slot + 90_000)), false);
  `);
});

test("blocked slots and a changed limit cannot evict real run history", () => {
  isolated(`
    const routine = store.create(input);
    const ids = [];
    for (let i = 0; i < MAX_RUNS; i++) {
      const run = store.beginRun(routine.id, "lane"); ids.unshift(run.id);
      store.endRun(routine.id, run.id, { state: "ok", summary: "Actual run" });
    }
    for (let i = 0; i < MAX_RUNS + 5; i++) store.holdRun(routine.id, i, "lane", "Held at limit12");
    assert.deepEqual(routine.runs.filter(r => r.heldSlot === undefined).map(r => r.id), ids);
    assert.equal(routine.runs.filter(r => r.heldSlot !== undefined).length, 1);
    assert.equal(store.holdRun(routine.id, MAX_RUNS + 4, "lane", "Held at limit11"), true);
    assert.equal(routine.runs[0].error, "Held at limit11");
    assert.equal(routine.runs.length, MAX_RUNS + 1);
    const accepted = store.beginRun(routine.id, "lane");
    assert.equal(routine.runs[0].id, accepted.id);
    assert.equal(routine.runs.filter(r => r.heldSlot === undefined).length, MAX_RUNS);
    assert.equal(routine.runs.filter(r => r.heldSlot !== undefined).length, 1);
  `);
});

test("a missed once slot stays enabled, not due or spent, and counts against capacity", () => {
  assert.equal(isolated(`
    for (let i = 0; i < MAX_ROUTINES; i++) {
      const routine = store.create({ ...input, repeat: "once", date: "2020-01-08" });
      routine.scheduledAt = 0;
      assert.equal(isDue(routine, new Date("2030-01-08T12:00:00")), false);
      assert.equal(routine.enabled, true);
      assert.equal(routine.lastRunAt, undefined);
    }
    assert.equal(store.create(input), null, "missed slots were treated as spent and evicted");
    console.log("capacity preserved");
  `).trim(), "capacity preserved");
});
