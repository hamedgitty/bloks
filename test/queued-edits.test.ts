// A message queued behind a running turn, changed before it goes
// (GitHub 155).
//
// The engine used to be handed a copy of the words taken when they were
// queued, so an edit made while they waited never reached it, and a
// message taken back went anyway. What goes now is what the transcript
// says when the burst goes. These hold that shut with a stand-in Claude
// CLI that keeps its first turn open and records exactly what each turn
// receives, along with the two things built on it: an open editor that
// holds the burst back until it saves or cancels (or is left too long),
// and Send now, which stops the running turn so the burst goes at once.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { startHarness, type Harness } from "./helpers/server.ts";

const waitFor = async <T,>(check: () => Promise<T | null | undefined | false> | T | null | undefined | false, ms = 15_000): Promise<T> => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const value = await check();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("condition did not become true");
};
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function setup(t: TestContext, env: Record<string, string> = {}) {
  const home = mkdtempSync(join(tmpdir(), "bloks-queued-edits-"));
  const cli = join(home, "fake-claude.mjs");
  const callsFile = join(home, "calls.json");
  const gate = join(home, "gate");
  let h: Harness | undefined;
  t.after(async () => {
    // a turn still held open lets go, so nothing outlives the test
    writeFileSync(gate, "");
    await h?.stop();
    rmSync(home, { recursive: true, force: true });
  });
  writeFileSync(cli, `#!${process.execPath}
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("2.1.289 (Claude Code)"); process.exit(0); }
if (args[0] === "auth") { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
const value = (flag) => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
let input = "";
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  const sessionId = value(args.includes("--resume") ? "--resume" : "--session-id");
  const text = JSON.parse(input.trim()).message.content;
  const calls = existsSync(${JSON.stringify(callsFile)}) ? JSON.parse(readFileSync(${JSON.stringify(callsFile)}, "utf8")) : [];
  calls.push(text);
  writeFileSync(${JSON.stringify(callsFile)} + ".tmp", JSON.stringify(calls)); renameSync(${JSON.stringify(callsFile)} + ".tmp", ${JSON.stringify(callsFile)});
  const n = calls.length;
  const out = (frame) => console.log(JSON.stringify(frame));
  out({ type: "system", subtype: "init", session_id: sessionId, model: "claude-sonnet-5" });
  const answer = () => {
    out({ type: "assistant", message: { content: [{ type: "text", text: "Answered " + n }] } });
    out({ type: "result", subtype: "success", is_error: false, num_turns: 1, duration_api_ms: 1, session_id: sessionId, result: "Answered " + n });
  };
  // A turn asked to hold stays open until the test opens the gate, the
  // way a long piece of work keeps a real one busy.
  if (!text.includes("HOLD")) return answer();
  const wait = setInterval(() => {
    if (!existsSync(${JSON.stringify(gate)})) return;
    clearInterval(wait);
    answer();
  }, 25);
});
`, { mode: 0o755 });
  mkdirSync(join(home, ".bloks"), { recursive: true });
  writeFileSync(join(home, ".bloks", "config.json"), JSON.stringify({
    instances: { claude: { driver: "claudeAgent", config: { cli, permissionMode: "bypassPermissions" } } },
  }));
  h = await startHarness({ HOME: home, ...env });
  const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Waiter" }) });
  const set = await h.fetch(`/api/bots/${bot.id}`, {
    method: "PATCH",
    body: JSON.stringify({ modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } }),
  });
  assert.equal(set.status, 200);
  const thread = bot.threadId as string;
  const hh = h;
  const s = {
    h: hh,
    bot,
    thread,
    /** What each turn the engine ran was given, in order. */
    calls: (): string[] => (existsSync(callsFile) ? JSON.parse(readFileSync(callsFile, "utf8")) : []),
    openGate: () => writeFileSync(gate, ""),
    say: (text: string) => hh.json(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text }) }),
    messages: async (): Promise<any[]> =>
      (await hh.json(`/api/bots/${bot.id}/messages?thread=${thread}&limit=500`)).messages,
    find: async (text: string): Promise<any> => (await s.messages()).find((m) => m.text === text),
    byId: async (id: string): Promise<any> => (await s.messages()).find((m) => m.id === id),
    busy: async () => Boolean((await hh.json("/api/bots?messages=0")).bots.find((b: any) => b.id === bot.id)?.busy),
    editing: (id: string, editing: boolean) =>
      hh.json(`/api/threads/${thread}/messages/${id}/editing`, { method: "POST", body: JSON.stringify({ editing }) }),
    edit: (id: string, text: string) =>
      hh.fetch(`/api/threads/${thread}/messages/${id}`, { method: "PATCH", body: JSON.stringify({ text }) }),
    /** Starts a turn that stays open until the gate opens. */
    async busyTurn(): Promise<void> {
      await s.say("HOLD this turn open");
      await waitFor(() => s.calls().length === 1);
    },
  };
  return s;
}

