// The composer's `/` list (#51).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { insert, matches, segments, slashAt, type Command } from "../src/lib/slashCommands.ts";
import { agentCommands, readSkillHeader } from "../server/agent-commands.ts";

const cmd = (id: string, name = id, source: Command["source"] = "library"): Command => ({ id, name, description: `${name} does a thing`, source });
const all = [cmd("tldr", "TL;DR"), cmd("brainstorm", "Brainstorm"), cmd("weekly-review", "Weekly review"), cmd("tldraw", "tldraw", "engine")];

test("a slash opens the list only at the start of a word, anywhere in the message", () => {
  assert.deepEqual(slashAt("/tl", 3), { start: 0, query: "tl" });
  assert.deepEqual(slashAt("please /tl", 10), { start: 7, query: "tl" });
  assert.deepEqual(slashAt("/", 1), { start: 0, query: "" });
  assert.equal(slashAt("and/or", 6), null);
  assert.equal(slashAt("see src/app", 11), null);
  // a finished word closes it
  assert.equal(slashAt("/tldr now", 9), null);
  // the caret decides, not the end of the text
  assert.deepEqual(slashAt("/br and more", 3), { start: 0, query: "br" });
});

test("matching is fuzzy, prefix first, and library skills lead on a tie", () => {
  assert.deepEqual(matches(all, "tl").map((c) => c.id), ["tldr", "tldraw"]);
  // letters in order: tldr first, the longer tldraw after it
  assert.deepEqual(matches(all, "tdr").map((c) => c.id), ["tldr", "tldraw"]);
  assert.deepEqual(matches(all, "review").map((c) => c.id), ["weekly-review"]);
  // by name as well as id
  assert.deepEqual(matches(all, "brain").map((c) => c.id), ["brainstorm"]);
  assert.equal(matches(all, "").length, 4);
  assert.equal(matches(all, "zzz").length, 0);
});

test("inserting replaces the half-typed word and leaves the caret after a space", () => {
  assert.deepEqual(insert("/tl", 0, 3, "tldr"), { text: "/tldr ", caret: 6 });
  assert.deepEqual(insert("please /tl this", 7, 10, "tldr"), { text: "please /tldr this", caret: 13 });
});

test("known skills in a message are marked, and every character is kept in order", () => {
  const ids = new Set(["tldr", "brainstorm"]);
  const text = "run /tldr on this, then /brainstorm. and/or /unknown";
  const runs = segments(text, ids);
  assert.equal(runs.map((r) => r.text).join(""), text);
  assert.deepEqual(runs.filter((r) => r.skill).map((r) => r.text), ["/tldr", "/brainstorm"]);
  assert.deepEqual(segments("plain text", ids), [{ text: "plain text", skill: false }]);
});

test("a Claude Code skill's name and description come from its header", () => {
  assert.deepEqual(readSkillHeader("---\nname: tldr\ndescription: \"Short summary\"\nother: x\n---\nbody"), { name: "tldr", description: "Short summary" });
  assert.equal(readSkillHeader("no header here"), null);
});

test("an agent on Claude Code also offers the engine's skills; library ones win a clash", () => {
  const home = mkdtempSync(join(tmpdir(), "bloks-cmds-"));
  try {
    for (const [dir, name] of [["tldr", "tldr"], ["pdf", "pdf"]]) {
      mkdirSync(join(home, ".claude", "skills", dir), { recursive: true });
      writeFileSync(join(home, ".claude", "skills", dir, "SKILL.md"), `---\nname: ${name}\ndescription: engine ${name}\n---\n`);
    }
    const library = [{ id: "tldr", name: "TL;DR", description: "library tldr" }];
    const onClaude = agentCommands({ library, onClaudeCode: true, home });
    assert.deepEqual(onClaude.map((c) => `${c.source}:${c.id}`), ["library:tldr", "engine:pdf"]);
    const onApi = agentCommands({ library, onClaudeCode: false, home });
    assert.deepEqual(onApi.map((c) => c.id), ["tldr"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
