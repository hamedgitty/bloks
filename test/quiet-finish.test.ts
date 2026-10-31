// `bloks quiet` (QA-198): an agent finishes the turn it is in quietly,
// when nothing in it needs the person. The server decides: it accepts
// only while nothing of the turn has reached the person, keeps what the
// engine still writes out of their attention, gives way to anything for
// them that comes after, and acts only on the turn it was taken in.
// The bare quiet word is unchanged (test/quiet-preview-http.test.ts).
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import { phoneRelay, previewOf, quietFixture, settledIn, type QuietBot } from "./helpers/quiet-finish.ts";
import { waitFor } from "./helpers/turns.ts";

const pause = (ms = 400) => new Promise((resolve) => setTimeout(resolve, ms));

/** What reached a running turn as a steer. */
const readSteers = (f: { home: string }) => {
  const file = join(f.home, "steers.jsonl");
  return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { pid: number; text: string }) : [];
};

/** The rows after the last prompt that started a turn in the lane. */
async function turnRows(f: Awaited<ReturnType<typeof quietFixture>>, bot: QuietBot, from = 0) {
  const rows = (await f.messages(bot)).slice(from);
  let at = rows.length - 1;
  while (at >= 0 && !(rows[at].role === "user" && !rows[at].midTurn && !rows[at].queued)) at--;
  return rows.slice(at + 1);
}

/** Bot B's turn started by bot A's `bloks say`: nobody is waiting on it. */
async function fromAgent(f: Awaited<ReturnType<typeof quietFixture>>, a: QuietBot, b: QuietBot, words = "Check the example inventory") {
  const before = f.turns().length;
  const res = await f.h.fetch(`/api/bots/${a.id}/messages`, { method: "POST", body: JSON.stringify({ text: "Ask the worker to check the inventory" }) });
  assert.ok(res.ok);
  const sender = await f.turn(before);
  const said = await f.call(sender, "POST", `/api/bots/${b.id}/messages`, { text: words });
  assert.ok(said.status < 300, JSON.stringify(said));
  const worker = await f.turn(before + 1);
  f.end(sender, "Asked.");
  assert.ok(await f.idle(a));
  return worker;
}

test("an agent's turn finished with bloks quiet ends without a message, an unread mark, a settled reply or a wake", async (t) => {
  const f = await quietFixture(t);
  const phone = await phoneRelay(t, f.h);
  const a = await f.hire("Sender"), b = await f.hire("Worker");
  const frames = await f.stream();
  const worker = await fromAgent(f, a, b);
  assert.match(worker.text, /run `bloks quiet` before writing any text/, "a credentialed turn is told about the command");
  const done = f.tool(worker, "bloks quiet");
  const cli = await promisify(execFile)(process.execPath, [fileURLToPath(new URL("../bin/bloks.mjs", import.meta.url)), "quiet"], {
    env: { HOME: f.home, BLOKS_URL: f.h.url, BLOKS_TOKEN: worker.token }, timeout: 15000,
  });
  const accepted = JSON.parse(cli.stdout);
  assert.equal(accepted.quiet, "accepted");
  assert.equal(accepted.effect, "when this turn ends");
  const again = await f.quiet(worker, b);
  assert.equal(again.status, 200);
  assert.equal(again.body.already, true, "a repeated call is the same acceptance");
  done();
  f.text(worker, "Done.");
  f.end(worker, "Done.");
  assert.ok(await f.idle(b));
  await pause();
  const said = (await turnRows(f, b)).filter((m) => m.role === "bot" && m.kind === "text");
  assert.deepEqual(said.map((m) => [m.text, m.quiet]), [["Done.", true]], "what the engine wrote after the call is kept quiet");
  assert.equal(previewOf(frames, b.threadId), "", "nothing was previewed");
  assert.deepEqual(settledIn(frames, b.threadId), [], "no settled reply");
  assert.equal(Boolean((await f.lane(b)).unread), false, "no unread mark");
  assert.deepEqual(phone.replies(), [], "no answer-ready wake");
});

