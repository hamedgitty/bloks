// What an agent changed, and the way back.
//
// Before a turn, the folder the agent works in is photographed; after it,
// photographed again. The difference is what the turn did to your files,
// shown as a card in the conversation with a diff per file and one button
// to put it all back.
//
// Our own store rather than git. Git would give diffs for free, but on a
// Mac without the developer tools, /usr/bin/git is a stub that pops an
// installer dialog, and "an agent turn opened a system dialog" is not a
// trade worth making for a diff. So this is content addressed the same
// way git is, without being git: every file version is kept once, by its
// sha256, and a photograph is a list of paths and hashes. A file that has
// not moved since the last photograph (same size, same mtime) is not read
// again, which is what keeps the second photograph of a folder cheap.
//
// Undo is careful rather than forceful. A file is put back only if it is
// still exactly what the turn left behind. If you or a later turn changed
// it since, it is left alone and named, because quietly throwing away
// work done after the fact is the one thing an undo must never do.
//
// Limits, all of them deliberate: folders too big to photograph in a
// moment are not tracked (the card says so rather than pretending), files
// over MAX_FILE are noted as changed but not kept, and a handful of
// directories that are regenerated rather than written (node_modules and
// friends) are skipped.
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { realpathSync } from "node:fs";

import { newId } from "./contracts.ts";

/** Bigger than this is noted as changed and never kept. */
export const MAX_FILE = 2 * 1024 * 1024;
/** More files than this and the folder is not tracked at all. */
export const MAX_FILES = 20_000;
/** New bytes one photograph may add to the store. */
const MAX_NEW_BYTES = 256 * 1024 * 1024;
/** Records kept; older ones lose their undo, never their card. */
const MAX_RECORDS = 300;
/** A text diff past this many lines on either side is summarised. */
const MAX_DIFF_LINES = 4_000;

/** Regenerated, not written: skipping them is most of what keeps this fast. */
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  ".gradle",
  "DerivedData",
  "Pods",
  "target",
  ".pytest_cache",
  ".mypy_cache",
]);
const SKIP_FILES = new Set([".DS_Store"]);

interface Entry {
  /** sha256 of the content; absent for a file too big to keep. */
  hash?: string;
  size: number;
  mtimeMs: number;
}
type Photo = Map<string, Entry>;

export type ChangeStatus = "added" | "modified" | "deleted";

export interface FileChange {
  path: string;
  status: ChangeStatus;
  before?: string;
  after?: string;
  /** Too big to keep, so shown but not undoable. */
  big?: boolean;
  added?: number;
  removed?: number;
}

export interface CheckpointRecord {
  id: string;
  threadId: string;
  botId: string;
  dir: string;
  at: number;
  files: FileChange[];
  revertedAt?: number;
  /** Where its card sits, so an undo can update it. */
  card?: { threadId: string; messageId: string };
  /** A rehearsal: the changes are in a clone, not yet in `dir`. They
   * reach `dir` only through apply, and only then can they be undone. */
  rehearsal?: { copy: string };
  appliedAt?: number;
  discardedAt?: number;
}

/** What goes on the card: small, and nothing the diff call cannot fetch. */
export interface ChangesSummary {
  checkpointId: string;
  files: Array<Pick<FileChange, "path" | "status" | "big" | "added" | "removed">>;
  /** How many files changed in all, when more than the card lists. */
  total: number;
  reverted?: { at: number; restored: number; skipped: number };
  /** Set for a rehearsal: waiting on a decision, applied, or discarded. */
  rehearsal?: { state: "pending" | "applied" | "discarded"; applied?: number; skipped?: number };
}

export interface DiffLine {
  kind: "same" | "add" | "del" | "gap";
  text: string;
}

export interface FileDiff {
  path: string;
  status: ChangeStatus;
  binary?: boolean;
  big?: boolean;
  tooLong?: boolean;
  lines: DiffLine[];
}

export interface RevertResult {
  restored: string[];
  skipped: Array<{ path: string; why: string }>;
}

/** A folder worth photographing: never a home directory or anything above
 * one, where a turn in the wrong place would copy a whole disk. */
export function trackable(dir: string | null | undefined, home = homedir()): dir is string {
  if (!dir) return false;
  const at = resolve(dir);
  const h = resolve(home);
  if (at === sep || at === h) return false;
  if (h.startsWith(at + sep)) return false;
  return existsSync(at) && statSync(at).isDirectory();
}

/**
 * The smallest line diff we can afford: common ends trimmed, then a
 * longest common subsequence over what is left. Past a size it gives up
 * and says so, rather than spending a second on a card nobody asked to
 * open yet.
 */
