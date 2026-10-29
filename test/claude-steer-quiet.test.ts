// A steered Claude turn and a long command (GitHub 330).
//
// Two agents' messages had joined a running turn, and while the agent
// answered them it ran a Bash call that took about 36 seconds. The model
// says nothing while a command runs, so after 30 seconds of that silence
// the turn was settled on its earlier result: Bloks showed it finished,
// the queued turn resumed the same session in a second process, and the
// first went on working beside it. A turn ends on a held result only
// once nothing it started is still running, and its process has stopped
// before the turn is reported as over.
//
// The engine is a synthetic peer on a controlled clock, so the wait is
// minutes long without the test being so.
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import fs, { mkdtempSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { test, type TestContext } from "node:test";

const THREAD = "steer-quiet-fixture";

async function fixture(t: TestContext, version: string) {
  const home = mkdtempSync(join(tmpdir(), "bloks-steer-quiet-"));
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  const written: any[] = [];
  const events: any[] = [];
  /** Signals sent to the engine and turns reported over, in order. */
  const timeline: string[] = [];
  const peer = Object.assign(new EventEmitter(), {
    pid: 2_147_483_646,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null as number | null,
    signalCode: null as string | null,
    stdin: new Writable({
      write(chunk, _encoding, done) {
        written.push(JSON.parse(String(chunk)));
        done();
      },
    }),
    kill(signal: string) {
      timeline.push(signal);
      queueMicrotask(() => {
        if (peer.signalCode) return;
        peer.signalCode = signal;
        peer.emit("exit", null, signal);
        peer.emit("close", null, signal);
      });
      return true;
    },
  });
  t.mock.method(childProcess, "execFile", (_cli: unknown, _args: unknown, _opts: unknown, callback: any) => {
    queueMicrotask(() => callback(null, version));
    return new EventEmitter();
  });
  t.mock.method(childProcess, "spawn", () => peer);
  t.mock.method(fs, "appendFileSync", () => {});
  // No real group stands behind the peer: signalling it falls back to
  // the peer itself, and looking for it finds nothing left.
  t.mock.method(process, "kill", (pid: number) => {
    assert.equal(pid, -peer.pid, "only the peer's own group may be signalled");
    throw Object.assign(new Error("no such group"), { code: "ESRCH" });
  });
  syncBuiltinESMExports();
  const { ClaudeDriver } = await import("../server/drivers/claude.ts");
  const instance = await ClaudeDriver.create({
    instanceId: "claude",
    displayName: "Claude",
    enabled: true,
    environment: {},
    config: { cli: "fixture-claude", permissionMode: "bypassPermissions" } as any,
  });
  instance.adapter.onEvent((event) => {
    events.push(event);
    if (event.type === "turn.completed") timeline.push("turn.completed");
  });
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: 1_000_000 });
  t.after(async () => {
    if (!peer.signalCode) {
      peer.signalCode = "SIGKILL";
      peer.emit("exit", null, "SIGKILL");
      peer.emit("close", null, "SIGKILL");
    }
    t.mock.timers.reset();
    await instance.dispose();
    t.mock.restoreAll();
    syncBuiltinESMExports();
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  });
  const send = (frame: any) => peer.stdout.write(JSON.stringify(frame) + "\n");
  const flush = async () => {
    for (let i = 0; i < 10; i++) await setImmediate();
  };
  const inputs = () => written.filter((frame) => frame.type === "user");
  const ends = () => events.filter((event) => event.type === "turn.completed");
  const place = {
    label: "fixture remote", cwd: home,
    spawn: () => peer as any,
    file: (name: string) => join(home, name),
    mcp: () => null,
  };
  return { instance, send, flush, inputs, ends, events, timeline, place };
}

/** The engine was told to stop, and the turn was reported over only
 * after that: the next turn on this session never starts beside it. */
function stoppedFirst(timeline: string[]) {
  const stop = timeline.indexOf("SIGTERM");
  const over = timeline.indexOf("turn.completed");
  assert.ok(stop >= 0 && over > stop, `the process was not stopped before its turn was over: ${timeline.join(", ") || "nothing"}`);
}

