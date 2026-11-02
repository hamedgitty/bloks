// One turn per lane, even while a turn is still getting ready.
//
// startTurn found the lane free, then awaited (a fold of a long
// conversation can take a model call, a shared room asks for its plan)
// before it marked the lane busy. A second start in that gap found the
// lane free too and went ahead: two turns in one lane, each answering
// without the other, and on Claude Code the second one failing freed the
// lane while the first still ran.
import { test } from "node:test";
import assert from "node:assert/strict";

import { startHarness } from "./helpers/server.ts";
import { agentOn, fakeProvider, idle, messagesOf, waitFor } from "./helpers/turns.ts";

test("words for a lane whose turn is still getting ready join it, rather than starting beside it", async (t) => {
  const fake = await fakeProvider(t);
  fake.state.answerAtOnce = true;
  const h = await startHarness();
  t.after(() => h.stop());
  const ivy = await agentOn(h, fake.port, "Ivy");
  // A model the table does not know gets a small window, so one long
  // message is enough to make the lane fold before its next turn.
  await h.fetch(`/api/bots/${ivy.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "grok", model: "small-model" } }) });
  // folds fail until the race below, so the lane stays long enough to fold
  fake.state.folding = "fail";
  const say = async (text: string) =>
    (await h.fetch(`/api/bots/${ivy.id}/messages`, { method: "POST", body: JSON.stringify({ text }) })).json();
  for (const text of ["x".repeat(99_000), "two", "three", "four"]) {
    await say(text);
    assert.ok(await idle(h, ivy), "a turn setting the lane up never ended");
    // words said while a turn's change card is still being made wait
    // behind it, and FIRST has to start a turn of its own
    await new Promise((r) => setTimeout(r, 1_000));
  }

  const callsBefore = fake.state.calls.length;
  fake.state.folding = "hold";
  const first = say("FIRST");
  assert.ok(await waitFor(() => fake.state.folds.length >= 1), "the turn did not fold first, so this proves nothing");
  const asked = (await messagesOf(h, ivy)).find((m) => m.text === "FIRST");
  assert.equal(asked?.queued, undefined, "FIRST waited behind something else, so this proves nothing");
  // while it is getting ready the lane is not free to close, and a drain
  // counts it as running
  const lane = (await h.json("/api/bots")).bots.find((b: any) => b.id === ivy.id).activeTaskId;
  const close = await h.fetch(`/api/bots/${ivy.id}/tasks/${lane}`, { method: "DELETE" });
  assert.equal(close.status, 409, "a lane still getting its turn ready was closed");
  const drained = await h.json("/api/maintenance/drain", { method: "POST", body: JSON.stringify({ seconds: 600 }) });
  assert.equal(drained.idle, false, "a drain counted a lane getting ready as idle");
  await h.fetch("/api/maintenance/drain", { method: "DELETE" });
  const second = say("SECOND");
  const answered = await Promise.race([second, new Promise((r) => setTimeout(() => r(null), 10_000))]);
  fake.state.folding = "fail";
  fake.state.folds.splice(0).forEach((release) => release());
  assert.ok(answered, "the second message started a turn of its own and waited on a fold, beside the first");
  assert.equal((answered as any).queued, true, "the second message did not wait for the turn getting ready");
  await first;
  await second;

  // Both words were ready before the input was committed. They join
  // the same turn, with one answer after them.
  const said = await waitFor(async () => {
    const list = await messagesOf(h, ivy);
    const texts = list.filter((m) => m.kind === "text" && !m.deleted).map((m) => m.text);
    return !list.some((m) => m.queued) && texts.at(-2) === "SECOND" && texts.at(-1) === "Done." ? texts : null;
  });
  assert.ok(said, "the waiting message was never answered");
  assert.deepEqual(said.slice(-3), ["FIRST", "SECOND", "Done."]);
  assert.equal(fake.state.calls.length - callsBefore, 1, "a second turn started beside or after the first");
  const sent = JSON.parse(fake.state.calls.at(-1)!).messages.at(-1).content;
  assert.equal(sent, "FIRST\n\nSECOND");
  // and the engine heard the follow-up once
  assert.equal(fake.sent("SECOND"), 1);
});

test("an unsupported engine keeps a later input behind an unconfirmed preparation input", async (t) => {
  const fake = await fakeProvider(t);
  fake.state.answerAtOnce = true;
  const h = await startHarness();
  t.after(() => h.stop());
  const ivy = await agentOn(h, fake.port, "Ivy");
  await h.fetch(`/api/bots/${ivy.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "grok", model: "small-model" } }) });
  fake.state.folding = "fail";
  const say = async (text: string) =>
    (await h.fetch(`/api/bots/${ivy.id}/messages`, { method: "POST", body: JSON.stringify({ text }) })).json();
  for (const text of ["x".repeat(99_000), "two", "three", "four"]) {
    await say(text);
    assert.ok(await idle(h, ivy), "the setup turn did not end");
    await new Promise((r) => setTimeout(r, 1_000));
  }
  const before = fake.state.calls.length;
  fake.state.folding = "hold";
  const first = say("ORIGINAL");
  assert.ok(await waitFor(() => fake.state.folds.length > 0), "the turn did not pause before its input");
  await say("PREPARED_A");
  fake.state.answerAtOnce = false;
  fake.state.folding = "fail";
  fake.state.folds.splice(0).forEach((release) => release());
  await first;
  assert.ok(await waitFor(() => fake.state.held.length === 1), "the first input did not reach the provider");
  const afterDispatch = await messagesOf(h, ivy);
  assert.equal(afterDispatch.find((m) => m.text === "PREPARED_A")?.preparation?.state, "dispatching");
  const later = await say("LATER_B");
  assert.equal(later.delivery.route, "pending");
  assert.equal(fake.state.calls.length - before, 1, "the later input stopped or overtook the first");
  const current = await messagesOf(h, ivy);
  assert.equal(current.find((m) => m.text === "LATER_B")?.preparation?.state, "pending");
  fake.state.answerAtOnce = true;
  fake.state.held.splice(0).forEach((release) => release());
  assert.ok(await waitFor(async () => fake.state.calls.length - before === 2 && !(await messagesOf(h, ivy)).some((m) => m.queued)),
    "the later input did not get its next turn");
  const firstInput = JSON.parse(fake.state.calls[before]).messages.at(-1).content;
  const nextInput = JSON.parse(fake.state.calls[before + 1]).messages.at(-1).content;
  assert.equal(firstInput, "ORIGINAL\n\nPREPARED_A");
  assert.equal(nextInput, "LATER_B");
});
