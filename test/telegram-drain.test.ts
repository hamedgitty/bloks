// A Telegram request held by drain returns to its own chat after restart.
// Every server, engine and Telegram account here is an isolated fixture.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { startHarness } from "./helpers/server.ts";
import { agentOn, idle, messagesOf, PICKUP, waitFor } from "./helpers/turns.ts";
import { TelegramReturns } from "../server/telegram-returns.ts";
import type { Message, Store } from "../server/store.ts";

const CHAT = 10101;
const OTHER_CHAT = 20202;
// A URL, not a path: NODE_OPTIONS splits on spaces, and a checkout under
// a folder with a space in its name would hand node half a path.
const preload = new URL("./helpers/telegram-fetch.mjs", import.meta.url).href;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const saved = (text: string) => text.startsWith("Your message is saved.");

async function telegramStub(t: TestContext) {
  const state = {
    updates: [] as any[],
    next: 1,
    sends: [] as { chat_id: number; text: string }[],
    accepted: [] as { chat_id: number; text: string }[],
    failPart: 0,
    failure: "refused" as "refused" | "dropped",
    answerParts: 0,
    held: false,
    release: [] as (() => void)[],
  };
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => raw += chunk);
    req.on("end", () => {
      const body = JSON.parse(raw || "{}");
      res.setHeader("content-type", "application/json");
      const reply = (result: unknown) => res.end(JSON.stringify({ ok: true, result }));
      if (req.url?.endsWith("/getMe")) return reply({ username: "offline_test_bot" });
      if (req.url?.endsWith("/getUpdates")) return void setTimeout(() =>
        reply(state.updates.filter((u) => u.update_id >= body.offset)), 50);
      if (req.url?.endsWith("/sendMessage")) {
        state.sends.push(body);
        const answer = !saved(body.text) && !body.text.startsWith("Paired.");
        if (answer && ++state.answerParts === state.failPart) {
          if (state.failure === "dropped") return res.destroy();
          res.statusCode = 403;
          return res.end(JSON.stringify({ ok: false }));
        }
        const finish = () => { state.accepted.push(body); reply({ message_id: state.accepted.length }); };
        if (answer && state.held) return void state.release.push(finish);
        return finish();
      }
      reply(true);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { state.release.forEach((f) => f()); server.closeAllConnections(); server.close(); });
  return {
    state,
    url: `http://127.0.0.1:${(server.address() as any).port}`,
    push(text: string, chatId = CHAT) {
      state.updates.push({ update_id: state.next++, message: { chat: { id: chatId }, from: { first_name: "Test" }, text } });
    },
    answers: () => state.accepted.filter((m) => !saved(m.text) && !m.text.startsWith("Paired.")),
  };
}

async function provider(t: TestContext) {
  const state = { calls: [] as string[], held: [] as ((text: string, error?: number) => void)[], immediate: false, text: "ANSWER" };
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => raw += chunk);
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url?.endsWith("/models")) return res.end(JSON.stringify({ data: [{ id: "grok-4" }] }));
      state.calls.push(raw);
      const finish = (text: string, error = 0) => {
        if (error) { res.statusCode = error; return res.end(JSON.stringify({ error: { message: error === 429 ? "quota exceeded" : "synthetic failure" } })); }
        res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: text } }] }));
      };
      if (state.immediate) finish(state.text);
      else state.held.push(finish);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { state.held.forEach((f) => f("cleanup")); server.closeAllConnections(); server.close(); });
  return { state, port: (server.address() as any).port as number };
}