/** A check-in by hand, as in test/quiet-checkins.test.ts, on a quiet routine. */
async function checkIn(f: Awaited<ReturnType<typeof quietFixture>>, b: QuietBot) {
  const made = await f.h.fetch("/api/routines", { method: "POST", body: JSON.stringify({ prompt: "Anything urgent in the example inbox?", days: [], targetId: b.id, targetKind: "agent", name: "Inbox", every: 30, activeHours: { from: "09:00", to: "18:00" } }) });
  assert.equal(made.status, 201, await made.clone().text());
  const { routine } = await made.json();
  await f.h.fetch(`/api/bots/${b.id}/tasks/${b.threadId}`, { method: "PATCH", body: JSON.stringify({ unread: false }) });
  const before = f.turns().length;
  assert.equal((await f.h.fetch(`/api/routines/${routine.id}/run`, { method: "POST", body: "{}" })).status, 202);
  const run = await f.turn(before);
  const finished = async () => {
    assert.ok(await f.idle(b));
    return waitFor(async () => {
      const now = (await f.h.json("/api/routines")).routines.find((r: any) => r.id === routine.id);
      return now?.runs?.[0]?.state !== "running" ? now : null;
    });
  };
  return { run, finished };
}

/** Waits for a text the engine wrote to be saved, and returns its row. */
const saved = (f: Awaited<ReturnType<typeof quietFixture>>, bot: QuietBot, words: string) =>
  waitFor(async () => (await f.messages(bot)).findLast((m) => m.role === "bot" && m.kind === "text" && m.text === words) ?? null);

test("a check-in finished with bloks quiet is folded away like one that answered QUIET", async (t) => {
  const f = await quietFixture(t);
  const phone = await phoneRelay(t, f.h);
  const b = await f.hire("Worker");
  const { run, finished } = await checkIn(f, b);
  assert.match(run.text, /run `bloks quiet` before writing any text/);
  const done = f.tool(run, "bloks quiet");
  const accepted = await f.quiet(run, b);
  assert.equal(accepted.status, 200, JSON.stringify(accepted));
  done();
  // its own tool calls after the finish are not something for the person
  f.tool(run, "ls example")();
  f.text(run, "Nothing new.");
  f.end(run, "Nothing new.");
  const routine = await finished();
  assert.equal(routine.runs[0].state, "ok");
  assert.equal(routine.runs[0].quiet, true, "the run is a quiet one");
  assert.equal(routine.lastReport, undefined, "nothing was reported");
  await pause();
  const rows = await f.messages(b);
  const prompt = rows.findLast((m) => m.role === "user" && m.text === "Anything urgent in the example inbox?");
  assert.equal(prompt.quiet, true, "its prompt is folded");
  const own = rows.slice(rows.indexOf(prompt) + 1).filter((m) => m.role === "bot");
  assert.ok(own.some((m) => m.kind === "activity") && own.some((m) => m.kind === "text"), JSON.stringify(own.map((m) => m.kind)));
  assert.deepEqual(own.filter((m) => !m.quiet).map((m) => m.kind), [], "its call and its words are folded with it");
  assert.equal(Boolean((await f.lane(b)).unread), false);
  const { entries } = await f.h.json("/api/ledger");
  assert.ok(!entries.some((e: any) => e.kind === "routine.ran"), "a quiet run went into the record");
  assert.deepEqual(phone.replies(), []);
});

test("a check-in that already said something is not finished quietly, and its report is delivered", async (t) => {
  const f = await quietFixture(t);
  const b = await f.hire("Worker");
  const { run, finished } = await checkIn(f, b);
  f.text(run, "Two example invoices are overdue.");
  assert.ok(await saved(f, b, "Two example invoices are overdue."));
  const refused = await f.quiet(run, b);
  assert.equal(refused.status, 409);
  assert.equal(refused.body.reason, "already_shown");
  assert.match(refused.body.error, /do not answer QUIET/);
  f.end(run, "Two example invoices are overdue.");
  const routine = await finished();
  assert.notEqual(routine.runs[0].quiet, true);
  await pause();
  const report = await saved(f, b, "Two example invoices are overdue.");
  assert.notEqual(report.quiet, true);
  assert.equal(Boolean((await f.lane(b)).unread), true, "the report is news");
});

