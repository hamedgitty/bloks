// A folder's shape becomes a roster.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

import { proposeTeam, readFolderSignals, scoutFolder } from "../server/scout.ts";

const scratch: string[] = [];
const project = (build: (root: string) => void): string => {
  const root = mkdtempSync(join(tmpdir(), "bloks-scout-"));
  scratch.push(root);
  build(root);
  return root;
};
after(() => {
  for (const root of scratch) rmSync(root, { recursive: true, force: true });
});

describe("readFolderSignals", () => {
  test("the manifest names the project and its dependencies", () => {
    const root = project((r) => {
      writeFileSync(join(r, "package.json"), JSON.stringify({ name: "acme", dependencies: { react: "1" } }));
    });
    const signals = readFolderSignals(root);
    assert.equal(signals.name, "acme");
    assert.deepEqual(signals.dependencies, ["react"]);
  });

  test("a README title outranks the manifest name", () => {
    const root = project((r) => {
      writeFileSync(join(r, "package.json"), JSON.stringify({ name: "acme" }));
      writeFileSync(join(r, "README.md"), "# Acme, the shop robot\n\nwords");
    });
    assert.equal(readFolderSignals(root).name, "Acme, the shop robot");
  });

  test("an unreadable folder answers empty, not an exception", () => {
    const signals = readFolderSignals("/definitely/not/here");
    assert.deepEqual(signals.entries, []);
  });
});

describe("proposeTeam", () => {
  test("every roster has a lead at 5 and a reviewer at 4", () => {
    const { members } = proposeTeam({ name: "x", entries: [], dependencies: [], extensions: {} });
    assert.equal(members[0]?.title, "Tech lead");
    assert.equal(members[0]?.seniority, 5);
    assert.equal(members.at(-1)?.title, "Reviewer");
    assert.equal(members.at(-1)?.seniority, 4);
  });

  test("a react project fields a frontend engineer", () => {
    const { members } = proposeTeam({ name: "x", entries: [], dependencies: ["react"], extensions: {} });
    assert.ok(members.some((m) => m.title === "Frontend engineer"));
  });

  test("a server directory fields a backend engineer", () => {
    const { members } = proposeTeam({ name: "x", entries: ["server"], dependencies: [], extensions: {} });
    assert.ok(members.some((m) => m.title === "Backend engineer"));
  });

  test("rosters top out at four seats however loud the signals", () => {
    const { members } = proposeTeam({
      name: "x",
      entries: ["server", "ios", "docs"],
      dependencies: ["react"],
      extensions: { py: 3, md: 5, swift: 2 },
    });
    assert.equal(members.length, 4);
  });

  test("the brief names the project", () => {
    const { brief, name } = proposeTeam({ name: "acme", entries: [], dependencies: [], extensions: {} });
    assert.match(brief, /acme/);
    assert.match(name, /acme/);
  });
});

describe("scoutFolder", () => {
  test("end to end on a real folder", () => {
    const root = project((r) => {
      writeFileSync(join(r, "package.json"), JSON.stringify({ name: "acme", dependencies: { react: "1" } }));
      mkdirSync(join(r, "server"));
    });
    const team = scoutFolder(root);
    assert.equal(team.members.length, 4);
    assert.ok(team.members.every((m) => m.color && m.shape && m.description));
  });

  test("a missing folder refuses in words", () => {
    assert.throws(() => scoutFolder("/definitely/not/here"), /does not exist/);
  });
});
