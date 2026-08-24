// Names spoken aloud become the mentions the room engine understands.
import { test } from "node:test";
import assert from "node:assert/strict";

import { routeSpokenToRoom } from "../src/lib/spokenRouting.ts";

const NAMES = ["Kat", "Katherine", "Remy"];

test("a leading name becomes a mention, longest name winning", () => {
  assert.equal(routeSpokenToRoom("Kat, take the numbers", NAMES), "@Kat take the numbers");
  assert.equal(
    routeSpokenToRoom("Katherine can you review this", NAMES),
    "@Katherine can you review this",
  );
  assert.equal(routeSpokenToRoom("hey Remy. what's left", NAMES), "@Remy what's left");
});

test("unaddressed speech passes through untouched", () => {
  assert.equal(routeSpokenToRoom("what does everyone think", NAMES), "what does everyone think");
  assert.equal(routeSpokenToRoom("  the Kat sat on the mat? no.  ", NAMES), "the Kat sat on the mat? no.");
});
