// The app's private bulk Send now must not erase a queued Telegram audience.
// Real HTTP/store handlers and native protocols, with loopback-only providers.
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { personFixture, SAM, LEE, until } from "./helpers/telegram-person.ts";

const GROUP = -7001;
function group(f: Awaited<ReturnType<typeof personFixture>>, text: string) {
  return f.say(`@PlanningBot ${text}`, SAM, { chat: { id: GROUP, type: "supergroup", title: "Planning group" }, entities: [{ type: "mention", offset: 0, length: 12 }] });
}
function words(r: any): string { return r.text?.split("--- the new message ---").at(-1) ?? ""; }

test("bulk Send now keeps mixed owner group and private app requests in their own turns", async (t) => {
  const f = await personFixture(t, "codex");
  await f.post(`/api/bots/${f.bot.id}/messages`, { text: "PRIVATE_RUNNING_WORDS FAKE_HOLD" });
  await until(() => existsSync(join(f.root, "held")), "the private owner turn did not start");
  const anchor = group(f, "GROUP_WAITING_WORDS FAKE_REPLY");
  const waiting = await until(async () => (await f.messages()).find((m) => m.queued && m.telegramGroup && m.text?.includes("GROUP_WAITING_WORDS")), "the group did not queue");
  const onlyGroup = await f.post(`/api/bots/${f.bot.id}/queued/now`, { taskId: f.bot.threadId });
  assert.equal(onlyGroup.outcome, "nothing", "the private bulk action selected an owner group's words");
  await f.post(`/api/bots/${f.bot.id}/messages`, { text: "PRIVATE_WAITING_WORDS", delivery: "wait" });
  await until(async () => (await f.messages()).some((m) => m.queued && m.text === "PRIVATE_WAITING_WORDS"), "the app words did not queue");
  const sent = await f.post(`/api/bots/${f.bot.id}/queued/now`, { taskId: f.bot.threadId });
  // The earlier group row keeps FIFO priority, so the existing private
  // steer guard chooses Stop and drains each audience as its own turn.
  assert.equal(sent.outcome, "stopped");
  assert.equal(f.records().some((r) => JSON.stringify(r.steered ?? null).includes("GROUP_WAITING_WORDS")), false, "group words entered the active private turn");
  writeFileSync(join(f.root, "release"), "1");
  const turn = await until(() => f.records().find((r) => words(r).includes("GROUP_WAITING_WORDS")), "the group never got its own turn");
  assert.equal(turn.groupOwner, true); assert.match(turn.replyToken, /^blr_/);
  const privateTurn = await until(() => f.records().find((r) => words(r).includes("PRIVATE_WAITING_WORDS")), "the private words never got their own turn");
  assert.equal(privateTurn.groupOwner, false); assert.equal(privateTurn.replyToken, undefined);
  await f.idle();
  const rows = await f.messages(), groupRow = rows.find((m) => m.id === waiting.id), privateRows = rows.filter((m) => m.text === "PRIVATE_WAITING_WORDS");
  assert.deepEqual(groupRow.telegramGroup, waiting.telegramGroup); assert.equal(groupRow.queued, false); assert.equal(groupRow.midTurn, undefined);
  assert.equal(privateRows.length, 1); assert.equal(privateRows[0].queued, false); assert.equal(privateRows[0].midTurn, undefined);
  assert.equal(privateRows[0].telegramGroup, undefined);
  assert.equal(f.records().some((r) => JSON.stringify(r.steered ?? null).includes("PRIVATE_WAITING_WORDS")), false);
  const reply = f.sent(GROUP).filter((c) => c.body.text === "Hello Lee"); assert.equal(reply.length, 1);
  assert.deepEqual(reply[0].body.reply_parameters, { message_id: anchor });
});

test("bulk Send now stops an active owner group before delivering queued private app words in a private turn", async (t) => {
  const f = await personFixture(t, "codex");
  group(f, "GROUP_RUNNING_WORDS FAKE_HOLD");
  await until(() => existsSync(join(f.root, "held")), "the owner group did not start");
  await f.post(`/api/bots/${f.bot.id}/messages`, { text: "PRIVATE_AFTER_GROUP FAKE_TEXT", delivery: "wait" });
  const waiting = await until(async () => (await f.messages()).find((m) => m.queued && m.text === "PRIVATE_AFTER_GROUP FAKE_TEXT"), "the private app words did not queue");
  const result = await f.post(`/api/bots/${f.bot.id}/queued/now`, { taskId: f.bot.threadId });
  assert.equal(result.outcome, "stopped");
  const turn = await until(() => f.records().find((r) => words(r).includes("PRIVATE_AFTER_GROUP")), "the private words never got their own turn");
  assert.equal(turn.groupOwner, false); assert.equal(turn.replyToken, undefined); assert.match(turn.token, /^blk_/);
  assert.equal(f.records().some((r) => JSON.stringify(r.steered ?? null).includes("PRIVATE_AFTER_GROUP")), false, "private words were steered into the active group");
  await f.idle();
  const rows = (await f.messages()).filter((m) => m.id === waiting.id);
  assert.equal(rows.length, 1); assert.equal(rows[0].queued, false); assert.equal(rows[0].telegramGroup, undefined); assert.equal(rows[0].midTurn, undefined);
  assert.equal(f.sent(GROUP).some((c) => c.body.text === "Hello Lee" || c.body.text === "Owner answer." || c.body.text.includes("PRIVATE_AFTER_GROUP")), false);
});


test("bulk Send now leaves a full-access private delegate's queued request with its own sender", async (t) => {
  const f = await personFixture(t, "codex");
  const lee = await f.admit("INITIAL_MEMBER_WORDS FAKE_TEXT"); await f.idle();
  await f.post(`/api/bots/${f.bot.id}/telegram`, { personId: lee.id, action: "full" });
  await f.post(`/api/bots/${f.bot.id}/messages`, { text: "PRIVATE_OWNER_BARRIER FAKE_HOLD" });
  await until(() => existsSync(join(f.root, "held")), "the private owner turn did not start");
  f.say("DELEGATE_WAITING_WORDS FAKE_TEXT", LEE);
  const waiting = await until(async () => (await f.messages()).find((m) => m.queued && m.telegramDelegate && m.text?.includes("DELEGATE_WAITING_WORDS")), "the delegate did not queue");
  const result = await f.post(`/api/bots/${f.bot.id}/queued/now`, { taskId: f.bot.threadId });
  assert.equal(result.outcome, "nothing");
  assert.equal(f.records().some((r) => JSON.stringify(r.steered ?? null).includes("DELEGATE_WAITING_WORDS")), false);
  const retained = (await f.messages()).find((m) => m.id === waiting.id);
  assert.equal(retained.queued, true); assert.deepEqual(retained.telegramDelegate, waiting.telegramDelegate);
  writeFileSync(join(f.root, "release"), "1");
  const turn = await until(() => f.records().find((r) => words(r).includes("DELEGATE_WAITING_WORDS")), "the delegate never got its own turn");
  assert.equal(turn.person, false); assert.equal(turn.groupOwner, false);
  assert.match(turn.text, /The owner gave this person full access to you; they are not the owner/);
  await f.idle();
  await until(() => f.sent(LEE).some((c) => c.body.text === "Owner answer."), "the delegate answer never reached their private chat");
});
