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
import { test, type TestContext } from "node:test";
import { startHarness } from "./helpers/server.ts";

const CHAT = 10101;
const STRANGER = 20202;
const preload = new URL("./helpers/telegram-fetch.mjs", import.meta.url).href;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor<T>(check: () => T | null | undefined | false | Promise<T | null | undefined | false>, why: string, ms = 30_000): Promise<T> {
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
  const state = { updates: [] as any[], next: 1, calls: [] as Call[], messageId: 100, holdToken: "", heldPolls: [] as Array<() => void> };
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
        const finish = () => reply(state.updates.filter((u) => (u._token ?? "12345:TEST_ONLY_TOKEN") === token && u.update_id >= body.offset));
        if (state.holdToken === token) return void state.heldPolls.push(finish);
        return void setTimeout(finish, 30);
      }
      if (method !== "sendChatAction") state.calls.push({ method, body, at: Date.now(), token });
      if (method === "getMe") return reply({ id: Number(token.split(":")[0]), is_bot: true, username: "PlanningBot" });
      if (["sendMessage", "sendPhoto", "sendDocument"].includes(method)) return reply({ message_id: ++state.messageId });
      reply(true);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return {
    state,
    url: `http://127.0.0.1:${(server.address() as any).port}`,
    say(text: string, token = "12345:TEST_ONLY_TOKEN", chatId = CHAT) {
      state.updates.push({ _token: token, update_id: state.next++, message: { message_id: state.next, chat: { id: chatId, type: "private" }, from: { id: chatId, is_bot: false, first_name: chatId === CHAT ? "Sam" : "Lee" }, text } });
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
import { appendFileSync, readFileSync, readdirSync, truncateSync, writeFileSync } from "node:fs";
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
const finish = (text) => {
  out({ method: "item/completed", params: { threadId: thread, turnId: turn, item: { type: "agentMessage", id: "answer", text } } });
  out({ method: "turn/completed", params: { threadId: thread, turn: { id: turn, status: "completed" } } });
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
  if (m.method !== "turn/start") return reply();
  turn = "work-" + process.pid; reply({ turn: { id: turn } });
  out({ method: "turn/started", params: { threadId: thread, turn: { id: turn } } });
  const text = m.params.input.filter((i) => i.type === "text").map((i) => i.text).join("");
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
  if (text.includes("SLOW")) {
    tool("t1", "npm test");
    await nap(21_000);
    tool("t2", "npm run build");
    await nap(300);
    tool("t3", "curl -u sk-test_abcdefghijklmnop api.invalid");
    await nap(5_000);
    return finish("SLOW DONE");
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
process.stdin.once("data", () => {
  out({ type: "system", subtype: "init", session_id: "sess-native", model: "claude-sonnet-5" });
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

async function fixture(t: TestContext, engine: "codex" | "claude" = "codex") {
  const root = mkdtempSync(join(tmpdir(), "bloks-telegram-native-"));
  mkdirSync(join(root, ".bloks"), { recursive: true });
  writeFileSync(join(root, ".bloks/config.json"), JSON.stringify({ instances: {
    codex: { driver: "codex", config: { cli: fakeCodex(root) } },
    claude: { driver: "claudeAgent", config: { cli: fakeClaude(root) } },
  } }));
  const tg = await telegramStub(t);
  const env = {
    HOME: root, NODE_OPTIONS: `--import=${preload}`, BLOKS_TEST_TELEGRAM_URL: tg.url,
    OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "", ELEVENLABS_API_KEY: "",
  };
  let h = await startHarness(env);
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
async function cardIn(f: Awaited<ReturnType<typeof fixture>>, title: string) {
  return waitFor(() => f.tg.sent().find((m) => m.method === "sendMessage" && m.body.text.startsWith(title)), `no "${title}" card reached the chat`);
}

test("an approval arrives with Allow and Deny to tap, and only the paired person's tap allows it", async (t) => {
  const f = await fixture(t);
  f.tg.say("APPROVE this");
  const card = await cardIn(f, "Approval needed");
  assert.equal(card.body.text, "Approval needed\nrm -rf build");
  assert.equal("disable_notification" in card.body, false);
  const rows = card.body.reply_markup.inline_keyboard;
  assert.deepEqual(rows.map((row: any[]) => row.map((b) => b.text)), [["Allow", "Deny"]]);
  const requestId = (await f.messages()).find((m) => m.kind === "options").card.requestId;
  for (const button of rows.flat()) {
    assert.ok(Buffer.byteLength(button.callback_data) <= 64);
    assert.ok(!button.callback_data.includes(requestId), "the request id never leaves this machine");
  }
  const allow = rows[0][0].callback_data;
  // the same button, pressed from a chat that is not paired and by
  // someone in the chat who is not the person it is paired with
  f.tg.press(card.id, allow, { chat: STRANGER, from: STRANGER });
  f.tg.press(card.id, allow, { from: STRANGER });
  await sleep(1_500);
  assert.equal(f.tg.calls("answerCallbackQuery").length, 0, "a stranger's press is not even answered");
  assert.equal(f.replies().length, 0, "and decides nothing");
  f.tg.press(card.id, allow);
  const answered = await waitFor(() => f.tg.calls("answerCallbackQuery")[0], "the press was never answered");
  assert.equal(answered.body.text, "Allowed");
  assert.deepEqual(f.replies().map((r) => r.result), [{ decision: "accept" }]);
  const edited = await waitFor(() => f.tg.calls("editMessageText").find((c) => c.body.message_id === card.id), "the card was never rewritten");
  assert.equal(edited.body.text, "Approval needed\nrm -rf build\n\nAllowed");
  assert.deepEqual(edited.body.reply_markup, { inline_keyboard: [] });
  await waitFor(() => f.tg.calls("sendMessage").some((c) => c.body.text === "DECIDED accept"), "the answer never came back");
  assert.equal(f.tg.calls("editMessageText").length, 1, "rewritten once, not again when the engine reported back");
});

test("a question's choices are one button each, and the tapped one is the answer", async (t) => {
  const f = await fixture(t);
  f.tg.say("QUESTION please");
  const card = await cardIn(f, "Your agent has a question");
  const rows = card.body.reply_markup.inline_keyboard;
  assert.deepEqual(rows.map((row: any[]) => row.map((b) => b.text)), [["Red"], ["Blue"], ["Green"]]);
  f.tg.press(card.id, rows[1][0].callback_data);
  await waitFor(() => f.tg.calls("sendMessage").some((c) => c.body.text === "PICKED Blue"), "the choice never reached the agent");
  const edited = f.tg.calls("editMessageText").find((c) => c.body.message_id === card.id);
  assert.equal(edited?.body.text, "Your agent has a question\nWhich colour?\n\nAnswered: Blue");
});

test("a question an engine asked permission to ask has its own choices, and the tapped one is the answer", async (t) => {
  // Claude Code's own question reaches Bloks labelled a permission. Read
  // as one here, the first choice allowed the asking with no answer in
  // it, and any other choice refused it.
  const f = await fixture(t, "claude");
  f.tg.say("which one");
  const card = await cardIn(f, "Your agent has a question");
  assert.equal(card.body.text, "Your agent has a question\nWhich database?");
  const rows = card.body.reply_markup.inline_keyboard;
  assert.deepEqual(rows.map((row: any[]) => row.map((b) => b.text)), [["Postgres"], ["SQLite"]]);
  f.tg.press(card.id, rows[1][0].callback_data);
  await waitFor(() => f.tg.calls("sendMessage").some((c) => c.body.text === "TOLD answer SQLite"), "the choice never reached the agent");
  const edited = f.tg.calls("editMessageText").find((c) => c.body.message_id === card.id);
  assert.equal(edited?.body.text, "Your agent has a question\nWhich database?\n\nAnswered: SQLite");
});

test("a card answered in the app is rewritten on the phone, and its buttons do nothing after", async (t) => {
  const f = await fixture(t);
  f.tg.say("APPROVE from the desk");
  const card = await cardIn(f, "Approval needed");
  const requestId = (await f.messages()).find((m) => m.kind === "options").card.requestId;
  const answered = await f.post(`/api/bots/${f.bot.id}/respond`, { requestId, behavior: "deny" });
  assert.equal(answered.outcome, "delivered");
  const edited = await waitFor(() => f.tg.calls("editMessageText").find((c) => c.body.message_id === card.id), "the phone's copy was never rewritten");
  assert.equal(edited.body.text, "Approval needed\nrm -rf build\n\nDenied");
  assert.deepEqual(edited.body.reply_markup, { inline_keyboard: [] });
  await waitFor(() => f.tg.calls("sendMessage").some((c) => c.body.text === "DECIDED decline"), "the answer never came back");
  // a tap that was already on its way says what happened, and decides nothing more
  f.tg.press(card.id, card.body.reply_markup.inline_keyboard[0][0].callback_data);
  const told = await waitFor(() => f.tg.calls("answerCallbackQuery")[0], "the late press was never answered");
  assert.equal(told.body.text, "Denied");
  assert.equal(f.replies().length, 1);
});

test("a question with no choices is still answered by typing, and says so once it is", async (t) => {
  const f = await fixture(t);
  f.tg.say("FREE answer");
  const card = await cardIn(f, "Your agent has a question");
  assert.equal(card.body.reply_markup, undefined);
  assert.match(card.body.text, /Reply with your answer\.$/);
  f.tg.say("Saturday");
  await waitFor(() => f.tg.calls("sendMessage").some((c) => c.body.text === "HEARD Saturday"), "the typed answer never reached the agent");
  const edited = f.tg.calls("editMessageText").find((c) => c.body.message_id === card.id);
  assert.equal(edited?.body.text, "Your agent has a question\nWhich day?\n\nAnswered: Saturday");
});

test("what a Telegram turn saved comes back after its answer: images as photos, the rest as files", async (t) => {
  const f = await fixture(t);
  f.tg.say("FILES please");
  const note = await waitFor(() => f.tg.calls("sendMessage").find((c) => c.body.text.startsWith("Not sent here")), "the files never finished");
  assert.equal(note.body.text, "Not sent here: footage.mov (over Telegram's 50 MB). It is in the app.");
  const order = f.tg.state.calls
    .filter((c) => ["sendMessage", "sendPhoto", "sendDocument"].includes(c.method) && !String(c.body.text ?? "").startsWith("Paired."))
    .map((c) => c.body.text ?? `${c.method} ${(c.body.photo ?? c.body.document).name}`);
  assert.deepEqual(order, [
    "Here are your files.",
    "sendDocument report.pdf",
    "sendPhoto chart.png",
    "Not sent here: footage.mov (over Telegram's 50 MB). It is in the app.",
  ]);
  const photo = f.tg.calls("sendPhoto")[0]!.body;
  assert.equal(photo.chat_id, String(CHAT));
  assert.deepEqual(photo.photo, { name: "chart.png", type: "image/png", size: 29 });
  assert.equal(f.tg.calls("sendDocument")[0]!.body.chat_id, String(CHAT));
  assert.equal("disable_notification" in photo, false);
  assert.equal("disable_notification" in f.tg.calls("sendDocument")[0]!.body, false);
});

test("only a few files come back with one answer, and the rest are counted", async (t) => {
  const f = await fixture(t);
  f.tg.say("MANY parts");
  const note = await waitFor(() => f.tg.calls("sendMessage").find((c) => c.body.text.startsWith("Not sent here")), "the files never finished");
  assert.equal(note.body.text, "Not sent here: 2 more files (only 5 come with an answer). They are in the app.");
  assert.deepEqual(f.tg.calls("sendDocument").map((c) => c.body.document.name), ["part-1.txt", "part-2.txt", "part-3.txt", "part-4.txt", "part-5.txt"]);
});

test("files from a turn that did not begin on Telegram stay in the app", async (t) => {
  const f = await fixture(t);
  await f.post(`/api/bots/${f.bot.id}/messages`, { text: "FILES from the desk" });
  await waitFor(async () => (await f.messages()).some((m) => m.kind === "artifact" && m.artifact.name === "chart.png"), "the turn never saved its files");
  await sleep(1_000);
  assert.deepEqual([...f.tg.calls("sendPhoto"), ...f.tg.calls("sendDocument")], []);
});

test("a long turn posts what it is working on, rewrites it as tools change, and takes it away for the answer", async (t) => {
  const f = await fixture(t);
  const asked = Date.now();
  f.tg.say("SLOW work");
  const status = await waitFor(() => f.tg.sent().find((m) => m.body.text?.startsWith("Working")), "no status line was posted", 40_000);
  assert.equal(status.body.text, "Working: npm test...");
  assert.equal(status.body.disable_notification, true);
  assert.ok(status.at - asked >= 19_000, `posted after ${status.at - asked} ms, not about twenty seconds`);
  const answer = await waitFor(() => f.tg.state.calls.find((c) => c.method === "sendMessage" && c.body.text === "SLOW DONE"), "the answer never came", 40_000);
  assert.equal("disable_notification" in answer.body, false);
  // one rewrite for two quick tools, naming the later, without the key
  // its command carried
  const edits = f.tg.calls("editMessageText");
  assert.deepEqual(edits.map((c) => [c.body.message_id, c.body.text]), [[status.id, "Working: curl -u [redacted] api.invalid..."]]);
  const removed = f.tg.calls("deleteMessage");
  assert.deepEqual(removed.map((c) => c.body), [{ chat_id: CHAT, message_id: status.id }]);
  assert.ok(removed[0]!.at <= answer.at, "the line is gone before the answer arrives");
});

test("a quick turn posts no status line", async (t) => {
  const f = await fixture(t);
  f.tg.say("hello");
  await waitFor(() => f.tg.calls("sendMessage").some((c) => c.body.text === "ANSWER"), "the answer never came");
  assert.equal(f.tg.sent().filter((m) => m.body.text?.startsWith("Working")).length, 0);
  assert.equal(f.tg.calls("deleteMessage").length, 0);
});

test("words said from Telegram are marked as that, and the app does not offer to redo them", async (t) => {
  const f = await fixture(t);
  f.tg.say("hello");
  await waitFor(() => f.tg.calls("sendMessage").some((c) => c.body.text === "ANSWER"), "the answer never came");
  const said = (await f.messages()).find((m) => m.role === "user" && m.text === "hello");
  assert.equal(said.fromTelegram, true, "nothing on the message says it came from Telegram");
  const redo = (id: string) => f.h.json(`/api/threads/${f.bot.threadId}/messages/${id}/redo`);
  assert.equal((await redo(said.id)).offered, false);
  // one typed in the app, in the same conversation, is the person's to redo
  await f.post(`/api/bots/${f.bot.id}/messages`, { text: "typed here" });
  const typed = await waitFor(async () => {
    const list = await f.messages();
    return list.filter((m) => m.text === "ANSWER").length === 2 && list.find((m) => m.text === "typed here");
  }, "the typed message was never answered");
  assert.ok(!typed.fromTelegram);
  await waitFor(async () => (await redo(typed.id)).offered === true, "a message typed in the app was not offered a redo");
});

test("a button from before a restart says its card has closed, and loses its buttons", async (t) => {
  const f = await fixture(t);
  f.tg.press(55, "AAAAAAAA:0");
  const told = await waitFor(() => f.tg.calls("answerCallbackQuery")[0], "the press was never answered");
  assert.equal(told.body.text, "That card has already closed.");
  const cleared = await waitFor(() => f.tg.calls("editMessageReplyMarkup")[0], "its buttons were left in place");
  assert.deepEqual(cleared.body, { chat_id: CHAT, message_id: 55, reply_markup: { inline_keyboard: [] } });
});

test("two agent bots do not borrow owner pairing or intake when their private chat id is the same", async (t) => {
  const f = await fixture(t);
  const { bot: second } = await f.post("/api/bots", { name: "Lee" });
  await f.h.json(`/api/bots/${second.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" } }) });
  const token = "22222:SECOND_TEST_TOKEN";
  const status = await f.post(`/api/bots/${second.id}/telegram`, { token, enabled: true });
  assert.equal(status.needsOwnerPairing, true);
  f.tg.say("NOT_PAIRED_YET", token);
  await waitFor(() => f.tg.calls("sendMessage").some((call) => call.token === token && call.body.text === "This bot is not paired with you."), "the second bot borrowed the first bot's pairing");
  const list = async (id: string) => (await f.h.json(`/api/bots/${id}/messages?limit=500`)).messages;
  assert.equal((await list(second.id)).some((message: any) => message.text === "NOT_PAIRED_YET"), false);
  const pairing = await f.post(`/api/bots/${second.id}/telegram`, { pair: true });
  f.tg.say(pairing.pairing, token);
  await waitFor(async () => (await f.h.json(`/api/bots/${second.id}/telegram`)).ownerPaired, "the second owner pairing did not complete");
  f.tg.say("ONLY_SECOND_BOT", token);
  await waitFor(() => f.tg.calls("sendMessage").some((call) => call.token === token && call.body.text === "ANSWER"), "the second bot's answer did not use its token");
  assert.equal((await list(second.id)).some((message: any) => message.text === "ONLY_SECOND_BOT"), true);
  assert.equal((await f.messages()).some((message) => message.text === "ONLY_SECOND_BOT" || message.text === pairing.pairing), false);
  f.tg.say("ONLY_FIRST_BOT");
  await waitFor(async () => (await f.messages()).some((message) => message.text === "ONLY_FIRST_BOT"), "the first bot stopped receiving its chat");
  assert.equal((await list(second.id)).some((message: any) => message.text === "ONLY_FIRST_BOT"), false);
  const publicStatus = await f.h.json("/api/telegram");
  assert.equal(JSON.stringify(publicStatus).includes(token), false);
});

test("a duplicate Telegram bot is refused even under a different token string", async (t) => {
  const f = await fixture(t);
  const { bot: second } = await f.post("/api/bots", { name: "Lee" });
  const response = await f.h.fetch(`/api/bots/${second.id}/telegram`, { method: "POST", body: JSON.stringify({ token: "12345:ROTATED_TEST_TOKEN" }) });
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /already belongs/);
  assert.equal((await f.h.json(`/api/bots/${second.id}/telegram`)).configured, false);
  assert.equal((await f.h.json(`/api/bots/${f.bot.id}/telegram`)).ownerPaired, true);
});

test("rotation and removal invalidate held old polls before they write into a conversation", async (t) => {
  const f = await fixture(t);
  const original = "12345:TEST_ONLY_TOKEN";
  f.tg.state.holdToken = original;
  await waitFor(() => f.tg.state.heldPolls.length, "the old bot never held a poll");
  f.tg.say("OLD_ROTATION_MESSAGE", original);
  const nextToken = "12345:ROTATED_TEST_TOKEN";
  await f.post(`/api/bots/${f.bot.id}/telegram`, { token: nextToken });
  f.tg.state.holdToken = nextToken;
  for (const release of f.tg.state.heldPolls.splice(0)) release();
  await waitFor(() => f.tg.state.heldPolls.length, "the rotated bot never started its own poll");
  assert.equal((await f.messages()).some((message) => message.text === "OLD_ROTATION_MESSAGE"), false);
  f.tg.say("OLD_REMOVAL_MESSAGE", nextToken);
  await f.post(`/api/bots/${f.bot.id}/telegram`, { forget: true });
  for (const release of f.tg.state.heldPolls.splice(0)) release();
  await sleep(150);
  assert.equal((await f.messages()).some((message) => message.text === "OLD_REMOVAL_MESSAGE"), false);
  assert.equal((await f.h.json(`/api/bots/${f.bot.id}/telegram`)).configured, false);
});


test("a real 2.6 config upgrade keeps two chats until people admission, and identifies the owner with a fresh word", async (t) => {
  const f = await fixture(t);
  await f.h.crash();
  const file = join(f.root, ".bloks", "config.json");
  const config = JSON.parse(readFileSync(file, "utf8"));
  const offset = config.telegram.bots[f.bot.id].offset;
  config.telegram = { token: "12345:TEST_ONLY_TOKEN", botId: f.bot.id, enabled: true, chatIds: [CHAT, STRANGER], offset, pairing: "old-word" };
  writeFileSync(file, JSON.stringify(config));
  await f.reboot();
  const migrated = JSON.parse(readFileSync(file, "utf8")).telegram;
  assert.equal(migrated.version, 1);
  assert.equal(migrated.token, undefined);
  assert.equal(migrated.migratedBotId, f.bot.id);
  assert.equal(migrated.bots[f.bot.id].offset, offset);
  assert.deepEqual(migrated.bots[f.bot.id].chatIds, [CHAT, STRANGER]);
  assert.equal(migrated.bots[f.bot.id].ownerUserId, undefined);
  assert.equal(migrated.bots[f.bot.id].pairing, null);
  const status = await f.h.json(`/api/bots/${f.bot.id}/telegram`);
  assert.equal(status.needsOwnerPairing, true);
  assert.equal(status.legacyPaired, 2);
  const pairing = await f.post(`/api/bots/${f.bot.id}/telegram`, { pair: true });
  assert.notEqual(pairing.pairing, "old-word");
  f.tg.say(pairing.pairing);
  await waitFor(async () => (await f.h.json(`/api/bots/${f.bot.id}/telegram`)).ownerPaired, "fresh word did not identify owner");
  const paired = JSON.parse(readFileSync(file, "utf8")).telegram.bots[f.bot.id];
  assert.equal(paired.ownerUserId, CHAT);
  assert.deepEqual(paired.chatIds, [CHAT, STRANGER]);
  f.tg.say("Sam after upgrade");
  await waitFor(() => f.tg.sent().find((c) => c.body.chat_id === CHAT && c.body.text === "ANSWER"), "owner chat stopped working after upgrade");
  f.tg.say("Lee after upgrade", "12345:TEST_ONLY_TOKEN", STRANGER);
  await waitFor(() => f.tg.sent().find((c) => c.body.chat_id === STRANGER && c.body.text === "ANSWER"), "second legacy chat lost its way in before PR 2");
});


test("a real turn credential cannot read bot settings, pair or remove its Telegram bot", async (t) => {
  const f = await fixture(t);
  f.tg.say("SETTINGS_GUARD");
  await waitFor(() => f.tg.sent().some((c) => c.body.text === "GUARDS [403,403,403,403]"), "an agent bearer reached owner-only Telegram settings");
  const status = await f.h.json(`/api/bots/${f.bot.id}/telegram`);
  assert.equal(status.configured, true);
  assert.equal(status.ownerPaired, true);
  assert.equal(status.pairing, null);
});
