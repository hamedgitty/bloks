// The memory journal: every change recorded, and undo that never loses work.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

import { MemoryJournal } from "../server/memory-journal.ts";

const scratch = mkdtempSync(join(tmpdir(), "bloks-memory-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
const ws = (botId: string) => join(scratch, "ws", botId);

function setup(botId: string, files: Record<string, string>) {
  mkdirSync(join(ws(botId), "memory"), { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(ws(botId), name), text);
  return new MemoryJournal(join(scratch, "journal"), ws);
}

describe("memory journal", () => {
  test("what an agent writes in a turn becomes one entry per file", () => {
    const j = setup("a", { "MEMORY.md": "# Memory\n" });
    j.begin("lane", "a");
    writeFileSync(join(ws("a"), "MEMORY.md"), "# Memory\n\n- Hamed prefers short replies\n");
    writeFileSync(join(ws("a"), "memory", "people.md"), "# People\n\nSam runs design.\n");
    const entries = j.finish("lane");
    assert.deepEqual(entries.map((e) => [e.file, e.by]).sort(), [["MEMORY.md", "agent"], ["memory/people.md", "agent"]]);
    const view = j.view(entries.find((e) => e.file === "MEMORY.md")!);
    assert.equal(view.added, 2);
    assert.equal(view.removed, 0);
    assert.equal(j.view(entries.find((e) => e.file === "memory/people.md")!).created, true);
    // a turn that changes nothing adds nothing
    j.begin("lane", "a");
    assert.equal(j.finish("lane").length, 0);
  });

  test("undo puts a file back, and a created topic is removed", () => {
    const j = setup("b", { "MEMORY.md": "old\n" });
    j.begin("lane", "b");
    writeFileSync(join(ws("b"), "MEMORY.md"), "new\n");
    writeFileSync(join(ws("b"), "memory", "x.md"), "x\n");
    const [first, second] = j.finish("lane").sort((p, q) => p.file.localeCompare(q.file));
    assert.ok(j.undo("b", first.id).ok);
    assert.equal(readFileSync(join(ws("b"), "MEMORY.md"), "utf8"), "old\n");
    assert.ok(j.undo("b", second.id).ok);
    assert.equal(existsSync(join(ws("b"), "memory", "x.md")), false);
    const list = j.list("b");
    assert.equal(list.filter((e) => e.by === "undo").length, 2);
    assert.ok(list.find((e) => e.id === first.id)!.undoneBy);
    const again = j.undo("b", first.id);
    assert.equal(again.ok, false);
  });

  test("an undo refuses a file that changed since, and touches nothing", () => {
    const j = setup("c", { "MEMORY.md": "one\n" });
    j.begin("lane", "c");
    writeFileSync(join(ws("c"), "MEMORY.md"), "two\n");
    const [entry] = j.finish("lane");
    writeFileSync(join(ws("c"), "MEMORY.md"), "three, mine\n");
    const result = j.undo("c", entry.id);
    assert.equal(result.ok, false);
    assert.equal(readFileSync(join(ws("c"), "MEMORY.md"), "utf8"), "three, mine\n");
  });

  test("edits made in Bloks are recorded as yours, and names outside memory are refused", () => {
    const j = setup("d", {});
    assert.ok(j.record("d", "MEMORY.md", "you", null, "hi\n"));
    assert.equal(j.record("d", "MEMORY.md", "you", "same", "same"), null);
    assert.equal(j.list("d")[0].by, "you");
    assert.equal(j.pathOf("d", "memory/../../secrets.md"), null);
    assert.equal(j.pathOf("d", "notes.md"), null);
    assert.ok(j.pathOf("d", "memory/people.md"));
  });
});
