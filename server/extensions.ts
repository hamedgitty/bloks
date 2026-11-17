// Workspace extensions: a panel, a few commands and a handful of event
// handlers, in one folder the owner installs (GitHub 507).
//
// An extension is somebody else's code, so it is treated the way an MCP
// server's interface is (server/mcp-apps.ts) and a step further:
//
//   It never runs as the owner. Its documents are served with a policy
//   that makes them a sandbox of their own, an opaque origin with no
//   network of any kind, and the only thing they can do is pass a message
//   to the app's page beside them. The page decides which messages are
//   requests at all, and the server decides again whether this extension
//   was granted what the request needs. Nothing an extension says is ever
//   a request to the API in its own right: it has no credential, it can
//   reach no address, and the page it talks to is the only one listening.
//
//   It asks for what it wants in its manifest, and the owner is shown
//   that list, in words, before anything is installed. What was shown is
//   what is granted: an install that names other permissions, or files
//   that changed after they were looked at, is refused.
//
//   The files are copied in at install, from the bytes that were hashed,
//   and that hash is checked again every time a document is served. An
//   agent able to write into the data folder cannot quietly change what
//   the owner approved; the extension stops being served instead.
//
//   It has no way to a secret. No saved secret, connection, key, token or
//   agent credential is in anything it can ask for, and with no network
//   it would have nowhere to send one. A capability that needs a
//   credential is not something an extension can have; that is what MCP
//   servers and connections are for.
//
// Pure apart from the file reads and writes it is handed paths for, so
// the rules can be tested without a server. The routes are in
// server/index.ts, the page's half in src/lib/extensions.ts.
import { createHash, randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import type { AppTheme } from "./mcp-apps.ts";

/** The file at the top of an extension's folder that says what it is. */
export const MANIFEST_FILE = "bloks-extension.json";

/** Everything with a size an extension can have, in one place. */
export const EXTENSION_LIMITS = {
  /** Files in the folder, the manifest included. */
  files: 200,
  /** All of them together. */
  bytes: 5 * 1024 * 1024,
  /** Any one of them. */
  fileBytes: 2 * 1024 * 1024,
  manifestBytes: 64 * 1024,
  panels: 4,
  commands: 20,
  settings: 12,
  /** What it may keep in its own storage, as JSON. */
  storageBytes: 256 * 1024,
  storageKey: 100,
  /** One call's parameters, as JSON. */
  callBytes: 64 * 1024,
  /** Messages to agents an hour, for each extension (agents.message). */
  messagesPerHour: 12,
  messageChars: 4_000,
  /** Installed in one workspace. */
  installed: 30,
} as const;

/**
 * What an extension can ask for, and how the install screen says it.
 * `high` is said beside the permission in a warning colour: those reach
 * past the extension's own panel into what agents do.
 */
export const PERMISSIONS = {
  "agents:read": { words: "See your agents' names and whether each one is working", high: false },
  "turns:read": { words: "Know when an agent starts and finishes a turn, without what was said", high: false },
  "agents:message": { words: "Send a message to one of your agents when you run one of its commands. The agent acts on it with its usual approvals.", high: true },
  "composer:write": { words: "Put words in an agent's message box for you to read and send", high: false },
  storage: { words: "Keep its own data in this workspace, up to 256 KB", high: false },
  notifications: { words: "Show short notices in the app", high: false },
} as const;

export type Permission = keyof typeof PERMISSIONS;
export const PERMISSION_IDS = Object.keys(PERMISSIONS) as Permission[];

/**
 * The workspace events an extension can handle, and the permission each
 * needs. Small on purpose: each is a fact about the workspace with no
 * words of anybody's in it.
 */
export const EVENTS = {
  "turn.started": "turns:read",
  "turn.finished": "turns:read",
  "agents.changed": "agents:read",
  "selection.changed": "agents:read",
  "theme.changed": null,
} as const satisfies Record<string, Permission | null>;

export type ExtensionEventName = keyof typeof EVENTS;

/** Calls the server answers, and the permission each needs. */
export const SERVER_METHODS = {
  "agents.list": "agents:read",
  "agents.message": "agents:message",
  "storage.get": "storage",
  "storage.set": "storage",
  "storage.remove": "storage",
  "settings.get": null,
} as const satisfies Record<string, Permission | null>;

/** Calls the app's page answers itself, never reaching the server. Listed
 * here too so the two halves can be held to one table (a test does). */
export const PAGE_METHODS = {
  "agents.selected": "agents:read",
  "composer.insert": "composer:write",
  notify: "notifications",
  "panel.open": null,
} as const satisfies Record<string, Permission | null>;

export type ServerMethod = keyof typeof SERVER_METHODS;

export interface ExtensionPanel {
  id: string;
  title: string;
  /** An HTML file in the folder. */
  entry: string;
}

export interface ExtensionCommand {
  id: string;
  title: string;
  description?: string;
}

export type SettingType = "text" | "boolean" | "number";

export interface ExtensionSetting {
  key: string;
  label: string;
  type: SettingType;
  default: string | boolean | number;
}

export interface ExtensionManifest {
  manifestVersion: 1;
  id: string;
  name: string;
  version: string;
  description: string;
  author?: string;
  /** The Bloks versions it works with, as a range (satisfiesRange). */
  bloks: string;
  permissions: Permission[];
  panels: ExtensionPanel[];
  /** An HTML file that runs hidden while the app is open, to handle the
   * extension's commands and events with no panel showing. */
  background?: string;
  commands: ExtensionCommand[];
  events: ExtensionEventName[];
  settings: ExtensionSetting[];
}

/** One installed extension, as extensions.json keeps it. */
export interface ExtensionRecord {
  id: string;
  manifest: ExtensionManifest;
  /** Where it came from, as the owner gave it. */
  source: { kind: "folder"; path: string } | { kind: "github"; url: string };
  /** Exactly the manifest's permissions, as the owner approved them. */
  granted: Permission[];
  enabled: boolean;
  /** The files' hash at install, checked before every document is served. */
  digest: string;
  installedAt: number;
  updatedAt: number;
  /** The owner's values for its settings, by key. */
  settings: Record<string, string | boolean | number>;
}

const ID = /^[a-z0-9][a-z0-9-]{1,39}$/;
const PART_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,40})?$/;
const SETTING_KEY = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;

