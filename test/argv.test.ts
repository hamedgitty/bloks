// Arguments, including the paths that broke the old split.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { splitArgs } from "../server/argv.ts";

describe("splitArgs", () => {
  test("plain arguments split on whitespace", () => {
    assert.deepEqual(splitArgs("run --flag value"), ["run", "--flag", "value"]);
    assert.deepEqual(splitArgs("  spaced   out  "), ["spaced", "out"]);
    assert.deepEqual(splitArgs(""), []);
  });

  test("a quoted path with a space stays one argument", () => {
    assert.deepEqual(splitArgs('"/Users/me/Application Support/thing.mjs"'), [
      "/Users/me/Application Support/thing.mjs",
    ]);
    assert.deepEqual(splitArgs("'/Users/me/My Files/x.mjs' --once"), [
      "/Users/me/My Files/x.mjs",
      "--once",
    ]);
  });

  test("a backslash-escaped space stays one argument", () => {
    assert.deepEqual(splitArgs("/Users/me/My\\ Files/x.mjs"), ["/Users/me/My Files/x.mjs"]);
  });

  test("quotes group without needing to wrap the whole argument", () => {
    assert.deepEqual(splitArgs('--dir=/a" "b'), ["--dir=/a b"]);
  });

  test("single quotes are literal inside", () => {
    assert.deepEqual(splitArgs(`'a "b" \\c'`), ['a "b" \\c']);
  });

  test("an empty quoted string is still an argument", () => {
    assert.deepEqual(splitArgs('a "" b'), ["a", "", "b"]);
  });

  test("an unterminated quote closes at the end rather than refusing", () => {
    assert.deepEqual(splitArgs('--name "half open'), ["--name", "half open"]);
  });

  test("a windows path keeps its separators", () => {
    assert.deepEqual(splitArgs('"C:\\Program Files\\thing\\run.exe" --go'), [
      "C:\\Program Files\\thing\\run.exe",
      "--go",
    ]);
  });
});

// The route the settings screen actually uses.
test("a command line with a spaced path registers as one command and one arg", async () => {
  const { splitArgs: split } = await import("../server/argv.ts");
  const parts = split('node "/Users/me/Application Support/mcp/server.mjs" --stdio');
  assert.deepEqual(parts, [
    "node",
    "/Users/me/Application Support/mcp/server.mjs",
    "--stdio",
  ]);
  assert.equal(parts[0], "node", "the binary is the first token");
});
