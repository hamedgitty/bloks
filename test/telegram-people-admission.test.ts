import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { LEE, SAM, nap, personFixture, until } from "./helpers/telegram-person.ts";
import { TELEGRAM_PEOPLE_UPGRADE } from "../server/telegram-people.ts";

// Who reaches an agent's Telegram bot, and how they are named: knocks,
// the owner's card, the upgrade from paired chats, and the engines that
// hold a person's turn. The turns themselves are in
// telegram-people-native.test.ts.

test("unknown and hostile senders cannot start a turn or fetch media; decline is told once", async (t) => {
  const f = await personFixture(t);
  for (const extra of [{ from: { id: LEE, is_bot: true, first_name: "Lee" } }, { from: {} }, { sender_chat: { id: LEE } }, { chat: { id: -123, type: "group" } }]) f.say("FAKE_REPLY", LEE, extra);
  await nap(250);
  assert.equal((await f.status()).people.length, 0); assert.equal(f.records().length, 0);
  f.say("voice", LEE, { voice: { file_id: "unknown-file", file_size: 20 } });
  const person = await until(async () => (await f.status()).people[0], "there was no knock");
  assert.equal(f.calls.some((c) => c.method === "getFile"), false);
  await f.post(`/api/bots/${f.bot.id}/telegram`, { personId: person.id, action: "decline" });
  f.say("again", LEE); f.say("again", LEE); await nap(150);
  assert.equal(f.sent(LEE).filter((m) => m.body.text.startsWith("Not now.")).length, 1);
  assert.equal(f.records().length, 0);
});

for (const prior of ["2.6", "agent-bot"]) {
  test(`the ${prior} two-chat upgrade notices both chats once and makes the other person knock`, async (t) => {
    const f = await personFixture(t);
    await f.flushed();
    await f.reboot(() => {
      const file = join(f.root, ".bloks/config.json"), cfg = JSON.parse(readFileSync(file, "utf8"));
      const state = cfg.telegram.bots[f.bot.id];
      cfg.telegram = prior === "2.6"
        ? { token: state.token, enabled: true, botId: f.bot.id, chatIds: [SAM, LEE], offset: state.offset, pairing: "old-word" }
        : { version: 1, bots: { [f.bot.id]: { ...state, chatIds: [SAM, LEE] } } };
      writeFileSync(file, JSON.stringify(cfg));
    });
    await until(() => f.sent(SAM).some((m) => m.body.text === TELEGRAM_PEOPLE_UPGRADE) && f.sent(LEE).some((m) => m.body.text === TELEGRAM_PEOPLE_UPGRADE), "an old chat was not told");
    assert.equal((await f.status()).legacyPaired, 0);
    assert.equal((await f.messages()).filter((m) => m.kind === "notice" && m.text === TELEGRAM_PEOPLE_UPGRADE).length, 1);
    f.say("FAKE_TEXT", LEE); await f.flushed();
    const person = (await f.status()).people.find((p: any) => p.name === "Lee");
    assert.equal(person.state, "pending"); assert.equal(f.records().length, 0);
    if (prior === "2.6") {
      assert.equal((await f.status()).ownerPaired, false);
      const pair = await f.post(`/api/bots/${f.bot.id}/telegram`, { pair: true });
      assert.notEqual(pair.pairing, "old-word"); f.say(pair.pairing); await f.flushed();
    }
    await f.post(`/api/bots/${f.bot.id}/telegram`, { personId: person.id, action: "allow" });
    await until(() => f.records().some((r) => r.person), "the old chat had no way in"); await f.idle();
    assert.equal(f.records().filter((r) => r.person).length, 1);
    await f.reboot(); await f.flushed();
    for (const chat of [SAM, LEE]) assert.equal(f.sent(chat).filter((m) => m.body.text === TELEGRAM_PEOPLE_UPGRADE).length, 1);
    assert.equal((await f.messages()).filter((m) => m.kind === "notice" && m.text === TELEGRAM_PEOPLE_UPGRADE).length, 1);
  });
}

test("upgrade sends interrupted or unconfirmed by transport stay uncertain and are not replayed", async (t) => {
  const f = await personFixture(t); await f.flushed();
  f.sendFailures.set(TELEGRAM_PEOPLE_UPGRADE, "disconnect");
  await f.reboot(() => {
    const file = join(f.root, ".bloks/config.json"), cfg = JSON.parse(readFileSync(file, "utf8"));
    cfg.telegram.version = 2;
    cfg.telegram.bots[f.bot.id].upgradeNotices = [{ chatId: SAM, state: "sending" }, { chatId: LEE, state: "pending" }];
    writeFileSync(file, JSON.stringify(cfg));
  });
  await until(async () => (await f.status()).upgradeNotices.every((n: any) => n.state === "uncertain"), "dispatch was not marked uncertain");
  assert.equal(f.sent(SAM).filter((m) => m.body.text === TELEGRAM_PEOPLE_UPGRADE).length, 0);
  // The notice can be marked uncertain before the fake server has logged
  // the send that broke, so wait for the log rather than read it once.
  await until(() => f.sent(LEE).some((m) => m.body.text === TELEGRAM_PEOPLE_UPGRADE), "the pending notice was never tried");
  assert.equal(f.sent(LEE).filter((m) => m.body.text === TELEGRAM_PEOPLE_UPGRADE).length, 1);
  await f.reboot(); await f.flushed();
  assert.equal(f.sent(LEE).filter((m) => m.body.text === TELEGRAM_PEOPLE_UPGRADE).length, 1);
});

