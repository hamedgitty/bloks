// Compactions in the chat, and compacting a quiet Claude Code conversation
// before its cache expires (GitHub 162).
//
// Claude Code reports its own compactions with a compact_boundary frame,
// which now leaves a line where it happened. With the setting on, a lane
// over 100k tokens that has been quiet for 55 minutes of an hour's cache
// gets /compact sent into its session, quietly: no message in the
// person's name, no unread dot, and anything said meanwhile waits.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { compactedNotice, idleCompactionDue, shortTokens, type IdleLane } from "../server/context.ts";
import { cacheTtlOf, promptSize, readCompactBoundary } from "../server/drivers/claude.ts";
import { startHarness, type Harness } from "./helpers/server.ts";

const HOUR = 60 * 60_000;
const MIN = 60_000;

const quiet = (over: Partial<IdleLane> = {}): IdleLane => ({
  enabled: true,
  now: 10 * HOUR,
  lastRequestAt: 10 * HOUR - 56 * MIN,
  context: 176_000,
  cacheTtl: "1h",
  busy: false,
  queued: false,
  waiting: false,
  paused: false,
  ...over,
});

test("a quiet lane is compacted in the few minutes before its cache expires, and not otherwise", () => {
  assert.equal(idleCompactionDue(quiet()), true);
  assert.equal(idleCompactionDue(quiet({ enabled: false })), false, "the setting is off");
  assert.equal(idleCompactionDue(quiet({ lastRequestAt: 10 * HOUR - 54 * MIN })), false, "too early");
  assert.equal(idleCompactionDue(quiet({ lastRequestAt: 10 * HOUR - 55 * MIN })), true, "the window opens at 55 minutes");
  assert.equal(idleCompactionDue(quiet({ lastRequestAt: 10 * HOUR - 58 * MIN })), false, "too late to start before the cache expires");
  assert.equal(idleCompactionDue(quiet({ lastRequestAt: 10 * HOUR - 3 * HOUR })), false, "a computer that slept through the window does not catch up");
  assert.equal(idleCompactionDue(quiet({ lastRequestAt: null })), false, "nothing known since a restart");
  assert.equal(idleCompactionDue(quiet({ context: 99_000 })), false, "small enough to write again");
  assert.equal(idleCompactionDue(quiet({ context: 100_000 })), true);
  assert.equal(idleCompactionDue(quiet({ cacheTtl: "5m" })), false, "a five-minute cache is not worth chasing");
  assert.equal(idleCompactionDue(quiet({ cacheTtl: undefined })), false, "no cache lifetime seen");
  assert.equal(idleCompactionDue(quiet({ busy: true })), false, "a turn is running");
  assert.equal(idleCompactionDue(quiet({ queued: true })), false, "messages are waiting");
  assert.equal(idleCompactionDue(quiet({ waiting: true })), false, "a card is open");
  assert.equal(idleCompactionDue(quiet({ paused: true })), false, "archived or held");
  // the window scales with the lifetime, which is how the test below runs fast
  assert.equal(idleCompactionDue(quiet({ lifetime: 6_000, now: 100_000, lastRequestAt: 100_000 - 5_600 })), true);
});

test("a compact_boundary frame becomes a short line with what the engine reported", () => {
  const frame = {
    type: "system",
    subtype: "compact_boundary",
    session_id: "s",
    compact_metadata: { trigger: "auto", pre_tokens: 320_412, post_tokens: 49_870, duration_ms: 61_000 },
  };
  const read = readCompactBoundary(frame);
  assert.deepEqual(read, { trigger: "auto", before: 320_412, after: 49_870 });
  assert.equal(compactedNotice(read!), "Compacted · 320k → 50k");
  assert.equal(compactedNotice({ ...read!, idle: true }), "Compacted while idle · 320k → 50k");
  // what the engine did not say is left out, not guessed
  const older = readCompactBoundary({ type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "manual", pre_tokens: 176_000 } });
  assert.deepEqual(older, { trigger: "manual", before: 176_000, after: null });
  assert.equal(compactedNotice(older!), "Compacted · from 176k");
  assert.equal(compactedNotice({ before: null, after: null }), "Compacted");
  assert.equal(readCompactBoundary({ type: "system", subtype: "init" }), null);
  assert.equal(readCompactBoundary({ type: "system", subtype: "compact_boundary", compact_metadata: { pre_tokens: "lots" } })?.before, null);
  assert.equal(shortTokens(1_250_000), "1.3M");
  assert.equal(shortTokens(1_000_000), "1M");
  assert.equal(shortTokens(640), "640");
});

