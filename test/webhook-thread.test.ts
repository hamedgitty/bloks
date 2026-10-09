// Named webhook conversations through the real receiver, with a held local
// provider. No account, external provider, or live webhook is used.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { lastWithYou } from "../server/activity.ts";
import { MAX_TASKS } from "../server/store.ts";
import { MAX_WEBHOOK_QUEUE_BYTES, MAX_WEBHOOK_QUEUE_ITEMS } from "../server/limits.ts";
import { normalizeThread } from "../server/routines.ts";
import { webhookMessage } from "../server/webhooks.ts";
import { lastEditable } from "../src/lib/transcript.ts";
import { startHarness } from "./helpers/server.ts";
import { agentOn, fakeProvider, inFlight, waitFor } from "./helpers/turns.ts";

const post = (body: unknown) => ({ method: "POST", body: JSON.stringify(body) });
const patch = (body: unknown) => ({ method: "PATCH", body: JSON.stringify(body) });
const futureTime = () => {
  const at = new Date(Date.now() + 3_600_000);
  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
};

async function fixture(t: TestContext) {
  const p = await fakeProvider(t);
  const home = mkdtempSync(join(tmpdir(), "bloks-hook-thread-"));
  let h = await startHarness({ HOME: home, USERPROFILE: home });
  t.after(async () => { await h.stop(); rmSync(home, { recursive: true, force: true }); });
  const bot = await agentOn(h, p.port, "Hook receiver");
  const current = async () => (await h.json("/api/bots")).bots.find((b: any) => b.id === bot.id);
  return {
    home, bot, p, current,
    get h() { return h; },
    async hook(thread?: unknown, extra = {}) {
      const r = await h.fetch("/api/webhooks", post({ name: "Build events", botId: bot.id, thread, ...extra }));
      assert.equal(r.status, 201);
      return (await r.json()).webhook;
    },
    fire: (hook: any, event: unknown) => h.fetch(`/hook/${hook.token}`, post(event)),
    say: (text: string, taskId = bot.threadId) => h.fetch(`/api/bots/${bot.id}/messages`, post({ text, taskId })),
    async messages(laneId = bot.threadId) { return (await h.json(`/api/bots/${bot.id}/messages?thread=${laneId}&limit=500`)).messages as any[]; },
    async started(n: number) { assert.ok(await waitFor(() => p.state.calls.length >= n), h.logs()); },
    input(i: number) { return JSON.parse(p.state.calls[i]).messages.filter((m: any) => m.role === "user").at(-1).content as string; },
    async finish(i: number) {
      p.state.held[i]();
      assert.ok(await waitFor(async () => (await current()).tasks.every((l: any) => l.state === "idle")), h.logs());
    },
    async restart(edit: () => void = () => {}) { await h.stop(); edit(); h = await startHarness({ HOME: home, USERPROFILE: home }); },
  };
}

test("webhook conversation CRUD normalizes, persists, clears, and retains the existing hook URL and history", async (t) => {
  const f = await fixture(t);
  const hook = await f.hook(" \t General\n ");
  assert.equal(hook.thread, "General");
  const r = await f.h.fetch(`/api/webhooks/${hook.id}`, patch({ name: "Renamed", enabled: false, thread: "  Long   title  " }));
  assert.equal(r.status, 200);
  const changed = (await r.json()).webhook;
  assert.equal(changed.thread, "Long title");
  assert.equal(changed.token, hook.token);
  assert.equal(changed.createdAt, hook.createdAt);
  await f.restart();
  const saved = (await f.h.json("/api/webhooks")).webhooks.find((h: any) => h.id === hook.id);
  assert.equal(saved.thread, "Long title");
  assert.equal(saved.enabled, false);
  assert.equal(saved.token, hook.token);
  assert.equal((await f.h.fetch(`/api/webhooks/${hook.id}`, patch({ enabled: true, thread: "General" }))).status, 200);
  assert.equal((await f.fire(hook, { event: "recorded-delivery" })).status, 202);
  await f.started(1); await f.finish(0);
  const fired = (await f.h.json("/api/webhooks")).webhooks.find((h: any) => h.id === hook.id);
  assert.equal(fired.firedCount, 1);
  assert.equal((await f.h.fetch(`/api/webhooks/${hook.id}`, patch({ thread: null }))).status, 200);
  const cleared = (await f.h.json("/api/webhooks")).webhooks.find((h: any) => h.id === hook.id);
  assert.equal(cleared.thread, undefined);
  assert.equal(cleared.token, fired.token);
  assert.deepEqual(cleared.deliveries, fired.deliveries);
  assert.equal(cleared.firedCount, fired.firedCount);
  assert.equal((await f.h.fetch(`/api/webhooks/${hook.id}`, patch({ name: "Again" }))).status, 200);
  assert.equal((await f.h.fetch(`/api/webhooks/${hook.id}`, patch({ thread: 7, enabled: false }))).status, 400);
  assert.equal((await f.h.json("/api/webhooks")).webhooks.find((h: any) => h.id === hook.id).enabled, true);
  for (const thread of ["", " \n\t ", 7, {}, undefined]) assert.equal((await f.hook(thread)).thread, undefined);
});

