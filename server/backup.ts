// Backups of the whole workspace, and putting one back.
//
// Everything Bloks knows lives in ~/.bloks (server/config.ts), so a backup
// is simple to describe: one file holding that folder. It is written
// beside it, to ~/.bloks-backups, never inside it, so a backup is not part
// of the thing it copies and the folder can be swapped whole. Moving a
// workspace to another computer is copying one file and restoring it.
//
// The file is a gzipped tar, which every archive tool already opens, so a
// person can look inside without Bloks. Its first entry, bloks-backup.json,
// says what it is in a few lines, which is all a list of backups needs to
// read. The workspace follows under bloks/. The last entry, manifest.json,
// names every file with its size and SHA-256; it comes last so that each
// file is read once and hashed on the way through. Verifying reads the
// archive end to end and holds every file to the manifest.
//
// With a passphrase the whole archive is sealed. scrypt turns the
// passphrase into a key and AES-256-GCM seals the archive a megabyte at a
// time, each piece numbered and the last one marked, so a piece taken
// out, moved or cut off is caught as surely as a changed byte. Only
// node:crypto: nothing to install, and nothing to trust but Node.
//
// Saved keys go into a sealed backup and nowhere else. config.json is the
// secrets file, and a backup copied to a drive or a shared folder must not
// be a way to lift every key on the machine. Without a passphrase they are
// taken out of the copy and the manifest names what was taken. Restoring
// such a backup keeps the keys this computer already has.
//
// Left out: what Bloks makes again by itself, or what is too big and too
// tied to one machine to be worth carrying (raw engine logs, browser
// profiles, rehearsal copies, caches, dependency folders, temp files), the
// files of the running server (its lock and port), and the Undo history
// unless asked for, since it holds a version of every file any agent has
// changed.
//
// A restore never loses what it replaces. It backs up the workspace as it
// is, unpacks the archive into a folder beside it, checks every file
// against the manifest, and only then leaves a note for the next start. A
// running server holds every store in memory and writes it back on each
// change, so swapping the folder under it would let the old workspace be
// written into the new one. The swap waits for the next start instead,
// where it happens before any store has read a file. The workspace it
// replaces is renamed, never deleted, to ~/.bloks.before-restore-<time>.
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import {
  closeSync,
  createReadStream,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  chmodSync,
  unlinkSync,
} from "node:fs";
import { mkdir, open, readdir, utimes } from "node:fs/promises";
import { basename, dirname, join, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { constants as zlib, createGunzip, createGzip, gunzipSync } from "node:zlib";

import { isRecord, readSaved, writeFileAtomic } from "./atomic-write.ts";
import { APP_VERSION, DATA_DIR } from "./config.ts";
import { holderOf } from "./data-lock.ts";

/** Bumped when a reader of this build could not read what it writes. */
export const BACKUP_FORMAT = 1;
/** Automatic backups kept; manual ones stay until somebody deletes them. */
export const AUTO_KEEP = 7;
/** How far apart automatic backups are. */
export const AUTO_EVERY_MS = 24 * 60 * 60_000;
/** Strong enough that guessing a passphrase costs real time and memory
 * per guess (128 MB and a fraction of a second here), cheap enough that
 * the person waiting for a backup does not notice. */
export const SCRYPT = { N: 1 << 17, r: 8, p: 1 } as const;
/** The shortest passphrase a backup is sealed with. */
export const MIN_PASSPHRASE = 8;

const SUMMARY_ENTRY = "bloks-backup.json";
const MANIFEST_ENTRY = "manifest.json";
const DATA_PREFIX = "bloks/";
const PLAIN_EXT = ".tar.gz";
const SEALED_EXT = ".tar.gz.enc";
const MAGIC = Buffer.from("BLOKSENC");
/** Plaintext per sealed piece. */
const CHUNK = 1 << 20;
/** How much of a file is read at once. */
const PIECE = 1 << 20;
const BLOCK = 512;
const MAX_HEADER = 16 * 1024;
const MAX_JSON = 256 * 1024 * 1024;
const MAX_PROBLEMS = 20;
const LAST_RESTORE = "last-restore.json";

export type BackupKind = "manual" | "automatic" | "before-restore";

/** What a backup is, in the few lines a list needs. */
export interface BackupSummary {
  format: number;
  app: "bloks";
  version: string;
  created: number;
  kind: BackupKind;
  /** The Undo history (checkpoints/) is inside. */
  undo: boolean;
  /** Saved keys are inside, which only ever happens when it is sealed. */
  secrets: boolean;
}

export interface ManifestFile {
  path: string;
  size: number;
  sha256: string;
  mode: number;
  mtime: number;
}

export interface Manifest extends BackupSummary {
  files: ManifestFile[];
  bytes: number;
  /** Where keys were taken out of config.json, by name and never value. */
  secretsLeftOut: string[];
  /** What was not backed up, and why. */
  leftOut: string[];
  /** Anything a person should know about this copy. */
  notes: string[];
}

export interface BackupInfo extends BackupSummary {
  name: string;
  path: string;
  size: number;
  encrypted: boolean;
  /** Its first lines could not be read: not a backup, or cut short. */
  damaged?: boolean;
}

export interface VerifyResult {
  ok: boolean;
  files: number;
  bytes: number;
  problems: string[];
}

/** A restore unpacked and checked, waiting for the next start. */
export interface PendingRestore {
  from: string;
  /** The data folder itself, through any link, which is what is renamed. */
  target: string;
  staging: string;
  aside: string;
  at: number;
  /** The backup taken of the workspace just before, by name. */
  safety?: string;
  /** Whether the restored workspace brings its own keys or keeps these. */
  keys: "restored" | "kept";
}

export interface AppliedRestore {
  from: string;
  at: number;
  aside: string;
  safety?: string;
  keys: "restored" | "kept";
}

/** Something a person can be told. `status` is what a route answers. */
export class BackupError extends Error {
  readonly status: number;
  readonly code: "passphrase" | "damaged" | "missing" | "refused";

  constructor(message: string, status = 400, code: BackupError["code"] = "refused") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const damaged = (why: string) =>
  new BackupError(`This backup is damaged or incomplete: ${why}.`, 422, "damaged");
const notABackup = () => new BackupError("This file is not a Bloks backup, or its start is damaged.", 422, "damaged");

// ── where things go ───────────────────────────────────────────────────

/** The data folder, and its backups beside it. Every function takes the
 * data folder so tests can point it somewhere of their own. */
export function backupsDirFor(dataDir = DATA_DIR): string {
  return `${dataDir}-backups`;
}

const markerFor = (dataDir: string) => `${dataDir}.restore-pending.json`;

/** The folder a rename really moves: through a link, so a data folder
 * kept on another disk stays there after a restore. */
function targetOf(dataDir: string): string {
  try {
    return lstatSync(dataDir).isSymbolicLink() ? realpathSync(dataDir) : dataDir;
  } catch {
    return dataDir;
  }
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Named by local date and time, so a list of files reads in order, with
 * the version that made it and what kind it is. */
export function backupFileName(at: Date, version: string, kind: BackupKind, sealed: boolean): string {
  const day = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
  const time = `${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
  const v = version ? `-v${version.replace(/[^\w.]/g, "")}` : "";
  const tag = kind === "automatic" ? "-auto" : kind === "before-restore" ? "-before-restore" : "";
  return `bloks-backup-${day}-${time}${v}${tag}${sealed ? SEALED_EXT : PLAIN_EXT}`;
}

/** A name a route may act on: one file in the backups folder, nothing
 * that climbs out of it, nothing hidden. */
export function isBackupName(name: string): boolean {
  return (
    /^[\w.-]+$/.test(name) && !name.startsWith(".") && name.length <= 200 && (name.endsWith(PLAIN_EXT) || name.endsWith(SEALED_EXT))
  );
}

/** Local time, like the backup names, so the folder a restore moved aside
 * sorts and reads beside the backup taken just before it. */
function stampOf(at: Date): string {
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
}

// ── saved keys ────────────────────────────────────────────────────────

/** Where config.json keeps credentials. `*` is any key of an object and
 * `[]` any item of a list, matched by its id when keys are put back. A
 * paired device's digest is on the list because the relay's keys are
 * derived from it (server/relay-crypto.ts). */
export const SECRET_PATHS = [
  "providers.*.key",
  "xai.key",
  "composio.key",
  "composio.apiKey",
  "speech.elevenlabsKey",
  "speech.openaiKey",
  "box.token",
  "custom[].keys[].key",
  "chat.slack.botToken",
  "chat.slack.appToken",
  "chat.discord.token",
  "chat.whatsapp.token",
  "chat.whatsapp.appSecret",
  "chat.whatsapp.verifyToken",
  "telegram.token",
  "mcpServers[].headers",
  "secrets",
  "relay.agentToken",
  "relay.clientToken",
  "remote.devices",
  "remote.memberDevices",
] as const;

interface Step {
  key: string;
  list: boolean;
}

const steps = (path: string): Step[] =>
  path.split(".").map((part) => (part.endsWith("[]") ? { key: part.slice(0, -2), list: true } : { key: part, list: false }));

/** Worth calling a saved value: something is there. */
function holds(value: unknown): boolean {
  if (value === undefined || value === null || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  if (isRecord(value)) return Object.keys(value).length > 0;
  return true;
}

function stripAt(node: unknown, path: Step[], at: string, out: string[]) {
  if (!isRecord(node)) return;
  const [step, ...rest] = path;
  for (const key of step.key === "*" ? Object.keys(node) : [step.key]) {
    if (!(key in node)) continue;
    const here = at ? `${at}.${key}` : key;
    const value = node[key];
    if (step.list) {
      if (!Array.isArray(value)) continue;
      value.forEach((item, i) => stripAt(item, rest, `${here}[${isRecord(item) && typeof item.id === "string" ? item.id : i}]`, out));
    } else if (rest.length) {
      stripAt(value, rest, here, out);
    } else {
      if (holds(value)) out.push(here);
      delete node[key];
    }
  }
}

/** Takes every saved key out of a parsed config.json, in place, and says
 * where each one was. */
export function stripSecrets(config: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const path of SECRET_PATHS) stripAt(config, steps(path), "", out);
  return out;
}

function carryAt(from: unknown, into: Record<string, unknown>, path: Step[]) {
  if (!isRecord(from)) return;
  const [step, ...rest] = path;
  for (const key of step.key === "*" ? Object.keys(from) : [step.key]) {
    if (!(key in from)) continue;
    const value = from[key];
    if (step.list) {
      const twins = into[key];
      if (!Array.isArray(value) || !Array.isArray(twins)) continue;
      for (const item of value) {
        if (!isRecord(item) || item.id === undefined) continue;
        const twin = twins.find((t) => isRecord(t) && t.id === item.id);
        if (isRecord(twin)) carryAt(item, twin, rest);
      }
    } else if (rest.length) {
      if (into[key] === undefined) into[key] = {};
      if (isRecord(into[key])) carryAt(value, into[key] as Record<string, unknown>, rest);
    } else if (holds(value) && !holds(into[key])) {
      into[key] = structuredClone(value);
    }
  }
}

/** Puts this computer's keys into a restored config.json that came
 * without any, where it has none of its own. */
export function carrySecrets(from: Record<string, unknown>, into: Record<string, unknown>): void {
  for (const path of SECRET_PATHS) carryAt(from, into, steps(path));
}

// ── what goes in ──────────────────────────────────────────────────────

/** Made again from what is around them, by the tools that made them;
 * skipping them is most of what keeps an agent's folder small. Version
 * control folders are not here: their history is the work. */
const REGENERATED = new Set([
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
  ".pytest_cache",
  ".mypy_cache",
]);

/** Why `rel` (a path inside the data folder, with forward slashes) is not
 * backed up, or null when it is. */
export function leftOutBecause(rel: string, isDir: boolean, undo: boolean): string | null {
  const parts = rel.split("/");
  const name = parts[parts.length - 1];
  if (parts.length === 1) {
    if (isDir && name === "native") return "raw engine logs";
    if (isDir && name === "browser") return "browser profiles";
    if (isDir && (name === "cache" || name === "tmp")) return "cache";
    if (isDir && name === "checkpoints" && !undo) return "Undo history, not asked for";
    if (!isDir && (name === "server.lock" || name === "port")) return "belongs to the running server";
  }
  // the record of rehearsals stays; the copies they ran in do not
  if (parts[0] === "rehearsals" && parts.length === 2 && name !== "index.json") return "rehearsal copy";
  if (isDir && REGENERATED.has(name)) return "made again by its tools";
  if (!isDir && (name === ".DS_Store" || name.endsWith(".tmp") || name.endsWith(".partial"))) return "temporary";
  return null;
}

interface Plan {
  files: string[];
  leftOut: string[];
}

/** Every file to back up, in a steady order, and what was passed over.
 * Links are passed over too: one could point anywhere, and a restore
 * writing through it is how an archive reaches outside its folder. */
async function collect(dataDir: string, undo: boolean): Promise<Plan> {
  const files: string[] = [];
  const leftOut: string[] = [];
  let unlisted = 0;
  const skip = (what: string) => {
    if (leftOut.length < 200) leftOut.push(what);
    else unlisted++;
  };
  const walk = async (rel: string) => {
    let entries;
    try {
      entries = await readdir(rel ? join(dataDir, ...rel.split("/")) : dataDir, { withFileTypes: true });
    } catch (e) {
      // a folder that went away while it was being read is simply not there
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
      throw e;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        skip(`${path} (a link)`);
        continue;
      }
      const isDir = entry.isDirectory();
      if (!isDir && !entry.isFile()) continue; // sockets and the like are a running process's
      const why = leftOutBecause(path, isDir, undo);
      if (why) {
        skip(`${path}${isDir ? "/" : ""} (${why})`);
        continue;
      }
      if (isDir) await walk(path);
      else files.push(path);
    }
  };
  await walk("");
  if (unlisted) leftOut.push(`and ${unlisted} more`);
  return { files, leftOut };
}

// ── tar, as much of it as a backup needs ──────────────────────────────

const padding = (size: number) => Buffer.alloc((BLOCK - (size % BLOCK)) % BLOCK);
const MAX_OCTAL = 0o77777777777;

function octal(value: number, width: number): string {
  return value.toString(8).padStart(width - 1, "0") + "\0";
}

function headerBlock(name: string, size: number, mode: number, mtime: number, type: string): Buffer {
  const block = Buffer.alloc(BLOCK);
  block.write(name, 0, 100, "utf8");
  block.write(octal(mode & 0o7777, 8), 100, "ascii");
  block.write(octal(0, 8), 108, "ascii");
  block.write(octal(0, 8), 116, "ascii");
  block.write(octal(size, 12), 124, "ascii");
  block.write(octal(Math.max(0, Math.floor(mtime / 1000)), 12), 136, "ascii");
  block.fill(0x20, 148, 156);
  block.write(type, 156, "ascii");
  block.write("ustar\0", 257, "ascii");
  block.write("00", 263, "ascii");
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
  return block;
}

/** A POSIX extended header record: its own length leads it. */
function paxBody(fields: Record<string, string>): Buffer {
  return Buffer.concat(
    Object.entries(fields).map(([key, value]) => {
      const rest = Buffer.byteLength(` ${key}=${value}\n`);
      let length = rest + String(rest).length;
      while (rest + String(length).length !== length) length = rest + String(length).length;
      return Buffer.from(`${length} ${key}=${value}\n`);
    }),
  );
}

/** The header blocks for one file. A name past 100 bytes or outside
 * plain ASCII, or a file past 8 GB, rides in an extended header, which
 * every current tar reads. */
function fileHeader(name: string, size: number, mode: number, mtime: number): Buffer {
  const fits = Buffer.byteLength(name) <= 100 && /^[\x20-\x7e]*$/.test(name);
  const pax: Record<string, string> = {};
  if (!fits) pax.path = name;
  if (size > MAX_OCTAL) pax.size = String(size);
  const shortName = fits ? name : name.replace(/[^\x20-\x7e]/g, "_").slice(-100);
  const plain = headerBlock(shortName, size > MAX_OCTAL ? 0 : size, mode, mtime, "0");
  if (!Object.keys(pax).length) return plain;
  const body = paxBody(pax);
  return Buffer.concat([headerBlock("PaxHeader", body.length, 0o644, mtime, "x"), body, padding(body.length), plain]);
}

function* fileEntry(name: string, bytes: Buffer, mode: number, mtime: number): Generator<Buffer> {
  yield fileHeader(name, bytes.length, mode, mtime);
  yield bytes;
  yield padding(bytes.length);
}

interface TarEntry {
  name: string;
  size: number;
  mode: number;
  mtime: number;
  type: string;
}

function readNumber(field: Buffer): number {
  // base 256, which some writers use for numbers octal cannot hold
  if (field[0] & 0x80) {
    let n = field[0] & 0x7f;
    for (let i = 1; i < field.length; i++) n = n * 256 + field[i];
    return n;
  }
  const text = field.toString("ascii").replace(/\0.*$/s, "").trim();
  if (!text) return 0;
  if (!/^[0-7]+$/.test(text)) throw damaged("a header holds a number that is not one");
  return parseInt(text, 8);
}

function parseHeader(block: Buffer): TarEntry {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : block[i];
  if (readNumber(block.subarray(148, 156)) !== sum) throw damaged("a header does not add up");
  const text = (from: number, length: number) => {
    const raw = block.subarray(from, from + length);
    const end = raw.indexOf(0);
    return raw.subarray(0, end < 0 ? length : end).toString("utf8");
  };
  let name = text(0, 100);
  if (text(257, 6).startsWith("ustar")) {
    const prefix = text(345, 155);
    if (prefix) name = `${prefix}/${name}`;
  }
  return {
    name,
    mode: readNumber(block.subarray(100, 108)),
    size: readNumber(block.subarray(124, 136)),
    mtime: readNumber(block.subarray(136, 148)) * 1000,
    type: block[156] ? String.fromCharCode(block[156]) : "0",
  };
}

function parsePax(body: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let at = 0;
  while (at < body.length) {
    const space = body.indexOf(0x20, at);
    if (space < 0) break;
    const length = Number(body.subarray(at, space).toString("ascii"));
    if (!Number.isInteger(length) || length <= space - at || at + length > body.length) throw damaged("an extended header is malformed");
    const record = body.subarray(space + 1, at + length - 1).toString("utf8");
    const eq = record.indexOf("=");
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1);
    at += length;
  }
  return out;
}

/** Bytes off a stream in the sizes a reader asks for. */
class ByteReader {
  private chunks: Buffer[] = [];
  private size = 0;
  private ended = false;
  private readonly source: AsyncIterator<Buffer>;

  constructor(source: AsyncIterable<Buffer>) {
    this.source = source[Symbol.asyncIterator]();
  }

  private async fill(n: number): Promise<boolean> {
    while (this.size < n && !this.ended) {
      const next = await this.source.next();
      if (next.done) {
        this.ended = true;
        break;
      }
      const chunk = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value);
      if (chunk.length) {
        this.chunks.push(chunk);
        this.size += chunk.length;
      }
    }
    return this.size >= n;
  }

  /** Exactly `n` bytes, or null when the stream ends first. */
  async read(n: number): Promise<Buffer | null> {
    if (n === 0) return Buffer.alloc(0);
    if (!(await this.fill(n))) return null;
    const all = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks, this.size);
    const rest = all.subarray(n);
    this.chunks = rest.length ? [rest] : [];
    this.size = rest.length;
    return all.subarray(0, n);
  }

  async exact(n: number): Promise<Buffer> {
    const bytes = await this.read(n);
    if (!bytes) throw damaged("it ends early, as if it was cut short while it was written or copied");
    return bytes;
  }

  async atEnd(): Promise<boolean> {
    return !(await this.fill(1));
  }

  /** Reads to the end, so whatever wraps the stream checks its own tail. */
  async drain(): Promise<void> {
    while (await this.fill(1)) {
      this.chunks = [];
      this.size = 0;
    }
  }
}

const isZero = (block: Buffer) => block.every((byte) => byte === 0);

async function walkTar(
  source: AsyncIterable<Buffer>,
  visit: (entry: TarEntry, data: AsyncIterable<Buffer>) => Promise<void>,
): Promise<void> {
  const reader = new ByteReader(source);
  let pax: Record<string, string> = {};
  for (;;) {
    const block = await reader.read(BLOCK);
    if (!block || isZero(block)) break;
    const entry = parseHeader(block);
    const size = pax.size !== undefined ? Number(pax.size) : entry.size;
    if (!Number.isSafeInteger(size) || size < 0) throw damaged("a file claims an impossible size");
    const name = pax.path ?? entry.name;
    pax = {};
    if (entry.type === "x" || entry.type === "g") {
      if (size > 1 << 20) throw damaged("an extended header is too big");
      const body = await reader.exact(size);
      await reader.exact(padding(size).length);
      if (entry.type === "x") pax = parsePax(body);
      continue;
    }
    let left = size;
    const data = (async function* () {
      while (left > 0) {
        const piece = await reader.exact(Math.min(left, PIECE));
        left -= piece.length;
        yield piece;
      }
    })();
    await visit({ ...entry, name, size }, data);
    while (left > 0) left -= (await reader.exact(Math.min(left, PIECE))).length;
    await reader.exact(padding(size).length);
  }
  await reader.drain();
}

// ── sealing ───────────────────────────────────────────────────────────

interface SealedHeader {
  format: number;
  cipher: "aes-256-gcm";
  kdf: { name: "scrypt"; N: number; r: number; p: number; salt: string };
  nonce: string;
  chunk: number;
  /** Proof of the key, not the key: tells a wrong passphrase apart from
   * a changed file. It costs a guesser exactly what trying to open the
   * first piece would, one scrypt per guess. */
  check: string;
  summary: BackupSummary;
}

const keyCheck = (key: Buffer) => createHmac("sha256", key).update("bloks backup passphrase check").digest("hex");

/** A passphrase a new backup can be sealed with. */
export function checkNewPassphrase(passphrase: unknown): string {
  if (typeof passphrase !== "string" || passphrase.length < MIN_PASSPHRASE) {
    throw new BackupError(`A passphrase needs at least ${MIN_PASSPHRASE} characters.`, 400, "passphrase");
  }
  if (passphrase.length > 1024) throw new BackupError("That passphrase is too long.", 400, "passphrase");
  return passphrase;
}

function deriveKey(passphrase: string, kdf: SealedHeader["kdf"]): Promise<Buffer> {
  const salt = Buffer.from(kdf.salt, "base64");
  return new Promise((resolve, reject) =>
    scrypt(
      passphrase.normalize("NFC"),
      salt,
      32,
      { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 256 * kdf.N * kdf.r + (1 << 20) },
      (error, key) => (error ? reject(error) : resolve(key)),
    ),
  );
}

function nonceAt(base: Buffer, index: number): Buffer {
  const nonce = Buffer.from(base);
  nonce.writeUInt32BE((nonce.readUInt32BE(8) ^ index) >>> 0, 8);
  return nonce;
}

/** What each piece is bound to besides its own bytes: the header (so the
 * settings and summary cannot be swapped), its place, and whether it is
 * the last one (so cutting the file short is not a quieter backup). */
function boundTo(headerHash: Buffer, index: number, final: boolean): Buffer {
  const tail = Buffer.alloc(5);
  tail.writeUInt32BE(index, 0);
  tail[4] = final ? 1 : 0;
  return Buffer.concat([headerHash, tail]);
}

function sealPiece(key: Buffer, base: Buffer, headerHash: Buffer, index: number, plain: Buffer, final: boolean): Buffer {
  const cipher = createCipheriv("aes-256-gcm", key, nonceAt(base, index));
  cipher.setAAD(boundTo(headerHash, index, final));
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  const frame = Buffer.alloc(5);
  frame[0] = final ? 1 : 0;
  frame.writeUInt32BE(plain.length, 1);
  return Buffer.concat([frame, body, cipher.getAuthTag()]);
}

async function sealer(passphrase: string, summary: BackupSummary) {
  const nonce = randomBytes(12);
  const kdf: SealedHeader["kdf"] = { name: "scrypt", ...SCRYPT, salt: randomBytes(16).toString("base64") };
  const key = await deriveKey(passphrase, kdf);
  const header: SealedHeader = {
    format: BACKUP_FORMAT,
    cipher: "aes-256-gcm",
    kdf,
    nonce: nonce.toString("base64"),
    chunk: CHUNK,
    check: keyCheck(key),
    summary,
  };
  const json = Buffer.from(JSON.stringify(header));
  const length = Buffer.alloc(4);
  length.writeUInt32BE(json.length);
  const head = Buffer.concat([MAGIC, length, json]);
  const headerHash = createHash("sha256").update(head).digest();
  return async function* (source: AsyncIterable<Buffer>) {
    yield head;
    let parts: Buffer[] = [];
    let size = 0;
    let index = 0;
    for await (const chunk of source) {
      parts.push(chunk);
      size += chunk.length;
      if (size <= CHUNK) continue;
      let all = Buffer.concat(parts, size);
      // strictly more than a piece: the last piece must be the one marked
      while (all.length > CHUNK) {
        yield sealPiece(key, nonce, headerHash, index++, all.subarray(0, CHUNK), false);
        all = all.subarray(CHUNK);
      }
      parts = [all];
      size = all.length;
    }
    yield sealPiece(key, nonce, headerHash, index, Buffer.concat(parts, size), true);
  };
}

function parseSealedHeader(json: Buffer): SealedHeader {
  let header: SealedHeader;
  try {
    header = JSON.parse(json.toString("utf8"));
  } catch {
    throw notABackup();
  }
  const kdf = header?.kdf;
  const sane =
    header?.cipher === "aes-256-gcm" &&
    kdf?.name === "scrypt" &&
    Number.isInteger(kdf.N) &&
    kdf.N >= 1 << 14 &&
    (kdf.N & (kdf.N - 1)) === 0 &&
    Number.isInteger(kdf.r) &&
    kdf.r >= 1 &&
    Number.isInteger(kdf.p) &&
    kdf.p >= 1 &&
    kdf.p <= 4 &&
    // a crafted file must not be a way to ask for gigabytes of memory
    128 * kdf.N * kdf.r <= 512 * 1024 * 1024 &&
    typeof kdf.salt === "string" &&
    typeof header.nonce === "string" &&
    Buffer.from(header.nonce, "base64").length === 12 &&
    typeof header.check === "string" &&
    /^[0-9a-f]{64}$/.test(header.check) &&
    Number.isInteger(header.chunk) &&
    header.chunk > 0 &&
    header.chunk <= 16 * CHUNK;
  if (!sane) throw notABackup();
  if (header.format > BACKUP_FORMAT) throw newer();
  return header;
}

const newer = () => new BackupError("This backup was made by a newer Bloks. Update Bloks to read it.", 422, "refused");
const wrongPassphrase = () => new BackupError("That passphrase does not open this backup.", 400, "passphrase");

async function* unseal(source: AsyncIterable<Buffer>, passphrase: string): AsyncGenerator<Buffer> {
  const reader = new ByteReader(source);
  const start = await reader.read(MAGIC.length + 4);
  if (!start || !start.subarray(0, MAGIC.length).equals(MAGIC)) throw notABackup();
  const length = start.readUInt32BE(MAGIC.length);
  if (length > MAX_HEADER) throw notABackup();
  const json = await reader.exact(length);
  const header = parseSealedHeader(json);
  const headerHash = createHash("sha256").update(Buffer.concat([start, json])).digest();
  const key = await deriveKey(passphrase, header.kdf);
  if (!timingSafeEqual(Buffer.from(keyCheck(key)), Buffer.from(header.check))) throw wrongPassphrase();
  const base = Buffer.from(header.nonce, "base64");
  for (let index = 0; ; index++) {
    const frame = await reader.read(5);
    if (!frame) throw damaged("it ends early, as if it was cut short while it was written or copied");
    const final = frame[0] === 1;
    const size = frame.readUInt32BE(1);
    if (frame[0] > 1 || size > header.chunk) throw damaged("a sealed piece is malformed");
    const body = await reader.exact(size + 16);
    const decipher = createDecipheriv("aes-256-gcm", key, nonceAt(base, index));
    decipher.setAAD(boundTo(headerHash, index, final));
    decipher.setAuthTag(body.subarray(size));
    let plain: Buffer;
    try {
      plain = Buffer.concat([decipher.update(body.subarray(0, size)), decipher.final()]);
    } catch {
      // the key is right (the check said so), so this piece was changed,
      // moved, or is not the one that ends it
      throw damaged("it has been changed since it was made");
    }
    yield plain;
    if (final) {
      if (!(await reader.atEnd())) throw damaged("something was added after its end");
      return;
    }
  }
}

function isSealed(file: string): boolean {
  const fd = openSync(file, "r");
  try {
    const head = Buffer.alloc(MAGIC.length);
    return readSync(fd, head, 0, head.length, 0) === head.length && head.equals(MAGIC);
  } finally {
    closeSync(fd);
  }
}

// ── reading a backup ──────────────────────────────────────────────────

function checkSummary(value: unknown): BackupSummary {
  if (!isRecord(value) || value.app !== "bloks" || typeof value.format !== "number") throw notABackup();
  if (value.format > BACKUP_FORMAT) throw newer();
  const kind: BackupKind = value.kind === "automatic" || value.kind === "before-restore" ? value.kind : "manual";
  return {
    format: value.format,
    app: "bloks",
    version: typeof value.version === "string" ? value.version.slice(0, 40) : "",
    created: typeof value.created === "number" ? value.created : 0,
    kind,
    undo: value.undo === true,
    secrets: value.secrets === true,
  };
}

/** What a backup is, from its first few kilobytes: the clear header of a
 * sealed one (no passphrase needed), or the first entry of a plain one. */
export function readBackupSummary(file: string): { summary: BackupSummary; encrypted: boolean } {
  const fd = openSync(file, "r");
  try {
    for (const want of [8 * 1024, 64 * 1024]) {
      const buffer = Buffer.alloc(want);
      const bytes = buffer.subarray(0, readSync(fd, buffer, 0, want, 0));
      if (bytes.subarray(0, MAGIC.length).equals(MAGIC)) {
        if (bytes.length < MAGIC.length + 4) throw notABackup();
        const length = bytes.readUInt32BE(MAGIC.length);
        if (length > MAX_HEADER) throw notABackup();
        if (bytes.length < MAGIC.length + 4 + length) {
          if (bytes.length < want) throw notABackup();
          continue;
        }
        const header = parseSealedHeader(bytes.subarray(MAGIC.length + 4, MAGIC.length + 4 + length));
        return { summary: checkSummary(header.summary), encrypted: true };
      }
      let tar: Buffer;
      try {
        // a prefix of the stream, unpacked as far as it goes
        tar = gunzipSync(bytes, { finishFlush: zlib.Z_SYNC_FLUSH });
      } catch {
        throw notABackup();
      }
      if (tar.length >= BLOCK) {
        const entry = parseHeader(tar.subarray(0, BLOCK));
        if (entry.name !== SUMMARY_ENTRY || entry.size > 64 * 1024) throw notABackup();
        if (tar.length >= BLOCK + entry.size) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(tar.subarray(BLOCK, BLOCK + entry.size).toString("utf8"));
          } catch {
            throw notABackup();
          }
          return { summary: checkSummary(parsed), encrypted: false };
        }
      }
      if (bytes.length < want) throw notABackup();
    }
    throw notABackup();
  } finally {
    closeSync(fd);
  }
}

async function readArchive(
  file: string,
  passphrase: string | undefined,
  visit: (entry: TarEntry, data: AsyncIterable<Buffer>) => Promise<void>,
): Promise<void> {
  const sealed = isSealed(file);
  if (sealed && !passphrase) {
    throw new BackupError("This backup is sealed. Enter its passphrase to open it.", 400, "passphrase");
  }
  const walk = (source: AsyncIterable<Buffer>) => walkTar(source, visit);
  try {
    if (sealed) {
      await pipeline(createReadStream(file), (source: AsyncIterable<Buffer>) => unseal(source, passphrase!), createGunzip(), walk);
    } else {
      await pipeline(createReadStream(file), createGunzip(), walk);
    }
  } catch (error) {
    if (error instanceof BackupError) throw error;
    // zlib names its own errors Z_*: the bytes are not a whole gzip stream
    if (/^Z_/.test(String((error as NodeJS.ErrnoException)?.code ?? ""))) throw damaged("it does not unpack");
    throw error;
  }
}

async function bytesOf(data: AsyncIterable<Buffer>, limit: number): Promise<Buffer> {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const piece of data) {
    size += piece.length;
    if (size > limit) throw damaged("an entry is far bigger than it should be");
    parts.push(piece);
  }
  return Buffer.concat(parts, size);
}

async function hashOf(data: AsyncIterable<Buffer>): Promise<string> {
  const hash = createHash("sha256");
  for await (const piece of data) hash.update(piece);
  return hash.digest("hex");
}

/** The path an entry may be written to inside the workspace, or null for
 * one that would land anywhere else. */
export function safeEntryPath(name: string): string | null {
  if (!name.startsWith(DATA_PREFIX)) return null;
  const rel = name.slice(DATA_PREFIX.length);
  if (!rel || rel.length > 4096 || rel.includes("\0") || rel.includes("\\")) return null;
  const parts = rel.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return null;
  if (process.platform === "win32" && parts.some((part) => /[:<>|?*"]/.test(part))) return null;
  return rel;
}

type Writer = (rel: string, entry: TarEntry, data: AsyncIterable<Buffer>) => Promise<string>;

interface Scan {
  summary: BackupSummary;
  manifest: Manifest | null;
  files: number;
  bytes: number;
  problems: string[];
}

/** Reads a backup end to end and holds it to its manifest. With a writer,
 * each file that may be written is handed to it as it goes by. A file
 * that would land outside the workspace, or is a link, is never handed
 * over: it becomes a problem instead. */
async function scan(file: string, passphrase: string | undefined, write?: Writer): Promise<Scan> {
  const problems: string[] = [];
  let unsaid = 0;
  const problem = (what: string) => {
    if (problems.length < MAX_PROBLEMS) problems.push(what);
    else unsaid++;
  };
  const seen = new Map<string, { size: number; sha256: string }>();
  let summary: BackupSummary | null = null;
  let manifest: Manifest | null = null;
  let unreadable = false;
  let bytes = 0;
  await readArchive(file, passphrase, async (entry, data) => {
    if (!summary) {
      if (entry.name !== SUMMARY_ENTRY) throw notABackup();
      let parsed: unknown;
      try {
        parsed = JSON.parse((await bytesOf(data, 64 * 1024)).toString("utf8"));
      } catch (error) {
        if (error instanceof BackupError) throw error;
        throw notABackup();
      }
      summary = checkSummary(parsed);
      return;
    }
    if (entry.name === MANIFEST_ENTRY && !manifest && !unreadable) {
      try {
        const parsed = JSON.parse((await bytesOf(data, MAX_JSON)).toString("utf8"));
        if (!isRecord(parsed) || !Array.isArray(parsed.files)) throw new Error();
        manifest = parsed as unknown as Manifest;
      } catch (error) {
        if (error instanceof BackupError) throw error;
        problem("its manifest cannot be read");
        unreadable = true;
      }
      return;
    }
    if (manifest) {
      problem(`${entry.name} comes after the manifest`);
      return;
    }
    if (entry.type === "5") return; // a folder: made as its files need it
    const rel = safeEntryPath(entry.name);
    if (!rel) {
      problem(`${entry.name} would land outside the workspace, so it was not read`);
      return;
    }
    if (entry.type !== "0") {
      problem(`${rel} is a link or a device, which a Bloks backup never holds`);
      return;
    }
    if (seen.has(rel)) {
      problem(`${rel} is in it twice`);
      return;
    }
    const sha256 = write ? await write(rel, entry, data) : await hashOf(data);
    seen.set(rel, { size: entry.size, sha256 });
    bytes += entry.size;
  });
  // assigned inside the visitor, which the compiler cannot follow
  const read = summary as BackupSummary | null;
  const found = manifest as Manifest | null;
  if (!read) throw notABackup();
  if (!found) {
    if (!unreadable) problem("its manifest is missing, so its files cannot be checked");
  } else {
    const listed = new Set<string>();
    for (const item of found.files) {
      if (!isRecord(item) || typeof item.path !== "string") continue;
      listed.add(item.path);
      const got = seen.get(item.path);
      if (!got) problem(`${item.path} is missing`);
      else if (got.sha256 !== item.sha256 || got.size !== item.size) problem(`${item.path} has changed since the backup was made`);
    }
    for (const rel of seen.keys()) if (!listed.has(rel)) problem(`${rel} is not in its manifest`);
  }
  if (unsaid) problems.push(`and ${unsaid} more`);
  return { summary: read, manifest: found, files: seen.size, bytes, problems };
}

/** Reads a whole backup and checks every file against its manifest. A
 * backup that is damaged answers with the damage as its problem rather
 * than as a failure; a sealed one needs its passphrase. */
export async function verifyBackup(file: string, passphrase?: string): Promise<VerifyResult> {
  try {
    const result = await scan(file, passphrase);
    return { ok: result.problems.length === 0, files: result.files, bytes: result.bytes, problems: result.problems };
  } catch (error) {
    if (error instanceof BackupError && error.code === "damaged") {
      return { ok: false, files: 0, bytes: 0, problems: [error.message] };
    }
    throw error;
  }
}

/** Opens a backup far enough to know it can be restored: it is one, and
 * a sealed one opens with this passphrase. Cheap, so a restore can say
 * no before it stops anything. */
export async function checkBackup(file: string, passphrase?: string): Promise<BackupSummary> {
  const { summary, encrypted } = readBackupSummary(file);
  if (!encrypted) return summary;
  if (!passphrase) throw new BackupError("This backup is sealed. Enter its passphrase to restore it.", 400, "passphrase");
  const stream = createReadStream(file);
  try {
    const pieces = unseal(stream, passphrase);
    await pieces.next();
    await pieces.return(undefined);
  } finally {
    stream.destroy();
  }
  return summary;
}

// ── making one ────────────────────────────────────────────────────────

export interface CreateOptions {
  kind?: BackupKind;
  /** Include the Undo history. */
  undo?: boolean;
  /** Seal it with this. */
  passphrase?: string;
  /** Include saved keys. Only with a passphrase, and on by default then. */
  secrets?: boolean;
  dataDir?: string;
  version?: string;
  now?: Date;
}

/** config.json as it goes into a backup: whole when keys go in, without
 * them otherwise. Null when it cannot be read, since a file whose keys
 * cannot be found cannot have them taken out. */
function configForBackup(file: string, keepKeys: boolean): { bytes: Buffer; leftOut: string[]; mtime: number } | null {
  let text: string;
  let mtime: number;
  try {
    text = readFileSync(file, "utf8");
    mtime = Math.floor(statSync(file).mtimeMs);
  } catch {
    return null;
  }
  if (keepKeys) return { bytes: Buffer.from(text), leftOut: [], mtime };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const leftOut = stripSecrets(parsed);
  return { bytes: Buffer.from(`${JSON.stringify(parsed, null, 2)}\n`), leftOut, mtime };
}

async function* archive(dataDir: string, plan: Plan, summary: BackupSummary): AsyncGenerator<Buffer> {
  yield* fileEntry(SUMMARY_ENTRY, Buffer.from(`${JSON.stringify(summary, null, 2)}\n`), 0o600, summary.created);
  const files: ManifestFile[] = [];
  const secretsLeftOut: string[] = [];
  const leftOut = [...plan.leftOut];
  const notes: string[] = [];
  let bytes = 0;
  for (const rel of plan.files) {
    const abs = join(dataDir, ...rel.split("/"));
    // config.json moved aside as unreadable, or a save's leftover: either
    // may hold every key in full, and neither can be read to take them out
    if (!summary.secrets && rel.startsWith("config.json.")) {
      leftOut.push(`${rel} (an old copy of config.json, which may hold keys)`);
      continue;
    }
    if (rel === "config.json") {
      const config = configForBackup(abs, summary.secrets);
      if (!config) {
        leftOut.push("config.json (it could not be read, so it was left out rather than risk the keys in it)");
        continue;
      }
      secretsLeftOut.push(...config.leftOut);
      yield* fileEntry(DATA_PREFIX + rel, config.bytes, 0o600, config.mtime);
      const sha256 = createHash("sha256").update(config.bytes).digest("hex");
      files.push({ path: rel, size: config.bytes.length, sha256, mode: 0o600, mtime: config.mtime });
      bytes += config.bytes.length;
      continue;
    }
    let handle;
    try {
      handle = await open(abs, "r");
    } catch (error) {
      // gone since the folder was listed: a temp file, a closed lane
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    try {
      // Sizes come from the open file. A store replaces its file by
      // renaming a new one over it, so what is open stays one whole
      // version; a log being appended to is read up to where it was.
      const st = await handle.stat();
      if (!st.isFile()) continue;
      const size = st.size;
      const mode = st.mode & 0o777;
      const mtime = Math.floor(st.mtimeMs);
      yield fileHeader(DATA_PREFIX + rel, size, mode, mtime);
      const hash = createHash("sha256");
      let done = 0;
      while (done < size) {
        const want = Math.min(PIECE, size - done);
        const buffer = Buffer.allocUnsafe(want);
        const { bytesRead } = await handle.read(buffer, 0, want, done);
        if (bytesRead === 0) break;
        const piece = buffer.subarray(0, bytesRead);
        hash.update(piece);
        done += bytesRead;
        yield piece;
      }
      if (done < size) {
        // cut shorter while it was read: the archive needs the size it
        // promised, so the rest is zeros, and the manifest says which
        const fill = Buffer.alloc(size - done);
        hash.update(fill);
        yield fill;
        notes.push(`${rel} got shorter while it was being backed up; its copy ends in zeros`);
      }
      yield padding(size);
      files.push({ path: rel, size, sha256: hash.digest("hex"), mode, mtime });
      bytes += size;
    } finally {
      await handle.close();
    }
  }
  const manifest: Manifest = { ...summary, files, bytes, secretsLeftOut, leftOut, notes };
  yield* fileEntry(MANIFEST_ENTRY, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`), 0o600, summary.created);
  yield Buffer.alloc(BLOCK * 2);
}

function freeName(dir: string, name: string): string {
  if (!existsSync(join(dir, name))) return name;
  const ext = name.endsWith(SEALED_EXT) ? SEALED_EXT : PLAIN_EXT;
  const stem = name.slice(0, -ext.length);
  for (let n = 2; ; n++) {
    const next = `${stem}-${n}${ext}`;
    if (!existsSync(join(dir, next))) return next;
  }
}

function ensureBackupsDir(dir: string) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    /* a filesystem without modes */
  }
}

