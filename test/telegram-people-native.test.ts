import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { LEE, SAM, nap, personFixture, until } from "./helpers/telegram-person.ts";
import { TELEGRAM_PEOPLE_UPGRADE } from "../server/telegram-people.ts";

for (const kind of ["codex", "claude"] as const) {
  test(`${kind}: a let-in person's full-agent turn asks only the owner and replies explicitly`, async (t) => {
    const f = await personFixture(t, kind);
    f.say("FAKE_APPROVE", LEE);
    const person = await until(async () => (await f.status()).people.find((p: any) => p.name === "Lee"), "there was no knock");
    await until(async () => (await f.messages()).find((m) => m.card?.requestId === `tg-person:${person.id}`), "there was no owner card");
    f.say("again", LEE); f.say("again", LEE);
    await f.flushed();
    assert.equal((await f.messages()).filter((m) => m.card?.requestId === `tg-person:${person.id}`).length, 1);
    assert.equal(f.records().filter((r) => r.person).length, 0);
    await f.post(`/api/bots/${f.bot.id}/telegram`, { personId: person.id, action: "allow" });
    const card = await until(async () => (await f.messages()).find((m) => m.card?.title === "Approval needed"), "the full agent did not ask for owner approval");
    assert.match(card.card.subtitle, /asked for by Lee/);
    assert.equal(existsSync(join(f.root, "effect")), false);
    f.say("yes", LEE);
    await f.flushed();
    assert.equal(existsSync(join(f.root, "effect")), false, "Lee's yes approved the command");
    assert.equal(f.sent(LEE).some((m) => m.body.reply_markup), false, "a card went to Lee");
    assert.equal(f.sent(SAM).some((m) => m.body.text.includes("Approval needed") && m.body.reply_markup), true);
    await f.post(`/api/bots/${f.bot.id}/respond`, { requestId: card.card.requestId, behavior: "allow" });
    await until(() => f.sent(LEE).some((m) => m.body.text === "Hello Lee"), "the explicit answer was not sent");
    await f.idle();
    assert.equal(readFileSync(join(f.root, "effect"), "utf8"), "approved");
    assert.equal(f.sent(LEE).some((m) => m.body.text.includes("Private transcript only")), false);
    const answer = f.sent(LEE).find((m) => m.body.text === "Hello Lee");
    assert.equal(answer.body.parse_mode, undefined); assert.equal(answer.body.reply_markup, undefined);
    assert.equal((await f.messages()).filter((m) => m.telegramSent?.state === "sent").length, 1);
    const call = f.records().find((r) => r.person);
    if (kind === "codex") { assert.equal(call.guard.sandbox, "read-only"); assert.equal(call.guard.approvalPolicy, "on-request"); assert.equal(call.guard.ephemeral, true); }
    else { assert.ok(call.args.includes("--setting-sources")); assert.ok(call.args.includes("--strict-mcp-config")); assert.ok(call.args.includes("--no-session-persistence")); assert.equal(call.args[call.args.indexOf("--permission-mode") + 1], "default"); }
  });
}

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

test("owner input waits behind a person's turn and does not enter their reply", async (t) => {
  const f = await personFixture(t);
  await f.admit("FAKE_HOLD");
  await until(() => existsSync(join(f.root, "held")), "the person's turn did not run");
  await f.post(`/api/bots/${f.bot.id}/messages`, { text: "OWNER_PRIVATE_WORDS" });
  assert.equal((await f.messages()).find((m) => m.text === "OWNER_PRIVATE_WORDS").queued, true);
  assert.equal(f.records().some((r) => JSON.stringify(r.steered ?? null).includes("OWNER_PRIVATE_WORDS")), false);
  writeFileSync(join(f.root, "release"), "1");
  await until(() => f.sent(LEE).some((m) => m.body.text === "Hello Lee"), "there was no reply");
  await until(() => f.records().some((r) => !r.person && r.text?.endsWith("OWNER_PRIVATE_WORDS")), "the owner message was lost");
  await f.idle();
  assert.equal(f.sent(LEE).some((m) => m.body.text.includes("OWNER_PRIVATE_WORDS")), false);
});

