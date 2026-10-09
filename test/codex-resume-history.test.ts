// A Codex resume of a long thread (GitHub 230).
//
// The resume used to ask for the thread's whole history, tens of
// megabytes on one line, and the line reader took longer to read it than
// the handshake allows. The turn then moved to a new thread, and the old
// thread's late answer and restored usage were read as the new turn's,
// so it reported no tokens at all.
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
import { lineSplitter } from "../server/ndjson.ts";

const usage = (thread: string, input: number, output: number) => ({
  method: "thread/tokenUsage/updated",
  params: {
    threadId: thread,
    tokenUsage: { total: { inputTokens: input, outputTokens: output }, last: { inputTokens: input, outputTokens: output } },
  },
});

/** An app-server whose resume fails, then speaks about the old thread
 * before it answers for the new one, as the late reply did. */
async function setup(t: TestContext, resumeWorks: boolean, fresh: string) {
  const sent: any[] = [];
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
          sent.push(frame);
          if (frame.method && frame.id !== undefined) {
            queueMicrotask(() => {
              if (frame.method === "thread/resume") {
                if (resumeWorks) send({ id: frame.id, result: { thread: { id: "old-thread" } } });
                else send({ id: frame.id, error: { code: -32000, message: "the thread could not be loaded" } });
                return;
              }
              if (frame.method === "thread/start") {
                // the old thread's restored usage, ahead of the new thread
                send(usage("old-thread", 397_541_922, 2_000_000));
                send({ id: frame.id, result: { thread: { id: fresh } } });
                return;
              }
              send({ id: frame.id, result: {} });
              if (frame.method === "turn/start") {
                send(usage(resumeWorks ? "old-thread" : fresh, 50_402, 900));
                send({ method: "turn/completed", params: { threadId: resumeWorks ? "old-thread" : fresh, turn: { status: "completed" } } });
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
  instance.adapter.onEvent((event: RuntimeEvent) => events.push(event));
  t.after(async () => {
    await instance.dispose();
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  await instance.adapter.sendTurn({ threadId: "lane", text: "hi", resumeCursor: "old-thread" } as any);
  for (let i = 0; i < 100 && !events.some((e) => e.type === "turn.completed"); i++) await setImmediate();
  return { sent, events };
}

test("a resume asks for the thread's state, not its history", async (t) => {
  const { sent } = await setup(t, true, "thread-a");
  const resume = sent.find((f) => f.method === "thread/resume");
  assert.equal(resume?.params?.excludeTurns, true);
});

test("after a resume fails, the old thread's usage is not this turn's baseline", async (t) => {
  const { events } = await setup(t, false, "thread-b");
  const spent = events.filter((e) => e.type === "thread.token-usage.updated").at(-1) as any;
  assert.ok(spent, "the new thread's turn reported nothing");
  assert.equal(spent.input, 50_402);
  assert.equal(spent.output, 900);
});

test("one very long line is read in linear time, and characters split across chunks arrive whole", () => {
  const lines: string[] = [];
  const feed = lineSplitter((line) => lines.push(line));
  // a curly quote stores the string as two-byte, as real history does
  const long = "’".repeat(10) + "x".repeat(20 * 1024 * 1024);
  const bytes = Buffer.from(`{"a":1}\n${long}\n`);
  const started = Date.now();
  for (let at = 0; at < bytes.length; at += 64 * 1024) feed(bytes.subarray(at, at + 64 * 1024));
  // the old reader took about 8 seconds for 20 MB; this takes a fraction of one
  assert.ok(Date.now() - started < 3_000, `took ${Date.now() - started} ms`);
  assert.deepEqual(lines.map((l) => l.length), [7, long.length]);
  assert.equal(lines[1], long);

  // "é" is two bytes; cut between them
  const split: string[] = [];
  const again = lineSplitter((line) => split.push(line));
  const word = Buffer.from("café\nau lait\n");
  again(word.subarray(0, 4));
  again(word.subarray(4));
  assert.deepEqual(split, ["café", "au lait"]);
});
