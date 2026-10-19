// Long-running ordinary Telegram replies use their consuming turn's end.
// Kept apart from the existing native suite's five-minute file budget.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CHAT, cardIn, fixture, heardContext, inputWords, sleep, waitFor } from "./helpers/telegram-native.ts";

// Move only the real fixture server's wall clock. Its ordinary 250ms
// waiter still runs, so restoring either old deadline causes phone output.
async function jumpPastWait(f: Awaited<ReturnType<typeof fixture>>, minutes: number) {
  writeFileSync(join(f.root, "telegram-clock-offset"), String(minutes * 60_000));
  await sleep(900);
}
const phoneReturns = (f: Awaited<ReturnType<typeof fixture>>) => f.tg.calls("sendMessage").filter(c =>
  !c.body.disable_notification && c.body.text !== "Sent." && !/^(Paired\.|Your agent has a question|Approval needed)/.test(c.body.text));

for (const branch of ["started", "steered"] as const) for (const minutes of [19, 25]) test(`timeout: ${branch} request at ${minutes} minutes retains phone ownership until real completion`, async t => {
  const f = await fixture(t, "codex", true);
  const cardKind = branch === "started" ? "question" : "approval";
  writeFileSync(join(f.root, `timeout-${cardKind}`), "1");
  if (branch === "started") f.tg.say("TIMEOUT_HOLD");
  else {
    writeFileSync(join(f.root, "timeout-card-delayed"), "1");
    await f.post(`/api/bots/${f.bot.id}/messages`, { text: "TIMEOUT_HOLD" });
    await waitFor(() => existsSync(join(f.root, "timeout-started")), "the app turn never started");
    f.tg.say("Please return this result");
    await waitFor(async () => (await f.messages()).some(m => m.fromTelegram && m.midTurn), "the phone request never steered");
    writeFileSync(join(f.root, "timeout-card-release"), "1");
  }
  const card = await cardIn(f, branch === "started" ? "Your agent has a question" : "Approval needed");
  await jumpPastWait(f, minutes);
  assert.deepEqual(phoneReturns(f), [], "a running request was falsely returned at the deadline");
  if (branch === "started") {
    f.tg.say("Thursday");
    await waitFor(() => existsSync(join(f.root, "timeout-card-answer")), "the late typed phone answer lost its owner");
    assert.match(readFileSync(join(f.root, "timeout-card-answer"), "utf8"), /Thursday/);
  } else {
    f.tg.press(card.id, card.body.reply_markup.inline_keyboard[0][0].callback_data);
    await waitFor(() => existsSync(join(f.root, "timeout-card-answer")), "the late approval lost its owner");
    assert.match(readFileSync(join(f.root, "timeout-card-answer"), "utf8"), /accept/);
  }
  f.tg.say("Additional sample detail");
  await waitFor(() => heardContext(f).some(c => c.method === "turn/steer" && inputWords(c).includes("Additional sample detail")), "the late follow-up did not steer");
  writeFileSync(join(f.root, "timeout-release"), "1");
  const final = await waitFor(() => phoneReturns(f).find(c => c.body.text === "REQUEST RESULT"), "the real result never returned to the phone");
  assert.equal(final.body.chat_id, CHAT);
  await sleep(400);
  assert.deepEqual(phoneReturns(f).map(c => c.body.text), ["REQUEST RESULT"]);
  for (const note of f.tg.sent().filter(c => c.body.disable_notification)) {
    assert.ok(f.tg.state.deleted.some(d => d.id === note.id && d.at <= final.at), "progress must be deleted before the answer");
  }
});

test("timeout: an intermediate failure retains the request through its retry", async t => {
  const f = await fixture(t, "codex", true);
  f.tg.say("TIMEOUT_RETRY");
  await waitFor(() => existsSync(join(f.root, "timeout-retried")), "the initial failure never ran");
  await waitFor(() => existsSync(join(f.root, "timeout-started")), "the logical turn never retried");
  await jumpPastWait(f, 25);
  assert.deepEqual(phoneReturns(f), [], "an intermediate failure settled the phone request");
  writeFileSync(join(f.root, "timeout-release"), "1");
  await waitFor(() => phoneReturns(f).some(c => c.body.text === "REQUEST RESULT"), "no retry result");
  assert.deepEqual(phoneReturns(f).map(c => c.body.text), ["REQUEST RESULT"]);
});

