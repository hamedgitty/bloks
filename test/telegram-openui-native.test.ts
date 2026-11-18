// The actual intake, queue, waiter, selector and sender, with a fake engine
// and loopback Telegram. No provider, account or private transcript is used.
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CHAT, STRANGER, fixture, heardContext, inputWords, sleep, waitFor } from "./helpers/telegram-native.ts";

type Fixture = Awaited<ReturnType<typeof fixture>>;
type Sent = { method: string; body: any };
const sentTo = (f: Fixture, chat: number) => f.tg.calls("sendMessage").filter((c) => c.body.chat_id === chat && !c.body.disable_notification);
/** Every answer message to a chat, ordinary or rich, in the order sent. */
const answersTo = (f: Fixture, chat: number) => f.tg.state.calls.filter((c) => ["sendMessage", "sendRichMessage"].includes(c.method) && c.body.chat_id === chat && !c.body.disable_notification);
const shown = (c: Sent): string => c.method === "sendRichMessage" ? c.body.rich_message.html : c.body.text;
/** Whether any of the selected table reached a chat, in either form. */
const tableIn = (calls: Sent[]) => calls.some((c) => c.method === "sendRichMessage" || shown(c).includes("30 kg"));
const table = (prose: boolean) => {
  const labels = Array.from({ length: 30 }, (_, i) => `Item ${i + 1}`);
  const values = Array.from({ length: 30 }, (_, i) => `${i + 1} kg`);
  labels[9] = "[Source](https://example.com/a-(b))";
  const code = `root = Card([Table([Col("Name", ${JSON.stringify(labels)}), Col("Weight", ${JSON.stringify(values)})]), TextContent("Keep the note. fixture-stored-secret-123")])`;
  return `${prose ? "Before the table.\n\n" : ""}\`\`\`openui\n${code}\n\`\`\`${prose ? "\n\nCaution after the table." : ""}`;
};
/** The table above as the formatter's rich message: every heading and
 * row once, in order, the link with its target. */
const TABLE_HTML = `<table><tr><th align="left">Name</th><th align="left">Weight</th></tr>${Array.from({ length: 30 }, (_, i) =>
  `<tr><td align="left">${i === 9 ? "Source (https://example.com/a-(b))" : `Item ${i + 1}`}</td><td align="left">${i + 1} kg</td></tr>`).join("")}</table>`;
const NOTE = "Keep the note. [redacted]";
/** The selected answer, as sent: its prose, the rich table, then the note
 * and the prose after it, each once and in order, with the secret redacted. */
function assertSelected(answers: Sent[], prose: boolean) {
  assert.deepEqual(answers.map((c) => c.method), [...(prose ? ["sendMessage"] : []), "sendRichMessage", "sendMessage"]);
  if (prose) assert.equal(answers[0]!.body.text, "Before the table.");
  assert.equal(answers.at(-2)!.body.rich_message.html, TABLE_HTML);
  assert.equal(answers.at(-1)!.body.text, prose ? `${NOTE}\n\nCaution after the table.` : NOTE);
  assert.ok(answers.every((c) => !shown(c).includes("fixture-stored-secret-123") && !shown(c).includes("root = Card")));
}
const noteArrived = (f: Fixture, chat: number, before: number) => answersTo(f, chat).slice(before).some((c) => c.method === "sendMessage" && c.body.text.includes("Keep the note."));
const idle = async (f: Fixture) => waitFor(async () => !(await f.h.json("/api/bots?messages=0")).bots.find((b: any) => b.id === f.bot.id).busy, "the agent did not settle");
async function grantDelegate(f: Fixture) {
  f.tg.say("Hello there", undefined, STRANGER);
  const person = await waitFor(async () => (await f.h.json(`/api/bots/${f.bot.id}/telegram`)).people.find((p: any) => p.name === "Lee"), "no delegate knock");
  await f.post(`/api/bots/${f.bot.id}/telegram`, { personId: person.id, action: "allow" });
  await waitFor(() => sentTo(f, STRANGER).some((c) => c.body.text.startsWith("This agent cannot answer from Telegram yet")), "no restricted notice");
  const response = await f.h.fetch(`/api/bots/${f.bot.id}/telegram`, { method: "POST", body: JSON.stringify({ personId: person.id, action: "full" }) });
  assert.equal(response.status, 200);
  return person;
}