test("codex: a person's turn is held before any engine starts, and the owner is told why", async (t) => {
  const f = await personFixture(t, "codex");
  await f.admit("CODEX_PERSON_WORDS FAKE_REPLY");
  await until(() => f.sent(LEE).some((m) => m.body.text.startsWith("This agent cannot answer")), "the person was left in silence");
  await f.idle();
  assert.equal(f.records().length, 0, "Codex heard the person's words");
  const notice = (await f.messages()).find((m) => m.kind === "notice" && /held:/.test(m.text ?? ""));
  assert.match(notice.text, /Codex.*any file on this computer.*Claude Code/s);
  // the reason stays in the owner's chat; the person gets the neutral line
  assert.equal(f.sent(LEE).some((m) => /Codex|file/.test(m.body.text)), false);
  f.say("CODEX_AGAIN FAKE_REPLY", LEE); await f.flushed(); await f.idle();
  assert.equal(f.records().length, 0);
  assert.equal(f.sent(LEE).filter((m) => m.body.text.startsWith("This agent cannot answer")).length, 1);
});

test("recall names a person's words as theirs, never the owner's", async (t) => {
  const f = await personFixture(t);
  await f.admit("PINEAPPLE ORCHARD harvest FAKE_TEXT");
  await until(() => f.records().some((r) => r.person), "the person's turn did not run"); await f.idle();
  const { hits } = await f.ownerJson(`/api/bots/${f.bot.id}/recall?q=${encodeURIComponent("pineapple orchard")}`);
  const hit = hits.find((h: any) => /PINEAPPLE ORCHARD/.test(h.text));
  assert.ok(hit, "recall did not find the person's words");
  assert.equal(hit.by, "telegram");
  assert.equal(hit.who, "Lee (Telegram)");
});

test("the admission card says who is knocking beyond a first name, and marks a namesake", async (t) => {
  const f = await personFixture(t);
  f.say("Hello from the first Lee", LEE, { from: { id: LEE, is_bot: false, first_name: "Lee\u202e", username: "lee_writes" } });
  const first = await until(async () => (await f.status()).people.find((p: any) => p.userId === LEE), "the first Lee did not knock");
  assert.equal(first.name, "Lee", "a reordering mark survived in the name");
  assert.equal(first.username, "lee_writes");
  assert.equal(first.first, "Hello from the first Lee");
  const card = await until(async () => (await f.messages()).find((m) => m.card?.requestId === `tg-person:${first.id}`), "there was no card");
  assert.match(card.card.subtitle, /@lee_writes, Telegram id 20202/);
  assert.match(card.card.subtitle, /Hello from the first Lee/);
  const OTHER = 30303;
  f.say("Hello, I am Lee too", OTHER, { from: { id: OTHER, is_bot: false, first_name: "Lee" } });
  const second = await until(async () => (await f.status()).people.find((p: any) => p.userId === OTHER), "the second Lee did not knock");
  assert.equal(second.sameName, true);
  assert.equal((await f.status()).people.find((p: any) => p.userId === LEE).sameName, true);
  const other = await until(async () => (await f.messages()).find((m) => m.card?.requestId === `tg-person:${second.id}`), "there was no second card");
  assert.match(other.card.subtitle, /Someone else here is also called Lee \(@lee_writes, Telegram id 20202\)/);
  assert.match(other.card.subtitle, /Telegram id 30303/);
  const forwarded = await until(() => f.sent(SAM).find((m) => m.body.text.includes("Telegram id 30303")), "the owner's Telegram card did not name the id");
  assert.match(forwarded.body.text, /also called Lee/);
  // the owner's Telegram card is rewritten in the app's words, once
  // Telegram has said which message it is
  const saved = () => JSON.parse(readFileSync(join(f.root, ".bloks/config.json"), "utf8")).telegram.bots[f.bot.id].people[String(OTHER)];
  await until(() => saved()?.telegramCardId, "the card's Telegram message was not kept");
  await f.post(`/api/bots/${f.bot.id}/telegram`, { personId: second.id, action: "decline" });
  await until(() => f.calls.some((c) => c.method === "editMessageText" && /Lee \(Telegram id 30303\): not now\./.test(c.body.text)), "the Telegram card was not rewritten as the app says it");
});
