// Signature compatibility and ordinary tool history without repeat warnings.
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import fs, { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { describe, test, type TestContext } from "node:test";

import type { RuntimeEvent } from "../server/contracts.ts";
import { acpSignature } from "../server/drivers/acp.ts";
import { CodexDriver, codexSignature } from "../server/drivers/codex.ts";
import { callSignature } from "../server/repeats.ts";
import { startHarness } from "./helpers/server.ts";
import { waitFor } from "./helpers/turns.ts";

describe("what a call asked for", () => {
  test("the same request written two ways is one request", () => {
    const a = callSignature("Bash", { command: "npm   test ", description: "Run the tests" });
    const b = callSignature("Bash", { description: "Run the tests", command: "npm test" });
    assert.equal(a, b);
    assert.match(a, /^[0-9a-f]{16}$/);
  });

  test("a different argument or a different tool is a different call", () => {
    const base = callSignature("Read", { file_path: "/w/a.ts" });
    assert.notEqual(callSignature("Read", { file_path: "/w/b.ts" }), base);
    assert.notEqual(callSignature("Write", { file_path: "/w/a.ts" }), base);
    assert.notEqual(callSignature("Read", { file_path: "/w/a.ts", offset: 10 }), base);
  });

  test("the arguments themselves are not in it, since they can carry a key", () => {
    const signature = callSignature("Bash", { command: "curl -H 'authorization: Bearer sk-live-123456'" });
    assert.doesNotMatch(signature, /sk-live|curl|Bearer/);
  });

  test("arguments built to be deep do not take the server down", () => {
    let deep: unknown = "end";
    for (let i = 0; i < 20_000; i++) deep = [deep];
    assert.match(callSignature("tool", deep), /^[0-9a-f]{16}$/);
  });

  test("Codex: only the request's own fields count, not its id or output", () => {
    const first = codexSignature({ type: "commandExecution", id: "c1", command: "npm test", cwd: "/w", status: "inProgress" });
    const again = codexSignature({ type: "commandExecution", id: "c2", command: "npm test", cwd: "/w", aggregatedOutput: "1 failing" });
    assert.ok(first);
    assert.equal(first, again);
    assert.notEqual(codexSignature({ type: "commandExecution", command: "npm test", cwd: "/elsewhere" }), first);
    assert.notEqual(codexSignature({ type: "mcpToolCall", server: "gh", tool: "issue", arguments: { n: 1 } }), codexSignature({ type: "mcpToolCall", server: "gh", tool: "issue", arguments: { n: 2 } }));
    assert.equal(codexSignature({ type: "reasoning" }), undefined);
  });

  test("ACP: from the call's own arguments, and none from an empty set of them", () => {
    const one = acpSignature({ kind: "execute", title: "ls", rawInput: { command: "ls -la", cwd: "/w" } });
    assert.ok(one);
    assert.equal(acpSignature({ kind: "execute", title: "ls", rawInput: { cwd: "/w", command: "ls  -la" } }), one);
    assert.notEqual(acpSignature({ kind: "execute", title: "ls", rawInput: { command: "ls", cwd: "/w" } }), one);
    // an agent that sends its arguments in a later update: without this,
    // every read would look like the same read
    assert.equal(acpSignature({ kind: "read", title: "Read File", rawInput: {} }), undefined);
    assert.equal(acpSignature({ kind: "read", title: "Read File" }), undefined);
  });
});

// The real Codex driver against an in-memory app-server, as in
// codex-approval.test.ts: no account, network or subprocess.
async function codexEvents(t: TestContext) {
  const peers: Array<{ send(frame: unknown): void }> = [];
  t.mock.method(childProcess, "spawn", () => {
    const stdout = new PassThrough();
    const peer = Object.assign(new EventEmitter(), {
      stdout,
      stderr: new PassThrough(),
      kill() {},
      stdin: new Writable({
        write(chunk, _encoding, done) {
          const frame = JSON.parse(String(chunk));
          if (frame.method && frame.id !== undefined) {
            queueMicrotask(() => stdout.write(JSON.stringify({ id: frame.id, result: frame.method === "thread/start" ? { thread: { id: "codex-thread" } } : {} }) + "\n"));
          }
          done();
        },
      }),
    });
    peers.push({ send: (frame) => stdout.write(JSON.stringify(frame) + "\n") });
    return peer;
  });
  t.mock.method(fs, "appendFileSync", () => {});
  syncBuiltinESMExports();
  const instance = await CodexDriver.create({ instanceId: "codex", displayName: "Codex", enabled: true, environment: {}, config: { cli: "fake-codex", fullAuto: false } });
  const events: RuntimeEvent[] = [];
  instance.adapter.onEvent((event) => events.push(event));
  t.after(async () => {
    for (const peer of peers) peer.send({ method: "turn/completed", params: { turn: { status: "completed" } } });
    await instance.dispose();
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  await instance.adapter.sendTurn({ threadId: "task-a", text: "Run the tests" });
  await setImmediate();
  return { peer: peers.at(-1)!, events };
}

test("Codex says what each command asked for on the call it starts", async (t) => {
  const { peer, events } = await codexEvents(t);
  const started = (id: string, command: string) =>
    peer.send({ method: "item/started", params: { threadId: "codex-thread", item: { id, type: "commandExecution", command, cwd: "/w" } } });
  started("c1", "npm test");
  started("c2", "npm test");
  started("c3", "npm run build");
  await setImmediate();
  const calls = events.filter((e): e is Extract<RuntimeEvent, { type: "item.started" }> => e.type === "item.started");
  assert.equal(calls.length, 3);
  assert.ok(calls[0].signature, "no signature on a Codex command");
  assert.equal(calls[0].signature, calls[1].signature);
  assert.notEqual(calls[2].signature, calls[0].signature);
});

// A stand-in Claude Code that plays each turn's tool calls from a file.
async function claudeFixture(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), "bloks-same-call-"));
  const scene = join(home, "calls.json");
  const runs = join(home, "runs.txt");
  const cli = join(home, "fake-claude.mjs");
  writeFileSync(scene, "[]");
  writeFileSync(runs, "");
  writeFileSync(cli, `#!${process.execPath}
import { appendFileSync, readFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("9.9.9 (Claude Code)"); process.exit(0); }
if (args[0] === "auth") { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
const out = (f) => console.log(JSON.stringify(f));
let input = "";
process.stdin.on("data", function take(c) {
  input += c;
  const frame = input.split("\\n").slice(0, -1).filter(Boolean).map(JSON.parse).find((f) => f.type === "user");
  if (!frame) return;
  process.stdin.off("data", take);
  out({ type: "system", subtype: "init", session_id: "loop-session", model: "claude-sonnet-5" });
  const calls = JSON.parse(readFileSync(${JSON.stringify(scene)}, "utf8"));
  calls.forEach((input, i) => {
    out({ type: "assistant", message: { content: [{ type: "tool_use", id: "tool-" + i, name: "Bash", input }] } });
    out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tool-" + i, content: input.fixtureError ? "Synthetic command failure" : "Completed", is_error: input.fixtureError === true }] } });
  });
  out({ type: "assistant", message: { content: [{ type: "text", text: "Done" }] } });
  out({ type: "result", subtype: "success", is_error: false, num_turns: 1, duration_api_ms: 1, session_id: "loop-session", result: "Done", total_cost_usd: 0 });
  appendFileSync(${JSON.stringify(runs)}, "ran\\n");
});
`, { mode: 0o755 });
  mkdirSync(join(home, ".bloks"));
  writeFileSync(join(home, ".bloks", "config.json"), JSON.stringify({ instances: { claude: { driver: "claudeAgent", config: { cli } } } }));
  const h = await startHarness({ HOME: home });
  const abort = new AbortController();
  let reading: Promise<void> | undefined;
  t.after(async () => {
    abort.abort();
    await reading;
    await h.stop();
    rmSync(home, { recursive: true, force: true });
  });
  const stream = await h.fetch("/api/events", { signal: abort.signal });
  const frames: any[] = [];
  reading = (async () => {
    let pending = "";
    try {
      const reader = stream.body!.getReader();
      for (;;) {
        const {done, value} = await reader.read();
        if (done) break;
        pending += new TextDecoder().decode(value);
        let end: number;
        while ((end = pending.indexOf("\n\n")) >= 0) {
          const frame = pending.slice(0, end); pending = pending.slice(end + 2);
          for (const line of frame.split("\n")) if (line.startsWith("data: ")) frames.push(JSON.parse(line.slice(6)));
        }
      }
    } catch (e) { if (!abort.signal.aborted) throw e; }
  })();
  assert.ok(await waitFor(() => frames.some(f => f.kind === "hello")));
  const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Sample helper" }) });
  await h.fetch(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } }) });
  const ran = () => readFileSync(runs, "utf8").split("\n").filter(Boolean).length;
  const turn = async (calls: unknown[]) => {
    writeFileSync(scene, JSON.stringify(calls));
    const before = ran();
    assert.ok((await h.fetch(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: "Make the tests pass" }) })).ok);
    assert.ok(
      await waitFor(async () => {
        if (ran() <= before) return false;
        const { bots } = await h.json("/api/bots?messages=0");
        return !bots.find((b: any) => b.id === bot.id)?.busy;
      }),
      h.logs(),
    );
  };
  const messages = async () => (await h.json(`/api/bots/${bot.id}/messages?limit=500`)).messages as any[];
  return { turn, messages, frames };
}

