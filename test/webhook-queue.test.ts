// Webhook events for a busy agent wait in its Webhooks lane and go in the
// next turn, within a bound, instead of being acknowledged and dropped
// (#124). Past the bound, or when the agent is held, the sender is told to
// retry before anything is recorded as accepted.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { chatHarness, waitFor } from "./helpers/chat-interactions.ts";
import { MAX_WEBHOOK_QUEUE_BYTES, MAX_WEBHOOK_QUEUE_ITEMS } from "../server/limits.ts";

/** The real HTTP receiver, with a local provider whose turns finish only
 * when the test allows them to. No real provider or account is used. */
async function webhookHarness(t: TestContext) {
  const r = await chatHarness();
  t.after(() => r.stop());
  const { h, bot, calls, post } = r;
  const { webhook } = await post("/api/webhooks", { name: "Build events", botId: bot.id });
  const current = async () => (await h.json("/api/bots")).bots.find((b: any) => b.id === bot.id);
  return {
    h, bot, calls, current, post,
    async firedCount() {
      return (await h.json("/api/webhooks")).webhooks.find((w: any) => w.id === webhook.id).firedCount;
    },
    fire: (payload: unknown) => h.fetch(`/hook/${webhook.token}`, { method: "POST", body: JSON.stringify(payload) }),
    messages: (laneId: string) => JSON.parse(readFileSync(join(h.home, ".bloks", `messages-${laneId}.json`), "utf8")) as any[],
    async started(count: number) { await waitFor(() => calls.length >= count); },
    async settled() { await waitFor(async () => (await current()).tasks.every((lane: any) => lane.state === "idle")); },
  };
}

function lastInput(call: { body: any }) {
  const content = call.body.messages.filter((m: any) => m.role === "user").at(-1)?.content;
  return typeof content === "string" ? content : JSON.stringify(content);
}

test("a webhook accepted while Webhooks is busy waits in that lane, then is delivered once", async (t) => {
  const r = await webhookHarness(t);
  assert.equal((await r.fire({ event: "first-event" })).status, 202);
  await r.started(1);
  const lane = (await r.current()).tasks.find((task: any) => task.title === "Webhooks");
  assert.equal(lane.state, "working");
  assert.equal((await r.fire({ event: "queued-event" })).status, 202);

  // The receiver answers before dispatch; read through it before
  // inspecting the saved transcript from this other process.
  const after = await r.current();
  const queued = r.messages(lane.id).filter((m) => m.role === "user" && m.text.includes("queued-event"));
  assert.equal(queued.length, 1, "acceptance must save the event instead of expecting a retry after 202");
  assert.equal(queued[0].queued, true);
  assert.equal(after.activeTaskId, r.bot.activeTaskId, "background delivery must not change the open conversation");
  assert.equal(r.calls.length, 1, "the event must not interrupt or run beside the busy turn");

  r.calls[0].finish();
  await r.started(2);
  assert.equal(lastInput(r.calls[1]).match(/queued-event/g)?.length, 1);
  r.calls[1].finish();
  await r.settled();
  assert.equal(r.messages(lane.id).filter((m) => m.role === "user" && m.text.includes("queued-event")).length, 1);
  assert.equal(r.messages(lane.id).find((m) => m.id === queued[0].id).queued, false);
  assert.equal((await r.h.fetch(`/api/bots/${r.bot.id}/messages`, {
    method: "POST", body: JSON.stringify({ taskId: lane.id, text: "A later turn" }),
  })).status, 202);
  await r.started(3);
  assert.equal(lastInput(r.calls[2]), "A later turn");
  r.calls[2].finish();
  await r.settled();
  assert.equal(r.calls.length, 3, "a later settle must not deliver the same event again");
});

test("equal payloads accepted while busy are separate events in the follow-up turn", async (t) => {
  const r = await webhookHarness(t);
  await r.fire({ event: "first-event" });
  await r.started(1);
  const lane = (await r.current()).tasks.find((task: any) => task.title === "Webhooks");
  for (let i = 0; i < 2; i++) assert.equal((await r.fire({ event: "equal-event" })).status, 202);
  assert.equal((await r.current()).tasks.find((task: any) => task.id === lane.id).state, "working");
  const queued = r.messages(lane.id).filter((m) => m.role === "user" && m.text.includes("equal-event"));
  assert.equal(queued.length, 2, "two accepted POSTs must not be deduplicated by their text");
  assert.ok(queued.every((m) => m.queued));
  r.calls[0].finish();
  await r.started(2);
  assert.equal(lastInput(r.calls[1]).match(/equal-event/g)?.length, 2, "both events reach the turn once");
  r.calls[1].finish();
  await r.settled();
  assert.ok(r.messages(lane.id).filter((m) => queued.some((q) => q.id === m.id)).every((m) => !m.queued));
  assert.equal(r.calls.length, 2);
});

