// Recall before a turn: the person's own message in one of an agent's
// conversations is preceded, in the turn's words and never the system
// prompt, by what the agent said elsewhere that matches, when it matches
// well enough. The message keeps the notes it was given; nothing is given
// twice, a switch on the agent or the workspace turns it off, and a room,
// a routine or another agent's reading of the chat gets none of it.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { startHarness, type Harness } from "./helpers/server.ts";
import { agentOn, fakeProvider, idle, messagesOf, waitFor } from "./helpers/turns.ts";

const MARK = "From your other conversations, in case it helps";
const QUESTION = "Which sticker vendor did we pick for the launch again?";

/** A conversation written straight to disk while the server is down:
 * forty days of standups nobody will look for, then the decision. */
function seedLaunch(home: string, threadId: string) {
  const day = 24 * 60 * 60 * 1000;
  const messages: object[] = [];
  for (let i = 0; i < 40; i++) {
    const at = Date.now() - (60 - i) * day;
    messages.push({ id: `standup-${i}`, at, role: "user", kind: "text", text: `Standup ${i}: the printer queue is fine and lunch is at noon.` });
    messages.push({ id: `standup-${i}-reply`, at: at + 1000, role: "bot", kind: "text", text: `Thanks, noted for standup ${i}.` });
  }
  messages.push({ id: "decided", at: Date.now() - 3 * day, role: "user", kind: "text", text: "For the launch we picked Sticker Mule as the sticker vendor, with delivery on Friday." });
  messages.push({ id: "decided-reply", at: Date.now() - 3 * day + 1000, role: "bot", kind: "text", text: "Got it: Sticker Mule prints the launch stickers, delivered Friday." });
  writeFileSync(join(home, ".bloks", `messages-${threadId}.json`), JSON.stringify(messages));
}

/** The turn the engine was handed for each call after `from`. */
const turnsSince = (calls: string[], from: number) =>
  calls.slice(from).map((body) => {
    const messages = JSON.parse(body).messages as Array<{ role: string; content: string }>;
    return { system: messages[0]?.role === "system" ? messages[0].content : "", text: messages[messages.length - 1].content, body };
  });

