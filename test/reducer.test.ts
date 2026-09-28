// The client reducer: where a message lands, and what a card settles to.
//
// A message arrives on one event stream carrying a threadId that could be
// an agent or a room, and getting that wrong puts a reply in the wrong
// conversation.
import { settleUnanswered, withoutEdits } from "../src/state/reducer.ts";
import { test } from "node:test";
import assert from "node:assert/strict";

import { initialState, reducer, type AppState, type Bot, type Message } from "../src/state/reducer.ts";

const bot = (id: string, over: Partial<Bot> = {}): Bot => ({
  id,
  threadId: `t-${id}`,
  name: id,
  title: "",
  description: "",
  notifications: true,
  color: "blue",
  unread: false,
  modelSelection: { instanceId: "claude", model: "m" },
  messages: [],
  ...over,
});

const msg = (id: string, over: Partial<Message> = {}): Message => ({
  id,
  role: "bot",
  kind: "text",
  text: "hello",
  at: 1,
  ...over,
});

const withState = (over: Partial<AppState>): AppState => ({ ...initialState, ...over });

test("a message for an agent lands in that agent's thread", () => {
  const state = withState({ bots: [bot("a"), bot("b")] });
  const next = reducer(state, { type: "messageAdded", threadId: "t-a", message: msg("m1") });
  assert.equal(next.bots[0].messages.length, 1);
  assert.equal(next.bots[1].messages.length, 0);
});

test("a message for a room lands in the room, not an agent", () => {
  const state = withState({
    bots: [bot("a")],
    bloks: [{ id: "room-1", name: "Launch", memberIds: ["a"], createdAt: 0, messages: [] }],
  });
  const next = reducer(state, { type: "messageAdded", threadId: "room-1", message: msg("m1") });
  assert.equal(next.bloks[0].messages.length, 1);
  assert.equal(next.bots[0].messages.length, 0);
});

test("the same message arriving twice is only stored once", () => {
  // reconnecting the event stream replays, so this has to be idempotent
  const state = withState({ bots: [bot("a")] });
  const once = reducer(state, { type: "messageAdded", threadId: "t-a", message: msg("m1") });
  const twice = reducer(once, { type: "messageAdded", threadId: "t-a", message: msg("m1") });
  assert.equal(twice.bots[0].messages.length, 1);
});

test("an agent nobody has seen is added, not dropped", () => {
  // this is how a team hire shows up: the server broadcasts the whole
  // record on a channel that otherwise carries patches
  const state = withState({ bots: [bot("a")] });
  const next = reducer(state, {
    type: "botPatched",
    bot: { id: "new", threadId: "t-new", name: "Hire" } as Partial<Bot> & { id: string },
  });
  assert.equal(next.bots.length, 2);
  assert.equal(next.bots[0].id, "new");
  assert.deepEqual(next.bots[0].messages, [], "an arrival starts with an empty transcript");
});

test("hydrate skips an archived agent and opens a living one", () => {
  const state = withState({ selectedId: "" });
  const next = reducer(state, {
    type: "hydrate",
    bots: [bot("asdf", { hidden: true }), bot("keep")],
  });
  assert.equal(next.selectedId, "keep");
});

test("hydrate restores the last selected living agent", () => {
  const state = withState({ selectedId: "keep" });
  const next = reducer(state, {
    type: "hydrate",
    bots: [bot("asdf", { hidden: true }), bot("keep"), bot("other")],
  });
  assert.equal(next.selectedId, "keep");
});

test("a partial patch for an unknown agent is ignored", () => {
  // without a threadId it is a patch for something we do not have, and
  // inventing an agent from it would put a broken row in the sidebar
  const state = withState({ bots: [bot("a")] });
  const next = reducer(state, { type: "botPatched", bot: { id: "ghost", busy: true } });
  assert.equal(next.bots.length, 1);
});

test("patching a known agent keeps its messages", () => {
  const state = withState({ bots: [bot("a", { messages: [msg("m1")] })] });
  const next = reducer(state, { type: "botPatched", bot: { id: "a", busy: true } });
  assert.equal(next.bots[0].busy, true);
  assert.equal(next.bots[0].messages.length, 1);
});

