// Who a room shows as thinking (src/components/RoomView.tsx, workingInRoom).
//
// The room read each member's own busy flag, which is up while any of its
// lanes works. A member at work in a conversation of its own showed "is
// thinking" in every room it was in, with nothing coming. Each lane now
// says which room its running turn speaks in, and the room reads that.
import { test } from "node:test";
import assert from "node:assert/strict";

import { workingInRoom } from "../src/state/reducer.ts";
import { startHarness } from "./helpers/server.ts";
import { agentOn, fakeProvider, idle, waitFor } from "./helpers/turns.ts";

test("a member reads as thinking in a room only while its turn there runs", async (t) => {
  const fake = await fakeProvider(t);
  const h = await startHarness();
  t.after(() => h.stop());
  const ada = await agentOn(h, fake.port, "Ada");
  const ben = await agentOn(h, fake.port, "Ben");
  const { blok: room } = await h.json("/api/bloks", { method: "POST", body: JSON.stringify({ name: "Plans", memberIds: [ada.id, ben.id] }) });
  const seen = async () => (await h.json("/api/bots?messages=0")).bots.find((b: any) => b.id === ada.id);

  // at work in her own conversation
  await h.fetch(`/api/bots/${ada.id}/messages`, { method: "POST", body: JSON.stringify({ text: "SOLO-WORK" }) });
  assert.ok(await waitFor(() => fake.sent("SOLO-WORK") > 0), "her own turn never started");
  const solo = await seen();
  assert.equal(solo.busy, true, "she was not busy, so this proves nothing");
  assert.equal(workingInRoom(solo, room.id), false, "a turn in her own conversation showed as thinking in the room");
  fake.state.held.splice(0).forEach((finish) => finish());
  assert.ok(await idle(h, ada));

  // then taking her turn in the room
  await h.fetch(`/api/bloks/${room.id}/messages`, { method: "POST", body: JSON.stringify({ text: "@Ada ROOM-ROUND what is next?" }) });
  assert.ok(
    await waitFor(() => fake.state.calls.some((c) => c.includes("You are Ada") && c.includes("ROOM-ROUND"))),
    "she never spoke in the room",
  );
  assert.equal(workingInRoom(await seen(), room.id), true, "her turn in the room did not show there");
  fake.state.answerAtOnce = true;
  fake.state.held.splice(0).forEach((finish) => finish());
  assert.ok(await idle(h, ada));
  assert.ok(await idle(h, ben));
  assert.equal(workingInRoom(await seen(), room.id), false, "she still read as thinking after her turn ended");
});

test("a harness too old to say which room keeps the agent's own flag", () => {
  assert.equal(workingInRoom({ busy: true }, "room-1"), true);
  assert.equal(workingInRoom({ busy: false }, "room-1"), false);
  assert.equal(workingInRoom({ busy: true, tasks: [{ room: "room-2" }] }, "room-1"), false);
});
