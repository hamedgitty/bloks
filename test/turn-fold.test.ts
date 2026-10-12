// A finished turn's work folds into one line, leaving the request and
// the result (GitHub 257): what goes under the fold, what stays out, what
// the line says, and that nothing folds while a turn is still running.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  askerWords,
  foldHolding,
  foldRoom,
  foldTurns,
  foldWords,
  lastFoldKey,
  rowsFrom,
  turnRunning,
  workedFor,
  type Folded,
  type TurnFold,
  type TurnRow,
} from "../src/lib/turnFold.ts";
import { kindOf } from "../src/lib/tool-summary.ts";
import type { Message } from "../src/state/reducer.ts";

const T0 = Date.UTC(2026, 0, 5, 9, 0, 0);
/** A clock that moves a minute a message unless told otherwise. */
let minute = 0;
const stamp = (at?: number) => T0 + (at ?? minute++) * 60_000;
const fresh = () => {
  minute = 0;
};

type Extra = Partial<Message> & { min?: number };
const make = (id: string, base: Partial<Message>, { min, ...extra }: Extra = {}): Message =>
  ({ id, role: "bot", kind: "text", ...base, ...extra, at: stamp(min) }) as Message;

const me = (id: string, extra?: Extra) => make(id, { role: "user", text: `me ${id}` }, extra);
const says = (id: string, extra?: Extra) => make(id, { text: `says ${id}` }, extra);
const tool = (id: string, name = "Bash", extra?: Extra) => make(id, { kind: "activity", tool: { name, ok: true } }, extra);
const asked = (id: string, peerId: string, peerName: string, extra?: Extra) =>
  make(id, { role: "user", text: `from ${peerName}`, agent: { dir: "in", peerId, peerName } }, extra);
const messaged = (id: string, peerId: string, peerName: string, extra?: Extra) =>
  make(
    id,
    { kind: "activity", text: `to ${peerName}`, tool: { name: `messaged ${peerName}`, ok: true }, agent: { dir: "out", peerId, peerName, status: "sent" } },
    extra,
  );
const changed = (id: string, total: number, extra?: Extra, shared = 0) =>
  make(
    id,
    {
      kind: "changes",
      changes: { checkpointId: `cp-${id}`, files: [], total, ...(shared ? { shared: { total: shared, alongside: ["bot-2"] } } : {}) },
    },
    extra,
  );
const notice = (id: string, text = "The turn was stopped.", extra?: Extra) => make(id, { kind: "notice", text }, extra);
const artifact = (id: string) => make(id, { kind: "artifact", artifact: { name: "report.pdf", mime: "application/pdf", size: 10 } });
const card = (id: string, answered?: string, extra?: Extra) =>
  make(id, { kind: "options", card: { title: "Approval needed", subtitle: "rm -rf build", options: ["Allow", "Deny"], requestId: `r-${id}`, ...(answered ? { answered } : {}) } }, extra);

/** The page as one line a row: a message by its id, a fold by what is under it. */
const page = (rows: TurnRow[]) =>
  rows.flatMap((row) => (row.kind === "fold" ? [`fold(${row.fold.messages.map((m) => m.id).join(" ")})`] : row.items.map((item) => item.message.id)));
const foldsOf = (folded: Folded): TurnFold[] => folded.rows.flatMap((row) => (row.kind === "fold" ? [row.fold] : []));
const line = (fold: TurnFold) => foldWords(fold, kindOf).join(" · ");

test("a Telegram person's reply and delivery state stay visible after private chat text", () => {
  fresh();
  const source = { botId: "planning", bindingGeneration: "one", personId: "lee", userId: 2, name: "Lee", grant: "allowed", chatId: 2, messageId: 3, requester: "telegram:lee" };
  for (const state of ["sent", "failed", "uncertain"] as const) {
    const folded = foldTurns([
      me("in", { telegramPerson: source }),
      tool("read", "Read"),
      says("sent", { telegramSent: { personId: "lee", name: "Lee", state } }),
      says("private"),
    ], false);
    assert.deepEqual(page(folded.rows), ["in", "fold(read)", "sent", "private"]);
    assert.equal(askerWords(foldsOf(folded)[0].asker!), "Message from Lee (Telegram)");
    assert.equal(foldHolding(folded.rows, 2), null);
  }
});

