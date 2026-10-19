// Every answer a card can send reaches the ask it is for (GitHub 254).
//
// Claude Code asks permission to use its own AskUserQuestion, so a
// question with choices reaches Bloks shaped like an approval. Pressing a
// choice sent "answer", the bridge took only allow or deny for that ask,
// and the refusal was read as the ask being gone: the card was closed as
// "unavailable" and hidden while the engine went on waiting for it, so
// the turn sat there and whatever was typed next waited behind it.
// Putting a question aside, and typing on an approval card, went the
// same way. Each of those now reaches the engine as something it can
// take, and a card the engine closed first stays on screen and says why.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startHarness } from "./helpers/server.ts";
import { waitFor } from "./helpers/turns.ts";

/** A Claude Code that asks through the bridge Bloks mounted for it, the
 * way the real one does, and says what the bridge answered. The words of
 * its turn pick what it asks. */
function claudeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "bloks-ask-answers-"));
  mkdirSync(join(home, ".bloks"), { recursive: true });
  const engine = { driver: "claudeAgent", config: { cli: join(home, "fake-claude.mjs") } };
  // a second engine, for an agent switched to it while an ask is open
  writeFileSync(join(home, ".bloks", "config.json"), JSON.stringify({ instances: { claude: engine, spare: engine } }));
  writeFileSync(
    join(home, "fake-claude.mjs"),
    `#!${process.execPath}
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("2.1.299 (Claude Code)"); process.exit(0); }
if (args[0] === "auth") { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
const out = (frame) => console.log(JSON.stringify(frame));
let buf = "";
const said = await new Promise((resolve) => {
  process.stdin.on("data", (c) => {
    buf += c;
    for (let i = buf.indexOf("\\n"); i >= 0; i = buf.indexOf("\\n")) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const frame = JSON.parse(line);
      if (frame.type === "user") resolve(String(frame.message?.content ?? ""));
    }
  });
});
out({ type: "system", subtype: "init", session_id: "sess-ask", model: "claude-sonnet-5" });
const done = (text) => {
  out({ type: "assistant", message: { content: [{ type: "text", text }] } });
  out({ type: "result", subtype: "success", is_error: false, num_turns: 1, duration_api_ms: 100, total_cost_usd: 0, session_id: "sess-ask", result: text });
};
const calls = {
  "NATIVE-QUESTION": { name: "approve", arguments: { tool_name: "AskUserQuestion", input: { questions: [
    { question: "Which database?", header: "Database", multiSelect: false, options: [{ label: "Postgres", description: "A server" }, { label: "SQLite", description: "A file" }] },
    { question: "Which port?", header: "Port", multiSelect: false, options: [{ label: "5432", description: "" }, { label: "8080", description: "" }] },
  ] } } },
  "OWN-QUESTION": { name: "ask_user", arguments: { question: "Ship it today?", choices: ["Today", "Friday"] } },
  "RUN-COMMAND": { name: "approve", arguments: { tool_name: "Bash", input: { command: "rm -rf build" } } },
  "ASK-THEN-LEAVE": { name: "ask_user", arguments: { question: "Still there?", choices: ["Yes", "No"] } },
  "ASK-AFTERWARDS": { name: "ask_user", arguments: { question: "Keep the old files?", choices: ["Keep", "Delete"] } },
};
const which = Object.keys(calls).find((word) => said.includes(word));
if (!which) {
  done("Done.");
} else {
  // the servers come in a private file, never on the command line
  const { command, args: bridgeArgs, env } = JSON.parse(readFileSync(args[args.indexOf("--mcp-config") + 1], "utf8")).mcpServers.bloks;
  const bridge = spawn(command, bridgeArgs, { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "inherit"] });
  const replies = new Map();
  let got = "";
  bridge.stdout.on("data", (c) => {
    got += c;
    for (let end = got.indexOf("\\n"); end >= 0; end = got.indexOf("\\n")) {
      const reply = JSON.parse(got.slice(0, end));
      got = got.slice(end + 1);
      replies.get(reply.id)?.(reply.result);
    }
  });
  const call = (id, method, params) => new Promise((resolve) => {
    replies.set(id, resolve);
    bridge.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\\n");
  });
  // the bridge is up, and on the turn's socket, before anything is asked
  await call(0, "initialize", {});
  await new Promise((r) => setTimeout(r, 300));
  // something left running asks once the turn's result is in
  if (which === "ASK-AFTERWARDS") done("Working on it.");
  const answer = call(1, "tools/call", calls[which]).then((result) => result.content[0].text);
  if (which === "ASK-AFTERWARDS") {
    writeFileSync(${JSON.stringify(join(home, "afterwards.txt"))}, await answer);
  } else if (which === "ASK-THEN-LEAVE") {
    // long enough for the card to be on screen, then the turn ends under it
    await new Promise((r) => setTimeout(r, 1500));
    done("Never mind.");
  } else {
    done("HEARD " + (await answer));
  }
  bridge.kill();
}
setTimeout(() => process.exit(0), 50);
`,
    { mode: 0o755 },
  );
  return home;
}

