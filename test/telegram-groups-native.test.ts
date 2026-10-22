// The real handler and native-driver protocols, against synthetic homes
// and a loopback Telegram. Vendor sandbox proof is a separate exercise.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { personFixture, until, SAM, LEE } from "./helpers/telegram-person.ts";

const GROUP = -7001;
function group(f: Awaited<ReturnType<typeof personFixture>>, text: string, from = SAM, extra: any = {}) {
  return f.say(`@PlanningBot ${text}`, from, { chat: { id: GROUP, type: "supergroup", title: "Planning group" }, entities: [{ type: "mention", offset: 0, length: 12 }], ...extra });
}
function newWords(record: any): string { return record.text.split("--- the new message ---").at(-1)!; }

for (const kind of ["codex", "claude"] as const) {
  test(`${kind}: an owner group turn keeps owner trust and separate, anchored reply authority`, async (t) => {
    const f = await personFixture(t, kind);
    const anchor = group(f, "OWNER_GROUP_WORDS FAKE_HOLD", SAM, { is_topic_message: true, message_thread_id: 9 });
    const turn = await until(() => f.records().find((r) => r.text?.includes("OWNER_GROUP_WORDS")), "the owner group turn did not start");
    assert.equal(turn.person, false); assert.equal(turn.groupOwner, true);
    assert.match(turn.token, /^blk_/); assert.match(turn.replyToken, /^blr_/);
    assert.notEqual(turn.token, turn.replyToken);
    assert.match(turn.text, /every member sees it/); assert.match(turn.text, /Chat text and the final answer stay in the app/);
    if (kind === "codex") { assert.equal(turn.guard.sandbox, "danger-full-access"); assert.equal(turn.codexHome, join(f.root, ".codex")); }
    else { assert.equal(turn.args[turn.args.indexOf("--permission-mode") + 1], "bypassPermissions"); assert.ok(!turn.args.includes("--setting-sources")); }
    const normal = await f.h.fetch("/api/agent/whoami", { headers: { authorization: `Bearer ${turn.token}` } });
    assert.equal(normal.status, 200, "the owner token lost its ordinary routes");
    for (const path of ["/api/agent/whoami", "/api/bots?messages=0", "/api/agent/memory"]) {
      assert.equal((await f.h.fetch(path, { headers: { authorization: `Bearer ${turn.replyToken}` } })).status, 403, "the separate reply token reached an ordinary route");
    }
    assert.equal((await f.h.fetch(turn.replyPath, { method: "POST", headers: { authorization: `Bearer ${turn.token}` }, body: JSON.stringify({ text: "MUST_NOT_SEND" }) })).status, 403, "the owner agent token gained a reply route");
    writeFileSync(join(f.root, "release"), "1");
    const sent = await until(() => f.sent(GROUP).find((c) => c.body.text === "Hello Lee"), "the explicit group reply did not arrive");
    await f.idle();
    assert.deepEqual(sent.body.reply_parameters, { message_id: anchor }); assert.equal(sent.body.message_thread_id, 9);
    assert.equal(sent.body.parse_mode, undefined); assert.equal(sent.body.reply_markup, undefined);
    assert.equal(f.sent(GROUP).some((c) => /Private transcript only|Owner answer|MUST_NOT_SEND/.test(c.body.text)), false);
    assert.equal((await f.h.fetch(turn.replyPath, { method: "POST", headers: { authorization: `Bearer ${turn.replyToken}` }, body: JSON.stringify({ text: "AFTER_TURN" }) })).status, 403);
  });

  test(`${kind}: a group knock is admitted into its original group and asks only the private owner`, async (t) => {
    const f = await personFixture(t, kind);
    const anchor = group(f, "MEMBER_GROUP_WORDS FAKE_APPROVE", LEE, { is_topic_message: true, message_thread_id: 9 });
    const person = await until(async () => (await f.status()).people.find((p: any) => p.name === "Lee"), "the group member did not knock");
    const saved = JSON.parse(readFileSync(join(f.root, ".bloks/config.json"), "utf8")).telegram.bots[f.bot.id].people[String(LEE)];
    assert.equal(saved.chatId, undefined, "a group knock invented a private DM");
    assert.equal(saved.first.destination.chatId, GROUP); assert.equal(saved.first.destination.messageId, anchor);
    const ack = await until(() => f.sent(GROUP).find((c) => c.body.text.startsWith("The owner has been asked")), "the addressed group knock got no acknowledgement");
    assert.deepEqual(ack.body.reply_parameters, { message_id: anchor }); assert.equal(ack.body.message_thread_id, 9);
    assert.equal(f.sent(LEE).length, 0);
    await f.post(`/api/bots/${f.bot.id}/telegram`, { personId: person.id, action: "allow" });
    if (kind === "codex") {
      await f.idle();
      assert.equal(f.records().length, 0, "a restricted group person reached Codex");
      const held = await until(() => f.sent(GROUP).find((c) => c.body.text.includes("cannot answer from Telegram")), "the Codex person hold was silent");
      assert.deepEqual(held.body.reply_parameters, { message_id: anchor });
      assert.equal(f.sent(LEE).length, 0);
      assert.equal(existsSync(join(f.root, "effect")), false);
      return;
    }
    const card = await until(async () => (await f.messages()).find((m) => m.card?.title === "Approval needed"), "the member's group command did not ask");
    assert.match(card.card.subtitle, /Lee in Planning group/);
    assert.equal(f.sent(GROUP).some((c) => c.body.reply_markup), false, "an owner card was posted in the group");
    await until(() => f.sent(SAM).some((c) => c.body.reply_markup && c.body.text.includes("Approval needed")), "the private owner card was not delivered");
    group(f, "yes", LEE, { is_topic_message: true, message_thread_id: 9 }); await f.flushed();
    assert.equal(existsSync(join(f.root, "effect")), false, "the member's group words answered an owner card");
    await f.post(`/api/bots/${f.bot.id}/respond`, { requestId: card.card.requestId, behavior: "allow" });
    const sent = await until(() => f.sent(GROUP).find((c) => c.body.text === "Hello Lee"), "the admitted first message did not reply in its group");
    await f.idle();
    assert.deepEqual(sent.body.reply_parameters, { message_id: anchor }, "a later steer moved the group's reply anchor");
    assert.equal(sent.body.message_thread_id, 9); assert.equal(f.sent(LEE).length, 0);
    const member = f.records().find((r) => r.person && r.text?.includes("MEMBER_GROUP_WORDS"));
    assert.ok(member); assert.ok(newWords(member).includes("MEMBER_GROUP_WORDS"));
    assert.ok(member.args.includes("--setting-sources"));
  });
}