for (const delegate of [false, true]) for (const prose of [false, true]) {
  test(`${delegate ? "delegate" : "owner"} queued waiter receives ${prose ? "prose and" : "only"} selected OpenUI table`, async (t) => {
    const f = await fixture(t);
    if (delegate) await grantDelegate(f);
    const chat = delegate ? STRANGER : CHAT;
    writeFileSync(join(f.root, "openui-answer.json"), JSON.stringify(table(prose)));
    // The phone request waits behind unrelated work; the fake engine refuses
    // the steer, then the real queue starts its own consuming turn.
    await f.post(`/api/bots/${f.bot.id}/messages`, { text: "SCOPED_MAIN_HOLD" });
    await waitFor(() => existsSync(join(f.root, "scope-force-queue")), "earlier turn did not start");
    const before = answersTo(f, chat).length;
    f.tg.say("OPENUI_SAMPLE", undefined, chat);
    await waitFor(async () => (await f.messages()).some((m) => m.text === "OPENUI_SAMPLE" && m.queued), "request did not queue");
    writeFileSync(join(f.root, "main-release"), "1");
    await waitFor(() => noteArrived(f, chat, before), "selected table was not sent");
    await sleep(250);
    assertSelected(answersTo(f, chat).slice(before), prose);
    assert.ok(!answersTo(f, chat).slice(before).some((c) => shown(c).includes("EARLIER FINAL")));
    assert.equal(heardContext(f).filter((c) => c.method === "turn/start" && inputWords(c).includes("OPENUI_SAMPLE")).length, 1);
    assert.equal(tableIn(answersTo(f, delegate ? CHAT : STRANGER)), false);
  });
}

test("deleting the selected row during cleanup keeps the ordinary reply and never exports its component", async (t) => {
  const f = await fixture(t);
  writeFileSync(join(f.root, "openui-answer.json"), JSON.stringify(table(false)));
  writeFileSync(join(f.root, "openui-progress"), "1");
  await f.post(`/api/bots/${f.bot.id}/messages`, { text: "SCOPED_MAIN_HOLD" });
  await waitFor(() => existsSync(join(f.root, "scope-force-queue")), "earlier turn did not start");
  const before = answersTo(f, CHAT).length;
  f.tg.say("OPENUI_SAMPLE", undefined, CHAT);
  await waitFor(async () => (await f.messages()).some((m) => m.text === "OPENUI_SAMPLE" && m.queued), "request did not queue");
  f.tg.state.holdDelete = true;
  writeFileSync(join(f.root, "main-release"), "1");
  await waitFor(() => f.tg.state.deleteReleases.length > 0, "progress cleanup did not hold", 40_000);
  const selected = await waitFor(async () => (await f.messages()).find((m) => m.role === "bot" && m.text?.includes("```openui")), "final row missing");
  const deleted = await f.h.fetch(`/api/threads/${f.bot.threadId}/messages/${selected.id}`, { method: "DELETE" });
  assert.equal(deleted.status, 200);
  await f.post(`/api/bots/${f.bot.id}/messages`, { text: "SCOPED_LATER" });
  await waitFor(async () => (await f.messages()).some((m) => m.text === "LATER FINAL"), "later turn did not finish");
  f.tg.state.holdDelete = false;
  f.tg.state.deleteReleases.splice(0).forEach((release) => release());
  await waitFor(() => sentTo(f, CHAT).slice(before).some((c) => c.body.text.includes("interactive")), "ordinary fallback did not arrive");
  const answers = answersTo(f, CHAT).slice(before);
  assert.ok(!tableIn(answers));
  assert.ok(!answers.some((c) => shown(c).includes("LATER FINAL")));
});

