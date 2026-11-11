// The actual intake, queue, waiter, selector and sender, with a fake engine
// and loopback Telegram. No provider, account or private transcript is used.
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CHAT, STRANGER, fixture, heardContext, inputWords, sleep, waitFor } from "./helpers/telegram-native.ts";

type Fixture = Awaited<ReturnType<typeof fixture>>;
const sentTo = (f: Fixture, chat: number) => f.tg.calls("sendMessage").filter((c) => c.body.chat_id === chat && !c.body.disable_notification);
const table = (prose: boolean) => {
  const labels = Array.from({ length: 30 }, (_, i) => `Item ${i + 1}`);
  const values = Array.from({ length: 30 }, (_, i) => `${i + 1} kg`);
  labels[9] = "[Source](https://example.com/a-(b))";
  const code = `root = Card([Table([Col("Name", ${JSON.stringify(labels)}), Col("Weight", ${JSON.stringify(values)})]), TextContent("Keep the note. fixture-stored-secret-123")])`;
  return `${prose ? "Before the table.\n\n" : ""}\`\`\`openui\n${code}\n\`\`\`${prose ? "\n\nCaution after the table." : ""}`;
};
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
    const before = sentTo(f, chat).length;
    f.tg.say("OPENUI_SAMPLE", undefined, chat);
    await waitFor(async () => (await f.messages()).some((m) => m.text === "OPENUI_SAMPLE" && m.queued), "request did not queue");
    writeFileSync(join(f.root, "main-release"), "1");
    await waitFor(() => sentTo(f, chat).slice(before).some((c) => c.body.text.includes("Row 30")), "selected table was not sent");
    const answers = sentTo(f, chat).slice(before);
    const text = answers.map((c) => c.body.text).join("\n");
    for (let i = 1; i <= 30; i++) {
      assert.ok(text.includes(`Row ${i}`), `missing row ${i}`);
      assert.ok(text.includes(`${i} kg`), `missing value ${i}`);
    }
    assert.ok(text.includes("Source (https://example.com/a-(b))"));
    assert.ok(text.includes("Keep the note."));
    assert.ok(text.includes("[redacted]"));
    assert.ok(!text.includes("fixture-stored-secret-123"));
    assert.equal(text.includes("Before the table."), prose);
    assert.equal(text.includes("Caution after the table."), prose);
    assert.ok(!text.includes("EARLIER FINAL"));
    assert.ok(!text.includes("root = Card"));
    assert.equal(heardContext(f).filter((c) => c.method === "turn/start" && inputWords(c).includes("OPENUI_SAMPLE")).length, 1);
    assert.equal(sentTo(f, delegate ? CHAT : STRANGER).some((c) => c.body.text.includes("Row 30")), false);
    await sleep(250);
    assert.equal(sentTo(f, chat).slice(before).filter((c) => c.body.text.includes("Row 30")).length, 1);
  });
}

test("deleting the selected row during cleanup keeps the ordinary reply and never exports its component", async (t) => {
  const f = await fixture(t);
  writeFileSync(join(f.root, "openui-answer.json"), JSON.stringify(table(false)));
  writeFileSync(join(f.root, "openui-progress"), "1");
  await f.post(`/api/bots/${f.bot.id}/messages`, { text: "SCOPED_MAIN_HOLD" });
  await waitFor(() => existsSync(join(f.root, "scope-force-queue")), "earlier turn did not start");
  const before = sentTo(f, CHAT).length;
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
  const text = sentTo(f, CHAT).slice(before).map((c) => c.body.text).join("\n");
  assert.ok(!text.includes("Row 30"));
  assert.ok(!text.includes("LATER FINAL"));
});

