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

test("stop-and-send is one request that names the stop and never steers", async () => {
  const sent = deferred<unknown>();
  const calls: Array<{ path: string; body: any }> = [];
  const ref = { botId: "river", taskId: "plans", text: "Use the revised outline", stopFirst: true };
  const pending = sendMessage(async (path, init) => {
    calls.push({ path, body: JSON.parse(String(init?.body)) });
    return sent.promise;
  }, ref);
  // Another conversation or new draft while it waits cannot move these words.
  ref.botId = "other";
  ref.taskId = "other-lane";
  ref.text = "New draft";
  sent.resolve({ ok: true, queued: true, stopped: true });
  assert.deepEqual(await pending, { ok: true, queued: true, stopped: true });
  assert.deepEqual(calls, [
    { path: "/api/bots/river/messages", body: { text: "Use the revised outline", taskId: "plans", steer: false, stopFirst: true } },
  ]);
});

test("an older server that only queued the words is then stopped, and a refused stop keeps them sent", async () => {
  const calls: string[] = [];
  const result = await sendMessage(async path => {
    calls.push(path);
    if (path.endsWith("/interrupt")) throw new Error("Stop was refused");
    return { ok: true, queued: true };
  }, { botId: "river", taskId: "plans", text: "Keep these words", stopFirst: true });
  assert.deepEqual(result, { ok: true, queued: true });
  assert.deepEqual(calls, ["/api/bots/river/messages", "/api/bots/river/interrupt"]);
  // a turn the words started on an idle lane is not stopped
  calls.length = 0;
  await sendMessage(async path => { calls.push(path); return { ok: true }; }, { botId: "river", text: "Start", stopFirst: true });
  assert.deepEqual(calls, ["/api/bots/river/messages"]);
});

test("a refused stop-and-send reaches draft recovery once", async () => {
  const failure = new Error("Send was refused");
  const calls: string[] = [];
  let recovered = 0;
  await sendMessage(async path => { calls.push(path); throw failure; }, {
    botId: "river", text: "Keep these words", stopFirst: true,
  }).catch(error => { assert.equal(error, failure); recovered++; });
  assert.deepEqual(calls, ["/api/bots/river/messages"]);
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

test("a plain send while a stop-then-send waits goes after it, not into the turn being stopped", async () => {
  const stopped = deferred<unknown>();
  const calls: Array<{ path: string; body: any }> = [];
  const api = async (path: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    calls.push({ path, body });
    return body.stopFirst ? stopped.promise : { ok: true };
  };
  const first = sendMessage(api, { botId: "river", taskId: "plans", text: "A", stopFirst: true });
  const second = sendMessage(api, { botId: "river", taskId: "plans", text: "B" });
  // another conversation is not held up by this one
  await sendMessage(api, { botId: "river", taskId: "other", text: "C" });
  await setImmediate();
  assert.deepEqual(calls.map((c) => c.body.text), ["A", "C"]);
  stopped.resolve({ ok: true, queued: true, stopped: true });
  await first;
  await second;
  assert.deepEqual(calls.map((c) => c.body.text), ["A", "C", "B"]);
  assert.equal(calls[0]!.body.stopFirst, true);
  assert.equal(calls[2]!.body.steer, undefined);
});

test("the person's tap on how words meet a running turn rides along, except on a stop-and-send", async () => {
  const calls: Array<{ path: string; body: any }> = [];
  const api = async (path: string, init?: RequestInit) => {
    calls.push({ path, body: JSON.parse(String(init?.body)) });
    return { ok: true };
  };
  await sendMessage(api, { botId: "river", taskId: "plans", text: "add a chart", delivery: "now" });
  await sendMessage(api, { botId: "river", taskId: "plans", text: "and a table", delivery: "wait", stopFirst: true });
  assert.deepEqual(calls[0], { path: "/api/bots/river/messages", body: { text: "add a chart", taskId: "plans", delivery: "now" } });
  assert.deepEqual(calls.at(-1), { path: "/api/bots/river/messages", body: { text: "and a table", taskId: "plans", steer: false, stopFirst: true } });
});