/** A Codex that asks a question over its own protocol. WITHDRAWN takes
 * the question back a moment later and works on, ending when it is told
 * something more. */
function codexHome(): string {
  const home = mkdtempSync(join(tmpdir(), "bloks-ask-answers-"));
  mkdirSync(join(home, ".bloks"), { recursive: true });
  writeFileSync(join(home, ".bloks", "config.json"), JSON.stringify({ instances: { codex: { driver: "codex", config: { cli: join(home, "fake-codex.mjs") } } } }));
  writeFileSync(
    join(home, "fake-codex.mjs"),
    `#!${process.execPath}
import { createInterface } from "node:readline";
if (process.argv[2] === "--version") { console.log("codex-cli 0.160.0"); process.exit(0); }
if (process.argv[2] === "login") { console.log("Logged in using ChatGPT"); process.exit(0); }
process.stdin.on("end", () => process.exit(0));
const out = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
let thread, turn;
const waiting = new Map();
const question = { itemId: "q", questions: [{ id: "q1", question: "Which colour?", options: [{ label: "Red" }, { label: "Blue" }] }] };
const ask = (id) => new Promise((resolve) => { waiting.set(id, resolve); out({ id, method: "item/tool/requestUserInput", params: { threadId: thread, turnId: turn, ...question } }); });
const finish = (text) => {
  out({ method: "item/completed", params: { threadId: thread, turnId: turn, item: { type: "agentMessage", id: "answer", text } } });
  out({ method: "turn/completed", params: { threadId: thread, turn: { id: turn, status: "completed" } } });
};
createInterface({ input: process.stdin }).on("line", async (line) => {
  const m = JSON.parse(line);
  if (!m.method) { waiting.get(m.id)?.(m.result); waiting.delete(m.id); return; }
  const reply = (result = {}) => out({ id: m.id, result });
  if (m.method === "initialize") return reply();
  if (m.method === "initialized") return;
  if (m.method === "model/list") return reply({ data: [{ id: "gpt-6.1-sol", model: "gpt-6.1-sol", displayName: "GPT-6.1 Sol", isDefault: true, hidden: false }] });
  if (m.method === "skills/list") return reply({ data: [{ cwd: m.params.cwds[0], skills: [], errors: [] }] });
  if (m.method === "thread/start" || m.method === "thread/resume") { thread = m.params.threadId ?? "native-" + process.pid; return reply({ thread: { id: thread }, model: "gpt-6.1-sol" }); }
  if (m.method === "turn/steer") { reply({ turnId: turn }); return finish("TOLD " + m.params.input[0].text); }
  if (m.method !== "turn/start") return reply();
  turn = "work-" + process.pid; reply({ turn: { id: turn } });
  out({ method: "turn/started", params: { threadId: thread, turn: { id: turn } } });
  const text = m.params.input.filter((i) => i.type === "text").map((i) => i.text).join("");
  if (text.includes("WITHDRAWN")) {
    void ask(7);
    setTimeout(() => out({ method: "serverRequest/resolved", params: { threadId: thread, requestId: 7 } }), 1200);
    return;
  }
  if (text.includes("QUESTION")) return finish("PICKED " + (await ask(7)).answers.q1.answers[0]);
  finish("Done.");
});
`,
    { mode: 0o755 },
  );
  return home;
}