test("two queued requests share their consuming turn without borrowing adjacent turns", async (t) => {
  const f = await fixture(t);
  writeFileSync(join(f.root, "openui-answer.json"), JSON.stringify(table(true)));
  await f.post(`/api/bots/${f.bot.id}/messages`, { text: "SCOPED_MAIN_HOLD" });
  await waitFor(() => existsSync(join(f.root, "scope-force-queue")), "earlier turn did not start");
  const before = sentTo(f, CHAT).length;
  f.tg.say("OPENUI_SAMPLE", undefined, CHAT);
  await waitFor(async () => (await f.messages()).some((m) => m.text === "OPENUI_SAMPLE" && m.queued), "first request did not queue");
  const second = await f.post(`/api/bots/${f.bot.id}/messages`, { text: "SECOND_BURST" });
  assert.equal(second.queued, true);
  await waitFor(async () => (await f.messages()).some((m) => m.text === "SECOND_BURST" && m.queued), "second request did not queue");
  writeFileSync(join(f.root, "main-release"), "1");
  await waitFor(() => sentTo(f, CHAT).slice(before).some((c) => c.body.text.includes("Row 30")), "table did not arrive");
  const starts = heardContext(f).filter((c) => c.method === "turn/start" && inputWords(c).includes("OPENUI_SAMPLE"));
  assert.equal(starts.length, 1);
  assert.ok(inputWords(starts[0]).includes("SECOND_BURST"));
  const output = sentTo(f, CHAT).slice(before).map((c) => c.body.text).join("\n");
  assert.ok(!output.includes("EARLIER FINAL"));
  assert.equal(sentTo(f, CHAT).slice(before).filter((c) => c.body.text.includes("Row 30")).length, 1);
});

test("a separate show row during the eligible turn is not collected or announced", async (t) => {
  const f = await fixture(t);
  writeFileSync(join(f.root, "openui-answer.json"), JSON.stringify(table(false)));
  writeFileSync(join(f.root, "openui-hold"), "1");
  await f.post(`/api/bots/${f.bot.id}/messages`, { text: "SCOPED_MAIN_HOLD" });
  await waitFor(() => existsSync(join(f.root, "scope-force-queue")), "earlier turn did not start");
  const before = sentTo(f, CHAT).length;
  f.tg.say("OPENUI_SAMPLE", undefined, CHAT);
  await waitFor(async () => (await f.messages()).some((m) => m.text === "OPENUI_SAMPLE" && m.queued), "request did not queue");
  writeFileSync(join(f.root, "main-release"), "1");
  await waitFor(() => existsSync(join(f.root, "openui-started")), "consuming turn did not start");
  const shown = await f.h.fetch(`/api/bots/${f.bot.id}/show`, { method: "POST", body: JSON.stringify({ kind: "chart", data: { title: "SEPARATE_SHOW_MARKER", bars: [{ label: "Separate", value: 42 }] } }) });
  assert.equal(shown.status, 201);
  assert.ok((await f.messages()).some((m) => m.kind === "component" && JSON.stringify(m.component).includes("SEPARATE_SHOW_MARKER")));
  writeFileSync(join(f.root, "openui-release"), "1");
  await waitFor(() => sentTo(f, CHAT).slice(before).some((c) => c.body.text.includes("Row 30")), "selected table did not arrive");
  const output = sentTo(f, CHAT).slice(before).map((c) => c.body.text).join("\n");
  assert.ok(!output.includes("SEPARATE_SHOW_MARKER"));
  assert.ok(!output.includes("could not be displayed"), "an unrelated show row must not generate a limitation notice");
});

test("an accepted mid-turn steer keeps the ordinary interactive fallback", async (t) => {
  const f = await fixture(t);
  writeFileSync(join(f.root, "rapid-answer.json"), JSON.stringify(table(false)));
  await f.post(`/api/bots/${f.bot.id}/messages`, { text: "CTX_HOLD" });
  await waitFor(() => existsSync(join(f.root, "ctx-started")), "prior turn did not start");
  const before = sentTo(f, CHAT).length;
  f.tg.say("RAPID_INPUT", undefined, CHAT);
  await waitFor(() => sentTo(f, CHAT).slice(before).some((c) => c.body.text.includes("interactive")), "ordinary interactive answer did not arrive");
  const output = sentTo(f, CHAT).slice(before).map((c) => c.body.text).join("\n");
  assert.ok(!output.includes("Row 30"));
  assert.ok(heardContext(f).some((c) => c.method === "turn/steer" && inputWords(c).includes("RAPID_INPUT")));
});