test("two queued requests share their consuming turn without borrowing adjacent turns", async (t) => {
  const f = await fixture(t);
  writeFileSync(join(f.root, "openui-answer.json"), JSON.stringify(table(true)));
  await f.post(`/api/bots/${f.bot.id}/messages`, { text: "SCOPED_MAIN_HOLD" });
  await waitFor(() => existsSync(join(f.root, "scope-force-queue")), "earlier turn did not start");
  const before = answersTo(f, CHAT).length;
  f.tg.say("OPENUI_SAMPLE", undefined, CHAT);
  await waitFor(async () => (await f.messages()).some((m) => m.text === "OPENUI_SAMPLE" && m.queued), "first request did not queue");
  const second = await f.post(`/api/bots/${f.bot.id}/messages`, { text: "SECOND_BURST" });
  assert.equal(second.queued, true);
  await waitFor(async () => (await f.messages()).some((m) => m.text === "SECOND_BURST" && m.queued), "second request did not queue");
  writeFileSync(join(f.root, "main-release"), "1");
  await waitFor(() => noteArrived(f, CHAT, before), "table did not arrive");
  const starts = heardContext(f).filter((c) => c.method === "turn/start" && inputWords(c).includes("OPENUI_SAMPLE"));
  assert.equal(starts.length, 1);
  assert.ok(inputWords(starts[0]).includes("SECOND_BURST"));
  await sleep(250);
  const answers = answersTo(f, CHAT).slice(before);
  assert.ok(!answers.some((c) => shown(c).includes("EARLIER FINAL")));
  assertSelected(answers, true);
});

test("a separate show row during the eligible turn is not collected or announced", async (t) => {
  const f = await fixture(t);
  writeFileSync(join(f.root, "openui-answer.json"), JSON.stringify(table(false)));
  writeFileSync(join(f.root, "openui-hold"), "1");
  await f.post(`/api/bots/${f.bot.id}/messages`, { text: "SCOPED_MAIN_HOLD" });
  await waitFor(() => existsSync(join(f.root, "scope-force-queue")), "earlier turn did not start");
  const before = answersTo(f, CHAT).length;
  f.tg.say("OPENUI_SAMPLE", undefined, CHAT);
  await waitFor(async () => (await f.messages()).some((m) => m.text === "OPENUI_SAMPLE" && m.queued), "request did not queue");
  writeFileSync(join(f.root, "main-release"), "1");
  await waitFor(() => existsSync(join(f.root, "openui-started")), "consuming turn did not start");
  const shownRow = await f.h.fetch(`/api/bots/${f.bot.id}/show`, { method: "POST", body: JSON.stringify({ kind: "chart", data: { title: "SEPARATE_SHOW_MARKER", bars: [{ label: "Separate", value: 42 }] } }) });
  assert.equal(shownRow.status, 201);
  assert.ok((await f.messages()).some((m) => m.kind === "component" && JSON.stringify(m.component).includes("SEPARATE_SHOW_MARKER")));
  writeFileSync(join(f.root, "openui-release"), "1");
  await waitFor(() => noteArrived(f, CHAT, before), "selected table did not arrive");
  const answers = answersTo(f, CHAT).slice(before);
  assert.ok(!answers.some((c) => shown(c).includes("SEPARATE_SHOW_MARKER")));
  assert.ok(!answers.some((c) => shown(c).includes("could not be displayed")), "an unrelated show row must not generate a limitation notice");
  assertSelected(answers, false);
});

test("an accepted mid-turn steer keeps the ordinary interactive fallback", async (t) => {
  const f = await fixture(t);
  writeFileSync(join(f.root, "rapid-answer.json"), JSON.stringify(table(false)));
  await f.post(`/api/bots/${f.bot.id}/messages`, { text: "CTX_HOLD" });
  await waitFor(() => existsSync(join(f.root, "ctx-started")), "prior turn did not start");
  const before = answersTo(f, CHAT).length;
  f.tg.say("RAPID_INPUT", undefined, CHAT);
  await waitFor(() => sentTo(f, CHAT).some((c) => c.body.text.includes("interactive")), "ordinary interactive answer did not arrive");
  assert.ok(!tableIn(answersTo(f, CHAT).slice(before)));
  assert.ok(heardContext(f).some((c) => c.method === "turn/steer" && inputWords(c).includes("RAPID_INPUT")));
});