/** An ACP agent that asks to edit a file and waits to be told. */
function acpHome(): string {
  const home = mkdtempSync(join(tmpdir(), "bloks-ask-answers-"));
  mkdirSync(join(home, ".bloks"), { recursive: true });
  writeFileSync(join(home, ".bloks", "config.json"), JSON.stringify({ instances: { acp: { driver: "pi", config: { cli: join(home, "fake-acp.cjs") } } } }));
  writeFileSync(
    join(home, "fake-acp.cjs"),
    `#!${process.execPath}
const say = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
const waiting = new Map();
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (!msg.method) return waiting.get(msg.id)?.(msg.result);
  if (msg.id === undefined) return;
  const reply = (result) => say({ jsonrpc: "2.0", id: msg.id, result });
  if (msg.method === "initialize") return reply({ protocolVersion: 1, agentCapabilities: {} });
  if (msg.method === "session/new") return reply({ sessionId: "s1" });
  if (msg.method !== "session/prompt") return reply({});
  waiting.set(9000, () => reply({ stopReason: "end_turn" }));
  say({ jsonrpc: "2.0", id: 9000, method: "session/request_permission", params: {
    sessionId: "s1",
    toolCall: { toolCallId: "t1", title: "Edit notes.txt", kind: "edit" },
    options: [{ optionId: "allow", name: "Allow once", kind: "allow_once" }, { optionId: "reject", name: "Reject", kind: "reject_once" }],
  } });
});
`,
    { mode: 0o755 },
  );
  return home;
}

const ENGINES = {
  claude: { home: claudeHome, model: "claude-sonnet-5" },
  codex: { home: codexHome, model: "gpt-6.1-sol" },
  acp: { home: acpHome, model: "auto" },
};

async function fixture(t: TestContext, engine: keyof typeof ENGINES = "claude") {
  const home = ENGINES[engine].home();
  const h = await startHarness({ HOME: home });
  t.after(async () => {
    await h.stop();
    rmSync(home, { recursive: true, force: true });
  });
  const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Kat" }) });
  await h.fetch(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: engine, model: ENGINES[engine].model } }) });
  const messages = async () => (await h.json(`/api/bots/${bot.id}/messages?thread=${bot.threadId}&limit=100`)).messages as any[];
  const say = (text: string) => h.json(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text, taskId: bot.threadId }) });
  const card = async () => {
    const found = await waitFor(async () => (await messages()).find((m) => m.kind === "options" && m.card?.requestId && !m.card.answered));
    assert.ok(found, "no card appeared");
    return found;
  };
  const respond = (requestId: string, body: Record<string, unknown>) =>
    h.json(`/api/bots/${bot.id}/respond`, { method: "POST", body: JSON.stringify({ requestId, ...body }) });
  /** What the agent said after `word`, once it has: what the bridge told
   * it, for one. */
  const heard = async (word = "HEARD") => {
    const said = await waitFor(async () => (await messages()).find((m) => m.kind === "text" && m.role === "bot" && (m.text ?? "").startsWith(`${word} `)));
    assert.ok(said, "the turn went on waiting for an answer it had been given");
    return String(said.text).slice(word.length + 1);
  };
  const idle = () =>
    waitFor(async () => {
      const { bots } = await h.json("/api/bots?messages=0");
      return bots.find((b: any) => b.id === bot.id)?.busy ? null : true;
    });
  const closedNote = (m: any) => m.kind === "activity" && /already closed/.test(m.tool?.name ?? "");
  return { h, home, bot, messages, say, card, respond, heard, idle, closedNote };
}

test("a choice pressed on Claude Code's own question reaches it as the answer", async (t) => {
  const f = await fixture(t);
  await f.say("NATIVE-QUESTION about the stack");
  const asked = await f.card();
  assert.equal(asked.card.title, "Your agent has a question");
  assert.deepEqual(asked.card.options, ["Postgres", "SQLite"]);

  // what the app sends when a choice is pressed
  const sent = await f.respond(asked.card.requestId, { behavior: "answer", message: "SQLite" });
  assert.equal(sent.outcome, "delivered");

  // the CLI's own contract for a question: allowed, with the answers in
  // the tool's input, each against the question it answers
  const verdict = JSON.parse(await f.heard());
  assert.equal(verdict.behavior, "allow");
  assert.equal(verdict.updatedInput.answers["Which database?"], "SQLite");
  assert.equal(verdict.updatedInput.questions.length, 2, "the questions themselves were not handed back");
  // the card showed one question, so the other is not answered for the person
  assert.notEqual(verdict.updatedInput.answers["Which port?"], "SQLite");
  assert.match(verdict.updatedInput.answers["Which port?"], /not shown/i);

  assert.ok(await f.idle(), "the turn never ended");
  const settled = (await f.messages()).find((m) => m.id === asked.id);
  assert.equal(settled.card.answered, "answer");
  assert.ok(!settled.card.dismissed, "an answered question was hidden");
  assert.ok(!settled.card.closed);
  assert.equal((await f.messages()).some(f.closedNote), false, "a delivered answer was reported as a closed request");
});

