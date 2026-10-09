// Archiving an agent stops its work and suspends its schedules, and
// keeps everything else for Restore (GitHub 220).
//
// Reported: agents archived mid-task went on to start file edits after
// the archive, and their routines and watchers stayed on, the watcher
// recording a failed look every few minutes. Three ways in, each tested
// here against the real server: a turn that was admitted but had not
// reached its engine yet, a turn running when the agent was hidden, and
// the schedules themselves.
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startHarness } from "./helpers/server.ts";
import { agentOn, fakeProvider, idle, messagesOf, waitFor } from "./helpers/turns.ts";

const find = async (h: { json: (p: string) => Promise<any> }, id: string) =>
  (await h.json("/api/bots?messages=0")).bots.find((b: any) => b.id === id);

test("a turn admitted before the archive but not yet sent never reaches its engine", async (t) => {
  const fake = await fakeProvider(t);
  fake.state.answerAtOnce = true;
  const h = await startHarness();
  const dir = mkdtempSync(join(tmpdir(), "bloks-archive-gate-"));
  const gate = join(dir, "gate");
  t.after(async () => {
    writeFileSync(gate, "");
    await h.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  const bot = await agentOn(h, fake.port, "Wren");

  // An engine whose CLI takes its time to say its version holds every
  // engine rebuild until it does, and a turn getting ready waits for a
  // rebuild before it is sent. That wait is the window: the lane is busy,
  // but no engine has heard of the turn, so there is nothing to interrupt.
  const started = join(dir, "asked");
  const slow = join(dir, "slow-claude.cjs");
  writeFileSync(
    slow,
    `#!${process.execPath}
const fs = require("node:fs");
if (process.argv[2] !== "--version") process.exit(1);
fs.writeFileSync(${JSON.stringify(started)}, "");
const until = Date.now() + 7000;
const tick = () => {
  if (fs.existsSync(${JSON.stringify(gate)}) || Date.now() > until) { console.log("2.1.300 (Claude Code)"); process.exit(0); }
  setTimeout(tick, 50);
};
tick();
`,
    { mode: 0o755 },
  );
  const configFile = join(h.home, ".bloks", "config.json");
  const config = JSON.parse(readFileSync(configFile, "utf8"));
  config.instances = { ...(config.instances ?? {}), slow: { driver: "claudeAgent", config: { cli: slow } } };
  writeFileSync(configFile, JSON.stringify(config));
  const reload = h.fetch("/api/providers/grok/connect", {
    method: "POST",
    body: JSON.stringify({ key: "test-key", url: `http://127.0.0.1:${fake.port}` }),
  });
  assert.ok(await waitFor(() => existsSync(started)), "the rebuild never started");

  const sent = await h.fetch(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: "REACH-ME and edit the notes" }) });
  assert.ok(sent.status < 300, `the message was refused before the archive: ${sent.status}`);
  assert.ok(await waitFor(async () => (await find(h, bot.id))?.busy), "the turn was never admitted");

  const archived = await h.fetch(`/api/bots/${bot.id}`, { method: "DELETE" });
  assert.equal(archived.status, 200);
  writeFileSync(gate, "");
  await reload;

  assert.ok(await idle(h, bot), "the lane stayed busy after its turn was dropped");
  // long enough for a turn that did go out to have been answered
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(fake.sent("REACH-ME"), 0, "an archived agent's turn reached its engine");
  const said = (await messagesOf(h, bot)).filter((m) => m.kind === "notice").map((m) => m.text);
  assert.ok(said.some((text) => /was archived before this reached its engine/.test(text)), `nothing said why: ${JSON.stringify(said)}`);
  assert.ok((await find(h, bot.id)).archivedAt);
});

