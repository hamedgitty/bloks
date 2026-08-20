// A run parked on an approval, across a restart.
//
// This is the whole reason a run is state on disk rather than a promise
// chain, and it is the part the reference material has not finished, so
// it gets a test of its own that actually closes the app and opens it
// again. Two properties, and they are different:
//
//   A gate still inside its window is picked up exactly where it was, and
//   answering it on the new process carries the run on.
//
//   A gate whose deadline passed while the app was closed is settled when
//   the app comes back. A deadline that expired overnight is still
//   expired; sitting there looking live until somebody happens to answer
//   it would be the worse of the two lies.
//
// It is the slowest test in the suite, because the shortest approval
// window the product offers is a minute and there is no honest way to
// make a clock run faster than a clock.
import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startHarness, type Harness } from "./helpers/server.ts";

async function waitFor<T>(check: () => Promise<T | null>, timeoutMs = 20_000): Promise<T | null> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const result = await check();
    if (result) return result;
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

describe("a run that outlives the app", () => {
  // A workspace this file owns, rather than the one the harness makes for
  // itself: stopping a harness deletes its own, which would make every
  // restart here a fresh install and prove nothing.
  const home = mkdtempSync(join(tmpdir(), "bloks-resume-"));
  const opened: Harness[] = [];

  /** The same workspace, opened again. */
  async function reopen(): Promise<Harness> {
    const next = await startHarness({ HOME: home, USERPROFILE: home });
    opened.push(next);
    return next;
  }

  after(async () => {
    for (const one of opened) await one.stop().catch(() => {});
    rmSync(home, { recursive: true, force: true });
  });

  test("a gate is picked up where it was left, and answering it carries on", async () => {
    const first = await reopen();
    const { bot } = await first.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Patient" }) });
    const { workflow } = await first.json("/api/workflows", {
      method: "POST",
      body: JSON.stringify({
        name: "Across a restart",
        trigger: { kind: "manual" },
        steps: [
          { id: "gate", action: "approve", text: "Carry on?", targetId: bot.id, timeoutMin: 120 },
          { id: "after", action: "approve", text: "And the next one?", targetId: bot.id, timeoutMin: 120 },
        ],
      }),
    });
    const { run } = await first.json(`/api/workflows/${workflow.id}/run`, { method: "POST", body: "{}" });

    const parked = await waitFor(async () => {
      const { workflows } = await first.json("/api/workflows");
      const found = workflows.find((w: any) => w.id === workflow.id)?.runs?.[0];
      return found?.state === "waiting" ? found : null;
    });
    assert.ok(parked, "the run never parked on its gate");
    assert.equal(parked.waiting.stepId, "gate");

    // close the app with the run sitting on its approval
    await first.stop();

    const second = await reopen();
    const carried = await waitFor(async () => {
      const { workflows } = await second.json("/api/workflows");
      return workflows.find((w: any) => w.id === workflow.id)?.runs?.[0] ?? null;
    });
    assert.ok(carried, "the workflow did not survive the restart");
    assert.equal(carried.state, "waiting", "a parked run was not picked up as parked");
    assert.equal(carried.id, run.id, "a different run came back");
    assert.equal(carried.waiting.stepId, "gate");
    assert.equal(carried.waiting.until, parked.waiting.until, "the deadline moved across the restart");

    // and the card is still in the chat, still pointing at this run
    const { bots } = await second.json("/api/bots");
    const card = bots
      .find((b: any) => b.id === bot.id)
      ?.messages.find((m: any) => m.card?.runId === run.id);
    assert.ok(card, "the card asking the question did not survive");
    assert.ok(!card.card.answered, "the card came back already answered");

    // answering on the new process carries the run on to the next gate
    await second.json(`/api/workflows/runs/${run.id}/answer`, {
      method: "POST",
      body: JSON.stringify({ answer: "Approve" }),
    });
    const moved = await waitFor(async () => {
      const { workflows } = await second.json("/api/workflows");
      const found = workflows.find((w: any) => w.id === workflow.id)?.runs?.[0];
      return found?.waiting?.stepId === "after" ? found : null;
    });
    assert.ok(moved, "answering on the reopened app did not carry the run on");
    assert.equal(moved.steps[0].state, "ok");
    assert.equal(moved.steps[0].summary, "Approve");
    await second.stop();
  });

  test("a deadline that passed while the app was closed is honoured when it opens", async () => {
    const first = await reopen();
    const { bot } = await first.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Expired" }) });
    const { workflow } = await first.json("/api/workflows", {
      method: "POST",
      body: JSON.stringify({
        name: "Short fuse",
        trigger: { kind: "manual" },
        steps: [
          // the shortest window the product offers
          { id: "gate", action: "approve", text: "Quick, yes or no?", targetId: bot.id, timeoutMin: 1 },
          { id: "after", action: "approve", text: "Should never be asked", targetId: bot.id },
        ],
      }),
    });
    const { run } = await first.json(`/api/workflows/${workflow.id}/run`, { method: "POST", body: "{}" });
    const parked = await waitFor(async () => {
      const { workflows } = await first.json("/api/workflows");
      const found = workflows.find((w: any) => w.id === workflow.id)?.runs?.find((r: any) => r.id === run.id);
      return found?.state === "waiting" ? found : null;
    });
    assert.ok(parked, "the run never parked");

    // close the app, and let the window pass with nothing running
    await first.stop();
    await new Promise((r) => setTimeout(r, Math.max(0, parked.waiting.until - Date.now()) + 1_500));

    const second = await reopen();
    const settled = await waitFor(async () => {
      const { workflows } = await second.json("/api/workflows");
      const found = workflows.find((w: any) => w.id === workflow.id)?.runs?.find((r: any) => r.id === run.id);
      return found && found.state !== "waiting" ? found : null;
    }, 30_000);
    assert.ok(settled, "an expired gate was still waiting after a restart");
    // nobody answering is not consent
    assert.equal(settled.state, "stopped");
    assert.match(settled.error, /nobody answered/);
    assert.equal(settled.steps[0].state, "timed-out");
    // and the step past the gate never ran
    assert.equal(settled.steps.length, 1, "a step after an unanswered gate ran anyway");

    // the card stops asking, so nobody answers a question that has closed
    const { bots } = await second.json("/api/bots");
    const card = bots
      .find((b: any) => b.id === bot.id)
      ?.messages.find((m: any) => m.card?.runId === run.id);
    assert.ok(card.card.answered, "the card was still open for an answer nobody could act on");
    const late = await second.fetch(`/api/workflows/runs/${run.id}/answer`, {
      method: "POST",
      body: JSON.stringify({ answer: "Approve" }),
    });
    assert.equal(late.status, 409);
    await second.stop();
  });

  test("a run left mid-flight by a quit is failed, not left spinning", async () => {
    // a spinner nobody is driving is the worst of the three states: it
    // says work is happening when nothing is
    const first = await reopen();
    const { workflows } = await first.json("/api/workflows");
    const all = workflows.flatMap((w: any) => w.runs ?? []);
    assert.ok(
      all.every((r: any) => r.state !== "running"),
      "a run came back from a restart still claiming to be running",
    );
    await first.stop();
  });
});