test("a request's whole prompt, and the cache lifetime it wrote with", () => {
  const usage = {
    input_tokens: 12,
    cache_read_input_tokens: 150_000,
    cache_creation_input_tokens: 2_000,
    cache_creation: { ephemeral_1h_input_tokens: 2_000, ephemeral_5m_input_tokens: 0 },
  };
  assert.equal(promptSize(usage), 152_012);
  assert.equal(cacheTtlOf(usage), "1h");
  assert.equal(cacheTtlOf({ cache_creation: { ephemeral_5m_input_tokens: 40 } }), "5m");
  assert.equal(cacheTtlOf({ cache_read_input_tokens: 9 }), undefined, "nothing written says nothing");
});

const waitFor = async <T,>(check: () => Promise<T | null | undefined> | T | null | undefined, ms = 30_000): Promise<T | null> => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const value = await check();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
};

/** A home with idle compaction on and the fake Claude Code below, whose
 * /compact takes `compactMs`. */
function fakeClaudeHome(compactMs = 1500): string {
  const home = mkdtempSync(join(tmpdir(), "bloks-idle-compact-"));
  mkdirSync(join(home, ".bloks"), { recursive: true });
  writeFileSync(
    join(home, ".bloks", "config.json"),
    JSON.stringify({
      instances: { claude: { driver: "claudeAgent", config: { cli: join(home, "fake-claude.mjs") } } },
      compaction: { idle: true },
    }),
  );
  // Answers a turn with a big, freshly cached prompt; answers /compact
  // with a compact_boundary and no assistant text, slowly enough that a
  // message can arrive while it runs. Every run is written down.
  writeFileSync(
    join(home, "fake-claude.mjs"),
    `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("9.9.9 (Claude Code)"); process.exit(0); }
if (args[0] === "auth") { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
const out = (frame) => console.log(JSON.stringify(frame));
let input = "";
process.stdin.on("data", (c) => (input += c));
((go) => { let line = ""; const take = (c) => { line += c; while (line.includes(String.fromCharCode(10))) { const at = line.indexOf(String.fromCharCode(10)); const next = line.slice(0, at); line = line.slice(at + 1); if (!next.trim() || JSON.parse(next).type !== "user") continue; if (typeof input !== "undefined") input = next; process.stdin.off("data", take); go(); return; } }; process.stdin.on("data", take); })(async () => {
  const said = JSON.parse(input.split("\\n")[0]).message.content;
  const file = ${JSON.stringify(join(home, "total.txt"))};
  const total = (existsSync(file) ? Number(readFileSync(file, "utf8")) : 0) + 1;
  writeFileSync(file, String(total));
  appendFileSync(${JSON.stringify(join(home, "runs.jsonl"))}, JSON.stringify({ said, args }) + "\\n");
  out({ type: "system", subtype: "init", session_id: "sess-162", model: "claude-sonnet-5" });
  if (said === "/compact") {
    await new Promise((r) => setTimeout(r, ${compactMs}));
    out({ type: "system", subtype: "compact_boundary", session_id: "sess-162", compact_metadata: { trigger: "manual", pre_tokens: 176000, post_tokens: 50000 } });
    out({ type: "result", subtype: "success", is_error: false, num_turns: 1, duration_api_ms: 1400, total_cost_usd: total, session_id: "sess-162", result: "", usage: { input_tokens: 3, cache_read_input_tokens: 176000, output_tokens: 9000 } });
    return;
  }
  // Claude Code compacting on its own, partway through a turn
  if (said === "start") out({ type: "system", subtype: "compact_boundary", session_id: "sess-162", compact_metadata: { trigger: "auto", pre_tokens: 320000, post_tokens: 48000 } });
  out({ type: "assistant", message: { content: [{ type: "text", text: "Reply " + total }], usage: { input_tokens: 10, cache_read_input_tokens: 174000, cache_creation_input_tokens: 2000, cache_creation: { ephemeral_1h_input_tokens: 2000 }, output_tokens: 40 } } });
  out({ type: "result", subtype: "success", is_error: false, num_turns: 1, duration_api_ms: 500, total_cost_usd: total, session_id: "sess-162", result: "Reply " + total });
});
`,
    { mode: 0o755 },
  );
  return home;
}