test("revoking a full-access grant before completion prevents the added component reaching that chat", async (t) => {
  const f = await fixture(t);
  const person = await grantDelegate(f);
  writeFileSync(join(f.root, "openui-answer.json"), JSON.stringify(table(false)));
  writeFileSync(join(f.root, "openui-hold"), "1");
  await f.post(`/api/bots/${f.bot.id}/messages`, { text: "SCOPED_MAIN_HOLD" });
  await waitFor(() => existsSync(join(f.root, "scope-force-queue")), "earlier turn did not start");
  const before = sentTo(f, STRANGER).length;
  f.tg.say("OPENUI_SAMPLE", undefined, STRANGER);
  await waitFor(async () => (await f.messages()).some((m) => m.text === "OPENUI_SAMPLE" && m.queued), "delegate request did not queue");
  writeFileSync(join(f.root, "main-release"), "1");
  await waitFor(() => existsSync(join(f.root, "openui-started")), "delegate turn did not start");
  const changed = await f.h.fetch(`/api/bots/${f.bot.id}/telegram`, { method: "POST", body: JSON.stringify({ personId: person.id, action: "restricted" }) });
  assert.equal(changed.status, 200);
  writeFileSync(join(f.root, "openui-release"), "1");
  await waitFor(async () => !(await f.h.json("/api/bots?messages=0")).bots.find((b: any) => b.id === f.bot.id).busy, "delegate turn did not settle");
  await sleep(500);
  assert.ok(sentTo(f, STRANGER).slice(before).every((c) => !c.body.text.includes("Row 30")));
  assert.ok(sentTo(f, CHAT).every((c) => !c.body.text.includes("Row 30")));
});

test("a queued request retried after failure keeps the ordinary interactive fallback", async (t) => {
  const f = await fixture(t, "codex", true);
  writeFileSync(join(f.root, "retry-ui.json"), JSON.stringify(table(false)));
  await f.post(`/api/bots/${f.bot.id}/messages`, { text: "SCOPED_MAIN_HOLD" });
  await waitFor(() => existsSync(join(f.root, "scope-force-queue")), "earlier turn did not start");
  const before = sentTo(f, CHAT).length;
  f.tg.say("TIMEOUT_RETRY", undefined, CHAT);
  await waitFor(async () => (await f.messages()).some((m) => m.text === "TIMEOUT_RETRY" && m.queued), "retry request did not queue");
  writeFileSync(join(f.root, "main-release"), "1");
  await waitFor(() => existsSync(join(f.root, "timeout-retried")), "first attempt did not fail");
  await waitFor(() => existsSync(join(f.root, "timeout-started")), "ordinary retry did not start");
  writeFileSync(join(f.root, "timeout-release"), "1");
  await waitFor(() => sentTo(f, CHAT).slice(before).some((c) => c.body.text.includes("interactive")), "ordinary fallback did not arrive");
  const output = sentTo(f, CHAT).slice(before).map((c) => c.body.text).join("\n");
  assert.ok(!output.includes("Row 30"));
  assert.equal(heardContext(f).filter((c) => c.method === "turn/start" && inputWords(c).includes("TIMEOUT_RETRY")).length, 2);
});

