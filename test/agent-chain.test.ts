// Agents messaging agents, past the point where anyone asked them to.
//
// Each `bloks say` to an idle agent starts a paid turn there, and a
// turn's own budget (TURN_BUDGET) starts again in every one of them, so
// two agents answering each other went on until somebody noticed. Now a
// turn started by an agent's message sits one further along a chain than
// the sender's turn did, and past twelve in a row the next message waits
// for the person; whoever they write to starts the chain over.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { startHarness, type Harness } from "./helpers/server.ts";
import { waitFor } from "./helpers/turns.ts";

const BLOKS = fileURLToPath(new URL("../bin/bloks.mjs", import.meta.url));

/** A stand-in Claude Code that, told START <id>, says something to that
 * agent with the real `bloks`, and, told by another agent, answers it the
 * same way, unless `quiet` is there. Told SELF START <id>, it says that
 * same thing on, so an agent told it about itself keeps telling itself.
 * Every `bloks say` and what it answered is a line in says.jsonl. */
function workspace() {
  const home = mkdtempSync(join(tmpdir(), "bloks-chain-"));
  mkdirSync(join(home, ".bloks"), { recursive: true });
  writeFileSync(join(home, ".bloks", "config.json"), JSON.stringify({ instances: { claude: { driver: "claudeAgent", config: { cli: join(home, "fake-claude.mjs") } } } }));
  const cli = `#!${process.execPath}
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("9.9.9 (Claude Code)"); process.exit(0); }
if (args[0] === "auth") { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
const home = ${JSON.stringify(home)};
const out = (frame) => console.log(JSON.stringify(frame));
let buf = "";
let started = false;
process.stdin.on("data", (c) => {
  buf += c;
  for (let i = buf.indexOf("\\n"); i >= 0; i = buf.indexOf("\\n")) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim() || started) continue;
    const frame = JSON.parse(line);
    if (frame.type !== "user") continue;
    started = true;
    go(String(frame.message?.content ?? ""));
  }
});
async function go(prompt) {
  out({ type: "system", subtype: "init", session_id: "sess-chain", model: "claude-sonnet-5" });
  const quiet = existsSync(home + "/quiet");
  // ROOMLOOP: told it in a conversation, name the other agent in the room;
  // named in the room, tell the first agent so in its conversation
  const loop = prompt.match(/ROOMLOOP room=([\\w-]+) a=([\\w-]+) b=(\\w+)/);
  // FILE: file a routine and a folder watcher for itself, with its own
  // credential, as an agent does with bloks routine and bloks watch
  const file = prompt.match(/FILE routine=([\\w-]+) dir=(\\S+)/);
  if (file && !quiet) {
    const auth = { authorization: "Bearer " + process.env.BLOKS_TOKEN, "content-type": "application/json" };
    const routine = await fetch(process.env.BLOKS_URL + "/api/routines", { method: "POST", headers: auth, body: JSON.stringify({ targetId: file[1], targetKind: "agent", prompt: "ROUTINE-RAN", time: "03:00", days: [] }) });
    const watcher = await fetch(process.env.BLOKS_URL + "/api/watchers", { method: "POST", headers: auth, body: JSON.stringify({ kind: "folder", target: file[2], instruction: "WATCHER-RAN", name: "drops" }) });
    appendFileSync(home + "/says.jsonl", JSON.stringify({ to: "file", said: { routine: routine.status, watcher: watcher.status } }) + "\\n");
    out({ type: "assistant", message: { content: [{ type: "text", text: "Done" }] } });
    out({ type: "result", subtype: "success", is_error: false, num_turns: 1, duration_api_ms: 100, total_cost_usd: 0, session_id: "sess-chain", result: "Done" });
    return;
  }
  // JOBLOOP: whoever takes the job posts one for the other agent
  const job = prompt.includes("JOBLOOP");
  const next = prompt.includes("JOBLOOP alpha") ? "JOBLOOP bravo" : "JOBLOOP alpha";
  if ((loop || job) && !quiet) {
    let said;
    try {
      if (job) {
        const res = await fetch(process.env.BLOKS_URL + "/api/jobs", { method: "POST", headers: { authorization: "Bearer " + process.env.BLOKS_TOKEN, "content-type": "application/json" }, body: JSON.stringify({ title: next, brief: next }) });
        said = { status: res.status };
      } else {
        const [, room, a, b] = loop;
        const inRoom = prompt.includes("@" + b);
        const words = (inRoom ? "" : "@" + b + " ") + "ROOMLOOP room=" + room + " a=" + a + " b=" + b;
        said = JSON.parse(execFileSync(process.execPath, [${JSON.stringify(BLOKS)}, "say", inRoom ? a : room, words], { encoding: "utf8" }));
      }
    } catch (e) { said = { ...JSON.parse(String(e.stdout || "{}")), refused: true }; }
    appendFileSync(home + "/says.jsonl", JSON.stringify({ to: job ? "jobs" : "loop", said }) + "\\n");
    out({ type: "assistant", message: { content: [{ type: "text", text: "Done" }] } });
    out({ type: "result", subtype: "success", is_error: false, num_turns: 1, duration_api_ms: 100, total_cost_usd: 0, session_id: "sess-chain", result: "Done" });
    return;
  }
  const start = prompt.match(/START ([\\w-]+)/);
  const asked = prompt.match(/use \`bloks say ([\\w-]+) <text>\`/);
  const self = prompt.includes("SELF");
  const to = start && !(self && quiet) ? start[1] : asked && !quiet ? asked[1] : null;
  if (to) {
    let said;
    const words = self ? "SELF START " + to : "over to you";
    try { said = JSON.parse(execFileSync(process.execPath, [${JSON.stringify(BLOKS)}, "say", to, words], { encoding: "utf8" })); }
    catch (e) { said = { ...JSON.parse(String(e.stdout || "{}")), refused: true }; }
    appendFileSync(home + "/says.jsonl", JSON.stringify({ to, said }) + "\\n");
  }
  out({ type: "assistant", message: { content: [{ type: "text", text: "Done" }] } });
  out({ type: "result", subtype: "success", is_error: false, num_turns: 1, duration_api_ms: 100, total_cost_usd: 0, session_id: "sess-chain", result: "Done" });
}
`;
  writeFileSync(join(home, "fake-claude.mjs"), cli, { mode: 0o755 });
  return home;
}

