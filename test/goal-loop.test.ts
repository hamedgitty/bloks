// Goals over real turns: `/goal` starts work as a note from Bloks, each
// turn that ends well is judged, and the goal ends done, blocked or out
// of turns, never past its budget. The provider here is a stand-in that
// answers turns at once (or holds them) and answers the judge from a
// script, so every path is decided by the test and nothing by a model.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startHarness, type Harness } from "./helpers/server.ts";
import { agentOn, messagesOf, waitFor } from "./helpers/turns.ts";

/** The judge's question, as server/goals.ts words it. */
const JUDGE = "Decide whether it is there yet";

const verdict = (status: "done" | "continue" | "blocked", reason: string, next?: string) =>
  JSON.stringify({ status, reason, ...(next ? { next } : {}) });

async function goalProvider(t: { after: (fn: () => unknown) => void }) {
  const state = {
    /** Every turn's request body, in order. */
    turns: [] as string[],
    /** Every question put to the judge. */
    judged: [] as string[],
    /** What the judge answers, in order; the last one repeats. */
    verdicts: [] as string[],
    reply: "Worked on it.",
    hold: false,
    held: [] as Array<() => void>,
  };
  let lastVerdict = verdict("continue", "more to do", "Carry on.");
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url?.endsWith("/models")) return res.end(JSON.stringify({ data: [{ id: "grok-4" }] }));
      const answer = (content: string) => res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }));
      if (body.includes(JUDGE)) {
        state.judged.push(body);
        lastVerdict = state.verdicts.shift() ?? lastVerdict;
        return answer(lastVerdict);
      }
      state.turns.push(body);
      const reply = state.reply;
      if (state.hold) state.held.push(() => answer(reply));
      else answer(reply);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  t.after(() => {
    state.held.forEach((f) => f());
    server.closeAllConnections();
    server.close();
  });
  return { state, port: (server.address() as { port: number }).port };
}

const laneOf = async (h: Harness, bot: { id: string }) =>
  (await h.json("/api/bots")).bots.find((b: any) => b.id === bot.id).tasks[0];
const goalOf = async (h: Harness, bot: { id: string }) => (await laneOf(h, bot)).goal;
const goalIs = (h: Harness, bot: { id: string }, status: string) =>
  waitFor(async () => {
    const goal = await goalOf(h, bot);
    return goal?.status === status && !goal.judging ? goal : null;
  });
const say = (h: Harness, bot: { id: string }, text: string) =>
  h.fetch(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text }) });
/** What the engine was asked last in one turn: the newest user message. */
const asked = (body: string) => {
  const messages = JSON.parse(body).messages as Array<{ role: string; content: unknown }>;
  const last = messages.filter((m) => m.role === "user").at(-1)?.content;
  return typeof last === "string" ? last : JSON.stringify(last);
};
const settle = () => new Promise((r) => setTimeout(r, 600));

test("/goal starts the work as a note from Bloks, and a judged done ends it", async (t) => {
  const p = await goalProvider(t);
  p.state.verdicts = [verdict("continue", "half written", "Write the summary."), verdict("done", "the report is shipped.")];
  const h = await startHarness();
  t.after(() => h.stop());
  const bot = await agentOn(h, p.port, "Ada");

  const res = await say(h, bot, "/goal ship the report");
  assert.equal(res.status, 202);
  assert.equal((await res.json()).goal.status, "active");
  const done = await goalIs(h, bot, "done");
  assert.ok(done, `the goal never finished: ${JSON.stringify(await goalOf(h, bot))}`);
  assert.equal(done.turns, 2);

  const said = await messagesOf(h, bot);
  // Bloks' own command, never sent on: not to the engine, and not into
  // the conversation as if the person had said it
  assert.ok(!p.state.turns.some((b) => b.includes("/goal")), "the engine was sent /goal");
  assert.ok(!said.some((m) => m.role === "user" && (m.text ?? "").includes("/goal")));
  const notes = said.filter((m) => m.via === "goal");
  assert.equal(notes.length, 2);
  assert.equal(notes[0].role, "user");
  assert.match(notes[0].text, /not typed by the person/);
  assert.match(notes[0].text, /ship the report/);
  assert.match(notes[1].text, /turn 2 of 20/);
  assert.match(notes[1].text, /Next: Write the summary\./);
  assert.equal(asked(p.state.turns[1]), notes[1].text);
  assert.ok(said.some((m) => m.kind === "notice" && m.goal === "set" && /Goal set: ship the report\. Up to 20 turns\./.test(m.text)));
  assert.ok(said.some((m) => m.kind === "notice" && m.goal === "done" && m.text === "Goal done: the report is shipped (2 turns)."));
  assert.equal(p.state.judged.length, 2);
  assert.match(p.state.judged[0], /ship the report/);
  assert.match(p.state.judged[0], /Worked on it\./);
});

