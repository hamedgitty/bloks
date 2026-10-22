// Restricted history follows the sender and private/group/topic audience,
// including persisted legacy replies and recovery, at actual engine input.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { personFixture, LEE, until } from "./helpers/telegram-person.ts";

function newWords(record: any): string { return record.text.split("--- the new message ---").at(-1)!; }

test("fresh and recovered restricted history keeps distinct sent replies, legacy private history and topic audiences", async (t) => {
  const f = await personFixture(t, "claude");
  const group = (words: string, chat = -7001, topic = 9) => f.say("@PlanningBot " + words, LEE, {
    chat: { id: chat, type: "supergroup", title: chat === -7001 ? "Planning" : "Second group" },
    entities: [{ type: "mention", offset: 0, length: 12 }], is_topic_message: true, message_thread_id: topic,
  });
  const heard = async (words: string) => {
    const row = await until(() => f.records().find((r) => r.person && r.text && newWords(r).includes(words)), words + " did not reach restricted input");
    await f.idle(); return row;
  };
  await f.admit("PRIVATE_IN_SENTINEL FAKE_REPLY"); await f.idle();
  group("A9_IN_SENTINEL FAKE_REPLY"); await heard("A9_IN_SENTINEL");
  group("B9_IN_SENTINEL FAKE_REPLY", -7002); await heard("B9_IN_SENTINEL");
  group("A10_IN_SENTINEL FAKE_REPLY", -7001, 10); await heard("A10_IN_SENTINEL");
  // Simulate a stored pre-change reply with no audience metadata alongside
  // distinct current replies. Change only this stopped fixture's data.
  await f.reboot(() => {
    const file = join(f.root, ".bloks", `messages-${f.bot.threadId}.json`);
    const rows = JSON.parse(readFileSync(file, "utf8"));
    for (const row of rows) if (row.telegramSent) {
      const audience = row.telegramSent.audience;
      if (audience === "private") { row.text = "LEGACY_PRIVATE_SENTINEL"; delete row.telegramSent.audience; }
      else {
        const [, , chat, topic] = JSON.parse(audience);
        row.text = chat === -7002 ? "B9_SENT_SENTINEL" : topic === 10 ? "A10_SENT_SENTINEL" : "A9_SENT_SENTINEL";
      }
    }
    const member = rows.find((row: any) => row.telegramPerson)?.telegramPerson;
    rows.push({ id: "other-person-reply", at: Date.now(), role: "bot", kind: "text", text: "OTHER_PERSON_SENTINEL",
      telegramSent: { personId: "another-person", name: "Rex", audience: JSON.stringify([f.bot.id, member.bindingGeneration, -7001, 9]), state: "sent" } });
    writeFileSync(file, JSON.stringify(rows));
    const botsFile = join(f.root, ".bloks/bots.json"), bots = JSON.parse(readFileSync(botsFile, "utf8"));
    const lane = bots.find((b: any) => b.id === f.bot.id).tasks.find((l: any) => l.id === f.bot.threadId);
    lane.context = { summary: "OWNER_SUMMARY_SENTINEL", through: 0, at: Date.now() };
    lane.resumeCursors.claude = "OLD_PROVIDER_SESSION_SENTINEL";
    writeFileSync(botsFile, JSON.stringify(bots));
  });
  const cases = [
    { name: "A9", chat: -7001, topic: 9, keep: /A9_IN_SENTINEL[\s\S]*A9_SENT_SENTINEL/, exclude: /PRIVATE_IN_SENTINEL|LEGACY_PRIVATE_SENTINEL|B9_(?:IN|SENT)_SENTINEL|A10_(?:IN|SENT)_SENTINEL/ },
    { name: "B9", chat: -7002, topic: 9, keep: /B9_IN_SENTINEL[\s\S]*B9_SENT_SENTINEL/, exclude: /PRIVATE_IN_SENTINEL|LEGACY_PRIVATE_SENTINEL|A9_(?:IN|SENT)_SENTINEL|A10_(?:IN|SENT)_SENTINEL/ },
    { name: "A10", chat: -7001, topic: 10, keep: /A10_IN_SENTINEL[\s\S]*A10_SENT_SENTINEL/, exclude: /PRIVATE_IN_SENTINEL|LEGACY_PRIVATE_SENTINEL|A9_(?:IN|SENT)_SENTINEL|B9_(?:IN|SENT)_SENTINEL/ },
  ];
  for (const c of cases) {
    group(c.name + "_AFTER_RESTART FAKE_TEXT", c.chat, c.topic);
    const row = await heard(c.name + "_AFTER_RESTART");
    assert.match(row.text, c.keep); assert.doesNotMatch(row.text, c.exclude);
    assert.doesNotMatch(JSON.stringify(row), /OWNER_SUMMARY_SENTINEL|OLD_PROVIDER_SESSION_SENTINEL|OTHER_PERSON_SENTINEL/);
    assert.equal(row.args.includes("--resume"), false, "a restricted turn resumed old provider context");
  }
  f.say("PRIVATE_AFTER_RESTART FAKE_TEXT", LEE);
  const dm = await heard("PRIVATE_AFTER_RESTART");
  assert.match(dm.text, /PRIVATE_IN_SENTINEL/); assert.match(dm.text, /LEGACY_PRIVATE_SENTINEL/, "legacy private reply was lost");
  assert.doesNotMatch(dm.text, /[AB](?:9|10)_(?:IN|SENT)_SENTINEL|OWNER_SUMMARY_SENTINEL|OLD_PROVIDER_SESSION_SENTINEL/);

  await f.post(`/api/bots/${f.bot.id}/messages`, { text: "OWNER_RECOVERY_HOLD FAKE_HOLD" });
  await until(() => existsSync(join(f.root, "held")), "owner did not hold the queue");
  group("A9_RECOVERED_WORDS FAKE_TEXT");
  await until(async () => (await f.messages()).some((m) => m.queued && m.text?.includes("A9_RECOVERED_WORDS")), "group recovery words did not queue");
  await f.reboot(() => writeFileSync(join(f.root, "release"), "1"));
  const recovered = await heard("A9_RECOVERED_WORDS");
  assert.match(recovered.text, /A9_IN_SENTINEL/); assert.match(recovered.text, /A9_SENT_SENTINEL/);
  assert.match(recovered.text, /A9_AFTER_RESTART/, "another anchor incorrectly created a new history audience");
  assert.doesNotMatch(recovered.text, /PRIVATE_IN_SENTINEL|LEGACY_PRIVATE_SENTINEL|B9_(?:IN|SENT)_SENTINEL|A10_(?:IN|SENT)_SENTINEL|OWNER_SUMMARY_SENTINEL|OLD_PROVIDER_SESSION_SENTINEL|OWNER_RECOVERY_HOLD|OTHER_PERSON_SENTINEL/);
});
