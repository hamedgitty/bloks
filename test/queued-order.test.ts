// Where a queued message sits in the conversation (GitHub 170).
//
// A message written while the agent works used to be stored where it was
// written and only marked as gone when it went, minutes later. The chat,
// a room's history and the transcript an engine is replayed all read
// that stored order, so it sat above everything the agent said meanwhile
// and read as if those posts answered it. Now it waits outside the
// conversation and is moved to the end of it when it goes, which is
// where the agent heard it. These hold that with a stand-in provider
// that answers only when the test lets it, so "meanwhile" is real.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startHarness, type Harness } from "./helpers/server.ts";
import { chatHarness, waitFor } from "./helpers/chat-interactions.ts";
import { splitWaiting } from "../src/lib/transcript.ts";
import type { Message } from "../src/state/reducer.ts";

test("a screen shows what waits apart from the conversation, in the order it was sent", () => {
  const m = (id: string, extra: Partial<Message> = {}): Message => ({ id, role: "user", kind: "text", text: id, at: 1, ...extra });
  const { said, waiting } = splitWaiting([
    m("asked"),
    m("first-waiting", { queued: true }),
    m("reply", { role: "bot" }),
    m("taken-back", { queued: true, deleted: true }),
    m("second-waiting", { queued: true }),
    m("never-sent", { unsent: true }),
    m("went", { queued: false, deliveredAt: 2 }),
  ]);
  assert.deepEqual(said.map((x) => x.id), ["asked", "reply", "went"]);
  // one taken back while it waited never entered the conversation, so it
  // leaves no "taken back" line behind in it either
  assert.deepEqual(waiting.map((x) => x.id), ["first-waiting", "second-waiting", "never-sent"]);
});

/** An OpenAI-compatible provider whose every answer waits for the test,
 * unless `answerAtOnce` is set. Answers are numbered, so a test can tell
 * which turn said what. */
async function fakeProvider(t: TestContext) {
  const state = {
    calls: [] as any[],
    held: [] as Array<() => void>,
    answerAtOnce: false,
  };
  const provider = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url?.endsWith("/models")) return res.end(JSON.stringify({ data: [{ id: "grok-4" }] }));
      state.calls.push(JSON.parse(body));
      const n = state.calls.length;
      const finish = () => res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: `Reply ${n}` } }] }));
      if (state.answerAtOnce) finish();
      else state.held.push(finish);
    });
  });
  await new Promise<void>((r) => provider.listen(0, "127.0.0.1", () => r()));
  t.after(() => {
    state.held.forEach((f) => f());
    provider.closeAllConnections();
    provider.close();
  });
  return { state, port: (provider.address() as { port: number }).port };
}

async function agentOn(h: Harness, port: number) {
  await h.json("/api/providers/grok/connect", { method: "POST", body: JSON.stringify({ key: "test-key", url: `http://127.0.0.1:${port}` }) });
  const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Orderly" }) });
  await h.fetch(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "grok", model: "grok-4" } }) });
  return bot as { id: string; threadId: string };
}

const lane = async (h: Harness, bot: { id: string; threadId: string }) =>
  (await h.json(`/api/bots/${bot.id}/messages?thread=${bot.threadId}&limit=500`)).messages as any[];

/** The words an engine was handed, in the order it was handed them. */
const replayed = (call: any) => (call.messages as Array<{ content?: unknown }>).map((m) => String(m.content ?? ""));

/** Reads the event stream for a moment, from a sequence number on. */
async function framesSince(h: Harness, seq: number, ms = 1_200): Promise<any[]> {
  const res = await h.fetch(`/api/events?since=${seq}`);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let seen = "";
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const race = await Promise.race([
      reader.read(),
      new Promise<null>((r) => setTimeout(() => r(null), deadline - Date.now())),
    ]);
    if (!race || race.done) break;
    seen += decoder.decode(race.value, { stream: true });
  }
  await reader.cancel().catch(() => {});
  return seen
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)));
}

async function currentSeq(h: Harness) {
  const [hello] = await framesSince(h, 0, 400);
  return Number(hello?._seq ?? 0);
}

