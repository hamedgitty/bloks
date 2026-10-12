import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { decide, parseUpdates, send, type Incoming } from "../server/telegram.ts";
import { CardButtons } from "../server/telegram-cards.ts";
import { inboxState, migrateTelegram, ownerPairing, pairedChats, replaceTelegramToken, telegramStatus } from "../server/telegram-bots.ts";

const agents = [{ id: "sam" }, { id: "lee" }];
const legacy = { token: "12345:TEST_ONLY_TOKEN", botId: "sam", chatIds: [101, 202], offset: 17, enabled: true, pairing: "old-word" };
const incoming = (over: Partial<Incoming> = {}): Incoming => ({ chatId: 101, from: "Sam", fromId: 101, fromBot: false, chatType: "private", text: "hello", updateId: 18, ...over });

describe("an agent's Telegram bot", () => {
  test("a 2.6 upgrade retains both legacy chats, offset and explicit agent", () => {
    const next = migrateTelegram(legacy, agents);
    assert.equal(next.token, undefined);
    assert.equal(next.botId, undefined);
    assert.equal(next.pairing, undefined);
    assert.equal(next.migratedBotId, "sam");
    const bot = next.bots!.sam;
    assert.equal(bot.token, legacy.token);
    assert.equal(bot.offset, 17);
    assert.equal(bot.enabled, true);
    assert.deepEqual(bot.chatIds, [101, 202]);
    assert.equal(bot.pairing, null);
    assert.equal(bot.ownerUserId, undefined);
    assert.equal(decide(inboxState(bot), incoming()).kind, "deliver");
    assert.equal(decide(inboxState(bot), incoming({ chatId: 202, fromId: 202, from: "Lee" })).kind, "deliver");
    assert.equal(migrateTelegram(next, agents), next);
  });
  test("a deleted explicit agent is not silently replaced", () => {
    const next = migrateTelegram({ ...legacy, botId: "gone" }, agents);
    assert.deepEqual(next.bots, {});
    assert.equal(next.pending?.token, legacy.token);
    assert.deepEqual(next.pending?.chatIds, [101, 202]);
    assert.match(next.migrationError!, /no longer here/);
    assert.equal(migrateTelegram(next, agents), next);
  });
  test("only a missing explicit choice uses the old first-visible fallback", () => {
    const next = migrateTelegram({ ...legacy, botId: undefined }, [{ id: "hidden", hidden: true }, ...agents]);
    assert.equal(next.migratedBotId, "sam");
    assert.equal(next.bots!.hidden, undefined);
  });
  test("an existing agent binding is never overwritten by legacy migration", () => {
    const existing = replaceTelegramToken(undefined, "99999:OTHER_TEST_TOKEN", { id: 99999, username: "PlanningBot" });
    const next = migrateTelegram({ ...legacy, bots: { sam: existing } }, agents);
    assert.equal(next.bots!.sam, existing);
    assert.equal(next.pending?.token, legacy.token);
    assert.match(next.migrationError!, /already has/);
  });
  test("fresh owner pairing precedes legacy delivery and keeps Lee paired", () => {
    const bot = ownerPairing(migrateTelegram(legacy, agents).bots!.sam);
    const state = inboxState(bot);
    assert.equal(state.pairing?.length, 8);
    assert.notEqual(state.pairing, "old-word");
    assert.deepEqual(decide(state, incoming({ text: state.pairing! })), { kind: "pair", chatId: 101, userId: 101 });
    const paired = { ...bot, ownerUserId: 101, ownerChatId: 101, pairing: null };
    assert.deepEqual(pairedChats(paired), [101, 202]);
    assert.equal(decide(inboxState(paired), incoming({ chatId: 202, fromId: 202, from: "Lee" })).kind, "deliver");
    assert.equal(telegramStatus(paired).ownerPaired, true);
  });
  test("pairing proves a private human user id, never name or chat order", () => {
    const bot = ownerPairing(replaceTelegramToken(undefined, "12345:TEST_ONLY_TOKEN", { id: 12345, username: "PlanningBot" }));
    const said = incoming({ text: bot.pairing! });
    for (const over of [
      { fromId: undefined }, { fromId: Number.MAX_SAFE_INTEGER + 1 }, { fromId: -1 },
      { fromBot: true }, { fromBot: undefined }, { anonymous: true },
      { chatType: "group" as const }, { chatType: "channel" as const }, { chatType: undefined },
    ]) assert.equal(decide(inboxState(bot), { ...said, ...over }).kind, "ignore", JSON.stringify(over));
    assert.deepEqual(decide(inboxState(bot), { ...said, chatId: 303, fromId: 404, from: "Owner" }), { kind: "pair", chatId: 303, userId: 404 });
  });
  test("an unpaired new bot accepts no ordinary message or old word", () => {
    const bot = replaceTelegramToken(undefined, "12345:TEST_ONLY_TOKEN", { id: 12345, username: "PlanningBot" });
    assert.equal(decide(inboxState(bot), incoming()).kind, "refuse");
    assert.equal(decide(inboxState(bot), incoming({ text: "old-word" })).kind, "refuse");
    assert.equal(telegramStatus(bot).needsOwnerPairing, true);
  });
  test("a new binding delivers only the identified owner in their private chat", () => {
    const bot = { ...replaceTelegramToken(undefined, "12345:TEST_ONLY_TOKEN", { id: 12345, username: "PlanningBot" }), ownerUserId: 404, ownerChatId: 303 };
    assert.equal(decide(inboxState(bot), incoming({ fromId: 404, chatId: 303 })).kind, "deliver");
    assert.equal(decide(inboxState(bot), incoming({ fromId: 303, chatId: 303 })).kind, "refuse");
    assert.equal(decide(inboxState(bot), incoming({ fromId: 404, chatId: -303, chatType: "group" })).kind, "refuse");
  });
  test("tokens remain private in status, which distinguishes legacy chats", () => {
    const status = telegramStatus(migrateTelegram(legacy, agents).bots!.sam);
    assert.equal(status.legacyPaired, 2);
    assert.equal(status.ownerPaired, false);
    assert.equal(status.needsOwnerPairing, true);
    assert.equal(JSON.stringify(status).includes(legacy.token), false);
  });
  test("same-bot rotation keeps owner, legacy reach and offset but changes generation", () => {
    const first = { ...replaceTelegramToken(undefined, "12345:TEST_ONLY_TOKEN", { id: 12345, username: "PlanningBot" }), ownerUserId: 101, ownerChatId: 101, chatIds: [202], offset: 19 };
    const rotated = replaceTelegramToken(first, "12345:ROTATED_TEST_TOKEN", { id: 12345, username: "PlanningBot" });
    assert.notEqual(rotated.generation, first.generation);
    assert.equal(rotated.ownerUserId, 101);
    assert.equal(rotated.ownerChatId, 101);
    assert.equal(rotated.offset, 19);
    assert.deepEqual(rotated.chatIds, [202]);
  });
  test("replacement by a different bot clears owner and old chats", () => {
    const first = { ...replaceTelegramToken(undefined, "12345:TEST_ONLY_TOKEN", { id: 12345, username: "PlanningBot" }), ownerUserId: 101, ownerChatId: 101, chatIds: [202], offset: 19 };
    const next = replaceTelegramToken(first, "99999:OTHER_TEST_TOKEN", { id: 99999, username: "PlanningBot" });
    assert.equal(next.ownerUserId, undefined);
    assert.equal(next.ownerChatId, undefined);
    assert.equal(next.offset, 0);
    assert.deepEqual(next.chatIds, []);
    assert.equal(telegramStatus(next).needsOwnerPairing, true);
  });
  test("wire parsing keeps sender identity separate from chat and display name", () => {
    const [message] = parseUpdates({ result: [{ update_id: 1, message: { chat: { id: 303, type: "private" }, from: { id: 404, is_bot: false, first_name: "Sam" }, text: "hello" } }] });
    assert.equal(message.fromId, 404);
    assert.equal(message.chatId, 303);
    assert.equal(message.fromBot, false);
    assert.equal(message.chatType, "private");
    const [anonymous] = parseUpdates({ result: [{ update_id: 2, message: { chat: { id: -303, type: "supergroup" }, sender_chat: { id: -303 }, from: { id: 404, is_bot: false }, text: "hello" } }] });
    assert.equal(anonymous.anonymous, true);
  });
  test("a card cannot be consumed by another bot or transport generation", () => {
    const cards = new CardButtons();
    const forwarded = cards.forward({ requestId: "request", botId: "sam", generation: "first", chatId: 101, permission: true, options: ["Allow", "Deny"] });
    const token = forwarded.keyboard!.inline_keyboard[0][0].callback_data!;
    cards.sent("request", 5);
    assert.equal(cards.press(101, 5, token, Date.now(), { botId: "lee", generation: "first" }), null);
    assert.equal(cards.press(101, 5, token, Date.now(), { botId: "sam", generation: "later" }), null);
    const right = cards.press(101, 5, token, Date.now(), { botId: "sam", generation: "first" });
    assert.ok(right && "option" in right);
    assert.equal(right.option, "Allow");
  });
  test("a retired connection cannot send a remaining answer part", async (t) => {
    const previous = globalThis.fetch;
    let calls = 0;
    let active = true;
    globalThis.fetch = async () => { calls++; active = false; return new Response(JSON.stringify({ ok: true, result: { message_id: calls } }), { status: 200 }); };
    t.after(() => { globalThis.fetch = previous; });
    await assert.rejects(send("TEST", 101, "x".repeat(9_000), false, undefined, () => active), /connection changed/);
    assert.equal(calls, 1);
  });
});
