// GitHub 380: an agent could give itself a goal with Codex's create_goal
// tool, and Codex then started a turn of its own to carry on with it the
// moment the last one ended. Bloks ends the process there, so that turn
// was cut off every time, and the next one opened told to keep working
// toward a goal nobody was holding. Codex's goals are now off in every
// thread's config, and a resumed thread has any goal it kept cleared.
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { after, test, type TestContext } from "node:test";

import type { RuntimeEvent } from "../server/contracts.ts";

const home = mkdtempSync(join(tmpdir(), "bloks-codex-goals-"));
process.env.HOME = home;
process.env.BLOKS_DATA_DIR = "";
mkdirSync(join(home, ".bloks", "native"), { recursive: true });
const { CodexDriver } = await import("../server/drivers/codex.ts");
after(() => rmSync(home, { recursive: true, force: true }));

const GOALS_OFF = { "features.goals": false };

interface Fake {
  /** An error message for a request this Codex refuses, or null. */
  refuse?: (frame: any) => string | null;
  /** Frames sent after turn/completed, as Codex's own next turn. */
  afterwards?: any[];
}

let lanes = 0;

async function setup(t: TestContext, fake: Fake = {}) {
  const lane = `goals-lane-${++lanes}`;
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
            const refused = fake.refuse?.(frame) ?? null;
            let reply: Record<string, unknown> = { id: frame.id, result: {} };
            if (refused) reply = { id: frame.id, error: { code: -32600, message: refused } };
            else if (frame.method === "thread/start") reply = { id: frame.id, result: { thread: { id: "codex-thread" }, model: "gpt-test" } };
            else if (frame.method === "thread/resume") reply = { id: frame.id, result: { thread: { id: frame.params.threadId }, model: "gpt-test" } };
            else if (frame.method === "thread/fork") reply = { id: frame.id, result: { thread: { id: "forked-thread" } } };
            else if (frame.method === "thread/goal/clear") reply = { id: frame.id, result: { cleared: true } };
            queueMicrotask(() => {
              stdout.write(JSON.stringify(reply) + "\n");
              if (frame.method === "turn/start" && !refused) {
                const thread = frame.params.threadId;
                stdout.write(JSON.stringify({ method: "turn/started", params: { threadId: thread, turn: { id: "turn-1" } } }) + "\n");
                stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: thread, turn: { id: "turn-1", status: "completed" } } }) + "\n");
                for (const extra of fake.afterwards ?? []) stdout.write(JSON.stringify(extra) + "\n");
              }
            });
          }
          done();
        },
      }),
    });
  });
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
  async function turn(extra: Record<string, unknown> = {}) {
    const before = events.filter((e) => e.type === "turn.completed").length;
    await instance.adapter.sendTurn({ threadId: lane, text: "hi", cwd: home, ...extra });
    for (let i = 0; i < 100 && events.filter((e) => e.type === "turn.completed").length === before; i++) await setImmediate();
  }
  const sent = (method: string) => frames.filter((f) => f.method === method).map((f) => f.params);
  const methods = () => frames.flatMap((f) => (f.method && f.id !== undefined ? [f.method] : []));
  const completed = () => events.flatMap((e) => (e.type === "turn.completed" ? [e] : []));
  return { events, turn, sent, methods, completed };
}

test("a new thread, a resumed one and a fork each have Codex's goals turned off", async (t) => {
  const h = await setup(t);
  await h.turn();
  assert.deepEqual(h.sent("thread/start")[0].config, GOALS_OFF);
  // nothing to clear in a thread that has only ever had them off
  assert.deepEqual(h.sent("thread/goal/clear"), []);

  await h.turn({ resumeCursor: "codex-thread" });
  assert.deepEqual(h.sent("thread/resume")[0].config, GOALS_OFF);

  await h.turn({ resumeCursor: "from-before", forkFrom: "from-before", handoff: "the story, then: hi" });
  assert.deepEqual(h.sent("thread/fork")[0].config, GOALS_OFF);
  assert.deepEqual(h.sent("thread/resume")[1].config, GOALS_OFF);
  assert.ok(h.completed().every((e) => e.type === "turn.completed" && e.ok));
});

test("a resumed thread has a goal it kept cleared, once, before the words go in", async (t) => {
  const h = await setup(t);
  await h.turn({ resumeCursor: "codex-thread" });
  assert.deepEqual(h.sent("thread/goal/clear"), [{ threadId: "codex-thread" }]);
  const order = h.methods();
  assert.ok(order.indexOf("thread/resume") < order.indexOf("thread/goal/clear"));
  assert.ok(order.indexOf("thread/goal/clear") < order.indexOf("turn/start"));

  // the next turn on it does not ask again
  await h.turn({ resumeCursor: "codex-thread" });
  assert.equal(h.sent("thread/goal/clear").length, 1);
  assert.equal(h.sent("turn/start").length, 2);
  assert.ok(h.completed().every((e) => e.type === "turn.completed" && e.ok));
});

test("a Codex that will not clear a goal still runs the turn, and says nothing of it", async (t) => {
  const h = await setup(t, {
    refuse: (frame) => (frame.method === "thread/goal/clear" ? "goals feature is disabled" : null),
  });
  await h.turn({ resumeCursor: "codex-thread" });
  assert.equal(h.sent("thread/goal/clear").length, 1);
  assert.equal(h.sent("turn/start").length, 1);
  assert.deepEqual(h.events.filter((e) => e.type === "runtime.error"), []);
  assert.ok(h.completed().every((e) => e.type === "turn.completed" && e.ok));
});

test("a Codex that takes no thread config gets its thread without it, and is not asked to clear", async (t) => {
  const h = await setup(t, {
    refuse: (frame) => (frame.params?.config ? "Invalid request: unknown field `config`" : null),
  });
  await h.turn({ resumeCursor: "codex-thread" });
  const resumes = h.sent("thread/resume");
  assert.equal(resumes.length, 2, "asked again, once, without the config");
  assert.equal("config" in resumes[1], false);
  assert.deepEqual(h.sent("thread/goal/clear"), []);
  assert.ok(h.completed().length === 1 && h.completed()[0].ok);
});

test("a turn Codex starts on its own after this one ended is not this turn's", async (t) => {
  // as an older thread's goal carrying on, 10 to 50ms after task_complete
  const h = await setup(t, {
    afterwards: [
      { method: "turn/started", params: { threadId: "codex-thread", turn: { id: "turn-goal" } } },
      { method: "item/started", params: { threadId: "codex-thread", turnId: "turn-goal", item: { id: "cmd", type: "commandExecution", command: "ls" } } },
      { method: "error", params: { threadId: "codex-thread", turnId: "turn-goal", error: { message: "interrupted" } } },
      { method: "turn/completed", params: { threadId: "codex-thread", turn: { id: "turn-goal", status: "interrupted" } } },
    ],
  });
  await h.turn();
  for (let i = 0; i < 20; i++) await setImmediate();
  assert.equal(h.completed().length, 1);
  assert.ok(h.completed()[0].ok);
  assert.deepEqual(h.events.filter((e) => e.type === "runtime.error" || e.type === "item.started"), []);
});
