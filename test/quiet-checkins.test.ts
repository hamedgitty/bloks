// Quiet runs: a check-in's agent is told, in the turn and not the system
// prompt, that it may answer QUIET when nothing needs the person, and a
// run that does is kept out of their way. A time-of-day routine that did
// not ask for this behaves exactly as it always has.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test, type TestContext } from "node:test";

import { QUIET_ASK } from "../server/routines.ts";
import { startHarness, type Harness } from "./helpers/server.ts";
import { agentOn, idle, messagesOf, waitFor } from "./helpers/turns.ts";

const post = (body: unknown) => ({ method: "POST", body: JSON.stringify(body) });

/** A chat-completions stand-in that answers each turn with the next
 * line it was given, and keeps what it was sent. */
async function replier(t: TestContext) {
  const state = { replies: [] as string[], calls: [] as any[] };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url?.endsWith("/models")) return res.end(JSON.stringify({ data: [{ id: "grok-4" }] }));
      const sent = JSON.parse(body);
      state.calls.push(sent);
      const content = state.replies.shift() ?? "Done.";
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const port = (server.address() as { port: number }).port;
  /** The words the latest turn was sent last: what the routine said. */
  const lastAsked = () => {
    const messages = state.calls.at(-1)?.messages ?? [];
    const said = messages.filter((m: any) => m.role === "user").at(-1)?.content;
    return typeof said === "string" ? said : JSON.stringify(said);
  };
  return { state, port, lastAsked };
}

async function setup(t: TestContext) {
  const h = await startHarness();
  t.after(() => h.stop());
  const p = await replier(t);
  const bot = await agentOn(h, p.port, "Sentry");
  return { h, p, bot };
}

const later = () => {
  const at = new Date(Date.now() + 60 * 60_000);
  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
};

async function file(h: Harness, body: Record<string, unknown>) {
  const res = await h.fetch("/api/routines", post({ prompt: "Anything urgent in the inbox?", days: [], ...body }));
  assert.equal(res.status, 201, await res.clone().text());
  return (await res.json()).routine as { id: string };
}

/** Runs it by hand and waits for its turn to end. */
async function runIt(h: Harness, bot: { id: string }, routineId: string) {
  assert.equal((await h.fetch(`/api/routines/${routineId}/run`, post({}))).status, 202);
  await new Promise((r) => setTimeout(r, 150));
  assert.ok(await idle(h, bot), h.logs());
  // the run is closed in the same step that settles the lane; give the
  // write a moment to land before reading it back
  return waitFor(async () => {
    const routine = (await h.json("/api/routines")).routines.find((r: any) => r.id === routineId);
    return routine?.runs?.[0]?.state !== "running" ? routine : null;
  });
}

const lane = async (h: Harness, bot: { id: string; threadId: string }) =>
  (await h.json("/api/bots")).bots.find((b: any) => b.id === bot.id).tasks.find((t: any) => t.id === bot.threadId);