/** Control characters, and the ones that reorder text on screen: no name
 * an extension gives itself may disguise what it is. */
const HIDDEN = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g;

function words(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(HIDDEN, "").trim().slice(0, max) : "";
}

// ── versions ──

type Triple = [number, number, number];

function triple(version: string): Triple | null {
  const m = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(version.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)];
}

function compare(a: Triple, b: Triple): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

/**
 * Whether `version` is in `range`. A range is "*", or comparators joined
 * by spaces that must all hold: `>=3.3.0`, `<4`, `=3.3.1`, `3.3.1`, and
 * the two shorthands people write, `^3.3.0` (this major) and `~3.3.0`
 * (this minor). Anything else is not a range, and null says so.
 */
export function satisfiesRange(version: string, range: string): boolean | null {
  const have = triple(version);
  if (!have) return null;
  const text = range.trim();
  if (!text || text.length > 80) return null;
  if (text === "*") return true;
  for (const part of text.split(/\s+/)) {
    const m = /^(>=|<=|>|<|=|\^|~)?(\d+(?:\.\d+){0,2})$/.exec(part);
    if (!m) return null;
    const want = triple(m[2])!;
    const op = m[1] ?? "=";
    const c = compare(have, want);
    const ok =
      op === ">=" ? c >= 0
      : op === "<=" ? c <= 0
      : op === ">" ? c > 0
      : op === "<" ? c < 0
      : op === "^" ? c >= 0 && have[0] === want[0]
      : op === "~" ? c >= 0 && have[0] === want[0] && have[1] === want[1]
      : c === 0;
    if (!ok) return false;
  }
  return true;
}

// ── paths ──

/**
 * A path inside the extension's folder, as its manifest or its markup
 * names one: relative, forward slashes, no climbing out, nothing hidden.
 * Null for anything else, which is then simply not one of its files.
 */
export function insidePath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim().replace(/^\.\//, "");
  if (!text || text.length > 200) return null;
  if (text.includes("\\") || text.includes("\0") || text.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(text)) return null;
  const parts = text.split("/");
  for (const part of parts) {
    if (!part || part === "." || part === ".." || part.startsWith(".")) return null;
  }
  return parts.join("/");
}

// ── the manifest ──

export interface ManifestVerdict {
  manifest: ExtensionManifest | null;
  /** Each reason it cannot be installed, in words for the owner. */
  problems: string[];
}

/**
 * The manifest as written, checked field by field. Every problem is
 * collected rather than the first one thrown, so an author fixing a
 * manifest sees all of it at once. `files` is what is in the folder, to
 * check the entries it names are there.
 */