test("a turn the person started cannot be finished quietly", async (t) => {
  const f = await quietFixture(t);
  const b = await f.hire("Worker");
  const before = f.turns().length;
  assert.ok((await f.h.fetch(`/api/bots/${b.id}/messages`, { method: "POST", body: JSON.stringify({ text: "What is in the example inbox?" }) })).ok);
  const turn = await f.turn(before);
  assert.doesNotMatch(turn.text, /bloks quiet/, "the person's own turn is not told about it");
  const refused = await f.quiet(turn, b);
  assert.equal(refused.status, 409);
  assert.equal(refused.body.reason, "person_in_turn");
  f.text(turn, "Two example messages.");
  f.end(turn, "Two example messages.");
  assert.ok(await f.idle(b));
  assert.notEqual((await saved(f, b, "Two example messages.")).quiet, true);
});

test("the person's words after the finish wait for a turn of their own, which answers them once", async (t) => {
  const f = await quietFixture(t);
  const phone = await phoneRelay(t, f.h);
  const a = await f.hire("Sender"), b = await f.hire("Worker");
  const frames = await f.stream();
  const worker = await fromAgent(f, a, b);
  assert.equal((await f.quiet(worker, b)).status, 200);
  const before = f.turns().length;
  // the person's one tap for "into this turn now": it still waits
  const sent = await f.h.fetch(`/api/bots/${b.id}/messages`, { method: "POST", body: JSON.stringify({ text: "And the example calendar?", delivery: "now" }) });
  assert.ok(sent.ok, await sent.clone().text());
  await pause();
  assert.equal(f.turns().length, before, "no turn yet");
  assert.ok(!readSteers(f).some((s) => /example calendar/.test(s.text)), "the words never joined the finished turn");
  f.text(worker, "Done.");
  f.end(worker, "Done.");
  const next = await f.turn(before);
  assert.match(next.text, /And the example calendar\?/);
  assert.equal((await saved(f, b, "Done.")).quiet, true, "the finished turn stayed quiet");
  f.text(next, "Nothing on the example calendar.");
  f.end(next, "Nothing on the example calendar.");
  assert.ok(await f.idle(b));
  await pause();
  assert.notEqual((await saved(f, b, "Nothing on the example calendar.")).quiet, true);
  assert.equal(Boolean((await f.lane(b)).unread), true);
  assert.equal(settledIn(frames, b.threadId).length, 1, "one settled reply, for the person's turn");
  assert.equal(phone.replies().length, 1, "one answer-ready wake");
});

test("a file the turn shares after the finish cancels it, and gives back what was held", async (t) => {
  const f = await quietFixture(t);
  const a = await f.hire("Sender"), b = await f.hire("Worker");
  const frames = await f.stream();
  const worker = await fromAgent(f, a, b);
  assert.equal((await f.quiet(worker, b)).status, 200);
  f.text(worker, "Here is the example report.");
  assert.equal((await saved(f, b, "Here is the example report.")).quiet, true, "held while the finish stands");
  const shared = await f.call(worker, "POST", `/api/bots/${b.id}/artifacts?name=example-report.md`, undefined, "# Example report\n");
  assert.ok(shared.status < 300, JSON.stringify(shared));
  assert.ok(await waitFor(async () => (await saved(f, b, "Here is the example report.")).quiet === undefined ? true : null), "the held text is given back");
  f.text(worker, "Shared it.");
  f.end(worker, "Shared it.");
  assert.ok(await f.idle(b));
  await pause();
  assert.notEqual((await saved(f, b, "Shared it.")).quiet, true);
  assert.equal(Boolean((await f.lane(b)).unread), true);
  // an agent's turn settles as a reply; only a turn the person waits on
  // wakes the phone as well (answerDue), and that is unchanged
  assert.equal(settledIn(frames, b.threadId).length, 1, "the turn settles as a reply");
  const again = await f.h.fetch(`/api/bots/${b.id}/tasks/${b.threadId}/quiet`, { method: "POST" });
  assert.equal(again.status, 403, "the person cannot finish a turn for the agent");
});

