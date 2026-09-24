// Teams as Markdown files: what reads, what is refused, and the round trip.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { parseGallery, parseTeamFile, TeamFileError, teamFromManifest, writeTeamFile } from "../server/team-file.ts";
import { TEAM_LIBRARY } from "../src/lib/teamLibrary.ts";

const LAUNCH = `---
name: Launch crew
blurb: Ships a product launch, end to end.
---

## Launch lead
seniority: 5
look: blue star
skills:
- Review everything before it ships
- Keep the plan to one page

Runs the launch. Reviews what comes back and makes the call.

## Copywriter
seniority: 2
look: coral drop

Writes the page, the email and the post.
Keeps every line under twenty words.
`;

describe("team files", () => {
  test("a written team reads into members, roles, looks and skills", () => {
    const team = parseTeamFile(LAUNCH);
    assert.equal(team.name, "Launch crew");
    assert.equal(team.blurb, "Ships a product launch, end to end.");
    assert.equal(team.members.length, 2);
    const [lead, copy] = team.members;
    assert.deepEqual([lead.title, lead.seniority, lead.color, lead.shape], ["Launch lead", 5, "blue", "star"]);
    assert.deepEqual(lead.skills, ["Review everything before it ships", "Keep the plan to one page"]);
    assert.equal(lead.description, "Runs the launch. Reviews what comes back and makes the call.");
    assert.equal(copy.description, "Writes the page, the email and the post.\nKeeps every line under twenty words.");
  });

  test("writing a team and reading it back gives the same team", () => {
    for (const premade of TEAM_LIBRARY) {
      const file = writeTeamFile({ name: premade.name, blurb: premade.blurb, members: premade.members });
      const back = parseTeamFile(file);
      assert.equal(back.name, premade.name);
      assert.equal(back.blurb, premade.blurb);
      assert.deepEqual(
        back.members.map((m) => [m.title, m.description, m.skills, m.seniority, m.color, m.shape]),
        premade.members.map((m) => [m.title, m.description, m.skills, m.seniority, m.color, m.shape]),
        premade.name,
      );
    }
  });

  test("a file without the block still works, from its # title", () => {
    const team = parseTeamFile("# Two of us\n\nA pair.\n\n## Writer\nWrites.\n\n## Editor\nseniority: 4\n\nEdits.\n");
    assert.equal(team.name, "Two of us");
    assert.equal(team.blurb, "A pair.");
    assert.equal(team.members[1].seniority, 4);
  });

  test("nobody senior: the first member leads", () => {
    const team = parseTeamFile("# Flat\n\n## A\nDoes a.\n\n## B\nDoes b.\n");
    assert.equal(team.members[0].seniority, 5);
  });

  test("mistakes are named, with where they are", () => {
    const refuse = (text: string, pattern: RegExp) =>
      assert.throws(() => parseTeamFile(text), (e: unknown) => e instanceof TeamFileError && pattern.test(e.message));
    refuse("## A\nx\n\n## B\ny\n", /name/);
    refuse("# T\n\n## Only one\nx\n", /at least two/);
    refuse("# T\n\n## A\nseniority: 9\n\nx\n\n## B\ny\n", /Seniority in the A section \(line 3\)/);
    refuse("# T\n\n## A\nlook: plaid star\ncolor: plaid\n\nx\n\n## B\ny\n", /color in the A section/);
    refuse("# T\n\n## A\n\n## B\ny\n", /Say what the member in the A section/);
    refuse(`# T\n${"\n## M\nx\n".repeat(9)}`, /up to 8/);
    refuse("x".repeat(70_000), /too large/);
  });

  test("long dashes an author typed become commas", () => {
    const team = parseTeamFile("# T\n\n## A\nWrites — fast.\n\n## B\ny\n");
    assert.equal(team.members[0].description, "Writes, fast.");
  });

  test("the gallery keeps only entries that read, and an older JSON export still imports", () => {
    const teams = parseGallery({ teams: [{ slug: "launch", file: LAUNCH, author: "Bloks" }, { slug: "Bad Slug", file: LAUNCH }, { slug: "broken", file: "# x" }] });
    assert.deepEqual(teams.map((t) => t.slug), ["launch"]);
    assert.equal(teams[0].author, "Bloks");
    const fromJson = teamFromManifest({ bloksTeam: 1, name: "Old", members: [{ name: "Ada", title: "Lead", description: "Leads.", seniority: 5, color: "red", shape: "bit" }, { name: "Bo", title: "", description: "Helps." }] });
    assert.equal(fromJson.members[0].name, "Ada");
    assert.equal(fromJson.members[1].title, "Bo");
  });
});
