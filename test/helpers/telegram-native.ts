// Telegram that feels like the phone it is on: cards answered with a tap,
// files sent back, and a word on what a long turn is doing. Every server,
// engine and Telegram account here is an isolated fixture:
// Telegram is a stub on loopback and the engine is a script that speaks
// Codex's protocol, or Claude Code's for the question it asks its own way.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { startHarness } from "./server.ts";

export const CHAT = 10101;
export const STRANGER = 20202;
const preload = new URL("./telegram-fetch.mjs", import.meta.url).href;
export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitFor<T>(check: () => T | null | undefined | false | Promise<T | null | undefined | false>, why: string, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await sleep(40);
  }
  throw new Error(why);
}

interface Call { method: string; body: any; at: number; token: string }

/** Telegram, as far as this bot ever sees it. Files arrive as forms and
 * are kept as what they were called, what they said they were and how
 * big they were. */
async function telegramStub(t: TestContext) {
  const state = { updates: [] as any[], next: 1, calls: [] as Call[], messageId: 100, holdToken: "", heldPolls: [] as Array<() => void>, pollTokens: [] as string[], getMeReplies: new Map<string, { status?: number; body: unknown }>(), holdDelete: false, deleteReleases: [] as Array<() => void>, deleted: [] as Array<{ id: number; at: number }> };
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", async () => {
      const raw = Buffer.concat(chunks);
      const method = req.url!.split("/").pop()!;
      const token = req.url!.split("/")[1].slice(3);
      const type = String(req.headers["content-type"] ?? "");
      let body: any = {};
      if (type.startsWith("multipart/form-data")) {
        const form = await new Response(raw, { headers: { "content-type": type } }).formData();
        for (const [key, value] of form as unknown as Iterable<[string, string | File]>) {
          body[key] = typeof value === "string" ? value : { name: value.name, type: value.type, size: value.size };
        }
      } else body = JSON.parse(raw.toString() || "{}");
      res.setHeader("content-type", "application/json");
      const reply = (result: unknown) => res.end(JSON.stringify({ ok: true, result }));
      if (method === "getUpdates") {
        state.pollTokens.push(token);
        const finish = () => reply(state.updates.filter((u) => (u._token ?? "12345:TEST_ONLY_TOKEN") === token && u.update_id >= body.offset));
        if (state.holdToken === token) return void state.heldPolls.push(finish);
        return void setTimeout(finish, 30);
      }
      if (method !== "sendChatAction") state.calls.push({ method, body, at: Date.now(), token });
      if (method === "getMe") {
        const override = state.getMeReplies.get(token);
        if (override) {
          if (override.status === 0) return void req.socket.destroy();
          res.statusCode = override.status ?? 200;
          return res.end(JSON.stringify(override.body));
        }
        return reply({ id: Number(token.split(":")[0]), is_bot: true, username: "PlanningBot" });
      }
      if (["sendMessage", "sendPhoto", "sendDocument"].includes(method)) return reply({ message_id: ++state.messageId });
      if (method === "deleteMessage") {
        const finish = () => { state.deleted.push({ id: body.message_id, at: Date.now() }); reply(true); };
        if (state.holdDelete) return void state.deleteReleases.push(finish);
        return finish();
      }
      reply(true);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { state.deleteReleases.forEach((f) => f()); server.closeAllConnections(); server.close(); });
  return {
    state,
    url: `http://127.0.0.1:${(server.address() as any).port}`,
    say(text: string, token = "12345:TEST_ONLY_TOKEN", chatId = CHAT, replyTo?: unknown) {
      state.updates.push({ _token: token, update_id: state.next++, message: { message_id: state.next, chat: { id: chatId, type: "private" }, from: { id: chatId, is_bot: false, first_name: chatId === CHAT ? "Sam" : "Lee" }, text, ...(replyTo ? { reply_to_message: replyTo } : {}) } });
    },
    press(messageId: number, data: string, over: { chat?: number; from?: number } = {}) {
      state.updates.push({
        update_id: state.next++,
        callback_query: {
          id: `press-${state.next}`,
          from: { id: over.from ?? CHAT, is_bot: false, first_name: "Sam" },
          message: { message_id: messageId, chat: { id: over.chat ?? CHAT, type: "private" } },
          data,
        },
      });
    },
    calls: (method: string) => state.calls.filter((c) => c.method === method),
    /** Each sendMessage, with the message id the stub gave it. */
    sent() {
      let id = 100;
      return state.calls.flatMap((c) => (["sendMessage", "sendPhoto", "sendDocument"].includes(c.method) ? [{ ...c, id: ++id }] : []));
    },
  };
}

