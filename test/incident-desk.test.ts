// The incident desk end to end (server/incidents.ts): a turn that fails
// for good becomes an incident, goes to whoever leads or to the person as
// a card, and a routine that keeps failing stops itself. The real server,
// a throwaway home, an engine that fails every turn, and a stand-in Claude
// Code as the lead that answers through the command line's routes with
// its own turn credential, as `bloks incident tell` does.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { startHarness, type Harness } from "./helpers/server.ts";
import { controlledChain } from "./helpers/agent-chain.ts";
import { noticeFor } from "../src/lib/notify.ts";
import { agentOn, idle, messagesOf, waitFor } from "./helpers/turns.ts";

let h: Harness;
let home: string;
let failingPort = 0;
const servers: Array<ReturnType<typeof createServer>> = [];

before(async () => {
  home = mkdtempSync(join(tmpdir(), "bloks-desk-"));
  // A lead on Claude Code: told about an incident, it tells the person
  // what is needed, then answers QUIET, as the note asks.
  const cli = join(home, "fake-claude.mjs");
  writeFileSync(
    cli,
    `#!${process.execPath}
const [first] = process.argv.slice(2);
if (first === "--version") { console.log("2.1.299 (Claude Code)"); process.exit(0); }
if (first === "auth") { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
let input = "";
((go) => { let line = ""; const take = (c) => { line += c; while (line.includes(String.fromCharCode(10))) { const at = line.indexOf(String.fromCharCode(10)); const next = line.slice(0, at); line = line.slice(at + 1); if (!next.trim() || JSON.parse(next).type !== "user") continue; input = next; process.stdin.off("data", take); go(); return; } }; process.stdin.on("data", take); })(async () => {
  const found = input.match(/Incident ([\\w-]+)\\./);
  const call = (path, body) => fetch(process.env.BLOKS_URL + path, {
    method: body ? "POST" : "GET",
    headers: { authorization: "Bearer " + process.env.BLOKS_TOKEN, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }).then((r) => r.json());
  if (found && input.includes("Rita's turn")) {
    await call("/api/incidents/" + found[1] + "/retry", {});
  } else if (found && input.includes("Hank's turn")) {
    const { bots } = await call("/api/bots?messages=0");
    const helper = bots.find((b) => b.name === "Helper");
    await call("/api/incidents/" + found[1] + "/hand", { to: helper.id, note: "Try it with the backup plan." });
  } else if (found) {
    await call("/api/incidents/" + found[1] + "/tell", { text: "Please put credit on the engine's account." });
  }
  console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "QUIET" }] } }));
  console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "QUIET" }));
});
`,
    { mode: 0o755 },
  );
  mkdirSync(join(home, ".bloks"), { recursive: true });
  writeFileSync(join(home, ".bloks", "config.json"), JSON.stringify({ instances: { claude: { driver: "claudeAgent", config: { cli } } } }));
  // an engine that fails every turn
  const failing = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url?.endsWith("/models")) return res.end(JSON.stringify({ data: [{ id: "grok-4" }] }));
      res.statusCode = 500;
      res.end(JSON.stringify({ error: { message: "the engine is having a moment" } }));
    });
  });
  await new Promise<void>((r) => failing.listen(0, "127.0.0.1", () => r()));
  servers.push(failing);
  failingPort = (failing.address() as { port: number }).port;
  h = await startHarness({ HOME: home });
});

after(async () => {
  await h?.stop();
  for (const server of servers) {
    server.closeAllConnections();
    server.close();
  }
  rmSync(home, { recursive: true, force: true });
});

const desk = (incidents: { enabled?: boolean; lead?: string }) =>
  h.fetch("/api/config", { method: "PUT", body: JSON.stringify({ incidents }) });
const listed = async () => (await h.json("/api/incidents")).incidents as any[];
const openFor = (botName: string) =>
  waitFor(async () => (await listed()).find((i) => i.open && i.where.botName === botName && i.state === "needs-you"), 20_000);

test("the desk's settings are checked and said back", async () => {
  assert.deepEqual((await h.json("/api/config")).incidents, { enabled: true, lead: "auto" });
  assert.equal((await desk({ lead: "nobody-here" })).status, 400);
  assert.equal((await desk({ enabled: "yes" as unknown as boolean })).status, 400);
  assert.equal((await desk({ lead: "person" })).status, 200);
  assert.deepEqual((await h.json("/api/config")).incidents, { enabled: true, lead: "person" });
  assert.ok((await h.json("/api/health")).features.includes("incidents"));
});

