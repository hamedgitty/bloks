// GitHub 523: a room topic's folder, held for Claude Code's own file
// tools by a PreToolUse hook (server/topic-folder-hook.ts). A write inside
// the folder, the agent's notes or the temp folder goes; one outside it is
// refused with the reason, through a link too; a tool that is not a file
// tool is not the hook's to judge. And the command Claude Code is handed
// runs as written, from a folder with a space and a quote in its name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { judgeWrite } from "../server/topic-folder-hook.ts";
import { topicFolderSettings } from "../server/drivers/claude.ts";

const root = mkdtempSync(join(tmpdir(), "bloks topic's folder "));
const folder = join(root, "src", "auth");
const notes = join(root, "notes");
mkdirSync(folder, { recursive: true });
mkdirSync(notes, { recursive: true });
mkdirSync(join(root, "elsewhere"), { recursive: true });
symlinkSync(join(root, "elsewhere"), join(folder, "out"));
test.after(() => rmSync(root, { recursive: true, force: true }));

const write = (path: string, cwd = root) => ({ tool_name: "Write", tool_input: { file_path: path, content: "x" }, cwd });

test("a write inside the folder or the agent's notes goes, one outside is refused", () => {
  assert.deepEqual(judgeWrite(write(join(folder, "login.ts")), [folder, notes]), { ok: true });
  assert.deepEqual(judgeWrite(write(join(folder, "new", "deep", "file.ts")), [folder, notes]), { ok: true });
  assert.deepEqual(judgeWrite(write(join(notes, "MEMORY.md")), [folder, notes]), { ok: true });
  assert.deepEqual(judgeWrite(write("src/auth/relative.ts"), [folder]), { ok: true });
  const out = judgeWrite(write(join(root, "README.md")), [folder, notes]);
  assert.equal(out.ok, false);
  assert.match((out as { reason: string }).reason, /go in .*src\/auth, and .*README\.md is outside it/);
  assert.equal(judgeWrite(write("../escape.ts", folder), [folder]).ok, false);
  assert.equal(judgeWrite(write(join(root, "src", "auth-other", "x.ts")), [folder]).ok, false, "a sibling that starts the same is not inside");
});

test("a link inside the folder that points out of it does not carry a write out", () => {
  assert.equal(judgeWrite(write(join(folder, "out", "file.ts")), [folder]).ok, false);
});

test("every file tool is held, and anything else is not this hook's to judge", () => {
  assert.equal(judgeWrite({ tool_name: "Edit", tool_input: { file_path: join(root, "a.ts") } }, [folder]).ok, false);
  assert.equal(judgeWrite({ tool_name: "MultiEdit", tool_input: { file_path: join(root, "a.ts") } }, [folder]).ok, false);
  assert.equal(judgeWrite({ tool_name: "NotebookEdit", tool_input: { notebook_path: join(root, "a.ipynb") } }, [folder]).ok, false);
  assert.equal(judgeWrite({ tool_name: "Write", tool_input: {} }, [folder]).ok, false, "a write that names no file is held");
  assert.deepEqual(judgeWrite({ tool_name: "Bash", tool_input: { command: "echo hi > /tmp/x" } }, [folder]), { ok: true });
  assert.deepEqual(judgeWrite({ tool_name: "Read", tool_input: { file_path: "/etc/hosts" } }, [folder]), { ok: true });
});

test("the hook Claude Code is handed runs as written and answers with its exit", { skip: process.platform === "win32" }, () => {
  const settings = JSON.parse(topicFolderSettings([folder, notes]));
  const entry = settings.hooks.PreToolUse[0];
  assert.equal(entry.matcher, "Write|Edit|MultiEdit|NotebookEdit");
  const run = (call: unknown) => spawnSync("/bin/sh", ["-c", entry.hooks[0].command], { input: JSON.stringify(call), encoding: "utf8" });
  const inside = run(write(join(folder, "ok.ts")));
  assert.equal(inside.status, 0, inside.stderr);
  const outside = run(write(join(root, "nope.ts")));
  assert.equal(outside.status, 2);
  assert.match(outside.stderr, /refused the Write/);
  const garbled = spawnSync("/bin/sh", ["-c", entry.hooks[0].command], { input: "not json", encoding: "utf8" });
  assert.equal(garbled.status, 2, "a call it cannot read is held");
});