test("revoking a full-access grant before completion prevents the added component reaching that chat", async (t) => {
  const f = await fixture(t);
  const person = await grantDelegate(f);
  writeFileSync(join(f.root, "openui-answer.json"), JSON.stringify(table(false)));
  writeFileSync(join(f.root, "openui-hold"), "1");
  await f.post(`/api/bots/${f.bot.id}/messages`, { text: "SCOPED_MAIN_HOLD" });
  await waitFor(() => existsSync(join(f.root, "scope-force-queue")), "earlier turn did not start");
  const before = answersTo(f, STRANGER).length;
  f.tg.say("OPENUI_SAMPLE", undefined, STRANGER);
  await waitFor(async () => (await f.messages()).some((m) => m.text === "OPENUI_SAMPLE" && m.queued), "delegate request did not queue");
  writeFileSync(join(f.root, "main-release"), "1");
  await waitFor(() => existsSync(join(f.root, "openui-started")), "delegate turn did not start");
  const changed = await f.h.fetch(`/api/bots/${f.bot.id}/telegram`, { method: "POST", body: JSON.stringify({ personId: person.id, action: "restricted" }) });
  assert.equal(changed.status, 200);
  writeFileSync(join(f.root, "openui-release"), "1");
  await idle(f);
  await sleep(500);
  assert.ok(!tableIn(answersTo(f, STRANGER).slice(before)));
  assert.ok(!tableIn(answersTo(f, CHAT)));
});

test("a queued request retried after failure keeps the ordinary interactive fallback", async (t) => {
  const f = await fixture(t, "codex", true);
  writeFileSync(join(f.root, "retry-ui.json"), JSON.stringify(table(false)));
  await f.post(`/api/bots/${f.bot.id}/messages`, { text: "SCOPED_MAIN_HOLD" });
  await waitFor(() => existsSync(join(f.root, "scope-force-queue")), "earlier turn did not start");
  const before = answersTo(f, CHAT).length;
  f.tg.say("TIMEOUT_RETRY", undefined, CHAT);
  await waitFor(async () => (await f.messages()).some((m) => m.text === "TIMEOUT_RETRY" && m.queued), "retry request did not queue");
  writeFileSync(join(f.root, "main-release"), "1");
  await waitFor(() => existsSync(join(f.root, "timeout-retried")), "first attempt did not fail");
  await waitFor(() => existsSync(join(f.root, "timeout-started")), "ordinary retry did not start");
  writeFileSync(join(f.root, "timeout-release"), "1");
  await waitFor(() => sentTo(f, CHAT).slice(before).some((c) => c.body.text.includes("interactive")), "ordinary fallback did not arrive");
  assert.ok(!tableIn(answersTo(f, CHAT).slice(before)));
  assert.equal(heardContext(f).filter((c) => c.method === "turn/start" && inputWords(c).includes("TIMEOUT_RETRY")).length, 2);
});

test("a queued request handed to a backup keeps the ordinary interactive fallback", async (t) => {
  const f = await fixture(t);
  writeFileSync(join(f.root, "fallback-ui.json"), JSON.stringify(table(false)));
  const settings = await f.h.fetch(`/api/bots/${f.bot.id}`, { method: "PATCH", body: JSON.stringify({ backupSelection: { instanceId: "claude", model: "claude-sonnet-5" } }) });
  assert.equal(settings.status, 200);
  await f.post(`/api/bots/${f.bot.id}/messages`, { text: "SCOPED_MAIN_HOLD" });
  await waitFor(() => existsSync(join(f.root, "scope-force-queue")), "earlier turn did not start");
  const before = answersTo(f, CHAT).length;
  f.tg.say("OPENUI_FALLBACK", undefined, CHAT);
  await waitFor(async () => (await f.messages()).some((m) => m.text === "OPENUI_FALLBACK" && m.queued), "backup request did not queue");
  writeFileSync(join(f.root, "main-release"), "1");
  await waitFor(() => existsSync(join(f.root, "fallback-started")), "backup did not start");
  await waitFor(() => sentTo(f, CHAT).slice(before).some((c) => c.body.text.includes("interactive")), "ordinary fallback did not arrive");
  assert.ok(!tableIn(answersTo(f, CHAT).slice(before)));
  assert.equal(heardContext(f).filter((c) => c.method === "turn/start" && inputWords(c).includes("OPENUI_FALLBACK")).length, 1);
});

