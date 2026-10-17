// The notification policy: what interrupts, and what does not.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { noticeFor, type NotifyContext } from "../src/lib/notify.ts";

const bot = { id: "bot-1", name: "Sage", notifications: true };
const base: NotifyContext = { replySettled: true, focused: false, selectedId: "", threadId: "t1", bot };

describe("what is worth interrupting for", () => {
  test("an agent's reply raises a banner when you are elsewhere", () => {
    const notice = noticeFor({ role: "bot", kind: "text", text: "Done, the report is ready." }, base);
    assert.equal(notice?.title, "Sage");
    assert.equal(notice?.body, "Done, the report is ready.");
    assert.equal(notice?.target, "bot-1");
    assert.equal(notice?.urgent, false);
  });

  test("nothing interrupts you about the thread you are looking at", () => {
    const watching = { ...base, focused: true, selectedId: "bot-1" };
    assert.equal(noticeFor({ role: "bot", kind: "text", text: "hello" }, watching), null);
    // even an approval, because the card is right there
    assert.equal(
      noticeFor({ role: "bot", kind: "options", card: { requestId: "r1", title: "Delete it?" } }, watching),
      null,
    );
  });

  test("an unfocused window still gets the reply for the open thread", () => {
    // selected but not focused: the app is behind something else
    const behind = { ...base, focused: false, selectedId: "bot-1" };
    assert.ok(noticeFor({ role: "bot", kind: "text", text: "back to you" }, behind));
  });

  test("an approval outranks the agent's own switch", () => {
    const quiet = { ...base, bot: { ...bot, notifications: false } };
    const notice = noticeFor(
      { role: "bot", kind: "options", card: { requestId: "r1", title: "Send the email?" } },
      quiet,
    );
    assert.equal(notice?.urgent, true);
    assert.equal(notice?.title, "Sage needs you");
    assert.equal(notice?.body, "Send the email?");
  });

  test("an agent told to stay quiet does not raise ordinary replies", () => {
    const quiet = { ...base, bot: { ...bot, notifications: false } };
    assert.equal(noticeFor({ role: "bot", kind: "text", text: "just thinking" }, quiet), null);
  });

  test("agent mentions in a room stay quiet while actual approval cards interrupt", () => {
    const room = { ...base, bot: undefined, room: { id: "room-1", name: "Launch" }, threadId: "room-1" };
    assert.equal(noticeFor({ role: "bot", kind: "text", text: "on it" }, room), null);
    const named = noticeFor({ role: "bot", kind: "text", text: "@you what do you think?" }, room);
    assert.equal(named, null);
    // an approval in a room still interrupts without a mention
    const ask = noticeFor(
      { role: "bot", kind: "options", card: { requestId: "r2", title: "Ship it?" } },
      room,
    );
    assert.equal(ask?.urgent, true);
    assert.match(ask!.title, /Launch/);
  });

  test("your own messages, tool activity and screens never interrupt", () => {
    assert.equal(noticeFor({ role: "user", kind: "text", text: "hi" }, base), null);
    for (const kind of ["activity", "screen", "artifact", "notice", "connector"]) {
      assert.equal(noticeFor({ role: "bot", kind, text: "x" }, base), null, kind);
    }
  });

  test("empty text is not news", () => {
    assert.equal(noticeFor({ role: "bot", kind: "text", text: "   " }, base), null);
    assert.equal(noticeFor({ role: "bot", kind: "text" }, base), null);
  });

  test("a long reply is clipped to something a banner can hold", () => {
    const long = "word ".repeat(200);
    const notice = noticeFor({ role: "bot", kind: "text", text: long }, base);
    assert.ok(notice!.body.length <= 180, `body was ${notice!.body.length}`);
    assert.match(notice!.body, /…$/);
  });

  test("whitespace and newlines are flattened, not shown raw", () => {
    const notice = noticeFor({ role: "bot", kind: "text", text: "one\n\n  two\ttthree" }, base);
    assert.equal(notice?.body, "one two tthree");
  });
});

describe("an agent that could not answer", () => {
  test("an engine failure is a record, not an unanswered decision", () => {
    const out = noticeFor({ role: "bot", kind: "notice", text: "402 This request would exceed your available credits" }, base);
    assert.equal(out, null);
    assert.equal(noticeFor({ role: "bot", kind: "notice", text: "Starting a new task keeps this one readable." }, base), null);
  });
});


describe("only pending decision cards bypass the reply switch", () => {
  const quiet = { ...base, bot: { ...bot, notifications: false } };
  test("a workflow gate names its question and deadline and opens its existing conversation", () => {
    const notice = noticeFor({ role: "bot", kind: "options", card: {
      runId: "run-1", title: "Publish the draft?", subtitle: "Draft review stops tomorrow if nobody answers.",
    } }, quiet);
    assert.equal(notice?.urgent, true);
    assert.equal(notice?.target, "bot-1");
    assert.match(notice!.body, /Publish the draft\?/);
    assert.match(notice!.body, /stops tomorrow/);
  });
  test("a request says the actual question rather than its generic heading", () => {
    const notice = noticeFor({ role: "bot", kind: "options", card: {
      requestId: "ask-1", title: "Your agent has a question", subtitle: "Which draft should I publish?",
    } }, quiet);
    assert.equal(notice?.body, "Which draft should I publish?");
  });
  for (const pointer of [{ requestId: "ask-1" }, { runId: "run-1" }]) {
    for (const settled of [{ answered: "Yes" }, { answered: "Closed without an answer" }, { dismissed: true }]) {
      test(`a settled ${Object.keys(pointer)[0]} card stays quiet: ${JSON.stringify(settled)}`, () => {
        assert.equal(noticeFor({ role: "bot", kind: "options", card: { ...pointer, ...settled, title: "Proceed?" } }, base), null);
      });
    }
    test(`a deleted ${Object.keys(pointer)[0]} card stays quiet`, () => {
      assert.equal(noticeFor({ role: "bot", kind: "options", deleted: true, card: { ...pointer, title: "Proceed?" } }, base), null);
    });
  }
  for (const message of [
    { chainHeld: true, text: "Held because the turn limit was reached." },
    { goal: "blocked", text: "The work is blocked." },
    { text: "429 quota exceeded" }, { text: "Not signed in" }, { text: "402 billing payment required" },
  ]) {
    test(`a mechanical notice never bypasses either switch state: ${message.text}`, () => {
      for (const ctx of [base, quiet]) assert.equal(noticeFor({ role: "bot", kind: "notice", ...message }, ctx), null);
    });
  }
  test("finished goal results still follow the existing per-agent reply switch", () => {
    for (const goal of ["done", "out"]) {
      const message = { role: "bot", kind: "notice", goal, text: "This run ended." };
      assert.equal(noticeFor(message, base)?.urgent, false);
      assert.equal(noticeFor(message, quiet), null);
    }
  });
  test("a setup card with no request or workflow remains quiet", () => {
    assert.equal(noticeFor({ role: "bot", kind: "options", card: { title: "A setup recommendation" } }, base), null);
  });
});
