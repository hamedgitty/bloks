// Private full access never widens an addressed group's trust or return scope.
// Real HTTP/store handlers and native protocols, isolated loopback providers only.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { personFixture, until, SAM, LEE } from "./helpers/telegram-person.ts";

type Fixture = Awaited<ReturnType<typeof personFixture>>;
const GROUP = -7001;
function group(f: Fixture, text: string, extra: any = {}) {
  return f.say(`@PlanningBot ${text}`, LEE, { chat: { id: GROUP, type: "supergroup", title: "Planning group" }, entities: [{ type: "mention", offset: 0, length: 12 }], ...extra });
}
function words(record: any): string { return record.text?.split("--- the new message ---").at(-1) ?? ""; }
const access = (f: Fixture, personId: string, action: string) => f.post(`/api/bots/${f.bot.id}/telegram`, { personId, action });
async function admitted(f: Fixture) { const lee = await f.admit("INITIAL_WORDS FAKE_TEXT"); await f.idle(); return lee; }
async function record(f: Fixture, marker: string) { return until(() => f.records().find((r) => words(r).includes(marker)), `${marker} did not reach an engine`); }
async function stored(f: Fixture, marker: string) { return until(async () => (await f.messages()).find((m) => m.text?.includes(marker)), `${marker} was not stored`); }
function restricted(r: any) {
  assert.equal(r.person, true); assert.equal(r.groupOwner, false); assert.match(r.token, /^blr_/);
  assert.ok(r.args.includes("--setting-sources")); assert.ok(r.args.includes("--no-session-persistence"));
  assert.doesNotMatch(r.system, /Deliverables:|persistent memory|Shared memory/);
}

for (const kind of ["claude", "codex"] as const) test(`${kind}: alternating full-access private and group requests retains separate trust and cards`, async (t) => {
  const f = await personFixture(t, kind), lee = await admitted(f);
  await access(f, lee.id, "full");
  f.say("PRIVATE_CARD_WORDS FAKE_QUESTION", LEE);
  const privateTurn = await record(f, "PRIVATE_CARD_WORDS");
  assert.equal(privateTurn.person, false); assert.equal(privateTurn.groupOwner, false); assert.match(privateTurn.token, /^blk_/);
  const card = await until(() => f.sent(LEE).find((c) => c.body.text.includes("Which day?")), "the delegate question did not reach its private chat");
  assert.ok(card); assert.equal(f.sent(SAM).some((c) => c.body.text.includes("Which day?")), false);
  assert.equal(f.sent(GROUP).some((c) => c.body.reply_markup), false);
  f.say("Tuesday", LEE);
  await until(() => f.records().some((r) => r.questionAnswer), "the private delegate could not answer their card");
  await f.idle();
  const privateRow = await stored(f, "PRIVATE_CARD_WORDS");
  assert.equal(privateRow.telegramDelegate?.personId, lee.id); assert.equal(privateRow.telegramPerson, undefined);

  const anchor = group(f, "GROUP_AFTER_PRIVATE FAKE_REPLY");
  const groupRow = await stored(f, "GROUP_AFTER_PRIVATE");
  assert.equal(groupRow.telegramPerson?.personId, lee.id); assert.equal(groupRow.telegramDelegate, undefined);
  if (kind === "claude") {
    const groupTurn = await record(f, "GROUP_AFTER_PRIVATE"); restricted(groupTurn);
    const sent = await until(() => f.sent(GROUP).find((c) => c.body.text === "Hello Lee"), "the restricted group reply did not arrive");
    assert.deepEqual(sent.body.reply_parameters, { message_id: anchor });
    await f.idle();
    const late = await f.h.fetch(`/api/bots/${f.bot.id}/telegram/reply`, { method: "POST", headers: { authorization: `Bearer ${groupTurn.token}` }, body: JSON.stringify({ text: "LATE_GROUP_REPLY" }) });
    assert.equal(late.status, 403, "a completed restricted group retained reply authority");
    assert.equal(f.sent(GROUP).some((c) => c.body.text === "LATE_GROUP_REPLY"), false);
  } else {
    const held = await until(() => f.sent(GROUP).find((c) => c.body.text.includes("cannot answer from Telegram")), "Codex did not hold the group request");
    assert.deepEqual(held.body.reply_parameters, { message_id: anchor });
    assert.equal(f.records().some((r) => words(r).includes("GROUP_AFTER_PRIVATE")), false);
  }
  await f.idle();
  f.say("PRIVATE_AFTER_GROUP FAKE_TEXT", LEE);
  const last = await record(f, "PRIVATE_AFTER_GROUP"); await f.idle();
  assert.equal(last.person, false); assert.equal(last.groupOwner, false); assert.match(last.token, /^blk_/);
  const row = await stored(f, "PRIVATE_AFTER_GROUP"); assert.equal(row.telegramDelegate?.personId, lee.id); assert.equal(row.telegramPerson, undefined);
  assert.equal(f.sent(GROUP).some((c) => c.body.text === "Owner answer." || c.body.reply_markup), false);
});

