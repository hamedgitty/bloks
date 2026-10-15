import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { sendMessage } from "../src/lib/sendMessage.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("stop-and-send waits for Stop and sends the follow-up once without steering", async () => {
  const stopped = deferred<unknown>();
  const sent = deferred<unknown>();
  const calls: Array<{ path: string; body: any }> = [];
  const ref = { botId: "river", taskId: "plans", text: "Use the revised outline", stopFirst: true };
  const pending = sendMessage(async (path, init) => {
    calls.push({ path, body: JSON.parse(String(init?.body)) });
    return path.endsWith("/interrupt") ? stopped.promise : sent.promise;
  }, ref);
  assert.deepEqual(calls, [{ path: "/api/bots/river/interrupt", body: { taskId: "plans" } }]);
  // Another conversation or new draft while Stop waits cannot move these words.
  ref.botId = "other";
  ref.taskId = "other-lane";
  ref.text = "New draft";
  stopped.resolve({ ok: true });
  await setImmediate();
  assert.deepEqual(calls, [
    { path: "/api/bots/river/interrupt", body: { taskId: "plans" } },
    { path: "/api/bots/river/messages", body: { text: "Use the revised outline", taskId: "plans", steer: false } },
  ]);
  sent.resolve({ ok: true, queued: true });
  assert.deepEqual(await pending, { ok: true, queued: true });
  assert.equal(calls.length, 2);
});

test("a refused Stop does not submit the follow-up and reaches draft recovery", async () => {
  const failure = new Error("Stop was refused");
  const calls: string[] = [];
  let recovered = 0;
  await sendMessage(async path => { calls.push(path); throw failure; }, {
    botId: "river", taskId: "plans", text: "Keep these words", stopFirst: true,
  }).catch(error => { assert.equal(error, failure); recovered++; });
  assert.deepEqual(calls, ["/api/bots/river/interrupt"]);
  assert.equal(recovered, 1);
});

test("a failed follow-up is returned to recovery without repeating Stop or send", async () => {
  const failure = new Error("Send was refused");
  const calls: string[] = [];
  let recovered = 0;
  await sendMessage(async path => {
    calls.push(path);
    if (path.endsWith("/messages")) throw failure;
    return { ok: true };
  }, { botId: "river", text: "Keep these words", stopFirst: true }).catch(error => {
    assert.equal(error, failure); recovered++;
  });
  assert.deepEqual(calls, ["/api/bots/river/interrupt", "/api/bots/river/messages"]);
  assert.equal(recovered, 1);
});

test("plain send leaves steering to the server and keeps reply context", async () => {
  const calls: Array<{ path: string; body: any }> = [];
  const replyTo = { id: "question", author: "River", excerpt: "Which outline?" };
  await sendMessage(async (path, init) => {
    calls.push({ path, body: JSON.parse(String(init?.body)) });
    return { ok: true, steered: true };
  }, { botId: "river", text: "The revised one", replyTo });
  assert.deepEqual(calls, [{ path: "/api/bots/river/messages", body: { text: "The revised one", replyTo } }]);
});