test("a question for the person after the finish cancels it", async (t) => {
  const f = await quietFixture(t);
  const a = await f.hire("Sender"), b = await f.hire("Worker");
  const worker = await fromAgent(f, a, b);
  assert.equal((await f.quiet(worker, b)).status, 200);
  f.text(worker, "Checking first.");
  assert.equal((await saved(f, b, "Checking first.")).quiet, true);
  await f.ask(worker, "Go ahead with the example change?");
  assert.ok(await waitFor(async () => (await saved(f, b, "Checking first.")).quiet === undefined ? true : null), "the held text is given back");
  const rows = await turnRows(f, b);
  assert.ok(rows.some((m) => m.role === "bot" && m.kind !== "text" && m.kind !== "activity" && !m.quiet), JSON.stringify(rows.map((m) => [m.kind, m.quiet])));
  const later = await f.quiet(worker, b);
  assert.equal(later.status, 409);
  assert.equal(later.body.reason, "superseded");
  f.text(worker, "The next example step needs your answer.");
  f.end(worker, "Asked.");
  assert.ok(await f.idle(b));
  await pause();
  assert.equal(Boolean((await f.lane(b)).unread), true, JSON.stringify([await f.lane(b), (await turnRows(f, b)).map((m) => [m.kind, m.text, m.quiet, m.state])]));
  assert.notEqual((await saved(f, b, "The next example step needs your answer.")).quiet, true);
});

test("queued person input does not cancel a quiet check-in and gets its own answer once", async (t) => {
  const f = await quietFixture(t), phone = await phoneRelay(t, f.h);
  const b = await f.hire("Worker"), frames = await f.stream();
  const { run } = await checkIn(f, b);
  assert.equal((await f.quiet(run, b)).status, 200);
  const sent = await f.h.fetch(`/api/bots/${b.id}/messages`, { method: "POST", body: JSON.stringify({ text: "Check the example calendar", delivery: "now" }) });
  assert.equal((await sent.json()).queued, true);
  assert.equal(readSteers(f).filter((s) => s.pid === run.pid).length, 0);
  f.text(run, "Nothing new.");
  f.end(run, "Nothing new.");
  const next = await f.turn(run.n + 1);
  const routine: any = await waitFor(async () => {
    const row = (await f.h.json("/api/routines")).routines.find((r: any) => r.targetId === b.id);
    return row?.runs?.[0]?.state !== "running" ? row : null;
  });
  assert.equal(routine.runs[0].quiet, true);
  assert.equal((await saved(f, b, "Nothing new.")).quiet, true);
  assert.deepEqual(settledIn(frames, b.threadId), []);
  f.text(next, "The example calendar is clear.");
  f.end(next, "The example calendar is clear.");
  assert.ok(await f.idle(b));
  await pause();
  assert.equal(settledIn(frames, b.threadId).length, 1);
  assert.equal(phone.replies().length, 1);
  assert.equal((await f.messages(b)).filter((m) => m.role === "user" && m.text === "Check the example calendar").length, 1);
});

test("handover after quiet restores held words and lets the backup answer normally", async (t) => {
  const f = await quietFixture(t);
  const a = await f.hire("Sender"), b = await f.hire("Worker"), frames = await f.stream();
  assert.ok((await f.h.fetch(`/api/bots/${b.id}`, { method: "PATCH", body: JSON.stringify({ backupSelection: { instanceId: "spare", model: "claude-sonnet-5" } }) })).ok);
  const worker = await fromAgent(f, a, b);
  assert.equal((await f.quiet(worker, b)).status, 200);
  f.text(worker, "The partial example result.");
  assert.equal((await saved(f, b, "The partial example result.")).quiet, true);
  f.end(worker, "You've hit your usage limit", true);
  const backup = await f.turn(worker.n + 1);
  assert.notEqual((await saved(f, b, "The partial example result.")).quiet, true);
  f.text(backup, "The example report is ready.");
  f.end(backup, "The example report is ready.");
  assert.ok(await f.idle(b));
  await pause();
  assert.notEqual((await saved(f, b, "The example report is ready.")).quiet, true);
  assert.equal(settledIn(frames, b.threadId).length, 1, "only the completed owner reply settles");
});

