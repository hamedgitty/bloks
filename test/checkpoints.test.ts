// What a turn changed, and undoing it without losing anything done since.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

import { execFileSync } from "node:child_process";

import { Checkpoints, diffLines, gitIgnored, MAX_FILE, overlapping, trackable } from "../server/checkpoints.ts";

const scratch = mkdtempSync(join(tmpdir(), "bloks-checkpoints-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

function folder(name: string, files: Record<string, string>) {
  const dir = join(scratch, name);
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
  return dir;
}

describe("checkpoints", () => {
  test("a turn's changes are listed, counted and undone", async () => {
    const dir = folder("one", { "a.txt": "one\ntwo\nthree\n", "keep.txt": "same\n", "gone.txt": "bye\n" });
    const cp = new Checkpoints(join(scratch, "store-one"));
    await cp.begin("lane", "bot", dir);

    // what the agent does in its turn
    writeFileSync(join(dir, "a.txt"), "one\n2\nthree\nfour\n");
    writeFileSync(join(dir, "new.txt"), "hello\n");
    rmSync(join(dir, "gone.txt"));

    const record = await cp.finish("lane");
    assert.ok(record);
    const byPath = Object.fromEntries(record!.files.map((f) => [f.path, f]));
    assert.deepEqual(Object.keys(byPath).sort(), ["a.txt", "gone.txt", "new.txt"]);
    assert.equal(byPath["a.txt"].status, "modified");
    assert.equal(byPath["a.txt"].added, 2);
    assert.equal(byPath["a.txt"].removed, 1);
    assert.equal(byPath["new.txt"].status, "added");
    assert.equal(byPath["new.txt"].added, 1, "a final newline is not a line of its own");
    assert.equal(byPath["gone.txt"].removed, 1);
    assert.equal(byPath["gone.txt"].status, "deleted");

    const diff = cp.diff(record!.id, "a.txt")!;
    assert.deepEqual(
      diff.lines.filter((l) => l.kind !== "same").map((l) => `${l.kind}:${l.text}`),
      ["del:two", "add:2", "add:four"],
    );

    const result = await cp.revert(record!.id);
    assert.deepEqual(result!.skipped, []);
    assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "one\ntwo\nthree\n");
    assert.equal(readFileSync(join(dir, "gone.txt"), "utf8"), "bye\n");
    assert.equal(existsSync(join(dir, "new.txt")), false);
    assert.equal(readFileSync(join(dir, "keep.txt"), "utf8"), "same\n");
    assert.ok(cp.get(record!.id)!.revertedAt);
  });

  test("an undo leaves alone whatever changed after the turn", async () => {
    const dir = folder("two", { "a.txt": "before\n", "b.txt": "before\n" });
    const cp = new Checkpoints(join(scratch, "store-two"));
    await cp.begin("lane", "bot", dir);
    writeFileSync(join(dir, "a.txt"), "agent\n");
    writeFileSync(join(dir, "b.txt"), "agent\n");
    const record = (await cp.finish("lane"))!;

    // the person keeps working on one of them
    writeFileSync(join(dir, "b.txt"), "mine now\n");

    const result = (await cp.revert(record.id))!;
    assert.deepEqual(result.restored, ["a.txt"]);
    assert.deepEqual(result.skipped, [{ path: "b.txt", why: "changed since" }]);
    assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "before\n");
    assert.equal(readFileSync(join(dir, "b.txt"), "utf8"), "mine now\n");
  });

  test("a turn that changed nothing leaves no card, and regenerated folders are ignored", async () => {
    const dir = folder("three", { "a.txt": "x\n" });
    const cp = new Checkpoints(join(scratch, "store-three"));
    await cp.begin("lane", "bot", dir);
    mkdirSync(join(dir, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "pkg", "index.js"), "module.exports = 1\n");
    writeFileSync(join(dir, ".DS_Store"), "noise");
    assert.equal(await cp.finish("lane"), null);
  });

  test("a file too big to keep is shown but never overwritten", async () => {
    const dir = folder("four", { "small.txt": "a\n" });
    writeFileSync(join(dir, "big.bin"), Buffer.alloc(MAX_FILE + 1, 1));
    const cp = new Checkpoints(join(scratch, "store-four"));
    await cp.begin("lane", "bot", dir);
    writeFileSync(join(dir, "big.bin"), Buffer.alloc(MAX_FILE + 2, 2));
    const record = (await cp.finish("lane"))!;
    assert.equal(record.files[0].path, "big.bin");
    assert.equal(record.files[0].big, true);
    const result = (await cp.revert(record.id))!;
    assert.deepEqual(result.skipped, [{ path: "big.bin", why: "too large to have been kept" }]);
  });

  test("records survive a restart, so an old card can still undo", async () => {
    const dir = folder("five", { "a.txt": "old\n" });
    const root = join(scratch, "store-five");
    const first = new Checkpoints(root);
    await first.begin("lane", "bot", dir);
    writeFileSync(join(dir, "a.txt"), "new\n");
    const record = (await first.finish("lane"))!;

    const second = new Checkpoints(root);
    assert.ok(second.get(record.id));
    await second.revert(record.id);
    assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "old\n");
  });

  test("an undo never writes through a folder swapped for a link since", async () => {
    const dir = folder("six", { "sub/a.txt": "before\n" });
    const outside = folder("six-outside", { "keep.txt": "untouched\n" });
    const cp = new Checkpoints(join(scratch, "store-six"));
    await cp.begin("lane", "bot", dir);
    writeFileSync(join(dir, "sub", "a.txt"), "after\n");
    const record = (await cp.finish("lane"))!;
    // the folder the change was in becomes a link to somewhere else
    rmSync(join(dir, "sub"), { recursive: true });
    symlinkSync(outside, join(dir, "sub"));
    writeFileSync(join(outside, "a.txt"), "after\n");
    const result = (await cp.revert(record.id))!;
    assert.deepEqual(result.skipped, [{ path: "sub/a.txt", why: "outside the folder" }]);
    assert.equal(readFileSync(join(outside, "a.txt"), "utf8"), "after\n");
  });

  test("paths someone else tracks are left out", async () => {
    const dir = folder("seven", { "MEMORY.md": "a\n", "memory/x.md": "b\n", "notes.txt": "c\n" });
    const cp = new Checkpoints(join(scratch, "store-seven"));
    await cp.begin("lane", "bot", dir, ["MEMORY.md", "memory/"]);
    writeFileSync(join(dir, "MEMORY.md"), "changed\n");
    writeFileSync(join(dir, "memory", "x.md"), "changed\n");
    writeFileSync(join(dir, "notes.txt"), "changed\n");
    const record = (await cp.finish("lane"))!;
    assert.deepEqual(record.files.map((f) => f.path), ["notes.txt"]);
  });

  test("a home folder, or anything above one, is never photographed", () => {
    const home = join(scratch, "home", "me");
    mkdirSync(join(home, "project"), { recursive: true });
    assert.equal(trackable(home, home), false);
    assert.equal(trackable(join(scratch, "home"), home), false);
    assert.equal(trackable("/", home), false);
    assert.equal(trackable(join(home, "project"), home), true);
    assert.equal(trackable(join(home, "missing"), home), false);
    assert.equal(trackable(null, home), false);
  });

  test("a diff shows a few lines of context and folds the rest", () => {
    const before = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
    const after = before.replace("line 20", "line twenty");
    const lines = diffLines(before, after)!;
    assert.equal(lines.filter((l) => l.kind === "gap").length, 2);
    assert.deepEqual(
      lines.filter((l) => l.kind === "add" || l.kind === "del").map((l) => l.text),
      ["line 20", "line twenty"],
    );
    assert.equal(lines.filter((l) => l.kind === "same").length, 6);
  });

  test("what the repository ignores is not the turn's work, and Undo leaves it be", async (t) => {
    const dir = folder("ignored", { ".gitignore": "build/\n*.log\n", "notes.md": "a\n", "build/out.js": "old build\n" });
    try {
      execFileSync("git", ["init", "-q", dir]);
    } catch {
      return t.skip("no git here");
    }
    if (!(await gitIgnored(dir))) return t.skip("no usable git here");
    const cp = new Checkpoints(join(scratch, "store-ignored"));
    await cp.begin("lane", "bot", dir);
    writeFileSync(join(dir, "notes.md"), "b\n");
    writeFileSync(join(dir, "build", "out.js"), "new build\n");
    writeFileSync(join(dir, "debug.log"), "log\n");
    const record = await cp.finish("lane");
    assert.deepEqual(record!.files.map((f) => `${f.status} ${f.path}`), ["modified notes.md"]);
    const undo = await cp.revert(record!.id);
    assert.deepEqual(undo!.restored, ["notes.md"]);
    assert.equal(readFileSync(join(dir, "build", "out.js"), "utf8"), "new build\n");
    assert.ok(existsSync(join(dir, "debug.log")));
  });

  test("Apply keeps a later edit to a file too big to have been kept", async () => {
    for (const [label, size] of [["small", 32], ["large", MAX_FILE + 1]] as const) {
      const dir = join(scratch, `apply-${label}`);
      const copy = join(scratch, `apply-${label}-copy`);
      mkdirSync(dir);
      mkdirSync(copy);
      writeFileSync(join(dir, "data.bin"), Buffer.alloc(size, 65));
      writeFileSync(join(copy, "data.bin"), Buffer.alloc(size, 65));
      const cp = new Checkpoints(join(scratch, `apply-${label}-store`));
      await cp.begin(label, "bot", dir, [], copy);
      writeFileSync(join(copy, "data.bin"), Buffer.alloc(size, 66));
      writeFileSync(join(dir, "data.bin"), Buffer.alloc(size + 1, 67));
      const record = await cp.finish(label);
      const result = await cp.apply(record!.id);
      assert.deepEqual(result, { restored: [], skipped: [{ path: "data.bin", why: "changed since the rehearsal began" }] }, label);
      assert.ok(readFileSync(join(dir, "data.bin")).every((b) => b === 67), `${label}: the later edit was lost`);
    }
  });

  test("Apply still brings in a big file nobody touched since", async () => {
    const dir = join(scratch, "apply-big-clean");
    const copy = join(scratch, "apply-big-clean-copy");
    mkdirSync(dir);
    mkdirSync(copy);
    const cp = new Checkpoints(join(scratch, "apply-big-clean-store"));
    await cp.begin("clean", "bot", dir, [], copy);
    writeFileSync(join(copy, "made.bin"), Buffer.alloc(MAX_FILE + 1, 66));
    const record = await cp.finish("clean");
    const result = await cp.apply(record!.id);
    assert.deepEqual(result!.restored, ["made.bin"]);
    assert.equal(readFileSync(join(dir, "made.bin")).length, MAX_FILE + 1);
  });
});