for (const order of ["person-owner", "owner-person"] as const) {
  test(`mixed-sender queue ${order} keeps new words and trust in separate turns`, async (t) => {
    const f = await personFixture(t);
    const ownerWords = "QUEUED_OWNER_WORDS FAKE_TEXT";
    const personWords = "QUEUED_PERSON_WORDS FAKE_TEXT";
    let personId: string;
    if (order === "person-owner") {
      await f.post(`/api/bots/${f.bot.id}/messages`, { text: "FAKE_HOLD" });
      await until(() => existsSync(join(f.root, "held")), "the owner did not start");
      const person = await f.admit(personWords);
      personId = person.id;
      await until(async () => (await f.messages()).find((m) => m.telegramPerson?.personId === personId && m.queued), "the person did not queue first");
      await f.post(`/api/bots/${f.bot.id}/messages`, { text: ownerWords });
    } else {
      await f.admit("FAKE_HOLD");
      await until(() => existsSync(join(f.root, "held")), "the first person did not start");
      await f.post(`/api/bots/${f.bot.id}/messages`, { text: ownerWords });
      const secondId = 30303;
      f.say(personWords, secondId, { from: { id: secondId, is_bot: false, first_name: "Rex" } });
      const person = await until(async () => (await f.status()).people.find((p: any) => p.name === "Rex"), "the second person did not knock");
      personId = person.id;
      await f.post(`/api/bots/${f.bot.id}/telegram`, { personId, action: "allow" });
      await until(async () => (await f.messages()).find((m) => m.telegramPerson?.personId === personId && m.queued), "the second person did not queue");
    }
    assert.equal((await f.messages()).find((m) => m.text === ownerWords).queued, true, "the owner's words did not enter the queue");
    assert.equal(f.records().filter((r) => typeof r.text === "string").length, 1, "queued words started before the held turn ended");
    assert.equal(f.records().some((r) => JSON.stringify(r.steered ?? null).includes(ownerWords)), false, "the owner's words steered into the held turn");
    writeFileSync(join(f.root, "release"), "1");
    const lastWords = order === "person-owner" ? ownerWords : personWords;
    await until(() => f.records().some((r) => r.text?.includes(lastWords)), "the last queued words were lost");
    await f.idle();
    const turns = f.records().filter((r) => typeof r.text === "string").slice(1);
    for (const turn of turns) {
      // Earlier context may quote both senders. Only this turn's new
      // words decide its requester and must belong to one sender.
      const words = turn.text.split("--- the new message ---").at(-1)!;
      const senders = [ownerWords, personWords].filter((text) => words.includes(text));
      assert.equal(senders.length, 1, "new words from different senders merged into one turn");
      assert.equal(turn.person, words.includes(personWords), "queued person words ran with owner trust");
      assert.equal(turn.guard.sandbox, turn.person ? "read-only" : "danger-full-access");
    }
    assert.equal(turns.length, 2, "one queued sender did not get its own turn");
    const newWords = turns.map((turn) => turn.text.split("--- the new message ---").at(-1)!.trim());
    assert.deepEqual(newWords.map((words) => words.includes(personWords) ? "person" : "owner"), order.split("-"));
    assert.equal((await f.messages()).find((m) => m.telegramPerson?.personId === personId && m.text?.includes(personWords)).queued, false);
  });
}

