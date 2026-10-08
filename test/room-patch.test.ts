// A room change the server refuses is said, and the list is put back
// from the server (GitHub 226).
import { test } from "node:test";
import assert from "node:assert/strict";

import { sendRoomPatch } from "../src/lib/roomPatch.ts";
import { reducer, initialState } from "../src/state/reducer.ts";

test("a refused archive shows the error and the room comes back", async () => {
  const room = { id: "room-1", name: "Launch", memberIds: [], messages: [], archived: false } as any;
  let state = reducer(initialState, { type: "hydrateBloks", bloks: [room] });
  // the list moves at once, as the app does before the request
  state = reducer(state, { type: "patchRoom", blokId: room.id, patch: { archived: true } });
  assert.deepEqual(state.bloks.map((b) => b.id), []);

  const errors: unknown[] = [];
  const api = async (path: string, init?: RequestInit) => {
    if (init?.method === "PATCH") throw new Error("Could not archive that room");
    assert.equal(path, "/api/bloks");
    return { bloks: [room] };
  };
  await sendRoomPatch(api, room.id, { archived: true }, (bloks) => {
    state = reducer(state, { type: "hydrateBloks", bloks });
  }, (e) => errors.push(e));

  assert.equal((errors[0] as Error)?.message, "Could not archive that room");
  assert.deepEqual(state.bloks.map((b) => b.id), ["room-1"]);
});

test("an archive the server takes leaves the list as it is", async () => {
  const calls: string[] = [];
  const errors: unknown[] = [];
  await sendRoomPatch(async (path) => (calls.push(path), {}), "room-1", { archived: true }, () => calls.push("hydrate"), (e) => errors.push(e));
  assert.deepEqual(calls, ["/api/bloks/room-1"]);
  assert.equal(errors.length, 0);
});
