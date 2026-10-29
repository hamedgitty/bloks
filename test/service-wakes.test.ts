// Pure trust/binding/audit checks. Real ingress and synthetic notification
// transport proof are separate from these helpers; this starts no server.
import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { test } from "node:test";
import {
  boundServiceMessages, MAX_SERVICE_QUEUE_BYTES, MAX_SERVICE_QUEUE_ITEMS, MAX_SERVICE_WAKE_BYTES,
  ordinaryWakeLane, readWakeInput, serviceQueueFull, serviceWakeLocal, wakeRecord, wakeStatus, wakeTextHash,
} from "../server/service-wakes.ts";
import type { BotRecord, Message, TaskRecord } from "../server/store.ts";

const botId = "a0000000-0000-4000-8000-000000000001";
const taskId = "a0000000-0000-4000-8000-000000000002";
const wakeId = "a0000000-0000-4000-8000-000000000003";
const otherId = "a0000000-0000-4000-8000-000000000004";
function admitted(patch: Partial<Message> = {}): Message {
  return { id: "message-1", at: 10, role: "user", kind: "text", text: "check receipts", via: "service", queued: true, queuedAt: 10,
    serviceWake: { botId, taskId, wakeId, textHash: wakeTextHash("check receipts") }, ...patch };
}
function req(headers: IncomingMessage["headers"] = { host: "localhost:1234" }, peer = "127.0.0.1"): IncomingMessage {
  return { headers, socket: { remoteAddress: peer } } as IncomingMessage;
}

test("service origin requires an actual local peer, local Host, and absent browser/credential/forwarding headers", () => {
  assert.equal(serviceWakeLocal(req(), false), true);
  assert.equal(serviceWakeLocal(req({ host: "[::1]:1234" }, "::1"), false), true);
  assert.equal(serviceWakeLocal(req({ host: "localhost" }, "::ffff:127.0.0.1"), false), true);
  for (const headers of [
    {}, { host: "example.com" }, { host: "localhost", origin: "http://localhost" },
    { host: "localhost", origin: "" }, { host: "localhost", origin: "null" },
    { host: "localhost", authorization: "" }, { host: "localhost", authorization: "Bearer expired" },
    { host: "localhost", authorization: "Bearer valid-agent-or-device" },
  ]) assert.equal(serviceWakeLocal(req(headers), false), false, JSON.stringify(headers));
  assert.equal(serviceWakeLocal(req({ host: "localhost" }, "192.0.2.1"), false), false);
  assert.equal(serviceWakeLocal(req(), true), false, "forwarded relay requests never gain local-service authority");
});

test("wake input is an exact bounded payload, never caller-selectable provenance", () => {
  const input = { taskId, wakeId, text: "  keep the exact words  " };
  assert.deepEqual(readWakeInput(input), input);
  assert.ok(readWakeInput({ taskId, wakeId, text: "x".repeat(MAX_SERVICE_WAKE_BYTES) }));
  assert.equal(readWakeInput({ taskId, wakeId, text: "界".repeat(Math.ceil(MAX_SERVICE_WAKE_BYTES / 3)) }), null);
  for (const raw of [null, [], {}, { ...input, taskId: "General" }, { ...input, wakeId: "same" },
    { ...input, text: "\n " }, { ...input, origin: "service" }, { ...input, via: "service" },
    { ...input, byYou: true }, { ...input, serviceWake: admitted().serviceWake }, { ...input, notifications: true }]) {
    assert.equal(readWakeInput(raw), null);
  }
});

test("only an existing ordinary private owner lane may accept service work", () => {
  const bot = { id: botId } as BotRecord;
  const task = { id: taskId } as TaskRecord;
  assert.equal(ordinaryWakeLane(bot, task, false), true);
  assert.equal(ordinaryWakeLane(undefined, task, false), false);
  assert.equal(ordinaryWakeLane(bot, undefined, false), false);
  assert.equal(ordinaryWakeLane(bot, task, true), false);
  assert.equal(ordinaryWakeLane({ ...bot, archivedAt: 1 }, task, false), false);
  assert.equal(ordinaryWakeLane({ ...bot, solo: { by: "member" } } as BotRecord, task, false), false);
  for (const key of ["personId", "team", "guestMail", "signalPerson", "imported"]) {
    assert.equal(ordinaryWakeLane(bot, { ...task, [key]: true } as TaskRecord, false), false, key);
  }
});

