// Driver-level protocol/deadline races with an explicit clock and pipe peer.
// HTTP/store and real subprocess cleanup are covered in claude-background*.
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import fs, { mkdtempSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { CLAUDE_COMPLETION_WAIT_MS as WAIT } from "../server/drivers/claude-inputs.ts";

async function fixture(t: TestContext, version = "2.1.300 (Claude Code)") {
  const home = mkdtempSync(join(tmpdir(), "bloks-completion-"));
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  const frames: any[] = [], events: any[] = [], native: any[] = [];
  const stdout = new PassThrough();
  const state = { version, confirmExit: true, failWrite: false, synchronous: null as null | ((f: any) => void), spawns: 0, args: [] as string[] };
  const peer = Object.assign(new EventEmitter(), {
    pid: 2_147_483_647,
    stdout, stderr: new PassThrough(), exitCode: null as number | null, signalCode: null as string | null,
    stdin: new Writable({ write(chunk, _encoding, done) {
      const frame = JSON.parse(String(chunk));
      if (state.failWrite && frame.type === "user") throw new Error("fixture write failed");
      frames.push(frame);
      state.synchronous?.(frame);
      done();
    } }),
    kill(signal: string) {
      if (!state.confirmExit) return true;
      queueMicrotask(() => {
        peer.signalCode = signal;
        peer.emit("exit", null, signal);
        peer.emit("close", null, signal);
      });
      return true;
    },
  });
  t.mock.method(childProcess, "execFile", (_cli: unknown, _args: unknown, _opts: unknown, callback: any) => {
    queueMicrotask(() => callback(null, state.version));
    return new EventEmitter();
  });
  t.mock.method(childProcess, "spawn", (_cli: unknown, args: string[]) => {
    state.spawns++;
    state.args = args;
    return peer;
  });
  t.mock.method(fs, "appendFileSync", (_path: unknown, line: any) => { native.push(JSON.parse(String(line))); });
  t.mock.method(process, "kill", (pid: number) => {
    assert.equal(pid, -peer.pid, "only the synthetic peer group may be inspected/signalled");
    throw Object.assign(new Error("no real fixture group"), { code: "ESRCH" });
  });
  syncBuiltinESMExports();
  const { ClaudeDriver } = await import("../server/drivers/claude.ts");
  const instance = await ClaudeDriver.create({ instanceId: "claude", displayName: "Claude", enabled: true,
    environment: {}, config: { cli: "fixture-claude", permissionMode: "bypassPermissions" } as any });
  instance.adapter.onEvent(e => events.push(e));
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: 1_000_000 });
  t.after(async () => {
    // A failing assertion in the mocked unconfirmed-exit case must not
    // leave disposal awaiting a clock which the test has already reset.
    if (peer.exitCode === null && peer.signalCode === null) {
      peer.signalCode = "SIGKILL"; peer.emit("exit", null, "SIGKILL"); peer.emit("close", null, "SIGKILL");
    }
    t.mock.timers.reset();
    await instance.dispose();
    t.mock.restoreAll();
    syncBuiltinESMExports();
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  });
  const send = (frame: any) => stdout.write(JSON.stringify(frame) + "\n");
  const start = async () => {
    await instance.adapter.sendTurn({ threadId: "completion-fixture", text: "First", stallMs: 0 });
    return frames.find(f => f.type === "user").uuid;
  };
  const steer = async () => {
    assert.equal(await instance.adapter.steerTurn!("completion-fixture", "Second"), true);
    return frames.filter(f => f.type === "user").at(-1).uuid;
  };
  let n = 0;
  const request = (id: string) => send({ type: "system", subtype: "status", status: "requesting", uuid: `request-${++n}`, user_message_uuids: [id] });
  const result = (id: string | undefined, extra: any = {}) => send({ type: "result", uuid: `result-${++n}`, user_message_uuid: id,
    is_error: false, num_turns: 0, duration_api_ms: 0, result: "", session_id: home, total_cost_usd: 0, ...extra });
  const complete = (id: string, state = "completed") => send({ type: "command_lifecycle", command_uuid: id, state });
  const flush = async () => { for (let i = 0; i < 5; i++) await setImmediate(); };
  const ends = () => events.filter(e => e.type === "turn.completed");
  const errors = () => events.filter(e => e.type === "runtime.error");
  return { instance, state, frames, events, native, peer, send, start, steer, request, result, complete, flush, ends, errors, driver: ClaudeDriver };
}

