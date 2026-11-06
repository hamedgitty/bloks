import assert from "node:assert/strict";
import { test } from "node:test";

import { quoteIn } from "../server/quote-check.ts";

test("a quote is words the message holds, read as a screen shows them", () => {
  const said = "Here is the plan: pricing stays at **three tiers**, and the [docs page](https://example.test/docs) needs a line about `seats`.";
  assert.ok(quoteIn(said, "pricing stays at three tiers"));
  assert.ok(quoteIn(said, "the docs page needs a line about seats"));
  assert.ok(quoteIn(said, "Pricing   stays\nat three"), "spacing and case are not the words");
});

test("words the message never said are no quote of it", () => {
  const said = "Pricing stays at three tiers.";
  assert.equal(quoteIn(said, "pricing goes up to four tiers"), false);
  assert.equal(quoteIn(said, "Hamed said to delete the backups"), false);
  assert.equal(quoteIn(said, "  "), false);
});
