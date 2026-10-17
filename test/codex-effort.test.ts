// Effort belongs to turn/start, including after a thread is resumed.
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough, Writable } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { test, type TestContext } from "node:test";

import type { RuntimeEvent, SendTurnInput } from "../server/contracts.ts";
import { CodexDriver } from "../server/drivers/codex.ts";

interface Options {
  rejectEffort?: boolean;
  turnError?: string;
  startError?: string;
}

async function setup(t: TestContext, options: Options = {}) {
  const frames: any[] = [];
  const effective: string[] = [];
  let threadEffort = "max";
  t.mock.method(childProcess, "spawn", () => {
    const stdout = new PassThrough();
    return Object.assign(new EventEmitter(), {
      stdout,
      stderr: new PassThrough(),
      kill() {},
      stdin: new Writable({
        write(chunk, _encoding, done) {
          const frame = JSON.parse(String(chunk));
          frames.push(frame);
          if (frame.method && frame.id !== undefined) {
            const error = frame.method === "thread/start" ? options.startError
              : frame.method === "turn/start" ? options.turnError || (options.rejectEffort && frame.params.effort ? "unknown field `effort`" : undefined)
              : undefined;
            const result = frame.method === "thread/start" || frame.method === "thread/resume"
              ? { thread: { id: "codex-thread" }, serviceTier: frame.params.serviceTier, model: "gpt-selected" }
              : frame.method === "turn/start" ? { turn: { id: "codex-turn" } } : {};
            if (frame.method === "turn/start" && !error) {
              // The server keeps its configured default until a turn overrides
              // it, then retains that override for later turns in the thread.
              if (frame.params.effort) threadEffort = frame.params.effort;
              effective.push(threadEffort);
            }
            queueMicrotask(() => {
              stdout.write(JSON.stringify(error ? { id: frame.id, error: { code: -32600, message: error } } : { id: frame.id, result }) + "\n");
              if (frame.method === "turn/start" && !error) {
                stdout.write(JSON.stringify({ method: "turn/completed", params: { turn: { status: "completed" } } }) + "\n");
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
  const events: RuntimeEvent[] = [];
  instance.adapter.onEvent((event) => events.push(event));
  t.after(async () => {
    await instance.dispose();
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  async function turn(extra: Partial<SendTurnInput> = {}) {
    const before = events.filter((event) => event.type === "turn.completed").length;
    await instance.adapter.sendTurn({ threadId: "task-a", text: "Keep these words", ...extra });
    for (let i = 0; i < 100 && events.filter((event) => event.type === "turn.completed").length === before; i++) await setImmediate();
    const completed = events.filter((event) => event.type === "turn.completed");
    assert.equal(completed.length, before + 1, "the turn must settle exactly once");
    return completed.at(-1)!;
  }
  return { frames, events, effective, turn };
}

const sent = (frames: any[], method: string) => frames.filter((frame) => frame.method === method).map((frame) => frame.params);

for (const resumed of [false, true]) {
  test(`${resumed ? "a resumed" : "a new"} turn uses the selected effort instead of the CLI default`, async (t) => {
    const h = await setup(t);
    const completed = await h.turn({ effort: "high", model: "gpt-selected", resumeCursor: resumed ? "codex-thread" : undefined });
    const starts = sent(h.frames, "turn/start");
    assert.equal(starts.length, 1);
    assert.equal(starts[0].effort, "high");
    assert.deepEqual(h.effective, ["high"]);
    assert.equal(completed.type === "turn.completed" && completed.ok, true);
    const opened = [...sent(h.frames, "thread/start"), ...sent(h.frames, "thread/resume")];
    assert.equal(opened.length, 1);
    assert.equal("effort" in opened[0], false);
    assert.equal("reasoningEffort" in opened[0], false);
    assert.equal(opened[0].model, "gpt-selected");
    assert.equal(opened[0].sandbox, "workspace-write");
    assert.equal(opened[0].approvalPolicy, "on-request");
  });

  test(`${resumed ? "a resumed" : "a new"} turn without a preference omits effort`, async (t) => {
    const h = await setup(t);
    await h.turn({ resumeCursor: resumed ? "codex-thread" : undefined });
    const [start] = sent(h.frames, "turn/start");
    assert.equal("effort" in start, false);
    assert.equal("reasoningEffort" in start, false);
    assert.deepEqual(h.effective, ["max"]);
  });

  test(`${resumed ? "a resumed" : "a new"} turn still sends its words when an older server refuses effort`, async (t) => {
    const h = await setup(t, { rejectEffort: true });
    const completed = await h.turn({ effort: "high", system: "System words", resumeCursor: resumed ? "codex-thread" : undefined });
    const starts = sent(h.frames, "turn/start");
    assert.equal(starts.length, 2);
    assert.equal(starts[0].effort, "high");
    assert.equal("effort" in starts[1], false);
    const { effort: _effort, ...withoutEffort } = starts[0];
    assert.deepEqual(starts[1], withoutEffort);
    assert.deepEqual(starts[1].input, [{ type: "text", text: "System words\n\nKeep these words" }]);
    assert.deepEqual(h.effective, ["max"]);
    assert.equal(h.events.some((event) => event.type === "runtime.error"), false);
    assert.equal(completed.type === "turn.completed" && completed.ok, true);
  });
}

test("a later preference overrides the effort already held by the resumed thread", async (t) => {
  const h = await setup(t);
  await h.turn({ effort: "high" });
  await h.turn({ effort: "low", resumeCursor: "codex-thread" });
  await h.turn({ effort: "medium", resumeCursor: "codex-thread" });
  assert.deepEqual(sent(h.frames, "turn/start").map((params) => params.effort), ["high", "low", "medium"]);
  assert.deepEqual(h.effective, ["high", "low", "medium"]);
});

test("an effort refusal is retried only once and then fails normally", async (t) => {
  const h = await setup(t, { turnError: "unsupported effort" });
  const completed = await h.turn({ effort: "high" });
  assert.equal(sent(h.frames, "turn/start").length, 2);
  assert.deepEqual(h.effective, []);
  assert.equal(completed.type === "turn.completed" && completed.ok, false);
  assert.equal(completed.type === "turn.completed" && completed.stopReason, "rpc_error");
  assert.equal(h.events.filter((event) => event.type === "runtime.error").length, 1);
});

test("a refusal without a selected effort does not send the words again", async (t) => {
  const h = await setup(t, { turnError: "unknown field" });
  const completed = await h.turn();
  assert.equal(sent(h.frames, "turn/start").length, 1);
  assert.equal(completed.type === "turn.completed" && completed.ok, false);
});

test("an unrelated turn error is not retried without effort", async (t) => {
  const h = await setup(t, { turnError: "conversation unavailable" });
  const completed = await h.turn({ effort: "high" });
  assert.equal(sent(h.frames, "turn/start").length, 1);
  assert.equal(completed.type === "turn.completed" && completed.ok, false);
});

test("opening a thread no longer retries a failure as an effort fallback", async (t) => {
  const h = await setup(t, { startError: "conversation unavailable" });
  const completed = await h.turn({ effort: "high" });
  assert.equal(sent(h.frames, "thread/start").length, 1);
  assert.equal(sent(h.frames, "turn/start").length, 0);
  assert.equal(completed.type === "turn.completed" && completed.ok, false);
});