test("declining a group knock sends no later group post or invented DM", async (t) => {
  const f = await personFixture(t);
  group(f, "PLEASE_LET_ME_IN FAKE_REPLY", LEE);
  const person = await until(async () => (await f.status()).people[0], "there was no group knock");
  await until(() => f.sent(GROUP).some((c) => c.body.text.startsWith("The owner has been asked")), "the acknowledgement was not sent");
  const before = f.sent(GROUP).length;
  await f.post(`/api/bots/${f.bot.id}/telegram`, { personId: person.id, action: "decline" });
  group(f, "again", LEE); await f.flushed();
  assert.equal(f.sent(GROUP).length, before); assert.equal(f.sent(LEE).length, 0); assert.equal(f.records().length, 0);
});

test("the targetless CLI uses the separate group credential", async (t) => {
  const f = await personFixture(t);
  const anchor = group(f, "FAKE_CLI");
  const called = await until(() => f.records().find((r) => r.cliReply), "the fixture did not try the CLI");
  assert.equal(called.cliReply.status, 0, JSON.stringify(called.cliReply));
  const sent = await until(() => f.sent(GROUP).find((c) => c.body.text === "Hello group from CLI"), "the targetless CLI did not reply");
  await f.idle();
  assert.deepEqual(sent.body.reply_parameters, { message_id: anchor });
  assert.equal(f.records().find((r) => r.cliReply)?.cliReply.status, 0);
});


