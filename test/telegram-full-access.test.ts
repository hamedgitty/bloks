// A person the owner gives full access on an agent's Telegram bot
// (GitHub 320): their words run as the agent's own turns, on its own
// engine, answered and asked in their own chat, kept apart from the
// owner's, and taken back by the owner alone. Telegram is a loopback stub
// and the engine a fixture that speaks Codex's protocol, which a
// restricted person's turn is never allowed to run on.
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CHAT, STRANGER, agentTries, fixture, heardContext, inputWords, sleep, waitFor } from "./helpers/telegram-native.ts";
import { sameTelegramDelegate, telegramDelegateCurrent, telegramSender, type TelegramPerson } from "../server/telegram-people.ts";
import { telegramStatus, type AgentTelegram } from "../server/telegram-bots.ts";

type Fixture = Awaited<ReturnType<typeof fixture>>;

const people = async (f: Fixture) => (await f.h.json(`/api/bots/${f.bot.id}/telegram`)).people as any[];
const sentTo = (f: Fixture, chat: number) => f.tg.calls("sendMessage").filter((c) => c.body.chat_id === chat && !c.body.disable_notification);
const access = (f: Fixture, personId: string, action: string) => f.h.fetch(`/api/bots/${f.bot.id}/telegram`, { method: "POST", body: JSON.stringify({ personId, action }) });

/** Lee knocks and is let in. Their first words are a restricted turn,
 * which an agent on Codex holds, and they are told so once. */
async function letLeeIn(f: Fixture) {
  f.tg.say("Hello there", undefined, STRANGER);
  const lee = await waitFor(async () => (await people(f)).find((p) => p.name === "Lee"), "Lee never knocked");
  await f.post(`/api/bots/${f.bot.id}/telegram`, { personId: lee.id, action: "allow" });
  await waitFor(() => sentTo(f, STRANGER).some((c) => c.body.text.startsWith("This agent cannot answer from Telegram yet")), "the restricted first turn was not held");
  return lee;
}

async function giveLeeFullAccess(f: Fixture) {
  const lee = await letLeeIn(f);
  assert.equal(lee.full, undefined, "letting someone in gave them full access");
  const granted = await access(f, lee.id, "full");
  assert.equal(granted.status, 200, await granted.text());
  return lee;
}

test("a person given full access runs ordinary turns on the agent's engine, answered in their own chat", async (t) => {
  const f = await fixture(t);
  await giveLeeFullAccess(f);
  assert.equal((await people(f)).find((p) => p.name === "Lee").full, true);

  f.tg.say("What is the plan?", undefined, STRANGER);
  await waitFor(() => sentTo(f, STRANGER).some((c) => c.body.text === "ANSWER"), "the full-access turn never answered Lee");
  assert.equal(sentTo(f, CHAT).some((c) => c.body.text === "ANSWER"), false, "the owner's chat got Lee's answer");
  const row = (await f.messages()).find((m) => m.text === "What is the plan?");
  assert.equal(row.telegramDelegate?.name, "Lee");
  assert.equal(row.telegramPerson, undefined, "a full-access turn ran as a restricted one");
  // the agent hears whose words they are, though the turn has its tools
  const start = heardContext(f).find((c) => c.method === "turn/start" && inputWords(c).includes("What is the plan?"));
  assert.match(inputWords(start), /Message from "Lee" on Telegram\. The owner gave this person full access to you; they are not the owner\./);

  // and the owner's own chat goes on as before
  f.tg.say("Owner here");
  await waitFor(() => sentTo(f, CHAT).some((c) => c.body.text === "ANSWER"), "the owner's turn never answered");
  assert.equal(sentTo(f, STRANGER).filter((c) => c.body.text === "ANSWER").length, 1, "Lee got the owner's answer");
});

test("a full-access person's cards come to their chat, and only they answer them there", async (t) => {
  const f = await fixture(t);
  await giveLeeFullAccess(f);
  f.tg.say("APPROVE this", undefined, STRANGER);
  const card = await waitFor(() => f.tg.sent().find((m) => m.body.chat_id === STRANGER && m.body.text.startsWith("Approval needed")), "Lee's card never reached Lee");
  assert.equal(f.tg.sent().some((m) => m.body.chat_id === CHAT && m.body.text.startsWith("Approval needed")), false, "Lee's card went to the owner's phone");
  const allow = card.body.reply_markup.inline_keyboard[0][0].callback_data;
  // the owner tapping under Lee's message, from the owner's own chat
  f.tg.press(card.id, allow);
  await sleep(600);
  assert.equal(f.replies().length, 0, "a tap from another chat answered Lee's card");
  f.tg.press(card.id, allow, { chat: STRANGER, from: STRANGER });
  await waitFor(() => sentTo(f, STRANGER).some((c) => c.body.text === "DECIDED accept"), "Lee's own tap did not answer the card");
  assert.equal(f.replies()[0].result.decision, "accept");
});

