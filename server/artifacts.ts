// Deliverables an agent leaves behind.
//
// Every agent gets a directory of its own under DATA_DIR. Its system
// prompt names the path; whatever the agent saves there during a turn
// surfaces in the chat as an artifact card the user can view in-app or
// download. Detection is a snapshot-and-diff around the turn, not a
// watcher: watchers are flaky across platforms and the interesting
// moment is "what did this turn produce", which a diff answers exactly.
// Exactly while one turn of the agent runs, that is: two conversations of
// one agent working at once share this directory, and which of them made
// a file is settled in server/artifact-turns.ts.
//
// The directory is also the one boundary a file is served from. A name is
// a path relative to it, folders included ("reports/q3.pdf"), and every
// name is judged twice: once as words (no "..", no hidden segments, no
// backslashes), and once as the file it really is, after links are
// followed, which has to be inside the directory too. That second
// judgement is made of the open file, not of the name (server/open-inside.ts),
// so what is checked, what its size is said to be, and the bytes sent
// are one file, whatever is swapped in the directory meanwhile. A file
// anywhere else on the computer reaches a person only by being shared
// into it (see publish below), never by being named.
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
  type ReadStream,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { DATA_DIR } from "./config.ts";
import { closeHeld, openInside, readHeld, streamHeld, within, type HeldFile } from "./open-inside.ts";

export interface ArtifactInfo {
  name: string;
  mime: string;
  size: number;
}

/** Filenames the end-of-turn sweep announces: a plain name at the top of
 * the directory, no separators, no leading dot. A file in a folder is
 * served and can be shared, but a turn that writes a site with forty
 * images in it should not leave forty cards. */
const SAFE_NAME = /^[\w][\w .()\-]{0,120}$/;

/** How deep a shared name may go, and how long it may be. Deeper than any
 * folder an agent makes on purpose. */
const MAX_DEPTH = 8;
const MAX_SEGMENT = 200;
const MAX_NAME = 1024;

/** Biggest file one share copies in. A long screen recording fits; a disk
 * image does not belong in a chat. */
export const MAX_PUBLISH_BYTES = 2 * 1024 * 1024 * 1024;

const MIME: Record<string, string> = {
  html: "text/html",
  htm: "text/html",
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  heic: "image/heic",
  mp4: "video/mp4",
  m4v: "video/x-m4v",
  mov: "video/quicktime",
  webm: "video/webm",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  md: "text/markdown",
  markdown: "text/markdown",
  txt: "text/plain",
  log: "text/plain",
  json: "application/json",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  zip: "application/zip",
};

export function mimeOf(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return MIME[ext] ?? "application/octet-stream";
}

