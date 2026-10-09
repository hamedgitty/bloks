// Claude Code's one-shot answers (summaries, names) carry the
// conversation itself, so they go in on stdin rather than the command
// line, and a key in the environment does not bill them to the API.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ClaudeDriver } from "../server/drivers/claude.ts";

test("a one-shot prompt goes over stdin, and no API key goes with it", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "bloks-oneshot-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const seen = join(dir, "seen.json");
  const cli = join(dir, "fake-claude.mjs");
  writeFileSync(
    cli,
    `#!${process.execPath}
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("9.9.9 (Claude Code)"); process.exit(0); }
let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ args, input, key: process.env.ANTHROPIC_API_KEY ?? null }));
  console.log("A short summary.");
});
`,
    { mode: 0o755 },
  );
  const before = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "sk-ant-should-not-travel";
  t.after(() => {
    if (before === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = before;
  });
  const instance = await ClaudeDriver.create({
    instanceId: "claude", displayName: "Claude", enabled: true, environment: {},
    config: { cli, permissionMode: "acceptEdits" } as any,
  });
  t.after(() => instance.dispose());

  const said = await instance.generateText!("SECRET-CONVERSATION about the launch");
  assert.equal(said, "A short summary.");
  const { args, input, key } = JSON.parse(readFileSync(seen, "utf8"));
  assert.ok(!args.some((a: string) => a.includes("SECRET-CONVERSATION")), "the prompt was on the command line");
  assert.equal(input, "SECRET-CONVERSATION about the launch");
  assert.equal(key, null, "the API key reached the one-shot call");
});
