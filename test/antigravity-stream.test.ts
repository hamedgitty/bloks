import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { RuntimeEvent, SendTurnInput } from "../server/contracts.ts";
import { SHUTDOWN_GRACE_MS } from "../server/drivers/engine-processes.ts";
import { OWN_GROUP } from "../server/no-console.ts";

const home = mkdtempSync(join(tmpdir(), "bloks-agy-stream-"));
process.env.BLOKS_DATA_DIR = home;
const { AntigravityDriver } = await import("../server/drivers/antigravity.ts");
after(() => rmSync(home, { recursive: true, force: true }));

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** A turn started on a stand-in agy, whose `turn` script runs once the
 * prompt has been read, with `out(frame)` to write a frame. The caller
 * disposes the driver. */
async function start(turn: string, extra: Partial<SendTurnInput> = {}) {
  const dir = mkdtempSync(join(home, "cli-"));
  const cli = join(dir, "agy.mjs");
  writeFileSync(cli, `#!${process.execPath}
import { writeFileSync } from "node:fs";
if (process.argv[2] === "--version") { console.log("1.4.10"); process.exit(0); }
if (process.argv[2] === "models") { console.log("gemini-3.8-flash-high"); process.exit(0); }
const out = (frame) => console.log(JSON.stringify(frame));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
process.stdin.resume();
process.stdin.on("end", async () => {
  ${turn}
});
`, { mode: 0o755 });
  const instance = await AntigravityDriver.create({
    instanceId: "agy", displayName: undefined, environment: {}, enabled: true,
    config: { cli, fullAuto: false },
  });
  const events: RuntimeEvent[] = [];
  const completed = new Promise<void>(resolve => instance.adapter.onEvent(event => {
    events.push(event);
    if (event.type === "turn.completed") resolve();
  }));
  const send = (more: Partial<SendTurnInput> = {}) => instance.adapter.sendTurn({ threadId: "test-thread", text: "hello",
    cwd: dir, model: "gemini-3.8-flash-high", ...extra, ...more });
  try {
    await send();
  } catch (error) {
    await instance.dispose();
    throw error;
  }
  return { instance, events, dir, completed, send };
}

async function within(done: Promise<void>, ms = 8_000) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([done, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("agy did not finish")), ms);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

/** One turn through a stand-in agy, to its end. */
async function run(turn: string, extra: Partial<SendTurnInput> = {}): Promise<{ events: RuntimeEvent[]; dir: string }> {
  const { instance, events, dir, completed } = await start(turn, extra);
  try {
    await within(completed);
    return { events, dir };
  } finally {
    await instance.dispose();
  }
}

async function answer(frames: unknown[], resumeCursor?: string): Promise<RuntimeEvent[]> {
  const turn = `for (const frame of ${JSON.stringify(frames)}) out(frame);`;
  return (await run(turn, resumeCursor ? { resumeCursor } : {})).events;
}

const init = { event: "init", conversation_id: "conversation-1", init: {} };
const step = (index: number, input: number, cached: number, output: number) => ({
  event: "step_update", step_update: { step_type: "agent_response", step_index: index,
    state: "DONE", usage: { input_tokens: input, cache_read_tokens: cached, output_tokens: output } },
});

test("an agy error reaches the harness before the failed turn ends", async () => {
  const message = "API error (attempt 1): INTERNAL (code 500): Internal error encountered.";
  const events = await answer([init, { event: "result", result: { status: "ERROR", error: message } }]);
  const error = events.find(event => event.type === "runtime.error");
  assert.equal(error?.type === "runtime.error" && error.message, message);
  assert.ok(events.indexOf(error!) < events.findIndex(event => event.type === "turn.completed"));
  assert.equal(events.filter(event => event.type === "turn.completed").length, 1);
  const completed = events.find(event => event.type === "turn.completed");
  assert.equal(completed?.ok, false);
});

test("an agy failure with no words of its own still says how it ended", async () => {
  const events = await answer([init, { event: "result", result: { status: "TIMEOUT" } }]);
  const error = events.find(event => event.type === "runtime.error");
  assert.equal(error?.type === "runtime.error" && error.message, "Antigravity ended with status TIMEOUT.");
  assert.equal(events.find(event => event.type === "turn.completed")?.ok, false);
});

test("a successful agy turn raises no error", async () => {
  const events = await answer([init, { event: "result", result: { status: "SUCCESS", response: "hello" } }]);
  assert.equal(events.some(event => event.type === "runtime.error"), false);
});

