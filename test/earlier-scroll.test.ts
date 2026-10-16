// Intentional upward paging and bounded opening/resize fill share the
// existing page path. Downward movement alone never asks for history.
import { test } from "node:test";
import assert from "node:assert/strict";

import { AUTO_EARLIER_PAGES, earlierPrefix, EARLIER_AHEAD_PX, shouldFillEarlier, shouldLoadEarlier } from "../src/lib/transcript.ts";

const near = EARLIER_AHEAD_PX - 50;

test("scrolling up near the top loads the next page", () => {
  assert.equal(shouldLoadEarlier({ top: near, lastTop: near + 30, more: true, loading: false }), true);
  assert.equal(shouldLoadEarlier({ top: 0, lastTop: 12, more: true, loading: false }), true);
});

test("not far from the top, not while moving down, not twice, not past the start", () => {
  assert.equal(shouldLoadEarlier({ top: EARLIER_AHEAD_PX + 200, lastTop: EARLIER_AHEAD_PX + 260, more: true, loading: false }), false);
  // opening a chat jumps to the newest message; a page landing restores the place below
  assert.equal(shouldLoadEarlier({ top: near, lastTop: 0, more: true, loading: false }), false);
  assert.equal(shouldLoadEarlier({ top: near, lastTop: near, more: true, loading: false }), false);
  assert.equal(shouldLoadEarlier({ top: near, lastTop: near + 30, more: true, loading: true }), false);
  assert.equal(shouldLoadEarlier({ top: near, lastTop: near + 30, more: false, loading: false }), false);
});


test("a short visible history fills on opening without needing a scroll", () => {
  const short = { width: 760, height: 800, contentHeight: 120, more: true, loading: false, stopped: false, attempts: 0 };
  assert.equal(shouldFillEarlier(short), true);
  assert.equal(shouldFillEarlier({ ...short, contentHeight: 800 }), false);
  assert.equal(shouldFillEarlier({ ...short, contentHeight: 900 }), false);
  assert.equal(shouldFillEarlier({ ...short, height: 0 }), false);
  assert.equal(shouldFillEarlier({ ...short, width: 0 }), false);
  assert.equal(shouldFillEarlier({ ...short, height: -1 }), false);
  assert.equal(shouldFillEarlier({ ...short, more: false }), false);
  assert.equal(shouldFillEarlier({ ...short, loading: true }), false);
  assert.equal(shouldFillEarlier({ ...short, stopped: true }), false);
});

test("folded pages can advance without height growth, within a finite pass", () => {
  const folded = { width: 760, height: 800, contentHeight: 120, more: true, loading: false, stopped: false, attempts: 0 };
  assert.equal(AUTO_EARLIER_PAGES, 8);
  for (let attempts = 0; attempts < 8; attempts++) assert.equal(shouldFillEarlier({ ...folded, attempts }), true);
  assert.equal(shouldFillEarlier({ ...folded, attempts: 8 }), false);
  assert.equal(shouldFillEarlier({ ...folded, attempts: 9 }), false);
});


test("earlier progress comes from the response prefix, not a live tail or a smaller count", () => {
  const row = (id: string) => ({ id, role: "bot" as const, kind: "text" as const, text: id, at: 1 });
  const existing = [row("boundary"), row("latest"), row("arrived-during-wait")];
  assert.deepEqual(earlierPrefix([row("older"), row("older"), row("another")], existing, "boundary").map((m) => m.id), ["older", "another"]);
  assert.deepEqual(earlierPrefix([], existing, "boundary"), []);
  assert.deepEqual(earlierPrefix(existing, existing, "boundary"), []);
  assert.deepEqual(earlierPrefix([row("arrived-during-wait")], existing, "boundary"), []);
  assert.deepEqual(earlierPrefix([row("boundary"), row("not-earlier")], existing, "boundary"), []);
  assert.deepEqual(earlierPrefix([row("older"), row("boundary"), row("not-earlier")], existing, "boundary").map((m) => m.id), ["older"]);
  assert.deepEqual(earlierPrefix([row("first")], []).map((m) => m.id), ["first"]);
});
