// Codex's folder-scoped skill catalog. Paths stay inside the server;
// only names and descriptions reach the menu.
import { isAbsolute } from "node:path";
import { MAX_ENGINE_COMMANDS, MAX_ENGINE_COMMAND_BYTES, MAX_ENGINE_COMMAND_ID_CHARS, MAX_ENGINE_COMMAND_DESCRIPTION_CHARS } from "./limits.ts";

export interface CodexSkill { name: string; description: string; path: string }
export const MAX_CODEX_SKILL_ITEMS = 16;
const ENV_NAMES = new Set(["PATH", "HOME", "USER", "SHELL", "PWD", "TMPDIR", "TEMP", "TMP", "LANG", "TERM", "XDG_CONFIG_HOME"]);
// Codex 0.160's skills/src/mentions.rs: ASCII letters, digits, _, - and :.
const nameChars = /^[A-Za-z0-9_:-]+$/;
const plainName = (name: unknown): name is string => typeof name === "string" && name.length > 0 && name.length <= MAX_ENGINE_COMMAND_ID_CHARS && nameChars.test(name) && !/^\d+$/.test(name) && !ENV_NAMES.has(name.toUpperCase());

/** Only whole dollar tokens in the person's own words. No shell escape,
 * embedded variable or double dollar, and no paths from resource links. */
export function codexSkillNames(words: readonly string[]): string[] {
  const names = new Set<string>();
  for (const text of words) {
    for (const match of text.matchAll(/(?:^|[\s\x22\x27<]|\p{Ps}|\p{Pi})\$([A-Za-z0-9_:-]+)/gu)) {
      if (plainName(match[1])) names.add(match[1]);
      if (names.size >= 128) return [...names];
    }
  }
  return [...names];
}

/** First enabled row for a name wins, matching Codex's ordered catalog.
 * A malformed envelope cannot supply instructions for a different folder. */
export function readCodexSkills(value: unknown, cwd: string): CodexSkill[] | null {
  const data = (value as { data?: unknown })?.data;
  if (!Array.isArray(data) || data.length > MAX_ENGINE_COMMANDS || Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_ENGINE_COMMAND_BYTES) return null;
  const entries = data.filter((entry) => entry?.cwd === cwd);
  if (entries.length !== 1 || !Array.isArray(entries[0].skills) || entries[0].skills.length > MAX_ENGINE_COMMANDS) return null;
  const seen = new Set<string>();
  const skills: CodexSkill[] = [];
  for (const row of entries[0].skills) {
    if (!row || row.enabled !== true || !plainName(row.name) || seen.has(row.name) || typeof row.path !== "string" || row.path.length > 4096 || !isAbsolute(row.path) || /[\x00-\x1f\x7f]/.test(row.path) || !/(?:^|[/\\])SKILL\.md$/i.test(row.path)) continue;
    const description = row.interface?.shortDescription ?? row.shortDescription ?? row.description;
    if (typeof description !== "string") continue;
    seen.add(row.name);
    skills.push({ name: row.name, description: description.replace(/[\x00-\x1f\x7f]+/g, " ").slice(0, MAX_ENGINE_COMMAND_DESCRIPTION_CHARS), path: row.path });
  }
  return skills;
}
