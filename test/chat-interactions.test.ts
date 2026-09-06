import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { chatHarness, decision, waitFor } from "./helpers/chat-interactions.ts";

test("room messages are visible and persisted while queued, then drain in order", async (t) => {
  const c = await chatHarness();
  t.after(() => c.stop());
  const path = `/api/bloks/${c.blok.id}/messages`;
  await c.post(path, { text: "@QueueAgent first request" });
  await waitFor(() => c.calls.length === 1);
  const queued = await c.h.fetch(path, {
    method: "POST", body: JSON.stringify({ text: "@QueueAgent second request" }), signal: AbortSignal.timeout(2_000),
  });
  assert.equal(queued.status, 202);
  const { message: second } = await queued.json() as any;
  await c.post(path, { text: "@QueueAgent third request" });
  assert.equal(c.calls.length, 1, "only the current turn should run");
  const messages = await c.messages();
  assert.equal(messages.find((m) => m.id === second.id)?.queued, true);
  assert.equal(messages.filter((m) => m.queued).length, 2);
  const disk = JSON.parse(readFileSync(join(c.h.home, ".bloks", `messages-${c.blok.id}.json`), "utf8"));
  assert.equal(disk.find((m: any) => m.id === second.id).queued, true);
  c.calls[0].finish();
  await waitFor(() => c.calls.length === 2);
  assert.equal((await c.messages()).find((m) => m.id === second.id).queued, false);
  assert.ok(!JSON.stringify(c.calls[1].body).includes("third request"), "future queued text must not reach the current turn");
  c.calls[1].finish();
  await waitFor(() => c.calls.length === 3);
  assert.match(JSON.stringify(c.calls[2].body), /third request/);
  assert.equal((await c.messages()).filter((m) => m.queued).length, 0);
  assert.equal((await c.messages()).filter((m) => m.role === "user").length, 3);
});

test("a queued room message taken back does not run", async (t) => {
  const c = await chatHarness();
  t.after(() => c.stop());
  const path = `/api/bloks/${c.blok.id}/messages`;
  await c.post(path, { text: "@QueueAgent first request" });
  await waitFor(() => c.calls.length === 1);
  const { message } = await c.post(path, { text: "@QueueAgent cancelled request" });
  await c.h.fetch(`/api/threads/${c.blok.id}/messages/${message.id}`, { method: "DELETE" });
  await c.post(path, { text: "@QueueAgent final request" });
  c.calls[0].finish();
  await waitFor(() => c.calls.length === 2);
  const prompt = JSON.stringify(c.calls[1].body);
  assert.match(prompt, /final request/);
  assert.ok(!prompt.includes("cancelled request"));
});

test("room decision options send a single queued reply and persist the user's choice", async (t) => {
  const c = await chatHarness();
  t.after(() => c.stop());
  await c.post(`/api/bloks/${c.blok.id}/messages`, { text: "@QueueAgent plan this" });
  await waitFor(() => c.calls.length === 1);
  await c.post(`/api/bots/${c.bot.id}/show`, decision);
  const card = (await c.messages()).find((m) => m.component?.kind === "decision");
  assert.ok(card, "an agent speaking in the room must show its decision in that room");
  const path = `/api/threads/${c.blok.id}/messages/${card.id}/choose`;
  const results = await Promise.all([0, 1].map(() => c.h.fetch(path, {
    method: "POST", body: JSON.stringify({ choice: 1 }),
  })));
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  const messages = await c.messages();
  assert.equal(messages.find((m) => m.id === card.id).decisionChoice, 1);
  const replies = messages.filter((m) => m.replyTo?.messageId === card.id);
  assert.equal(replies.length, 1);
  assert.equal(replies[0].text, "@QueueAgent Full rewrite");
  assert.equal(replies[0].queued, true);
  c.calls[0].finish();
  await waitFor(() => c.calls.length === 2);
  assert.match(JSON.stringify(c.calls[1].body), /Full rewrite/);
});

test("solo decisions validate choices, preserve their task, and remain retryable on refusal", async (t) => {
  const c = await chatHarness();
  t.after(() => c.stop());
  const taskId = c.bot.activeTaskId;
  await c.post(`/api/bots/${c.bot.id}/show`, decision);
  const { bots } = await c.h.json("/api/bots");
  const card = bots.find((b: any) => b.id === c.bot.id).messages.find((m: any) => m.component?.kind === "decision");
  const path = `/api/threads/${taskId}/messages/${card.id}/choose`;
  for (const choice of [-1, 2, 0.5, "1", null]) {
    const res = await c.h.fetch(path, { method: "POST", body: JSON.stringify({ choice }) });
    assert.equal(res.status, 400);
  }
  await c.post(`/api/bots/${c.bot.id}/wheel`, {});
  assert.equal((await c.h.fetch(path, { method: "POST", body: JSON.stringify({ choice: 0 }) })).status, 409);
  await c.h.fetch(`/api/bots/${c.bot.id}/wheel`, { method: "DELETE" });
  await c.post(`/api/bots/${c.bot.id}/tasks`, { title: "Another task" });
  const response = await c.post(path, { choice: 0 });
  assert.equal(response.message.decisionChoice, 0);
  await waitFor(() => c.calls.length === 1);
  // The selected task stays selected; the reply is sent to the card's task.
  const latest = await c.h.json("/api/bots");
  const bot = latest.bots.find((b: any) => b.id === c.bot.id);
  assert.notEqual(bot.activeTaskId, taskId);
  const saved = JSON.parse(readFileSync(join(c.h.home, ".bloks", `messages-${taskId}.json`), "utf8"));
  assert.ok(saved.some((m: any) => m.replyTo?.messageId === card.id && m.text === "Quick review"));
});