test("idle General hook input is marked, uneditable, not byYou, and does not replace person activity", async (t) => {
  const f = await fixture(t);
  await f.say("Person before"); await f.started(1); await f.finish(0);
  const before = await f.current();
  const personBefore = lastEditable(await f.messages());
  assert.equal(personBefore?.text, "Person before");
  const hook = await f.hook("General");
  assert.equal((await f.fire(hook, { event: "idle-General" })).status, 202);
  await f.started(2);
  const messages = await f.messages();
  const event = messages.find((m) => m.role === "user" && m.text.includes("idle-General"));
  assert.equal(event.via, "webhook");
  assert.equal(lastEditable(messages)?.id, personBefore?.id);
  assert.equal(lastWithYou(messages), lastWithYou(messages.filter((m) => m.id !== event.id)));
  assert.equal(f.input(1), webhookMessage(hook.name, JSON.stringify({ event: "idle-General" })));
  assert.equal(inFlight(f.home).find((r: any) => r.laneId === f.bot.threadId)?.byYou, undefined);
  assert.equal((await f.current()).activeTaskId, before.activeTaskId);
  assert.ok(!(await f.current()).tasks.some((l: any) => l.title === "Webhooks"));
  await f.finish(1);
  assert.equal((await f.current()).activeWithYouAt, before.activeWithYouAt);
  await f.say("Person after"); await f.started(3);
  const after = lastEditable(await f.messages());
  assert.equal(after?.text, "Person after");
  assert.equal(after?.via, undefined);
  assert.equal(f.input(2), "Person after");
  assert.equal(inFlight(f.home).find((r: any) => r.laneId === f.bot.threadId)?.byYou, true);
  await f.finish(2);
});

test("a routine and a hook share one conversation after the exact same whitespace and UTF-16 title normalization", async (t) => {
  const f = await fixture(t);
  const raw = " \t" + "x".repeat(38) + "  😀  \n";
  const title = normalizeThread(raw)!;
  assert.equal(title.length, 40);
  assert.equal(title.charCodeAt(39), 0xd83d);
  const { routine } = await f.h.json("/api/routines", post({ prompt: "Routine in the same lane", targetId: f.bot.id, time: futureTime(), thread: raw }));
  const hook = await f.hook(raw);
  assert.equal(hook.thread, routine.thread);
  assert.equal((await f.h.fetch(`/api/routines/${routine.id}/run`, post({}))).status, 202);
  await f.started(1); await f.finish(0);
  const active = (await f.current()).activeTaskId;
  assert.equal((await f.fire(hook, { event: "same-lane" })).status, 202);
  await f.started(2); await f.finish(1);
  const matching = (await f.current()).tasks.filter((l: any) => l.title === title);
  assert.equal(matching.length, 1);
  assert.ok((await f.messages(matching[0].id)).some((m) => m.text === "Routine in the same lane"));
  assert.equal((await f.messages(matching[0].id)).filter((m) => m.role === "user" && m.text.includes("same-lane")).length, 1);
  assert.equal((await f.current()).activeTaskId, active);
});