async function fixture(t: TestContext, nativeScript?: string) {
  const dataRoot = mkdtempSync(join(tmpdir(), "bloks-telegram-drain-"));
  const tg = await telegramStub(t);
  const engine = await provider(t);
  if (nativeScript) {
    mkdirSync(join(dataRoot, ".bloks"), { recursive: true });
    writeFileSync(join(dataRoot, ".bloks", "config.json"), JSON.stringify({
      instances: { claude: { driver: "claudeAgent", config: { cli: join(dataRoot, "fake-claude.mjs") } } },
    }));
    writeFileSync(join(dataRoot, "fake-claude.mjs"), `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
if (process.argv[2] === "--version") { console.log("9.9.9 (Claude Code)"); process.exit(0); }
if (process.argv[2] === "auth") { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
const root = ${JSON.stringify(dataRoot)};
const n = (existsSync(root + "/spawns") ? Number(readFileSync(root + "/spawns", "utf8")) : 0) + 1;
writeFileSync(root + "/spawns", String(n));
const out = (frame) => console.log(JSON.stringify(frame));
const say = (text) => out({ type: "assistant", message: { content: [{ type: "text", text }] } });
const nap = (ms) => new Promise((r) => setTimeout(r, ms));
let lines = [], buf = "";
process.stdin.on("data", (c) => {
  buf += c;
  for (let i = buf.indexOf("\\n"); i >= 0; i = buf.indexOf("\\n")) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const frame = JSON.parse(line);
    if (frame.type !== "user") continue;
    const text = String(frame.message?.content ?? "");
    appendFileSync(root + "/heard-" + n, text + "\\n"); lines.push(text);
  }
});
const next = async () => { while (!lines.length) await nap(20); return lines.shift(); };
const prompt = await next();
out({ type: "system", subtype: "init", session_id: "test-session", model: "claude-sonnet-5" });
${nativeScript}
out({ type: "result", subtype: "success", is_error: false, num_turns: 1, duration_api_ms: 100, total_cost_usd: 0, session_id: "test-session", result: "Done" });
setTimeout(() => process.exit(0), 50);
`, { mode: 0o755 });
  }
  const env = {
    HOME: dataRoot, NODE_OPTIONS: `--import=${preload}`, BLOKS_TEST_TELEGRAM_URL: tg.url,
    OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "", ELEVENLABS_API_KEY: "",
  };
  let h = await startHarness(env);
  const bot = await agentOn(h, engine.port, "Answerer");
  if (nativeScript) await h.fetch(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({
    modelSelection: { instanceId: "claude", model: "claude-sonnet-5" },
  }) });
  const paired = await h.json("/api/telegram", { method: "POST", body: JSON.stringify({
    token: "12345:TEST_ONLY_TOKEN", enabled: true, botId: bot.id, pair: true,
  }) });
  assert.ok(paired.pairing, JSON.stringify(paired));
  tg.push(paired.pairing);
  assert.ok(await waitFor(() => tg.state.accepted.some((m) => m.text.startsWith("Paired."))), "stub chat never paired");
  t.after(async () => { await h.crash(); rmSync(dataRoot, { recursive: true, force: true }); });
  return {
    dataRoot, tg, engine, bot, env,
    get h() { return h; },
    async reboot() { await h.crash(); h = await startHarness(env); return h; },
    async queue(text = "DRAIN_REQUEST") {
      await h.json("/api/maintenance/drain", { method: "POST", body: JSON.stringify({ seconds: 60 }) });
      tg.push(text);
      const message = await waitFor(async () => (await messagesOf(h, bot)).find((m) => m.role === "user" && m.text === text));
      assert.ok(message, "drain intake did not save the message");
      assert.ok(await waitFor(() => tg.state.accepted.some((m) => saved(m.text))), "no saved notice");
      return message;
    },
  };
}

