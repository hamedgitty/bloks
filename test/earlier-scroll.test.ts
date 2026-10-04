// Scrolling up a long conversation brings in earlier messages on its
// own (GitHub 133). What this holds shut: a page loading on its own when
// a chat opens or a loaded page puts the reader back in place (both move
// down, not up), a second request while one is on its way, and asking
// for more when there is none.
import { test } from "node:test";
import assert from "node:assert/strict";

import { EARLIER_AHEAD_PX, shouldLoadEarlier } from "../src/lib/transcript.ts";

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
