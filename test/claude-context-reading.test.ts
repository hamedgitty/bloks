// Native frames through the actual driver and HTTP server, without a
// provider or an account: request readings and accounting stay separate.
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startHarness } from "./helpers/server.ts";
import { waitFor } from "./helpers/turns.ts";

const assistant = (used: number, parent?: unknown, cacheWrite = 0) => ({
  type: "assistant", parent_tool_use_id: parent,
  message: { content: [{ type: "text", text: "Request" }], usage: { input_tokens: used - cacheWrite, cache_creation_input_tokens: cacheWrite, cache_creation: { ephemeral_1h_input_tokens: cacheWrite }, output_tokens: 7 } },
});
const boundary = (parent?: unknown) => ({ type: "system", subtype: "compact_boundary", parent_tool_use_id: parent,
  compact_metadata: { pre_tokens: 256_720, post_tokens: 10_589 } });

async function setup(t: TestContext, beforeTurn = 0, idle = false) {
  const fixtureHome = mkdtempSync(join(tmpdir(), "bloks-claude-reading-"));
  const scene = join(fixtureHome, "frames.json");
  const runs = join(fixtureHome, "runs.jsonl");
  const cli = join(fixtureHome, "fake-claude.mjs");
  writeFileSync(scene, "[]");
  writeFileSync(runs, "");
  writeFileSync(cli, `#!${process.execPath}
import { appendFileSync, readFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("9.9.9 (Claude Code)"); process.exit(0); }
if (args[0] === "auth") { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
const out = f => console.log(JSON.stringify(f));
let input = "";
process.stdin.on("data", async function take(c) {
  input += c;
  const frame = input.split("\\n").slice(0, -1).filter(Boolean).map(JSON.parse).find(f => f.type === "user");
  if (!frame) return;
  process.stdin.off("data", take);
  const said = frame.message.content;
  appendFileSync(${JSON.stringify(runs)}, JSON.stringify({ said, args }) + "\\n");
  out({ type: "system", subtype: "init", session_id: "parent-session", model: "claude-sonnet-5" });
  const frames = said === "/compact" ? [${JSON.stringify(boundary())}] : JSON.parse(readFileSync(${JSON.stringify(scene)}, "utf8"));
  for (const frame of frames) {
    if (frame.wait) { await new Promise(r => setTimeout(r, frame.wait)); continue; }
    out(frame);
  }
  out({ type: "result", subtype: "success", is_error: false, num_turns: 1, duration_api_ms: 1,
    session_id: "parent-session", result: "Done", total_cost_usd: 0,
    usage: { input_tokens: 300000, output_tokens: 100 },
    modelUsage: { "claude-sonnet-5": { contextWindow: 1000000 } } });
});
`, { mode: 0o755 });
  mkdirSync(join(fixtureHome, ".bloks"));
  writeFileSync(join(fixtureHome, ".bloks", "config.json"), JSON.stringify({
    compaction: { idle, beforeTurn },
    instances: { claude: { driver: "claudeAgent", config: { cli } } },
  }));
  let h = await startHarness({ HOME: fixtureHome, ...(idle ? { BLOKS_IDLE_CACHE_MS: "7000" } : {}) });
  t.after(async () => { await h.stop(); rmSync(fixtureHome, { recursive: true, force: true }); });
  const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Parent" }) });
  await h.fetch(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } }) });
  const calls = () => readFileSync(runs, "utf8").trim().split("\n").filter(Boolean).map(s => JSON.parse(s));
  const agent = async () => (await h.json("/api/bots?messages=0")).bots.find((b: any) => b.id === bot.id);
  const lane = async () => (await agent()).tasks.find((l: any) => l.id === bot.threadId);
  const messages = async () => (await h.json(`/api/bots/${bot.id}/messages?limit=200`)).messages as any[];
  const start = async (frames: any[], text = "Next") => {
    writeFileSync(scene, JSON.stringify(frames));
    const count = calls().length;
    const res = await h.fetch(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text }) });
    assert.ok(res.ok);
    return async () => assert.ok(await waitFor(async () => calls().length > count && !(await agent()).busy, 15_000), h.logs());
  };
  const turn = async (frames: any[], text = "Next") => { await (await start(frames, text))(); };
  const restart = async () => { await h.stop(); h = await startHarness({ HOME: fixtureHome }); };
  const stored = () => JSON.parse(readFileSync(join(fixtureHome, ".bloks", "bots.json"), "utf8")).find((b: any) => b.id === bot.id).tasks.find((l: any) => l.id === bot.threadId);
  const model = async (model: string) => h.fetch(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "claude", model } }) });
  return { lane, messages, start, turn, calls, restart, stored, agent, model };
}