test("a file first found at completion cancels quiet before its restored reply settles", async (t) => {
  const f = await quietFixture(t);
  const phone = await phoneRelay(t, f.h);
  const b = await f.hire("Worker"), frames = await f.stream();
  const { run, finished } = await checkIn(f, b);
  assert.equal((await f.quiet(run, b)).status, 200);
  f.text(run, "Here is the example report.");
  assert.equal((await saved(f, b, "Here is the example report.")).quiet, true);
  const dir = join(f.home, ".bloks/artifacts", b.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "example-report.md"), "# Example report\n");
  f.end(run, "Here is the example report.");
  const routine: any = await finished();
  await pause();
  assert.notEqual(routine.runs[0].quiet, true);
  assert.notEqual((await saved(f, b, "Here is the example report.")).quiet, true);
  assert.ok((await f.messages(b)).some((m) => m.kind === "artifact" && !m.quiet));
  assert.equal(Boolean((await f.lane(b)).unread), true);
  assert.equal(settledIn(frames, b.threadId).length, 1, "restored words settle once");
  assert.equal(phone.replies().length, 0, "routine output follows the existing no-answer-wake policy");
});

test("a late write made with an earlier turn's credential leaves the next turn's finish standing", async (t) => {
  const f = await quietFixture(t);
  const a = await f.hire("Sender"), b = await f.hire("Worker");
  const frames = await f.stream();
  const first = await fromAgent(f, a, b);
  // a card from the first turn, its body still on its way when it ends
  const port = new URL(f.h.url).port;
  const held = request({ host: "127.0.0.1", port, method: "POST", path: `/api/bots/${b.id}/show`, headers: { authorization: `Bearer ${first.token}`, "content-type": "application/json" } });
  const answered = new Promise<number>((resolve, reject) => { held.on("response", (res) => { res.resume(); resolve(res.statusCode ?? 0); }); held.on("error", reject); });
  held.write("{\"kind\":\"decision\",");
  await pause();
  f.text(first, "First answer.");
  f.end(first, "First answer.");
  assert.ok(await f.idle(b));
  await pause();
  const settledBefore = settledIn(frames, b.threadId).length;
  const second = await fromAgent(f, a, b, "Check the example inventory again");
  assert.equal((await f.quiet(second, b)).status, 200);
  held.end("\"data\":{\"question\":\"Which example?\",\"options\":[{\"label\":\"One\"},{\"label\":\"Two\"}]}}");
  assert.equal(await answered, 201);
  assert.ok(await waitFor(async () => (await f.messages(b)).some((m) => m.kind === "component") ? true : null));
  f.text(second, "Done.");
  f.end(second, "Done.");
  assert.ok(await f.idle(b));
  await pause();
  assert.equal((await saved(f, b, "Done.")).quiet, true, "the second turn finished quietly");
  assert.equal(settledIn(frames, b.threadId).length, settledBefore, "and settled no reply");
  const stale = await f.h.fetch(`/api/bots/${b.id}/tasks/${b.threadId}/quiet`, { method: "POST", headers: { authorization: `Bearer ${first.token}` } });
  assert.equal(stale.status, 401, "an ended turn's credential is not recognized");
});

test("a turn that fails after the finish is reported as failed", async (t) => {
  const f = await quietFixture(t);
  const a = await f.hire("Sender"), b = await f.hire("Worker");
  const worker = await fromAgent(f, a, b);
  assert.equal((await f.quiet(worker, b)).status, 200);
  f.text(worker, "The partial example result.");
  assert.equal((await saved(f, b, "The partial example result.")).quiet, true);
  f.end(worker, "The example tool crashed.", true);
  assert.ok(await f.idle(b));
  await pause();
  const rows = await turnRows(f, b);
  const notice = rows.find((m) => m.role === "bot" && m.kind === "notice" && !m.compaction);
  assert.ok(notice, JSON.stringify(rows.map((m) => [m.kind, m.text, m.quiet])));
  assert.notEqual(notice.quiet, true, "the failure is not folded away");
  assert.notEqual((await saved(f, b, "The partial example result.")).quiet, true, "failure restores prior words");
});

