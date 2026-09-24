// Rehearsals: work on a clone, then apply it, carefully, or let it go.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

import { Checkpoints } from "../server/checkpoints.ts";
import { cloneFolder, Rehearsals } from "../server/rehearsals.ts";

const scratch = mkdtempSync(join(tmpdir(), "bloks-rehearsals-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

function folder(name: string, files: Record<string, string>) {
  const dir = join(scratch, name);
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
  return dir;
}

/** A rehearsal the way the server runs one, without the turn. */
async function rehearse(name: string, files: Record<string, string>, work: (copy: string) => void) {
  const dir = folder(name, files);
  const cp = new Checkpoints(join(scratch, `store-${name}`));
  const copy = join(scratch, `${name}-copy`);
  await cloneFolder(dir, copy);
  await cp.begin("lane", "bot", dir, [], copy);
  work(copy);
  const record = await cp.finish("lane");
  return { dir, copy, cp, record };
}

describe("rehearsals", () => {
  test("a clone keeps content and file times", async () => {
    const dir = folder("clone", { "a.txt": "one\n", "deep/b.txt": "two\n" });
    const copy = join(scratch, "clone-copy");
    await cloneFolder(dir, copy);
    assert.equal(readFileSync(join(copy, "deep/b.txt"), "utf8"), "two\n");
    assert.equal(statSync(join(copy, "a.txt")).mtimeMs, statSync(join(dir, "a.txt")).mtimeMs);
  });

  test("the work lands in the clone, the card compares it with the real folder, and nothing real moves", async () => {
    const { dir, record } = await rehearse("one", { "README.md": "# Plan\n\nThursday\n", "old.txt": "x\n" }, (copy) => {
      writeFileSync(join(copy, "README.md"), "# Plan\n\nFriday\n");
      writeFileSync(join(copy, "notes.md"), "new\n");
      rmSync(join(copy, "old.txt"));
    });
    assert.ok(record?.rehearsal);
    assert.deepEqual(record!.files.map((f) => [f.path, f.status]), [["README.md", "modified"], ["notes.md", "added"], ["old.txt", "deleted"]]);
    assert.equal(readFileSync(join(dir, "README.md"), "utf8"), "# Plan\n\nThursday\n");
    assert.equal(existsSync(join(dir, "notes.md")), false);
  });

  test("apply writes the rehearsal into the folder, and afterwards it undoes like any turn", async () => {
    const { dir, cp, record } = await rehearse("two", { "README.md": "Thursday\n", "old.txt": "x\n" }, (copy) => {
      writeFileSync(join(copy, "README.md"), "Friday\n");
      writeFileSync(join(copy, "notes.md"), "new\n");
      rmSync(join(copy, "old.txt"));
    });
    assert.equal(await cp.revert(record!.id), null, "nothing to undo before it is applied");
    const applied = (await cp.apply(record!.id))!;
    assert.deepEqual(applied.restored.sort(), ["README.md", "notes.md", "old.txt"]);
    assert.equal(readFileSync(join(dir, "README.md"), "utf8"), "Friday\n");
    assert.equal(readFileSync(join(dir, "notes.md"), "utf8"), "new\n");
    assert.equal(existsSync(join(dir, "old.txt")), false);
    assert.equal(cp.summary(record!).rehearsal?.state, "applied");
    assert.equal(await cp.apply(record!.id), null, "applied once only");
    const undone = (await cp.revert(record!.id))!;
    assert.equal(undone.skipped.length, 0);
    assert.equal(readFileSync(join(dir, "README.md"), "utf8"), "Thursday\n");
    assert.equal(existsSync(join(dir, "old.txt")), true);
  });

  test("a file changed in the real folder meanwhile is left alone and named", async () => {
    const { dir, cp, record } = await rehearse("three", { "a.txt": "a\n", "b.txt": "b\n" }, (copy) => {
      writeFileSync(join(copy, "a.txt"), "agent\n");
      writeFileSync(join(copy, "b.txt"), "agent\n");
    });
    writeFileSync(join(dir, "b.txt"), "mine\n");
    const applied = (await cp.apply(record!.id))!;
    assert.deepEqual(applied.restored, ["a.txt"]);
    assert.deepEqual(applied.skipped, [{ path: "b.txt", why: "changed since the rehearsal began" }]);
    assert.equal(readFileSync(join(dir, "b.txt"), "utf8"), "mine\n");
  });

  test("a discarded rehearsal can neither be applied nor undone", async () => {
    const { dir, cp, record } = await rehearse("four", { "a.txt": "a\n" }, (copy) => writeFileSync(join(copy, "a.txt"), "b\n"));
    assert.equal(cp.discard(record!.id), true);
    assert.equal(await cp.apply(record!.id), null);
    assert.equal(await cp.revert(record!.id), null);
    assert.equal(cp.summary(record!).rehearsal?.state, "discarded");
    assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "a\n");
  });

  test("the registry keeps attempts in groups, clears clones on settling, and survives a restart", async () => {
    const dir = folder("five", { "a.txt": "a\n" });
    const root = join(scratch, "registry");
    const reg = new Rehearsals(root);
    const first = await reg.open({ botId: "b1", taskId: "t1", dir, text: "do it" });
    const second = await reg.open({ group: first.group, botId: "b2", taskId: "t2", dir, text: "do it" });
    assert.equal(reg.inGroup(first.group).length, 2);
    assert.ok(existsSync(first.copy) && existsSync(second.copy));
    await reg.settle(second.id, "discarded");
    assert.equal(existsSync(second.copy), false);
    const again = new Rehearsals(root);
    assert.equal(again.get(first.id)?.state, "failed", "a rehearsal cannot still be running after a restart");
    assert.equal(again.get(second.id)?.state, "discarded");
  });
});