test("busy General drains person, hook, person as one FIFO turn, once each, with the right source", async (t) => {
  const f = await fixture(t);
  const hook = await f.hook("General");
  await f.say("Running request"); await f.started(1);
  assert.equal((await f.say("PERSON-FIRST")).status, 202);
  const response = await f.fire(hook, { event: "HOOK-MIDDLE" });
  assert.equal(response.status, 202);
  assert.equal((await response.json()).queued, true);
  assert.equal((await f.say("PERSON-LAST")).status, 202);
  const queued = (await f.messages()).filter((m) => m.queued);
  assert.equal(queued.length, 3);
  assert.deepEqual(queued.map((m) => m.via), [undefined, "webhook", undefined]);
  assert.equal(f.p.state.calls.length, 1);
  f.p.state.held[0](); await f.started(2);
  const text = f.input(1);
  assert.ok(text.indexOf("PERSON-FIRST") < text.indexOf("HOOK-MIDDLE"));
  assert.ok(text.indexOf("HOOK-MIDDLE") < text.indexOf("PERSON-LAST"));
  for (const word of ["PERSON-FIRST", "HOOK-MIDDLE", "PERSON-LAST"]) assert.equal(text.split(word).length - 1, 1);
  assert.equal(text, ["PERSON-FIRST", webhookMessage(hook.name, JSON.stringify({ event: "HOOK-MIDDLE" })), "PERSON-LAST"].join("\n"));
  assert.equal(inFlight(f.home).find((r: any) => r.laneId === f.bot.threadId)?.byYou, true);
  await f.finish(1);
  assert.ok((await f.messages()).filter((m) => queued.some((q) => q.id === m.id)).every((m) => !m.queued));
  await f.say("Later request"); await f.started(3);
  assert.equal(f.input(2), "Later request"); await f.finish(2);
  assert.equal(f.p.state.calls.length, 3);
});

test("two simultaneous hooks naming General share its claim and one queue", async (t) => {
  const f = await fixture(t);
  const hooks = [await f.hook("General"), await f.hook("General")];
  const responses = await Promise.all(hooks.map((hook, i) => f.fire(hook, { event: `parallel-${i}` })));
  assert.ok(responses.every((r) => r.status === 202));
  assert.equal((await Promise.all(responses.map((r) => r.json()))).filter((r) => r.queued).length, 1);
  await f.started(1);
  assert.equal(f.p.state.calls.length, 1);
  assert.equal((await f.messages()).filter((m) => m.queued).length, 1);
  f.p.state.held[0](); await f.started(2); await f.finish(1);
  const events = (await f.messages()).filter((m) => m.role === "user" && /parallel-/.test(m.text));
  assert.equal(events.length, 2);
  assert.ok(events.every((m) => m.via === "webhook" && !m.queued));
});

for (const bound of ["items", "bytes"] as const) {
  test(`two hooks naming busy General share the webhook ${bound} bound`, async (t) => {
    const f = await fixture(t);
    const hooks = [await f.hook("General"), await f.hook("General")];
    await f.say("Keep General busy"); await f.started(1);
    const count = bound === "items" ? MAX_WEBHOOK_QUEUE_ITEMS : 8;
    const detail = bound === "bytes" ? "界".repeat(4_000) : "small";
    for (let i = 0; i < count; i++) assert.equal((await f.fire(hooks[i % 2], { event: `bounded-${i}`, detail })).status, 202);
    const rejected = await f.fire(hooks[count % 2], { event: "OVER-BOUND", detail });
    assert.equal(rejected.status, 503);
    assert.equal(rejected.headers.get("retry-after"), "30");
    const queued = (await f.messages()).filter((m) => m.queued);
    assert.equal(queued.length, count);
    assert.ok(!queued.some((m) => m.text.includes("OVER-BOUND")));
    if (bound === "bytes") {
      const bytes = queued.reduce((n, m) => n + Buffer.byteLength(m.text) + 1, 0);
      assert.ok(bytes < MAX_WEBHOOK_QUEUE_BYTES);
      assert.ok(bytes + Buffer.byteLength(queued[0].text) + 1 > MAX_WEBHOOK_QUEUE_BYTES);
    }
    const records = (await f.h.json("/api/webhooks")).webhooks;
    assert.equal(hooks.reduce((n, h) => n + records.find((r: any) => r.id === h.id).firedCount, 0), count);
    f.p.state.held[0](); await f.started(2);
    assert.equal(inFlight(f.home).find((r: any) => r.laneId === f.bot.threadId)?.byYou, undefined);
    for (let i = 0; i < count; i++) assert.equal(f.input(1).split(`bounded-${i}"`).length - 1, 1);
    await f.finish(1);
  });
}