test("timeout: an empty captured end returns before immediately queued work ends", async t => {
  const f = await fixture(t, "codex", true);
  f.tg.say("TIMEOUT_EMPTY");
  await waitFor(() => existsSync(join(f.root, "timeout-started")), "the phone turn never started");
  writeFileSync(join(f.root, "scope-force-queue"), "1");
  const queued = await f.post(`/api/bots/${f.bot.id}/messages`, { text: "TIMEOUT_LATER" });
  assert.equal(queued.queued, true);
  // Remove the note too: this really is an empty captured answer.
  const note = (await f.messages()).find(m => m.text === "Checking the sample.");
  await f.h.json(`/api/threads/${f.bot.threadId}/messages/${note.id}`, { method: "DELETE" });
  writeFileSync(join(f.root, "timeout-release"), "1");
  await waitFor(() => existsSync(join(f.root, "timeout-later-started")), "the later turn never started");
  await waitFor(() => phoneReturns(f).some(c => c.body.text === "(the agent finished without saying anything)"), "the captured empty end waited for later work", 3_000);
  assert.deepEqual(phoneReturns(f).map(c => c.body.text), ["(the agent finished without saying anything)"]);
  writeFileSync(join(f.root, "timeout-later-release"), "1");
  await sleep(500);
  assert.equal(phoneReturns(f).some(c => c.body.text === "LATER RESULT"), false);
});

test("timeout: files use the captured request while later work runs during progress cleanup", async t => {
  const f = await fixture(t, "codex", true);
  f.tg.say("TIMEOUT_FILES");
  await waitFor(() => existsSync(join(f.root, "timeout-started")), "the phone turn never started");
  await jumpPastWait(f, 25);
  // The existing progress timer still uses real elapsed time; wait for
  // its note before holding the actual deletion request.
  await waitFor(() => f.tg.sent().some(c => c.body.disable_notification), "no progress note", 25_000);
  f.tg.state.holdDelete = true;
  writeFileSync(join(f.root, "timeout-release"), "1");
  await waitFor(() => f.tg.state.deleteReleases.length > 0, "cleanup did not hold");
  await f.post(`/api/bots/${f.bot.id}/messages`, { text: "TIMEOUT_LATER" });
  await waitFor(() => existsSync(join(f.root, "timeout-later-started")), "the later turn never started");
  writeFileSync(join(f.root, "timeout-later-release"), "1");
  await waitFor(async () => (await f.messages()).some(m => m.kind === "artifact" && m.artifact.name === "later.txt"), "later file never committed");
  f.tg.state.holdDelete = false;
  f.tg.state.deleteReleases.splice(0).forEach(release => release());
  await waitFor(() => f.tg.calls("sendDocument").length > 0, "the request file never returned");
  // This next request is serialized after every file in the prior return.
  // Its answer proves the whole batch has arrived, not just its first file.
  f.tg.say("DELIVERY_BARRIER");
  await waitFor(() => phoneReturns(f).some(c => c.body.text === "DELIVERY DONE"), "the return batch never finished");
  assert.deepEqual(f.tg.calls("sendDocument").map(c => c.body.document.name), ["earlier.txt"]);
  assert.deepEqual(phoneReturns(f).map(c => c.body.text), ["REQUEST RESULT", "DELIVERY DONE"]);
  assert.ok(f.tg.state.deleted.every(d => d.at <= phoneReturns(f)[0].at));
});