export function artifactsDir(botId: string): string {
  const dir = join(DATA_DIR, "artifacts", botId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/**
 * A name as words: "reports/q3.pdf", tidied, or null. Judged after any
 * percent decoding the caller did, so an encoded "../" is a "../" here.
 * Each segment is any characters a file can have except the ones that
 * move: no empty segment, no "." or "..", nothing hidden, no backslash
 * (a separator somewhere), no control characters.
 */
export function safeName(name: string): string | null {
  if (typeof name !== "string" || !name || name.length > MAX_NAME) return null;
  if (name.startsWith("/") || name.includes("\\")) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) return null;
  const parts = name.split("/");
  if (parts.length > MAX_DEPTH) return null;
  for (const part of parts) {
    if (!part || part.length > MAX_SEGMENT || part.startsWith(".") || part.trim() !== part) return null;
  }
  return parts.join("/");
}

/** The directory as it really is, links followed. macOS keeps temporary
 * folders behind a link, and a home folder can be one too. */
function realRoot(botId: string): string {
  const dir = artifactsDir(botId);
  try {
    return realpathSync(dir);
  } catch {
    return dir;
  }
}

/** The file a name stands for, open, with the name tidied; or null when
 * it is not a safe name, is not a regular file, or is anywhere but inside
 * the directory. Whoever gets one closes it. */
function holdArtifact(botId: string, name: string): { held: HeldFile; name: string } | null {
  if (!/^[\w-]+$/.test(botId)) return null;
  const clean = safeName(name);
  if (!clean) return null;
  const held = openInside(artifactsDir(botId), clean.split("/"));
  return held ? { held, name: clean } : null;
}

/** Where the file a name stands for is, or null when it is not a safe
 * name, is not a file, or is a link that leads outside the directory.
 * An answer about the name, for deciding whether one is shared: reading
 * the file goes through openArtifact, never through this path. */
export function artifactPath(botId: string, name: string): string | null {
  const found = holdArtifact(botId, name);
  if (!found) return null;
  closeHeld(found.held);
  return found.held.path;
}

export function artifactInfo(botId: string, name: string): ArtifactInfo | null {
  const found = holdArtifact(botId, name);
  if (!found) return null;
  closeHeld(found.held);
  return { name: found.name, mime: mimeOf(found.name), size: found.held.stat.size };
}

/** "bytes=0-1023", "bytes=500-", "bytes=-500", read against a size.
 * Anything else, or more than one range, is the whole file. Null when the
 * range starts past the end, which the route answers 416. */
export function parseRange(header: string | null | undefined, size: number): { start: number; end: number } | null | undefined {
  const m = /^bytes=(\d*)-(\d*)$/.exec((header ?? "").trim());
  if (!m || (!m[1] && !m[2])) return undefined;
  let start: number;
  let end: number;
  if (!m[1]) {
    const tail = Number(m[2]);
    if (tail === 0) return null;
    start = Math.max(0, size - tail);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  }
  if (start >= size || end < start) return null;
  return { start, end };
}

/** A shared file, open: its size as the open file has it, and its bytes
 * from that same open file. */
export interface OpenedArtifact extends ArtifactInfo {
  /** Which version of the file this is, from the open file: another file
   * put in its place, or this one written to, has another. A device that
   * takes a large file a piece at a time asks every piece by it. */
  tag: string;
  /** All of it, or a range read against `size`. Closes the file when it
   * ends, fails or is destroyed. */
  stream(range?: { start: number; end: number }): ReadStream;
  /** All of it at once, up to `max` bytes, then closed. Null when it is
   * bigger than that or cannot be read. */
  read(max?: number): Buffer<ArrayBuffer> | null;
  /** Lets it go unread, for an answer that sends no bytes. */
  close(): void;
}

/** The file a name stands for, opened once: the judgement, the size and
 * the bytes all come from that one open. Null when it is not shared. */
export function openArtifact(botId: string, name: string): OpenedArtifact | null {
  const found = holdArtifact(botId, name);
  if (!found) return null;
  const { held } = found;
  const { dev, ino, size, mtimeMs, ctimeMs } = held.stat;
  return {
    name: found.name,
    mime: mimeOf(found.name),
    size,
    tag: createHash("sha256").update(`${dev}:${ino}:${size}:${mtimeMs}:${ctimeMs}`).digest("base64url").slice(0, 22),
    stream: (range) => streamHeld(held, range),
    read: (max) => readHeld(held, max),
    close: () => closeHeld(held),
  };
}

/** Every file in an agent's directory, folders included, newest first.
 * Capped, because a folder somebody cloned a repository into is still
 * somebody's folder and not a list for a phone. */
export function listArtifacts(botId: string, cap = 500): ArtifactInfo[] {
  const root = realRoot(botId);
  const found: Array<ArtifactInfo & { at: number }> = [];
  const walk = (dir: string, prefix: string, depth: number) => {
    if (depth > MAX_DEPTH || found.length >= cap) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found.length >= cap) return;
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (!safeName(name)) continue;
      // links are not followed here: what one points at is decided when
      // it is opened, by artifactPath, and a loop of them is not a list
      if (entry.isDirectory()) walk(join(dir, entry.name), name, depth + 1);
      else if (entry.isFile()) {
        try {
          const stat = statSync(join(dir, entry.name));
          found.push({ name, mime: mimeOf(name), size: stat.size, at: stat.mtimeMs });
        } catch {}
      }
    }
  };
  walk(root, "", 1);
  return found.sort((a, b) => b.at - a.at).map(({ at: _at, ...info }) => info);
}