test("drain intake keeps its chat and task through restart, returns once, and never subscribes to later turns", async (t) => {
  const f = await fixture(t);
  const request = await f.queue();
  assert.equal(request.telegramReply.chatId, CHAT);
  assert.equal(request.queued, true);
  assert.equal(f.engine.state.calls.length, 0);
  const { bot } = await f.h.json(`/api/bots/${f.bot.id}/tasks`, { method: "POST", body: JSON.stringify({ title: "Elsewhere" }) });
  assert.notEqual(bot.activeTaskId, f.bot.threadId);
  f.engine.state.immediate = true;
  await f.reboot();
  assert.ok(await waitFor(() => f.tg.answers().length === 1), "no return after restart");
  assert.deepEqual(f.tg.answers().map(({ chat_id, text }) => ({ chat_id, text })), [{ chat_id: CHAT, text: "ANSWER" }]);
  assert.equal((await messagesOf(f.h, f.bot)).find((m) => m.id === request.id).telegramReply.state, "sent");
  await f.reboot();
  await f.h.json(`/api/bots/${f.bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: "UNRELATED", taskId: f.bot.threadId }) });
  assert.ok(await idle(f.h, f.bot));
  await sleep(250);
  assert.equal(f.tg.answers().length, 1);
});

test("drain-held words and compact recover as separate turns and return each answer once", async (t) => {
  const f = await fixture(t, `say(prompt.startsWith("/compact") ? "COMPACT_ANSWER" : "WORDS_ANSWER");`);
  const words = await f.queue("ORDINARY_DRAIN_WORDS");
  const command = await f.queue("/compact ORIGINAL_ARG");
  await f.reboot();
  assert.ok(await waitFor(() => f.tg.answers().length === 2));
  assert.deepEqual(f.tg.answers().map((m) => [m.chat_id, m.text]), [[CHAT, "WORDS_ANSWER"], [CHAT, "COMPACT_ANSWER"]]);
  assert.equal(readFileSync(join(f.dataRoot, "heard-1"), "utf8").trim(), "ORDINARY_DRAIN_WORDS");
  assert.equal(readFileSync(join(f.dataRoot, "heard-2"), "utf8").trim(), "/compact ORIGINAL_ARG");
  const after = await messagesOf(f.h, f.bot);
  assert.equal(after.find((m) => m.id === words.id).telegramReply.state, "sent");
  assert.equal(after.find((m) => m.id === command.id).telegramReply.state, "sent");
  await f.reboot();await sleep(250);
  assert.equal(f.tg.answers().length, 2);
});

test("a cut-off pickup binds only ordinary drain messages and leaves compact for its own return", async (t) => {
  const f = await fixture(t, `
if(n===1){say("ORIGINAL_WORKING");await nap(15000);}
else say(prompt.startsWith("/compact") ? "COMPACT_ANSWER" : "PICKUP_ANSWER");
`);
  await f.h.json(`/api/bots/${f.bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: "OLD_WORK" }) });
  assert.ok(await waitFor(() => (awaitCount() >= 1)));
  function awaitCount(){try{return Number(readFileSync(join(f.dataRoot,"spawns"),"utf8"));}catch{return 0;}}
  const words = await f.queue("NEW_DRAIN_WORDS");
  const command = await f.queue("/compact ORIGINAL_ARG");
  await f.reboot();
  assert.ok(await waitFor(() => f.tg.answers().length === 2));
  const pickup = readFileSync(join(f.dataRoot, "heard-2"), "utf8");
  assert.match(pickup, /NEW_DRAIN_WORDS/);assert.doesNotMatch(pickup, /\/compact/);
  assert.equal(readFileSync(join(f.dataRoot, "heard-3"), "utf8").trim(), "/compact ORIGINAL_ARG");
  assert.deepEqual(f.tg.answers().map((m) => [m.chat_id, m.text]), [[CHAT, "PICKUP_ANSWER"], [CHAT, "COMPACT_ANSWER"]]);
  const after = await messagesOf(f.h, f.bot);
  assert.equal(after.find((m) => m.id === words.id).telegramReply.state, "sent");
  assert.equal(after.find((m) => m.id === command.id).telegramReply.state, "sent");
});

