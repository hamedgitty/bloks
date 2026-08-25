// What an HTTP status says about a pasted Composio key.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { keyVerdict } from "../server/composio.ts";

describe("keyVerdict", () => {
  test("success accepts the key", () => {
    assert.equal(keyVerdict(200), true);
    assert.equal(keyVerdict(204), true);
  });

  test("a refusal rejects it", () => {
    assert.equal(keyVerdict(401), false);
    assert.equal(keyVerdict(403), false);
  });

  test("anything else cannot tell, so the save goes through", () => {
    for (const status of [0, 404, 429, 500, 502, 503]) {
      assert.equal(keyVerdict(status), null);
    }
  });
});
