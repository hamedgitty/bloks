// An unreadable memory file is not an absent one.
import assert from "node:assert/strict";
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { MemoryJournal } from "../server/memory-journal.ts";

function fixture(t: TestContext, files: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), "bloks-baseline-"));
  const ws = join(root, "workspace");
  mkdirSync(join(ws, "memory"), { recursive: true });
  for (const [file, text] of Object.entries(files)) writeFileSync(join(ws, file), text);
  const journal = join(root, "journal", "bot.json");
  const j = new MemoryJournal(join(root, "journal"), () => ws);
  const renamed: string[] = [];
  const rename = fs.renameSync;
  t.mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
    if (String(from).startsWith(ws + "/") || String(to).startsWith(ws + "/")) renamed.push(String(from));
    return rename(from, to);
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    rmSync(root, { recursive: true, force: true });
    assert.deepEqual(renamed, [], "no memory file is renamed, including after a read failure");
  });
  return { j, ws, journal };
}

function fault(t: TestContext, method: "readFileSync" | "readdirSync", paths: string[], code = "EACCES") {
  const real = fs[method];
  const mocked = t.mock.method(fs, method, (path: fs.PathLike, ...args: unknown[]) => {
    if (paths.includes(String(path))) throw Object.assign(new Error("planted memory must not reach an error"), { code });
    return Reflect.apply(real, fs, [path, ...args]);
  });
  syncBuiltinESMExports();
  return () => {
    mocked.mock.restore();
    syncBuiltinESMExports();
  };
}

test("a failed read, then an edit and Undo, never deletes existing main or topic memory", (t) => {
  const { j, ws } = fixture(t, { "MEMORY.md": "main before", "memory/topic.md": "topic before", "memory/healthy.md": "healthy before" });
  const restore = fault(t, "readFileSync", [join(ws, "MEMORY.md"), join(ws, "memory/topic.md")]);
  j.begin("turn", "bot");
  restore();
  writeFileSync(join(ws, "MEMORY.md"), "main after");
  writeFileSync(join(ws, "memory/topic.md"), "topic after");
  writeFileSync(join(ws, "memory/healthy.md"), "healthy after");
  const entries = j.finish("turn");
  assert.deepEqual(entries.map((e) => e.file), ["memory/healthy.md"], "unknown before has no creation or Undo target");
  assert.equal(j.undo("bot", entries[0].id).ok, true);
  assert.equal(readFileSync(join(ws, "MEMORY.md"), "utf8"), "main after");
  assert.equal(readFileSync(join(ws, "memory/topic.md"), "utf8"), "topic after");
  assert.equal(readFileSync(join(ws, "memory/healthy.md"), "utf8"), "healthy before");
  // No failed observation is cached into the next turn.
  j.begin("next", "bot");
  writeFileSync(join(ws, "MEMORY.md"), "main next");
  const [next] = j.finish("next");
  assert.equal(next.before, "main after");
  assert.equal(j.undo("bot", next.id).ok, true);
  assert.equal(readFileSync(join(ws, "MEMORY.md"), "utf8"), "main after");
});

test("a failed finish read invents no deletion while a readable companion still records", (t) => {
  const { j, ws } = fixture(t, { "MEMORY.md": "before", "memory/topic.md": "before", "memory/healthy.md": "before" });
  j.begin("turn", "bot");
  for (const file of ["MEMORY.md", "memory/topic.md", "memory/healthy.md"]) writeFileSync(join(ws, file), "after");
  const restore = fault(t, "readFileSync", [join(ws, "MEMORY.md"), join(ws, "memory/topic.md")]);
  const entries = j.finish("turn");
  restore();
  assert.deepEqual(entries.map((e) => e.file), ["memory/healthy.md"]);
  assert.equal(j.finish("turn").length, 0, "the incomplete snapshot is consumed once");
  assert.equal(readFileSync(join(ws, "memory/topic.md"), "utf8"), "after");
});

for (const end of ["begin", "finish"] as const) {
  test(`an unreadable topic directory at ${end} leaves main memory independent`, (t) => {
    const { j, ws } = fixture(t, { "MEMORY.md": "before", "memory/topic.md": "before" });
    let restore = () => {};
    if (end === "begin") restore = fault(t, "readdirSync", [join(ws, "memory")]);
    j.begin("turn", "bot");
    restore();
    writeFileSync(join(ws, "MEMORY.md"), "after");
    writeFileSync(join(ws, "memory/topic.md"), "after");
    if (end === "finish") restore = fault(t, "readdirSync", [join(ws, "memory")]);
    const entries = j.finish("turn");
    restore();
    assert.deepEqual(entries.map((e) => e.file), ["MEMORY.md"], "unknown listing cannot claim any topic");
    assert.equal(j.undo("bot", entries[0].id).ok, true);
    assert.equal(readFileSync(join(ws, "MEMORY.md"), "utf8"), "before");
    assert.equal(readFileSync(join(ws, "memory/topic.md"), "utf8"), "after");
  });
}

test("EISDIR is unknown too, even when a listed topic becomes readable afterwards", (t) => {
  const { j, ws } = fixture(t);
  const file = join(ws, "memory/directory.md");
  mkdirSync(file);
  assert.throws(() => readFileSync(file, "utf8"), { code: "EISDIR" });
  j.begin("turn", "bot");
  rmSync(file, { recursive: true });
  writeFileSync(file, "now a file");
  assert.deepEqual(j.finish("turn"), [], "EISDIR cannot become a creation");
  assert.equal(readFileSync(file, "utf8"), "now a file");
});

