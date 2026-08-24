// What we propose, given what somebody says they do.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { recommendedFor, WORK_TYPES } from "../src/lib/recommend.ts";
import { AGENT_TEMPLATES } from "../src/lib/agentTemplates.ts";

describe("recommendations", () => {
  test("every recommendation names a template that exists", () => {
    // the mapping is hand-written data; a typo in it would show the
    // newcomer an empty card on the most important screen in the app
    const known = new Set(AGENT_TEMPLATES.map((t) => t.id));
    for (const work of WORK_TYPES) {
      for (const id of recommendedFor([work.id], 3)) {
        assert.ok(known.has(id), `${work.id} recommends unknown template ${id}`);
      }
    }
    for (const id of recommendedFor([], 3)) {
      assert.ok(known.has(id), `the fallback recommends unknown template ${id}`);
    }
  });

  test("the obvious answer comes first", () => {
    assert.equal(recommendedFor(["building"])[0], "engineer");
    assert.equal(recommendedFor(["support"])[0], "support");
    assert.equal(recommendedFor(["running"])[0], "chief-of-staff");
  });

  test("two kinds of work interleave rather than stacking", () => {
    const both = recommendedFor(["writing", "selling"], 3);
    assert.equal(both[0], "writer", "the first choice of the first answer leads");
    assert.equal(both[1], "sales-outbound", "the other answer is not buried");
    assert.equal(new Set(both).size, both.length, "no repeats");
  });

  test("saying nothing still gets a useful three", () => {
    const none = recommendedFor([]);
    assert.equal(none.length, 3);
    assert.deepEqual(none, ["personal-assistant", "research-analyst", "writer"]);
  });

  test("nonsense answers fall back rather than returning nothing", () => {
    const junk = recommendedFor(["not-a-thing", "also-not"], 3);
    assert.equal(junk.length, 3);
  });

  test("a narrow answer is topped up to the limit without repeating", () => {
    const one = recommendedFor(["admin"], 5);
    assert.equal(one.length, 5);
    assert.equal(new Set(one).size, 5);
  });
});