export function diffLines(before: string, after: string): DiffLine[] | null {
  // a file's last newline ends its last line; it is not one more
  const split = (text: string) => (text === "" ? [] : text.replace(/\n$/, "").split("\n"));
  const a = split(before);
  const b = split(after);
  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) return null;
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const x = a.slice(head, a.length - tail);
  const y = b.slice(head, b.length - tail);
  if (x.length * y.length > 4_000_000) return null;

  // lcs[i][j]: common length of x[i..] and y[j..], one row at a time
  const rows: Uint32Array[] = [];
  for (let i = 0; i <= x.length; i++) rows.push(new Uint32Array(y.length + 1));
  for (let i = x.length - 1; i >= 0; i--) {
    for (let j = y.length - 1; j >= 0; j--) {
      rows[i][j] = x[i] === y[j] ? rows[i + 1][j + 1] + 1 : Math.max(rows[i + 1][j], rows[i][j + 1]);
    }
  }
  const middle: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) {
      middle.push({ kind: "same", text: x[i] });
      i++;
      j++;
    } else if (rows[i + 1][j] >= rows[i][j + 1]) {
      middle.push({ kind: "del", text: x[i++] });
    } else {
      middle.push({ kind: "add", text: y[j++] });
    }
  }
  while (i < x.length) middle.push({ kind: "del", text: x[i++] });
  while (j < y.length) middle.push({ kind: "add", text: y[j++] });

  const all: DiffLine[] = [
    ...a.slice(0, head).map((text) => ({ kind: "same" as const, text })),
    ...middle,
    ...a.slice(a.length - tail).map((text) => ({ kind: "same" as const, text })),
  ];
  return context(all, 3);
}

/** Unchanged runs cut down to a few lines either side of a change. */
function context(lines: DiffLine[], keep: number): DiffLine[] {
  const near = new Array(lines.length).fill(false);
  lines.forEach((line, at) => {
    if (line.kind === "same") return;
    for (let k = Math.max(0, at - keep); k <= Math.min(lines.length - 1, at + keep); k++) near[k] = true;
  });
  const out: DiffLine[] = [];
  let skipped = 0;
  lines.forEach((line, at) => {
    if (near[at]) {
      if (skipped) out.push({ kind: "gap", text: `${skipped} unchanged line${skipped === 1 ? "" : "s"}` });
      skipped = 0;
      out.push(line);
    } else skipped++;
  });
  if (skipped && out.length) out.push({ kind: "gap", text: `${skipped} unchanged line${skipped === 1 ? "" : "s"}` });
  return out;
}

/**
 * Whether a path, as the filesystem resolves it, is still inside a
 * folder: every existing ancestor is resolved through its links and
 * compared with the folder's own resolved path, and the file itself must
 * not be a link.
 */
export function insideReally(folder: string, target: string): boolean {
  let root: string;
  try {
    root = realpathSync(folder);
  } catch {
    return false;
  }
  try {
    if (lstatSync(target).isSymbolicLink()) return false;
  } catch {
    /* not there yet, which is fine: an added file being removed or a
       deleted one coming back */
  }
  let parent = dirname(target);
  while (!existsSync(parent)) {
    const up = dirname(parent);
    if (up === parent) return false;
    parent = up;
  }
  let real: string;
  try {
    real = realpathSync(parent);
  } catch {
    return false;
  }
  return real === root || real.startsWith(root + sep);
}

function looksBinary(data: Buffer): boolean {
  const n = Math.min(data.length, 8000);
  for (let k = 0; k < n; k++) if (data[k] === 0) return true;
  return false;
}

export class Checkpoints {
  private readonly root: string;
  private readonly blobs: string;
  private readonly photos: string;
  private readonly indexFile: string;
  private records: CheckpointRecord[] = [];
  /** The photograph taken before each lane's running turn. */
  private pending = new Map<string, { botId: string; dir: string; photo: Photo; ignore: string[]; afterDir?: string }>();
  /** One photograph of a folder at a time, so two lanes do not race. */
  private queues = new Map<string, Promise<unknown>>();

  constructor(root: string) {
    this.root = root;
    this.blobs = join(root, "blobs");
    this.photos = join(root, "photos");
    this.indexFile = join(root, "index.json");
    try {
      this.records = JSON.parse(readFileSync(this.indexFile, "utf8"));
      if (!Array.isArray(this.records)) this.records = [];
    } catch {
      this.records = [];
    }
  }