export function checkManifest(raw: unknown, files: ReadonlySet<string>, appVersion: string): ManifestVerdict {
  const problems: string[] = [];
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { manifest: null, problems: [`${MANIFEST_FILE} is not a JSON object.`] };
  }
  const v = raw as Record<string, unknown>;
  if (v.manifestVersion !== 1) problems.push("manifestVersion must be 1.");
  const id = typeof v.id === "string" ? v.id : "";
  if (!ID.test(id)) problems.push("id must be 2 to 40 lower case letters, digits and dashes, starting with a letter or digit.");
  const name = words(v.name, 60);
  if (!name) problems.push("name is missing.");
  const version = typeof v.version === "string" ? v.version.trim() : "";
  if (!VERSION.test(version)) problems.push("version must look like 1.0.0.");
  const description = words(v.description, 300);
  const author = words(v.author, 80);
  const bloks = typeof v.bloks === "string" ? v.bloks.trim() : "";
  const fits = bloks ? satisfiesRange(appVersion, bloks) : null;
  if (!bloks || fits === null) problems.push('bloks must be a version range, such as ">=3.3.0" or "^3.3.0".');
  else if (!fits) problems.push(`It needs Bloks ${bloks}, and this is Bloks ${appVersion}.`);

  const permissions: Permission[] = [];
  if (v.permissions !== undefined && !Array.isArray(v.permissions)) problems.push("permissions must be a list.");
  for (const p of Array.isArray(v.permissions) ? v.permissions : []) {
    if (typeof p !== "string" || !(p in PERMISSIONS)) {
      problems.push(`${JSON.stringify(p).slice(0, 60)} is not a permission Bloks has.`);
      continue;
    }
    if (!permissions.includes(p as Permission)) permissions.push(p as Permission);
  }

  const entry = (value: unknown, what: string): string | null => {
    const path = insidePath(value);
    if (!path) {
      problems.push(`${what} must be a path inside the folder.`);
      return null;
    }
    if (!/\.html?$/i.test(path)) problems.push(`${what} must be an .html file.`);
    else if (!files.has(path)) problems.push(`${what}, ${path}, is not in the folder.`);
    return path;
  };

  const panels: ExtensionPanel[] = [];
  if (v.panels !== undefined && !Array.isArray(v.panels)) problems.push("panels must be a list.");
  const panelList = Array.isArray(v.panels) ? v.panels : [];
  if (panelList.length > EXTENSION_LIMITS.panels) problems.push(`At most ${EXTENSION_LIMITS.panels} panels.`);
  for (const [i, item] of panelList.slice(0, EXTENSION_LIMITS.panels).entries()) {
    const p = (item ?? {}) as Record<string, unknown>;
    const pid = typeof p.id === "string" ? p.id : "";
    if (!PART_ID.test(pid) || pid === "background") problems.push(`panels[${i}].id must be lower case letters, digits and dashes, and not "background".`);
    else if (panels.some((x) => x.id === pid)) problems.push(`Two panels are called ${pid}.`);
    const title = words(p.title, 40);
    if (!title) problems.push(`panels[${i}].title is missing.`);
    const path = entry(p.entry, `panels[${i}].entry`);
    if (PART_ID.test(pid) && title && path) panels.push({ id: pid, title, entry: path });
  }

  let background: string | undefined;
  if (v.background !== undefined) background = entry(v.background, "background") ?? undefined;

  const commands: ExtensionCommand[] = [];
  if (v.commands !== undefined && !Array.isArray(v.commands)) problems.push("commands must be a list.");
  const commandList = Array.isArray(v.commands) ? v.commands : [];
  if (commandList.length > EXTENSION_LIMITS.commands) problems.push(`At most ${EXTENSION_LIMITS.commands} commands.`);
  for (const [i, item] of commandList.slice(0, EXTENSION_LIMITS.commands).entries()) {
    const c = (item ?? {}) as Record<string, unknown>;
    const cid = typeof c.id === "string" ? c.id : "";
    const title = words(c.title, 60);
    if (!PART_ID.test(cid)) problems.push(`commands[${i}].id must be lower case letters, digits and dashes.`);
    else if (commands.some((x) => x.id === cid)) problems.push(`Two commands are called ${cid}.`);
    if (!title) problems.push(`commands[${i}].title is missing.`);
    const said = words(c.description, 160);
    if (PART_ID.test(cid) && title) commands.push({ id: cid, title, ...(said ? { description: said } : {}) });
  }

  const events: ExtensionEventName[] = [];
  if (v.events !== undefined && !Array.isArray(v.events)) problems.push("events must be a list.");
  for (const e of Array.isArray(v.events) ? v.events : []) {
    if (typeof e !== "string" || !(e in EVENTS)) {
      problems.push(`${JSON.stringify(e).slice(0, 60)} is not an event Bloks sends.`);
      continue;
    }
    const needs = EVENTS[e as ExtensionEventName];
    if (needs && !permissions.includes(needs)) problems.push(`The event ${e} needs the permission ${needs}.`);
    if (!events.includes(e as ExtensionEventName)) events.push(e as ExtensionEventName);
  }

  // Something has to be there to hear a command or an event: the hidden
  // document, or failing that a panel, which hears them while it is open.
  if ((commands.length || events.length) && !background && !panels.length) {
    problems.push("Commands and events need a background document or a panel to handle them.");
  }
  if (!panels.length && !background && !commands.length) problems.push("It adds nothing: no panel, no background document and no command.");

  const settings: ExtensionSetting[] = [];
  if (v.settings !== undefined && !Array.isArray(v.settings)) problems.push("settings must be a list.");
  const settingList = Array.isArray(v.settings) ? v.settings : [];
  if (settingList.length > EXTENSION_LIMITS.settings) problems.push(`At most ${EXTENSION_LIMITS.settings} settings.`);
  for (const [i, item] of settingList.slice(0, EXTENSION_LIMITS.settings).entries()) {
    const s = (item ?? {}) as Record<string, unknown>;
    const key = typeof s.key === "string" ? s.key : "";
    const label = words(s.label, 80);
    const type = s.type;
    if (!SETTING_KEY.test(key)) problems.push(`settings[${i}].key must be a letter followed by letters, digits or underscores.`);
    else if (settings.some((x) => x.key === key)) problems.push(`Two settings are called ${key}.`);
    if (!label) problems.push(`settings[${i}].label is missing.`);
    if (type !== "text" && type !== "boolean" && type !== "number") {
      problems.push(`settings[${i}].type must be text, boolean or number.`);
      continue;
    }
    const fallback = type === "boolean" ? false : type === "number" ? 0 : "";
    const given = settingValue(type, s.default === undefined ? fallback : s.default);
    if (given === null) problems.push(`settings[${i}].default is not a ${type}.`);
    if (SETTING_KEY.test(key) && label) settings.push({ key, label, type, default: given ?? fallback });
  }

  if (problems.length) return { manifest: null, problems };
  return {
    manifest: {
      manifestVersion: 1,
      id,
      name,
      version,
      description,
      ...(author ? { author } : {}),
      bloks,
      permissions,
      panels,
      ...(background ? { background } : {}),
      commands,
      events,
      settings,
    },
    problems,
  };
}