describe("the three shapes", () => {
  test("I asked: my message, the line, the reply", () => {
    fresh();
    const said = [
      me("ask"),
      says("p1"),
      tool("t1"),
      tool("t2"),
      says("p2"),
      tool("t3"),
      messaged("out", "qa", "QA"),
      says("reply", { min: 8 }),
      changed("files", 4, { min: 8 }),
    ];
    const folded = foldTurns(said, false);
    assert.deepEqual(page(folded.rows), ["ask", "fold(p1 t1 t2 p2 t3 out files)", "reply"]);
    const [fold] = foldsOf(folded);
    assert.equal(line(fold), "worked 8 min · 3 commands · 4 files");
    assert.equal(fold.asker, null, "my own turn names nobody");
    assert.deepEqual(fold.messaged, [{ peerId: "qa", peerName: "QA" }]);
    assert.equal(fold.replied, false);
    assert.equal(fold.alone, false);
    assert.equal(folded.named.size, 0);
  });

  test("another agent asked and the agent wrote something for me: the line says who asked, then the reply", () => {
    fresh();
    const said = [
      asked("in", "hoe", "Head of Engineering"),
      tool("t1"),
      says("p1", { afterAgent: { peerId: "hoe", peerName: "Head of Engineering" } }),
      tool("t2"),
      says("reply", { min: 3, afterAgent: { peerId: "hoe", peerName: "Head of Engineering" } }),
    ];
    const folded = foldTurns(said, false);
    // the message that started it is on the line, not a row of its own
    assert.deepEqual(page(folded.rows), ["fold(in t1 p1 t2)", "reply"]);
    const [fold] = foldsOf(folded);
    assert.equal(fold.asker?.by, "agent");
    assert.equal(askerWords(fold.asker!), "Head of Engineering asked");
    assert.equal(askerWords(fold.asker!, { name: "CTO" }), "CTO asked", "the name it has now");
    assert.equal(line(fold), "worked 3 min · 2 commands");
    assert.equal(fold.alone, false);
    assert.equal(fold.replied, false);
    // the "After a message from" link goes from the reply: the line says it
    assert.ok(folded.named.has("reply"));
    // and the name opens the exchange at the message that asked
    assert.equal(fold.asker?.by === "agent" && fold.asker.message.id, "in");
  });

  test("another agent asked and the agent only answered that agent: the line alone, ending in replied", () => {
    fresh();
    const said = [
      me("ask"),
      says("earlier"),
      asked("in", "qa", "QA", { min: 10 }),
      tool("t1", "Bash", { min: 10.3 }),
      tool("t2", "Bash", { min: 10.6 }),
      messaged("back", "qa", "QA", { min: 11 }),
    ];
    const folded = foldTurns(said, false);
    assert.deepEqual(page(folded.rows), ["ask", "earlier", "fold(in t1 t2 back)"]);
    const fold = foldsOf(folded)[0];
    assert.equal(askerWords(fold.asker!), "QA asked");
    assert.equal(line(fold), "worked 1 min · 2 commands");
    assert.equal(fold.replied, true);
    assert.equal(fold.alone, true, "nothing for the person, so it is drawn muted");
    // the one that asked is not shown again among those it messaged
    assert.deepEqual(fold.messaged, []);
  });

  test("it wrote for me and also answered the one that asked", () => {
    fresh();
    const said = [asked("in", "qa", "QA"), tool("t1"), messaged("back", "qa", "QA"), messaged("on", "eng", "Engineer"), says("reply")];
    const [fold] = foldsOf(foldTurns(said, false));
    assert.equal(fold.replied, true);
    assert.equal(fold.alone, false);
    assert.deepEqual(fold.messaged, [{ peerId: "eng", peerName: "Engineer" }]);
  });
});