test("the person's turn is told what was said elsewhere, in its words, once, and only when it fits", async (t) => {
  const engine = await fakeProvider(t);
  engine.state.answerAtOnce = true;
  const home = mkdtempSync(join(tmpdir(), "bloks-recall-ahead-"));
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }));

  let h: Harness = await startHarness({ HOME: home });
  const bot = await agentOn(h, engine.port, "Scout");
  const { bot: withLane } = await h.json(`/api/bots/${bot.id}/tasks`, { method: "POST", body: JSON.stringify({ title: "Launch plan" }) });
  const launch = withLane.tasks.find((task: any) => task.title === "Launch plan");
  await h.fetch(`/api/bots/${bot.id}/tasks/${bot.threadId}/activate`, { method: "POST" });
  await h.stop();
  seedLaunch(home, launch.id);
  const topics = join(home, ".bloks", "workspaces", bot.id, "memory");
  mkdirSync(topics, { recursive: true });
  writeFileSync(join(topics, "vendors.md"), "## Vendors\n- Sticker Mule: launch stickers, net 30 invoices.\n");

  h = await startHarness({ HOME: home });
  t.after(() => h.stop());
  const ask = async (text: string) => {
    const from = engine.state.calls.length;
    await h.fetch(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text, taskId: bot.threadId }) });
    assert.ok(await idle(h, bot));
    const turns = turnsSince(engine.state.calls, from);
    assert.equal(turns.length, 1, "one turn, one call");
    const said = (await messagesOf(h, bot)).filter((m) => m.role === "user" && m.text === text).pop();
    return { ...turns[0], said };
  };

  // either switch off, nothing is looked for
  await h.fetch(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ recallBeforeTurn: false }) });
  let turn = await ask(QUESTION);
  assert.ok(!turn.text.includes(MARK), "recall ran for an agent that has it off");
  assert.equal(turn.said.recalled, undefined);
  await h.fetch(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ recallBeforeTurn: true }) });
  const off = await h.json("/api/config", { method: "PUT", body: JSON.stringify({ recall: { beforeTurn: false } }) });
  assert.equal(off.recall.beforeTurn, false);
  turn = await ask(QUESTION);
  assert.ok(!turn.text.includes(MARK), "recall ran with the workspace switch off");
  await h.json("/api/config", { method: "PUT", body: JSON.stringify({ recall: { beforeTurn: true } }) });

  // both on: the decision, in the turn's words ahead of the question
  turn = await ask(QUESTION);
  assert.ok(turn.text.includes(MARK), `nothing was recalled: ${turn.text}`);
  assert.ok(turn.text.endsWith(QUESTION), "the person's words come last");
  assert.match(turn.text, /your conversation "Launch plan", Hamed|your conversation "Launch plan", the person/);
  assert.match(turn.text, /Sticker Mule as the sticker vendor/);
  assert.match(turn.text, /ignore the rest/);
  assert.ok(!turn.system.includes(MARK) && !turn.system.includes("Sticker Mule as the sticker vendor"), "recall reached the system prompt");
  const block = turn.text.slice(0, turn.text.indexOf(QUESTION));
  assert.ok(block.length < 2_200, `the notes ran to ${block.length} characters`);
  assert.ok(!/Standup \d+/.test(block), "a standup that only shares a word was recalled");

  // and the message keeps what it was given, and where it came from
  const notes = turn.said.recalled as any[];
  assert.ok(notes.length >= 1 && notes.length <= 3, JSON.stringify(notes));
  const decided = notes.find((note) => note.messageId === "decided");
  assert.deepEqual(
    { kind: decided.kind, threadId: decided.threadId, where: decided.where, who: decided.who },
    { kind: "conversation", threadId: launch.id, where: "Launch plan", who: "You" },
  );
  assert.match(decided.text, /Sticker Mule/);
  assert.ok(notes.every((note) => note.memory !== "MEMORY.md"), "MEMORY.md is already in the prompt");

  // asked again, nothing it was just given comes back
  turn = await ask(QUESTION);
  for (const note of notes) assert.ok(!turn.text.includes(note.text), `given twice: ${note.text}`);

  // a message that only shares a common word gets nothing
  turn = await ask("What time is lunch today?");
  assert.ok(!turn.text.includes(MARK), "a weak match was recalled");

  // a room's turn and a routine's are not the person's own turn here
  const echo = await agentOn(h, engine.port, "Echo");
  const { blok: room } = await h.json("/api/bloks", { method: "POST", body: JSON.stringify({ name: "Ops", memberIds: [bot.id, echo.id] }) });
  let from = engine.state.calls.length;
  await h.fetch(`/api/bloks/${room.id}/messages`, { method: "POST", body: JSON.stringify({ text: "Who prints the launch stickers, which vendor did we pick?" }) });
  assert.ok(await waitFor(() => engine.state.calls.length > from));
  assert.ok(await idle(h, bot));
  assert.ok(!engine.state.calls.slice(from).some((body) => body.includes(MARK)), "a room's turn was given recall");

  const { routine } = await h.json("/api/routines", {
    method: "POST",
    body: JSON.stringify({ targetId: bot.id, targetKind: "agent", prompt: "Weekly: which sticker vendor prints the launch stickers?", time: "03:00", days: [] }),
  });
  from = engine.state.calls.length;
  assert.equal((await h.fetch(`/api/routines/${routine.id}/run`, { method: "POST" })).status, 202);
  assert.ok(await waitFor(() => engine.state.calls.length > from));
  assert.ok(await idle(h, bot));
  assert.ok(!engine.state.calls.slice(from).some((body) => body.includes(MARK)), "a routine's turn was given recall");
});