test("owner app words and another agent's say wait behind an owner group turn", async (t) => {
  const f = await personFixture(t, "codex");
  group(f, "ACTIVE_GROUP_WORDS FAKE_HOLD");
  await until(() => f.records().some((r) => r.text?.includes("ACTIVE_GROUP_WORDS")), "the group did not start");
  const { bot: peer } = await f.post("/api/bots", { name: "Rex" });
  await f.ownerJson(`/api/bots/${peer.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" }, approvals: "full" }) });
  await f.post(`/api/bots/${peer.id}/messages`, { text: "PEER_HELD_WORDS FAKE_HOLD" });
  const peerTurn = await until(() => f.records().find((r) => r.text?.endsWith("PEER_HELD_WORDS FAKE_HOLD")), "the peer did not start");
  await f.post(`/api/bots/${f.bot.id}/messages`, { text: "APP_PRIVATE_WORDS FAKE_TEXT", delivery: "now" });
  const said = await f.h.fetch(`/api/bots/${f.bot.id}/messages`, { method: "POST", headers: { authorization: `Bearer ${peerTurn.token}` }, body: JSON.stringify({ text: "PEER_PRIVATE_WORDS FAKE_TEXT", now: true }) });
  assert.equal(said.status, 202, await said.clone().text());
  assert.equal((await said.json()).queued, true);
  for (const words of ["APP_PRIVATE_WORDS", "PEER_PRIVATE_WORDS"]) {
    assert.ok((await f.messages()).some((m) => m.queued && m.text?.includes(words)), "private words did not queue");
    assert.equal(f.records().some((r) => JSON.stringify(r.steered ?? null).includes(words)), false, "private words steered into the group");
  }
  writeFileSync(join(f.root, "release"), "1");
  await until(() => f.records().some((r) => r.text?.includes("PEER_PRIVATE_WORDS")), "private words did not get their turn");
  await f.idle();
  const turns = f.records().filter((r) => typeof r.text === "string" && !r.text?.endsWith("PEER_HELD_WORDS FAKE_HOLD"));
  for (const turn of turns) {
    const words = newWords(turn);
    if (words.includes("APP_PRIVATE_WORDS") || words.includes("PEER_PRIVATE_WORDS")) assert.equal(turn.groupOwner, false, "private words got group reply authority");
  }
  assert.equal(f.sent(GROUP).some((c) => /APP_PRIVATE_WORDS|PEER_PRIVATE_WORDS/.test(c.body.text)), false);
});

for (const order of ["group-private", "private-group"] as const) {
  test(`owner queue ${order} keeps audiences separate and uses the last merged group anchor`, async (t) => {
    const f = await personFixture(t);
    await f.admit("FAKE_HOLD");
    await until(() => existsSync(join(f.root, "held")), "the blocking person turn did not start");
    const privateWords = "QUEUED_PRIVATE_WORDS FAKE_TEXT";
    if (order === "private-group") await f.post(`/api/bots/${f.bot.id}/messages`, { text: privateWords });
    group(f, "QUEUED_GROUP_ONE FAKE_REPLY");
    const lastAnchor = group(f, "QUEUED_GROUP_TWO FAKE_REPLY");
    await f.flushed();
    await until(async () => (await f.messages()).filter((m) => m.telegramGroup && m.queued).length === 2, "the group words did not queue");
    if (order === "group-private") await f.post(`/api/bots/${f.bot.id}/messages`, { text: privateWords });
    assert.ok((await f.messages()).some((m) => m.queued && m.text === privateWords));
    writeFileSync(join(f.root, "release"), "1");
    await until(() => f.records().some((r) => newWords({ text: r.text ?? "" }).includes(order === "group-private" ? privateWords : "QUEUED_GROUP_TWO")), "the final queued audience was lost");
    await f.idle();
    const turns = f.records().filter((r) => typeof r.text === "string").slice(1);
    assert.equal(turns.length, 2);
    for (const turn of turns) {
      const words = newWords(turn);
      assert.notEqual(words.includes("QUEUED_GROUP_ONE"), words.includes(privateWords), "new private and group words merged into one turn");
      assert.equal(turn.groupOwner, words.includes("QUEUED_GROUP_ONE"));
    }
    assert.deepEqual(turns.map((r) => r.groupOwner ? "group" : "private"), order.split("-"));
    const reply = f.sent(GROUP).find((c) => c.body.text === "Hello Lee");
    assert.ok(reply); assert.deepEqual(reply.body.reply_parameters, { message_id: lastAnchor });
  });
}

test("a member in two groups and a private chat has separate queued audiences", async (t) => {
  const f = await personFixture(t);
  await f.admit("FAKE_TEXT"); await f.idle();
  await f.post(`/api/bots/${f.bot.id}/messages`, { text: "FAKE_HOLD" });
  await until(() => existsSync(join(f.root, "held")), "the owner did not block the queue");
  const first = group(f, "GROUP_A_WORDS FAKE_REPLY", LEE);
  group(f, "GROUP_B_WORDS FAKE_REPLY", LEE, { chat: { id: -7002, type: "group", title: "Second group" } });
  f.say("PRIVATE_MEMBER_WORDS FAKE_TEXT", LEE);
  await f.flushed();
  await until(async () => (await f.messages()).filter((m) => m.queued && m.telegramPerson).length === 3, "the three audiences did not queue");
  writeFileSync(join(f.root, "release"), "1");
  await until(() => f.records().some((r) => r.person && newWords(r).includes("PRIVATE_MEMBER_WORDS")), "the private member words were lost");
  await f.idle();
  const turns = f.records().filter((r) => r.person && /GROUP_A_WORDS|GROUP_B_WORDS|PRIVATE_MEMBER_WORDS/.test(newWords(r)));
  assert.equal(turns.length, 3);
  for (const turn of turns) assert.equal(["GROUP_A_WORDS", "GROUP_B_WORDS", "PRIVATE_MEMBER_WORDS"].filter((w) => newWords(turn).includes(w)).length, 1);
  assert.deepEqual(f.sent(GROUP).find((c) => c.body.text === "Hello Lee").body.reply_parameters, { message_id: first });
  assert.equal(f.sent(-7002).filter((c) => c.body.text === "Hello Lee").length, 1);
});

test("unaddressed and forged group addresses do no transcript, admission or file work", async (t) => {
  const f = await personFixture(t);
  for (const extra of [
    { entities: [] }, { forward_origin: { type: "user" } }, { sender_chat: { id: GROUP } }, { is_automatic_forward: true },
    { entities: [], quote: { text: "@PlanningBot", entities: [{ type: "mention", offset: 0, length: 12 }] } },
    { entities: [], reply_to_message: { message_id: 30, chat: { id: GROUP }, from: { id: 12345 }, text: "Service", pinned_message: { message_id: 20 } } },
  ]) group(f, "IGNORED_GROUP_PAYLOAD", LEE, { voice: { file_id: "never-fetch", file_size: 20 }, ...extra });
  await f.flushed();
  f.say("PRIVATE_CONTROL_WORDS FAKE_TEXT");
  await until(() => f.records().some((r) => r.text?.endsWith("PRIVATE_CONTROL_WORDS FAKE_TEXT")), "the offset did not pass the ignored messages");
  await f.idle();
  assert.equal((await f.status()).people.length, 0);
  assert.equal(f.calls.some((c) => c.method === "getFile"), false);
  assert.equal((await f.messages()).some((m) => m.text?.includes("IGNORED_GROUP_PAYLOAD")), false);
  assert.equal(f.h.logs().includes("IGNORED_GROUP_PAYLOAD"), false);
  assert.equal(f.sent(GROUP).length, 0); assert.equal(f.sent(LEE).length, 0);
});

test("an owner quote keeps owner trust while the unadmitted quoted author's own words only knock", async (t) => {
  const f = await personFixture(t, "codex");
  group(f, "OWNER_QUOTE_WORDS FAKE_TEXT", SAM, { reply_to_message: {
    message_id: 30, chat: { id: GROUP }, from: { id: 30303, is_bot: false, first_name: "Rex" }, text: "UNADMITTED_PERSON_QUOTE",
    photo: [{ file_id: "never-fetch-quote", width: 1, height: 1 }],
  } });
  const owner = await until(() => f.records().find((r) => r.text?.includes("OWNER_QUOTE_WORDS")), "the owner quote did not run");
  await f.idle();
  assert.equal(owner.person, false); assert.equal(owner.guard.sandbox, "danger-full-access");
  assert.match(owner.text, /Quoted context from "Rex"/); assert.match(owner.text, /UNADMITTED_PERSON_QUOTE/);
  assert.equal(f.calls.some((c) => c.method === "getFile"), false);
  group(f, "REX_OWN_WORDS FAKE_REPLY", 30303, { from: { id: 30303, is_bot: false, first_name: "Rex" } });
  const knock = await until(async () => (await f.status()).people.find((p: any) => p.name === "Rex"), "the actual author did not knock");
  assert.equal(knock.state, "pending");
  await f.flushed();
  assert.equal(f.records().some((r) => newWords({ text: r.text ?? "" }).includes("REX_OWN_WORDS")), false);
});

test("opening a private chat after a group knock does not move its first admitted message", async (t) => {
  const f = await personFixture(t);
  const anchor = group(f, "FIRST_GROUP_WORDS FAKE_REPLY", LEE);
  const person = await until(async () => (await f.status()).people[0], "there was no group knock");
  f.say("LATER_PRIVATE_PENDING_WORDS", LEE); await f.flushed();
  await until(() => JSON.parse(readFileSync(join(f.root, ".bloks/config.json"), "utf8")).telegram.bots[f.bot.id].people[String(LEE)].chatId === LEE, "the private message did not learn the private chat");
  const saved = JSON.parse(readFileSync(join(f.root, ".bloks/config.json"), "utf8")).telegram.bots[f.bot.id].people[String(LEE)];
  assert.equal(saved.first.destination.chatId, GROUP);
  await f.post(`/api/bots/${f.bot.id}/telegram`, { personId: person.id, action: "allow" });
  const reply = await until(() => f.sent(GROUP).find((c) => c.body.text === "Hello Lee"), "the first group message was not delivered");
  await f.idle();
  assert.deepEqual(reply.body.reply_parameters, { message_id: anchor });
  assert.equal(f.sent(LEE).length, 0);
  assert.equal(f.records().some((r) => newWords({ text: r.text ?? "" }).includes("LATER_PRIVATE_PENDING_WORDS")), false);
});

test("a deleted group anchor records a failed reply and never falls back to a plain post", async (t) => {
  const f = await personFixture(t);
  f.sendFailures.set("Hello Lee", 400);
  const anchor = group(f, "FAKE_REPLY");
  await until(async () => (await f.messages()).some((m) => m.telegramSent?.state === "failed"), "the definite anchor failure was not recorded");
  await f.idle();
  const attempts = f.sent(GROUP).filter((c) => c.body.text === "Hello Lee");
  assert.equal(attempts.length, 1); assert.deepEqual(attempts[0].body.reply_parameters, { message_id: anchor });
  assert.equal(f.sent(GROUP).some((c) => c.body.reply_parameters === undefined), false);
});

test("an addressed group album downloads both photos after one admission decision", async (t) => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  const f = await personFixture(t, "claude", { files: { one: png, two: png } });
  await f.admit("FAKE_TEXT"); await f.idle();
  f.say("", LEE, { chat: { id: GROUP, type: "supergroup", title: "Planning group" }, media_group_id: "album", photo: [{ file_id: "one", width: 1, height: 1 }], entities: [] });
  const anchor = f.say("", LEE, { chat: { id: GROUP, type: "supergroup", title: "Planning group" }, media_group_id: "album", photo: [{ file_id: "two", width: 1, height: 1 }], text: undefined, caption: "@PlanningBot ALBUM_WORDS", caption_entities: [{ type: "mention", offset: 0, length: 12 }], is_topic_message: true, message_thread_id: 9 });
  const turn = await until(() => f.records().find((r) => r.text?.includes("ALBUM_WORDS")), "the addressed album did not run");
  await f.idle();
  assert.equal((newWords(turn).match(/<attached-image /g) ?? []).length, 2, "the addressed album was cut down to its captioned photo");
  assert.deepEqual(f.calls.filter((c) => c.method === "getFile").map((c) => c.body.file_id).sort(), ["one", "two"]);
  const reply = f.sent(GROUP).find((c) => c.body.text === "Hello Lee");
  assert.ok(reply); assert.deepEqual(reply.body.reply_parameters, { message_id: anchor }); assert.equal(reply.body.message_thread_id, 9);
});

for (const active of ["group", "private"] as const) {
  test(`the owner's private DM and group cannot steer across an active ${active} audience`, async (t) => {
    const f = await personFixture(t);
    if (active === "group") group(f, "ACTIVE_GROUP_DM_TEST FAKE_HOLD");
    else f.say("ACTIVE_PRIVATE_DM_TEST FAKE_HOLD");
    await until(() => existsSync(join(f.root, "held")), "the active audience did not start");
    if (active === "group") f.say("QUEUED_PRIVATE_DM_WORDS FAKE_TEXT");
    else group(f, "QUEUED_GROUP_DM_WORDS FAKE_REPLY");
    await f.flushed();
    const queuedWords = active === "group" ? "QUEUED_PRIVATE_DM_WORDS" : "QUEUED_GROUP_DM_WORDS";
    await until(async () => (await f.messages()).some((m) => m.queued && m.text?.includes(queuedWords)), "the different audience did not queue");
    assert.equal(f.records().some((r) => JSON.stringify(r.steered ?? null).includes(queuedWords)), false);
    writeFileSync(join(f.root, "release"), "1");
    const later = await until(() => f.records().find((r) => r.text && newWords(r).includes(queuedWords)), "the queued audience was lost");
    await f.idle();
    assert.equal(later.groupOwner, active === "private");
    assert.equal(f.sent(GROUP).some((c) => /QUEUED_PRIVATE_DM_WORDS/.test(c.body.text)), false);
  });
}