test("taking one person out drops queued words and stops only their active turn", async (t) => {
  const f = await personFixture(t);
  await f.post(`/api/bots/${f.bot.id}/messages`, { text: "FAKE_HOLD" });
  await until(() => existsSync(join(f.root, "held")), "the owner did not run");
  const person = await f.admit();
  await until(async () => (await f.messages()).find((m) => m.telegramPerson?.personId === person.id && m.queued), "the person did not queue");
  await f.post(`/api/bots/${f.bot.id}/telegram`, { personId: person.id, action: "remove" });
  const removed = (await f.messages()).find((m) => m.telegramPerson?.personId === person.id);
  assert.equal(removed.queued, false); assert.equal(removed.unsent, true);
  assert.equal((await f.h.json("/api/bots")).bots.find((b: any) => b.id === f.bot.id).busy, true, "the owner's turn was stopped");
  writeFileSync(join(f.root, "release"), "1"); await f.idle();
  await f.post(`/api/bots/${f.bot.id}/telegram`, { personId: person.id, action: "allow" });
  f.say("FAKE_APPROVE", LEE);
  const card = await until(async () => (await f.messages()).find((m) => m.card?.title === "Approval needed" && !m.card.answered), "the person did not ask");
  await f.post(`/api/bots/${f.bot.id}/telegram`, { personId: person.id, action: "remove" });
  await f.idle();
  const answer = await f.h.fetch(`/api/bots/${f.bot.id}/respond`, { method: "POST", body: JSON.stringify({ requestId: card.card.requestId, behavior: "allow" }) });
  assert.notEqual((await answer.json()).outcome, "delivered");
  assert.equal(existsSync(join(f.root, "effect")), false);
});

