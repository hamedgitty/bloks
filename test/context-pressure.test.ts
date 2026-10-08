// Long native sessions: how full they are, compacting them before a turn,
// and what a new session is told (GitHub 222, 223, 224).
//
// A native session sends its whole context again on every tool call, so
// a long one turned one tool-heavy message into millions of input tokens
// and emptied a five-hour limit in twenty minutes. The fakes below are
// stand-ins for Codex's app-server, Claude Code and pi-acp that make two
// dozen tool calls a turn on a large context, the way the reports did,
// and the tests check three things: the lane reads the latest request
// against the engine's own window (not the turn's sum against a guess),
// the next turn on a session over the line is compacted first, and a new
// session on a long conversation is told a bounded story.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import {
  BEFORE_TURN_CEILING,
  HANDOFF_MAX_TOKENS,
  beforeTurnLine,
  boundHandoff,
  clipText,
  compactBeforeTurn,
  contextLimitFor,
  handoffBudget,
  knownLimitFor,
  laneFill,
  summaryTurn,
  type Reading,
  type Turn,
} from "../server/context.ts";
import { acpReading } from "../server/drivers/acp.ts";
import { contextWindowOf } from "../server/drivers/claude.ts";
import { contextReading } from "../server/drivers/codex.ts";
import { freshTurnText } from "../server/turn-context.ts";
import { UsageStore, summarize } from "../server/usage.ts";
import { startHarness, type Harness } from "./helpers/server.ts";
import { waitFor } from "./helpers/turns.ts";

const say = (role: Turn["role"], text: string): Turn => ({ role, text });

// ── the numbers ────────────────────────────────────────────────────────

describe("how full a session is", () => {
  test("GPT-6 point releases have a window, not the default", () => {
    assert.equal(contextLimitFor("gpt-6.1-sol"), 272_000);
    assert.equal(contextLimitFor("gpt-6"), 272_000);
    assert.equal(knownLimitFor("gpt-6.1-sol"), 272_000);
    assert.equal(knownLimitFor("something-new-1"), null, "the default is a guess, not a known limit");
  });

  test("each engine's own numbers are read where it puts them", () => {
    // Codex: the latest request and the window it holds the thread to
    assert.deepEqual(
      contextReading({ total: { inputTokens: 4_100_000 }, last: { inputTokens: 172_300 }, modelContextWindow: 258_400 }),
      { used: 172_300, window: 258_400 },
    );
    assert.deepEqual(contextReading({ total: { inputTokens: 9 } }), { used: null, window: null });
    // ACP: usage_update's used and size
    assert.deepEqual(acpReading({ sessionUpdate: "usage_update", used: 150_000, size: 200_000 }), { used: 150_000, window: 200_000 });
    assert.deepEqual(acpReading({ sessionUpdate: "usage_update", used: "lots" }), { used: null, window: null });
    // Claude Code: the result's modelUsage, for the turn's own model
    const result = {
      modelUsage: {
        "claude-haiku-4-5": { contextWindow: 200_000 },
        "claude-sonnet-5": { contextWindow: 1_000_000 },
      },
    };
    assert.equal(contextWindowOf(result, "sonnet", "claude-sonnet-5"), 1_000_000);
    assert.equal(contextWindowOf(result, "opus", null), null, "two models and neither is the turn's");
    assert.equal(contextWindowOf({ modelUsage: { "claude-sonnet-5": { contextWindow: 1_000_000 } } }, "sonnet"), 1_000_000);
    assert.equal(contextWindowOf({}, "sonnet"), null);
  });

  test("a reading counts only for the engine and model that made it", () => {
    const codex: Reading = { used: 66_046, window: 258_400, instanceId: "codex", model: "gpt-6.1-sol", at: 1 };
    const own = laneFill(codex, 958_776, { instanceId: "codex", model: "gpt-6.1-sol" });
    assert.equal(own.used, 66_046);
    assert.equal(own.limit, 258_400);
    assert.equal(own.window, "engine");
    // the agent moved to Claude: Codex's numbers are not Claude's
    const moved = laneFill(codex, 958_776, { instanceId: "claude", model: "claude-opus-5-5" });
    assert.equal(moved.used, 0);
    assert.equal(moved.limit, 1_000_000);
    assert.equal(moved.window, "table");
    // the same engine on another model has not been measured either
    assert.equal(laneFill(codex, 0, { instanceId: "codex", model: "gpt-6-luna" }).used, 0);
    // a lane from before readings were kept shows what it showed
    assert.equal(laneFill(undefined, 120_000, { instanceId: "claude", model: "claude-sonnet-5" }).used, 120_000);
  });
});

