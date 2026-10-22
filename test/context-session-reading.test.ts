import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { startHarness } from "./helpers/server.ts";
import { idle, waitFor } from "./helpers/turns.ts";

type Scene = { replace?: boolean; opening?: Array<[number | null, number | null]>; used?: number; compact?: boolean; pause?: boolean };

// A custom instance name proves selection follows driver kind, not its id.
// All native traffic is a local fake; the actual server/store/SSE paths run.
async function fixture(t: TestContext, beforeTurn = 0) {
  const home = mkdtempSync(join(tmpdir(), "bloks-session-reading-"));
  const scene = join(home, "scene.json");
  const ready = join(home, "ready");
  const release = join(home, "release");
  const calls = join(home, "calls.jsonl");
  const cli = join(home, "fake-codex.mjs");
  writeFileSync(scene, "{}");
  writeFileSync(calls, "");
  writeFileSync(cli, String.raw`#!${process.execPath}
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("codex-cli 9.9.9"); process.exit(0); }
if (args[0] === "login") { console.log("Logged in using ChatGPT"); process.exit(0); }
const out = (m) => JSON.stringify(m) + "\n";
const send = (m) => process.stdout.write(out(m));
const plan = () => JSON.parse(readFileSync(${JSON.stringify(scene)}, "utf8"));
let thread = "original-parent";
const reading = (used, window) => ({ method: "thread/tokenUsage/updated", params: { threadId: thread, tokenUsage: {
  last: { inputTokens: used, outputTokens: 1 }, modelContextWindow: window,
} } });
const compact = () => {
  send({ method: "item/started", params: { threadId: thread, turnId: "work", item: { type: "contextCompaction", id: "boundary" } } });
  send({ method: "item/completed", params: { threadId: thread, turnId: "work", item: { type: "contextCompaction", id: "boundary" } } });
};
createInterface({ input: process.stdin }).on("line", line => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ method: m.method }) + "\n");
  if (m.method === "model/list") return send({ id: m.id, result: { data: [{ id: "gpt-6.1-sol", model: "gpt-6.1-sol", displayName: "GPT-6.1-Sol", isDefault: true }] } });
  const p = plan();
  if (m.method === "thread/resume" && p.replace) return send({ id: m.id, error: { code: -1, message: "not found" } });
  if (m.method === "thread/start" || m.method === "thread/resume") {
    thread = p.replace ? "replacement-parent" : (m.params.threadId ?? "original-parent");
    const reply = { id: m.id, result: { thread: { id: thread }, model: "gpt-6.1-sol" } };
    return process.stdout.write([reply, ...(p.opening ?? []).map(([used, window]) => reading(used, window))].map(out).join(""));
  }
  if (m.method === "thread/compact/start") {
    send({ id: m.id, result: {} });
    send({ method: "turn/started", params: { threadId: thread, turn: { id: "compact", status: "inProgress" } } });
    return send({ method: "turn/completed", params: { threadId: thread, turn: { id: "compact", status: "completed" } } });
  }
  if (m.method !== "turn/start") return send({ id: m.id, result: {} });
  send({ id: m.id, result: { turn: { id: "work", status: "inProgress" } } });
  send({ method: "turn/started", params: { threadId: thread, turn: { id: "work", status: "inProgress" } } });
  const finish = () => {
    if (p.compact) compact();
    if (p.used !== undefined) send(reading(p.used, 1000));
    send({ method: "item/completed", params: { threadId: thread, item: { type: "agentMessage", id: "answer", text: "Done." } } });
    send({ method: "turn/completed", params: { threadId: thread, turn: { id: "work", status: "completed" } } });
  };
  if (!p.pause) return finish();
  writeFileSync(${JSON.stringify(ready)}, thread);
  const timer = setInterval(() => { if (existsSync(${JSON.stringify(release)})) { clearInterval(timer); finish(); } }, 10);
});
`, { mode: 0o755 });
  mkdirSync(join(home, ".bloks"));
  writeFileSync(join(home, ".bloks", "config.json"), JSON.stringify({
    compaction: { idle: false, beforeTurn },
    instances: { "native-reader": { driver: "codex", config: { cli } } },
  }));
  let h = await startHarness({ HOME: home });
  const abort = new AbortController();
  const frames: any[] = [];
  let stream: Promise<void> | undefined;
  t.after(async () => {
    abort.abort();
    await stream?.catch(() => {});
    await h.stop();
    rmSync(home, { recursive: true, force: true });
  });
  const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Session fixture" }) });
  assert.ok((await h.fetch(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "native-reader", model: "gpt-6.1-sol" } }) })).ok);
  const botOf = async () => (await h.json("/api/bots?messages=0")).bots.find((b: any) => b.id === bot.id);
  const laneOf = async () => (await botOf()).tasks.find((l: any) => l.id === bot.threadId);
  const messages = async () => (await h.json(`/api/bots/${bot.id}/messages?limit=200`)).messages as any[];
  const savedLane = () => {
    const all = JSON.parse(readFileSync(join(home, ".bloks", "bots.json"), "utf8"));
    return all.find((b: any) => b.id === bot.id).tasks.find((l: any) => l.id === bot.threadId);
  };
  return {
    bot, frames, laneOf, messages, savedLane,
    methods: () => readFileSync(calls, "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l).method),
    async listen() {
      const response = await h.fetch("/api/events", { signal: abort.signal });
      assert.equal(response.status, 200);
      const reader = response.body!.getReader();
      stream = (async () => {
        let buffer = "";
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) return;
            buffer += new TextDecoder().decode(value);
            let split: number;
            while ((split = buffer.indexOf("\n\n")) !== -1) {
              const frame = buffer.slice(0, split);
              buffer = buffer.slice(split + 2);
              if (frame.startsWith("data: ")) frames.push(JSON.parse(frame.slice(6)));
            }
          }
        } catch (error) { if (!abort.signal.aborted) throw error; }
      })();
      assert.ok(await waitFor(() => frames.some(f => f.kind === "hello")));
      frames.splice(0);
    },
    async turn(p: Scene) {
      writeFileSync(scene, JSON.stringify(p));
      rmSync(ready, { force: true });
      rmSync(release, { force: true });
      const count = (await messages()).filter(m => m.kind === "text" && m.role === "bot").length;
      assert.ok((await h.fetch(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: "Check the document." }) })).ok);
      if (p.pause) {
        assert.ok(await waitFor(() => existsSync(ready)), h.logs());
        return;
      }
      assert.ok(await waitFor(async () => (await messages()).filter(m => m.kind === "text" && m.role === "bot").length > count), h.logs());
      assert.ok(await idle(h, bot), h.logs());
    },
    async finish() {
      writeFileSync(release, "yes");
      assert.ok(await idle(h, bot), h.logs());
    },
    async reload() {
      abort.abort();
      await stream?.catch(() => {});
      await h.stop();
      h = await startHarness({ HOME: home });
      return laneOf();
    },
  };
}

