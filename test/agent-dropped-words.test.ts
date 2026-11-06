// Words an agent left waiting for another, dropped before they were read,
// are told to the conversation that sent them, once, in one line on its
// next turn there, and nothing starts a turn just to say it. The sender's
// own record row says why: taken back, deleted by the person, not sent,
// or the conversation they waited in was closed.
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHarness } from "./helpers/server.ts";

const TOLD = "words you left waiting for another agent were dropped before it read them";

async function waitFor<T>(check: () => T | false | undefined | Promise<T | false | undefined>, ms = 20_000): Promise<T> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const result = await check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error("fixture condition did not become true");
}

// A stand-in for Claude Code. HOLD <marker> keeps its turn open until the
// test releases it; anything else is answered at once. Every turn's words
// are kept, with the conversation it ran in, so the test reads what each
// turn was told.
async function fixture(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), "bloks-dropped-words-"));
  const cli = join(home, "engine.mjs");
  const heardFile = join(home, "heard.jsonl");
  mkdirSync(join(home, ".bloks"));
  writeFileSync(cli, `#!${process.execPath}
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("2.1.299 (Claude Code)"); process.exit(0); }
if (args[0] === "auth") { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
const out = (frame) => console.log(JSON.stringify(frame));
let first = true, who;
const input = createInterface({ input: process.stdin });
input.on("line", async (line) => {
  const frame = JSON.parse(line);
  if (frame.type !== "user") return;
  const text = String(frame.message.content);
  if (first) {
    first = false;
    out({ type: "system", subtype: "init", session_id: "fixture-" + Math.random(), model: "claude-sonnet-5" });
    const res = await fetch(process.env.BLOKS_URL + "/api/agent/whoami", { headers: { authorization: "Bearer " + process.env.BLOKS_TOKEN } });
    who = await res.json();
  }
  appendFileSync(${JSON.stringify(heardFile)}, JSON.stringify({ text, who, token: process.env.BLOKS_TOKEN }) + "\\n");
  const done = () => {
    out({ type: "assistant", message: { content: [{ type: "text", text: "Done." }] } });
    out({ type: "result", subtype: "success", is_error: false, num_turns: 1, duration_api_ms: 1, result: "Done." });
    setTimeout(() => process.exit(0), 30);
  };
  const held = text.match(/HOLD ([A-Za-z0-9]+)/);
  if (held) {
    out({ type: "result", subtype: "success", is_error: false, num_turns: 0, duration_api_ms: 0, result: "" });
    writeFileSync(${JSON.stringify(home)} + "/ready-" + held[1], "");
    const timer = setInterval(() => {
      if (!existsSync(${JSON.stringify(home)} + "/release-" + held[1])) return;
      clearInterval(timer); done();
    }, 20);
  } else done();
});
`, { mode: 0o755 });
  writeFileSync(join(home, ".bloks", "config.json"), JSON.stringify({
    instances: { claude: { driver: "claudeAgent", config: { cli, permissionMode: "bypassPermissions" } } },
  }));
  const h = await startHarness({ HOME: home });
  t.after(async () => { await h.stop(); rmSync(home, { recursive: true, force: true }); });
  const heard = (): any[] => existsSync(heardFile) ? readFileSync(heardFile, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  const make = async (name: string) => {
    const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name }) });
    await h.json(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } }) });
    return bot;
  };
  const lane = async (bot: any, title: string) =>
    (await h.json(`/api/bots/${bot.id}/tasks`, { method: "POST", body: JSON.stringify({ title }) })).bot.tasks.find((x: any) => x.title === title).id as string;
  const messages = async (id: string, laneId: string): Promise<any[]> => (await h.json(`/api/bots/${id}/messages?thread=${laneId}&limit=500`)).messages;
  const busy = async (id: string) => (await h.json("/api/bots?messages=0")).bots.find((b: any) => b.id === id)?.busy;
  const hold = async (bot: any, marker: string, laneId = bot.threadId) => {
    await h.json(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ taskId: laneId, text: `HOLD ${marker}` }) });
    await waitFor(() => existsSync(join(home, "ready-" + marker)));
    return (await waitFor(() => heard().find((m) => m.text.includes(`HOLD ${marker}`)))).token as string;
  };
  const as = async (token: string, path: string, body?: unknown) => {
    const res = await h.fetch(path, { method: "POST", headers: { authorization: "Bearer " + token }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, body: await res.json() };
  };
  const release = (marker: string) => writeFileSync(join(home, "release-" + marker), "");
  // The person writes in a conversation, and the turn that answers is read back.
  const next = async (bot: any, laneId: string, words: string) => {
    await h.json(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ taskId: laneId, text: words }) });
    const turn = await waitFor(() => heard().find((m) => m.text.includes(words)));
    await waitFor(async () => !(await busy(bot.id)));
    return turn.text as string;
  };
  const record = async (bot: any, laneId: string, text: string) => (await messages(bot.id, laneId)).find((m) => m.agent?.dir === "out" && m.text === text);
  return { h, home, heard, make, lane, messages, busy, hold, as, release, next, record };
}