  /** Photographs the folder before a turn. Never throws: a turn does not
   * wait on, or fail because of, its undo. */
  async begin(
    threadId: string,
    botId: string,
    dir: string | null | undefined,
    ignore: string[] = [],
    /** A rehearsal: the turn works in this clone of `dir`, and the
     * difference is taken between `dir` now and the clone after. */
    afterDir?: string,
  ): Promise<boolean> {
    this.pending.delete(threadId);
    if (!trackable(dir)) return false;
    const photo = await this.serial(dir, () => this.photograph(dir, ignore));
    if (photo) this.pending.set(threadId, { botId, dir, photo, ignore, ...(afterDir ? { afterDir } : {}) });
    return Boolean(photo);
  }

  /** Photographs again after the turn, and keeps the difference. Null
   * when nothing changed, or nothing was being watched. */
  async finish(threadId: string): Promise<CheckpointRecord | null> {
    const before = this.pending.get(threadId);
    this.pending.delete(threadId);
    if (!before) return null;
    const where = before.afterDir ?? before.dir;
    const after = await this.serial(where, () => this.photograph(where, before.ignore, before.afterDir ? before.photo : undefined));
    if (before.afterDir) this.forgetPhoto(before.afterDir);
    if (!after) return null;
    const files = this.compare(before.photo, after);
    if (files.length === 0) return null;
    const record: CheckpointRecord = {
      id: newId(),
      threadId,
      botId: before.botId,
      dir: before.dir,
      at: Date.now(),
      files,
      ...(before.afterDir ? { rehearsal: { copy: before.afterDir } } : {}),
    };
    this.records.push(record);
    if (this.records.length > MAX_RECORDS) {
      this.records.splice(0, this.records.length - MAX_RECORDS);
      this.sweep();
    }
    this.save();
    return record;
  }

  /** Forgets a turn that never ran. */
  cancel(threadId: string) {
    this.pending.delete(threadId);
  }

  attachCard(id: string, threadId: string, messageId: string) {
    const record = this.get(id);
    if (!record) return;
    record.card = { threadId, messageId };
    this.save();
  }

  get(id: string): CheckpointRecord | undefined {
    return this.records.find((r) => r.id === id);
  }

  summary(record: CheckpointRecord, listed = 50): ChangesSummary {
    return {
      ...(record.rehearsal
        ? { rehearsal: { state: record.discardedAt ? ("discarded" as const) : record.appliedAt ? ("applied" as const) : ("pending" as const) } }
        : {}),
      checkpointId: record.id,
      files: record.files.slice(0, listed).map(({ path, status, big, added, removed }) => ({
        path,
        status,
        ...(big ? { big } : {}),
        ...(added !== undefined ? { added } : {}),
        ...(removed !== undefined ? { removed } : {}),
      })),
      total: record.files.length,
    };
  }

  diff(id: string, path: string): FileDiff | null {
    const record = this.get(id);
    const change = record?.files.find((f) => f.path === path);
    if (!record || !change) return null;
    const base: FileDiff = { path, status: change.status, lines: [] };
    if (change.big) return { ...base, big: true };
    const before = change.before ? this.blob(change.before) : Buffer.alloc(0);
    const after = change.after ? this.blob(change.after) : Buffer.alloc(0);
    if (!before || !after) return { ...base, big: true };
    if (looksBinary(before) || looksBinary(after)) return { ...base, binary: true };
    const lines = diffLines(before.toString("utf8"), after.toString("utf8"));
    return lines ? { ...base, lines } : { ...base, tooLong: true };
  }

  /**
   * Puts the folder back the way it was before the turn, file by file,
   * leaving anything that has changed since alone.
   */
  /**
   * A rehearsal's changes, written into the real folder. Each file only
   * if it is still exactly as it was when the rehearsal began: a file you
   * changed meanwhile is left alone and named. From then on the record
   * undoes like any other.
   */
  async apply(id: string): Promise<RevertResult | null> {
    const record = this.get(id);
    if (!record?.rehearsal || record.appliedAt || record.discardedAt) return null;
    return this.serial(record.dir, async () => {
      const result: RevertResult = { restored: [], skipped: [] };
      for (const change of record.files) {
        const target = join(record.dir, change.path);
        if (relative(record.dir, target).startsWith("..") || !insideReally(record.dir, target)) {
          result.skipped.push({ path: change.path, why: "outside the folder" });
          continue;
        }
        if (change.big) {
          // too big to have been kept, but still sitting in the clone
          const source = join(record.rehearsal!.copy, change.path);
          if (change.status === "deleted") {
            unlinkSync(target);
          } else if (existsSync(source)) {
            mkdirSync(dirname(target), { recursive: true });
            copyFileSync(source, target);
          } else {
            result.skipped.push({ path: change.path, why: "no longer in the rehearsal" });
            continue;
          }
          result.restored.push(change.path);
          continue;
        }
        const now = this.hashOf(target);
        if (now !== (change.before ?? null)) {
          result.skipped.push({ path: change.path, why: "changed since the rehearsal began" });
          continue;
        }
        if (change.status === "deleted") {
          unlinkSync(target);
        } else {
          const data = change.after ? this.blob(change.after) : null;
          if (!data) {
            result.skipped.push({ path: change.path, why: "no longer kept" });
            continue;
          }
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(target, data);
        }
        result.restored.push(change.path);
      }
      record.appliedAt = Date.now();
      this.save();
      return result;
    });
  }

