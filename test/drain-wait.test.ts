// The stored reason, not a guess by the app, explains an update queue.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DRAINING_TEXT } from "../server/drain.ts";
import { startHarness, type Harness } from "./helpers/server.ts";
import { agentOn, fakeProvider, idle, messagesOf, waitFor } from "./helpers/turns.ts";

const post = (text: string, extra: Record<string, unknown> = {}): RequestInit => ({
  method: "POST", body: JSON.stringify({ text, ...extra }),
});

test("a person's drain reason survives edits and restart, then clears on delivery", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "bloks-drain-wait-"));
  const fake = await fakeProvider(t);
  let h: Harness | undefined;
  t.after(async () => {
    await h?.stop();
    rmSync(home, { recursive: true, force: true, maxRetries: 5 });
  });
  h = await startHarness({ HOME: home });
  const bot = await agentOn(h, fake.port, "Ivy");
  await h.json("/api/maintenance/drain", { method: "POST" });
  const response = await h.json(`/api/bots/${bot.id}/messages`, post("BEFORE-EDIT", { waitsFor: "invented" }));
  assert.equal(response.queued, true);
  assert.match(response.note, /finishing what is running/);
  const queued = (await messagesOf(h, bot)).find((m) => m.text === "BEFORE-EDIT");
  assert.equal(queued.waitsFor, "restart", "the server did not store the drain reason");
  assert.equal(fake.sent("BEFORE-EDIT"), 0);
  const edited = await h.fetch(`/api/threads/${bot.threadId}/messages/${queued.id}`, {
    method: "PATCH", body: JSON.stringify({ text: "AFTER-EDIT", waitsFor: "invented" }),
  });
  assert.equal(edited.status, 200);
  const saved = JSON.parse(readFileSync(join(home, ".bloks", `messages-${bot.threadId}.json`), "utf8"));
  assert.equal(saved.find((m: any) => m.id === queued.id).waitsFor, "restart", "editing changed the server's reason");
  assert.equal(saved.find((m: any) => m.id === queued.id).queuedAt, queued.queuedAt);
  await h.stop();
  h = undefined;

  fake.state.answerAtOnce = true;
  h = await startHarness({ HOME: home });
  assert.ok(await waitFor(() => fake.sent("AFTER-EDIT") === 1), "the reloaded queue was not delivered");
  assert.ok(await idle(h, bot));
  const delivered = (await messagesOf(h, bot)).find((m) => m.id === queued.id);
  assert.equal(delivered.text, "AFTER-EDIT");
  assert.equal(delivered.queued, false);
  assert.equal(delivered.waitsFor, undefined, "the restart reason stayed on a delivered message");
  assert.equal(delivered.queuedAt, queued.queuedAt);
  assert.equal(delivered.at, delivered.deliveredAt);
  assert.equal(fake.sent("BEFORE-EDIT"), 0, "the original text was delivered instead of the edit");
  assert.equal(fake.sent("AFTER-EDIT"), 1);
});

test("a message queued during a drain keeps its reason when the busy turn ends, and clears it on cancellation", async (t) => {
  const fake = await fakeProvider(t);
  const h = await startHarness();
  t.after(() => h.stop());
  const bot = await agentOn(h, fake.port, "Ivy");
  await h.json(`/api/bots/${bot.id}/messages`, post("RUNNING"));
  assert.ok(await waitFor(() => fake.state.held.length === 1));
  await h.json("/api/maintenance/drain", { method: "POST" });
  await h.json(`/api/bots/${bot.id}/messages`, post("WAITS-FOR-RESTART"));
  const queued = (await messagesOf(h, bot)).find((m) => m.text === "WAITS-FOR-RESTART");
  assert.equal(queued.waitsFor, "restart", "a busy drain queue lost its reason");
  fake.state.held.shift()!();
  assert.ok(await idle(h, bot));
  const waiting = (await messagesOf(h, bot)).find((m) => m.id === queued.id);
  assert.equal(waiting.queued, true);
  assert.equal(waiting.waitsFor, "restart");
  assert.equal(fake.sent("WAITS-FOR-RESTART"), 0);
  fake.state.answerAtOnce = true;
  await h.json("/api/maintenance/drain", { method: "DELETE" });
  assert.ok(await waitFor(() => fake.sent("WAITS-FOR-RESTART") === 1));
  assert.ok(await idle(h, bot));
  const delivered = (await messagesOf(h, bot)).find((m) => m.id === queued.id);
  assert.equal(delivered.queued, false);
  assert.equal(delivered.waitsFor, undefined, "calling the drain off left a stale reason");
});