test("production housekeeping/request sequence leaves silent root work unbounded with stall disabled", async t => {
  const f = await fixture(t);
  const a = await f.start();
  f.result(a); // nR's empty resume housekeeping, before processUserInput
  t.mock.timers.tick(WAIT - 1);
  f.request(a); // emitted only with the gated partial-message option
  t.mock.timers.tick(WAIT * 3);
  assert.equal(f.ends().length, 0);
  assert.equal(f.errors().length, 0);
  f.result(a, { result: "Real answer", num_turns: 1, duration_api_ms: 10 });
  f.complete(a);
  await f.flush();
  assert.equal(f.ends().length, 1);
  assert.equal(f.ends()[0].ok, true);
  assert.ok(f.state.args.includes("--include-partial-messages"));
});

test("unanswered preparation expires once, with no input replay and late frames sealed", async t => {
  const f = await fixture(t);
  const a = await f.start();
  f.result(a);
  t.mock.timers.tick(WAIT);
  await f.flush();
  assert.equal(f.errors().length, 1);
  assert.match(f.errors()[0].message, /waiting for.*900 seconds.*turn was stopped.*Send the message again/s);
  assert.equal(f.ends().length, 1);
  assert.equal(f.ends()[0].stopReason, "interrupted");
  assert.equal(f.frames.filter(v => v.type === "user").length, 1);
  assert.equal(f.state.spawns, 1);
  const before = f.events.length;
  f.result(a, { result: "Too late" }); f.complete(a);
  f.peer.emit("error", new Error("late spawn callback"));
  assert.equal(f.events.length, before);
});

test("A's answered metadata expiry does not end B's observed request even after another fifteen minutes", async t => {
  const f = await fixture(t);
  const a = await f.start(), b = await f.steer();
  f.request(a);
  f.result(a, { result: "A answer", total_cost_usd: 1 });
  f.request(b);
  t.mock.timers.tick(WAIT * 2);
  await f.flush();
  assert.equal(f.ends().length, 0);
  assert.equal(f.peer.stdin.writable, true);
  assert.equal(f.errors().length, 0);
  t.mock.timers.tick(WAIT * 2);
  f.result(b, { result: "B answer", total_cost_usd: 2 }); f.complete(b);
  t.mock.timers.tick(31_000);
  await f.flush();
  assert.equal(f.ends().length, 1);
  assert.equal(f.ends()[0].ok, true);
  assert.equal(f.ends()[0].cost, 2);
});

test("a genuinely unanswered B stops once while A's delivered answer is retained", async t => {
  const f = await fixture(t);
  const a = await f.start();
  const b = await f.steer();
  f.result(a, { result: "A answer", total_cost_usd: 1 }); f.complete(a);
  f.result(b); // a later housekeeping zero is no answer or accounting replacement
  t.mock.timers.tick(WAIT);
  await f.flush();
  assert.equal(f.errors().length, 1);
  assert.equal(f.ends().length, 1);
  assert.equal(f.ends()[0].ok, false);
  assert.equal(f.ends()[0].cost, 1);
});

test("discarded partial, child and foreign frames cannot prolong accepted-steer quiet or reach native partial logging", async t => {
  const f = await fixture(t);
  const a = await f.start(), b = await f.steer();
  f.result(a, { result: "A" }); f.complete(a);
  f.result(b, { result: "B" }); f.complete(b);
  t.mock.timers.tick(29_000);
  for (const frame of [
    { type: "stream_event", event: { type: "content_block_delta", delta: { text: "partial" } } },
    { type: "assistant", parent_tool_use_id: "child", message: { content: [{ type: "text", text: "child prose" }] } },
    { type: "system", subtype: "status", status: "requesting", uuid: "foreign", user_message_uuids: ["other"] },
    { type: "noise" },
  ]) f.send(frame);
  t.mock.timers.tick(2_000);
  await f.flush();
  assert.equal(f.ends().length, 1);
  assert.equal(f.events.filter(e => e.type === "content.delta").length, 0);
  assert.equal(f.native.some(v => v.msg.type === "stream_event"), false);
});