  /** A rehearsal left unapplied: its card says so, and it cannot be undone. */
  discard(id: string): boolean {
    const record = this.get(id);
    if (!record?.rehearsal || record.appliedAt || record.discardedAt) return false;
    record.discardedAt = Date.now();
    this.save();
    return true;
  }

  async revert(id: string): Promise<RevertResult | null> {
    const record = this.get(id);
    if (!record) return null;
    // a rehearsal that never reached the folder has nothing there to undo
    if (record.rehearsal && !record.appliedAt) return null;
    return this.serial(record.dir, async () => {
      const result: RevertResult = { restored: [], skipped: [] };
      for (const change of record.files) {
        const target = join(record.dir, change.path);
        // never outside the folder, whatever a record on disk says, and
        // not through a link: a folder the agent swapped for a symlink
        // since would otherwise carry the write somewhere else entirely
        if (relative(record.dir, target).startsWith("..") || !insideReally(record.dir, target)) {
          result.skipped.push({ path: change.path, why: "outside the folder" });
          continue;
        }
        if (change.big) {
          result.skipped.push({ path: change.path, why: "too large to have been kept" });
          continue;
        }
        const now = this.hashOf(target);
        if (now !== (change.after ?? null)) {
          result.skipped.push({ path: change.path, why: "changed since" });
          continue;
        }
        if (change.status === "added") {
          unlinkSync(target);
        } else {
          const data = change.before ? this.blob(change.before) : null;
          if (!data) {
            result.skipped.push({ path: change.path, why: "no longer kept" });
            continue;
          }
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(target, data);
        }
        result.restored.push(change.path);
      }
      record.revertedAt = Date.now();
      this.save();
      return result;
    });
  }

  // ── the photographs ────────────────────────────────────────────────

  private serial<T>(dir: string, work: () => Promise<T> | T): Promise<T> {
    const prior = this.queues.get(dir) ?? Promise.resolve();
    const next = prior.then(work, work);
    this.queues.set(
      dir,
      next.catch(() => {}),
    );
    return next;
  }

  /** A clone's photograph is of no use once the clone is gone. */
  forgetPhoto(dir: string) {
    rmSync(this.photoFile(dir), { force: true });
  }

  private photoFile(dir: string) {
    return join(this.photos, `${createHash("sha256").update(resolve(dir)).digest("hex").slice(0, 32)}.json`);
  }

  /** The folder as it is now, or null if it is too big to track. */
  /** `ignore` names paths (a file, or a folder ending in /) that are
   * someone else's to track, like an agent's own memory. */
  private async photograph(dir: string, ignore: string[] = [], seed?: Photo): Promise<Photo | null> {
    // a clone keeps its original's times, so the original's photograph
    // spares re-reading every file that the turn did not touch
    let last: Photo = seed ? new Map(seed) : new Map();
    if (!seed) {
      try {
        last = new Map(Object.entries(JSON.parse(readFileSync(this.photoFile(dir), "utf8"))));
      } catch {
        /* the first photograph of this folder */
      }
    }
    const photo: Photo = new Map();
    let added = 0;
    const stack = [""];
    while (stack.length) {
      const rel = stack.pop()!;
      let names: string[];
      try {
        names = await readdir(join(dir, rel));
      } catch {
        continue;
      }
      for (const name of names) {
        const path = rel ? `${rel}/${name}` : name;
        if (ignore.some((skip) => (skip.endsWith("/") ? `${path}/`.startsWith(skip) : path === skip))) continue;
        let info;
        try {
          info = lstatSync(join(dir, path));
        } catch {
          continue;
        }
        if (info.isSymbolicLink()) continue;
        if (info.isDirectory()) {
          if (!SKIP_DIRS.has(name)) stack.push(path);
          continue;
        }
        if (!info.isFile() || SKIP_FILES.has(name)) continue;
        if (photo.size >= MAX_FILES) return null;
        const seen = last.get(path);
        if (seen && seen.size === info.size && seen.mtimeMs === info.mtimeMs) {
          photo.set(path, seen);
          continue;
        }
        if (info.size > MAX_FILE) {
          photo.set(path, { size: info.size, mtimeMs: info.mtimeMs });
          continue;
        }
        let data: Buffer;
        try {
          // read without blocking: a first photograph of a big folder is
          // thousands of files, and the server has a UI to keep answering
          data = await readFile(join(dir, path));
        } catch {
          continue;
        }
        const hash = createHash("sha256").update(data).digest("hex");
        if (await this.keep(hash, data)) {
          added += data.length;
          if (added > MAX_NEW_BYTES) return null;
        }
        photo.set(path, { hash, size: info.size, mtimeMs: info.mtimeMs });
      }
    }
    mkdirSync(this.photos, { recursive: true });
    writeFileSync(this.photoFile(dir), JSON.stringify(Object.fromEntries(photo)));
    return photo;
  }