test("reply credentials refuse every wider route and every extra reply argument", async (t) => {
  const f = await personFixture(t);
  const person = await f.admit("FAKE_HOLD");
  await until(() => existsSync(join(f.root, "held")), "the person did not run");
  const token = f.records().find((r) => r.person).token;
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const forbidden: Array<[string, string]> = [
    ["GET", "/api/agent/whoami"],
    ["GET", "/api/bots"], ["GET", `/api/bots/${f.bot.id}/recall`], ["GET", `/api/bots/${f.bot.id}/memory`],
    ["GET", "/api/config"], ["POST", "/api/pair/claim"], ["POST", "/api/routines"], ["POST", "/api/watchers"],
    ["POST", "/api/bloks"], ["POST", `/api/bots/${f.bot.id}/messages`], ["POST", `/api/bots/${f.bot.id}/respond`],
    ["POST", `/api/bots/${f.bot.id}/secrets`], ["POST", `/api/bots/${f.bot.id}/telegram`], ["POST", "/hook/fixture"],
    ["GET", "/api/health"], ["POST", "/api/bots/other/telegram/reply"],
  ];
  const before = readFileSync(join(f.root, ".bloks/config.json"), "utf8");
  for (const [method, path] of forbidden) {
    const response = await f.h.fetch(path, { method, headers, ...(method === "GET" ? {} : { body: "{}" }) });
    assert.equal(response.status, 403, `${method} ${path}`);
  }
  for (const field of ["chat_id", "to", "agent", "file", "parse_mode", "reply_markup"]) {
    const response = await f.h.fetch(`/api/bots/${f.bot.id}/telegram/reply`, { method: "POST", headers, body: JSON.stringify({ text: "do not send", [field]: "elsewhere" }) });
    assert.equal(response.status, 403);
  }
  const { bot: other } = await f.post("/api/bots", { name: "Sam" });
  await f.ownerJson(`/api/bots/${other.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" } }) });
  await f.post(`/api/bots/${other.id}/messages`, { text: "FAKE_HOLD" });
  const otherToken = await until(() => f.records().find((r) => !r.person)?.token, "the other agent did not start");
  assert.equal((await f.h.fetch(`/api/bots/${f.bot.id}/telegram/reply`, { method: "POST", headers: { authorization: `Bearer ${otherToken}` }, body: JSON.stringify({ text: "another agent's reply" }) })).status, 403);
  assert.equal((await f.h.fetch(`/api/bots/${other.id}/telegram/reply`, { method: "POST", headers, body: JSON.stringify({ text: "another agent's route" }) })).status, 403);
  assert.equal(readFileSync(join(f.root, ".bloks/config.json"), "utf8"), before);
  assert.equal(f.sent(LEE).some((m) => m.body.text === "do not send"), false);
  await f.post(`/api/bots/${f.bot.id}/telegram`, { personId: person.id, action: "remove" });
  assert.equal((await f.h.fetch(`/api/bots/${f.bot.id}/telegram/reply`, { method: "POST", headers, body: JSON.stringify({ text: "late" }) })).status, 403);
  await f.post(`/api/bots/${f.bot.id}/telegram`, { personId: person.id, action: "allow" });
  assert.equal((await f.h.fetch(`/api/bots/${f.bot.id}/telegram/reply`, { method: "POST", headers, body: JSON.stringify({ text: "readmitted" }) })).status, 403);
  writeFileSync(join(f.root, "release"), "1");
});

test("a person's transcript-only ending sends no automatic Telegram answer", async (t) => {
  const f = await personFixture(t);
  await f.admit("FAKE_TEXT");
  await until(async () => (await f.messages()).some((m) => m.text === "Private transcript only."), "the private text was not recorded");
  await f.idle();
  assert.equal(f.sent(LEE).some((m) => m.body.text === "Private transcript only."), false);
  assert.equal(f.sent(LEE).some((m) => m.body.text === "Hello Lee"), false);
});

test("rotation, unpair and removal revoke a running person's approval and credential", async (t) => {
  const f = await personFixture(t);
  for (const change of [{ token: "12345:ROTATED_TEST_TOKEN" }, { unpair: true }, { forget: true }]) {
    if (!(await f.status()).paired) {
      const pairing = await f.post(`/api/bots/${f.bot.id}/telegram`, { token: "12345:TEST_ONLY_TOKEN", pair: true });
      f.say(pairing.pairing); await f.flushed();
    }
    let person = (await f.status()).people.find((p: any) => p.name === "Lee");
    if (person) { await f.post(`/api/bots/${f.bot.id}/telegram`, { personId: person.id, action: "allow" }); f.say("FAKE_APPROVE", LEE); }
    else person = await f.admit("FAKE_APPROVE");
    const card = await until(async () => (await f.messages()).find((m) => m.card?.title === "Approval needed" && !m.card.answered), "the person did not ask");
    const token = f.records().filter((r) => r.person).at(-1).token;
    await f.post(`/api/bots/${f.bot.id}/telegram`, change);
    await f.idle();
    const result = await f.post(`/api/bots/${f.bot.id}/respond`, { requestId: card.card.requestId, behavior: "allow" });
    assert.notEqual(result.outcome, "delivered");
    assert.equal(existsSync(join(f.root, "effect")), false);
    const late = await f.h.fetch(`/api/bots/${f.bot.id}/telegram/reply`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ text: "late" }) });
    assert.equal(late.status, 403);
  }
  assert.equal(f.sent(LEE).some((m) => m.body.text === "late"), false);
});

test("an uncertain reply is shown to the owner and cannot be retried by the same turn", async (t) => {
  const f = await personFixture(t);
  await f.admit("FAKE_HOLD");
  await until(() => existsSync(join(f.root, "held")), "the person did not run");
  const token = f.records().find((r) => r.person).token;
  f.sendFailures.set("uncertain answer", "disconnect");
  const send = (text: string) => f.h.fetch(`/api/bots/${f.bot.id}/telegram/reply`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ text }) });
  assert.equal((await send("x".repeat(4097))).status, 403);
  assert.equal((await send("uncertain answer")).status, 403);
  assert.equal((await f.messages()).find((m) => m.text === "uncertain answer").telegramSent.state, "uncertain");
  assert.equal((await send("uncertain answer")).status, 403);
  assert.equal(f.sent(LEE).filter((m) => m.body.text === "uncertain answer").length, 1);
  assert.equal(f.sent(LEE).some((m) => m.body.text.length > 4096), false);
  writeFileSync(join(f.root, "release"), "1"); await f.idle();
  assert.equal((await send("after the turn")).status, 403);
});

for (const kind of ["codex", "claude"] as const) test(`${kind}: owner, person, owner keeps the owner's cursor and tells the third turn the exchange`, async (t) => {
  const f = await personFixture(t, kind);
  await f.post(`/api/bots/${f.bot.id}/messages`, { text: "OWNER_BEFORE" }); await f.idle();
  const before = f.records().find((r) => !r.person);
  if (kind === "codex") assert.equal(before.guard.sandbox, "danger-full-access");
  const stateFile = join(f.root, ".bloks/bots.json");
  const savedLane = () => JSON.parse(readFileSync(stateFile, "utf8")).find((b: any) => b.id === f.bot.id).tasks[0];
  const ownerCursor = savedLane().resumeCursors[kind];
  assert.equal(typeof ownerCursor, "string");
  await f.admit("FAKE_TEXT"); await until(() => f.records().some((r) => r.person), "person turn did not start"); await f.idle();
  const person = f.records().find((r) => r.person);
  if (kind === "claude") assert.equal(person.args.includes("--resume"), false);
  assert.equal(savedLane().resumeCursors[kind], ownerCursor);
  await f.post(`/api/bots/${f.bot.id}/messages`, { text: "OWNER_AFTER" }); await f.idle();
  const after = f.records().filter((r) => !r.person).at(-1);
  if (kind === "codex") assert.equal(after.guard.threadId, undefined, "the owner resumed without learning the exchange");
  else assert.equal(after.args.includes("--resume"), false, "the owner resumed without learning the exchange");
  assert.match(after.text, /Message from.*Lee.*Telegram/);
  assert.match(after.text, /Private transcript only/);
  assert.match(after.text, /OWNER_AFTER/);
});

for (const shape of ["system", "system-rules", "policy", "keyring"]) {
  test(`reported ${shape} permission mismatch holds visibly before a person's input`, async (t) => {
    const f = await personFixture(t);
    writeFileSync(join(f.root, "guard-case"), shape);
    if (shape === "system-rules") {
      mkdirSync(join(f.root, "rules"));
      writeFileSync(join(f.root, "rules/default.rules"), 'prefix_rule(pattern=["touch"], decision="allow")\n');
    }
    const auth = readFileSync(join(f.root, ".codex/auth.json"), "utf8");
    await f.admit();
    await until(() => f.sent(LEE).some((m) => m.body.text.startsWith("This agent cannot answer")), "the person was left in silence");
    await f.idle();
    assert.equal(f.records().length, 0, "the engine heard the person's input despite its mismatched guard");
    assert.ok((await f.messages()).some((m) => m.kind === "notice" && /held:/.test(m.text ?? "")));
    f.say("FAKE_REPLY", LEE); await f.flushed(); await f.idle();
    assert.equal(f.sent(LEE).filter((m) => m.body.text.startsWith("This agent cannot answer")).length, 1);
    assert.equal(readFileSync(join(f.root, ".codex/auth.json"), "utf8"), auth);
    assert.equal(existsSync(join(f.root, "effect")), false);
    assert.equal(f.sent(LEE).some((m) => m.body.text === "Hello Lee"), false);
  });
}

for (const shape of ["claude-mode", "claude-server"]) {
  test(`Claude reported ${shape} mismatch holds before receiving the person's words`, async (t) => {
    const f = await personFixture(t, "claude");
    writeFileSync(join(f.root, "guard-case"), shape);
    await f.admit("CLAUDE_MISMATCH_WORDS FAKE_REPLY");
    await until(() => f.sent(LEE).some((m) => m.body.text.startsWith("This agent cannot answer")) || f.records().some((r) => r.text?.includes("CLAUDE_MISMATCH_WORDS")), "Claude neither held visibly nor received the input");
    assert.equal(f.records().length, 0, "Claude received the person's words before verifying its reported permissions and tools");
    assert.ok(f.sent(LEE).some((m) => m.body.text.startsWith("This agent cannot answer")), "the person was left in silence");
    await f.idle();
    assert.ok((await f.messages()).some((m) => m.kind === "notice" && /held:/.test(m.text ?? "") && /Claude/.test(m.text ?? "")), "the owner did not see the hold reason");
    f.say("CLAUDE_MISMATCH_AGAIN FAKE_REPLY", LEE); await f.flushed(); await f.idle();
    const notices = f.sent(LEE).filter((m) => m.body.text.startsWith("This agent cannot answer"));
    assert.equal(notices.length, 1, "the neutral hold notice was repeated");
    assert.equal(notices[0].body.text.includes(shape), false, "the person received the owner's hold reason");
    assert.equal(f.records().length, 0, "a second message bypassed the Claude startup hold");
    assert.equal(existsSync(join(f.root, "effect")), false);
    assert.equal(f.sent(LEE).some((m) => m.body.text === "Hello Lee" || m.body.reply_markup), false);
  });
}

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
  assert.equal(f.sent(LEE).filter((m) => m.body.text === TELEGRAM_PEOPLE_UPGRADE).length, 1);
  await f.reboot(); await f.flushed();
  assert.equal(f.sent(LEE).filter((m) => m.body.text === TELEGRAM_PEOPLE_UPGRADE).length, 1);
});

