// Existing native Telegram transport, pairing, cards and progress checks.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CHAT, STRANGER, cardIn, fixture, heardContext, inputWords, sleep, waitFor } from "./helpers/telegram-native.ts";

for (const path of ["immediate", "drain"] as const) for (const [prompt, expected] of [
  ["ENGINE_NOTICE", "synthetic engine refusal"],
  ["COMPLETION_FAILURE", "synthetic completion failure"],
  ["EMPTY_TURN", "(the agent finished without saying anything)"],
  ["REPLY_THEN_NOTICE", "A real reply."],
]) test(`${path} Telegram answer carries a notice only without a reply (${prompt})`, async (t) => {
  const f = await fixture(t);
  if (path === "drain") await f.post("/api/maintenance/drain", { seconds: 60 });
  f.tg.say(prompt);
  if (path === "drain") {
    await waitFor(async () => (await f.messages()).some((m) => m.text === prompt && m.telegramReply?.state === "queued"), "the request never queued");
    await f.h.json("/api/maintenance/drain", { method: "DELETE" });
  }
  const answer = await waitFor(() => f.tg.calls("sendMessage").find((c) => !c.body.disable_notification && !c.body.text.startsWith("Paired.") && !c.body.text.startsWith("Your message is saved.")), "the answer never came");
  assert.equal(answer.body.text, expected);
  assert.equal("disable_notification" in answer.body, false);
  if (prompt !== "REPLY_THEN_NOTICE") assert.equal("parse_mode" in answer.body, false, "provider notices are plain text");
  if (prompt !== "EMPTY_TURN") assert.ok((await f.messages()).some((m) => m.kind === "notice" && m.text.includes("synthetic")), "the app keeps the error notice");
  await sleep(250);
  assert.equal(f.tg.calls("sendMessage").filter((c) => c.body.text === expected).length, 1);
  assert.equal(f.tg.calls("sendMessage").filter((c) => c.body.text === "(the agent finished without saying anything)").length, prompt === "EMPTY_TURN" ? 1 : 0);
});

for (const path of ["immediate", "drain"] as const) for (const prompt of ["CLAUDE_REFUSAL", "CLAUDE_REPLY_NOTICE"]) test(`${path} Claude is_error result reaches Telegram redacted and plain (${prompt})`, async (t) => {
  const f = await fixture(t, "claude");
  if (path === "drain") await f.post("/api/maintenance/drain", { seconds: 60 });
  f.tg.say(prompt);
  if (path === "drain") {
    await waitFor(async () => (await f.messages()).some((m) => m.text === prompt && m.telegramReply?.state === "queued"), "the request never queued");
    await f.h.json("/api/maintenance/drain", { method: "DELETE" });
  }
  const expected = prompt === "CLAUDE_REFUSAL" ? "The provider refused *this* request: [redacted], [redacted]." : "A real reply.";
  const answer = await waitFor(() => f.tg.calls("sendMessage").find((c) => !c.body.disable_notification && !c.body.text.startsWith("Paired.") && !c.body.text.startsWith("Your message is saved.")), "the Claude result never reached the chat");
  assert.equal(answer.body.text, expected);
  const notices = (await f.messages()).filter((m) => m.kind === "notice");
  assert.ok(notices.some((m) => m.text.includes("The provider refused")), "the sentence-shaped reason is in the app");
  if (prompt === "CLAUDE_REFUSAL") assert.equal("parse_mode" in answer.body, false);
  assert.doesNotMatch(answer.body.text, /fixture-stored-secret-123|sk-fixture_abcdefghijklmnop/);
  assert.equal(f.tg.calls("sendMessage").filter((c) => c.body.text === "(the agent finished without saying anything)").length, 0);
});

test("an approval arrives with Allow and Deny to tap, and only the paired person's tap allows it", async (t) => {
  const f = await fixture(t);
  f.tg.say("APPROVE this");
  const card = await cardIn(f, "Approval needed");
  assert.equal(card.body.text, "Approval needed\nrm -rf build");
  assert.equal("disable_notification" in card.body, false);
  const rows = card.body.reply_markup.inline_keyboard;
  assert.deepEqual(rows.map((row: any[]) => row.map((b) => b.text)), [["Allow", "Deny"]]);
  const requestId = (await f.messages()).find((m) => m.kind === "options").card.requestId;
  for (const button of rows.flat()) {
    assert.ok(Buffer.byteLength(button.callback_data) <= 64);
    assert.ok(!button.callback_data.includes(requestId), "the request id never leaves this machine");
  }
  const allow = rows[0][0].callback_data;
  // the same button, pressed from a chat that is not paired and by
  // someone in the chat who is not the person it is paired with
  f.tg.press(card.id, allow, { chat: STRANGER, from: STRANGER });
  f.tg.press(card.id, allow, { from: STRANGER });
  await sleep(1_500);
  assert.equal(f.tg.calls("answerCallbackQuery").length, 0, "a stranger's press is not even answered");
  assert.equal(f.replies().length, 0, "and decides nothing");
  f.tg.press(card.id, allow);
  const answered = await waitFor(() => f.tg.calls("answerCallbackQuery")[0], "the press was never answered");
  assert.equal(answered.body.text, "Allowed");
  assert.deepEqual(f.replies().map((r) => r.result), [{ decision: "accept" }]);
  const edited = await waitFor(() => f.tg.calls("editMessageText").find((c) => c.body.message_id === card.id), "the card was never rewritten");
  assert.equal(edited.body.text, "Approval needed\nrm -rf build\n\nAllowed");
  assert.deepEqual(edited.body.reply_markup, { inline_keyboard: [] });
  await waitFor(() => f.tg.calls("sendMessage").some((c) => c.body.text === "DECIDED accept"), "the answer never came back");
  assert.equal(f.tg.calls("editMessageText").length, 1, "rewritten once, not again when the engine reported back");
});