test("a webhook's turn may finish quietly; another lane's, or nobody's, may not", async (t) => {
  const f = await quietFixture(t);
  const phone = await phoneRelay(t, f.h);
  const a = await f.hire("Sender"), b = await f.hire("Worker");
  const { webhook } = await f.h.json("/api/webhooks", { method: "POST", body: JSON.stringify({ botId: b.id, name: "Example source" }) });
  const before = f.turns().length;
  const fired = await f.h.fetch(`/hook/${webhook.token}`, { method: "POST", body: JSON.stringify({ event: "nothing new" }) });
  assert.equal(fired.status, 202, await fired.clone().text());
  const turn = await f.turn(before);
  // A's turn, running at the same time, has no say over B's
  const sender = await (async () => {
    const n = f.turns().length;
    assert.ok((await f.h.fetch(`/api/bots/${a.id}/messages`, { method: "POST", body: JSON.stringify({ text: "Look at the worker" }) })).ok);
    return f.turn(n);
  })();
  const other = await f.quiet(sender, b);
  assert.equal(other.status, 403, JSON.stringify(other));
  f.end(sender, "Looked.");
  const accepted = await f.quiet(turn, b);
  assert.equal(accepted.status, 200, JSON.stringify(accepted));
  f.text(turn, "Nothing new.");
  f.end(turn, "Nothing new.");
  assert.ok(await f.idle(b));
  await pause();
  assert.equal((await saved(f, b, "Nothing new.")).quiet, true);
  assert.equal(Boolean((await f.lane(b)).unread), false);
  assert.deepEqual(phone.replies(), []);
});

const decision = { kind: "decision", data: { question: "Which example?", options: [{ label: "One" }, { label: "Two" }] } };
const team = "Here is the example plan.\n\n```bloks-team\n" + JSON.stringify({ room: "Example", brief: "An example brief", members: ["Ana", "Bo"].map((name) => ({ name, title: "Owns an example", description: "Example instructions", skills: ["Example skill"] })) }) + "\n```";

test("a card the turn shows, or a team it proposes, after the finish cancels it; one shown before refuses it", async (t) => {
  const f = await quietFixture(t);
  const a = await f.hire("Sender"), b = await f.hire("Worker");
  const frames = await f.stream();
  // a card after the finish
  let worker = await fromAgent(f, a, b);
  assert.equal((await f.quiet(worker, b)).status, 200);
  f.text(worker, "One question first.");
  assert.equal((await saved(f, b, "One question first.")).quiet, true);
  assert.equal((await f.call(worker, "POST", `/api/bots/${b.id}/show`, decision)).status, 201);
  assert.ok(await waitFor(async () => (await saved(f, b, "One question first.")).quiet === undefined ? true : null), "the held text is given back");
  f.end(worker, "Asked.");
  assert.ok(await f.idle(b));
  await pause();
  assert.equal(settledIn(frames, b.threadId).length, 1);
  // a team proposal after the finish
  worker = await fromAgent(f, a, b, "Plan the example launch");
  assert.equal((await f.quiet(worker, b)).status, 200);
  f.text(worker, team);
  assert.ok(await waitFor(async () => (await turnRows(f, b)).some((m) => m.role === "bot" && m.kind === "options" && m.card?.team && !m.quiet) ? true : null), "the proposal is delivered");
  assert.notEqual((await saved(f, b, "Here is the example plan.")).quiet, true, "and the words it came with");
  assert.equal((await f.quiet(worker, b)).body.reason, "superseded");
  f.end(worker, "Proposed.");
  assert.ok(await f.idle(b));
  await pause();
  assert.equal(settledIn(frames, b.threadId).length, 2);
  // a card before the call
  worker = await fromAgent(f, a, b, "Ask about the example");
  assert.equal((await f.call(worker, "POST", `/api/bots/${b.id}/show`, decision)).status, 201);
  const refused = await f.quiet(worker, b);
  assert.equal(refused.status, 409);
  assert.equal(refused.body.reason, "already_shown");
  f.end(worker, "Asked.");
  assert.ok(await f.idle(b));
});

