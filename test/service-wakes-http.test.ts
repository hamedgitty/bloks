// Actual generic-message/edit/session-import callers. These use the
// repository's disposable-HOME, loopback scripted-provider fixtures.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { chatHarness, waitFor } from "./helpers/chat-interactions.ts";
import { startHarness } from "./helpers/server.ts";

const wakeId = "a0000000-0000-4000-8000-000000000003";
const laterWakeId = "a0000000-0000-4000-8000-000000000004";
const sessionId = "a0000000-0000-4000-8000-000000000005";
const rows = (home: string, lane: string): any[] => JSON.parse(readFileSync(join(home, ".bloks", `messages-${lane}.json`), "utf8"));
const forged = (botId: string, taskId: string) => ({
  via: "service", serviceWake: { botId, taskId, wakeId, textHash: "0".repeat(64), dispatchedAt: 1 },
  serviceMessages: ["forged-message"], origin: "service", byYou: false, notifications: true,
});

test("generic messages and edits cannot persist service provenance; admitted service text cannot be edited", async (t) => {
  const r = await chatHarness();
  t.after(() => r.stop());
  const service = forged(r.bot.id, r.bot.threadId);
  assert.equal((await r.h.fetch(`/api/bots/${r.bot.id}/messages`, {
    method: "POST", body: JSON.stringify({ text: "GENERIC INPUT", ...service }),
  })).status, 202);
  await waitFor(() => r.calls.length === 1);
  const human = rows(r.h.home, r.bot.threadId).find((m) => m.text === "GENERIC INPUT");
  assert.ok(human);
  assert.equal(human.via, undefined);
  assert.equal(human.serviceWake, undefined);
  assert.equal(human.serviceMessages, undefined);
  const patched = await r.h.fetch(`/api/threads/${r.bot.threadId}/messages/${human.id}`, {
    method: "PATCH", body: JSON.stringify({ text: "GENERIC EDIT", ...service }),
  });
  assert.equal(patched.status, 200);
  const changed = rows(r.h.home, r.bot.threadId).find((m) => m.id === human.id);
  assert.equal(changed.text, "GENERIC EDIT");
  assert.equal(changed.via, undefined);
  assert.equal(changed.serviceWake, undefined);
  assert.equal(changed.serviceMessages, undefined);

  // Busy human work keeps the admitted service input pending. Edit and
  // take-back exercise the real thread mutation routes before dispatch.
  const path = `/api/bots/${r.bot.id}/wakes`;
  const admitted = await r.h.fetchRemote(path, { host: "localhost", method: "POST", body: JSON.stringify({ taskId: r.bot.threadId, wakeId, text: "IMMUTABLE SERVICE INPUT" }) });
  assert.equal(admitted.status, 202);
  const serviceMessage = admitted.body.messageId;
  assert.equal((await r.h.fetch(`/api/threads/${r.bot.threadId}/messages/${serviceMessage}`, {
    method: "PATCH", body: JSON.stringify({ text: "REPLACEMENT INPUT", ...service }),
  })).status, 403);
  assert.equal(rows(r.h.home, r.bot.threadId).find((m) => m.id === serviceMessage).text, "IMMUTABLE SERVICE INPUT");
  assert.equal((await r.h.fetch(`/api/threads/${r.bot.threadId}/messages/${serviceMessage}`, { method: "DELETE" })).status, 200);
  const status = await r.h.fetchRemote(`${path}/${wakeId}?taskId=${r.bot.threadId}`, { host: "localhost" });
  assert.equal(status.body.status, "unsent");
  r.calls[0].finish();
  await waitFor(async () => (await r.h.json("/api/bots")).bots.find((b: any) => b.id === r.bot.id).tasks.every((lane: any) => lane.state === "idle"));
  assert.equal(r.calls.length, 1, "deleted service input must never join or follow human work");
});