test("a question's choices are one button each, and the tapped one is the answer", async (t) => {
  const f = await fixture(t);
  f.tg.say("QUESTION please");
  const card = await cardIn(f, "Your agent has a question");
  const rows = card.body.reply_markup.inline_keyboard;
  assert.deepEqual(rows.map((row: any[]) => row.map((b) => b.text)), [["Red"], ["Blue"], ["Green"]]);
  f.tg.press(card.id, rows[1][0].callback_data);
  await waitFor(() => f.tg.calls("sendMessage").some((c) => c.body.text === "PICKED Blue"), "the choice never reached the agent");
  const edited = await waitFor(() => f.tg.calls("editMessageText").find((c) => c.body.message_id === card.id), "the answered card was not rewritten");
  assert.equal(edited?.body.text, "Your agent has a question\nWhich colour?\n\nAnswered: Blue");
});

test("a question an engine asked permission to ask has its own choices, and the tapped one is the answer", async (t) => {
  // Claude Code's own question reaches Bloks labelled a permission. Read
  // as one here, the first choice allowed the asking with no answer in
  // it, and any other choice refused it.
  const f = await fixture(t, "claude");
  f.tg.say("which one");
  const card = await cardIn(f, "Your agent has a question");
  assert.equal(card.body.text, "Your agent has a question\nWhich database?");
  const rows = card.body.reply_markup.inline_keyboard;
  assert.deepEqual(rows.map((row: any[]) => row.map((b) => b.text)), [["Postgres"], ["SQLite"]]);
  f.tg.press(card.id, rows[1][0].callback_data);
  await waitFor(() => f.tg.calls("sendMessage").some((c) => c.body.text === "TOLD answer SQLite"), "the choice never reached the agent");
  const edited = f.tg.calls("editMessageText").find((c) => c.body.message_id === card.id);
  assert.equal(edited?.body.text, "Your agent has a question\nWhich database?\n\nAnswered: SQLite");
});

test("a card answered in the app is rewritten on the phone, and its buttons do nothing after", async (t) => {
  const f = await fixture(t);
  f.tg.say("APPROVE from the desk");
  const card = await cardIn(f, "Approval needed");
  const requestId = (await f.messages()).find((m) => m.kind === "options").card.requestId;
  const answered = await f.post(`/api/bots/${f.bot.id}/respond`, { requestId, behavior: "deny" });
  assert.equal(answered.outcome, "delivered");
  const edited = await waitFor(() => f.tg.calls("editMessageText").find((c) => c.body.message_id === card.id), "the phone's copy was never rewritten");
  assert.equal(edited.body.text, "Approval needed\nrm -rf build\n\nDenied");
  assert.deepEqual(edited.body.reply_markup, { inline_keyboard: [] });
  await waitFor(() => f.tg.calls("sendMessage").some((c) => c.body.text === "DECIDED decline"), "the answer never came back");
  // a tap that was already on its way says what happened, and decides nothing more
  f.tg.press(card.id, card.body.reply_markup.inline_keyboard[0][0].callback_data);
  const told = await waitFor(() => f.tg.calls("answerCallbackQuery")[0], "the late press was never answered");
  assert.equal(told.body.text, "Denied");
  assert.equal(f.replies().length, 1);
});

test("a question with no choices is still answered by typing, and says so once it is", async (t) => {
  const f = await fixture(t);
  f.tg.say("FREE answer");
  const card = await cardIn(f, "Your agent has a question");
  assert.equal(card.body.reply_markup, undefined);
  assert.match(card.body.text, /Reply with your answer\.$/);
  f.tg.say("Saturday");
  await waitFor(() => f.tg.calls("sendMessage").some((c) => c.body.text === "HEARD Saturday"), "the typed answer never reached the agent");
  const edited = f.tg.calls("editMessageText").find((c) => c.body.message_id === card.id);
  assert.equal(edited?.body.text, "Your agent has a question\nWhich day?\n\nAnswered: Saturday");
});

test("what a Telegram turn saved comes back after its answer: images as photos, the rest as files", async (t) => {
  const f = await fixture(t);
  f.tg.say("FILES please");
  const note = await waitFor(() => f.tg.calls("sendMessage").find((c) => c.body.text.startsWith("Not sent here")), "the files never finished");
  assert.equal(note.body.text, "Not sent here: footage.mov (over Telegram's 50 MB). It is in the app.");
  const order = f.tg.state.calls
    .filter((c) => ["sendMessage", "sendPhoto", "sendDocument"].includes(c.method) && !String(c.body.text ?? "").startsWith("Paired."))
    .map((c) => c.body.text ?? `${c.method} ${(c.body.photo ?? c.body.document).name}`);
  assert.deepEqual(order, [
    "Here are your files.",
    "sendDocument report.pdf",
    "sendPhoto chart.png",
    "Not sent here: footage.mov (over Telegram's 50 MB). It is in the app.",
  ]);
  const photo = f.tg.calls("sendPhoto")[0]!.body;
  assert.equal(photo.chat_id, String(CHAT));
  assert.deepEqual(photo.photo, { name: "chart.png", type: "image/png", size: 29 });
  assert.equal(f.tg.calls("sendDocument")[0]!.body.chat_id, String(CHAT));
  assert.equal("disable_notification" in photo, false);
  assert.equal("disable_notification" in f.tg.calls("sendDocument")[0]!.body, false);
});

test("only a few files come back with one answer, and the rest are counted", async (t) => {
  const f = await fixture(t);
  f.tg.say("MANY parts");
  const note = await waitFor(() => f.tg.calls("sendMessage").find((c) => c.body.text.startsWith("Not sent here")), "the files never finished");
  assert.equal(note.body.text, "Not sent here: 2 more files (only 5 come with an answer). They are in the app.");
  assert.deepEqual(f.tg.calls("sendDocument").map((c) => c.body.document.name), ["part-1.txt", "part-2.txt", "part-3.txt", "part-4.txt", "part-5.txt"]);
});

test("files from a turn that did not begin on Telegram stay in the app", async (t) => {
  const f = await fixture(t);
  await f.post(`/api/bots/${f.bot.id}/messages`, { text: "FILES from the desk" });
  await waitFor(async () => (await f.messages()).some((m) => m.kind === "artifact" && m.artifact.name === "chart.png"), "the turn never saved its files");
  await sleep(1_000);
  assert.deepEqual([...f.tg.calls("sendPhoto"), ...f.tg.calls("sendDocument")], []);
});

