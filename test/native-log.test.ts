// GitHub 157: Codex answers thread/resume with the whole conversation so
// far and a lane resumes on every turn, so the untranslated copy grew by
// the full history each time. The copy keeps a count of the turns instead,
// and copies written before that are slimmed once.
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { slimFrame, slimNativeLogs } from "../server/drivers/native.ts";

const turns = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `turn-${i}`, items: [{ type: "userMessage", text: "x".repeat(200) }] }));
const resumed = (n: number) => ({ id: 7, result: { thread: { id: "thr_1", preview: "hello", turns: turns(n) }, model: "gpt-6" } });
const usage = { method: "thread/tokenUsage/updated", params: { threadId: "thr_1", tokenUsage: { total: { inputTokens: 1200, cachedInputTokens: 900 } } } };
const line = (msg: unknown) => JSON.stringify({ at: "2026-10-05T12:00:00.000Z", dir: "in", source: "codex.app-server", msg });

test("a thread handed back whole is kept as a count, and nothing else changes", () => {
  const frame = resumed(3);
  const slim = slimFrame(frame) as any;
  assert.equal(slim.result.thread.turnCount, 3);
  assert.equal(slim.result.thread.turns, undefined);
  assert.equal(slim.result.thread.id, "thr_1", "the rest of the thread stays");
  assert.equal(slim.result.model, "gpt-6", "the rest of the result stays");
  assert.equal(slim.id, 7);
  assert.equal(frame.result.thread.turns.length, 3, "the driver's own frame is never touched");
  // token usage, which people read the copy for, comes through as it is
  assert.equal(slimFrame(usage), usage);
  assert.equal(slimFrame(null), null);
  assert.equal(slimFrame("text"), "text");
});

test("copies from before are slimmed once, line by line, and the rest is left as it was", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "bloks-native-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const codex = join(dir, "lane-codex.ndjson");
  const claude = join(dir, "lane-claude.ndjson");
  writeFileSync(codex, [line(usage), line(resumed(40)), line(usage), line(resumed(41)), "not json at all"].join("\n") + "\n");
  writeFileSync(claude, [line({ type: "assistant", text: "hi" })].join("\n") + "\n");
  const claudeBefore = statSync(claude).mtimeMs;
  const sizeBefore = statSync(codex).size;

  const first = await slimNativeLogs(dir);
  assert.equal(first.files, 1);
  assert.ok(first.saved > 0);
  assert.ok(statSync(codex).size < sizeBefore / 5, "the repeated history is gone");

  const lines = readFileSync(codex, "utf8").trimEnd().split("\n");
  assert.equal(lines.length, 5, "every line is still there");
  assert.equal(lines[0], line(usage), "a line without a thread is byte for byte the same");
  assert.equal(lines[2], line(usage));
  assert.equal(lines[4], "not json at all");
  assert.equal(JSON.parse(lines[1]).msg.result.thread.turnCount, 40);
  assert.equal(JSON.parse(lines[3]).msg.result.thread.turnCount, 41);
  assert.equal(JSON.parse(lines[1]).at, "2026-10-05T12:00:00.000Z");
  assert.equal(statSync(claude).mtimeMs, claudeBefore, "a copy with no thread in it is not rewritten");
  assert.ok(!existsSync(`${codex}.slimming`));

  // once per data folder
  appendFileSync(codex, line(resumed(42)) + "\n");
  const second = await slimNativeLogs(dir);
  assert.equal(second.files, 0, "the pass does not run again");
});

test("a copy written to while it is read is left whole, and slimmed next time", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "bloks-native-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const codex = join(dir, "lane.ndjson");
  writeFileSync(codex, line(resumed(30)) + "\n");

  const running = slimNativeLogs(dir);
  // the turn that is running right now appends while the pass reads
  appendFileSync(codex, line(usage) + "\n");
  const first = await running;
  assert.equal(first.files, 0, "not swapped over a line it never read");
  const kept = readFileSync(codex, "utf8").trimEnd().split("\n");
  assert.equal(kept.length, 2);
  assert.equal(kept[1], line(usage), "the appended line survives");
  assert.ok(!existsSync(join(dir, ".slimmed-1")), "and the pass is not marked done");

  const second = await slimNativeLogs(dir);
  assert.equal(second.files, 1);
  const slim = readFileSync(codex, "utf8").trimEnd().split("\n");
  assert.equal(JSON.parse(slim[0]).msg.result.thread.turnCount, 30);
  assert.equal(slim[1], line(usage));
});