test("a resumed agy turn counts its requests once, not the conversation's lifetime usage", async () => {
  const events = await answer([init, step(20, 30, 100, 5), step(20, 30, 100, 5), step(22, 40, 200, 7),
    { event: "result", result: { status: "SUCCESS", response: "hello",
      usage: { input_tokens: 100_000, cache_read_tokens: 900_000, output_tokens: 50_000 } } }], "conversation-1");
  const usage = events.filter(event => event.type === "thread.token-usage.updated");
  assert.equal(usage.at(-1)?.input, 370);
  assert.equal(usage.at(-1)?.output, 12);
  assert.equal(usage.at(-1)?.context, 240, "context is the latest request, not the sum of requests");
});

test("a resumed result without request usage is unmeasured, never charged its entire history", async () => {
  const events = await answer([init, { event: "result", result: { status: "SUCCESS", response: "hello",
    usage: { input_tokens: 100_000, output_tokens: 50_000 } } }], "conversation-1");
  assert.equal(events.filter(event => event.type === "thread.token-usage.updated").length, 0);
});

test("a fresh result-only agy can still report the turn's usage", async () => {
  const events = await answer([init, { event: "result", result: { status: "SUCCESS", response: "hello",
    usage: { input_tokens: 30, cache_read_tokens: 100, output_tokens: 5 } } }]);
  const usage = events.find(event => event.type === "thread.token-usage.updated");
  assert.equal(usage?.input, 130);
  assert.equal(usage?.output, 5);
});

const tool = (index: number, state: string) => ({
  event: "step_update", step_update: { step_type: "tool", step_index: index, tool_name: "run_command", state },
});

// Bloks used to start every agy turn with --print-timeout 10m, which ends
// the turn at ten minutes however busy it is (GitHub 528). Only a tool
// step gone silent for the stall limit may end it now.
test("an agy turn runs past the stall limit while it keeps working", async () => {
  const { events } = await run(`
    for (let i = 0; i < 6; i++) { out(${JSON.stringify(tool(0, "ACTIVE"))}); await wait(200); out(${JSON.stringify(tool(0, "DONE"))}); }
    await wait(1_500);
    out({ event: "result", result: { status: "SUCCESS", response: "done" } });
  `, { stallMs: 1_000 });
  assert.equal(events.some(event => event.type === "runtime.error"), false);
  assert.equal(events.find(event => event.type === "turn.completed")?.ok, true);
});

/** Whether a process can still run: kill(0) also finds a Linux zombie,
 * which an orphan stays until init reaps it. */
function running(pid: number) {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (process.platform !== "linux") return true;
  try {
    return !/\) [ZX] /.test(readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return false;
  }
}

/** A stand-in agy that starts a command deaf to SIGTERM, records both
 * pids, opens a tool step and goes silent. `onTerm` is what agy itself
 * does on SIGTERM; without one it ends. */
const silentWithDeafCommand = (onTerm = "") => `
  const { spawn } = await import("node:child_process");
  const command = spawn(process.execPath, ["-e",
    "process.on('SIGTERM', () => {}); process.stdout.write('ready'); setInterval(() => {}, 60_000)"],
    { stdio: ["ignore", "pipe", "ignore"] });
  await new Promise((resolve) => command.stdout.once("data", resolve));
  writeFileSync("pids", JSON.stringify([process.pid, command.pid]));
  ${onTerm}
  out(${JSON.stringify(init)});
  out(${JSON.stringify(tool(4, "ACTIVE"))});
  setInterval(() => {}, 60_000);
`;

async function until(ready: () => boolean, what: string) {
  for (let i = 0; i < 200 && !ready(); i++) await wait(25);
  assert.ok(ready(), what);
}

