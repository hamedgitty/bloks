// What each agent remembered, when, and the way back.
//
// Memory is plain Markdown in the agent's workspace (server/workspace.ts):
// MEMORY.md, loaded into every turn, and memory/<topic>.md files the agent
// reads when a topic matters. The agent edits them with its own file
// tools, which is what makes memory yours to read. It also means a change
// can happen without anyone watching, so this keeps the record.
//
// Changes with known before and after states become entries: which file,
// who changed it (the agent in a turn, you in the editor, or an undo),
// and the text before and after.
// Memory files are small, so whole texts are kept rather than diffs; that
// makes undo exact and the journal readable without the files it
// describes.
//
// Undo follows the same rule as a turn's undo (server/checkpoints.ts): a
// file goes back only if it is still exactly what that change left. If
// anything changed it since, the undo says so and touches nothing.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { diffLines, type DiffLine } from "./checkpoints.ts";
import { isLink } from "./workspace.ts";
import { newId } from "./contracts.ts";

/** Entries kept per agent; the oldest go first. */
const MAX_ENTRIES = 300;
/** A single remembered text; larger ones are noted but not kept. */
const MAX_TEXT_BYTES = 256 * 1024;
const TOPIC = /^[\w][\w .-]{0,120}\.md$/;

export type MemoryAuthor = "agent" | "you" | "undo";

export interface MemoryEntry {
  id: string;
  at: number;
  /** "MEMORY.md" or "memory/<topic>.md". */
  file: string;
  by: MemoryAuthor;
  /** null: the file did not exist. */
  before: string | null;
  after: string | null;
  /** The entry this one undid. */
  undoes?: string;
  /** Set on an entry once it has been undone. */
  undoneBy?: string;
  /** Too large to keep; shown, never undoable. */
  big?: boolean;
}

/** The journal's view of an entry: counts and a diff, not whole texts. */
export interface MemoryEntryView extends Omit<MemoryEntry, "before" | "after"> {
  added: number;
  removed: number;
  lines: DiffLine[] | null;
  created: boolean;
  deleted: boolean;
}

/** Only ENOENT means absence. An unreadable file must never become null. */
export function readMemoryText(path: string, file: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    const reason = typeof code === "string" && /^[A-Z][A-Z0-9_]*$/.test(code) ? code : "READ_ERROR";
    throw Object.assign(new Error(`Could not read ${file} (${reason}). Restore file access and retry; nothing was changed.`), { code: reason });
  }
}

type Snapshot = {
  files: Map<string, string | null>;
  unreadable: Set<string>;
  topicsReadable: boolean;
};

export class MemoryJournal {
  private readonly root: string;
  private readonly workspaceOf: (botId: string) => string;
  private pending = new Map<string, { botId: string; snapshot: Snapshot }>();

  constructor(root: string, workspaceOf: (botId: string) => string) {
    this.root = root;
    this.workspaceOf = workspaceOf;
  }

  /** The memory files as they are, by journal name. */
  snapshot(botId: string): Snapshot {
    const dir = this.workspaceOf(botId);
    const out: Snapshot = { files: new Map(), unreadable: new Set(), topicsReadable: true };
    const read = (name: string, path: string) => {
      try {
        out.files.set(name, readMemoryText(path, name));
      } catch {
        out.unreadable.add(name);
      }
    };
    read("MEMORY.md", join(dir, "MEMORY.md"));
    try {
      for (const name of readdirSync(join(dir, "memory"))) {
        if (TOPIC.test(name)) read(`memory/${name}`, join(dir, "memory", name));
      }
    } catch (error) {
      out.topicsReadable = (error as NodeJS.ErrnoException).code === "ENOENT";
    }
    return out;
  }

  /** Before a turn: what memory looked like. */
  begin(threadId: string, botId: string) {
    this.pending.set(threadId, { botId, snapshot: this.snapshot(botId) });
  }

  /** After a turn: every file the agent changed becomes an entry. */
  finish(threadId: string): MemoryEntry[] {
    const before = this.pending.get(threadId);
    this.pending.delete(threadId);
    if (!before) return [];
    const after = this.snapshot(before.botId);
    const entries: MemoryEntry[] = [];
    for (const file of new Set([...before.snapshot.files.keys(), ...after.files.keys()])) {
      if (before.snapshot.unreadable.has(file) || after.unreadable.has(file)) continue;
      if (file.startsWith("memory/") && (!before.snapshot.topicsReadable || !after.topicsReadable)) continue;
      // A name absent from a readable listing is known absent. Unknown
      // file reads and directory listings were excluded above.
      const a = before.snapshot.files.get(file) ?? null;
      const b = after.files.get(file) ?? null;
      if (a === b) continue;
      entries.push(this.entry(file, "agent", a, b));
    }
    if (entries.length) this.append(before.botId, entries);
    return entries;
  }

