import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { parseUpdates } from "../server/telegram.ts";
import { addressedTelegramGroup, TelegramGroupMessages, telegramGroupDestination, telegramQuotedContext } from "../server/telegram-groups.ts";
import { knockTelegram, telegramAudience, telegramSender, telegramSenderCurrent, telegramOwnerGroupCurrent, type TelegramOwnerGroup } from "../server/telegram-people.ts";
import type { AgentTelegram } from "../server/telegram-bots.ts";

const bot = { telegramId: 12345, username: "PlanningBot" };
function incoming(extra: any = {}) {
  return parseUpdates({ ok: true, result: [{ update_id: 1, message: {
    message_id: 42, chat: { id: -7001, type: "supergroup", title: "Planning group" },
    from: { id: 20202, is_bot: false, first_name: "Lee" },
    text: "@PlanningBot hello", entities: [{ type: "mention", offset: 0, length: 12 }], ...extra,
  } }] })[0];
}

test("mentions use the whole original UTF16 slice, including leading spaces and emoji", () => {
  const m = incoming({ text: "  🟢 @pLaNnInGbOt hello", entities: [{ type: "mention", offset: 5, length: 12 }] });
  assert.equal(addressedTelegramGroup(m, bot), true);
  assert.equal(addressedTelegramGroup(incoming({ text: "@PlanningBotExtra", entities: [{ type: "mention", offset: 0, length: 17 }] }), bot), false);
  assert.equal(addressedTelegramGroup(incoming({ text: "@PlanningBot", entities: [] }), bot), false);
});

test("bad numeric spans and half a surrogate pair cannot address", () => {
  for (const entity of [
    { type: "mention", offset: -1, length: 12 }, { type: "mention", offset: 0.5, length: 12 },
    { type: "mention", offset: 0, length: 10000 }, { type: "text_mention", offset: 1, length: 1, user: { id: 12345 } },
  ]) assert.equal(addressedTelegramGroup(incoming({ text: "🟢 @PlanningBot", entities: [entity] }), bot), false);
});

test("a numeric text mention identifies the bot and captions keep their offsets", () => {
  assert.equal(addressedTelegramGroup(incoming({ entities: [{ type: "text_mention", offset: 0, length: 12, user: { id: 12345 } }] }), bot), true);
  assert.equal(addressedTelegramGroup(incoming({ entities: [{ type: "text_mention", offset: 0, length: 12, user: { id: 98765 } }] }), bot), false);
  assert.equal(addressedTelegramGroup(incoming({ text: undefined, caption: "  @PlanningBot", caption_entities: [{ type: "mention", offset: 2, length: 12 }], photo: [{ file_id: "synthetic-image", width: 1, height: 1 }] }), bot), true);
});

test("forwards, quotations and commands do not supply an outer address", () => {
  for (const change of [
    { forward_origin: { type: "user" } },
    { text: "hello", entities: [], quote: { text: "@PlanningBot", entities: [{ type: "mention", offset: 0, length: 12 }] } },
    { text: "hello", entities: [], external_reply: { origin: { type: "user", sender_user: { id: 12345 } } } },
    { text: "/go@PlanningBot", entities: [{ type: "bot_command", offset: 0, length: 15 }] },
    { text: "/go@PlanningBot", entities: [{ type: "mention", offset: 3, length: 12 }] },
  ]) assert.equal(addressedTelegramGroup(incoming(change), bot), false);
});

test("anonymous, automatically forwarded, bot and unsafe senders never address", () => {
  for (const change of [
    { sender_chat: { id: -7001 } }, { is_automatic_forward: true },
    { from: { id: 20202, is_bot: true } }, { from: { id: Number.MAX_SAFE_INTEGER + 1, is_bot: false } },
    { from: { id: 20202 } }, { chat: { id: -7001, type: "channel" } }, { message_id: -3 },
  ]) assert.equal(addressedTelegramGroup(incoming(change), bot), false);
});