/** An engine that speaks Codex's app-server protocol and does what the
 * words of its turn say: ask for approval, ask a question, save files, or
 * work slowly through a few commands. */
function fakeCodex(root: string): string {
  const cli = join(root, "fake-codex.mjs");
  writeFileSync(cli, `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync, readdirSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
if (process.argv[2] === "--version") { console.log("codex-cli 0.160.0"); process.exit(0); }
if (process.argv[2] === "login") { console.log("Logged in using ChatGPT"); process.exit(0); }
const root = ${JSON.stringify(root)};
process.stdin.on("end", () => process.exit(0));
const out = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
const log = (m) => appendFileSync(root + "/calls.jsonl", JSON.stringify(m) + "\\n");
const nap = (ms) => new Promise((r) => setTimeout(r, ms));
// the agent's deliverables folder, the only one under artifacts here
const deliverables = () => { const dir = join(root, ".bloks", "artifacts"); return join(dir, readdirSync(dir)[0]); };
const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");
let thread, turn;
const waiting = new Map();
const ask = (id, method, params) => new Promise((resolve) => { waiting.set(id, resolve); out({ id, method, params: { threadId: thread, turnId: turn, ...params } }); });
const tool = (id, command) => out({ method: "item/started", params: { threadId: thread, turnId: turn, item: { type: "commandExecution", id, command } } });
const say = (id, text) => out({ method: "item/completed", params: { threadId: thread, turnId: turn, item: { type: "agentMessage", id, text } } });
const finish = (text, reason) => {
  if (text !== null) out({ method: "item/completed", params: { threadId: thread, turnId: turn, item: { type: "agentMessage", id: "answer", text } } });
  out({ method: "turn/completed", params: { threadId: thread, turn: { id: turn, status: reason ? "failed" : "completed", ...(reason ? { error: { message: reason } } : {}) } } });
};
createInterface({ input: process.stdin }).on("line", async (line) => {
  const m = JSON.parse(line);
  if (!m.method) { const resolve = waiting.get(m.id); if (resolve) { waiting.delete(m.id); log({ reply: m.id, result: m.result }); resolve(m.result); } return; }
  const reply = (result = {}) => out({ id: m.id, result });
  if (m.method === "initialize") return reply();
  if (m.method === "initialized") return;
  if (m.method === "model/list") return reply({ data: [{ id: "gpt-6.1-sol", model: "gpt-6.1-sol", displayName: "GPT-6.1 Sol", isDefault: true, hidden: false }] });
  if (m.method === "skills/list") return reply({ data: [{ cwd: m.params.cwds[0], skills: [], errors: [] }] });
  if (m.method === "thread/start" || m.method === "thread/resume") { thread = m.params.threadId ?? "native-" + process.pid; return reply({ thread: { id: thread }, model: "gpt-6.1-sol" }); }
  if (m.method === "turn/interrupt") { out({ method: "turn/completed", params: { threadId: thread, turn: { id: turn, status: "interrupted" } } }); return reply(); }
  if (["turn/start","turn/steer"].includes(m.method)) log({ method:m.method, params:m.params });
  if (m.method === "turn/steer") { if (!existsSync(root + "/scope-force-queue")) return reply({turnId:turn}); }
  if (m.method === "turn/steer" && existsSync(root + "/scope-force-queue")) return out({ id: m.id, error: { code: -32000, message: "fixture cannot steer" } });
  if (m.method === "turn/steer") return reply({ turnId: turn });
  if (m.method !== "turn/start") return reply();
  turn = "work-" + process.pid; reply({ turn: { id: turn } });
  out({ method: "turn/started", params: { threadId: thread, turn: { id: turn } } });
  const text = m.params.input.filter((i) => i.type === "text").map((i) => i.text).join("");
  if (text.includes("TIMEOUT_")) {
    if (text.includes("TIMEOUT_RETRY") && !existsSync(root + "/timeout-retried")) {
      writeFileSync(root + "/timeout-retried", "1");
      return finish(null, "temporary synthetic failure");
    }
    if (text.includes("TIMEOUT_LATER")) {
      writeFileSync(join(deliverables(), "later.txt"), "later work");
      writeFileSync(root + "/timeout-later-started", "1");
      for (let i = 0; i < 3000 && !existsSync(root + "/timeout-later-release"); i++) await nap(20);
      return finish("LATER RESULT");
    }
    if (text.includes("TIMEOUT_FILES")) writeFileSync(join(deliverables(), "earlier.txt"), "request work");
    writeFileSync(root + "/timeout-started", "1");
    say("timeout-note", "Checking the sample."); tool("timeout-tool", "git status");
    if (existsSync(root + "/timeout-card-delayed")) {
      for (let i = 0; i < 3000 && !existsSync(root + "/timeout-card-release"); i++) await nap(20);
    }
    if (existsSync(root + "/timeout-question")) {
      const result = await ask(990, "item/tool/requestUserInput", { itemId: "late-question", questions: [{ id: "day", question: "Which day?" }] });
      writeFileSync(root + "/timeout-card-answer", JSON.stringify(result));
    }
    if (existsSync(root + "/timeout-approval")) {
      const result = await ask(991, "item/commandExecution/requestApproval", { itemId: "late-approval", command: "remove sample output" });
      writeFileSync(root + "/timeout-card-answer", JSON.stringify(result));
    }
    for (let i = 0; i < 3000 && !existsSync(root + "/timeout-release"); i++) await nap(20);
    if (text.includes("TIMEOUT_EMPTY")) return finish(null);
    return finish("REQUEST RESULT");
  }
  if (text.includes("CTX_HOLD")) { writeFileSync(root+"/ctx-started","1"); for(let i=0;i<1000&&!existsSync(root+"/ctx-release");i++)await nap(20);return finish("CTX DONE"); }
  const scope = text.match(/SCOPED_[A-Z_]+/g)?.at(-1);
  if (scope) {
    writeFileSync(root + "/" + scope + "-started", "1");
    if (scope === "SCOPED_HOLD") {
      for (let i = 0; i < 3000 && !existsSync(root + "/aside-release"); i++) await nap(20);
      return finish("ASIDE DONE");
    }
    if (scope === "SCOPED_MAIN_HOLD") {
      if (existsSync(root + "/timeout-behind-files")) writeFileSync(join(deliverables(), "behind.txt"), "earlier work");
      writeFileSync(root + "/scope-force-queue", "1");
      say("other-note", "An earlier request's note.");
      let late = false;
      for (let i = 0; i < 3000 && !existsSync(root + "/main-release"); i++) {
        if (!late && existsSync(root + "/old-note-release")) { late = true; say("other-late", "An earlier request's late note."); }
        await nap(20);
      }
      return finish("EARLIER FINAL");
    }
    if (scope === "SCOPED_LATER") { say("later-note", "LATER NOTE"); return finish("LATER FINAL"); }
    say("phone-note", "PHONE NOTE");
    tool("scope-tool", "git status");
    if (scope === "SCOPED_OWNER_PROGRESS") await nap(21_500);
    say("phone-final", "PHONE FINAL"); tool("after-final", "git status");
    return finish(null);
  }
  if (text.includes("EMPTY_TURN")) return finish(null);
  if (text.includes("COMPLETION_FAILURE")) return finish(null, "synthetic completion failure");
  if (text.includes("ENGINE_NOTICE") || text.includes("REPLY_THEN_NOTICE")) {
    if (text.includes("REPLY_THEN_NOTICE")) out({ method: "item/completed", params: { threadId: thread, turnId: turn, item: { type: "agentMessage", id: "reply", text: "A real reply." } } });
    out({ method: "error", params: { threadId: thread, error: { message: "synthetic engine refusal" } } });
    return finish(null, "synthetic engine refusal");
  }
  if (text.includes("SETTINGS_GUARD")) {
    const botId = JSON.parse(readFileSync(root + "/.bloks/bots.json", "utf8")).find((bot) => bot.name === "Planning").id;
    const attempts = [["GET", "/api/telegram"], ["GET", "/api/bots/" + botId + "/telegram"], ["POST", "/api/bots/" + botId + "/telegram", { pair: true }], ["POST", "/api/bots/" + botId + "/telegram", { forget: true }]];
    const statuses = [];
    for (const [method, path, body] of attempts) {
      const response = await fetch(process.env.BLOKS_URL + path, { method, headers: { Authorization: "Bearer " + process.env.BLOKS_TOKEN, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
      statuses.push(response.status);
    }
    return finish("GUARDS " + JSON.stringify(statuses));
  }
  if (text.includes("APPROVE")) {
    const result = await ask(900, "item/commandExecution/requestApproval", { itemId: "cmd-1", command: "rm -rf build" });
    return finish("DECIDED " + result.decision);
  }
  if (text.includes("QUESTION")) {
    const result = await ask(901, "item/tool/requestUserInput", { itemId: "q", questions: [{ id: "q1", question: "Which colour?", options: [{ label: "Red" }, { label: "Blue" }, { label: "Green" }] }] });
    return finish("PICKED " + result.answers.q1.answers[0]);
  }
  if (text.includes("FREE")) {
    const result = await ask(902, "item/tool/requestUserInput", { itemId: "q", questions: [{ id: "q1", question: "Which day?" }] });
    return finish("HEARD " + result.answers.q1.answers[0]);
  }
  if (text.includes("FILES")) {
    const dir = deliverables();
    // apart, so they are told apart by when they were saved
    writeFileSync(join(dir, "report.pdf"), "%PDF-1.4 a small report"); await nap(15);
    writeFileSync(join(dir, "chart.png"), PNG); await nap(15);
    // over Telegram's 50 MB, without writing 50 MB: a sparse file
    writeFileSync(join(dir, "footage.mov"), ""); truncateSync(join(dir, "footage.mov"), 51 * 1024 * 1024);
    return finish("Here are your files.");
  }
  if (text.includes("MANY")) {
    const dir = deliverables();
    for (let i = 1; i <= 7; i++) { writeFileSync(join(dir, "part-" + i + ".txt"), "part " + i); await nap(15); }
    return finish("Seven parts.");
  }
  if (text.includes("HOLD_UNPAIR")) {
    writeFileSync(root + "/unpair-started", "1");
    for (let i = 0; i < 1000 && !existsSync(root + "/unpair-release"); i++) await nap(20);
    return finish("OLD_UNPAIRED_ANSWER");
  }
  if (text.includes("SLOW_NO_NOTE")) {
    tool("t1", "npm test"); await nap(21_500);
    say("only-final", "NO NOTE DONE"); await nap(300);
    return finish(null);
  }
  // the one retry a failed turn gets (GitHub 284) fails again, at once
  if (text.includes("SLOW_ERROR") && text.includes("A note from Bloks")) {
    out({ method: "error", params: { threadId: thread, error: { message: "synthetic failure after a note" } } });
    return finish(null, "synthetic failure after a note");
  }
  if (text.includes("SLOW")) {
    out({ method: "item/completed", params: { threadId: thread, turnId: turn, item: { type: "reasoning", id: "thought", summary: [{ type: "summary_text", text: "PRIVATE_REASONING" }], content: [{ type: "reasoning_text", text: "PRIVATE_REASONING" }] } } });
    say("n1", "I am checking the parser.");
    tool("t1", "npm test");
    await nap(21_000);
    if (text.includes("SLOW_ERROR")) {
      say("n2", "The parser checks pass.");
      tool("error-work", "npm run build");
      for (let i = 0; i < 1000 && !existsSync(root + "/error-release"); i++) await nap(20);
      out({ method: "error", params: { threadId: thread, error: { message: "synthetic failure after a note" } } });
      return finish(null, "synthetic failure after a note");
    }
    if (text.includes("SLOW_STOP")) return;
    say("n2", "The parser checks pass.");
    tool("t2", "npm run build");
    await nap(300);
    say("n3", "I am checking the build.");
    tool("t3", "npm run lint");
    await nap(5_000);
    say("answer", "SLOW DONE");
    tool("trailing", "git status");
    return finish(null);
  }
  finish("ANSWER");
});
`, { mode: 0o755 });
  return cli;
}

