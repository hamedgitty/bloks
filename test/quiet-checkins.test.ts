// Quiet runs: a check-in's agent is told, in the turn and not the system
// prompt, that it may answer QUIET when nothing needs the person, and a
// run that does is kept out of their way. A manual run still owes the person an outcome.
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

test("an explicitly run check-in owes an honest outcome rather than a marker", async (t) => {
  const { h, p, bot } = await setup(t);
  const routine = await file(h, { targetId: bot.id, targetKind: "agent", name: "Inbox", every: 30 });
  p.state.replies.push("Quiet.");
  const after = await runIt(h, bot, routine.id);
  assert.equal(p.lastAsked(), `(Your routine "Inbox" was run by hand. ${QUIET_ASK})\n\nAnything urgent in the inbox?`);
  assert.equal(after.runs[0].state, "failed");
  assert.equal(after.runs[0].quiet, undefined);
  assert.equal(after.runs[0].error, "The agent ended this turn without an answer.");
  assert.equal(after.lastReport, undefined);
  const said = await messagesOf(h, bot);
  assert.ok(!said.some((m: any) => m.role === "bot" && /^quiet[.!…]*$/i.test(m.text?.trim() ?? "")));
  assert.equal(said.filter((m: any) => m.text === after.runs[0].error).length, 1);
  assert.equal((await lane(h, bot)).unread, true);
  const shown = await frames(h);
  assert.ok(!shown.some((f: any) => f.kind === "runtime" && (f.event?.delta === "Quiet." || f.event?.text === "Quiet.")));
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

test("manual time-of-day runs cannot silently lose an answer with or without the quiet flag", async (t) => {
  const { h, p, bot } = await setup(t);
  for (const quiet of [false, true]) {
    const routine = await file(h, { targetId: bot.id, targetKind: "agent", time: later(), quiet });
    p.state.replies.push("QUIET");
    const result = await runIt(h, bot, routine.id);
    assert.equal(result.runs[0].state, "failed");
    assert.equal(result.runs[0].error, "The agent ended this turn without an answer.");
    assert.equal(result.runs[0].quiet, undefined);
    assert.ok((await lane(h, bot)).unread);
  }
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