test("ordinary queues ignore client reasons on create and edit, and a webhook queue stays unmarked", async (t) => {
  const fake = await fakeProvider(t);
  const h = await startHarness();
  t.after(() => h.stop());
  const bot = await agentOn(h, fake.port, "Ivy");
  await h.json(`/api/bots/${bot.id}/messages`, post("RUNNING"));
  assert.ok(await waitFor(() => fake.state.held.length === 1));
  await h.json(`/api/bots/${bot.id}/messages`, post("ORDINARY-QUEUE", { waitsFor: "restart" }));
  const ordinary = (await messagesOf(h, bot)).find((m) => m.text === "ORDINARY-QUEUE");
  assert.equal(ordinary.queued, true);
  assert.equal(ordinary.waitsFor, undefined, "the client invented a restart reason");
  assert.equal((await h.fetch(`/api/threads/${bot.threadId}/messages/${ordinary.id}`, {
    method: "PATCH", body: JSON.stringify({ text: "ORDINARY-EDIT", waitsFor: "restart" }),
  })).status, 200);
  assert.equal((await messagesOf(h, bot)).find((m) => m.id === ordinary.id).waitsFor, undefined);

  const { webhook } = await h.json("/api/webhooks", {
    method: "POST", body: JSON.stringify({ name: "Build events", botId: bot.id, thread: "General" }),
  });
  await h.json("/api/maintenance/drain", { method: "POST" });
  assert.equal((await h.fetch(`/hook/${webhook.token}`, post("BACKGROUND-EVENT", { waitsFor: "restart" }))).status, 202);
  const background = (await messagesOf(h, bot)).find((m) => m.via === "webhook");
  assert.ok(background?.queued);
  assert.equal(background.waitsFor, undefined, "a background event gained the person's restart reason");
  fake.state.answerAtOnce = true;
  fake.state.held.shift()!();
  await h.json("/api/maintenance/drain", { method: "DELETE" });
  assert.ok(await waitFor(async () => (await messagesOf(h, bot)).filter((m) => m.queued).length === 0));
  assert.ok(await idle(h, bot));
});

test("calling off a drain clears its saved reason while the turn is still working, without marking an older queue", async (t) => {
  const fake = await fakeProvider(t);
  const h = await startHarness();
  t.after(() => h.stop());
  const bot = await agentOn(h, fake.port, "Ivy");
  await h.json(`/api/bots/${bot.id}/messages`, post("STILL-RUNNING"));
  assert.ok(await waitFor(() => fake.state.held.length === 1));
  await h.json(`/api/bots/${bot.id}/messages`, post("BEFORE-DRAIN"));
  const older = (await messagesOf(h, bot)).find((m) => m.text === "BEFORE-DRAIN");
  await h.json("/api/maintenance/drain", { method: "POST" });
  await h.json(`/api/bots/${bot.id}/messages`, post("CANCEL-WHILE-BUSY"));
  const marked = (await messagesOf(h, bot)).find((m) => m.text === "CANCEL-WHILE-BUSY");
  assert.equal(marked.waitsFor, "restart");
  assert.equal((await messagesOf(h, bot)).find((m) => m.id === older.id).waitsFor, undefined, "the drain marked an older queue");

  await h.json("/api/maintenance/drain", { method: "DELETE" });
  const waiting = (await messagesOf(h, bot)).find((m) => m.id === marked.id);
  assert.equal(waiting.waitsFor, undefined, "calling off a busy drain kept the restart reason");
  assert.equal(waiting.queued, true, "cancelling the drain delivered into a working turn");
  assert.equal(waiting.queuedAt, marked.queuedAt);
  assert.equal(fake.sent("CANCEL-WHILE-BUSY"), 0);
  assert.equal((await h.json("/api/bots")).bots.find((b: any) => b.id === bot.id).busy, true);
  const saved = JSON.parse(readFileSync(join(h.home, ".bloks", `messages-${bot.threadId}.json`), "utf8"));
  assert.equal(saved.find((m: any) => m.id === marked.id).waitsFor, undefined, "cancellation did not save the cleared reason");
  await h.json("/api/maintenance/drain", { method: "POST" });
  assert.equal((await messagesOf(h, bot)).find((m) => m.id === marked.id).waitsFor, undefined, "a later drain remarked old words");
  await h.json("/api/maintenance/drain", { method: "DELETE" });
  fake.state.answerAtOnce = true;
  fake.state.held.shift()!();
  assert.ok(await waitFor(() => fake.sent("CANCEL-WHILE-BUSY") === 1), "the released busy queue never delivered");
  assert.ok(await idle(h, bot));
  assert.equal(fake.sent("CANCEL-WHILE-BUSY"), 1);
});

