import assert from "node:assert/strict";
import { test } from "node:test";
import { agentCommands, engineCommand } from "../server/agent-commands.ts";
import { codexSkillNames, readCodexSkills } from "../server/codex-skills.ts";
import { insert, segments } from "../src/lib/slashCommands.ts";

const row = (name: string, extra = {}) => ({ name, description: "Long description", enabled: true, path: `/PRIVATE/${name}/SKILL.md`, ...extra });
const list = (skills: unknown[], cwd = "/repo") => ({ data: [{ cwd, skills, errors: [] }] });

test("Codex dollar names use the native ASCII mention alphabet and safe token boundaries", () => {
  assert.deepEqual(codexSkillNames(["$one. ($two, [$plug:review] {$a_b} '$a-3' <\"$last\">", "$one $ONE"]), ["one", "two", "plug:review", "a_b", "a-3", "last", "ONE"]);
  assert.deepEqual(codexSkillNames(["$$x a$x \\$x $HOME $home $PATH $5 $500,000 ordinary"]), []);
  assert.deepEqual(codexSkillNames(["$one $one $one", "$two"]), ["one", "two"]);
  assert.deepEqual(codexSkillNames(["«$one», “$two”"]), ["one", "two"]);
  assert.equal(codexSkillNames([Array.from({ length: 200 }, (_, i) => `$skill-${i}`).join(" ")]).length, 128);
});

test("folder-scoped enabled skills retain only invocation fields and first enabled duplicate", () => {
  const skills = readCodexSkills(list([
    row("same", { enabled: false }), row("same", { scope: "repo", interface: { shortDescription: "Short\nline", iconSmall: "/PRIVATE/icon" }, dependencies: { tools: ["PRIVATE_TOOL"] } }), row("same", { path: "/PRIVATE/other/SKILL.md" }),
    ...["user", "system", "admin"].map((scope) => row("from-" + scope, { scope })), row("plug:review", { pluginId: "plugin", shortDescription: "Plugin" }),
  ]), "/repo")!;
  assert.equal(skills.length, 5);
  assert.deepEqual(skills[0], { name: "same", description: "Short line", path: "/PRIVATE/same/SKILL.md" });
  assert.doesNotMatch(JSON.stringify(skills), /PRIVATE_TOOL|iconSmall|pluginId|"scope":/);
  assert.equal(readCodexSkills(list([row("x")], "/elsewhere"), "/repo"), null);
  assert.equal(readCodexSkills({ data: [list([]).data[0], list([]).data[0]] }, "/repo"), null);
});

test("malformed, hostile and oversized rows cannot introduce a path or an unbounded catalog", () => {
  assert.deepEqual(readCodexSkills(list([null, row("bad/name"), row("bad name"), row("bad.name"), row("HOME"), row("5"), row("x", { path: "relative/SKILL.md" }), row("y", { path: "/path/other.txt" }), row("z", { path: "/bad\0/SKILL.md" }), row("q", { description: 123 }), row("off", { enabled: false })]), "/repo"), []);
  assert.equal(readCodexSkills(list(Array.from({ length: 2049 }, () => row("a"))), "/repo"), null);
  assert.equal(readCodexSkills(list([row("a", { description: "x".repeat(1024 * 1024) })]), "/repo"), null);
  assert.equal(readCodexSkills(list([row("a", { name: "x".repeat(129) })]), "/repo")?.length, 0);
  assert.equal(readCodexSkills(list([row("a", { path: "/" + "x".repeat(4096) + "/SKILL.md" })]), "/repo")?.length, 0);
  assert.equal(readCodexSkills(list([row("a", { description: "x".repeat(400) })]), "/repo")?.[0].description.length, 300);
});

test("Codex menu offers only compact and native skills, with library collisions preserved and paths absent", () => {
  const library = [{ id: "compact", name: "Shadow", description: "Library" }, { id: "same", name: "Library same", description: "Library" }];
  const commands = agentCommands({ library, onClaudeCode: false, onCodex: true, codexSkills: readCodexSkills(list([row("compact"), row("same"), row("plug:review")]), "/repo")! });
  assert.deepEqual(commands.filter((c) => c.kind === "command").map((c) => c.id), ["compact"]);
  assert.equal(commands.find((c) => c.id === "same")?.source, "library");
  assert.equal(commands.find((c) => c.id === "plug:review")?.prefix, "$");
  assert.doesNotMatch(JSON.stringify(commands), /PRIVATE|path|dependencies/);
  assert.deepEqual(agentCommands({ library, onClaudeCode: false }), library.map((s) => ({ ...s, source: "library", kind: "skill" })));
});

test("a selected Codex skill inserts and highlights its dollar name while slash behavior stays intact", () => {
  assert.deepEqual(insert("please /rev", 7, 11, "plug:review", "$"), { text: "please $plug:review ", caret: 20 });
  const text = "(/compact) ($plug:review), $$plug:review a$plug:review \\$plug:review /library";
  const runs = segments(text, new Set(["compact", "library"]), new Set(["plug:review"]));
  assert.equal(runs.map((r) => r.text).join(""), text);
  assert.deepEqual(runs.filter((r) => r.skill).map((r) => r.text), ["$plug:review", "/library"]);
});

test("native command detection preserves Claude and limits Codex to bare compact", () => {
  for (const words of ["/compact", "/compact \t\r\n"]) assert.equal(engineCommand(words, "codex"), "compact");
  for (const words of ["/compact keep notes", "/compact exact args\nmore", "/compact\nkeep notes", " /compact", "please /compact", "/compact,", "/context", "/usage", "/recap", "/login"]) assert.equal(engineCommand(words, "codex"), null);
  assert.equal(engineCommand("/compact exact args\nmore", "claudeAgent"), "compact");
  assert.equal(engineCommand("/context", "claudeAgent"), "context");
  assert.equal(engineCommand("/compact", "other"), null);
});
