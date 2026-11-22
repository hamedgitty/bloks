// What git says has changed in a conversation's folder, for the side
// dock's Changes panel (GitHub 522): the working tree against the last
// commit, tracked and untracked, how many lines each file gained and
// lost, one file's diff, and the branch with how far it is ahead of or
// behind its upstream.
//
// The panel's first view is what the conversation's own turns changed,
// from the photographs Bloks takes around each turn (server/checkpoints.ts,
// laneChanges). This is the second, for a folder that is a repository:
// everything not yet committed, whoever wrote it.
//
// Read only, and careful about it. Git is asked only when it is really
// there (realGit: never the macOS stub that opens an installer), with no
// prompts, no optional locks, no fsmonitor and no hooks; a diff never
// runs a repository's external diff or textconv program; a path is only
// ever one git itself reported as changed; and an untracked file is read
// only when it is a plain file inside the folder, never through a link.
import { execFile } from "node:child_process";
import { lstat, open, realpath } from "node:fs/promises";
import { devNull } from "node:os";
import path from "node:path";

import { realGit, SKIP_DIRS } from "./checkpoints.ts";

export type GitStatus = "added" | "modified" | "deleted" | "renamed" | "conflict";

export interface GitChangedFile {
  /** Relative to the conversation's folder, with forward slashes. */
  path: string;
  status: GitStatus;
  /** Not yet known to git. */
  untracked?: true;
  /** A rename's old path. */
  from?: string;
  /** Lines added and removed against the last commit; null when git cannot
   * count them (binary, or too large to read). */
  added: number | null;
  removed: number | null;
  binary?: true;
}

export type GitChanges =
  | { repo: false; installed: boolean }
  | {
      repo: true;
      branch: string | null;
      /** The commit, short, for a detached head (null before the first). */
      head: string | null;
      upstream: string | null;
      ahead: number;
      behind: number;
      changes: GitChangedFile[];
      /** More changed files than the list holds. */
      truncated: boolean;
    };

export interface GitDiffLine {
  kind: "add" | "del" | "same";
  old?: number;
  new?: number;
  text: string;
}

export interface GitFileDiff {
  path: string;
  status: GitStatus;
  hunks: Array<{ header: string; lines: GitDiffLine[] }>;
  binary?: true;
  tooLarge?: true;
  /** A symbolic link, which this does not follow. */
  link?: true;
  /** Longer than the panel holds; the rest is left out. */
  truncated: boolean;
}

export const MAX_FILES = 1000;
export const MAX_DIFF_LINES = 4000;
/** Untracked files larger than this are not read to count or show. */
const MAX_READ = 1_000_000;
/** At most this many untracked files are read to count their lines. */
const MAX_COUNTED = 300;

type StatusHeader = { oid: string | null; branch: string | null; upstream: string | null; ahead: number; behind: number };
type RawChange = { path: string; status: GitStatus; untracked?: true; from?: string };

/** What a git run said, or that it could not run at all. */
type Ran = { ok: true; out: string } | { ok: false; out: string; missing?: boolean };

const GIT_ENV = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_ASKPASS: "",
  SSH_ASKPASS: "",
  GIT_PAGER: "cat",
  // a path is a path, never a pattern
  GIT_LITERAL_PATHSPECS: "1",
};
/** Config set back to git's defaults so a person's own settings cannot
 * change what is parsed, and nothing in the repository runs. */
const SAFE_CONFIG = ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "diff.suppressBlankEmpty=false", "-c", "color.ui=false"];
const DIFF_FLAGS = ["--no-ext-diff", "--no-textconv", "--no-color", "--no-renames"];

function runGit(args: string[], cwd: string): Promise<Ran> {
  const git = realGit();
  if (!git) return Promise.resolve({ ok: false, out: "", missing: true });
  return new Promise((done) => {
    execFile(
      git,
      [...SAFE_CONFIG, ...args],
      { cwd, timeout: 8_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true, env: { ...process.env, ...GIT_ENV } },
      (error, stdout, stderr) => done(error ? { ok: false, out: `${stderr || error.message}` } : { ok: true, out: String(stdout) }),
    );
  });
}