test("a refused steer whose old turn ended before the receipt uses only the later consuming answer", async (t) => {
  const f = await fixture(t);
  writeFileSync(join(f.root, "rapid-queued-answer.json"), JSON.stringify(table(false)));
  await f.post(`/api/bots/${f.bot.id}/messages`, { text: "CTX_HOLD" });
  await waitFor(() => existsSync(join(f.root, "ctx-started")), "prior turn did not start");
  const before = answersTo(f, CHAT).length;
  f.tg.say("RAPID_REFUSE", undefined, CHAT);
  await waitFor(() => noteArrived(f, CHAT, before), "queued table did not arrive");
  await sleep(250);
  const answers = answersTo(f, CHAT).slice(before);
  assert.ok(!answers.some((c) => shown(c).includes("EARLIER RESULT")));
  assertSelected(answers, false);
  assert.equal(heardContext(f).filter((c) => c.method === "turn/start" && inputWords(c).includes("RAPID_REFUSE")).length, 1);
});

for (const kind of ["EMPTY", "FAILED"] as const) test(`a ${kind.toLowerCase()} consuming turn keeps its ordinary answer when a later turn succeeds`, async (t) => {
  const f = await fixture(t);
  writeFileSync(join(f.root, "openui-answer.json"), JSON.stringify(table(false)));
  await f.post(`/api/bots/${f.bot.id}/messages`, { text: "SCOPED_MAIN_HOLD" });
  await waitFor(() => existsSync(join(f.root, "scope-force-queue")), "earlier turn did not start");
  const before = answersTo(f, CHAT).length;
  const request = `OPENUI_${kind}`;
  f.tg.say(request, undefined, CHAT);
  await waitFor(async () => (await f.messages()).some((m) => m.text === request && m.queued), "request did not queue");
  writeFileSync(join(f.root, "main-release"), "1");
  const expected = kind === "EMPTY" ? "finished without saying anything" : "interactive";
  await waitFor(() => sentTo(f, CHAT).slice(before).some((c) => c.body.text.includes(expected)), "ordinary answer did not arrive");
  await f.post(`/api/bots/${f.bot.id}/messages`, { text: "SCOPED_LATER" });
  await waitFor(async () => (await f.messages()).some((m) => m.text === "LATER FINAL"), "later turn did not succeed");
  await sleep(250);
  const answers = answersTo(f, CHAT).slice(before);
  assert.ok(!tableIn(answers));
  assert.ok(!answers.some((c) => shown(c).includes("LATER FINAL")));
  assert.equal(heardContext(f).filter((c) => c.method === "turn/start" && inputWords(c).includes(request)).length, 1);
});

// ── an owner's request to an idle agent: the direct start ──

for (const prose of [false, true]) test(`idle owner request receives ${prose ? "prose and" : "only"} its OpenUI table, the table as a rich message`, async (t) => {
  const f = await fixture(t);
  writeFileSync(join(f.root, "openui-answer.json"), JSON.stringify(table(prose)));
  const before = answersTo(f, CHAT).length;
  f.tg.say("OPENUI_SAMPLE", undefined, CHAT);
  await waitFor(() => noteArrived(f, CHAT, before), "the idle answer did not arrive");
  await sleep(250);
  assertSelected(answersTo(f, CHAT).slice(before), prose);
  const starts = heardContext(f).filter((c) => ["turn/start", "turn/steer"].includes(c.method) && inputWords(c).includes("OPENUI_SAMPLE"));
  assert.deepEqual(starts.map((c) => c.method), ["turn/start"]);
  // A row that waited is marked when it is delivered; this one started its own turn.
  const request = (await f.messages()).find((m) => m.role === "user" && m.text === "OPENUI_SAMPLE");
  assert.ok(request?.fromTelegram);
  assert.equal(request.queuedAt, undefined);
  assert.equal(request.deliveredAt, undefined);
});

