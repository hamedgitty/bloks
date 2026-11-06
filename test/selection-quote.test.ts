// Quoting what you selected in a message: the words a quote keeps and
// where the toolbar over a selection goes (src/lib/selectionQuote.ts),
// the reply handed to a branch opened with a quote (src/lib/replyHandoff.ts),
// and, through the server, what the engine hears of a quote and the
// answer a branch starts from (server/branch.ts).
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { branchAnswerId } from "../server/branch.ts";
import type { Message } from "../server/store.ts";
import { handReply, listenForReply, type HandedReply } from "../src/lib/replyHandoff.ts";
import { QUOTE_MAX, isQuoteKey, quoteOf, toolbarSpot } from "../src/lib/selectionQuote.ts";
import { startHarness } from "./helpers/server.ts";
import { agentOn, fakeProvider, idle, messagesOf, waitFor } from "./helpers/turns.ts";

describe("the words a quote keeps", () => {
  test("exactly what was selected, its line breaks kept and its loose ends tidied", () => {
    assert.equal(quoteOf("  the press kit  "), "the press kit");
    assert.equal(quoteOf("one\r\ntwo   \n\n\n\nthree"), "one\ntwo\n\nthree");
    assert.equal(quoteOf("a b"), "a b");
    assert.equal(quoteOf(" \n\t "), null);
  });

  test("a long selection is cut at a word, with an ellipsis, within the cap", () => {
    const long = "word ".repeat(1_000);
    const quote = quoteOf(long)!;
    assert.ok(quote.length <= QUOTE_MAX, `${quote.length}`);
    assert.ok(quote.endsWith("word…"));
    // the server keeps the same cap
    assert.equal(QUOTE_MAX, 2000);
  });
});

describe("where the toolbar goes", () => {
  const viewport = { width: 1000, height: 800 };
  const toolbar = { width: 200, height: 36 };

  test("centred just above the selection, never on it", () => {
    const spot = toolbarSpot({ top: 300, bottom: 320, left: 400, right: 600 }, toolbar, viewport);
    assert.deepEqual(spot, { top: 300 - 8 - 36, left: 400, side: "above" });
    assert.ok(spot.top + toolbar.height <= 300);
  });

  test("below it with no room above, and below on a touch screen, whose own menu goes above", () => {
    assert.equal(toolbarSpot({ top: 20, bottom: 40, left: 400, right: 600 }, toolbar, viewport).side, "below");
    const touch = toolbarSpot({ top: 300, bottom: 320, left: 400, right: 600 }, toolbar, viewport, { below: true });
    assert.deepEqual(touch, { top: 328, left: 400, side: "below" });
    // a touch selection at the foot of the screen still goes above
    assert.equal(toolbarSpot({ top: 700, bottom: 780, left: 400, right: 600 }, toolbar, viewport, { below: true }).side, "above");
  });

  test("kept inside the window at its edges", () => {
    assert.equal(toolbarSpot({ top: 300, bottom: 320, left: 0, right: 20 }, toolbar, viewport).left, 8);
    assert.equal(toolbarSpot({ top: 300, bottom: 320, left: 980, right: 1000 }, toolbar, viewport).left, 1000 - 8 - 200);
    // taller than the screen: the side with more room, clamped
    const tall = toolbarSpot({ top: -500, bottom: 700, left: 400, right: 600 }, toolbar, viewport);
    assert.equal(tall.side, "below");
    assert.ok(tall.top >= 8 && tall.top + toolbar.height <= 800 - 8);
  });
});

test("the quote key is ⌘' on a Mac and Ctrl+' elsewhere, wherever the apostrophe sits", () => {
  const key = (over: Partial<{ key: string; code: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean }>) => ({ key: "'", code: "Quote", metaKey: false, ctrlKey: false, altKey: false, ...over });
  assert.equal(isQuoteKey(key({ metaKey: true }), true), true);
  assert.equal(isQuoteKey(key({ ctrlKey: true }), true), false);
  assert.equal(isQuoteKey(key({ ctrlKey: true }), false), true);
  assert.equal(isQuoteKey(key({ metaKey: true, altKey: true }), true), false);
  // a layout where the apostrophe takes Shift, read by the key's place
  assert.equal(isQuoteKey(key({ key: "#", code: "Quote", metaKey: true }), true), true);
  assert.equal(isQuoteKey(key({ key: "a", code: "KeyA", metaKey: true }), true), false);
});