/**
 * Which agent's file a filesystem path is, when it is one.
 *
 * An agent's reply names its deliverables the way it saved them, as a
 * path on this computer, and a phone cannot open a path. This answers
 * for a path that lands in some agent's directory, by the same two
 * judgements as artifactPath: what the path says, then where it really
 * is. A path anywhere else is not a file anybody shared, and gets null.
 */
export function resolveArtifactRef(raw: string): { botId: string; name: string } | null {
  if (typeof raw !== "string" || !raw.trim() || raw.length > 4096) return null;
  let path = raw.trim();
  if (/^file:/i.test(path)) {
    try {
      path = fileURLToPath(path);
    } catch {
      return null;
    }
  } else if (/%[0-9a-f]{2}/i.test(path)) {
    try {
      path = decodeURIComponent(path);
    } catch {
      return null;
    }
  }
  if (path.startsWith("~/")) path = join(homedir(), path.slice(2));
  if (!isAbsolute(path)) return null;
  const base = join(DATA_DIR, "artifacts");
  const candidates = [relative(base, resolve(path))];
  try {
    candidates.push(relative(realpathSync(base), realpathSync(path)));
  } catch {}
  for (const rel of candidates) {
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) continue;
    const [botId, ...rest] = rel.split(sep);
    if (!botId || !rest.length || !/^[\w-]+$/.test(botId)) continue;
    const name = rest.join("/");
    if (artifactPath(botId, name)) return { botId, name };
  }
  return null;
}

/** The route a shared file is asked for at, alone or after this
 * computer's own address, as an agent may write it in a reply. */