test("a long turn posts new silent visible notes, then deletes them before its final-only answer", async (t) => {
  const f = await fixture(t);
  const asked = Date.now();
  f.tg.say("SLOW work");
  const first = await waitFor(() => f.tg.state.calls.find((m) => m.body.disable_notification || m.method === "editMessageText"), "no notes message was posted", 40_000);
  assert.equal(first.method, "sendMessage", "notes must be new posts, never edits");
  assert.equal(first.body.text, "I am checking the parser.");
  assert.equal(first.body.disable_notification, true);
  assert.ok(first.at - asked >= 19_000, "posted after " + (first.at - asked) + " ms, not about twenty seconds");
  const answer = await waitFor(() => f.tg.state.calls.find((c) => c.method === "sendMessage" && c.body.text === "SLOW DONE"), "the answer never came", 40_000);
  assert.equal("disable_notification" in answer.body, false);
  const notes = f.tg.sent().filter((c) => c.body.disable_notification);
  assert.equal(notes.length, 2);
  assert.deepEqual(notes.map((c) => c.body.text), ["I am checking the parser.", "The parser checks pass.\n\nI am checking the build."]);
  assert.ok(notes[1].at - notes[0].at >= 3_800, "new notes obey the throttle");
  assert.ok(notes.every((c) => !c.body.parse_mode));
  assert.equal(f.tg.calls("editMessageText").length, 0);
  assert.ok(f.tg.calls("sendMessage").every((c) => !c.body.text.includes("Working:")));
  assert.doesNotMatch(JSON.stringify(f.tg.state.calls), /PRIVATE_REASONING|npm test|npm run build|git status/);
  assert.deepEqual(f.tg.calls("deleteMessage").map((c) => c.body), notes.map((c) => ({ chat_id: CHAT, message_id: c.id })));
  assert.ok(notes.every((c) => f.tg.state.deleted.some((d) => d.id === c.id && d.at <= answer.at)), "every known message is gone before the answer");
});

test("a turn with tools and no visible note posts nothing extra even after twenty seconds", async (t) => {
  const f = await fixture(t);
  f.tg.say("SLOW_NO_NOTE");
  await waitFor(() => f.tg.calls("sendMessage").some((c) => c.body.text === "NO NOTE DONE"), "the empty-note turn never ended", 40_000);
  assert.equal(f.tg.calls("sendMessage").filter((c) => c.body.disable_notification).length, 0);
  assert.equal(f.tg.calls("editMessageText").length, 0);
});

test("Claude thinking items never reach the notes messages or final answer", async (t) => {
  const f = await fixture(t, "claude");
  f.tg.say("CLAUDE_THINKING");
  const status = await waitFor(() => f.tg.sent().find((m) => m.body.disable_notification), "no visible Claude note", 40_000);
  assert.equal(status.body.text, "A visible note.");
  const answer = await waitFor(() => f.tg.calls("sendMessage").find((c) => c.body.text === "THINKING DONE"), "no Claude final answer", 40_000);
  assert.equal("disable_notification" in answer.body, false);
  assert.doesNotMatch(JSON.stringify(f.tg.state.calls), /PRIVATE_THINKING/);
  assert.doesNotMatch(JSON.stringify(await f.messages()), /PRIVATE_THINKING/);
  assert.ok(f.tg.calls("deleteMessage")[0].at <= answer.at);
});

test("all notes messages are deleted before an error notice when their text was taken back", async (t) => {
  const f = await fixture(t);
  f.tg.say("SLOW_ERROR");
  await waitFor(() => f.tg.sent().filter((m) => m.body.disable_notification).length === 2, "no two notes before error", 40_000);
  const notes = f.tg.sent().filter((m) => m.body.disable_notification);
  assert.deepEqual(notes.map((m) => m.body.text), ["I am checking the parser.", "The parser checks pass."]);
  const transcript = await f.messages();
  const from = transcript.findIndex((m) => m.role === "user" && m.text === "SLOW_ERROR");
  assert.ok(from >= 0);
  const rows = transcript.slice(from + 1).filter((m) => m.kind === "text" && m.role === "bot");
  assert.equal(rows.length, 2);
  for (const note of rows) await f.h.json("/api/threads/" + f.bot.threadId + "/messages/" + note.id, { method: "DELETE" });
  writeFileSync(join(f.root, "error-release"), "1");
  const answer = await waitFor(() => f.tg.calls("sendMessage").find((c) => c.body.text === "synthetic failure after a note" && !c.body.disable_notification), "no notice after error", 40_000);
  assert.equal("parse_mode" in answer.body, false);
  assert.equal(f.tg.calls("editMessageText").length, 0);
  assert.deepEqual(f.tg.calls("deleteMessage").map((c) => c.body.message_id), notes.map((m) => m.id));
  assert.ok(notes.every((m) => f.tg.state.deleted.some((d) => d.id === m.id && d.at <= answer.at)));
  assert.ok((await f.messages()).some((m) => m.kind === "notice" && m.text.includes("synthetic failure after a note")));
});

test("stopping a native turn deletes its notes before a fresh answer", async (t) => {
  const f = await fixture(t);
  f.tg.say("SLOW_STOP");
  const status = await waitFor(() => f.tg.sent().find((m) => m.body.disable_notification), "no note before stop", 40_000);
  await f.post("/api/bots/" + f.bot.id + "/interrupt", { taskId: f.bot.threadId });
  const answer = await waitFor(() => f.tg.calls("sendMessage").find((c) => c.body.text === "I am checking the parser." && !c.body.disable_notification), "no answer after stop");
  assert.ok(f.tg.calls("deleteMessage").some((c) => c.body.message_id === status.id && c.at <= answer.at));
  assert.equal(f.tg.calls("sendMessage").filter((c) => c.body.disable_notification).length, 1);
});

test("a quick turn posts no notes messages", async (t) => {
  const f = await fixture(t);
  f.tg.say("hello");
  await waitFor(() => f.tg.calls("sendMessage").some((c) => c.body.text === "ANSWER"), "the answer never came");
  assert.equal(f.tg.sent().filter((m) => m.body.disable_notification).length, 0);
  assert.equal(f.tg.calls("editMessageText").length, 0);
  assert.equal(f.tg.calls("deleteMessage").length, 0);
});

