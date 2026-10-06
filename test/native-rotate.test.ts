// GitHub 159: a lane's untranslated copy only ever grew, to 9.4 GB for one
// lane on one machine. Past a size the file is moved aside and gzipped,
// and a lane keeps only its newest few.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";

import {
  NATIVE_CAP,
  NATIVE_KEPT,
  appendNative,
  forgetNative,
  nativeSettled,
  rotateNative,
  tidyNativeLogs,
} from "../server/drivers/native.ts";

const home = (t: { after: (fn: () => void) => void }) => {
  const dir = mkdtempSync(join(tmpdir(), "bloks-native-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const archived = (dir: string) => (existsSync(join(dir, "archive")) ? readdirSync(join(dir, "archive")).sort() : []);
const unzip = (path: string) => gunzipSync(readFileSync(path)).toString("utf8").trimEnd().split("\n");
const frame = (n: number) => ({ dir: "in" as const, source: "codex.app-server", msg: { id: n } });
// a copy exactly `short` bytes under the cap, in whole lines
const nearlyFull = (path: string, short: number) => {
  const line = JSON.stringify({ at: "2026-10-05T12:00:00.000Z", dir: "in", source: "x", msg: "y".repeat(900) }) + "\n";
  const count = Math.floor((NATIVE_CAP - short - 1000) / line.length);
  const rest = NATIVE_CAP - short - count * line.length;
  const filler = JSON.stringify({ msg: "y".repeat(rest - 1 - JSON.stringify({ msg: "" }).length) }) + "\n";
  writeFileSync(path, line.repeat(count) + filler);
  return count + 1;
};

test("crossing the cap moves the file aside whole, and the lane keeps writing", async (t) => {
  const dir = home(t);
  const live = join(dir, "lane.ndjson");
  const before = nearlyFull(live, 100);

  // under the cap, then over it: the line that crosses stays with the old
  // file, and the one after starts the new one
  appendNative("lane", { ...frame(1), msg: { pad: "z".repeat(400) } }, dir);
  assert.ok(!existsSync(join(dir, "archive")), "nothing moves until the cap is passed");
  appendNative("lane", frame(2), dir);
  appendNative("lane", frame(3), dir);
  await nativeSettled();

  const kept = readFileSync(live, "utf8").trimEnd().split("\n");
  assert.deepEqual(kept.map((l) => JSON.parse(l).msg.id), [2, 3]);
  const names = archived(dir);
  assert.equal(names.length, 1);
  assert.match(names[0], /^lane\.\d{8}T\d{9}Z\.ndjson\.gz$/, "only the gzip is left, no plain copy");
  const lines = unzip(join(dir, "archive", names[0]));
  assert.equal(lines.length, before + 1, "every line made it into the gzip");
  for (const line of lines) JSON.parse(line);
});

test("a copy that was already too big moves on its lane's first append", async (t) => {
  const dir = home(t);
  const live = join(dir, "old.ndjson");
  writeFileSync(live, "x".repeat(NATIVE_CAP + 10));
  appendNative("old", frame(1), dir);
  await nativeSettled();
  assert.equal(readFileSync(live, "utf8").trimEnd().split("\n").length, 1);
  assert.equal(archived(dir).length, 1);
});

test(`a lane keeps its newest ${NATIVE_KEPT} gzipped copies`, async (t) => {
  const dir = home(t);
  for (let i = 0; i < NATIVE_KEPT + 2; i++) {
    writeFileSync(join(dir, "lane.ndjson"), `round ${i}\n`);
    await rotateNative("lane", dir);
  }
  writeFileSync(join(dir, "other.ndjson"), "other\n");
  await rotateNative("other", dir);

  const mine = archived(dir).filter((name) => name.startsWith("lane."));
  assert.equal(mine.length, NATIVE_KEPT);
  assert.deepEqual(
    mine.map((name) => unzip(join(dir, "archive", name))[0]),
    ["round 2", "round 3", "round 4"],
    "the oldest go first",
  );
  assert.equal(archived(dir).filter((name) => name.startsWith("other.")).length, 1, "another lane's are its own");
});

test("deleting the agent takes the gzipped copies too", async (t) => {
  const dir = home(t);
  writeFileSync(join(dir, "lane.ndjson"), "one\n");
  await rotateNative("lane", dir);
  appendNative("lane", frame(1), dir);
  writeFileSync(join(dir, "keep.ndjson"), "two\n");
  await rotateNative("keep", dir);

  forgetNative("lane", dir);
  assert.ok(!existsSync(join(dir, "lane.ndjson")));
  assert.deepEqual(archived(dir).filter((name) => name.startsWith("lane.")), []);
  assert.equal(archived(dir).length, 1, "other lanes are left alone");
});

test("a gzip a crash cut short is redone on the next start", async (t) => {
  const dir = home(t);
  const archive = join(dir, "archive");
  mkdirSync(archive);
  // moved aside, then the app quit mid-gzip
  writeFileSync(join(archive, "lane.20261005T120000000Z.ndjson"), "a\nb\n");
  writeFileSync(join(archive, "lane.20261005T120000000Z.ndjson.gz.partial"), "half");
  // gzipped, then the app quit before the plain copy was deleted
  writeFileSync(join(archive, "lane.20261004T120000000Z.ndjson"), "c\n");
  writeFileSync(join(archive, "lane.20261004T120000000Z.ndjson.gz"), Buffer.from([]));
  // a lane too big that nobody has written to since
  writeFileSync(join(dir, "idle.ndjson"), "x".repeat(NATIVE_CAP));

  const { rotated } = await tidyNativeLogs(dir);
  assert.equal(rotated, 1);
  const names = archived(dir);
  assert.deepEqual(names.filter((name) => !name.endsWith(".gz")), [], "no plain or half-written copies left");
  assert.deepEqual(unzip(join(archive, "lane.20261005T120000000Z.ndjson.gz")), ["a", "b"]);
  assert.equal(names.filter((name) => name.startsWith("idle.")).length, 1);
  assert.ok(!existsSync(join(dir, "idle.ndjson")));
});