test("a queued message goes with the words it has when it goes, and not at all once taken back", async (t) => {
  const s = await setup(t);
  await s.busyTurn();
  for (const text of ["QA_QUEUE_EDIT_OLD", "QA_QUEUE_DELETE_OLD", "QA_QUEUE_KEEP"]) {
    assert.equal((await s.say(text)).queued, true, `${text} waits behind the turn`);
  }
  const edited = await s.find("QA_QUEUE_EDIT_OLD");
  const dropped = await s.find("QA_QUEUE_DELETE_OLD");
  const kept = await s.find("QA_QUEUE_KEEP");

  const patch = await s.edit(edited.id, "QA_QUEUE_EDIT_NEW");
  assert.equal(patch.status, 200);
  assert.equal((await s.byId(edited.id)).text, "QA_QUEUE_EDIT_NEW");
  const deletion = await s.h.fetch(`/api/threads/${s.thread}/messages/${dropped.id}`, { method: "DELETE" });
  assert.equal(deletion.status, 200);
  assert.equal((await s.byId(dropped.id)).deleted, true);

  s.openGate();
  await waitFor(() => s.calls().length >= 2);
  assert.equal(s.calls()[1], "QA_QUEUE_EDIT_NEW\nQA_QUEUE_KEEP", "the next turn was told something the chat does not say");

  // and the chat says that is what went, and when
  const went = await waitFor(async () => {
    const m = await s.byId(edited.id);
    return m && !m.queued ? m : null;
  });
  assert.equal(went.text, "QA_QUEUE_EDIT_NEW");
  assert.equal(typeof went.deliveredAt, "number");
  assert.equal((await s.byId(kept.id)).deliveredAt, went.deliveredAt, "one burst, one moment");
  // It entered the conversation then, not when it was written: after
  // what the agent said while it waited, the burst together and in the
  // order it was written, under the ids the edit and the deletion found
  // it by (GitHub 170). The one taken back never entered at all.
  const all = (await s.messages()).filter((m) => m.kind === "text");
  // from the turn it waited behind, past the agent's greeting
  const said = all.slice(all.findIndex((m) => m.text === "HOLD this turn open"));
  const entered = said.filter((m) => !m.deleted);
  assert.deepEqual(
    entered.slice(0, 4).map((m) => m.text),
    ["HOLD this turn open", "Answered 1", "QA_QUEUE_EDIT_NEW", "QA_QUEUE_KEEP"],
  );
  assert.equal(entered[2].id, edited.id);
  assert.equal(entered[3].id, kept.id);
  assert.ok(said.findIndex((m) => m.id === dropped.id) < said.findIndex((m) => m.text === "Answered 1"), "a message taken back was moved as if it went");
  const gone = await s.byId(dropped.id);
  assert.equal(gone.text, "");
  assert.equal(gone.deliveredAt, undefined, "a message taken back never went anywhere");
  await waitFor(async () => !(await s.busy()));
  assert.equal(s.calls().length, 2);
});

test("a burst that was all taken back starts no turn", async (t) => {
  const s = await setup(t);
  await s.busyTurn();
  await s.say("TAKEN_BACK_ONE");
  await s.say("TAKEN_BACK_TWO");
  for (const text of ["TAKEN_BACK_ONE", "TAKEN_BACK_TWO"]) {
    const m = await s.find(text);
    await s.h.fetch(`/api/threads/${s.thread}/messages/${m.id}`, { method: "DELETE" });
  }
  s.openGate();
  await waitFor(async () => !(await s.busy()));
  await pause(1_000);
  assert.equal(s.calls().length, 1, "a turn ran on words that were taken back");
  // and the lane is free for the next thing said to it
  await s.say("AFTERWARDS");
  await waitFor(() => s.calls().length === 2);
  assert.equal(s.calls()[1], "AFTERWARDS");
});