test("words said from Telegram are marked as that, and the app does not offer to redo them", async (t) => {
  const f = await fixture(t);
  f.tg.say("hello");
  await waitFor(() => f.tg.calls("sendMessage").some((c) => c.body.text === "ANSWER"), "the answer never came");
  const said = (await f.messages()).find((m) => m.role === "user" && m.text === "hello");
  assert.equal(said.fromTelegram, true, "nothing on the message says it came from Telegram");
  const redo = (id: string) => f.h.json(`/api/threads/${f.bot.threadId}/messages/${id}/redo`);
  assert.equal((await redo(said.id)).offered, false);
  // one typed in the app, in the same conversation, is the person's to redo
  await f.post(`/api/bots/${f.bot.id}/messages`, { text: "typed here" });
  const typed = await waitFor(async () => {
    const list = await f.messages();
    return list.filter((m) => m.text === "ANSWER").length === 2 && list.find((m) => m.text === "typed here");
  }, "the typed message was never answered");
  assert.ok(!typed.fromTelegram);
  await waitFor(async () => (await redo(typed.id)).offered === true, "a message typed in the app was not offered a redo");
});

test("a button from before a restart says its card has closed, and loses its buttons", async (t) => {
  const f = await fixture(t);
  f.tg.press(55, "AAAAAAAA:0");
  const told = await waitFor(() => f.tg.calls("answerCallbackQuery")[0], "the press was never answered");
  assert.equal(told.body.text, "That card has already closed.");
  const cleared = await waitFor(() => f.tg.calls("editMessageReplyMarkup")[0], "its buttons were left in place");
  assert.deepEqual(cleared.body, { chat_id: CHAT, message_id: 55, reply_markup: { inline_keyboard: [] } });
});

