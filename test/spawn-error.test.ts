// What the user reads when a turn could not start.
//
// This is the first thing a new install shows if no engine is set up, so
// it has to be a sentence with a next step in it, not an errno.
import { test } from "node:test";
import assert from "node:assert/strict";

import { describeEarlyExit, describeSpawnError } from "../server/drivers/spawn-error.ts";

const enoent = Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" });
const ctx = {
  name: "Claude Code",
  command: "claude",
  install: "npm i -g @anthropic-ai/claude-code",
  signIn: "run `claude` once to sign in",
};

test("a missing engine says so, and says what to run", () => {
  const message = describeSpawnError(enoent, ctx);
  assert.ok(message.includes("Claude Code is not installed"));
  assert.ok(message.includes("npm i -g @anthropic-ai/claude-code"));
  assert.ok(message.includes("Settings"), "the other way out should be offered too");
});

test("the errno never reaches the user", () => {
  const message = describeSpawnError(enoent, ctx);
  assert.ok(!message.includes("ENOENT"), message);
  assert.ok(!message.includes("spawn claude"), message);
});

test("an engine with no installer still gets a readable sentence", () => {
  const message = describeSpawnError(enoent, { name: "Some Agent", command: "some-agent" });
  assert.ok(message.startsWith("Some Agent is not installed"));
  assert.ok(!message.includes("undefined"));
});

test("a permissions failure is not reported as missing", () => {
  const message = describeSpawnError(
    Object.assign(new Error("spawn EACCES"), { code: "EACCES" }),
    ctx,
  );
  assert.ok(message.includes("not runnable"));
  assert.ok(!message.includes("not installed"), "wrong diagnosis sends people to the wrong fix");
});

test("an unknown failure keeps its detail rather than swallowing it", () => {
  const message = describeSpawnError(new Error("something odd happened"), ctx);
  assert.ok(message.includes("Claude Code could not start"));
  assert.ok(message.includes("something odd happened"));
});

test("a non-Error is handled too", () => {
  assert.ok(describeSpawnError("just a string", ctx).includes("just a string"));
  assert.ok(describeSpawnError(null, ctx).includes("could not start"));
});

test("an auth failure on exit is named as one", () => {
  const message = describeEarlyExit(1, "Error: Not logged in. Run `claude` to authenticate.", {
    name: "Claude Code",
    signIn: "run `claude` once in a terminal",
  });
  assert.ok(message.includes("not signed in"));
  assert.ok(message.includes("run `claude` once in a terminal"));
});

test("a silent early exit still says something useful", () => {
  const message = describeEarlyExit(3, "", { name: "Codex" });
  assert.ok(message.includes("Codex"));
  assert.ok(message.includes("3"));
  assert.ok(message.includes("said nothing"));
});

test("only the tail of a noisy stderr is quoted", () => {
  const noisy = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
  const message = describeEarlyExit(1, noisy, { name: "Codex" });
  assert.ok(message.length < 400, `message was ${message.length} chars`);
  assert.ok(message.includes("line 199"), "the last lines are the ones that matter");
});