test("an idle request whose turn ends at once gets only its final answer's table", async (t) => {
  const f = await fixture(t);
  writeFileSync(join(f.root, "openui-answer.json"), JSON.stringify(table(false)));
  writeFileSync(join(f.root, "openui-earlier.json"), JSON.stringify("Earlier in the turn:\n\n```openui\nroot = Card([Table([Col(\"Earlier\", [\"EARLIER_ROW\"])])])\n```"));
  const before = answersTo(f, CHAT).length;
  f.tg.say("OPENUI_IMMEDIATE", undefined, CHAT);
  await waitFor(() => noteArrived(f, CHAT, before), "the immediate answer did not arrive");
  await sleep(250);
  const answers = answersTo(f, CHAT).slice(before);
  assertSelected(answers, false);
  assert.ok(!answers.some((c) => /EARLIER_ROW|Earlier in the turn/.test(shown(c))));
  assert.equal(heardContext(f).filter((c) => c.method === "turn/start" && inputWords(c).includes("OPENUI_IMMEDIATE")).length, 1);
});

/** Changes the idle request's own row or its answer's, through the API a person uses. */
async function change(f: Fixture, what: "answer deleted" | "request edited" | "request deleted") {
  const rows = await f.messages();
  const request = rows.find((m) => m.role === "user" && m.text === "OPENUI_SAMPLE");
  const answer = rows.find((m) => m.role === "bot" && m.text?.includes("```openui"));
  assert.ok(request && answer, "the request and its answer are stored");
  const target = what === "answer deleted" ? answer : request;
  const response = await f.h.fetch(`/api/threads/${f.bot.threadId}/messages/${target.id}`, what === "request edited"
    ? { method: "PATCH", body: JSON.stringify({ text: "OPENUI_SAMPLE, edited" }) }
    : { method: "DELETE" });
  assert.equal(response.status, 200, `${what}: ${await response.text()}`);
}

for (const what of ["answer deleted", "request edited", "request deleted"] as const) test(`idle request: ${what} before handoff keeps the ordinary reply`, async (t) => {
  const f = await fixture(t);
  writeFileSync(join(f.root, "openui-answer.json"), JSON.stringify(table(false)));
  writeFileSync(join(f.root, "openui-progress"), "1");
  const before = answersTo(f, CHAT).length;
  // The progress note's cleanup is the last step before the answer is
  // handed to the sender; it waits here while the row changes.
  f.tg.state.holdDelete = true;
  f.tg.say("OPENUI_SAMPLE", undefined, CHAT);
  await waitFor(() => f.tg.state.deleteReleases.length > 0, "progress cleanup did not hold", 40_000);
  await change(f, what);
  f.tg.state.holdDelete = false;
  f.tg.state.deleteReleases.splice(0).forEach((release) => release());
  await idle(f);
  await sleep(500);
  // The ordinary reply as it was before components: with the request row
  // gone, the reply lookup finds nothing, as it always has.
  const ordinary = what === "request deleted" ? "(the agent finished without saying anything)" : "The answer is interactive. Open Bloks to see it.";
  assert.deepEqual(answersTo(f, CHAT).slice(before).map(shown), [ordinary], what);
});

/** Holds Telegram's answer to the first part of the reply to `chat`. */
function holdFirstPart(f: Fixture, chat: number) {
  f.tg.state.answer = (c) => c.body.chat_id === chat && c.method === "sendMessage" && c.body.text === "Before the table." ? "hold" : undefined;
}
function releaseFirstPart(f: Fixture) {
  f.tg.state.answer = undefined;
  f.tg.state.heldReplies.splice(0).forEach((release) => release());
}

for (const what of ["answer deleted", "request edited", "request deleted"] as const) test(`idle request: ${what} after its first part is sent, the rest of the reply still arrives`, async (t) => {
  const f = await fixture(t);
  writeFileSync(join(f.root, "openui-answer.json"), JSON.stringify(table(true)));
  const before = answersTo(f, CHAT).length;
  holdFirstPart(f, CHAT);
  f.tg.say("OPENUI_SAMPLE", undefined, CHAT);
  await waitFor(() => f.tg.state.heldReplies.length === 1, "the first part was not sent");
  await change(f, what);
  releaseFirstPart(f);
  await waitFor(() => noteArrived(f, CHAT, before), "the rest of the reply did not arrive");
  await sleep(250);
  assertSelected(answersTo(f, CHAT).slice(before), true);
});