for (const stale of [false, true]) {
  test(`a queued owner group reply survives restart with its owner binding ${stale ? "changed" : "retained"}`, async (t) => {
    const f = await personFixture(t);
    await f.post(`/api/bots/${f.bot.id}/messages`, { text: "FAKE_HOLD" });
    await until(() => existsSync(join(f.root, "held")), "the owner did not block the queue");
    const anchor = group(f, "RESTART_GROUP_WORDS FAKE_REPLY", SAM, { is_topic_message: true, message_thread_id: 9 });
    await f.flushed();
    const queued = await until(async () => (await f.messages()).find((m) => m.telegramGroup && m.queued), "group words did not queue");
    await f.reboot(() => {
      writeFileSync(join(f.root, "release"), "1");
      if (!stale) return;
      const file = join(f.root, ".bloks/config.json"), cfg = JSON.parse(readFileSync(file, "utf8"));
      cfg.telegram.bots[f.bot.id].ownerUserId = 30303;
      writeFileSync(file, JSON.stringify(cfg));
    });
    if (stale) {
      await until(async () => (await f.messages()).find((m) => m.id === queued.id && m.unsent), "a changed owner binding ran queued group words");
      assert.equal(f.records().some((r) => r.text && newWords(r).includes("RESTART_GROUP_WORDS")), false);
      assert.equal(f.sent(GROUP).some((c) => c.body.text === "Hello Lee"), false);
    } else {
      const resumed = await until(() => f.records().find((r) => r.text && newWords(r).includes("RESTART_GROUP_WORDS")), "queued group words were not recovered");
      await f.idle();
      assert.equal(resumed.person, false); assert.equal(resumed.groupOwner, true);
      assert.deepEqual(f.sent(GROUP).find((c) => c.body.text === "Hello Lee").body.reply_parameters, { message_id: anchor });
      assert.equal(f.sent(GROUP).find((c) => c.body.text === "Hello Lee").body.message_thread_id, 9);
    }
  });
}

