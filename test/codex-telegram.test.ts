import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import { codexCommands, waitFor } from "./helpers/codex-commands.ts";

const preload = new URL("./helpers/telegram-fetch.mjs", import.meta.url).href;
const entry = new URL("../server/index.ts", import.meta.url);
const CHAT = 10101;

async function fixture(t: TestContext) {
  const updates: any[] = [], sends: any[] = [];
  let next = 1;
  const server = createServer((req, res) => {
    let raw = ""; req.on("data", (part) => raw += part);
    req.on("end", () => {
      const body = JSON.parse(raw || "{}"); res.setHeader("content-type", "application/json");
      const reply = (result: unknown) => res.end(JSON.stringify({ ok: true, result }));
      if (req.url?.endsWith("getMe")) return reply({ username: "offline_test" });
      if (req.url?.endsWith("getUpdates")) return void setTimeout(() => reply(updates.filter((u) => u.update_id >= body.offset)), 30);
      if (req.url?.endsWith("sendMessage")) { sends.push(body); return reply({ message_id: sends.length }); }
      return reply(true);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${(server.address() as any).port}`;
  const env = { NODE_OPTIONS: `--import=${preload}`, BLOKS_TEST_TELEGRAM_URL: url };
  const s = await codexCommands(t, env);
  const push = (text: string) => updates.push({ update_id: next++, message: { message_id: next, chat: { id: CHAT }, from: { first_name: "Test" }, text } });
  const paired = await s.post("/api/telegram", { token: "12345:TEST_ONLY", enabled: true, botId: s.bot.id, pair: true });
  assert.ok(paired.pairing); push(paired.pairing);
  await waitFor(() => sends.some((m) => m.text.startsWith("Paired.")));
  const answers = () => sends.filter((m) => !m.text.startsWith("Paired.") && !m.text.startsWith("Your message is saved."));
  return { ...s, get h() { return s.h; }, push, sends, answers, async queue(text: string) {
    const before = sends.length; push(text);
    await waitFor(() => sends.slice(before).some((m) => m.text.startsWith("Your message is saved.")));
  }, async stoppedBeforeRecovery() {
    await s.h.crash();
    const child = spawn(process.execPath, [fileURLToPath(entry)], { env: { ...process.env, ...env, HOME: s.root, USERPROFILE: s.root, BLOKS_PORT: "0", BLOKS_TEST_STOP_BEFORE_RECOVERY: "1", OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "", ELEVENLABS_API_KEY: "", XAI_API_KEY: "", GEMINI_API_KEY: "", COMPOSIO_KEY: "", BOX_TOKEN: "", BLOKS_LOOPBACK_ONLY: "", PATH: "/nonexistent", npm_config_prefix: "", PREFIX: "" }, stdio: ["ignore", "pipe", "pipe"] });
    let output = ""; child.stdout?.on("data", (chunk) => output += chunk); child.stderr?.resume();
    t.after(() => child.kill("SIGKILL"));
    await waitFor(() => output.includes("bloks server on http://"));
    const gone = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGKILL"); await gone;
  } };
}

test("the owner's Telegram skill words reach turn/start as a named item", async (t) => {
  const s = await fixture(t); s.push("PHONE $selected");
  await waitFor(() => s.answers().length === 1); await s.settled();
  const input = s.calls().find((c) => c.method === "turn/start").params.input;
  assert.deepEqual(input.filter((i: any) => i.type === "skill").map((i: any) => i.name), ["selected"]);
  assert.equal(s.answers()[0].chat_id, CHAT);
});

test("drain holds words and compact through restart with one return each", async (t) => {
  const s = await fixture(t); await s.turn("warm session");
  await s.post("/api/maintenance/drain", { seconds: 60 });
  await s.queue("DRAIN $selected"); await s.queue("/compact");
  await s.reboot(); await waitFor(() => s.answers().length === 2); await s.settled();
  const turns = s.calls().filter((c) => c.method === "turn/start");
  assert.equal(turns.length, 2);
  assert.deepEqual(turns[1].params.input.filter((i: any) => i.type === "skill").map((i: any) => i.name), ["selected"]);
  assert.equal(s.calls().filter((c) => c.method === "thread/compact/start").length, 1);
  assert.ok(s.answers().every((m) => m.chat_id === CHAT));
  await s.reboot(); await s.settled();
  assert.equal(s.answers().length, 2);
});

test("a second startup before dispatch retains the native command return", { skip: process.platform === "win32" }, async (t) => {
  const s = await fixture(t); await s.turn("warm session");
  await s.post("/api/maintenance/drain", { seconds: 60 }); await s.queue("/compact");
  await s.stoppedBeforeRecovery(); assert.equal(s.answers().length, 0);
  await s.reboot(); await waitFor(() => s.answers().length === 1); await s.settled();
  assert.equal(s.calls().filter((c) => c.method === "thread/compact/start").length, 1);
  assert.equal(s.calls().filter((c) => c.method === "turn/start").length, 1);
});

test("a cut-off pickup takes only its ordinary Telegram segment before compact's own return", async (t) => {
  const s = await fixture(t); await s.turn("warm session");
  await s.say("HOLD"); await waitFor(() => s.calls().filter((c) => c.method === "turn/start").length === 2);
  await s.post("/api/maintenance/drain", { seconds: 60 });
  await s.queue("PICKUP $selected"); await s.queue("/compact");
  await s.reboot(); await waitFor(() => s.answers().length === 2); await s.settled();
  const turns = s.calls().filter((c) => c.method === "turn/start");
  assert.equal(turns.length, 3);
  assert.deepEqual(turns[2].params.input.filter((i: any) => i.type === "skill").map((i: any) => i.name), ["selected"]);
  assert.equal(s.calls().filter((c) => c.method === "thread/compact/start").length, 1);
  assert.equal((await s.messages()).filter((m) => m.telegramReply?.state === "sent").length, 2);
});
