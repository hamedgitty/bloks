// The one line a conversation shows in the list.
//
// Every message kind has to produce one. The kinds that carry something
// other than words used to fall through to an empty string, so an agent
// whose last answer was a chart, a saved file or a refusal looked like an
// agent that had said nothing.
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { describeComponent, plainText, previewLine } from "../src/lib/preview.ts";
import type { Message } from "../src/state/reducer.ts";

const msg = (over: Partial<Message>): Message =>
  ({ id: "m", role: "bot", kind: "text", at: 0, ...over }) as Message;

describe("every kind says something", () => {
  test("nothing at all is a new agent", () => {
    assert.equal(previewLine(undefined), "New agent");
  });

  test("words, with the markdown stripped", () => {
    assert.equal(previewLine(msg({ text: "**Done.** See `report.md`" })), "Done. See report.md");
  });

  test("a card shows what it asks", () => {
    assert.equal(
      previewLine(msg({ kind: "options", card: { title: "Ship it?", options: ["Yes"] } as never })),
      "Ship it?",
    );
  });

  test("a file, an app and a secret each name themselves", () => {
    assert.equal(
      previewLine(msg({ kind: "artifact", artifact: { name: "q4.csv", mime: "text/csv", size: 12 } })),
      "Saved q4.csv",
    );
    assert.equal(
      previewLine(msg({ kind: "connector", connector: { slug: "gh", label: "GitHub", status: "needs-auth" } })),
      "Connect GitHub",
    );
    assert.equal(
      previewLine(msg({ kind: "secret", secret: { envName: "K", label: "API key", status: "needs-value" } })),
      "Needs your API key",
    );
  });

  test("no kind falls through to an empty line", () => {
    const kinds: Message["kind"][] = [
      "text",
      "options",
      "activity",
      "screen",
      "notice",
      "artifact",
      "connector",
      "secret",
      "component",
    ];
    for (const kind of kinds) {
      // the payload is deliberately missing: a half arrived message of
      // any kind still has to produce a line
      const line = previewLine(msg({ kind, text: kind === "text" || kind === "notice" ? "said something" : "" }));
      assert.ok(line.length > 0, `${kind} produced an empty preview`);
    }
  });
});

describe("a component is described rather than drawn", () => {
  test("each shape, named by what it is", () => {
    assert.equal(describeComponent({ kind: "chart", title: "Spend" }), "Spend");
    assert.equal(describeComponent({ kind: "chart" }), "A chart");
    assert.equal(describeComponent({ kind: "table" }), "A table");
    assert.equal(describeComponent({ kind: "decision", question: "Which one?" }), "Which one?");
    assert.equal(describeComponent({ kind: "steps" }), "Some steps");
    assert.equal(describeComponent({ kind: "quote", text: "As it was written." }), "As it was written.");
    assert.equal(describeComponent({ kind: "refused", what: "send it" }), "Refused: send it");
  });

  test("a kind this build does not know still reads as something", () => {
    // a newer harness must never blank an older client's row
    assert.equal(describeComponent({ kind: "timeline" }), "An answer");
  });

  test("a title that is only spaces is not a title", () => {
    assert.equal(describeComponent({ kind: "chart", title: "   " }), "A chart");
  });
});

describe("a message taken back", () => {
  test("says so, whatever it used to be", () => {
    assert.equal(previewLine(msg({ text: "the secret is", deleted: true })), "Message taken back");
    assert.equal(
      previewLine(msg({ kind: "component", component: { kind: "chart", title: "Spend" }, deleted: true })),
      "Message taken back",
    );
  });
});

test("markdown markers are stripped, not the words", () => {
  assert.equal(plainText("# Heading\n- one\n- two"), "Heading one two");
});
