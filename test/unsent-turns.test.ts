// A turn that fails on its way to its engine (server/index.ts, startTurn).
//
// A routine run, a workflow's ask step, a job and an email each register
// themselves against a lane before its turn starts, and hear how it ended
// from turn.completed. A turn that failed while it was getting ready (the
// Local VM not running, a project folder gone) never reaches its engine,
// so no turn.completed ever came: the run stayed "running", the job stayed
// claimed by an agent that was not doing it, and the step held its run
// forever, because a run waiting on a turn is never retried. The same
// start also left the lane marked as speaking in the room it was asked in.
import { test } from "node:test";
import assert from "node:assert/strict";

import { startHarness, type Harness } from "./helpers/server.ts";
import { agentOn, fakeProvider, waitFor } from "./helpers/turns.ts";

/** A runtime that is not there, so a turn on the Local VM fails getting
 * ready rather than reaching any engine. */
const NO_RUNTIME = { BLOKS_VM_RUNTIME: "/nonexistent/bloks-test-container-runtime" };

async function only(h: Harness, keep: string) {
  // A fresh workspace greets you with an agent of its own. Put away, it
  // is not a candidate for the job board, so the job goes to `keep`.
  const { bots } = await h.json("/api/bots?messages=0");
  for (const other of bots.filter((b: any) => b.id !== keep)) {
    await h.fetch(`/api/bots/${other.id}`, { method: "PATCH", body: JSON.stringify({ hidden: true }) });
  }
}

const idle = async (h: Harness, botId: string) =>
  waitFor(async () => {
    const bot = (await h.json("/api/bots?messages=0")).bots.find((b: any) => b.id === botId);
    return bot && !bot.busy ? bot : null;
  });

test("a turn that fails getting ready ends the workflow step, the job and the routine run waiting on it", async (t) => {
  const fake = await fakeProvider(t);
  fake.state.answerAtOnce = true;
  const h = await startHarness(NO_RUNTIME);
  t.after(() => h.stop());
  const vee = await agentOn(h, fake.port, "Vee");
  await h.fetch(`/api/bots/${vee.id}`, { method: "PATCH", body: JSON.stringify({ computer: "sandbox" }) });
  await only(h, vee.id);

  // a workflow's ask step
  const { workflow } = await h.json("/api/workflows", {
    method: "POST",
    body: JSON.stringify({
      name: "Ask Vee",
      trigger: { kind: "manual" },
      steps: [{ id: "ask", action: "ask", text: "Check the numbers", targetId: vee.id }],
    }),
  });
  const { run } = await h.json(`/api/workflows/${workflow.id}/run`, { method: "POST", body: "{}" });
  const failed = await waitFor(async () => {
    const { workflows } = await h.json("/api/workflows");
    const found = workflows.find((w: any) => w.id === workflow.id)?.runs?.find((r: any) => r.id === run.id);
    return found?.state === "failed" ? found : null;
  });
  assert.ok(failed, "the run was left running on a turn that never started");
  assert.equal(failed.steps[0].state, "failed");
  assert.match(failed.error, /Local VM|running/, "the run does not say why");
  assert.ok(await idle(h, vee.id), "the lane stayed busy");

  // a job
  const { job } = await h.json("/api/jobs", { method: "POST", body: JSON.stringify({ title: "Tidy the folder" }) });
  const ended = await waitFor(async () => {
    const found = (await h.json("/api/jobs")).jobs.find((j: any) => j.id === job.id);
    return found?.state === "failed" ? found : null;
  });
  assert.ok(ended, "the job stayed claimed by an agent that never started on it");
  assert.match(ended.result, /Local VM|running/);

  // a routine run
  const { routine } = await h.json("/api/routines", {
    method: "POST",
    body: JSON.stringify({ targetId: vee.id, prompt: "Morning check", time: "03:00", enabled: false }),
  });
  const ran = await h.fetch(`/api/routines/${routine.id}/run`, { method: "POST", body: "{}" });
  assert.equal(ran.status, 202);
  const closed = await waitFor(async () => {
    const found = (await h.json("/api/routines")).routines.find((r: any) => r.id === routine.id);
    return found?.runs?.[0]?.state === "failed" ? found.runs[0] : null;
  });
  assert.ok(closed, "the routine's run stayed open");
  assert.match(closed.error, /Local VM|running/);

  // and none of it reached an engine
  assert.equal(fake.state.calls.length, 0);
});

test("a turn stopped by a missing project folder frees the room it was asked in, and its routine run says why", async (t) => {
  const fake = await fakeProvider(t);
  fake.state.answerAtOnce = true;
  const h = await startHarness();
  t.after(() => h.stop());
  const pia = await agentOn(h, fake.port, "Pia");
  await h.json("/api/projects", {
    method: "POST",
    body: JSON.stringify({ name: "Atlas", folders: ["/nonexistent/bloks-test-atlas"], memberIds: [pia.id] }),
  });

  // something of the person's to rewind to later
  await h.fetch(`/api/bots/${pia.id}/messages`, { method: "POST", body: JSON.stringify({ text: "FIRST WORDS" }) });
  assert.ok(await idle(h, pia.id));
  const asked = (await h.json(`/api/bots/${pia.id}/messages?thread=${pia.threadId}&limit=50`)).messages.find(
    (m: any) => m.role === "user" && m.text === "FIRST WORDS",
  );
  assert.ok(asked);

  // a room needs two, and only Pia is asked
  const quill = await agentOn(h, fake.port, "Quill");
  const { blok: room } = await h.json("/api/bloks", { method: "POST", body: JSON.stringify({ name: "Plans", memberIds: [pia.id, quill.id] }) });
  await h.fetch(`/api/bloks/${room.id}/messages`, { method: "POST", body: JSON.stringify({ text: "@Pia what is next?" }) });
  const said = await waitFor(async () =>
    (await h.json(`/api/bloks/${room.id}/messages?limit=50`)).messages.find((m: any) => m.kind === "notice" && /Atlas points at/.test(m.text)),
  );
  assert.ok(said, "the room was not told why nothing ran");
  assert.ok(await idle(h, pia.id));

  // The lane still read as speaking in the room, so the person could
  // not take it back to their own words: "Pia is speaking in a room".
  const rewound = await h.fetch(`/api/threads/${pia.threadId}/rewind`, {
    method: "POST",
    body: JSON.stringify({ messageId: asked.id }),
  });
  assert.equal(rewound.status, 200, await rewound.clone().text());

  const { routine } = await h.json("/api/routines", {
    method: "POST",
    body: JSON.stringify({ targetId: pia.id, prompt: "Morning check", time: "03:00", enabled: false }),
  });
  await h.fetch(`/api/routines/${routine.id}/run`, { method: "POST", body: "{}" });
  const closed = await waitFor(async () => {
    const found = (await h.json("/api/routines")).routines.find((r: any) => r.id === routine.id);
    return found?.runs?.[0]?.state === "failed" ? found.runs[0] : null;
  });
  assert.ok(closed, "the routine's run stayed open");
  assert.match(closed.error, /Atlas points at/);
  assert.equal(fake.state.calls.length, 0);
});
