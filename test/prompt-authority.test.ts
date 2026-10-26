import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const home = mkdtempSync(join(tmpdir(), "prompt-authority-"));
process.env.BLOKS_DATA_DIR = join(home, ".bloks");
after(() => rmSync(home, { recursive: true, force: true }));
const { getSkills, disclose, skillsPrompt } = await import("../server/skills.ts");
const { replyRules } = await import("../server/house-style.ts");
const { secretHint } = await import("../server/agent-cli.ts");

test("both reply modes distinguish a requested file from an ordinary answer", () => {
  for (const drawn of [true, false]) {
    const said = replyRules(drawn);
    assert.match(said, /unless a file is requested or otherwise authorized/);
    assert.match(said, /analysis or comparison alone does not authorize a file/);
  }
  assert.match(replyRules(true), /openui block/);
  assert.doesNotMatch(replyRules(false), /openui block/);
});

test("actual built-ins remain accessible with and without skill retrieval", () => {
  const skills = getSkills(["page-design", "code-review", "daily-brief"]);
  assert.equal(skills.length, 3);
  const fetched = disclose(skills, true);
  const full = disclose(skills, false);
  assert.equal(full.indexed.length, 0);
  assert.equal(full.inline.length, 3);
  for (const skill of skills) {
    assert.ok([...fetched.inline, ...fetched.indexed].some((s) => s.id === skill.id));
    if (fetched.indexed.some((s) => s.id === skill.id)) {
      assert.match(skillsPrompt(fetched, "read the skill")!, new RegExp(skill.id));
      assert.ok(getSkills([skill.id])[0].body.includes(skill.body));
    } else assert.ok(skillsPrompt(fetched, "read the skill")!.includes(skill.body));
    assert.ok(skillsPrompt(full, "unused")!.includes(skill.body));
  }
});

test("secret instructions remain capability scoped", () => {
  assert.match(secretHint("tool", "node cli")!, /request_secret/);
  assert.match(secretHint("cli", "node cli")!, /node cli/);
  assert.doesNotMatch(secretHint("cli", "node cli")!, /request_secret/);
  assert.equal(secretHint(null, "node cli"), null);
});