test("two restarts before queue recovery leave one request and one return", async (t) => {
  const f = await fixture(t);
  const request = await f.queue();
  await f.h.crash();
  for (let n = 0; n < 2; n++) {
    const child = spawn(process.execPath, ["server/index.ts"], { cwd: process.cwd(), env: {
      ...process.env, ...f.env, PATH: "/nonexistent", BLOKS_PORT: String(40000 + Math.floor(Math.random() * 15000)),
      BLOKS_TEST_STOP_BEFORE_RECOVERY: "1", XAI_API_KEY: "", GEMINI_API_KEY: "", COMPOSIO_KEY: "", BOX_TOKEN: "",
    }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout!.on("data", (c) => output += c);
    child.stderr!.on("data", (c) => output += c);
    t.after(() => child.kill("SIGKILL"));
    try {
      assert.ok(await waitFor(() => output.includes("bloks server on http://")), output);
      const row = JSON.parse(readFileSync(join(f.dataRoot, ".bloks", `messages-${f.bot.threadId}.json`), "utf8")).find((m: any) => m.id === request.id);
      assert.equal(row.queued, true);
      assert.equal(row.telegramReply.state, "queued");
      assert.equal(f.engine.state.calls.length, 0);
    } finally {
      const ended = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill("SIGKILL"); await ended;
    }
  }
  f.engine.state.immediate = true;
  await f.reboot();
  assert.ok(await waitFor(() => f.tg.answers().length === 1));
  assert.equal(f.engine.state.calls.length, 1);
});

test("a running drain request returns only its continuation's answer after another restart", async (t) => {
  const f = await fixture(t);
  await f.queue();
  await f.reboot();
  assert.ok(await waitFor(() => f.engine.state.calls.length === 1));
  assert.equal(f.tg.answers().length, 0);
  f.engine.state.immediate = true;
  f.engine.state.text = "CONTINUED";
  await f.reboot();
  assert.ok(await waitFor(() => f.tg.answers().length === 1));
  assert.equal(f.tg.answers()[0].text, "CONTINUED");
  assert.ok(f.engine.state.calls[1].includes(PICKUP));
});

test("a continuation cut off again cannot send an unrelated later answer to the old chat", async (t) => {
  const f = await fixture(t);
  const request = await f.queue();
  await f.reboot();
  assert.ok(await waitFor(() => f.engine.state.calls.length === 1), "T1 never started");
  await f.reboot();
  assert.ok(await waitFor(() => f.engine.state.calls.length === 2), "T2 continuation never started");
  assert.ok(f.engine.state.calls[1].includes(PICKUP));
  await f.reboot();
  assert.ok(await idle(f.h, f.bot));
  assert.equal(f.engine.state.calls.length, 2);
  const afterRestart = await messagesOf(f.h, f.bot);
  f.engine.state.immediate = true;
  f.engine.state.text = "UNRELATED_ANSWER";
  await f.h.json(`/api/bots/${f.bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: "UNRELATED", taskId: f.bot.threadId }) });
  assert.ok(await idle(f.h, f.bot));
  assert.ok((await messagesOf(f.h, f.bot)).some((m) => m.role === "bot" && m.kind === "text" && m.text === "UNRELATED_ANSWER"));
  await sleep(250);
  assert.equal(f.tg.answers().length, 0, "an unrelated app answer was sent to the old chat");
  assert.equal(afterRestart.find((m) => m.id === request.id).telegramReply.state, "failed");
  assert.equal(afterRestart.filter((m) => m.kind === "notice" && m.text.includes("no turn to continue")).length, 1);
  await f.reboot();
  assert.equal((await messagesOf(f.h, f.bot)).filter((m) => m.kind === "notice" && m.text.includes("no turn to continue")).length, 1);
  assert.equal(f.tg.answers().length, 0);
});

test("calling off drain combines two same-chat requests into one answer and keeps edits server-owned", async (t) => {
  const f = await fixture(t);
  const first = await f.queue("FIRST");
  const patched = await f.h.json(`/api/threads/${f.bot.threadId}/messages/${first.id}`, { method: "PATCH", body: JSON.stringify({
    text: "EDITED", telegramReply: { chatId: OTHER_CHAT, state: "queued" }, chatId: OTHER_CHAT,
  }) });
  assert.equal(patched.message.telegramReply.chatId, CHAT);
  f.tg.push("SECOND");
  assert.ok(await waitFor(async () => (await messagesOf(f.h, f.bot)).find((m) => m.text === "SECOND")));
  f.engine.state.immediate = true;
  await f.h.json("/api/maintenance/drain", { method: "DELETE" });
  assert.ok(await waitFor(() => f.tg.answers().length === 1));
  assert.ok(f.engine.state.calls[0].includes("EDITED"));
  assert.ok(f.engine.state.calls[0].includes("SECOND"));
  assert.equal(f.tg.answers()[0].chat_id, CHAT);
  await f.h.json("/api/maintenance/drain", { method: "POST" });
  await f.h.json(`/api/bots/${f.bot.id}/messages`, { method: "POST", body: JSON.stringify({
    text: "CLIENT_FAKE", telegramReply: { chatId: CHAT, state: "queued" }, chatId: CHAT,
  }) });
  assert.equal((await messagesOf(f.h, f.bot)).find((m) => m.text === "CLIENT_FAKE").telegramReply, undefined);
});

test("a queued same-chat follow-up after restart receives its own answer, not two overlapping answers", async (t) => {
  const f = await fixture(t);
  await f.queue("FIRST"); await f.reboot();
  assert.ok(await waitFor(() => f.engine.state.calls.length === 1));
  f.tg.push("FOLLOWUP");
  assert.ok(await waitFor(async () => (await messagesOf(f.h, f.bot)).find((m) => m.text === "FOLLOWUP" && m.queued)));
  f.engine.state.held.shift()!("FIRST_ANSWER");
  assert.ok(await waitFor(() => f.engine.state.calls.length === 2));
  f.engine.state.held.shift()!("FOLLOWUP_ANSWER");
  assert.ok(await waitFor(() => f.tg.answers().length === 2));
  assert.deepEqual(f.tg.answers().map((m) => m.text), ["FIRST_ANSWER", "FOLLOWUP_ANSWER"]);
});

test("a steered same-chat follow-up after restart has one answer for the consuming native turn", async (t) => {
  const f = await fixture(t, `say("Working"); const more = await next(); say("Both: " + more);`);
  await f.queue(); await f.reboot();
  assert.ok(await waitFor(async () => (await messagesOf(f.h, f.bot)).some((m) => m.text === "Working")));
  f.tg.push("FOLLOWUP");
  assert.ok(await waitFor(() => f.tg.answers().length === 1));
  assert.equal(f.tg.answers()[0].text, "Working\n\nBoth: FOLLOWUP");
  assert.equal(readFileSync(join(f.dataRoot, "spawns"), "utf8"), "1");
  await sleep(300);
  assert.equal(f.tg.answers().length, 1);
});

test("a queued drain request joins a cut-off turn and returns its immediate continuation answer", async (t) => {
  const f = await fixture(t);
  await f.h.json(`/api/bots/${f.bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: "OLD_WORK" }) });
  assert.ok(await waitFor(() => f.engine.state.calls.length === 1));
  await f.queue("NEW_DRAIN_REQUEST");
  f.engine.state.immediate = true; f.engine.state.text = "QUICK_JOIN";
  await f.reboot();
  assert.ok(await waitFor(() => f.tg.answers().length === 1));
  assert.ok(f.engine.state.calls[1].includes(PICKUP));
  assert.ok(f.engine.state.calls[1].includes("NEW_DRAIN_REQUEST"));
  assert.equal(f.tg.answers()[0].text, "QUICK_JOIN");
});