/** Writes one backup of the data folder and says what it wrote. The file
 * appears only once it is whole: it is written beside its name and
 * renamed into place. */
export async function createBackup(opts: CreateOptions = {}): Promise<BackupInfo> {
  const dataDir = opts.dataDir ?? DATA_DIR;
  const backupsDir = backupsDirFor(dataDir);
  const passphrase = opts.passphrase ? checkNewPassphrase(opts.passphrase) : undefined;
  const secrets = opts.secrets ?? Boolean(passphrase);
  if (secrets && !passphrase) {
    throw new BackupError("Saved keys only go into a backup sealed with a passphrase.", 400, "passphrase");
  }
  if (!existsSync(dataDir)) throw new BackupError("There is no workspace to back up yet.", 404, "missing");
  const at = opts.now ?? new Date();
  const version = opts.version ?? APP_VERSION;
  const summary: BackupSummary = {
    format: BACKUP_FORMAT,
    app: "bloks",
    version,
    created: at.getTime(),
    kind: opts.kind ?? "manual",
    undo: Boolean(opts.undo),
    secrets,
  };
  ensureBackupsDir(backupsDir);
  const name = freeName(backupsDir, backupFileName(at, version, summary.kind, Boolean(passphrase)));
  const file = join(backupsDir, name);
  const partial = `${file}.partial`;
  const plan = await collect(dataDir, summary.undo);
  let mine = false;
  try {
    // wx: a second backup choosing the same name in the same second (the
    // command line beside the app) fails rather than writing into this one
    const out = createWriteStream(partial, { flags: "wx", mode: 0o600, flush: true });
    out.once("open", () => (mine = true));
    const tar = Readable.from(archive(dataDir, plan, summary));
    if (passphrase) await pipeline(tar, createGzip(), await sealer(passphrase, summary), out);
    else await pipeline(tar, createGzip(), out);
    renameSync(partial, file);
  } catch (error) {
    if (mine) rmSync(partial, { force: true });
    throw error;
  }
  return { ...summary, name, path: file, size: statSync(file).size, encrypted: Boolean(passphrase) };
}

