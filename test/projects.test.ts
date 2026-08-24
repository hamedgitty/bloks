// A project: what it tells an agent, and what it does when its folder goes.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MAX_FOLDERS,
  MAX_NAME,
  briefFor,
  cleanInput,
  missingFolderMessage,
  workingFolder,
  type Project,
  type ProjectStanding,
} from "../server/projects.ts";
import { folderState } from "../server/workspace.ts";

const projectOf = (over: Partial<Project> = {}): Project => ({
  id: "p1",
  name: "Launch",
  brief: "",
  color: "blue",
  shape: "star",
  folders: [],
  include: [],
  memberIds: [],
  createdAt: 1,
  ...over,
});

const standingOf = (project: Project, states: Array<"ok" | "missing" | "not-a-folder">): ProjectStanding => ({
  ...project,
  folderStates: project.folders.map((path, i) => ({ path, state: states[i] ?? "ok" })),
  broken: states.some((s) => s !== "ok"),
});

describe("what an agent working on a project is told", () => {
  test("the name, always", () => {
    assert.match(briefFor(projectOf()), /You are working on Launch\./);
  });

  test("the standing brief, when there is one", () => {
    const brief = briefFor(projectOf({ brief: "Ship small, ship often." }));
    assert.match(brief, /Ship small, ship often\./);
  });

  test("which folder it is in, when there is more than one", () => {
    const one = briefFor(projectOf({ folders: ["/a"] }));
    assert.equal(/Its folders/.test(one), false, "one folder needs no explanation");
    const two = briefFor(projectOf({ folders: ["/a", "/b"] }));
    assert.match(two, /Its folders: \/a, \/b/);
    assert.match(two, /running in the first of them/);
  });

  test("what matters inside them, and that the rest probably is not it", () => {
    const brief = briefFor(projectOf({ include: ["src/**", "docs/*.md"] }));
    assert.match(brief, /What matters here: src\/\*\*, docs\/\*\.md/);
    assert.match(brief, /probably not what you were asked about/);
  });
});

describe("a folder that has gone", () => {
  test("the disk is asked, and answers three ways", () => {
    const dir = mkdtempSync(join(tmpdir(), "bloks-proj-"));
    const file = join(dir, "a-file.txt");
    writeFileSync(file, "hello");
    assert.equal(folderState(dir), "ok");
    assert.equal(folderState(file), "not-a-folder");
    assert.equal(folderState(join(dir, "nope")), "missing");
    rmSync(dir, { recursive: true, force: true });
    assert.equal(folderState(dir), "missing", "a folder that moves stops being ok");
  });

  test("a turn runs in the first folder that is actually there", () => {
    const project = projectOf({ folders: ["/gone", "/here"] });
    assert.equal(workingFolder(standingOf(project, ["missing", "ok"])), "/here");
  });

  test("with none of them there, there is nowhere to run", () => {
    // the alternative is falling back to somewhere else, and an agent
    // quietly writing into the wrong directory is harder to notice than
    // an agent refusing to start
    const project = projectOf({ folders: ["/gone", "/also-gone"] });
    assert.equal(workingFolder(standingOf(project, ["missing", "missing"])), null);
  });

  test("what people are told names the folder and says what stops", () => {
    const project = projectOf({ folders: ["/gone"] });
    const one = missingFolderMessage(project, ["/gone"]);
    assert.match(one, /Launch points at \/gone, which is not there any more/);
    assert.match(one, /Nothing will run in it/);
    const many = missingFolderMessage(project, ["/gone", "/also"]);
    assert.match(many, /folders that are not there any more: \/gone, \/also/);
  });
});

describe("what a client may set", () => {
  test("the ordinary fields survive", () => {
    const clean = cleanInput({
      name: "  Launch  ",
      brief: "Be brief.",
      color: "purple",
      shape: "diamond",
      folders: ["/a", " /b "],
      include: ["src/**"],
      memberIds: ["bot-1"],
    });
    assert.equal(clean.name, "Launch");
    assert.equal(clean.color, "purple");
    assert.deepEqual(clean.folders, ["/a", "/b"]);
    assert.deepEqual(clean.memberIds, ["bot-1"]);
  });

  test("a colour or shape we do not have is ignored rather than stored", () => {
    const clean = cleanInput({ name: "x", color: "chartreuse", shape: "hexagon" });
    assert.equal(clean.color, undefined);
    assert.equal(clean.shape, undefined);
  });

  test("nothing unbounded gets through", () => {
    const clean = cleanInput({
      name: "x".repeat(500),
      folders: Array.from({ length: 40 }, (_, i) => `/f${i}`),
      include: Array.from({ length: 100 }, (_, i) => `p${i}`),
      memberIds: ["fine", "not a valid id", "../escape"],
    });
    assert.equal(clean.name!.length, MAX_NAME);
    assert.equal(clean.folders!.length, MAX_FOLDERS);
    assert.ok(clean.include!.length <= 24);
    assert.deepEqual(clean.memberIds, ["fine"]);
  });

  test("a project always has a name, even when nobody gave it one", () => {
    assert.equal(cleanInput({}).name, "Untitled project");
    // but an existing one keeps its own rather than being renamed
    assert.equal(cleanInput({ brief: "x" }, projectOf()).name, undefined);
  });
});
