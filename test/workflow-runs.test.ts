// A busy workflow remembers its last few runs, and lets the oldest
// finished ones go to make room: never one still running, or waiting on
// an approval somebody may yet answer.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

// the store writes where the data folder is, so it is a throwaway one
const home = mkdtempSync(join(tmpdir(), "bloks-workflow-runs-"));
let workflows: typeof import("../server/workflows.ts");

before(async () => {
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  const config = await import("../server/config.ts");
  assert.equal(config.DATA_DIR, join(home, ".bloks"));
  workflows = await import("../server/workflows.ts");
});
after(() => rmSync(home, { recursive: true, force: true }));

test("starting runs past the limit drops finished ones, never one in flight", () => {
  const { MAX_RUNS, WorkflowStore } = workflows;
  const store = new WorkflowStore();
  const flow = store.create(
    { name: "Triage", enabled: true, trigger: { kind: "manual" }, steps: [{ id: "ask", action: "ask", targetId: "bot", text: "Look" }] },
    0,
  )!;

  // one run parked on an approval, one still running, then a busy day
  const waiting = store.begin(flow.id, {}, 1)!;
  store.update(waiting.id, (run) => {
    run.state = "waiting";
  });
  const running = store.begin(flow.id, {}, 2)!;
  for (let at = 3; at < 3 + MAX_RUNS * 2; at++) {
    const run = store.begin(flow.id, {}, at)!;
    store.update(run.id, (r) => {
      r.state = "done";
    });
  }

  const kept = store.get(flow.id)!.runs!;
  assert.ok(store.run(waiting.id), "the run waiting on an approval can still be found");
  assert.ok(store.run(running.id), "the run still going can still be found");
  assert.deepEqual(store.waiting().map((r) => r.id), [waiting.id]);
  assert.equal(kept.length, MAX_RUNS, "finished runs still make room");
  assert.equal(kept.filter((r) => r.state === "done").length, MAX_RUNS - 2);
  assert.equal(kept[0].startedAt, 2 + MAX_RUNS * 2, "the newest first");
});