test("a queued burst joins the conversation after what the agent said while it waited, on disk and in the replay", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "bloks-queued-order-"));
  const fake = await fakeProvider(t);
  const h = await startHarness({ HOME: home });
  t.after(() => h.stop());
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }));
  const bot = await agentOn(h, fake.port);

  await h.fetch(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: "FIRST_ASK" }) });
  await waitFor(() => fake.state.calls.length >= 1, 15_000);
  for (const text of ["WAIT_A", "WAIT_B"]) {
    const said = await h.json(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text }) });
    assert.equal(said.queued, true, `${text} waits behind the turn`);
  }
  const before = await lane(h, bot);
  const a = before.find((m) => m.text === "WAIT_A");
  const b = before.find((m) => m.text === "WAIT_B");
  assert.equal(a.queued, true);
  assert.equal(b.queued, true);

  const seq = await currentSeq(h);
  fake.state.answerAtOnce = true;
  fake.state.held.splice(0).forEach((f) => f());
  await waitFor(() => fake.state.calls.length >= 2, 15_000);
  const after = await waitFor(async () => {
    const list = await lane(h, bot);
    return list.some((m) => m.text === "Reply 2") ? list : null;
  }, 15_000);

  // The agent's answer to the first ask, then the burst, together and in
  // the order it was written, then the answer to the burst. The ids are
  // the ones the messages had while they waited.
  const texts = after.filter((m) => m.kind === "text").map((m) => m.text);
  assert.deepEqual(texts.slice(texts.indexOf("FIRST_ASK")), ["FIRST_ASK", "Reply 1", "WAIT_A", "WAIT_B", "Reply 2"]);
  const wentA = after.find((m) => m.id === a.id);
  const wentB = after.find((m) => m.id === b.id);
  assert.equal(wentA.text, "WAIT_A");
  assert.equal(wentA.queued, false);
  assert.equal(wentA.deliveredAt, wentB.deliveredAt, "one turn took the burst, so it went at one moment");
  // its place in the conversation is when it went; when it was written is kept
  assert.equal(wentA.at, wentA.deliveredAt);
  assert.equal(wentA.queuedAt, a.queuedAt);
  assert.ok(wentA.at >= after.find((m) => m.text === "Reply 1").at, "it is dated before the reply it now follows");

  // the same on disk, which is what a room's history and an export read
  const disk = JSON.parse(readFileSync(join(home, ".bloks", `messages-${bot.threadId}.json`), "utf8"));
  const onDisk = disk.filter((m: any) => m.kind === "text").map((m: any) => m.text);
  assert.deepEqual(onDisk.slice(onDisk.indexOf("FIRST_ASK")), ["FIRST_ASK", "Reply 1", "WAIT_A", "WAIT_B", "Reply 2"]);

  // and in what the engine was replayed for the burst's turn: its own
  // answer first, then the burst, never the burst above that answer
  const words = replayed(fake.state.calls[1]);
  const answered = words.findIndex((w) => w.includes("Reply 1"));
  assert.ok(answered >= 0, "the engine was not told what it said");
  assert.ok(answered < words.findIndex((w) => w.includes("WAIT_A")), "the engine heard the burst before its own answer");

  // A screen is told the message moved, not only that it changed, so it
  // can move it too; one patch each, in the burst's order.
  const moved = (await framesSince(h, seq)).filter((f) => f.kind === "message.patch" && f.moved);
  assert.deepEqual(moved.map((f) => f.message.id), [a.id, b.id]);
  assert.ok(moved.every((f) => f.threadId === bot.threadId && f.message.queued === false));
});

test("a turn's change card stays under that turn, above a message delivered after it (GitHub 207)", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "bloks-queued-card-"));
  const desk = join(home, "desk");
  mkdirSync(desk, { recursive: true });
  writeFileSync(join(desk, "plan.md"), "one\n");
  const fake = await fakeProvider(t);
  const h = await startHarness({ HOME: home });
  // stopped before its folder goes, or the server writes into a folder
  // being deleted
  t.after(() => h.stop());
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }));
  const bot = await agentOn(h, fake.port);
  const set = await h.fetch(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ cwd: desk }) });
  assert.equal(set.status, 200, await set.clone().text());

  await h.fetch(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: "FIRST_ASK" }) });
  await waitFor(() => fake.state.calls.length >= 1, 15_000);
  // the turn edits its folder, and a message waits behind it
  writeFileSync(join(desk, "plan.md"), "two\n");
  const said = await h.json(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: "WAIT_A" }) });
  assert.equal(said.queued, true);

  fake.state.answerAtOnce = true;
  fake.state.held.splice(0).forEach((f) => f());
  const after = await waitFor(async () => {
    const list = await lane(h, bot);
    return list.some((m) => m.text === "Reply 2") ? list : null;
  }, 15_000);
  const order = after
    .filter((m) => m.kind === "changes" || (m.kind === "text" && m.text))
    .map((m) => (m.kind === "changes" ? "CARD" : m.text));
  assert.deepEqual(order.slice(order.indexOf("FIRST_ASK")), ["FIRST_ASK", "Reply 1", "CARD", "WAIT_A", "Reply 2"]);
});