// ── the list ──────────────────────────────────────────────────────────

/** Every backup in the folder, newest first. One whose start cannot be
 * read is still listed, marked damaged, so it can be deleted. */
export function listBackups(dataDir = DATA_DIR): BackupInfo[] {
  const dir = backupsDirFor(dataDir);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: BackupInfo[] = [];
  for (const name of names) {
    if (!isBackupName(name)) continue;
    const path = join(dir, name);
    let size: number;
    let mtime: number;
    try {
      const st = statSync(path);
      if (!st.isFile()) continue;
      size = st.size;
      mtime = st.mtimeMs;
    } catch {
      continue;
    }
    try {
      const { summary, encrypted } = readBackupSummary(path);
      out.push({ ...summary, name, path, size, encrypted });
    } catch {
      out.push({
        format: 0,
        app: "bloks",
        version: "",
        created: Math.floor(mtime),
        kind: name.includes("-auto") ? "automatic" : "manual",
        undo: false,
        secrets: false,
        name,
        path,
        size,
        encrypted: name.endsWith(SEALED_EXT),
        damaged: true,
      });
    }
  }
  return out.sort((a, b) => b.created - a.created || (a.name < b.name ? 1 : -1));
}

/** The file behind a name from the list, or a refusal a route can say. */
export function backupPath(name: unknown, dataDir = DATA_DIR): string {
  if (typeof name !== "string" || !isBackupName(name)) throw new BackupError("That is not the name of a backup.", 400);
  const path = join(backupsDirFor(dataDir), name);
  if (!existsSync(path)) throw new BackupError("There is no backup by that name.", 404, "missing");
  return path;
}

