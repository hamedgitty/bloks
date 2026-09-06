import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough, Writable } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { test, type TestContext } from "node:test";

import type { RuntimeEvent } from "../server/contracts.ts";
import { CodexDriver } from "../server/drivers/codex.ts";

// Exercise the real driver and JSON-RPC transport against an in-memory
// app-server. No account, network, subprocess, or workspace data is used.
async function setup(t: TestContext, fullAuto = false) {
  const peers: ReturnType<typeof makePeer>[] = [];
  const logs: any[] = [];
  function makePeer() {
    const frames: any[] = [];
    const stdout = new PassThrough();
    const peer = Object.assign(new EventEmitter(), {
      stdout,
      stderr: new PassThrough(),
      kill() {},
      stdin: new Writable({
        write(chunk, _encoding, done) {
          const frame = JSON.parse(String(chunk));
          frames.push(frame);
          if (frame.method && frame.id !== undefined) {
            queueMicrotask(() => stdout.write(JSON.stringify({
              id: frame.id,
              result: frame.method === "thread/start" ? { thread: { id: "codex-thread" } } : {},
            }) + "\n"));
          }
          done();
        },
      }),
    });
    return {
      peer, frames,
      send(frame: unknown) { stdout.write(JSON.stringify(frame) + "\n"); },
      reply(id: unknown) { return frames.find((f) => f.id === id && (f.result || f.error)); },
    };
  }
  t.mock.method(childProcess, "spawn", () => {
    const peer = makePeer();
    peers.push(peer);
    return peer.peer;
  });
  t.mock.method(fs, "appendFileSync", (_path: unknown, data: unknown) => {
    logs.push(JSON.parse(String(data)));
  });
  syncBuiltinESMExports();
  const instance = await CodexDriver.create({
    instanceId: "codex", displayName: "Codex", enabled: true, environment: {},
    config: { cli: "fake-codex", fullAuto },
  });
  const events: RuntimeEvent[] = [];
  instance.adapter.onEvent((event) => events.push(event));
  t.after(async () => {
    for (const peer of peers) peer.send({ method: "turn/completed", params: { turn: { status: "completed" } } });
    await instance.dispose();
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  async function start(threadId = "task-a") {
    await instance.adapter.sendTurn({ threadId, text: "Test Drive" });
    await setImmediate();
    return peers.at(-1)!;
  }
  return { instance, events, logs, start };
}

function elicitation(id: number | string = 0, tool = "COMPOSIO_MULTI_EXECUTE_TOOL") {
  return {
    id, method: "mcpServer/elicitation/request",
    params: {
      threadId: "codex-thread", turnId: "codex-turn", serverName: "bloks_connectors",
      mode: "form", _meta: { codex_approval_kind: "mcp_tool_call" },
      message: `Allow the bloks_connectors MCP server to run tool "${tool}"?`,
      requestedSchema: { type: "object", properties: {} },
    },
  };
}

test("Accept sends an MCP action with empty content, not a command decision", async (t) => {
  const h = await setup(t);
  const peer = await h.start();
  peer.send(elicitation());
  const ask = h.events.find((e) => e.type === "request.opened")!;
  assert.equal(ask.type, "request.opened");
  if (ask.type !== "request.opened") return;
  assert.equal(ask.requestType, "permission");
  assert.equal(ask.tool, "mcp__bloks_connectors");
  assert.match(ask.summary, /COMPOSIO_MULTI_EXECUTE_TOOL/);
  assert.equal(peer.reply(0), undefined, "the call must wait for the user");
  await h.instance.adapter.respondToRequest("task-a", ask.requestId!, { behavior: "allow" });
  assert.deepEqual(peer.reply(0).result, { action: "accept", content: {}, _meta: null });
  const log = h.logs.find((l) => l.source === "bloks.approval" && l.msg.stage === "resolved").msg;
  assert.equal(log.requestId, ask.requestId);
  assert.equal(log.rpcRequestId, 0);
  assert.equal(log.threadId, "task-a");
  assert.equal(log.providerThreadId, "codex-thread");
  assert.equal(log.behavior, "allow");
  assert.equal(log.source, "user");
});

test("Reject declines MCP, while timeout cancels and is not attributed to the user", async (t) => {
  const h = await setup(t);
  const peer = await h.start();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  peer.send(elicitation(0));
  const ask = h.events.find((e) => e.type === "request.opened")!;
  await h.instance.adapter.respondToRequest("task-a", ask.requestId!, { behavior: "deny" });
  assert.deepEqual(peer.reply(0).result, { action: "decline", content: null, _meta: null });
  peer.send(elicitation(1, "COMPOSIO_MANAGE_CONNECTIONS"));
  t.mock.timers.tick(15 * 60_000);
  assert.deepEqual(peer.reply(1).result, { action: "cancel", content: null, _meta: null });
  const resolutions = h.events.filter((e) => e.type === "request.resolved");
  assert.deepEqual(resolutions.map((e) => e.source), ["user", "timeout"]);
  assert.ok(h.events.some((e) => e.type === "runtime.error" && /approval timed out/.test(e.message)));
});

test("accepted decisions survive duplicate answers, engine acknowledgments, and expired timers", async (t) => {
  const h = await setup(t);
  const peer = await h.start();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  peer.send(elicitation(0));
  const ask = h.events.find((e) => e.type === "request.opened")!;
  await h.instance.adapter.respondToRequest("task-a", ask.requestId!, { behavior: "allow" });
  await assert.rejects(h.instance.adapter.respondToRequest("task-a", ask.requestId!, { behavior: "deny" }), /no such pending request/);
  peer.send({ method: "serverRequest/resolved", params: { threadId: "codex-thread", requestId: 0 } });
  t.mock.timers.tick(15 * 60_000);
  assert.equal(peer.frames.filter((f) => f.id === 0 && f.result).length, 1);
  assert.equal(peer.reply(0).result.action, "accept");
  assert.equal(h.events.filter((e) => e.type === "request.resolved").length, 1);
});

test("engine-cleared requests cannot be answered and do not send a second RPC reply", async (t) => {
  const h = await setup(t);
  const peer = await h.start();
  peer.send(elicitation(0));
  const ask = h.events.find((e) => e.type === "request.opened")!;
  peer.send({ method: "serverRequest/resolved", params: { threadId: "another-thread", requestId: 0 } });
  assert.ok(!h.events.some((e) => e.type === "request.resolved"), "another thread cannot close this approval");
  peer.send({ method: "serverRequest/resolved", params: { threadId: "codex-thread", requestId: 0 } });
  await assert.rejects(h.instance.adapter.respondToRequest("task-a", ask.requestId!, { behavior: "allow" }), /no such pending request/);
  assert.equal(peer.reply(0), undefined);
  assert.ok(h.events.some((e) => e.type === "request.resolved" && e.source === "engine"));
  assert.ok(h.logs.some((l) => l.source === "bloks.approval" && l.msg.stage === "unavailable"));
});

test("turn completion cancels pending MCP approvals", async (t) => {
  const h = await setup(t);
  const peer = await h.start();
  peer.send(elicitation(0));
  peer.send({ method: "turn/completed", params: { turn: { status: "completed" } } });
  assert.equal(peer.reply(0).result.action, "cancel");
  assert.ok(h.events.some((e) => e.type === "request.resolved" && e.source === "turn-ended"));
});

test("concurrent tasks and out-of-order approvals keep their own RPC ids", async (t) => {
  const h = await setup(t);
  const first = await h.start("task-a");
  const second = await h.start("task-b");
  first.send(elicitation(0));
  first.send(elicitation("next"));
  second.send(elicitation(0));
  const asks = h.events.filter((e) => e.type === "request.opened");
  await assert.rejects(h.instance.adapter.respondToRequest("task-b", asks[0].requestId!, { behavior: "allow" }), /no such pending request/);
  await h.instance.adapter.respondToRequest("task-b", asks[2].requestId!, { behavior: "deny" });
  await h.instance.adapter.respondToRequest("task-a", asks[1].requestId!, { behavior: "allow" });
  assert.equal(first.reply(0), undefined);
  await h.instance.adapter.respondToRequest("task-a", asks[0].requestId!, { behavior: "allow" });
  assert.equal(first.reply(0).result.action, "accept");
  assert.equal(first.reply("next").result.action, "accept");
  assert.equal(second.reply(0).result.action, "decline");
});

test("fullAuto uses the MCP response format too", async (t) => {
  const h = await setup(t, true);
  const peer = await h.start();
  peer.send(elicitation(0));
  assert.deepEqual(peer.reply(0).result, { action: "accept", content: {}, _meta: null });
  assert.ok(!h.events.some((e) => e.type === "request.opened"));
});

test("forms requiring input are cancelled explicitly instead of submitting invented content", async (t) => {
  const h = await setup(t, true);
  const peer = await h.start();
  const request = elicitation(0);
  request.params.requestedSchema.properties = { email: { type: "string" } };
  peer.send(request);
  assert.deepEqual(peer.reply(0).result, { action: "cancel", content: null, _meta: null });
  assert.ok(h.events.some((e) => e.type === "runtime.error" && /input form/.test(e.message)));
});

test("command, edit and question replies retain their own protocol formats", async (t) => {
  const h = await setup(t);
  const peer = await h.start();
  for (const [method, allow, expected] of [
    ["item/commandExecution/requestApproval", true, "accept"],
    ["item/fileChange/requestApproval", false, "decline"],
    ["execCommandApproval", true, "approved"],
    ["applyPatchApproval", false, "denied"],
  ] as const) {
    peer.send({ id: method, method, params: { command: "test" } });
    const ask = h.events.filter((e) => e.type === "request.opened").at(-1)!;
    await h.instance.adapter.respondToRequest("task-a", ask.requestId!, { behavior: allow ? "allow" : "deny" });
    assert.deepEqual(peer.reply(method).result, { decision: expected });
  }
  peer.send({ id: "question", method: "item/tool/requestUserInput", params: {
    questions: [{ id: "date", question: "When?", options: [{ label: "Friday" }] }],
  } });
  const ask = h.events.filter((e) => e.type === "request.opened").at(-1)!;
  await h.instance.adapter.respondToRequest("task-a", ask.requestId!, { behavior: "answer", message: "Friday" });
  assert.deepEqual(peer.reply("question").result, { answers: { date: { answers: ["Friday"] } } });
});