test("idle request: replacing the connection after the first part stops the rest", async (t) => {
  const f = await fixture(t);
  writeFileSync(join(f.root, "openui-answer.json"), JSON.stringify(table(true)));
  const before = answersTo(f, CHAT).length;
  holdFirstPart(f, CHAT);
  f.tg.say("OPENUI_SAMPLE", undefined, CHAT);
  await waitFor(() => f.tg.state.heldReplies.length === 1, "the first part was not sent");
  const response = await f.h.fetch(`/api/bots/${f.bot.id}/telegram`, { method: "POST", body: JSON.stringify({ unpair: true }) });
  assert.equal(response.status, 200);
  releaseFirstPart(f);
  await idle(f);
  await sleep(500);
  assert.deepEqual(answersTo(f, CHAT).slice(before).map(shown), ["Before the table."]);
});

test("delegate: revoking full access after the first part stops the rest", async (t) => {
  const f = await fixture(t);
  const person = await grantDelegate(f);
  writeFileSync(join(f.root, "openui-answer.json"), JSON.stringify(table(true)));
  const before = answersTo(f, STRANGER).length;
  holdFirstPart(f, STRANGER);
  f.tg.say("OPENUI_SAMPLE", undefined, STRANGER);
  await waitFor(() => f.tg.state.heldReplies.length === 1, "the first part was not sent");
  const changed = await f.h.fetch(`/api/bots/${f.bot.id}/telegram`, { method: "POST", body: JSON.stringify({ personId: person.id, action: "restricted" }) });
  assert.equal(changed.status, 200);
  releaseFirstPart(f);
  await idle(f);
  await sleep(500);
  assert.deepEqual(answersTo(f, STRANGER).slice(before).map(shown), ["Before the table."]);
  assert.ok(!tableIn(answersTo(f, CHAT)));
});

test("idle request: a table part with an unknown result is not sent again, and the rest stops", async (t) => {
  const f = await fixture(t);
  writeFileSync(join(f.root, "openui-answer.json"), JSON.stringify(table(true)));
  const before = answersTo(f, CHAT).length;
  f.tg.state.answer = (c) => c.method === "sendRichMessage" ? "drop" : undefined;
  f.tg.say("OPENUI_SAMPLE", undefined, CHAT);
  await waitFor(() => f.tg.calls("sendRichMessage").length === 1, "the table part was not sent");
  await idle(f);
  await sleep(500);
  const answers = answersTo(f, CHAT).slice(before);
  assert.deepEqual(answers.map((c) => c.method), ["sendMessage", "sendRichMessage"]);
  assert.equal(answers[0]!.body.text, "Before the table.");
  assert.equal(answers[1]!.body.rich_message.html, TABLE_HTML);
});

for (const kind of ["EMPTY", "FAILED"] as const) test(`an idle ${kind.toLowerCase()} turn keeps its ordinary answer when a later turn succeeds`, async (t) => {
  const f = await fixture(t);
  writeFileSync(join(f.root, "openui-answer.json"), JSON.stringify(table(false)));
  const before = answersTo(f, CHAT).length;
  const request = `OPENUI_${kind}`;
  f.tg.say(request, undefined, CHAT);
  const expected = kind === "EMPTY" ? "finished without saying anything" : "interactive";
  await waitFor(() => sentTo(f, CHAT).slice(before).some((c) => c.body.text.includes(expected)), "ordinary answer did not arrive");
  await f.post(`/api/bots/${f.bot.id}/messages`, { text: "SCOPED_LATER" });
  await waitFor(async () => (await f.messages()).some((m) => m.text === "LATER FINAL"), "later turn did not succeed");
  await sleep(250);
  const answers = answersTo(f, CHAT).slice(before);
  assert.ok(!tableIn(answers));
  assert.ok(!answers.some((c) => shown(c).includes("LATER FINAL")));
  assert.equal(heardContext(f).filter((c) => c.method === "turn/start" && inputWords(c).includes(request)).length, 1);
});