/**
 * `git status --porcelain=v2 -z --branch`: the `# branch.*` headers, then
 * one entry per changed path. Ordinary (1), renamed or copied (2, whose
 * old path is the next NUL field), unmerged (u) and untracked (?) entries;
 * ignored ones and untracked folders (a nested repository) are left out.
 */
export function parsePorcelainV2(out: string): { header: StatusHeader; changes: RawChange[] } {
  const header: StatusHeader = { oid: null, branch: null, upstream: null, ahead: 0, behind: 0 };
  const changes: RawChange[] = [];
  const parts = out.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (!entry) continue;
    if (entry.startsWith("# ")) {
      const [key, ...rest] = entry.slice(2).split(" ");
      const value = rest.join(" ");
      if (key === "branch.oid") header.oid = value === "(initial)" ? null : value;
      else if (key === "branch.head") header.branch = value === "(detached)" ? null : value;
      else if (key === "branch.upstream") header.upstream = value;
      else if (key === "branch.ab") {
        const m = /^\+(\d+) -(\d+)$/.exec(value);
        if (m) [header.ahead, header.behind] = [Number(m[1]), Number(m[2])];
      }
      continue;
    }
    const kind = entry[0];
    if (kind === "?") {
      const p = entry.slice(2);
      if (!p.endsWith("/")) changes.push({ path: p, status: "added", untracked: true });
      continue;
    }
    if (kind === "1" || kind === "2" || kind === "u") {
      // fixed fields before the path: 1 has 8, 2 has 9 (its score), u has 10
      const split = splitFields(entry, kind === "1" ? 8 : kind === "2" ? 9 : 10);
      if (!split) continue;
      const xy = split.fields[1] ?? "..";
      if (kind === "u") changes.push({ path: split.rest, status: "conflict" });
      else if (kind === "2") {
        const from = parts[++i] ?? "";
        changes.push({ path: split.rest, status: "renamed", ...(from ? { from } : {}) });
      } else changes.push({ path: split.rest, status: xy.includes("D") ? "deleted" : xy.includes("A") ? "added" : "modified" });
    }
  }
  return { header, changes };
}

/** The first `n` space-separated fields and everything after them (a path
 * may itself hold spaces). */
function splitFields(entry: string, n: number): { fields: string[]; rest: string } | null {
  const fields: string[] = [];
  let at = 0;
  for (let k = 0; k < n; k++) {
    const next = entry.indexOf(" ", at);
    if (next < 0) return null;
    fields.push(entry.slice(at, next));
    at = next + 1;
  }
  return { fields, rest: entry.slice(at) };
}

/** `git diff --numstat -z --no-renames`: "added\tremoved\tpath\0" per
 * file, "-\t-" for a binary one. */
export function parseNumstat(out: string): Map<string, { added: number | null; removed: number | null; binary: boolean }> {
  const counts = new Map<string, { added: number | null; removed: number | null; binary: boolean }>();
  for (const entry of out.split("\0")) {
    const m = /^(-|\d+)\t(-|\d+)\t(.+)$/s.exec(entry);
    if (!m) continue;
    const binary = m[1] === "-" && m[2] === "-";
    counts.set(m[3], { added: binary ? null : Number(m[1]), removed: binary ? null : Number(m[2]), binary });
  }
  return counts;
}

/** A unified diff's hunks, each line with its old and new numbers. File
 * headers and "\ No newline" notes are left out. */
export function parseUnifiedDiff(out: string, maxLines = MAX_DIFF_LINES): { hunks: GitFileDiff["hunks"]; binary: boolean; truncated: boolean } {
  const hunks: GitFileDiff["hunks"] = [];
  let binary = false;
  let count = 0;
  let oldNo = 0;
  let newNo = 0;
  let current: GitFileDiff["hunks"][number] | null = null;
  for (const line of out.split("\n")) {
    const at = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (at) {
      if (count >= maxLines) return { hunks, binary, truncated: true };
      current = { header: line, lines: [] };
      hunks.push(current);
      oldNo = Number(at[1]);
      newNo = Number(at[2]);
      continue;
    }
    if (!current) {
      if (/^Binary files .* differ$/.test(line) || line.startsWith("GIT binary patch")) binary = true;
      continue;
    }
    const sign = line[0];
    if (sign !== "+" && sign !== "-" && sign !== " ") continue;
    if (count >= maxLines) return { hunks, binary, truncated: true };
    count++;
    const text = line.slice(1);
    if (sign === "+") current.lines.push({ kind: "add", new: newNo++, text });
    else if (sign === "-") current.lines.push({ kind: "del", old: oldNo++, text });
    else current.lines.push({ kind: "same", old: oldNo++, new: newNo++, text });
  }
  return { hunks, binary, truncated: false };
}