test("preparation receipts require Claude's matching input UUID", async (t) => {
  const f = await fixture(t, "2.1.300 (Claude Code)");
  const initial: string[] = [], ready: string[] = [];
  const started = await f.instance.adapter.sendTurn({
    threadId: THREAD, text: "FIRST", stallMs: 0,
    preparation: {
      freeze: () => ({
        hasInputs: true, skillNames: [],
        commit: () => ({ text: "READY_A", skillNames: [], images: [], settle: (status) => initial.push(status) }),
      }),
      ready: (turnId) => ready.push(turnId),
      unavailable: () => {},
    },
  });
  assert.match(f.inputs()[0].message.content, /FIRST\n\nREADY_A/);
  assert.deepEqual(initial, []);
  const initialId = f.inputs()[0].uuid;
  f.send({ type: "system", subtype: "status", status: "requesting", user_message_uuids: ["foreign"] });
  await f.flush();
  assert.deepEqual(initial, []);
  f.send({ type: "system", subtype: "status", status: "requesting", user_message_uuids: [initialId] });
  await f.flush();
  assert.deepEqual(initial, ["accepted"]);
  assert.deepEqual(ready, [started.turnId]);

  let dispatched = 0;
  const steering = f.instance.adapter.steerPrepared!(THREAD, started.turnId, "READY_B", { onDispatch: () => { dispatched++; } });
  await f.flush();
  const nextId = f.inputs()[1].uuid;
  assert.equal(dispatched, 1);
  f.send({ type: "command_lifecycle", command_uuid: "foreign", state: "started" });
  await f.flush();
  f.send({ type: "command_lifecycle", command_uuid: nextId, state: "started" });
  assert.equal(await steering, "accepted");
  assert.equal(f.inputs().filter((input) => input.message.content === "READY_B").length, 1);
});

for (const version of ["2.1.299 (Claude Code)", "unknown"]) test(`${version}: preparation waits for the next turn and ordinary steering still works`, async (t) => {
  const f = await fixture(t, version);
  const initial: string[] = [], ready: string[] = [];
  let unavailable = 0;
  await f.instance.adapter.sendTurn({
    threadId: THREAD, text: "FIRST", stallMs: 0,
    preparation: {
      freeze: () => ({
        hasInputs: true, skillNames: [],
        commit: () => ({ text: "READY_A", skillNames: [], images: [], settle: (status) => initial.push(status) }),
      }),
      ready: (turnId) => ready.push(turnId),
      unavailable: () => { unavailable++; },
    },
  });
  assert.equal(f.inputs()[0].uuid, undefined);
  assert.equal(f.inputs()[0].message.content, "FIRST");
  assert.deepEqual(initial, []);
  assert.deepEqual(ready, []);
  assert.equal(unavailable, 1);
  assert.equal(await f.instance.adapter.steerTurn!(THREAD, "NORMAL_STEER"), true);
  assert.equal(f.inputs()[1].message.content, "NORMAL_STEER");
});

for (const remote of ["2.1.299", "unknown"]) test(`a local modern probe cannot authorize preparation on a remote ${remote} CLI`, async (t) => {
  const f = await fixture(t, "2.1.300 (Claude Code)");
  let unavailable = 0, frozen = 0, ready = 0, spawned = 0;
  const place = { ...f.place, spawn: () => { spawned++; return f.place.spawn(); } };
  await f.instance.adapter.sendTurn({
    threadId: THREAD, text: "FIRST", stallMs: 0, place,
    preparation: {
      freeze: () => { frozen++; return { hasInputs: true, skillNames: [],
        commit: () => ({ text: "READY_A", skillNames: [], images: [], settle: () => {} }) }; },
      ready: () => { ready++; },
      unavailable: () => { unavailable++; },
    },
  });
  assert.equal(spawned, 1, "the turn must use the remote place");
  assert.equal(f.inputs()[0].message.content, "FIRST");
  // An older remote peer can report activity without correlating an input;
  // an unknown one offers no capability evidence at all.
  if (remote !== "unknown") {
    f.send({ type: "system", subtype: "status", status: "requesting" });
    await f.flush();
  }
  assert.equal(unavailable, 1);
  assert.equal(frozen, 0);
  assert.equal(ready, 0);
  assert.equal(await f.instance.adapter.steerTurn!(THREAD, "NORMAL_STEER"), true);
  assert.equal(f.inputs()[1].message.content, "NORMAL_STEER");
});

const LONG_COMMAND = { type: "assistant", message: { content: [{ type: "tool_use", id: "bash-36s", name: "Bash", input: { command: "./sync-records.sh" } }] } };
const COMMAND_DONE = { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "bash-36s", content: "synced" }] } };

