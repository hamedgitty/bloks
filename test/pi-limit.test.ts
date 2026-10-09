// A Pi engine that runs out, and the backup that should take over.
//
// Reported: an agent on Pi (Kimi) with Claude as its backup hit Kimi's
// daily limit, and from then on every message was simply ignored. No
// error, no warning, no backup. pi-acp 0.0.34 is why: when the provider
// refuses, pi records the assistant message with stopReason "error" and
// the provider's words in its session file, and pi-acp answers
// session/prompt with end_turn and nothing else. Bloks took that as a
// turn that ended well with nothing to say.
//
// The fake below plays pi-acp in each of the shapes a failure can take:
//   file     pi-acp 0.0.34 as it is: retry status lines, then end_turn,
//            the reason only in pi's session file
//   text     the provider's error passed through as the whole reply
//   rpc      a JSON-RPC error whose reason is in data.details
//   stderr   end_turn with nothing, the reason on stderr
//   late     the same, with the reason written just after the reply, so
//            it reaches Bloks after the reply does (GitHub 233)
//   empty    end_turn with nothing at all
//   refusal  stopReason "refusal" with nothing
//   talk     an agent talking about a limit it met in its work
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import { isErrorReply, piTurnError, providerWords } from "../server/drivers/acp.ts";
import { outReason } from "../server/failover.ts";
import { startHarness, type Harness } from "./helpers/server.ts";
import { waitFor } from "./helpers/turns.ts";

const KIMI_LIMIT =
  '429 {"type":"error","error":{"type":"rate_limit_error","message":"You have reached your daily usage limit. Please try again in 3 hours."}}';

const FAKE_PI_ACP = `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const home = require("node:os").homedir();
const say = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
const chunk = (sessionId, text) =>
  say({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } });
let sessionId = null;
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined || !msg.method) return;
  const reply = (result) => say({ jsonrpc: "2.0", id: msg.id, result });
  if (msg.method === "initialize") return reply({ protocolVersion: 1, agentCapabilities: {} });
  if (msg.method === "session/new") {
    sessionId = "s-" + process.pid + "-" + Date.now();
    return reply({ sessionId });
  }
  if (msg.method !== "session/prompt") return reply({});
  const text = msg.params.prompt.map((p) => p.text).join("");
  const shape = text.match(/SHAPE (\\w+)/)?.[1] ?? "none";
  const tally = path.join(home, "asked-" + shape);
  fs.writeFileSync(tally, String((fs.existsSync(tally) ? Number(fs.readFileSync(tally, "utf8")) : 0) + 1));
  if (shape === "file") {
    // what pi writes, and where pi-acp says it is
    const file = path.join(home, "pi-sessions", sessionId + ".jsonl");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const at = new Date().toISOString();
    fs.writeFileSync(file, [
      { type: "session", id: sessionId, timestamp: at },
      { type: "message", id: "u1", timestamp: at, message: { role: "user", content: [{ type: "text", text }] } },
      { type: "message", id: "a1", timestamp: at, message: { role: "assistant", content: [], stopReason: "error", errorMessage: ${JSON.stringify(KIMI_LIMIT)} } },
    ].map((e) => JSON.stringify(e)).join("\\n") + "\\n");
    const mapFile = path.join(home, ".pi", "pi-acp", "session-map.json");
    fs.mkdirSync(path.dirname(mapFile), { recursive: true });
    let map = { version: 1, sessions: {} };
    try { map = JSON.parse(fs.readFileSync(mapFile, "utf8")); } catch {}
    map.sessions[sessionId] = { sessionId, cwd: msg.params.cwd ?? home, sessionFile: file, updatedAt: at };
    fs.writeFileSync(mapFile, JSON.stringify(map));
    chunk(sessionId, "Retrying (attempt 1/3, waiting 2s)...");
    chunk(sessionId, "Retry finished, resuming.");
    return reply({ stopReason: "end_turn" });
  }
  if (shape === "text") {
    chunk(sessionId, "Error: 429 rate_limit_reached_error: Your account org-1 request reached organization TPD rate limit, current: 2000001, limit: 2000000");
    return reply({ stopReason: "end_turn" });
  }
  if (shape === "rpc") {
    return say({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: "Internal error", data: { details: "pi prompt failed: You exceeded your current token quota: ak-1 0, please check your account balance" } } });
  }
  if (shape === "stderr") {
    process.stderr.write("pi: provider error: 429 Too Many Requests\\n");
    return reply({ stopReason: "end_turn" });
  }
  if (shape === "late") {
    reply({ stopReason: "end_turn" });
    return setImmediate(() => process.stderr.write("pi: provider error: 429 Too Many Requests\\n"));
  }
  if (shape === "refusal") return reply({ stopReason: "refusal" });
  if (shape === "talk") {
    chunk(sessionId, "Rate limit reached on the GitHub API, so I paused the sync.");
    return reply({ stopReason: "end_turn" });
  }
  return reply({ stopReason: "end_turn" });
});
`;

