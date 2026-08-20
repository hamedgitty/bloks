// The notification policy: what interrupts, and what does not.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { noticeFor, type NotifyContext } from "../src/lib/notify.ts";

const bot = { id: "bot-1", name: "Sage", notifications: true };
const base: NotifyContext = { focused: false, selectedId: "", threadId: "t1", bot };

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

  test("agents talking in a room are silent unless they named you", () => {
    const room = { ...base, bot: undefined, room: { id: "room-1", name: "Launch" }, threadId: "room-1" };
    assert.equal(noticeFor({ role: "bot", kind: "text", text: "on it" }, room), null);
    const named = noticeFor({ role: "bot", kind: "text", text: "@you what do you think?" }, { ...room, mentionsUser: true });
    assert.equal(named?.title, "Launch");
    assert.equal(named?.target, "room-1");
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