describe("compacting before a turn", () => {
  test("the line is the lower of a share of the window and the ceiling", () => {
    assert.equal(BEFORE_TURN_CEILING, 200_000);
    assert.equal(beforeTurnLine({ window: 258_400, ceiling: 200_000 }), 155_040);
    assert.equal(beforeTurnLine({ window: 1_000_000, ceiling: 200_000 }), 200_000, "a big window is a limit, not a budget");
    assert.equal(beforeTurnLine({ window: null, ceiling: 200_000 }), 200_000);
    assert.equal(beforeTurnLine({ window: 258_400, at: 0.8, ceiling: 400_000 }), 206_720);
  });

  test("over the line compacts, under it or switched off does not", () => {
    const lane = { window: 258_400, ceiling: 200_000 };
    assert.equal(compactBeforeTurn({ ...lane, used: 172_300 }), true);
    assert.equal(compactBeforeTurn({ ...lane, used: 140_977 }), false);
    assert.equal(compactBeforeTurn({ ...lane, used: 172_300, ceiling: 0 }), false, "off");
    assert.equal(compactBeforeTurn({ ...lane, used: 0 }), false, "nothing measured");
    // a compaction that did not bring it down is not asked for every turn
    assert.equal(compactBeforeTurn({ ...lane, used: 180_000, lastFrom: 172_300 }), false);
    assert.equal(compactBeforeTurn({ ...lane, used: 190_000, lastFrom: 172_300 }), true, "grown a tenth since");
  });
});

describe("what a new session is told", () => {
  const long = (n: number, size: number): Turn[] =>
    Array.from({ length: n }, (_, i) => say(i % 2 ? "assistant" : "user", `message ${i} ${"x".repeat(size)}`));

  test("the budget follows the window, within bounds", () => {
    assert.equal(handoffBudget(1_000_000), HANDOFF_MAX_TOKENS);
    assert.equal(handoffBudget(32_000), 4_800);
    assert.equal(handoffBudget(4_000), 2_000);
    assert.equal(handoffBudget(null), HANDOFF_MAX_TOKENS);
  });

  test("a long conversation is cut to the budget from the end, saying how much was left out", () => {
    const turns = long(300, 2_000);
    const budget = 4_000;
    const told = boundHandoff(turns, budget);
    const chars = told.turns.reduce((n, t) => n + t.text.length, 0);
    assert.ok(chars <= budget * 4, `${chars} characters is over the budget`);
    assert.equal(told.turns.at(-1)!.text, turns.at(-1)!.text, "the latest message is whole");
    assert.equal(told.left, 300 - told.turns.length);
    assert.ok(told.left > 250);
    // and the text the engine gets says so
    const text = freshTurnText(told.turns, "Carry on.", { left: told.left });
    assert.match(text, new RegExp(`${told.left} earlier messages are left out`));
    assert.match(text, /--- the new message ---\n\nCarry on\.$/);
  });

  test("the summary is kept, and one huge message cannot crowd out the rest", () => {
    const turns = [summaryTurn("They want the launch moved to Friday."), ...long(10, 100), say("user", "y".repeat(500_000))];
    const told = boundHandoff(turns, 2_000);
    assert.match(told.turns[0].text, /launch moved to Friday/);
    const last = told.turns.at(-1)!.text;
    assert.ok(last.length <= 2_000, "the pasted log was sent whole");
    assert.match(last, /characters left out/);
    assert.ok(told.turns.length >= 3, "the end of the conversation is there");
    assert.equal(clipText("short", 100), "short");
  });

  test("a new session after a lost cursor is told so", () => {
    assert.match(freshTurnText([say("user", "hi")], "next", { why: "session" }), /in a new session; the earlier one could not be carried on/);
  });
});