test("taking full access back drops queued private and group work under the old grant", async (t) => {
  const f = await personFixture(t), lee = await admitted(f); await access(f, lee.id, "full");
  // Prime the cached full-access inbox, then block the lane with owner work.
  f.say("CACHE_FULL_INBOX FAKE_TEXT", LEE); await record(f, "CACHE_FULL_INBOX"); await f.idle();
  await f.post(`/api/bots/${f.bot.id}/messages`, { text: "OWNER_BARRIER FAKE_HOLD" });
  await until(() => existsSync(join(f.root, "held")), "the owner barrier did not start");
  f.say("QUEUED_FULL_PRIVATE FAKE_TEXT", LEE); group(f, "QUEUED_RESTRICTED_GROUP FAKE_REPLY");
  const queued = await until(async () => {
    const rows = (await f.messages()).filter((m) => /QUEUED_FULL_PRIVATE|QUEUED_RESTRICTED_GROUP/.test(m.text ?? "") && m.queued);
    return rows.length === 2 && rows;
  }, "both audiences did not queue");
  assert.ok(queued.some((m: any) => m.telegramDelegate)); assert.ok(queued.some((m: any) => m.telegramPerson?.group));
  await access(f, lee.id, "restricted");
  await until(async () => {
    const rows = await f.messages(); return queued.every((q: any) => rows.some((m) => m.id === q.id && m.unsent && !m.queued));
  }, "revocation did not drop both queued audiences");
  writeFileSync(join(f.root, "release"), "1"); await f.idle();
  assert.equal(f.records().some((r) => /QUEUED_FULL_PRIVATE|QUEUED_RESTRICTED_GROUP/.test(words(r))), false);
  f.say("PRIVATE_AFTER_RESTRICT FAKE_TEXT", LEE); restricted(await record(f, "PRIVATE_AFTER_RESTRICT")); await f.idle();
  group(f, "GROUP_AFTER_RESTRICT FAKE_REPLY"); restricted(await record(f, "GROUP_AFTER_RESTRICT")); await f.idle();
  assert.equal(f.sent(GROUP).some((c) => c.body.reply_markup), false);
});

test("a buffered group album stays restricted when its sender gains private full access", async (t) => {
  const png = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");
  const f = await personFixture(t, "claude", { files: { sample: png } }), lee = await admitted(f);
  const anchor = group(f, "BUFFERED_GROUP_WORDS", { media_group_id: "neutral-album", photo: [{ file_id: "sample", width: 1, height: 1, file_size: png.length }] });
  // The loop persists this offset before handing the album to its buffer.
  // Waiting for the next poll instead would also wait out the 500 ms buffer.
  await until(() => JSON.parse(readFileSync(join(f.root, ".bloks/config.json"), "utf8")).telegram.bots[f.bot.id].offset >= anchor, "the buffered update was not consumed");
  assert.equal(f.calls.some((c) => c.method === "getFile"), false, "the album was no longer buffered before the access change");
  await access(f, lee.id, "full");
  assert.equal(f.calls.some((c) => c.method === "getFile"), false, "the access change missed the buffer window");
  const turn = await record(f, "BUFFERED_GROUP_WORDS"); restricted(turn); await f.idle();
  const row = await stored(f, "BUFFERED_GROUP_WORDS"); assert.equal(row.telegramDelegate, undefined); assert.equal(row.telegramPerson.personId, lee.id);
  const reply = f.sent(GROUP).find((c) => c.body.text === "Hello Lee"); assert.ok(reply); assert.deepEqual(reply.body.reply_parameters, { message_id: anchor });
  f.say("PRIVATE_AFTER_BUFFER FAKE_TEXT", LEE); const delegate = await record(f, "PRIVATE_AFTER_BUFFER"); await f.idle(); assert.equal(delegate.person, false); assert.match(delegate.token, /^blk_/);
});

test("a recovered group destination cannot use a stale private full-access delegate marker", async (t) => {
  const f = await personFixture(t), lee = await admitted(f); await access(f, lee.id, "full");
  await f.post(`/api/bots/${f.bot.id}/messages`, { text: "RECOVERY_BARRIER FAKE_HOLD" });
  await until(() => existsSync(join(f.root, "held")), "the recovery barrier did not start");
  group(f, "RECOVERED_GROUP_WORDS FAKE_TEXT");
  const queued = await until(async () => (await f.messages()).find((m) => m.queued && m.text?.includes("RECOVERED_GROUP_WORDS")), "the group did not queue");
  await f.reboot(() => {
    writeFileSync(join(f.root, "release"), "1");
    const file = join(f.root, ".bloks", `messages-${f.bot.threadId}.json`), rows = JSON.parse(readFileSync(file, "utf8"));
    const row = rows.find((m: any) => m.id === queued.id); assert.ok(row);
    row.telegramDelegate = row.telegramPerson; delete row.telegramPerson;
    writeFileSync(file, JSON.stringify(rows));
  });
  await until(async () => (await f.messages()).some((m) => m.id === queued.id && m.unsent && !m.queued), "the recovered group delegate was not refused");
  assert.equal(f.records().some((r) => words(r).includes("RECOVERED_GROUP_WORDS")), false);
  assert.equal(f.sent(GROUP).some((c) => c.body.text === "Owner answer." || c.body.text === "Hello Lee"), false);
});