test("a queued request handed to a backup keeps the ordinary interactive fallback", async (t) => {
  const f = await fixture(t);
  writeFileSync(join(f.root, "fallback-ui.json"), JSON.stringify(table(false)));
  const settings = await f.h.fetch(`/api/bots/${f.bot.id}`, { method: "PATCH", body: JSON.stringify({ backupSelection: { instanceId: "claude", model: "claude-sonnet-5" } }) });
  assert.equal(settings.status, 200);
  await f.post(`/api/bots/${f.bot.id}/messages`, { text: "SCOPED_MAIN_HOLD" });
  await waitFor(() => existsSync(join(f.root, "scope-force-queue")), "earlier turn did not start");
  const before = sentTo(f, CHAT).length;
  f.tg.say("OPENUI_FALLBACK", undefined, CHAT);
  await waitFor(async () => (await f.messages()).some((m) => m.text === "OPENUI_FALLBACK" && m.queued), "backup request did not queue");
  writeFileSync(join(f.root, "main-release"), "1");
  await waitFor(() => existsSync(join(f.root, "fallback-started")), "backup did not start");
  await waitFor(() => sentTo(f, CHAT).slice(before).some((c) => c.body.text.includes("interactive")), "ordinary fallback did not arrive");
  const output = sentTo(f, CHAT).slice(before).map((c) => c.body.text).join("\n");
  assert.ok(!output.includes("Row 30"));
  assert.equal(heardContext(f).filter((c) => c.method === "turn/start" && inputWords(c).includes("OPENUI_FALLBACK")).length, 1);
});

test("a refused steer whose old turn ended before the receipt uses only the later consuming answer", async (t) => {
  const f = await fixture(t);
  writeFileSync(join(f.root, "rapid-queued-answer.json"), JSON.stringify(table(false)));
  await f.post(`/api/bots/${f.bot.id}/messages`, { text: "CTX_HOLD" });
  await waitFor(() => existsSync(join(f.root, "ctx-started")), "prior turn did not start");
  const before = sentTo(f, CHAT).length;
  f.tg.say("RAPID_REFUSE", undefined, CHAT);
  await waitFor(() => sentTo(f, CHAT).slice(before).some((c) => c.body.text.includes("Row 30")), "queued table did not arrive");
  const output = sentTo(f, CHAT).slice(before).map((c) => c.body.text).join("\n");
  assert.ok(!output.includes("EARLIER RESULT"));
  assert.equal(heardContext(f).filter((c) => c.method === "turn/start" && inputWords(c).includes("RAPID_REFUSE")).length, 1);
});

for (const kind of ["EMPTY", "FAILED"] as const) test(`a ${kind.toLowerCase()} consuming turn keeps its ordinary answer when a later turn succeeds`, async (t) => {
  const f = await fixture(t);
  writeFileSync(join(f.root, "openui-answer.json"), JSON.stringify(table(false)));
  await f.post(`/api/bots/${f.bot.id}/messages`, { text: "SCOPED_MAIN_HOLD" });
  await waitFor(() => existsSync(join(f.root, "scope-force-queue")), "earlier turn did not start");
  const before = sentTo(f, CHAT).length;
  const request = `OPENUI_${kind}`;
  f.tg.say(request, undefined, CHAT);
  await waitFor(async () => (await f.messages()).some((m) => m.text === request && m.queued), "request did not queue");
  writeFileSync(join(f.root, "main-release"), "1");
  const expected = kind === "EMPTY" ? "finished without saying anything" : "interactive";
  await waitFor(() => sentTo(f, CHAT).slice(before).some((c) => c.body.text.includes(expected)), "ordinary answer did not arrive");
  await f.post(`/api/bots/${f.bot.id}/messages`, { text: "SCOPED_LATER" });
  await waitFor(async () => (await f.messages()).some((m) => m.text === "LATER FINAL"), "later turn did not succeed");
  await sleep(250);
  const output = sentTo(f, CHAT).slice(before).map((c) => c.body.text).join("\n");
  assert.ok(!output.includes("Row 30"));
  assert.ok(!output.includes("LATER FINAL"));
  assert.equal(heardContext(f).filter((c) => c.method === "turn/start" && inputWords(c).includes(request)).length, 1);
});