describe("what a turn is", () => {
  test("a turn still running is left exactly as it is, and the ones before it fold", () => {
    fresh();
    const said = [me("a1"), tool("t1"), says("r1"), me("a2"), says("p"), tool("t2")];
    assert.deepEqual(page(foldTurns(said, true).rows), ["a1", "fold(t1)", "r1", "a2", "p", "t2"]);
    // and once it ends, its work folds too
    assert.deepEqual(page(foldTurns([...said, says("r2")], false).rows), ["a1", "fold(t1)", "r1", "a2", "fold(p t2)", "r2"]);
  });

  test("with nothing in the transcript but a running turn, nothing folds", () => {
    fresh();
    const said = [me("a"), says("p1"), tool("t1"), says("p2")];
    assert.deepEqual(page(foldTurns(said, true).rows), ["a", "p1", "t1", "p2"]);
    assert.equal(lastFoldKey(foldTurns(said, true).rows), "");
  });

  test("my words in the middle of a turn never fold, and split its work in two", () => {
    fresh();
    const said = [me("ask"), says("p1"), tool("t1"), says("p2"), me("also", { midTurn: true }), tool("t2"), tool("t3"), says("reply")];
    const folded = foldTurns(said, false);
    assert.deepEqual(page(folded.rows), ["ask", "fold(p1 t1 p2)", "also", "fold(t2 t3)", "reply"]);
    const [before, after] = foldsOf(folded);
    // each line is about its own part: up to my words, and from them on
    assert.equal(line(before), "worked 4 min · 1 command");
    assert.equal(line(after), "worked 3 min · 2 commands");
  });

  test("a transcript that does not say a message joined a turn takes it as the start of one", () => {
    fresh();
    // written before midTurn was recorded: the same messages, unmarked
    const said = [me("ask"), says("p1"), tool("t1"), says("p2"), me("also"), tool("t2"), says("reply")];
    // the last thing said before my words reads as that turn's result, which
    // shows a little more than it might and never hides a reply
    assert.deepEqual(page(foldTurns(said, false).rows), ["ask", "fold(p1 t1)", "p2", "also", "fold(t2)", "reply"]);
  });

  test("a transcript that opens in the middle of a turn folds what it has", () => {
    fresh();
    const said = [tool("t1"), says("p"), tool("t2"), says("reply"), me("next"), says("r2")];
    assert.deepEqual(page(foldTurns(said, false).rows), ["fold(t1 p t2)", "reply", "next", "r2"]);
  });

  test("messages that waited and went together start one turn", () => {
    fresh();
    const said = [me("a"), me("b"), tool("t1"), says("reply")];
    assert.deepEqual(page(foldTurns(said, false).rows), ["a", "b", "fold(t1)", "reply"]);
  });

  test("work after the last reply goes into the same fold, above the reply", () => {
    fresh();
    const said = [me("ask"), tool("t1"), says("reply"), tool("commit"), changed("files", 2)];
    const folded = foldTurns(said, false);
    assert.deepEqual(page(folded.rows), ["ask", "fold(t1 commit files)", "reply"]);
    assert.equal(line(foldsOf(folded)[0]), "worked 4 min · 2 commands · 2 files");
  });

  test("a fold whose work all came after the reply still sits above it", () => {
    fresh();
    const said = [me("ask"), says("reply"), tool("commit"), changed("files", 1)];
    assert.deepEqual(page(foldTurns(said, false).rows), ["ask", "fold(commit files)", "reply"]);
  });

  test("a turn another agent started gets a line even when it ran no tools", () => {
    fresh();
    const said = [asked("in", "qa", "QA"), says("reply", { min: 0.5 })];
    const folded = foldTurns(said, false);
    assert.deepEqual(page(folded.rows), ["fold(in)", "reply"]);
    assert.equal(line(foldsOf(folded)[0]), "worked 30 sec");
  });

  test("a turn of mine with nothing on the way gets no line", () => {
    fresh();
    const said = [me("ask"), says("reply")];
    assert.deepEqual(page(foldTurns(said, false).rows), ["ask", "reply"]);
  });

  test("a stopped or cut-off turn keeps its last message and the notice outside", () => {
    fresh();
    const said = [
      me("ask"),
      says("p1"),
      make("t1", { kind: "activity", tool: { name: "Bash", stopped: true } }),
      says("p2"),
      make("t2", { kind: "activity", tool: { name: "Bash", stopped: true } }),
      notice("stopped"),
    ];
    assert.deepEqual(page(foldTurns(said, false).rows), ["ask", "fold(p1 t1 t2)", "p2", "stopped"]);
    // one that said nothing at all keeps the notice, under the line
    fresh();
    const silent = [me("ask"), tool("t1"), notice("failed", "The engine is not signed in.")];
    assert.deepEqual(page(foldTurns(silent, false).rows), ["ask", "fold(t1)", "failed"]);
  });
});