test("the budget is a hard cap: a judge that always says go on gets exactly the turns allowed", async (t) => {
  const p = await goalProvider(t);
  p.state.verdicts = [verdict("continue", "not yet", "Keep at it.")];
  const h = await startHarness();
  t.after(() => h.stop());
  const bot = await agentOn(h, p.port, "Ben");

  assert.equal((await say(h, bot, "/goal something never quite done\nturns: 3")).status, 202);
  const out = await goalIs(h, bot, "out");
  assert.ok(out, `the goal never ran out: ${JSON.stringify(await goalOf(h, bot))}`);
  assert.equal(out.turns, 3);
  assert.equal(p.state.turns.length, 3);
  const said = await messagesOf(h, bot);
  assert.ok(said.some((m) => m.goal === "out" && /Goal stopped after 3 turns, its budget/.test(m.text)));
  // and nothing more after it
  await settle();
  assert.equal(p.state.turns.length, 3);
  // a goal out of turns is not resumed without more of them
  const lane = await laneOf(h, bot);
  const again = await h.fetch(`/api/bots/${bot.id}/tasks/${lane.id}/goal`, { method: "PATCH", body: JSON.stringify({ status: "active" }) });
  assert.equal(again.status, 409);
  const more = await h.fetch(`/api/bots/${bot.id}/tasks/${lane.id}/goal`, { method: "PATCH", body: JSON.stringify({ status: "active", budget: 4 }) });
  assert.equal(more.status, 200);
  assert.ok(await goalIs(h, bot, "out"));
  assert.equal(p.state.turns.length, 4);
});

test("a check that fails is never done, whatever the judge says, and one that passes is", async (t) => {
  const p = await goalProvider(t);
  p.state.verdicts = [verdict("done", "looks finished")];
  const h = await startHarness();
  t.after(() => h.stop());
  const bot = await agentOn(h, p.port, "Cy");

  assert.equal((await say(h, bot, "/goal make the check pass\ncheck: echo nope; exit 3\nturns: 2")).status, 202);
  const out = await goalIs(h, bot, "out");
  assert.ok(out, `the goal was not held to its check: ${JSON.stringify(await goalOf(h, bot))}`);
  const notes = (await messagesOf(h, bot)).filter((m) => m.via === "goal");
  assert.match(notes[1].text, /Check result: `echo nope; exit 3` failed \(exit 3\)\. The end of its output:\nnope/);
  assert.match(p.state.judged[0], /failed \(exit 3\)/);

  const lane = await laneOf(h, bot);
  const set = await h.fetch(`/api/bots/${bot.id}/tasks/${lane.id}/goal`, {
    method: "PUT",
    body: JSON.stringify({ text: "make the check pass", check: "exit 0" }),
  });
  assert.equal(set.status, 200);
  const done = await goalIs(h, bot, "done");
  assert.ok(done, `a passing check and a done verdict did not finish it: ${JSON.stringify(await goalOf(h, bot))}`);
  assert.equal(done.turns, 1);
});