test("a full-access turn asked again after a failure is still theirs: its card and its answer go to them", async (t) => {
  const f = await fixture(t);
  await giveLeeFullAccess(f);
  writeFileSync(join(f.root, "timeout-approval"), "1");
  f.tg.say("TIMEOUT_RETRY", undefined, STRANGER);
  await waitFor(() => existsSync(join(f.root, "timeout-retried")), "the first try never failed");
  const card = await waitFor(() => f.tg.sent().find((m) => m.body.text.startsWith("Approval needed")), "the retry raised no card");
  assert.equal(card.body.chat_id, STRANGER, "the retry's card went to someone else");
  f.tg.press(card.id, card.body.reply_markup.inline_keyboard[0][0].callback_data, { chat: STRANGER, from: STRANGER });
  await waitFor(() => existsSync(join(f.root, "timeout-card-answer")), "Lee's answer did not reach the retry");
  writeFileSync(join(f.root, "timeout-release"), "1");
  await waitFor(() => sentTo(f, STRANGER).some((c) => c.body.text === "REQUEST RESULT"), "the retry's answer never reached Lee");
  assert.equal(sentTo(f, CHAT).some((c) => c.body.text === "REQUEST RESULT"), false);
});

test("different senders take separate turns, and only the sender of the running one adds to it", async (t) => {
  const f = await fixture(t);
  await giveLeeFullAccess(f);
  f.tg.say("CTX_HOLD", undefined, STRANGER);
  await waitFor(() => existsSync(join(f.root, "ctx-started")), "Lee's turn never started");
  f.tg.say("Owner words while Lee works");
  await waitFor(async () => (await f.messages()).some((m) => m.text === "Owner words while Lee works" && m.queued), "the owner's words did not wait");
  f.tg.say("Lee adds a detail", undefined, STRANGER);
  await waitFor(() => heardContext(f).some((c) => c.method === "turn/steer" && inputWords(c).includes("Lee adds a detail")), "Lee's follow-up did not join Lee's turn");
  assert.equal(heardContext(f).some((c) => inputWords(c).includes("Owner words while Lee works") && c.method === "turn/steer"), false, "the owner's words joined Lee's turn");
  writeFileSync(join(f.root, "ctx-release"), "1");
  await waitFor(() => sentTo(f, STRANGER).some((c) => c.body.text === "CTX DONE"), "Lee's turn never answered Lee");
  await waitFor(() => sentTo(f, CHAT).some((c) => c.body.text === "ANSWER"), "the owner's words never got a turn of their own");
  assert.equal(sentTo(f, CHAT).some((c) => c.body.text === "CTX DONE"), false, "the owner got Lee's answer");
  assert.equal(sentTo(f, STRANGER).some((c) => c.body.text === "ANSWER"), false, "Lee got the owner's answer");
  // a turn of the owner's own, with the owner's words as the owner's
  const owner = heardContext(f).find((c) => c.method === "turn/start" && inputWords(c).includes("Owner words while Lee works"));
  assert.ok(owner, "the owner's words never started a turn");
  assert.doesNotMatch(inputWords(owner), /they are not the owner\.\)\s+Owner words/);
  assert.equal((await f.messages()).find((m) => m.text === "Owner words while Lee works").telegramDelegate, undefined);
});