test("lookup and retry authority bind the original bot, immutable task, wake and unchanged text", () => {
  const m = admitted();
  assert.equal(wakeRecord([m], botId, taskId, wakeId), m);
  for (const ids of [[otherId, taskId, wakeId], [botId, otherId, wakeId], [botId, taskId, otherId]]) {
    assert.equal(wakeRecord([m], ...ids as [string, string, string]), undefined);
  }
  assert.equal(boundServiceMessages([m], botId, taskId, [m.id]), true);
  assert.equal(boundServiceMessages([m], botId, otherId, [m.id]), false);
  assert.equal(boundServiceMessages([m], otherId, taskId, [m.id]), false);
  assert.equal(boundServiceMessages([m], botId, taskId, []), false);
  assert.equal(boundServiceMessages([], botId, taskId, [m.id]), false);
  for (const patch of [{ text: "changed" }, { via: undefined }, { serviceWake: undefined }, { deleted: true }, { unsent: true }, { role: "bot" }]) {
    assert.equal(boundServiceMessages([admitted(patch as Partial<Message>)], botId, taskId, [m.id]), false);
  }
  assert.equal(boundServiceMessages([admitted({ serviceWake: { ...m.serviceWake!, dispatchedAt: 20 } })], botId, taskId, [m.id]), true, "the same work may retain its binding through its own retry");
});

test("audit distinguishes known unsent from possible dispatch and erased/unknown evidence", () => {
  assert.equal(wakeStatus(undefined), "unconfirmed");
  assert.equal(wakeStatus(admitted()), "queued");
  assert.equal(wakeStatus(admitted({ queued: false })), "unconfirmed");
  assert.equal(wakeStatus(admitted({ queued: false, deliveredAt: 20 })), "unconfirmed");
  assert.equal(wakeStatus(admitted({ deleted: true, text: "" })), "unsent");
  assert.equal(wakeStatus(admitted({ unsent: true })), "unsent");
  const dispatched = { ...admitted().serviceWake!, dispatchedAt: 20 };
  assert.equal(wakeStatus(admitted({ serviceWake: dispatched, deleted: true, text: "", unsent: true })), "dispatched", "a tombstone cannot erase possible execution");
  assert.equal(wakeStatus(admitted({ via: undefined })), "unconfirmed");
  assert.equal(wakeRecord([admitted({ deleted: true, text: "" })], botId, taskId, wakeId)?.serviceWake?.textHash, wakeTextHash("check receipts"), "deletion retains bounded same-text dedup evidence");
});

test("pending service queue is bounded independently of ordinary words and dispatched work", () => {
  const queue = Array.from({ length: MAX_SERVICE_QUEUE_ITEMS }, (_, i) => admitted({ id: `m-${i}` }));
  assert.equal(serviceQueueFull(queue, "next"), true);
  assert.equal(serviceQueueFull(queue.slice(1), "next"), false);
  assert.equal(serviceQueueFull(queue.map((m) => ({ ...m, via: undefined })), "next"), false);
  assert.equal(serviceQueueFull(queue.map((m) => ({ ...m, serviceWake: { ...m.serviceWake!, dispatchedAt: 20 } })), "next"), false);
  assert.equal(serviceQueueFull(queue.map((m) => ({ ...m, unsent: true })), "next"), false);
  assert.equal(serviceQueueFull([admitted({ text: "x".repeat(MAX_SERVICE_QUEUE_BYTES - 3) })], "界"), false);
  assert.equal(serviceQueueFull([admitted({ text: "x".repeat(MAX_SERVICE_QUEUE_BYTES - 2) })], "界"), true);
});
