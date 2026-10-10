// What the Backups page says (src/lib/backups.ts), held to what the
// server does (server/backup.ts).
//
// The restore confirmation is the sentence somebody reads before their
// whole workspace is replaced. Each line of it is a promise the server
// keeps, so each is checked here against the backup it describes.
import { test } from "node:test";
import assert from "node:assert/strict";

import { asideFolder, backupDetails, kindLabel, passphraseProblem, restoreLine, restoreSteps, sizeText, type BackupItem } from "../src/lib/backups.ts";

const plain: BackupItem = {
  name: "bloks-backup-2026-10-10-083005-v2.6.0.tar.gz",
  path: "/Users/me/.bloks-backups/bloks-backup-2026-10-10-083005-v2.6.0.tar.gz",
  size: 12_400_000,
  created: Date.UTC(2026, 9, 10, 12, 30),
  kind: "manual",
  version: "2.6.0",
  undo: false,
  secrets: false,
  encrypted: false,
};

test("a restore says what happens in order, and where the workspace it replaces goes", () => {
  const { steps } = restoreSteps(plain, "/Users/me/.bloks-backups");
  assert.equal(steps.length, 5);
  assert.match(steps[0], /finish first/, "it must say running work finishes before anything");
  assert.match(steps[1], /backed up as it is now/);
  assert.match(steps[2], /checked before anything changes/);
  assert.equal(steps[3], "Your current workspace is moved aside to /Users/me/.bloks.before-restore-…, not deleted.");
  assert.match(steps[4], /restarts/);
  assert.equal(asideFolder("C:\\Users\\me\\.bloks-backups"), "C:\\Users\\me\\.bloks.before-restore-…");
});

test("the keys sentence matches the backup: kept without keys, replaced with them", () => {
  assert.match(restoreSteps(plain, "/x/.bloks-backups").notes[0], /no saved keys, so the keys on this computer stay/);
  const withKeys = { ...plain, encrypted: true, secrets: true, undo: true };
  const { notes } = restoreSteps(withKeys, "/x/.bloks-backups");
  assert.match(notes[0], /its own saved keys, and they replace/);
  assert.equal(notes.length, 1, "a backup with Undo history must not warn that undo is lost");
  assert.match(restoreSteps(plain, "/x/.bloks-backups").notes[1], /no Undo history/);
});

test("each step of a restore under way reads as a sentence, and a stop says nothing changed once", () => {
  const now = 1_000_000;
  assert.equal(restoreLine({ phase: "draining", from: "x", running: 2, deadline: now + 4.5 * 60_000 }, now), "Waiting for 2 running turns to finish, up to 5 more minutes…");
  assert.equal(restoreLine({ phase: "draining", from: "x", running: 1, deadline: now + 30_000 }, now), "Waiting for 1 running turn to finish, up to 1 more minute…");
  assert.equal(restoreLine({ phase: "draining", from: "x", running: 0 }, now), "Getting ready to restore…");
  assert.match(restoreLine({ phase: "staging", from: "x" }), /checking every file/);
  assert.equal(
    restoreLine({ phase: "failed", from: "x", error: "That passphrase does not open this backup." }),
    "The restore stopped. That passphrase does not open this backup. Nothing was changed.",
  );
  assert.equal(
    restoreLine({ phase: "failed", from: "x", error: "This backup did not check out, so nothing was changed: a.json is missing." }),
    "The restore stopped. This backup did not check out, so nothing was changed: a.json is missing.",
  );
});

test("a backup's line says what made it and what is inside", () => {
  assert.equal(backupDetails(plain), "Bloks 2.6.0 · 12.4 MB");
  assert.equal(backupDetails({ ...plain, encrypted: true, secrets: true, undo: true, size: 2_100_000_000 }), "Bloks 2.6.0 · 2.1 GB · sealed · with Undo history · with saved keys");
  assert.match(backupDetails({ ...plain, damaged: true, size: 300 }), /^1 KB · cannot be read/);
  assert.equal(sizeText(512_000), "512 KB");
  assert.equal(kindLabel("automatic"), "Automatic");
  assert.equal(kindLabel("before-restore"), "Before a restore");
  assert.equal(kindLabel("manual"), null);
});

test("a passphrase is long enough and typed the same twice before a backup is sealed", () => {
  assert.match(passphraseProblem("short", "short") ?? "", /at least 8/);
  assert.match(passphraseProblem("long enough", "long enougj") ?? "", /differ/);
  assert.equal(passphraseProblem("long enough", "long enough"), null);
});