test("an open editor holds the queued burst whole until it saves, and the save is what goes", async (t) => {
  const s = await setup(t);
  await s.busyTurn();
  for (const text of ["FIRST_WAITING", "SECOND_WAITING_OLD", "THIRD_WAITING"]) await s.say(text);
  const second = await s.find("SECOND_WAITING_OLD");

  // only a message that is waiting can hold anything back
  const sent = await s.find("HOLD this turn open");
  assert.deepEqual(await s.editing(sent.id, true), { holding: false });
  assert.deepEqual(await s.editing(second.id, true), { holding: true });

  // the turn ends, and nothing follows it while the editor is open
  s.openGate();
  await waitFor(async () => !(await s.busy()));
  await pause(1_000);
  assert.equal(s.calls().length, 1, "the burst went while one of its messages was open in the editor");
  const waiting = (await s.messages()).filter((m) => m.queued).map((m) => m.text);
  assert.deepEqual(waiting, ["FIRST_WAITING", "SECOND_WAITING_OLD", "THIRD_WAITING"], "all of it waits, not only the one being edited");
  // something said now, with no turn running, still goes after them
  assert.equal((await s.say("SAID_WHILE_EDITING")).queued, true, "a later message overtook the held burst");
  await pause(500);
  assert.equal(s.calls().length, 1);

  // the save closes the editor, and the burst goes with it, in order
  assert.equal((await s.edit(second.id, "SECOND_WAITING_NEW")).status, 200);
  await waitFor(() => s.calls().length >= 2);
  assert.equal(s.calls()[1], "FIRST_WAITING\nSECOND_WAITING_NEW\nTHIRD_WAITING\nSAID_WHILE_EDITING");
  // and the chat reads the same way: the turn's answer, then all four
  const texts = await waitFor(async () => {
    const list = await s.messages();
    return list.some((m) => m.queued) ? null : list.filter((m) => m.kind === "text").map((m) => m.text);
  });
  assert.deepEqual(texts.slice(texts.indexOf("HOLD this turn open")).slice(0, 6), [
    "HOLD this turn open",
    "Answered 1",
    "FIRST_WAITING",
    "SECOND_WAITING_NEW",
    "THIRD_WAITING",
    "SAID_WHILE_EDITING",
  ]);
});

test("a held burst goes as it was when the editor is cancelled", async (t) => {
  const s = await setup(t);
  await s.busyTurn();
  await s.say("CANCELLED_EDIT");
  const m = await s.find("CANCELLED_EDIT");
  assert.deepEqual(await s.editing(m.id, true), { holding: true });
  s.openGate();
  await waitFor(async () => !(await s.busy()));
  await pause(800);
  assert.equal(s.calls().length, 1);
  assert.deepEqual(await s.editing(m.id, false), { holding: false });
  await waitFor(() => s.calls().length >= 2);
  assert.equal(s.calls()[1], "CANCELLED_EDIT");
});

test("an editor left open too long lets the burst go anyway", async (t) => {
  const s = await setup(t, { BLOKS_EDIT_HOLD_MS: "1500" });
  await s.busyTurn();
  await s.say("LEFT_OPEN");
  const m = await s.find("LEFT_OPEN");
  const opened = Date.now();
  assert.deepEqual(await s.editing(m.id, true), { holding: true });
  s.openGate();
  await waitFor(() => s.calls().length >= 2);
  assert.equal(s.calls()[1], "LEFT_OPEN");
  const went = await waitFor(async () => {
    const after = await s.byId(m.id);
    return after?.deliveredAt ? after : null;
  });
  assert.ok(went.deliveredAt - opened >= 1_500, `it went ${went.deliveredAt - opened}ms after the editor opened, before the hold ran out`);
});

test("Send now stops the running turn, and everything queued goes together in the next", async (t) => {
  const s = await setup(t);
  await s.busyTurn();
  await s.say("CHANGE_OF_PLAN");
  await s.say("AND_THIS_TOO");
  // what the queued bubble's Send now sends: the same stop Cmd+Enter makes
  const stopped = await s.h.fetch(`/api/bots/${s.bot.id}/interrupt`, { method: "POST" });
  assert.equal(stopped.status, 200);
  await waitFor(() => s.calls().length >= 2);
  assert.equal(s.calls()[1], "CHANGE_OF_PLAN\nAND_THIS_TOO");
  const said = await waitFor(async () => {
    const list = await s.messages();
    return list.some((m) => m.role === "bot" && m.text === "Answered 2") ? list : null;
  });
  assert.ok(!said.some((m) => m.role === "bot" && m.text === "Answered 1"), "the stopped turn finished after all");
  assert.equal(said.filter((m) => m.queued).length, 0);
});
