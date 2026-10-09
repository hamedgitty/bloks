// What was being written in one conversation stays with it.
//
// The composer was one box for every agent, so a half-written message and
// its attachments followed you to the next agent and Enter sent them
// there. Each conversation keeps its own draft now.
import { test } from "node:test";
import assert from "node:assert/strict";

import { isEmptyDraft, keepDraft, readDraft, takeBack } from "../src/lib/drafts.ts";

test("a draft stays with its conversation and is found there again", () => {
  keepDraft("agent-a:lane-1", { text: "for a", attachments: [{ id: "chip" }] });
  assert.deepEqual(readDraft("agent-b:lane-1"), { text: "", attachments: [] });
  // another lane of the same agent is another conversation
  assert.deepEqual(readDraft("agent-a:lane-2"), { text: "", attachments: [] });
  assert.deepEqual(readDraft("agent-a:lane-1"), { text: "for a", attachments: [{ id: "chip" }] });
});

test("a box left empty forgets what it held", () => {
  keepDraft("agent-c:lane-1", { text: "half a thought", attachments: [] });
  keepDraft("agent-c:lane-1", { text: "  \n", attachments: [] });
  assert.deepEqual(readDraft("agent-c:lane-1"), { text: "", attachments: [] });
});

test("a send that failed comes back to an empty box, chips and all", () => {
  // The box clears the moment you press Enter. A refusal after that used
  // to take the message with it, leaving only an error to say it existed.
  const sent = { text: "the plan for Friday", attachments: [{ id: "notes.pdf" }] };
  assert.deepEqual(takeBack({ text: "", attachments: [] }, sent), sent);
});

test("a send that failed leaves alone what was typed since", () => {
  const sent = { text: "the plan for Friday", attachments: [] };
  assert.equal(takeBack({ text: "actually, Monday", attachments: [] }, sent), null);
  assert.equal(takeBack({ text: "", attachments: [{ id: "chart.png" }] }, sent), null);
});

test("chips alone are a draft worth keeping", () => {
  assert.equal(isEmptyDraft({ text: "", attachments: [{ id: "chip" }] }), false);
  assert.equal(isEmptyDraft({ text: " ", attachments: [] }), true);
  assert.equal(isEmptyDraft(undefined), true);
});
