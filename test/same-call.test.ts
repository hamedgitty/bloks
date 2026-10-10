// A turn making the same call over and over: counted by what each call
// asked for, said as a chip on the turn at 5, 10 and 20, and once at 20 as
// a notice that the turn can be stopped. Never stopped for the person.
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
import { callSignature, REPEAT_MARKS, RepeatWatch } from "../server/repeats.ts";
import { repeatedIn } from "../src/lib/tool-summary.ts";
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

describe("counting a turn's calls", () => {
  test("the chat hears at 5, 10 and 20, and the chip moves up with it", () => {
    const watch = new RepeatWatch();
    watch.begin("lane");
    const heard: Array<{ at: number; count: number; from: string | null; notice: boolean }> = [];
    for (let i = 1; i <= 25; i++) {
      const mark = watch.note("lane", "same");
      if (!mark) continue;
      heard.push({ at: i, count: mark.count, from: mark.moveFrom?.messageId ?? null, notice: mark.notice });
      watch.chipAt("lane", { threadId: "lane", messageId: `m${i}` }, mark.count);
    }
    assert.deepEqual(heard, [
      { at: 5, count: 5, from: null, notice: false },
      { at: 10, count: 10, from: "m5", notice: false },
      { at: 20, count: 20, from: "m10", notice: true },
    ]);
    assert.deepEqual([...REPEAT_MARKS], [5, 10, 20]);
  });

  test("a second call reaching a mark the chip already shows changes nothing", () => {
    const watch = new RepeatWatch();
    watch.begin("lane");
    for (let i = 0; i < 10; i++) {
      const mark = watch.note("lane", "a");
      if (mark) watch.chipAt("lane", { threadId: "lane", messageId: `a${i}` }, mark.count);
    }
    for (let i = 0; i < 9; i++) assert.equal(watch.note("lane", "b"), null, `call ${i + 1} of b`);
    // and the notice is said once a turn, whichever call gets there
    for (let i = 0; i < 10; i++) {
      const mark = watch.note("lane", "a");
      if (mark) watch.chipAt("lane", { threadId: "lane", messageId: `a2-${i}` }, mark.count);
    }
    for (let i = 0; i < 11; i++) assert.equal(watch.note("lane", "b"), null);
  });

  test("each turn counts from nothing", () => {
    const watch = new RepeatWatch();
    watch.begin("lane");
    for (let i = 0; i < 4; i++) watch.note("lane", "same");
    watch.end("lane");
    watch.begin("lane");
    for (let i = 0; i < 4; i++) assert.equal(watch.note("lane", "same"), null);
    assert.equal(watch.note("lane", "same")?.count, 5);
  });

  test("memory stays bounded, and a loop among many calls is still counted", () => {
    const watch = new RepeatWatch();
    watch.begin("lane");
    let looped = 0;
    for (let i = 0; i < 2_000; i++) {
      watch.note("lane", `once-${i}`);
      if (i % 50 === 0 && watch.note("lane", "loop")) looped++;
    }
    assert.ok(watch.callsIn("lane") <= 256, `${watch.callsIn("lane")} calls kept for one turn`);
    assert.equal(looped, 3, "the call the turn keeps making is never the one forgotten");
    for (let i = 0; i < 2_000; i++) watch.begin(`lane-${i}`);
    assert.ok(watch.size <= 512, `${watch.size} turns kept`);
  });

  test("a run shows the highest mark among its rows", () => {
    assert.equal(repeatedIn([{}, { repeated: 5 }, { repeated: 20 }, {}]), 20);
    assert.equal(repeatedIn([{}, {}]), 0);
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
    out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tool-" + i, content: "1 failing" }] } });
  });
  out({ type: "assistant", message: { content: [{ type: "text", text: "Done" }] } });
  out({ type: "result", subtype: "success", is_error: false, num_turns: 1, duration_api_ms: 1, session_id: "loop-session", result: "Done", total_cost_usd: 0 });
  appendFileSync(${JSON.stringify(runs)}, "ran\\n");
});
`, { mode: 0o755 });
  mkdirSync(join(home, ".bloks"));
  writeFileSync(join(home, ".bloks", "config.json"), JSON.stringify({ instances: { claude: { driver: "claudeAgent", config: { cli } } } }));
  const h = await startHarness({ HOME: home });
  t.after(async () => {
    await h.stop();
    rmSync(home, { recursive: true, force: true });
  });
  const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Ada" }) });
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
  return { turn, messages };
}

const same = (n: number) => Array.from({ length: n }, () => ({ command: "npm test", description: "Run the tests" }));
const loopNotice = (m: any) => m.kind === "notice" && /same call 20 times/.test(m.text ?? "");

test("a Claude Code turn going round in circles gets one chip, and at 20 one notice", async (t) => {
  const f = await claudeFixture(t);
  // twenty of the same command, with two others among them
  await f.turn([...same(9), { command: "ls" }, ...same(11), { command: "git status" }]);
  let all = await f.messages();
  const activity = all.filter((m) => m.kind === "activity");
  assert.equal(activity.length, 22);
  const chipped = activity.filter((m) => m.repeated);
  assert.equal(chipped.length, 1, "one chip a turn, moved up rather than left behind");
  assert.equal(chipped[0].repeated, 20);
  assert.equal(activity.indexOf(chipped[0]), 20, "on the twentieth of the same call");
  const notices = all.filter(loopNotice);
  assert.equal(notices.length, 1);
  assert.match(notices[0].text, /Ada/);
  assert.doesNotMatch(notices[0].text, /npm test|Bash/, "the notice reaches a shared room's members whole");
  assert.ok(activity.every((m) => m.tool.ok === true), "nothing was stopped");

  // the next turn counts from nothing: 12 of the same is a 10, not a 32
  await f.turn(same(12));
  all = await f.messages();
  const second = all.filter((m) => m.kind === "activity").slice(22);
  assert.deepEqual(second.filter((m) => m.repeated).map((m) => [second.indexOf(m), m.repeated]), [[9, 10]]);
  assert.equal(all.filter(loopNotice).length, 1, "no second notice below 20");

  // and four of the same is nothing at all
  await f.turn(same(4));
  all = await f.messages();
  assert.equal(all.filter((m) => m.kind === "activity").slice(34).filter((m) => m.repeated).length, 0);
});

test("an API model's repeated call is counted the same way", async (t) => {
  // one round of five identical calls to a tool the session does not have,
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
        return res.end(JSON.stringify({ choices: [{ message: { role: "assistant", tool_calls: [0, 1, 2, 3, 4].map(call) } }] }));
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
  assert.equal(activity.length, 5);
  assert.deepEqual(activity.map((m) => m.repeated ?? 0), [0, 0, 0, 0, 5]);
});
