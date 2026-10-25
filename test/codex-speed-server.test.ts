// Codex speed through the server: where the choice is kept, which turns
// take it, and what a Fast turn that cannot be had does to recovery.
//
// The fake Codex here never mentions serviceTier unless a test says so,
// the way a Codex older than the field behaves. Standard has to work
// against it unchanged; Fast has to be refused by it, unsent.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { codexCommands, waitFor } from "./helpers/codex-commands.ts";

type Fixture = Awaited<ReturnType<typeof codexCommands>>;

const setWorkspace = (s: Fixture, speed: unknown) =>
  s.h.json("/api/config", { method: "PATCH", body: JSON.stringify({ codex: { speed } }) });

const patchBot = (s: Fixture, id: string, body: unknown) =>
  s.h.json(`/api/bots/${id}`, { method: "PATCH", body: JSON.stringify(body) });

/** Every thread/start and thread/resume, in order. */
const opens = (s: Fixture) => s.calls().filter((c) => c.method === "thread/start" || c.method === "thread/resume");

const lastTier = (s: Fixture) => opens(s).at(-1)?.params.serviceTier;

const lane = async (s: Fixture) => (await s.current()).tasks.find((task: any) => task.id === s.bot.threadId);

const transcript = async (s: Fixture) => (await s.messages()).map((m) => m.text ?? "").join("\n");

test("Standard works against a Codex that never mentions the tier", async (t) => {
  const s = await codexCommands(t);
  assert.equal((await s.h.json("/api/config")).codex.speed, "standard");

  await s.turn("first, a fresh thread");
  await s.turn("then a resumed one");
  await patchBot(s, s.bot.id, { codexSpeed: "standard" });
  await s.turn("and by the agent's own choice");

  const [fresh, resumed, own] = opens(s);
  assert.equal(fresh.method, "thread/start");
  assert.equal(resumed.method, "thread/resume");
  assert.equal(own.method, "thread/resume");
  for (const open of opens(s)) assert.equal("serviceTier" in open.params, false, "Standard says nothing about the tier");
  assert.equal(s.count("turn/start"), 3);
  assert.match(await transcript(s), /ANSWER/);
  assert.doesNotMatch(await transcript(s), /not sent/);
});

test("the workspace default and an agent's own choice are kept, and agents follow the workspace live", async (t) => {
  const s = await codexCommands(t);
  s.spec({ tier: "echo" });

  await s.turn("initial");
  assert.equal(lastTier(s), undefined);

  await setWorkspace(s, "fast");
  await s.turn("following the workspace to Fast");
  assert.equal(lastTier(s), "priority");

  await patchBot(s, s.bot.id, { codexSpeed: "standard" });
  await s.turn("its own Standard");
  assert.equal(lastTier(s), undefined);

  await s.reboot();
  assert.equal((await s.current()).codexSpeed, "standard");
  assert.equal((await s.h.json("/api/config")).codex.speed, "fast");
  await s.turn("after a restart");
  assert.equal(lastTier(s), undefined);

  await patchBot(s, s.bot.id, { codexSpeed: null });
  await s.turn("cleared, back to the workspace");
  assert.equal(lastTier(s), "priority");
  assert.equal(s.stored().codexSpeed, null);

  const peer = await s.hire("Peer");
  assert.equal(peer.codexSpeed ?? null, null);
  await s.post(`/api/bots/${peer.id}/messages`, { text: "a new agent" });
  await s.called("turn/start", 6);
  assert.equal(lastTier(s), "priority");
});

test("queued work takes the speed when it starts, and a steer carries none", async (t) => {
  const s = await codexCommands(t);
  s.spec({ tier: "echo" });
  await s.say("HOLD first");
  await s.called("turn/start", 1);

  await setWorkspace(s, "fast");
  await s.say("steer the running turn");
  await s.called("turn/steer", 1);
  await s.say("queued behind it", { steer: false });
  assert.equal(opens(s).length, 1);
  assert.equal("serviceTier" in opens(s)[0].params, false, "the running turn keeps the speed it started with");

  s.gate();
  await s.called("turn/start", 2);
  await s.settled();
  assert.equal(opens(s)[1].params.serviceTier, "priority");
  for (const steer of s.calls().filter((c) => c.method === "turn/steer")) assert.equal("serviceTier" in steer.params, false);
});