test("an idle request retried after failure keeps the ordinary interactive fallback", async (t) => {
  const f = await fixture(t, "codex", true);
  writeFileSync(join(f.root, "retry-ui.json"), JSON.stringify(table(false)));
  const before = answersTo(f, CHAT).length;
  f.tg.say("TIMEOUT_RETRY", undefined, CHAT);
  await waitFor(() => existsSync(join(f.root, "timeout-retried")), "first attempt did not fail");
  await waitFor(() => existsSync(join(f.root, "timeout-started")), "ordinary retry did not start");
  writeFileSync(join(f.root, "timeout-release"), "1");
  await waitFor(() => sentTo(f, CHAT).slice(before).some((c) => c.body.text.includes("interactive")), "ordinary fallback did not arrive");
  assert.ok(!tableIn(answersTo(f, CHAT).slice(before)));
  assert.equal(heardContext(f).filter((c) => c.method === "turn/start" && inputWords(c).includes("TIMEOUT_RETRY")).length, 2);
});

test("an idle request handed to a backup keeps the ordinary interactive fallback", async (t) => {
  const f = await fixture(t);
  writeFileSync(join(f.root, "fallback-ui.json"), JSON.stringify(table(false)));
  const settings = await f.h.fetch(`/api/bots/${f.bot.id}`, { method: "PATCH", body: JSON.stringify({ backupSelection: { instanceId: "claude", model: "claude-sonnet-5" } }) });
  assert.equal(settings.status, 200);
  const before = answersTo(f, CHAT).length;
  f.tg.say("OPENUI_FALLBACK", undefined, CHAT);
  await waitFor(() => existsSync(join(f.root, "fallback-started")), "backup did not start");
  await waitFor(() => sentTo(f, CHAT).slice(before).some((c) => c.body.text.includes("interactive")), "ordinary fallback did not arrive");
  assert.ok(!tableIn(answersTo(f, CHAT).slice(before)));
  assert.equal(heardContext(f).filter((c) => c.method === "turn/start" && inputWords(c).includes("OPENUI_FALLBACK")).length, 1);
});

test("an idle request whose start is refused after its row is written gains no component, also from a later turn", async (t) => {
  const f = await fixture(t);
  writeFileSync(join(f.root, "openui-answer.json"), JSON.stringify(table(false)));
  const before = answersTo(f, CHAT).length;
  f.tg.say("START_REFUSED", undefined, CHAT);
  await waitFor(() => answersTo(f, CHAT).length > before, "the refused start was not answered");
  await idle(f);
  assert.ok((await f.messages()).some((m) => m.role === "user" && m.text === "START_REFUSED"), "the request row was written");
  await f.post(`/api/bots/${f.bot.id}/messages`, { text: "OPENUI_SAMPLE" });
  await waitFor(async () => (await f.messages()).some((m) => m.role === "bot" && m.text?.includes("```openui")), "the later turn did not answer");
  await idle(f);
  await sleep(500);
  // The start's failure, as before, and nothing from the later turn.
  assert.deepEqual(answersTo(f, CHAT).slice(before).map(shown), ["fixture cannot start this turn"]);
});

test("an idle request to a held agent is refused before it is written, with no component", async (t) => {
  const f = await fixture(t);
  writeFileSync(join(f.root, "openui-answer.json"), JSON.stringify(table(false)));
  await f.post(`/api/bots/${f.bot.id}/wheel`, { why: "a fixture hold" });
  const before = answersTo(f, CHAT).length;
  f.tg.say("OPENUI_SAMPLE", undefined, CHAT);
  await waitFor(() => answersTo(f, CHAT).length > before, "the held agent did not answer");
  await sleep(250);
  const answers = answersTo(f, CHAT).slice(before);
  assert.equal(answers.length, 1);
  assert.match(shown(answers[0]!), /^Could not answer: .*\(a fixture hold\)/);
  assert.ok(!(await f.messages()).some((m) => m.role === "user" && m.text === "OPENUI_SAMPLE"));
  assert.equal(heardContext(f).filter((c) => c.method === "turn/start" && inputWords(c).includes("OPENUI_SAMPLE")).length, 0);
});