const same = (n: number) => Array.from({ length: n }, () => ({ command: "npm test", description: "Run the tests" }));
const loopNotice = (m: any) => m.kind === "notice" && /same call 20 times/.test(m.text ?? "");

test("more than twenty repeated, empty and distinct calls keep tool results without warnings", async (t) => {
  const f = await claudeFixture(t);
  const calls = [...same(10), { command: "ls" }, ...same(12), {}, { command: "" }, { command: "node failing.js", fixtureError: true }];
  await f.turn(calls);
  const all = await f.messages();
  const activity = all.filter(m => m.kind === "activity");
  assert.equal(activity.length, calls.length, "every ordinary tool record is retained");
  assert.equal(all.filter(loopNotice).length, 0, "no count-only stuck notice");
  assert.ok(activity.every(m => m.repeated === undefined), "new activity has no repeat metadata");
  assert.deepEqual(activity.map(m => m.tool.ok), calls.map(c => "fixtureError" in c ? false : true));
  assert.equal(activity.at(-1).tool.command, "node failing.js", "failed outcome stays on its own item");
  assert.ok(all.some(m => m.kind === "text" && m.text === "Done"), "ordinary answer retained");
  assert.ok(await waitFor(() => f.frames.some(f => f.kind === "message.patch" && f.message.id === activity.at(-1).id && f.message.tool.ok === false)));
  const ids = new Set(activity.map(m => m.id));
  const appends = f.frames.filter(f => f.kind === "message" && ids.has(f.message?.id));
  const patches = f.frames.filter(f => f.kind === "message.patch" && ids.has(f.message?.id));
  assert.equal(appends.length, calls.length);
  assert.equal(patches.length, calls.length, "exactly one required completion/error patch per tool, no repeat-driven patch");
  for (let i = 0; i < activity.length; i++) {
    const started = appends[i].message, saved = activity[i];
    assert.equal(started.id, saved.id);
    const own = patches.filter(f => f.message.id === started.id);
    assert.equal(own.length, 1, "completion belongs to exactly one started tool");
    assert.equal(own[0].message.tool.command, started.tool.command);
    assert.equal(own[0].message.tool.name, started.tool.name);
    assert.equal(own[0].message.tool.ok, saved.tool.ok);
    assert.equal(own[0].message.repeated, undefined);
  }
  await f.turn(same(25));
  const second = (await f.messages()).filter(m => m.kind === "activity").slice(activity.length);
  assert.equal(second.length, 25);
  assert.ok(second.every(m => m.repeated === undefined && m.tool.ok === true));
  assert.equal((await f.messages()).filter(loopNotice).length, 0);
});