  private compare(before: Photo, after: Photo): FileChange[] {
    const out: FileChange[] = [];
    const paths = new Set([...before.keys(), ...after.keys()]);
    for (const path of [...paths].sort()) {
      const a = before.get(path);
      const b = after.get(path);
      if (a && b && a.size === b.size && a.hash === b.hash && (a.hash || a.mtimeMs === b.mtimeMs)) continue;
      const status: ChangeStatus = !a ? "added" : !b ? "deleted" : "modified";
      const big = Boolean((a && !a.hash) || (b && !b.hash));
      const change: FileChange = { path, status, ...(a?.hash ? { before: a.hash } : {}), ...(b?.hash ? { after: b.hash } : {}) };
      if (big) change.big = true;
      else this.count(change);
      out.push(change);
    }
    return out;
  }

  /** Lines added and removed, for the card. Skipped for anything binary. */
  private count(change: FileChange) {
    const before = change.before ? this.blob(change.before) : Buffer.alloc(0);
    const after = change.after ? this.blob(change.after) : Buffer.alloc(0);
    if (!before || !after || looksBinary(before) || looksBinary(after)) return;
    const lines = diffLines(before.toString("utf8"), after.toString("utf8"));
    if (!lines) return;
    change.added = lines.filter((l) => l.kind === "add").length;
    change.removed = lines.filter((l) => l.kind === "del").length;
  }

  // ── the store ──────────────────────────────────────────────────────

  private blobPath(hash: string) {
    return join(this.blobs, hash.slice(0, 2), hash);
  }

  /** Keeps one version of a file; true if it was new. */
  private async keep(hash: string, data: Buffer): Promise<boolean> {
    const path = this.blobPath(hash);
    if (existsSync(path)) return false;
    await mkdir(dirname(path), { recursive: true });
    const temp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    await writeFile(temp, data);
    await rename(temp, path);
    return true;
  }

  private blob(hash: string): Buffer | null {
    try {
      return readFileSync(this.blobPath(hash));
    } catch {
      return null;
    }
  }

  private hashOf(path: string): string | null {
    try {
      const info = lstatSync(path);
      if (!info.isFile()) return null;
      return createHash("sha256").update(readFileSync(path)).digest("hex");
    } catch {
      return null;
    }
  }

  private save() {
    mkdirSync(this.root, { recursive: true });
    const temp = `${this.indexFile}.tmp`;
    writeFileSync(temp, JSON.stringify(this.records));
    renameSync(temp, this.indexFile);
  }

  /** Drops kept versions nothing points at any more: not a record, and
   * not the latest photograph of any folder (which the next turn's
   * comparison and undo both lean on). */
  private sweep() {
    const wanted = new Set<string>();
    for (const r of this.records) for (const f of r.files) {
      if (f.before) wanted.add(f.before);
      if (f.after) wanted.add(f.after);
    }
    try {
      for (const name of readdirSync(this.photos)) {
        const photo = JSON.parse(readFileSync(join(this.photos, name), "utf8")) as Record<string, Entry>;
        for (const entry of Object.values(photo)) if (entry.hash) wanted.add(entry.hash);
      }
      for (const shard of readdirSync(this.blobs)) {
        for (const name of readdirSync(join(this.blobs, shard))) {
          if (!wanted.has(name)) rmSync(join(this.blobs, shard, name), { force: true });
        }
      }
    } catch {
      /* a sweep that fails leaves extra bytes, never missing ones */
    }
  }
}