/** Every frame still in the server's replay ring. */
async function frames(h: Harness): Promise<any[]> {
  const res = await h.fetch("/api/events?since=0");
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let seen = "";
  const deadline = Date.now() + 800;
  while (Date.now() < deadline) {
    const next = await Promise.race([reader.read(), new Promise<null>((r) => setTimeout(() => r(null), deadline - Date.now()))]);
    if (!next || next.done) break;
    seen += decoder.decode(next.value, { stream: true });
  }
  await reader.cancel().catch(() => {});
  return seen.split("\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6)));
}

test("a check-in that answers QUIET is folded away: no unread, no ledger line, a quiet run", async (t) => {
  const { h, p, bot } = await setup(t);
  const routine = await file(h, { targetId: bot.id, targetKind: "agent", name: "Inbox", every: 30, activeHours: { from: "09:00", to: "18:00" } });
  await h.fetch(`/api/bots/${bot.id}/tasks/${bot.threadId}`, { method: "PATCH", body: JSON.stringify({ unread: false }) });
  p.state.replies.push("Quiet.");

  const after = await runIt(h, bot, routine.id);
  // told in the turn, in so many words, and never in the standing prompt
  assert.equal(p.lastAsked(), `(Your routine "Inbox" was run by hand. ${QUIET_ASK})\n\nAnything urgent in the inbox?`);
  const system = p.state.calls.at(-1).messages.find((m: any) => m.role === "system")?.content ?? "";
  assert.doesNotMatch(String(system), /QUIET/);

  assert.equal(after.runs[0].state, "ok");
  assert.equal(after.runs[0].quiet, true);
  assert.equal(after.runs[0].summary, undefined, "one word is not a summary");
  assert.equal(after.lastReport, undefined, "nothing was reported");

  const said = await messagesOf(h, bot);
  const prompt = said.find((m: any) => m.role === "user" && m.text === "Anything urgent in the inbox?");
  const answer = said.find((m: any) => m.role === "bot" && m.text === "Quiet.");
  assert.deepEqual(prompt.routine, { name: "Inbox", manual: true, quiet: true });
  assert.equal(prompt.quiet, true);
  assert.equal(answer.quiet, true);
  assert.ok(!(await lane(h, bot)).unread, "a quiet check-in marked the lane unread");
  assert.ok(!(await h.json("/api/bots")).bots.find((b: any) => b.id === bot.id).unread);

  // the answer's frame was already marked quiet, and held for the end of
  // the check-in, so no client ever had it as news
  const shown = (await frames(h)).filter((f) => f.kind === "message" && f.message?.id === answer.id);
  assert.equal(shown.length, 1);
  assert.equal(shown[0].message.quiet, true);
  assert.equal(shown[0].checkIn, true);

  const { entries } = await h.json("/api/ledger");
  assert.ok(!entries.some((e: any) => e.kind === "routine.ran"), "a quiet run went into the record");
});

test("a check-in with something to say is news like any reply, and its next run is told what it said", async (t) => {
  const { h, p, bot } = await setup(t);
  const routine = await file(h, { targetId: bot.id, targetKind: "agent", every: 60 });
  await h.fetch(`/api/bots/${bot.id}/tasks/${bot.threadId}`, { method: "PATCH", body: JSON.stringify({ unread: false }) });
  p.state.replies.push("Two invoices are overdue: Acme and Globex.", "QUIET", "Still overdue.");

  const first = await runIt(h, bot, routine.id);
  assert.equal(p.lastAsked(), `(Your routine was run by hand. ${QUIET_ASK})\n\nAnything urgent in the inbox?`, "nothing to recall yet");
  assert.equal(first.runs[0].quiet, undefined);
  assert.equal(first.runs[0].summary, "Two invoices are overdue: Acme and Globex.");
  assert.equal(first.lastReport.summary, "Two invoices are overdue: Acme and Globex.");
  assert.equal((await lane(h, bot)).unread, true, "a check-in that reported is something to read");
  const report = (await messagesOf(h, bot)).find((m: any) => m.text?.startsWith("Two invoices"));
  assert.equal(report.quiet, undefined);
  const { entries } = await h.json("/api/ledger");
  assert.ok(entries.some((e: any) => e.kind === "routine.ran"), "a run that reported is in the record");

  // the next one carries what was reported, and a quiet run in between
  // does not take its place
  await runIt(h, bot, routine.id);
  const note = "(Last time this routine reported: Two invoices are overdue: Acme and Globex.)";
  assert.equal(p.lastAsked(), `(Your routine was run by hand. ${QUIET_ASK})\n\n${note}\n\nAnything urgent in the inbox?`);
  assert.equal((await lane(h, bot)).unread, true, "the quiet run left the unread reply unread");
  await runIt(h, bot, routine.id);
  assert.equal(p.lastAsked(), `(Your routine was run by hand. ${QUIET_ASK})\n\n${note}\n\nAnything urgent in the inbox?`);
  // and what the person sees stays the routine's own prompt
  assert.ok((await messagesOf(h, bot)).filter((m: any) => m.role === "user").every((m: any) => m.text === "Anything urgent in the inbox?"));
});

test("a time-of-day routine is untouched unless it asks to be quiet", async (t) => {
  const { h, p, bot } = await setup(t);
  const plain = await file(h, { targetId: bot.id, targetKind: "agent", name: "Brief", time: later() });
  await h.fetch(`/api/bots/${bot.id}/tasks/${bot.threadId}`, { method: "PATCH", body: JSON.stringify({ unread: false }) });
  p.state.replies.push("QUIET");
  const ran = await runIt(h, bot, plain.id);
  assert.equal(p.lastAsked(), '(Your routine "Brief" was run by hand.)\n\nAnything urgent in the inbox?');
  assert.equal(ran.runs[0].quiet, undefined, "it was never told it could be quiet");
  const said = await messagesOf(h, bot);
  assert.deepEqual(said.find((m: any) => m.role === "user").routine, { name: "Brief", manual: true });
  assert.ok(said.every((m: any) => m.quiet === undefined));
  assert.equal((await lane(h, bot)).unread, true);

  const asked = await file(h, { targetId: bot.id, targetKind: "agent", name: "Brief if needed", time: later(), quiet: true });
  await h.fetch(`/api/bots/${bot.id}/tasks/${bot.threadId}`, { method: "PATCH", body: JSON.stringify({ unread: false }) });
  p.state.replies.push("QUIET");
  const quiet = await runIt(h, bot, asked.id);
  assert.equal(p.lastAsked(), `(Your routine "Brief if needed" was run by hand. ${QUIET_ASK})\n\nAnything urgent in the inbox?`);
  assert.equal(quiet.runs[0].quiet, true);
  assert.ok(!(await lane(h, bot)).unread);
});

test("a check-in that fails is not quiet, whatever it said", async (t) => {
  const h = await startHarness();
  t.after(() => h.stop());
  // an engine that refuses every turn
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url?.endsWith("/models")) return res.end(JSON.stringify({ data: [{ id: "grok-4" }] }));
      res.statusCode = 500;
      res.end(JSON.stringify({ error: { message: "the engine is having a moment" } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const bot = await agentOn(h, (server.address() as { port: number }).port, "Sentry");
  const routine = await file(h, { targetId: bot.id, targetKind: "agent", every: 30 });
  await h.fetch(`/api/bots/${bot.id}/tasks/${bot.threadId}`, { method: "PATCH", body: JSON.stringify({ unread: false }) });
  const after = await runIt(h, bot, routine.id);
  assert.equal(after.runs[0].state, "failed");
  assert.equal(after.runs[0].quiet, undefined);
  assert.equal((await lane(h, bot)).unread, true, "a failed check-in is something to see");
  assert.ok((await messagesOf(h, bot)).every((m: any) => m.quiet === undefined));
});
