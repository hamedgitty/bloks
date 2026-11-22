// The side dock's Files and Changes panels (GitHub 522): the tree of an
// agent's shared files and its filter, what a conversation changed over
// all its turns, and what git says is not committed in its folder.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

import { buildTree, countFiles, filterTree, visibleRows } from "../src/lib/fileTree.ts";
import { changeTotals, changesRound, numberedDiff, totalsLabel, type ChangedFile } from "../src/lib/laneChanges.ts";
import { Checkpoints, diffLines } from "../server/checkpoints.ts";
import { localUrls } from "../server/terminal.ts";
import { MAX_RECENT, noteRecent, parseRecent, previewsFrom } from "../src/lib/previews.ts";
import { backgroundTasks, runningCount } from "../src/lib/backgroundTasks.ts";
import { gitChanges, gitFileDiff, inSkippedDir, parseNumstat, parsePorcelainV2, parseUnifiedDiff, safeRelativePath } from "../server/git-changes.ts";

const scratch = mkdtempSync(join(tmpdir(), "bloks-dock-panels-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

function folder(name: string, files: Record<string, string>) {
  const dir = join(scratch, name);
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
  return dir;
}

const leaf = (name: string) => ({ name, mime: "text/plain", size: 1 });

describe("the Files panel's tree", () => {
  const files = ["reports/q3.pdf", "reports/2024/q10.md", "reports/2024/q2.md", "notes.md", "Apple.txt"].map(leaf);

  test("folders first, then files, in the order a person reads numbers", () => {
    const tree = buildTree(files);
    assert.deepEqual(tree.map((n) => n.label), ["reports", "Apple.txt", "notes.md"]);
    const reports = tree[0];
    assert.deepEqual(reports.children.map((n) => n.label), ["2024", "q3.pdf"]);
    assert.deepEqual(reports.children[0].children.map((n) => n.label), ["q2.md", "q10.md"]);
    assert.equal(countFiles(tree), 5);
  });

  test("a name with an empty part is no row", () => {
    assert.equal(countFiles(buildTree([leaf("a//b.md"), leaf("/c.md"), leaf("ok.md")])), 1);
  });

  test("folders open one at a time, and a filter opens everything that matches", () => {
    const tree = buildTree(files);
    assert.deepEqual(visibleRows(tree, new Set()).map((r) => r.node.path), ["reports", "Apple.txt", "notes.md"]);
    const opened = visibleRows(tree, new Set(["reports"]));
    assert.deepEqual(opened.map((r) => [r.node.path, r.depth]), [["reports", 0], ["reports/2024", 1], ["reports/q3.pdf", 1], ["Apple.txt", 0], ["notes.md", 0]]);
    const found = filterTree(tree, "2024 Q1");
    assert.deepEqual(visibleRows(found, new Set(), true).map((r) => r.node.path), ["reports", "reports/2024", "reports/2024/q10.md"]);
    assert.deepEqual(filterTree(tree, "nothing-like-it"), []);
    assert.equal(filterTree(tree, "  ").length, tree.length, "nothing typed is the whole tree");
  });
});

describe("what a conversation changed", () => {
  test("one difference per file over every turn, newest first, and a file made and gone again is not listed", async () => {
    const dir = folder("lane", { "a.md": "one\ntwo\n", "b.md": "keep\n", "c.md": "bye\n" });
    const cp = new Checkpoints(join(scratch, "store-lane"));
    await cp.begin("lane1", "bot", dir);
    writeFileSync(join(dir, "a.md"), "one\nTWO\n");
    writeFileSync(join(dir, "tmp.md"), "scratch\n");
    assert.ok(await cp.finish("lane1"));
    await new Promise((r) => setTimeout(r, 5));
    await cp.begin("lane1", "bot", dir);
    writeFileSync(join(dir, "a.md"), "one\nTWO\nthree\n");
    unlinkSync(join(dir, "tmp.md"));
    unlinkSync(join(dir, "c.md"));
    writeFileSync(join(dir, "new.md"), "hello\n");
    assert.ok(await cp.finish("lane1"));

    const changes = cp.laneChanges("lane1");
    const byPath = Object.fromEntries(changes.map((c) => [c.path, c]));
    assert.deepEqual(Object.keys(byPath).sort(), ["a.md", "c.md", "new.md"]);
    assert.equal(byPath["a.md"].status, "modified");
    assert.equal(byPath["a.md"].turns, 2);
    assert.equal(byPath["a.md"].added, 2);
    assert.equal(byPath["a.md"].removed, 1);
    assert.equal(byPath["c.md"].status, "deleted");
    assert.equal(byPath["new.md"].status, "added");
    assert.equal(cp.laneChanges("other").length, 0, "another conversation's turns are not this one's");

    const diff = cp.laneDiff("lane1", "a.md")!;
    assert.deepEqual(diff.lines.filter((l) => l.kind !== "same").map((l) => [l.kind, l.text]), [["del", "two"], ["add", "TWO"], ["add", "three"]]);
    assert.equal(diff.lines.find((l) => l.text === "three")?.new, 3, "each line knows where it is after");
    assert.equal(cp.laneFile("lane1", "a.md"), "one\nTWO\nthree\n");
    assert.equal(cp.laneFile("lane1", "c.md"), null, "a deleted file has nothing to open");
    assert.equal(cp.laneFile("lane1", "tmp.md"), null, "nor a path it no longer lists");
    assert.equal(cp.laneDiff("lane1", "../etc/passwd"), null);
  });

  test("an undone turn changed nothing", async () => {
    const dir = folder("undone", { "a.md": "x\n" });
    const cp = new Checkpoints(join(scratch, "store-undone"));
    await cp.begin("lane2", "bot", dir);
    writeFileSync(join(dir, "a.md"), "y\n");
    const record = await cp.finish("lane2");
    assert.equal(cp.laneChanges("lane2").length, 1);
    await cp.revert(record!.id);
    assert.equal(cp.laneChanges("lane2").length, 0);
  });

  test("the panel's totals, rows and round", () => {
    const files: ChangedFile[] = [
      { path: "a", status: "modified", checkpointId: "c", at: 1, turns: 1, added: 3, removed: 1 },
      { path: "b", status: "added", checkpointId: "c", at: 1, turns: 1, added: 2 },
      { path: "c", status: "modified", checkpointId: "c", at: 1, turns: 1, big: true },
    ];
    assert.deepEqual(changeTotals(files), { files: 3, added: 5, removed: 1 });
    assert.equal(totalsLabel(files), "+5 −1");
    assert.equal(totalsLabel([]), undefined, "nothing changed says nothing");
    const rows = numberedDiff({ hunks: [{ lines: [{ kind: "add", new: 1, text: "x" }] }, { lines: [{ kind: "same", old: 9, new: 10, text: "y" }] }] });
    assert.deepEqual(rows.map((r) => r.kind), ["add", "gap", "same"]);
    assert.deepEqual(numberedDiff({ lines: diffLines("a\n", "b\n")! }).map((r) => [r.kind, r.old, r.new]), [["del", 1, undefined], ["add", undefined, 1]]);
    const round = changesRound([{ id: "1", kind: "changes", changes: {} }, { id: "2", kind: "text" }]);
    assert.notEqual(round, changesRound([{ id: "1", kind: "changes", changes: { reverted: { at: 1 } } }]), "an undo is a new round");
  });
});

describe("what git says is not committed", () => {
  test("porcelain v2, numstat and unified diffs are read as git writes them", () => {
    const status = [
      "# branch.oid 1234567890abcdef",
      "# branch.head main",
      "# branch.upstream origin/main",
      "# branch.ab +2 -1",
      "1 .M N... 100644 100644 100644 aaa bbb src/a file.ts",
      "1 A. N... 000000 100644 100644 000 ccc added.ts",
      "1 .D N... 100644 100644 000000 ddd ddd gone.ts",
      "2 R. N... 100644 100644 100644 eee eee R100 new.ts",
      "old.ts",
      "u UU N... 100644 100644 100644 100644 f g h both.ts",
      "? notes.md",
      "? nested/",
      "",
    ].join("\0");
    const { header, changes } = parsePorcelainV2(status);
    assert.deepEqual(header, { oid: "1234567890abcdef", branch: "main", upstream: "origin/main", ahead: 2, behind: 1 });
    assert.deepEqual(changes, [
      { path: "src/a file.ts", status: "modified" },
      { path: "added.ts", status: "added" },
      { path: "gone.ts", status: "deleted" },
      { path: "new.ts", status: "renamed", from: "old.ts" },
      { path: "both.ts", status: "conflict" },
      { path: "notes.md", status: "added", untracked: true },
    ]);
    const counts = parseNumstat("3\t1\ta.ts\0-\t-\timg.png\0");
    assert.deepEqual(counts.get("a.ts"), { added: 3, removed: 1, binary: false });
    assert.deepEqual(counts.get("img.png"), { added: null, removed: null, binary: true });
    const diff = parseUnifiedDiff("diff --git a/x b/x\n@@ -1,2 +1,2 @@\n a\n-b\n+B\n\\ No newline at end of file\n");
    assert.deepEqual(diff.hunks[0].lines, [
      { kind: "same", old: 1, new: 1, text: "a" },
      { kind: "del", old: 2, text: "b" },
      { kind: "add", new: 2, text: "B" },
    ]);
    assert.equal(parseUnifiedDiff("@@ -1 +1 @@\n-a\n+b\n", 1).truncated, true);
  });

  test("a path asked about stays inside the folder", () => {
    assert.equal(safeRelativePath("src/a.ts"), "src/a.ts");
    for (const bad of ["", "/etc/passwd", "../x", "a/../b", "a//b", "./a", "a\0b", 7]) assert.equal(safeRelativePath(bad), null, String(bad));
    assert.equal(inSkippedDir("node_modules/x/index.js"), true);
    assert.equal(inSkippedDir("src/node_modules.ts"), false);
  });

  test("a real repository's uncommitted files and one file's diff, links never read", async (t) => {
    const dir = folder("repo", { "a.txt": "one\n", "keep.txt": "same\n" });
    try {
      execFileSync("git", ["init", "-q", dir]);
      execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", "add", "."]);
      execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "first"]);
    } catch {
      return t.skip("no git here");
    }
    const state = await gitChanges(dir);
    if (!state.repo) return t.skip("no usable git here");
    assert.equal(state.changes.length, 0);
    writeFileSync(join(dir, "a.txt"), "one\ntwo\n");
    writeFileSync(join(dir, "new.txt"), "x\ny\n");
    symlinkSync("/etc/hosts", join(dir, "link.txt"));
    mkdirSync(join(dir, "node_modules", "p"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "p", "i.js"), "x\n");
    const after = await gitChanges(dir);
    assert.ok(after.repo);
    const byPath = Object.fromEntries(after.changes.map((c) => [c.path, c]));
    assert.deepEqual(Object.keys(byPath).sort(), ["a.txt", "link.txt", "new.txt"], "nothing from a dependency folder");
    assert.deepEqual([byPath["a.txt"].added, byPath["a.txt"].removed], [1, 0]);
    assert.equal(byPath["new.txt"].added, 2);
    const diff = await gitFileDiff(dir, "a.txt");
    assert.deepEqual(diff?.hunks[0].lines.filter((l) => l.kind === "add").map((l) => [l.new, l.text]), [[2, "two"]]);
    assert.equal((await gitFileDiff(dir, "link.txt"))?.link, true);
    assert.equal(await gitFileDiff(dir, "keep.txt"), null, "a file git does not list as changed");
    assert.equal(await gitFileDiff(dir, "../a.txt"), null);
    assert.deepEqual(await gitChanges(scratch), { repo: false, installed: true });
  });
});

