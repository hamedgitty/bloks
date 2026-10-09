// A Codex compaction before a turn that runs past the limit (GitHub 234).
//
// The words then go to a new thread, but the compaction keeps running in
// the same app-server and finishes minutes later on the thread left
// behind. Its end was read as the end of the person's turn, which was
// reported done and had its process killed while the new thread was
// still working; its usage was the new thread's baseline, so the work
// was charged nothing; and the switch itself was never said.
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough, Writable } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { test, type TestContext } from "node:test";

import type { RuntimeEvent } from "../server/contracts.ts";
import { COMPACT_LIMIT_MS, CodexDriver } from "../server/drivers/codex.ts";

const usage = (thread: string, total: [number, number], last: [number, number]) => ({
  method: "thread/tokenUsage/updated",
  params: {
    threadId: thread,
    tokenUsage: {
      total: { inputTokens: total[0], outputTokens: total[1] },
      last: { inputTokens: last[0], outputTokens: last[1] },
      modelContextWindow: 258_400,
    },
  },
});

/** An app-server whose compaction starts and then says nothing more
 * until the test speaks for it, as a slow one does. */
async function setup(t: TestContext, old: string, fresh: string) {
  const frames: any[] = [];
  let stdout = new PassThrough();
  t.mock.method(childProcess, "spawn", () => {
    const out = new PassThrough();
    stdout = out;
    const send = (msg: unknown) => out.write(JSON.stringify(msg) + "\n");
    return Object.assign(new EventEmitter(), {
      stdout: out,
      stderr: new PassThrough(),
      kill() {},
      stdin: new Writable({
        write(chunk, _encoding, done) {
          const frame = JSON.parse(String(chunk));
          frames.push(frame);
          if (frame.method && frame.id !== undefined) {
            queueMicrotask(() => {
              if (frame.method === "thread/resume") {
                send({ id: frame.id, result: { thread: { id: old } } });
                // what the thread had already spent
                send(usage(old, [212_084, 5_000], [212_084, 400]));
                return;
              }
              if (frame.method === "thread/start") return send({ id: frame.id, result: { thread: { id: fresh } } });
              if (frame.method === "thread/compact/start") {
                send({ id: frame.id, result: {} });
                send({ method: "turn/started", params: { threadId: old, turn: { id: "compact-turn", status: "inProgress" } } });
                // the compaction reading the whole thread
                send(usage(old, [424_168, 6_000], [212_084, 1_000]));
                return;
              }
              if (frame.method === "turn/start") {
                send({ id: frame.id, result: { turn: { id: "work-turn", status: "inProgress" } } });
                send({ method: "turn/started", params: { threadId: frame.params.threadId, turn: { id: "work-turn", status: "inProgress" } } });
                return;
              }
              send({ id: frame.id, result: {} });
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
  await instance.catalogReady;
  const events: RuntimeEvent[] = [];
  instance.adapter.onEvent((event: RuntimeEvent) => events.push(event));
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.after(async () => {
    await instance.dispose();
    t.mock.timers.reset();
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const send = (msg: unknown) => stdout.write(JSON.stringify(msg) + "\n");
  const until = async (done: () => boolean) => {
    for (let i = 0; i < 200 && !done(); i++) await setImmediate();
  };
  return { instance, frames, events, send, until };
}

test("a compaction that finishes after the limit does not end the turn on the new thread", async (t) => {
  const h = await setup(t, "slow-thread", "fresh-thread");
  await h.instance.adapter.sendTurn({
    threadId: "lane", text: "do the work", resumeCursor: "slow-thread", compactFirst: true, handoff: "HANDOFF do the work",
  });
  await h.until(() => h.frames.some((f) => f.method === "thread/compact/start"));
  assert.ok(h.frames.some((f) => f.method === "thread/compact/start"), "no compaction was asked for");

  // the limit passes with the compaction still running
  t.mock.timers.tick(COMPACT_LIMIT_MS);
  await h.until(() => h.frames.some((f) => f.method === "turn/start"));
  const begun = h.frames.find((f) => f.method === "turn/start");
  assert.equal(begun?.params?.threadId, "fresh-thread");
  assert.equal(begun?.params?.input?.[0]?.text, "HANDOFF do the work", "the new thread was not told the story");

  // the compaction is asked to stop, on the thread and turn it runs in
  const stop = h.frames.find((f) => f.method === "turn/interrupt");
  assert.deepEqual(stop?.params, { threadId: "slow-thread", turnId: "compact-turn" });

  // and the person is told the conversation moved
  const said = h.events.filter((e) => e.type === "runtime.error").map((e: any) => e.message);
  assert.equal(said.length, 1, `said: ${said.join(" | ")}`);
  assert.match(said[0], /more than 10 minutes to compact/);
  assert.match(said[0], /new Codex session/);

  // the old compaction finishes late, with its usage
  const switched = h.events.length;
  h.send(usage("slow-thread", [430_000, 7_000], [5_832, 1_000]));
  h.send({ method: "turn/completed", params: { threadId: "slow-thread", turn: { id: "compact-turn", status: "completed" } } });
  for (let i = 0; i < 20; i++) await setImmediate();
  assert.equal(h.events.filter((e) => e.type === "turn.completed").length, 0, "the old compaction ended the new thread's turn");
  const readings = h.events.slice(switched).filter((e) => e.type === "context.reading") as any[];
  assert.equal(readings.length, 0, `the old thread's late reading was taken: ${JSON.stringify(readings)}`);

  // the new thread does the work and ends the turn
  h.send(usage("fresh-thread", [30_000, 800], [30_000, 800]));
  h.send({ method: "item/completed", params: { threadId: "fresh-thread", item: { type: "agentMessage", id: "a", text: "finished the real work" } } });
  h.send({ method: "turn/completed", params: { threadId: "fresh-thread", turn: { id: "work-turn", status: "completed" } } });
  await h.until(() => h.events.some((e) => e.type === "turn.completed"));
  const ended = h.events.filter((e) => e.type === "turn.completed") as any[];
  assert.equal(ended.length, 1);
  assert.equal(ended[0].ok, true);
  assert.ok(h.events.some((e) => e.type === "item.completed" && (e as any).text === "finished the real work"));

  // the new thread's reading, not the old one's
  assert.deepEqual(
    (h.events.slice(switched).filter((e) => e.type === "context.reading") as any[]).map((e) => e.used),
    [30_000],
  );
  // what the compaction spent, then the new thread's work on top of it
  const spent = h.events.filter((e) => e.type === "thread.token-usage.updated").at(-1) as any;
  assert.equal(spent.input, 212_084 + 30_000);
  assert.equal(spent.output, 1_000 + 800);
});

test("a compaction that finishes in time keeps the thread and says nothing", async (t) => {
  const h = await setup(t, "quick-thread", "unused-thread");
  await h.instance.adapter.sendTurn({
    threadId: "lane", text: "do the work", resumeCursor: "quick-thread", compactFirst: true, handoff: "HANDOFF do the work",
  });
  await h.until(() => h.frames.some((f) => f.method === "thread/compact/start"));
  h.send({ method: "turn/completed", params: { threadId: "quick-thread", turn: { id: "compact-turn", status: "completed" } } });
  await h.until(() => h.frames.some((f) => f.method === "turn/start"));
  assert.equal(h.frames.find((f) => f.method === "turn/start")?.params?.threadId, "quick-thread");
  assert.equal(h.frames.some((f) => f.method === "thread/start" || f.method === "turn/interrupt"), false);
  assert.equal(h.events.some((e) => e.type === "runtime.error"), false);
  assert.ok(h.events.some((e) => e.type === "context.compacted"));
});