test("a held agent does not queue webhook work behind its running turn", async (t) => {
  const r = await webhookHarness(t);
  await r.fire({ event: "first-event" });
  await r.started(1);
  const lane = (await r.current()).tasks.find((task: any) => task.title === "Webhooks");
  await r.post(`/api/bots/${r.bot.id}/wheel`, { why: "driving" });
  // refused before acceptance, so the sender knows to retry later
  const refused = await r.fire({ event: "held-event" });
  assert.equal(refused.status, 503);
  await r.current();
  assert.ok(!r.messages(lane.id).some((m) => m.role === "user" && m.text.includes("held-event")));
  await r.h.fetch(`/api/bots/${r.bot.id}/wheel`, { method: "DELETE" });
  r.calls[0].finish();
  await r.settled();
  assert.equal(r.calls.length, 1, "handing the wheel back must not replay work refused during the hold");
});

test("a full webhook burst is refused before acceptance, drains once, and can admit a retry", async (t) => {
  const r = await webhookHarness(t);
  await r.fire({ event: "first-event" });
  await r.started(1);
  const lane = (await r.current()).tasks.find((task: any) => task.title === "Webhooks");
  // An ordinary queued message must not consume the webhook budget.
  await r.post(`/api/bots/${r.bot.id}/messages`, { taskId: lane.id, text: "User follow-up" });
  for (let i = 0; i < MAX_WEBHOOK_QUEUE_ITEMS; i++) {
    assert.equal((await r.fire({ event: `limit-event-${i}` })).status, 202);
  }
  const rejected = await r.fire({ event: "over-limit" });
  assert.equal(rejected.status, 503);
  assert.match((await rejected.json()).error, /retry/i);
  await r.current();
  const queued = r.messages(lane.id).filter((m) => m.role === "user" && m.text.includes("limit-event-"));
  assert.equal(queued.length, MAX_WEBHOOK_QUEUE_ITEMS);
  assert.ok(queued.every((m) => m.queued));
  assert.ok(!r.messages(lane.id).some((m) => m.text.includes("over-limit")));
  assert.equal(await r.firedCount(), MAX_WEBHOOK_QUEUE_ITEMS + 1, "refused work must not be recorded as accepted");

  r.calls[0].finish();
  await r.started(2);
  const input = lastInput(r.calls[1]);
  assert.equal(input.match(/limit-event-\d+/g)?.length, MAX_WEBHOOK_QUEUE_ITEMS);
  assert.equal(input.match(/User follow-up/g)?.length, 1);
  assert.ok(!input.includes("over-limit"));
  r.calls[1].finish();
  await r.settled();
  assert.ok(r.messages(lane.id).filter((m) => queued.some((q) => q.id === m.id)).every((m) => !m.queued));

  assert.equal((await r.fire({ event: "over-limit" })).status, 202);
  await r.started(3);
  assert.equal(lastInput(r.calls[2]).match(/over-limit/g)?.length, 1);
  r.calls[2].finish();
  await r.settled();
  assert.equal(r.calls.length, 3, "the drained burst must not replay on the retried event's settle");
});

test("webhook admission bounds aggregate UTF-8 bytes before saving another event", async (t) => {
  const r = await webhookHarness(t);
  await r.fire({ event: "first-event" });
  await r.started(1);
  const lane = (await r.current()).tasks.find((task: any) => task.title === "Webhooks");
  // The existing formatter keeps 4,000 payload characters. Eight of
  // these fit, but the ninth exceeds the byte cap before the item cap.
  const detail = "界".repeat(4_000);
  for (let i = 0; i < 8; i++) {
    assert.equal((await r.fire({ event: `byte-event-${i}`, detail })).status, 202);
  }
  await r.current();
  const queued = r.messages(lane.id).filter((m) => m.role === "user" && m.text.includes("byte-event-"));
  assert.equal(queued.length, 8);
  assert.ok(queued.every((m) => m.queued));
  const bytes = queued.reduce((sum, m) => sum + Buffer.byteLength(m.text) + 1, 0);
  const chars = queued.reduce((sum, m) => sum + m.text.length + 1, 0);
  assert.ok(bytes < MAX_WEBHOOK_QUEUE_BYTES);
  assert.ok(bytes + Buffer.byteLength(queued[0].text) + 1 > MAX_WEBHOOK_QUEUE_BYTES);
  assert.ok(9 < MAX_WEBHOOK_QUEUE_ITEMS);
  assert.ok(chars + queued[0].text.length + 1 < MAX_WEBHOOK_QUEUE_BYTES);
  const rejected = await r.fire({ event: "byte-event-8", detail });
  assert.equal(rejected.status, 503);
  assert.match((await rejected.json()).error, /retry/i);
  await r.current();
  assert.ok(!r.messages(lane.id).some((m) => m.text.includes("byte-event-8")));
  assert.equal(await r.firedCount(), 9);
  r.calls[0].finish();
  await r.started(2);
  const input = lastInput(r.calls[1]);
  for (let i = 0; i < 8; i++) assert.equal(input.match(new RegExp(`byte-event-${i}`, "g"))?.length, 1);
  assert.ok(!input.includes("byte-event-8"));
  r.calls[1].finish();
  await r.settled();
  assert.ok(r.messages(lane.id).filter((m) => queued.some((q) => q.id === m.id)).every((m) => !m.queued));
  assert.equal(r.calls.length, 2);
});