/** A chat engine that always answers. */
function spareEngine(): Promise<{ server: Server; url: string; asked: string[] }> {
  const asked: string[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url?.endsWith("/models")) return res.end(JSON.stringify({ data: [{ id: "m-1" }] }));
      asked.push(body);
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "Done, from the spare." } }] }));
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${(server.address() as any).port}`, asked })),
  );
}

describe("what a failed Pi turn looks like", () => {
  test("a provider error buried in JSON reads as its sentence, status kept", () => {
    assert.equal(providerWords(KIMI_LIMIT), "429: You have reached your daily usage limit. Please try again in 3 hours.");
    assert.equal(providerWords("plain words"), "plain words");
    assert.equal(providerWords("500 {not json"), "500 {not json");
  });

  test("Moonshot's and Kimi's wording counts as out", () => {
    assert.equal(outReason(KIMI_LIMIT), "limit");
    assert.equal(outReason("exceeded_current_quota_error"), "limit");
    assert.equal(outReason("You exceeded your current token quota: ak-1 0, please check your account balance"), "limit");
    assert.equal(outReason("rate_limit_reached_error: request reached organization TPD rate limit"), "limit");
    assert.equal(outReason("Your account is suspended, please check your plan and billing details"), "credit");
    assert.equal(outReason("engine_overloaded_error: The engine is currently overloaded"), "overloaded");
    assert.equal(outReason("Insufficient balance"), "credit");
    assert.equal(outReason("余额不足"), "credit");
  });

  test("an error passed through as the reply is told apart from a reply about limits", () => {
    assert.ok(isErrorReply("Error: 429 Too Many Requests"));
    assert.ok(isErrorReply(KIMI_LIMIT));
    assert.ok(isErrorReply("API error: daily limit reached"));
    assert.ok(!isErrorReply("Rate limit reached on the GitHub API, so I paused the sync."));
    assert.ok(!isErrorReply("Error handling is fine now; the rate limit retry works."));
    assert.ok(!isErrorReply("Error: 429\nand then a long explanation"));
    assert.ok(!isErrorReply("Error: the test failed"));
  });

  test("pi's session file says why, but only for this turn and only when it ended there", () => {
    const home = mkdtempSync(join(tmpdir(), "bloks-pi-file-"));
    try {
      const file = join(home, "s.jsonl");
      mkdirSync(join(home, ".pi", "pi-acp"), { recursive: true });
      writeFileSync(join(home, ".pi", "pi-acp", "session-map.json"), JSON.stringify({ version: 1, sessions: { s1: { sessionFile: file } } }));
      const at = Date.now();
      const line = (message: unknown, when = at) => JSON.stringify({ type: "message", timestamp: new Date(when).toISOString(), message });
      const failed = { role: "assistant", content: [], stopReason: "error", errorMessage: KIMI_LIMIT };
      writeFileSync(file, [line({ role: "user", content: [] }), line(failed)].join("\n") + "\n");
      assert.equal(piTurnError("s1", at, home), KIMI_LIMIT);
      assert.equal(piTurnError("other", at, home), null, "an unknown session");
      // an error from an earlier turn is history
      assert.equal(piTurnError("s1", at + 60_000, home), null);
      // a turn that went on after a retried error ended well
      writeFileSync(file, [line(failed), line({ role: "assistant", content: [{ type: "text", text: "hi" }], stopReason: "stop" })].join("\n") + "\n");
      assert.equal(piTurnError("s1", at, home), null);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("a Pi engine that runs out moves to the backup", () => {
  let h: Harness;
  let home: string;
  let spare: Awaited<ReturnType<typeof spareEngine>>;
  const shapes = ["file", "text", "rpc", "stderr", "late", "empty", "refusal", "talk"];
  before(async () => {
    home = mkdtempSync(join(tmpdir(), "bloks-pi-limit-"));
    mkdirSync(join(home, ".bloks"), { recursive: true });
    const cli = join(home, "fake-pi-acp.cjs");
    writeFileSync(cli, FAKE_PI_ACP, { mode: 0o755 });
    // one Pi engine per shape: a limit rests the whole engine
    const instances = Object.fromEntries(shapes.map((s) => [`pi-${s}`, { driver: "pi", config: { cli } }]));
    writeFileSync(join(home, ".bloks", "config.json"), JSON.stringify({ instances }));
    spare = await spareEngine();
    h = await startHarness({ HOME: home });
    await h.fetch("/api/providers/kimi/connect", { method: "POST", body: JSON.stringify({ key: "sk-test-3333333333", url: spare.url }) });
  });
  after(async () => {
    await h.stop();
    spare.server.close();
    rmSync(home, { recursive: true, force: true });
  });

  const asked = (shape: string) => {
    const file = join(home, `asked-${shape}`);
    return existsSync(file) ? Number(readFileSync(file, "utf8")) : 0;
  };
  const agentOn = async (shape: string) => {
    const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: `Pi ${shape}` }) });
    const patched = await h.fetch(`/api/bots/${bot.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        modelSelection: { instanceId: `pi-${shape}`, model: "auto" },
        backupSelection: { instanceId: "kimi", model: "m-1" },
      }),
    });
    assert.equal(patched.status, 200);
    return bot.id as string;
  };
  const settled = (botId: string, ready: (messages: any[]) => boolean) =>
    waitFor(async () => {
      const me = (await h.json("/api/bots")).bots.find((b: any) => b.id === botId);
      return !me.busy && ready(me.messages) ? me.messages : null;
    });

  for (const shape of ["file", "text", "rpc", "stderr", "late"]) {
    test(`${shape}: the backup answers, nothing of the failure is the agent's reply, and Pi rests`, async () => {
      const botId = await agentOn(shape);
      await h.fetch(`/api/bots/${botId}/messages`, { method: "POST", body: JSON.stringify({ text: `SHAPE ${shape} summarise the week` }) });
      const first = await settled(botId, (m) => m.some((x) => x.text === "Done, from the spare."));
      assert.ok(first, "the backup never answered");
      assert.equal(asked(shape), 1, "Pi is tried first, once");
      // everything after the message (the agent's greeting comes before)
      const since = first.slice(first.findIndex((m: any) => m.role === "user"));
      assert.deepEqual(
        since.filter((m: any) => m.role === "bot" && m.kind === "text").map((m: any) => m.text),
        ["Done, from the spare."],
        "the failure (or pi-acp's retry lines) was posted as the agent's reply",
      );
      const notices = since.filter((m: any) => m.kind === "notice");
      assert.equal(notices.length, 1, "said once, in plain words, not the raw error as well");
      assert.match(notices[0].text, /is picking this up/);
      // the provider's own wait (3 hours) is used, not the default rest
      if (shape === "file") assert.doesNotMatch(notices[0].text, /30 minutes/);

      // the next message goes straight to the backup: Pi is resting
      await h.fetch(`/api/bots/${botId}/messages`, { method: "POST", body: JSON.stringify({ text: `SHAPE ${shape} and next week?` }) });
      const second = await settled(botId, (m) => m.filter((x) => x.text === "Done, from the spare.").length === 2);
      assert.ok(second, "the second turn never landed");
      assert.equal(asked(shape), 1, "a resting Pi was asked again");
    });
  }

  for (const shape of ["empty", "refusal"]) {
    test(`${shape}: a turn that ends with nothing says so instead of going quiet`, async () => {
      const botId = await agentOn(shape);
      await h.fetch(`/api/bots/${botId}/messages`, { method: "POST", body: JSON.stringify({ text: `SHAPE ${shape} hello` }) });
      const messages = await settled(botId, (m) => m.some((x) => x.kind === "notice"));
      assert.ok(messages, "the turn ended without a word to the person");
      const notice = messages.find((m: any) => m.kind === "notice");
      assert.match(notice.text, shape === "empty" ? /ended the turn without a reply/ : /refusal/);
      // nothing says the engine is out, so the backup is not asked
      assert.ok(!messages.some((m: any) => /picking this up/.test(m.text ?? "")));
      assert.equal(asked(shape), 1);
    });
  }

  test("an agent that only talks about a limit is answering, not out", async () => {
    const botId = await agentOn("talk");
    await h.fetch(`/api/bots/${botId}/messages`, { method: "POST", body: JSON.stringify({ text: "SHAPE talk sync the repo" }) });
    const messages = await settled(botId, (m) => m.some((x) => x.role === "bot" && x.kind === "text"));
    assert.ok(messages, "the turn never ended");
    assert.ok(messages.some((m: any) => m.role === "bot" && m.kind === "text" && /GitHub API/.test(m.text)), "the reply was not shown");
    assert.ok(!messages.some((m: any) => /picking this up/.test(m.text ?? "")), "a reply about limits handed the turn over");
    assert.ok(!messages.some((m: any) => m.kind === "notice"), "a good turn grew a notice");
  });
});