test("hiding an agent mid-turn stops the turn, and it starts no tool afterwards", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "bloks-archive-acp-"));
  const gate = join(home, "gate");
  const ran = join(home, "tool-ran");
  const log = join(home, "acp.log");
  // An ACP agent that, told ASK-AFTER-GATE, waits for the gate, then asks
  // to edit a file and does it if allowed. It ignores session/cancel, as
  // an agent busy in a tool can, so only the kill stops it.
  const cli = join(home, "fake-acp.cjs");
  writeFileSync(
    cli,
    `#!${process.execPath}
const fs = require("node:fs");
const say = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
const note = (line) => fs.appendFileSync(${JSON.stringify(log)}, line + "\\n");
const waiting = new Map();
let asked = 9000;
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (!msg.method) return waiting.get(msg.id)?.(msg.result);
  note(msg.method);
  if (msg.id === undefined) return;
  const reply = (result) => say({ jsonrpc: "2.0", id: msg.id, result });
  if (msg.method === "initialize") return reply({ protocolVersion: 1, agentCapabilities: {} });
  if (msg.method === "session/new") return reply({ sessionId: "s1" });
  if (msg.method !== "session/prompt") return reply({});
  const text = msg.params.prompt.map((p) => p.text).join("");
  if (!text.includes("ASK-AFTER-GATE")) return reply({ stopReason: "end_turn" });
  const tick = () => {
    if (!fs.existsSync(${JSON.stringify(gate)})) return setTimeout(tick, 50);
    const id = asked++;
    waiting.set(id, (result) => {
      note("answered " + JSON.stringify(result));
      if (result?.outcome?.optionId === "allow") fs.writeFileSync(${JSON.stringify(ran)}, "yes");
      reply({ stopReason: "end_turn" });
    });
    say({ jsonrpc: "2.0", id, method: "session/request_permission", params: {
      sessionId: "s1",
      toolCall: { toolCallId: "t1", title: "Edit notes.txt", kind: "edit" },
      options: [{ optionId: "allow", name: "Allow once", kind: "allow_once" }, { optionId: "reject", name: "Reject", kind: "reject_once" }],
    } });
  };
  tick();
});
`,
    { mode: 0o755 },
  );
  mkdirSync(join(home, ".bloks"), { recursive: true });
  writeFileSync(join(home, ".bloks", "config.json"), JSON.stringify({ instances: { "pi-fake": { driver: "pi", config: { cli } } } }));
  const h = await startHarness({ HOME: home });
  t.after(async () => {
    appendFileSync(gate, "");
    await h.stop();
    rmSync(home, { recursive: true, force: true });
  });

  const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Otto" }) });
  // auto: anything it asks for is waved through, which is how the
  // reported edits went ahead with nobody there to say no
  const set = await h.fetch(`/api/bots/${bot.id}`, {
    method: "PATCH",
    body: JSON.stringify({ modelSelection: { instanceId: "pi-fake", model: "auto" }, approvals: "auto" }),
  });
  assert.equal(set.status, 200);
  await h.fetch(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: "ASK-AFTER-GATE: tidy the notes" }) });
  assert.ok(
    await waitFor(() => existsSync(log) && readFileSync(log, "utf8").includes("session/prompt")),
    "the turn never reached the agent",
  );

  const hidden = await h.fetch(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ hidden: true }) });
  assert.equal(hidden.status, 200);
  // the agent gets to the tool only now, after the archive was reported
  writeFileSync(gate, "");
  assert.ok(await waitFor(async () => !(await find(h, bot.id))?.busy, 10_000), "the turn went on after the agent was hidden");
  await new Promise((r) => setTimeout(r, 1_000));
  assert.equal(existsSync(ran), false, "an archived agent started a tool");
  const after = await find(h, bot.id);
  assert.ok(after.archivedAt && after.hidden);
});