describe("who started it", () => {
  test("a routine, a watcher, a webhook and a goal's next step go on the line", () => {
    for (const [via, words] of [
      ["routine", "From your routine Morning check"],
      ["watcher", "From your watcher"],
      ["webhook", "From a webhook"],
      ["goal", "Toward your goal"],
    ] as const) {
      fresh();
      const start = me("start", { via, ...(via === "routine" ? { routine: { name: "Morning check", manual: false } } : {}) });
      const folded = foldTurns([start, tool("t1"), says("reply")], false);
      assert.deepEqual(page(folded.rows), ["fold(start t1)", "reply"], via);
      assert.equal(askerWords(foldsOf(folded)[0].asker!), words);
    }
    assert.equal(askerWords({ by: "goal", text: "" }, { turn: { of: 3, budget: 10 } }), "Toward your goal, turn 3 of 10");
    assert.equal(askerWords({ by: "routine" }), "From your routine");
  });

  test("a person's words stay outside, however they came in", () => {
    fresh();
    const said = [me("mail", { via: "email" }), tool("t1"), says("reply")];
    const folded = foldTurns(said, false);
    assert.deepEqual(page(folded.rows), ["mail", "fold(t1)", "reply"]);
    assert.equal(foldsOf(folded)[0].asker, null);
  });

  test("with my own words among what started it, the line names nobody", () => {
    fresh();
    const said = [asked("in", "qa", "QA"), me("mine"), tool("t1"), says("reply")];
    const folded = foldTurns(said, false);
    assert.deepEqual(page(folded.rows), ["fold(in t1)", "mine", "reply"]);
    assert.equal(foldsOf(folded)[0].asker, null);
    assert.equal(folded.named.size, 0);
  });

  test("another agent's words that joined a running turn fold with its work", () => {
    fresh();
    const said = [asked("in", "qa", "QA"), tool("t1"), asked("more", "qa", "QA", { midTurn: true }), tool("t2"), says("reply")];
    assert.deepEqual(page(foldTurns(said, false).rows), ["fold(in t1 more t2)", "reply"]);
  });
});

