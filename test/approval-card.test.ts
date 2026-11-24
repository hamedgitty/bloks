// An approval card reads as what the agent wants to do, never as the JSON
// it arrived in, and offers "Always allow" only as the rules can say it.
import { test } from "node:test";
import assert from "node:assert/strict";

import { readApproval, settledAs, splitChoices, tidyPath } from "../src/lib/approvalCard.ts";

const ada = { id: "a", name: "Ada" };
const card = (tool: string, subtitle: string, extra: Record<string, unknown> = {}) => ({
  title: "Approval needed",
  subtitle,
  tool,
  ...extra,
});

test("a Claude Code command is a command, with all three ways to remember it", () => {
  const view = readApproval(card("Bash", "pnpm test --filter api"), ada);
  assert.equal(view.verb, "wants to run a command");
  assert.deepEqual(view.detail, { kind: "command", text: "pnpm test --filter api" });
  assert.equal(view.short, "pnpm test --filter api");
  assert.deepEqual(
    view.scopes.map((s) => s.rule),
    [
      { effect: "allow", field: "command", op: "equals", value: "pnpm test --filter api", botId: "a" },
      { effect: "allow", field: "tool", op: "equals", value: "Bash", botId: "a" },
      { effect: "allow", field: "tool", op: "equals", value: "Bash" },
    ],
  );
  assert.equal(view.scopes[2].wide, true);
});

test("an edit sent as JSON becomes a file and a diff", () => {
  const view = readApproval(
    card("Edit", '{"file_path":"/Users/sam/app/src/a.ts","old_string":"x = 1","new_string":"x = 2","replace_all":false}'),
    ada,
  );
  assert.equal(view.verb, "wants to edit a file");
  assert.deepEqual(view.detail, { kind: "diff", path: "/Users/sam/app/src/a.ts", removed: "x = 1", added: "x = 2" });
  assert.equal(view.short, "a.ts");
  assert.equal(view.cut, false);
  // no exact-command rule for something that is not a command
  assert.deepEqual(view.scopes.map((s) => s.id), ["agent", "everyone"]);
});

test("JSON cut off at 200 characters keeps the fields that closed and says it was cut", () => {
  const summary = '{"owner":"sam","repo":"app","title":"Fix it","body":"A long body that goes on and on until the server stops sending it partway thr';
  const view = readApproval(card("mcp__github__create_issue", summary), ada);
  assert.equal(view.verb, "wants to use github");
  assert.equal(view.cut, true);
  assert.deepEqual(view.detail, {
    kind: "fields",
    name: "create_issue",
    fields: [
      ["owner", "sam"],
      ["repo", "app"],
      ["title", "Fix it"],
    ],
  });
});

test("a URL is a page to open", () => {
  const view = readApproval(card("WebFetch", "https://example.com/docs?a=1"), ada);
  assert.equal(view.verb, "wants to open a page");
  assert.deepEqual(view.detail, { kind: "url", url: "https://example.com/docs?a=1" });
});

test("an ACP title gives up the code in its backticks", () => {
  assert.deepEqual(readApproval(card("execute", "Run `ls -la`"), ada).detail, { kind: "command", text: "ls -la" });
  assert.deepEqual(readApproval(card("edit", "Edit `src/a.ts`"), ada).detail, { kind: "path", path: "src/a.ts" });
});

test("Antigravity's CommandLine and Path read as a command and a file, with the risky command warned about", () => {
  const run = readApproval(card("execute", '{"CommandLine":"rm -rf build","Cwd":"/Users/sam/app"}'), ada);
  assert.equal(run.verb, "wants to run a command");
  assert.deepEqual(run.detail, { kind: "command", text: "rm -rf build" });
  assert.ok(run.risk);
  assert.deepEqual(run.scopes, []);

  const read = readApproval(card("read", '{"Path":"/Users/sam/app/src/a.ts"}'), ada);
  assert.deepEqual(read.detail, { kind: "path", path: "/Users/sam/app/src/a.ts" });
  assert.equal(read.short, "a.ts");
  assert.deepEqual(readApproval(card("read", '{"AbsolutePath":"/tmp/b.ts"}'), ada).detail, { kind: "path", path: "/tmp/b.ts" });
  assert.deepEqual(readApproval(card("execute", '{"Command":"ls"}'), ada).detail, { kind: "command", text: "ls" });
  for (const key of ["FilePath", "TargetFile", "DirectoryPath"]) {
    assert.deepEqual(readApproval(card("read", JSON.stringify({ [key]: "/tmp/c" })), ada).detail, { kind: "path", path: "/tmp/c" }, key);
  }
  for (const key of ["Url", "Uri"]) {
    assert.deepEqual(readApproval(card("fetch", JSON.stringify({ [key]: "https://example.com/x" })), ada).detail, { kind: "url", url: "https://example.com/x" }, key);
  }
});