test("a paused replacement clears saved/API fill and publishes the unknown client fill before any new reading", async t => {
  const f = await fixture(t);
  await f.turn({ used: 600 });
  assert.equal((await f.laneOf()).context.used, 600);
  await f.listen();
  await f.turn({ replace: true, pause: true, compact: true });
  assert.equal((await f.laneOf()).context.measured, false);
  assert.equal(f.savedLane().reading, undefined);
  const update = await waitFor(() => f.frames.find(frame => frame.kind === "bot" && frame.bot.id === f.bot.id &&
    frame.bot.tasks.find((l: any) => l.id === f.bot.threadId)?.context.measured === false));
  assert.ok(update, "no client bot update while the replacement is held before a reading");
  await f.finish();
  assert.deepEqual((await f.messages()).find(m => m.compaction)?.compaction, { before: null, after: null });
  assert.equal((await f.reload()).context.measured, false);
});

test("same-parent recovery retains before and the first request after compaction", async t => {
  const f = await fixture(t);
  await f.turn({ used: 600 });
  await f.turn({ pause: true, compact: true, used: 120 });
  assert.equal((await f.laneOf()).context.used, 600);
  await f.finish();
  assert.deepEqual((await f.messages()).find(m => m.compaction)?.compaction, { before: 600, after: 120 });
  assert.equal((await f.reload()).context.used, 120);
});