test("a listed topic gone at read time is known absent, not unknown", (t) => {
  const { j, ws } = fixture(t, { "memory/gone.md": "listed" });
  const restore = fault(t, "readFileSync", [join(ws, "memory/gone.md")], "ENOENT");
  j.begin("turn", "bot");
  restore();
  writeFileSync(join(ws, "memory/gone.md"), "created");
  const [entry] = j.finish("turn");
  assert.equal(entry.before, null);
  assert.equal(j.undo("bot", entry.id).ok, true);
  assert.equal(existsSync(join(ws, "memory/gone.md")), false);
});

test("a real new file in an absent topic directory is removed by Undo", (t) => {
  const { j, ws } = fixture(t);
  rmSync(join(ws, "memory"), { recursive: true });
  j.begin("turn", "bot");
  mkdirSync(join(ws, "memory"));
  const file = join(ws, "memory/new.md");
  writeFileSync(file, "new");
  const [entry] = j.finish("turn");
  assert.equal(entry.before, null);
  assert.equal(j.view(entry).created, true);
  assert.equal(j.undo("bot", entry.id).ok, true);
  assert.equal(existsSync(file), false);
});

test("a normal edit is restored exactly", (t) => {
  const original = "# Memory\n\nCaf\u00e9\r\n";
  const { j, ws } = fixture(t, { "MEMORY.md": original });
  j.begin("turn", "bot");
  writeFileSync(join(ws, "MEMORY.md"), "edited\n");
  const [entry] = j.finish("turn");
  assert.equal(j.undo("bot", entry.id).ok, true);
  assert.equal(readFileSync(join(ws, "MEMORY.md"), "utf8"), original);
  assert.deepEqual(j.undo("bot", entry.id), { ok: false, status: 409, error: "already undone" });
  assert.deepEqual(j.undo("bot", "not-an-entry"), { ok: false, status: 404, error: "no such change" });
});

test("changed-since refusal preserves both the file and journal", (t) => {
  const { j, ws, journal } = fixture(t, { "MEMORY.md": "before" });
  j.begin("turn", "bot");
  writeFileSync(join(ws, "MEMORY.md"), "after");
  const [entry] = j.finish("turn");
  const saved = readFileSync(journal);
  writeFileSync(join(ws, "MEMORY.md"), "later");
  assert.deepEqual(j.undo("bot", entry.id), { ok: false, status: 409, error: "that file has changed since; undo the later changes first, or edit it directly" });
  assert.equal(readFileSync(join(ws, "MEMORY.md"), "utf8"), "later");
  assert.deepEqual(readFileSync(journal), saved);
});

test("big-entry refusal over 256 KB preserves both the file and journal", (t) => {
  const { j, ws, journal } = fixture(t, { "MEMORY.md": "before" });
  j.begin("turn", "bot");
  const big = "x".repeat(256 * 1024 + 1);
  writeFileSync(join(ws, "MEMORY.md"), big);
  const [entry] = j.finish("turn");
  const saved = readFileSync(journal);
  assert.equal(entry.big, true);
  assert.deepEqual(j.undo("bot", entry.id), { ok: false, status: 409, error: "that change was too large to keep, so it cannot be undone" });
  assert.equal(readFileSync(join(ws, "MEMORY.md"), "utf8"), big);
  assert.deepEqual(readFileSync(journal), saved);
});

for (const file of ["MEMORY.md", "memory/topic.md"]) {
  test(`Undo cannot overwrite unreadable ${file} after a recorded deletion`, (t) => {
    const { j, ws, journal } = fixture(t);
    const path = join(ws, file);
    const entry = j.record("bot", file, "you", "deleted text", null)!;
    writeFileSync(path, "later text");
    const saved = readFileSync(journal);
    const restore = fault(t, "readFileSync", [path]);
    const result = j.undo("bot", entry.id);
    restore();
    assert.equal(result.ok, false, "a failed current read must not pass the deleted-entry guard");
    if (!result.ok) {
      assert.equal(result.status, 409);
      assert.match(result.error, /EACCES/);
      assert.match(result.error, /make sure Bloks can read it/i);
      assert.match(result.error, /nothing was changed/i);
      assert.ok(!result.error.includes("planted memory"));
    }
    assert.equal(readFileSync(path, "utf8"), "later text");
    assert.deepEqual(readFileSync(journal), saved);
    const again = j.undo("bot", entry.id);
    assert.equal(again.ok, false, "restored reading applies changed-since protection");
  });
}

test("the existing link refusal takes precedence over a read failure", (t) => {
  const { j, ws, journal } = fixture(t, { "memory/outside.md": "outside" });
  const path = join(ws, "MEMORY.md");
  const entry = j.record("bot", "MEMORY.md", "you", null, "outside")!;
  symlinkSync(join(ws, "memory/outside.md"), path);
  const saved = readFileSync(journal);
  const restore = fault(t, "readFileSync", [path]);
  assert.deepEqual(j.undo("bot", entry.id), { ok: false, status: 409, error: "that file is a link to somewhere else now, so it was left alone" });
  restore();
  assert.equal(readFileSync(path, "utf8"), "outside");
  assert.deepEqual(readFileSync(journal), saved);
});
