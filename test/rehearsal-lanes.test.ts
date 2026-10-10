// A rehearsal's copy lives as long as its lane: close the lane and the
// rehearsal is discarded, its copy cleared, without waiting for a restart.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { startHarness } from "./helpers/server.ts";
import { agentOn, fakeProvider, waitFor } from "./helpers/turns.ts";

test("closing a rehearsal's lane discards the rehearsal and clears its copy", async (t) => {
  const fake = await fakeProvider(t);
  fake.state.answerAtOnce = true;
  const h = await startHarness();
  t.after(() => h.stop());
  const bot = await agentOn(h, fake.port, "Ada");

  const started = await h.json("/api/rehearsals", { method: "POST", body: JSON.stringify({ botId: bot.id, text: "Tidy the notes" }) });
  const [attempt] = started.attempts as Array<{ id: string; taskId: string }>;
  const copy = join(h.home, ".bloks", "rehearsals", attempt.id);
  assert.ok(existsSync(copy));
  const stateOf = async () => ((await h.json("/api/rehearsals")).rehearsals as any[]).find((r) => r.id === attempt.id)?.state;

  // the turn changes nothing, so the copy waits for a follow-up there
  assert.ok(await waitFor(async () => (await stateOf()) === "empty"), "the rehearsal's turn finished");
  const closed = await h.fetch(`/api/bots/${bot.id}/tasks/${attempt.taskId}`, { method: "DELETE" });
  assert.equal(closed.status, 200);

  assert.ok(await waitFor(async () => (await stateOf()) === "discarded", 5_000), "closing the lane discards the rehearsal");
  assert.ok(await waitFor(() => !existsSync(copy), 5_000), "and clears its copy");
});