export function deleteBackup(name: unknown, dataDir = DATA_DIR): void {
  unlinkSync(backupPath(name, dataDir));
}

/** Keeps the newest automatic backups and deletes the rest of them, and
 * clears any half-written file a stopped backup left behind. Manual
 * backups and the ones taken before a restore are never touched. */
export function pruneAutomatic(dataDir = DATA_DIR, keep = AUTO_KEEP, now = Date.now()): string[] {
  const dir = backupsDirFor(dataDir);
  const gone: string[] = [];
  for (const backup of listBackups(dataDir).filter((b) => b.kind === "automatic" && !b.damaged).slice(keep)) {
    try {
      unlinkSync(backup.path);
      gone.push(backup.name);
    } catch {
      /* already gone */
    }
  }
  try {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".partial")) continue;
      const path = join(dir, name);
      // a day untouched: long past any backup still being written
      if (now - statSync(path).mtimeMs > AUTO_EVERY_MS) rmSync(path, { force: true });
    }
  } catch {
    /* no folder yet */
  }
  return gone;
}

/** Whether the daily backup should be made now: switched on, nothing
 * running and nothing else under way, and none made in the last day. A
 * newest one dated well past now is a clock that moved, not a reason to
 * stop backing up. */
export function autoBackupDue(input: { enabled: boolean; idle: boolean; newestAt: number | null; now: number }): boolean {
  if (!input.enabled || !input.idle) return false;
  if (input.newestAt === null) return true;
  if (input.newestAt > input.now + 60 * 60_000) return true;
  return input.now - input.newestAt >= AUTO_EVERY_MS;
}