/** A path a page asked about, checked before it goes anywhere near git or
 * the disk: relative, inside the folder, no `..`, no NUL. The caller
 * still only acts on paths git reports as changed. */
export function safeRelativePath(p: unknown): string | null {
  if (typeof p !== "string" || !p || p.length > 4096 || p.includes("\0")) return null;
  const clean = process.platform === "win32" ? p.replace(/\\/g, "/") : p;
  if (clean.startsWith("/") || /^[a-zA-Z]:/.test(clean)) return null;
  const parts = clean.split("/");
  if (parts.some((s) => s === ".." || s === "." || s === "")) return null;
  return clean;
}

/** Whether a folder-relative path sits in one of the folders that are
 * regenerated rather than written (node_modules and friends). */
export function inSkippedDir(rel: string): boolean {
  return rel.split("/").slice(0, -1).some((part) => SKIP_DIRS.has(part));
}

type Repo = { root: string; prefix: string; folder: string };

async function realDir(dir: string): Promise<string> {
  try {
    return await realpath(dir);
  } catch {
    return path.resolve(dir);
  }
}

/** The repository the folder is in, and the folder's path inside it. */
async function findRepo(dir: string): Promise<Repo | { repo: false; installed: boolean }> {
  const top = await runGit(["rev-parse", "--show-toplevel"], dir);
  if (!top.ok) return { repo: false, installed: !top.missing };
  const root = await realDir(top.out.trim());
  const folder = await realDir(dir);
  const prefix = path.relative(root, folder).split(path.sep).filter(Boolean).join("/");
  return { root, prefix, folder };
}

const countLines = (text: string) => (text ? text.split("\n").length - (text.endsWith("\n") ? 1 : 0) : 0);

/** An untracked file's text, read only if it is a plain file (never a
 * link) inside the folder and small enough. */