describe("what stays out of the fold", () => {
  test("a card still waiting stays out, and one already answered goes in", () => {
    fresh();
    const said = [me("ask"), tool("t1"), card("waiting"), card("answered", "Allow"), tool("t2"), says("reply")];
    assert.deepEqual(page(foldTurns(said, false).rows), ["ask", "fold(t1 answered t2)", "waiting", "reply"]);
    // one closed some other way no longer waits either
    fresh();
    const closed = [
      me("ask"),
      tool("t1"),
      make("cut", { kind: "options", card: { title: "Approval needed", subtitle: "", options: [], requestId: "r", cutOff: true } }),
      make("gone", { kind: "options", card: { title: "Approval needed", subtitle: "", options: [], dismissed: true } }),
      says("reply"),
    ];
    assert.deepEqual(page(foldTurns(closed, false).rows), ["ask", "fold(t1 cut gone)", "reply"]);
  });

  test("a secure field and a connection wait the same way", () => {
    fresh();
    const secret = (id: string, status: "needs-value" | "saved" | "dismissed") =>
      make(id, { kind: "secret", secret: { envName: "KEY", label: "A key", status } });
    const connector = (id: string, status: "needs-auth" | "authorizing" | "connected" | "failed" | "dismissed") =>
      make(id, { kind: "connector", connector: { slug: "gmail", label: "Gmail", status } });
    const said = [
      me("ask"),
      tool("t1"),
      secret("s-open", "needs-value"),
      secret("s-saved", "saved"),
      connector("c-open", "needs-auth"),
      connector("c-going", "authorizing"),
      // a connection that failed still offers to try again
      connector("c-failed", "failed"),
      connector("c-done", "connected"),
      connector("c-gone", "dismissed"),
      says("reply"),
    ];
    assert.deepEqual(page(foldTurns(said, false).rows), [
      "ask",
      "fold(t1 s-saved c-done c-gone)",
      "s-open",
      "c-open",
      "c-going",
      "c-failed",
      "reply",
    ]);
  });

  test("cards I answered are not a turn's work, and alone they make no line", () => {
    fresh();
    // an agent's greeting and its first question, before anybody asked for anything
    const hello = [says("greeting"), card("setup", "Yes")];
    assert.deepEqual(page(foldTurns(hello, false).rows), ["greeting", "setup"]);
    fresh();
    assert.deepEqual(page(foldTurns([me("ask"), card("q", "Allow"), says("reply")], false).rows), ["ask", "q", "reply"]);
  });

  test("an artifact, a component and a notice stay out", () => {
    fresh();
    const said = [
      me("ask"),
      tool("t1"),
      make("chart", { kind: "component", component: { kind: "chart", bars: [] } }),
      notice("compacted", "Context compacted.", { compaction: { before: 10, after: 5 } }),
      tool("t2"),
      says("reply"),
      artifact("file"),
      make("screen", { kind: "screen", png: "AAAA" }),
    ];
    assert.deepEqual(page(foldTurns(said, false).rows), ["ask", "fold(t1 t2 screen)", "chart", "compacted", "reply", "file"]);
  });

  test("the changed-files card goes in, and the line counts only the turn's own files", () => {
    fresh();
    const own = foldTurns([me("ask"), tool("t1"), says("reply"), changed("files", 6, {}, 2)], false);
    assert.deepEqual(page(own.rows), ["ask", "fold(t1 files)", "reply"]);
    assert.equal(line(foldsOf(own)[0]), "worked 3 min · 1 command · 4 files");
    // a card that only counts files changed around the turn adds nothing
    fresh();
    const around = foldTurns([me("ask"), tool("t1"), says("reply"), changed("files", 3, {}, 3)], false);
    assert.deepEqual(page(around.rows), ["ask", "fold(t1 files)", "reply"]);
    assert.equal(line(foldsOf(around)[0]), "worked 3 min · 1 command");
    // undone or not, the turn changed them, and Undo is one click in
    fresh();
    const undone = [
      me("ask"),
      says("reply"),
      make("files", { kind: "changes", changes: { checkpointId: "cp", files: [], total: 1, reverted: { at: 1, restored: 1, skipped: 0 } } }),
    ];
    assert.equal(line(foldsOf(foldTurns(undone, false))[0]), "worked 2 min · 1 file");
  });

  test("a rehearsal still waiting to be applied stays out", () => {
    fresh();
    const rehearsal = (state: "pending" | "applied" | "discarded") =>
      make(`files-${state}`, { kind: "changes", changes: { checkpointId: "cp", files: [], total: 2, rehearsal: { state } } });
    assert.deepEqual(page(foldTurns([me("ask"), tool("t1"), says("reply"), rehearsal("pending")], false).rows), [
      "ask",
      "fold(t1)",
      "reply",
      "files-pending",
    ]);
    fresh();
    const dropped = foldTurns([me("ask"), tool("t1"), says("reply"), rehearsal("discarded")], false);
    assert.deepEqual(page(dropped.rows), ["ask", "fold(t1 files-discarded)", "reply"]);
    assert.equal(line(foldsOf(dropped)[0]), "worked 3 min · 1 command", "nothing was changed in the end");
  });

  test("quiet check-ins keep the one muted line they already have", () => {
    fresh();
    const quiet = (id: string, base: Partial<Message>) => make(id, { ...base, quiet: true });
    const said = [
      me("ask"),
      tool("t1"),
      says("reply"),
      quiet("q-ask", { role: "user", via: "routine", routine: { name: "Inbox", manual: false, quiet: true } }),
      quiet("q-tool", { kind: "activity", tool: { name: "Bash", ok: true } }),
      quiet("q-answer", { text: "QUIET" }),
      me("next"),
      says("r2"),
    ];
    const folded = foldTurns(said, false);
    assert.deepEqual(page(folded.rows), ["ask", "fold(t1)", "reply", "q-ask", "q-tool", "q-answer", "next", "r2"]);
    // and they stay next to each other, so they still read as one run
    assert.deepEqual(folded.rows.map((row) => row.kind), ["said", "fold", "said"]);
  });

  test("a message taken back keeps its row, and is never taken for the reply", () => {
    fresh();
    const said = [me("ask"), tool("t1"), says("kept"), says("gone", { deleted: true, text: undefined })];
    assert.deepEqual(page(foldTurns(said, false).rows), ["ask", "fold(t1)", "kept", "gone"]);
  });

  test("a message to another agent that was not delivered reached nobody", () => {
    fresh();
    const failed = make("out", { kind: "activity", tool: { name: "messaged QA", ok: false }, agent: { dir: "out", peerId: "qa", peerName: "QA", status: "failed" } });
    const said = [asked("in", "qa", "QA"), failed, messaged("o1", "eng", "Engineer"), messaged("o2", "eng", "Engineer")];
    const [fold] = foldsOf(foldTurns(said, false));
    assert.equal(fold.replied, false);
    assert.deepEqual(fold.messaged, [{ peerId: "eng", peerName: "Engineer" }], "each agent once");
    assert.deepEqual(fold.tools, [], "a message to an agent is not a command");
  });
});