test("a person's free-text question takes only the owner's explicit card reply", async (t) => {
  const f = await personFixture(t);
  await f.admit("FAKE_QUESTION");
  const card = await until(() => f.sent(SAM).find((m) => m.body.text.startsWith("Your agent has a question")), "no owner question card");
  assert.match(card.body.text, /for Lee/); assert.match(card.body.text, /Reply to this card/);
  f.say("OWNER_PRIVATE_WORDS"); f.say("yes", LEE); await f.flushed();
  assert.equal(f.records().some((r) => r.questionAnswer), false);
  assert.equal((await f.messages()).find((m) => m.text === "OWNER_PRIVATE_WORDS").queued, true);
  f.say("Friday", SAM, { reply_to_message: { message_id: card.messageId } }); await f.flushed();
  await until(() => f.records().some((r) => r.questionAnswer), "explicit owner answer was not accepted");
  await f.idle();
  assert.equal(f.records().find((r) => r.questionAnswer).questionAnswer.answers.q.answers[0], "Friday");
  assert.equal(f.sent(LEE).some((m) => m.body.text.includes("OWNER_PRIVATE_WORDS")), false);
});

test("an owner allow rule cannot answer a full-agent person's approval", async (t) => {
  const f = await personFixture(t, "codex", { seed: (root) => writeFileSync(join(root, ".bloks/rules.json"), JSON.stringify([{ id: "synthetic-allow", effect: "allow", field: "command", op: "contains", value: "synthetic-marker", enabled: true, createdAt: 1 }])) });
  await f.admit("FAKE_APPROVE");
  const card = await until(async () => (await f.messages()).find((m) => m.card?.title === "Approval needed"), "the owner's rule answered the person");
  assert.equal(existsSync(join(f.root, "effect")), false);
  await f.post(`/api/bots/${f.bot.id}/respond`, { requestId: card.card.requestId, behavior: "deny" }); await f.idle();
  assert.equal(existsSync(join(f.root, "effect")), false);
});