/** A Claude Code whose own question tool asks permission to ask, the way
 * the real one does: an ask on the turn's socket with no word that it is
 * a question. It says back what it was told. */
function fakeClaude(root: string): string {
  const cli = join(root, "fake-claude.mjs");
  writeFileSync(cli, `#!${process.execPath}
import { createConnection } from "node:net";
import { readFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("9.9.9 (Claude Code)"); process.exit(0); }
if (args[0] === "auth") { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
const out = (frame) => console.log(JSON.stringify(frame));
process.stdin.once("data", async (input) => {
  out({ type: "system", subtype: "init", session_id: "sess-native", model: "claude-sonnet-5" });
  if (String(input).includes("CLAUDE_THINKING")) {
    out({ type: "system", subtype: "thinking_tokens", estimated_tokens: 32, text: "PRIVATE_THINKING" });
    out({ type: "assistant", message: { content: [{ type: "thinking", thinking: "PRIVATE_THINKING" }, { type: "text", text: "A visible note." }] } });
    out({ type: "assistant", message: { content: [{ type: "tool_use", id: "visible-work", name: "Read", input: { file_path: "synthetic.ts" } }] } });
    await new Promise((r) => setTimeout(r, 21_500));
    out({ type: "assistant", message: { content: [{ type: "text", text: "THINKING DONE" }] } });
    out({ type: "result", subtype: "success", is_error: false, num_turns: 1, duration_api_ms: 100, total_cost_usd: 0, session_id: "sess-native", result: "THINKING DONE" });
    return setTimeout(() => process.exit(0), 50);
  }
  if (String(input).includes("CLAUDE_REFUSAL") || String(input).includes("CLAUDE_REPLY_NOTICE")) {
    if (String(input).includes("CLAUDE_REPLY_NOTICE")) out({ type: "assistant", message: { content: [{ type: "text", text: "A real reply." }] } });
    // An is_error result supplies a stopReason without a runtime.error.
    out({ type: "result", subtype: "error_during_execution", is_error: true, num_turns: 1, duration_api_ms: 100, total_cost_usd: 0, session_id: "sess-native", result: "The provider refused *this* request: fixture-stored-secret-123, sk-fixture_abcdefghijklmnop." });
    return setTimeout(() => process.exit(0), 50);
  }
  const config = JSON.parse(readFileSync(args[args.indexOf("--mcp-config") + 1], "utf8"));
  const socket = createConnection(config.mcpServers.bloks.args[1]);
  socket.write(JSON.stringify({ t: "ask", id: "ask-db", tool: "AskUserQuestion", input: { questions: [{ question: "Which database?", options: [{ label: "Postgres" }, { label: "SQLite" }] }] } }) + "\\n");
  socket.once("data", (line) => {
    const told = JSON.parse(String(line));
    const text = "TOLD " + told.behavior + " " + told.message;
    out({ type: "assistant", message: { content: [{ type: "text", text }] } });
    out({ type: "result", subtype: "success", is_error: false, num_turns: 1, duration_api_ms: 100, total_cost_usd: 0, session_id: "sess-native", result: text });
    setTimeout(() => process.exit(0), 50);
  });
});
`, { mode: 0o755 });
  return cli;
}

