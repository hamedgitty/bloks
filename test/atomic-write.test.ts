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

import { readSaved, writeFileAtomic } from "../server/atomic-write.ts";

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
  assert.deepEqual(readSaved(file, [], Array.isArray), []);
  const aside = join(dir, readdirSync(dir)[0]);
  assert.ok(aside, "the unreadable file was kept");
  assert.match(aside!, /jobs\.json\.corrupt-[\dT-]+Z-[\da-f-]+$/);
  assert.equal(readFileSync(aside!, "utf8"), '[{"id":"j1","title":"Wri');
  assert.deepEqual(readdirSync(dir), [aside!.slice(dir.length + 1)]);

  // A first run has no file at all, and that is not worth a copy or a word.
  assert.deepEqual(readSaved(join(dir, "none.json"), [], Array.isArray), []);
  assert.deepEqual(readdirSync(dir).length, 1);
});

test("a file that could not be read this once refuses empty state and can be retried", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "bloks-aside-io-"));
  try {
    const file = join(dir, "messages-x.json");
    writeFileSync(file, '[{"id":"m1"}]');
    // too many open files, say: the file itself may be fine
    const real = fs.readFileSync;
    t.mock.method(fs, "readFileSync", (path: any, ...args: any[]) => {
      if (path === file) throw Object.assign(new Error("planted-secret"), { code: "EMFILE" });
      return (real as any)(path, ...args);
    });
    syncBuiltinESMExports();
    t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
    assert.throws(() => readSaved(file, [], Array.isArray), /EMFILE.*Make sure it is a file Bloks can read and write/);
    t.mock.restoreAll();
    syncBuiltinESMExports();
    assert.equal(readFileSync(file, "utf8"), '[{"id":"m1"}]');
    // a file that is there and is not JSON is the one that moves
    writeFileSync(file, '[{"id":');
    assert.deepEqual(readSaved(file, [], Array.isArray), []);
    assert.equal(readdirSync(dir).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a refused preservation never returns empty or quotes the invalid text", (t) => {
  const dir = scratch(t);
  const file = join(dir, "config.json");
  const text = '{"key":planted-secret}';
  writeFileSync(file, text, { mode: 0o600 });
  t.mock.method(fs, "renameSync", () => {
    throw Object.assign(new Error("planted-secret in the filesystem error"), { code: "EACCES" });
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  assert.throws(() => readSaved(file, {}, (value) => Boolean(value)), (error: any) => {
    assert.match(error.message, /config\.json \(EACCES\).*Make sure it is a file Bloks can read and write/);
    assert.doesNotMatch(String(error.stack), /planted-secret/);
    assert.equal(error.cause, undefined);
    return true;
  });
  assert.equal(readFileSync(file, "utf8"), text);
  assert.deepEqual(readdirSync(dir), ["config.json"]);
});

test("a rejected top level or decoder preserves the original bytes and permissions", (t) => {
  const dir = scratch(t);
  for (const [name, text, decode] of [
    ["array.json", "{}", JSON.parse],
    ["key.pem", "planted-secret", () => { throw new Error("planted-secret"); }],
  ] as const) {
    const file = join(dir, name);
    writeFileSync(file, text, { mode: 0o600 });
    const warn = t.mock.method(console, "warn", () => {});
    assert.deepEqual(readSaved(file, [], Array.isArray, decode), []);
    const aside = readdirSync(dir).find((f) => f.startsWith(name + ".corrupt-"));
    assert.ok(aside);
    assert.equal(readFileSync(join(dir, aside), "utf8"), text);
    if (process.platform !== "win32") assert.equal(statSync(join(dir, aside)).mode & 0o777, 0o600);
    assert.doesNotMatch(warn.mock.calls.map((c) => c.arguments.join(" ")).join("\n"), /planted-secret/);
    t.mock.restoreAll();
  }
});

test("two invalid versions kept at the same timestamp preserve both originals", (t) => {
  const dir = scratch(t);
  const file = join(dir, "config.json");
  t.mock.method(Date.prototype, "toISOString", () => "2026-01-01T00:00:00.000Z");
  t.mock.method(console, "warn", () => {});
  for (const text of ["first invalid version", "second invalid version"]) {
    writeFileSync(file, text);
    assert.deepEqual(readSaved(file, {}, () => true), {});
  }
  const copies = readdirSync(dir).map((name) => readFileSync(join(dir, name), "utf8")).sort();
  assert.deepEqual(copies, ["first invalid version", "second invalid version"]);
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