async function boot(t: TestContext) {
  const home = workspace();
  const h = await startHarness({ HOME: home });
  t.after(async () => {
    writeFileSync(join(home, "quiet"), "");
    await h.stop();
    rmSync(home, { recursive: true, force: true });
  });
  const hire = async (name: string) => {
    const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name }) });
    await h.fetch(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } }) });
    return bot as { id: string; name: string };
  };
  return { home, h, hire };
}

const says = (home: string) =>
  existsSync(join(home, "says.jsonl"))
    ? readFileSync(join(home, "says.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { to: string; said: any })
    : [];
const idle = (h: Harness) =>
  waitFor(async () => ((await h.json("/api/bots?messages=0")).bots.some((b: any) => b.busy) ? null : true));
const notices = async (h: Harness, bot: { id: string }) =>
  ((await h.json(`/api/bots/${bot.id}/messages?limit=200`)).messages as any[]).filter((m) => m.kind === "notice").map((m) => m.text as string);

test("two agents answering each other stop after twelve turns, and the person writing starts it over", async (t) => {
  const { home, h, hire } = await boot(t);
  const alpha = await hire("Alpha");
  const bravo = await hire("Bravo");

  // The person asks Alpha to say something to Bravo, and from there each
  // answers the other. Twelve turns in a row are the agents' own; the
  // thirteenth message is the one that waits for the person.
  await h.fetch(`/api/bots/${alpha.id}/messages`, { method: "POST", body: JSON.stringify({ text: `START ${bravo.id}` }) });
  const refused = await waitFor(() => says(home).find((line) => line.said.refused) ?? null, 60_000);
  assert.ok(refused, `the agents were still answering each other after ${says(home).length} messages`);
  assert.ok(await idle(h), "a turn was still running after the refusal");
  await new Promise((r) => setTimeout(r, 1_000));

  const all = says(home);
  assert.equal(all.length, 13, `expected twelve messages through and the thirteenth refused: ${JSON.stringify(all.map((x) => x.said))}`);
  assert.ok(all.slice(0, 12).every((line) => !line.said.refused), "a message inside the limit was refused");
  // the turn at twelve was Alpha's, so its message to Bravo is the one refused
  assert.equal(refused.to, bravo.id);
  assert.match(refused.said.error, /did not get this/);
  assert.match(refused.said.error, /12 turns in a row/);
  // and the person reads why in the conversation it was meant for
  const told = await notices(h, bravo);
  assert.ok(
    told.includes("Alpha and Bravo have passed messages back and forth 12 times without you; the next one waits for you."),
    `nothing in Bravo's conversation says why it stopped: ${JSON.stringify(told)}`,
  );

  // The person writes to either, and that turn starts the chain over: its
  // message goes through.
  writeFileSync(join(home, "quiet"), "");
  await h.fetch(`/api/bots/${bravo.id}/messages`, { method: "POST", body: JSON.stringify({ text: `START ${alpha.id}` }) });
  const after = await waitFor(() => (says(home).length > 13 ? says(home)[13] : null));
  assert.ok(after, "Bravo's turn never ran");
  assert.equal(after.to, alpha.id);
  assert.ok(!after.said.refused, `the person's own turn was still held to the old chain: ${JSON.stringify(after.said)}`);
});

test("an agent messaging itself is a chain too", async (t) => {
  const { home, h, hire } = await boot(t);
  const solo = await hire("Solo");
  // Its message to itself waits for its own turn to end, then starts the
  // next one, which says it again: a loop with nobody else in it.
  await h.fetch(`/api/bots/${solo.id}/messages`, { method: "POST", body: JSON.stringify({ text: `SELF START ${solo.id}` }) });
  const refused = await waitFor(() => says(home).find((line) => line.said.refused) ?? null, 60_000);
  assert.ok(refused, `the agent was still messaging itself after ${says(home).length} messages`);
  assert.ok(await idle(h));
  assert.equal(says(home).length, 13);
  const told = await notices(h, solo);
  assert.ok(
    told.includes("Solo has passed messages to itself 12 times without you; the next one waits for you."),
    `nothing in Solo's conversation says why it stopped: ${JSON.stringify(told)}`,
  );
});

/** Nothing new said for a while, with every agent idle: the loop is over. */
async function settledSays(home: string, h: Harness) {
  let seen = -1;
  for (let i = 0; i < 120; i++) {
    await idle(h);
    await new Promise((r) => setTimeout(r, 1_500));
    const now = says(home).length;
    if (now === seen && !(await h.json("/api/bots?messages=0")).bots.some((b: any) => b.busy)) return now;
    seen = now;
  }
  return null;
}

test("naming an agent in a room from a conversation, and being answered there, is the same chain", async (t) => {
  // Alpha names Bravo in a room from its own conversation; Bravo, in the
  // room, tells Alpha in Alpha's. A room turn used to start every chain
  // again, so neither ever grew and the two kept each other going.
  const { home, h, hire } = await boot(t);
  const alpha = await hire("Alpha");
  const bravo = await hire("Bravo");
  const { blok } = await h.json("/api/bloks", { method: "POST", body: JSON.stringify({ name: "Ops", memberIds: [alpha.id, bravo.id] }) });
  await h.fetch(`/api/bots/${alpha.id}/messages`, { method: "POST", body: JSON.stringify({ text: `ROOMLOOP room=${blok.id} a=${alpha.id} b=Bravo` }) });

  const total = await settledSays(home, h);
  assert.ok(total !== null && total <= 14, `the agents were still going after ${says(home).length} messages`);
  const room = (await h.json(`/api/bloks/${blok.id}/messages?limit=200`)).messages as any[];
  assert.ok(
    room.some((m) => m.kind === "notice" && /turns in a row without you, so nobody was woken/.test(m.text)),
    `nothing in the room says why it stopped: ${JSON.stringify(room.map((m) => m.text))}`,
  );

  // the person posting in the room starts it over
  const before = says(home).length;
  await h.fetch(`/api/bloks/${blok.id}/messages`, { method: "POST", body: JSON.stringify({ text: `@Bravo ROOMLOOP room=${blok.id} a=${alpha.id} b=Bravo` }) });
  assert.ok(await waitFor(() => says(home).length > before), "the person's post did not start the room over");
  writeFileSync(join(home, "quiet"), "");
});

test("jobs agents post for each other are a chain, and past it wait for the person", async (t) => {
  const { home, h, hire } = await boot(t);
  await hire("Alpha");
  await hire("Bravo");
  await h.json("/api/jobs", { method: "POST", body: JSON.stringify({ title: "JOBLOOP alpha", brief: "JOBLOOP alpha" }) });

  const total = await settledSays(home, h);
  assert.ok(total !== null && total <= 14, `jobs were still being posted after ${says(home).length}`);
  const { jobs } = await h.json("/api/jobs");
  const held = (jobs as any[]).find((job) => job.state === "failed" && /Not offered: agents had started 12 turns in a row/.test(job.result ?? ""));
  assert.ok(held, `no job was held for the person: ${JSON.stringify((jobs as any[]).map((job) => [job.state, job.result]))}`);
});

test("routines and watchers an agent files carry its place, and past the limit wait for the person", async (t) => {
  const home = workspace();
  let h = await startHarness({ HOME: home });
  t.after(async () => {
    writeFileSync(join(home, "quiet"), "");
    await h.stop();
    rmSync(home, { recursive: true, force: true });
  });
  const { bot: alpha } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Alpha" }) });
  await h.fetch(`/api/bots/${alpha.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } }) });
  const dir = join(home, "drops");
  mkdirSync(dir);

  // filed from a turn the person started, so one along
  await h.fetch(`/api/bots/${alpha.id}/messages`, { method: "POST", body: JSON.stringify({ text: `FILE routine=${alpha.id} dir=${dir}` }) });
  const filed = await waitFor(() => says(home).find((line) => line.to === "file") ?? null);
  assert.deepEqual(filed?.said, { routine: 201, watcher: 201 });
  assert.ok(await idle(h));
  const routine = (await h.json("/api/routines")).routines[0];
  const watcher = (await h.json("/api/watchers")).watchers[0];
  assert.equal(routine.chain, 1);
  assert.equal(watcher.chain, 1);
  // the person changing one, or looking by hand, has had their say; the
  // look is also the watcher's first, the baseline a change is measured
  // against, which its agent being busy filing it put off
  await h.fetch(`/api/routines/${routine.id}`, { method: "PATCH", body: JSON.stringify({ name: "Nightly" }) });
  assert.equal((await h.json("/api/routines")).routines[0].chain, undefined);
  await h.json(`/api/watchers/${watcher.id}/check`, { method: "POST" });
  const looked = (await h.json("/api/watchers")).watchers[0];
  assert.equal(looked.chain, undefined);
  assert.ok(looked.lastCheck, "the person's look took no baseline");

  // As if an agent had filed both deep in a chain: the routine comes due
  // and the folder changes, and neither starts a turn.
  await h.stop();
  const data = join(home, ".bloks");
  const rewrite = (file: string, change: (rows: any[]) => void) => {
    const rows = JSON.parse(readFileSync(join(data, file), "utf8"));
    change(rows);
    writeFileSync(join(data, file), JSON.stringify(rows));
  };
  const due = new Date(Date.now() - 60_000);
  rewrite("routines.json", (rows) => {
    rows[0].chain = 13;
    rows[0].time = `${String(due.getHours()).padStart(2, "0")}:${String(due.getMinutes()).padStart(2, "0")}`;
    rows[0].scheduledAt = due.getTime() - 60_000;
    delete rows[0].lastRunAt;
  });
  rewrite("watchers.json", (rows) => { rows[0].chain = 13; });
  h = await startHarness({ HOME: home });
  const held = await waitFor(async () => (await h.json("/api/routines")).routines[0].runs?.find((run: any) => run.state === "failed") ?? null, 20_000);
  assert.match(held?.error ?? "", /^Held: agents had started 12 turns in a row without you/);
  writeFileSync(join(dir, "new.txt"), "x");
  // a folder is looked at once it has been still for SETTLE_MS (20 s)
  const quietly = await waitFor(async () => (/^Held:/.test((await h.json("/api/watchers")).watchers[0].lastError ?? "") ? true : null), 45_000);
  assert.ok(quietly, "the watcher looked and acted past the limit");
  const asked = async (words: string) => ((await h.json(`/api/bots/${alpha.id}/messages?limit=200`)).messages as any[]).some((m) => m.text?.includes(words));
  assert.ok(!(await asked("ROUTINE-RAN")) && !(await asked("WATCHER-RAN")), "a held routine or watcher started a turn");

  // the person running or looking by hand starts each over
  assert.equal((await h.fetch(`/api/routines/${routine.id}/run`, { method: "POST" })).status, 202);
  assert.ok(await waitFor(() => asked("ROUTINE-RAN")), "the person's run was still held");
  assert.ok(await idle(h));
  const look = await h.json(`/api/watchers/${watcher.id}/check`, { method: "POST" });
  assert.equal(look.fired, true, look.note);
  assert.ok(await waitFor(() => asked("WATCHER-RAN")), "the person's look was still held");
  assert.equal((await h.json("/api/watchers")).watchers[0].chain, undefined);
  assert.equal((await h.json("/api/routines")).routines[0].chain, undefined);
});
