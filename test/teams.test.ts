// Parsing a team plan out of model output.
//
// Everything here is untrusted: the model decides the shape, and a plan
// that survives becomes real agents spending real tokens. The tests care
// most about what must NOT get through.
import { test } from "node:test";
import assert from "node:assert/strict";

import { extractTeamPlan, normalizePlan, MAX_HIRES } from "../server/teams.ts";

const plan = (members: unknown[], extra: Record<string, unknown> = {}) =>
  "Here is my thinking.\n\n```bloks-team\n" +
  JSON.stringify({ room: "Launch", brief: "Ship it", members, ...extra }) +
  "\n```";

const member = (name: string) => ({
  name,
  title: "Owns a thing",
  description: "Standing instructions",
  skills: ["Do the thing"],
});

test("a valid plan is extracted and the block is stripped from the prose", () => {
  const { plan: parsed, text } = extractTeamPlan(plan([member("Ana"), member("Bo")]));
  assert.equal(parsed?.room, "Launch");
  assert.equal(parsed?.members.length, 2);
  assert.equal(text, "Here is my thinking.");
  assert.ok(!text.includes("bloks-team"), "the fence is machinery, not prose");
});

test("prose with no fence is left exactly alone", () => {
  const said = "I can handle this myself, no team needed.";
  const { plan: parsed, text } = extractTeamPlan(said);
  assert.equal(parsed, null);
  assert.equal(text, said);
});

test("a malformed block does not become a team", () => {
  const { plan: parsed, text } = extractTeamPlan("Thinking\n\n```bloks-team\n{ not json\n```");
  assert.equal(parsed, null);
  // and the text survives, so the user still sees what the agent said
  assert.ok(text.includes("Thinking"));
});

test("a team of one is not a team", () => {
  assert.equal(extractTeamPlan(plan([member("Solo")])).plan, null);
  assert.equal(normalizePlan({ room: "x", brief: "y", members: [] }), null);
});

test("an oversized team is cut to the cap", () => {
  const many = Array.from({ length: 25 }, (_, i) => member(`Agent ${i}`));
  const parsed = extractTeamPlan(plan(many)).plan;
  assert.equal(parsed?.members.length, MAX_HIRES);
});

test("members without a name are skipped, not defaulted", () => {
  const parsed = normalizePlan({
    room: "Launch",
    brief: "Ship it",
    members: [member("Ana"), { title: "no name" }, member("Bo"), null, "a string"],
  });
  assert.deepEqual(parsed?.members.map((m) => m.name), ["Ana", "Bo"]);
});

test("long fields are capped so a plan cannot become a giant prompt", () => {
  const parsed = normalizePlan({
    room: "R".repeat(500),
    brief: "B".repeat(20_000),
    members: [
      { name: "N".repeat(500), title: "T".repeat(500), description: "D".repeat(9_000), skills: ["S".repeat(2_000)] },
      member("Bo"),
    ],
  });
  assert.ok(parsed!.room.length <= 60);
  assert.ok(parsed!.brief.length <= 4_000);
  assert.ok(parsed!.members[0].name.length <= 40);
  assert.ok(parsed!.members[0].title.length <= 80);
  assert.ok(parsed!.members[0].description.length <= 2_000);
  assert.ok(parsed!.members[0].skills[0].length <= 400);
});

test("skills that are not strings are dropped", () => {
  const parsed = normalizePlan({
    room: "Launch",
    brief: "Ship it",
    members: [
      { name: "Ana", title: "t", description: "d", skills: ["real", null, 5, { a: 1 }] },
      member("Bo"),
    ],
  });
  assert.deepEqual(parsed?.members[0].skills, ["real"]);
});

test("a plain json fence still parses, since models forget the label", () => {
  const said =
    "Proposing a team.\n\n```json\n" +
    JSON.stringify({ room: "Launch", brief: "b", members: [member("Ana"), member("Bo")] }) +
    "\n```";
  assert.equal(extractTeamPlan(said).plan?.members.length, 2);
});

test("garbage in the top level is rejected outright", () => {
  for (const raw of [null, undefined, "string", 42, [], { members: "not an array" }]) {
    assert.equal(normalizePlan(raw), null);
  }
});
