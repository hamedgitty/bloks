// Saving a file whole (server/atomic-write.ts).
//
// Several stores used to save with a plain writeFileSync, which empties
// the file before writing it. A crash or a full disk in between left a
// file cut short, and config.json, with every key in it, went the same
// way.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeFileAtomic } from "../server/atomic-write.ts";

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
