// What an agent can be asked for by name, for the composer's `/` list (#51).
//
// Two kinds, both things the agent can actually follow when a message
// names them. The library skills attached to the agent, which are in its
// prompt. And, for an agent running on Claude Code, the skills installed
// for Claude Code itself (~/.claude/skills, and the agent's own folder's
// .claude/skills), which the CLI loads on its own and runs when a message
// starts with /name.
//
// Only a name and a one-line description of each leaves this file: the
// list is for choosing, and a skill's body is the agent's to read.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface AgentCommand {
  /** What follows the slash. */
  id: string;
  name: string;
  description: string;
  /** Where it comes from: the Bloks library, or the engine itself. */
  source: "library" | "engine";
}

/** A SKILL.md is small; anything past this is not read for its header. */
const MAX_HEADER_BYTES = 64 * 1024;
/** Enough for any real setup, and a stop for a folder of thousands. */
const MAX_PER_DIR = 200;

/**
 * The name and description from a SKILL.md's frontmatter, or null when it
 * has none. Only the two plain fields are read; everything else in the
 * header is the engine's business.
 */
export function readSkillHeader(text: string): { name: string; description: string } | null {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;
  const field = (key: string) => {
    const line = match[1].split(/\r?\n/).find((l) => l.startsWith(`${key}:`));
    if (!line) return "";
    return line
      .slice(key.length + 1)
      .trim()
      .replace(/^(["'])(.*)\1$/, "$2");
  };
  const name = field("name");
  return name ? { name, description: field("description") } : null;
}

/** Claude Code's skills in one folder: each a directory with a SKILL.md. */
export function engineSkillsIn(dir: string): AgentCommand[] {
  if (!existsSync(dir)) return [];
  const out: AgentCommand[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(dir).slice(0, MAX_PER_DIR);
  } catch {
    return [];
  }
  for (const entry of entries) {
    const file = join(dir, entry, "SKILL.md");
    try {
      if (!existsSync(file) || statSync(file).size > MAX_HEADER_BYTES) continue;
      const header = readSkillHeader(readFileSync(file, "utf8"));
      if (!header) continue;
      // the directory name is what the CLI answers to
      out.push({ id: entry, name: header.name, description: header.description.slice(0, 300), source: "engine" });
    } catch {
      /* one unreadable skill does not hide the rest */
    }
  }
  return out;
}

/**
 * Everything a `/` can name for one agent, library skills first. Where an
 * engine skill and a library skill share an id, the library one wins: it
 * is the one Bloks put in the agent's prompt.
 */
export function agentCommands(input: {
  library: Array<{ id: string; name: string; description: string }>;
  onClaudeCode: boolean;
  cwd?: string | null;
  home?: string;
}): AgentCommand[] {
  const library: AgentCommand[] = input.library.map((s) => ({
    id: s.id,
    name: s.name,
    description: s.description,
    source: "library",
  }));
  if (!input.onClaudeCode) return library;
  const seen = new Set(library.map((c) => c.id));
  const engine: AgentCommand[] = [];
  const dirs = [join(input.home ?? homedir(), ".claude", "skills"), ...(input.cwd ? [join(input.cwd, ".claude", "skills")] : [])];
  for (const dir of dirs) {
    for (const skill of engineSkillsIn(dir)) {
      if (seen.has(skill.id)) continue;
      seen.add(skill.id);
      engine.push(skill);
    }
  }
  engine.sort((a, b) => a.id.localeCompare(b.id));
  return [...library, ...engine];
}
