// A Codex thread the person had before Bloks is carried on in a fork of
// it, never resumed in place: resuming would write the person's own
// rollout file (server/session-import.ts). A Codex that cannot fork gets a
// new thread told the story, and the original is never touched.
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

const ORIGINAL = "thread-from-before-bloks";

async function setup(t: TestContext, canFork: boolean) {
  const frames: any[] = [];
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
            let reply: Record<string, unknown> = { id: frame.id, result: {} };
            if (frame.method === "thread/fork") {
              reply = canFork
                ? { id: frame.id, result: { thread: { id: "forked-thread" } } }
                : { id: frame.id, error: { code: -32601, message: "method not found: thread/fork" } };
            }
            if (frame.method === "thread/resume") reply = { id: frame.id, result: { thread: { id: frame.params.threadId }, model: "gpt-test" } };
            if (frame.method === "thread/start") reply = { id: frame.id, result: { thread: { id: "new-thread" }, model: "gpt-test" } };
            queueMicrotask(() => {
              stdout.write(JSON.stringify(reply) + "\n");
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
    await instance.adapter.sendTurn({ threadId: "lane", text: "carry on", ...extra });
    for (let i = 0; i < 50 && events.filter((e) => e.type === "turn.completed").length === before; i++) await setImmediate();
  }
  const sent = (method: string) => frames.filter((f) => f.method === method).map((f) => f.params);
  const sessions = () => events.flatMap((e) => (e.type === "session.started" ? [e.sessionId] : []));
  return { turn, sent, sessions };
}

test("a thread from before Bloks is forked, and the fork is what resumes", async (t) => {
  const h = await setup(t, true);
  await h.turn({ resumeCursor: ORIGINAL, forkFrom: ORIGINAL, handoff: "the story, then: carry on" });
  assert.deepEqual(h.sent("thread/fork"), [{ threadId: ORIGINAL, config: { "features.goals": false } }]);
  assert.deepEqual(h.sent("thread/resume").map((p) => p.threadId), ["forked-thread"]);
  assert.deepEqual(h.sessions(), ["forked-thread"], "the lane's cursor becomes the fork");
  assert.equal(h.sent("turn/start")[0].input[0].text, "carry on", "a carried-on session is not told what it has");
});

test("a Codex that cannot fork starts a new thread told the story, never the original", async (t) => {
  const h = await setup(t, false);
  await h.turn({ resumeCursor: ORIGINAL, forkFrom: ORIGINAL, handoff: "the story, then: carry on" });
  assert.deepEqual(h.sent("thread/resume"), [], "the person's own thread was resumed in place");
  assert.equal(h.sent("thread/start").length, 1);
  assert.equal(h.sent("turn/start")[0].input[0].text, "the story, then: carry on");
  assert.deepEqual(h.sessions(), ["new-thread"]);
});

test("once the cursor is the fork, the lane resumes it like any thread", async (t) => {
  const h = await setup(t, true);
  await h.turn({ resumeCursor: "forked-thread", forkFrom: ORIGINAL });
  assert.deepEqual(h.sent("thread/fork"), []);
  assert.deepEqual(h.sent("thread/resume").map((p) => p.threadId), ["forked-thread"]);
});