export async function fixture(t: TestContext, engine: "codex" | "claude" = "codex", clock = false) {
  const root = mkdtempSync(join(tmpdir(), "bloks-telegram-native-"));
  mkdirSync(join(root, ".bloks"), { recursive: true });
  writeFileSync(join(root, ".bloks/config.json"), JSON.stringify({ instances: {
    codex: { driver: "codex", config: { cli: fakeCodex(root) } },
    claude: { driver: "claudeAgent", config: { cli: fakeClaude(root) } },
  }, secrets: { TEST_NOTICE: "fixture-stored-secret-123" } }));
  const tg = await telegramStub(t);
  const env = {
    HOME: root, NODE_OPTIONS: `--import=${preload}${clock ? ` --import=${new URL("./telegram-clock.mjs", import.meta.url).href}` : ""}`, BLOKS_TEST_TELEGRAM_URL: tg.url,
    OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "", ELEVENLABS_API_KEY: "",
  };
  let h: Awaited<ReturnType<typeof startHarness>>;
  try { h = await startHarness(env); }
  catch (error) { rmSync(root, { recursive: true, force: true }); throw error; }
  t.after(async () => { await h.crash(); rmSync(root, { recursive: true, force: true }); });
  const post = (path: string, body: unknown = {}) => h.json(path, { method: "POST", body: JSON.stringify(body) });
  const { bot } = await post("/api/bots", { name: "Planning" });
  const model = engine === "codex" ? "gpt-6.1-sol" : "claude-sonnet-5";
  await h.json(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: engine, model } }) });
  const paired = await post("/api/telegram", { token: "12345:TEST_ONLY_TOKEN", enabled: true, botId: bot.id, pair: true });
  assert.ok(paired.pairing, JSON.stringify(paired));
  tg.say(paired.pairing);
  await waitFor(() => tg.calls("sendMessage").some((c) => c.body.text.startsWith("Paired.")), "the stub chat never paired");
  const replies = (): any[] => existsSync(join(root, "calls.jsonl"))
    ? readFileSync(join(root, "calls.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((c) => c.reply)
    : [];
  const messages = async () => (await h.json(`/api/bots/${bot.id}/messages?thread=${bot.threadId}&limit=500`)).messages as any[];
  return { root, tg, get h() { return h; }, bot, post, replies, messages,
    async reboot() { await h.crash(); h = await startHarness(env); },
  };
}

/** The card a turn forwarded, once it has been sent. */
export async function cardIn(f: Awaited<ReturnType<typeof fixture>>, title: string) {
  return waitFor(() => f.tg.sent().find((m) => m.method === "sendMessage" && m.body.text.startsWith(title)), `no "${title}" card reached the chat`);
}

export const heardContext = (f: Awaited<ReturnType<typeof fixture>>) => existsSync(join(f.root, "calls.jsonl")) ? readFileSync(join(f.root, "calls.jsonl"), "utf8").split("\n").slice(0, -1).filter(Boolean).map(x => JSON.parse(x)).filter(x => x.method) : [];
export const inputWords = (call: any) => call.params.input.filter((x: any) => x.type === "text").map((x: any) => x.text).join("");