test("a message not sent after a restart stays out of the conversation until it is sent again", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "bloks-queued-order-"));
  const fake = await fakeProvider(t);
  fake.state.answerAtOnce = true;
  const first = await startHarness({ HOME: home });
  const bot = await agentOn(first, fake.port);
  await first.stop();

  // waiting a day when Bloks stopped: too long ago to send on its own
  const file = join(home, ".bloks", `messages-${bot.threadId}.json`);
  let list: any[] = [];
  try {
    list = JSON.parse(readFileSync(file, "utf8"));
  } catch {}
  const day = 24 * 60 * 60_000;
  list.push({ id: "stale-words", at: Date.now() - day, role: "user", kind: "text", text: "STALE_WORDS", queued: true, queuedAt: Date.now() - day });
  writeFileSync(file, JSON.stringify(list, null, 2));

  const h = await startHarness({ HOME: home });
  t.after(() => h.stop());
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }));
  const unsent = await waitFor(async () => (await lane(h, bot)).find((m) => m.id === "stale-words" && m.unsent), 15_000);
  assert.equal(unsent.queued, false);

  // the conversation goes on without it: the engine never hears it
  await h.fetch(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: "MEANWHILE" }) });
  await waitFor(() => fake.state.calls.length >= 1, 15_000);
  assert.ok(!replayed(fake.state.calls[0]).some((w) => w.includes("STALE_WORDS")), "a message never sent was replayed");
  await waitFor(async () => (await lane(h, bot)).some((m) => m.text === "Reply 1"), 15_000);

  // Send again, as the strip does it: the words said now, then the one
  // that never went taken back. They join the conversation at the end.
  await h.json(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: "STALE_WORDS", taskId: bot.threadId }) });
  assert.equal((await h.fetch(`/api/threads/${bot.threadId}/messages/stale-words`, { method: "DELETE" })).status, 200);
  await waitFor(() => fake.state.calls.length >= 2, 15_000);
  const words = replayed(fake.state.calls[1]);
  assert.ok(words.some((w) => w.includes("STALE_WORDS")), "sent again, and the engine never heard it");
  assert.ok(words.findIndex((w) => w.includes("Reply 1")) < words.findIndex((w) => w.includes("STALE_WORDS")), "sent again above what came after it");
  const now = await waitFor(async () => {
    const all = await lane(h, bot);
    return all.some((m) => m.text === "Reply 2") ? all : null;
  }, 15_000);
  const texts = now.filter((m) => m.kind === "text" && !m.deleted && !m.unsent).map((m) => m.text);
  assert.deepEqual(texts.slice(texts.indexOf("MEANWHILE")), ["MEANWHILE", "Reply 1", "STALE_WORDS", "Reply 2"]);
  assert.equal(now.find((m) => m.id === "stale-words").deleted, true, "the one that never went is still waiting");
});

test("in a room, a queued message joins the history after the round it waited behind", async (t) => {
  const c = await chatHarness();
  t.after(() => c.stop());
  const path = `/api/bloks/${c.blok.id}/messages`;
  await c.post(path, { text: "@QueueAgent first request" });
  await waitFor(() => c.calls.length === 1);
  const { message: second } = await c.post(path, { text: "@QueueAgent second request" });
  const { message: third } = await c.post(path, { text: "@QueueAgent third request" });
  assert.equal(second.queued, true);
  assert.equal(typeof second.queuedAt, "number", "a room records when a message was queued too");
  // edited while it waits, found by the id it was given
  const edit = await c.h.fetch(`/api/threads/${c.blok.id}/messages/${second.id}`, {
    method: "PATCH", body: JSON.stringify({ text: "@QueueAgent second request, reworded" }),
  });
  assert.equal(edit.status, 200);

  c.calls[0].finish();
  await waitFor(() => c.calls.length === 2);
  const said = (list: any[]) =>
    list.filter((m) => m.kind === "text" && !m.queued && /request/.test(m.text ?? "")).map((m) => m.text);
  const midway = await waitFor(async () => {
    const list = await c.messages();
    return list.find((m) => m.id === second.id)?.queued === false ? list : null;
  });
  assert.deepEqual(said(midway), [
    "@QueueAgent first request",
    "Finished this request.",
    "@QueueAgent second request, reworded",
  ]);
  assert.equal(midway.find((m) => m.id === third.id).queued, true, "the third still waits for its own turn");

  // The history the next speaker is given reads the same way: the answer,
  // then the message that waited for it, and nothing still waiting.
  const prompt = JSON.stringify(c.calls[1].body);
  const history = prompt.slice(prompt.indexOf("Recent conversation in this room:"));
  assert.ok(history.length > 0, "no room history in the prompt");
  const finished = history.indexOf("Finished this request.");
  assert.ok(finished >= 0 && finished < history.indexOf("second request, reworded"), "the room's history put the waiting message above the answer");
  assert.ok(!history.includes("third request"), "a message still waiting reached the room's history");

  c.calls[1].finish();
  await waitFor(() => c.calls.length === 3);
  const done = await waitFor(async () => {
    const list = await c.messages();
    return list.some((m) => m.queued) ? null : list;
  });
  assert.deepEqual(said(done), [
    "@QueueAgent first request",
    "Finished this request.",
    "@QueueAgent second request, reworded",
    "Finished this request.",
    "@QueueAgent third request",
  ]);
});