test("a silent agy tool step ends the turn as stalled once agy and its command are gone, and nothing agy says while stopping counts", { skip: !OWN_GROUP }, async (t) => {
  // agy answers SIGTERM with a last result before it exits
  const late = { event: "result", result: { status: "SUCCESS", response: "late",
    usage: { input_tokens: 99, output_tokens: 9 } } };
  const { instance, events, dir, completed, send } = await start(silentWithDeafCommand(`
    process.on("SIGTERM", () => process.stdout.write(${JSON.stringify(JSON.stringify(late))} + "\\n", () => process.exit(0)));
  `), { stallMs: 300 });
  let pids: number[] = [];
  t.after(async () => {
    await instance.dispose();
    for (const pid of pids) try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
  });
  await until(() => events.some(event => event.type === "runtime.error"), "the stall was never declared");
  pids = JSON.parse(readFileSync(join(dir, "pids"), "utf8"));
  // the command has not let go yet, so neither has the turn
  await assert.rejects(send({ text: "next" }), /already running/);
  await within(completed);
  assert.deepEqual(pids.filter(running), [], "the turn ended before agy and its command did");
  await wait(100);
  const error = events.findIndex(event => event.type === "runtime.error");
  assert.match(events[error]?.type === "runtime.error" ? events[error].message : "", /^run_command made no progress/);
  assert.equal(events.filter(event => event.type === "runtime.error").length, 1);
  assert.equal(events.at(-1)?.type, "turn.completed", "something reached the harness after the turn ended");
  assert.equal(events.some(event => event.type === "content.delta" || event.type === "thread.token-usage.updated"), false,
    "what agy said while stopping was taken as the turn's");
  const completion = events.at(-1);
  assert.equal(completion?.type === "turn.completed" && completion.ok, false);
  assert.equal(completion?.type === "turn.completed" && completion.stopReason, "tool_stalled");
});

test("Stop ends an agy that ignores SIGTERM, with the stall limit off", async (t) => {
  const { instance, events, dir, completed } = await start(`
    process.on("SIGTERM", () => {});
    writeFileSync("pids", JSON.stringify([process.pid]));
    out(${JSON.stringify(init)});
    out(${JSON.stringify(tool(4, "ACTIVE"))});
    setInterval(() => {}, 60_000);
  `, { stallMs: 0 });
  let pids: number[] = [];
  t.after(async () => {
    await instance.dispose();
    for (const pid of pids) try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
  });
  await until(() => events.some(event => event.type === "item.started"), "the tool step never started");
  pids = JSON.parse(readFileSync(join(dir, "pids"), "utf8"));
  await instance.adapter.interruptTurn("test-thread");
  await within(completed);
  assert.deepEqual(pids.filter(running), [], "agy outlived the stopped turn");
  assert.equal(events.some(event => event.type === "runtime.error"), false);
  const completion = events.at(-1);
  assert.equal(completion?.type === "turn.completed" && completion.stopReason, "interrupted");
});

test("disposing during a stall's grace ends the command agy left behind, without waiting out the grace", { skip: !OWN_GROUP }, async (t) => {
  const { instance, events, dir } = await start(silentWithDeafCommand(), { stallMs: 300 });
  let pids: number[] = [];
  t.after(async () => {
    await instance.dispose();
    for (const pid of pids) try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
  });
  await until(() => events.some(event => event.type === "runtime.error"), "the stall was never declared");
  pids = JSON.parse(readFileSync(join(dir, "pids"), "utf8"));
  const [agy, command] = pids;
  await until(() => !running(agy), "agy did not end on SIGTERM");
  assert.ok(running(command), "the command should still be waiting for its SIGKILL");
  const began = Date.now();
  await instance.dispose();
  assert.equal(running(command), false, "dispose returned with the command still running");
  assert.ok(Date.now() - began < SHUTDOWN_GRACE_MS, "dispose waited out the stop grace");
});

// Auto approvals answer yes for the owner's own requests only, as the
// approval gate does (GitHub 542). Anyone else's turn stays in accept-edits.
test("agy runs in its Auto mode only on an owner's own turn of an agent on auto", async () => {
  const { agyMode } = await import("../server/drivers/antigravity.ts");
  const config = { cli: "agy", fullAuto: false };
  const turn = { threadId: "t", text: "hi" };
  assert.deepEqual(agyMode(config, { ...turn, autoApproves: true }), ["--mode", "auto"]);
  assert.deepEqual(agyMode(config, turn), ["--mode", "accept-edits"]);
  for (const other of [{ untrusted: true }, { forOthers: true }, { shared: { tools: "desk" as const } }, { person: {} as never }]) {
    assert.deepEqual(agyMode(config, { ...turn, autoApproves: true, ...other }), ["--mode", "accept-edits"], JSON.stringify(other));
  }
  assert.deepEqual(agyMode(config, { ...turn, fullAccess: true }), ["--dangerously-skip-permissions"]);
  assert.deepEqual(agyMode({ ...config, fullAuto: true }, { ...turn, untrusted: true }), ["--mode", "accept-edits"]);
});