test("a group reply with unknown delivery is not sent again", async (t) => {
  const f = await personFixture(t);
  f.sendFailures.set("Hello Lee", "disconnect");
  const anchor = group(f, "FAKE_REPLY");
  await until(async () => (await f.messages()).some((m) => m.telegramSent?.state === "uncertain"), "unknown group delivery was not recorded");
  await f.idle();
  const sent = f.sent(GROUP).filter((c) => c.body.text === "Hello Lee");
  assert.equal(sent.length, 1); assert.deepEqual(sent[0].body.reply_parameters, { message_id: anchor });
});

test("a group owner's typed question answer requires a reply to the private card", async (t) => {
  const f = await personFixture(t);
  const anchor = group(f, "FAKE_QUESTION");
  const card = await until(() => f.sent(SAM).find((c) => c.body.text.includes("Which day?")), "the group question did not reach the private owner");
  assert.match(card.body.text, /reply to this card/i);
  f.say("OWNER_PLAIN_WORDS FAKE_TEXT");
  group(f, "PERSON_ANSWER_WORDS", LEE);
  await f.flushed();
  await until(async () => (await f.messages()).some((m) => m.text?.includes("OWNER_PLAIN_WORDS") && m.queued), "the plain private words did not remain their own input");
  assert.equal(f.records().some((r) => r.questionAnswer), false, "ordinary words answered the group turn's question");
  f.say("Wednesday", SAM, { reply_to_message: { message_id: card.messageId } });
  const answer = await until(() => f.records().find((r) => r.questionAnswer), "the card reply did not answer the question");
  assert.match(JSON.stringify(answer.questionAnswer), /Wednesday/);
  await until(() => f.records().some((r) => r.text && newWords(r).includes("OWNER_PLAIN_WORDS")), "the plain private input was lost");
  await f.idle();
  assert.deepEqual(f.sent(GROUP).find((c) => c.body.text === "Hello Lee").body.reply_parameters, { message_id: anchor });
  assert.equal(f.sent(GROUP).some((c) => c.body.text.includes("OWNER_PLAIN_WORDS") || c.body.reply_markup), false);
});