test("a reply addresses only the actual bot in this chat, never a service post", () => {
  const reply = { message_id: 30, chat: { id: -7001 }, from: { id: 12345, first_name: "PlanningBot" }, text: "Bot answer" };
  assert.equal(addressedTelegramGroup(incoming({ text: "follow up", entities: [], reply_to_message: reply }), bot), true);
  for (const changed of [{ ...reply, from: { id: 55555 } }, { ...reply, chat: { id: -7002 } }, { ...reply, pinned_message: { message_id: 29 } }]) {
    assert.equal(addressedTelegramGroup(incoming({ text: "follow up", entities: [], reply_to_message: changed }), bot), false);
  }
});

test("ordinary bot invoices and newer content address while payment and checklist service posts do not", () => {
  const reply = { message_id: 30, chat: { id: -7001 }, from: { id: 12345, first_name: "PlanningBot" } };
  for (const field of ["rich_message", "paid_media", "checklist", "invoice", "giveaway", "giveaway_winners"]) {
    const message = incoming({ text: "follow up", entities: [], reply_to_message: { ...reply, [field]: {} } });
    assert.equal(addressedTelegramGroup(message, bot), true, `${field} was mistaken for a service message`);
    assert.match(telegramQuotedContext(message), /not downloaded or transcribed/);
  }
  for (const field of ["successful_payment", "refunded_payment", "chat_owner_changed", "checklist_tasks_done", "community_chat_joined", "managed_bot_created", "poll_option_added", "suggested_post_approved"]) {
    assert.equal(addressedTelegramGroup(incoming({ text: "follow up", entities: [], reply_to_message: { ...reply, text: "Synthetic service text", [field]: {} } }), bot), false, field);
  }
});

test("quoted media is a bounded description with its author, never a file address", () => {
  const text = telegramQuotedContext(incoming({ reply_to_message: { message_id: 30, chat: { id: -7001 }, from: { id: 30303, first_name: "Rex" }, text: "Their quoted words", photo: [{ file_id: "never-fetch-this-file", width: 1, height: 1 }] } }));
  assert.match(text, /Rex/); assert.match(text, /30303/); assert.match(text, /Their quoted words/);
  assert.match(text, /not downloaded or transcribed/); assert.ok(!text.includes("never-fetch-this-file"));
});

test("topics are carried only when Telegram identifies the addressing message as topical", () => {
  assert.equal(telegramGroupDestination(incoming({ is_topic_message: true, message_thread_id: 9 })).group!.threadId, 9);
  assert.equal(telegramGroupDestination(incoming({ message_thread_id: 9 })).group!.threadId, undefined);
});

test("an addressed album keeps all its parts and uses the last addressing anchor", async () => {
  const delivered: any[] = [];
  const messages = new TelegramGroupMessages(() => bot, async (parts, destination) => { delivered.push({ parts, destination }); }, 10000);
  await messages.take(incoming({ message_id: 41, text: undefined, caption: "first photo", caption_entities: [], media_group_id: "a", photo: [{ file_id: "one", width: 1, height: 1 }] }));
  await messages.take(incoming({ message_id: 42, text: undefined, caption: "@PlanningBot both", caption_entities: [{ type: "mention", offset: 0, length: 12 }], media_group_id: "a", is_topic_message: true, message_thread_id: 9, photo: [{ file_id: "two", width: 1, height: 1 }] }));
  assert.equal(delivered.length, 0);
  await messages.flush(); messages.close();
  assert.equal(delivered.length, 1); assert.equal(delivered[0].parts.length, 2);
  assert.equal(delivered[0].destination.messageId, 42); assert.equal(delivered[0].parts[0].messageId, 42);
  assert.equal(delivered[0].destination.group.threadId, 9);
});

test("albums with the same media id never borrow another sender's or chat's caption", async () => {
  const delivered: any[] = [];
  const messages = new TelegramGroupMessages(() => bot, async (parts) => { delivered.push(parts); }, 10000);
  const photo = { text: undefined, caption: "silent photo", caption_entities: [], media_group_id: "shared", photo: [{ file_id: "one", width: 1, height: 1 }] };
  await messages.take(incoming(photo));
  await messages.take(incoming({ ...photo, chat: { id: -7002, type: "group" } }));
  await messages.take(incoming({ ...photo, from: { id: 30303, is_bot: false, first_name: "Rex" }, caption: "@PlanningBot", caption_entities: [{ type: "mention", offset: 0, length: 12 }] }));
  await messages.flush(); messages.close();
  assert.equal(delivered.length, 1); assert.equal(delivered[0].length, 1); assert.equal(delivered[0][0].fromId, 30303);
});