test("with no verdict from the judge, the agent's own last line decides", async (t) => {
  const p = await goalProvider(t);
  p.state.verdicts = ["I think it is probably fine?"];
  p.state.reply = "Renamed every file.\nGoal: done";
  const h = await startHarness();
  t.after(() => h.stop());
  const bot = await agentOn(h, p.port, "Dee");

  await say(h, bot, "/goal rename the files");
  const done = await goalIs(h, bot, "done");
  assert.ok(done);
  assert.equal(done.turns, 1);
});

test("blocked hands the goal back, the lane waits on the person, and their answer picks it up", async (t) => {
  const p = await goalProvider(t);
  p.state.verdicts = [verdict("blocked", "needs the staging password"), verdict("done", "deployed")];
  const h = await startHarness();
  t.after(() => h.stop());
  const bot = await agentOn(h, p.port, "Eve");

  await say(h, bot, "/goal deploy to staging");
  assert.ok(await goalIs(h, bot, "blocked"));
  const lane = await laneOf(h, bot);
  assert.equal(lane.state, "needs-you");
  assert.equal(lane.unread, true);
  assert.ok((await messagesOf(h, bot)).some((m) => m.goal === "blocked" && /Goal blocked: needs the staging password\./.test(m.text)));

  await say(h, bot, "it is in the team vault under staging");
  const done = await goalIs(h, bot, "done");
  assert.ok(done, `the answer did not pick the goal up: ${JSON.stringify(await goalOf(h, bot))}`);
  // the person's turn is not one of the goal's
  assert.equal(done.turns, 1);
  assert.equal(p.state.turns.length, 2);
  assert.equal(asked(p.state.turns[1]), "it is in the team vault under staging");
});

test("pause holds the goal through the turn's end, resume goes on, and clear removes it", async (t) => {
  const p = await goalProvider(t);
  p.state.verdicts = [verdict("done", "all of it")];
  p.state.hold = true;
  const h = await startHarness();
  t.after(() => h.stop());
  const bot = await agentOn(h, p.port, "Fin");

  await say(h, bot, "/goal the long job");
  assert.ok(await waitFor(() => p.state.held.length === 1));
  const lane = await laneOf(h, bot);
  const goalPath = `/api/bots/${bot.id}/tasks/${lane.id}/goal`;
  const paused = await h.fetch(goalPath, { method: "PATCH", body: JSON.stringify({ status: "paused" }) });
  assert.equal(paused.status, 200);
  assert.equal((await paused.json()).goal.status, "paused");
  p.state.hold = false;
  p.state.held.shift()!();
  assert.ok(await waitFor(async () => (await laneOf(h, bot)).state === "idle"));
  await settle();
  assert.equal(p.state.judged.length, 0, "a paused goal was judged");
  assert.equal(p.state.turns.length, 1, "a paused goal started a turn");
  assert.equal((await goalOf(h, bot)).status, "paused");

  assert.equal((await h.fetch(goalPath, { method: "PATCH", body: JSON.stringify({ status: "active" }) })).status, 200);
  const done = await goalIs(h, bot, "done");
  assert.ok(done);
  assert.equal(done.turns, 2);
  assert.match(asked(p.state.turns[1]), /which the person resumed/);

  assert.equal((await h.fetch(goalPath, { method: "DELETE" })).status, 200);
  assert.equal((await goalOf(h, bot)) ?? null, null);
});

test("the person's Stop pauses the goal, and nothing starts after it", async (t) => {
  const p = await goalProvider(t);
  p.state.hold = true;
  const h = await startHarness();
  t.after(() => h.stop());
  const bot = await agentOn(h, p.port, "Gus");

  await say(h, bot, "/goal a job worth stopping");
  assert.ok(await waitFor(() => p.state.held.length === 1));
  const lane = await laneOf(h, bot);
  assert.equal((await h.fetch(`/api/bots/${bot.id}/interrupt`, { method: "POST", body: JSON.stringify({ taskId: lane.id }) })).status, 200);
  const paused = await goalIs(h, bot, "paused");
  assert.ok(paused);
  assert.equal(paused.lastReason, "you stopped the turn");
  assert.ok(await waitFor(async () => (await laneOf(h, bot)).state === "idle"));
  await settle();
  assert.equal(p.state.judged.length, 0);
  assert.equal(p.state.turns.length, 1);
});

