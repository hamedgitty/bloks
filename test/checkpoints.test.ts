// What a turn changed, and undoing it without losing anything done since.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

import { Checkpoints, diffLines, MAX_FILE, trackable } from "../server/checkpoints.ts";

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
});