test("taking full access back drops their waiting words, stops their turn and leaves them restricted", async (t) => {
  const f = await fixture(t);
  const lee = await giveLeeFullAccess(f);
  // waiting behind the owner's turn
  await f.post(`/api/bots/${f.bot.id}/messages`, { text: "CTX_HOLD" });
  await waitFor(() => existsSync(join(f.root, "ctx-started")), "the owner's turn never started");
  f.tg.say("Waiting words", undefined, STRANGER);
  await waitFor(async () => (await f.messages()).some((m) => m.text === "Waiting words" && m.queued), "Lee's words did not wait");
  assert.equal((await access(f, lee.id, "restricted")).status, 200);
  await waitFor(async () => (await f.messages()).some((m) => m.text === "Waiting words" && m.unsent && !m.queued), "Lee's waiting words were not dropped");
  writeFileSync(join(f.root, "ctx-release"), "1");
  await waitFor(async () => (await f.messages()).some((m) => m.text === "CTX DONE"), "the owner's turn never ended");

  // running, then taken back
  assert.equal((await access(f, lee.id, "full")).status, 200);
  f.tg.say("SCOPED_HOLD", undefined, STRANGER);
  await waitFor(() => existsSync(join(f.root, "SCOPED_HOLD-started")), "Lee's turn never started");
  const before = sentTo(f, STRANGER).length;
  assert.equal((await access(f, lee.id, "restricted")).status, 200);
  await waitFor(async () => !(await f.h.json("/api/bots?messages=0")).bots.find((b: any) => b.id === f.bot.id).busy, "Lee's turn was not stopped");
  await sleep(500);
  assert.equal(sentTo(f, STRANGER).length, before, "Lee was answered after their access was taken back");
  const now = (await people(f)).find((p) => p.id === lee.id);
  assert.equal(now.state, "allowed");
  assert.equal(now.full, undefined);
  // their next words are a restricted turn again, which Codex holds
  f.tg.say("Anything else?", undefined, STRANGER);
  await waitFor(async () => (await f.messages()).some((m) => m.text === "Anything else?" && m.telegramPerson && !m.telegramDelegate), "Lee was not restricted again");
});

test("only the owner gives full access, only to someone let in, and taking them out ends it", async (t) => {
  const f = await fixture(t);
  f.tg.say("Hello there", undefined, STRANGER);
  const lee = await waitFor(async () => (await people(f)).find((p) => p.name === "Lee"), "Lee never knocked");
  assert.equal((await access(f, lee.id, "full")).status, 409, "someone still waiting was given full access");
  assert.equal((await access(f, "nobody", "full")).status, 404);
  await f.post(`/api/bots/${f.bot.id}/telegram`, { personId: lee.id, action: "allow" });
  // the agent's own credential is refused, as for every Telegram setting
  assert.deepEqual(await agentTries(f, [["POST", `/api/bots/${f.bot.id}/telegram`, { personId: lee.id, action: "full" }]]), [403]);
  assert.equal((await people(f)).find((p) => p.id === lee.id).full, undefined);
  assert.equal((await access(f, lee.id, "full")).status, 200);
  assert.equal((await access(f, lee.id, "remove")).status, 200);
  assert.equal((await access(f, lee.id, "allow")).status, 200);
  assert.equal((await people(f)).find((p) => p.id === lee.id).full, undefined, "letting someone back in restored their full access");
});

test("a sender holds full access only under the grant it was given with", () => {
  const person: TelegramPerson = { id: "p1", userId: 20202, name: "Lee", chatId: 20202, state: "allowed", grant: "g1" };
  const state: AgentTelegram = { token: "12345:TEST", enabled: true, generation: "gen", people: { "20202": { ...person, full: true } } };
  const sender = telegramSender("bot", state, person);
  assert.equal(telegramDelegateCurrent(state, sender), true);
  assert.equal(telegramDelegateCurrent({ ...state, people: { "20202": { ...person } } }, sender), false, "restricted again");
  assert.equal(telegramDelegateCurrent({ ...state, people: { "20202": { ...person, full: true, grant: "g2" } } }, sender), false, "a new grant");
  const groupSender = telegramSender("agent", state, person, 4, { chatId: -7001, messageId: 4, group: { title: "Planning" } });
  assert.equal(telegramDelegateCurrent(state, groupSender), false, "a private full-access grant must not authorize group delegation");
  assert.equal(telegramDelegateCurrent({ ...state, generation: "other" }, sender), false, "another connection");
  assert.equal(sameTelegramDelegate(sender, { ...sender, messageId: 7 }), true);
  assert.equal(sameTelegramDelegate(sender, undefined), false);
  assert.equal(sameTelegramDelegate(undefined, undefined), true);
  assert.equal(telegramStatus(state).people[0].full, true);
  assert.equal(telegramStatus({ ...state, people: { "20202": { ...person, full: true, state: "removed" } } }).people[0].full, undefined);
});