test("drain-held owner group words keep their audience and anchor after drain is called off", async (t) => {
  const f = await personFixture(t);
  await f.post("/api/maintenance/drain", { seconds: 60 });
  const anchor = group(f, "DRAIN_GROUP_WORDS FAKE_REPLY", SAM, { is_topic_message: true, message_thread_id: 9 });
  await f.flushed();
  await until(async () => (await f.messages()).some((m) => m.telegramGroup && m.queued), "drain did not keep the group words");
  assert.equal(f.records().length, 0);
  await f.ownerJson("/api/maintenance/drain", { method: "DELETE" });
  const turn = await until(() => f.records().find((r) => r.text && newWords(r).includes("DRAIN_GROUP_WORDS")), "drain lost the group words");
  await f.idle();
  assert.equal(turn.groupOwner, true);
  const reply = f.sent(GROUP).find((c) => c.body.text === "Hello Lee");
  assert.deepEqual(reply.body.reply_parameters, { message_id: anchor }); assert.equal(reply.body.message_thread_id, 9);
});

test("a cut-off owner group turn keeps its original anchor after a later steer and restart", async (t) => {
  const f = await personFixture(t);
  const anchor = group(f, "CUT_OFF_GROUP_WORDS FAKE_HOLD", SAM, { is_topic_message: true, message_thread_id: 9 });
  await until(() => existsSync(join(f.root, "held")), "the owner group turn did not start");
  const laterAnchor = group(f, "STEERED_GROUP_WORDS", SAM, { is_topic_message: true, message_thread_id: 9 });
  await f.flushed();
  await until(() => f.records().some((r) => JSON.stringify(r.steered ?? null).includes("STEERED_GROUP_WORDS")), "the same audience did not steer");
  assert.notEqual(anchor, laterAnchor);
  await f.reboot(() => writeFileSync(join(f.root, "release"), "1"));
  const reply = await until(() => f.sent(GROUP).find((c) => c.body.text === "Hello Lee"), "the cut-off group turn was not recovered");
  await f.idle();
  assert.equal(f.records().filter((r) => r.groupOwner).length, 2);
  assert.deepEqual(reply.body.reply_parameters, { message_id: anchor }); assert.equal(reply.body.message_thread_id, 9);
  assert.equal(f.sent(GROUP).filter((c) => c.body.text === "Hello Lee").length, 1);
});