/** When the newest automatic backup was made, or null with none. */
export function newestAutomatic(dataDir = DATA_DIR): number | null {
  const found = listBackups(dataDir).find((b) => b.kind === "automatic" && !b.damaged);
  return found ? found.created : null;
}

/** How each system shows a file in its file manager. */
export function revealCommand(file: string, platform: NodeJS.Platform = process.platform): { command: string; args: string[] } {
  if (platform === "darwin") return { command: "open", args: ["-R", file] };
  if (platform === "win32") return { command: "explorer.exe", args: [`/select,${file}`] };
  return { command: "xdg-open", args: [dirname(file)] };
}

export function revealBackup(file: string): boolean {
  const { command, args } = revealCommand(file);
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

// ── putting one back ──────────────────────────────────────────────────

async function writeStaged(root: string, rel: string, entry: TarEntry, data: AsyncIterable<Buffer>): Promise<string> {
  const target = join(root, ...rel.split("/"));
  if (!target.startsWith(root + sep)) throw damaged(`${rel} would land outside the workspace`);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  // owner read and write always, never group or other write
  const handle = await open(target, "wx", (entry.mode & 0o755) | 0o600);
  const hash = createHash("sha256");
  try {
    for await (const piece of data) {
      hash.update(piece);
      await handle.write(piece);
    }
  } finally {
    await handle.close();
  }
  if (entry.mtime > 0) await utimes(target, entry.mtime / 1000, entry.mtime / 1000).catch(() => {});
  return hash.digest("hex");
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** A backup that came without keys keeps this computer's: restoring last
 * week's agents is not meant to sign every engine out. */
function keepTheseKeys(dataDir: string, staging: string) {
  const current = readJson(join(dataDir, "config.json"));
  if (!isRecord(current)) return;
  const file = join(staging, "config.json");
  const restored = existsSync(file) ? readJson(file) : {};
  if (!isRecord(restored)) return;
  carrySecrets(current, restored);
  writeFileAtomic(file, JSON.stringify(restored, null, 2), 0o600);
}

/**
 * Unpacks a backup into a folder beside the data folder, checks every
 * file against the manifest, and leaves the note that has the next start
 * swap it in. Nothing in the data folder changes here. A backup that does
 * not check out is removed again, and no note is left.
 */
export async function stageRestore(
  file: string,
  opts: { passphrase?: string; dataDir?: string; safety?: string; now?: Date } = {},
): Promise<PendingRestore> {
  const dataDir = opts.dataDir ?? DATA_DIR;
  const target = targetOf(dataDir);
  const stamp = stampOf(opts.now ?? new Date());
  const staging = `${target}.restoring-${stamp}`;
  const aside = `${target}.before-restore-${stamp}`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true, mode: 0o700 });
  let keys: PendingRestore["keys"];
  try {
    const result = await scan(file, opts.passphrase, (rel, entry, data) => writeStaged(staging, rel, entry, data));
    if (result.problems.length) {
      throw new BackupError(`This backup did not check out, so nothing was changed: ${result.problems.slice(0, 3).join("; ")}.`, 422, "damaged");
    }
    keys = result.summary.secrets ? "restored" : "kept";
    if (keys === "kept") keepTheseKeys(dataDir, staging);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    if ((error as NodeJS.ErrnoException)?.code === "ENOTDIR" || (error as NodeJS.ErrnoException)?.code === "EEXIST") {
      throw damaged("its files and folders do not fit together");
    }
    throw error;
  }
  const pending: PendingRestore = { from: basename(file), target, staging, aside, at: Date.now(), safety: opts.safety, keys };
  writeFileAtomic(markerFor(dataDir), JSON.stringify(pending, null, 2), 0o600);
  return pending;
}