/** A setting's value, if it is one of its type; null if not. */
export function settingValue(type: SettingType, value: unknown): string | boolean | number | null {
  if (type === "boolean") return typeof value === "boolean" ? value : null;
  if (type === "number") return typeof value === "number" && Number.isFinite(value) ? value : null;
  return typeof value === "string" ? value.replace(HIDDEN, "").slice(0, 500) : null;
}

/** The owner's values over the defaults, for `settings.get`. */
export function settingsOf(record: Pick<ExtensionRecord, "manifest" | "settings">): Record<string, string | boolean | number> {
  const out: Record<string, string | boolean | number> = {};
  for (const s of record.manifest.settings) {
    const kept = settingValue(s.type, record.settings?.[s.key]);
    out[s.key] = kept ?? s.default;
  }
  return out;
}

/** The owner's change to settings, checked against the manifest. */
export function patchSettings(
  manifest: ExtensionManifest,
  current: Record<string, string | boolean | number>,
  patch: unknown,
): { ok: true; settings: Record<string, string | boolean | number> } | { ok: false; error: string } {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) return { ok: false, error: "settings is an object of values by key" };
  const next = { ...current };
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    const s = manifest.settings.find((x) => x.key === key);
    if (!s) return { ok: false, error: `${key.slice(0, 40)} is not one of its settings` };
    const kept = settingValue(s.type, value);
    if (kept === null) return { ok: false, error: `${s.label} is a ${s.type}` };
    next[key] = kept;
  }
  return { ok: true, settings: next };
}

// ── the folder ──

export interface FolderFile {
  path: string;
  bytes: Buffer;
}

export interface FolderSnapshot {
  files: FolderFile[];
  digest: string;
}

export class FolderRefused extends Error {}