test("a Claude marker uses the own last-before and first-after requests", async t => {
  const f = await setup(t);
  await f.turn([assistant(274_710)]);
  const finish = await f.start([boundary(), { wait: 700 }, assistant(1, "child"), assistant(0), assistant(71_542, null), assistant(90_000)]);
  const pending = await waitFor(async () => (await f.messages()).find(m => m.compaction));
  assert.equal(pending.text, "Compacted · from 275k");
  assert.deepEqual(pending.compaction, { before: 274_710, after: null });
  assert.equal((await f.lane()).context.used, 0);
  assert.ok(f.stored().pendingCompaction);
  await finish();
  const markers = (await f.messages()).filter(m => m.compaction);
  assert.equal(markers.length, 1);
  assert.equal(markers[0].id, pending.id);
  assert.equal(markers[0].at, pending.at);
  assert.equal(markers[0].text, "Compacted · 275k → 72k");
  assert.equal(markers[0].compaction.after, 71_542);
  assert.equal((await f.lane()).context.used, 90_000);
  assert.equal(f.stored().pendingCompaction, undefined);
});

test("window-only result leaves a marker pending across a real server restart", async t => {
  const f = await setup(t);
  await f.turn([assistant(274_710)]);
  await f.turn([boundary()]);
  const marker = (await f.messages()).find(m => m.compaction);
  assert.equal(marker.text, "Compacted · from 275k");
  assert.equal(f.stored().reading.used, 0);
  assert.ok(f.stored().pendingCompaction);
  await f.restart();
  await f.turn([assistant(71_542), assistant(90_000)]);
  const patched = (await f.messages()).find(m => m.id === marker.id);
  assert.equal(patched.compaction.after, 71_542);
  assert.equal(patched.at, marker.at);
});

test("a typed Claude /compact result's accounting input does not drive the after-turn fold", async t => {
  const f = await setup(t);
  await f.turn([assistant(50_000)]);
  await f.turn([], "/compact");
  assert.equal(f.stored().lastInput, 300_000, "result usage is still accounted");
  assert.equal((await f.lane()).context.measured, false);
  assert.equal((await f.lane()).context.used, 0);
  assert.ok(f.stored().pendingCompaction, "no subsequent request has reported its size");
  assert.deepEqual(f.calls().map(r => r.said), ["Next", "/compact"], "result accounting must not cause another engine call");
});

test("a child-last frame keeps the parent's reading and all child accounting", async t => {
  const f = await setup(t);
  await f.turn([assistant(50_000, undefined, 10_000), assistant(300_000, "foreground-child", 40_000)]);
  assert.equal((await f.lane()).context.used, 50_000);
  assert.equal(f.stored().usage.input, 260_000, "the child's original accounting event was retained");
  assert.equal(f.stored().usage.output, 7);
  await f.turn([assistant(300_000, null), assistant(1_000, "background-child")]);
  assert.equal((await f.lane()).context.used, 300_000);
  await f.turn([assistant(50_000), assistant(300_000, "child"), assistant(60_000)]);
  assert.equal((await f.lane()).context.used, 60_000, "the next parent request wins");
});

test("larger and smaller child requests leave the parent's pre-turn compaction unchanged", async t => {
  const f = await setup(t, 200_000);
  await f.turn([assistant(50_000), assistant(300_000, "child")]);
  await f.turn([assistant(50_000)]);
  assert.equal(f.calls().filter(r => r.said === "/compact").length, 0, "a large child cannot turn it on");
  await f.turn([assistant(300_000), assistant(1_000, "child")]);
  await f.turn([assistant(50_000)]);
  assert.equal(f.calls().filter(r => r.said === "/compact").length, 1, "a small child cannot turn it off");
});

