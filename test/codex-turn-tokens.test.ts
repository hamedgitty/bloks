// A Codex turn is charged its own tokens, not the thread's (#173).
//
// Codex reports `total` for the whole thread, and it carries on from turn
// to turn. Passed on as it was, a thread's second turn was charged for the
// first one again, and every later turn for all of them.
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { mkdtempSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { test, type TestContext } from "node:test";

import type { RuntimeEvent } from "../server/contracts.ts";
import { CodexDriver, turnBaseline } from "../server/drivers/codex.ts";
import { summarize, UsageStore } from "../server/usage.ts";

type Usage = { total: [number, number]; last?: [number, number] };

const usage = (thread: string, u: Usage) => ({
  method: "thread/tokenUsage/updated",
  params: {
    threadId: thread,
    tokenUsage: {
      total: { inputTokens: u.total[0], outputTokens: u.total[1] },
      ...(u.last ? { last: { inputTokens: u.last[0], outputTokens: u.last[1] } } : {}),
    },
  },
});

// An in-memory app-server that plays back the usage updates it is given
// for each turn, then completes the turn.
async function setup(t: TestContext, thread: string) {
  const script: { onResume: Usage[]; onTurn: Usage[] } = { onResume: [], onTurn: [] };
  t.mock.method(childProcess, "spawn", () => {
    const stdout = new PassThrough();
    const send = (msg: unknown) => stdout.write(JSON.stringify(msg) + "\n");
    return Object.assign(new EventEmitter(), {
      stdout,
      stderr: new PassThrough(),
      kill() {},
      stdin: new Writable({
        write(chunk, _encoding, done) {
          const frame = JSON.parse(String(chunk));
          if (frame.method && frame.id !== undefined) {
            const opens = frame.method === "thread/start" || frame.method === "thread/resume";
            queueMicrotask(() => {
              send({ id: frame.id, result: opens ? { thread: { id: thread } } : {} });
              if (frame.method === "thread/resume") for (const u of script.onResume) send(usage(thread, u));
              if (frame.method === "turn/start") {
                for (const u of script.onTurn) send(usage(thread, u));
                send({ method: "turn/completed", params: { turn: { status: "completed" } } });
              }
            });
          }
          done();
        },
      }),
    });
  });
  t.mock.method(fs, "appendFileSync", () => {});
  syncBuiltinESMExports();
  const instance = await CodexDriver.create({
    instanceId: "codex", displayName: "Codex", enabled: true, environment: {},
    config: { cli: "fake-codex", fullAuto: false },
  });
  const store = new UsageStore(join(mkdtempSync(join(tmpdir(), "bloks-usage-")), "usage.json"));
  instance.adapter.onEvent((event: RuntimeEvent) => {
    if (event.type === "thread.token-usage.updated") store.noteTokens("bot1", "codex", event.input, event.output);
    if (event.type === "turn.completed") store.recordTurn("bot1", "codex", null);
  });
  t.after(async () => {
    await instance.dispose();
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  /** One turn, and the input and output it banked. */
  async function turn(onTurn: Usage[], extra: Record<string, unknown> = {}) {
    script.onTurn = onTurn;
    const before = summarize(store.since(1), 1).total;
    await instance.adapter.sendTurn({ threadId: "task-a", text: "hi", ...extra });
    for (let i = 0; i < 50 && summarize(store.since(1), 1).total.turns === before.turns; i++) await setImmediate();
    const after = summarize(store.since(1), 1).total;
    return { input: after.input - before.input, output: after.output - before.output };
  }
  return { script, turn };
}

// The numbers from the issue: turn one ends at 105,553 input tokens for
// the thread, turn two's first update says 138,016 and its last 2,496,354.
const turnOne: Usage[] = [
  { total: [60_000, 400], last: [60_000, 400] },
  { total: [105_553, 900], last: [45_553, 500] },
];
const turnTwo: Usage[] = [
  { total: [138_016, 1_200], last: [32_463, 300] },
  { total: [138_016, 1_200], last: [32_463, 300] },
  { total: [2_496_354, 9_000], last: [70_000, 600] },
];

test("a second turn is charged from where the first one ended", async (t) => {
  const h = await setup(t, "thread-in-one-run");
  assert.deepEqual(await h.turn(turnOne), { input: 105_553, output: 900 });
  // 2,496,354 less the 105,553 the thread had already spent; the repeated
  // update in the middle changes nothing
  assert.deepEqual(await h.turn(turnTwo, { resumeCursor: "thread-in-one-run" }), {
    input: 2_390_801,
    output: 8_100,
  });
});

test("after a restart, a resumed thread's history is not charged again", async (t) => {
  // Nothing is remembered for this thread, so the first update's total
  // less its own call is what the thread had spent before the turn.
  const h = await setup(t, "thread-after-restart");
  assert.deepEqual(await h.turn(turnTwo, { resumeCursor: "thread-after-restart" }), {
    input: 2_390_801,
    output: 8_100,
  });
});

test("usage reported on resume, before the turn starts, is the baseline", async (t) => {
  const h = await setup(t, "thread-replayed");
  h.script.onResume = [{ total: [105_553, 900], last: [45_553, 500] }];
  assert.deepEqual(await h.turn(turnTwo, { resumeCursor: "thread-replayed" }), {
    input: 2_390_801,
    output: 8_100,
  });
});

test("a thread whose count started again is not charged a negative turn", () => {
  const base = turnBaseline({ input: 500_000, output: 4_000 }, { input: 40_000, output: 300 }, { input: 40_000, output: 300 });
  assert.deepEqual(base, { input: 0, output: 0 });
});

test("without the last call, the turn counts from its first update", () => {
  // undercounting one call beats charging the whole thread again
  assert.deepEqual(turnBaseline(undefined, { input: 138_016, output: 1_200 }, null), { input: 138_016, output: 1_200 });
});
