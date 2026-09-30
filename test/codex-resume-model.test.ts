// The model picked for a Codex agent has to reach Codex on every turn,
// not only the one that started the conversation.
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough, Writable } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { test, type TestContext } from "node:test";

import type { RuntimeEvent } from "../server/contracts.ts";
import { CodexDriver } from "../server/drivers/codex.ts";

// An in-memory app-server that remembers the thread's model the way the
// real one does: a resume without a model keeps the one it started with.
async function setup(t: TestContext) {
  const frames: any[] = [];
  let threadModel = "gpt-started-with";
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
            if (frame.method === "thread/start" || frame.method === "thread/resume") {
              if (frame.params.model) threadModel = frame.params.model;
            }
            const result =
              frame.method === "thread/start" || frame.method === "thread/resume"
                ? { thread: { id: "codex-thread" }, model: threadModel }
                : {};
            queueMicrotask(() => {
              stdout.write(JSON.stringify({ id: frame.id, result }) + "\n");
              if (frame.method === "turn/start") {
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
  async function turn(extra: Record<string, unknown>) {
    const before = events.filter((e) => e.type === "turn.completed").length;
    await instance.adapter.sendTurn({ threadId: "task-a", text: "hi", ...extra });
    for (let i = 0; i < 50 && events.filter((e) => e.type === "turn.completed").length === before; i++) await setImmediate();
  }
  return { frames, events, turn };
}

const sent = (frames: any[], method: string) => frames.filter((f) => f.method === method).map((f) => f.params);
const started = (events: RuntimeEvent[]) =>
  events.filter((e) => e.type === "session.started").map((e) => (e.type === "session.started" ? e.model : null));

test("a resumed conversation is told the model picked since", async (t) => {
  const h = await setup(t);
  await h.turn({ model: "gpt-started-with" });
  await h.turn({ model: "vendor/other-model", resumeCursor: "codex-thread" });
  const [resume] = sent(h.frames, "thread/resume");
  assert.equal(resume.threadId, "codex-thread");
  assert.equal(resume.model, "vendor/other-model");
  assert.deepEqual(started(h.events), ["gpt-started-with", "vendor/other-model"]);
});

test("with no model picked, a resume leaves the thread's own", async (t) => {
  const h = await setup(t);
  await h.turn({ resumeCursor: "codex-thread" });
  const [resume] = sent(h.frames, "thread/resume");
  assert.equal("model" in resume, false);
  // what the session reports is what Codex says it runs, not a guess
  assert.deepEqual(started(h.events), ["gpt-started-with"]);
});