describe("when a turn has ended", () => {
  test("a conversation that is working has not, and an idle one has", () => {
    assert.equal(turnRunning("working", true, []), true);
    assert.equal(turnRunning("idle", true, []), false, "another conversation of the agent's is the busy one");
    assert.equal(turnRunning(undefined, true, []), true, "an older harness only says whether the agent is busy");
    assert.equal(turnRunning(undefined, false, []), false);
  });

  test("a turn paused on a question has not ended, and a goal blocked on me has", () => {
    fresh();
    const paused = [me("ask"), tool("t1"), card("waiting")];
    assert.equal(turnRunning("needs-you", true, paused), true);
    assert.deepEqual(page(foldTurns(paused, turnRunning("needs-you", true, paused)).rows), ["ask", "t1", "waiting"]);
    fresh();
    const blocked = [me("ask"), tool("t1"), says("reply"), notice("blocked", "Blocked: needs a key.", { goal: "blocked" })];
    assert.equal(turnRunning("needs-you", false, blocked), false);
    // an older turn's card nobody answered does not keep a later turn open
    fresh();
    const stale = [me("a1"), card("old"), me("a2"), says("reply")];
    assert.equal(turnRunning("needs-you", false, stale), false);
  });

  test("a turn running beside a parked workflow has not ended, unless the agent is busy somewhere else", () => {
    fresh();
    // the lane reads needs-you for the workflow's gate, which no turn is held on
    const gate = make("gate", { kind: "options", card: { title: "Ship it?", subtitle: "", options: ["Yes", "No"], runId: "run-1" } });
    const said = [gate, me("ask"), tool("t1")];
    assert.equal(turnRunning("needs-you", true, said), true);
    assert.equal(turnRunning("needs-you", true, said, true), false, "another conversation may be the one working");
  });

  test("the reply of the turn that just folded is the row to hold in place", () => {
    fresh();
    const said = [me("a1"), tool("t1"), says("r1"), me("a2"), tool("t2"), says("r2"), tool("t3")];
    const folded = foldTurns(said, false);
    assert.equal(folded.hold?.message.id, "r2");
    assert.equal(folded.hold?.index, 5);
    assert.equal(lastFoldKey(folded.rows), "t2");
    // while the second runs, the first is the newest fold
    assert.equal(lastFoldKey(foldTurns(said, true).rows), "t1");
    assert.equal(foldTurns(said, true).hold?.message.id, "r1");
  });

  test("a fold keeps its key as a changes card joins it", () => {
    fresh();
    const said = [me("ask"), tool("t1"), says("reply")];
    const before = lastFoldKey(foldTurns(said, false).rows);
    assert.equal(lastFoldKey(foldTurns([...said, changed("files", 2)], false).rows), before);
  });
});

