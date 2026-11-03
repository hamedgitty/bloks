// Stop in a room ends the round (GitHub 475).
//
// Stop interrupted the members speaking, and the round went straight on
// to the next one: stopping the room started somebody else, and what
// waited behind the round still waited for all of it. Now the round
// stops with them, and what waited goes, as when a round ends on its own.
import assert from "node:assert/strict";
import { test } from "node:test";

import { startHarness } from "./helpers/server.ts";
import { agentOn, fakeProvider, idle, waitFor } from "./helpers/turns.ts";

test("Stop in a room stops the round, and what waited goes next", async (t) => {
  const fake = await fakeProvider(t);
  const h = await startHarness();
  t.after(() => h.stop());
  const ada = await agentOn(h, fake.port, "Ada");
  const ben = await agentOn(h, fake.port, "Ben");
  await h.fetch(`/api/bots/${ben.id}`, { method: "PATCH", body: JSON.stringify({ seniority: 3 }) });
  const { blok } = await h.json("/api/bloks", { method: "POST", body: JSON.stringify({ name: "Plans", memberIds: [ada.id, ben.id] }) });
  const calls = (name: string, marker: string) => fake.state.calls.filter((c) => c.includes(`You are ${name}`) && c.includes(marker)).length;

  await h.fetch(`/api/bloks/${blok.id}/messages`, { method: "POST", body: JSON.stringify({ text: "ROOM-ROUND plan the launch" }) });
  assert.ok(await waitFor(() => calls("Ada", "ROOM-ROUND") > 0), "Ada never spoke");
  assert.equal((await h.fetch(`/api/bloks/${blok.id}/messages`, { method: "POST", body: JSON.stringify({ text: "AFTER-STOP start over" }) })).status, 202);

  fake.state.answerAtOnce = true;
  const stopped = await h.json(`/api/bloks/${blok.id}/stop`, { method: "POST" });
  assert.equal(stopped.stopped, 1);

  // what waited goes, to both, and Ben never takes the stopped round's turn
  assert.ok(await waitFor(() => calls("Ada", "AFTER-STOP") > 0 && calls("Ben", "AFTER-STOP") > 0), "what waited never went");
  assert.ok(await idle(h, ada));
  assert.ok(await idle(h, ben));
  assert.equal(calls("Ben", "AFTER-STOP"), 1);
  assert.equal(
    fake.state.calls.filter((c) => c.includes("You are Ben") && !c.includes("AFTER-STOP")).length,
    0,
    "Ben started in the stopped round",
  );

  assert.equal((await h.fetch("/api/bloks/no-such-room/stop", { method: "POST" })).status, 404);
});