test("a quiet Claude Code lane is compacted without a word in the person's name, and what is said meanwhile waits", async (t) => {
  const home = fakeClaudeHome();
  // an hour is eight seconds here: the window is about 7.3s to 7.7s
  const h = await startHarness({ HOME: home, BLOKS_IDLE_CACHE_MS: "8000" });
  t.after(async () => {
    await h.stop();
    rmSync(home, { recursive: true, force: true });
  });
  const runs = () =>
    existsSync(join(home, "runs.jsonl"))
      ? readFileSync(join(home, "runs.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line))
      : [];
  const messages = async (id: string) => (await h.json(`/api/bots/${id}/messages?limit=100`)).messages as any[];
  const agent = async (id: string) => (await h.json("/api/bots?messages=0")).bots.find((b: any) => b.id === id);

  const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Keeper" }) });
  await h.fetch(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } }) });
  await h.fetch(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: "start" }) });
  assert.ok(await waitFor(async () => (await messages(bot.id)).some((m) => m.text === "Reply 1") && !(await agent(bot.id)).busy), "the first turn never answered");
  const own = (await messages(bot.id)).find((m) => m.compaction);
  assert.equal(own?.text, "Compacted · 320k → 48k", "Claude Code's own compaction left no line");
  assert.equal(own.kind, "notice");
  // read, so a dot afterwards could only have come from the compaction
  await h.fetch(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ unread: false }) });
  const spentBefore = (await h.json("/api/usage?days=1")).total.cost;

  const compacted = await waitFor(async () => {
    const marker = (await messages(bot.id)).find((m) => m.compaction?.idle);
    return marker && !(await agent(bot.id)).busy ? marker : null;
  });
  assert.ok(compacted, "the quiet lane was never compacted");
  assert.equal(compacted.text, "Compacted while idle · 176k → 50k");
  assert.equal(compacted.compaction.idle, true);
  const compaction = runs().find((r) => r.said === "/compact");
  assert.ok(compaction.args.includes("--resume") && compaction.args.includes("sess-162"), "it did not resume the lane's own session");
  assert.ok(compaction.args.includes("--append-system-prompt-file"), "it was not sent the system prompt the cache was written with");
  assert.equal((await messages(bot.id)).some((m) => m.role === "user" && /compact/.test(m.text ?? "")), false, "/compact was posted as a message");
  const after = await agent(bot.id);
  assert.equal(after.unread, false, "a compaction marked the agent unread");
  assert.equal(after.tasks.find((l: any) => l.id === bot.threadId)?.context?.used, 50_000, "the lane still reads as full");
  assert.ok((await h.json("/api/usage?days=1")).total.cost > spentBefore, "what the compaction spent was not counted");

  // Talked to again, and quiet again: the second compaction holds what is
  // said during it, which then goes as an ordinary turn.
  await h.fetch(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: "again" }) });
  assert.ok(await waitFor(async () => !(await agent(bot.id)).busy && runs().length === 3), "the second turn never ran");
  assert.ok(await waitFor(async () => (runs().at(-1)?.said === "/compact" ? true : null)), "it was not compacted a second time");
  const reply = await h.fetch(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: "while you were compacting" }) });
  assert.equal(reply.status, 202, "a message during the compaction did not wait in the queue");
  assert.ok(
    await waitFor(async () => runs().some((r) => typeof r.said === "string" && r.said.includes("while you were compacting"))),
    "the waiting message never went",
  );
  assert.equal(runs().filter((r) => r.said === "/compact").length, 2);
});

test("an idle compaction cut off by a restart is dropped, not picked up", async (t) => {
  // long enough to still be running when the server goes
  const home = fakeClaudeHome(20_000);
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const runs = () =>
    existsSync(join(home, "runs.jsonl"))
      ? readFileSync(join(home, "runs.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line))
      : [];
  const inFlight = () => {
    try {
      return JSON.parse(readFileSync(join(home, ".bloks", "turns-in-flight.json"), "utf8")) as any[];
    } catch {
      return [];
    }
  };
  const messages = async (h: Harness, id: string) => (await h.json(`/api/bots/${id}/messages?limit=100`)).messages as any[];

  const first = await startHarness({ HOME: home, BLOKS_IDLE_CACHE_MS: "8000" });
  const { bot } = await first.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Keeper" }) });
  await first.fetch(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } }) });
  await first.fetch(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: "start" }) });
  assert.ok(await waitFor(async () => (await messages(first, bot.id)).some((m) => m.text === "Reply 1")), "the first turn never answered");
  assert.ok(await waitFor(() => (runs().at(-1)?.said === "/compact" ? true : null)), "the quiet lane was never compacted");
  // Nobody asked for it, so it is not a turn that can be cut off: picking
  // it up would tell the person their agent was interrupted, and tell the
  // agent to carry on with work it never chose to do.
  assert.deepEqual(inFlight(), [], "the compaction was written down as a turn in flight");
  await first.crash();

  const second = await startHarness({ HOME: home, BLOKS_IDLE_CACHE_MS: "8000" });
  t.after(() => second.stop());
  const ran = runs().length;
  await new Promise((r) => setTimeout(r, 2_000));
  assert.equal(runs().length, ran, "something ran in the lane after the restart");
  const after = await messages(second, bot.id);
  assert.equal(after.filter((m) => m.kind === "notice" && /cut off/.test(m.text ?? "")).length, 0, "the person was told of a cut-off");
  const agent = (await second.json("/api/bots?messages=0")).bots.find((b: any) => b.id === bot.id);
  assert.equal(agent.busy, false, "the lane came back busy");
});