const HREF = /^(?:https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?)?\/api\/bots\/([\w-]+)\/artifacts\/([^?#]+)(?:[?#].*)?$/i;

/**
 * Whatever a link in a reply points at, as a shared file: the route
 * itself (with this computer's address in front or not), a path, or a
 * file: URL. Null when it is none of those, or names nothing shared.
 */
export function resolveShared(raw: string): { botId: string; name: string } | null {
  const href = HREF.exec(typeof raw === "string" ? raw.trim() : "");
  if (href) {
    let name: string;
    try {
      name = decodeURIComponent(href[2]);
    } catch {
      return null;
    }
    const clean = safeName(name);
    return clean && artifactPath(href[1], clean) ? { botId: href[1], name: clean } : null;
  }
  return resolveArtifactRef(raw);
}

/** A name that is not taken yet: "q3.pdf", then "q3 (2).pdf", and on. */
export function freeName(botId: string, wanted: string): string | null {
  const clean = safeName(wanted);
  if (!clean) return null;
  const dir = artifactsDir(botId);
  if (!existsSync(join(dir, ...clean.split("/")))) return clean;
  const slash = clean.lastIndexOf("/");
  const folder = slash >= 0 ? clean.slice(0, slash + 1) : "";
  const file = clean.slice(slash + 1);
  const dot = file.lastIndexOf(".");
  const stem = dot > 0 ? file.slice(0, dot) : file;
  const ext = dot > 0 ? file.slice(dot) : "";
  for (let n = 2; n < 1000; n++) {
    const next = `${folder}${stem} (${n})${ext}`;
    if (!existsSync(join(dir, ...next.split("/")))) return safeName(next);
  }
  return null;
}

/**
 * Bytes handed in from elsewhere on this computer, written under a name
 * nobody has yet. They land in a hidden file first and are renamed in
 * only once complete, so a half-copied file is never served and never
 * swept up as a card. Whatever went wrong, the hidden file goes.
 */
export async function publishBytes(
  botId: string,
  wanted: string,
  chunks: AsyncIterable<Buffer | Uint8Array | string>,
): Promise<{ ok: true; info: ArtifactInfo } | { ok: false; status: number; error: string }> {
  const name = freeName(botId, wanted);
  if (!name) return { ok: false, status: 400, error: "that is not a name a shared file can have" };
  const dir = artifactsDir(botId);
  const target = join(dir, ...name.split("/"));
  const folder = dirname(target);
  // A folder on the way that is a link out of the directory is refused
  // before anything is made or written through it: judged at the nearest
  // folder that exists now, and again once the rest is made.
  const root = realRoot(botId);
  const staysInside = (dir: string) => {
    try {
      const real = realpathSync(dir);
      return real === root || within(root, real);
    } catch {
      return false;
    }
  };
  let existing = folder;
  while (!existsSync(existing) && existing !== dir) existing = dirname(existing);
  if (!staysInside(existing)) return { ok: false, status: 400, error: "that folder leads outside the agent's files" };
  try {
    mkdirSync(folder, { recursive: true, mode: 0o700 });
  } catch {
    return { ok: false, status: 400, error: "that folder could not be made" };
  }
  if (!staysInside(folder)) return { ok: false, status: 400, error: "that folder leads outside the agent's files" };
  const staging = join(folder, `.incoming-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const fd = openSync(staging, "wx", 0o600);
  let size = 0;
  try {
    for await (const chunk of chunks) {
      const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      size += bytes.length;
      if (size > MAX_PUBLISH_BYTES) throw Object.assign(new Error("that file is too large to share"), { status: 413 });
      writeSync(fd, bytes);
    }
    fsyncSync(fd);
    closeSync(fd);
    renameSync(staging, target);
  } catch (error) {
    try {
      closeSync(fd);
    } catch {}
    rmSync(staging, { force: true });
    return {
      ok: false,
      status: (error as { status?: number }).status ?? 500,
      error: (error as Error).message || "the file could not be saved",
    };
  }
  return { ok: true, info: { name, mime: mimeOf(name), size } };
}

/** How a shared file is asked for: the route, its name encoded as one
 * segment so a folder in it cannot be read as more of the route. */
export function artifactHref(botId: string, name: string): string {
  return `/api/bots/${botId}/artifacts/${encodeURIComponent(name)}`;
}

/** A download's filename header, for any name: plain ASCII for whatever
 * reads only that, and the real name, encoded, for everything else. A
 * name with a character outside ASCII would otherwise throw when the
 * header is written. */
export function attachmentHeader(name: string): string {
  const file = name.split("/").pop() ?? name;
  const plain = file.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "");
  const encoded = encodeURIComponent(file).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${plain}"; filename*=UTF-8''${encoded}`;
}

/** name -> mtime+size fingerprint of everything currently in the dir. */
export function snapshot(botId: string): Map<string, string> {
  const seen = new Map<string, string>();
  try {
    for (const name of readdirSync(artifactsDir(botId))) {
      if (!SAFE_NAME.test(name)) continue;
      try {
        const stat = statSync(join(artifactsDir(botId), name));
        if (stat.isFile()) seen.set(name, `${stat.mtimeMs}:${stat.size}`);
      } catch {}
    }
  } catch {}
  return seen;
}

/** The fingerprint the sweep would take of one file now, so a file shared
 * mid-turn is not announced a second time when the turn ends. */
export function fingerprint(botId: string, name: string): string | null {
  const found = holdArtifact(botId, name);
  if (!found) return null;
  closeHeld(found.held);
  const { stat } = found.held;
  return `${stat.mtimeMs}:${stat.size}`;
}

/** Files that are new or changed since `before`, newest last, each with
 * when it was last written and its fingerprint, for telling which of two
 * turns running at once wrote it (server/artifact-turns.ts). */
export function changedSince(
  botId: string,
  before: Map<string, string>,
): Array<ArtifactInfo & { at: number; print: string }> {
  const produced: Array<ArtifactInfo & { at: number; print: string }> = [];
  const dir = artifactsDir(botId);
  try {
    for (const name of readdirSync(dir)) {
      if (!SAFE_NAME.test(name)) continue;
      try {
        const stat = statSync(join(dir, name));
        if (!stat.isFile()) continue;
        const print = `${stat.mtimeMs}:${stat.size}`;
        if (before.get(name) !== print) {
          produced.push({ name, mime: mimeOf(name), size: stat.size, at: stat.mtimeMs, print });
        }
      } catch {}
    }
  } catch {}
  return produced.sort((a, b) => a.at - b.at);
}