/**
 * Every file in an extension's folder, read once into memory, with the
 * hash of them all. What is installed is written from these bytes and no
 * others, so the files that were hashed, shown and approved are the ones
 * that land, whatever happens to the folder in between.
 *
 * A link anywhere in it refuses the whole folder: it could point at
 * anything on the computer, and following one quietly is how a private
 * file would end up served in a panel. Hidden files and folders (a .git,
 * a .DS_Store) are left out, and cannot be named by the manifest either.
 */
export function snapshotFolder(root: string): FolderSnapshot {
  const files: FolderFile[] = [];
  let total = 0;
  const top = lstatSync(root);
  if (top.isSymbolicLink() || !top.isDirectory()) throw new FolderRefused("That is not a folder.");
  const walk = (dir: string, rel: string) => {
    for (const name of readdirSync(dir).sort()) {
      if (name.startsWith(".")) continue;
      const full = join(dir, name);
      const path = rel ? `${rel}/${name}` : name;
      const st = lstatSync(full);
      if (st.isSymbolicLink()) throw new FolderRefused(`${path} is a link. An extension's folder may not contain links.`);
      if (st.isDirectory()) {
        walk(full, path);
        continue;
      }
      if (!st.isFile()) throw new FolderRefused(`${path} is not a plain file.`);
      if (!insidePath(path)) throw new FolderRefused(`${path} is not a name an extension's file can have.`);
      if (files.length >= EXTENSION_LIMITS.files) throw new FolderRefused(`More than ${EXTENSION_LIMITS.files} files.`);
      if (st.size > EXTENSION_LIMITS.fileBytes) throw new FolderRefused(`${path} is larger than 2 MB.`);
      total += st.size;
      if (total > EXTENSION_LIMITS.bytes) throw new FolderRefused("The folder is larger than 5 MB.");
      files.push({ path, bytes: readFileSync(full) });
    }
  };
  walk(root, "");
  return { files, digest: digestOf(files) };
}

/** One hash over every file's name and bytes, in a fixed order. */
export function digestOf(files: readonly FolderFile[]): string {
  const hash = createHash("sha256");
  for (const file of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    hash.update(file.path);
    hash.update("\0");
    hash.update(String(file.bytes.length));
    hash.update("\0");
    hash.update(file.bytes);
  }
  return hash.digest("hex");
}

/** The manifest out of a snapshot, checked. */
export function manifestIn(snapshot: FolderSnapshot, appVersion: string): ManifestVerdict {
  const file = snapshot.files.find((f) => f.path === MANIFEST_FILE);
  if (!file) return { manifest: null, problems: [`There is no ${MANIFEST_FILE} at the top of the folder.`] };
  if (file.bytes.length > EXTENSION_LIMITS.manifestBytes) return { manifest: null, problems: [`${MANIFEST_FILE} is larger than 64 KB.`] };
  let raw: unknown;
  try {
    raw = JSON.parse(file.bytes.toString("utf8"));
  } catch {
    return { manifest: null, problems: [`${MANIFEST_FILE} is not valid JSON.`] };
  }
  return checkManifest(raw, new Set(snapshot.files.map((f) => f.path)), appVersion);
}

/**
 * Writes a snapshot as the installed copy of an extension: into a folder
 * beside it first, then moved into place in one step, so an update that
 * fails half way leaves the copy that was there.
 */
export function writeInstalled(root: string, id: string, snapshot: FolderSnapshot): void {
  if (!ID.test(id)) throw new Error("not an extension id");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const target = join(root, id);
  const staging = join(root, `.${id}.${randomBytes(6).toString("hex")}`);
  mkdirSync(staging, { mode: 0o700 });
  try {
    for (const file of snapshot.files) {
      const path = insidePath(file.path);
      if (!path) throw new Error("not a file of the extension's");
      const parts = path.split("/");
      if (parts.length > 1) mkdirSync(join(staging, ...parts.slice(0, -1)), { recursive: true, mode: 0o700 });
      writeFileSync(join(staging, ...parts), file.bytes, { mode: 0o600 });
    }
    const old = join(root, `.${id}.old.${randomBytes(6).toString("hex")}`);
    let moved = false;
    try {
      renameSync(target, old);
      moved = true;
    } catch {
      /* nothing installed yet */
    }
    renameSync(staging, target);
    if (moved) rmSync(old, { recursive: true, force: true });
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

/**
 * The installed copy, read back and checked against the hash it was
 * installed with. Null when anything differs: a file added, removed or
 * changed since the owner approved it.
 */
export function readInstalled(root: string, record: Pick<ExtensionRecord, "id" | "digest">): FolderSnapshot | null {
  if (!ID.test(record.id)) return null;
  try {
    const snapshot = snapshotFolder(join(root, record.id));
    return snapshot.digest === record.digest ? snapshot : null;
  } catch {
    return null;
  }
}

// ── the framed document ──

/**
 * The policy an extension's documents run under, sent as a header with
 * each one. `sandbox allow-scripts` gives the document an opaque origin
 * of its own wherever it is loaded, framed or opened by itself, so it can
 * read none of the app's cookies, storage or pages, and a request it
 * somehow made would arrive as Origin null, which the API refuses
 * (server/http-guard.ts). Then nothing may load or connect anywhere: no
 * fetch, no socket, no image, font or frame from any address, no form,
 * no worker. Its own scripts and styles are inlined into it, which is
 * why inline is the one source allowed. No eval: nothing an extension
 * needs is worth handing a string to the compiler.
 */
export const EXTENSION_CSP = [
  "sandbox allow-scripts",
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "media-src data: blob:",
  "connect-src 'none'",
  "form-action 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "worker-src 'none'",
  "manifest-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  // only the app's own page may frame it
  "frame-ancestors 'self'",
].join("; ");

/** The headers sent with every framed document. */
export const FRAME_HEADERS: Record<string, string> = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "content-security-policy": EXTENSION_CSP,
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cross-origin-opener-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), usb=(), serial=(), hid=(), bluetooth=(), payment=(), clipboard-read=(), display-capture=()",
};