test("a sleep handover leaves the return bound until the pickup settles", async (t) => {
  const f = await fixture(t);
  await f.queue();
  await f.h.json("/api/maintenance/drain", { method: "DELETE" });
  assert.ok(await waitFor(() => f.engine.state.held.length === 1));
  await f.h.json("/api/power", { method: "POST", body: JSON.stringify({ state: "suspend" }) });
  await f.h.json("/api/power", { method: "POST", body: JSON.stringify({ state: "resume" }) });
  f.engine.state.immediate = true; f.engine.state.text = "AFTER_SLEEP";
  f.engine.state.held.shift()!("", 400);
  assert.equal(f.tg.answers().length, 0);
  assert.ok(await waitFor(() => f.tg.answers().length === 1));
  assert.equal(f.tg.answers()[0].text, "AFTER_SLEEP");
  assert.ok(f.engine.state.calls[1].includes("went to sleep"));
});

test("a backup handover leaves the return bound until the backup settles", async (t) => {
  const f = await fixture(t, `say("BACKUP_ANSWER");`);
  await f.h.fetch(`/api/bots/${f.bot.id}`, { method: "PATCH", body: JSON.stringify({
    modelSelection: { instanceId: "grok", model: "grok-4" },
    backupSelection: { instanceId: "claude", model: "claude-sonnet-5" },
  }) });
  await f.queue();
  await f.h.json("/api/maintenance/drain", { method: "DELETE" });
  assert.ok(await waitFor(() => f.engine.state.held.length === 1));
  f.engine.state.held.shift()!("", 429);
  assert.equal(f.tg.answers().length, 0);
  assert.ok(await waitFor(() => f.tg.answers().length === 1));
  assert.equal(f.tg.answers()[0].text, "BACKUP_ANSWER");
});