test("restricted group history stays inside its sender and audience without owner standing context", async (t) => {
  const f = await personFixture(t, "claude", { seed(root) {
    const file = join(root, ".bloks/config.json"), cfg = JSON.parse(readFileSync(file, "utf8"));
    cfg.profile = { about: "OWNER_PROFILE_FACT" };
    writeFileSync(file, JSON.stringify(cfg));
  } });
  mkdirSync(join(f.root, ".bloks/workspaces", f.bot.id), { recursive: true });
  writeFileSync(join(f.root, ".bloks/workspaces", f.bot.id, "MEMORY.md"), "OWNER_MEMORY_FACT");
  await f.post("/api/bots/" + f.bot.id + "/messages", { text: "OWNER_SECRET_WORDS FAKE_TEXT" }); await f.idle();
  await f.admit("PRIVATE_MEMBER_FACT FAKE_REPLY");
  await until(() => f.sent(LEE).some((c) => c.body.text === "Hello Lee"), "the private person reply was not confirmed");
  await f.idle();
  group(f, "GROUP_A_FIRST FAKE_REPLY", LEE);
  await until(() => f.records().some((x) => x.person && newWords(x).includes("GROUP_A_FIRST")), "first group turn did not start"); await f.idle();
  group(f, "GROUP_B_FIRST FAKE_REPLY", LEE, { chat: { id: -7002, type: "group", title: "Second group" } });
  await until(() => f.records().some((x) => x.person && newWords(x).includes("GROUP_B_FIRST")), "second group turn did not start"); await f.idle();
  group(f, "GROUP_A_SECOND FAKE_TEXT", LEE);
  await until(() => f.records().some((x) => x.person && newWords(x).includes("GROUP_A_SECOND")), "follow-up group turn did not start"); await f.idle();
  const groups = f.records().filter((x) => x.person && /GROUP_[AB]_/.test(newWords(x)));
  assert.equal(groups.length, 3);
  for (const turn of groups) {
    assert.doesNotMatch(turn.text + turn.system, /OWNER_SECRET_WORDS|OWNER_PROFILE_FACT|OWNER_MEMORY_FACT|PRIVATE_MEMBER_FACT/);
    assert.doesNotMatch(turn.system, /Deliverables:|persistent memory|Shared memory/);
    assert.equal(turn.person, true);
  }
  const b = groups.find((x) => newWords(x).includes("GROUP_B_FIRST"));
  assert.doesNotMatch(b.text, /GROUP_A_FIRST/);
  const a2 = groups.find((x) => newWords(x).includes("GROUP_A_SECOND"));
  assert.match(a2.text, /GROUP_A_FIRST/);
  assert.match(a2.text, /Hello Lee/);
  assert.doesNotMatch(a2.text, /GROUP_B_FIRST/);
});

for (const full of [false, true]) test("a group person stays restricted on Codex, including a private full grant: " + full, async (t) => {
  const f = await personFixture(t, "codex");
  const lee = await f.admit("FIRST_PRIVATE_WORDS FAKE_TEXT"); await f.idle();
  if (full) await f.post("/api/bots/" + f.bot.id + "/telegram", { personId: lee.id, action: "full" });
  const anchor = group(f, "MUST_STAY_RESTRICTED FAKE_TEXT", LEE);
  const held = await until(() => f.sent(GROUP).find((x) => x.body.text.includes("cannot answer from Telegram")), "the group person was not held visibly");
  await f.idle();
  assert.deepEqual(held.body.reply_parameters, { message_id: anchor });
  assert.equal(f.records().length, 0, "a restricted group turn used Codex or private full delegation");
  assert.equal(f.sent(GROUP).some((x) => x.body.reply_markup), false);
});
