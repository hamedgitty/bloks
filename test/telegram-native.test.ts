// Existing native Telegram transport, pairing, cards and progress checks.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CHAT, STRANGER, agentCli, cardIn, fixture, sleep, waitFor } from "./helpers/telegram-native.ts";

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

test("a question its agent withdrew closes on the phone where it is, and a late tap answers nothing", async (t) => {
  const f = await fixture(t);
  f.tg.say("ASYNC_ASK which colour");
  const card = await cardIn(f, "Your agent has a question");
  await waitFor(() => f.tg.calls("sendMessage").some((c) => c.body.text === "Carried on."), "the turn never ended");
  const asked = (await f.messages()).find((m) => m.kind === "options" && m.card?.requestId);
  const before = f.tg.sent().length;
  const ran = await agentCli(f, ["unask", asked.id]);
  assert.deepEqual(ran, { status: 0, answer: { ok: true, withdrawn: asked.id } });
  const edited = await waitFor(() => f.tg.calls("editMessageText").find((c) => c.body.message_id === card.id), "the phone's copy was never closed");
  assert.equal(edited.body.text, "Your agent has a question\nWhich colour?\n\nClosed without an answer.");
  assert.deepEqual(edited.body.reply_markup, { inline_keyboard: [] });
  // closed in place: nothing new is said in the chat for it
  assert.deepEqual(f.tg.sent().slice(before).map((m) => m.body.text).filter((text) => text !== "RAN"), []);
  // a tap already on its way is told it closed, and is no answer
  f.tg.press(card.id, card.body.reply_markup.inline_keyboard[0][0].callback_data);
  const told = await waitFor(() => f.tg.calls("answerCallbackQuery")[0], "the late press was never answered");
  assert.equal(told.body.text, "Closed without an answer.");
  // and what is typed next is a message of its own, not an answer to it
  f.tg.say("NEXT please");
  await waitFor(() => f.tg.calls("sendMessage").some((c) => c.body.text === "ANSWER"), "the next words never reached the agent");
  const said = (await f.messages()).filter((m) => m.role === "user").map((m) => m.text);
  assert.ok(said.includes("NEXT please"), "the next words were not a message");
  assert.ok(!said.some((text) => text === "Red" || text === "Blue"), "the late tap was taken as an answer");
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