test("answering a card settles it in the agent's thread", () => {
  const card = msg("c1", { kind: "options", card: { title: "t", subtitle: "s", options: ["Yes"] } });
  const state = withState({ bots: [bot("a", { messages: [card] })] });
  const next = reducer(state, { type: "answerCard", botId: "a", messageId: "c1", answer: "Yes" });
  assert.equal(next.bots[0].messages[0].card?.answered, "Yes");
});

test("answering a card shown in a room settles it in the room", () => {
  const card = msg("c1", { kind: "options", from: "a", card: { title: "t", subtitle: "s", options: ["Yes"] } });
  const state = withState({
    bots: [bot("a")],
    bloks: [{ id: "room-1", name: "R", memberIds: ["a"], createdAt: 0, messages: [card] }],
  });
  const next = reducer(state, {
    type: "answerCard",
    botId: "a",
    roomId: "room-1",
    messageId: "c1",
    answer: "Yes",
  });
  assert.equal(next.bloks[0].messages[0].card?.answered, "Yes");
  assert.equal(next.bots[0].messages.length, 0, "the agent's own thread is untouched");
});

test("selecting an agent clears its unread badge", () => {
  const state = withState({ bots: [bot("a", { unread: true })] });
  const next = reducer(state, { type: "select", id: "a" });
  assert.equal(next.selectedId, "a");
  assert.equal(next.bots[0].unread, false);
});

test("archiving the selected agent keeps its transcript and moves the selection", () => {
  // The row goes to the drawer rather than out of the state. Dropping it
  // and letting the bot frame put it back would put it back empty: a bot
  // frame carries no messages, so the transcript the archive drawer
  // promises to keep would be gone from the client that is open.
  const state = withState({ bots: [bot("a"), bot("b")], selectedId: "a" });
  const next = reducer(state, { type: "deleteBot", botId: "a" });
  assert.equal(next.bots.length, 2, "the agent left the client entirely");
  const archived = next.bots.find((b) => b.id === "a")!;
  assert.equal(archived.hidden, true);
  assert.ok(archived.archivedAt, "archived without the flag an older client reads");
  assert.equal(archived.messages.length, state.bots[0].messages.length, "the transcript went with it");
  assert.equal(next.selectedId, "b", "still looking at an agent that is gone from the list");
});

test("deleting it for good takes it out of the client", () => {
  const state = withState({ bots: [bot("a"), bot("b")], selectedId: "a" });
  const next = reducer(state, { type: "deleteBot", botId: "a", forget: true });
  assert.equal(next.bots.length, 1);
  assert.equal(next.selectedId, "b");
});

test("streaming text accumulates per thread and clears on its own", () => {
  let state = withState({ bots: [bot("a")] });
  state = reducer(state, { type: "streamDelta", threadId: "t-a", delta: "Hel" });
  state = reducer(state, { type: "streamDelta", threadId: "t-a", delta: "lo" });
  assert.equal(state.streaming["t-a"], "Hello");
  state = reducer(state, { type: "streamClear", threadId: "t-a" });
  assert.equal(state.streaming["t-a"], undefined);
});

test("the reducer never mutates the state it was given", () => {
  const before = withState({ bots: [bot("a")] });
  const snapshot = JSON.stringify(before);
  reducer(before, { type: "messageAdded", threadId: "t-a", message: msg("m1") });
  reducer(before, { type: "botPatched", bot: { id: "a", busy: true } });
  reducer(before, { type: "select", id: "a" });
  assert.equal(JSON.stringify(before), snapshot);
});

// Setup ends by opening the agent picker, which then has to explain
// itself differently: "who do you need first" rather than "build a new
// agent", and a skip rather than a back arrow. The flag that switches
// that copy must not leak into any later visit, or every subsequent
// agent gets the first-run wording.
test("the first-run flag is set only by a deliberate first-run open", () => {
  let state = withState({});
  state = reducer(state, { type: "toggleNewAgent", open: true, firstRun: true });
  assert.equal(state.newAgentOpen, true);
  assert.equal(state.newAgentFirstRun, true);

  // skipping clears it
  state = reducer(state, { type: "toggleNewAgent", open: false });
  assert.equal(state.newAgentFirstRun, false);

  // and a later ordinary open does not inherit it
  state = reducer(state, { type: "toggleNewAgent", open: true });
  assert.equal(state.newAgentOpen, true);
  assert.equal(state.newAgentFirstRun, false);
});

