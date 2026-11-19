import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { RuntimeEvent, SendTurnInput } from "../server/contracts.ts";
import { OWN_GROUP } from "../server/no-console.ts";

const home = mkdtempSync(join(tmpdir(), "bloks-agy-stream-"));
process.env.BLOKS_DATA_DIR = home;
const { AntigravityDriver } = await import("../server/drivers/antigravity.ts");
after(() => rmSync(home, { recursive: true, force: true }));

/** One turn through a stand-in agy, whose `turn` script runs once the
 * prompt has been read, with `out(frame)` to write a frame. `ended` runs
 * after the turn completes and before the driver is disposed. */
async function run(turn: string, extra: Partial<SendTurnInput> = {},
  ended?: (dir: string) => Promise<void>): Promise<{ events: RuntimeEvent[]; dir: string }> {
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
  let done!: () => void;
  const completed = new Promise<void>(resolve => { done = resolve; });
  instance.adapter.onEvent(event => {
    events.push(event);
    if (event.type === "turn.completed") done();
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await instance.adapter.sendTurn({ threadId: "test-thread", text: "hello", cwd: dir,
      model: "gemini-3.8-flash-high", ...extra });
    await Promise.race([completed, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("agy did not finish")), 8_000);
    })]);
    await ended?.(dir);
    return { events, dir };
  } finally {
    clearTimeout(timer);
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
    await wait(600);
    out({ event: "result", result: { status: "SUCCESS", response: "done" } });
  `, { stallMs: 300 });
  assert.equal(events.some(event => event.type === "runtime.error"), false);
  assert.equal(events.find(event => event.type === "turn.completed")?.ok, true);
});

test("a silent agy tool step ends the turn as stalled and stops agy and its command, even one deaf to SIGTERM", { skip: !OWN_GROUP }, async (t) => {
  let pids: number[] = [];
  t.after(() => { for (const pid of pids) try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } });
  const { events } = await run(`
    // agy itself ends on SIGTERM; the command it started does not
    const { spawn } = await import("node:child_process");
    const command = spawn(process.execPath, ["-e",
      "process.on('SIGTERM', () => {}); process.stdout.write('ready'); setInterval(() => {}, 60_000)"],
      { stdio: ["ignore", "pipe", "ignore"] });
    await new Promise((resolve) => command.stdout.once("data", resolve));
    writeFileSync("pids", JSON.stringify([process.pid, command.pid]));
    out(${JSON.stringify(init)});
    out(${JSON.stringify(tool(4, "ACTIVE"))});
    setInterval(() => {}, 60_000);
  `, { stallMs: 300 }, async (dir) => {
    // before dispose, which would end agy on its own
    pids = JSON.parse(readFileSync(join(dir, "pids"), "utf8"));
    const alive = () => pids.filter((pid) => { try { process.kill(pid, 0); return true; } catch { return false; } });
    for (let i = 0; i < 100 && alive().length; i++) await new Promise(resolve => setTimeout(resolve, 50));
    assert.deepEqual(alive(), [], "agy or its command is still running");
  });
  const error = events.findIndex(event => event.type === "runtime.error");
  const completions = events.filter(event => event.type === "turn.completed");
  assert.match(events[error]?.type === "runtime.error" ? events[error].message : "", /^run_command made no progress/);
  assert.equal(completions.length, 1);
  assert.ok(error < events.indexOf(completions[0]), "the error came after the turn ended");
  assert.equal(completions[0].ok, false);
  assert.equal(completions[0].type === "turn.completed" && completions[0].stopReason, "tool_stalled");
});