test("on Claude Code the notes ride in the message, and another agent never sees them", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "bloks-recall-ahead-claude-"));
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }));
  const cli = join(home, "fake-claude.mjs");
  const calls = join(home, "calls.json");
  const answers = join(home, "answers.json");
  // Every turn's message and system prompt are written down; told CALLS
  // <base64 json>, it makes each request with its turn's credential.
  writeFileSync(
    cli,
    `#!${process.execPath}
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("9.9.9 (Claude Code)"); process.exit(0); }
if (args[0] === "auth") { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
const value = (flag) => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
let input = "";
((go) => { let line = ""; const take = (c) => { line += c; while (line.includes(String.fromCharCode(10))) { const at = line.indexOf(String.fromCharCode(10)); const next = line.slice(0, at); line = line.slice(at + 1); if (!next.trim() || JSON.parse(next).type !== "user") continue; input = next; process.stdin.off("data", take); go(); return; } }; process.stdin.on("data", take); })(async () => {
  const text = JSON.parse(input).message.content;
  const said = typeof text === "string" ? text : text.map((part) => part.text ?? "").join("");
  const system = value("--append-system-prompt-file") ? readFileSync(value("--append-system-prompt-file"), "utf8") : "";
  const seen = existsSync(${JSON.stringify(calls)}) ? JSON.parse(readFileSync(${JSON.stringify(calls)}, "utf8")) : [];
  seen.push({ text: said, system });
  writeFileSync(${JSON.stringify(calls)} + ".tmp", JSON.stringify(seen)); renameSync(${JSON.stringify(calls)} + ".tmp", ${JSON.stringify(calls)});
  const asked = said.match(/CALLS ([A-Za-z0-9+\\/=]+)/);
  if (asked) {
    const out = [];
    for (const [method, path] of JSON.parse(Buffer.from(asked[1], "base64").toString("utf8"))) {
      const res = await fetch(process.env.BLOKS_URL + path, { method, headers: { authorization: "Bearer " + process.env.BLOKS_TOKEN } });
      out.push({ status: res.status, body: await res.json().catch(() => null) });
    }
    writeFileSync(${JSON.stringify(answers)} + ".tmp", JSON.stringify(out)); renameSync(${JSON.stringify(answers)} + ".tmp", ${JSON.stringify(answers)});
  }
  const session = "s-" + Math.random().toString(36).slice(2);
  console.log(JSON.stringify({ type: "system", subtype: "init", session_id: session, model: "claude-sonnet-5" }));
  console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Done." }] } }));
  console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 1, duration_api_ms: 1, session_id: session, result: "Done." }));
});
`,
    { mode: 0o755 },
  );
  mkdirSync(join(home, ".bloks"), { recursive: true });
  writeFileSync(join(home, ".bloks", "config.json"), JSON.stringify({ instances: { claude: { driver: "claudeAgent", config: { cli } } } }));
  const claude = { modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } };

  let h: Harness = await startHarness({ HOME: home });
  const make = async (name: string) => {
    const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name }) });
    await h.fetch(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify(claude) });
    return bot as { id: string; threadId: string };
  };
  const scout = await make("Scout");
  const peer = await make("Peer");
  const { bot: withLane } = await h.json(`/api/bots/${scout.id}/tasks`, { method: "POST", body: JSON.stringify({ title: "Launch plan" }) });
  const launch = withLane.tasks.find((task: any) => task.title === "Launch plan");
  await h.fetch(`/api/bots/${scout.id}/tasks/${scout.threadId}/activate`, { method: "POST" });
  await h.stop();
  seedLaunch(home, launch.id);

  h = await startHarness({ HOME: home });
  t.after(() => h.stop());
  const seen = () => (existsSync(calls) ? (JSON.parse(readFileSync(calls, "utf8")) as Array<{ text: string; system: string }>) : []);
  const before = seen().length;
  await h.fetch(`/api/bots/${scout.id}/messages`, { method: "POST", body: JSON.stringify({ text: QUESTION, taskId: scout.threadId }) });
  assert.ok(await waitFor(() => seen().length > before), "the turn never ran");
  assert.ok(await idle(h, scout));
  const turn = seen()[before];
  assert.ok(turn.text.includes(MARK) && turn.text.includes("Sticker Mule"), `nothing was recalled: ${turn.text}`);
  assert.ok(!turn.system.includes(MARK) && !turn.system.includes("Sticker Mule"), "recall reached the standing prompt");
  const mine = (await messagesOf(h, scout)).find((m) => m.text === QUESTION);
  assert.ok(mine.recalled?.length, "the person's message does not say what was recalled");

  // another agent reading the roster sees Scout's chat, not its notes
  rmSync(answers, { force: true });
  await h.fetch(`/api/bots/${peer.id}/messages`, { method: "POST", body: JSON.stringify({ text: `CALLS ${Buffer.from(JSON.stringify([["GET", "/api/bots"]])).toString("base64")}` }) });
  assert.ok(await waitFor(() => existsSync(answers)), "the peer's turn never ran");
  const [roster] = JSON.parse(readFileSync(answers, "utf8"));
  assert.equal(roster.status, 200);
  const theirs = roster.body.bots.find((b: any) => b.id === scout.id).messages.find((m: any) => m.text === QUESTION);
  assert.ok(theirs, "the peer could not read the message at all");
  assert.equal(theirs.recalled, undefined, "another agent read what recall brought from Scout's other conversations");
  // and the person still can
  const { bots } = await h.json("/api/bots");
  assert.ok(bots.find((b: any) => b.id === scout.id).messages.find((m: any) => m.text === QUESTION).recalled?.length);
});