test("two agent bots do not borrow owner pairing or intake when their private chat id is the same", async (t) => {
  const f = await fixture(t);
  const { bot: second } = await f.post("/api/bots", { name: "Lee" });
  await f.h.json(`/api/bots/${second.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" } }) });
  const token = "22222:SECOND_TEST_TOKEN";
  const status = await f.post(`/api/bots/${second.id}/telegram`, { token, enabled: true });
  assert.equal(status.needsOwnerPairing, true);
  f.tg.say("NOT_PAIRED_YET", token);
  await waitFor(() => f.tg.calls("sendMessage").some((call) => call.token === token && call.body.text.startsWith("The owner has been asked")), "the second bot borrowed the first bot's pairing");
  const list = async (id: string) => (await f.h.json(`/api/bots/${id}/messages?limit=500`)).messages;
  assert.equal((await list(second.id)).some((message: any) => message.text === "NOT_PAIRED_YET"), false);
  const pairing = await f.post(`/api/bots/${second.id}/telegram`, { pair: true });
  f.tg.say(pairing.pairing, token);
  await waitFor(async () => (await f.h.json(`/api/bots/${second.id}/telegram`)).ownerPaired, "the second owner pairing did not complete");
  assert.deepEqual((await f.h.json(`/api/bots/${second.id}/telegram`)).people, [], "the owner was still offered as a pending person");
  f.tg.say("ONLY_SECOND_BOT", token);
  await waitFor(() => f.tg.calls("sendMessage").some((call) => call.token === token && call.body.text === "ANSWER"), "the second bot's answer did not use its token");
  assert.equal((await list(second.id)).some((message: any) => message.text === "ONLY_SECOND_BOT"), true);
  assert.equal((await f.messages()).some((message) => message.text === "ONLY_SECOND_BOT" || message.text === pairing.pairing), false);
  f.tg.say("ONLY_FIRST_BOT");
  await waitFor(async () => (await f.messages()).some((message) => message.text === "ONLY_FIRST_BOT"), "the first bot stopped receiving its chat");
  assert.equal((await list(second.id)).some((message: any) => message.text === "ONLY_FIRST_BOT"), false);
  const publicStatus = await f.h.json("/api/telegram");
  assert.equal(JSON.stringify(publicStatus).includes(token), false);
});

test("a duplicate Telegram bot is refused even under a different token string", async (t) => {
  const f = await fixture(t);
  const { bot: second } = await f.post("/api/bots", { name: "Lee" });
  const response = await f.h.fetch(`/api/bots/${second.id}/telegram`, { method: "POST", body: JSON.stringify({ token: "12345:ROTATED_TEST_TOKEN" }) });
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /already belongs/);
  assert.equal((await f.h.json(`/api/bots/${second.id}/telegram`)).configured, false);
  assert.equal((await f.h.json(`/api/bots/${f.bot.id}/telegram`)).ownerPaired, true);
});

test("rotation and removal invalidate held old polls before they write into a conversation", async (t) => {
  const f = await fixture(t);
  const original = "12345:TEST_ONLY_TOKEN";
  f.tg.state.holdToken = original;
  await waitFor(() => f.tg.state.heldPolls.length, "the old bot never held a poll");
  f.tg.say("OLD_ROTATION_MESSAGE", original);
  const nextToken = "12345:ROTATED_TEST_TOKEN";
  await f.post(`/api/bots/${f.bot.id}/telegram`, { token: nextToken });
  f.tg.state.holdToken = nextToken;
  for (const release of f.tg.state.heldPolls.splice(0)) release();
  await waitFor(() => f.tg.state.heldPolls.length, "the rotated bot never started its own poll");
  assert.equal((await f.messages()).some((message) => message.text === "OLD_ROTATION_MESSAGE"), false);
  f.tg.say("OLD_REMOVAL_MESSAGE", nextToken);
  await f.post(`/api/bots/${f.bot.id}/telegram`, { forget: true });
  for (const release of f.tg.state.heldPolls.splice(0)) release();
  await sleep(150);
  assert.equal((await f.messages()).some((message) => message.text === "OLD_REMOVAL_MESSAGE"), false);
  assert.equal((await f.h.json(`/api/bots/${f.bot.id}/telegram`)).configured, false);
});


test("a real 2.6 config upgrade tells both old chats and identifies the owner with a fresh word", async (t) => {
  const f = await fixture(t);
  await f.h.crash();
  const file = join(f.root, ".bloks", "config.json");
  const config = JSON.parse(readFileSync(file, "utf8"));
  const offset = config.telegram.bots[f.bot.id].offset;
  config.telegram = { token: "12345:TEST_ONLY_TOKEN", botId: f.bot.id, enabled: true, chatIds: [CHAT, STRANGER], offset, pairing: "old-word" };
  writeFileSync(file, JSON.stringify(config));
  await f.reboot();
  const migrated = JSON.parse(readFileSync(file, "utf8")).telegram;
  assert.equal(migrated.version, 2);
  assert.equal(migrated.token, undefined);
  assert.equal(migrated.migratedBotId, f.bot.id);
  assert.equal(migrated.bots[f.bot.id].offset, offset);
  assert.deepEqual(migrated.bots[f.bot.id].chatIds, []);
  assert.deepEqual(migrated.bots[f.bot.id].upgradeNotices.map((n: any) => n.chatId), [CHAT, STRANGER]);
  assert.equal(migrated.bots[f.bot.id].ownerUserId, undefined);
  assert.equal(migrated.bots[f.bot.id].pairing, null);
  const status = await f.h.json(`/api/bots/${f.bot.id}/telegram`);
  assert.equal(status.needsOwnerPairing, true);
  assert.equal(status.legacyPaired, 0);
  const pairing = await f.post(`/api/bots/${f.bot.id}/telegram`, { pair: true });
  assert.notEqual(pairing.pairing, "old-word");
  f.tg.say(pairing.pairing);
  await waitFor(async () => (await f.h.json(`/api/bots/${f.bot.id}/telegram`)).ownerPaired, "fresh word did not identify owner");
  const paired = JSON.parse(readFileSync(file, "utf8")).telegram.bots[f.bot.id];
  assert.equal(paired.ownerUserId, CHAT);
  assert.deepEqual(paired.chatIds, []);
  f.tg.say("Sam after upgrade");
  await waitFor(() => f.tg.sent().find((c) => c.body.chat_id === CHAT && c.body.text === "ANSWER"), "owner chat stopped working after upgrade");
  f.tg.say("Lee after upgrade", "12345:TEST_ONLY_TOKEN", STRANGER);
  await waitFor(() => f.tg.sent().find((c) => c.body.chat_id === STRANGER && c.body.text.startsWith("The owner has been asked")), "second legacy chat had no way to knock");
  assert.equal(f.tg.sent().some((c) => c.body.chat_id === STRANGER && c.body.text === "ANSWER"), false);
});


test("a real turn credential cannot read bot settings, pair or remove its Telegram bot", async (t) => {
  const f = await fixture(t);
  f.tg.say("SETTINGS_GUARD");
  await waitFor(() => f.tg.sent().some((c) => c.body.text === "GUARDS [403,403,403,403]"), "an agent bearer reached owner-only Telegram settings");
  const status = await f.h.json(`/api/bots/${f.bot.id}/telegram`);
  assert.equal(status.configured, true);
  assert.equal(status.ownerPaired, true);
  assert.equal(status.pairing, null);
});

async function savedTelegram(f: Awaited<ReturnType<typeof fixture>>, telegram: unknown) {
  await f.h.crash();
  const file = join(f.root, ".bloks", "config.json");
  const config = JSON.parse(readFileSync(file, "utf8"));
  config.telegram = telegram;
  writeFileSync(file, JSON.stringify(config));
  await f.reboot();
}

test("deleting an agent removes its token, retires its poller and lets another agent use the bot", async (t) => {
  const f = await fixture(t);
  const token = "12345:TEST_ONLY_TOKEN";
  const { bot: second } = await f.post("/api/bots", { name: "Lee" });
  f.tg.state.holdToken = token;
  await waitFor(() => f.tg.state.heldPolls.length, "no held poll before deletion");
  const response = await f.h.fetch(`/api/bots/${f.bot.id}?forget=1`, { method: "DELETE" });
  assert.equal(response.status, 200);
  const config = readFileSync(join(f.root, ".bloks", "config.json"), "utf8");
  assert.equal(JSON.parse(config).telegram.bots[f.bot.id], undefined);
  assert.equal(config.includes(token), false, "deleted agent token stayed on disk");
  const polls = f.tg.state.pollTokens.length;
  for (const release of f.tg.state.heldPolls.splice(0)) release();
  await sleep(250);
  assert.equal(f.tg.state.pollTokens.length, polls, "deleted agent's poller kept running");
  f.tg.state.holdToken = "";
  const saved = await f.h.fetch(`/api/bots/${second.id}/telegram`, { method: "POST", body: JSON.stringify({ token }) });
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).needsOwnerPairing, true);
});

test("bindings without their agent are neither identified, polled nor counted as duplicates", async (t) => {
  const f = await fixture(t);
  const orphan = "33333:RESTORED_ONLY_TEST_TOKEN";
  f.tg.state.getMeReplies.set(orphan, { status: 401, body: { ok: false } });
  await savedTelegram(f, { version: 1, bots: {
    absentKnown: { token: "12345:OLD_TEST_TOKEN", telegramId: 12345, generation: "old", enabled: true },
    absentUnknown: { token: orphan },
  } });
  const before = f.tg.calls("getMe").length;
  const saved = await f.h.fetch(`/api/bots/${f.bot.id}/telegram`, { method: "POST", body: JSON.stringify({ token: "12345:TEST_ONLY_TOKEN" }) });
  assert.equal(saved.status, 200);
  await waitFor(() => f.tg.state.pollTokens.includes("12345:TEST_ONLY_TOKEN"), "restored token blocked the real agent's poller");
  assert.equal(f.tg.calls("getMe").slice(before).some((call) => call.token === orphan || call.token === "12345:OLD_TEST_TOKEN"), false);
  assert.equal(f.tg.state.pollTokens.includes(orphan), false);
  const state = JSON.parse(readFileSync(join(f.root, ".bloks", "config.json"), "utf8")).telegram;
  assert.equal(state.bots.absentUnknown.telegramId, undefined);
  assert.equal(state.bots[f.bot.id].telegramId, 12345);
});

for (const sameAgent of [true, false]) {
  test(`a refused unidentified legacy token does not block a valid token on ${sameAgent ? "the same" : "another"} agent`, async (t) => {
    const f = await fixture(t);
    const { bot: second } = await f.post("/api/bots", { name: "Lee" });
    const old = "88888:REVOKED_TEST_TOKEN";
    f.tg.state.getMeReplies.set(old, sameAgent ? { status: 401, body: { ok: false } } : { body: { ok: false } });
    await savedTelegram(f, { token: old, enabled: true, botId: f.bot.id, chatIds: [CHAT, STRANGER], offset: 0 });
    const id = sameAgent ? f.bot.id : second.id;
    const response = await f.h.fetch(`/api/bots/${id}/telegram`, { method: "POST", body: JSON.stringify({ token: "22222:VALID_TEST_TOKEN" }) });
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
    const state = JSON.parse(readFileSync(join(f.root, ".bloks", "config.json"), "utf8")).telegram.bots;
    assert.equal(state[id].token, "22222:VALID_TEST_TOKEN");
    assert.equal(state[id].telegramId, 22222);
    await waitFor(() => f.tg.state.pollTokens.includes("22222:VALID_TEST_TOKEN"), "new token did not poll");
  });
}

test("an unidentified live binding still refuses a different token for the same bot", async (t) => {
  const f = await fixture(t);
  const { bot: second } = await f.post("/api/bots", { name: "Lee" });
  const binding = JSON.parse(readFileSync(join(f.root, ".bloks", "config.json"), "utf8")).telegram.bots[f.bot.id];
  delete binding.telegramId;
  binding.enabled = false;
  await savedTelegram(f, { version: 1, bots: { [f.bot.id]: binding } });
  const response = await f.h.fetch(`/api/bots/${second.id}/telegram`, { method: "POST", body: JSON.stringify({ token: "12345:ROTATED_TEST_TOKEN" }) });
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /already belongs/);
  assert.equal((await f.h.json(`/api/bots/${second.id}/telegram`)).configured, false);
});

test("failure to reach an old binding names the saved bot, not a refusal of the valid new token", async (t) => {
  const f = await fixture(t);
  const { bot: second } = await f.post("/api/bots", { name: "Lee" });
  const old = "12345:TEST_ONLY_TOKEN";
  const binding = JSON.parse(readFileSync(join(f.root, ".bloks", "config.json"), "utf8")).telegram.bots[f.bot.id];
  delete binding.telegramId;
  binding.enabled = false;
  await savedTelegram(f, { version: 2, bots: { [f.bot.id]: binding } });
  f.tg.state.getMeReplies.set(old, { status: 0, body: {} });
  const response = await f.h.fetch(`/api/bots/${second.id}/telegram`, { method: "POST", body: JSON.stringify({ token: "22222:VALID_TEST_TOKEN" }) });
  assert.equal(response.status, 502);
  const body = await response.json();
  assert.match(body.error, /verify a saved Telegram bot/);
  assert.doesNotMatch(body.error, /token was refused/);
  assert.equal((await f.h.json(`/api/bots/${second.id}/telegram`)).configured, false);
  assert.deepEqual(JSON.parse(readFileSync(join(f.root, ".bloks", "config.json"), "utf8")).telegram.bots[f.bot.id], binding);
});

for (const mode of ["same token", "same bot id", "App Settings move"]) {
  test(`a pending migration through ${mode} keeps notice jobs and offset without carrying old grants`, async (t) => {
    const f = await fixture(t);
    const token = "12345:TEST_ONLY_TOKEN";
    await savedTelegram(f, { token, enabled: true, botId: "deleted-agent", chatIds: [CHAT, STRANGER], offset: 17 });
    f.tg.state.next = 18;
    const body = mode === "App Settings move" ? { migrate: true } : { token: mode === "same bot id" ? "12345:ROTATED_TEST_TOKEN" : token };
    const response = await f.h.fetch(`/api/bots/${f.bot.id}/telegram`, { method: "POST", body: JSON.stringify(body) });
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
    const config = JSON.parse(readFileSync(join(f.root, ".bloks", "config.json"), "utf8"));
    assert.equal(config.telegram.pending, undefined);
    assert.equal(config.telegram.migrationError, undefined);
    assert.equal(config.telegram.migratedBotId, f.bot.id);
    assert.deepEqual(config.telegram.bots[f.bot.id].chatIds, []);
    assert.deepEqual(config.telegram.bots[f.bot.id].upgradeNotices.map((n: any) => n.chatId), [CHAT, STRANGER]);
    assert.equal(config.telegram.bots[f.bot.id].offset, 17);
    assert.equal(config.telegram.bots[f.bot.id].ownerUserId, undefined);
    assert.equal((await f.h.json(`/api/bots/${f.bot.id}/telegram`)).needsOwnerPairing, true);
    const activeToken = config.telegram.bots[f.bot.id].token;
    f.tg.say("Lee after pending migration", activeToken, STRANGER);
    await waitFor(() => f.tg.sent().some((call) => call.token === activeToken && call.body.chat_id === STRANGER && call.body.text.startsWith("The owner has been asked")), "the second legacy chat had no way to knock");
    assert.equal(f.tg.sent().some((call) => call.token === activeToken && call.body.chat_id === STRANGER && call.body.text === "ANSWER"), false);
  });
}

test("an App Settings pending move visibly refuses a bot already bound to another agent", async (t) => {
  const f = await fixture(t);
  const { bot: second } = await f.post("/api/bots", { name: "Lee" });
  const state = JSON.parse(readFileSync(join(f.root, ".bloks", "config.json"), "utf8")).telegram;
  state.pending = { token: "12345:ROTATED_TEST_TOKEN", chatIds: [CHAT, STRANGER], enabled: true, offset: 17 };
  await savedTelegram(f, state);
  const response = await f.h.fetch(`/api/bots/${second.id}/telegram`, { method: "POST", body: JSON.stringify({ migrate: true }) });
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /already belongs/);
  const config = JSON.parse(readFileSync(join(f.root, ".bloks", "config.json"), "utf8"));
  assert.deepEqual(config.telegram.pending.chatIds, [CHAT, STRANGER]);
  assert.equal(config.telegram.bots[second.id], undefined);
  assert.equal(f.tg.state.pollTokens.includes("12345:ROTATED_TEST_TOKEN"), false);
});

test("invalid getMe results leave the binding, generation, owner and answering poller unchanged", async (t) => {
  const f = await fixture(t);
  const bad = "99999:INVALID_TEST_TOKEN";
  const good = { id: 99999, is_bot: true, username: "PlanningBot" };
  const cases = [
    { status: 401, body: { ok: false } },
    { body: { ok: false, result: good } },
    { body: { ok: true, result: { ...good, is_bot: false } } },
    { body: { ok: true, result: { is_bot: true, username: "PlanningBot" } } },
    { body: { ok: true, result: { ...good, id: 0 } } },
    { body: { ok: true, result: { ...good, id: -1 } } },
  ];
  for (const [i, denied] of cases.entries()) {
    const before = JSON.parse(readFileSync(join(f.root, ".bloks", "config.json"), "utf8")).telegram.bots[f.bot.id];
    f.tg.state.getMeReplies.set(bad, denied);
    const response = await f.h.fetch(`/api/bots/${f.bot.id}/telegram`, { method: "POST", body: JSON.stringify({ token: bad }) });
    assert.equal(response.status, 400, `invalid getMe case ${i} was accepted`);
    const after = JSON.parse(readFileSync(join(f.root, ".bloks", "config.json"), "utf8")).telegram.bots[f.bot.id];
    assert.deepEqual(after, before, `invalid getMe case ${i} changed the connection`);
    const replies = f.tg.sent().filter((call) => call.body.text === "ANSWER").length;
    f.tg.say(`Sam after refused token ${i}`);
    await waitFor(() => f.tg.sent().filter((call) => call.body.text === "ANSWER").length > replies, `invalid getMe case ${i} stopped the old poller`);
  }
});

test("unpairing without disabling retires an in-flight answer by generation", async (t) => {
  const f = await fixture(t);
  f.tg.say("HOLD_UNPAIR");
  await waitFor(() => existsSync(join(f.root, "unpair-started")), "the old turn did not start");
  const response = await f.h.fetch(`/api/bots/${f.bot.id}/telegram`, { method: "POST", body: JSON.stringify({ unpair: true }) });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).enabled, true);
  writeFileSync(join(f.root, "unpair-release"), "1");
  await waitFor(async () => (await f.messages()).some((message) => message.role === "bot" && message.text === "OLD_UNPAIRED_ANSWER"), "the old turn never finished in the app");
  await sleep(150);
  assert.equal(f.tg.sent().some((call) => call.body.text === "OLD_UNPAIRED_ANSWER"), false, "the unpaired chat received its retired answer");
});

test("a normal phone request finishes independently of another busy lane", async (t) => {
  const f = await fixture(t);
  const { bot } = await f.post("/api/bots/" + f.bot.id + "/tasks", { title: "Aside" });
  const aside = bot.tasks.find((task: any) => task.id !== f.bot.threadId)!;
  const active = await f.post("/api/bots/" + f.bot.id + "/tasks/" + f.bot.threadId + "/activate");
  assert.equal(active.bot.activeTaskId, f.bot.threadId);
  await f.post("/api/bots/" + f.bot.id + "/messages", { text: "SCOPED_HOLD", taskId: aside.id });
  await waitFor(() => existsSync(join(f.root, "SCOPED_HOLD-started")), "the aside never started");
  f.tg.say("SCOPED_PHONE");
  await waitFor(async () => (await f.messages()).some((m) => m.text === "PHONE FINAL"), "the consuming turn did not end");
  await waitFor(() => f.tg.calls("sendMessage").some(c => c.body.text === "PHONE FINAL"), "the other lane held the phone answer", 3_000);
  assert.equal(existsSync(join(f.root, "aside-release")), false);
  await f.post("/api/bots/" + f.bot.id + "/messages", { text: "SCOPED_LATER", taskId: f.bot.threadId });
  await waitFor(async () => (await f.messages()).some((m) => m.text === "LATER FINAL"), "the later turn never spoke");
  writeFileSync(join(f.root, "aside-release"), "1");
  const answer = await waitFor(() => f.tg.calls("sendMessage").find((c) => c.body.text === "PHONE FINAL"), "the original answer never came");
  assert.equal("disable_notification" in answer.body, false);
  assert.equal(f.tg.calls("sendMessage").filter((c) => c.body.text.includes("LATER")).length, 0);
  assert.equal(f.tg.calls("sendMessage").filter((c) => c.body.disable_notification).length, 0);
});

test("queued words wait without notes, start the twenty seconds at delivery, and exclude a later turn", async (t) => {
  const f = await fixture(t);
  await f.post("/api/bots/" + f.bot.id + "/messages", { text: "SCOPED_MAIN_HOLD" });
  await waitFor(() => existsSync(join(f.root, "scope-force-queue")), "the first turn never held");
  f.tg.say("SCOPED_OWNER_PROGRESS");
  const request = await waitFor(async () => (await f.messages()).find((m) => m.text === "SCOPED_OWNER_PROGRESS" && m.queued), "the phone request never queued");
  writeFileSync(join(f.root, "old-note-release"), "1");
  await waitFor(async () => (await f.messages()).some((m) => m.text === "An earlier request's late note."), "no earlier note while queued");
  await sleep(21_000);
  assert.equal(f.tg.calls("sendMessage").filter((c) => c.body.disable_notification).length, 0);
  writeFileSync(join(f.root, "main-release"), "1");
  const delivered = await waitFor(async () => (await f.messages()).find((m) => m.id === request.id && !m.queued && m.deliveredAt), "the request never delivered");
  const status = await waitFor(() => f.tg.sent().find((m) => m.body.disable_notification), "no consuming-turn note", 40_000);
  assert.equal(status.body.text, "PHONE NOTE");
  assert.ok(status.at - delivered.deliveredAt >= 19_000, "queue time must not count");
  f.tg.state.holdDelete = true;
  await waitFor(() => f.tg.state.deleteReleases.length === 1, "the notes never reached cleanup");
  await f.post("/api/bots/" + f.bot.id + "/messages", { text: "SCOPED_LATER" });
  await waitFor(async () => (await f.messages()).some((m) => m.text === "LATER FINAL"), "the later turn did not end");
  assert.equal(f.tg.calls("sendMessage").filter((c) => c.body.text === "PHONE FINAL").length, 0);
  f.tg.state.holdDelete = false; f.tg.state.deleteReleases.shift()!();
  const answer = await waitFor(() => f.tg.calls("sendMessage").find((c) => c.body.text === "PHONE FINAL"), "no queued answer");
  assert.ok(f.tg.state.deleted.some((d) => d.id === status.id && d.at <= answer.at));
  assert.equal(f.tg.calls("editMessageText").length, 0);
  assert.equal(f.tg.calls("sendMessage").filter((c) => c.body.text.includes("EARLIER") || c.body.text.includes("LATER")).length, 0);
});

test("a queued phone request taken back in the app sends none of the running turn's text", async (t) => {
  const f = await fixture(t);
  await f.post("/api/bots/" + f.bot.id + "/messages", { text: "SCOPED_MAIN_HOLD" });
  await waitFor(() => existsSync(join(f.root, "scope-force-queue")), "the first turn never held");
  f.tg.say("SCOPED_PHONE");
  const request = await waitFor(async () => (await f.messages()).find((m) => m.text === "SCOPED_PHONE" && m.queued), "the phone request never queued");
  writeFileSync(join(f.root, "old-note-release"), "1");
  await waitFor(async () => (await f.messages()).some((m) => m.text === "An earlier request's late note."), "no earlier note");
  await f.h.json("/api/threads/" + f.bot.threadId + "/messages/" + request.id, { method: "DELETE" });
  const fallback = "(the agent finished without saying anything)";
  await waitFor(() => f.tg.calls("sendMessage").some((c) => c.body.text === fallback), "no no-text answer after takeback");
  writeFileSync(join(f.root, "main-release"), "1");
  await waitFor(async () => (await f.messages()).some((m) => m.text === "EARLIER FINAL"), "the original work was lost");
  assert.equal(f.tg.calls("sendMessage").filter((c) => /earlier|PHONE/i.test(c.body.text)).length, 0);
  assert.equal(f.tg.calls("sendMessage").filter((c) => c.body.disable_notification).length, 0);
  assert.equal(existsSync(join(f.root, "SCOPED_PHONE-started")), false);
});

const ctxOriginal = (id: number, text = "Earlier sample") => ({ message_id: id, chat: { id: CHAT }, from: { first_name: "Sample author" }, text });


test("reply context reaches saved Telegram input and direct engine prompt once", async t => {
  const f = await fixture(t); f.tg.say("Current request", undefined, CHAT, { ...ctxOriginal(11), text: undefined, caption: "Earlier document caption", document: { file_id: "quoted", file_name: "sample.pdf" } });
  const calls = await waitFor(() => { const c = heardContext(f); return c.length ? c : null }, "no direct input"); const words = inputWords(calls[0]);
  assert.match(words, /Replying to Sample author's earlier message: "Earlier document caption"/); assert.equal((words.match(/Replying to/g) ?? []).length, 1);
  const saved = await waitFor(async () => { const m = (await f.messages()).find(m => m.text === "Current request"); return m ?? null }, "no saved input");
  assert.deepEqual(saved.replyTo, { id: `tg:${CHAT}:11`, author: "Sample author", excerpt: "Earlier document caption" }); assert.equal(saved.fromTelegram, true);
  assert.equal(f.tg.calls("getFile").length, 0, "quoted document must not be downloaded");
});
test("reply context accepted steer matches in-app steer without quote-driven skills", async t => {
  const f = await fixture(t); f.tg.say("CTX_HOLD"); await waitFor(() => existsSync(join(f.root, "ctx-started")), "no active turn");
  f.tg.say("Telegram followup", undefined, CHAT, ctxOriginal(12, "/compact $quoted_skill"));
  await waitFor(() => heardContext(f).some(c => c.method === "turn/steer"), "no Telegram steer");
  await f.post(`/api/bots/${f.bot.id}/messages`, { text: "In-app followup", replyTo: { author: "Sample author", excerpt: "/compact $quoted_skill", id: "app-ref" } });
  const calls = await waitFor(() => { const c = heardContext(f).filter(c => c.method === "turn/steer"); return c.length === 2 ? c : null }, "no in-app steer");
  for (const c of calls) { assert.match(inputWords(c), /Replying to Sample author's earlier message/); assert.equal((inputWords(c).match(/Replying to/g) ?? []).length, 1); assert.ok(c.params.input.every((i: any) => i.type === "text"), "quoted skill is not activated") }
  const rows = await f.messages(); for (const text of ["Telegram followup", "In-app followup"]) { const row = rows.find(m => m.text === text); assert.equal(row.midTurn, true); assert.ok(row.replyTo) }
  writeFileSync(join(f.root, "ctx-release"), "1");
});
test("reply context survives definite steer refusal and its queued delivery", async t => {
  const f = await fixture(t); writeFileSync(join(f.root, "scope-force-queue"), "1"); await f.post(`/api/bots/${f.bot.id}/messages`, { text: "CTX_HOLD" }); await waitFor(() => existsSync(join(f.root, "ctx-started")), "no active turn");
  f.tg.say("Queued Telegram request", undefined, CHAT, ctxOriginal(13, "Queued sample excerpt"));
  const row = await waitFor(async () => (await f.messages()).find(m => m.text === "Queued Telegram request" && m.queued), "no queued input"); assert.equal(row.replyTo.excerpt, "Queued sample excerpt");
  writeFileSync(join(f.root, "ctx-release"), "1");
  const c = await waitFor(() => heardContext(f).find(c => c.method === "turn/start" && inputWords(c).includes("Queued Telegram request")), "no queued engine delivery"); assert.match(inputWords(c), /Queued sample excerpt/); assert.equal((inputWords(c).match(/Replying to/g) ?? []).length, 1);
});