test("words taken back from another conversation are told once to the one that sent them, with no turn of their own", async (t) => {
  const f = await fixture(t);
  const a = await f.make("Agent A"), b = await f.make("Agent B");
  const aSecond = await f.lane(a, "Second");
  const fromMain = await f.hold(a, "AMain");
  const fromSecond = await f.hold(a, "ASecond", aSecond);
  await f.hold(b, "BBusy");
  assert.equal((await f.as(fromMain, `/api/bots/${b.id}/messages`, { text: "WORDS FROM THE FIRST" })).body.queued, true);
  assert.equal((await f.as(fromSecond, `/api/bots/${b.id}/messages`, { text: "WORDS FROM THE SECOND" })).body.queued, true);
  // the second conversation takes back both: its own, and the first's
  const taken = await f.as(fromSecond, `/api/bots/${b.id}/take-back`);
  assert.equal(taken.status, 200, JSON.stringify(taken.body));
  assert.equal(taken.body.takenBack.length, 2);

  const first = await f.record(a, a.threadId, "WORDS FROM THE FIRST");
  assert.equal(first.agent.status, "failed");
  assert.deepEqual(first.agent.dropped, { why: "taken-back" });
  // the conversation that took them back has its answer already
  assert.deepEqual((await f.record(a, aSecond, "WORDS FROM THE SECOND")).agent.dropped, { why: "taken-back", told: true });

  f.release("AMain"); f.release("ASecond"); f.release("BBusy");
  await waitFor(async () => !(await f.busy(a.id)) && !(await f.busy(b.id)));
  // nothing started a turn to say it
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(f.heard().filter((m) => m.who.botId === a.id).length, 2);

  const told = await f.next(a, a.threadId, "THE NEXT THING");
  assert.ok(told.includes(TOLD), told);
  assert.ok(told.includes(`to Agent B, "WORDS FROM THE FIRST" (taken back from another of your conversations)`), told);
  assert.ok(!told.includes("WORDS FROM THE SECOND"), "a word its own conversation took back was told to another");
  assert.equal((await f.record(a, a.threadId, "WORDS FROM THE FIRST")).agent.dropped.told, true);
  // once
  assert.ok(!(await f.next(a, a.threadId, "AND AFTER THAT")).includes(TOLD));
  // and the conversation that took them back is not told again
  assert.ok(!(await f.next(a, aSecond, "IN THE SECOND")).includes(TOLD));
});

test("words deleted by the person, never sent, or in a conversation since closed each say so", async (t) => {
  const f = await fixture(t);
  const a = await f.make("Agent A"), b = await f.make("Agent B"), c = await f.make("Agent C");
  const sender = await f.hold(a, "Sender");

  // deleted by the person while they waited
  await f.hold(b, "BFirst");
  await f.as(sender, `/api/bots/${b.id}/messages`, { text: "WORDS THE PERSON DELETES" });
  const waiting = (await f.messages(b.id, b.threadId)).find((m) => m.text === "WORDS THE PERSON DELETES");
  const deleted = await f.h.fetch(`/api/threads/${b.threadId}/messages/${waiting.id}`, { method: "DELETE" });
  assert.equal(deleted.status, 200, JSON.stringify({ body: await deleted.json(), waiting }));
  assert.deepEqual((await f.record(a, a.threadId, "WORDS THE PERSON DELETES")).agent.dropped, { why: "removed" });

  // in a conversation closed while they waited: one A opened, held back by
  // the person's editor once its turn ended, then closed
  const opened = await f.as(sender, "/api/agent/conversations", { to: b.id, title: "Side work", text: "HOLD BSide" });
  assert.equal(opened.status, 201, JSON.stringify(opened.body));
  await waitFor(() => existsSync(join(f.home, "ready-BSide")));
  const side: string = opened.body.taskId;
  assert.equal((await f.as(sender, `/api/bots/${b.id}/messages`, { text: "WORDS IN A CLOSED TAB", taskId: side })).body.queued, true);
  const inSide = (await f.messages(b.id, side)).find((m) => m.text === "WORDS IN A CLOSED TAB");
  assert.equal((await f.h.fetch(`/api/threads/${side}/messages/${inSide.id}/editing`, { method: "POST", body: JSON.stringify({ editing: true }) })).status, 200);
  f.release("BSide");
  // the turn has ended, and the words still wait behind the editor
  const closing = await waitFor(async () => {
    const res = await f.h.fetch(`/api/bots/${b.id}/tasks/${side}`, { method: "DELETE" });
    return res.status === 409 ? undefined : res;
  });
  assert.equal(closing.status, 200, JSON.stringify(await closing.json()));
  assert.deepEqual((await f.record(a, a.threadId, "WORDS IN A CLOSED TAB")).agent.dropped, { why: "closed" });

  // never sent: the recipient was archived before its turn took them
  await f.hold(c, "CBusy");
  assert.equal((await f.as(sender, `/api/bots/${c.id}/messages`, { text: "WORDS FOR AN ARCHIVED AGENT" })).body.queued, true);
  assert.equal((await f.h.fetch(`/api/bots/${c.id}`, { method: "DELETE" })).status, 200);
  f.release("CBusy");
  const unsent = await waitFor(async () => {
    const row = await f.record(a, a.threadId, "WORDS FOR AN ARCHIVED AGENT");
    return row?.agent.status === "failed" ? row : undefined;
  });
  assert.deepEqual(unsent.agent.dropped, { why: "not-sent" });

  f.release("Sender"); f.release("BFirst");
  await waitFor(async () => !(await f.busy(a.id)) && !(await f.busy(b.id)));
  const told = await f.next(a, a.threadId, "WHAT NOW");
  // one line, every one of them, each with its reason
  const line = told.split("\n").find((l) => l.includes(TOLD));
  assert.ok(line, told);
  assert.ok(line.includes(`to Agent B, "WORDS THE PERSON DELETES" (deleted by the person)`), line);
  assert.ok(line.includes(`to Agent B, "WORDS IN A CLOSED TAB" (the conversation they waited in was closed)`), line);
  assert.ok(line.includes(`to Agent C, "WORDS FOR AN ARCHIVED AGENT" (not sent)`), line);
  assert.ok(!(await f.next(a, a.threadId, "AND THEN")).includes(TOLD));
});