for (const restart of [false, true]) {
  test(`drain saves a named hook on disk and delivers once after ${restart ? "restart" : "drain off"}, even after its title changes`, async (t) => {
    const f = await fixture(t);
    const hook = await f.hook("General");
    await f.h.json("/api/maintenance/drain", post({ seconds: 600 }));
    const response = await f.fire(hook, { event: "DURABLE-HOOK" });
    assert.equal(response.status, 202);
    assert.equal((await response.json()).queued, true);
    const saved = JSON.parse(readFileSync(join(f.home, ".bloks", `messages-${f.bot.threadId}.json`), "utf8"));
    const event = saved.find((m: any) => m.text?.includes("DURABLE-HOOK"));
    assert.equal(event.via, "webhook"); assert.equal(event.queued, true);
    assert.equal(f.p.state.calls.length, 0);
    assert.equal((await f.h.fetch(`/api/webhooks/${hook.id}`, patch({ thread: "Changed after acceptance" }))).status, 200);
    if (restart) await f.restart();
    else await f.h.json("/api/maintenance/drain", { method: "DELETE" });
    await f.started(1);
    assert.equal(f.input(0), webhookMessage(hook.name, JSON.stringify({ event: "DURABLE-HOOK" })));
    assert.equal(inFlight(f.home).find((r: any) => r.laneId === f.bot.threadId)?.byYou, undefined);
    await f.finish(0);
    assert.equal((await f.messages()).find((m) => m.id === event.id).queued, false);
    assert.equal(f.p.state.calls.length, 1);
    assert.ok(!(await f.current()).tasks.some((l: any) => l.title === "Changed after acceptance"));
  });
}

test("an unset conversation still uses Webhooks for idle, busy and drain delivery", async (t) => {
  const f = await fixture(t);
  const hook = await f.hook();
  const active = (await f.current()).activeTaskId;
  await f.fire(hook, { event: "default-idle" }); await f.started(1);
  const lane = (await f.current()).tasks.find((l: any) => l.title === "Webhooks");
  assert.ok(lane);
  assert.equal((await f.fire(hook, { event: "default-busy" })).status, 202);
  f.p.state.held[0](); await f.started(2); await f.finish(1);
  await f.h.json("/api/maintenance/drain", post({ seconds: 600 }));
  assert.equal((await f.fire(hook, { event: "default-drain" })).status, 202);
  assert.equal((await f.messages(lane.id)).find((m) => m.text?.includes("default-drain")).queued, true);
  await f.h.json("/api/maintenance/drain", { method: "DELETE" });
  await f.started(3); await f.finish(2);
  const events = (await f.messages(lane.id)).filter((m) => m.role === "user");
  assert.equal(events.length, 3); assert.ok(events.every((m) => m.via === "webhook" && !m.queued));
  assert.equal((await f.current()).activeTaskId, active);
});

for (const reason of ["held", "missing engine", "archived"] as const) {
  test(`a named hook refused for ${reason} records no delivery, lane or prompt`, async (t) => {
    const f = await fixture(t);
    const hook = await f.hook("Must not be created");
    if (reason === "held") await f.h.json(`/api/bots/${f.bot.id}/wheel`, post({ why: "Fixture hold" }));
    if (reason === "archived") assert.equal((await f.h.fetch(`/api/bots/${f.bot.id}`, { method: "DELETE" })).status, 200);
    if (reason === "missing engine") await f.restart(() => {
      const file = join(f.home, ".bloks", "bots.json"); const bots = JSON.parse(readFileSync(file, "utf8"));
      bots.find((b: any) => b.id === f.bot.id).modelSelection = { instanceId: "missing", model: "fixture" };
      writeFileSync(file, JSON.stringify(bots));
    });
    const response = await f.fire(hook, { event: "REFUSED-EVENT" });
    assert.equal(response.status, reason === "held" ? 503 : 409);
    const record = (await f.h.json("/api/webhooks")).webhooks.find((h: any) => h.id === hook.id);
    assert.equal(record.firedCount, undefined);
    assert.ok(!(await f.current()).tasks.some((l: any) => l.title === "Must not be created"));
    assert.ok(!(await f.messages()).some((m) => m.text?.includes("REFUSED-EVENT")));
    assert.equal(f.p.state.calls.length, 0);
  });
}