test("creating the first agent closes the picker and drops the first-run flag", () => {
  let state = reducer(withState({}), { type: "toggleNewAgent", open: true, firstRun: true });
  state = reducer(state, { type: "botAdded", bot: bot("chief") });
  assert.equal(state.newAgentOpen, false);
  assert.equal(state.newAgentFirstRun, false);
  assert.equal(state.selectedId, "chief");
});

test("an archived room stays out of the list after the server echoes it and after a reload", () => {
  const room = { id: "r1", name: "Setup", memberIds: ["a"], createdAt: 1, messages: [] };
  const other = { id: "r2", name: "Other", memberIds: ["a"], createdAt: 2, messages: [] };
  let state = reducer(withState({}), { type: "hydrateBloks", bloks: [room, other] });
  state = reducer(state, { type: "patchRoom", blokId: "r1", patch: { archived: true } });
  assert.deepEqual(state.bloks.map((b) => b.id), ["r2"]);

  // the server's broadcast of the same change
  const { messages: _m, ...echo } = room;
  state = reducer(state, { type: "blokPatched", blok: { ...echo, archived: true } });
  assert.deepEqual(state.bloks.map((b) => b.id), ["r2"], "the echo brought it back");

  // the next app load reads every room, archived ones included
  state = reducer(state, { type: "hydrateBloks", bloks: [{ ...room, archived: true }, other] });
  assert.deepEqual(state.bloks.map((b) => b.id), ["r2"], "a reload brought it back");
});

test("the echo of a save does not take back what has been typed since", () => {
  // typed "Chris", paused, the save went out, then " Engineer" was typed
  let state = withState({ bots: [bot("a", { name: "A" })] });
  state = reducer(state, { type: "updateBot", botId: "a", patch: { name: "Chris" } });
  state = reducer(state, { type: "updateBot", botId: "a", patch: { name: "Chris Engineer" } });
  // the server's broadcast of the first save, arriving now, with a title
  // changed somewhere else
  const echo = { id: "a", name: "Chris", title: "Ships code" };
  state = reducer(state, { type: "botPatched", bot: withoutEdits(echo, new Set(["name"])) });
  assert.equal(state.bots[0].name, "Chris Engineer");
  assert.equal(state.bots[0].title, "Ships code", "fields nobody is typing into still arrive");
  assert.equal(withoutEdits(echo, new Set()), echo, "nothing being edited, nothing copied");
});

test("an older save response does not clear a newer unanswered mark", () => {
  // Generations are monotonic per field (allocated outside this helper).
  const unanswered = new Map<string, number>();
  const seq = new Map<string, number>();
  const send = () => {
    const gen = (seq.get("name") ?? 0) + 1;
    seq.set("name", gen);
    unanswered.set("name", gen);
    return gen;
  };
  const a = send(); // 1
  const b = send(); // 2
  // B finishes first
  assert.deepEqual([...settleUnanswered(unanswered, new Map([["name", b]]))], []);
  assert.equal(unanswered.has("name"), false);
  const c = send(); // 3, after B settled
  // A's late response must not match C
  assert.deepEqual([...settleUnanswered(unanswered, new Map([["name", a]]))], ["name"]);
  assert.equal(unanswered.get("name"), c, "C's mark survives A's late response");
  assert.deepEqual([...settleUnanswered(unanswered, new Map([["name", c]]))], []);
  assert.equal(unanswered.has("name"), false);
});

test("a renamed lane shows its new name at once, and only that lane changes", () => {
  const lanes = [
    { id: "l1", title: "see general", state: "idle" as const, createdAt: 1 },
    { id: "l2", title: "General", state: "idle" as const, createdAt: 2 },
  ];
  let state = withState({ bots: [bot("a", { tasks: lanes }), bot("b", { tasks: lanes })] });
  state = reducer(state, { type: "renameTask", botId: "a", taskId: "l1", title: "Q3 numbers" });
  assert.deepEqual(state.bots[0].tasks!.map((t) => t.title), ["Q3 numbers", "General"]);
  assert.deepEqual(state.bots[1].tasks!.map((t) => t.title), ["see general", "General"], "another agent's lane of the same id");
});