const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

/**
 * The SDK every document gets, ahead of its own markup: `window.bloks`,
 * the one way out. A call is a message to the page that framed it, and
 * the page's reply comes back as a message; events and commands arrive
 * the same way. Messages from anywhere but that page are ignored.
 *
 * It also takes WebRTC away before the extension's code runs: a policy
 * cannot stop a peer connection, and one could carry data to a server
 * through its candidates. An extension that needs it is not one for a
 * frame with no network.
 */
export const FRAME_PRELUDE = `(function(){"use strict";
var host=window.parent;
["RTCPeerConnection","webkitRTCPeerConnection","RTCDataChannel","RTCSessionDescription","RTCIceCandidate","RTCRtpSender","RTCRtpReceiver"].forEach(function(k){try{Object.defineProperty(window,k,{value:undefined,writable:false,configurable:false})}catch(e){}});
var seq=0,waiting=new Map(),handlers=new Map(),commands=new Map(),context={};
function post(m){m.bloks=1;try{host.postMessage(m,"*")}catch(e){}}
function report(err){var t=err&&err.message?err.message:String(err);post({type:"error",message:String(t).slice(0,300)})}
addEventListener("error",function(e){report(e.error||e.message)});
addEventListener("unhandledrejection",function(e){report(e.reason)});
addEventListener("message",function(e){
if(e.source!==host)return;var d=e.data;if(!d||d.bloks!==1)return;
if(d.type==="reply"){var w=waiting.get(d.id);if(!w)return;waiting.delete(d.id);if(d.ok)w.resolve(d.result);else w.reject(new Error(String(d.error||"refused")));return}
if(d.type==="hello"){context=d.context||{};return}
if(d.type==="event"&&d.name==="theme.changed"&&d.data&&typeof d.data==="object"){var names={background:["--bloks-bg","--background"],foreground:["--bloks-fg","--foreground"],muted:["--bloks-muted","--muted-foreground"],border:["--bloks-border","--border"],accent:["--bloks-accent","--brand"]};var root=document.documentElement.style;Object.keys(names).forEach(function(k){var v=d.data[k];if(typeof v==="string"&&/^[#a-zA-Z0-9(),.%\s\/-]{0,64}$/.test(v))names[k].forEach(function(n){root.setProperty(n,v)})});if(d.data.scheme==="dark"||d.data.scheme==="light")root.colorScheme=d.data.scheme}
if(d.type==="event"){(handlers.get(d.name)||[]).slice().forEach(function(fn){try{fn(d.data)}catch(err){report(err)}});(handlers.get("*")||[]).slice().forEach(function(fn){try{fn(d.name,d.data)}catch(err){report(err)}});return}
if(d.type==="command"){var fn=commands.get(d.id);if(!fn)return;try{Promise.resolve(fn(d.context||{})).catch(report)}catch(err){report(err)}}
});
var api={
call:function(method,params){return new Promise(function(resolve,reject){var id=++seq;waiting.set(id,{resolve:resolve,reject:reject});post({type:"call",id:id,method:String(method),params:params===undefined?null:params})})},
on:function(name,fn){name=String(name);var list=handlers.get(name)||[];list.push(fn);handlers.set(name,list);return function(){var l=handlers.get(name)||[];var i=l.indexOf(fn);if(i>=0)l.splice(i,1)}},
onCommand:function(id,fn){commands.set(String(id),fn)},
get context(){return context}
};
Object.defineProperty(window,"bloks",{value:Object.freeze(api),writable:false,configurable:false});
post({type:"ready"});
})();`;