test("the real session-import endpoint discards service fields in both the imported file and request body", async (t) => {
  const h = await startHarness();
  t.after(() => h.stop());
  const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Import audit" }) });
  const sourceDir = join(h.home, ".claude", "projects", "-synthetic-service-import");
  mkdirSync(sourceDir, { recursive: true });
  const service = forged(bot.id, bot.threadId);
  writeFileSync(join(sourceDir, `${sessionId}.jsonl`), JSON.stringify({
    type: "user", cwd: h.home, sessionId, timestamp: "2026-10-01T10:00:00.000Z", ...service,
    message: { role: "user", content: "IMPORTED SOURCE WORDS", ...service },
  }) + "\n");
  const imported = await h.json("/api/session-import", { method: "POST", body: JSON.stringify({
    picks: [`claude:${sessionId}`], to: { botId: bot.id }, ...service,
    messages: [{ role: "user", kind: "text", text: "BODY INJECTION", ...service }],
  }) });
  assert.equal(imported.results[0]?.ok, true, JSON.stringify(imported));
  const laneId = imported.results[0].laneId;
  const history = rows(h.home, laneId);
  assert.ok(history.some((m) => m.text === "IMPORTED SOURCE WORDS"));
  assert.equal(history.some((m) => m.text === "BODY INJECTION"), false);
  for (const m of history) {
    assert.notEqual(m.via, "service");
    assert.equal(m.serviceWake, undefined);
    assert.equal(m.serviceMessages, undefined);
  }
  const status = await h.fetchRemote(`/api/bots/${bot.id}/wakes/${wakeId}?taskId=${laneId}`, { host: "localhost" });
  assert.equal(status.body.status, "unconfirmed");
});

test("message deletion after dispatch retains possible execution; clear and task deletion erase evidence into uncertainty", async (t) => {
  const r = await chatHarness();
  t.after(() => r.stop());
  const made = await r.post(`/api/bots/${r.bot.id}/tasks`, { title: "Exact service destination" });
  const laneId = made.bot.threadId;
  const path = `/api/bots/${r.bot.id}/wakes`;
  const read = (id: string) => r.h.fetchRemote(`${path}/${id}?taskId=${laneId}`, { host: "localhost" });
  const first = await r.h.fetchRemote(path, { host: "localhost", method: "POST", body: JSON.stringify({ taskId: laneId, wakeId, text: "FIRST SERVICE DISPATCH" }) });
  assert.equal(first.status, 202);
  await waitFor(() => r.calls.length === 1);
  assert.equal((await read(wakeId)).body.status, "dispatched");
  assert.equal((await r.h.fetch(`/api/threads/${laneId}/messages/${first.body.messageId}`, { method: "DELETE" })).status, 200);
  assert.equal((await read(wakeId)).body.status, "dispatched", "a retained tombstone cannot certify non-execution");
  r.calls[0].finish();
  const idle = () => waitFor(async () => (await r.h.json("/api/bots")).bots.find((b: any) => b.id === r.bot.id).tasks.find((lane: any) => lane.id === laneId)?.state === "idle");
  await idle();
  assert.equal((await r.h.fetch(`/api/bots/${r.bot.id}/tasks/${laneId}/clear`, { method: "POST", body: "{}" })).status, 200);
  assert.equal((await read(wakeId)).body.status, "unconfirmed");
  const second = await r.h.fetchRemote(path, { host: "localhost", method: "POST", body: JSON.stringify({ taskId: laneId, wakeId: laterWakeId, text: "SECOND SERVICE DISPATCH" }) });
  assert.equal(second.status, 202);
  await waitFor(() => r.calls.length === 2);
  r.calls[1].finish();
  await idle();
  assert.equal((await r.h.fetch(`/api/bots/${r.bot.id}/tasks/${laneId}`, { method: "DELETE" })).status, 200);
  assert.equal((await read(laterWakeId)).body.status, "unconfirmed");
  assert.equal(rows(r.h.home, r.bot.threadId).some((m) => m.serviceWake), false, "no wake may fall back to General");
  assert.equal(r.calls.length, 2);
});