describe("usage an engine did not report", () => {
  test("a turn that answered with no tokens is counted as not reported, not as free", () => {
    const store = new UsageStore(join(mkdtempSync(join(tmpdir(), "bloks-usage-")), "usage.json"));
    store.recordTurn("pi-agent", "pi", null, new Date(), true);
    store.recordTurn("pi-agent", "pi", null, new Date(), false);
    store.noteTokens("codex-agent", "codex", 100, 10);
    store.recordTurn("codex-agent", "codex", null, new Date(), true);
    const summary = summarize(store.since(1), 1);
    assert.equal(summary.unmeasured, 1, "a failed turn is not a turn that went unreported");
    assert.equal(summary.total.turns, 3);
    assert.equal(store.since(1).find((b) => b.botId === "pi-agent")?.unmeasured, 1);
  });
});

// ── the round trip through a real server ───────────────────────────────

const lines = (file: string) =>
  existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];

const TOOL_CALLS = 24;
const WINDOW = 258_400;

/**
 * A stand-in for `codex app-server`. Every turn makes two dozen tool
 * calls, each a model request that carries the whole thread: 170k tokens
 * of it on a turn that says BIG until the thread is compacted, and 40k
 * otherwise. `thread/compact/start`
 * compacts the way the real one does (a turn of its own), or is refused
 * with `refuseCompact`, the way an app-server without it answers.
 */
function fakeCodex(home: string, refuseCompact = false): string {
  const cli = join(home, "fake-codex.mjs");
  writeFileSync(
    cli,
    `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("codex-cli 9.9.9"); process.exit(0); }
if (args[0] === "login") { console.log("Logged in using ChatGPT"); process.exit(0); }
const HOME = ${JSON.stringify(home)};
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
const log = (m) => appendFileSync(HOME + "/codex-log.jsonl", JSON.stringify(m) + "\\n");
const stateFile = HOME + "/codex-state.json";
const load = () => (existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : { threads: 0, small: {} , total: {} });
const save = (s) => writeFileSync(stateFile, JSON.stringify(s));
let thread = null;
createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (!m.method) return;
  const state = load();
  if (m.method === "model/list") return send({ id: m.id, result: { data: [{ id: "gpt-6.1-sol", model: "gpt-6.1-sol", displayName: "GPT-6.1-Sol", isDefault: true, hidden: false }] } });
  if (m.method === "initialize") return send({ id: m.id, result: {} });
  const text = m.method === "turn/start" ? m.params.input.map((i) => i.text).join("") : undefined;
  log({ method: m.method, thread: m.params?.threadId ?? null, text });
  if (m.method === "thread/start") {
    state.threads += 1;
    thread = "thread-" + state.threads;
    save(state);
    return send({ id: m.id, result: { thread: { id: thread }, model: "gpt-6.1-sol" } });
  }
  if (m.method === "thread/resume") {
    thread = m.params.threadId;
    return send({ id: m.id, result: { thread: { id: thread }, model: "gpt-6.1-sol" } });
  }
  if (m.method === "thread/compact/start") {
    if (${refuseCompact}) return send({ id: m.id, error: { code: -32601, message: "unknown method thread/compact/start" } });
    send({ id: m.id, result: {} });
    send({ method: "turn/started", params: { threadId: thread, turn: { id: "compact-turn", status: "inProgress" } } });
    send({ method: "item/started", params: { threadId: thread, item: { type: "contextCompaction", id: "cc" } } });
    send({ method: "item/completed", params: { threadId: thread, item: { type: "contextCompaction", id: "cc" } } });
    state.small[thread] = true;
    save(state);
    return send({ method: "turn/completed", params: { threadId: thread, turn: { id: "compact-turn", status: "completed" } } });
  }
  if (m.method === "turn/start") {
    send({ id: m.id, result: { turn: { id: "turn-1", status: "inProgress" } } });
    send({ method: "turn/started", params: { threadId: thread, turn: { id: "turn-1", status: "inProgress" } } });
    const base = state.small[thread] || !text.includes("BIG") ? 40000 : 170000;
    let total = state.total[thread] ?? 0;
    for (let i = 0; i < ${TOOL_CALLS}; i++) {
      send({ method: "item/started", params: { threadId: thread, item: { type: "commandExecution", id: "c" + i, command: "ls" } } });
      total += base + i * 100;
      send({ method: "thread/tokenUsage/updated", params: { threadId: thread, turnId: "turn-1", tokenUsage: {
        total: { inputTokens: total, outputTokens: (i + 1) * 50 },
        last: { inputTokens: base + i * 100, outputTokens: 50 },
        modelContextWindow: ${WINDOW},
      } } });
      send({ method: "item/completed", params: { threadId: thread, item: { type: "commandExecution", id: "c" + i, status: "completed" } } });
    }
    state.total[thread] = total;
    save(state);
    send({ method: "item/completed", params: { threadId: thread, item: { type: "agentMessage", id: "a", text: "Checked " + text.length } } });
    return send({ method: "turn/completed", params: { threadId: thread, turn: { id: "turn-1", status: "completed" } } });
  }
  if (m.id !== undefined) send({ id: m.id, result: {} });
});
`,
    { mode: 0o755 },
  );
  return cli;
}