test("a question put aside is told to the agent, and the turn goes on", async (t) => {
  const f = await fixture(t);
  await f.say("OWN-QUESTION before the release");
  const asked = await f.card();
  assert.deepEqual(asked.card.options, ["Today", "Friday"]);

  // what the app sends when the card's X is pressed
  const sent = await f.respond(asked.card.requestId, { behavior: "deny", message: "Dismissed by user." });
  assert.equal(sent.outcome, "delivered");
  assert.equal(await f.heard(), "Dismissed by user.");
  assert.ok(await f.idle(), "the turn never ended");
  assert.equal((await f.messages()).some(f.closedNote), false);
});

test("words typed on an approval refuse it, and the agent reads them", async (t) => {
  const f = await fixture(t);
  await f.say("RUN-COMMAND to tidy up");
  const asked = await f.card();
  assert.equal(asked.card.title, "Approval needed");

  // what the app sends for the card's own text field
  const sent = await f.respond(asked.card.requestId, { behavior: "answer", message: "Use trash instead" });
  assert.equal(sent.outcome, "delivered");
  assert.deepEqual(JSON.parse(await f.heard()), { behavior: "deny", message: "Use trash instead" });
  const settled = (await f.messages()).find((m) => m.id === asked.id);
  assert.equal(settled.card.answered, "deny", "the card reads as something other than refused");
});

test("a question the turn ended under stays on screen and says why, and the next message starts a turn", async (t) => {
  const f = await fixture(t);
  await f.say("ASK-THEN-LEAVE");
  const asked = await f.card();
  assert.ok(await f.idle(), "the turn never ended");
  const closed = await waitFor(async () => {
    const now = (await f.messages()).find((m) => m.id === asked.id);
    return now?.card.answered ? now : null;
  });
  assert.ok(closed, "the card was left open with nothing waiting on it");
  assert.ok(!closed.card.dismissed, "a question nobody answered vanished from the conversation");
  assert.match(closed.card.closed, /turn ended/);

  // pressing it now changes nothing, and says so beside the card
  const late = await f.respond(asked.card.requestId, { behavior: "answer", message: "Yes" });
  assert.equal(late.outcome, "unavailable");
  const after = await f.messages();
  assert.equal(after.find((m) => m.id === asked.id).card.closed, closed.card.closed);
  assert.equal(after.filter(f.closedNote).length, 1);

  // nothing is left waiting, so plain words are a new turn, not a queue
  const next = await f.say("carry on without it");
  assert.ok(!next.queued && !next.steered, "the message waited behind a turn that had ended");
  assert.ok(await waitFor(async () => (await f.messages()).find((m) => m.kind === "text" && m.text === "Done.")), "the next message never ran");
});

