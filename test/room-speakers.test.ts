// One speaker at a time in a room (server/index.ts, speakInTurn).
//
// The next speaker waited for the last one to be idle in every lane, for
// at most two minutes. So a member busy elsewhere held the room for no
// reason, and a room turn longer than two minutes (Claude Code's often
// are) had the next speaker talk over it and the round end before its
// handoffs came in. The wait is now for the room's own turn, with the
// same patience as the other waits on a turn. The two minutes are not
// waited out here; what is tested is which turn the room waits for.
import { test } from "node:test";
import assert from "node:assert/strict";

import { startHarness } from "./helpers/server.ts";
import { agentOn, fakeProvider, idle, waitFor } from "./helpers/turns.ts";

test("the next speaker goes when the last one's room turn ends, even while it works elsewhere", async (t) => {
  const fake = await fakeProvider(t);
  const h = await startHarness();
  t.after(() => h.stop());
  const ada = await agentOn(h, fake.port, "Ada");
  const ben = await agentOn(h, fake.port, "Ben");
  // the junior speaks first
  await h.fetch(`/api/bots/${ben.id}`, { method: "PATCH", body: JSON.stringify({ seniority: 3 }) });
  const { blok: room } = await h.json("/api/bloks", { method: "POST", body: JSON.stringify({ name: "Plans", memberIds: [ada.id, ben.id] }) });
  const callFor = (name: string, marker: string) => fake.state.calls.findIndex((c) => c.includes(`You are ${name}`) && c.includes(marker));

  await h.fetch(`/api/bloks/${room.id}/messages`, { method: "POST", body: JSON.stringify({ text: "ROOM-ROUND what is next?" }) });
  assert.ok(await waitFor(() => callFor("Ada", "ROOM-ROUND") >= 0), "Ada never spoke in the room");

  // While her room turn runs, Ada starts something else in another lane,
  // which outlasts it.
  const { bot } = await h.json(`/api/bots/${ada.id}/tasks`, { method: "POST", body: JSON.stringify({ title: "Elsewhere" }) });
  const elsewhere = bot.activeTaskId;
  await h.fetch(`/api/bots/${ada.id}/messages`, { method: "POST", body: JSON.stringify({ text: "SOLO-WORK", taskId: elsewhere }) });
  assert.ok(await waitFor(() => callFor("Ada", "SOLO-WORK") >= 0), "Ada's other turn never started");

  // her room turn ends; her other one has not
  fake.state.held[callFor("Ada", "ROOM-ROUND")]();
  assert.ok(
    await waitFor(() => callFor("Ben", "ROOM-ROUND") >= 0, 10_000),
    "Ben waited on Ada's other lane rather than her turn in the room",
  );
  assert.equal(
    (await h.json(`/api/bots/${ada.id}/messages?thread=${elsewhere}&limit=20`)).messages.some((m: any) => m.role === "bot" && m.kind === "text"),
    false,
    "Ada's other turn ended first, so this proves nothing",
  );

  fake.state.answerAtOnce = true;
  fake.state.held.forEach((finish) => finish());
  assert.ok(await idle(h, ada));
  assert.ok(await idle(h, ben));
});