test("an API model keeps repeated tool failures without a count warning", async (t) => {
  // one round of twenty-five identical calls to a tool the session does not have,
  // then an answer
  let round = 0;
  const provider = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url?.endsWith("/models")) return res.end(JSON.stringify({ data: [{ id: "grok-4" }] }));
      if (round++ === 0) {
        const call = (i: number) => ({ id: `call-${i}`, type: "function", function: { name: "lookup", arguments: JSON.stringify({ query: "weather" }) } });
        return res.end(JSON.stringify({ choices: [{ message: { role: "assistant", tool_calls: Array.from({ length: 25 }, (_, i) => call(i)) } }] }));
      }
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "Done." } }] }));
    });
  });
  await new Promise<void>((r) => provider.listen(0, "127.0.0.1", () => r()));
  const port = (provider.address() as { port: number }).port;
  const h = await startHarness();
  t.after(async () => {
    await h.stop();
    provider.closeAllConnections();
    provider.close();
  });
  await h.json("/api/providers/grok/connect", { method: "POST", body: JSON.stringify({ key: "test-key", url: `http://127.0.0.1:${port}` }) });
  const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Linus" }) });
  await h.fetch(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "grok", model: "grok-4" } }) });
  await h.fetch(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: "Weather?" }) });
  const settled = await waitFor(async () => {
    const all = (await h.json(`/api/bots/${bot.id}/messages?limit=200`)).messages as any[];
    return all.some((m) => m.kind === "text" && m.text === "Done.") ? all : null;
  });
  assert.ok(settled, h.logs());
  const activity = settled.filter((m) => m.kind === "activity");
  assert.equal(activity.length, 25);
  assert.ok(activity.every(m => m.repeated === undefined && m.tool.ok === false), "unknown-tool errors remain visible");
  assert.equal(settled.filter(loopNotice).length, 0, "no count-only stuck notice");
});
