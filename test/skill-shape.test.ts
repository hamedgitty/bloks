// The shape every bundled skill keeps.
//
// A skill that fires on everything near its subject is worse than no
// skill: it turns a one-line answer into a procedure. So each one has
// to say when to leave it alone, and this is what stops the next skill
// added here from quietly skipping that.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { listSkills } from "../server/skills.ts";

const builtins = () => listSkills().filter((skill) => skill.source === "builtin");

describe("bundled skills", () => {
  test("there are some", () => {
    assert.ok(builtins().length >= 8);
  });

  for (const skill of builtins()) {
    describe(skill.name, () => {
      test("says when it applies", () => {
        assert.match(skill.body, /^Use this /, `${skill.id} should open with "Use this ..."`);
      });

      test("says when to leave it alone", () => {
        assert.match(
          skill.body,
          /^Not for: .+/m,
          `${skill.id} has no "Not for:" line, so it will fire on anything nearby`,
        );
      });

      test("says what it hands back and what needs a person", () => {
        assert.match(skill.body, /^Return: .+/m, `${skill.id} has no "Return:" line`);
        assert.match(skill.body, /^Approval: .+/m, `${skill.id} has no "Approval:" line`);
      });
    });
  }
});