for (const protectedKind of ["shared", "rehearsal"] as const) {
  test(`a hook naming an existing ${protectedKind} lane is refused before acceptance`, async (t) => {
    const f = await fixture(t);
    const title = protectedKind === "shared" ? "Shared: Guests" : "Rehearsal: Work";
    const { bot: made } = await f.h.json(`/api/bots/${f.bot.id}/tasks`, post({ title }));
    const task = made.tasks.find((l: any) => l.title === title);
    assert.ok(task?.id);
    if (protectedKind === "shared") {
      const { bot: other } = await f.h.json("/api/bots", post({ name: "Guest helper" }));
      assert.equal((await f.h.fetch("/api/bloks", post({ name: "Guests", memberIds: [f.bot.id, other.id] }))).status, 201);
    }
    await f.restart(() => {
      if (protectedKind === "shared") {
        const file = join(f.home, ".bloks", "bloks.json"); const rooms = JSON.parse(readFileSync(file, "utf8"));
        rooms[0].lanes = { [f.bot.id]: task.id }; writeFileSync(file, JSON.stringify(rooms));
      } else {
        const dir = join(f.home, ".bloks", "rehearsals"); mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "index.json"), JSON.stringify([{ id: "fixture-rehearsal", group: "fixture", botId: f.bot.id, taskId: task.id, dir: f.home, copy: join(f.home, "gone"), text: "Work", state: "discarded", at: Date.now() }]));
      }
    });
    const hook = await f.hook(title);
    for (const draining of [false, true]) {
      if (draining) await f.h.json("/api/maintenance/drain", post({ seconds: 600 }));
      const response = await f.fire(hook, { event: "PROTECTED-PAYLOAD" });
      assert.equal(response.status, 409);
      assert.equal((await response.json()).error, "that conversation cannot receive webhook events");
    }
    assert.ok(!(await f.messages(task.id)).some((m) => m.text?.includes("PROTECTED-PAYLOAD")));
    assert.equal((await f.h.json("/api/webhooks")).webhooks.find((h: any) => h.id === hook.id).firedCount, undefined);
    assert.equal(f.p.state.calls.length, 0);
  });
}

test("at the lane cap a new hook title uses the first eligible idle fallback and keeps the active conversation", async (t) => {
  const f = await fixture(t);
  for (let i = 1; i < MAX_TASKS; i++) assert.equal((await f.h.fetch(`/api/bots/${f.bot.id}/tasks`, post({ title: `Cap lane ${i}` }))).status, 201);
  const before = await f.current();
  assert.equal((await f.h.fetch(`/api/bots/${f.bot.id}/tasks`, post({ title: "Over cap" }))).status, 409);
  const hook = await f.hook("New custom title");
  assert.equal((await f.fire(hook, { event: "CAP-FALLBACK" })).status, 202);
  await f.started(1);
  assert.equal(inFlight(f.home).find((r: any) => r.botId === f.bot.id)?.laneId, before.tasks[0].id);
  assert.equal((await f.current()).activeTaskId, before.activeTaskId);
  assert.ok(!(await f.current()).tasks.some((l: any) => l.title === "New custom title"));
  await f.finish(0);
});

test("the capped fallback passes over a rehearsal's idle lane", async (t) => {
  const f = await fixture(t);
  for (let i = 1; i < MAX_TASKS; i++) assert.equal((await f.h.fetch(`/api/bots/${f.bot.id}/tasks`, post({ title: `Cap lane ${i}` }))).status, 201);
  await f.restart(() => {
    const dir = join(f.home, ".bloks", "rehearsals"); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "index.json"), JSON.stringify([{ id: "fallback-rehearsal", group: "fixture", botId: f.bot.id, taskId: f.bot.threadId, dir: f.home, copy: join(f.home, "gone"), text: "Work", state: "discarded", at: Date.now() }]));
  });
  const before = await f.current();
  const hook = await f.hook("New capped conversation");
  assert.equal((await f.fire(hook, { event: "SAFE-FALLBACK" })).status, 202);
  assert.ok(await waitFor(async () => f.p.state.calls.length > 0 || (await f.messages()).some((m) => m.kind === "notice" && m.text.includes("could not start"))));
  assert.equal(f.p.state.calls.length, 1, "the event starts in an ordinary lane rather than being refused by a rehearsal");
  await f.started(1);
  assert.equal(inFlight(f.home).find((r: any) => r.botId === f.bot.id)?.laneId, before.tasks[1].id);
  assert.equal((await f.current()).activeTaskId, before.activeTaskId);
  assert.ok(!(await f.messages(f.bot.threadId)).some((m) => m.text?.includes("SAFE-FALLBACK")));
  await f.finish(0);
});