test("a retired binding drops held albums without any delivery", async () => {
  let delivered = 0;
  const messages = new TelegramGroupMessages(() => bot, async () => { delivered++; }, 10000);
  await messages.take(incoming({ media_group_id: "a", photo: [{ file_id: "one", width: 1, height: 1 }] }));
  messages.close(); await messages.flush(); assert.equal(delivered, 0);
});

test("a group knock has no learned private chat and keeps its first topic and anchor", () => {
  const state: AgentTelegram = { generation: "g", token: "synthetic", enabled: true };
  const m = incoming({ is_topic_message: true, message_thread_id: 9 });
  const destination = telegramGroupDestination(m);
  const person = knockTelegram(state, m, destination).person!;
  assert.equal(person.chatId, undefined); assert.deepEqual(person.first!.destination, destination);
  state.people = { [String(person.userId)]: { ...person, state: "allowed" } };
  const sender = telegramSender("b", state, state.people[String(person.userId)], undefined, destination);
  assert.equal(telegramSenderCurrent(state, sender), true);
  assert.equal(telegramSenderCurrent({ ...state, generation: "changed" }, sender), false);
});

test("one person has one requester across destinations, with distinct queue audiences", () => {
  const state: AgentTelegram = { generation: "g", token: "synthetic", enabled: true };
  const person = knockTelegram(state, incoming(), telegramGroupDestination(incoming())).person!;
  const allowed = { ...person, state: "allowed" as const, chatId: 20202 };
  state.people = { "20202": allowed };
  const privateSender = telegramSender("b", state, allowed, 1);
  const groupSender = telegramSender("b", state, allowed, 42, telegramGroupDestination(incoming()));
  const otherGroup = { ...groupSender, chatId: -7002 };
  assert.equal(privateSender.requester, groupSender.requester);
  assert.equal(telegramAudience(privateSender), "private");
  assert.notEqual(telegramAudience(groupSender), telegramAudience(privateSender));
  assert.notEqual(telegramAudience(groupSender), telegramAudience(otherGroup));
  assert.equal(telegramSenderCurrent(state, groupSender), true);
});

test("old PR2 private requester hashes remain restricted and cannot authorize a group", () => {
  const state: AgentTelegram = { generation: "g", token: "synthetic", enabled: true };
  const person = { id: "p", userId: 20202, name: "Lee", chatId: 20202, state: "allowed" as const, grant: "grant" };
  state.people = { "20202": person };
  const old = { ...telegramSender("b", state, person, 1), requester: "telegram:" + createHash("sha256").update(JSON.stringify(["b", "g", "p", "grant", 20202])).digest("hex").slice(0, 32) };
  assert.equal(telegramSenderCurrent(state, old), true);
  assert.equal(telegramSenderCurrent(state, { ...old, ...telegramGroupDestination(incoming()) }), false);
});

test("an owner group return rechecks owner identity without inventing an admission", () => {
  const state: AgentTelegram = { generation: "g", token: "synthetic", enabled: true, ownerUserId: 10101, ownerChatId: 10101 };
  const target = telegramGroupDestination(incoming());
  const source: TelegramOwnerGroup = { ...target, group: target.group!, owner: true, botId: "b", bindingGeneration: "g", userId: 10101, name: "Sam", requester: "owner" };
  assert.equal(telegramOwnerGroupCurrent(state, source), true);
  assert.equal(state.people, undefined);
  assert.equal(telegramOwnerGroupCurrent({ ...state, ownerUserId: 40404 }, source), false);
  assert.equal(telegramOwnerGroupCurrent(state, { ...source, chatId: 10101 }), false);
});
