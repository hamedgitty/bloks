import assert from "node:assert/strict";
import { test } from "node:test";
import { createTranscriptWidth, transcriptWidth, TRANSCRIPT_WIDTH_KEY, TRANSCRIPT_WIDTHS } from "../src/lib/transcriptWidth.ts";

test("unknown stored choices use Narrow and never become CSS", () => {
  for (const value of [undefined, null, "", "garbage", "WIDE", "<img src=x onerror=alert(1)>", "var(--bad)", "999999px", "url(https://example.com)", 960, [], {}]) {
    assert.equal(transcriptWidth(value), "narrow");
    const applied: string[] = [];
    const choice = createTranscriptWidth({ getItem: () => value as string, setItem() {} }, (css) => applied.push(css));
    assert.equal(choice.get(), "narrow");
    assert.deepEqual(applied, ["760px"]);
  }
});

test("the three reading choices have their measured literal caps", () => {
  for (const [value, pixels] of [["narrow", "760px"], ["medium", "800px"], ["wide", "960px"]]) {
    const applied: string[] = [];
    let saved: [string, string] | undefined;
    const choice = createTranscriptWidth({ getItem: () => value, setItem: (key, next) => { saved = [key, next]; } }, (css) => applied.push(css));
    assert.equal(choice.get(), value);
    choice.set(value);
    assert.deepEqual(saved, [TRANSCRIPT_WIDTH_KEY, value]);
    assert.deepEqual(applied, [pixels, pixels]);
  }
  assert.deepEqual(TRANSCRIPT_WIDTHS, { narrow: "760px", medium: "800px", wide: "960px" });
});

test("an unreadable store falls back and still permits a session choice", () => {
  const applied: string[] = [];
  const choice = createTranscriptWidth({ getItem() { throw new Error("blocked"); }, setItem() {} }, (css) => applied.push(css));
  assert.equal(choice.get(), "narrow");
  choice.set("wide");
  assert.equal(choice.get(), "wide");
  assert.deepEqual(applied, ["760px", "960px"]);
});

test("a failed write and later sync preserve the current window's choice", () => {
  const applied: string[] = [];
  let stored = "narrow", fail = true;
  const choice = createTranscriptWidth({ getItem: () => stored, setItem(_key, value) { if (fail) throw new Error("full"); stored = value; } }, (css) => applied.push(css));
  choice.set("wide");
  choice.sync();
  assert.equal(stored, "narrow");
  assert.equal(choice.get(), "wide");
  assert.deepEqual(applied, ["760px", "960px", "960px"]);
  fail = false;
  choice.set("medium");
  stored = "narrow";
  choice.sync();
  assert.equal(choice.get(), "narrow");
  assert.deepEqual(applied.slice(-2), ["800px", "760px"]);
});

test("sync and invalid setters apply only literal caps", () => {
  const applied: string[] = [];
  let stored = "wide";
  const choice = createTranscriptWidth({ getItem: () => stored, setItem(_key, value) { stored = value; } }, (css) => applied.push(css));
  stored = "<style>bad</style>";
  choice.sync();
  choice.set("900px; color:red");
  assert.deepEqual(applied, ["960px", "760px", "760px"]);
  assert.equal(stored, "narrow");
});