test("larger and smaller child requests leave the parent's eligible idle compaction unchanged", async t => {
  const f = await setup(t, 0, true);
  await f.turn([assistant(50_000, undefined, 1_000), assistant(300_000, "child", 2_000)]);
  await new Promise(r => setTimeout(r, 8_000));
  assert.equal(f.calls().filter(r => r.said === "/compact").length, 0, "the child's size did not make the small parent eligible");
  await f.turn([assistant(300_000, null, 2_000), assistant(1_000, "child", 100)]);
  assert.ok(await waitFor(() => f.calls().some(r => r.said === "/compact"), 15_000), "the small child suppressed the large parent's idle compaction");
  const marker = await waitFor(async () => (await f.messages()).find(m => m.compaction?.idle), 5_000);
  assert.equal(marker.compaction.before, 300_000);
});

test("a child compact boundary does not mark or invalidate the parent", async t => {
  const f = await setup(t);
  await f.turn([assistant(50_000)]);
  await f.turn([boundary("child"), assistant(300_000, "child")]);
  assert.equal((await f.messages()).filter(m => m.compaction).length, 0);
  assert.equal(f.stored().pendingCompaction, undefined);
  assert.equal((await f.lane()).context.used, 50_000);
});

test("an interrupted child-last turn keeps the parent reading", async t => {
  const f = await setup(t);
  await f.turn([assistant(50_000), assistant(300_000, "foreground-child"),
    { type: "result", subtype: "error_during_execution", is_error: true, num_turns: 1,
      duration_api_ms: 1, session_id: "parent-session", result: "Stopped for this fixture", total_cost_usd: 0 }]);
  assert.equal((await f.lane()).context.used, 50_000);
  assert.equal(f.stored().usage.input, 300_000);
});

test("every non-null parent value is a child and missing usage cannot resolve a marker", async t => {
  const f = await setup(t);
  await f.turn([assistant(50_000)]);
  await f.turn([boundary(), ...["", false, 0, {}, []].map(parent => assistant(300_000, parent)),
    { type: "assistant", message: { content: [] } }, assistant(0), assistant(-1)]);
  assert.equal((await f.lane()).context.used, 0);
  assert.ok(f.stored().pendingCompaction);
  assert.equal((await f.messages()).find(m => m.compaction).compaction.after, null);
});

test("a different model's last request is unknown at the next boundary", async t => {
  const f = await setup(t);
  await f.turn([assistant(274_710)]);
  assert.ok((await f.model("claude-opus-5-5")).ok);
  await f.turn([boundary(), assistant(71_542)]);
  const marker = (await f.messages()).find(m => m.compaction);
  assert.equal(marker.compaction.before, null);
  assert.equal(marker.compaction.after, 71_542);
});

test("a window-only /compact result does not clear the growth guard", async t => {
  const f = await setup(t, 200_000);
  await f.turn([assistant(274_710)]);
  await f.turn([assistant(280_000), assistant(0), assistant(1_000, "child")]);
  assert.equal(f.calls().filter(r => r.said === "/compact").length, 1);
  await f.turn([assistant(280_000)]);
  assert.equal(f.calls().filter(r => r.said === "/compact").length, 1, "still above the line, but below lastFrom times 1.1");
  await f.turn([assistant(310_000)]);
  await f.turn([assistant(310_000)]);
  assert.equal(f.calls().filter(r => r.said === "/compact").length, 2, "growth by a tenth compacts again");
  await f.turn([assistant(50_000)]);
  await f.turn([assistant(250_000)]);
  await f.turn([assistant(50_000)]);
  assert.equal(f.calls().filter(r => r.said === "/compact").length, 3, "an under-line parent clears the guard for a new crossing");
});

test("a missing own request never borrows compact pre_tokens for before", async t => {
  const f = await setup(t);
  await f.turn([boundary(), assistant(71_542)]);
  const marker = (await f.messages()).find(m => m.compaction);
  assert.equal(marker.compaction.before, null);
  assert.equal(marker.compaction.after, 71_542);
});
