import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { RuntimeEvent } from "../server/contracts.ts";

const home = mkdtempSync(join(tmpdir(), "bloks-agy-stream-"));
process.env.BLOKS_DATA_DIR = home;
const { AntigravityDriver } = await import("../server/drivers/antigravity.ts");
after(() => rmSync(home, { recursive: true, force: true }));

async function answer(frames: unknown[], resumeCursor?: string): Promise<RuntimeEvent[]> {
  const dir = mkdtempSync(join(home, "cli-"));
  const cli = join(dir, "agy.mjs");
  writeFileSync(cli, `#!${process.execPath}
if (process.argv[2] === "--version") { console.log("1.4.10"); process.exit(0); }
if (process.argv[2] === "models") { console.log("gemini-3.8-flash-high"); process.exit(0); }
process.stdin.resume();
process.stdin.on("end", () => {
  for (const frame of ${JSON.stringify(frames)}) console.log(JSON.stringify(frame));
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
      model: "gemini-3.8-flash-high", ...(resumeCursor ? { resumeCursor } : {}) });
    await Promise.race([completed, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("agy did not finish")), 8_000);
    })]);
    return events;
  } finally {
    clearTimeout(timer);
    await instance.dispose();
  }
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
