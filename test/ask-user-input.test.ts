// The required question in the MCP schema still needs a runtime check:
// a malformed tool call must not open a card with nothing to answer.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createAskBroker, type PendingAsk } from "../server/harness/ask-broker.ts";
import { readJsonLines } from "../server/ndjson.ts";

const PROXY = fileURLToPath(new URL("../server/permission-proxy.ts", import.meta.url));

function bridge(t: TestContext, publish?: string, answer = "Green") {
  const dir = mkdtempSync(join(tmpdir(), "bloks-ask-user-input-"));
  const asks: PendingAsk[] = [];
  const broker = createAskBroker({
    socketPath: join(dir, "b.sock"),
    onAsk: (ask) => {
      asks.push(ask);
      broker.answer(ask.id, ask.kind === "permission" ? "allow" : "answer", answer);
    },
    onResolve: () => {},
  });
  const proxy = spawn(process.execPath, [PROXY, join(dir, "b.sock")], {
    env: { HOME: dir, PATH: "/nonexistent", ...(publish === undefined ? {} : { BLOKS_PUBLISH: publish }) },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  proxy.stderr.on("data", (chunk) => { stderr += chunk; });
  t.after(async () => {
    const gone = new Promise<void>((resolve) => {
      if (proxy.exitCode !== null || proxy.signalCode !== null) resolve();
      else proxy.once("exit", () => resolve());
    });
    proxy.kill();
    broker.close();
    await gone;
    rmSync(dir, { recursive: true, force: true });
  });
  const replies = new Map<number, any>();
  readJsonLines(proxy.stdout, (frame) => { replies.set(frame.id, frame); });
  let id = 0;
  const call = async (name: string, args?: unknown) => {
    const key = ++id;
    const params = { name, ...(args === undefined ? {} : { arguments: args }) };
    proxy.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: key, method: "tools/call", params }) + "\n");
    for (let i = 0; i < 200 && !replies.has(key); i++) await new Promise((r) => setTimeout(r, 10));
    assert.ok(replies.has(key), `no stdio reply: ${stderr}`);
    const frame = replies.get(key);
    replies.delete(key);
    assert.equal(frame.id, key);
    return frame.result;
  };
  return { asks, call };
}

test("invalid ask_user calls never reach the broker, and a corrected call still works", async (t) => {
  const { asks, call } = bridge(t, "ask_user");
  const invalid: [string, unknown][] = [
    ["omitted arguments", undefined],
    ["null arguments", null],
    ["missing question", {}],
    ["null question", { question: null }],
    ["empty question", { question: "" }],
    ["whitespace question", { question: " \t\r\n" }],
    ["nonbreaking space question", { question: "\u00a0" }],
    ["number question", { question: 0 }],
    ["boolean question", { question: false }],
    ["array question", { question: ["Which color?"] }],
    ["object question", { question: { text: "Which color?" } }],
  ];
  for (const [name, args] of invalid) {
    await t.test(name, async () => {
      const before = asks.length;
      const result = await call("ask_user", args);
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /ask_user.*non-empty.*question/i);
      assert.equal(asks.length, before, "invalid input opened a question at the broker");
    });
  }
  await t.test("corrected input on the same proxy", async () => {
    const before = asks.length;
    const input = { question: "  Which color?\n", choices: ["Blue", "Green"] };
    const result = await call("ask_user", input);
    assert.equal(result.isError, undefined);
    assert.deepEqual(result.content, [{ type: "text", text: "Green" }]);
    assert.equal(asks.length, before + 1);
    assert.equal(asks.at(-1)?.kind, "question");
    assert.equal(asks.at(-1)?.tool, "ask_user");
    assert.deepEqual(asks.at(-1)?.input, input, "a valid question and choices were changed");
  });
});

test("a valid question with no choices keeps the unanswered guidance", async (t) => {
  const { asks, call } = bridge(t, "ask_user", "");
  const result = await call("ask_user", { question: "Which color?" });
  assert.deepEqual(asks[0].input, { question: "Which color?" });
  assert.deepEqual(result.content, [{ type: "text", text: "No answer was given. Use your best judgment." }]);
});

test("the ask_user guard leaves permission, secret and connection requests intact", async (t) => {
  const { asks, call } = bridge(t);
  const input = { command: "echo fixture" };
  const approved = await call("approve", { tool_name: "Bash", input });
  assert.deepEqual(JSON.parse(approved.content[0].text), { behavior: "allow", updatedInput: input });
  assert.equal(asks[0].kind, "permission");
  assert.equal(asks[0].tool, "Bash");
  assert.deepEqual(asks[0].input, input);

  const secret = { name: "Example API key", hint: "The example settings" };
  const requested = await call("request_secret", secret);
  assert.deepEqual(requested.content, [{ type: "text", text: "Green" }]);
  assert.equal(asks[1].kind, "question");
  assert.equal(asks[1].tool, "request_secret");
  assert.deepEqual(asks[1].input, secret);

  const connection = { apps: ["example"], reason: "Read an example document" };
  const connected = await call("request_connection", connection);
  assert.deepEqual(connected.content, [{ type: "text", text: "Green" }]);
  assert.equal(asks[2].kind, "question");
  assert.equal(asks[2].tool, "request_connection");
  assert.deepEqual(asks[2].input, connection);
});

test("an unpublished ask_user is still refused before input validation", async (t) => {
  const { asks, call } = bridge(t, "approve");
  const result = await call("ask_user", {});
  assert.equal(result.isError, true);
  assert.equal(result.content[0].text, "Bloks: there is no ask_user tool here");
  assert.equal(asks.length, 0);
});