test("a legacy General keeps person activity when a hook is also aimed there", async (t) => {
  const f = await fixture(t);
  const hook = await f.hook("General");
  await f.say("Legacy person input"); await f.started(1); await f.finish(0);
  const expected = lastWithYou(await f.messages());
  await f.fire(hook, { event: "Marked legacy hook" }); await f.started(2); await f.finish(1);
  await f.restart(() => {
    const file = join(f.home, ".bloks", "bots.json"); const bots = JSON.parse(readFileSync(file, "utf8"));
    delete bots.find((b: any) => b.id === f.bot.id).activeWithYouAt; writeFileSync(file, JSON.stringify(bots));
  });
  assert.equal((await f.current()).activeWithYouAt, expected);
});

test("a room or workflow hook stores its thread but ignores it and keeps dispatch precedence", async (t) => {
  const f = await fixture(t);
  const { bot: other } = await f.h.json("/api/bots", post({ name: "Room helper" }));
  const { blok } = await f.h.json("/api/bloks", post({ name: "Events room", memberIds: [f.bot.id, other.id] }));
  assert.ok(blok?.id);
  const roomHook = await f.hook("Never a solo lane", { blokId: blok.id });
  assert.equal((await f.h.fetch(`/api/webhooks/${roomHook.id}`, patch({ thread: "Still ignored" }))).status, 200);
  assert.equal((await f.fire(roomHook, { event: "ROOM-EVENT" })).status, 202);
  assert.ok(await waitFor(async () => (await f.h.json("/api/bloks")).bloks.find((r: any) => r.id === blok.id).messages.some((m: any) => m.text?.includes("ROOM-EVENT"))));
  const { workflow } = await f.h.json("/api/workflows", post({ name: "Hook workflow", trigger: { kind: "webhook" }, steps: [{ action: "approve", text: "Check {{trigger.text}}", targetId: f.bot.id }] }));
  assert.ok(workflow?.id);
  const flowHook = await f.hook("Ignored flow lane", { workflowId: workflow.id, blokId: blok.id });
  assert.equal((await f.h.fetch(`/api/webhooks/${flowHook.id}`, patch({ thread: "Still ignored flow" }))).status, 200);
  assert.equal((await f.fire(flowHook, { event: "FLOW-EVENT" })).status, 202);
  assert.ok(await waitFor(async () => (await f.h.json("/api/workflows")).workflows.find((w: any) => w.id === workflow.id)?.runs?.some((r: any) => r.trigger?.text?.includes("FLOW-EVENT"))));
  const titles = (await f.current()).tasks.map((l: any) => l.title);
  for (const title of ["Still ignored", "Still ignored flow"]) assert.ok(!titles.includes(title));
});

test("another agent's matching conversation title is never selected", async (t) => {
  const f = await fixture(t);
  const { bot: other } = await f.h.json("/api/bots", post({ name: "Other receiver" }));
  const { bot: made } = await f.h.json(`/api/bots/${other.id}/tasks`, post({ title: "Event lane" }));
  const task = made.tasks.find((l: any) => l.title === "Event lane");
  const active = (await f.current()).activeTaskId;
  const hook = await f.hook("Event lane"); await f.fire(hook, { event: "OWN-AGENT" }); await f.started(1);
  const lane = (await f.current()).tasks.find((l: any) => l.title === "Event lane");
  assert.notEqual(lane.id, task.id);
  assert.equal((await f.current()).activeTaskId, active);
  assert.equal(inFlight(f.home).find((r: any) => r.botId === f.bot.id)?.laneId, lane.id);
  await f.finish(0);
});