test("an engine rebuild keeps the return for the pickup instead of its first settle", async (t) => {
  const f = await fixture(t);
  await f.queue(); await f.h.json("/api/maintenance/drain", { method: "DELETE" });
  assert.ok(await waitFor(() => f.engine.state.calls.length === 1));
  f.engine.state.immediate = true; f.engine.state.text = "AFTER_REBUILD";
  await f.h.json("/api/providers/grok/connect", { method: "POST", body: JSON.stringify({ key: "test-key-2", url: `http://127.0.0.1:${f.engine.port}` }) });
  assert.ok(await waitFor(() => f.tg.answers().length === 1));
  assert.equal(f.tg.answers()[0].text, "AFTER_REBUILD");
});

test("a consuming turn that cannot start sends the ordinary refusal once", async (t) => {
  const f = await fixture(t);
  await f.queue();
  await f.h.json(`/api/bots/${f.bot.id}/wheel`, { method: "POST", body: JSON.stringify({ why: "fixture hold" }) });
  await f.h.json("/api/maintenance/drain", { method: "DELETE" });
  assert.ok(await waitFor(() => f.tg.answers().length === 1));
  assert.match(f.tg.answers()[0].text, /Could not answer:.*Hand the wheel back/);
  assert.equal(f.engine.state.calls.length, 0);
});

test("a consuming turn stopped by a missing project folder sends why, not an empty answer", async (t) => {
  const f = await fixture(t);
  await f.queue();
  await f.h.json("/api/projects", { method: "POST", body: JSON.stringify({
    name: "Atlas", folders: ["/nonexistent/bloks-test-atlas"], memberIds: [f.bot.id],
  }) });
  await f.h.json("/api/maintenance/drain", { method: "DELETE" });
  assert.ok(await waitFor(() => f.tg.answers().length === 1));
  // it used to say "(the agent finished without saying anything)"
  assert.match(f.tg.answers()[0].text, /Atlas points at \/nonexistent\/bloks-test-atlas/);
  assert.equal(f.engine.state.calls.length, 0);
  await sleep(250);
  assert.equal(f.tg.answers().length, 1);
});

test("a failed consuming turn without a pickup returns the normal empty-answer fallback once", async (t) => {
  const f = await fixture(t);
  await f.queue(); await f.h.json("/api/maintenance/drain", { method: "DELETE" });
  assert.ok(await waitFor(() => f.engine.state.held.length === 1));
  f.engine.state.held.shift()!("", 400);
  assert.ok(await waitFor(() => f.tg.answers().length === 1));
  assert.equal(f.tg.answers()[0].text, "(the agent finished without saying anything)");
  assert.equal(f.engine.state.calls.length, 1);
});

for (const missing of ["none", "unpaired"] as const) test(`a recovered request with ${missing} Telegram configuration stays visibly unresolved`, async (t) => {
  const f = await fixture(t);
  const request = await f.queue(); await f.h.crash();
  const file = join(f.dataRoot, ".bloks", "config.json");
  const cfg = JSON.parse(readFileSync(file, "utf8"));
  if (missing === "none") delete cfg.telegram;
  else cfg.telegram.chatIds = [];
  writeFileSync(file, JSON.stringify(cfg));
  f.engine.state.immediate = true;
  await f.reboot();
  const failed = await waitFor(async () => (await messagesOf(f.h, f.bot)).find((m) => m.id === request.id && m.telegramReply.state === "failed"));
  assert.ok(failed);
  assert.ok((await messagesOf(f.h, f.bot)).some((m) => m.kind === "notice" && m.text.includes("not configured for the chat")));
  assert.equal(f.tg.answers().length, 0);
  await f.reboot(); await sleep(200);
  assert.equal(f.tg.answers().length, 0);
});

