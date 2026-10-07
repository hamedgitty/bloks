// Engines rebuilt while Bloks runs: a custom endpoint added or removed,
// a key changed, a provider connected (reloadProviders in
// server/index.ts; GitHub 198).
//
// A rebuild used to end every engine at once and tell nobody, so every
// lane in the middle of a turn stayed busy until Bloks restarted, and
// queued everything said to it. What matters: an engine whose settings
// did not change keeps its turn; a turn on one that was rebuilt ends,
// frees its lane, and is picked up on the new engine; and a turn whose
// engine was taken away says so instead of hanging.
import { test } from "node:test";
import assert from "node:assert/strict";

import { startHarness } from "./helpers/server.ts";
import { agentOn, fakeProvider, idle, inFlight, messagesOf, waitFor } from "./helpers/turns.ts";

const RELOAD = "The engine you run on was restarted";

test("adding and removing a custom endpoint leaves a turn on another engine running", async (t) => {
  const fake = await fakeProvider(t);
  const h = await startHarness();
  t.after(() => h.stop());
  const bot = await agentOn(h, fake.port, "Ivy");
  await h.fetch(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: "LONG-JOB" }) });
  await waitFor(() => fake.state.calls.length >= 1);

  const added = await h.json("/api/custom-endpoints", {
    method: "POST",
    body: JSON.stringify({ name: "Elsewhere", url: "http://127.0.0.1:9/v1", key: "sk-other" }),
  });
  const res = await h.fetch(`/api/custom-endpoints/${added.endpoints[0].id}`, { method: "DELETE" });
  assert.equal(res.status, 200);

  // the turn on grok was never touched: it answers when its call does
  fake.state.held.splice(0).forEach((finish) => finish());
  assert.ok(await idle(h, bot), "the lane did not settle");
  const messages = await messagesOf(h, bot);
  assert.ok(messages.some((m) => m.role === "bot" && m.text === "Done."), "the turn's answer was lost");
  assert.equal(messages.filter((m) => m.kind === "notice").length, 0, "a turn nobody cut off got a notice");
  assert.equal(fake.sent(RELOAD), 0);
  assert.equal(fake.state.calls.length, 1);
});

test("a turn on an engine that is rebuilt ends, frees its lane, and picks up on the new one", async (t) => {
  const fake = await fakeProvider(t);
  const h = await startHarness();
  t.after(() => h.stop());
  const bot = await agentOn(h, fake.port, "Ivy");
  await h.fetch(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: "LONG-JOB" }) });
  await waitFor(() => fake.state.calls.length >= 1);

  // a new key for the same provider rebuilds its engine
  fake.state.answerAtOnce = true;
  await h.json("/api/providers/grok/connect", {
    method: "POST",
    body: JSON.stringify({ key: "test-key-2", url: `http://127.0.0.1:${fake.port}` }),
  });
  assert.ok(await waitFor(() => fake.sent(RELOAD) >= 1), "the cut-off turn was never picked up");
  assert.ok(await idle(h, bot), "the lane stayed busy after its engine was rebuilt");
  // the old engine's call coming back late reaches nobody
  fake.state.held.splice(0).forEach((finish) => finish());
  await new Promise((r) => setTimeout(r, 500));

  let messages = await messagesOf(h, bot);
  const notices = messages.filter((m) => m.kind === "notice");
  assert.deepEqual(
    notices.map((m) => m.text),
    ["Ivy was cut off when its engine restarted, and is picking up where it left off."],
  );
  assert.equal(messages.filter((m) => m.role === "bot" && m.text === "Done.").length, 1);
  assert.equal(messages.filter((m) => m.role === "user" && m.text === "LONG-JOB").length, 1, "the request was asked again");
  assert.equal(fake.sent(RELOAD), 1, "picked up more than once");
  assert.deepEqual(inFlight(h.home), [], "the pickup ended and left nothing behind");

  // and the lane answers the next thing said to it, rather than queueing it
  const next = await h.json(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: "AND-THEN" }) });
  assert.notEqual(next.queued, true);
  assert.ok(await waitFor(() => fake.sent("AND-THEN") >= 1));
  assert.ok(await idle(h, bot));
  messages = await messagesOf(h, bot);
  assert.equal(messages.filter((m) => m.role === "bot" && m.text === "Done.").length, 2);
});

test("a turn whose custom endpoint is removed ends with a notice, and the lane is free", async (t) => {
  const fake = await fakeProvider(t);
  const h = await startHarness();
  t.after(() => h.stop());
  const added = await h.json("/api/custom-endpoints", {
    method: "POST",
    body: JSON.stringify({ name: "Mine", url: `http://127.0.0.1:${fake.port}/v1`, key: "sk-mine" }),
  });
  const endpoint = added.endpoints[0];
  const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Kat" }) });
  await h.fetch(`/api/bots/${bot.id}`, {
    method: "PATCH",
    body: JSON.stringify({ modelSelection: { instanceId: endpoint.instanceId, model: "grok-4" } }),
  });
  await h.fetch(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: "LONG-JOB" }) });
  await waitFor(() => fake.state.calls.length >= 1);

  const res = await h.fetch(`/api/custom-endpoints/${endpoint.id}`, { method: "DELETE" });
  assert.equal(res.status, 200);
  assert.ok(await idle(h, bot), "the lane stayed busy after its engine was removed");
  const messages = await messagesOf(h, bot);
  assert.ok(
    messages.some((m) => m.kind === "notice" && /^Kat was cut off because the engine it was running on was removed/.test(m.text ?? "")),
    "nothing said why the turn ended",
  );
  // nothing to pick up on, so nothing tried
  await new Promise((r) => setTimeout(r, 1_800));
  assert.equal(fake.sent(RELOAD), 0);
  assert.deepEqual(inFlight(h.home), []);
});

test("a card the old engine was waiting on is cut off, and answering it reaches nothing", async (t) => {
  const fake = await fakeProvider(t);
  fake.state.askOn = "DECIDE-SHIP";
  fake.state.answerAtOnce = true;
  const h = await startHarness();
  t.after(() => h.stop());
  const bot = await agentOn(h, fake.port, "Kat");
  await h.fetch(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: "DECIDE-SHIP" }) });
  const card = await waitFor(async () => (await messagesOf(h, bot)).find((m) => m.kind === "options" && m.card?.requestId)?.card);
  assert.ok(card, "no question card appeared");

  await h.json("/api/providers/grok/connect", {
    method: "POST",
    body: JSON.stringify({ key: "test-key-2", url: `http://127.0.0.1:${fake.port}` }),
  });
  assert.ok(await waitFor(() => fake.sent(RELOAD) >= 1), "the cut-off turn was never picked up");
  const old = (await messagesOf(h, bot)).find((m) => m.kind === "options" && m.card?.requestId === card.requestId);
  assert.equal(old.card.cutOff, true);
  assert.ok(old.card.answered, "the old card still reads as open");
  const calls = fake.state.calls.length;
  const answered = await h.json(`/api/bots/${bot.id}/respond`, {
    method: "POST",
    body: JSON.stringify({ requestId: card.requestId, behavior: "answer", message: "Yes" }),
  });
  assert.equal(answered.outcome, "unavailable");
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(fake.state.calls.length, calls, "an answer to the old card reached the new engine");
});