// One race cannot be placed reliably with an HTTP timer: startTurn's hold
// check runs synchronously after the 202. Execute those real source nodes
// with a response fixture that puts the hold on at acceptance instead.
// This changes no production code and does not model the append/refusal.
for (const lateGate of ["hold", "drain"] as const) test(`a ${lateGate} placed at idle acceptance ${lateGate === "hold" ? "refuses startTurn with one notice and no orphan hook prompt" : "saves one marked webhook in the durable queue"}`, async (t) => {
  const source = readFileSync(new URL("../server/index.ts", import.meta.url), "utf8");
  const file = ts.createSourceFile("index.ts", source, ts.ScriptTarget.Latest, true);
  const names = new Set(["startTurn", "startClaimedTurn", "backgroundTaskId", "webhookLaneEligible", "webhookRefusal", "claimWebhookLane", "queueOnLane"]);
  const nodes = file.statements.filter((n): n is ts.FunctionDeclaration => ts.isFunctionDeclaration(n) && names.has(n.name?.text ?? ""));
  assert.equal(nodes.length, names.size);
  let ingress: ts.IfStatement | undefined;
  const find = (node: ts.Node) => { if (ts.isIfStatement(node) && node.expression.getText(file) === "hookMatch") ingress = node; ts.forEachChild(node, find); };
  find(file); assert.ok(ingress);
  const code = ts.transpileModule(nodes.map((n) => n.getText(file)).join("\n") + "\nasync function fire() {" + ingress.getText(file) + "}\nfire();", { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  const task = { id: "general", title: "General" };
  const bot = { id: "receiver", name: "Receiver", tasks: [task], threadId: task.id, activeTaskId: task.id };
  const hook = { botId: bot.id, thread: "General", id: "hook", name: "Build" };
  const messages: any[] = [];
  const home = mkdtempSync(join(tmpdir(), "bloks-hook-late-gate-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const disk = join(home, "messages.json");
  const drain = { on: false };
  let held = false;
  let accepted = 0;
  const context = {
    Buffer, hookMatch: ["/hook/token", "token"], method: "POST", isLocalRequest: () => true,
    req: { async *[Symbol.asyncIterator]() { yield Buffer.from('{"event":"LATE-HOLD"}'); } },
    res: { setHeader() {}, headersSent: false },
    json: (_res: any, status: number) => { assert.equal(status, 202); accepted++; if (lateGate === "hold") held = true; else drain.on = true; },
    webhooks: { byToken: () => hook, noteFired() {} },
    store: { bot: () => bot, appendMessage: (_id: string, m: any) => { m.id = `message-${messages.length}`; messages.push(m); writeFileSync(disk, JSON.stringify(messages)); return m; } },
    wheel: { heldBy: () => held ? { why: "Fixture late hold" } : undefined, noteTurnedAway() {} },
    selectEngine: () => ({ instanceId: "fake" }), registry: { get: () => ({}) },
    bloks: { roomsFor: () => [] }, rehearsals: { forTask: () => undefined },
    drain, claimedLanes: new Map(), webhookLanes: new Set(), steerQueues: new Map(), acceptingClaude: () => undefined,
    webhookMessage, MAX_WEBHOOK_QUEUE_ITEMS, MAX_WEBHOOK_QUEUE_BYTES,
    broadcast() {}, clientBot: () => bot, heldRefusal: () => "the agent is held",
    redactSecrets: (text: string) => text, drainSteer() {}, drainRoomTags() {},
  };
  await runInNewContext(code, context);
  assert.ok(await waitFor(() => messages.length));
  assert.equal(accepted, 1);
  assert.equal(messages.length, 1);
  if (lateGate === "hold") {
    assert.equal(messages.filter((m) => m.role === "user").length, 0);
    assert.equal(messages[0].kind, "notice");
    assert.match(messages[0].text, /fired but the turn could not start.*held/);
  } else {
    const saved = JSON.parse(readFileSync(disk, "utf8"));
    assert.equal(saved[0].via, "webhook");
    assert.equal(saved[0].queued, true);
    assert.equal(saved[0].text, webhookMessage(hook.name, '{"event":"LATE-HOLD"}'));
    const waiting = context.steerQueues.get(task.id)?.items;
    assert.equal(waiting?.length, 1);
    assert.equal(waiting[0].messageId, saved[0].id);
    assert.equal(waiting[0].source, "webhook");
    assert.equal(context.claimedLanes.size, 0);
  }
});