test("a reason is shown as a sentence, and a summary that is only the tool's name as nothing", () => {
  const reason = readApproval(card("shell", "Run the test suite to check the change."), ada);
  assert.deepEqual(reason.detail, { kind: "text", text: "Run the test suite to check the change." });
  const bare = readApproval(card("edit", "edit"), ada);
  assert.equal(bare.detail, undefined);
  assert.equal(bare.verb, "wants to make an edit");
});

test("only Claude Code's own command summary is trusted as the exact command", () => {
  // Codex may put a reason or a command here; a rule on it could match nothing
  const codex = readApproval(card("shell", "npm install"), ada);
  assert.deepEqual(codex.scopes.map((s) => s.id), ["agent", "everyone"]);
  // and a command the server cut at 200 is not the command
  const long = readApproval(card("Bash", "x".repeat(200)), ada);
  assert.equal(long.cut, true);
  assert.ok(!long.scopes.some((s) => s.id === "command"));
});

test("risky commands are said to be, and get no rule from the card", () => {
  for (const command of ["rm -rf build", "sudo make install", "git push --force origin main", "git reset --hard HEAD~1"]) {
    const view = readApproval(card("Bash", command), ada);
    assert.ok(view.risk, command);
    assert.deepEqual(view.scopes, [], command);
  }
  assert.ok(readApproval(card("delete", "Delete `old.txt`"), ada).risk);
  assert.equal(readApproval(card("Bash", "rm notes.txt"), ada).risk, undefined);
  assert.equal(readApproval(card("Bash", "git push origin main"), ada).risk, undefined);
});

test("nothing to remember for a question tool, or for someone else's ask", () => {
  assert.deepEqual(readApproval(card("AskUserQuestion", "Which one?"), ada).scopes, []);
  assert.deepEqual(readApproval(card("Bash", "ls", { askedFor: "p1" }), ada).scopes, []);
  const mail = readApproval(card("Bash", "ls (asked for by an email from x@y.z)"), ada);
  assert.equal(mail.askedBy, "an email from x@y.z");
  assert.deepEqual(mail.detail, { kind: "command", text: "ls" });
  assert.deepEqual(mail.scopes, []);
});

test("a card with no tool still reads", () => {
  const view = readApproval({ title: "Approval needed", subtitle: "Send the report" }, ada);
  assert.equal(view.verb, "needs your approval");
  assert.deepEqual(view.scopes, []);
});

test("answers settle as allowed or denied whichever words carried them", () => {
  for (const yes of ["Allow", "allow", "Allow once", "Always allow"]) assert.equal(settledAs(yes), "allowed", yes);
  for (const no of ["Deny", "deny", "Reject", "Dismissed by user."]) assert.equal(settledAs(no), "denied", no);
  assert.equal(settledAs("Closed without an answer"), "other");
});

test("an agent's own choices become a yes, a no and the rest in its words", () => {
  assert.deepEqual(splitChoices(["Allow", "Deny"]), { allow: "Allow", deny: "Deny", others: [] });
  assert.deepEqual(splitChoices(["Allow once", "Always allow", "Reject"]), {
    allow: "Allow once",
    deny: "Reject",
    others: ["Always allow"],
  });
});

test("a home folder is said as ~", () => {
  assert.equal(tidyPath("/Users/sam/app/a.ts"), "~/app/a.ts");
  assert.equal(tidyPath("/home/sam"), "~");
  assert.equal(tidyPath("/etc/hosts"), "/etc/hosts");
});
