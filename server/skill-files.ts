// What a skill keeps beside its instructions.
//
// A skill is one text, at most MAX_SKILL_CHARS long, because that text may
// be sent whole on every turn of every agent that uses it
// (server/skills.ts). A skill worth writing down is often more than that:
// an API reference, a helper script, a table of codes. Flattening all of
// it into the one text either does not fit or fills every prompt with
// pages the agent needs once a week (GitHub 455). So a skill can carry
// supporting files, the way a SKILL.md folder does: the instructions stay
// the entry point, under the same limit, and name the files; the files
// are never in a prompt, and an agent reads one when the instructions
// send it there (`bloks skill <id> --file <path>`).
//
// Plain text only, a handful of them, each bounded: a skill's files are
// read by agents and shown to the person whole, and a binary or a
// clone of a repository is neither. Names are relative paths judged as
// words and then opened inside the skill's own folder (server/open-inside.ts),
// so a name can never reach another skill's files or anything else.
import { mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { DATA_DIR } from "./config.ts";
import { closeHeld, openInside, readHeld } from "./open-inside.ts";

/** How many files one skill keeps. */
export const MAX_SKILL_FILES = 40;
/** How big one file may be, in bytes. A long API reference fits. */
export const MAX_SKILL_FILE_BYTES = 128 * 1024;
/** How much all of one skill's files may come to, in bytes: with its
 * instructions, under what one request to the workspace may carry. */
export const MAX_SKILL_FILES_BYTES = 768 * 1024;
/** How deep a file may sit: references/api/v2.md, not a source tree. */
const MAX_DEPTH = 4;
const SEGMENT = /^[A-Za-z0-9_][\w .()+@-]{0,99}$/;

export interface SupportingFile {
  path: string;
  text: string;
}

export interface SupportingFileInfo {
  path: string;
  /** Bytes, as stored. */
  size: number;
}

/** Where a skill's files live: beside the library, never in it, so the
 * library stays one markdown file per skill. */
function root(): string {
  return join(DATA_DIR, "skill-files");
}

function folderOf(id: string): string | null {
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(id) ? join(root(), id) : null;
}

/** A file's name as words, tidied, or null: a relative path of plain
 * segments, nothing hidden, no climbing, and never the skill's own
 * SKILL.md, which is its instructions and not one of its files. */
export function supportingFileName(path: unknown): string | null {
  if (typeof path !== "string") return null;
  const parts = path.replace(/^\.\//, "").split("/");
  if (!parts.length || parts.length > MAX_DEPTH) return null;
  for (const part of parts) if (!SEGMENT.test(part) || part.trim() !== part) return null;
  const clean = parts.join("/");
  if (clean.toLowerCase() === "skill.md") return null;
  return clean;
}

/** Files as somebody sent them, judged whole: the list, or why not. */
export function checkSupportingFiles(raw: unknown): { ok: true; files: SupportingFile[] } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, files: [] };
  if (!Array.isArray(raw)) return { ok: false, error: "files is a list of { path, text }" };
  if (raw.length > MAX_SKILL_FILES) {
    return { ok: false, error: `A skill keeps at most ${MAX_SKILL_FILES} files; that is ${raw.length}. Fold the small ones together.` };
  }
  const files: SupportingFile[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const entry of raw) {
    const path = supportingFileName((entry as { path?: unknown })?.path);
    const text = (entry as { text?: unknown })?.text;
    if (!path) {
      return {
        ok: false,
        error: `"${String((entry as { path?: unknown })?.path ?? "").slice(0, 120)}" is not a name a skill's file can have: a relative path of letters, numbers, dots, dashes and spaces, at most ${MAX_DEPTH} folders deep, nothing hidden, and not SKILL.md`,
      };
    }
    if (seen.has(path.toLowerCase())) return { ok: false, error: `${path} is in the list twice` };
    seen.add(path.toLowerCase());
    if (typeof text !== "string") return { ok: false, error: `${path} has no text` };
    // eslint-disable-next-line no-control-regex
    if (/\u0000/.test(text)) return { ok: false, error: `${path} is not text: a skill's files are plain text, never binaries` };
    const size = Buffer.byteLength(text, "utf8");
    if (size > MAX_SKILL_FILE_BYTES) {
      return { ok: false, error: `${path} is ${Math.ceil(size / 1024)} KB; one file of a skill is at most ${MAX_SKILL_FILE_BYTES / 1024} KB` };
    }
    total += size;
    if (total > MAX_SKILL_FILES_BYTES) {
      return { ok: false, error: `Those files come to more than ${MAX_SKILL_FILES_BYTES / 1024} KB, the most one skill keeps` };
    }
    files.push({ path, text });
  }
  return { ok: true, files: files.sort((a, b) => a.path.localeCompare(b.path)) };
}

