// The rules behind changing a room in the app (src/lib/roomEdit.ts,
// GitHub 370): who a picker offers and how many it takes, the name a
// rename keeps, the one change the Agents dialog saves, what it says when
// the lead is taken out, and the New room dialog a fresh start opens.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MAX_MEMBERS,
  freshStartPreset,
  leadNote,
  nextRoomName,
  roomCandidates,
  rosterPatch,
  togglePicked,
} from "../src/lib/roomEdit.ts";
import { initialState, reducer, type Blok, type Bot } from "../src/state/reducer.ts";

const agent = (id: string, extra: Partial<Bot> = {}) => ({ id, name: id.toUpperCase(), ...extra }) as Bot;

test("a picker takes up to eight and refuses the ninth, and a second tap takes one out", () => {
  let picked: string[] = [];
  for (let i = 1; i <= MAX_MEMBERS + 1; i++) picked = togglePicked(picked, `a${i}`);
  assert.equal(MAX_MEMBERS, 8);
  assert.deepEqual(picked, ["a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8"]);
  // full, out is still allowed, and then there is room again
  picked = togglePicked(picked, "a3");
  assert.equal(picked.includes("a3"), false);
  assert.deepEqual(togglePicked(picked, "a9").at(-1), "a9");
});

test("hidden agents and other people's solo agents are never offered, and a room's own members come first", () => {
  const bots = [
    agent("ada"),
    agent("ghost", { hidden: true }),
    agent("sams", { solo: { by: "person-sam" } }),
    agent("mine", { solo: { by: "owner" } }),
    agent("bo"),
    agent("old", { hidden: true, archivedAt: 1 }),
  ];
  assert.deepEqual(roomCandidates(bots).map((b) => b.id), ["ada", "mine", "bo"]);
  // an archived member keeps its seat until someone takes it away, so it
  // is listed for the room it is in, in the room's order, and nowhere else
  assert.deepEqual(roomCandidates(bots, ["bo", "old"]).map((b) => b.id), ["bo", "old", "ada", "mine"]);
});

test("a rename keeps the words trimmed, folded and clamped, and blank or unchanged keeps the old name", () => {
  assert.equal(nextRoomName("  Launch   week ", "Launch"), "Launch week");
  assert.equal(nextRoomName("x".repeat(120), "Launch"), "x".repeat(80));
  assert.equal(nextRoomName("   ", "Launch"), null);
  assert.equal(nextRoomName(" Launch ", "Launch"), null);
});

test("the Agents dialog saves the roster and a tapped crown in one change, and nothing when nothing moved", () => {
  const room = { memberIds: ["ada", "bo"], leadId: "bo" };
  assert.equal(rosterPatch(room, ["ada", "bo"], "bo"), null);
  assert.deepEqual(rosterPatch(room, ["ada", "bo", "cy"], "bo"), { memberIds: ["ada", "bo", "cy"] });
  assert.deepEqual(rosterPatch(room, ["ada", "bo", "cy"], "cy"), { memberIds: ["ada", "bo", "cy"], leadId: "cy" });
  // the crowned lead taken out: no crown is sent, and the server puts
  // the room on seniority by itself
  assert.deepEqual(rosterPatch(room, ["ada", "cy"], "bo"), { memberIds: ["ada", "cy"] });
  // a new crown alone is still a change
  assert.deepEqual(rosterPatch(room, ["ada", "bo"], "ada"), { memberIds: ["ada", "bo"], leadId: "ada" });
  // the same agents in another order are another room: ties go to whoever is first
  assert.deepEqual(rosterPatch(room, ["bo", "ada"], "bo"), { memberIds: ["bo", "ada"] });
});

test("taking the lead out says who leads now, by the rule the room uses", () => {
  const ada = { id: "ada", name: "Ada", seniority: 3 };
  const bo = { id: "bo", name: "Bo", seniority: 5 };
  const cy = { id: "cy", name: "Cy", seniority: 3 };
  // Bo led and is gone: the next most senior, ties to whoever is first
  assert.equal(leadNote(bo, [ada, cy], "bo"), "Bo is out, so Ada leads now, as the most senior.");
  assert.equal(leadNote(bo, [cy, ada], null), "Bo is out, so Cy leads now, as the most senior.");
  // a crown tapped by hand needs no explaining, and neither does a lead who stayed
  assert.equal(leadNote(bo, [ada, cy], "cy"), null);
  assert.equal(leadNote(bo, [bo, ada], "bo"), null);
  // one agent left is not a room to lead
  assert.equal(leadNote(bo, [ada], null), null);
});

test("a fresh start fills in the same team, crown, answering and folder, and leaves out who cannot answer", () => {
  const bots = [agent("ada"), agent("bo"), agent("cy"), agent("gone", { hidden: true, archivedAt: 5 })];
  const room = {
    id: "room-1",
    name: "Launch",
    memberIds: ["bo", "gone", "ada"],
    leadId: "ada",
    leadOnly: true,
    cwd: "/work/old",
    pinnedCwd: "/work/launch",
    createdAt: 1,
    messages: [],
  } as Blok;
  assert.deepEqual(freshStartPreset(room, bots), {
    name: "Launch",
    memberIds: ["bo", "ada"],
    leadId: "ada",
    leadOnly: true,
    cwd: "/work/launch",
    from: "Launch",
  });
  // an archived lead does not come along, so the new room is on seniority;
  // a room whose members each used their own folder passes none on
  const plain = freshStartPreset({ ...room, leadId: "gone", leadOnly: undefined, pinnedCwd: null }, bots);
  assert.equal(plain.leadId, null);
  assert.equal(plain.leadOnly, false);
  assert.equal("cwd" in plain, false);
  // a folder set but not yet pinned by a first turn still counts
  assert.equal(freshStartPreset({ ...room, pinnedCwd: undefined }, bots).cwd, "/work/old");
});

test("the preset opens the New room dialog filled in, and never outlives it", () => {
  const preset = { name: "Launch", memberIds: ["ada", "bo"], leadId: null, leadOnly: false, from: "Launch" };
  let state = reducer(initialState, { type: "toggleNewRoom", open: true, preset });
  assert.equal(state.newRoomOpen, true);
  assert.deepEqual(state.newRoomPreset, preset);
  // closed, by Cancel or by the room being made
  state = reducer(state, { type: "toggleNewRoom", open: false });
  assert.equal(state.newRoomPreset, null);
  // and an ordinary New room is empty, whatever came before
  state = reducer(reducer(state, { type: "toggleNewRoom", open: true, preset }), { type: "toggleNewRoom", open: false });
  state = reducer(state, { type: "toggleNewRoom", open: true });
  assert.equal(state.newRoomOpen, true);
  assert.equal(state.newRoomPreset, null);
});

test("a rename is shown at once in every place that lists the room", () => {
  const room = { id: "room-1", name: "Launch", memberIds: [], messages: [], createdAt: 1 } as Blok;
  let state = reducer(initialState, { type: "hydrateBloks", bloks: [room] });
  state = reducer(state, { type: "patchRoom", blokId: room.id, patch: { name: "Launch week" } });
  assert.equal(state.bloks[0].name, "Launch week");
  // the server's frame says the same, and the transcript is untouched
  state = reducer(state, { type: "blokPatched", blok: { ...room, name: "Launch week" } });
  assert.equal(state.bloks[0].name, "Launch week");
  assert.deepEqual(state.bloks[0].messages, []);
});
