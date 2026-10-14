import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough, Writable } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { test, type TestContext } from "node:test";

import type { RuntimeEvent } from "../server/contracts.ts";
import { CodexDriver } from "../server/drivers/codex.ts";
import { describeEarlyExit } from "../server/drivers/spawn-error.ts";

async function setup(t: TestContext, holdInitialize = false) {
  const children: any[] = [];
  const requests: any[] = [];
  t.mock.method(fs, "mkdirSync", () => undefined);
  t.mock.method(fs, "appendFileSync", () => undefined);
  t.mock.method(childProcess, "spawn", () => {
    const stdout = new PassThrough();
    const send = (frame: unknown) => stdout.write(JSON.stringify(frame) + "\n");
    const child = Object.assign(new EventEmitter(), {
      stdout, stderr: new PassThrough(), signals: [] as string[],
      kill(signal: string) {
        this.signals.push(signal);
        queueMicrotask(() => child.emit("close", null, signal));
        return true;
      },
      stdin: new Writable({ write(chunk, _encoding, done) {
        const frame = JSON.parse(String(chunk));
        requests.push(frame);
        if (frame.id !== undefined && frame.method) queueMicrotask(() => {
          if (holdInitialize && children.length > 1 && frame.method === "initialize") return;
          const result = frame.method === "model/list" ? { data: [] }
            : frame.method === "thread/start" ? { thread: { id: "native-thread" } }
            : frame.method === "turn/start" ? { turn: { id: "native-turn" } } : {};
          send({ id: frame.id, result });
        });
        done();
      } }),
      send,
    });
    children.push(child);
    return child as any;
  });
  syncBuiltinESMExports();
  const instance = await CodexDriver.create({
    instanceId: "codex", displayName: "Codex", enabled: true, environment: {},
    config: { cli: "fixture-codex", fullAuto: false },
  });
  await instance.catalogReady;
  const events: RuntimeEvent[] = [];
  instance.adapter.onEvent((event) => events.push(event));
  const spin = async () => { for (let i = 0; i < 20; i++) await setImmediate(); };
  t.after(async () => {
    await instance.dispose();
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  await instance.adapter.sendTurn({ threadId: "lane", text: "Synthetic request" });
  await spin();
  return { instance, events, requests, child: children.at(-1), spin };
}

for (const held of [false, true]) test(`a requested Codex stop ends quietly, including pending initialization=${held}`, async (t) => {
  const h = await setup(t, held);
  h.child.stderr.write("An unrelated fixture startup warning.\n");
  assert.equal(h.instance.adapter.hasSession("lane"), true);
  assert.equal(h.requests.some((r) => r.method === "turn/start"), !held);
  await h.instance.adapter.interruptTurn("lane");
  await h.spin();
  // A Stop is not evidence that this stderr line caused a failed turn.
  assert.deepEqual(h.events.filter((e) => e.type === "runtime.error"), []);
  assert.deepEqual(h.events.filter((e) => e.type === "turn.completed").map((e) => [e.ok, e.stopReason]), [[false, "interrupted"]]);
  assert.equal(h.instance.adapter.hasSession("lane"), false);
  assert.ok(h.child.signals.every((signal: string) => signal === "SIGTERM"));
  assert.ok(h.child.signals.length > 0);
});

for (const code of [0, 1, null]) test(`an unrequested Codex exit ${code} still reports its stderr`, async (t) => {
  const h = await setup(t);
  const stderr = "An unrelated fixture startup warning.\n";
  h.child.stderr.write(stderr);
  h.child.emit("close", code);
  await h.spin();
  assert.deepEqual(h.events.filter((e) => e.type === "runtime.error").map((e) => e.message),
    [describeEarlyExit(code, stderr, { name: "Codex", signIn: "run `codex login`" })]);
  assert.deepEqual(h.events.filter((e) => e.type === "turn.completed").map((e) => [e.ok, e.stopReason]), [[false, "exit_before_result"]]);
  assert.equal(h.instance.adapter.hasSession("lane"), false);
});

test("Codex completion cleanup is not an interruption or an early-exit error", async (t) => {
  const h = await setup(t);
  h.child.send({ method: "turn/completed", params: { threadId: "native-thread", turn: { id: "native-turn", status: "completed" } } });
  await h.spin();
  await h.instance.adapter.interruptTurn("lane");
  assert.deepEqual(h.events.filter((e) => e.type === "runtime.error"), []);
  assert.deepEqual(h.events.filter((e) => e.type === "turn.completed").map((e) => [e.ok, e.stopReason]), [[true, null]]);
  assert.equal(h.instance.adapter.hasSession("lane"), false);
});