test("startup defines bound-without-turn, sending, sent, failed and uncertain without replay", async (t) => {
  const f = await fixture(t);
  const request = await f.queue(); await f.h.crash();
  const file = join(f.dataRoot, ".bloks", `messages-${f.bot.threadId}.json`);
  const rows = JSON.parse(readFileSync(file, "utf8"));
  for (const state of ["bound", "sending", "sent", "failed", "uncertain"]) rows.push({
    ...request, id: `fixture-${state}`, text: `STATE_${state}`, queued: false,
    telegramReply: { chatId: CHAT, state, after: request.id },
  });
  writeFileSync(file, JSON.stringify(rows));
  f.engine.state.immediate = true;
  await f.reboot();
  assert.ok(await waitFor(() => f.tg.answers().length === 1));
  const after = await messagesOf(f.h, f.bot);
  for (const [original, expected] of [["bound", "failed"], ["sending", "uncertain"], ["sent", "sent"], ["failed", "failed"], ["uncertain", "uncertain"]]) {
    assert.equal(after.find((m) => m.id === `fixture-${original}`).telegramReply.state, expected);
  }
  assert.ok(after.some((m) => m.kind === "notice" && m.text.includes("no turn to continue")));
  assert.ok(after.some((m) => m.kind === "notice" && m.text.includes("may have been partly delivered")));
  await f.reboot(); await sleep(250);
  assert.equal(f.tg.answers().length, 1);
});

for (const reason of ["stale", "waiting"] as const) test(`startup fails a bound return whose cut-off record is ${reason}, with one notice and no send`, async (t) => {
  const f = await fixture(t);
  const request = await f.queue();
  await f.reboot();
  assert.ok(await waitFor(() => f.engine.state.calls.length === 1));
  await f.h.crash();
  const file = join(f.dataRoot, ".bloks", "turns-in-flight.json");
  const turns = JSON.parse(readFileSync(file, "utf8"));
  const turn = turns.find((r: any) => r.laneId === f.bot.threadId);
  assert.ok(turn);
  if (reason === "stale") turn.seenAt = Date.now() - 13 * 60 * 60_000;
  else {
    const messagesFile = join(f.dataRoot, ".bloks", `messages-${f.bot.threadId}.json`);
    const rows = JSON.parse(readFileSync(messagesFile, "utf8"));
    rows.push({ id: "fixture-continue", role: "bot", kind: "notice", at: Date.now(), text: "Waiting to continue", carryOn: { laneId: f.bot.threadId } });
    writeFileSync(messagesFile, JSON.stringify(rows));
    turn.waiting = { noticeId: "fixture-continue", threadId: f.bot.threadId, since: Date.now() };
  }
  writeFileSync(file, JSON.stringify(turns));
  await f.reboot();
  assert.ok(await idle(f.h, f.bot));
  const after = await messagesOf(f.h, f.bot);
  assert.equal(after.find((m) => m.id === request.id).telegramReply.state, "failed");
  assert.equal(after.filter((m) => m.kind === "notice" && m.text.includes("no turn to continue")).length, 1);
  assert.equal(f.engine.state.calls.length, 1);
  assert.equal(f.tg.answers().length, 0);
  await f.reboot();
  assert.equal((await messagesOf(f.h, f.bot)).filter((m) => m.kind === "notice" && m.text.includes("no turn to continue")).length, 1);
  assert.equal(f.tg.answers().length, 0);
});

test("taken-back and expired drain inputs neither start a turn nor send a return", async (t) => {
  const f = await fixture(t);
  const removed = await f.queue("REMOVED");
  await f.h.fetch(`/api/threads/${f.bot.threadId}/messages/${removed.id}`, { method: "DELETE" });
  const expired = await f.queue("EXPIRED"); await f.h.crash();
  const file = join(f.dataRoot, ".bloks", `messages-${f.bot.threadId}.json`);
  const rows = JSON.parse(readFileSync(file, "utf8"));
  rows.find((m: any) => m.id === expired.id).queuedAt = Date.now() - 13 * 60 * 60_000;
  writeFileSync(file, JSON.stringify(rows));
  await f.reboot(); await sleep(300);
  assert.equal((await messagesOf(f.h, f.bot)).find((m) => m.id === expired.id).unsent, true);
  assert.equal(f.engine.state.calls.length, 0);
  assert.equal(f.tg.answers().length, 0);
});