test("a turn that fails for good is a card for the person, and resolving it settles the card", async () => {
  await desk({ enabled: true, lead: "person" });
  const sage = await agentOn(h, failingPort, "Sage");
  await h.fetch(`/api/bots/${sage.id}/messages`, { method: "POST", body: JSON.stringify({ text: "Summarise the inbox" }) });
  const incident = await openFor("Sage");
  assert.ok(incident, "no incident reached the person");
  assert.equal(incident.kind, "turn");
  assert.equal(incident.where.laneId, sage.threadId);
  assert.deepEqual(incident.lead, { kind: "person" });
  assert.match(incident.why, /having a moment/);
  await idle(h, sage);
  const said = await messagesOf(h, sage);
  const card = said.find((m) => m.incident?.kind === "needs-you");
  assert.ok(card, "no card in the conversation");
  assert.equal(card.kind, "notice");
  assert.equal(card.incident.state, "open");
  // the failure's own notice is the card: the error is said once, not
  // once by the turn and again by the desk
  assert.match(card.text, /having a moment/);
  assert.equal(said.filter((m) => m.kind === "notice" && /stopped here/.test(m.text ?? "")).length, 1);
  assert.equal(incident.card.messageId, card.id);
  // the activity list and the incident itself say the same
  assert.ok((await h.json("/api/activity")).incidents.some((i: any) => i.id === incident.id));
  assert.equal((await h.json(`/api/incidents/${incident.id}`)).incident.id, incident.id);

  const resolved = await h.json(`/api/incidents/${incident.id}/resolve`, { method: "POST" });
  assert.equal(resolved.incident.state, "resolved");
  const after = (await messagesOf(h, sage)).find((m) => m.id === card.id);
  assert.equal(after.incident.state, "resolved");
  assert.ok(!(await h.json("/api/activity")).incidents.some((i: any) => i.id === incident.id));
});