test("the person's words go before the goal's next turn, which follows theirs", async (t) => {
  const p = await goalProvider(t);
  p.state.verdicts = [verdict("continue", "one part left", "Write part two."), verdict("done", "both parts written")];
  p.state.hold = true;
  const h = await startHarness();
  t.after(() => h.stop());
  const bot = await agentOn(h, p.port, "Hal");

  await say(h, bot, "/goal write both parts");
  assert.ok(await waitFor(() => p.state.held.length === 1));
  // said while the goal's turn runs, on an engine that cannot take words
  // mid-turn, so it waits; it must go next, not behind another goal turn
  assert.equal((await say(h, bot, "also mention the budget")).status, 202);
  p.state.hold = false;
  p.state.held.shift()!();
  const done = await goalIs(h, bot, "done");
  assert.ok(done, `the goal never finished: ${JSON.stringify(await goalOf(h, bot))}`);
  assert.equal(p.state.turns.length, 3);
  assert.equal(asked(p.state.turns[1]), "also mention the budget");
  assert.match(asked(p.state.turns[2]), /Keep going toward your goal/);
  // nothing judged the goal's first turn: the person's words were waiting
  assert.equal(p.state.judged.length, 2);
});

test("a goal a restart left between turns is paused, not judged again unattended", async (t) => {
  const p = await goalProvider(t);
  const home = mkdtempSync(join(tmpdir(), "bloks-goal-restart-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const first = await startHarness({ HOME: home });
  const bot = await agentOn(first, p.port, "Kit");
  await first.stop();
  // as Bloks left it: the goal active, its judge gone with the process
  const file = join(home, ".bloks", "bots.json");
  const saved = JSON.parse(readFileSync(file, "utf8"));
  saved.find((b: any) => b.id === bot.id).tasks[0].goal = {
    text: "tidy the docs",
    budget: 20,
    turns: 2,
    status: "active",
    startedAt: Date.now() - 60_000,
  };
  writeFileSync(file, JSON.stringify(saved));

  const h = await startHarness({ HOME: home });
  t.after(() => h.stop());
  const paused = await goalIs(h, bot, "paused");
  assert.ok(paused, `the goal was not paused: ${JSON.stringify(await goalOf(h, bot))}`);
  assert.equal(paused.turns, 2);
  assert.equal(paused.text, "tidy the docs");
  assert.ok((await messagesOf(h, bot)).some((m) => m.goal === "paused" && /Bloks restarted between its turns/.test(m.text)));
  await settle();
  assert.equal(p.state.judged.length, 0);
  assert.equal(p.state.turns.length, 0);
});

test("a goal is refused where it does not belong, and every screen is told", async (t) => {
  const p = await goalProvider(t);
  const h = await startHarness();
  t.after(() => h.stop());
  const bot = await agentOn(h, p.port, "Ivy");

  // what done looks like is not optional
  const empty = await say(h, bot, "/goal");
  assert.equal(empty.status, 400);
  assert.match((await empty.json()).error, /what done looks like/);

  // a rehearsal is one piece of work, applied or discarded whole
  const opened = await h.json("/api/rehearsals", { method: "POST", body: JSON.stringify({ botId: bot.id, text: "try it" }) });
  const rehearsal = opened.attempts?.[0]?.taskId;
  assert.ok(rehearsal, JSON.stringify(opened));
  const refused = await h.fetch(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: "/goal finish it", taskId: rehearsal }) });
  assert.equal(refused.status, 409);
  const lanes = (await h.json("/api/bots")).bots.find((b: any) => b.id === bot.id).tasks;
  assert.equal(lanes.find((l: any) => l.id === rehearsal).noGoals, true);
  assert.equal(lanes[0].noGoals, undefined);
  assert.equal(lanes.find((l: any) => l.id === rehearsal).goal, undefined);
});