test("a question still open at the call refuses the finish", async (t) => {
  const f = await quietFixture(t);
  const a = await f.hire("Sender"), b = await f.hire("Worker");
  const worker = await fromAgent(f, a, b);
  await f.ask(worker, "Go ahead with the example change?");
  assert.ok(await waitFor(async () => (await turnRows(f, b)).some((m) => m.role === "bot" && m.kind !== "text" && m.kind !== "activity") ? true : null));
  const refused = await f.quiet(worker, b);
  assert.equal(refused.status, 409);
  assert.equal(refused.body.reason, "open_request");
  f.end(worker, "Asked.");
  assert.ok(await f.idle(b));
});

test("an agent's turn the person joined cannot be finished quietly", async (t) => {
  const f = await quietFixture(t);
  const a = await f.hire("Sender"), b = await f.hire("Worker");
  const worker = await fromAgent(f, a, b);
  const sent = await f.h.fetch(`/api/bots/${b.id}/messages`, { method: "POST", body: JSON.stringify({ text: "Also the example calendar", delivery: "now" }) });
  assert.ok(sent.ok);
  assert.ok(await waitFor(() => readSteers(f).some((s) => s.pid === worker.pid && /example calendar/.test(s.text)) ? true : null), "the person's words joined the turn");
  const refused = await f.quiet(worker, b);
  assert.equal(refused.status, 409);
  assert.equal(refused.body.reason, "person_in_turn");
  f.text(worker, "Both checked.");
  f.end(worker, "Both checked.");
  assert.ok(await f.idle(b));
  assert.notEqual((await saved(f, b, "Both checked.")).quiet, true);
});

for (const outcome of ["accepted", "uncertain"] as const) test(`pending steer blocks quiet through ${outcome} admission, without duplicate input`, async (t) => {
  const f = await quietFixture(t, true);
  const phone = await phoneRelay(t, f.h);
  const a = await f.hire("Sender"), b = await f.hire("Worker");
  const frames = await f.stream(), worker = await fromAgent(f, a, b);
  const sent = f.h.fetch(`/api/bots/${b.id}/messages`, {
    method: "POST", body: JSON.stringify({ text: "Also the example calendar", delivery: "now" }),
  });
  assert.ok(await waitFor(() => existsSync(join(f.home, "steer-entered"))));
  const pending = await f.quiet(worker, b);
  assert.equal(pending.status, 409);
  assert.equal(pending.body.reason, "input_arriving");
  assert.equal(readSteers(f).length, 0, "the reservation precedes actual engine input");
  writeFileSync(join(f.home, "steer-release"), outcome);
  const response = await sent;
  const receipt = await response.json();
  assert.ok(!receipt.queued, JSON.stringify(receipt));
  assert.ok(await waitFor(() => readSteers(f).some((s) => s.pid === worker.pid)));
  const after = await f.quiet(worker, b);
  assert.equal(after.status, 409);
  assert.equal(after.body.reason, outcome === "uncertain" ? "input_uncertain" : "person_in_turn");
  f.text(worker, "The example calendar is clear.");
  f.end(worker, "The example calendar is clear.");
  assert.ok(await f.idle(b));
  await pause();
  assert.equal(readSteers(f).filter((s) => s.pid === worker.pid && /example calendar/.test(s.text)).length, 1);
  assert.equal(f.turns().filter((turn) => /example calendar/.test(turn.text)).length, 0, "uncertainty does not queue a duplicate turn");
  assert.equal(settledIn(frames, b.threadId).length, 1);
  if (outcome === "accepted") assert.equal(phone.replies().length, 1);
});