test("an archived agent's schedules are suspended, unchanged, and resume on Restore with a word", async (t) => {
  const h = await startHarness();
  const folder = mkdtempSync(join(tmpdir(), "bloks-archive-watch-"));
  t.after(async () => {
    await h.stop();
    rmSync(folder, { recursive: true, force: true });
  });
  const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Juno" }) });
  const { routine } = await h.json("/api/routines", {
    method: "POST",
    body: JSON.stringify({ targetId: bot.id, targetKind: "agent", name: "Weekly report", prompt: "Write it.", time: "09:00", days: [1] }),
  });
  const { watcher } = await h.json("/api/watchers", {
    method: "POST",
    body: JSON.stringify({ botId: bot.id, kind: "folder", target: folder, name: "Invoices", instruction: "File them." }),
  });
  const watched = () => h.json("/api/watchers").then((r) => r.watchers.find((w: any) => w.id === watcher.id));
  const scheduled = () => h.json("/api/routines").then((r) => r.routines.find((x: any) => x.id === routine.id));
  // the first look is the baseline
  assert.ok(await waitFor(async () => (await watched())?.lastCheck), "the watcher never took its first look");

  assert.equal((await h.fetch(`/api/bots/${bot.id}`, { method: "DELETE" })).status, 200);

  // paused because the agent is archived, and nothing about either changed
  const r = await scheduled();
  assert.equal(r.enabled, true, "the routine's own switch was flipped");
  assert.equal(r.suspended, "archived");
  assert.equal(r.nextRunAt, null, "a suspended routine still says when it runs next");
  const w = await watched();
  assert.equal(w.enabled, true, "the watcher's own switch was flipped");
  assert.equal(w.suspended, "archived");

  // A look now is not a failed look: no error, and the last look stays
  // where it was. The reported watcher logged "its agent is gone or
  // archived" every few minutes.
  writeFileSync(join(folder, "invoice.pdf"), "new");
  const look = await h.json(`/api/watchers/${watcher.id}/check`, { method: "POST", body: "{}" });
  assert.equal(look.fired, false);
  const still = await watched();
  assert.equal(still.lastError, undefined, `a look at an archived agent's watcher was recorded as an error: ${still.lastError}`);
  assert.equal(still.lastCheck, w.lastCheck, "a look at an archived agent's watcher moved its last look on");

  // Restore brings both back as they were, and says so
  assert.equal((await h.fetch(`/api/bots/${bot.id}/restore`, { method: "POST" })).status, 200);
  const back = await scheduled();
  assert.equal(back.suspended, undefined);
  assert.equal(back.enabled, true);
  assert.ok(back.nextRunAt, "the restored routine has no next run");
  assert.equal((await watched()).suspended, undefined);
  const notices = (await messagesOf(h, bot)).filter((m) => m.kind === "notice").map((m) => m.text as string);
  const resumed = notices.find((text) => /resumed/.test(text));
  assert.ok(resumed, `Restore said nothing about its schedules: ${JSON.stringify(notices)}`);
  assert.match(resumed!, /Weekly report/);
  assert.match(resumed!, /Invoices/);
});

test("words waiting behind a turn the archive stopped are marked not sent, not delivered to nobody", async (t) => {
  const fake = await fakeProvider(t);
  const h = await startHarness();
  t.after(() => h.stop());
  const bot = await agentOn(h, fake.port, "Wren");

  await h.fetch(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: "LONG-WORK" }) });
  assert.ok(await waitFor(() => fake.sent("LONG-WORK") >= 1), "the turn never started");
  const said = await h.json(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: "AND-THEN" }) });
  assert.equal(said.queued, true);

  // The archive stops the turn, and the turn's end goes to what waited.
  // That used to deliver it, so it read as heard, and then refuse it.
  assert.equal((await h.fetch(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ hidden: true }) })).status, 200);
  assert.ok(await idle(h, bot), "the turn did not stop");
  const waited = await waitFor(async () => {
    const m = (await messagesOf(h, bot)).find((x) => x.text === "AND-THEN");
    return m && !m.queued ? m : null;
  });
  assert.ok(waited, "what waited is still waiting");
  assert.equal(waited.unsent, true, "what waited reads as delivered, though nothing heard it");
  assert.ok(
    (await messagesOf(h, bot)).some((m) => m.kind === "notice" && /was not sent\. Wren is archived/.test(m.text ?? "")),
    "nothing said why it was not sent",
  );

  // Restore does not send it behind the person's back either
  fake.state.answerAtOnce = true;
  assert.equal((await h.fetch(`/api/bots/${bot.id}/restore`, { method: "POST" })).status, 200);
  await new Promise((r) => setTimeout(r, 1_000));
  assert.equal(fake.sent("AND-THEN"), 0);
});