test("Claude question, secret and connection tools stay in the owner's chat", async (t) => {
  const f = await personFixture(t, "claude");
  const person = await f.admit("FAKE_BLOKS");
  const card = await until(async () => (await f.messages()).find((m) => m.card?.title === "Your agent has a question"), "Claude did not ask the owner");
  await until(() => f.sent(SAM).some((m) => m.body.text.includes("Which day?")), "the card did not reach the owner");
  f.say("Friday", LEE); await f.flushed();
  assert.equal(f.records().some((r) => r.questionAnswer), false);
  assert.equal(f.sent(LEE).some((m) => m.body.reply_markup), false);
  await f.post(`/api/bots/${f.bot.id}/respond`, { requestId: card.card.requestId, behavior: "answer", message: "Monday" });
  await until(() => f.records().some((r) => r.connectionAnswer), "the owner tools did not finish"); await f.idle();
  assert.equal(f.records().find((r) => r.questionAnswer).questionAnswer.message, "Monday");
  const cards = (await f.messages()).filter((m) => m.secret || m.connector);
  assert.equal(cards.length, 2);
  for (const m of cards) assert.equal(m.telegramPerson?.personId, person.id);
  assert.equal(cards.find((m) => m.secret).secret.status, "needs-value");
  assert.equal(cards.find((m) => m.connector).connector.status, "needs-auth");
  f.say("SYNTHETIC_VALUE", LEE); await f.flushed(); await f.idle();
  assert.equal((await f.messages()).find((m) => m.secret).secret.status, "needs-value");
  assert.equal(f.sent(LEE).some((m) => m.body.text.includes("Synthetic service key") || m.body.text.includes("Which day?") || m.body.reply_markup), false);
});