/** Words that would close the element they are inlined into. */
const closeScript = (text: string) => text.replace(/<\/(script)/gi, "<\\/$1").replace(/<!--/g, "<\\!--");
const closeStyle = (text: string) => text.replace(/<\/(style)/gi, "<\\/$1");

const attr = (tag: string, name: string): string | null => {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  return m ? (m[1] ?? m[2] ?? m[3] ?? "") : null;
};

/**
 * An extension's HTML with its own files folded in: a script by src, a
 * stylesheet by href and an image by src, when each names a file of its
 * own. The policy allows nothing to be fetched, so a reference to
 * anywhere else is left as it is and simply does not load. A path is
 * relative to the folder's top; `read` returns null for anything that is
 * not one of its files.
 */
export function inlineAssets(html: string, read: (path: string) => Buffer | null): string {
  let out = html.replace(/<script\b([^>]*)>\s*<\/script\s*>/gi, (whole, attrs: string) => {
    const src = attr(` ${attrs}`, "src");
    if (src === null) return whole;
    const path = insidePath(src);
    const bytes = path ? read(path) : null;
    if (!bytes) return whole;
    const rest = attrs.replace(/\s(?:src|integrity|crossorigin)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");
    return `<script${rest}>${closeScript(bytes.toString("utf8"))}</script>`;
  });
  out = out.replace(/<link\b[^>]*>/gi, (tag) => {
    const rel = (attr(tag, "rel") ?? "").toLowerCase();
    if (!rel.split(/\s+/).includes("stylesheet")) return tag;
    const path = insidePath(attr(tag, "href"));
    const bytes = path ? read(path) : null;
    return bytes ? `<style>${closeStyle(bytes.toString("utf8"))}</style>` : tag;
  });
  out = out.replace(/<img\b[^>]*>/gi, (tag) => {
    const src = attr(tag, "src");
    const path = insidePath(src);
    const type = path ? IMAGE_TYPES[extname(path).toLowerCase()] : undefined;
    const bytes = path && type ? read(path) : null;
    if (!bytes || !type) return tag;
    return tag.replace(/\ssrc\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i, ` src="data:${type};base64,${bytes.toString("base64")}"`);
  });
  return out;
}

/**
 * The whole document a frame is served: the policy again as a meta tag
 * (the header is the one that counts; this is for anyone reading the
 * source), the app's colours as variables, the SDK, then the extension's
 * own markup with its files folded in.
 *
 * The colours go out under two sets of names: Bloks's own, and the plain
 * ones (`--background`, `--foreground`, `--brand`) that panels written
 * for other hosts already read (GitHub 524), so such a panel looks at
 * home without being rewritten.
 */
export function frameExtensionDocument(html: string, read: (path: string) => Buffer | null, theme: AppTheme): string {
  const body = inlineAssets(html, read);
  return [
    "<!doctype html><html><head><meta charset=\"utf-8\">",
    `<meta http-equiv="Content-Security-Policy" content="${EXTENSION_CSP.replace("sandbox allow-scripts; ", "")}">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<meta name="color-scheme" content="${theme.scheme}">`,
    "<style>:root{",
    `color-scheme:${theme.scheme};`,
    `--bloks-bg:${theme.background};--bloks-fg:${theme.foreground};--bloks-muted:${theme.muted};--bloks-border:${theme.border};--bloks-accent:${theme.accent};`,
    `--background:${theme.background};--foreground:${theme.foreground};--muted-foreground:${theme.muted};--border:${theme.border};--brand:${theme.accent};`,
    "}html,body{margin:0;padding:0;",
    "background:var(--bloks-bg);color:var(--bloks-fg);",
    'font:14px/1.5 ui-sans-serif,-apple-system,system-ui,"Segoe UI",sans-serif;}</style>',
    `<script>${FRAME_PRELUDE}</script>`,
    "</head><body>",
    body,
    "</body></html>",
  ].join("");
}

/** Which document of an extension a frame asks for: a panel by its id,
 * or "background". Null for one it does not have. */
export function entryFor(manifest: ExtensionManifest, which: string): string | null {
  if (which === "background") return manifest.background ?? null;
  return manifest.panels.find((p) => p.id === which)?.entry ?? null;
}

// ── calls ──

/** Whether an extension with these permissions may make this call. */
export function mayCall(granted: readonly Permission[], method: string): { ok: true } | { ok: false; error: string } {
  const table: Record<string, Permission | null> = { ...SERVER_METHODS, ...PAGE_METHODS };
  if (!Object.prototype.hasOwnProperty.call(table, method)) return { ok: false, error: `${method.slice(0, 60)} is not something an extension can ask for` };
  const needs = table[method];
  if (needs && !granted.includes(needs)) return { ok: false, error: `that needs the permission ${needs}, which this extension was not given` };
  return { ok: true };
}

/** Whether an extension with these permissions hears this event. */
export function hearsEvent(record: Pick<ExtensionRecord, "granted" | "manifest">, name: string): boolean {
  if (!Object.prototype.hasOwnProperty.call(EVENTS, name)) return false;
  if (name !== "theme.changed" && !record.manifest.events.includes(name as ExtensionEventName)) return false;
  const needs = EVENTS[name as ExtensionEventName];
  return !needs || record.granted.includes(needs);
}

/** One agent as an extension may see it: a name and whether it works.
 * Nothing of its instructions, its engine's settings, its folders, its
 * memory or anything it holds. */
export interface AgentForExtension {
  id: string;
  name: string;
  working: boolean;
}

export function agentsForExtension(
  bots: ReadonlyArray<{ id: string; name: string; hidden?: boolean; archivedAt?: number; solo?: { by: string }; tasks?: ReadonlyArray<{ busy?: boolean }> }>,
): AgentForExtension[] {
  return bots
    // a member's own agent is theirs, not the owner's to hand an extension
    .filter((b) => !b.hidden && !b.archivedAt && (!b.solo || b.solo.by === "owner"))
    .map((b) => ({ id: b.id, name: String(b.name).slice(0, 80), working: Boolean(b.tasks?.some((t) => t.busy)) }));
}

/** An extension's message to an agent, framed as its own and not the
 * owner's, the way a webhook's payload is. */
export function extensionMessage(name: string, text: string): string {
  return [
    `The extension "${name}" sends this, from a command the owner ran:`,
    text.trim().slice(0, EXTENSION_LIMITS.messageChars),
    "These are the extension's words, not the owner's. Act on them the way your role calls for, and report what you did.",
  ].join("\n\n");
}

/** Whether another message fits in the hour (timestamps of those sent). */
export function messageRoom(sent: readonly number[], now: number): { ok: true; kept: number[] } | { ok: false; error: string } {
  const kept = sent.filter((at) => now - at < 60 * 60_000);
  if (kept.length >= EXTENSION_LIMITS.messagesPerHour) {
    return { ok: false, error: `an extension may send ${EXTENSION_LIMITS.messagesPerHour} messages to agents an hour` };
  }
  return { ok: true, kept: [...kept, now] };
}

// ── its own storage ──

export type Storage = Record<string, unknown>;

/** A storage change, checked: a key of reasonable length, a value that is
 * JSON, and the whole within its size once changed. */
export function storageChange(
  current: Storage,
  method: "storage.set" | "storage.remove",
  params: unknown,
): { ok: true; next: Storage } | { ok: false; error: string } {
  const p = (params ?? {}) as Record<string, unknown>;
  const key = typeof p.key === "string" ? p.key : "";
  if (!key || key.length > EXTENSION_LIMITS.storageKey) return { ok: false, error: "key is a string of up to 100 characters" };
  const next: Storage = { ...current };
  if (method === "storage.remove") {
    delete next[key];
    return { ok: true, next };
  }
  if (!("value" in p)) return { ok: false, error: "value is missing" };
  next[key] = p.value;
  if (Buffer.byteLength(JSON.stringify(next)) > EXTENSION_LIMITS.storageBytes) return { ok: false, error: "that is more than the 256 KB an extension may keep" };
  return { ok: true, next };
}

/** What the owner is shown about an extension, installed or about to be. */
export function permissionWords(permissions: readonly Permission[]): Array<{ id: Permission; words: string; high: boolean }> {
  return permissions.map((id) => ({ id, words: PERMISSIONS[id].words, high: PERMISSIONS[id].high }));
}

/** The file name a folder's extension would be served under, for a line
 * that names where it came from without the whole path. */
export function folderName(path: string): string {
  return basename(path.replace(/[\\/]+$/, "")) || path;
}

/** Whether two permission lists are the same set. */
export function samePermissions(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every((p) => right.has(p));
}