test("timeout: pre-engine failure captures its response before queued work starts", async t => {
  const f = await fixture(t, "codex", true);
  const slow = join(f.root, "slow-engine.cjs");
  writeFileSync(slow, `#!${process.execPath}
const fs = require("node:fs");
if (process.argv[2] !== "--version") process.exit(1);
fs.writeFileSync(${JSON.stringify(join(f.root, "timeout-version-started"))}, "1");
const until = Date.now() + 7000;
const tick = () => {
  if (fs.existsSync(${JSON.stringify(join(f.root, "timeout-version-release"))}) || Date.now() > until) { console.log("2.1.300 (Claude Code)"); process.exit(0); }
  setTimeout(tick, 20);
};
tick();
`, { mode: 0o755 });
  const configPath = join(f.root, ".bloks", "config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  config.instances.slow = { driver: "claudeAgent", config: { cli: slow } };
  writeFileSync(configPath, JSON.stringify(config));
  const rebuild = f.post("/api/providers/grok/connect", { key: "test-key", url: f.tg.url });
  await waitFor(() => existsSync(join(f.root, "timeout-version-started")), "the fixture rebuild never held");
  f.tg.say("NEVER_REACH_ENGINE");
  await waitFor(async () => (await f.messages()).some(m => m.fromTelegram && m.text === "NEVER_REACH_ENGINE"), "the request was not admitted");
  await waitFor(async () => (await f.h.json("/api/bots?messages=0")).bots.find((b: any) => b.id === f.bot.id)?.tasks.find((lane: any) => lane.id === f.bot.threadId)?.state === "working", "the admitted request never became busy");
  const queued = await f.post(`/api/bots/${f.bot.id}/messages`, { text: "TIMEOUT_LATER" });
  assert.equal(queued.queued, true);
  await f.post(`/api/bots/${f.bot.id}/interrupt`, { taskId: f.bot.threadId });
  writeFileSync(join(f.root, "timeout-version-release"), "1");
  await rebuild;
  await waitFor(() => existsSync(join(f.root, "timeout-later-started")), "queued work never started");
  const answer = await waitFor(() => phoneReturns(f)[0], "the pre-engine failure waited for later work", 3_000);
  assert.match(answer.body.text, /Stopped before Planning had started on it/, JSON.stringify({ messages: await f.messages(), calls: heardContext(f) }));
  const starts = heardContext(f).filter(c => c.method === "turn/start");
  assert.equal(starts.length, 1, "only the queued work may reach the engine");
  assert.match(inputWords(starts[0]), /TIMEOUT_LATER/);
  writeFileSync(join(f.root, "timeout-later-release"), "1");
  await sleep(500);
  assert.equal(phoneReturns(f).length, 1);
});

test("timeout: retiring a long wait stops its notes and leaves the next connection's cards intact", async t => {
  const f = await fixture(t, "codex", true);
  f.tg.say("TIMEOUT_HOLD");
  await waitFor(() => existsSync(join(f.root, "timeout-started")), "no phone turn");
  await jumpPastWait(f, 25);
  assert.deepEqual(phoneReturns(f), []);
  const response = await f.post(`/api/bots/${f.bot.id}/telegram`, { unpair: true });
  assert.equal(response.enabled, true);
  await sleep(350); // the retired wait's ordinary tick must exit
  const count = f.tg.calls("sendMessage").length;
  writeFileSync(join(f.root, "timeout-release"), "1");
  await waitFor(async () => (await f.messages()).some(m => m.text === "REQUEST RESULT"), "the app work was lost on unpairing");
  await sleep(350);
  assert.equal(f.tg.calls("sendMessage").length, count, "retired work sent progress or a final to the old chat");
  const paired = await f.post(`/api/bots/${f.bot.id}/telegram`, { pair: true });
  f.tg.say(paired.pairing);
  await waitFor(() => f.tg.calls("sendMessage").filter(c => c.body.text.startsWith("Paired.")).length === 2, "no new pairing");
  f.tg.say("QUESTION please");
  const card = await cardIn(f, "Your agent has a question");
  f.tg.press(card.id, card.body.reply_markup.inline_keyboard[1][0].callback_data);
  await waitFor(() => f.tg.calls("sendMessage").some(c => c.body.text === "PICKED Blue"), "stale ownership took the next card answer");
  assert.equal(f.tg.calls("sendMessage").some(c => c.body.text === "REQUEST RESULT"), false);
});

test("timeout: queued file selection excludes the work waited behind", async t => {
  const f = await fixture(t, "codex", true);
  writeFileSync(join(f.root, "timeout-behind-files"), "1");
  await f.post(`/api/bots/${f.bot.id}/messages`, { text: "SCOPED_MAIN_HOLD" });
  await waitFor(() => existsSync(join(f.root, "scope-force-queue")), "the earlier turn never started");
  f.tg.say("TIMEOUT_FILES");
  await waitFor(async () => (await f.messages()).some(m => m.text === "TIMEOUT_FILES" && m.queued), "the phone request never queued");
  writeFileSync(join(f.root, "main-release"), "1");
  await waitFor(() => existsSync(join(f.root, "timeout-started")), "the consuming turn never started");
  writeFileSync(join(f.root, "timeout-release"), "1");
  await waitFor(() => f.tg.calls("sendDocument").length > 0, "the request's file never returned");
  // This next request is serialized after every file in the prior return.
  // Its answer proves the whole batch has arrived, not just its first file.
  f.tg.say("DELIVERY_BARRIER");
  await waitFor(() => phoneReturns(f).some(c => c.body.text === "DELIVERY DONE"), "the return batch never finished");
  assert.deepEqual(f.tg.calls("sendDocument").map(c => c.body.document.name), ["earlier.txt"]);
  assert.deepEqual(phoneReturns(f).map(c => c.body.text), ["REQUEST RESULT", "DELIVERY DONE"]);
  assert.ok((await f.messages()).some(m => m.artifact?.name === "behind.txt"), "the earlier work must have committed its own file");
});

for (const mode of ["INPUT", "EMPTY", "REFUSE"] as const) test(`timeout: coalesced steer receipt and terminal frames (${mode}) retain the exact request`, async t => {
  const f = await fixture(t, "codex", true);
  await f.post(`/api/bots/${f.bot.id}/messages`, { text: "TIMEOUT_HOLD" });
  await waitFor(async () => (await f.messages()).some(m => m.text === "Checking the sample."), "the initial work never spoke");
  f.tg.say(`RAPID_${mode}`);
  const expected = mode === "INPUT" ? "RAPID FINAL" : mode === "EMPTY" ? "(the agent finished without saying anything)" : "QUEUED RESULT";
  const final = await waitFor(() => phoneReturns(f).find(c => c.body.text === expected), "the coalesced request never returned its own terminal result", 5_000);
  assert.equal(final.body.chat_id, CHAT);
  const messages = await f.messages();
  const request = messages.find(m => m.fromTelegram && m.text === `RAPID_${mode}`);
  assert.ok(request);
  if (mode === "REFUSE") {
    assert.equal(request.midTurn, undefined);
    assert.ok(request.deliveredAt, "the refused input must consume its own queued turn");
    assert.equal(phoneReturns(f).some(c => c.body.text === "EARLIER RESULT"), false);
  } else {
    assert.equal(request.midTurn, true);
    if (mode === "INPUT") assert.ok(messages.findIndex(m => m.text === "RAPID FINAL") < messages.indexOf(request), "the fixture must hit final-before-saved-input ordering");
  }
  if (mode === "INPUT") {
    await waitFor(() => f.tg.calls("sendDocument").length > 0, "the pre-receipt file was lost");
    f.tg.say("DELIVERY_BARRIER");
    await waitFor(() => phoneReturns(f).some(c => c.body.text === "DELIVERY DONE"), "rapid file batch never finished");
    assert.deepEqual(f.tg.calls("sendDocument").map(c => c.body.document.name), ["rapid.txt"]);
  }
  assert.equal(phoneReturns(f).filter(c => c.body.text === expected).length, 1);
});
