// One transcript, read two ways.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { preview, replyCounts, replyLabel, rootIds, threadsFrom } from "../src/lib/threads.ts";
import type { Message } from "../src/state/reducer.ts";

let clock = 0;
const say = (id: string, text: string, replyToId?: string, from = "user"): Message =>
  ({
    id,
    role: from === "user" ? "user" : "bot",
    from: from === "user" ? undefined : from,
    kind: "text",
    text,
    at: ++clock,
    ...(replyToId ? { replyTo: { id: replyToId, author: "somebody", excerpt: "…" } } : {}),
  }) as Message;

const nameOf = (m: Message) => (m.role === "user" ? "You" : (m.from ?? "agent"));

describe("which conversation a message belongs to", () => {
  test("a reply to a reply joins the same thread, it does not start one inside it", () => {
    // arbitrary nesting is easy to build and hard to read: a thread is
    // keyed by its root
    const messages = [say("a", "the topic"), say("b", "an answer", "a"), say("c", "answering that", "b")];
    const roots = rootIds(messages);
    assert.equal(roots.get("a"), "a");
    assert.equal(roots.get("b"), "a");
    assert.equal(roots.get("c"), "a");
  });

  test("a reply to something no longer here is its own beginning", () => {
    // the alternative is a thread with no root, which cannot be drawn
    const roots = rootIds([say("b", "answering a deleted thing", "gone")]);
    assert.equal(roots.get("b"), "b");
  });

  test("messages that answer each other do not hang the reader", () => {
    const a = say("a", "one", "b");
    const b = say("b", "two", "a");
    const roots = rootIds([a, b]);
    assert.ok(roots.get("a"));
    assert.ok(roots.get("b"));
  });

  test("a message answering itself is its own root", () => {
    const odd = say("x", "curious", "x");
    assert.equal(rootIds([odd]).get("x"), "x");
  });
});

describe("the transcript as topics", () => {
  test("replies gather under their root, oldest first", () => {
    const messages = [
      say("a", "first topic"),
      say("b", "second topic"),
      say("c", "about the first", "a"),
      say("d", "also about the first", "a"),
    ];
    const threads = threadsFrom(messages, nameOf);
    const first = threads.find((t) => t.root.id === "a")!;
    assert.deepEqual(first.replies.map((r) => r.id), ["c", "d"]);
    assert.equal(threads.find((t) => t.root.id === "b")!.replies.length, 0);
  });

  test("a topic somebody returned to comes back up", () => {
    // the whole reason for this lens: the stream already orders by when
    // things were said
    const messages = [say("a", "old topic"), say("b", "new topic"), say("c", "back to the old one", "a")];
    const threads = threadsFrom(messages, nameOf);
    assert.deepEqual(threads.map((t) => t.root.id), ["a", "b"]);
  });

  test("everyone who spoke in a thread is listed once, in order", () => {
    const messages = [
      say("a", "topic", undefined, "user"),
      say("b", "reply", "a", "ivy"),
      say("c", "reply", "a", "rae"),
      say("d", "again", "a", "ivy"),
    ];
    const thread = threadsFrom(messages, nameOf)[0];
    assert.deepEqual(thread.participants, ["You", "ivy", "rae"]);
  });

  test("nothing is hidden: every message is somewhere", () => {
    // a lens that omits something is a lens people learn not to trust
    const messages = [say("a", "one"), say("b", "two", "a"), say("c", "three"), say("d", "four", "c")];
    const threads = threadsFrom(messages, nameOf);
    const seen = threads.flatMap((t) => [t.root.id, ...t.replies.map((r) => r.id)]).sort();
    assert.deepEqual(seen, ["a", "b", "c", "d"]);
  });

  test("a deleted message is in neither lens", () => {
    const messages = [say("a", "one"), { ...say("b", "gone", "a"), deleted: true } as Message];
    const threads = threadsFrom(messages, nameOf);
    assert.equal(threads.length, 1);
    assert.equal(threads[0].replies.length, 0);
  });

  test("an empty room is an empty list, not an exception", () => {
    assert.deepEqual(threadsFrom([], nameOf), []);
  });
});

describe("what the stream shows about a thread", () => {
  test("a root knows how many answers it has, replies to replies included", () => {
    const messages = [say("a", "topic"), say("b", "reply", "a"), say("c", "reply to reply", "b"), say("d", "other")];
    const counts = replyCounts(messages);
    assert.equal(counts.get("a"), 2);
    assert.equal(counts.get("d"), undefined);
  });

  test("the label counts in words, and says nothing for none", () => {
    assert.equal(replyLabel(0), null);
    assert.equal(replyLabel(1), "1 reply");
    assert.equal(replyLabel(4), "4 replies");
  });
});

describe("standing in for a message in a list", () => {
  test("its own words, on one line, cut with an ellipsis", () => {
    assert.equal(preview(say("a", "  a  topic\nover two lines ")), "a topic over two lines");
    assert.equal(preview(say("a", "x".repeat(200)), 20).length, 20);
    assert.match(preview(say("a", "x".repeat(200)), 20), /…$/);
  });

  test("something without words still says what it is", () => {
    const artifact = { id: "f", role: "bot", kind: "artifact", at: 1, artifact: { name: "report.pdf", mime: "", size: 1 } } as Message;
    assert.equal(preview(artifact), "report.pdf");
    const card = { id: "q", role: "bot", kind: "options", at: 1, card: { title: "Which one?", subtitle: "", options: [] } } as Message;
    assert.equal(preview(card), "Which one?");
    const shot = { id: "s", role: "bot", kind: "screen", at: 1 } as Message;
    assert.equal(preview(shot), "a screenshot");
  });
});