async function codexHome(opts: { refuseCompact?: boolean; instances?: string[] } = {}) {
  const home = mkdtempSync(join(tmpdir(), "bloks-pressure-"));
  mkdirSync(join(home, ".bloks"), { recursive: true });
  const cli = fakeCodex(home, opts.refuseCompact);
  const instances = Object.fromEntries((opts.instances ?? ["codex"]).map((id) => [id, { driver: "codex", config: { cli } }]));
  writeFileSync(join(home, ".bloks", "config.json"), JSON.stringify({ instances }));
  const h = await startHarness({ HOME: home });
  return { home, h, log: () => lines(join(home, "codex-log.jsonl")) };
}

const botOf = async (h: Harness, id: string) => (await h.json("/api/bots?messages=0")).bots.find((b: any) => b.id === id);
const messagesOf = async (h: Harness, id: string) => (await h.json(`/api/bots/${id}/messages?limit=200`)).messages as any[];

/** Send, and wait for the lane to be free with one more reply in it. */
async function turn(h: Harness, botId: string, text: string) {
  const replies = (await messagesOf(h, botId)).filter((m) => m.role === "bot" && m.kind === "text").length;
  const sent = await h.fetch(`/api/bots/${botId}/messages`, { method: "POST", body: JSON.stringify({ text }) });
  assert.ok(sent.ok, `sending failed: ${sent.status}`);
  const done = await waitFor(async () => {
    const said = (await messagesOf(h, botId)).filter((m) => m.role === "bot" && m.kind === "text").length;
    return said > replies && !(await botOf(h, botId)).busy ? true : null;
  }, 30_000);
  assert.ok(done, `the turn "${text.slice(0, 20)}" never finished`);
}

const methodsAfter = (log: any[], from: number) =>
  log
    .slice(from)
    .map((l) => l.method)
    .filter((m) => m !== "initialized");

