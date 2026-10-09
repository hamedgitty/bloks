// The client reducer: where a message lands, and what a card settles to.
//
// A message arrives on one event stream carrying a threadId that could be
// an agent or a room, and getting that wrong puts a reply in the wrong
// conversation.
import { settleUnanswered, withoutEdits } from "../src/state/reducer.ts";
import { test } from "node:test";
import assert from "node:assert/strict";

import { configFromFrame, initialState, openLaneWorking, reducer, type AppState, type Bot, type Message } from "../src/state/reducer.ts";

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

test("a queued message that went moves to the end of the conversation, in an agent's thread or a room", () => {
  // The server moves it on disk when it goes (GitHub 170); a screen that
  // only patched it in place would show it above everything said while
  // it waited, until the next reload put it right.
  const waiting = msg("q1", { role: "user", text: "later", queued: true });
  const went = { ...waiting, queued: false, deliveredAt: 5, at: 5 };
  const room = { id: "room-1", name: "Launch", memberIds: ["a"], createdAt: 0, messages: [msg("r0"), waiting, msg("r1")] };
  const state = withState({ bots: [bot("a", { messages: [msg("m0"), waiting, msg("m1")] })], bloks: [room] });
  const moved = reducer(state, { type: "messagePatched", threadId: "t-a", message: went, moved: true });
  assert.deepEqual(moved.bots[0].messages.map((m) => m.id), ["m0", "m1", "q1"]);
  assert.equal(moved.bots[0].messages[2].queued, false);
  const inRoom = reducer(state, { type: "messagePatched", threadId: "room-1", message: went, moved: true });
  assert.deepEqual(inRoom.bloks[0].messages.map((m) => m.id), ["r0", "r1", "q1"]);
  // an ordinary patch, a reaction or an edit, stays where it is
  const edited = reducer(state, { type: "messagePatched", threadId: "t-a", message: { ...waiting, text: "sooner" } });
  assert.deepEqual(edited.bots[0].messages.map((m) => m.id), ["m0", "q1", "m1"]);
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

test("a finished turn's text stays until its message lands, and a late delta cannot reopen it", () => {
  // Through the relay the message can arrive after the turn's end, and a
  // delta after both. Neither may leave a gap or a second copy.
  let state = withState({ bots: [bot("a")] });
  state = reducer(state, { type: "turnStarted", threadId: "t-a" });
  state = reducer(state, { type: "streamDelta", threadId: "t-a", delta: "Hello" });
  state = reducer(state, { type: "turnSettled", threadId: "t-a" });
  assert.equal(state.streaming["t-a"], "Hello", "the reply vanished before its message came");
  state = reducer(state, { type: "messageAdded", threadId: "t-a", message: { ...msg("m1"), role: "bot", kind: "text", text: "Hello" } });
  assert.equal(state.streaming["t-a"], undefined);
  state = reducer(state, { type: "streamDelta", threadId: "t-a", delta: "Hello" });
  assert.equal(state.streaming["t-a"], undefined, "a late delta opened a second copy");
  // the next turn streams as usual, and a linger timer from the last one
  // does not cut it off
  state = reducer(state, { type: "turnStarted", threadId: "t-a" });
  state = reducer(state, { type: "streamDelta", threadId: "t-a", delta: "Next" });
  state = reducer(state, { type: "streamClear", threadId: "t-a", onlyIfSettled: true });
  assert.equal(state.streaming["t-a"], "Next");
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

test("a settings broadcast keeps the new agent defaults, so the card does not vanish", () => {
  // what PUT /api/config broadcasts after a save, arriving after its own response
  const frame = {
    kind: "config",
    _seq: 7,
    xai: { configured: false },
    composio: { configured: false },
    box: { configured: false },
    profile: { about: "" },
    skills: { propose: true },
    agentDefaults: { effort: "high" },
  };
  let state = withState({});
  state = reducer(state, { type: "configStatus", config: configFromFrame(frame) });
  assert.deepEqual(state.config?.agentDefaults, { effort: "high" });
  assert.deepEqual(state.config?.skills, { propose: true });
  assert.equal("kind" in state.config!, false, "the stream's own fields stay out");
  assert.equal("_seq" in state.config!, false);
});

test("an agent announced before the reply that made it is not listed twice", () => {
  let state = withState({});
  const made = bot("n", { threadId: "t-n" });
  state = reducer(state, { type: "botPatched", bot: made });
  state = reducer(state, { type: "botAdded", bot: made });
  assert.deepEqual(state.bots.map((b) => b.id), ["n"]);
  assert.equal(state.selectedId, "n");
});

test("a page of earlier messages lands above, once, and only on the lane it was for", () => {
  const state = withState({ bots: [bot("a", { messages: [msg("m3"), msg("m4")], olderMessages: 2 })] });
  const page = { type: "earlierLoaded" as const, id: "a", threadId: "t-a", messages: [msg("m1"), msg("m2"), msg("m3")], olderMessages: 0 };
  const next = reducer(state, page);
  const a = next.bots[0];
  assert.deepEqual(a.messages.map((m) => m.id), ["m1", "m2", "m3", "m4"]);
  assert.equal(a.olderMessages, 0);
  // the lane changed while the page was loading: the page is not this lane's
  const moved = reducer(state, { ...page, threadId: "t-other" });
  assert.equal(moved.bots[0].messages.length, 2);
});

test("marking one conversation unread lights it and its agent, and nothing else", () => {
  const lanes = [
    { id: "l1", title: "One", state: "idle" as const, createdAt: 1 },
    { id: "l2", title: "Two", state: "idle" as const, createdAt: 2 },
  ];
  const state = withState({ bots: [bot("a", { tasks: lanes })] });
  const next = reducer(state, { type: "markLaneUnread", botId: "a", taskId: "l2" });
  const a = next.bots[0];
  assert.equal(a.unread, true);
  assert.deepEqual(a.tasks?.map((t) => Boolean(t.unread)), [false, true]);
});

test("only the conversation on screen reads as working, not every one of the agent's", () => {
  const lanes = [
    { id: "t-a", createdAt: 1, state: "idle" },
    { id: "t-b", createdAt: 2, state: "working" },
  ];
  assert.equal(openLaneWorking({ threadId: "t-a", activeTaskId: "t-a", busy: true, tasks: lanes }), false, "an idle lane said working");
  assert.equal(openLaneWorking({ threadId: "t-b", activeTaskId: "t-b", busy: true, tasks: lanes }), true);
  // a harness too old to report lanes keeps the agent-wide flag
  assert.equal(openLaneWorking({ threadId: "t-a", busy: true }), true);
});

test("a placement lands on the agents and rooms it names, and nowhere else", () => {
  // a drop shows at once, neighbours and all; the server's frames follow
  const room = { id: "r1", name: "Standup", memberIds: ["a"], createdAt: 1, pinned: true, pinOrder: 1, messages: [] };
  const state = withState({ bots: [bot("a", { pinned: true, pinOrder: 2 }), bot("b")], bloks: [room] });
  const next = reducer(state, {
    type: "placed",
    rows: [
      { kind: "agent", id: "b", patch: { section: null, pinned: true, pinOrder: 1 } },
      { kind: "room", id: "r1", patch: { pinOrder: 2 } },
      { kind: "agent", id: "a", patch: { pinOrder: 3 } },
    ],
  });
  assert.deepEqual(next.bots.map((b) => [b.id, b.pinned, b.pinOrder]), [
    ["a", true, 3],
    ["b", true, 1],
  ]);
  assert.equal(next.bloks[0].pinOrder, 2);
  assert.equal(next.bots[0].messages, state.bots[0].messages, "a placement touched a transcript");
});

test("the order of the headings comes from the workspace, and a drag replaces it", () => {
  const loaded = reducer(withState({}), { type: "sectionOrder", order: ["Travel", "Ops"] });
  assert.deepEqual(loaded.sectionOrder, ["Travel", "Ops"]);
  const moved = reducer(loaded, { type: "moveSections", order: ["Ops", "Travel"] });
  assert.deepEqual(moved.sectionOrder, ["Ops", "Travel"]);
});

test("a lane opened elsewhere drops the last lane's transcript and asks for its own", () => {
  // A bot frame never carries messages. One that moved the agent to
  // another lane (a rehearsal, or a lane picked on the phone) kept the old
  // lane's words on screen under the new lane's name.
  const state = withState({ bots: [bot("a", { threadId: "t1", activeTaskId: "t1", messages: [msg("old")], olderMessages: 40 })] });
  const moved = reducer(state, { type: "botPatched", bot: { id: "a", threadId: "t2", activeTaskId: "t2" } });
  assert.deepEqual(moved.bots[0].messages, []);
  assert.equal(moved.bots[0].olderMessages, undefined);
  assert.deepEqual(moved.laneLoads, { a: "t2" });
  // nothing changed lanes: nothing to ask for
  const same = reducer(state, { type: "botPatched", bot: { id: "a", threadId: "t1", name: "Ada" } });
  assert.deepEqual(same.bots[0].messages.map((m) => m.id), ["old"]);
  assert.deepEqual(same.laneLoads, {});
});

test("the asked-for transcript lands once, with what the stream brought meanwhile after it", () => {
  let state = withState({ bots: [bot("a", { threadId: "t1", activeTaskId: "t1", messages: [msg("old")] })] });
  state = reducer(state, { type: "botPatched", bot: { id: "a", threadId: "t2", activeTaskId: "t2" } });
  // said in the new lane while its page was on the way
  state = reducer(state, { type: "messageAdded", threadId: "t2", message: msg("live", { text: "newest" }) });
  const page = [msg("first", { role: "user" }), msg("live", { text: "older copy" })];
  const loaded = reducer(state, { type: "laneLoaded", id: "a", threadId: "t2", messages: page, olderMessages: 3 });
  assert.deepEqual(loaded.bots[0].messages.map((m) => m.id), ["first", "live"]);
  assert.equal(loaded.bots[0].messages[1].text, "newest");
  assert.equal(loaded.bots[0].olderMessages, 3);
  assert.deepEqual(loaded.laneLoads, {});
  // a second answer for the same lane is not stacked on the first
  const twice = reducer(loaded, { type: "laneLoaded", id: "a", threadId: "t2", messages: page, olderMessages: 3 });
  assert.equal(twice, loaded);
});

test("an answer for a lane no longer open is dropped", () => {
  let state = withState({ bots: [bot("a", { threadId: "t1", activeTaskId: "t1" })] });
  state = reducer(state, { type: "botPatched", bot: { id: "a", threadId: "t2", activeTaskId: "t2" } });
  state = reducer(state, { type: "botPatched", bot: { id: "a", threadId: "t3", activeTaskId: "t3" } });
  const stale = reducer(state, { type: "laneLoaded", id: "a", threadId: "t2", messages: [msg("x")], olderMessages: 0 });
  assert.deepEqual(stale.bots[0].messages, []);
  assert.deepEqual(stale.laneLoads, { a: "t3" });
  // a switch that brings its own transcript needs no asking
  const answered = reducer(state, {
    type: "botPatched",
    bot: { id: "a", threadId: "t4", activeTaskId: "t4", messages: [msg("y")] },
  });
  assert.deepEqual(answered.bots[0].messages.map((m) => m.id), ["y"]);
  assert.deepEqual(answered.laneLoads, {});
});

test("a reply landing in a lane in the background ends that lane's streamed text", () => {
  // Only the open lane's messages are kept here, and the message for a
  // background lane returned before the preview was cleared. Its preview
  // kept every word of the turn, so opening the lane mid-turn repeated
  // what had already been said above it.
  const state = withState({
    bots: [bot("a", { threadId: "t-open" })],
    streaming: { "t-back": "Here is the first part", "t-open": "still going" },
  });
  const next = reducer(state, { type: "messageAdded", threadId: "t-back", message: msg("m1", { text: "Here is the first part" }) });
  assert.deepEqual(next.streaming, { "t-open": "still going" });
  assert.equal(next.bots[0].messages.length, 0);
  // a tool call is not the reply, and leaves the preview alone
  const tool = reducer(state, { type: "messageAdded", threadId: "t-back", message: msg("m2", { kind: "activity" }) });
  assert.equal(tool.streaming["t-back"], "Here is the first part");
});

test("an older error's timer does not take a newer error off the screen", () => {
  // Every failure used to start its own six second clear, and the first
  // one to fire cleared whatever was showing: a second error two seconds
  // after the first was gone after four.
  const first = reducer(withState({}), { type: "error", message: "Could not send that" });
  const second = reducer(first, { type: "error", message: "Could not rename that room" });
  const early = reducer(second, { type: "error", message: null, at: first.errorAt });
  assert.equal(early.error, "Could not rename that room");
  const due = reducer(early, { type: "error", message: null, at: second.errorAt });
  assert.equal(due.error, null);
  // the same words twice are two errors, each with its own time
  const again = reducer(second, { type: "error", message: "Could not rename that room" });
  assert.notEqual(again.errorAt, second.errorAt);
});
