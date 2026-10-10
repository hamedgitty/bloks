// A card answered with a tap on a phone, and only by the tap it was sent with.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { CardButtons, MAX_BUTTONS, outcomeOf, settledText } from "../server/telegram-cards.ts";

const CHAT = 42;
const approval = (requestId = "req-1", over: Record<string, unknown> = {}) => ({
  requestId,
  botId: "bot-1",
  chatId: CHAT,
  permission: true,
  title: "Approval needed",
  subtitle: "rm -rf build",
  options: ["Allow", "Deny"],
  ...over,
});
const question = (requestId = "req-2", options = ["Red", "Blue", "Green"]) => ({
  requestId,
  botId: "bot-1",
  chatId: CHAT,
  permission: false,
  title: "Your agent has a question",
  subtitle: "Which colour?",
  options,
});
const data = (sent: { keyboard?: { inline_keyboard: { callback_data: string }[][] } }, i: number) =>
  sent.keyboard!.inline_keyboard.flat()[i]!.callback_data;

describe("buttons on a forwarded card", () => {
  test("an approval is Allow and Deny side by side, under only what it asks", () => {
    const sent = new CardButtons().forward(approval());
    assert.equal(sent.text, "Approval needed\nrm -rf build");
    assert.deepEqual(sent.keyboard!.inline_keyboard.map((row) => row.map((b) => b.text)), [["Allow", "Deny"]]);
  });

  test("a question's choices are one to a row", () => {
    const sent = new CardButtons().forward(question());
    assert.deepEqual(sent.keyboard!.inline_keyboard.map((row) => row.map((b) => b.text)), [["Red"], ["Blue"], ["Green"]]);
  });

  test("a question with no choices has no buttons, and still asks to be typed", () => {
    const sent = new CardButtons().forward(question("req-3", []));
    assert.equal(sent.keyboard, undefined);
    assert.match(sent.text, /Reply with your answer\.$/);
  });

  test("too many choices are typed by number instead", () => {
    const options = Array.from({ length: MAX_BUTTONS + 1 }, (_, i) => `Choice ${i + 1}`);
    const sent = new CardButtons().forward(question("req-4", options));
    assert.equal(sent.keyboard, undefined);
    assert.match(sent.text, /1\. Choice 1/);
  });

  test("a button carries a short token, never the request id, and fits Telegram's 64 bytes", () => {
    const longId = `request-${"x".repeat(120)}`;
    const sent = new CardButtons().forward(question(longId));
    for (const button of sent.keyboard!.inline_keyboard.flat()) {
      assert.ok(Buffer.byteLength(button.callback_data) <= 64, button.callback_data);
      assert.ok(!button.callback_data.includes("request-"), "the request id stays on this machine");
    }
  });

  test("two cards never share a token", () => {
    const cards = new CardButtons();
    const one = data(cards.forward(approval("a")), 0);
    const two = data(cards.forward(approval("b")), 0);
    assert.notEqual(one.split(":")[0], two.split(":")[0]);
  });
});

describe("a tap", () => {
  test("answers the card its button is under, with the choice it names", () => {
    const cards = new CardButtons();
    const first = cards.forward(approval("a"));
    const second = cards.forward(question("b"));
    cards.sent("a", 10);
    cards.sent("b", 11);
    const pressed = cards.press(CHAT, 11, data(second, 1));
    assert.ok(pressed && "card" in pressed);
    assert.equal(pressed.card.requestId, "b");
    assert.equal(pressed.option, "Blue");
    assert.equal(settledText(pressed.card), "Your agent has a question\nWhich colour?\n\nAnswered: Blue");
    const denied = cards.press(CHAT, 10, data(first, 1));
    assert.ok(denied && "card" in denied);
    assert.equal(denied.card.settled, "Denied");
  });

  test("counts only in the chat, and under the message, it was sent to", () => {
    const cards = new CardButtons();
    const sent = cards.forward(approval());
    cards.sent("req-1", 10);
    assert.equal(cards.press(7, 10, data(sent, 0)), null, "another chat");
    assert.equal(cards.press(CHAT, 99, data(sent, 0)), null, "another message");
    assert.equal(cards.press(CHAT, 10, "nonsense"), null);
    assert.equal(cards.press(CHAT, 10, `${data(sent, 0).split(":")[0]}:7`), null, "a choice the card never had");
    assert.ok(cards.press(CHAT, 10, data(sent, 0)), "and still answers from where it belongs");
  });

  test("a second tap changes nothing, and is told what the first did", () => {
    const cards = new CardButtons();
    const sent = cards.forward(approval());
    cards.sent("req-1", 10);
    assert.ok(cards.press(CHAT, 10, data(sent, 0)));
    assert.deepEqual(cards.press(CHAT, 10, data(sent, 1)), { settled: "Allowed" });
  });

  test("a card from long ago is forgotten, and its buttons answer nothing", () => {
    const cards = new CardButtons(1_000);
    const sent = cards.forward(approval(), 0);
    cards.sent("req-1", 10);
    assert.equal(cards.press(CHAT, 10, data(sent, 0), 5_000), null);
  });

  test("a tap is not rewritten a second time when the engine reports the answer back", () => {
    const cards = new CardButtons();
    const sent = cards.forward(approval());
    cards.sent("req-1", 10);
    cards.press(CHAT, 10, data(sent, 0));
    assert.equal(cards.settle("req-1", () => "Allowed"), undefined);
  });
});

describe("a card answered somewhere else", () => {
  test("is handed back to be rewritten with how, and its buttons stop answering", () => {
    const cards = new CardButtons();
    const sent = cards.forward(approval());
    cards.sent("req-1", 10);
    const settled = cards.settle("req-1", (card) => outcomeOf(card, "deny", "user"));
    assert.equal(settled?.messageId, 10);
    assert.equal(settledText(settled!), "Approval needed\nrm -rf build\n\nDenied");
    assert.deepEqual(cards.press(CHAT, 10, data(sent, 0)), { settled: "Denied" });
  });

  test("before Telegram said which message it became is rewritten once it does", () => {
    const cards = new CardButtons();
    cards.forward(approval());
    assert.equal(cards.settle("req-1", () => "Allowed"), undefined);
    assert.equal(cards.sent("req-1", 10)?.settled, "Allowed");
    assert.equal(cards.sent("req-1", 10), undefined, "and only once");
  });

  test("says what was chosen when the answer said so", () => {
    const cards = new CardButtons();
    cards.forward(question());
    cards.sent("req-2", 10);
    cards.expect("req-2", "Green");
    assert.equal(cards.settle("req-2", (card) => outcomeOf(card, "answer", "user"))?.settled, "Answered: Green");
  });

  test("is rewritten without how to answer it, which is no longer true", () => {
    const cards = new CardButtons();
    cards.forward(question("req-3", []));
    cards.sent("req-3", 10);
    cards.expect("req-3", "Saturday");
    const settled = cards.settle("req-3", (card) => outcomeOf(card, "answer", "user"));
    assert.equal(settledText(settled!), "Your agent has a question\nWhich colour?\n\nAnswered: Saturday");
  });

  test("a card no person answered says it closed, not that it was denied", () => {
    const card = new CardButtons();
    card.forward(approval());
    card.sent("req-1", 10);
    assert.equal(card.settle("req-1", (c) => outcomeOf(c, "deny", "turn-ended"))?.settled, "Closed without an answer.");
  });
});