for (const [name, change] of [
  ["never mentions the tier", {}],
  ["says no tier", { tier: null }],
  ["says another tier", { tier: "default" }],
  ["rejects the field", { rejectTier: true }],
] as const) {
  test(`Fast on a Codex that ${name} is not sent, not retried, and rests nothing`, async (t) => {
    const s = await codexCommands(t);
    await s.turn("warm");
    const cursor = s.stored().tasks[0].resumeCursors.codex;
    // a backup on the same Codex, which cannot run Fast either
    await patchBot(s, s.bot.id, { backupSelection: { instanceId: "other", model: "gpt-6.1-sol" }, codexSpeed: "fast" });
    s.spec(change);

    await s.say("refused");
    // the primary resumes and is refused; the backup opens and is refused
    await s.called("thread/start", 2);
    await waitFor(async () => (await s.messages()).filter((m) => /not sent/.test(m.text ?? "")).length >= 1);
    await s.settled();

    assert.equal(s.count("thread/resume"), 1);
    assert.equal(s.count("turn/start"), 1, "no words reached the model after warm-up");
    assert.equal(lastTier(s), "priority");
    assert.equal(s.stored().tasks[0].resumeCursors.codex, cursor, "the session is kept for the next turn");
    const said = await transcript(s);
    assert.doesNotMatch(said, /Trying again in a minute|new session, with the conversation/);
    assert.doesNotMatch(said, /is out of usage|is overloaded|is out of credit/);

    // nothing rests: another agent's Standard turn on the same engine goes ahead
    const peer = await s.hire("Peer");
    await s.post(`/api/bots/${peer.id}/messages`, { text: "Standard, after the refusal" });
    await s.called("turn/start", 2);
  });
}

test("a Fast refusal hands over once to a backup Codex that can run Fast, then returns", async (t) => {
  const s = await codexCommands(t, { BLOKS_BACKUP_STAY_MS: "20" });
  await s.turn("warm the primary");
  await patchBot(s, s.bot.id, { backupSelection: { instanceId: "other", model: "gpt-6.1-sol" }, codexSpeed: "fast" });
  // the primary resumes and is refused; the backup's fresh thread confirms
  s.spec({ tier: "echo", rejectTier: "thread/resume" });

  await s.say("to the backup");
  await s.called("turn/start", 2);
  await s.settled();
  assert.equal(s.count("thread/resume"), 1);
  assert.equal(opens(s).at(-1).method, "thread/start");
  assert.equal(lastTier(s), "priority");
  assert.match(await transcript(s), /picking this up/);
  assert.doesNotMatch(await transcript(s), /Trying again in a minute/);

  s.spec({ tier: "echo" });
  await patchBot(s, s.bot.id, { codexSpeed: "standard" });
  await new Promise((resolve) => setTimeout(resolve, 40));
  await s.turn("back on the primary");
  assert.equal(opens(s).at(-1).params.threadId, s.stored().tasks[0].resumeCursors.codex);
  assert.equal("serviceTier" in opens(s).at(-1).params, false);
  assert.equal(s.stored().modelSelection.instanceId, "codex");
});

for (const [name, change, detail] of [
  ["a turn/start error", { turnError: { code: -32600, message: "Server is draining; retry after reconnecting" } }, "Server is draining"],
  ["an exit before turn/start is answered", { exitBeforeAnswer: "synthetic exit before the answer" }, "synthetic exit before the answer"],
  ["an exit after the turn started", { exitAfterStart: "synthetic exit after the start" }, "synthetic exit after the start"],
] as const) {
  test(`${name} is asked again after the wait, then handed to the backup`, async (t) => {
    const s = await codexCommands(t, { BLOKS_RETRY_WAIT_MS: "20" });
    await s.turn("warm");
    await patchBot(s, s.bot.id, { backupSelection: { instanceId: "other", model: "gpt-6.1-sol" } });
    s.spec(change);

    await s.say("recover");
    // the first try, the same engine again, then the backup
    await s.called("turn/start", 4);
    await waitFor(async () => /picking this up/.test(await transcript(s)), "the backup never took the turn");
    await s.settled();

    assert.equal(s.count("turn/start"), 4);
    const said = await transcript(s);
    assert.match(said, /Trying again in a minute/);
    assert.ok(said.includes(detail), "Codex's own words stay visible");
    assert.doesNotMatch(said, /uncertain/i);
  });
}

test("a running turn's speed shows while it runs and leaves nothing behind", async (t) => {
  const s = await codexCommands(t);
  s.spec({ tier: "echo" });
  await setWorkspace(s, "fast");
  await s.say("HOLD the running turn");
  await waitFor(async () => (await lane(s))?.codexDispatch, "the running turn never showed its speed");

  const shown = (await lane(s)).codexDispatch;
  assert.deepEqual(shown, {
    choice: { default: "fast", override: null, resolved: "fast", source: "workspace" },
    configuredTier: "priority",
    actualTier: null,
  });

  await setWorkspace(s, "standard");
  await patchBot(s, s.bot.id, { codexSpeed: "standard" });
  assert.deepEqual((await lane(s)).codexDispatch, shown, "a setting changed mid-turn is for the next turn");

  s.gate();
  await s.settled();
  assert.equal((await lane(s)).codexDispatch, undefined);
  assert.equal((await s.messages()).some((m) => /^Codex: /.test(m.text ?? "")), false, "the speed is never a message");
});

test("a Standard turn by the workspace default carries no speed at all", async (t) => {
  const s = await codexCommands(t);
  await s.say("HOLD a Standard turn");
  await s.called("turn/start", 1);
  assert.equal((await lane(s)).state, "working");
  assert.equal((await lane(s)).codexDispatch, undefined);
  s.gate();
  await s.settled();
});