describe("finding and windows", () => {
  test("a message under a fold says which fold, so a find hit can open it", () => {
    fresh();
    const said = [me("ask"), says("p1"), tool("t1"), says("reply")];
    const { rows } = foldTurns(said, false);
    assert.equal(foldHolding(rows, 1), "p1");
    assert.equal(foldHolding(rows, 2), "p1");
    assert.equal(foldHolding(rows, 0), null, "my own words are never under one");
    assert.equal(foldHolding(rows, 3), null);
  });

  test("the rendered tail of a long conversation draws a fold that reaches into it whole", () => {
    fresh();
    const said = [me("a1"), tool("t1"), says("r1"), me("a2"), tool("t2"), tool("t3"), says("r2")];
    const { rows } = foldTurns(said, false);
    assert.deepEqual(page(rowsFrom(rows, 0)), ["a1", "fold(t1)", "r1", "a2", "fold(t2 t3)", "r2"]);
    assert.deepEqual(page(rowsFrom(rows, 3)), ["a2", "fold(t2 t3)", "r2"]);
    assert.deepEqual(page(rowsFrom(rows, 5)), ["fold(t2 t3)", "r2"]);
    // indices stay the transcript's own, whatever is drawn
    const tail = rowsFrom(rows, 6);
    assert.deepEqual(tail, [{ kind: "said", items: [{ message: said[6], index: 6 }] }]);
  });
});

describe("the line", () => {
  test("says how long in the unit worth saying", () => {
    assert.equal(workedFor(0), "1 sec");
    assert.equal(workedFor(40_000), "40 sec");
    assert.equal(workedFor(59_600), "1 min");
    assert.equal(workedFor(8 * 60_000 + 20_000), "8 min");
    assert.equal(workedFor(60 * 60_000), "1 hr");
    assert.equal(workedFor(65 * 60_000), "1 hr 5 min");
  });

  test("counts commands when every call was one, and steps when the turn also read or edited", () => {
    fresh();
    const commands = foldsOf(foldTurns([me("ask"), tool("t1", "Bash"), tool("t2", "git status --short"), says("reply")], false))[0];
    assert.equal(line(commands), "worked 3 min · 2 commands");
    fresh();
    const mixed = foldsOf(foldTurns([me("ask"), tool("t1", "Bash"), tool("t2", "Read"), tool("t3", "Edit"), says("reply")], false))[0];
    assert.equal(line(mixed), "worked 4 min · 3 steps");
    fresh();
    const one = foldsOf(foldTurns([me("ask"), tool("t1", "Read"), says("reply")], false))[0];
    assert.equal(line(one), "worked 2 min · 1 step");
  });

  test("is time, counts and names only: never a word of what was said", () => {
    fresh();
    const said = [me("ask"), says("p1", { text: "SECRET PLAN" }), tool("t1"), says("reply")];
    const [fold] = foldsOf(foldTurns(said, false));
    assert.ok(!line(fold).includes("SECRET"));
  });
});