test("a Claude person's late ask stays refused after its turn ends", async (t) => {
  const f = await personFixture(t, "claude");
  await f.post(`/api/bots/${f.bot.id}/messages`, { text: "OWNER_BEFORE" }); await f.idle();
  const savedLane = () => JSON.parse(readFileSync(join(f.root, ".bloks/bots.json"), "utf8")).find((b: any) => b.id === f.bot.id).tasks[0];
  const cursor = savedLane().resumeCursors.claude;
  assert.equal(typeof cursor, "string");
  await f.admit("FAKE_LATE");
  const answer = await until(() => f.records().find((r) => r.lateAnswer)?.lateAnswer, "the late person ask was not settled");
  assert.equal(answer.behavior, "deny");
  assert.equal(existsSync(join(f.root, "effect")), false);
  assert.equal((await f.messages()).some((m) => m.card?.title === "Approval needed"), false);
  assert.equal((await f.messages()).some((m) => m.text === "LATE_PERSON_TEXT"), false);
  assert.equal(savedLane().resumeCursors.claude, cursor);
  await f.idle();
});

for (const removed of [false, true]) {
  test(`a queued person survives restart with their trust${removed ? " revoked before recovery" : " retained"}`, async (t) => {
    const f = await personFixture(t);
    await f.post(`/api/bots/${f.bot.id}/messages`, { text: "FAKE_HOLD" });
    await until(() => existsSync(join(f.root, "held")), "owner did not start");
    const person = await f.admit("FAKE_TEXT");
    const queued = await until(async () => (await f.messages()).find((m) => m.telegramPerson?.personId === person.id && m.queued), "person did not queue");
    await f.reboot(() => {
      if (!removed) return;
      const file = join(f.root, ".bloks/config.json"), cfg = JSON.parse(readFileSync(file, "utf8"));
      cfg.telegram.bots[f.bot.id].people[String(LEE)].state = "removed";
      writeFileSync(file, JSON.stringify(cfg));
    });
    if (removed) {
      await until(async () => (await f.messages()).find((m) => m.id === queued.id && m.unsent), "the revoked queue remained live");
      assert.equal((await f.messages()).find((m) => m.id === queued.id).queued, false);
      assert.equal(f.records().some((r) => r.person), false);
    } else {
      const recovered = await until(() => f.records().find((r) => r.person), "queued person was not recovered");
      await f.idle();
      assert.equal(recovered.guard.sandbox, "read-only"); assert.equal(recovered.guard.approvalPolicy, "on-request");
      assert.match(recovered.text, /Message from.*Lee.*Telegram/);
      assert.equal(f.records().filter((r) => r.person).length, 1);
    }
  });
}