for (const replace of [false, true]) test(`coalesced partial readings retain fresh fields and pending-marker session identity (replacement=${replace})`, async t => {
  const f = await fixture(t);
  await f.turn({ used: 600 });
  await f.turn({ compact: true });
  const before = (await f.messages()).find(m => m.compaction);
  assert.deepEqual(before.compaction, { before: 600, after: null });
  await f.turn({ replace, opening: [[null, 1500], [120, null], [180, 2000], [220, null]], pause: true });
  assert.equal((await f.laneOf()).context.used, 220);
  assert.equal((await f.laneOf()).context.limit, 2000);
  assert.deepEqual((await f.messages()).find(m => m.id === before.id).compaction, { before: 600, after: replace ? null : 120 });
  await f.finish();
  assert.equal((await f.reload()).context.used, 220);
});

test("the pre-turn consumer retains a custom Codex instance's same-session before and first-after", async t => {
  const f = await fixture(t, 500);
  await f.turn({ used: 600 });
  await f.turn({ used: 120 });
  assert.ok(f.methods().includes("thread/compact/start"));
  assert.deepEqual((await f.messages()).find(m => m.compaction)?.compaction, { before: 600, after: 120 });
});


test("a non-Codex opening usage update retains its reading across the later session cursor", async t => {
  const home = mkdtempSync(join(tmpdir(), "bloks-opening-reading-"));
  const cli = join(home, "fake-pi.cjs");
  writeFileSync(cli, String.raw`#!${process.execPath}
const { createInterface } = require("node:readline");
const send = m => process.stdout.write(JSON.stringify(m) + "\n");
createInterface({ input: process.stdin }).on("line", line => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  const reply = result => send({ jsonrpc: "2.0", id: m.id, result });
  if (m.method === "initialize") return reply({ protocolVersion: 1, agentCapabilities: { loadSession: true } });
  if (m.method === "session/new" || m.method === "session/load") {
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "opening-session", update: { sessionUpdate: "usage_update", used: 600, size: 1000 } } });
    return reply(m.method === "session/new" ? { sessionId: "opening-session" } : {});
  }
  if (m.method === "session/prompt") {
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "opening-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done." } } } });
    return reply({ stopReason: "end_turn" });
  }
  reply({});
});
`, { mode: 0o755 });
  mkdirSync(join(home, ".bloks"));
  writeFileSync(join(home, ".bloks", "config.json"), JSON.stringify({
    compaction: { idle: false, beforeTurn: 0 }, instances: { "opening-reader": { driver: "pi", config: { cli } } },
  }));
  const h = await startHarness({ HOME: home });
  t.after(async () => { await h.stop(); rmSync(home, { recursive: true, force: true }); });
  const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Opening fixture" }) });
  assert.ok((await h.fetch(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "opening-reader", model: "auto" } }) })).ok);
  assert.ok((await h.fetch(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: "Check the document." }) })).ok);
  const lane = await waitFor(async () => {
    const { bots } = await h.json("/api/bots?messages=0");
    return bots.find((b: any) => b.id === bot.id)?.tasks.find((l: any) => l.id === bot.threadId && l.context?.used === 600);
  });
  assert.ok(lane, h.logs());
  assert.equal(lane.context.limit, 1000);
  assert.ok(await idle(h, bot), h.logs());
});