/** The restore waiting for the next start, if one is. */
export function pendingRestore(dataDir = DATA_DIR): PendingRestore | null {
  const found = readJson(markerFor(dataDir));
  return isRecord(found) && typeof found.staging === "string" ? (found as unknown as PendingRestore) : null;
}

/** The last restore applied, for the page that asked for it to say so. */
export function lastRestore(dataDir = DATA_DIR): AppliedRestore | null {
  return readSaved<AppliedRestore | null>(join(backupsDirFor(dataDir), LAST_RESTORE), null, isRecord);
}

/**
 * Backs up the workspace as it is, then stages the backup in `file` for
 * the next start (stageRestore). The fresh backup comes first and a
 * failure to make it stops the restore: what is replaced must be kept
 * twice, once in that backup and once in the folder moved aside.
 */
export async function restoreBackup(
  file: string,
  opts: { passphrase?: string; dataDir?: string; now?: Date } = {},
): Promise<{ safety: BackupInfo | null; pending: PendingRestore }> {
  await checkBackup(file, opts.passphrase);
  const dataDir = opts.dataDir ?? DATA_DIR;
  const safety = existsSync(dataDir) ? await createBackup({ kind: "before-restore", dataDir, now: opts.now }) : null;
  const pending = await stageRestore(file, { passphrase: opts.passphrase, dataDir, safety: safety?.name, now: opts.now });
  return { safety, pending };
}