test("a legitimate empty completed result succeeds without waiting for prose", async t => {
  const f = await fixture(t);
  const a = await f.start();
  f.complete(a); f.result(a);
  await f.flush();
  assert.equal(f.ends().length, 1);
  assert.equal(f.ends()[0].ok, true);
});

test("provider error metadata fallback retains the original outcome and accounting once", async t => {
  const f = await fixture(t);
  const a = await f.start();
  f.result(a, { is_error: true, errors: ["Provider failed"], usage: { input_tokens: 3, output_tokens: 4 }, total_cost_usd: 1 });
  t.mock.timers.tick(WAIT);
  await f.flush();
  assert.equal(f.ends().length, 1);
  assert.equal(f.ends()[0].ok, false);
  assert.match(f.ends()[0].stopReason, /Provider failed/);
  assert.equal(f.events.filter(e => e.type === "thread.token-usage.updated").length, 1);
  assert.equal(f.errors().some(e => /900 seconds/.test(e.message)), false);
});

test("reserved admission rejection leaves no phantom steer", async t => {
  const f = await fixture(t);
  const a = await f.start();
  await assert.rejects(f.instance.adapter.steerTurn!("completion-fixture", "Not admitted", { onDispatch() { throw new Error("reservation unavailable"); } }), /reservation unavailable/);
  assert.equal(f.frames.filter(v => v.type === "user").length, 1);
  f.result(a, { result: "A" }); f.complete(a);
  await f.flush();
  assert.equal(f.ends().length, 1);
  assert.equal(f.ends()[0].ok, true);
});

test("initial input is registered before a synchronous result/completion can arrive", async t => {
  const f = await fixture(t);
  f.state.synchronous = frame => {
    if (frame.type !== "user") return;
    f.result(frame.uuid, { result: "Synchronous answer" }); f.complete(frame.uuid);
  };
  await f.start();
  await f.flush();
  assert.equal(f.ends().length, 1);
  assert.equal(f.ends()[0].ok, true);
});

test("a refused lifecycle cannot turn earlier assistant prose into a successful answer", async t => {
  const f = await fixture(t);
  const a = await f.start();
  f.send({ type: "assistant", message: { content: [{ type: "text", text: "Earlier prose" }] } });
  f.complete(a, "refused");
  await f.flush();
  assert.equal(f.ends().length, 1);
  assert.equal(f.ends()[0].ok, false);
  assert.match(f.errors()[0].message, /refused/);
});

test("a physical write error propagates after admission and cannot fall back or leave an input pending", async t => {
  const f = await fixture(t);
  await f.start();
  let admitted = 0;
  f.state.failWrite = true;
  await assert.rejects(f.instance.adapter.steerTurn!("completion-fixture", "Write failure", { onDispatch() { admitted++; } }), /fixture write failed/);
  await f.flush();
  assert.equal(admitted, 1);
  assert.equal(f.ends().length, 1);
  assert.equal(f.errors().length, 1);
  assert.equal(f.ends()[0].stopReason, "interrupted");
});

test("a later accepted input's success cannot erase an earlier provider error or duplicate session cost", async t => {
  const f = await fixture(t);
  const a = await f.start(), b = await f.steer();
  f.result(a, { is_error: true, errors: ["A provider error"], total_cost_usd: 1 }); f.complete(a);
  f.result(b, { result: "B answer", total_cost_usd: 2 }); f.complete(b);
  t.mock.timers.tick(31_000);
  await f.flush();
  assert.equal(f.ends().length, 1);
  assert.equal(f.ends()[0].ok, false);
  assert.match(f.ends()[0].stopReason, /A provider error/);
  assert.equal(f.ends()[0].cost, 2);
});

