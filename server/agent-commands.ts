// What an agent can be asked for by name, for the composer's `/` list (#51).
//
// Library skills live in the agent's prompt. Claude Code reports its own
// skills, MCP prompts and native commands. Before that first classified
// report, its filesystem skills and four supported commands are the fallback.
//
// Only a name and a one-line description of each leaves this file: the
// list is for choosing, and a skill's body is the agent's to read.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { MAX_ENGINE_COMMANDS, MAX_ENGINE_COMMAND_BYTES, MAX_ENGINE_COMMAND_ID_CHARS, MAX_ENGINE_COMMAND_DESCRIPTION_CHARS } from "./limits.ts";

export interface AgentCommand {
  /** What follows the slash. */
  id: string;
  name: string;
  description: string;
  /** Where it comes from: the Bloks library, or the engine itself. */
  source: "library" | "engine";
  kind?: "skill" | "command";
}

export const CLAUDE_COMMANDS = new Map([
  ["compact", "Compact this conversation"],
  ["context", "Show this conversation's context"],
  ["usage", "Show session usage"],
  ["recap", "Recap this conversation"],
]);
const TERMINAL_COMMANDS = new Set(["doctor", "color", "focus", "reload-plugins"]);

/** Only an exact first token is a native command. Keep its arguments untouched. */
export function claudeCommand(text: string): string | null {
  const name = /^\/([^\s]+)(?:\s|$)/.exec(text)?.[1];
  return name && CLAUDE_COMMANDS.has(name) ? name : null;
}

export interface ClaudeCommandRow { name: string; description: string; builtin?: boolean }
export interface ClaudeCatalog { commands: AgentCommand[]; reserved: string[] }
const validId = (id: unknown): id is string => typeof id === "string" && id.length > 0 && id.length <= MAX_ENGINE_COMMAND_ID_CHARS && !/[\s/\x00-\x1f\x7f]/.test(id);

/** Discard all metadata except invocation names, descriptions and classification. */
export function readClaudeCommands(value: unknown): ClaudeCommandRow[] | null {
  if (!Array.isArray(value) || value.length > MAX_ENGINE_COMMANDS || Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_ENGINE_COMMAND_BYTES) return null;
  const rows: ClaudeCommandRow[] = [];
  for (const row of value) {
    if (!row || !validId(row.name) || typeof row.description !== "string" || (row.builtin !== undefined && typeof row.builtin !== "boolean")) return null;
    rows.push({ name: row.name, description: row.description.replace(/[\x00-\x1f\x7f]+/g, " ").slice(0, MAX_ENGINE_COMMAND_DESCRIPTION_CHARS), ...(typeof row.builtin === "boolean" ? { builtin: row.builtin } : {}) });
  }
  return rows;
}

/** `builtin` includes bundled skills. The same turn's init skills separates them. */
export function classifyClaudeCommands(rows: ClaudeCommandRow[] | null, skills: unknown, terminal: unknown): ClaudeCatalog | null {
  if (!rows || !rows.some((r) => typeof r.builtin === "boolean") || !Array.isArray(skills) || skills.length > MAX_ENGINE_COMMANDS || !skills.every(validId)) return null;
  if (terminal !== undefined && (!Array.isArray(terminal) || terminal.length > MAX_ENGINE_COMMANDS || !terminal.every(validId))) return null;
  const bundled = new Set(skills);
  const excluded = new Set(["loop", ...TERMINAL_COMMANDS, ...(terminal ?? [])]);
  const unique = new Map<string, ClaudeCommandRow>();
  for (const row of rows) if (!unique.has(row.name) || row.builtin === true) unique.set(row.name, row);
  const commands: AgentCommand[] = [];
  const reserved: string[] = [];
  for (const row of unique.values()) {
    const command = row.builtin === true && !bundled.has(row.name);
    if (command || excluded.has(row.name)) reserved.push(row.name);
    if (excluded.has(row.name) || (command && !CLAUDE_COMMANDS.has(row.name))) continue;
    commands.push({ id: row.name, name: row.name, description: row.description, source: "engine", kind: command ? "command" : "skill" });
  }
  return { commands, reserved };
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
      if (!header || !validId(entry) || entry === "loop" || TERMINAL_COMMANDS.has(entry)) continue;
      // the directory name is what the CLI answers to
      out.push({ id: entry, name: header.name, description: header.description.slice(0, 300), source: "engine", kind: "skill" });
    } catch {
      /* one unreadable skill does not hide the rest */
    }
  }
  return out;
}

/**
 * Everything a `/` can name for one agent, library skills first. Where an
 * engine skill and a library skill share an id, the library one wins.
 * Native commands reserve their names, because that is what the CLI runs.
 */
export function agentCommands(input: {
  library: Array<{ id: string; name: string; description: string }>;
  onClaudeCode: boolean;
  cwd?: string | null;
  home?: string;
  reported?: ClaudeCatalog;
}): AgentCommand[] {
  const library: AgentCommand[] = input.library.map((s) => ({
    id: s.id,
    name: s.name,
    description: s.description,
    source: "library",
    kind: "skill",
  }));
  if (!input.onClaudeCode) return library;
  const reserved = new Set(input.reported?.reserved ?? [...CLAUDE_COMMANDS.keys(), "loop", ...TERMINAL_COMMANDS]);
  const kept = library.filter((c) => !reserved.has(c.id));
  const seen = new Set(kept.map((c) => c.id));
  const engine: AgentCommand[] = [];
  const dirs = [join(input.home ?? homedir(), ".claude", "skills"), ...(input.cwd ? [join(input.cwd, ".claude", "skills")] : [])];
  const available = input.reported?.commands ?? [
    ...dirs.flatMap(engineSkillsIn).filter((c) => !reserved.has(c.id)),
    ...[...CLAUDE_COMMANDS].map(([id, description]): AgentCommand => ({ id, name: id, description, source: "engine", kind: "command" })),
  ];
  for (const skill of available) {
    if (seen.has(skill.id)) continue;
    seen.add(skill.id);
    engine.push(skill);
  }
  engine.sort((a, b) => a.id.localeCompare(b.id));
  return [...kept, ...engine];
}
