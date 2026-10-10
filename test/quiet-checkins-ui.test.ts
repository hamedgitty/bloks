// What the app does with a quiet check-in: never a banner, a held banner
// for the replies of a check-in still running, one muted line for a run
// of them in the chat, and nothing in the sidebar's preview.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { CheckInHold, noticeFor, type NotifyContext } from "../src/lib/notify.ts";
import { lastSaid } from "../src/lib/preview.ts";
import { quietLine, quietRunAt } from "../src/lib/transcript.ts";
import type { Message } from "../src/state/reducer.ts";

const ctx: NotifyContext = { focused: false, selectedId: "", threadId: "t1", bot: { id: "bot-1", name: "Sentry", notifications: true } };

describe("banners", () => {
  test("a quiet answer never raises one, whatever else is true", () => {
    assert.equal(noticeFor({ role: "bot", kind: "text", text: "QUIET", quiet: true }, ctx), null);
    assert.ok(noticeFor({ role: "bot", kind: "text", text: "QUIET" }, ctx), "the word alone, unmarked, is an ordinary reply");
  });

  test("a check-in's replies wait for its turn to end, and only a report is let go", () => {
    const hold = new CheckInHold();
    const commentary = { role: "bot", kind: "text", text: "Checking the inbox." };
    assert.equal(hold.holds(commentary, true), true);
    assert.equal(hold.holds(commentary, false), false, "an ordinary turn's reply is not held");
    assert.equal(hold.holds({ role: "bot", kind: "options", card: { requestId: "r1" } }, true), false, "a question is news at once");
    assert.equal(hold.holds({ role: "bot", kind: "activity" }, true), false);

    hold.hold("t1", commentary);
    hold.hold("t1", { role: "bot", kind: "text", text: "QUIET", quiet: true });
    assert.equal(hold.release("t1"), null, "a quiet ending lets nothing go, the commentary included");
    assert.equal(hold.release("t1"), null);

    hold.hold("t1", commentary);
    hold.hold("t1", { role: "bot", kind: "text", text: "Two invoices are overdue." });
    hold.hold("t2", { role: "bot", kind: "text", text: "Elsewhere." });
    assert.equal(hold.release("t1")?.text, "Two invoices are overdue.", "the last reply is the news");
    assert.equal(hold.release("t1"), null, "and only once");
    assert.equal(hold.release("t2")?.text, "Elsewhere.", "each thread keeps its own");
  });
});

const m = (id: string, over: Partial<Message> = {}): Message => ({ id, role: "bot", kind: "text", text: id, at: 0, ...over }) as Message;

describe("the chat", () => {
  const thread = [
    m("hello", { role: "user" }),
    m("p1", { role: "user", quiet: true, at: 1 }),
    m("tool", { kind: "activity", quiet: true, at: 2 }),
    m("q1", { quiet: true, at: 3 }),
    m("p2", { role: "user", quiet: true, at: 4 }),
    m("q2", { quiet: true, at: 5 }),
    m("report"),
    m("p3", { role: "user", quiet: true, at: 7 }),
    m("q3", { quiet: true, deleted: true, at: 8 }),
  ];

  test("a run of quiet messages is drawn once, at its first", () => {
    assert.equal(quietRunAt(thread, 0), null, "not quiet");
    assert.deepEqual(quietRunAt(thread, 1)?.map((x) => x.id), ["p1", "tool", "q1", "p2", "q2"]);
    for (const inside of [2, 3, 4, 5]) assert.equal(quietRunAt(thread, inside), null, `drawn already, at ${thread[inside].id}`);
    assert.equal(quietRunAt(thread, 6), null);
    assert.deepEqual(quietRunAt(thread, 7)?.map((x) => x.id), ["p3"], "a message taken back ends the run");
  });

  test("the line counts check-ins, not messages, and says when the last was", () => {
    const run = quietRunAt(thread, 1)!;
    assert.equal(quietLine(run, (at) => `t${at}`), "2 quiet check-ins, last at t5");
    assert.equal(quietLine([thread[3]], (at) => `t${at}`), "1 quiet check-in, last at t3");
  });

  test("the sidebar's line and time read past a quiet check-in", () => {
    assert.equal(lastSaid(thread.slice(0, 6))?.id, "hello");
    assert.equal(lastSaid(thread.slice(0, 7))?.id, "report");
  });
});