async function readUntracked(folder: string, rel: string): Promise<{ text: string } | { binary: true } | { link: true } | { tooLarge: true } | null> {
  const full = path.join(folder, ...rel.split("/"));
  try {
    const parent = await realpath(path.dirname(full));
    if (parent !== folder && !parent.startsWith(folder + path.sep)) return null;
    const info = await lstat(full);
    if (info.isSymbolicLink()) return { link: true };
    if (!info.isFile()) return null;
    if (info.size > MAX_READ) return { tooLarge: true };
    const handle = await open(full, "r");
    try {
      const buf = Buffer.alloc(info.size);
      await handle.read(buf, 0, info.size, 0);
      if (buf.subarray(0, 8000).includes(0)) return { binary: true };
      return { text: buf.toString("utf8") };
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

/** What diffs compare against: the last commit, or before the first one
 * git's empty tree. */
async function base(root: string, oid: string | null): Promise<string | null> {
  if (oid) return "HEAD";
  const empty = await runGit(["hash-object", "-t", "tree", devNull], root);
  return empty.ok ? empty.out.trim() : null;
}

/** The folder's uncommitted changes, or that it is not a repository. */
export async function gitChanges(dir: string): Promise<GitChanges> {
  const repo = await findRepo(dir);
  if ("repo" in repo) return repo;
  const scope = repo.prefix ? ["--", repo.prefix] : [];
  const status = await runGit(["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all", "--ignore-submodules=dirty", ...scope], repo.root);
  if (!status.ok) return { repo: false, installed: true };
  const { header, changes: raw } = parsePorcelainV2(status.out);
  const inFolder = raw
    .filter((c) => !repo.prefix || c.path.startsWith(`${repo.prefix}/`))
    .map((c) => ({ ...c, rel: repo.prefix ? c.path.slice(repo.prefix.length + 1) : c.path }))
    // new files in dependency and build folders are never listed: a
    // repository that forgot to ignore them would otherwise list thousands
    .filter((c) => !(c.untracked && inSkippedDir(c.rel)));
  const truncated = inFolder.length > MAX_FILES;
  const listed = inFolder.slice(0, MAX_FILES);
  const against = await base(repo.root, header.oid);
  const numstat = against ? await runGit(["diff", against, "--numstat", "-z", ...DIFF_FLAGS, ...scope], repo.root) : null;
  const counts = numstat?.ok ? parseNumstat(numstat.out) : new Map();

  let counted = 0;
  const changes: GitChangedFile[] = [];
  for (const c of listed) {
    const file: GitChangedFile = { path: c.rel, status: c.status, added: null, removed: null };
    if (c.untracked) file.untracked = true;
    if (c.from) file.from = repo.prefix && c.from.startsWith(`${repo.prefix}/`) ? c.from.slice(repo.prefix.length + 1) : c.from;
    const n = counts.get(c.path);
    if (n) {
      file.added = n.added;
      file.removed = n.removed;
      if (n.binary) file.binary = true;
    } else if (c.untracked && counted < MAX_COUNTED) {
      counted++;
      const read = await readUntracked(repo.folder, c.rel);
      if (read && "text" in read) {
        file.added = countLines(read.text);
        file.removed = 0;
      } else if (read && "binary" in read) file.binary = true;
    }
    changes.push(file);
  }
  return {
    repo: true,
    branch: header.branch,
    head: header.branch ? null : (header.oid?.slice(0, 7) ?? null),
    upstream: header.upstream,
    ahead: header.ahead,
    behind: header.behind,
    changes,
    truncated,
  };
}

/** One changed file's diff against the last commit (an untracked file
 * against nothing). Null when the path is not one git lists as changed. */
export async function gitFileDiff(dir: string, asked: unknown): Promise<GitFileDiff | null> {
  const rel = safeRelativePath(asked);
  if (!rel) return null;
  const state = await gitChanges(dir);
  if (!state.repo) return null;
  const file = state.changes.find((c) => c.path === rel);
  if (!file) return null;
  const repo = await findRepo(dir);
  if ("repo" in repo) return null;

  if (file.untracked) {
    const read = await readUntracked(repo.folder, rel);
    if (!read) return null;
    if ("link" in read) return { path: rel, status: file.status, hunks: [], link: true, truncated: false };
    if ("binary" in read) return { path: rel, status: file.status, hunks: [], binary: true, truncated: false };
    if ("tooLarge" in read) return { path: rel, status: file.status, hunks: [], tooLarge: true, truncated: false };
    const lines = read.text.split("\n");
    if (read.text.endsWith("\n")) lines.pop();
    const shown = lines.slice(0, MAX_DIFF_LINES);
    return {
      path: rel,
      status: file.status,
      hunks: shown.length ? [{ header: `@@ -0,0 +1,${lines.length} @@`, lines: shown.map((text, i) => ({ kind: "add" as const, new: i + 1, text })) }] : [],
      truncated: lines.length > shown.length,
    };
  }

  const repoPath = repo.prefix ? `${repo.prefix}/${rel}` : rel;
  const head = await runGit(["rev-parse", "--verify", "--quiet", "HEAD"], repo.root);
  const against = await base(repo.root, head.ok ? head.out.trim() : null);
  if (!against) return null;
  const diff = await runGit(["diff", against, ...DIFF_FLAGS, "-U3", "--", repoPath], repo.root);
  if (!diff.ok) return /maxBuffer/i.test(diff.out) ? { path: rel, status: file.status, hunks: [], tooLarge: true, truncated: false } : null;
  const parsed = parseUnifiedDiff(diff.out);
  return { path: rel, status: file.status, hunks: parsed.hunks, truncated: parsed.truncated, ...(parsed.binary || file.binary ? { binary: true as const } : {}) };
}