test("the real permission broker pauses the remaining preparation budget without replenishing it", async t => {
  const f = await fixture(t);
  await f.start();
  t.mock.timers.tick(WAIT - 1_000);
  const path = f.state.args[f.state.args.indexOf("--mcp-config") + 1];
  const socket = JSON.parse(fs.readFileSync(path, "utf8")).mcpServers.bloks.args.at(-1);
  const connection = connect(socket);
  t.after(() => connection.destroy());
  await new Promise<void>((resolve, reject) => { connection.once("connect", resolve); connection.once("error", reject); });
  connection.write(JSON.stringify({ t: "ask", id: "ask-fixture", kind: "question", tool: "ask_user", input: { question: "Continue?" } }) + "\n");
  for (let i = 0; i < 50 && !f.events.some(e => e.type === "request.opened"); i++) await setImmediate();
  assert.equal(f.events.filter(e => e.type === "request.opened").length, 1);
  t.mock.timers.tick(5 * 60_000);
  assert.equal(f.errors().length, 0);
  await f.instance.adapter.respondToRequest("completion-fixture", "ask-fixture", { behavior: "answer", message: "Yes" });
  t.mock.timers.tick(999);
  assert.equal(f.errors().length, 0);
  t.mock.timers.tick(1);
  await f.flush();
  assert.equal(f.errors().length, 1);
  assert.equal(f.ends().length, 1);
  assert.equal(f.events.filter(e => e.type === "request.resolved").length, 1);
});

for (const version of ["2.1.299 (Claude Code)", "custom Claude build", "2.1.300-preview (Claude Code)"]) {
  test(`legacy completion boundary stays unchanged for ${version}`, async t => {
    const f = await fixture(t, version);
    const id = await f.start();
    assert.equal(id, undefined);
    assert.equal(f.state.args.includes("--include-partial-messages"), false);
    f.result(id);
    assert.equal(f.peer.stdin.writable, false, "legacy still closes at its first result");
    t.mock.timers.tick(WAIT * 2);
    assert.equal(f.ends().length, 0, "legacy zero stays held without a new deadline");
    f.peer.exitCode = 0;
    f.peer.emit("exit", 0, null); f.peer.emit("close", 0, null);
    await f.flush();
    assert.equal(f.ends().length, 1);
    assert.equal(f.ends()[0].ok, true);
  });
}

test("health refresh cannot downgrade the captured protocol of an active supported process", async t => {
  const f = await fixture(t);
  const a = await f.start();
  f.state.version = "2.1.299 (Claude Code)";
  await f.instance.snapshot();
  f.result(a);
  assert.equal(f.peer.stdin.writable, true);
  f.result(a, { result: "Real answer" }); f.complete(a);
  await f.flush();
  assert.equal(f.ends().length, 1);
  assert.equal(f.ends()[0].ok, true);
});

test("unconfirmed cleanup retains its lane barrier across instance disposal and replacement", async t => {
  const f = await fixture(t);
  f.state.confirmExit = false;
  const a = await f.start();
  f.result(a, { result: "Delivered" }); f.complete(a);
  t.mock.timers.tick(3_000);
  t.mock.timers.tick(3_000);
  await f.flush();
  assert.equal(f.ends().length, 1);
  assert.equal(f.ends()[0].ok, false);
  assert.match(f.errors()[0].message, /did not finish stopping/);
  const disposing = f.instance.dispose();
  t.mock.timers.tick(1_500); // the instance-wide helper's bounded shutdown wait
  await f.flush();
  await disposing;
  const replacement = await f.driver.create({ instanceId: "claude", displayName: "Claude", enabled: true,
    environment: {}, config: { cli: "fixture-claude", permissionMode: "bypassPermissions" } as any });
  t.after(() => replacement.dispose());
  await assert.rejects(replacement.adapter.sendTurn({ threadId: "completion-fixture", text: "Successor" }), /already running/);
  assert.equal(f.state.spawns, 1);
  // The mocked unconfirmed process now really exits; only its own barrier
  // can be released, even though its old instance has been disposed.
  f.peer.signalCode = "SIGKILL"; f.peer.emit("exit", null, "SIGKILL"); f.peer.emit("close", null, "SIGKILL");
  await f.flush();
  assert.equal(f.ends().length, 1);
});

test("terminal accounting callbacks cannot admit a steer after the selected result", async t => {
  const f = await fixture(t);
  const a = await f.start();
  let attempted: Promise<boolean> | undefined;
  f.instance.adapter.onEvent(event => {
    if (event.type === "thread.token-usage.updated") attempted = f.instance.adapter.steerTurn!("completion-fixture", "Too late");
  });
  f.result(a, { result: "Delivered", usage: { input_tokens: 3, output_tokens: 4 } }); f.complete(a);
  await f.flush();
  assert.equal(await attempted, false);
  assert.equal(f.frames.filter(v => v.type === "user").length, 1);
  assert.equal(f.ends().length, 1);
});