test("another agent's words sent now join before the finish, and wait for a turn of their own after it", async (t) => {
  const f = await quietFixture(t);
  const a = await f.hire("Sender"), b = await f.hire("Worker");
  const worker = await fromAgent(f, a, b);
  /** A new turn of A's, the agent whose message started B's turn (so it
   * may join it, mayJoin), saying to B now, as `bloks say --now`. */
  const sayNow = async (words: string) => {
    const n = f.turns().length;
    assert.ok((await f.h.fetch(`/api/bots/${a.id}/messages`, { method: "POST", body: JSON.stringify({ text: "Tell the worker" }) })).ok);
    const turn = await f.turn(n);
    const said = await f.call(turn, "POST", `/api/bots/${b.id}/messages`, { text: words, now: true });
    assert.ok(said.status < 300, JSON.stringify(said));
    return turn;
  };
  const first = await sayNow("Count the example shelves too");
  assert.ok(await waitFor(() => readSteers(f).some((s) => s.pid === worker.pid && /example shelves/.test(s.text)) ? true : null), "joined the running turn");
  f.end(first, "Told.");
  assert.ok(await f.idle(a));
  assert.equal((await f.quiet(worker, b)).status, 200, "an agent joining is nobody waiting");
  const before = f.turns().length;
  const second = await sayNow("And the example drawers");
  await pause();
  assert.ok(!readSteers(f).some((s) => /example drawers/.test(s.text)), "not into the finished turn");
  f.end(second, "Told.");
  f.text(worker, "Done.");
  f.end(worker, "Done.");
  const next = await waitFor(() => f.turns().slice(before).find((x) => /example drawers/.test(x.text)) ?? null);
  assert.ok(next, "answered as its own turn");
  assert.equal((await saved(f, b, "Done.")).quiet, true);
  f.end(next, "Drawers counted.");
  assert.ok(await f.idle(b));
});

test("a turn stopped after the finish ends as a stopped turn", async (t) => {
  const f = await quietFixture(t);
  const a = await f.hire("Sender"), b = await f.hire("Worker");
  const worker = await fromAgent(f, a, b);
  assert.equal((await f.quiet(worker, b)).status, 200);
  f.text(worker, "The partial example result.");
  assert.equal((await saved(f, b, "The partial example result.")).quiet, true);
  await f.h.fetch(`/api/bots/${b.id}/tasks/${b.threadId}`, { method: "PATCH", body: JSON.stringify({ unread: false }) });
  const stopped = await f.h.fetch(`/api/bots/${b.id}/interrupt`, { method: "POST", body: JSON.stringify({ taskId: b.threadId }) });
  assert.ok(stopped.ok, await stopped.clone().text());
  assert.ok(await f.idle(b));
  await pause();
  const rows = await turnRows(f, b);
  assert.ok(!rows.some((m) => m.role === "bot" && m.quiet && m.kind !== "text"), JSON.stringify(rows.map((m) => [m.kind, m.text, m.quiet])));
  assert.equal(Boolean((await f.lane(b)).unread), true, "a stopped turn is not a quiet one");
  assert.notEqual((await saved(f, b, "The partial example result.")).quiet, true, "a stop restores prior words");
});

test("a watcher's turn may finish quietly, without a reply wake", async (t) => {
  const f = await quietFixture(t);
  const phone = await phoneRelay(t, f.h);
  const b = await f.hire("Worker");
  const frames = await f.stream();
  const dir = join(f.home, "drops");
  mkdirSync(dir);
  const made = await f.h.fetch("/api/watchers", { method: "POST", body: JSON.stringify({ kind: "folder", target: dir, instruction: "Look at the new example file", name: "drops", botId: b.id }) });
  assert.ok(made.ok, await made.clone().text());
  const watcher = (await f.h.json("/api/watchers")).watchers[0];
  await f.h.json(`/api/watchers/${watcher.id}/check`, { method: "POST" });
  const before = f.turns().length;
  writeFileSync(join(dir, "example.txt"), "example");
  await f.h.json(`/api/watchers/${watcher.id}/check`, { method: "POST" });
  const turn = await f.turn(before);
  await f.h.fetch(`/api/bots/${b.id}/tasks/${b.threadId}`, { method: "PATCH", body: JSON.stringify({ unread: false }) });
  const accepted = await f.quiet(turn, b);
  assert.equal(accepted.status, 200, JSON.stringify(accepted));
  f.text(turn, "Nothing in it.");
  f.end(turn, "Nothing in it.");
  assert.ok(await f.idle(b));
  await pause();
  assert.equal((await saved(f, b, "Nothing in it.")).quiet, true);
  assert.deepEqual(settledIn(frames, b.threadId), []);
  assert.equal(Boolean((await f.lane(b)).unread), false);
  assert.deepEqual(phone.replies(), []);
});