// The same whichever way the turn ends with background work
// (server/background-work.ts): this one started none.
for (const backgroundWork of ["finish", "stop"] as const) for (const version of ["2.1.299 (Claude Code)", "2.1.300 (Claude Code)"]) {
  test(`a steered turn does not end while its command runs, and its process stops before the turn is over (${version}, ${backgroundWork})`, async (t) => {
    const f = await fixture(t, version);
    await f.instance.adapter.sendTurn({ threadId: THREAD, text: "Look into the records", stallMs: 0, backgroundWork });
    assert.equal(await f.instance.adapter.steerTurn!(THREAD, "[From Ana] the March ones too"), true);
    assert.equal(await f.instance.adapter.steerTurn!(THREAD, "[From Ben] and April"), true);
    const [first, ...steers] = f.inputs().map((frame) => frame.uuid as string | undefined);
    // its own session: what a session has cost so far is kept per process
    const session = `sess-steered-${version.split(" ")[0]}-${backgroundWork}`;
    const attributed = typeof first === "string";
    const request = (ids: Array<string | undefined>) =>
      attributed && f.send({ type: "system", subtype: "status", status: "requesting", uuid: `request-${ids.join("-")}`, user_message_uuids: ids });
    const result = (ids: Array<string | undefined>, text: string, cost: number) =>
      f.send({
        type: "result", subtype: "success", is_error: false, num_turns: 2, duration_api_ms: 900, total_cost_usd: cost,
        session_id: session, result: text,
        ...(attributed ? { uuid: `result-${text}`, user_message_uuid: ids.at(-1), user_message_uuids: ids } : {}),
      });
    const completed = (ids: Array<string | undefined>) => {
      for (const id of ids) if (id) f.send({ type: "command_lifecycle", command_uuid: id, state: "completed" });
    };

    f.send({ type: "system", subtype: "init", session_id: session, model: "claude-sonnet-5" });
    request([first]);
    f.send({ type: "assistant", message: { content: [{ type: "text", text: "The records are in order." }] } });
    result([first], "The records are in order.", 1);
    completed([first]);
    // the steered messages are answered next, and that answer runs a
    // command that takes a while and prints nothing until it is done
    request(steers);
    f.send(LONG_COMMAND);
    await f.flush();
    t.mock.timers.tick(36_000);
    await f.flush();
    assert.equal(f.ends().length, 0, "the turn was settled while its command was still running");
    assert.deepEqual(f.timeline, [], "the process was stopped under a running command");
    // however long it takes, without the stall limit (stallMs 0)
    t.mock.timers.tick(10 * 60_000);
    await f.flush();
    assert.equal(f.ends().length, 0, "the turn was settled while its command was still running");

    f.send(COMMAND_DONE);
    f.send({ type: "assistant", message: { content: [{ type: "text", text: "March and April are synced." }] } });
    result(steers, "March and April are synced.", 3);
    completed(steers);
    await f.flush();
    t.mock.timers.tick(31_000);
    await f.flush();
    assert.equal(f.ends().length, 1, "the turn never ended");
    assert.equal(f.ends()[0].ok, true);
    assert.equal(f.ends()[0].cost, 3, "the turn is charged its last result, which covers both");
    const said = f.events.filter((event) => event.type === "item.completed" && event.itemType === "assistant_text").map((event) => event.text);
    assert.deepEqual(said, ["The records are in order.", "March and April are synced."]);
    // The next turn resumes this session: the old process has been told
    // to stop, and has, before the lane reads as free.
    stoppedFirst(f.timeline);
    assert.equal(f.instance.adapter.hasSession!(THREAD), false);
  });
}

for (const backgroundWork of ["finish", "stop"] as const) test(`a steered turn with nothing left running still ends after a quiet spell on a CLI that does not attribute results (${backgroundWork})`, async (t) => {
  const f = await fixture(t, "2.1.299 (Claude Code)");
  await f.instance.adapter.sendTurn({ threadId: THREAD, text: "Start the export", stallMs: 0, backgroundWork });
  assert.equal(await f.instance.adapter.steerTurn!(THREAD, "and mail it"), true);
  f.send({ type: "system", subtype: "init", session_id: `sess-quiet-${backgroundWork}`, model: "claude-sonnet-5" });
  f.send({ type: "assistant", message: { content: [{ type: "text", text: "Export started in the background." }] } });
  f.send({ type: "result", subtype: "success", is_error: false, num_turns: 1, duration_api_ms: 400, total_cost_usd: 1, session_id: `sess-quiet-${backgroundWork}`, result: "Export started in the background." });
  await f.flush();
  // a background task keeps the process alive, saying nothing: that is
  // what the quiet spell is for
  t.mock.timers.tick(29_000);
  await f.flush();
  assert.equal(f.ends().length, 0);
  t.mock.timers.tick(2_000);
  await f.flush();
  assert.equal(f.ends().length, 1);
  assert.equal(f.ends()[0].ok, true);
  stoppedFirst(f.timeline);
});
