// Saving a file whole, and keeping one that will not parse
// (server/atomic-write.ts).
//
// Several stores used to save with a plain writeFileSync, which empties
// the file before writing it. A crash or a full disk in between left a
// file cut short, the loader read that as nothing saved, and the next
// save made the loss permanent. config.json, with every key in it, went
// the same way.
import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { setAside, writeFileAtomic } from "../server/atomic-write.ts";

const scratch = (t: { after: (fn: () => void) => void }) => {
  const dir = mkdtempSync(join(tmpdir(), "bloks-atomic-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test("a save replaces the file whole, and leaves nothing else beside it", (t) => {
  const dir = scratch(t);
  const file = join(dir, "bloks.json");
  writeFileSync(file, JSON.stringify([{ id: "old" }]));
  writeFileAtomic(file, JSON.stringify([{ id: "new" }]), 0o600);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), [{ id: "new" }]);
  // a temp file left behind on every save would fill the folder
  assert.deepEqual(readdirSync(dir), ["bloks.json"]);
});

test("a file saved 0600 is 0600, even over one somebody left wider", { skip: process.platform === "win32" }, (t) => {
  const dir = scratch(t);
  const file = join(dir, "config.json");
  // An older build wrote config.json without a mode, and a mode passed to
  // writeFileSync only counts for a file it creates.
  writeFileSync(file, "{}", { mode: 0o644 });
  writeFileAtomic(file, JSON.stringify({ providers: { anthropic: { key: "k" } } }), 0o600);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  // and a file that did not exist yet is made that way
  const fresh = join(dir, "fresh.json");
  writeFileAtomic(fresh, "[]", 0o600);
  assert.equal(statSync(fresh).mode & 0o777, 0o600);
});

test("a save that fails part way leaves the old file exactly as it was", (t) => {
  const dir = scratch(t);
  const file = join(dir, "routines.json");
  writeFileSync(file, '[{"id":"r1"}]');
  // Not something writeFileSync can write, so it throws mid-save, which
  // is where a full disk would throw too.
  assert.throws(() => writeFileAtomic(file, Symbol("not text") as unknown as string, 0o600));
  assert.equal(readFileSync(file, "utf8"), '[{"id":"r1"}]');
  assert.deepEqual(readdirSync(dir), ["routines.json"], "the half-written temp is cleaned up");
});

test("a file that will not parse is moved aside; a missing one is left alone", (t) => {
  const dir = scratch(t);
  const file = join(dir, "jobs.json");
  writeFileSync(file, '[{"id":"j1","title":"Wri');
  let error: unknown;
  try {
    JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    error = e;
  }
  const aside = setAside(file, error);
  assert.ok(aside, "the unreadable file was kept");
  assert.match(aside!, /jobs\.json\.corrupt-[\dT-]+Z$/);
  assert.equal(readFileSync(aside!, "utf8"), '[{"id":"j1","title":"Wri');
  assert.deepEqual(readdirSync(dir), [aside!.slice(dir.length + 1)]);

  // A first run has no file at all, and that is not worth a copy or a word.
  let missing: unknown;
  try {
    readFileSync(join(dir, "none.json"), "utf8");
  } catch (e) {
    missing = e;
  }
  assert.equal(setAside(join(dir, "none.json"), missing), null);
  assert.deepEqual(readdirSync(dir).length, 1);
});

test("a file that could not be read this once is left where it is", () => {
  const dir = mkdtempSync(join(tmpdir(), "bloks-aside-io-"));
  try {
    const file = join(dir, "messages-x.json");
    writeFileSync(file, '[{"id":"m1"}]');
    // too many open files, say: the file itself may be fine
    const busy = Object.assign(new Error("EMFILE: too many open files"), { code: "EMFILE" });
    assert.equal(setAside(file, busy), null);
    assert.equal(readFileSync(file, "utf8"), '[{"id":"m1"}]');
    // a file that is there and is not JSON is the one that moves
    writeFileSync(file, '[{"id":');
    let parse: unknown;
    try {
      JSON.parse(readFileSync(file, "utf8"));
    } catch (error) {
      parse = error;
    }
    assert.ok(setAside(file, parse));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a save that skips the flush still replaces the file whole", () => {
  const dir = mkdtempSync(join(tmpdir(), "bloks-noflush-"));
  try {
    const file = join(dir, "bots.json");
    writeFileSync(file, "old");
    writeFileAtomic(file, "new", undefined, { flush: false });
    assert.equal(readFileSync(file, "utf8"), "new");
    assert.deepEqual(readdirSync(dir), ["bots.json"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Windows: a scanner or the indexer holding the file makes a rename over
// it fail for a moment.
test("a rename refused for a moment is tried again", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "bloks-busy-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "rooms.json");
  writeFileSync(file, "old");
  const real = fs.renameSync;
  let refused = 0;
  t.mock.method(fs, "renameSync", (from: string, to: string) => {
    if (refused++ < 2) throw Object.assign(new Error("EBUSY: resource busy"), { code: "EBUSY" });
    return real(from, to);
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  writeFileAtomic(file, "new");
  assert.equal(readFileSync(file, "utf8"), "new");
  assert.deepEqual(readdirSync(dir), ["rooms.json"]);
});

test("a rename that stays refused falls back to writing the file in place", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "bloks-busy-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "config.json");
  writeFileSync(file, "old");
  t.mock.method(fs, "renameSync", () => {
    throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  writeFileAtomic(file, "new", 0o600);
  assert.equal(readFileSync(file, "utf8"), "new");
  assert.deepEqual(readdirSync(dir), ["config.json"], "the temp file was left behind");
});