test("an agent's say to a busy lane names the drain first but stays unmarked", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "bloks-drain-say-"));
  const cli = join(home, "fake-claude.mjs");
  mkdirSync(join(home, ".bloks"));
  writeFileSync(cli, `#!${process.execPath}
import { existsSync, readFileSync, writeFileSync } from "node:fs";
const home = ${JSON.stringify(home)};
if (process.argv[2] === "--version") { console.log("9.9.9 (Claude Code)"); process.exit(0); }
if (process.argv[2] === "auth") { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
let input = "";
process.stdin.on("data", async c => {
  input += c;
  if (!input.includes("\\n")) return;
  process.stdin.removeAllListeners("data");
  writeFileSync(home + "/ready", "ready");
  while (!existsSync(home + "/send.json")) await new Promise(r => setTimeout(r, 25));
  const { target, text } = JSON.parse(readFileSync(home + "/send.json", "utf8"));
  const response = await fetch(process.env.BLOKS_URL + "/api/bots/" + target + "/messages", {
    method: "POST", headers: { authorization: "Bearer " + process.env.BLOKS_TOKEN, "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  writeFileSync(home + "/reply.json", JSON.stringify({ status: response.status, body: await response.json() }));
  console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Done." }));
});
`, { mode: 0o755 });
  writeFileSync(join(home, ".bloks", "config.json"), JSON.stringify({ instances: { claude: { driver: "claudeAgent", config: { cli } } } }));
  const fake = await fakeProvider(t);
  const h = await startHarness({ HOME: home });
  t.after(async () => { await h.stop(); rmSync(home, { recursive: true, force: true }); });
  const target = await agentOn(h, fake.port, "Ivy");
  const { bot: sender } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Sender" }) });
  await h.json(`/api/bots/${sender.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } }) });
  await h.json(`/api/bots/${target.id}/messages`, post("BUSY-SAY-TARGET"));
  await h.json(`/api/bots/${sender.id}/messages`, post("Wait for the synthetic request"));
  assert.ok(await waitFor(() => existsSync(join(home, "ready")) && fake.state.held.length === 1));
  await h.json("/api/maintenance/drain", { method: "POST" });
  writeFileSync(join(home, "send.json"), JSON.stringify({ target: target.id, text: "AGENT-DRAIN-SAY" }));
  assert.ok(await waitFor(() => existsSync(join(home, "reply.json"))));
  const reply = JSON.parse(readFileSync(join(home, "reply.json"), "utf8"));
  assert.equal(reply.status, 202);
  assert.equal(reply.body.queued, true);
  assert.ok(reply.body.note.startsWith(DRAINING_TEXT), "the agent's busy say hid the drain reason");
  assert.ok(!reply.body.note.includes("waits until that turn ends"));
  const queued = (await messagesOf(h, target)).find((m) => m.text === "AGENT-DRAIN-SAY");
  assert.equal(queued.agent.peerId, sender.id);
  assert.equal(queued.waitsFor, undefined, "the agent gained the person's restart mark");
  fake.state.answerAtOnce = true;
  fake.state.held.shift()!();
  await h.json("/api/maintenance/drain", { method: "DELETE" });
  assert.ok(await idle(h, target));
});

test("a paired person's Telegram words store the restart reason and clear it before the busy turn ends", async (t) => {
  const updates: any[] = [], calls: Array<{ method: string; body: any }> = [];
  const telegram = createServer((req, res) => {
    let text = "";
    req.on("data", (c) => { text += c; });
    req.on("end", () => {
      const method = req.url!.split("/").pop()!, body = JSON.parse(text || "{}");
      calls.push({ method, body });
      const result = method === "getUpdates" ? updates.filter((u) => u.update_id >= body.offset)
        : method === "getMe" ? { username: "drain_fixture_bot" }
        : method === "sendMessage" ? { message_id: calls.length } : true;
      const reply = () => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ ok: true, result })); };
      if (method === "getUpdates") setTimeout(reply, 30); else reply();
    });
  });
  await new Promise<void>((resolve) => telegram.listen(0, "127.0.0.1", resolve));
  t.after(() => { telegram.closeAllConnections(); telegram.close(); });
  const fake = await fakeProvider(t);
  const preload = fileURLToPath(new URL("./helpers/telegram-fetch.mjs", import.meta.url));
  const h = await startHarness({ NODE_OPTIONS: `--import=${preload}`, BLOKS_TEST_TELEGRAM_URL: `http://127.0.0.1:${(telegram.address() as any).port}` });
  t.after(() => h.stop());
  const bot = await agentOn(h, fake.port, "Ivy");
  const paired = await h.json("/api/telegram", { method: "POST", body: JSON.stringify({ token: "12345:TEST_ONLY_TOKEN", enabled: true, botId: bot.id, pair: true }) });
  const say = (text: string) => { const id = updates.length + 1; updates.push({ update_id: id, message: { message_id: id, chat: { id: 4242 }, from: { id: 4242, first_name: "Test" }, text } }); };
  assert.ok(paired.pairing);
  say(paired.pairing);
  assert.ok(await waitFor(() => calls.some((c) => c.method === "sendMessage" && c.body.text.startsWith("Paired."))));
  await h.json(`/api/bots/${bot.id}/messages`, post("TELEGRAM-BUSY"));
  assert.ok(await waitFor(() => fake.state.held.length === 1));
  await h.json("/api/maintenance/drain", { method: "POST" });
  say("TELEGRAM-DRAIN-WORDS");
  const queued = await waitFor(async () => (await messagesOf(h, bot)).find((m) => m.text === "TELEGRAM-DRAIN-WORDS"));
  assert.ok(queued);
  assert.equal(queued.waitsFor, "restart", "the person's Telegram drain queue lost its reason");
  assert.equal(queued.queued, true);
  assert.equal(queued.telegramReply.chatId, 4242);
  const saved = JSON.parse(readFileSync(join(h.home, ".bloks", `messages-${bot.threadId}.json`), "utf8"));
  assert.equal(saved.find((m: any) => m.id === queued.id).waitsFor, "restart");
  assert.ok(await waitFor(() => calls.some((c) => c.method === "sendMessage" && c.body.text.startsWith("Your message is saved."))));
  await h.json("/api/maintenance/drain", { method: "DELETE" });
  const waiting = (await messagesOf(h, bot)).find((m) => m.id === queued.id);
  assert.equal(waiting.waitsFor, undefined, "Telegram's cancelled busy drain kept its reason");
  assert.equal(waiting.queued, true);
  assert.equal(waiting.telegramReply.chatId, 4242);
  fake.state.answerAtOnce = true;
  fake.state.held.shift()!();
  assert.ok(await waitFor(() => fake.sent("TELEGRAM-DRAIN-WORDS") === 1), "the released Telegram queue never delivered");
  assert.ok(await idle(h, bot));
  assert.equal(fake.sent("TELEGRAM-DRAIN-WORDS"), 1);
});