/** A skill's files, by name and size, sorted; none when it has none. */
export function listSupportingFiles(id: string): SupportingFileInfo[] {
  const folder = folderOf(id);
  if (!folder) return [];
  const found: SupportingFileInfo[] = [];
  const walk = (dir: string, prefix: string, depth: number) => {
    if (depth > MAX_DEPTH || found.length >= MAX_SKILL_FILES) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (SEGMENT.test(entry.name)) walk(join(dir, entry.name), name, depth + 1);
      } else if (entry.isFile() && supportingFileName(name) === name) {
        const held = openInside(folder, name.split("/"));
        if (!held) continue;
        found.push({ path: name, size: held.stat.size });
        closeHeld(held);
      }
    }
  };
  walk(folder, "", 1);
  return found.sort((a, b) => a.path.localeCompare(b.path));
}

/** One of a skill's files, as text, or null when it has no such file. */
export function readSupportingFile(id: string, path: string): string | null {
  const folder = folderOf(id);
  const name = supportingFileName(path);
  if (!folder || !name) return null;
  const held = openInside(folder, name.split("/"));
  if (!held) return null;
  const bytes = readHeld(held, MAX_SKILL_FILE_BYTES);
  closeHeld(held);
  return bytes ? bytes.toString("utf8") : null;
}

/** Every one of a skill's files, as text, for showing them all at once. */
export function readSupportingFiles(id: string): SupportingFile[] {
  return listSupportingFiles(id)
    .map((info) => ({ path: info.path, text: readSupportingFile(id, info.path) }))
    .filter((file): file is SupportingFile => file.text !== null);
}

/**
 * A skill's files, replaced as a set: written into a folder of their own
 * first and swapped in whole, so a skill is never seen with half of a
 * new set beside half of the old one. An empty set removes the folder.
 * The files are checked by checkSupportingFiles before they get here.
 */
export function writeSupportingFiles(id: string, files: readonly SupportingFile[]): void {
  const folder = folderOf(id);
  if (!folder) throw Object.assign(new Error("that is not a skill's id"), { status: 400 });
  if (!files.length) return removeSupportingFiles(id);
  mkdirSync(root(), { recursive: true, mode: 0o700 });
  const tag = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const staging = join(root(), `.incoming-${id}-${tag}`);
  const old = join(root(), `.outgoing-${id}-${tag}`);
  let moved = false;
  try {
    for (const file of files) {
      const parts = file.path.split("/");
      mkdirSync(join(staging, ...parts.slice(0, -1)), { recursive: true, mode: 0o700 });
      writeFileSync(join(staging, ...parts), file.text, { mode: 0o600 });
    }
    try {
      renameSync(folder, old);
      moved = true;
    } catch {}
    renameSync(staging, folder);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    // the set it had stays its set
    if (moved) {
      try {
        renameSync(old, folder);
      } catch {}
    }
    throw error;
  }
  if (moved) rmSync(old, { recursive: true, force: true });
}

/** A skill's files gone with it. */
export function removeSupportingFiles(id: string): void {
  const folder = folderOf(id);
  if (folder) rmSync(folder, { recursive: true, force: true });
}

/** The two sets the same, path for path and word for word. */
export function sameSupportingFiles(a: readonly SupportingFile[], b: readonly SupportingFile[]): boolean {
  if (a.length !== b.length) return false;
  const byPath = new Map(b.map((file) => [file.path, file.text]));
  return a.every((file) => byPath.get(file.path) === file.text);
}
