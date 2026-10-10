// Telegram that feels like the phone it is on: cards answered with a tap.
// Every server, engine and Telegram account here is an isolated fixture:
// Telegram is a stub on loopback and the engine is a script that speaks
// Codex's protocol.
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

interface Call { method: string; body: any; at: number }

/** Telegram, as far as this bot ever sees it. Files arrive as forms and
 * are kept as what they were called, what they said they were and how
 * big they were. */
async function telegramStub(t: TestContext) {
  const state = { updates: [] as any[], next: 1, calls: [] as Call[], messageId: 100 };
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", async () => {
      const raw = Buffer.concat(chunks);
      const method = req.url!.split("/").pop()!;
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
        return void setTimeout(() => reply(state.updates.filter((u) => u.update_id >= body.offset)), 30);
      }
      if (method !== "sendChatAction") state.calls.push({ method, body, at: Date.now() });
      if (method === "getMe") return reply({ username: "offline_test_bot" });
      if (["sendMessage", "sendPhoto", "sendDocument"].includes(method)) return reply({ message_id: ++state.messageId });
      reply(true);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return {
    state,
    url: `http://127.0.0.1:${(server.address() as any).port}`,
    say(text: string) {
      state.updates.push({ update_id: state.next++, message: { message_id: state.next, chat: { id: CHAT }, from: { id: CHAT, first_name: "Test" }, text } });
    },
    press(messageId: number, data: string, over: { chat?: number; from?: number } = {}) {
      state.updates.push({
        update_id: state.next++,
        callback_query: {
          id: `press-${state.next}`,
          from: { id: over.from ?? CHAT, first_name: "Test" },
          message: { message_id: messageId, chat: { id: over.chat ?? CHAT } },
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
 * words of its turn say: ask for approval, or ask a question. */
function fakeCodex(root: string): string {
  const cli = join(root, "fake-codex.mjs");
  writeFileSync(cli, `#!${process.execPath}
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
if (process.argv[2] === "--version") { console.log("codex-cli 0.160.0"); process.exit(0); }
if (process.argv[2] === "login") { console.log("Logged in using ChatGPT"); process.exit(0); }
const root = ${JSON.stringify(root)};
process.stdin.on("end", () => process.exit(0));
const out = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
const log = (m) => appendFileSync(root + "/calls.jsonl", JSON.stringify(m) + "\\n");
let thread, turn;
const waiting = new Map();
const ask = (id, method, params) => new Promise((resolve) => { waiting.set(id, resolve); out({ id, method, params: { threadId: thread, turnId: turn, ...params } }); });
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
  finish("ANSWER");
});
`, { mode: 0o755 });
  return cli;
}

async function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "bloks-telegram-native-"));
  mkdirSync(join(root, ".bloks"), { recursive: true });
  writeFileSync(join(root, ".bloks/config.json"), JSON.stringify({ instances: { codex: { driver: "codex", config: { cli: fakeCodex(root) } } } }));
  const tg = await telegramStub(t);
  const h = await startHarness({
    HOME: root, NODE_OPTIONS: `--import=${preload}`, BLOKS_TEST_TELEGRAM_URL: tg.url,
    OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "", ELEVENLABS_API_KEY: "",
  });
  t.after(async () => { await h.crash(); rmSync(root, { recursive: true, force: true }); });
  const post = (path: string, body: unknown = {}) => h.json(path, { method: "POST", body: JSON.stringify(body) });
  const { bot } = await post("/api/bots", { name: "Rex" });
  await h.json(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" } }) });
  const paired = await post("/api/telegram", { token: "12345:TEST_ONLY_TOKEN", enabled: true, botId: bot.id, pair: true });
  assert.ok(paired.pairing, JSON.stringify(paired));
  tg.say(paired.pairing);
  await waitFor(() => tg.calls("sendMessage").some((c) => c.body.text.startsWith("Paired.")), "the stub chat never paired");
  const replies = (): any[] => existsSync(join(root, "calls.jsonl"))
    ? readFileSync(join(root, "calls.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((c) => c.reply)
    : [];
  const messages = async () => (await h.json(`/api/bots/${bot.id}/messages?thread=${bot.threadId}&limit=500`)).messages as any[];
  return { root, tg, h, bot, post, replies, messages };
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

test("a button from before a restart says its card has closed, and loses its buttons", async (t) => {
  const f = await fixture(t);
  f.tg.press(55, "AAAAAAAA:0");
  const told = await waitFor(() => f.tg.calls("answerCallbackQuery")[0], "the press was never answered");
  assert.equal(told.body.text, "That card has already closed.");
  const cleared = await waitFor(() => f.tg.calls("editMessageReplyMarkup")[0], "its buttons were left in place");
  assert.deepEqual(cleared.body, { chat_id: CHAT, message_id: 55, reply_markup: { inline_keyboard: [] } });
});
