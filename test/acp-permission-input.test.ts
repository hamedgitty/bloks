// What an ACP agent's permission request is about, for the rules. Without
// it, a rule about a command or a path could never match an ACP agent.
import { test } from "node:test";
import assert from "node:assert/strict";

import { permissionInput } from "../server/drivers/acp.ts";

test("a call's command and every file it names reach the rules", () => {
  assert.deepEqual(permissionInput({ kind: "execute", rawInput: { command: "rm -rf build", timeout: 30 } }), { command: "rm -rf build" });
  assert.deepEqual(
    permissionInput({
      kind: "edit",
      locations: [{ path: "/w/a.ts" }, { path: "/w/a.ts" }],
      content: [{ type: "diff", path: "/w/.env", oldText: "", newText: "SECRET=1" }],
    }),
    { paths: ["/w/a.ts", "/w/.env"] },
  );
});

test("only the fields a rule reads go with it, never a file's contents", () => {
  const input = permissionInput({ kind: "edit", rawInput: { file_path: "/w/big.txt", content: "x".repeat(100_000) } });
  assert.deepEqual(input, { file_path: "/w/big.txt" });
});

test("a long command reaches the rules whole, so padding cannot hide its end", () => {
  const padded = `echo ${"x".repeat(5_000)}; git push --force`;
  assert.equal(permissionInput({ kind: "execute", rawInput: { command: padded } }).command, padded);
});

test("a command given as its argv is read as one line", () => {
  assert.deepEqual(permissionInput({ kind: "execute", rawInput: { command: ["git", "push", "--force"] } }), { command: "git push --force" });
});