test("a manually run Fast Codex check-in keeps its speed and reports a missing answer honestly", async (t) => {
  const s = await codexCommands(t);
  await s.turn("warm");
  s.spec({ tier: "echo", answer: "QUIET" });
  await patchBot(s, s.bot.id, { codexSpeed: "fast" });
  await s.h.json(`/api/bots/${s.bot.id}/tasks/${s.bot.threadId}`, { method: "PATCH", body: JSON.stringify({ unread: false }) });

  const { routine } = await s.post("/api/routines", {
    targetId: s.bot.id,
    targetKind: "agent",
    name: "Inbox",
    prompt: "Any news?",
    every: 30,
    days: [],
  });
  await s.post(`/api/routines/${routine.id}/run`);
  await s.called("turn/start", 2);
  await s.settled();
  const run = async () => (await s.h.json("/api/routines")).routines.find((r: any) => r.id === routine.id)?.runs?.[0];
  await waitFor(async () => (await run())?.state && (await run()).state !== "running", "the check-in never finished");

  assert.equal(lastTier(s), "priority");
  assert.equal((await run()).state, "failed");
  assert.equal((await run()).error, "The agent ended this turn without an answer.");
  assert.equal(Boolean((await lane(s)).unread), true);
  const messages = await s.messages();
  const asked = messages.findIndex((m) => m.role === "user" && m.text === "Any news?");
  assert.ok(asked >= 0);
  assert.ok(!messages.slice(asked).some((m) => m.role === "bot" && m.text === "QUIET"));
});

test("an agent reads its speed and may slow only itself; Fast and the workspace stay the owner's", async (t) => {
  const s = await codexCommands(t);
  s.spec({ captureCredential: true });
  await s.say("HOLD for the credential");
  await s.called("turn/start", 1);
  // the stand-in notes the turn before it writes what it was handed, so
  // on a busy machine the file can lag the call by a beat
  const credentials = join(s.root, "credentials.jsonl");
  await waitFor(() => existsSync(credentials) && readFileSync(credentials, "utf8").trim(), "the credential was never captured");
  const { token } = JSON.parse(readFileSync(credentials, "utf8").trim().split("\n")[0]);
  const asAgent = (path: string, method = "GET", body?: unknown) =>
    s.h.fetch(path, {
      method,
      headers: { authorization: `Bearer ${token}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  const me = await (await asAgent("/api/agent/whoami")).json();
  assert.deepEqual(me.codexSpeed, { default: "standard", override: null, resolved: "standard", source: "workspace" });
  assert.equal((await asAgent("/api/config", "PATCH", { codex: { speed: "fast" } })).status, 403);
  const peer = await s.hire("Peer");
  assert.equal((await asAgent(`/api/bots/${peer.id}`, "PATCH", { codexSpeed: "fast" })).status, 403);
  for (const value of [false, {}, [], "priority", 0]) {
    assert.equal((await asAgent(`/api/bots/${s.bot.id}`, "PATCH", { codexSpeed: value })).status, 400);
  }
  assert.equal((await asAgent(`/api/bots/${s.bot.id}`, "PATCH", { codexSpeed: "standard" })).status, 200);
  // Fast spends the person's plan faster, so an agent cannot choose it
  assert.equal((await asAgent(`/api/bots/${s.bot.id}`, "PATCH", { codexSpeed: "fast" })).status, 403);
  assert.equal((await asAgent(`/api/bots/${s.bot.id}`, "PATCH", { codexSpeed: null })).status, 200);

  for (const value of [false, {}, null, "priority", { speed: "fast", extra: true }]) {
    const answer = await s.h.fetch("/api/config", { method: "PATCH", body: JSON.stringify({ codex: value }) });
    assert.equal(answer.status, 400);
  }

  s.gate();
  await s.settled();
});

test("routines, webhooks and workflows take the same speed as a message", async (t) => {
  const s = await codexCommands(t);
  s.spec({ tier: "echo" });
  await setWorkspace(s, "fast");

  const { routine } = await s.post("/api/routines", { targetId: s.bot.id, targetKind: "agent", prompt: "from a routine", time: "23:59", days: [] });
  await s.post(`/api/routines/${routine.id}/run`);
  await s.called("turn/start", 1);
  await s.settled();
  assert.equal(lastTier(s), "priority");

  const { webhook } = await s.post("/api/webhooks", { name: "Fixture", botId: s.bot.id });
  const hooked = await s.h.fetch(`/hook/${webhook.token}`, { method: "POST", body: JSON.stringify({ event: "from a webhook" }) });
  assert.equal(hooked.status, 202);
  await s.called("turn/start", 2);
  await s.settled();
  assert.equal(lastTier(s), "priority");

  const { workflow } = await s.post("/api/workflows", {
    name: "Fixture",
    trigger: { kind: "manual" },
    steps: [{ action: "ask", targetId: s.bot.id, text: "from a workflow" }],
  });
  await s.post(`/api/workflows/${workflow.id}/run`);
  await s.called("turn/start", 3);
  await s.settled();
  assert.equal(lastTier(s), "priority");
});