test("a closed card put aside in another of the agent's conversations stays put aside", async (t) => {
  // A closed card stays on screen now, so its X has to be able to put it
  // away wherever it is. Only the agent's first conversation was looked
  // in, and a card anywhere else came back on the next load.
  const f = await fixture(t);
  const made = await f.h.json(`/api/bots/${f.bot.id}/tasks`, { method: "POST", body: JSON.stringify({ title: "Elsewhere" }) });
  const lane = made.bot.tasks.find((task: any) => task.title === "Elsewhere").id;
  const there = async () => (await f.h.json(`/api/bots/${f.bot.id}/messages?thread=${lane}&limit=100`)).messages as any[];
  await f.h.json(`/api/bots/${f.bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: "ASK-THEN-LEAVE", taskId: lane }) });
  const closed = await waitFor(async () => (await there()).find((m) => m.kind === "options" && m.card?.closed));
  assert.ok(closed, "the card never closed");

  // what the app sends for the X on a card nothing waits on: no answer
  // to anything, only the card put away
  const put = await f.h.fetch(`/api/bots/${f.bot.id}/cards/${closed.id}`, { method: "PATCH", body: JSON.stringify({ dismissed: true, taskId: lane }) });
  assert.equal(put.status, 200);
  const after = await there();
  assert.equal(after.find((m) => m.id === closed.id).card.dismissed, true);
  assert.equal(after.some(f.closedNote), false);
});

test("an answer goes to the engine that asked, whatever the agent has been moved to since", async (t) => {
  // A live request belongs to its original turn even if preferences change.
  // Finished turns no longer retain a broker or background authority.
  const f = await fixture(t);
  await f.say("OWN-QUESTION");
  const asked = await f.card();
  await f.h.fetch(`/api/bots/${f.bot.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "spare", model: "claude-sonnet-5" } }) });

  const sent = await f.respond(asked.card.requestId, { behavior: "answer", message: "Keep" });
  assert.equal(sent.outcome, "delivered");
  assert.equal(await f.heard(), "Keep");
  assert.ok(await f.idle(), "the original turn never ended");
});

test("a finished Claude process cannot leave an answerable background question", async t => {
  const f = await fixture(t);
  await f.say("ASK-AFTERWARDS");
  assert.ok(await f.idle(), "the turn never ended");
  assert.equal((await f.messages()).some(m => m.card?.requestId && !m.card.answered), false);
  const next = await f.say("carry on without it");
  assert.ok(!next.queued && !next.steered);
  assert.ok(await f.idle());
});

test("a Codex question takes a choice, and takes being put aside", async (t) => {
  const f = await fixture(t, "codex");
  await f.say("QUESTION one");
  const first = await f.card();
  assert.deepEqual(first.card.options, ["Red", "Blue"]);
  assert.equal((await f.respond(first.card.requestId, { behavior: "answer", message: "Blue" })).outcome, "delivered");
  assert.equal(await f.heard("PICKED"), "Blue");
  assert.ok(await f.idle(), "the turn never ended");

  await f.say("QUESTION two");
  const second = await f.card();
  assert.equal((await f.respond(second.card.requestId, { behavior: "deny", message: "Dismissed by user." })).outcome, "delivered");
  assert.ok(
    await waitFor(async () => (await f.messages()).find((m) => m.kind === "text" && m.text === "PICKED Dismissed by user.")),
    "a question put aside left the turn waiting",
  );
  assert.equal((await f.messages()).some(f.closedNote), false);
});

test("a question its engine takes back stays on screen and says so, and the next message still reaches the turn", async (t) => {
  const f = await fixture(t, "codex");
  await f.say("WITHDRAWN");
  const asked = await f.card();
  const closed = await waitFor(async () => {
    const now = (await f.messages()).find((m) => m.id === asked.id);
    return now?.card.answered ? now : null;
  });
  assert.ok(closed, "the card stayed open after its engine closed the question");
  assert.ok(!closed.card.dismissed, "a question the engine closed vanished from the conversation");
  assert.equal(closed.card.closed, "Kat's engine closed this before it was answered. Nothing is waiting on it now.");

  // the turn is still running, and plain words go into it
  const next = await f.say("use blue");
  assert.equal(next.steered, true);
  assert.equal(await f.heard("TOLD"), "use blue");
  assert.ok(await f.idle(), "the turn never ended");
});

test("an approval that Stop closed is not put down as the person's refusal", async (t) => {
  // An ACP agent's ask said the person settled it however it ended, so a
  // stopped turn left a card reading as denied by them.
  const f = await fixture(t, "acp");
  await f.say("tidy the notes");
  const asked = await f.card();
  assert.equal(asked.card.title, "Approval needed");
  const stopped = await f.h.fetch(`/api/bots/${f.bot.id}/interrupt`, { method: "POST", body: JSON.stringify({ taskId: f.bot.threadId }) });
  assert.equal(stopped.status, 200);
  const closed = await waitFor(async () => {
    const now = (await f.messages()).find((m) => m.id === asked.id);
    return now?.card.answered ? now : null;
  });
  assert.ok(closed, "the card stayed open after its turn was stopped");
  assert.equal(closed.card.closed, "The turn ended before this was answered, so it was not done. Nothing is waiting on it now.");
  assert.notEqual(closed.card.answered, "deny");
});