describe("a Codex lane with a long context and two dozen tool calls a turn", () => {
  test("reads the latest request against Codex's window, and is compacted before its next turn", async (t) => {
    const { home, h, log } = await codexHome();
    t.after(async () => {
      await h.stop();
      rmSync(home, { recursive: true, force: true });
    });
    const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Rex" }) });
    await h.fetch(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" } }) });

    await turn(h, bot.id, "BIG: diagnose the usage numbers.");
    const lane = (await botOf(h, bot.id)).tasks.find((l: any) => l.id === bot.threadId);
    // the latest request, not the twenty-four summed
    const last = 170_000 + (TOOL_CALLS - 1) * 100;
    assert.equal(lane.context.used, last);
    assert.equal(lane.context.limit, WINDOW, "the window is Codex's own, not the table's");
    assert.equal(lane.context.window, "engine");
    assert.ok(lane.context.fraction < 0.7, `read ${lane.context.fraction} full`);
    // what the turn spent is still every request, which is the real cost
    // of a long context in a tool loop, and is not how full it is
    const spent = Array.from({ length: TOOL_CALLS }, (_, i) => 170_000 + i * 100).reduce((a, b) => a + b, 0);
    assert.equal((await h.json("/api/usage?days=1")).total.input, spent);
    assert.equal(log().filter((l) => l.method === "thread/compact/start").length, 0, "a first turn has nothing to compact");

    // over 60% of 258,400: the next turn compacts the thread first
    const before = log().length;
    await turn(h, bot.id, "BIG: now apply the fix.");
    const order = methodsAfter(log(), before);
    assert.ok(order.includes("thread/resume"), "the thread was not resumed");
    assert.ok(order.indexOf("thread/compact/start") > order.indexOf("thread/resume"), `no compaction before the turn: ${order.join(", ")}`);
    assert.ok(order.indexOf("thread/compact/start") < order.indexOf("turn/start"), "the words went before the compaction");
    assert.equal(order.filter((m) => m === "thread/start").length, 0, "a compactable thread was replaced");
    const marker = (await messagesOf(h, bot.id)).find((m) => m.compaction);
    assert.equal(marker?.text, "Compacted · from 172k");
    assert.equal(marker.compaction.idle, undefined);
    const after = (await botOf(h, bot.id)).tasks.find((l: any) => l.id === bot.threadId);
    assert.equal(after.context.used, 40_000 + (TOOL_CALLS - 1) * 100);

    // under the line now: the third turn goes straight in
    const third = log().length;
    await turn(h, bot.id, "BIG: and check it worked.");
    assert.deepEqual(
      methodsAfter(log(), third).filter((m) => m !== "initialize"),
      ["thread/resume", "turn/start"],
    );
  });

  test("an app-server that cannot compact gets a new thread told a bounded story", async (t) => {
    const { home, h, log } = await codexHome({ refuseCompact: true });
    t.after(async () => {
      await h.stop();
      rmSync(home, { recursive: true, force: true });
    });
    const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Rex" }) });
    await h.fetch(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" } }) });
    // a long conversation: four pasted logs of 40k characters each, then
    // a turn that leaves the thread at 172k
    for (let i = 0; i < 4; i++) await turn(h, bot.id, `LOG-${i} ${"z".repeat(40_000)}`);
    await turn(h, bot.id, "BIG: go through all of them.");

    const before = log().length;
    await turn(h, bot.id, "FINAL-ASK what broke?");
    const order = methodsAfter(log(), before);
    assert.ok(order.indexOf("thread/compact/start") < order.indexOf("thread/start"), `${order.join(", ")}`);
    const started = log().slice(before).find((l) => l.method === "turn/start");
    assert.notEqual(started.thread, "thread-1", "the words went into the old thread");
    const story = started.text.slice(started.text.indexOf("You are picking up this conversation"));
    assert.ok(story.startsWith("You are picking up this conversation in a new session"), "the new thread was not told the story");
    assert.match(story, /FINAL-ASK what broke\?$/);
    assert.match(story, /go through all of them/, "the most recent part of the story is missing");
    assert.match(story, /LOG-3/);
    assert.ok(story.length <= HANDOFF_MAX_TOKENS * 4 + 2_000, `the story was ${story.length} characters`);
  });

  test("a room lane is compacted before its next turn too", async (t) => {
    const { home, h, log } = await codexHome();
    t.after(async () => {
      await h.stop();
      rmSync(home, { recursive: true, force: true });
    });
    const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Rex" }) });
    await h.fetch(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" } }) });
    const { bot: other } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Ivy" }) });
    await h.fetch(`/api/bots/${other.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" } }) });
    const { blok } = await h.json("/api/bloks", { method: "POST", body: JSON.stringify({ name: "Ops", memberIds: [bot.id, other.id] }) });
    const turnsStarted = () => log().filter((l) => l.method === "turn/start").length;
    const roomTurn = async (text: string) => {
      const was = turnsStarted();
      await h.fetch(`/api/bloks/${blok.id}/messages`, { method: "POST", body: JSON.stringify({ text }) });
      assert.ok(
        await waitFor(async () => (turnsStarted() > was && !(await botOf(h, bot.id)).busy ? true : null), 30_000),
        "the room turn never finished",
      );
    };
    await roomTurn("@Rex BIG: look at the totals");
    const before = log().length;
    await roomTurn("@Rex BIG: and fix them");
    const order = methodsAfter(log(), before);
    assert.ok(
      order.includes("thread/compact/start") && order.indexOf("thread/compact/start") < order.indexOf("turn/start"),
      `no compaction before the room turn: ${order.join(", ")}`,
    );
    const room = (await h.json(`/api/bloks/${blok.id}/messages?limit=100`)).messages as any[];
    assert.ok(room.some((m) => m.compaction && m.from === bot.id), "the room was not told where it happened");
  });

  test("a switch to another engine hands over a bounded story, not the whole transcript", async (t) => {
    const { home, h, log } = await codexHome({ instances: ["codex", "codex-b"] });
    t.after(async () => {
      await h.stop();
      rmSync(home, { recursive: true, force: true });
    });
    const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Rex" }) });
    await h.fetch(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" } }) });
    for (let i = 0; i < 4; i++) await turn(h, bot.id, `LOG-${i} ${"z".repeat(40_000)}`);

    await h.fetch(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "codex-b", model: "gpt-6.1-sol" } }) });
    const before = log().length;
    await turn(h, bot.id, "SWITCHED what now?");
    const started = log().slice(before).find((l) => l.method === "turn/start");
    const story = started.text.slice(started.text.indexOf("You are picking up this conversation"));
    assert.ok(story.startsWith("You are picking up this conversation mid-thread"), "the new engine was not told the story");
    assert.match(story, /SWITCHED what now\?$/);
    assert.match(story, /LOG-3/);
    assert.match(story, /earlier messages? (is|are) left out/);
    assert.ok(story.length <= HANDOFF_MAX_TOKENS * 4 + 2_000, `the story was ${story.length} characters`);
  });
});

/**
 * A stand-in for Claude Code that answers on the first stdin line. A turn
 * makes twenty-two tool calls on a 230k context (60k after a /compact),
 * and its result names a million-token window for the model.
 */
function fakeClaude(home: string): string {
  const cli = join(home, "fake-claude.mjs");
  writeFileSync(
    cli,
    `#!${process.execPath}
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("9.9.9 (Claude Code)"); process.exit(0); }
if (args[0] === "auth") { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
const out = (frame) => console.log(JSON.stringify(frame));
const small = ${JSON.stringify(join(home, "compacted"))};
let input = "";
process.stdin.on("data", (c) => (input += c));
((go) => { let line = ""; const take = (c) => { line += c; if (!line.includes(String.fromCharCode(10))) return; process.stdin.off("data", take); go(); }; process.stdin.on("data", take); })(() => {
  const said = JSON.parse(input.split("\\n")[0]).message.content;
  appendFileSync(${JSON.stringify(join(home, "runs.jsonl"))}, JSON.stringify({ said: said.slice(0, 200), args }) + "\\n");
  out({ type: "system", subtype: "init", session_id: "sess-223", model: "claude-sonnet-5" });
  const result = (extra) => out({ type: "result", subtype: "success", is_error: false, num_turns: 1, duration_api_ms: 500, total_cost_usd: 0.5, session_id: "sess-223", result: "", modelUsage: { "claude-sonnet-5": { contextWindow: 1000000 } }, ...extra });
  if (said === "/compact") {
    writeFileSync(small, "yes");
    out({ type: "system", subtype: "compact_boundary", session_id: "sess-223", compact_metadata: { trigger: "manual", pre_tokens: 252000, post_tokens: 50000 } });
    return result({ usage: { input_tokens: 3, cache_read_input_tokens: 252000, output_tokens: 9000 } });
  }
  const base = existsSync(small) ? 60000 : 230000;
  const usage = (i) => ({ input_tokens: 5, cache_read_input_tokens: base + i * 1000, cache_creation_input_tokens: 100, cache_creation: { ephemeral_1h_input_tokens: 100 }, output_tokens: 20 });
  for (let i = 0; i < 22; i++) {
    out({ type: "assistant", message: { content: [{ type: "tool_use", id: "t" + i, name: "Bash", input: { command: "ls" } }], usage: usage(i) } });
    out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t" + i, content: "ok" }] } });
  }
  out({ type: "assistant", message: { content: [{ type: "text", text: "Done: " + said.slice(0, 20) }], usage: usage(22) } });
  result({ result: "Done" });
});
`,
    { mode: 0o755 },
  );
  return cli;
}

describe("a Claude Code lane with a long context and many tool calls a turn", () => {
  test("reads Claude Code's own window, and sends /compact into the session before the next turn", async (t) => {
    const home = mkdtempSync(join(tmpdir(), "bloks-pressure-claude-"));
    mkdirSync(join(home, ".bloks"), { recursive: true });
    const cli = fakeClaude(home);
    writeFileSync(join(home, ".bloks", "config.json"), JSON.stringify({ instances: { claude: { driver: "claudeAgent", config: { cli } } } }));
    const h = await startHarness({ HOME: home });
    t.after(async () => {
      await h.stop();
      rmSync(home, { recursive: true, force: true });
    });
    const runs = () => lines(join(home, "runs.jsonl"));
    const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Keeper" }) });
    await h.fetch(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } }) });

    await turn(h, bot.id, "Look into the failing build.");
    const lane = (await botOf(h, bot.id)).tasks.find((l: any) => l.id === bot.threadId);
    // the last request's whole prompt, against the window the CLI named
    assert.equal(lane.context.used, 5 + 230_000 + 22 * 1_000 + 100);
    assert.equal(lane.context.limit, 1_000_000, "the table's 200k was used instead of Claude Code's window");
    assert.equal(lane.context.window, "engine");

    // over the 200k ceiling: /compact goes into the same session first
    await turn(h, bot.id, "Fix it.");
    const said = runs().map((r) => r.said);
    assert.equal(said[1], "/compact", `ran: ${said.join(" | ")}`);
    assert.ok(runs()[1].args.includes("--resume") && runs()[1].args.includes("sess-223"), "it did not compact the lane's own session");
    assert.ok(runs()[1].args.includes("--append-system-prompt-file"), "the compaction was not sent the turn's system prompt");
    assert.match(said[2], /Fix it\./);
    assert.ok(runs()[2].args.includes("--resume"), "the turn did not go into the compacted session");
    const messages = await messagesOf(h, bot.id);
    const marker = messages.find((m) => m.compaction);
    assert.equal(marker?.text, "Compacted · 252k → 50k");
    assert.equal(messages.some((m) => m.role === "user" && /compact/.test(m.text ?? "")), false, "/compact was posted as a message");

    // now small: the next turn goes straight in
    await turn(h, bot.id, "Thanks.");
    assert.equal(runs().filter((r) => r.said === "/compact").length, 1);
  });
});

/**
 * A stand-in for pi-acp: it can load a session, lists /compact among its
 * commands, reports how full the session is with `usage_update` and never
 * reports tokens, the way pi does. A turn makes twenty tool calls.
 */
function fakePi(home: string): string {
  const cli = join(home, "fake-pi-acp.cjs");
  writeFileSync(
    cli,
    `#!${process.execPath}
const fs = require("node:fs");
const HOME = ${JSON.stringify(home)};
const say = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
const update = (sessionId, u) => say({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: u } });
const small = HOME + "/pi-compacted";
let sessionId = null;
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined || !msg.method) return;
  const reply = (result) => say({ jsonrpc: "2.0", id: msg.id, result });
  if (msg.method === "initialize") return reply({ protocolVersion: 1, agentCapabilities: { loadSession: true } });
  if (msg.method === "session/new" || msg.method === "session/load") {
    sessionId = msg.method === "session/load" ? msg.params.sessionId : "pi-" + process.pid;
    reply(msg.method === "session/new" ? { sessionId } : {});
    return update(sessionId, { sessionUpdate: "available_commands_update", availableCommands: [{ name: "compact", description: "Compact the session" }, { name: "model" }] });
  }
  if (msg.method !== "session/prompt") return reply({});
  const text = msg.params.prompt.map((p) => p.text).join("");
  fs.appendFileSync(HOME + "/pi-log.jsonl", JSON.stringify({ session: msg.params.sessionId, text: text.slice(-80) }) + "\\n");
  if (text === "/compact") {
    fs.writeFileSync(small, "yes");
    update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Compacted." } });
    return reply({ stopReason: "end_turn" });
  }
  const base = fs.existsSync(small) ? 30000 : 150000;
  for (let i = 0; i < 20; i++) {
    update(sessionId, { sessionUpdate: "tool_call", toolCallId: "c" + i, title: "ls", kind: "execute", status: "pending" });
    update(sessionId, { sessionUpdate: "usage_update", used: base + i * 500, size: 200000 });
    update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "c" + i, status: "completed" });
  }
  update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done." } });
  return reply({ stopReason: "end_turn" });
});
`,
    { mode: 0o755 },
  );
  return cli;
}

describe("a Pi lane", () => {
  test("reads usage_update, compacts with its own /compact before the next turn, and says its tokens were not reported", async (t) => {
    const home = mkdtempSync(join(tmpdir(), "bloks-pressure-pi-"));
    mkdirSync(join(home, ".bloks"), { recursive: true });
    const cli = fakePi(home);
    writeFileSync(join(home, ".bloks", "config.json"), JSON.stringify({ instances: { pi: { driver: "pi", config: { cli } } } }));
    const h = await startHarness({ HOME: home });
    t.after(async () => {
      await h.stop();
      rmSync(home, { recursive: true, force: true });
    });
    const prompts = () => lines(join(home, "pi-log.jsonl"));
    const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Pip" }) });
    await h.fetch(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "pi", model: "auto" } }) });

    await turn(h, bot.id, "Sort the inbox.");
    const lane = (await botOf(h, bot.id)).tasks.find((l: any) => l.id === bot.threadId);
    assert.equal(lane.context.used, 150_000 + 19 * 500);
    assert.equal(lane.context.limit, 200_000);

    await turn(h, bot.id, "Archive the rest.");
    const asked = prompts().map((p) => p.text);
    assert.equal(asked[1], "/compact", `asked: ${asked.join(" | ")}`);
    assert.match(asked[2], /Archive the rest\.$/);
    assert.equal(prompts()[1].session, prompts()[2].session, "the words did not go into the compacted session");
    const messages = await messagesOf(h, bot.id);
    assert.ok(messages.some((m) => m.compaction), "no marker where it happened");
    assert.equal(messages.some((m) => m.kind === "text" && m.text === "Compacted."), false, "what /compact said was taken for the reply");

    // pi reports no tokens: Activity says so instead of a zero
    const activity = await h.json("/api/activity");
    const row = activity.agents.find((a: any) => a.botId === bot.id);
    assert.equal(row.today.input + row.today.output, 0);
    assert.ok(row.today.unmeasured >= 2, "turns with no tokens reported read as free");
  });
});
