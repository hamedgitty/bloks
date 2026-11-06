// Bring your setup.
//
// Somebody arriving from another agent tool has already taught it a lot:
// standing instructions, skills, the tool servers it talks to, what it
// may and may not do, a few facts about them. Typing all of that again is
// the first hour of a new app, and most people stop before the hour is
// up. So this reads what is there and offers it, item by item.
//
// Four rules, in the order they were decided.
//
//   Read only, and only from known places. Each source is a short list of
//   files and folders by name under the person's home. Nothing is searched
//   for, nothing outside those names is opened, and nothing in a source
//   folder is ever written. The one database read is OpenBot's, opened
//   read only for the one table its own guide names, and a transfer file
//   is read only once the person has picked it, and only by the paths
//   that format documents.
//
//   Never a credential without a yes. Files that hold sign-ins (auth.json,
//   .credentials.json, .env, tokens, keychains) are never opened, even
//   when a link points at one. What is read is scrubbed of anything shaped
//   like a key before anyone sees it, and an MCP server's environment and
//   headers, and a chat app's token, come across as names with empty
//   values. The person types a value in here, or says yes, for that one
//   value, to copying the one the other tool's config already holds. A
//   value is never sent to the window, never kept in the record of what
//   was imported, and never copied because something else was ticked.
//
//   Nothing is written until the person ticks it. The review is a list;
//   the import applies the ticked items and nothing else. It reads the
//   files again rather than trusting what the window sends back, so a file
//   that changed since the review is refused rather than imported unseen.
//
//   Again means update, and every import can be taken back. Each item has
//   a stable key and a digest of what was imported, kept beside the rest
//   of the workspace, so importing a second time replaces what the first
//   time added instead of adding it twice. Each import also keeps what it
//   changed, so it can be undone (server/setup-undo.ts).
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import { FILE_MAX_BYTES } from "./attachments.ts";
import { isRecord, readSaved, writeFileAtomic } from "./atomic-write.ts";
import { isEffort, type Effort } from "./effort.ts";
import { reservedEnvName } from "./env-names.ts";
import { parseJson5 } from "./json5.ts";
import { MAX_DESCRIPTION_CHARS, MAX_MCP_SERVERS, MAX_NAME_CHARS, MAX_TITLE_CHARS } from "./limits.ts";
import { cleanRule, describe as describeRule, isQuestionTool, plainWords, type Effect, type Field, type Op, type Rule } from "./policy.ts";
import { cleanNote, MAX_NOTE, type ProfileNote } from "./profile-notes.ts";
import { describe as describeRoutine, MAX_ROUTINE_PROMPT, type Routine } from "./routines.ts";
import { countChars, MAX_SKILL_CHARS, slugify } from "./skills.ts";
import { MEMORY_FILE_MAX_BYTES } from "./workspace.ts";
import { listZip, readZipEntry, ZipRefused, type ZipEntry, type ZipLimits } from "./zip-read.ts";

// ── what there is to find ──────────────────────────────────────────────

export type SourceId = "claude" | "codex" | "cursor" | "openclaw" | "hermes" | "openbot";

export const SOURCE_NAMES: Record<SourceId, string> = {
  claude: "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  openclaw: "OpenClaw",
  hermes: "Hermes",
  openbot: "OpenBot",
};

export const SOURCE_IDS = Object.keys(SOURCE_NAMES) as SourceId[];

export type ItemKind = "agent" | "instructions" | "memory" | "skill" | "mcp" | "setting" | "rule" | "fact" | "channel" | "files" | "routine";

/** Where an item can go. Each kind has its own short list. */
export type Destination = "agent" | "brief" | "memory" | "skills" | "mcp" | "engine" | "rules" | "about" | "channel" | "files" | "routine";

/** The engine families an agent or a model setting can be carried to:
 * each one Bloks runs, by the name a person knows it by. */
export type Engine = "claude" | "codex" | "grok" | "opencode" | "gemini" | "cursor" | "cline" | "kimi" | "devin" | "pi" | "openrouter" | "deepseek";

export const ENGINE_NAMES: Record<Engine, string> = {
  claude: "Claude Code",
  codex: "Codex",
  grok: "Grok",
  opencode: "OpenCode",
  gemini: "Gemini",
  cursor: "Cursor",
  cline: "Cline",
  kimi: "Kimi",
  devin: "Devin",
  pi: "Pi",
  openrouter: "OpenRouter",
  deepseek: "DeepSeek",
};

/** The drivers (server/drivers/) that run each family, the one a person
 * most likely set up first: a CLI before the same lab's API. */
export const ENGINE_DRIVERS: Record<Engine, readonly string[]> = {
  claude: ["claudeAgent"],
  codex: ["codex"],
  grok: ["grokCli", "grok"],
  opencode: ["opencode"],
  gemini: ["geminiCli", "gemini"],
  cursor: ["cursor"],
  cline: ["cline"],
  kimi: ["kimi"],
  devin: ["devin"],
  pi: ["pi"],
  openrouter: ["openrouter"],
  deepseek: ["deepseek"],
};

/** An MCP server as it will be registered: every value that could be a
 * credential is already gone. */
export interface McpImport {
  name: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  /** Names only. Every value is empty until the person fills it in. */
  env?: Record<string, string>;
  headers?: Record<string, string>;
}

/** Another tool's subagent, as a Bloks agent. */
export interface AgentImport {
  name: string;
  /** What it is for, from its description: the agent's title. */
  title: string;
  /** Its prompt: the agent's instructions. */
  instructions: string;
  /** An empty model is that engine's own default. */
  model?: { engine: Engine; model: string };
  /** What it ran on in the other tool, when no engine here is of the same
   * family, so the review can say it moves to the default. */
  ranOn?: string;
  /** Its picture, known by a hash of its bytes, which are kept beside
   * the scan (AVATARS) rather than in it. */
  avatar?: { mime: string; hash: string; bytes: number };
  effort?: Effort;
  color?: string;
  /** Skills and servers it asked for, by name, attached when Bloks has them. */
  skills: string[];
  servers: string[];
  /** What Bloks refuses for this agent alone, as rules. */
  deny: Array<{ field: Field; op: Op; value: string; label: string }>;
}

/** A default model, for the agent made for that tool. */
export interface SettingImport {
  engine: Engine;
  model?: string;
  effort?: Effort;
}

export type ChatPlatform = "telegram" | "slack" | "discord";

export const PLATFORM_NAMES: Record<ChatPlatform, string> = { telegram: "Telegram", slack: "Slack", discord: "Discord" };

export interface ChannelImport {
  platform: ChatPlatform;
  /** Which of the other tool's accounts on that platform, when it had several. */
  account?: string;
}

/** Files from an agent's own folder, by path inside it. */
export interface FilesImport {
  files: Array<{ path: string; bytes: number }>;
  total: number;
}

/** A schedule another tool ran an agent on. It always arrives paused. */
export interface RoutineImport {
  name?: string;
  prompt: string;
  /** "HH:MM" and the days, 0 for Sunday; no days is every day. */
  time: string;
  days: number[];
  /** Whether the schedule could be read, or is a stand in to set. */
  scheduled: boolean;
}

/**
 * One value an item needs and does not carry: an environment variable, a
 * header or a chat app's token. The window shows a field for each, and a
 * box to copy the other tool's value when its config holds one.
 */
export interface SecretSlot {
  /** env:NAME, header:Name or token:field. What a pick names it by. */
  id: string;
  name: string;
  where: "env" | "header" | "token";
  /** The file a value was found in, when there is one to copy. */
  copyFrom?: string;
  /** The variable the other tool reads it from, when it was one. */
  ref?: string;
  /** Without it the item cannot be imported at all. */
  required?: boolean;
}

/**
 * The values a slot could be copied from, kept off the item itself.
 *
 * A WeakMap rather than a field so that nothing which serializes a scan,
 * the review, a test's snapshot, a log line, can carry one by accident:
 * the only way to a value is to ask for it here, by item and slot, which
 * only an import the person said yes to does.
 */
const SECRET_VALUES = new WeakMap<FoundItem, Map<string, string>>();

/** The value the other tool's config holds for one slot, if any. */
export function secretValue(item: FoundItem, slotId: string): string | undefined {
  return SECRET_VALUES.get(item)?.get(slotId);
}

/**
 * Bytes an item brings that a scan should not carry: an agent's picture,
 * and the way to read each of its workspace files when the import comes
 * to copy them. Kept beside the item for the same reason the values are,
 * so a scan stays small and plain enough to print.
 */
const AVATARS = new WeakMap<FoundItem, Buffer>();
const FILE_READERS = new WeakMap<FoundItem, (path: string) => Buffer>();

/** An agent's picture, as the scan read it. */
export function avatarBytes(item: FoundItem): Buffer | undefined {
  return AVATARS.get(item);
}

export interface FoundItem {
  /** Stable from one look to the next: the source and what the thing is. */
  key: string;
  source: SourceId;
  kind: ItemKind;
  title: string;
  /** Where it was found, with the home folder written as ~. */
  from: string;
  /** What would be imported, already scrubbed. */
  text: string;
  /** sha256 of what would be imported, which is how a second import knows
   * whether anything changed. */
  digest: string;
  notes: string[];
  destinations: Destination[];
  /** The memory topic file a memory/<name>.md becomes, when it is one. */
  topic?: string;
  skill?: { id: string; name: string; description: string; body: string };
  mcp?: McpImport;
  rule?: { effect: Effect; field: Field; op: Op; value: string; tool?: string };
  agent?: AgentImport;
  setting?: SettingImport;
  channel?: ChannelImport;
  files?: FilesImport;
  routine?: RoutineImport;
  secrets?: SecretSlot[];
  /** An earlier item with the same content, from another tool's folder. */
  sameAs?: string;
  /** The agent this is a part of, in a tool whose agents each bring their
   * own: it goes to whatever that agent becomes here. */
  owner?: { key: string; name: string };
}

export interface Skipped {
  from: string;
  why: string;
}

export interface SourceScan {
  id: SourceId;
  name: string;
  /** The folder it lives in, as ~/.something. */
  folder: string;
  /** What a new agent made from this source is called. */
  agentName: string;
  items: FoundItem[];
  skipped: Skipped[];
}

export interface Scan {
  home: string;
  sources: SourceScan[];
}

// ── how much is read ───────────────────────────────────────────────────

/** Instructions and memory files. The same bound the memory editor saves. */
export const MAX_TEXT_FILE_BYTES = MEMORY_FILE_MAX_BYTES;
/** One SKILL.md: the library's own limit in any script, plus frontmatter. */
const MAX_SKILL_FILE_BYTES = MAX_SKILL_CHARS * 4 + 4_000;
/** ~/.claude.json carries a history of every project opened, so it can be
 * large; only its mcpServers are ever looked at. */
const MAX_CONFIG_JSON_BYTES = 16 * 1024 * 1024;
const MAX_SETTINGS_BYTES = 1024 * 1024;
const MAX_SKILLS_PER_SOURCE = 100;
const MAX_TOPICS_PER_SOURCE = 60;
const MAX_FACTS_PER_SOURCE = 20;
const MAX_RULES_PER_SOURCE = 50;
const MAX_MCP_PER_SOURCE = 32;
/** Subagents, commands and rule files each, per source. */
const MAX_AGENTS_PER_SOURCE = 30;
const MAX_COMMANDS_PER_SOURCE = 100;
const MAX_RULE_FILES_PER_SOURCE = 60;
/** Rules one imported agent brings for itself. */
const MAX_DENY_PER_AGENT = 20;
/** Accounts on one chat platform, in a config that has several. */
const MAX_ACCOUNTS = 4;
/** One value typed in, or copied, for a server or a chat app. */
export const MAX_SECRET_CHARS = 4_096;
const MAX_ARGS = 24;
const MAX_ENV_NAMES = 32;
const MAX_HEADER_NAMES = 8;
/** How much of an item the review shows. The import uses the whole text. */
export const PREVIEW_CHARS = 1_200;

// ── never a credential ─────────────────────────────────────────────────

/**
 * A file name that holds, or is likely to hold, a sign-in.
 *
 * Deliberately broad. A memory note that happens to be called
 * "api-keys.md" is left out with a line saying why, which costs the person
 * a copy and paste; opening a token file would cost them the token.
 */
const CREDENTIAL_NAME =
  /^\.?env(\..*)?$|\.env$|^\.?(auth|credentials?|keychain|cookies?)(\.[\w.-]+)?$|tokens?|secrets?|credential|passw(or)?d|oauth|api[_-]?keys?|\.(pem|key|p12|pfx|keystore|jks|kdbx|sqlite|db)$|^id_(rsa|dsa|ecdsa|ed25519)/i;

/** Folders that hold keys whatever their files are called. */
const CREDENTIAL_FOLDERS = new Set([".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker", "Keychains", ".password-store", ".1password"]);

export function isCredentialPath(path: string): boolean {
  if (CREDENTIAL_NAME.test(basename(path))) return true;
  return path.split(/[\\/]/).some((part) => CREDENTIAL_FOLDERS.has(part));
}

const REMOVED = "[removed]";

/** Shapes that are a credential wherever they appear. */
const SECRET_SHAPES: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-ant-[A-Za-z0-9_-]{16,}/g,
  /\b(?:sk|pk|rk|ck|ak|gsk|xai)[-_](?:live_|test_|proj-)?[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abeprs]-[A-Za-z0-9-]{10,}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\bya29\.[0-9A-Za-z_-]{20,}/g,
  /\bglpat-[A-Za-z0-9_-]{20,}/g,
  /\bhf_[A-Za-z0-9]{30,}/g,
  /\bnpm_[A-Za-z0-9]{30,}/g,
  /\bblok_live_[0-9a-f]{32}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
];

/** A value that reads like something generated rather than written:
 * letters and digits together, or long and unbroken. Placeholders such as
 * $GITHUB_TOKEN or <your key> are not, and stay as they are. */
