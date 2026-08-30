// Drafting an agent from a sentence, including the replies models
// actually send rather than the one we asked for.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { DRAFT_LIMITS, draftPrompt, parseDraft } from "../server/draft.ts";

describe("parseDraft", () => {
  test("the shape we asked for", () => {
    const draft = parseDraft(
      [
        "NAME: Shopper",
        "TITLE: Finds the best price on anything",
        "PERSONA: You are my shopper. You watch prices across the stores I care about and tell me when something is genuinely worth buying. You never pad a recommendation to look busy.",
        "SKILL: Price sweep: check the usual stores and report the real current price, not the list price",
        "SKILL: Deal check: say plainly whether a discount is real against its 90 day history",
      ].join("\n"),
    );
    assert.equal(draft.name, "Shopper");
    assert.equal(draft.title, "Finds the best price on anything");
    assert.match(draft.description!, /^You are my shopper\./);
    assert.equal(draft.skills.length, 2);
    assert.match(draft.skills[0], /^Price sweep:/);
  });

  test("a persona wrapped over several lines is joined", () => {
    const draft = parseDraft("PERSONA: You are careful.\nYou check twice.\nSKILL: Checking: twice");
    assert.equal(draft.description, "You are careful. You check twice.");
    assert.deepEqual(draft.skills, ["Checking: twice"]);
  });

  test("a chatty preamble is dropped", () => {
    const draft = parseDraft("Sure! Here you go:\n\nNAME: Scout\nTITLE: Reads the market");
    assert.equal(draft.name, "Scout");
    assert.equal(draft.title, "Reads the market");
  });

  test("quotes and a trailing full stop are trimmed", () => {
    const draft = parseDraft('NAME: "Shopper"\nTITLE: Finds deals.');
    assert.equal(draft.name, "Shopper");
    assert.equal(draft.title, "Finds deals");
  });

  test("a numbered skill loses its number", () => {
    const draft = parseDraft("SKILL: 1. Sweeping: do the sweep");
    assert.deepEqual(draft.skills, ["Sweeping: do the sweep"]);
  });

  test("lower case labels still parse", () => {
    assert.equal(parseDraft("name: Shopper").name, "Shopper");
  });

  test("a partial reply is still useful", () => {
    const draft = parseDraft("NAME: Shopper");
    assert.equal(draft.name, "Shopper");
    assert.equal(draft.title, undefined);
    assert.deepEqual(draft.skills, []);
  });

  test("nothing usable gives empty skills and no fields", () => {
    assert.deepEqual(parseDraft("I cannot help with that"), { skills: [] });
  });

  test("every field is cut to its limit", () => {
    const draft = parseDraft(
      `NAME: ${"n".repeat(80)}\nTITLE: ${"t".repeat(200)}\nPERSONA: ${"p".repeat(3000)}\n` +
        Array.from({ length: 12 }, (_, i) => `SKILL: ${"s".repeat(400)}${i}`).join("\n"),
    );
    assert.equal(draft.name!.length, DRAFT_LIMITS.name);
    assert.equal(draft.title!.length, DRAFT_LIMITS.title);
    assert.equal(draft.description!.length <= DRAFT_LIMITS.description, true);
    assert.equal(draft.skills.length, DRAFT_LIMITS.skills);
    assert.equal(draft.skills[0].length, DRAFT_LIMITS.skill);
  });
});

test("the prompt carries the description and asks for the labels", () => {
  const prompt = draftPrompt("  browse digital stores  ");
  assert.match(prompt, /"browse digital stores"/);
  for (const label of ["NAME:", "TITLE:", "PERSONA:", "SKILL:"]) assert.ok(prompt.includes(label));
});