for (const failure of ["refused", "dropped"] as const) test(`a partly delivered long answer with its second chunk ${failure} is never replayed`, async (t) => {
  const f = await fixture(t);
  const request = await f.queue();
  f.engine.state.immediate = true; f.engine.state.text = "Long answer " + "word ".repeat(2000);
  f.tg.state.failPart = 2; f.tg.state.failure = failure;
  await f.h.json("/api/maintenance/drain", { method: "DELETE" });
  assert.ok(await waitFor(async () => (await messagesOf(f.h, f.bot)).some((m) => m.kind === "notice" && m.text.includes("partly delivered"))));
  const row = (await messagesOf(f.h, f.bot)).find((m) => m.id === request.id);
  assert.equal(row.telegramReply.state, failure === "refused" ? "failed" : "uncertain");
  assert.equal(row.telegramReply.parts, 1);
  assert.equal(f.tg.state.answerParts, 2);
  assert.equal(f.tg.answers().length, 1);
  await f.reboot(); await sleep(250);
  assert.equal(f.tg.state.answerParts, 2, "accepted chunk was replayed");
});

test("a planned drain waits for an in-flight return send", async (t) => {
  const f = await fixture(t);
  await f.queue(); f.tg.state.held = true; f.engine.state.immediate = true;
  await f.h.json("/api/maintenance/drain", { method: "DELETE" });
  assert.ok(await waitFor(() => f.tg.state.release.length === 1));
  const during = await f.h.json("/api/maintenance/drain", { method: "POST", body: JSON.stringify({ seconds: 60 }) });
  assert.equal(during.idle, false); assert.equal(during.done, false);
  f.tg.state.held = false; f.tg.state.release.shift()!();
  assert.ok(await waitFor(async () => (await f.h.json("/api/maintenance/drain")).idle));
});

test("a synchronous fake engine speaks before carryOn moves its input: all turn text still returns", async (t) => {
  const rows = [
    { id: "old", role: "bot", kind: "text", text: "OLD ANSWER" },
    { id: "request", role: "user", kind: "text", text: "ASK", queued: true, telegramReply: { chatId: CHAT, state: "queued" } },
    { id: "notice", role: "bot", kind: "notice", text: "Picking up" },
  ] as Message[];
  const memory = {
    bots: [{ tasks: [{ id: "lane" }] }],
    messagesFor: () => rows,
    patchMessages: (_lane: string, ids: string[], patch: (m: Message) => Partial<Message>) => rows.filter((m) => ids.includes(m.id)).map((m) => Object.assign(m, patch(m))),
  } as unknown as Store;
  const bodies: any[] = [];
  t.mock.method(globalThis, "fetch", async (_input: Parameters<typeof fetch>[0], options?: RequestInit) => {
    assert.equal(rows.find((m) => m.id === "request")!.telegramReply!.state, "sending", "sending marker must precede I/O");
    const body = options?.body;
    assert.ok(typeof body === "string");
    bodies.push(JSON.parse(body));
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
  });
  const returns = new TelegramReturns(memory, () => ({ enabled: true, token: "TEST", chatIds: [CHAT] }), () => {}, () => {});
  returns.bind("lane", ["request"], true);
  // A synchronous adapter publishes text before startTurn resolves.
  rows.push({ id: "early", at: 1, role: "bot", kind: "text", text: "EARLY" });
  // deliverQueued then moves its request behind that already-spoken text.
  const request = rows.splice(rows.findIndex((m) => m.id === "request"), 1)[0];
  request.queued = false; rows.push(request);
  rows.push({ id: "final", at: 2, role: "bot", kind: "text", text: "FINAL" });
  returns.finish("lane");
  assert.ok(await waitFor(() => request.telegramReply?.state === "sent"));
  assert.equal(bodies[0].text, "EARLY\n\nFINAL");
  returns.finish("lane");
  assert.equal(bodies.length, 1);
});