// GitHub 153: two agents in one folder. A turn that ran beside another
// keeps as its own only what its engine said it edited; the rest is
// listed apart and Undo leaves it alone.
describe("turns that share a folder", () => {
  test("each turn claims what it said it edited, and Undo leaves the other agent's work", async () => {
    const dir = folder("shared", { "notes.md": "a\n", "log.md": "b\n", "skill.md": "c\n" });
    const cp = new Checkpoints(join(scratch, "store-shared"));
    await cp.begin("lane-a", "ada", dir);
    await cp.begin("lane-b", "linus", dir);

    // A edits notes.md with its file tool; B edits log.md the same way and
    // skill.md from a shell command it never names
    cp.noteEdits("lane-a", [join(dir, "notes.md")]);
    writeFileSync(join(dir, "notes.md"), "a, by Ada\n");
    cp.noteEdits("lane-b", ["log.md"]);
    writeFileSync(join(dir, "log.md"), "b, by Linus\n");
    writeFileSync(join(dir, "skill.md"), "c, by a script\n");

    const a = (await cp.finish("lane-a"))!;
    const own = a.files.filter((f) => !f.shared).map((f) => f.path);
    const shared = a.files.filter((f) => f.shared).map((f) => f.path).sort();
    assert.deepEqual(own, ["notes.md"]);
    assert.deepEqual(shared, ["log.md", "skill.md"]);
    assert.deepEqual(a.alongside, ["linus"]);
    assert.equal(a.files[0].path, "notes.md", "its own come first on the card");
    const summary = cp.summary(a);
    assert.deepEqual(summary.shared, { total: 2, alongside: ["linus"] });

    const undo = (await cp.revert(a.id))!;
    assert.deepEqual(undo.restored, ["notes.md"]);
    assert.deepEqual(undo.skipped.map((s) => s.path).sort(), ["log.md", "skill.md"]);
    assert.equal(readFileSync(join(dir, "notes.md"), "utf8"), "a\n");
    assert.equal(readFileSync(join(dir, "log.md"), "utf8"), "b, by Linus\n", "the other agent's work is untouched");

    // B still running after A finished: it overlapped A, so it is just as careful
    const b = (await cp.finish("lane-b"))!;
    assert.deepEqual(b.files.filter((f) => !f.shared).map((f) => f.path), ["log.md"]);
    assert.deepEqual(b.alongside, ["ada"]);
  });

  test("a turn that came and went in the middle of a long one still counts", async () => {
    const dir = folder("brief", { "x.md": "1\n", "y.md": "2\n" });
    const cp = new Checkpoints(join(scratch, "store-brief"));
    await cp.begin("long", "ada", dir);
    await cp.begin("short", "linus", dir);
    writeFileSync(join(dir, "y.md"), "2, by Linus\n");
    await cp.finish("short");
    writeFileSync(join(dir, "x.md"), "1, by Ada\n");
    cp.noteEdits("long", ["x.md"]);
    const long = (await cp.finish("long"))!;
    assert.deepEqual(long.files.find((f) => f.path === "y.md")?.shared, true);
    assert.equal(long.files.find((f) => f.path === "x.md")?.shared, undefined);
  });

  test("a turn that ran alone claims everything, as before", async () => {
    const dir = folder("alone", { "x.md": "1\n" });
    const cp = new Checkpoints(join(scratch, "store-alone"));
    await cp.begin("lane", "ada", dir);
    writeFileSync(join(dir, "x.md"), "2\n");
    writeFileSync(join(dir, "z.md"), "new\n");
    const record = (await cp.finish("lane"))!;
    assert.ok(record.files.every((f) => !f.shared));
    assert.equal(record.alongside, undefined);
    assert.equal(cp.summary(record).shared, undefined);
    // and a later turn elsewhere, or after this one ended, changes nothing
    const other = folder("elsewhere", { "q.md": "q\n" });
    await cp.begin("lane-2", "linus", other);
    await cp.begin("lane-3", "linus", dir);
    writeFileSync(join(dir, "x.md"), "3\n");
    const third = (await cp.finish("lane-3"))!;
    assert.ok(third.files.every((f) => !f.shared), "a turn elsewhere is not in this folder");
    cp.cancel("lane-2");
  });

  test("a folder inside another is the same place, and a path outside the folder is never claimed", async () => {
    assert.equal(overlapping("/work/repo", "/work/repo/sub"), true);
    assert.equal(overlapping("/work/repo/sub", "/work/repo"), true);
    assert.equal(overlapping("/work/repo", "/work/repo2"), false);
    const dir = folder("nested", { "top.md": "t\n", "sub/inner.md": "i\n" });
    const cp = new Checkpoints(join(scratch, "store-nested"));
    await cp.begin("outer", "ada", dir);
    await cp.begin("inner", "linus", join(dir, "sub"));
    cp.noteEdits("outer", ["../somewhere-else.md", "/etc/hosts", "top.md"]);
    writeFileSync(join(dir, "top.md"), "t2\n");
    writeFileSync(join(dir, "sub", "inner.md"), "i2\n");
    const outer = (await cp.finish("outer"))!;
    assert.deepEqual(outer.files.filter((f) => !f.shared).map((f) => f.path), ["top.md"]);
    assert.deepEqual(outer.files.filter((f) => f.shared).map((f) => f.path), ["sub/inner.md"]);
    cp.cancel("inner");
  });

  test("a rehearsal works in its own copy, so it neither shares the folder nor makes others share it", async () => {
    const dir = folder("rehearsed", { "r.md": "r\n" });
    const copy = folder("rehearsed-copy", { "r.md": "r\n" });
    const cp = new Checkpoints(join(scratch, "store-rehearsed"));
    await cp.begin("real", "ada", dir);
    await cp.begin("rehearsal", "linus", dir, [], copy);
    writeFileSync(join(dir, "r.md"), "r, by Ada\n");
    const real = (await cp.finish("real"))!;
    assert.ok(real.files.every((f) => !f.shared));
    cp.cancel("rehearsal");
  });
});
