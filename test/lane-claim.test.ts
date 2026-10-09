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

test("words for a lane whose turn is still getting ready wait for that turn, rather than starting beside it", async (t) => {
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

  fake.state.folding = "hold";
  const first = say("FIRST");
  assert.ok(await waitFor(() => fake.state.folds.length >= 1), "the turn did not fold first, so this proves nothing");
  const asked = (await messagesOf(h, ivy)).find((m) => m.text === "FIRST");
  assert.equal(asked?.queued, undefined, "FIRST waited behind something else, so this proves nothing");
  const second = say("SECOND");
  const answered = await Promise.race([second, new Promise((r) => setTimeout(() => r(null), 10_000))]);
  fake.state.folding = "fail";
  fake.state.folds.splice(0).forEach((release) => release());
  assert.ok(answered, "the second message started a turn of its own and waited on a fold, beside the first");
  assert.equal((answered as any).queued, true, "the second message did not wait for the turn getting ready");
  await first;
  await second;

  // SECOND waits at the end of the chat until its turn, so FIRST's
  // answer lands after it for a moment; it moves when it goes
  const said = await waitFor(async () => {
    const list = await messagesOf(h, ivy);
    const texts = list.filter((m) => m.kind === "text" && !m.deleted).map((m) => m.text);
    return !list.some((m) => m.queued) && texts.at(-2) === "SECOND" && texts.at(-1) === "Done." ? texts : null;
  });
  assert.ok(said, "the waiting message was never answered");
  assert.deepEqual(said.slice(-4), ["FIRST", "Done.", "SECOND", "Done."]);
  // and the engine heard it once, in a turn of its own
  assert.equal(fake.sent("SECOND"), 1);
});