describe("a room", () => {
  const from = (id: string, botId: string, m: Message): Message => ({ ...m, id, from: botId });
  const nobody = new Map<string, number | null>();

  test("each agent's turn folds on its own, and another agent's message stays", () => {
    fresh();
    const said = [
      me("ask"),
      from("a-t1", "ada", tool("x")),
      from("a-p", "ada", says("x")),
      from("a-t2", "ada", tool("x")),
      from("a-reply", "ada", says("x")),
      from("l-t1", "linus", tool("x")),
      from("l-reply", "linus", says("x")),
      // Ada again, answering Linus: a turn of its own, and her first reply stays
      from("a-t3", "ada", tool("x")),
      from("a-reply2", "ada", says("x")),
    ];
    const folded = foldRoom(said, nobody);
    assert.deepEqual(page(folded.rows), [
      "ask",
      "fold(a-t1 a-p a-t2)",
      "a-reply",
      "fold(l-t1)",
      "l-reply",
      "fold(a-t3)",
      "a-reply2",
    ]);
    const [ada, linus] = foldsOf(folded);
    assert.equal(ada.speaker, "ada");
    assert.equal(linus.speaker, "linus");
    assert.equal(ada.asker, null);
    assert.equal(line(ada), "worked 3 min · 2 commands");
    assert.equal(folded.hold?.message.id, "a-reply2");
  });

  test("an agent still taking its turn is left as it is, and the others fold", () => {
    fresh();
    const said = [
      me("ask"),
      from("a-t1", "ada", tool("x")),
      from("a-reply", "ada", says("x")),
      from("l-t1", "linus", tool("x")),
      from("l-p", "linus", says("x")),
      from("l-t2", "linus", tool("x")),
    ];
    assert.deepEqual(page(foldRoom(said, new Map([["linus", 3]])).rows), ["ask", "fold(a-t1)", "a-reply", "l-t1", "l-p", "l-t2"]);
    // opened with it already at work: its latest stretch is the one going
    assert.deepEqual(page(foldRoom(said, new Map([["linus", null]])).rows), ["ask", "fold(a-t1)", "a-reply", "l-t1", "l-p", "l-t2"]);
  });

  test("two agents working at once: nothing of a running turn folds when the other speaks", () => {
    fresh();
    const said = [
      me("ask"),
      from("a-t1", "ada", tool("x")),
      from("l-t1", "linus", tool("x")),
      from("a-p", "ada", says("x")),
      from("l-reply", "linus", says("x")),
      from("a-t2", "ada", tool("x")),
    ];
    // Ada has been at it since before her first call (seen starting at 1)
    assert.deepEqual(page(foldRoom(said, new Map([["ada", 1]])).rows), ["ask", "a-t1", "fold(l-t1)", "a-p", "l-reply", "a-t2"]);
    // and when she is done, what she said before Linus spoke stays on the page
    const done = [...said, from("a-reply", "ada", says("x"))];
    assert.deepEqual(page(foldRoom(done, nobody).rows), ["ask", "fold(a-t1)", "fold(l-t1)", "a-p", "l-reply", "fold(a-t2)", "a-reply"]);
  });

  test("the person's words, the room's own lines and waiting cards stay out", () => {
    fresh();
    const said = [
      says("opened", { text: "Room opened with Ada, Linus." }),
      me("ask"),
      from("a-t1", "ada", tool("x")),
      from("a-card", "ada", card("x")),
      from("a-done", "ada", card("x", "Allow")),
      make("joined", { kind: "notice", event: true, text: "Kat joined the room." }),
      from("a-reply", "ada", says("x")),
      from("a-files", "ada", changed("x", 3)),
      me("thanks"),
    ];
    const folded = foldRoom(said, nobody);
    assert.deepEqual(page(folded.rows), ["opened", "ask", "fold(a-t1 a-done a-files)", "a-card", "joined", "a-reply", "thanks"]);
    assert.equal(line(foldsOf(folded)[0]), "worked 5 min · 1 command · 3 files");
  });
});
