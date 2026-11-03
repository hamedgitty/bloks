// Stopping an ACP turn (GitHub 475).
//
// A stop is session/cancel, then the kill. OpenCode answers the cancel
// with stopReason "cancelled", which read as the turn failing ("The turn
// did not finish (cancelled)"). A stop while the conversation was still
// reopening let the cut-short session/load read as a forgotten session,
// so session/new went to the process being killed and came back as an
// internal error. A stopped turn ends as stopped, and nothing more is
// asked of a process on its way out.
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough, Writable } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { test, type TestContext } from "node:test";

import type { RuntimeEvent } from "../server/contracts.ts";
import { ACP_SPECS, acpDriver } from "../server/drivers/acp.ts";

/** An OpenCode whose session/load and session/prompt wait for the test,
 * and whose process can be made to exit as a kill would. */
async function setup(t: TestContext, options: { fullAuto?: boolean; hold?: string[] } = {}) {
  const hold = new Set(["session/prompt", "session/load", ...(options.hold ?? [])]);
  const frames: any[] = [];
  let stdout = new PassThrough();
  let proc: EventEmitter | null = null;
  t.mock.method(childProcess, "spawn", () => {
    const out = new PassThrough();
    stdout = out;
    const send = (msg: unknown) => out.write(JSON.stringify(msg) + "\n");
    proc = Object.assign(new EventEmitter(), {
      stdout: out,
      stderr: new PassThrough(),
      pid: undefined,
      kill() {},
      stdin: new Writable({
        write(chunk, _encoding, done) {
          const frame = JSON.parse(String(chunk));
          frames.push(frame);
          if (frame.method && frame.id !== undefined && !hold.has(frame.method)) {
            queueMicrotask(() => {
              if (frame.method === "initialize") return send({ jsonrpc: "2.0", id: frame.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
              if (frame.method === "session/new") return send({ jsonrpc: "2.0", id: frame.id, result: { sessionId: "new-session", modes: { availableModes: [{ id: "yolo" }] } } });
              send({ jsonrpc: "2.0", id: frame.id, result: {} });
            });
          }
          done();
        },
      }),
    });
    return proc;
  });
  t.mock.method(fs, "appendFileSync", () => {});
  syncBuiltinESMExports();
  const spec = ACP_SPECS.find((s) => s.kind === "opencode")!;
  const instance = await acpDriver(spec).create({
    instanceId: "opencode", displayName: "OpenCode", enabled: true, environment: {},
    config: { cli: "fake-opencode", fullAuto: options.fullAuto ?? false },
  });
  await instance.catalogReady;
  // the catalog's own probe opened a session; only the turn's frames count
  frames.length = 0;
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
  const asked = (method: string) => frames.find((f) => f.method === method);
  const ended = () => events.find((e) => e.type === "turn.completed") as any;
  const errors = () => events.filter((e) => e.type === "runtime.error");
  const exit = () => proc?.emit("close", null);
  return { instance, frames, events, send, until, asked, ended, errors, exit };
}

test("a stopped turn the agent answers with cancelled ends as stopped", async (t) => {
  const h = await setup(t);
  await h.instance.adapter.sendTurn({ threadId: "lane", text: "do the work" });
  await h.until(() => Boolean(h.asked("session/prompt")));
  const prompt = h.asked("session/prompt");

  const stopping = h.instance.adapter.interruptTurn("lane");
  assert.deepEqual(h.asked("session/cancel")?.params, { sessionId: "new-session" });
  h.send({ jsonrpc: "2.0", id: prompt.id, result: { stopReason: "cancelled" } });
  await h.until(() => Boolean(h.ended()));
  t.mock.timers.tick(3_000);
  await stopping;

  assert.equal(h.ended()?.ok, false);
  assert.equal(h.ended()?.stopReason, "interrupted");
  assert.equal(h.errors().length, 0);
});

test("a stopped turn whose agent goes before answering ends as stopped, not as an early exit", async (t) => {
  const h = await setup(t);
  await h.instance.adapter.sendTurn({ threadId: "lane", text: "do the work" });
  await h.until(() => Boolean(h.asked("session/prompt")));

  const stopping = h.instance.adapter.interruptTurn("lane");
  t.mock.timers.tick(2_000);
  h.exit();
  await stopping;
  await h.until(() => Boolean(h.ended()));

  assert.equal(h.ended()?.stopReason, "interrupted");
  assert.equal(h.errors().length, 0, "the kill read as the agent exiting early");
});

test("a stop while the conversation reopens asks nothing more of the agent", async (t) => {
  const h = await setup(t);
  await h.instance.adapter.sendTurn({ threadId: "lane", text: "do the work", resumeCursor: "old-session" });
  await h.until(() => Boolean(h.asked("session/load")));

  await h.instance.adapter.interruptTurn("lane");
  // the cut-short load comes back an error, as it does from a process being killed
  h.send({ jsonrpc: "2.0", id: h.asked("session/load").id, error: { code: -32603, message: "Internal error" } });
  await h.until(() => Boolean(h.ended()));
  for (let i = 0; i < 20; i++) await setImmediate();

  assert.equal(h.ended()?.stopReason, "interrupted");
  assert.equal(h.asked("session/new"), undefined, "session/new went to a process being stopped");
  assert.equal(h.asked("session/prompt"), undefined);
  assert.equal(h.errors().length, 0);
});

test("a turn nobody stopped still reports a cancel as the agent's own", async (t) => {
  const h = await setup(t);
  await h.instance.adapter.sendTurn({ threadId: "lane", text: "do the work" });
  await h.until(() => Boolean(h.asked("session/prompt")));
  h.send({ jsonrpc: "2.0", id: h.asked("session/prompt").id, result: { stopReason: "cancelled" } });
  await h.until(() => Boolean(h.ended()));

  assert.equal(h.ended()?.ok, false);
  assert.equal(h.ended()?.stopReason, "cancelled");
});

test("a stop while full access is being asked for is not a refusal of it", async (t) => {
  const h = await setup(t, { fullAuto: true, hold: ["session/set_mode"] });
  await h.instance.adapter.sendTurn({ threadId: "lane", text: "do the work" });
  await h.until(() => Boolean(h.asked("session/set_mode")));

  await h.instance.adapter.interruptTurn("lane");
  await h.until(() => Boolean(h.ended()));
  for (let i = 0; i < 20; i++) await setImmediate();

  assert.equal(h.ended()?.stopReason, "interrupted");
  assert.equal(h.asked("session/prompt"), undefined);
  assert.equal(h.errors().length, 0, "the stop read as the agent refusing full access");
});