test("with a lead, the lead gets a quiet turn and what it says reaches the person as the card", async () => {
  await desk({ enabled: true, lead: "auto" });
  const { bot: chief } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Chief", seniority: 4 }) });
  await h.fetch(`/api/bots/${chief.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } }) });
  const ivy = await agentOn(h, failingPort, "Ivy");
  await h.fetch(`/api/bots/${ivy.id}/messages`, { method: "POST", body: JSON.stringify({ text: "Draft the reply" }) });
  const incident = await waitFor(async () => (await listed()).find((i) => i.where.botName === "Ivy" && i.needs), 30_000);
  assert.ok(incident, "the lead's word never reached the person");
  assert.deepEqual(incident.lead, { kind: "agent", id: chief.id, name: "Chief" });
  assert.equal(incident.state, "needs-you");
  assert.equal(incident.needs, "Please put credit on the engine's account.");
  const card = await waitFor(async () => (await messagesOf(h, ivy)).find((m) => m.incident?.kind === "needs-you"));
  assert.match(card.text, /Chief looked at it and needs you: Please put credit/);
  // the lead's turn was a note from Bloks, never the person's words, and
  // its QUIET answer folded it away
  await idle(h, chief);
  const lane = (await h.json(`/api/bots/${chief.id}/messages?thread=${chief.threadId}&limit=500`)).messages as any[];
  const note = lane.find((m) => m.via === "incident");
  assert.ok(note, "no note in the lead's conversation");
  assert.equal(note.incident.id, incident.id);
  assert.match(note.text, /not from the person/);
  const folded = await waitFor(async () => {
    const now = (await h.json(`/api/bots/${chief.id}/messages?thread=${chief.threadId}&limit=500`)).messages as any[];
    return now.find((m) => m.id === note.id)?.quiet ? now : null;
  });
  assert.ok(folded, "the lead's QUIET answer was not folded away");
  const turn = folded.slice(folded.findIndex((m) => m.id === note.id));
  assert.ok(turn.some((m) => m.role === "bot" && m.kind === "text"), "the lead never answered");
  assert.ok(turn.filter((m) => m.role === "bot" && m.kind === "text").every((m) => m.quiet), "its answer stayed on the page");
  // the lead cannot act on it again now it is with the person, nor settle it
  const statuses = await h.json(`/api/incidents/${incident.id}`);
  assert.equal(statuses.incident.state, "needs-you");
  await h.json(`/api/incidents/${incident.id}/resolve`, { method: "POST" });
});

test("a lead's one retry that fails again goes to the person, and starts nothing new", async () => {
  await desk({ enabled: true, lead: "auto" });
  const rita = await agentOn(h, failingPort, "Rita");
  await h.fetch(`/api/bots/${rita.id}/messages`, { method: "POST", body: JSON.stringify({ text: "Book the room" }) });
  const incident = await waitFor(async () => (await listed()).find((i) => i.where.botName === "Rita" && i.retriedAt && i.state === "needs-you"), 30_000);
  assert.ok(incident, "the retry never came back to the person");
  assert.equal(incident.count, 2, "the retry's failure is counted on the same incident");
  assert.equal((await listed()).filter((i) => i.where.botName === "Rita").length, 1);
  const card = await waitFor(async () => (await messagesOf(h, rita)).find((m) => m.incident?.kind === "needs-you"));
  assert.match(card.text, /failed again when it was tried once more/);
  // the person may still try it; the lead has had its one
  const again = await h.fetch(`/api/incidents/${incident.id}/retry`, { method: "POST" });
  assert.equal(again.status, 202);
  // failing again brings it back to the person, counted on the same one
  const back = await waitFor(async () => {
    const now = (await h.json(`/api/incidents/${incident.id}`)).incident;
    return now.state === "needs-you" && now.count === 3 ? now : null;
  }, 20_000);
  assert.ok(back, "the person's retry did not come back to them");
  await idle(h, rita);
  await h.json(`/api/incidents/${incident.id}/resolve`, { method: "POST" });
});

test("a lead can hand it to a teammate, which settles it and sends the teammate what failed", async () => {
  await desk({ enabled: true, lead: "auto" });
  const helper = await agentOn(h, failingPort, "Helper");
  const hank = await agentOn(h, failingPort, "Hank");
  await h.fetch(`/api/bots/${hank.id}/messages`, { method: "POST", body: JSON.stringify({ text: "File the expenses" }) });
  const incident = await waitFor(async () => (await listed()).find((i) => i.where.botName === "Hank" && i.handedTo), 30_000);
  assert.ok(incident, "never handed on");
  assert.equal(incident.state, "resolved");
  assert.equal(incident.handedTo.id, helper.id);
  assert.match(incident.resolution, /Handed to Helper/);
  const sent = await waitFor(async () => (await messagesOf(h, helper)).find((m) => m.agent?.dir === "in" && /Hank's turn/.test(m.text ?? "")));
  assert.ok(sent, "the teammate never heard");
  assert.match(sent.text, /Try it with the backup plan/);
  await idle(h, helper);
  for (const open of (await listed()).filter((i) => i.open)) await h.json(`/api/incidents/${open.id}/resolve`, { method: "POST" });
});

test("a routine that fails three times in a row stops, says so once, and a change starts it again", async () => {
  await desk({ enabled: true, lead: "person" });
  const rex = await agentOn(h, failingPort, "Rex");
  const { routine } = await h.json("/api/routines", {
    method: "POST",
    body: JSON.stringify({ targetId: rex.id, targetKind: "agent", name: "Morning sweep", prompt: "Sweep the inbox", time: "06:00" }),
  });
  for (let run = 1; run <= 3; run++) {
    const started = await h.fetch(`/api/routines/${routine.id}/run`, { method: "POST" });
    assert.equal(started.status, 202);
    const ended = await waitFor(async () => {
      const found = (await h.json("/api/routines")).routines.find((r: any) => r.id === routine.id);
      return found.runs?.filter((r: any) => r.state === "failed").length === run ? found : null;
    }, 20_000);
    assert.ok(ended, `run ${run} never finished`);
    await idle(h, rex);
  }
  const stopped = (await h.json("/api/routines")).routines.find((r: any) => r.id === routine.id);
  assert.equal(stopped.failures, 3);
  assert.ok(stopped.failing?.at);
  assert.match(stopped.failing.error, /having a moment|did not finish/);
  assert.equal(stopped.enabled, true, "still on: only its schedule waits");
  assert.equal(stopped.nextRunAt === null || typeof stopped.nextRunAt === "number", true);
  const notices = (await messagesOf(h, rex)).filter((m) => m.failing);
  assert.equal(notices.length, 1, "said once");
  assert.deepEqual(notices[0].failing, { kind: "routine", id: routine.id, name: "Morning sweep" });
  // one incident for the routine, counted, not three
  const about = (await listed()).filter((i) => i.subject === `routine:${routine.id}`);
  assert.equal(about.length, 1);
  assert.equal(about[0].count, 3);
  // Activity and the desk's list say it stopped
  assert.ok((await h.json("/api/activity")).failing.some((f: any) => f.id === routine.id));
  // the person pausing it is having a say: the failing state goes
  const paused = await h.json(`/api/routines/${routine.id}`, { method: "PATCH", body: JSON.stringify({ enabled: false }) });
  assert.equal(paused.routine.failing, undefined);
  assert.equal(paused.routine.failures, undefined);
  assert.ok(!(await h.json("/api/activity")).failing.some((f: any) => f.id === routine.id));
});

test("switched off, the desk raises nothing", async () => {
  await desk({ enabled: false });
  const before = (await listed()).length;
  const off = await agentOn(h, failingPort, "Quill");
  await h.fetch(`/api/bots/${off.id}/messages`, { method: "POST", body: JSON.stringify({ text: "Try this" }) });
  await waitFor(async () => (await messagesOf(h, off)).some((m) => m.kind === "notice" && /stopped here|could not answer|having a moment/.test(m.text ?? "")) || null);
  await idle(h, off);
  assert.equal((await listed()).length, before);
  assert.ok(!(await messagesOf(h, off)).some((m) => m.incident));
  await desk({ enabled: true });
});

for (const onlyMarker of [false, true]) test(`a reset marker is never claimed by an incident (${onlyMarker ? "marker only" : "preceding error"})`, async (t) => {
  const c = await controlledChain(t);
  const lead = await c.hire("Review lead");
  await c.h.json("/api/config", { method: "PUT", body: JSON.stringify({ incidents: { enabled: true, lead: lead.id } }) });
  const worker = await agentOn(c.h, failingPort, "Sample worker");
  await c.h.json(`/api/bots/${worker.id}/messages`, { method: "POST", body: JSON.stringify({ text: "Prepare the sample" }) });
  const leadTurn = await c.turnAfter(0);
  const incident = await waitFor(async () => (await c.h.json("/api/incidents")).incidents.find((i: any) => i.where.laneId === worker.threadId && i.state === "with-lead"));
  assert.ok(incident); assert.ok(await idle(c.h, worker));
  const prior = await messagesOf(c.h, worker);
  const error = prior.findLast((m) => m.kind === "notice" && !m.deleted);
  assert.ok(error, "the actual engine failure left no notice");
  if (onlyMarker) for (const row of prior.filter((m) => m.kind === "notice")) {
    assert.equal((await c.h.fetch(`/api/threads/${worker.threadId}/messages/${row.id}`, { method: "DELETE" })).status, 200);
  }
  assert.equal((await c.h.fetch(`/api/bots/${worker.id}/tasks/${worker.threadId}/fresh`, { method: "POST" })).status, 200);
  const marker = (await messagesOf(c.h, worker)).findLast((m) => m.sessionReset);
  assert.ok(marker);
  assert.equal((await c.agent(leadTurn, `/api/incidents/${incident.id}/tell`, { text: "Please check the sample service." })).status, 202);
  const after = await messagesOf(c.h, worker);
  assert.deepEqual(after.find((m) => m.id === marker.id), marker, "the failure mutated the reset's identity, words or flag");
  const card = after.find((m) => m.incident?.kind === "needs-you"); assert.ok(card);
  assert.equal(card.id === error.id, !onlyMarker);
  assert.notEqual(card.id, marker.id); assert.equal(card.sessionReset, undefined);
  assert.ok(noticeFor(card, { focused: false, selectedId: "", threadId: worker.threadId, bot: { id: worker.id, name: "Sample worker" } })?.urgent);
  await c.finish(leadTurn, lead);
});