function looksGenerated(value: string): boolean {
  if (/^[$<{%]/.test(value) || /^(.)\1+$/.test(value)) return false;
  if (value.length >= 12 && /\d/.test(value) && /[A-Za-z]/.test(value)) return true;
  return value.length >= 32 && /^[A-Za-z0-9+/=_.-]+$/.test(value);
}

/** A flag or a name that says its value is a credential. "auth" only as
 * a word of its own, so --author is left alone. */
const SECRET_NAME = /api[_-]?key|apikey|secret|token|passw(or)?d|pwd|access[_-]?key|private[_-]?key|credential|(^|[-_])auth($|[-_])/i;

/**
 * Takes out of a text everything that looks like a key, a token or a
 * password, and says how many it took.
 *
 * It cannot know what a secret is, only what one tends to look like, so it
 * leans towards taking too much: a path or an id that happened to look
 * generated becomes [removed], which the person can see in the preview
 * and put back by hand. The other mistake cannot be put back.
 */
export function scrubSecrets(input: string): { text: string; removed: number } {
  let removed = 0;
  let text = input;
  const take = (keep = "") => {
    removed += 1;
    return `${keep}${REMOVED}`;
  };
  for (const shape of SECRET_SHAPES) text = text.replace(shape, () => take());
  // the word that says what follows is kept, so the sentence still reads
  text = text.replace(/\b(Bearer|Basic|Token)(\s+)([A-Za-z0-9._~+/=-]{12,})/gi, (whole, word, space, value) =>
    value === REMOVED || !looksGenerated(value) ? whole : take(`${word}${space}`),
  );
  // Addresses first, since they are the most exact: https://user:password@host
  text = text.replace(/\b([a-z][a-z0-9+.-]*:\/\/)([^\s/:@]+):([^\s/@]+)@/gi, (_whole, scheme, user) => `${take(`${scheme}${user}:`)}@`);
  // ?api_key=... and friends
  text = text.replace(
    /([?&](?:api[_-]?key|key|token|access_token|auth|secret|password|sig|signature|client_secret)=)([^&\s#"']+)/gi,
    (whole, name, value) => (value === REMOVED ? whole : take(name)),
  );
  // name = value, name: value, "name": "value". Any name with "key" in it
  // counts, because the value still has to look generated to be taken:
  // "hotkey: Cmd+K" stays.
  text = text.replace(
    /\b([A-Za-z0-9_.-]*(?:key|secret|token|passw(?:or)?d|pwd)[A-Za-z0-9_.-]*)(["']?\s*[:=]\s*["']?)([^\s"'`,;)&]+)/gi,
    (whole, name, between, value) => {
      if (value.includes(REMOVED)) return whole;
      const password = /passw(or)?d|pwd/i.test(name) && value.length >= 6 && !/^[$<{%]/.test(value);
      return password || looksGenerated(value) ? take(`${name}${between}`) : whole;
    },
  );
  return { text, removed };
}

// ── reading, carefully ─────────────────────────────────────────────────

type Read = { text: string } | { skip: string } | null;

function kb(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${Math.round(bytes / (1024 * 1024))} MB` : `${Math.round(bytes / 1024)} KB`;
}

/**
 * One known file, or why it was not read, or null when it is not there.
 *
 * A link is followed only to look at where it goes: if that is a credential
 * or not the kind of file the name promised, it is not opened. Someone's
 * SKILL.md pointing at their cloud credentials is a mistake to catch here,
 * not a file to import.
 */
function readKnown(path: string, max: number, wants?: RegExp): Read {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return null;
  }
  let real = path;
  if (stat.isSymbolicLink()) {
    try {
      real = realpathSync(path);
      stat = statSync(real);
    } catch {
      return { skip: "a link to something that is not there" };
    }
  }
  if (isCredentialPath(path) || isCredentialPath(real)) {
    return { skip: "looks like a file that holds a sign-in or a key, so it was not opened" };
  }
  if (wants && !wants.test(basename(real))) return { skip: "a link to a different kind of file, so it was not opened" };
  if (!stat.isFile()) return null;
  if (stat.size > max) return { skip: `larger than ${kb(max)}, so it was left alone` };
  try {
    return { text: readFileSync(real, "utf8").replace(/\r\n/g, "\n") };
  } catch {
    return { skip: "could not be read" };
  }
}

function isFolder(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Folders inside a folder, by name, without the hidden ones. */
function foldersIn(dir: string, max: number): string[] {
  try {
    return readdirSync(dir)
      .filter((name) => !name.startsWith(".") && isFolder(join(dir, name)))
      .sort()
      .slice(0, max);
  } catch {
    return [];
  }
}

function filesIn(dir: string, pattern: RegExp, max: number): string[] {
  try {
    return readdirSync(dir)
      .filter((name) => pattern.test(name) && !name.startsWith("."))
      .sort()
      .slice(0, max);
  } catch {
    return [];
  }
}

function fromHome(home: string, path: string): string {
  const rel = relative(home, path);
  return rel && !rel.startsWith("..") ? `~/${rel.split(sep).join("/")}` : path;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** What a file an import wrote is known by, so an undo takes it back
 * only while it is still those bytes. */
export function bytesHash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function removedNote(removed: number): string[] {
  return removed
    ? [`${plural(removed, "thing that looked like a key or a password was", "things that looked like keys or passwords were")} taken out.`]
    : [];
}

// ── frontmatter ────────────────────────────────────────────────────────

/**
 * name and description from a SKILL.md's frontmatter, and the body after it.
 *
 * Skills written for other tools often fold a long description over
 * several lines with YAML's `|` or `>`. The library's own reader takes one
 * line per key, so this reads the folded form too, and a list written one
 * `- item` to a line, which subagents use for their tools, and nothing
 * else of YAML: the other keys belong to the tool the skill came from.
 *
 * `meta` is every top level key it could read, lower-cased, a list
 * joined with commas. `broken` is a header that opens and never closes,
 * which is a file to leave out rather than one to import with its
 * header pasted into the body.
 */
export function readFrontmatter(markdown: string): {
  name?: string;
  description?: string;
  body: string;
  meta: Record<string, string>;
  broken?: boolean;
} {
  const match = markdown.match(/^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)([\s\S]*)$/);
  const meta: Record<string, string> = Object.create(null);
  if (!match) {
    return /^---[ \t]*\n/.test(markdown) ? { body: markdown.trim(), meta, broken: true } : { body: markdown.trim(), meta };
  }
  const lines = match[1].split("\n");
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (!kv) continue;
    let value = kv[2].trim();
    if (/^[|>][+-]?$/.test(value)) {
      const folded: string[] = [];
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || !lines[i + 1].trim())) folded.push(lines[++i].trim());
      value = folded.filter(Boolean).join(" ");
    } else if (!value) {
      // a block list; anything more deeply nested under an item is that
      // item's own business and is passed over
      const items: string[] = [];
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || /^-\s/.test(lines[i + 1]) || !lines[i + 1].trim())) {
        const item = /^\s*-\s+(.*)$/.exec(lines[++i]);
        if (item) items.push(item[1].trim().replace(/^["']|["']$/g, ""));
      }
      value = items.join(", ");
    }
    meta[kv[1].toLowerCase()] = value.replace(/^["']|["']$/g, "");
  }
  return { name: meta.name, description: meta.description, body: match[2].trim(), meta };
}

/** A frontmatter value that may be a list, as one: `a, b`, `[a, b]` and a
 * block list all read the same. A tool spec with spaces in it, `Bash(git
 * log)`, stays one item. */
export function listOf(value: string | undefined): string[] {
  if (!value) return [];
  const inner = value.trim().replace(/^\[(.*)\]$/s, "$1");
  const out: string[] = [];
  let depth = 0;
  let here = "";
  const split = inner.includes(",") ? "," : " ";
  for (const c of inner) {
    if (c === "(") depth++;
    if (c === ")") depth = Math.max(0, depth - 1);
    if (c === split && depth === 0) {
      out.push(here);
      here = "";
    } else here += c;
  }
  out.push(here);
  return out.map((v) => v.trim().replace(/^["']|["']$/g, "")).filter(Boolean).slice(0, 64);
}

// ── a little TOML ──────────────────────────────────────────────────────

const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

class TomlReader {
  s: string;
  i = 0;
  constructor(text: string) {
    this.s = text;
  }
  done() {
    return this.i >= this.s.length;
  }
  at(text: string) {
    return this.s.startsWith(text, this.i);
  }
  fail(): never {
    throw new Error(`unreadable at ${this.i}`);
  }
  expect(text: string) {
    this.spaces();
    if (!this.at(text)) this.fail();
    this.i += text.length;
  }
  spaces() {
    while (this.s[this.i] === " " || this.s[this.i] === "\t") this.i++;
  }
  /** Spaces, line ends and comments: what may sit between statements and
   * between the items of a list. */
  blank() {
    for (;;) {
      this.spaces();
      const c = this.s[this.i];
      if (c === "\n" || c === "\r") this.i++;
      else if (c === "#") this.comment();
      else return;
    }
  }
  comment() {
    while (!this.done() && this.s[this.i] !== "\n") this.i++;
  }
  skipLine() {
    this.comment();
    if (!this.done()) this.i++;
  }
  endOfLine() {
    this.spaces();
    if (this.s[this.i] === "#") this.comment();
    if (this.done()) return;
    if (this.at("\r\n")) this.i += 2;
    else if (this.s[this.i] === "\n") this.i++;
    else this.fail();
  }
  key(): string {
    this.spaces();
    const c = this.s[this.i];
    if (c === '"') return this.basic();
    if (c === "'") return this.literal();
    const m = /^[A-Za-z0-9_-]+/.exec(this.s.slice(this.i, this.i + 256));
    if (!m) this.fail();
    this.i += m[0].length;
    return m[0];
  }
  keyPath(): string[] {
    const path = [this.key()];
    this.spaces();
    while (this.s[this.i] === ".") {
      this.i++;
      path.push(this.key());
      this.spaces();
    }
    if (path.some((part) => UNSAFE_KEYS.has(part))) this.fail();
    return path;
  }
  basic(): string {
    if (this.at('"""')) return this.multiBasic();
    this.i++;
    let out = "";
    for (;;) {
      if (this.done()) this.fail();
      const c = this.s[this.i++];
      if (c === '"') return out;
      if (c === "\n") this.fail();
      out += c === "\\" ? this.escape() : c;
    }
  }
  escape(): string {
    const c = this.s[this.i++];
    const simple: Record<string, string> = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", '"': '"', "\\": "\\" };
    if (c in simple) return simple[c];
    if (c === "u" || c === "U") {
      const width = c === "u" ? 4 : 8;
      const hex = this.s.slice(this.i, this.i + width);
      if (!/^[0-9A-Fa-f]+$/.test(hex) || hex.length !== width) this.fail();
      this.i += width;
      return String.fromCodePoint(parseInt(hex, 16));
    }
    this.fail();
  }
  multiBasic(): string {
    this.i += 3;
    if (this.at("\r\n")) this.i += 2;
    else if (this.s[this.i] === "\n") this.i++;
    let out = "";
    for (;;) {
      if (this.done()) this.fail();
      if (this.at('"""')) {
        this.i += 3;
        return out;
      }
      const c = this.s[this.i++];
      if (c === "\\") {
        // a backslash at the end of a line joins it to the next
        if (/^[ \t]*\r?\n/.test(this.s.slice(this.i, this.i + 64))) {
          while (/\s/.test(this.s[this.i] ?? "")) this.i++;
        } else out += this.escape();
      } else out += c;
    }
  }
  literal(): string {
    if (this.at("'''")) {
      this.i += 3;
      if (this.at("\r\n")) this.i += 2;
      else if (this.s[this.i] === "\n") this.i++;
      const end = this.s.indexOf("'''", this.i);
      if (end < 0) this.fail();
      const out = this.s.slice(this.i, end);
      this.i = end + 3;
      return out;
    }
    this.i++;
    const end = this.s.indexOf("'", this.i);
    const line = this.s.indexOf("\n", this.i);
    if (end < 0 || (line >= 0 && line < end)) this.fail();
    const out = this.s.slice(this.i, end);
    this.i = end + 1;
    return out;
  }
  value(): unknown {
    this.spaces();
    const c = this.s[this.i];
    if (c === '"') return this.basic();
    if (c === "'") return this.literal();
    if (c === "[") return this.array();
    if (c === "{") return this.inline();
    const m = /^[^\s,\]}#]+/.exec(this.s.slice(this.i, this.i + 256));
    if (!m) this.fail();
    this.i += m[0].length;
    const token = m[0];
    if (token === "true") return true;
    if (token === "false") return false;
    if (/^[+-]?\d[\d_]*(\.\d[\d_]*)?([eE][+-]?\d+)?$/.test(token)) return Number(token.replace(/_/g, ""));
    // dates, hex, inf: kept as written, since nothing here needs them
    return token;
  }
  array(): unknown[] {
    this.i++;
    const out: unknown[] = [];
    for (;;) {
      this.blank();
      if (this.s[this.i] === "]") {
        this.i++;
        return out;
      }
      out.push(this.value());
      this.blank();
      if (this.s[this.i] === ",") this.i++;
      else if (this.s[this.i] !== "]") this.fail();
    }
  }
  inline(): Record<string, unknown> {
    this.i++;
    const out: Record<string, unknown> = {};
    this.spaces();
    if (this.s[this.i] === "}") {
      this.i++;
      return out;
    }
    for (;;) {
      const path = this.keyPath();
      this.expect("=");
      assign(out, path, this.value());
      this.spaces();
      if (this.s[this.i] === ",") {
        this.i++;
        continue;
      }
      if (this.s[this.i] === "}") {
        this.i++;
        return out;
      }
      this.fail();
    }
  }
}

function tableAt(root: Record<string, unknown>, path: string[]): Record<string, unknown> {
  let here = root;
  for (const part of path) {
    const next = here[part];
    if (next === undefined) here = here[part] = {};
    else if (isRecord(next)) here = next;
    else throw new Error("not a table");
  }
  return here;
}

function assign(table: Record<string, unknown>, path: string[], value: unknown) {
  tableAt(table, path.slice(0, -1))[path[path.length - 1]] = value;
}

/**
 * The parts of a TOML file a config needs: tables, dotted and quoted keys,
 * strings of all four kinds, numbers, booleans, lists over several lines
 * and inline tables. Arrays of tables are skipped.
 *
 * Written here rather than added as a dependency, because the one file it
 * reads is small and the answer it needs is a handful of strings. A line
 * it cannot read is left out rather than failing the whole file: one odd
 * setting should not hide every server the person has.
 */
export function parseToml(text: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  let current: Record<string, unknown> | null = root;
  const r = new TomlReader(text);
  for (;;) {
    r.blank();
    if (r.done()) return root;
    const start = r.i;
    const header = r.at("[");
    // Each statement takes effect only once its whole line has read
    // cleanly, so "key = = 2" leaves nothing behind.
    try {
      if (r.at("[[")) {
        r.i += 2;
        r.keyPath();
        r.expect("]]");
        r.endOfLine();
        current = null;
      } else if (header) {
        r.i += 1;
        const path = r.keyPath();
        r.expect("]");
        r.endOfLine();
        current = tableAt(root, path);
      } else {
        const path = r.keyPath();
        r.expect("=");
        const value = r.value();
        r.endOfLine();
        if (current) assign(current, path, value);
      }
    } catch {
      // a table that cannot be read takes its keys with it, rather than
      // letting them land in the table before it
      if (header) current = null;
      r.i = start;
      r.skipLine();
    }
  }
}

// ── permission rules ───────────────────────────────────────────────────

export type RuleMapping =
  | { rule: { effect: Effect; field: Field; op: Op; value: string; tool?: string }; notes: string[] }
  | { skip: string };

/**
 * One permission rule from Claude Code's settings, as a Bloks rule, or why
 * it cannot be one.
 *
 * A Bloks rule looks at one thing (the tool, the command, the path or the
 * address) where theirs pairs a tool with a pattern. So the translation
 * is allowed to be broader than the original only when it denies: a deny
 * that catches a little more is still a deny. An allow that would let
 * agents do more than the original allowed is left out and says why,
 * because quietly widening what runs without asking is the one mistake an
 * import of rules must not make.
 */
export function ruleFromPermission(pattern: string, effect: Effect, home: string): RuleMapping {
  const raw = pattern.trim();
  const m = /^([A-Za-z_][\w.-]*)(?:\((.*)\))?$/s.exec(raw);
  if (!m) return { skip: "not a rule Bloks can read" };
  const [, tool, spec] = m;
  const deny = effect === "deny";
  const out = (field: Field, op: Op, value: string, notes: string[] = []): RuleMapping =>
    value.length > 200 ? { skip: "longer than a Bloks rule holds" } : { rule: { effect, field, op, value }, notes };

  if (isQuestionTool(tool)) return { skip: "that tool asks you a question, which a rule cannot answer" };

  if (tool.startsWith("mcp__")) {
    if (spec !== undefined) return { skip: "not a rule Bloks can read" };
    const [, server, name] = tool.split("__");
    if (!server) return { skip: "not a rule Bloks can read" };
    // Bloks mounts a person's own servers under a prefix of its own, so the
    // full name never matches; the server and tool part always does.
    return out("tool", "contains", name ? `${server}__${name}` : `${server}__`);
  }

  if (spec === undefined || spec.trim() === "" || spec.trim() === "*") {
    return out("tool", "equals", tool, [`Engines name their tools differently, so this matches the one called ${tool}.`]);
  }

  if (tool === "Bash") {
    let command = spec.trim();
    let prefix = false;
    if (command.endsWith(":*")) {
      command = command.slice(0, -2);
      prefix = true;
    } else if (/\s\*$/.test(command)) {
      command = command.slice(0, -1).trimEnd();
      prefix = true;
    }
    if (command.includes("*")) return { skip: "a wildcard in the middle of a command cannot be said as a Bloks rule" };
    if (!command) return { skip: "not a rule Bloks can read" };
    if (deny) {
      return out("command", "contains", command, ["Bloks refuses any command with these words in it, wherever they come."]);
    }
    // Claude Code does not let a prefix rule through with a second
    // command chained after it, and neither may the translation: "runs"
    // is one plain command whose words begin with these, where "starts
    // with" would let `npm test; curl ... | sh` through.
    if (prefix && !plainWords(command)) return { skip: "not one plain command, so Bloks cannot be sure what it would let through" };
    return prefix
      ? out("command", "runs", command, ["Bloks lets it through only as one plain command starting with these words, with nothing chained after it."])
      : out("command", "equals", command);
  }

  if (tool === "WebFetch") {
    const domain = /^domain:([A-Za-z0-9.-]+)$/.exec(spec.trim())?.[1];
    if (!domain) return { skip: "not a rule Bloks can read" };
    return deny
      ? out("url", "contains", domain.toLowerCase())
      : out("url", "starts-with", `https://${domain.toLowerCase()}/`, ["Only https addresses on that host itself."]);
  }

  if (["Read", "Edit", "Write", "MultiEdit", "NotebookEdit", "Glob", "Grep", "LS"].includes(tool)) {
    // A Bloks rule about a path covers every tool unless it names one, so
    // an allow written for reading names Read, and the other ways of
    // looking, which engines name differently, are left out.
    if (!deny && ["Glob", "Grep", "LS"].includes(tool)) {
      return { skip: "a Bloks rule about a path covers every tool, so this would let agents change files there too, not only read them" };
    }
    const path = pathRule(spec.trim(), home);
    if (!path) return { skip: "a path pattern Bloks rules cannot express" };
    if (!deny && !path.exact) {
      return { skip: "relative to a project folder, which a rule for every agent cannot know, so it would allow more than it did" };
    }
    if (!deny && tool === "Read") {
      const made = out("path", path.op, path.value, ["Only for reading, through the tool called Read."]);
      return "rule" in made ? { ...made, rule: { ...made.rule, tool: "Read" } } : made;
    }
    return out("path", path.op, path.value, deny ? [`Applies to every tool that names the path, not only ${tool}.`] : []);
  }

  return { skip: "Bloks cannot read that kind of rule" };
}

/** A path pattern as one comparison, and whether that comparison is as
 * narrow as the pattern was. */
function pathRule(pattern: string, home: string): { op: Op; value: string; exact: boolean } | null {
  let p = pattern;
  let absolute = false;
  if (p.startsWith("//")) {
    p = p.slice(1);
    absolute = true;
  } else if (p.startsWith("~/")) {
    p = `${home}/${p.slice(2)}`;
    absolute = true;
  } else if (p.startsWith("/")) {
    // relative to the settings file, which for these is ~/.claude
    p = `${home}/.claude${p}`;
    absolute = true;
  } else if (p.startsWith("./")) {
    p = p.slice(2);
  }
  const dir = /^(.*?)\/(\*\*|\*\*\/\*|\*)$/.exec(p);
  if (dir && !dir[1].includes("*")) {
    return absolute
      ? { op: "starts-with", value: `${dir[1]}/`, exact: true }
      : { op: "contains", value: `/${dir[1].replace(/^\/+/, "")}/`, exact: false };
  }
  const anywhere = /^(?:\*\*\/)?(.*)$/.exec(p)![1];
  if (!absolute && /^\*\.[\w.-]+$/.test(anywhere)) return { op: "ends-with", value: anywhere.slice(1), exact: false };
  if (p.includes("*")) return null;
  return absolute ? { op: "equals", value: p, exact: true } : { op: "ends-with", value: `/${p}`, exact: false };
}

// ── facts about the person ─────────────────────────────────────────────

/**
 * Short facts out of a USER.md, one per line.
 *
 * These files often start from a template with labels and no answers
 * ("- **Name:**"), questions to fill in, and placeholders in brackets.
 * Those are left out, as are lines too long to be one fact and any line
 * that had something key-shaped in it: a fact that held a secret is
 * dropped whole rather than kept with a hole in it.
 */
export function factsFrom(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let fenced = false;
  for (const piece of text.split(/\n|§/)) {
    const line = piece.trim();
    if (line.startsWith("```")) {
      fenced = !fenced;
      continue;
    }
    if (fenced || !line || line.startsWith("#") || line.startsWith("<!--") || line.startsWith(">")) continue;
    let fact = line
      .replace(/^(?:[-*+]|\d+[.)])\s+/, "")
      .replace(/\*\*|__|`/g, "")
      .replace(/^[*_]+|[*_]+$/g, "")
      .trim();
    if (/^\(.*\)$/.test(fact) || /^\[.*\]$/.test(fact) || fact.endsWith("?")) continue;
    if (/^[^:]{1,40}:\s*$/.test(fact)) continue;
    if (fact.length > MAX_NOTE) continue;
    if (scrubSecrets(fact).removed) continue;
    fact = cleanNote(fact);
    const shape = fact.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
    if (shape.length < 3 || seen.has(shape)) continue;
    seen.add(shape);
    out.push(fact);
    if (out.length >= MAX_FACTS_PER_SOURCE) break;
  }
  return out;
}

// ── MCP servers ────────────────────────────────────────────────────────

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function quoted(arg: string): string {
  return /[\s"']/.test(arg) ? JSON.stringify(arg) : arg;
}

/**
 * One server entry from another tool's config, with every credential gone.
 *
 * Environment values and header values are dropped whole, not scrubbed:
 * that is where a server's keys live, and a value that does not look like
 * a key is no promise that it is not one. The names stay, so the person
 * can see what to fill in. An argument after a flag like --api-key goes
 * the same way, and anything key-shaped in the command, the other
 * arguments or the address is taken out.
 *
 * What was dropped is still known, apart from the server: `values` holds
 * each literal value the config had, by slot, for an import the person
 * says yes to; `refs` names the variable a value was read from, which is
 * the other tool's shell and not something to copy.
 */
export function mcpFrom(
  rawName: string,
  raw: unknown,
  sourceName: string,
  home = "",
): { mcp: McpImport; notes: string[]; values: Map<string, string>; refs: Map<string, string> } | { skip: string } {
  if (!isRecord(raw)) return { skip: "not a server entry Bloks can read" };
  const name = rawName.replace(/[\x00-\x1f]/g, "").trim().slice(0, 40);
  if (!name) return { skip: "a server with no name" };
  if (raw.type === "ws" || raw.type === "sdk") return { skip: "a kind of server that only its own tool can start" };
  const notes: string[] = [];
  const values = new Map<string, string>();
  const refs = new Map<string, string>();
  let removed = 0;
  const scrub = (value: string) => {
    const s = scrubSecrets(value);
    removed += s.removed;
    return s.text;
  };
  // Cursor's own variables. The home folder is this one; a project folder
  // is something a server for every agent does not have.
  let project = false;
  const expand = (value: string) => {
    if (/\$\{workspaceFolder(Basename)?\}/.test(value)) project = true;
    return home ? value.replace(/\$\{userHome\}/g, home).replace(/\$\{pathSeparator\}|\$\{\/\}/g, sep) : value;
  };

  const url = expand(typeof raw.url === "string" ? raw.url.trim() : typeof raw.serverUrl === "string" ? raw.serverUrl.trim() : "");
  const command = expand(typeof raw.command === "string" ? raw.command.trim() : "");
  const transport: McpImport["transport"] = command ? "stdio" : "http";
  const mcp: McpImport = { name, transport };

  if (transport === "stdio") {
    mcp.command = scrub(command).slice(0, 300);
    const args: string[] = [];
    const given = strings(raw.args).slice(0, MAX_ARGS);
    for (let i = 0; i < given.length; i++) {
      const arg = expand(given[i].slice(0, 1000));
      const flag = /^(--?[\w-]+)=(.*)$/.exec(arg);
      if (flag && SECRET_NAME.test(flag[1]) && flag[2]) {
        args.push(`${flag[1]}=`);
        notes.push(`The value of ${flag[1]} was left out. Add it in the server's environment, or register it again with the value.`);
        continue;
      }
      args.push(scrub(arg));
      if (/^--?[\w-]+$/.test(arg) && SECRET_NAME.test(arg) && i + 1 < given.length && !given[i + 1].startsWith("-")) {
        args.push("");
        i++;
        notes.push(`The value after ${arg} was left out. Add it in the server's environment, or register it again with the value.`);
      }
    }
    if (args.length) mcp.args = args;
  } else {
    if (!/^https?:\/\//i.test(url)) return { skip: "neither a command to run nor an http address" };
    mcp.url = scrub(url).slice(0, 400);
    if (raw.type === "sse") notes.push("It speaks SSE there. Bloks connects over streamable HTTP, so check the server answers at this address.");
  }

  // Values never cross. Names a program reads to decide how to start
  // (PATH, NODE_OPTIONS and the like) are not carried either: the engine
  // already passes its own, and a blank one would break the server.
  const envNames = new Set<string>();
  const dropped: string[] = [];
  const env = isRecord(raw.env) ? raw.env : {};
  // Codex forwards some variables from the shell by name, written either
  // as the name or as { name, source }
  const forwarded = Array.isArray(raw.env_vars)
    ? raw.env_vars.map((v) => (typeof v === "string" ? v : isRecord(v) && typeof v.name === "string" ? v.name : "")).filter(Boolean)
    : [];
  for (const envName of [...Object.keys(env), ...forwarded]) {
    if (!ENV_NAME.test(envName)) continue;
    if (reservedEnvName(envName.toUpperCase())) dropped.push(envName);
    else if (envNames.size < MAX_ENV_NAMES) envNames.add(envName);
  }
  if (dropped.length) notes.push(`${dropped.join(", ")} ${dropped.length === 1 ? "was" : "were"} not carried: ${dropped.length === 1 ? "it changes" : "they change"} how programs start, so set ${dropped.length === 1 ? "it" : "them"} yourself if the server needs ${dropped.length === 1 ? "it" : "them"}.`);
  for (const envName of envNames) {
    const value = env[envName];
    if (typeof value === "string") remember(`env:${envName}`, value, values, refs);
    else if (forwarded.includes(envName)) refs.set(`env:${envName}`, envName);
  }

  const headerNames = new Set<string>();
  const literal = [raw.headers, raw.http_headers].filter(isRecord);
  const fromEnv = isRecord(raw.env_http_headers) ? raw.env_http_headers : {};
  for (const table of [...literal, fromEnv]) {
    for (const header of Object.keys(table)) {
      if (!HEADER_NAME.test(header) || headerNames.size >= MAX_HEADER_NAMES) continue;
      headerNames.add(header);
      const value = table[header];
      if (typeof value !== "string") continue;
      if (table === fromEnv) refs.set(`header:${header}`, value);
      else remember(`header:${header}`, value, values, refs);
    }
  }
  if (typeof raw.bearer_token_env_var === "string" && headerNames.size < MAX_HEADER_NAMES) {
    headerNames.add("Authorization");
    refs.set("header:Authorization", raw.bearer_token_env_var);
  }
  if (transport === "stdio") headerNames.clear();
  for (const slot of [...values.keys(), ...refs.keys()]) {
    if (slot.startsWith("header:") && !headerNames.has(slot.slice("header:".length))) {
      values.delete(slot);
      refs.delete(slot);
    }
  }

  if (envNames.size) mcp.env = Object.fromEntries([...envNames].map((n) => [n, ""]));
  if (headerNames.size) mcp.headers = Object.fromEntries([...headerNames].map((n) => [n, ""]));
  const needs = [...envNames, ...headerNames];
  if (needs.length) {
    notes.push(
      `${needs.join(", ")} ${needs.length === 1 ? "was" : "were"} not copied. Fill ${needs.length === 1 ? "it" : "them"} in here, or later under Settings, Apps and keys.`,
    );
  }
  if (typeof raw.envFile === "string") notes.push("It also read its environment from a file, which Bloks does not open. Fill in what it needs.");
  if (raw.headersHelper !== undefined || raw.http_headers_helper !== undefined) {
    notes.push(`${sourceName} ran a command to make its headers, which is not carried. Fill them in instead.`);
  }
  if (isRecord(raw.oauth) || isRecord(raw.auth)) notes.push("It signs in with OAuth there. Sign in again from Bloks once it is added.");
  if (project) notes.push("It names the project folder it ran in, which a server for every agent does not have. Check its command before using it.");
  if (raw.enabled === false || raw.disabled === true) notes.push(`It is switched off in ${sourceName}.`);
  notes.unshift(...removedNote(removed));
  return { mcp, notes, values, refs };
}

/**
 * A config value, as something to copy or as the variable it names.
 *
 * `${NAME}`, `${NAME:-default}`, `${env:NAME}` and `$NAME` are read from
 * the other tool's shell when it starts the server, which is not this
 * process's environment and not something to go looking in. So is a
 * value with one inside it, `Bearer ${TOKEN}`, which copied as it is
 * would be the words rather than the key. Anything else is the value.
 */
function remember(slot: string, raw: string, values: Map<string, string>, refs: Map<string, string>) {
  const value = raw.trim();
  if (!value) return;
  const ref = /\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}/.exec(value) ?? /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(value);
  if (ref) refs.set(slot, ref[1]);
  else if (value.length <= MAX_SECRET_CHARS && !/[\x00-\x08\x0b-\x1f]/.test(value)) values.set(slot, value);
}

/** The fields the window shows for a server's missing values. */
function slotsFor(mcp: McpImport, values: Map<string, string>, refs: Map<string, string>, from: string): SecretSlot[] {
  const slots: SecretSlot[] = [];
  for (const [where, names] of [["env", Object.keys(mcp.env ?? {})], ["header", Object.keys(mcp.headers ?? {})]] as const) {
    for (const name of names) {
      const id = `${where}:${name}`;
      slots.push({
        id,
        name,
        where,
        ...(values.has(id) ? { copyFrom: from } : {}),
        ...(refs.has(id) ? { ref: refs.get(id) } : {}),
      });
    }
  }
  return slots;
}

function mcpPreview(mcp: McpImport): string {
  const head = mcp.transport === "stdio" ? [mcp.command ?? "", ...(mcp.args ?? [])].map(quoted).join(" ") : (mcp.url ?? "");
  const fill = [...Object.keys(mcp.env ?? {}), ...Object.keys(mcp.headers ?? {})].map((n) => `${n}: (you fill this in)`);
  return [head, ...fill].join("\n");
}

// ── items ──────────────────────────────────────────────────────────────

type Builder = { items: FoundItem[]; skipped: Skipped[]; home: string; source: SourceId };

function digestOf(payload: unknown): string {
  return sha256(JSON.stringify(payload));
}

/** JSON, or JSON with the comments and trailing commas people keep in a
 * config by hand. Undefined when it is neither. The fast reader first,
 * since ~/.claude.json can run to megabytes. */
function readJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    try {
      return parseJson5(text);
    } catch {
      return undefined;
    }
  }
}

interface TextExtra {
  title?: string;
  topic?: string;
  /** A header to take off first, as rule files have. */
  frontmatter?: boolean;
  /** What else to say about this file, from what it holds. */
  say?: (raw: string, meta: Record<string, string>) => string[];
  /** What else a file may be called: .mdc for Cursor's rules. */
  wants?: RegExp;
}

/** Instructions or memory, from one text file. */
function addText(b: Builder, kind: "instructions" | "memory", path: string, extra: TextExtra = {}) {
  const from = fromHome(b.home, path);
  const read = readKnown(path, MAX_TEXT_FILE_BYTES, extra.wants ?? /\.md$/i);
  if (!read) return;
  if ("skip" in read) return void b.skipped.push({ from, why: read.skip });
  let raw = read.text;
  let meta: Record<string, string> = {};
  if (extra.frontmatter) {
    const parsed = readFrontmatter(raw);
    if (parsed.broken) return void b.skipped.push({ from, why: "its header is never closed, so Bloks cannot tell where the text starts" });
    raw = parsed.body;
    meta = parsed.meta;
  }
  const { text, removed } = scrubSecrets(raw);
  const body = text.trim();
  if (!body) return;
  const title = extra.title ?? basename(path);
  const notes = [...removedNote(removed), ...(extra.say?.(raw, meta) ?? [])];
  let destinations: Destination[] = kind === "memory" ? ["memory"] : ["brief", "memory"];
  if (kind === "instructions" && body.length > MAX_DESCRIPTION_CHARS) {
    destinations = ["memory"];
    notes.push(`Longer than an agent's instructions hold (${MAX_DESCRIPTION_CHARS.toLocaleString("en-US")} characters), so it goes to memory, which an agent reads every turn.`);
  }
  b.items.push({
    key: `${b.source}:${kind}:${extra.topic ? `memory/${extra.topic}` : title}`,
    source: b.source,
    kind,
    title,
    from,
    text: body,
    digest: digestOf({ kind, text: body, topic: extra.topic ?? null }),
    notes,
    destinations,
    ...(extra.topic ? { topic: extra.topic } : {}),
  });
}

/** A memory topic name the workspace will accept, from a file name. */
function topicName(file: string): string {
  const stem = file.replace(/\.md$/i, "").replace(/[^\w .-]+/g, "-").replace(/^[^\w]+/, "").slice(0, 100);
  return `${stem || "notes"}.md`;
}

function addTopics(b: Builder, dir: string) {
  for (const file of filesIn(dir, /\.md$/i, MAX_TOPICS_PER_SOURCE)) {
    addText(b, "memory", join(dir, file), { title: `memory/${file}`, topic: topicName(file) });
  }
}

/** A skill folder's SKILL.md. `tag` keeps two folders of one tool apart
 * when both hold a skill by the same name; `owner` is the agent it came
 * with, in a tool whose agents keep skills of their own. */
function addSkill(b: Builder, dir: string, tag = "", owner?: FoundItem["owner"]) {
  const path = join(dir, "SKILL.md");
  const from = fromHome(b.home, path);
  const read = readKnown(path, MAX_SKILL_FILE_BYTES, /\.md$/i);
  if (!read) return;
  if ("skip" in read) return void b.skipped.push({ from, why: read.skip });
  const parsed = readFrontmatter(read.text);
  if (parsed.broken) return void b.skipped.push({ from, why: "its header is never closed, so Bloks cannot tell where the instructions start" });
  const folder = basename(dir);
  const others = (() => {
    try {
      return readdirSync(dir).filter((f) => f !== "SKILL.md" && !f.startsWith(".")).length;
    } catch {
      return 0; // the skill itself was readable, which is what matters
    }
  })();
  const notes =
    others > 0
      ? [`Only its instructions come across. The ${plural(others, "other file", "other files")} in its folder stay${others === 1 ? "s" : ""} in ${fromHome(b.home, dir)}.`]
      : [];
  pushSkill(b, { key: `${b.source}:skill:${tag}${folder}`, id: folder, from, parsed, notes, owner });
}

/** One skill item, from whatever file it was made from. */
function pushSkill(
  b: Builder,
  input: {
    key: string;
    id: string;
    from: string;
    parsed: { name?: string; description?: string; body: string };
    notes?: string[];
    title?: string;
    head?: string;
    owner?: FoundItem["owner"];
  },
) {
  const { text: scrubbed, removed } = scrubSecrets(input.parsed.body);
  if (!scrubbed.trim()) return void b.skipped.push({ from: input.from, why: "it has no instructions" });
  const body = input.head ? `${input.head}\n\n${scrubbed.trim()}` : scrubbed.trim();
  if (countChars(body) > MAX_SKILL_CHARS) {
    return void b.skipped.push({ from: input.from, why: `longer than a skill holds (${MAX_SKILL_CHARS.toLocaleString("en-US")} characters)` });
  }
  if (b.items.some((i) => i.key === input.key)) {
    return void b.skipped.push({ from: input.from, why: "a skill by the same name is already listed from this tool" });
  }
  const name = scrubSecrets(input.parsed.name?.trim() || input.id).text.slice(0, 80);
  const firstLine = scrubbed.split("\n").find((l) => l.trim() && !l.startsWith("#"))?.trim() ?? "";
  const description = scrubSecrets(input.parsed.description?.trim() || firstLine).text.slice(0, 200);
  const skill = { id: slugify(input.id), name, description, body };
  b.items.push({
    key: input.key,
    source: b.source,
    kind: "skill",
    title: input.title ?? name,
    from: input.from,
    text: skill.body,
    digest: digestOf({ kind: "skill", ...skill }),
    notes: [...removedNote(removed), ...(input.notes ?? [])],
    destinations: ["skills"],
    skill,
    ...(input.owner ? { owner: input.owner } : {}),
  });
}

function addMcp(b: Builder, name: string, raw: unknown, from: string, extra: string[] = []) {
  const made = mcpFrom(name, raw, SOURCE_NAMES[b.source], b.home);
  if ("skip" in made) return void b.skipped.push({ from: `${from}: ${name}`, why: made.skip });
  const mcp = made.mcp;
  const key = `${b.source}:mcp:${mcp.name}`;
  // the same name in two of one tool's files: the first one read wins,
  // which is the order the tool itself gives them
  if (b.items.some((i) => i.key === key)) return void b.skipped.push({ from: `${from}: ${name}`, why: "a server by the same name is already listed from this tool" });
  const item: FoundItem = {
    key,
    source: b.source,
    kind: "mcp",
    title: mcp.name,
    from,
    text: mcpPreview(mcp),
    digest: digestOf({ kind: "mcp", ...mcp }),
    notes: [...made.notes, ...extra],
    destinations: ["mcp"],
    mcp,
  };
  const slots = slotsFor(mcp, made.values, made.refs, from);
  if (slots.length) item.secrets = slots;
  if (made.values.size) SECRET_VALUES.set(item, made.values);
  b.items.push(item);
}

/** Every server in one config file's `mcpServers`, or why none were. */
function addMcpFile(b: Builder, path: string, extra: string[] = [], key = "mcpServers") {
  const from = fromHome(b.home, path);
  const read = readKnown(path, MAX_CONFIG_JSON_BYTES, /\.json5?$/i);
  if (!read) return;
  if ("skip" in read) return void b.skipped.push({ from, why: read.skip });
  const parsed = readJson(read.text);
  if (parsed === undefined) return void b.skipped.push({ from, why: "not JSON Bloks can read" });
  const servers = isRecord(parsed) && isRecord(parsed[key]) ? parsed[key] : {};
  for (const name of Object.keys(servers).slice(0, MAX_MCP_PER_SOURCE)) addMcp(b, name, servers[name], from, extra);
}

function addFacts(b: Builder, path: string) {
  const from = fromHome(b.home, path);
  const read = readKnown(path, MAX_TEXT_FILE_BYTES, /\.md$/i);
  if (!read) return;
  if ("skip" in read) return void b.skipped.push({ from, why: read.skip });
  for (const fact of factsFrom(read.text)) {
    const shape = fact.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
    b.items.push({
      key: `${b.source}:fact:${sha256(shape).slice(0, 16)}`,
      source: b.source,
      kind: "fact",
      title: fact,
      from,
      text: fact,
      digest: digestOf({ kind: "fact", fact }),
      notes: [],
      destinations: ["about"],
    });
  }
}

/** Claude Code's settings.json: its permission rules become rule items,
 * and the rest of it is handed back for what else is worth reading. */
function addRules(b: Builder, path: string): Record<string, unknown> | null {
  const from = fromHome(b.home, path);
  const read = readKnown(path, MAX_SETTINGS_BYTES, /\.json$/i);
  if (!read) return null;
  if ("skip" in read) {
    b.skipped.push({ from, why: read.skip });
    return null;
  }
  const settings = readJson(read.text);
  if (!isRecord(settings)) {
    b.skipped.push({ from, why: "not JSON Bloks can read" });
    return null;
  }
  const permissions = isRecord(settings.permissions) ? settings.permissions : {};
  let count = 0;
  for (const effect of ["deny", "allow"] as const) {
    for (const pattern of strings(permissions[effect])) {
      if (count >= MAX_RULES_PER_SOURCE) return settings;
      const label = `${effect === "deny" ? "Deny" : "Allow"} ${pattern.slice(0, 200)}`;
      const mapped = ruleFromPermission(pattern, effect, b.home);
      if ("skip" in mapped) {
        b.skipped.push({ from: `${from}: ${label}`, why: mapped.skip });
        continue;
      }
      count++;
      const rule = mapped.rule;
      const summary = describeRule({ ...rule, id: "", enabled: true, createdAt: 0 });
      b.items.push({
        key: `${b.source}:rule:${effect}:${pattern.slice(0, 200)}`,
        source: b.source,
        kind: "rule",
        title: label,
        from,
        text: summary,
        digest: digestOf({ kind: "rule", ...rule }),
        notes: mapped.notes,
        destinations: ["rules"],
        rule,
      });
    }
  }
  return settings;
}

/** Markdown files under a folder and the folders in it, a few levels
 * down, as paths relative to it. Hidden names are passed over. */
function markdownUnder(dir: string, pattern: RegExp, depth: number, max: number, prefix = ""): string[] {
  const out = filesIn(dir, pattern, max).map((f) => `${prefix}${f}`);
  if (depth > 1) {
    for (const folder of foldersIn(dir, max)) {
      if (out.length >= max) break;
      out.push(...markdownUnder(join(dir, folder), pattern, depth - 1, max - out.length, `${prefix}${folder}/`));
    }
  }
  return out.slice(0, max);
}

// ── subagents ──────────────────────────────────────────────────────────

/** Tools that change something or reach out, by Claude Code's names. An
 * agent whose list leaves one out is refused it here, by a rule of its
 * own. Reading tools are never refused this way: leaving one out of a
 * list was a narrowing worth keeping only where it stopped harm. */
const ACTING_TOOLS = ["Bash", "Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch"];

/** The colours an agent can be that the other tools also name. */
const AGENT_COLORS = new Set(["red", "blue", "green", "yellow", "purple", "orange", "pink", "cyan"]);

/** Claude Code's model names, as the Claude Code engine here takes them.
 * The aliases mean the newest of each family there as they do here. */
function claudeModel(raw: string | undefined): { model?: { engine: Engine; model: string }; note?: string } {
  const value = (raw ?? "").trim();
  if (!value || value === "inherit" || value === "default") return {};
  if (/^(sonnet|opus|haiku|fable)(\[1m\])?$/i.test(value) || /^claude-[\w.-]{1,60}$/i.test(value)) {
    return { model: { engine: "claude", model: value.toLowerCase() } };
  }
  return { note: `Its model, ${value.slice(0, 60)}, is not one Bloks knows, so it runs on your default engine.` };
}

/** Frontmatter keys that mean something there and have nothing to become
 * here, said once so nobody expects them to have come across. */
const UNCARRIED: Record<string, string> = {
  permissionmode: "permission mode",
  hooks: "hooks",
  memory: "memory setting",
  isolation: "isolation",
  background: "background setting",
  is_background: "background setting",
  maxturns: "turn limit",
  initialprompt: "first prompt",
};

/**
 * Subagents: one Markdown file each, a header saying who it is and the
 * prompt below it. Claude Code and Cursor write the same shape with
 * different keys, so both are read here and told apart by `source`.
 *
 * What it may use becomes rules for that agent alone, and only ever
 * refusals: a list of allowed tools leaves the acting ones out, and those
 * become denies, so an import never lets an agent do more than it did.
 */
function addAgents(b: Builder, dir: string) {
  for (const file of filesIn(dir, /\.md$/i, MAX_AGENTS_PER_SOURCE)) {
    const path = join(dir, file);
    const from = fromHome(b.home, path);
    const read = readKnown(path, MAX_SKILL_FILE_BYTES, /\.md$/i);
    if (!read) continue;
    if ("skip" in read) {
      b.skipped.push({ from, why: read.skip });
      continue;
    }
    const parsed = readFrontmatter(read.text);
    if (parsed.broken) {
      b.skipped.push({ from, why: "its header is never closed, so Bloks cannot tell where its prompt starts" });
      continue;
    }
    const { text: prompt, removed } = scrubSecrets(parsed.body);
    if (!prompt.trim()) {
      b.skipped.push({ from, why: "it has no prompt" });
      continue;
    }
    const stem = file.replace(/\.md$/i, "");
    const name = scrubSecrets(parsed.name?.trim() || stem).text.replace(/[\x00-\x1f]/g, "").slice(0, MAX_NAME_CHARS).trim();
    if (!name) continue;
    const description = scrubSecrets(parsed.description ?? "").text.replace(/\s+/g, " ").trim();
    const meta = parsed.meta;
    const notes = removedNote(removed);

    const model = b.source === "claude" ? claudeModel(meta.model) : {};
    if (model.note) notes.push(model.note);
    if (b.source === "cursor" && meta.model && meta.model !== "inherit") {
      notes.push(`Cursor's model ${meta.model.slice(0, 60)} is not carried, so it runs on your default engine.`);
    }

    // what it may use, as refusals for this agent alone
    const deny: AgentImport["deny"] = [];
    const refuse = (tool: string) => {
      if (!deny.some((d) => d.field === "tool" && d.value === tool)) deny.push({ field: "tool", op: "equals", value: tool, label: tool });
    };
    if (b.source === "claude" && meta.tools !== undefined) {
      const allowed = new Set(listOf(meta.tools).map((t) => t.replace(/\(.*$/s, "").trim()));
      if (allowed.size) for (const tool of ACTING_TOOLS) if (!allowed.has(tool)) refuse(tool);
    }
    if (b.source === "claude") {
      for (const pattern of listOf(meta.disallowedtools)) {
        const mapped = ruleFromPermission(pattern, "deny", b.home);
        if ("skip" in mapped) notes.push(`${pattern.slice(0, 80)} is not refused here: ${mapped.skip}.`);
        else if (!deny.some((d) => d.field === mapped.rule.field && d.value === mapped.rule.value)) {
          deny.push({ field: mapped.rule.field, op: mapped.rule.op, value: mapped.rule.value, label: pattern.slice(0, 80) });
        }
      }
    }
    if (b.source === "cursor" && /^true$/i.test(meta.readonly ?? "")) for (const tool of ["Bash", "Edit", "Write", "NotebookEdit"]) refuse(tool);
    deny.splice(MAX_DENY_PER_AGENT);
    if (deny.length) {
      notes.push(`Bloks refuses ${deny.map((d) => d.label).join(", ")} for this agent, as ${SOURCE_NAMES[b.source]} did. Engines name their tools differently, so these match the names Claude Code uses.`);
    }

    const skills = listOf(meta.skills).filter((s) => /^[\w.:-]{1,80}$/.test(s));
    const servers: string[] = [];
    for (const entry of listOf(meta.mcpservers)) {
      if (entry.endsWith(":") || entry.includes("{")) notes.push("It defines a server of its own, which is not brought over. Add it under Apps and keys.");
      else if (entry.length <= 40) servers.push(entry);
    }
    const effort = isEffort(meta.effort) ? meta.effort : undefined;
    const color = AGENT_COLORS.has((meta.color ?? "").toLowerCase()) ? meta.color.toLowerCase() : undefined;
    const uncarried = [...new Set(Object.keys(meta).filter((k) => k in UNCARRIED && meta[k]).map((k) => UNCARRIED[k]))];
    if (uncarried.length) notes.push(`Its ${uncarried.join(", ")} ${uncarried.length === 1 ? "is" : "are"} not carried. Bloks asks as your rules and approvals say.`);

    const instructions = prompt.trim();
    if (instructions.length > MAX_DESCRIPTION_CHARS) {
      notes.push(`Its prompt is longer than an agent's instructions hold (${MAX_DESCRIPTION_CHARS.toLocaleString("en-US")} characters), so the whole of it goes to the agent's memory, which it reads every turn.`);
    }
    const agent: AgentImport = {
      name,
      title: (description.split(/(?<=[.!?])\s/)[0] || `Brought over from ${SOURCE_NAMES[b.source]}`).slice(0, MAX_TITLE_CHARS),
      instructions,
      ...(model.model ? { model: model.model } : {}),
      ...(effort ? { effort } : {}),
      ...(color ? { color } : {}),
      skills,
      servers,
      deny,
    };
    const about = [
      description,
      model.model ? `Model: ${model.model.model}` : "",
      skills.length ? `Skills: ${skills.join(", ")}` : "",
      servers.length ? `MCP servers: ${servers.join(", ")}` : "",
    ].filter(Boolean);
    const preview = [...about, ...(about.length ? [""] : []), instructions].join("\n");
    b.items.push({
      key: `${b.source}:agent:${stem}`,
      source: b.source,
      kind: "agent",
      title: name,
      from,
      text: preview,
      digest: digestOf({ kind: "agent", ...agent }),
      notes,
      destinations: ["agent"],
      agent,
    });
  }
}

// ── commands and prompts ───────────────────────────────────────────────

/**
 * Saved prompts a person runs by name (Claude Code's and Cursor's
 * commands, Codex's prompts) as skills. A skill is the nearest thing:
 * instructions an agent reads when they fit what was asked, which is
 * what a command was, minus the slash.
 *
 * The text is kept as written, with one line on top saying what its
 * placeholders were, since $ARGUMENTS means nothing to an agent that was
 * never told it is the rest of the person's message.
 */
function addCommands(b: Builder, dir: string, opts: { depth: number; kind: "command" | "prompt"; tag?: string }) {
  const tool = SOURCE_NAMES[b.source];
  for (const rel of markdownUnder(dir, /\.md$/i, opts.depth, MAX_COMMANDS_PER_SOURCE)) {
    const path = join(dir, rel);
    const from = fromHome(b.home, path);
    const read = readKnown(path, MAX_SKILL_FILE_BYTES, /\.md$/i);
    if (!read) continue;
    if ("skip" in read) {
      b.skipped.push({ from, why: read.skip });
      continue;
    }
    const parsed = readFrontmatter(read.text);
    if (parsed.broken) {
      b.skipped.push({ from, why: "its header is never closed, so Bloks cannot tell where its text starts" });
      continue;
    }
    const stem = rel.replace(/\.md$/i, "");
    // Claude Code names a command in a folder folder:name
    const command = opts.kind === "prompt" ? `prompts:${stem}` : stem.split("/").join(":");
    const notes: string[] = [];
    const placeholders = /\$ARGUMENTS|\$\d|\$[A-Z][A-Z0-9_]*\b/.test(parsed.body);
    const head = placeholders
      ? `Written as the /${command} command for ${tool}. Where it says $ARGUMENTS, or $1, $2 and so on, read what the person asked for${opts.kind === "prompt" ? " (in Codex $1 was the first thing they gave)" : ""}.`
      : undefined;
    if (/(^|\s)!`[^`]+`|^```!/m.test(parsed.body)) notes.push(`Lines that ran a command first in ${tool} come across as text, for the agent to run if it needs to.`);
    if (opts.kind === "prompt") notes.push("Codex calls these prompts and now suggests skills instead, which is what this becomes.");
    pushSkill(b, {
      key: `${b.source}:${opts.kind}:${opts.tag ?? ""}${stem}`,
      id: stem.replace(/\//g, "-"),
      from,
      parsed: { name: command, description: parsed.meta.description || parsed.meta["argument-hint"] && `/${command} ${parsed.meta["argument-hint"]}`, body: parsed.body },
      notes,
      title: `/${command}`,
      head,
    });
  }
}

// ── rule files ─────────────────────────────────────────────────────────

/** Claude Code's ~/.claude/rules: standing instructions, one file per
 * topic, some only for files that match. */
function addRuleFiles(b: Builder, dir: string) {
  for (const rel of markdownUnder(dir, /\.md$/i, 3, MAX_RULE_FILES_PER_SOURCE)) {
    addText(b, "instructions", join(dir, rel), {
      title: `rules/${rel}`,
      frontmatter: true,
      say: (_raw, meta) =>
        meta.paths
          ? [`${SOURCE_NAMES[b.source]} used it only for files matching ${listOf(meta.paths).join(", ").slice(0, 120)}. Here it applies to everything the agent does.`]
          : [],
    });
  }
}

/**
 * Cursor's rules, in the .mdc form it documents for a project's rules and
 * that people keep in ~/.cursor/rules too. Cursor does not document that
 * folder, so each file is read on its own and one it cannot make sense of
 * is named and left out.
 *
 * A rule that always applies is standing instructions. Any other kind is
 * applied when it fits, by its description or the files it names, which
 * is what a skill is.
 */
function addCursorRules(b: Builder, dir: string) {
  for (const rel of markdownUnder(dir, /\.mdc?$/i, 3, MAX_RULE_FILES_PER_SOURCE)) {
    const path = join(dir, rel);
    const from = fromHome(b.home, path);
    const read = readKnown(path, MAX_SKILL_FILE_BYTES, /\.mdc?$/i);
    if (!read) continue;
    if ("skip" in read) {
      b.skipped.push({ from, why: read.skip });
      continue;
    }
    const parsed = readFrontmatter(read.text);
    if (parsed.broken) {
      b.skipped.push({ from, why: "its header is never closed, so Bloks cannot tell what kind of rule it is" });
      continue;
    }
    const always = /^true$/i.test(parsed.meta.alwaysapply ?? "");
    const globs = listOf(parsed.meta.globs);
    if (always) {
      addText(b, "instructions", path, { title: `rules/${rel}`, frontmatter: true, wants: /\.mdc?$/i });
      continue;
    }
    const stem = rel.replace(/\.mdc?$/i, "");
    pushSkill(b, {
      key: `cursor:rule-file:${stem}`,
      id: stem.replace(/\//g, "-"),
      from,
      parsed: {
        name: stem.split("/").pop(),
        description: parsed.meta.description || (globs.length ? `For files matching ${globs.join(", ")}` : ""),
        body: parsed.body,
      },
      title: `rules/${rel}`,
      notes: [
        globs.length
          ? `Cursor attached it for files matching ${globs.join(", ").slice(0, 120)}. Here an agent reads it when it fits what it is doing.`
          : "Cursor applied it when it fitted. Here it is a skill, which an agent reads when it fits.",
      ],
    });
  }
}

// ── model settings ─────────────────────────────────────────────────────

/** Effort levels by other names: Codex's lowest and highest. */
function effortFrom(raw: unknown): Effort | undefined {
  if (isEffort(raw)) return raw;
  if (raw === "minimal" || raw === "none") return "low";
  if (raw === "ultra") return "max";
  return undefined;
}

/** A default model, offered to the agent made for that tool. */
function addSetting(b: Builder, from: string, setting: SettingImport, notes: string[] = []) {
  const parts = [setting.model && `Model: ${setting.model}`, setting.effort && `Thinking: ${setting.effort}`].filter(Boolean);
  if (!parts.length) return;
  b.items.push({
    key: `${b.source}:setting:model`,
    source: b.source,
    kind: "setting",
    title: setting.model ? `Model ${setting.model}` : `Thinking ${setting.effort}`,
    from,
    text: `${parts.join("\n")}\nOn ${ENGINE_NAMES[setting.engine]}.`,
    digest: digestOf({ kind: "setting", ...setting }),
    notes,
    destinations: ["engine"],
    setting,
  });
}

// ── chat apps ──────────────────────────────────────────────────────────

/** A token as a config writes it: the value, the variable it names, or
 * a pointer to a secret store, which is not followed. */
function tokenIn(raw: unknown): { value?: string; ref?: string; stored?: boolean } {
  if (isRecord(raw) && typeof raw.source === "string") return { stored: true };
  if (typeof raw !== "string" || !raw.trim()) return {};
  const values = new Map<string, string>();
  const refs = new Map<string, string>();
  remember("t", raw, values, refs);
  return { value: values.get("t"), ref: refs.get("t") };
}

/**
 * One chat app connection, where Bloks has the same app: a bot that
 * answers on Telegram, or the Slack and Discord apps shared rooms speak
 * through. Its token is a slot like a server's key, empty unless the
 * person fills it in or says to copy it.
 */
function addChannel(
  b: Builder,
  from: string,
  platform: ChatPlatform,
  account: string | undefined,
  tokens: Array<{ field: string; name: string; raw: unknown; envName?: string; required: boolean }>,
  notes: string[],
) {
  const slots: SecretSlot[] = [];
  const values = new Map<string, string>();
  for (const token of tokens) {
    const found = tokenIn(token.raw);
    const id = `token:${token.field}`;
    if (found.value) values.set(id, found.value);
    if (found.stored) notes.push(`Its ${token.name} is in OpenClaw's secret store, which Bloks does not open. Paste it here.`);
    slots.push({
      id,
      name: token.name,
      where: "token",
      required: token.required,
      ...(found.value ? { copyFrom: from } : {}),
      ...(found.ref || (!found.value && !found.stored && token.envName) ? { ref: found.ref ?? token.envName } : {}),
    });
  }
  const label = PLATFORM_NAMES[platform];
  const item: FoundItem = {
    key: `${b.source}:channel:${platform}${account ? `:${account}` : ""}`,
    source: b.source,
    kind: "channel",
    title: account ? `${label} (${account})` : label,
    from,
    text:
      platform === "telegram"
        ? "A Telegram bot that answers as one agent. Saved switched off, for you to pair with and turn on."
        : `The ${label} app that shared rooms speak through. Saved switched off, for you to turn on.`,
    digest: digestOf({ kind: "channel", platform, account: account ?? null, slots: slots.map((s) => s.id) }),
    notes: [
      ...notes,
      `A bot answers one app at a time, so it is saved switched off. Turn it on in Bloks once ${SOURCE_NAMES[b.source]} has stopped using it.`,
    ],
    destinations: ["channel"],
    channel: { platform, ...(account ? { account } : {}) },
    secrets: slots,
  };
  if (values.size) SECRET_VALUES.set(item, values);
  b.items.push(item);
}

/** An agent's name out of an IDENTITY.md, when it says one. */
function identityName(path: string): string | null {
  const read = readKnown(path, MAX_TEXT_FILE_BYTES, /\.md$/i);
  if (!read || "skip" in read) return null;
  const m = /^\s*(?:[-*]\s*)?\**name\**\s*:\**\s*(.+)$/im.exec(read.text);
  const name = m?.[1].replace(/[*_`]/g, "").trim() ?? "";
  return name && name.length <= 40 && !/^\(.*\)$/.test(name) && !scrubSecrets(name).removed ? name : null;
}

// ── the sources ────────────────────────────────────────────────────────

function begin(home: string, source: SourceId): Builder {
  return { items: [], skipped: [], home, source };
}

function finish(b: Builder, folder: string, agentName?: string | null): SourceScan {
  return {
    id: b.source,
    name: SOURCE_NAMES[b.source],
    folder,
    agentName: agentName || `${SOURCE_NAMES[b.source]} agent`,
    items: b.items,
    skipped: b.skipped,
  };
}

function claude(home: string): SourceScan | null {
  const root = join(home, ".claude");
  const json = join(home, ".claude.json");
  let hasJson = true;
  try {
    lstatSync(json);
  } catch {
    hasJson = false;
  }
  if (!isFolder(root) && !hasJson) return null;
  const b = begin(home, "claude");
  addText(b, "instructions", join(root, "CLAUDE.md"), { say: importsNote });
  addRuleFiles(b, join(root, "rules"));
  addAgents(b, join(root, "agents"));
  for (const folder of foldersIn(join(root, "skills"), MAX_SKILLS_PER_SOURCE)) addSkill(b, join(root, "skills", folder));
  // Claude Code still runs these, and calls them skills now
  addCommands(b, join(root, "commands"), { depth: 3, kind: "command" });
  // Only the servers set for every project. The ones under "projects" are
  // tied to one folder each, and belong to that folder rather than to the
  // person.
  addMcpFile(b, json);
  const settings = addRules(b, join(root, "settings.json"));
  if (settings) {
    // Claude Code documents no servers in settings.json, and some people
    // keep them there anyway: read them, and say where they came from.
    if (isRecord(settings.mcpServers)) {
      for (const name of Object.keys(settings.mcpServers).slice(0, MAX_MCP_PER_SOURCE)) {
        addMcp(b, name, settings.mcpServers[name], "~/.claude/settings.json", ["Claude Code does not read servers from settings.json, so check it is one you use."]);
      }
    }
    const model = typeof settings.model === "string" ? claudeModel(settings.model) : {};
    if (model.model) addSetting(b, "~/.claude/settings.json", { engine: "claude", model: model.model.model });
    else if (model.note) b.skipped.push({ from: "~/.claude/settings.json: model", why: model.note });
  }
  return finish(b, "~/.claude");
}

/** CLAUDE.md can pull other files in with @path. Those are not followed:
 * they could be anywhere, and are named so the person knows. */
function importsNote(raw: string): string[] {
  const named: string[] = [];
  let fenced = false;
  for (const line of raw.split("\n")) {
    if (line.trim().startsWith("```")) fenced = !fenced;
    if (fenced) continue;
    for (const m of line.replace(/`[^`]*`/g, "").matchAll(/(?:^|\s)@((?:~|\.{1,2})?\/?[\w.-]+(?:\/[\w.-]+)*)/g)) {
      // the full stop of the sentence it sits in is not part of the path
      const path = m[1].replace(/\.+$/, "");
      if (path.includes("/") || /\.\w+$/.test(path)) named.push(path);
    }
  }
  const unique = [...new Set(named)].slice(0, 4);
  return unique.length
    ? [`It pulls in ${unique.map((p) => `@${p}`).join(", ")}, which ${unique.length === 1 ? "is" : "are"} not brought over. Add ${unique.length === 1 ? "it" : "them"} by hand if the agent needs ${unique.length === 1 ? "it" : "them"}.`]
    : [];
}

function codex(home: string): SourceScan | null {
  const root = join(home, ".codex");
  if (!isFolder(root)) return null;
  const b = begin(home, "codex");
  // Codex reads the override in place of AGENTS.md when it has anything in it
  const override = readKnown(join(root, "AGENTS.override.md"), MAX_TEXT_FILE_BYTES, /\.md$/i);
  if (override && "text" in override && override.text.trim()) {
    addText(b, "instructions", join(root, "AGENTS.override.md"));
    if (readKnown(join(root, "AGENTS.md"), MAX_TEXT_FILE_BYTES, /\.md$/i)) {
      b.skipped.push({ from: "~/.codex/AGENTS.md", why: "Codex reads AGENTS.override.md instead of it, so this one is left out" });
    }
  } else {
    if (override && "skip" in override) b.skipped.push({ from: "~/.codex/AGENTS.override.md", why: override.skip });
    addText(b, "instructions", join(root, "AGENTS.md"));
  }
  const path = join(root, "config.toml");
  const read = readKnown(path, MAX_SETTINGS_BYTES, /\.toml$/i);
  if (read && "skip" in read) b.skipped.push({ from: "~/.codex/config.toml", why: read.skip });
  if (read && "text" in read) {
    const config = parseToml(read.text);
    const servers = config.mcp_servers;
    if (isRecord(servers)) {
      for (const name of Object.keys(servers).slice(0, MAX_MCP_PER_SOURCE)) addMcp(b, name, servers[name], "~/.codex/config.toml");
    }
    const model = typeof config.model === "string" && /^[\w.:/-]{1,80}$/.test(config.model) ? config.model : undefined;
    const effort = effortFrom(config.model_reasoning_effort);
    const notes: string[] = [];
    if (typeof config.model_provider === "string" && config.model_provider !== "openai") {
      notes.push(`Codex used the ${config.model_provider.slice(0, 40)} provider for it. Bloks runs it through Codex as Codex is set up here.`);
    }
    if (model || effort) addSetting(b, "~/.codex/config.toml", { engine: "codex", ...(model ? { model } : {}), ...(effort ? { effort } : {}) }, notes);
  }
  addCommands(b, join(root, "prompts"), { depth: 1, kind: "prompt" });
  // Codex's own skills folder now, and the one it read before
  for (const folder of foldersIn(join(home, ".agents", "skills"), MAX_SKILLS_PER_SOURCE)) addSkill(b, join(home, ".agents", "skills", folder), "agents/");
  for (const folder of foldersIn(join(root, "skills"), MAX_SKILLS_PER_SOURCE)) addSkill(b, join(root, "skills", folder));
  return finish(b, "~/.codex");
}

/**
 * Cursor keeps its MCP servers, skills, subagents and commands under
 * ~/.cursor, and its user rules in its own settings, where they are not a
 * file to read. Rules some people keep in ~/.cursor/rules are read too.
 */
function cursor(home: string): SourceScan | null {
  const root = join(home, ".cursor");
  if (!isFolder(root)) return null;
  const b = begin(home, "cursor");
  addCursorRules(b, join(root, "rules"));
  addAgents(b, join(root, "agents"));
  for (const folder of foldersIn(join(root, "skills"), MAX_SKILLS_PER_SOURCE)) addSkill(b, join(root, "skills", folder));
  addCommands(b, join(root, "commands"), { depth: 2, kind: "command" });
  addMcpFile(b, join(root, "mcp.json"));
  if (b.items.length || b.skipped.length) {
    b.skipped.push({
      from: "Cursor Settings, Rules",
      why: "Cursor keeps your user rules in its settings rather than in a file, so they cannot be read. Copy them from there into an agent's instructions.",
    });
  }
  return finish(b, "~/.cursor");
}

/**
 * OpenClaw: a workspace of Markdown files that make up its agent, skills
 * of its own, and a JSON5 config with its model and the chat apps it
 * answers on.
 */
function openclaw(home: string): SourceScan | null {
  const state = join(home, ".openclaw");
  if (!isFolder(state)) return null;
  const b = begin(home, "openclaw");
  const configPath = join(state, "openclaw.json");
  const read = readKnown(configPath, MAX_SETTINGS_BYTES, /\.json5?$/i);
  let config: Record<string, unknown> = {};
  if (read && "skip" in read) b.skipped.push({ from: "~/.openclaw/openclaw.json", why: read.skip });
  if (read && "text" in read) {
    try {
      const parsed = parseJson5(read.text);
      if (isRecord(parsed)) config = parsed;
    } catch {
      b.skipped.push({ from: "~/.openclaw/openclaw.json", why: "not JSON5 Bloks can read, so its model and chat apps were left out" });
    }
  }
  if (config.$include !== undefined) b.skipped.push({ from: "~/.openclaw/openclaw.json: $include", why: "the files it pulls in are not followed" });
  const defaults = isRecord(config.agents) && isRecord(config.agents.defaults) ? config.agents.defaults : {};

  // The workspace is where the config says, when that is in this home
  // folder; anywhere else is not one of the places this reads.
  let root = join(state, "workspace");
  if (typeof defaults.workspace === "string" && defaults.workspace.trim()) {
    const wanted = resolve(home, defaults.workspace.trim().replace(/^~(?=\/|$)/, home));
    const inside = relative(home, wanted);
    if (inside && !inside.startsWith("..") && !isCredentialPath(wanted) && isFolder(wanted)) root = wanted;
    else b.skipped.push({ from: "~/.openclaw/openclaw.json: agents.defaults.workspace", why: "points outside your home folder, so Bloks read ~/.openclaw/workspace instead" });
  }
  const folder = fromHome(home, root);
  if (isFolder(root)) {
    addText(b, "instructions", join(root, "SOUL.md"));
    addText(b, "instructions", join(root, "IDENTITY.md"));
    addText(b, "instructions", join(root, "AGENTS.md"));
    addText(b, "memory", join(root, "MEMORY.md"));
    addTopics(b, join(root, "memory"));
    for (const name of foldersIn(join(root, "skills"), MAX_SKILLS_PER_SOURCE)) addSkill(b, join(root, "skills", name));
    addFacts(b, join(root, "USER.md"));
  }
  for (const name of foldersIn(join(state, "skills"), MAX_SKILLS_PER_SOURCE)) addSkill(b, join(state, "skills", name), "managed/");

  const model = typeof defaults.model === "string" ? defaults.model : isRecord(defaults.model) && typeof defaults.model.primary === "string" ? defaults.model.primary : "";
  if (model) {
    const [provider, ...rest] = model.split("/");
    const id = rest.join("/");
    if (provider === "anthropic" && /^claude-[\w.-]{1,60}$/.test(id)) addSetting(b, "~/.openclaw/openclaw.json", { engine: "claude", model: id });
    else if ((provider === "openai" || provider === "openai-codex") && /^[\w.:-]{1,80}$/.test(id)) addSetting(b, "~/.openclaw/openclaw.json", { engine: "codex", model: id });
    else b.skipped.push({ from: "~/.openclaw/openclaw.json: agents.defaults.model", why: `${model.slice(0, 80)} is not a model one of Bloks's engines runs, so choose one on the agent` });
  }
  addChannels(b, isRecord(config.channels) ? config.channels : {});
  return finish(b, folder, identityName(join(root, "IDENTITY.md")));
}

/** OpenClaw's chat apps, where Bloks has the same one. */
function addChannels(b: Builder, channels: Record<string, unknown>) {
  const from = "~/.openclaw/openclaw.json";
  const off = (raw: Record<string, unknown>) => (raw.enabled === false ? ["It is switched off in OpenClaw."] : []);
  const each = (raw: Record<string, unknown>, add: (entry: Record<string, unknown>, account?: string) => void) => {
    add(raw);
    if (isRecord(raw.accounts)) {
      for (const id of Object.keys(raw.accounts).slice(0, MAX_ACCOUNTS)) {
        const entry = raw.accounts[id];
        if (isRecord(entry) && /^[\w.-]{1,40}$/.test(id)) add({ ...entry }, id);
      }
    }
  };
  for (const [name, raw] of Object.entries(channels)) {
    if (!isRecord(raw) || name === "defaults") continue;
    if (name === "telegram") {
      each(raw, (entry, account) => {
        if (entry.botToken === undefined && entry.tokenFile === undefined && (account || isRecord(raw.accounts))) return;
        const notes = off(entry);
        if (entry.tokenFile !== undefined) notes.push("OpenClaw read its token from a file, which Bloks does not open. Paste the token here.");
        addChannel(b, from, "telegram", account, [{ field: "botToken", name: "Bot token", raw: entry.botToken, envName: account ? undefined : "TELEGRAM_BOT_TOKEN", required: true }], notes);
      });
    } else if (name === "discord") {
      each(raw, (entry, account) => {
        if (entry.token === undefined && (account || isRecord(raw.accounts))) return;
        addChannel(b, from, "discord", account, [{ field: "token", name: "Bot token", raw: entry.token, envName: account ? undefined : "DISCORD_BOT_TOKEN", required: true }], off(entry));
      });
    } else if (name === "slack") {
      each(raw, (entry, account) => {
        if (entry.botToken === undefined && (account || isRecord(raw.accounts))) return;
        const notes = off(entry);
        if (entry.appToken === undefined && entry.signingSecret !== undefined) {
          notes.push("OpenClaw took Slack's events over HTTP. Bloks connects over Socket Mode, which needs an app-level token (xapp-) from your Slack app's settings.");
        }
        addChannel(
          b,
          from,
          "slack",
          account,
          [
            { field: "botToken", name: "Bot token", raw: entry.botToken, required: true },
            { field: "appToken", name: "App-level token", raw: entry.appToken, required: true },
          ],
          notes,
        );
      });
    } else if (name === "whatsapp") {
      b.skipped.push({ from: `${from}: channels.whatsapp`, why: "OpenClaw links WhatsApp as a device, and Bloks connects through Meta's Cloud API. Set it up under Settings, Chat apps" });
    } else if (/^[\w-]{1,30}$/.test(name)) {
      b.skipped.push({ from: `${from}: channels.${name}`, why: "Bloks does not have that chat app" });
    }
  }
}

/** Skill folders up to a few levels down: some tools file skills under a
 * category folder, some do not, and a folder with a SKILL.md is a skill
 * either way. */
function skillFolders(dir: string, depth: number, found: string[] = []): string[] {
  for (const name of foldersIn(dir, MAX_SKILLS_PER_SOURCE)) {
    if (found.length >= MAX_SKILLS_PER_SOURCE) break;
    const here = join(dir, name);
    let hasSkill = true;
    try {
      lstatSync(join(here, "SKILL.md"));
    } catch {
      hasSkill = false;
    }
    if (hasSkill) found.push(here);
    else if (depth > 1) skillFolders(here, depth - 1, found);
  }
  return found;
}

/**
 * Hermes keeps its memories and skills under ~/.hermes, in a layout that
 * has moved between versions, so each part is looked for and skipped when
 * it is not there rather than assumed.
 */
function hermes(home: string): SourceScan | null {
  const root = join(home, ".hermes");
  if (!isFolder(root)) return null;
  const b = begin(home, "hermes");
  addText(b, "instructions", join(root, "SOUL.md"));
  for (const memories of ["memories", "memory"]) {
    const dir = join(root, memories);
    for (const file of filesIn(dir, /\.md$/i, MAX_TOPICS_PER_SOURCE)) {
      const path = join(dir, file);
      if (/^user\.md$/i.test(file)) addFacts(b, path);
      else if (/^memory\.md$/i.test(file)) addText(b, "memory", path, { title: `${memories}/${file}` });
      else addText(b, "memory", path, { title: `${memories}/${file}`, topic: topicName(file) });
    }
  }
  for (const dir of skillFolders(join(root, "skills"), 3)) addSkill(b, dir);
  return finish(b, "~/.hermes");
}

// ── OpenBot ────────────────────────────────────────────────────────────
//
// OpenBot keeps several agents, each with its own instructions, skills,
// memories and folder. Its own guide documents where they live: an app
// data folder holding one SQLite database, a folder per agent under
// ~/OpenBot/Agents, and a transfer file its settings write. Nothing else
// about it is documented, so nothing else is assumed. The JSON inside the
// database and the transfer file is read tolerantly: a field is taken
// only when its name and its type leave no doubt, the rest is passed
// over, and no value is ever made up. Every item is shown before anything
// is written, so a wrong reading is something to see and untick.
//
// An agent's parts come with it. Its skills, memories, files and routines
// go to whatever the agent becomes here (`owner`), unless the person
// sends them to another agent.

/** OpenBot's app data folder, under the home folder, on each system. */
export function openbotDataFolder(home: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === "darwin") return join(home, "Library", "Application Support", "OpenBot");
  // %APPDATA%, where Windows keeps it unless a profile was moved
  if (platform === "win32") return join(home, "AppData", "Roaming", "OpenBot");
  return join(home, ".config", "OpenBot");
}

/** A transfer file, picked by the person, and the name they knew it by. */
export interface TransferFile {
  path: string;
  name: string;
}

export interface DetectOptions {
  openbotTransfer?: TransferFile | null;
  /** The system whose folders to look in. This one, but for a test. */
  platform?: NodeJS.Platform;
}

/** What a transfer file may hold. A whole OpenBot, workspaces included,
 * fits well inside these; a file built to exhaust a reader does not. */
const TRANSFER_LIMITS: ZipLimits = { entries: 5_000, total: 512 * 1024 * 1024, entry: 64 * 1024 * 1024 };
/** The file itself, as it arrives. */
export const MAX_TRANSFER_BYTES = 256 * 1024 * 1024;
const TRANSFER_JSON = "openbot-transfer.json";
const TRANSFER_FORMAT = "openbot-instance-transfer";
const MAX_TRANSFER_JSON_BYTES = 8 * 1024 * 1024;
const MAX_DATABASE_BYTES = 512 * 1024 * 1024;
const MAX_AGENT_JSON_BYTES = 1024 * 1024;
/** An agent's picture, as large as an agent file carries one. */
const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
/** Files one agent brings, and their bytes together; each file is held to
 * what a file handed to an agent may be (server/attachments.ts). */
const MAX_WORKSPACE_FILES = 500;
const MAX_WORKSPACE_BYTES = 100 * 1024 * 1024;
const MAX_WORKSPACE_DEPTH = 8;
const MAX_MEMORIES = 2_000;
const MAX_ROUTINES_PER_AGENT = 20;
/** The topic file searchable memories become. */
const MEMORY_TOPIC = "From OpenBot.md";

/** What a transfer file holds, judged whole. */
interface Transfer {
  path: string;
  name: string;
  json: Record<string, unknown>;
  entries: Map<string, ZipEntry>;
}

/** A transfer file judged whole, or ZipRefused saying why not. */
function openTransfer(file: TransferFile): Transfer {
  const entries = new Map(listZip(file.path, TRANSFER_LIMITS).map((e) => [e.name, e]));
  const head = entries.get(TRANSFER_JSON);
  if (!head) throw new ZipRefused(`it has no ${TRANSFER_JSON}, so it is not an OpenBot transfer file`);
  if (head.size > MAX_TRANSFER_JSON_BYTES) throw new ZipRefused(`its ${TRANSFER_JSON} is larger than ${kb(MAX_TRANSFER_JSON_BYTES)}`);
  const json = readJson(readZipEntry(file.path, head).toString("utf8"));
  // The format's name and version are documented and the keys that hold
  // them are not, so it is the value that is looked for.
  if (!isRecord(json) || !Object.values(json).includes(TRANSFER_FORMAT)) throw new ZipRefused("it is not an OpenBot transfer file");
  if (typeof json.version === "number" && json.version !== 1) throw new ZipRefused("a newer OpenBot wrote it, in a version of the format Bloks does not read yet");
  return { path: file.path, name: file.name, json, entries };
}

/** Why a transfer file cannot be read, or null when it can: asked as it
 * arrives, so a file that would be refused is never kept. */
export function transferProblem(path: string): string | null {
  try {
    openTransfer({ path, name: basename(path) });
    return null;
  } catch (error) {
    return error instanceof ZipRefused ? error.message : "it could not be read";
  }
}

/** A string field by one of its names, trimmed, or undefined. */
function field(raw: Record<string, unknown>, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = raw[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

type MemoryKind = "essential" | "searchable";

/** One OpenBot agent, as far as its JSON says. */
interface OpenBotAgent {
  /** Its folder, in the transfer file or under ~/OpenBot/Agents. */
  key: string;
  name?: string;
  title?: string;
  instructions?: string;
  provider?: string;
  model?: string;
  effort?: Effort;
  memories: Array<{ text: string; kind: MemoryKind | null }>;
  routines: Record<string, unknown>[];
  servers: Array<[string, unknown]>;
}

/** A memory as written: a string, or an object with its text and, when it
 * says so in a way that cannot be read two ways, which kind it is. */
function memoryOf(entry: unknown, kind: MemoryKind | null): { text: string; kind: MemoryKind | null } | null {
  if (typeof entry === "string") return entry.trim() ? { text: entry.trim(), kind } : null;
  if (!isRecord(entry)) return null;
  const text = field(entry, "text", "content");
  if (!text) return null;
  let marked = kind;
  if (entry.essential === true) marked = "essential";
  else if (entry.essential === false) marked = "searchable";
  for (const name of ["kind", "type", "tier", "mode"]) {
    if (entry[name] === "essential" || entry[name] === "searchable") marked = entry[name] as MemoryKind;
  }
  return { text, kind: marked };
}

/** What can be read out of one agent's JSON without guessing. */
function agentFromJson(raw: Record<string, unknown>, key: string): OpenBotAgent {
  const memories: OpenBotAgent["memories"] = [];
  const collect = (list: unknown, kind: MemoryKind | null) => {
    if (!Array.isArray(list)) return;
    for (const entry of list) {
      if (memories.length >= MAX_MEMORIES) return;
      const memory = memoryOf(entry, kind);
      if (memory) memories.push(memory);
    }
  };
  collect(raw.memories, null);
  collect(raw.essentialMemories, "essential");
  collect(raw.searchableMemories, "searchable");
  const listed = raw.mcpServers ?? raw.mcp_servers;
  const servers: Array<[string, unknown]> = isRecord(listed)
    ? Object.entries(listed)
    : Array.isArray(listed)
      ? listed.filter(isRecord).flatMap((s): Array<[string, unknown]> => (typeof s.name === "string" && s.name.trim() ? [[s.name, s]] : []))
      : [];
  const effort = effortFrom(raw.reasoningEffort ?? raw.reasoning_effort ?? raw.effort);
  return {
    key,
    name: field(raw, "name"),
    title: field(raw, "title"),
    instructions: typeof raw.instructions === "string" ? raw.instructions : undefined,
    provider: field(raw, "provider"),
    model: field(raw, "model"),
    ...(effort ? { effort } : {}),
    memories,
    routines: Array.isArray(raw.routines) ? raw.routines.filter(isRecord).slice(0, MAX_ROUTINES_PER_AGENT) : [],
    servers: servers.slice(0, MAX_MCP_PER_SOURCE),
  };
}

/**
 * The providers OpenBot runs, by the names it might write them, and the
 * family each is here. Null where Bloks has no engine of that family: the
 * agent comes across on the default engine, and says so.
 */
const OPENBOT_PROVIDERS: Record<string, { name: string; engine: Engine | null }> = {
  codex: { name: "Codex", engine: "codex" },
  claude: { name: "Claude Code", engine: "claude" },
  claudecode: { name: "Claude Code", engine: "claude" },
  grok: { name: "Grok", engine: "grok" },
  grokcli: { name: "Grok", engine: "grok" },
  opencode: { name: "OpenCode", engine: "opencode" },
  gemini: { name: "Gemini", engine: "gemini" },
  geminicli: { name: "Gemini", engine: "gemini" },
  cursor: { name: "Cursor", engine: "cursor" },
  cursoragent: { name: "Cursor", engine: "cursor" },
  cline: { name: "Cline", engine: "cline" },
  kimi: { name: "Kimi", engine: "kimi" },
  kimicli: { name: "Kimi", engine: "kimi" },
  devin: { name: "Devin", engine: "devin" },
  githubcopilot: { name: "GitHub Copilot", engine: null },
  copilot: { name: "GitHub Copilot", engine: null },
  hermes: { name: "Hermes", engine: null },
  pi: { name: "Pi", engine: "pi" },
  muse: { name: "Muse", engine: null },
  openrouter: { name: "OpenRouter", engine: "openrouter" },
  deepseek: { name: "DeepSeek", engine: "deepseek" },
  custom: { name: "a custom endpoint", engine: null },
  openaicompatible: { name: "a custom endpoint", engine: null },
  acp: { name: "a custom ACP agent", engine: null },
  customacp: { name: "a custom ACP agent", engine: null },
};

function providerOf(raw: string | undefined): { name: string; engine: Engine | null } | null {
  if (!raw) return null;
  const known = OPENBOT_PROVIDERS[raw.toLowerCase().replace(/[^a-z0-9]/g, "")];
  if (known) return known;
  const name = scrubSecrets(raw).text.replace(/[\x00-\x1f]/g, "").slice(0, 40).trim();
  return name ? { name, engine: null } : null;
}

/** What an agent that moves to the default engine says. The review names
 * that engine when it knows it. */
export function ranOnNote(ranOn: string, here?: string | null): string {
  return `Ran on ${ranOn} in OpenBot; uses ${here || "your default engine"} here. Change it after import.`;
}

/** Days of the week from cron's last field, 7 being Sunday as well as 0,
 * or null for anything more than a list of days and ranges. */
function cronDays(spec: string): number[] | null {
  if (spec === "*") return [];
  const days = new Set<number>();
  for (const part of spec.split(",")) {
    const m = /^(\d)(?:-(\d))?$/.exec(part);
    if (!m) return null;
    const from = Number(m[1]);
    const to = m[2] === undefined ? from : Number(m[2]);
    if (from > 7 || to > 7 || to < from) return null;
    for (let d = from; d <= to; d++) days.add(d % 7);
  }
  return days.size === 7 ? [] : [...days].sort();
}

/**
 * A routine, as one here: what it says, and when. A time of day with its
 * days, or a cron line of that shape, reads exactly; anything else is a
 * schedule this cannot be sure of, and the routine comes with a stand in
 * time to set, which it says.
 */
function routineFrom(raw: Record<string, unknown>): { routine: RoutineImport; removed: number } | { skip: string } {
  const said = field(raw, "prompt", "instructions");
  if (!said) return { skip: "it has nothing to say when it runs" };
  if (said.length > MAX_ROUTINE_PROMPT) return { skip: `longer than a routine holds (${MAX_ROUTINE_PROMPT.toLocaleString("en-US")} characters)` };
  const { text: prompt, removed } = scrubSecrets(said);
  const named = field(raw, "name", "title");
  const name = named ? scrubSecrets(named).text.replace(/[\x00-\x1f]/g, "").slice(0, 60).trim() : "";
  const time = field(raw, "time");
  const days = Array.isArray(raw.days) && raw.days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6) ? [...new Set(raw.days as number[])].sort() : null;
  let when: { time: string; days: number[] } | null = null;
  if (time && /^([01]\d|2[0-3]):[0-5]\d$/.test(time)) when = { time, days: days ?? [] };
  else {
    const cron = /^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+(\S+)$/.exec(field(raw, "cron", "schedule") ?? "");
    const onDays = cron ? cronDays(cron[3]) : null;
    if (cron && Number(cron[1]) < 60 && Number(cron[2]) < 24 && onDays) {
      when = { time: `${cron[2].padStart(2, "0")}:${cron[1].padStart(2, "0")}`, days: onDays };
    }
  }
  return {
    routine: { ...(name ? { name } : {}), prompt, time: when?.time ?? "09:00", days: when?.days ?? [], scheduled: Boolean(when) },
    removed,
  };
}

/** A picture by its first bytes: the three an agent's photo may be. */
function imageType(bytes: Buffer): string | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  return null;
}

function sizeWords(bytes: number): string {
  if (bytes < 1024) return `${bytes} ${bytes === 1 ? "byte" : "bytes"}`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

/**
 * The rows of OpenBot's agents table, each one agent's JSON, or why it
 * could not be read, or null when there is no database.
 *
 * Opened read only and asked one question, of the one table OpenBot's
 * guide names. Never written, and never waited on: when OpenBot is
 * running and holds it, or the Node running Bloks has no SQLite, that is
 * said and the folders are read instead. node:sqlite is loaded here, and
 * only here, when there is a database to read, so a Node without it (22
 * before 22.13) loses this one step and nothing else.
 */
function openbotDatabase(path: string): { agents: Record<string, unknown>[] } | { skip: string } | null {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return null;
  }
  if (stat.isSymbolicLink()) return { skip: "a link to somewhere else, so it was not opened" };
  if (!stat.isFile()) return null;
  if (stat.size > MAX_DATABASE_BYTES) return { skip: `larger than ${kb(MAX_DATABASE_BYTES)}, so names come from the agents' folders` };
  type Sqlite = { DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => { prepare(sql: string): { all(): unknown[] }; close(): void } };
  let sqlite: Sqlite | undefined;
  try {
    sqlite = process.getBuiltinModule?.("node:sqlite") as Sqlite | undefined;
  } catch {
    sqlite = undefined;
  }
  if (!sqlite?.DatabaseSync) return { skip: "this version of Node cannot read OpenBot's database, so names come from the agents' folders" };
  let db: InstanceType<Sqlite["DatabaseSync"]> | null = null;
  try {
    db = new sqlite.DatabaseSync(path, { readOnly: true });
    const agents: Record<string, unknown>[] = [];
    for (const row of db.prepare("SELECT agent_json FROM projection_agents").all()) {
      if (agents.length >= MAX_AGENTS_PER_SOURCE) break;
      const json = isRecord(row) ? row.agent_json : undefined;
      if (typeof json !== "string" || json.length > MAX_AGENT_JSON_BYTES) continue;
      const parsed = readJson(json);
      if (isRecord(parsed)) agents.push(parsed);
    }
    return { agents };
  } catch (error) {
    const said = error instanceof Error ? error.message : String(error);
    if (/busy|locked/i.test(said)) return { skip: "OpenBot is using its database right now, so names come from the agents' folders. Look again once OpenBot is closed" };
    if (/no such (table|column)/i.test(said)) return { skip: "its agents are not where OpenBot's guide says, so names come from the agents' folders" };
    return { skip: "could not be read, so names come from the agents' folders" };
  } finally {
    try {
      db?.close();
    } catch {
      // closing a database that never opened has nothing to undo
    }
  }
}

interface WorkspaceList {
  files: Array<{ path: string; bytes: number; stamp: string }>;
  total: number;
  hidden: number;
  links: number;
  secret: number;
  large: string[];
  over: number;
}

const emptyList = (): WorkspaceList => ({ files: [], total: 0, hidden: 0, links: 0, secret: 0, large: [], over: 0 });

/** Why a path in an agent's folder is not one of its files, or null. The
 * instruction file is the agent's instructions already, and MEMORY.md and
 * memory/ at the top are where Bloks keeps an agent's memory. */
function notAWorkspaceFile(rel: string): "hidden" | "own" | "secret" | null {
  const parts = rel.split("/");
  if (parts.some((part) => part.startsWith("."))) return "hidden";
  if (parts.length === 1 && /^(agents|claude|memory)\.md$/i.test(parts[0])) return "own";
  if (parts[0].toLowerCase() === "memory") return "own";
  // what an engine reads by itself from the folder it works in, at any
  // depth: instructions, and a config that can name commands for it to
  // run. Brought over as files they would set the engine up unseen.
  const name = parts.at(-1)!.toLowerCase();
  if (/^(agents|agents\.override|claude|gemini)\.md$/.test(name) || /^opencode\.jsonc?$/.test(name)) return "own";
  if (isCredentialPath(rel)) return "secret";
  return null;
}

/** One file into the list, or the count of why not. */
function listFile(list: WorkspaceList, path: string, bytes: number, stamp: string) {
  const why = notAWorkspaceFile(path);
  if (why === "hidden") list.hidden++;
  else if (why === "secret") list.secret++;
  else if (why === "own") return;
  else if (bytes > FILE_MAX_BYTES) list.large.push(path);
  else if (list.files.length >= MAX_WORKSPACE_FILES || list.total + bytes > MAX_WORKSPACE_BYTES) list.over++;
  else {
    list.files.push({ path, bytes, stamp });
    list.total += bytes;
  }
}

/** The regular files in an agent's folder, a few levels down. A link is
 * never followed, and a hidden folder (.git, its skills) is not entered. */
function folderFiles(root: string): WorkspaceList {
  const list = emptyList();
  const walk = (dir: string, rel: string, depth: number) => {
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const name of names) {
      const path = join(dir, name);
      const inside = rel ? `${rel}/${name}` : name;
      let stat;
      try {
        stat = lstatSync(path);
      } catch {
        continue;
      }
      if (stat.isSymbolicLink()) list.links++;
      else if (stat.isDirectory()) {
        const why = notAWorkspaceFile(inside);
        if (why === "hidden") list.hidden++;
        else if (!why && depth < MAX_WORKSPACE_DEPTH) walk(path, inside, depth + 1);
      } else if (stat.isFile()) listFile(list, inside, stat.size, `${stat.size}:${Math.round(stat.mtimeMs)}`);
    }
  };
  walk(root, "", 1);
  return list;
}

/** A workspace file's bytes at import, from a folder: still a regular
 * file, not a link, and no larger than a file may be. */
function readFolderFile(root: string, rel: string): Buffer {
  const path = join(root, ...rel.split("/"));
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${rel} is not a file any more`);
  if (stat.size > FILE_MAX_BYTES) throw new Error(`${rel} is larger than ${sizeWords(FILE_MAX_BYTES)} now`);
  return readFileSync(path);
}

/** The first heading of an instruction file, when it names the agent
 * rather than the file. */
function headingName(text: string): string | undefined {
  const heading = /^#\s+(.+)$/m.exec(text)?.[1]?.replace(/[*_`]/g, "").trim();
  if (!heading || heading.length > MAX_NAME_CHARS || /^(agents|claude)(\.md)?$|^(instructions|system prompt)$/i.test(heading)) return undefined;
  return scrubSecrets(heading).removed ? undefined : heading;
}

type Owner = NonNullable<FoundItem["owner"]>;

interface AgentParts {
  from: string;
  /** The instruction file in its folder, for an agent whose JSON has none. */
  instructionFile?: { read: Read; from: string };
  /** Lists its skills, as its own. */
  skills: (owner: Owner) => void;
  files?: { list: WorkspaceList; read: (path: string) => Buffer; from: string };
  avatar?: { bytes: Buffer; mime: string } | { skip: string };
}

/** One OpenBot agent, and every part of it, as items. */
function addOpenBotAgent(b: Builder, agent: OpenBotAgent, number: number, parts: AgentParts) {
  const id = /^[\w.-]{1,64}$/.test(agent.key) ? agent.key : sha256(agent.key).slice(0, 16);
  const file = parts.instructionFile?.read;
  if (file && "skip" in file) b.skipped.push({ from: parts.instructionFile!.from, why: file.skip });
  const fileText = file && "text" in file ? file.text : undefined;
  const named = agent.name ? scrubSecrets(agent.name).text : fileText ? headingName(fileText) : undefined;
  const name = (named ?? "").replace(/[\x00-\x1f]/g, "").slice(0, MAX_NAME_CHARS).trim() || `OpenBot agent ${number}`;
  const owner: Owner = { key: `openbot:agent:${id}`, name };

  const before = b.items.length;
  parts.skills(owner);
  const skillIds = b.items.slice(before).filter((i) => i.skill).map((i) => i.skill!.id);

  const { text: instructions, removed } = scrubSecrets((agent.instructions ?? fileText ?? "").trim());
  const notes = removedNote(removed);
  const provider = providerOf(agent.provider);
  let model: AgentImport["model"];
  let ranOn: string | undefined;
  if (provider?.engine) {
    // a model id only means something on an engine of the same family
    const modelId = agent.model && /^[\w.:/@+[\]-]{1,100}$/.test(agent.model) ? agent.model : "";
    if (agent.model && !modelId) notes.push(`Its model, ${scrubSecrets(agent.model).text.slice(0, 60)}, is not one Bloks can name, so it runs on ${ENGINE_NAMES[provider.engine]}'s default.`);
    model = { engine: provider.engine, model: modelId };
  } else if (provider) {
    ranOn = provider.name;
    notes.push(ranOnNote(provider.name));
  }
  if (instructions.length > MAX_DESCRIPTION_CHARS) {
    notes.push(`Its instructions are longer than an agent's hold (${MAX_DESCRIPTION_CHARS.toLocaleString("en-US")} characters), so the whole of them goes to the agent's memory, which it reads every turn.`);
  }
  let avatar: AgentImport["avatar"];
  if (parts.avatar && "skip" in parts.avatar) notes.push(parts.avatar.skip);
  else if (parts.avatar) avatar = { mime: parts.avatar.mime, hash: avatarHashOf(parts.avatar.bytes), bytes: parts.avatar.bytes.length };
  const servers = agent.servers.length;
  if (servers) {
    notes.push(
      servers === 1
        ? "Its MCP server comes over attached to nothing, as servers from every tool do. Attach it once its keys are in."
        : "Its MCP servers come over attached to nothing, as servers from every tool do. Attach them once their keys are in.",
    );
  }
  const title = scrubSecrets(agent.title ?? "").text.replace(/\s+/g, " ").trim().slice(0, MAX_TITLE_CHARS) || "Brought over from OpenBot";
  const imported: AgentImport = {
    name,
    title,
    instructions,
    ...(model ? { model } : {}),
    ...(ranOn ? { ranOn } : {}),
    ...(agent.effort ? { effort: agent.effort } : {}),
    ...(avatar ? { avatar } : {}),
    skills: skillIds,
    servers: [],
    deny: [],
  };
  const about = [
    title,
    model ? `Engine: ${ENGINE_NAMES[model.engine]}${model.model ? `, ${model.model}` : ""}` : ranOn ? `Ran on: ${ranOn}` : "",
    agent.effort ? `Thinking: ${agent.effort}` : "",
    skillIds.length ? `Skills: ${skillIds.join(", ")}` : "",
    avatar ? "With its picture" : "",
  ].filter(Boolean);
  const item: FoundItem = {
    key: owner.key,
    source: "openbot",
    kind: "agent",
    title: name,
    from: parts.from,
    text: [...about, ...(instructions ? ["", instructions] : [])].join("\n"),
    digest: digestOf({ kind: "agent", ...imported }),
    notes,
    destinations: ["agent"],
    agent: imported,
  };
  if (parts.avatar && !("skip" in parts.avatar)) AVATARS.set(item, parts.avatar.bytes);
  b.items.push(item);

  addMemories(b, owner, id, agent.memories, parts.from);
  if (parts.files) addWorkspaceFiles(b, owner, id, parts.files);
  addRoutines(b, owner, id, agent.routines, parts.from);
  for (const [server, raw] of agent.servers) {
    const clean = server.replace(/[\x00-\x1f]/g, "").trim().slice(0, 40);
    const listed = b.items.find((i) => i.kind === "mcp" && i.mcp?.name === clean);
    if (listed) listed.notes.push(`${name} used it too.`);
    else addMcp(b, server, raw, parts.from, [`${name} used it in OpenBot.`]);
  }
}

/** Essential memories as the agent's standing memory, searchable ones as
 * a note it looks up, each kind one item. A memory that says neither goes
 * with the searchable ones, which an agent reads only when they fit. */
function addMemories(b: Builder, owner: Owner, id: string, memories: OpenBotAgent["memories"], from: string) {
  const unmarked = memories.filter((m) => m.kind === null).length;
  for (const kind of ["essential", "searchable"] as const) {
    const these = memories.filter((m) => (kind === "essential" ? m.kind === "essential" : m.kind !== "essential"));
    if (!these.length) continue;
    let removed = 0;
    let text = "";
    let kept = 0;
    for (const memory of these) {
      const scrubbed = scrubSecrets(memory.text);
      const line = `- ${scrubbed.text.trim().replace(/\n/g, "\n  ")}`;
      // what one memory file holds, with room for the heading it lands under
      if (Buffer.byteLength(text ? `${text}\n${line}` : line, "utf8") > MAX_TEXT_FILE_BYTES - 1024) break;
      removed += scrubbed.removed;
      text = text ? `${text}\n${line}` : line;
      kept++;
    }
    if (!kept) continue;
    const notes = removedNote(removed);
    notes.push(
      kind === "essential"
        ? `${plural(kept, "memory", "memories")} for ${owner.name}'s standing memory, which it reads every turn.`
        : `${plural(kept, "memory", "memories")} kept as a note in ${owner.name}'s memory, which it looks up when a topic comes up.`,
    );
    const left = these.length - kept;
    if (left) notes.push(`${plural(left, "more did", "more did")} not fit in one memory file (${kb(MAX_TEXT_FILE_BYTES)}), so ${left === 1 ? "it was" : "they were"} left out.`);
    if (kind === "essential" && (text.split("\n").length > 150 || Buffer.byteLength(text, "utf8") > 20_000)) {
      notes.push("More than a turn reads of standing memory, so the end of it will not be read each turn. Move some to its notes after import.");
    }
    if (kind === "searchable" && unmarked) {
      notes.push(`${plural(unmarked, "memory did", "memories did")} not say which kind ${unmarked === 1 ? "it was" : "they were"}, so ${unmarked === 1 ? "it is" : "they are"} with these.`);
    }
    b.items.push({
      key: `openbot:memory:${id}/${kind}`,
      source: "openbot",
      kind: "memory",
      title: kind === "essential" ? "Essential memories" : "Searchable memories",
      from,
      text,
      digest: digestOf({ kind: "memory", text, topic: kind === "essential" ? null : MEMORY_TOPIC }),
      notes,
      destinations: ["memory"],
      ...(kind === "searchable" ? { topic: MEMORY_TOPIC } : {}),
      owner,
    });
  }
}

/** The files in an agent's folder, as one item, unticked: they are often
 * many, and often only meant for the tool they were made in. */
function addWorkspaceFiles(b: Builder, owner: Owner, id: string, input: NonNullable<AgentParts["files"]>) {
  const { list } = input;
  const notes: string[] = [];
  if (list.secret) {
    notes.push(`${plural(list.secret, "file looks", "files look")} like ${list.secret === 1 ? "it holds" : "they hold"} a sign-in or a key, so ${list.secret === 1 ? "it was" : "they were"} left out.`);
  }
  if (list.hidden) notes.push("Hidden files and folders stay in OpenBot.");
  if (list.links) notes.push(`${plural(list.links, "link was", "links were")} not followed.`);
  if (list.large.length) {
    notes.push(`Larger than ${sizeWords(FILE_MAX_BYTES)}, so left out: ${list.large.slice(0, 5).join(", ")}${list.large.length > 5 ? `, and ${list.large.length - 5} more` : ""}.`);
  }
  if (list.over) notes.push(`${plural(list.over, "more file was", "more files were")} past what one agent brings (${MAX_WORKSPACE_FILES} files, ${sizeWords(MAX_WORKSPACE_BYTES)}), so left out.`);
  if (!list.files.length) {
    if (notes.length) b.skipped.push({ from: input.from, why: `none of its files came across. ${notes.join(" ")}` });
    return;
  }
  // how many and how large is said beside the title, and in the dry run
  notes.unshift(`Copied into ${owner.name}'s workspace. A file already there by the same name is left as it is.`);
  const shown = list.files.slice(0, 40).map((f) => `${f.path}  ${sizeWords(f.bytes)}`);
  if (list.files.length > shown.length) shown.push(`and ${list.files.length - shown.length} more`);
  const item: FoundItem = {
    key: `openbot:files:${id}`,
    source: "openbot",
    kind: "files",
    title: "Workspace files",
    from: input.from,
    text: shown.join("\n"),
    digest: digestOf({ kind: "files", files: list.files.map((f) => [f.path, f.stamp]) }),
    notes,
    destinations: ["files"],
    files: { files: list.files.map(({ path, bytes }) => ({ path, bytes })), total: list.total },
    owner,
  };
  FILE_READERS.set(item, input.read);
  b.items.push(item);
}

/** Each routine as an item of its own, unticked, to arrive paused. */
function addRoutines(b: Builder, owner: Owner, id: string, routines: Record<string, unknown>[], from: string) {
  routines.forEach((raw, index) => {
    const made = routineFrom(raw);
    const label = field(raw, "name", "title") ?? `routine ${index + 1}`;
    if ("skip" in made) return void b.skipped.push({ from: `${from}: ${scrubSecrets(label).text.slice(0, 60)}`, why: made.skip });
    const { routine, removed } = made;
    let key = `openbot:routine:${id}/${slugify(routine.name ?? "") || index + 1}`;
    if (b.items.some((i) => i.key === key)) key = `${key}-${index + 1}`;
    const summary = describeRoutine({ time: routine.time, days: routine.days } as Routine);
    const notes = [...removedNote(removed), `Arrives paused, for ${owner.name}. Switch it on under Routines once you have looked at it.`];
    if (!routine.scheduled) notes.push("Its schedule could not be read, so it is set to every day at 09:00. Set its time before switching it on.");
    b.items.push({
      key,
      source: "openbot",
      kind: "routine",
      title: routine.name || routine.prompt.replace(/\s+/g, " ").slice(0, 60),
      from,
      text: `${summary}\n\n${routine.prompt}`,
      digest: digestOf({ kind: "routine", ...routine }),
      notes,
      destinations: ["routine"],
      routine,
      owner,
    });
  });
}

/** The agents in a transfer file: those its JSON lists, matched to their
 * folders where it says which, and any folder it does not list. */
function transferAgents(transfer: Transfer): OpenBotAgent[] {
  const folders = new Set<string>();
  for (const name of transfer.entries.keys()) {
    const m = /^agents\/([^/]+)\//.exec(name);
    if (m) folders.add(m[1]);
  }
  const out: OpenBotAgent[] = [];
  const taken = new Set<string>();
  const add = (raw: Record<string, unknown>, keys: Array<string | undefined>, fallback: string) => {
    const named = keys.filter((k): k is string => Boolean(k));
    const key = named.find((k) => folders.has(k) && !taken.has(k)) ?? named.find((k) => !taken.has(k)) ?? fallback;
    taken.add(key);
    out.push(agentFromJson(raw, key));
  };
  const listed = transfer.json.agents;
  if (Array.isArray(listed)) {
    listed.filter(isRecord).forEach((raw, i) => add(raw, [field(raw, "key"), field(raw, "id"), field(raw, "slug")], `agent-${i + 1}`));
  } else if (isRecord(listed)) {
    Object.entries(listed).forEach(([k, raw], i) => {
      if (isRecord(raw)) add(raw, [k, field(raw, "key"), field(raw, "id")], `agent-${i + 1}`);
    });
  }
  for (const key of [...folders].sort()) if (!taken.has(key)) add({}, [key], key);
  return out;
}

/** One agent out of a transfer file: its JSON, then its folder there. */
function addTransferAgent(b: Builder, transfer: Transfer, agent: OpenBotAgent, number: number) {
  const prefix = `agents/${agent.key}/`;
  const from = `${transfer.name}: ${prefix.slice(0, -1)}`;
  const readText = (name: string, max: number): Read => {
    const entry = transfer.entries.get(name);
    if (!entry) return null;
    if (entry.size > max) return { skip: `larger than ${kb(max)}, so it was left alone` };
    try {
      return { text: readZipEntry(transfer.path, entry).toString("utf8").replace(/\r\n/g, "\n") };
    } catch (error) {
      return { skip: error instanceof ZipRefused ? error.message : "could not be read" };
    }
  };
  const inside = [...transfer.entries.values()].filter((e) => e.name.startsWith(prefix) && !e.name.endsWith("/"));

  let instructionFile: AgentParts["instructionFile"];
  if (agent.instructions === undefined) {
    for (const name of ["AGENTS.md", "CLAUDE.md"]) {
      const read = readText(`${prefix}workspace/${name}`, MAX_TEXT_FILE_BYTES);
      if (read) {
        instructionFile = { read, from: `${transfer.name}: ${prefix}workspace/${name}` };
        break;
      }
    }
  }

  // its picture: a file of its own beside its folders, known by its bytes,
  // one called avatar looked at first
  let avatar: AgentParts["avatar"];
  const loose = inside.filter((e) => !e.name.slice(prefix.length).includes("/"));
  const named = (e: ZipEntry) => Number(/^avatar/i.test(e.name.slice(prefix.length)));
  for (const entry of loose.sort((x, y) => named(y) - named(x))) {
    if (entry.size > MAX_AVATAR_BYTES) {
      avatar ??= { skip: `Its picture is larger than ${sizeWords(MAX_AVATAR_BYTES)}, so it was left out.` };
      continue;
    }
    let bytes: Buffer;
    try {
      bytes = readZipEntry(transfer.path, entry);
    } catch {
      continue;
    }
    const mime = imageType(bytes);
    if (mime) {
      avatar = { bytes, mime };
      break;
    }
    avatar ??= { skip: "Its picture is not a PNG, JPEG or WebP image, so it was left out." };
  }

  const skills = (owner: Owner) => {
    let managed = 0;
    const slugs = [...new Set(inside.map((e) => /^skills\/([^/]+)\/SKILL\.md$/.exec(e.name.slice(prefix.length))?.[1]).filter((s): s is string => Boolean(s)))].sort();
    for (const slug of slugs.slice(0, MAX_SKILLS_PER_SOURCE)) {
      const folder = `${prefix}skills/${slug}/`;
      if (transfer.entries.has(`${folder}.openbot-managed.json`)) {
        managed++;
        continue;
      }
      const path = `${folder}SKILL.md`;
      const at = `${transfer.name}: ${path}`;
      const read = readText(path, MAX_SKILL_FILE_BYTES);
      if (!read) continue;
      if ("skip" in read) {
        b.skipped.push({ from: at, why: read.skip });
        continue;
      }
      const parsed = readFrontmatter(read.text);
      if (parsed.broken) {
        b.skipped.push({ from: at, why: "its header is never closed, so Bloks cannot tell where the instructions start" });
        continue;
      }
      const others = inside.filter((e) => e.name.startsWith(folder) && e.name !== path && !e.name.slice(folder.length).startsWith(".")).length;
      const notes = others ? [`Only its instructions come across. The ${plural(others, "other file", "other files")} in its folder stay${others === 1 ? "s" : ""} in the transfer file.`] : [];
      pushSkill(b, { key: `openbot:skill:${agent.key}/${slug}`, id: slug, from: at, parsed, notes, owner });
    }
    if (managed) {
      b.skipped.push({
        from: `${transfer.name}: ${prefix}skills`,
        why: `${plural(managed, "skill OpenBot installed itself was", "skills OpenBot installed itself were")} left out, since ${managed === 1 ? "it is" : "they are"} OpenBot's own`,
      });
    }
  };

  const list = emptyList();
  const root = `${prefix}workspace/`;
  for (const entry of inside) {
    if (entry.name.startsWith(root)) listFile(list, entry.name.slice(root.length), entry.size, `${entry.size}:${entry.crc}`);
  }
  const files = {
    list,
    from: `${transfer.name}: ${root.slice(0, -1)}`,
    read: (path: string) => {
      const entry = transfer.entries.get(`${root}${path}`);
      if (!entry) throw new Error(`${path} is not in the transfer file any more`);
      return readZipEntry(transfer.path, entry);
    },
  };
  addOpenBotAgent(b, agent, number, { from, instructionFile, skills, files, avatar });
}

/** One agent from its folder under ~/OpenBot/Agents, with what the
 * database says about it; or from the database alone, when it has no
 * folder. */
function addFolderAgent(b: Builder, agent: OpenBotAgent, number: number, dir: string | null, dbFrom: string) {
  const from = dir ? fromHome(b.home, dir) : dbFrom;
  let instructionFile: AgentParts["instructionFile"];
  if (dir && agent.instructions === undefined) {
    for (const name of ["AGENTS.md", "CLAUDE.md"]) {
      const read = readKnown(join(dir, name), MAX_TEXT_FILE_BYTES, /\.md$/i);
      if (read) {
        instructionFile = { read, from: fromHome(b.home, join(dir, name)) };
        break;
      }
    }
  }
  const skills = (owner: Owner) => {
    if (!dir) return;
    let managed = 0;
    for (const where of [".agents", ".claude"]) {
      const root = join(dir, where, "skills");
      for (const slug of foldersIn(root, MAX_SKILLS_PER_SOURCE)) {
        let theirs = true;
        try {
          lstatSync(join(root, slug, ".openbot-managed.json"));
        } catch {
          theirs = false;
        }
        if (theirs) managed++;
        else addSkill(b, join(root, slug), `${agent.key}/`, owner);
      }
    }
    if (managed) {
      b.skipped.push({
        from: `${from}: skills`,
        why: `${plural(managed, "skill OpenBot installed itself was", "skills OpenBot installed itself were")} left out, since ${managed === 1 ? "it is" : "they are"} OpenBot's own`,
      });
    }
  };
  const files = dir ? { list: folderFiles(dir), read: (path: string) => readFolderFile(dir, path), from } : undefined;
  addOpenBotAgent(b, agent, number, { from, instructionFile, skills, files });
}

/**
 * OpenBot: a transfer file when the person picked one, then each agent's
 * folder, named and set up from the database where it can be read.
 */
function openbot(home: string, options: DetectOptions = {}): SourceScan | null {
  const data = openbotDataFolder(home, options.platform);
  const agentsRoot = join(home, "OpenBot", "Agents");
  const picked = options.openbotTransfer ?? null;
  if (!picked && !isFolder(data) && !isFolder(agentsRoot)) return null;
  const b = begin(home, "openbot");

  let transfer: Transfer | null = null;
  if (picked) {
    try {
      transfer = openTransfer(picked);
    } catch (error) {
      b.skipped.push({ from: picked.name, why: `${error instanceof ZipRefused ? error.message : "it could not be read"}, so nothing in it was read` });
    }
  }

  // the database: names and settings, by the agent's id
  const dbPath = join(data, "openbot.db");
  const dbFrom = fromHome(home, dbPath);
  const rows = openbotDatabase(dbPath);
  const known = new Map<string, Record<string, unknown>>();
  if (rows && "skip" in rows) b.skipped.push({ from: dbFrom, why: rows.skip });
  else if (rows) {
    for (const raw of rows.agents) {
      const name = field(raw, "name");
      const id = field(raw, "id") ?? (name ? `named-${slugify(name)}` : undefined);
      if (id && !known.has(id)) known.set(id, raw);
    }
  }

  let number = 0;
  let over = 0;
  const seen = new Set<string>();
  const room = () => {
    if (number < MAX_AGENTS_PER_SOURCE) return true;
    over++;
    return false;
  };
  if (transfer) {
    for (const agent of transferAgents(transfer)) {
      if (!room()) continue;
      seen.add(agent.key);
      addTransferAgent(b, transfer, agent, ++number);
    }
    const names = [...transfer.entries.keys()].filter((n) => !n.endsWith("/"));
    const shared = names.filter((n) => n.startsWith("shared/")).length;
    if (shared) {
      b.skipped.push({ from: `${transfer.name}: shared`, why: `${plural(shared, "file", "files")} shared between agents stay in the transfer file. Copy the ones an agent needs into its workspace` });
    }
    const other = names.filter((n) => n !== TRANSFER_JSON && !n.startsWith("agents/") && !n.startsWith("shared/")).length;
    if (other) {
      b.skipped.push({ from: transfer.name, why: `${plural(other, "other entry was", "other entries were")} not read, since the transfer format does not say what ${other === 1 ? "it is" : "they are"}` });
    }
  }
  for (const key of foldersIn(agentsRoot, MAX_AGENTS_PER_SOURCE)) {
    if (seen.has(key) || !room()) continue;
    seen.add(key);
    addFolderAgent(b, agentFromJson(known.get(key) ?? {}, key), ++number, join(agentsRoot, key), dbFrom);
  }
  for (const [key, raw] of known) {
    if (seen.has(key) || !room()) continue;
    seen.add(key);
    addFolderAgent(b, agentFromJson(raw, key), ++number, null, dbFrom);
  }
  if (over) b.skipped.push({ from: "OpenBot", why: `${plural(over, "more agent was", "more agents were")} left out: Bloks brings ${MAX_AGENTS_PER_SOURCE} from one tool at a time` });

  if (!transfer && filesIn(join(home, "OpenBot", "Shared"), /./, 1).length) {
    b.skipped.push({ from: "~/OpenBot/Shared", why: "files shared between agents stay where they are. Copy the ones an agent needs into its workspace" });
  }
  const folder = transfer ? transfer.name : fromHome(home, isFolder(agentsRoot) ? join(home, "OpenBot") : data);
  return finish(b, folder);
}

/** What stays in OpenBot whatever is picked, as the dry run says it. */
export const OPENBOT_STAYS = "chat history and channels, saved logins and the vault, connectors and browser profiles";


/** Everything found, by source. Reads and never writes. */
export function detectSetup(home: string = homedir(), only?: SourceId, options: DetectOptions = {}): Scan {
  const readers: Record<SourceId, (home: string) => SourceScan | null> = { claude, codex, cursor, openclaw, hermes, openbot: (h) => openbot(h, options) };
  const sources = SOURCE_IDS.filter((id) => !only || id === only)
    .map((id) => readers[id](home))
    .filter((s): s is SourceScan => s !== null && (s.items.length > 0 || s.skipped.length > 0));
  for (const source of sources) source.items.sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
  // The same skill or server in two tools' folders (Cursor reads Claude
  // Code's skills, and people link one folder into another) is offered
  // once: the later copy says where the first is and waits unticked.
  const first = new Map<string, FoundItem>();
  // Two of one tool's agents carrying the same skill is the same case.
  for (const item of sources.flatMap((s) => s.items)) {
    if (item.kind !== "skill" && item.kind !== "mcp" && item.kind !== "agent") continue;
    const seen = first.get(item.digest);
    if (seen && seen.source !== item.source) item.sameAs = `${SOURCE_NAMES[seen.source]}'s ${seen.title}`;
    else if (seen && item.owner && seen.owner && seen.owner.key !== item.owner.key) item.sameAs = `${seen.owner.name}'s ${seen.title}`;
    else if (!seen) first.set(item.digest, item);
  }
  return { home, sources };
}

/** How a source's items are listed, and the order an import applies
 * them in: skills and servers before the agents that attach them, and
 * agents before the parts that go to them. */
export const KIND_ORDER: ItemKind[] = ["agent", "instructions", "memory", "files", "skill", "mcp", "setting", "routine", "rule", "fact", "channel"];
const APPLY_ORDER: ItemKind[] = ["skill", "mcp", "agent", "instructions", "memory", "files", "setting", "routine", "rule", "fact", "channel"];

// ── what came from where ───────────────────────────────────────────────

export interface RecordEntry {
  digest: string;
  at: number;
  to: Destination;
  botId?: string;
  /** What was made: a skill id, an MCP server id, a rule id, a note id,
   * an agent's id, or the chat app it was. */
  ref?: string;
  /** For instructions and memory: the file, and exactly what was added, so
   * the next import can find that text and replace it. */
  file?: string;
  applied?: string;
}

/**
 * One small file beside the workspace, keyed by item.
 *
 * Kept rather than worked out again from the destinations, because nothing
 * in an agent's instructions or a skill says where it came from, and
 * "updates rather than duplicates" needs to know exactly what the last
 * import added.
 */
export class ImportRecord {
  private readonly file: string;
  private entries: Record<string, RecordEntry>;

  constructor(file: string) {
    this.file = file;
    const saved = readSaved<Record<string, unknown>>(file, {}, isRecord);
    this.entries = {};
    for (const [key, value] of Object.entries(saved)) {
      if (isRecord(value) && typeof value.digest === "string" && typeof value.to === "string") {
        this.entries[key] = value as unknown as RecordEntry;
      }
    }
  }

  get(key: string): RecordEntry | undefined {
    return Object.hasOwn(this.entries, key) ? this.entries[key] : undefined;
  }

  set(key: string, entry: RecordEntry) {
    this.entries[key] = entry;
    this.save();
  }

  /** Forgotten, as when an undo takes back the only import of an item. */
  delete(key: string) {
    if (!Object.hasOwn(this.entries, key)) return;
    delete this.entries[key];
    this.save();
  }

  private save() {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    writeFileAtomic(this.file, JSON.stringify(this.entries, null, 2), 0o600);
  }
}

// ── where things go ────────────────────────────────────────────────────

export interface McpEntry {
  id: string;
  name: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
}

/** The parts of an agent an import may set, and an undo puts back. */
export interface AgentSettings {
  title: string;
  description: string;
  color?: string;
  effort?: Effort | null;
  modelSelection?: { instanceId: string; model: string };
  skillIds: string[];
  mcpServers: string[];
}

export interface ChannelInput {
  platform: ChatPlatform;
  /** The agent a Telegram bot answers as. */
  botId?: string;
  /** By field: botToken, appToken, token. */
  tokens: Record<string, string>;
}

/** What the import needs from the rest of Bloks. Passed in, so the rules
 * of the import can be checked without a running workspace. */
export interface ImportDeps {
  agent(id: string): { id: string; name: string; description: string; busy: boolean } | null;
  /** Every agent in service, for names an import could clash with. */
  agents(): Array<{ id: string; name: string }>;
  agentSettings(id: string): AgentSettings | null;
  patchAgent(id: string, patch: Partial<AgentSettings>): void;
  createAgent(input: { name: string; title: string; settings?: Partial<AgentSettings> }): string;
  /** Archives an agent an import made, unless the person has talked with
   * it since, in which case it is theirs now and stays. */
  retireAgent(id: string): "archived" | "talked" | "gone";
  /** The engine of that kind a new agent would run on, if Bloks has one. */
  engine(engine: Engine): { instanceId: string; model: string } | null;
  setInstructions(botId: string, text: string): void;
  /** null when the file is not there; throws when it cannot be read. */
  readMemory(botId: string, file: string): string | null;
  /** Through the memory journal, so it can be undone. */
  writeMemory(botId: string, file: string, before: string | null, after: string): void;
  skills(): Array<{ id: string; source: "builtin" | "user"; name?: string }>;
  skill(id: string): { name: string; description: string; body: string; source: "builtin" | "user" } | null;
  installSkill(input: { id: string; name: string; description: string; body: string }): string;
  removeSkill(id: string): boolean;
  mcpServers(): McpEntry[];
  saveMcpServers(list: McpEntry[]): void;
  newId(): string;
  rules(): Rule[];
  addRule(rule: Omit<Rule, "id" | "createdAt">): Rule | null;
  removeRule(id: string): boolean;
  notes(): ProfileNote[];
  suggestNote(text: string, by: { id: string; name: string }): ProfileNote | null;
  removeNote(id: string): boolean;
  /** A connection already saved for that app, by a short hash of its
   * token, never the token. */
  channel(platform: ChatPlatform, botId?: string): { tokenHash: string } | null;
  /** Checks the token with the app itself and saves it switched off. */
  connectChannel(input: ChannelInput): Promise<void>;
  disconnectChannel(platform: ChatPlatform, botId?: string): void;
  /** The name of the engine a new agent runs on, for an item to say so. */
  defaultEngine?(): string | null;
  /** A short hash of an agent's photo, or null when it has none. */
  avatarHash(botId: string): string | null;
  setAvatar(botId: string, mime: string, bytes: Buffer): void;
  clearAvatar(botId: string): void;
  /** A file into an agent's workspace, never over one already there:
   * written, there already with the same bytes, or taken by another. */
  writeWorkspaceFile(botId: string, path: string, bytes: Buffer): "written" | "same" | "taken";
  /** null when it is not there, or is not a plain file any more. */
  readWorkspaceFile(botId: string, path: string): Buffer | null;
  removeWorkspaceFile(botId: string, path: string): boolean;
  /** A routine for an agent, filed paused. Null when there is no room. */
  addRoutine(input: { botId: string; name?: string; prompt: string; time: string; days: number[] }): string | null;
  routine(id: string): { enabled: boolean } | null;
  removeRoutine(id: string): boolean;
}

/** A short hash of a picture's bytes, the way an undo knows it. */
export function avatarHashOf(bytes: Buffer): string {
  return bytesHash(bytes).slice(0, 32);
}

/** How an undo knows a connection is still the one an import made,
 * without keeping the token anywhere. */
export function tokenHash(token: string): string {
  return sha256(token).slice(0, 16);
}

/** Whatever an earlier import added, if it is still there to update. */
function stillThere(entry: RecordEntry, deps: ImportDeps): boolean {
  switch (entry.to) {
    case "brief": {
      const bot = entry.botId ? deps.agent(entry.botId) : null;
      return Boolean(bot && entry.applied && bot.description.includes(entry.applied));
    }
    case "memory": {
      if (!entry.botId || !entry.file || !entry.applied || !deps.agent(entry.botId)) return false;
      try {
        return (deps.readMemory(entry.botId, entry.file) ?? "").includes(entry.applied);
      } catch {
        return false;
      }
    }
    case "skills":
      return deps.skills().some((s) => s.id === entry.ref && s.source === "user");
    case "mcp":
      return deps.mcpServers().some((s) => s.id === entry.ref);
    case "rules":
      return deps.rules().some((r) => r.id === entry.ref);
    case "about":
      return deps.notes().some((n) => n.id === entry.ref);
    case "agent":
    case "engine":
    case "files":
      return Boolean(entry.botId && deps.agent(entry.botId));
    case "routine":
      return Boolean(entry.ref && deps.routine(entry.ref));
    case "channel":
      return Boolean(entry.ref && (entry.ref === "telegram" ? entry.botId && deps.channel("telegram", entry.botId) : deps.channel(entry.ref as ChatPlatform)));
    default:
      return false;
  }
}

export interface Conflict {
  kind: "skill" | "agent" | "mcp";
  /** What is already here by that name. */
  name: string;
  /** Whether the person may choose to write over it. Never a skill that
   * ships with Bloks, and never a server, whose keys the person typed. */
  canReplace: boolean;
}

export interface ReviewItem {
  key: string;
  source: SourceId;
  kind: ItemKind;
  title: string;
  from: string;
  preview: string;
  chars: number;
  digest: string;
  notes: string[];
  /** new: never imported. changed: imported, and different now.
   * imported: what is here is what was brought over last time. */
  status: "new" | "changed" | "imported";
  destinations: Destination[];
  suggested: { to: Destination; botId?: string };
  /** Ticked when the review opens. Rules, chat apps and copies of
   * something already listed wait for a person to tick them. */
  picked: boolean;
  /** Something already here by the same name, for the person to decide. */
  conflict?: Conflict;
  /** Values it needs and does not carry. No value is ever in here. */
  secrets?: SecretSlot[];
  sameAs?: string;
  skill?: { name: string; description: string };
  mcp?: { name: string; transport: "stdio" | "http"; needs: string[] };
  rule?: { effect: Effect; summary: string };
  agent?: { name: string; title: string; model?: string; skills: string[]; servers: string[]; refuses: string[]; photo?: string };
  setting?: { engine: Engine; engineName: string; model?: string; effort?: Effort };
  channel?: { platform: ChatPlatform; name: string; perAgent: boolean };
  files?: { count: number; bytes: number };
  routine?: { summary: string; scheduled: boolean };
  /** The agent it is a part of, which it goes to unless the person says;
   * `here` when an earlier import of that agent is still here to take it. */
  owner?: { key: string; name: string; here?: boolean };
}

export interface ReviewSource {
  id: SourceId;
  name: string;
  folder: string;
  agentName: string;
  items: ReviewItem[];
  skipped: Skipped[];
}

export interface Review {
  sources: ReviewSource[];
  /** Items that are new or changed: what is worth offering. */
  fresh: number;
}

/** What is here already by the name an item would take, unless it is
 * what an earlier import of this item made. */
function conflictOf(item: FoundItem, ours: boolean, deps: ImportDeps): Conflict | undefined {
  if (ours) return undefined;
  if (item.skill) {
    const id = slugify(item.skill.id);
    const theirs = deps.skills().find((s) => s.id === id);
    if (theirs) return { kind: "skill", name: theirs.name || theirs.id, canReplace: theirs.source === "user" };
  }
  if (item.agent) {
    const lower = item.agent.name.toLowerCase();
    const theirs = deps.agents().find((a) => a.name.toLowerCase() === lower);
    if (theirs) return { kind: "agent", name: theirs.name, canReplace: true };
  }
  if (item.mcp) {
    const lower = item.mcp.name.toLowerCase();
    const theirs = deps.mcpServers().find((s) => s.name.toLowerCase() === lower);
    if (theirs) return { kind: "mcp", name: theirs.name, canReplace: false };
  }
  return undefined;
}

/** What the window shows: every item with a preview, where it would go,
 * whether it was brought over before, and what it would clash with. */
export function reviewOf(scan: Scan, record: ImportRecord, deps: ImportDeps): Review {
  let fresh = 0;
  const engineHere = deps.defaultEngine?.() ?? null;
  const sources = scan.sources.map((source) => ({
    id: source.id,
    name: source.name,
    folder: source.folder,
    agentName: source.agentName,
    skipped: source.skipped,
    items: source.items.map((item): ReviewItem => {
      const before = record.get(item.key);
      const there = before ? stillThere(before, deps) : false;
      const status = !before || !there ? "new" : before.digest === item.digest ? "imported" : "changed";
      if (status !== "imported" && !item.sameAs) fresh++;
      const usual = item.destinations[0];
      // Where it went last time, while that agent is still here, even if
      // what was added has since been undone: the person chose it once.
      const toAgent = (to?: Destination) =>
        to === "brief" || to === "memory" || to === "engine" || to === "files" || to === "routine" || (to === "channel" && item.channel?.platform === "telegram");
      const agentGone = toAgent(before?.to) && !(before?.botId && deps.agent(before.botId));
      const again = before && item.destinations.includes(before.to) && !agentGone ? before : null;
      const to = again?.to ?? usual;
      // A part of an agent goes with it, which is said as the agent it
      // came with for as long as that is where it went.
      const ownerBot = item.owner ? record.get(item.owner.key)?.botId : undefined;
      const fallback = item.owner ? "owner" : "new";
      const botId = again?.botId && again.botId !== ownerBot ? again.botId : fallback;
      const suggested = toAgent(to) ? { to, botId } : { to };
      const notes = item.agent?.ranOn && !item.agent.model && engineHere
        ? item.notes.map((note) => (note === ranOnNote(item.agent!.ranOn!) ? ranOnNote(item.agent!.ranOn!, engineHere) : note))
        : item.notes;
      const conflict = conflictOf(item, Boolean(before && there), deps);
      return {
        key: item.key,
        source: item.source,
        kind: item.kind,
        title: item.title,
        from: item.from,
        preview: item.text.length > PREVIEW_CHARS ? `${item.text.slice(0, PREVIEW_CHARS).trimEnd()}\n…` : item.text,
        chars: item.text.length,
        digest: item.digest,
        notes,
        status,
        destinations: item.destinations,
        suggested,
        // rules, chat apps, files and schedules wait for a person to tick them
        picked: status !== "imported" && !["rule", "channel", "files", "routine"].includes(item.kind) && !item.sameAs,
        ...(conflict ? { conflict } : {}),
        ...(item.secrets?.length ? { secrets: item.secrets.map((s) => ({ ...s })) } : {}),
        ...(item.sameAs ? { sameAs: item.sameAs } : {}),
        ...(item.skill ? { skill: { name: item.skill.name, description: item.skill.description } } : {}),
        ...(item.mcp
          ? { mcp: { name: item.mcp.name, transport: item.mcp.transport, needs: [...Object.keys(item.mcp.env ?? {}), ...Object.keys(item.mcp.headers ?? {})] } }
          : {}),
        ...(item.rule ? { rule: { effect: item.rule.effect, summary: item.text } } : {}),
        ...(item.agent
          ? {
              agent: {
                name: item.agent.name,
                title: item.agent.title,
                ...(item.agent.model ? { model: item.agent.model.model || ENGINE_NAMES[item.agent.model.engine] } : {}),
                skills: item.agent.skills,
                servers: item.agent.servers,
                refuses: item.agent.deny.map((d) => d.label),
                // the picture by a hash of its bytes, for the window to ask for
                ...(item.agent.avatar ? { photo: item.agent.avatar.hash } : {}),
              },
            }
          : {}),
        ...(item.setting ? { setting: { ...item.setting, engineName: ENGINE_NAMES[item.setting.engine] } } : {}),
        ...(item.channel
          ? { channel: { platform: item.channel.platform, name: PLATFORM_NAMES[item.channel.platform], perAgent: item.channel.platform === "telegram" } }
          : {}),
        ...(item.files ? { files: { count: item.files.files.length, bytes: item.files.total } } : {}),
        ...(item.routine ? { routine: { summary: describeRoutine({ time: item.routine.time, days: item.routine.days } as Routine), scheduled: item.routine.scheduled } } : {}),
        ...(item.owner ? { owner: { ...item.owner, ...(ownerBot && deps.agent(ownerBot) ? { here: true } : {}) } } : {}),
      };
    }),
  }));
  return { sources, fresh };
}

/** A value for one slot: typed in by the person, or the other tool's own,
 * copied because the person said so for this one. */
export type SecretAnswer = { copy: true } | { value: string };

export interface Pick {
  key: string;
  digest: string;
  to: Destination;
  /** An agent's id, or "new" for an agent made for this source. */
  botId?: string;
  /** For an item whose name is taken: add it beside the other under a
   * name of its own, or write over the other. Leaving it out is unticking. */
  conflict?: "both" | "replace";
  /** By slot id. A slot not named here stays empty. */
  secrets?: Record<string, SecretAnswer>;
}

export interface ImportResult {
  key: string;
  ok: boolean;
  did?: "added" | "updated" | "unchanged";
  botId?: string;
  /** Something the person should know about how it landed. */
  note?: string;
  error?: string;
}

/**
 * What one import changed, a step at a time, so an undo can take each
 * back if it is still as the import left it. Never a secret: a chat
 * app's connection is known by a hash of its token, and a server's
 * values are blanked before its earlier shape is kept.
 */
export type UndoStep = { key: string; title: string } & (
  | { kind: "agent-created"; botId: string; name: string }
  | { kind: "agent-patched"; botId: string; name: string; before: AgentSettings; after: AgentSettings }
  | { kind: "brief"; botId: string; before: string; after: string }
  | { kind: "memory"; botId: string; file: string; before: string | null; after: string }
  | { kind: "skill-added"; id: string; body: string }
  | { kind: "skill-replaced"; id: string; before: { name: string; description: string; body: string }; body: string }
  | { kind: "mcp-added"; id: string; name: string }
  | { kind: "mcp-updated"; id: string; before: McpEntry }
  | { kind: "rule-added"; id: string }
  | { kind: "note-added"; id: string }
  | { kind: "channel"; platform: ChatPlatform; botId?: string; tokenHash: string }
  | { kind: "avatar-set"; botId: string; name: string; hash: string }
  | { kind: "files-added"; botId: string; files: Array<{ path: string; hash: string }> }
  | { kind: "routine-added"; id: string; name: string }
);

export interface ImportOutcome {
  results: ImportResult[];
  /** Agents made by this import. */
  created: string[];
  /** Everything it changed, in order, for an undo. */
  steps: UndoStep[];
  /** What the record said about each item before this import, so an undo
   * can put that back too. */
  records: Array<{ key: string; before: RecordEntry | null }>;
  /** What changed, so the caller can tell open windows. */
  touched: {
    agents: Set<string>;
    memory: Set<string>;
    skills: boolean;
    mcp: boolean;
    rules: boolean;
    notes: boolean;
    channels: Set<ChatPlatform>;
    routines: boolean;
  };
}

const DESTINATIONS = new Set<Destination>(["agent", "brief", "memory", "skills", "mcp", "engine", "rules", "about", "channel", "files", "routine"]);

/** A slot's answer, checked into shape. A value is what the person typed,
 * trimmed, and no longer than any key is. */
function cleanSecrets(value: unknown): Record<string, SecretAnswer> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, SecretAnswer> = {};
  for (const [id, answer] of Object.entries(value).slice(0, MAX_ENV_NAMES + MAX_HEADER_NAMES)) {
    if (!/^(env|header|token):[\w.-]{1,64}$/.test(id) || !isRecord(answer)) continue;
    if (answer.copy === true) out[id] = { copy: true };
    else if (typeof answer.value === "string") {
      const typed = answer.value.trim();
      if (typed && typed.length <= MAX_SECRET_CHARS && !/[\x00-\x08\x0a-\x1f\x7f]/.test(typed)) out[id] = { value: typed };
    }
  }
  return Object.keys(out).length ? out : undefined;
}

/** What a window may send, checked into shape. Anything else is dropped. */
export function cleanPicks(value: unknown): Pick[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: Pick[] = [];
  for (const raw of value.slice(0, 500)) {
    if (!isRecord(raw)) continue;
    const { key, digest, to, botId, conflict } = raw;
    if (typeof key !== "string" || key.length > 400 || seen.has(key)) continue;
    if (typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest)) continue;
    if (typeof to !== "string" || !DESTINATIONS.has(to as Destination)) continue;
    seen.add(key);
    const secrets = cleanSecrets(raw.secrets);
    out.push({
      key,
      digest,
      to: to as Destination,
      ...(typeof botId === "string" && /^[\w-]{1,64}$/.test(botId) ? { botId } : {}),
      ...(conflict === "both" || conflict === "replace" ? { conflict } : {}),
      ...(secrets ? { secrets } : {}),
    });
  }
  return out;
}

/** Puts `block` into `current`: in place of what the last import added
 * when that is still there, not again when it is already there, and on
 * the end otherwise. */
function placeBlock(current: string, block: string, last: string | undefined): { next: string; did: ImportResult["did"] } {
  if (last && current.includes(last)) {
    if (last === block) return { next: current, did: "unchanged" };
    // a function, so a $ in the text is not read as a replacement pattern
    return { next: current.replace(last, () => block), did: "updated" };
  }
  if (current.includes(block)) return { next: current, did: "unchanged" };
  return { next: current.trim() ? `${current.trimEnd()}\n\n${block}` : block, did: "added" };
}

const sameShape = (a: string, b: string) =>
  a.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "") === b.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/** A server with every value it holds blanked: what an undo may keep. */
function blanked(entry: McpEntry): McpEntry {
  const blank = (table?: Record<string, string>) => (table ? Object.fromEntries(Object.keys(table).map((n) => [n, ""])) : undefined);
  return { ...entry, ...(entry.env ? { env: blank(entry.env) } : {}), ...(entry.headers ? { headers: blank(entry.headers) } : {}) };
}

const sameSettings = (a: AgentSettings, b: AgentSettings) => JSON.stringify(a) === JSON.stringify(b);

/** The first paragraphs of a long prompt, up to `max` characters. */
function opening(text: string, max: number): string {
  let out = "";
  for (const paragraph of text.split(/\n{2,}/)) {
    if (out.length + paragraph.length + 2 > max) break;
    out = out ? `${out}\n\n${paragraph}` : paragraph;
  }
  return out || text.slice(0, max).trimEnd();
}

/**
 * The values an item needs, from what the person answered: typed, or
 * copied from the other tool's config because they said so for this
 * slot. A slot the item cannot do without and nobody answered stops it.
 */
function answersFor(item: FoundItem, pick: Pick): Map<string, string> {
  const out = new Map<string, string>();
  for (const slot of item.secrets ?? []) {
    const answer = pick.secrets?.[slot.id];
    if (!answer) continue;
    if ("copy" in answer) {
      const value = secretValue(item, slot.id);
      if (value === undefined) throw new Error(`there is no ${slot.name} in ${item.from} to copy. Paste it instead.`);
      out.set(slot.id, value);
    } else out.set(slot.id, answer.value);
  }
  for (const slot of item.secrets ?? []) {
    if (slot.required && !out.has(slot.id)) {
      throw new Error(`it needs its ${slot.name.toLowerCase()}. Paste it${slot.copyFrom ? `, or choose to copy the one in ${slot.copyFrom}` : ""}.`);
    }
  }
  return out;
}

/**
 * Applies the ticked items, each on its own: one that cannot be imported
 * says why and the rest still go. Reads nothing from the window but which
 * items, where, and the values the person typed or said to copy; the
 * content is the scan's.
 *
 * Skills and servers go first, so an agent made in the same import can
 * have the ones it asked for attached.
 */
export async function applyImport(scan: Scan, picks: unknown, deps: ImportDeps, record: ImportRecord, now = Date.now()): Promise<ImportOutcome> {
  const items = scan.sources.flatMap((s) => s.items);
  const byKey = new Map(items.map((item) => [item.key, item]));
  const sourceOf = new Map(scan.sources.map((s) => [s.id, s]));
  const rank = (key: string) => {
    const item = byKey.get(key);
    return item ? APPLY_ORDER.indexOf(item.kind) * 100_000 + items.indexOf(item) : Infinity;
  };
  const wanted = cleanPicks(picks).sort((a, b) => rank(a.key) - rank(b.key));
  const outcome: ImportOutcome = {
    results: [],
    created: [],
    steps: [],
    records: [],
    touched: { agents: new Set(), memory: new Set(), skills: false, mcp: false, rules: false, notes: false, channels: new Set(), routines: false },
  };
  // one new agent per source per import, whatever number of items go to it
  const fresh = new Map<SourceId, string>();
  // what each agent item became in this import, for the parts that go to it
  const madeFor = new Map<string, string>();
  const kept = new Set<string>();
  const remember = (key: string, entry: RecordEntry) => {
    if (!kept.has(key)) {
      kept.add(key);
      outcome.records.push({ key, before: record.get(key) ?? null });
    }
    record.set(key, entry);
  };

  const agentFor = (pick: Pick, item: FoundItem): string => {
    if (pick.botId === "owner") {
      if (!item.owner) throw new Error("choose an agent for this, or a new one");
      const earlier = record.get(item.owner.key);
      const id = madeFor.get(item.owner.key) ?? (earlier?.to === "agent" && earlier.botId && deps.agent(earlier.botId) ? earlier.botId : undefined);
      if (!id || !deps.agent(id)) throw new Error(`bring ${item.owner.name} over too, or choose another agent for this.`);
      return id;
    }
    if (pick.botId === "new") {
      const made = fresh.get(item.source);
      if (made && deps.agent(made)) return made;
      const source = sourceOf.get(item.source)!;
      const id = deps.createAgent({ name: source.agentName, title: `Brought over from ${source.name}` });
      fresh.set(item.source, id);
      outcome.created.push(id);
      outcome.steps.push({ kind: "agent-created", key: item.key, title: source.agentName, botId: id, name: source.agentName });
      return id;
    }
    if (!pick.botId || !deps.agent(pick.botId)) throw new Error("choose an agent for this, or a new one");
    return pick.botId;
  };

  /** Writes a block into an agent's memory file, through the journal. */
  const intoMemory = (item: FoundItem, botId: string, file: string, block: string, previous: string | undefined) => {
    const bot = deps.agent(botId)!;
    if (bot.busy) throw new Error(`${bot.name} is working right now. Import this once it has finished.`);
    const before = deps.readMemory(botId, file);
    const placed = placeBlock(before ?? "", block, previous);
    const after = placed.next.endsWith("\n") ? placed.next : `${placed.next}\n`;
    if (Buffer.byteLength(after, "utf8") > MEMORY_FILE_MAX_BYTES) {
      throw new Error(`${file} would pass 256 KB. Make room in ${bot.name}'s memory first.`);
    }
    if (placed.did !== "unchanged") {
      deps.writeMemory(botId, file, before, after);
      outcome.touched.memory.add(botId);
      outcome.steps.push({ kind: "memory", key: item.key, title: item.title, botId, file, before, after });
    }
    return placed.did;
  };

  for (const pick of wanted) {
    const item = byKey.get(pick.key);
    if (!item) {
      outcome.results.push({ key: pick.key, ok: false, error: "it is not there any more. Look again." });
      continue;
    }
    if (item.digest !== pick.digest) {
      outcome.results.push({ key: pick.key, ok: false, error: "it changed since you looked, so it was not imported. Look again." });
      continue;
    }
    if (!item.destinations.includes(pick.to)) {
      outcome.results.push({ key: pick.key, ok: false, error: "that is not somewhere this can go" });
      continue;
    }
    const last = record.get(item.key);
    const sourceName = SOURCE_NAMES[item.source];
    try {
      switch (pick.to) {
        case "brief": {
          const botId = agentFor(pick, item);
          const bot = deps.agent(botId)!;
          const block = item.text;
          const previous = last?.to === "brief" && last.botId === botId ? last.applied : undefined;
          const { next, did } = placeBlock(bot.description ?? "", block, previous);
          if (next.length > MAX_DESCRIPTION_CHARS) {
            throw new Error(
              `${bot.name}'s instructions would pass ${MAX_DESCRIPTION_CHARS.toLocaleString("en-US")} characters. Send this to its memory instead.`,
            );
          }
          if (next !== bot.description) {
            deps.setInstructions(botId, next);
            outcome.touched.agents.add(botId);
            outcome.steps.push({ kind: "brief", key: item.key, title: item.title, botId, before: bot.description ?? "", after: next });
          }
          remember(item.key, { digest: item.digest, at: now, to: "brief", botId, applied: block });
          outcome.results.push({ key: item.key, ok: true, did, botId });
          break;
        }
        case "memory": {
          const botId = agentFor(pick, item);
          const file = item.topic ? `memory/${item.topic}` : "MEMORY.md";
          const block = item.topic ? item.text : `## From ${sourceName}: ${item.title}\n\n${item.text}`;
          const previous = last?.to === "memory" && last.botId === botId && last.file === file ? last.applied : undefined;
          const did = intoMemory(item, botId, file, block, previous);
          remember(item.key, { digest: item.digest, at: now, to: "memory", botId, file, applied: block });
          outcome.results.push({ key: item.key, ok: true, did, botId });
          break;
        }
        case "skills": {
          const skill = item.skill!;
          const library = deps.skills();
          const mine = last?.to === "skills" && last.ref && library.some((s) => s.id === last.ref && s.source === "user") ? last.ref : null;
          let id = mine;
          let did: ImportResult["did"] = mine ? (last!.digest === item.digest ? "unchanged" : "updated") : "added";
          let before = mine ? deps.skill(mine) : null;
          if (!id) {
            const base = slugify(skill.id);
            const theirs = library.find((s) => s.id === base);
            if (theirs && pick.conflict === "replace") {
              // A skill that ships with Bloks is never written over; one
              // somebody wrote is, when they said so, and an undo puts it back.
              if (theirs.source !== "user") throw new Error(`${theirs.name || base} comes with Bloks and cannot be replaced. Keep both instead.`);
              id = base;
              before = deps.skill(base);
              did = "updated";
            } else {
              // A skill already in the library under that name is somebody's,
              // and an import does not get to write over it unasked.
              const taken = new Set(library.map((s) => s.id));
              id = [base, slugify(`${base}-${item.source}`), ...[2, 3, 4, 5].map((n) => slugify(`${base}-${item.source}-${n}`))].find((c) => !taken.has(c)) ?? null;
              if (!id) throw new Error("there are already skills by that name");
            }
          }
          if (did !== "unchanged") {
            deps.installSkill({ id, name: skill.name, description: skill.description, body: skill.body });
            outcome.touched.skills = true;
            outcome.steps.push(
              before
                ? { kind: "skill-replaced", key: item.key, title: item.title, id, before: { name: before.name, description: before.description, body: before.body }, body: sha256(skill.body) }
                : { kind: "skill-added", key: item.key, title: item.title, id, body: sha256(skill.body) },
            );
          }
          remember(item.key, { digest: item.digest, at: now, to: "skills", ref: id });
          outcome.results.push({ key: item.key, ok: true, did, ...(id !== slugify(skill.id) && !mine ? { note: `Added as ${id}, beside the one already here.` } : {}) });
          break;
        }
        case "mcp": {
          const mcp = item.mcp!;
          const given = answersFor(item, pick);
          const list = deps.mcpServers();
          const existing = last?.to === "mcp" && last.ref ? list.find((s) => s.id === last.ref) : undefined;
          const others = list.filter((s) => s !== existing);
          let name = mcp.name;
          if (others.some((s) => s.name.toLowerCase() === name.toLowerCase())) name = `${mcp.name} (${sourceName})`.slice(0, 40);
          // what the person gave now, else what they filled in before, for
          // every name still asked for
          const fill = (names: Record<string, string> | undefined, had: Record<string, string> | undefined, where: "env" | "header") =>
            names ? Object.fromEntries(Object.keys(names).map((n) => [n, given.get(`${where}:${n}`) ?? had?.[n] ?? ""])) : undefined;
          const entry: McpEntry = {
            id: existing?.id ?? deps.newId(),
            name,
            transport: mcp.transport,
            ...(mcp.command !== undefined ? { command: mcp.command } : {}),
            ...(mcp.args ? { args: mcp.args } : {}),
            ...(mcp.url !== undefined ? { url: mcp.url } : {}),
            ...(mcp.env ? { env: fill(mcp.env, existing?.env, "env") } : {}),
            ...(mcp.headers ? { headers: fill(mcp.headers, existing?.headers, "header") } : {}),
          };
          let did: ImportResult["did"];
          if (existing) {
            did = last!.digest === item.digest && JSON.stringify(entry) === JSON.stringify(existing) ? "unchanged" : "updated";
            if (did === "updated") {
              deps.saveMcpServers(list.map((s) => (s === existing ? entry : s)));
              outcome.steps.push({ kind: "mcp-updated", key: item.key, title: item.title, id: entry.id, before: blanked(existing) });
            }
          } else {
            if (list.length >= MAX_MCP_SERVERS) {
              throw new Error(`Bloks holds ${MAX_MCP_SERVERS} MCP servers. Remove one under Settings, Apps and keys, then import this.`);
            }
            did = "added";
            deps.saveMcpServers([...list, entry]);
            outcome.steps.push({ kind: "mcp-added", key: item.key, title: item.title, id: entry.id, name });
          }
          if (did !== "unchanged") outcome.touched.mcp = true;
          remember(item.key, { digest: item.digest, at: now, to: "mcp", ref: entry.id });
          const empty = [...Object.entries(entry.env ?? {}), ...Object.entries(entry.headers ?? {})].filter(([, v]) => !v).map(([n]) => n);
          outcome.results.push({
            key: item.key,
            ok: true,
            did,
            ...(name !== mcp.name ? { note: `Added as ${name}, beside the one already here.` } : empty.length ? { note: `Still needs ${empty.join(", ")}.` } : {}),
          });
          break;
        }
        case "rules": {
          const rule = item.rule!;
          const rules = deps.rules();
          let ref = last?.to === "rules" && last.ref && rules.some((r) => r.id === last.ref) ? last.ref : null;
          ref ??=
            rules.find(
              (r) =>
                !r.botId &&
                r.effect === rule.effect &&
                r.field === rule.field &&
                r.op === rule.op &&
                (r.tool ?? "") === (rule.tool ?? "") &&
                r.value.toLowerCase() === rule.value.toLowerCase(),
            )?.id ?? null;
          let did: ImportResult["did"] = "unchanged";
          if (!ref) {
            const cleaned = cleanRule({ ...rule, enabled: true });
            if ("error" in cleaned) throw new Error(cleaned.error);
            const added = deps.addRule(cleaned.rule);
            if (!added) throw new Error("that is as many rules as one workspace holds");
            ref = added.id;
            did = "added";
            outcome.touched.rules = true;
            outcome.steps.push({ kind: "rule-added", key: item.key, title: item.title, id: added.id });
          }
          remember(item.key, { digest: item.digest, at: now, to: "rules", ref });
          outcome.results.push({ key: item.key, ok: true, did });
          break;
        }
        case "about": {
          const notes = deps.notes();
          let ref = last?.to === "about" && last.ref && notes.some((n) => n.id === last.ref) ? last.ref : null;
          ref ??= notes.find((n) => sameShape(n.text, item.text))?.id ?? null;
          let did: ImportResult["did"] = "unchanged";
          if (!ref) {
            const note = deps.suggestNote(item.text, { id: "setup-import", name: `your ${sourceName} setup` });
            if (!note) throw new Error("there are already 20 suggestions waiting in About you. Keep or dismiss some first.");
            ref = note.id;
            did = "added";
            outcome.touched.notes = true;
            outcome.steps.push({ kind: "note-added", key: item.key, title: item.title, id: note.id });
          }
          remember(item.key, { digest: item.digest, at: now, to: "about", ref });
          outcome.results.push({ key: item.key, ok: true, did });
          break;
        }
        case "agent": {
          const result = importAgent(item, pick, last, deps, outcome, sourceOf.get(item.source)!, record);
          madeFor.set(item.key, result.botId);
          remember(item.key, { digest: item.digest, at: now, to: "agent", botId: result.botId, ref: result.botId });
          outcome.results.push({ key: item.key, ok: true, ...result });
          break;
        }
        case "files": {
          const botId = agentFor(pick, item);
          const bot = deps.agent(botId)!;
          const read = FILE_READERS.get(item);
          if (!read) throw new Error("its files cannot be read any more. Look again.");
          // Each file on its own: one that changed into something else
          // since the look, or that the workspace refuses, is named and
          // the rest still come.
          const written: Array<{ path: string; hash: string }> = [];
          let taken = 0;
          const failed: string[] = [];
          for (const file of item.files!.files) {
            try {
              const bytes = read(file.path);
              const did = deps.writeWorkspaceFile(botId, file.path, bytes);
              if (did === "written") written.push({ path: file.path, hash: bytesHash(bytes) });
              else if (did === "taken") taken++;
            } catch {
              failed.push(file.path);
            }
          }
          if (written.length) {
            outcome.steps.push({ kind: "files-added", key: item.key, title: item.title, botId, files: written });
            outcome.touched.agents.add(botId);
          }
          remember(item.key, { digest: item.digest, at: now, to: "files", botId, ref: botId });
          const said = [
            taken ? `${plural(taken, "file was", "files were")} already in ${bot.name}'s workspace and ${taken === 1 ? "was" : "were"} left as ${taken === 1 ? "it is" : "they are"}.` : "",
            failed.length ? `${plural(failed.length, "file", "files")} could not be read: ${failed.slice(0, 3).join(", ")}${failed.length > 3 ? ", and more" : ""}.` : "",
          ].filter(Boolean);
          outcome.results.push({
            key: item.key,
            ok: true,
            did: written.length ? (last?.to === "files" ? "updated" : "added") : "unchanged",
            botId,
            ...(said.length ? { note: said.join(" ") } : {}),
          });
          break;
        }
        case "routine": {
          const routine = item.routine!;
          const botId = agentFor(pick, item);
          const still = last?.to === "routine" && last.ref && deps.routine(last.ref) ? last.ref : null;
          if (still) {
            remember(item.key, { digest: item.digest, at: now, to: "routine", botId, ref: still });
            outcome.results.push({
              key: item.key,
              ok: true,
              did: "unchanged",
              botId,
              ...(last!.digest !== item.digest ? { note: "The one from the last import is still here. Change it under Routines." } : {}),
            });
            break;
          }
          const id = deps.addRoutine({ botId, ...(routine.name ? { name: routine.name } : {}), prompt: routine.prompt, time: routine.time, days: routine.days });
          if (!id) throw new Error("Bloks holds 50 routines. Remove one under Routines, then import this.");
          outcome.steps.push({ kind: "routine-added", key: item.key, title: item.title, id, name: item.title });
          outcome.touched.routines = true;
          remember(item.key, { digest: item.digest, at: now, to: "routine", botId, ref: id });
          outcome.results.push({ key: item.key, ok: true, did: "added", botId, note: "Added paused. Switch it on under Routines." });
          break;
        }
        case "engine": {
          const setting = item.setting!;
          const engine = deps.engine(setting.engine);
          if (!engine) {
            throw new Error(`${ENGINE_NAMES[setting.engine]} is not set up in Bloks yet. Connect it under Settings, Engines and keys, then import this.`);
          }
          const botId = agentFor(pick, item);
          const bot = deps.agent(botId)!;
          if (bot.busy) throw new Error(`${bot.name} is working right now. Import this once it has finished.`);
          const before = deps.agentSettings(botId)!;
          const after: AgentSettings = {
            ...before,
            modelSelection: { instanceId: engine.instanceId, model: setting.model ?? engine.model },
            ...(setting.effort ? { effort: setting.effort } : {}),
          };
          const did: ImportResult["did"] = sameSettings(before, after) ? "unchanged" : last?.to === "engine" && last.botId === botId ? "updated" : "added";
          if (did !== "unchanged") {
            deps.patchAgent(botId, { modelSelection: after.modelSelection, ...(setting.effort ? { effort: setting.effort } : {}) });
            outcome.touched.agents.add(botId);
            outcome.steps.push({ kind: "agent-patched", key: item.key, title: item.title, botId, name: bot.name, before, after });
          }
          remember(item.key, { digest: item.digest, at: now, to: "engine", botId });
          outcome.results.push({ key: item.key, ok: true, did, botId });
          break;
        }
        case "channel": {
          const channel = item.channel!;
          const label = PLATFORM_NAMES[channel.platform];
          const given = answersFor(item, pick);
          const tokens = Object.fromEntries([...given].map(([id, value]) => [id.slice("token:".length), value]));
          const madeBefore = outcome.created.length;
          const botId = channel.platform === "telegram" ? agentFor(pick, item) : undefined;
          try {
            if (deps.channel(channel.platform, botId)) {
              throw new Error(
                botId ? `${deps.agent(botId)!.name} already has a ${label} bot. Change it in the agent's settings instead.` : `${label} is already connected. Change it under Settings, Chat apps instead.`,
              );
            }
            await deps.connectChannel({ platform: channel.platform, ...(botId ? { botId } : {}), tokens });
          } catch (error) {
            // an agent made only to hold this bot is not left behind
            if (botId && outcome.created.length > madeBefore && deps.retireAgent(botId) === "archived") {
              outcome.created.pop();
              outcome.steps.pop();
              fresh.delete(item.source);
            }
            throw error;
          }
          const saved = deps.channel(channel.platform, botId);
          outcome.touched.channels.add(channel.platform);
          if (saved) outcome.steps.push({ kind: "channel", key: item.key, title: item.title, platform: channel.platform, ...(botId ? { botId } : {}), tokenHash: saved.tokenHash });
          remember(item.key, { digest: item.digest, at: now, to: "channel", ref: channel.platform, ...(botId ? { botId } : {}) });
          outcome.results.push({
            key: item.key,
            ok: true,
            did: "added",
            ...(botId ? { botId } : {}),
            note: `Saved switched off. Turn it on once ${sourceName} has stopped using this bot.`,
          });
          break;
        }
      }
    } catch (error) {
      outcome.results.push({ key: item.key, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return outcome;
}

/**
 * A subagent as an agent: made new, written over an agent of the same
 * name when the person said to, or brought up to date when an earlier
 * import made it.
 *
 * The skills and servers it asked for are attached when Bloks has them
 * by that name, including ones this same import just added. What it was
 * refused becomes rules for it alone.
 */
function importAgent(
  item: FoundItem,
  pick: Pick,
  last: RecordEntry | undefined,
  deps: ImportDeps,
  outcome: ImportOutcome,
  source: SourceScan,
  record: ImportRecord,
): { did: ImportResult["did"]; botId: string; note?: string } {
  const a = item.agent!;
  const notes: string[] = [];
  let botId = last?.to === "agent" && last.botId && deps.agent(last.botId) ? last.botId : null;
  if (!botId && pick.conflict === "replace") {
    const lower = a.name.toLowerCase();
    botId = deps.agents().find((x) => x.name.toLowerCase() === lower)?.id ?? null;
  }

  const long = a.instructions.length > MAX_DESCRIPTION_CHARS;
  const heading = `Instructions from ${source.name}`;
  const settings: Partial<AgentSettings> = {
    title: a.title,
    description: long ? `${opening(a.instructions, MAX_DESCRIPTION_CHARS - 200)}\n\nThe whole of your instructions are in your memory, under "${heading}".` : a.instructions,
  };
  if (a.color) settings.color = a.color;
  if (a.effort) settings.effort = a.effort;
  if (a.model) {
    const engine = deps.engine(a.model.engine);
    if (engine) settings.modelSelection = { instanceId: engine.instanceId, model: a.model.model || engine.model };
    else notes.push(`It runs on your default engine: ${ENGINE_NAMES[a.model.engine]} is not set up in Bloks yet.`);
  }

  // what it asked for, by name: in the library, or brought over just now
  const skillIds: string[] = [];
  const library = deps.skills();
  for (const wanted of a.skills) {
    const slug = slugify(wanted.replace(/:/g, "-"));
    // its own copy first, where each agent brought skills of its own
    const named = source.items.filter((i) => i.skill && slugify(i.skill.id) === slug);
    const brought = named.find((i) => i.owner?.key === item.key) ?? named[0];
    const ref = brought ? outcomeRef(outcome, brought.key, deps, record, "skills") : undefined;
    const id = ref ?? library.find((s) => s.id === slug)?.id;
    if (id && !skillIds.includes(id)) skillIds.push(id);
    else if (!id) notes.push(`Bloks has no skill called ${wanted} yet, so it was not attached.`);
  }
  const serverIds: string[] = [];
  const servers = deps.mcpServers();
  for (const wanted of a.servers) {
    const lower = wanted.toLowerCase();
    const brought = source.items.find((i) => i.mcp && i.mcp.name.toLowerCase() === lower);
    const ref = brought ? outcomeRef(outcome, brought.key, deps, record, "mcp") : undefined;
    const id = ref ?? servers.find((s) => s.name.toLowerCase() === lower)?.id;
    if (id && !serverIds.includes(id)) serverIds.push(id);
    else if (!id) notes.push(`Bloks has no MCP server called ${wanted} yet, so it was not attached.`);
  }

  let did: ImportResult["did"];
  if (botId) {
    const bot = deps.agent(botId)!;
    if (bot.busy) throw new Error(`${bot.name} is working right now. Import this once it has finished.`);
    const before = deps.agentSettings(botId)!;
    const after: AgentSettings = {
      ...before,
      ...settings,
      skillIds: [...new Set([...before.skillIds, ...skillIds])],
      mcpServers: [...new Set([...before.mcpServers, ...serverIds])],
    };
    did = sameSettings(before, after) ? "unchanged" : "updated";
    if (did === "updated") {
      deps.patchAgent(botId, after);
      outcome.touched.agents.add(botId);
      outcome.steps.push({ kind: "agent-patched", key: item.key, title: item.title, botId, name: bot.name, before, after });
    }
  } else {
    const taken = deps.agents().some((x) => x.name.toLowerCase() === a.name.toLowerCase());
    const name = taken ? `${a.name} (${source.name})`.slice(0, MAX_NAME_CHARS) : a.name;
    botId = deps.createAgent({ name, title: a.title, settings: { ...settings, skillIds, mcpServers: serverIds } });
    outcome.created.push(botId);
    outcome.steps.push({ kind: "agent-created", key: item.key, title: item.title, botId, name });
    if (taken) notes.push(`Added as ${name}, beside the agent already called ${a.name}.`);
    did = "added";
  }

  // Its picture, on an agent made now or one that has none: a photo the
  // person chose is theirs, and an import does not write over it.
  const photo = a.avatar ? AVATARS.get(item) : undefined;
  if (photo && a.avatar && deps.avatarHash(botId) === null) {
    deps.setAvatar(botId, a.avatar.mime, photo);
    outcome.touched.agents.add(botId);
    if (did !== "added") {
      outcome.steps.push({ kind: "avatar-set", key: item.key, title: `${a.name}'s picture`, botId, name: a.name, hash: avatarHashOf(photo) });
      if (did === "unchanged") did = "updated";
    }
  }

  if (long) {
    const block = `## ${heading}\n\n${a.instructions}`;
    const file = "MEMORY.md";
    const bot = deps.agent(botId)!;
    const before = deps.readMemory(botId, file);
    const placed = placeBlock(before ?? "", block, undefined);
    const after = placed.next.endsWith("\n") ? placed.next : `${placed.next}\n`;
    if (placed.did !== "unchanged" && Buffer.byteLength(after, "utf8") <= MEMORY_FILE_MAX_BYTES && !bot.busy) {
      deps.writeMemory(botId, file, before, after);
      outcome.touched.memory.add(botId);
      outcome.steps.push({ kind: "memory", key: item.key, title: item.title, botId, file, before, after });
    }
  }

  // refusals for this agent alone, each once
  for (const deny of a.deny) {
    const have = deps.rules().some((r) => r.botId === botId && r.effect === "deny" && r.field === deny.field && r.op === deny.op && r.value === deny.value);
    if (have) continue;
    const cleaned = cleanRule({ effect: "deny", field: deny.field, op: deny.op, value: deny.value, botId, enabled: true });
    if ("error" in cleaned) continue;
    const added = deps.addRule(cleaned.rule);
    if (!added) {
      notes.push("Bloks holds 100 rules, so not everything it was refused could be added.");
      break;
    }
    outcome.touched.rules = true;
    outcome.steps.push({ kind: "rule-added", key: item.key, title: `${a.name}: deny ${deny.label}`, id: added.id });
  }
  return { did, botId, ...(notes.length ? { note: notes.join(" ") } : {}) };
}

/** What an item became, if it was imported just now or before and is
 * still here. */
function outcomeRef(outcome: ImportOutcome, key: string, deps: ImportDeps, record: ImportRecord, to: "skills" | "mcp"): string | undefined {
  for (const step of outcome.steps) {
    if (step.key !== key) continue;
    if (to === "skills" && (step.kind === "skill-added" || step.kind === "skill-replaced")) return step.id;
    if (to === "mcp" && (step.kind === "mcp-added" || step.kind === "mcp-updated")) return step.id;
  }
  const entry = record.get(key);
  return entry?.to === to && entry.ref && stillThere(entry, deps) ? entry.ref : undefined;
}

// ── a look from the terminal ───────────────────────────────────────────

const KIND_LABELS: Record<ItemKind, string> = {
  agent: "Agents",
  instructions: "Instructions",
  memory: "Memory",
  skill: "Skills",
  mcp: "MCP servers",
  setting: "Models",
  rule: "Rules",
  fact: "About you",
  channel: "Chat apps",
  files: "Workspace files",
  routine: "Routines",
};

/** What a scan found, as `bloks-server import --dry-run` prints it: by
 * source, grouped by what each becomes, and what was left out. Reads
 * nothing more and writes nothing; no value is ever in it. */
export function dryRunReport(scan: Scan): string {
  if (!scan.sources.length) return `Nothing to bring over. Bloks looks in ~/.claude, ~/.codex, ~/.cursor, ~/.openclaw, ~/.hermes and OpenBot's folders.\n`;
  const lines: string[] = [];
  for (const source of scan.sources) {
    lines.push(`${source.name} (${source.folder})`);
    for (const kind of KIND_ORDER) {
      const items = source.items.filter((i) => i.kind === kind);
      if (!items.length) continue;
      lines.push(`  ${KIND_LABELS[kind]}`);
      for (const item of items) {
        const extra = [
          item.sameAs ? `same as ${item.sameAs}` : "",
          item.secrets?.length ? `needs ${item.secrets.map((s) => s.name).join(", ")}` : "",
          item.files ? `${plural(item.files.files.length, "file", "files")}, ${sizeWords(item.files.total)}` : "",
          item.routine ? describeRoutine({ time: item.routine.time, days: item.routine.days } as Routine) : "",
        ].filter(Boolean);
        lines.push(`    ${item.title}${extra.length ? ` (${extra.join("; ")})` : ""}`);
        for (const note of item.notes) lines.push(`      ${note}`);
      }
    }
    if (source.skipped.length) {
      lines.push("  Left out");
      for (const skip of source.skipped) lines.push(`    ${skip.from}: ${skip.why}`);
    }
    if (source.id === "openbot") lines.push(`  Stays in OpenBot: ${OPENBOT_STAYS}.`);
    lines.push("");
  }
  const count = scan.sources.reduce((n, s) => n + s.items.length, 0);
  lines.push(`${count} ${count === 1 ? "item" : "items"} found. Nothing was imported: choose what to bring over in Bloks, Settings, Bring your setup.`);
  return `${lines.join("\n")}\n`;
}