describe("the browser's empty tab and Background tasks", () => {
  test("a terminal's addresses on this computer are found as a person would open them", () => {
    assert.deepEqual(localUrls("\u001b[32m  ➜  Local:   http://localhost:5173/\u001b[0m\n"), ["http://localhost:5173/"]);
    assert.deepEqual(localUrls("listening on http://0.0.0.0:3000, see (http://127.0.0.1:8080)."), ["http://localhost:3000", "http://127.0.0.1:8080"]);
    assert.deepEqual(localUrls("visit https://example.com:443 or http://localhost without a port"), [], "only this computer, with a port");
  });

  test("the agent's running tabs come first, then recent pages not already offered", () => {
    const shells = [
      { title: "dev", agent: { name: "Ada" }, urls: ["http://localhost:5173/"] },
      { title: "mine", urls: ["http://localhost:9999"] },
      { title: "old", agent: { name: "Ada" }, urls: ["http://localhost:4000"], exitedAt: 5 },
    ];
    const offered = previewsFrom(shells, [{ url: "http://localhost:5173/" }, { url: "https://bloks.dev", title: "Bloks" }]);
    assert.deepEqual(offered.map((p) => p.url), ["http://localhost:5173/", "https://bloks.dev"], "the person's tab and an ended one are not offered");
    assert.deepEqual(offered[0].from, { kind: "terminal", title: "dev", agent: "Ada" });
  });

  test("recent pages: newest first, once each, web pages only, capped", () => {
    let list: Array<{ url: string; title?: string }> = [];
    for (let i = 0; i < MAX_RECENT + 2; i++) list = noteRecent(list, { url: `https://a.test/${i}` });
    list = noteRecent(list, { url: "https://a.test/3", title: " Three " });
    list = noteRecent(list, { url: "file:///etc/passwd" });
    assert.equal(list.length, MAX_RECENT);
    assert.deepEqual(list[0], { url: "https://a.test/3", title: "Three" });
    assert.deepEqual(parseRecent(JSON.stringify([{ url: "javascript:alert(1)" }, { url: "http://x.test", title: 4 }, 7])), [{ url: "http://x.test" }]);
    assert.deepEqual(parseRecent("{nope"), []);
  });

  test("background tasks are the agent's own tabs and the jobs it took, with a count of what runs", () => {
    const tasks = backgroundTasks(
      [
        { id: "a", title: "dev", startedAt: 2, agent: { command: "npm run dev" }, urls: ["http://localhost:5173"] },
        { id: "b", title: "tests", startedAt: 1, exitedAt: 3, exitCode: 1, agent: { command: "npm test" } },
        { id: "c", title: "mine", startedAt: 4 },
      ],
      [
        { id: "j1", title: "Draft notes", state: "claimed", claimedBy: "bot", postedAt: 1, threadId: "lane" },
        { id: "j2", title: "Done one", state: "done", claimedBy: "bot", postedAt: 1 },
        { id: "j3", title: "Theirs", state: "claimed", claimedBy: "other", postedAt: 1 },
      ],
      "bot",
    );
    assert.deepEqual(tasks.map((t) => `${t.kind}:${t.id}`), ["terminal:a", "terminal:b", "job:j1"]);
    assert.equal(runningCount(tasks), 2);
    assert.equal(tasks[1].kind === "terminal" && tasks[1].exitCode, 1);
  });
});