  /** A change made through Bloks itself (the editor, or an undo). */
  record(botId: string, file: string, by: MemoryAuthor, before: string | null, after: string | null, undoes?: string): MemoryEntry | null {
    if (before === after) return null;
    const entry = { ...this.entry(file, by, before, after), ...(undoes ? { undoes } : {}) };
    this.append(botId, [entry]);
    return entry;
  }

  list(botId: string): MemoryEntry[] {
    return this.load(botId);
  }

  view(entry: MemoryEntry): MemoryEntryView {
    const { before, after, ...rest } = entry;
    const lines = entry.big ? null : diffLines(before ?? "", after ?? "");
    return {
      ...rest,
      added: lines ? lines.filter((l) => l.kind === "add").length : 0,
      removed: lines ? lines.filter((l) => l.kind === "del").length : 0,
      lines,
      created: before === null,
      deleted: after === null,
    };
  }

  /**
   * Puts a file back the way it was before one entry, if it is still
   * what that entry left. Returns the undo's own entry, or an error.
   */
  undo(botId: string, entryId: string): { ok: true; entry: MemoryEntry } | { ok: false; status: number; error: string } {
    const entries = this.load(botId);
    const target = entries.find((e) => e.id === entryId);
    if (!target) return { ok: false, status: 404, error: "no such change" };
    if (target.undoneBy) return { ok: false, status: 409, error: "already undone" };
    if (target.big) return { ok: false, status: 409, error: "that change was too large to keep, so it cannot be undone" };
    const path = this.pathOf(botId, target.file);
    if (!path) return { ok: false, status: 400, error: "not a memory file" };
    if (isLink(path) || isLink(join(this.workspaceOf(botId), "memory"))) {
      return { ok: false, status: 409, error: "that file is a link to somewhere else now, so it was left alone" };
    }
    let now: string | null;
    try {
      now = readMemoryText(path, target.file);
    } catch (error) {
      return { ok: false, status: 409, error: (error as Error).message };
    }
    if (now !== target.after) {
      return { ok: false, status: 409, error: "that file has changed since; undo the later changes first, or edit it directly" };
    }
    if (target.before === null) {
      try {
        unlinkSync(path);
      } catch {
        /* already gone */
      }
    } else {
      mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
      writeFileSync(path, target.before, { mode: 0o600 });
    }
    const entry: MemoryEntry = { ...this.entry(target.file, "undo", target.after, target.before), undoes: target.id };
    target.undoneBy = entry.id;
    const next = [...entries, entry];
    this.save(botId, next);
    return { ok: true, entry };
  }

  /** The path of a journal file name, only ever inside the workspace. */
  pathOf(botId: string, file: string): string | null {
    const dir = this.workspaceOf(botId);
    if (file === "MEMORY.md") return join(dir, "MEMORY.md");
    const topic = file.startsWith("memory/") ? file.slice(7) : "";
    return TOPIC.test(topic) ? join(dir, "memory", topic) : null;
  }

  // ── storage ────────────────────────────────────────────────────────

  private entry(file: string, by: MemoryAuthor, before: string | null, after: string | null): MemoryEntry {
    const big = [before, after].some((t) => t !== null && Buffer.byteLength(t, "utf8") > MAX_TEXT_BYTES);
    return {
      id: newId(),
      at: Date.now(),
      file,
      by,
      before: big ? null : before,
      after: big ? null : after,
      ...(big ? { big: true } : {}),
    };
  }

  private fileOf(botId: string) {
    return join(this.root, `${botId.replace(/[^\w-]/g, "")}.json`);
  }

  private load(botId: string): MemoryEntry[] {
    const file = this.fileOf(botId);
    if (!existsSync(file)) return [];
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private append(botId: string, entries: MemoryEntry[]) {
    this.save(botId, [...this.load(botId), ...entries]);
  }

  private save(botId: string, entries: MemoryEntry[]) {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const file = this.fileOf(botId);
    const temp = `${file}.tmp`;
    writeFileSync(temp, JSON.stringify(entries.slice(-MAX_ENTRIES)), { mode: 0o600 });
    renameSync(temp, file);
  }
}