test("a webhook with no available background lane gets a retryable failure before acceptance", async (t) => {
  const r = await webhookHarness(t);
  // Fill the ordinary lane cap, with each lane on a held provider request.
  // Without a named Webhooks lane, the receiver cannot admit more work.
  let capped = false;
  for (let i = 0; i < 25; i++) {
    const made = await r.h.fetch(`/api/bots/${r.bot.id}/tasks`, {
      method: "POST", body: JSON.stringify({ title: `Lane ${i}` }),
    });
    if (made.status !== 201) { capped = true; break; }
  }
  assert.equal(capped, true);
  const lanes = (await r.current()).tasks;
  for (const lane of lanes) {
    const started = await r.h.fetch(`/api/bots/${r.bot.id}/messages`, {
      method: "POST", body: JSON.stringify({ taskId: lane.id, text: `Work in ${lane.id}` }),
    });
    assert.equal(started.status, 202);
  }
  await r.started(lanes.length);
  assert.ok((await r.current()).tasks.every((lane: any) => lane.state === "working"));
  const fired = await r.fire({ event: "retry-event" });
  assert.equal(fired.status, 503, "202 promises delivery; a sender must be told it needs to retry");
  assert.match((await fired.json()).error, /retry/i);
  assert.ok(!(await r.current()).tasks.some((lane: any) => lane.title === "Webhooks"));
});

test("a message waiting when Bloks stops runs after it starts again", async (t) => {
  // The words were always saved; only the intent to send them lived in
  // memory, so a restart left them flagged "waiting" with nothing to run
  // them. They are picked up again on start.
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { createServer } = await import("node:http");
  const { startHarness } = await import("./helpers/server.ts");
  const home = mkdtempSync(join(tmpdir(), "bloks-queue-restart-"));
  const calls: string[] = [];
  const held: Array<() => void> = [];
  let answerAtOnce = false;
  const provider = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url?.endsWith("/models")) return res.end(JSON.stringify({ data: [{ id: "grok-4" }] }));
      calls.push(body);
      const finish = () => res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "Done." } }] }));
      if (answerAtOnce) finish();
      else held.push(finish);
    });
  });
  await new Promise<void>((r) => provider.listen(0, "127.0.0.1", () => r()));
  t.after(async () => {
    held.forEach((f) => f());
    provider.closeAllConnections();
    provider.close();
  });

  const first = await startHarness({ HOME: home });
  const port = (provider.address() as { port: number }).port;
  await first.json("/api/providers/grok/connect", { method: "POST", body: JSON.stringify({ key: "test-key", url: `http://127.0.0.1:${port}` }) });
  const { bot } = await first.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Restarted" }) });
  await first.fetch(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "grok", model: "grok-4" } }) });
  await first.fetch(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: "the first thing" }) });
  await waitFor(() => calls.length >= 1);
  const waiting = await first.json(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: "WAITING-THROUGH-RESTART" }) });
  assert.equal(waiting.queued, true);
  await first.stop();

  answerAtOnce = true;
  const second = await startHarness({ HOME: home });
  t.after(() => second.stop());
  // only once the second server has stopped writing into it
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }));
  await waitFor(() => calls.some((c) => c.includes("WAITING-THROUGH-RESTART")));
  const message = await waitFor(async () => {
    const { messages } = await second.json(`/api/bots/${bot.id}/messages?thread=${bot.threadId}&limit=500`);
    const found = messages.find((m: any) => m.text === "WAITING-THROUGH-RESTART");
    return found && !found.queued ? found : null;
  });
  assert.ok(message, "the waiting message was left flagged queued after the restart");
});