test("a reply handed to a branch reaches its view whether it is up yet or not", () => {
  const quote: HandedReply = { id: "m9", author: "Ada", excerpt: "The launch", quote: "the press kit" };
  const got: HandedReply[] = [];
  // handed first, taken when the view comes up
  handReply("b1:l1", quote);
  const stop = listenForReply("b1:l1", (r) => got.push(r));
  assert.deepEqual(got, [quote]);
  // the view up first, handed straight to it
  handReply("b1:l1", { ...quote, quote: "again" });
  assert.equal(got[1]?.quote, "again");
  stop();
  // once gone, it waits again, and only once
  handReply("b1:l1", { ...quote, quote: "later" });
  const later: HandedReply[] = [];
  listenForReply("b1:l1", (r) => later.push(r))();
  listenForReply("b1:l1", (r) => later.push(r))();
  assert.deepEqual(later.map((r) => r.quote), ["later"]);
});

test("a branch's answer is its last copied message, just before its line", () => {
  const m = (id: string, over: Partial<Message> = {}): Message => ({ id, role: "bot", kind: "text", text: id, at: 1, ...over });
  assert.equal(branchAnswerId([m("a"), m("b"), m("line", { kind: "notice", branch: { from: "x", messageId: "b0", title: "T" } })]), "b");
  assert.equal(branchAnswerId([m("a")]), undefined);
});

test("the engine hears the quoted words and whose message they came from, and the message keeps them", async (t) => {
  const engine = await fakeProvider(t);
  engine.state.answerAtOnce = true;
  const h = await startHarness();
  t.after(() => h.stop());
  const ada = await agentOn(h, engine.port, "Ada");
  await h.fetch(`/api/bots/${ada.id}/messages`, { method: "POST", body: JSON.stringify({ text: "Plan the launch." }) });
  const answer = await waitFor(async () => (await messagesOf(h, ada)).filter((m) => m.role === "bot" && m.kind === "text").at(-1) ?? null);
  assert.ok(answer);
  assert.ok(await idle(h, ada));

  const before = engine.state.calls.length;
  const replyTo = { id: answer.id, author: "Ada", excerpt: "Done.", quote: "first line\nsecond line" };
  const res = await h.fetch(`/api/bots/${ada.id}/messages`, { method: "POST", body: JSON.stringify({ text: "Why these?", replyTo }) });
  assert.equal(res.status, 202);
  const call = await waitFor(() => engine.state.calls.slice(before).find((c) => c.includes("Why these?")) ?? null);
  assert.ok(call);
  const said = JSON.parse(call).messages.at(-1).content as string;
  assert.equal(said, `(Replying to Ada's earlier message, which begins "Done.", and quoting this part of it:\n> first line\n> second line\n)\n\nWhy these?`);
  const kept = (await messagesOf(h, ada)).find((m) => m.text === "Why these?");
  assert.deepEqual(kept.replyTo, replyTo);
  assert.ok(await idle(h, ada));

  // a quote past the cap is cut to it, and one without words is no quote
  const huge = await h.fetch(`/api/bots/${ada.id}/messages`, { method: "POST", body: JSON.stringify({ text: "And this?", replyTo: { ...replyTo, quote: "x".repeat(5_000) } }) });
  assert.equal(huge.status, 202);
  const cut = await waitFor(async () => (await messagesOf(h, ada)).find((m) => m.text === "And this?") ?? null);
  assert.equal(cut.replyTo.quote.length, 2000);
  assert.ok(await idle(h, ada));

  // Branch with this: the branch answers with its copy of the answer
  const branched = await h.json(`/api/threads/${ada.threadId}/branch`, { method: "POST", body: JSON.stringify({ messageId: answer.id }) });
  assert.ok(branched.threadId);
  const copied = (await h.json(`/api/bots/${ada.id}/messages?thread=${branched.threadId}&limit=50`)).messages as Message[];
  const copy = copied.find((m) => m.id === branched.messageId);
  assert.ok(copy, "the branch did not name its answer");
  assert.equal(copy.text, answer.text);
  assert.notEqual(copy.id, answer.id);
});