function renameRetrying(from: string, to: string) {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // Windows refuses a folder rename while a scanner has a file in it
      if ((code === "EPERM" || code === "EBUSY" || code === "EACCES") && attempt < 5) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100 * (attempt + 1));
        continue;
      }
      throw error;
    }
  }
}

/** Unpacked copies a stopped restore left behind, with no note to say
 * they are wanted. Each one is only ever a copy of a backup file. */
function sweepStaging(target: string) {
  const prefix = `${basename(target)}.restoring-`;
  try {
    for (const name of readdirSync(dirname(target))) {
      if (name.startsWith(prefix)) rmSync(join(dirname(target), name), { recursive: true, force: true });
    }
  } catch {
    /* nothing to sweep */
  }
}

/**
 * Swaps a staged restore in, if one is waiting. Called as the server
 * starts, before any store reads the data folder, and by the command
 * line when no server is running. Left alone while another Bloks holds
 * the folder: that one applies it when it next starts.
 *
 * Throws when a swap cannot finish, after putting back what it moved;
 * the note stays, so the next start tries again.
 */
export function applyPendingRestore(opts: { dataDir?: string; log?: (line: string) => void } = {}): AppliedRestore | null {
  const dataDir = opts.dataDir ?? DATA_DIR;
  const log = opts.log ?? ((line: string) => console.log(line));
  const target = targetOf(dataDir);
  if (holderOf(target)) return null;
  const marker = markerFor(dataDir);
  const pending = pendingRestore(dataDir);
  if (!pending) {
    if (existsSync(marker)) rmSync(marker, { force: true });
    sweepStaging(target);
    return null;
  }
  const fits =
    pending.target === target &&
    pending.staging.startsWith(`${target}.restoring-`) &&
    pending.aside.startsWith(`${target}.before-restore-`) &&
    !pending.staging.slice(target.length).includes(sep) &&
    !pending.aside.slice(target.length).includes(sep);
  if (!fits || !existsSync(pending.staging)) {
    log("[bloks] a restore was waiting, but its unpacked copy is not where it should be, so the workspace stays as it is");
    rmSync(marker, { force: true });
    sweepStaging(target);
    return null;
  }
  const hadWorkspace = existsSync(target);
  if (hadWorkspace) {
    try {
      renameRetrying(target, pending.aside);
    } catch (error) {
      throw new Error(`could not move the workspace aside to restore ${pending.from} (${(error as NodeJS.ErrnoException).code}); nothing was changed`);
    }
  }
  try {
    renameRetrying(pending.staging, target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (hadWorkspace) {
      try {
        renameRetrying(pending.aside, target);
      } catch {
        throw new Error(
          `could not finish restoring ${pending.from} (${code}). Your workspace is at ${pending.aside}; rename it back to ${target} to use it as it was`,
        );
      }
    }
    throw new Error(`could not restore ${pending.from} (${code}); the workspace stays as it was`);
  }
  rmSync(marker, { force: true });
  // the lock of the server that stopped for this, which went with it
  if (hadWorkspace) rmSync(join(pending.aside, "server.lock"), { force: true });
  const applied: AppliedRestore = {
    from: pending.from,
    at: Date.now(),
    aside: hadWorkspace ? pending.aside : "",
    safety: pending.safety,
    keys: pending.keys,
  };
  try {
    ensureBackupsDir(backupsDirFor(dataDir));
    writeFileAtomic(join(backupsDirFor(dataDir), LAST_RESTORE), JSON.stringify(applied, null, 2), 0o600);
  } catch {
    /* the restore happened; only the note about it is missing */
  }
  log(
    `[bloks] restored the workspace from ${pending.from}${hadWorkspace ? `; the one it replaced is at ${pending.aside}` : ""}`,
  );
  return applied;
}
