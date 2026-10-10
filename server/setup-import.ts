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
//   folder is ever written.
//
//   Never a credential. Files that hold sign-ins (auth.json,
//   .credentials.json, .env, tokens, keychains) are never opened, even
//   when a link points at one. What is read is scrubbed of anything shaped
//   like a key before anyone sees it, and an MCP server's environment and
//   headers come across as names with empty values: the person fills them
//   in here, on purpose, or that part of the server stays empty.
//
//   Nothing is written until the person ticks it. The review is a list;
//   the import applies the ticked items and nothing else. It reads the
//   files again rather than trusting what the window sends back, so a file
//   that changed since the review is refused rather than imported unseen.
//
//   Again means update. Each item has a stable key and a digest of what was
//   imported, kept beside the rest of the workspace, so importing a second
//   time replaces what the first time added instead of adding it twice.
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";

import { isRecord, readSaved, writeFileAtomic } from "./atomic-write.ts";
import { reservedEnvName } from "./env-names.ts";
import { MAX_DESCRIPTION_CHARS, MAX_MCP_SERVERS } from "./limits.ts";
import { cleanRule, describe as describeRule, isQuestionTool, type Effect, type Field, type Op, type Rule } from "./policy.ts";
import { cleanNote, MAX_NOTE, type ProfileNote } from "./profile-notes.ts";
import { countChars, MAX_SKILL_CHARS, slugify } from "./skills.ts";
import { MEMORY_FILE_MAX_BYTES } from "./workspace.ts";

// ── what there is to find ──────────────────────────────────────────────

export type SourceId = "claude" | "codex" | "openclaw" | "hermes";

export const SOURCE_NAMES: Record<SourceId, string> = {
  claude: "Claude Code",
  codex: "Codex",
  openclaw: "OpenClaw",
  hermes: "Hermes",
};

export type ItemKind = "instructions" | "memory" | "skill" | "mcp" | "rule" | "fact";

/** Where an item can go. Each kind has its own short list. */
export type Destination = "brief" | "memory" | "skills" | "mcp" | "rules" | "about";

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
  rule?: { effect: Effect; field: Field; op: Op; value: string };
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
 * line per key, so this reads the folded form too, and nothing else of
 * YAML: the other keys belong to the tool the skill came from.
 */
export function readFrontmatter(markdown: string): { name?: string; description?: string; body: string } {
  const match = markdown.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { body: markdown.trim() };
  const meta: Record<string, string> = {};
  const lines = match[1].split("\n");
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (!kv) continue;
    let value = kv[2].trim();
    if (/^[|>][+-]?$/.test(value)) {
      const folded: string[] = [];
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || !lines[i + 1].trim())) folded.push(lines[++i].trim());
      value = folded.filter(Boolean).join(" ");
    }
    meta[kv[1].toLowerCase()] = value.replace(/^["']|["']$/g, "");
  }
  return { name: meta.name, description: meta.description, body: match[2].trim() };
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
  | { rule: { effect: Effect; field: Field; op: Op; value: string }; notes: string[] }
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
    return prefix
      ? out("command", "starts-with", command, ["Bloks compares the start of the command, so anything added after these words is allowed too."])
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
    // A Bloks rule about a path covers every tool, so an allow written for
    // reading would allow writing as well.
    if (!deny && ["Read", "Glob", "Grep", "LS"].includes(tool)) {
      return { skip: "a Bloks rule about a path covers every tool, so this would let agents change files there too, not only read them" };
    }
    const path = pathRule(spec.trim(), home);
    if (!path) return { skip: "a path pattern Bloks rules cannot express" };
    if (!deny && !path.exact) {
      return { skip: "relative to a project folder, which a rule for every agent cannot know, so it would allow more than it did" };
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
 */
export function mcpFrom(rawName: string, raw: unknown, sourceName: string): { mcp: McpImport; notes: string[] } | { skip: string } {
  if (!isRecord(raw)) return { skip: "not a server entry Bloks can read" };
  const name = rawName.replace(/[\x00-\x1f]/g, "").trim().slice(0, 40);
  if (!name) return { skip: "a server with no name" };
  const notes: string[] = [];
  let removed = 0;
  const scrub = (value: string) => {
    const s = scrubSecrets(value);
    removed += s.removed;
    return s.text;
  };

  const url = typeof raw.url === "string" ? raw.url.trim() : typeof raw.serverUrl === "string" ? raw.serverUrl.trim() : "";
  const command = typeof raw.command === "string" ? raw.command.trim() : "";
  const transport: McpImport["transport"] = command ? "stdio" : "http";
  const mcp: McpImport = { name, transport };

  if (transport === "stdio") {
    mcp.command = scrub(command).slice(0, 300);
    const args: string[] = [];
    const given = strings(raw.args).slice(0, MAX_ARGS);
    for (let i = 0; i < given.length; i++) {
      const arg = given[i].slice(0, 1000);
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
  for (const envName of [...Object.keys(isRecord(raw.env) ? raw.env : {}), ...strings(raw.env_vars)]) {
    if (!ENV_NAME.test(envName)) continue;
    if (reservedEnvName(envName.toUpperCase())) dropped.push(envName);
    else if (envNames.size < MAX_ENV_NAMES) envNames.add(envName);
  }
  if (dropped.length) notes.push(`${dropped.join(", ")} ${dropped.length === 1 ? "was" : "were"} not carried: ${dropped.length === 1 ? "it changes" : "they change"} how programs start, so set ${dropped.length === 1 ? "it" : "them"} yourself if the server needs ${dropped.length === 1 ? "it" : "them"}.`);

  const headerNames = new Set<string>();
  const headerSources = [raw.headers, raw.http_headers, raw.env_http_headers].filter(isRecord);
  for (const table of headerSources) {
    for (const header of Object.keys(table)) if (HEADER_NAME.test(header) && headerNames.size < MAX_HEADER_NAMES) headerNames.add(header);
  }
  if (typeof raw.bearer_token_env_var === "string" && headerNames.size < MAX_HEADER_NAMES) headerNames.add("Authorization");
  if (transport === "stdio") headerNames.clear();

  if (envNames.size) mcp.env = Object.fromEntries([...envNames].map((n) => [n, ""]));
  if (headerNames.size) mcp.headers = Object.fromEntries([...headerNames].map((n) => [n, ""]));
  const needs = [...envNames, ...headerNames];
  if (needs.length) {
    notes.push(
      `${needs.join(", ")} ${needs.length === 1 ? "was" : "were"} not copied. Fill ${needs.length === 1 ? "it" : "them"} in under Settings, Apps and keys.`,
    );
  }
  if (raw.enabled === false || raw.disabled === true) notes.push(`It is switched off in ${sourceName}.`);
  notes.unshift(...removedNote(removed));
  return { mcp, notes };
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

/** Instructions or memory, from one text file. */
function addText(b: Builder, kind: "instructions" | "memory", path: string, extra: { title?: string; topic?: string } = {}) {
  const from = fromHome(b.home, path);
  const read = readKnown(path, MAX_TEXT_FILE_BYTES, /\.md$/i);
  if (!read) return;
  if ("skip" in read) return void b.skipped.push({ from, why: read.skip });
  const { text, removed } = scrubSecrets(read.text);
  const body = text.trim();
  if (!body) return;
  const title = extra.title ?? basename(path);
  const notes = removedNote(removed);
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

function addSkill(b: Builder, dir: string) {
  const path = join(dir, "SKILL.md");
  const from = fromHome(b.home, path);
  const read = readKnown(path, MAX_SKILL_FILE_BYTES, /\.md$/i);
  if (!read) return;
  if ("skip" in read) return void b.skipped.push({ from, why: read.skip });
  const parsed = readFrontmatter(read.text);
  const { text: body, removed } = scrubSecrets(parsed.body);
  if (!body.trim()) return;
  if (countChars(body) > MAX_SKILL_CHARS) {
    return void b.skipped.push({ from, why: `longer than a skill holds (${MAX_SKILL_CHARS.toLocaleString("en-US")} characters)` });
  }
  const folder = basename(dir);
  const name = scrubSecrets(parsed.name?.trim() || folder).text.slice(0, 80);
  const firstLine = body.split("\n").find((l) => l.trim() && !l.startsWith("#"))?.trim() ?? "";
  const description = scrubSecrets(parsed.description?.trim() || firstLine).text.slice(0, 200);
  const skill = { id: slugify(folder), name, description, body: body.trim() };
  const notes = removedNote(removed);
  let others = 0;
  try {
    others = readdirSync(dir).filter((f) => f !== "SKILL.md" && !f.startsWith(".")).length;
  } catch {
    /* the skill itself was readable, which is what matters */
  }
  if (others) {
    notes.push(`Only its instructions come across. The ${plural(others, "other file", "other files")} in its folder stay${others === 1 ? "s" : ""} in ${fromHome(b.home, dir)}.`);
  }
  b.items.push({
    key: `${b.source}:skill:${folder}`,
    source: b.source,
    kind: "skill",
    title: name,
    from,
    text: skill.body,
    digest: digestOf({ kind: "skill", ...skill }),
    notes,
    destinations: ["skills"],
    skill,
  });
}

function addMcp(b: Builder, name: string, raw: unknown, from: string) {
  const made = mcpFrom(name, raw, SOURCE_NAMES[b.source]);
  if ("skip" in made) return void b.skipped.push({ from: `${from}: ${name}`, why: made.skip });
  const mcp = made.mcp;
  b.items.push({
    key: `${b.source}:mcp:${mcp.name}`,
    source: b.source,
    kind: "mcp",
    title: mcp.name,
    from,
    text: mcpPreview(mcp),
    digest: digestOf({ kind: "mcp", ...mcp }),
    notes: made.notes,
    destinations: ["mcp"],
    mcp,
  });
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

function addRules(b: Builder, path: string) {
  const from = fromHome(b.home, path);
  const read = readKnown(path, MAX_SETTINGS_BYTES, /\.json$/i);
  if (!read) return;
  if ("skip" in read) return void b.skipped.push({ from, why: read.skip });
  let settings: unknown;
  try {
    settings = JSON.parse(read.text);
  } catch {
    return void b.skipped.push({ from, why: "not JSON Bloks can read" });
  }
  const permissions = isRecord(settings) && isRecord(settings.permissions) ? settings.permissions : {};
  let count = 0;
  for (const effect of ["deny", "allow"] as const) {
    for (const pattern of strings(permissions[effect])) {
      if (count >= MAX_RULES_PER_SOURCE) return;
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
  addText(b, "instructions", join(root, "CLAUDE.md"));
  for (const folder of foldersIn(join(root, "skills"), MAX_SKILLS_PER_SOURCE)) addSkill(b, join(root, "skills", folder));
  // Only the servers set for every project. The ones under "projects" are
  // tied to one folder each, and belong to that folder rather than to the
  // person.
  const read = readKnown(json, MAX_CONFIG_JSON_BYTES, /\.json$/i);
  if (read && "skip" in read) b.skipped.push({ from: "~/.claude.json", why: read.skip });
  if (read && "text" in read) {
    try {
      const parsed = JSON.parse(read.text);
      const servers = isRecord(parsed) && isRecord(parsed.mcpServers) ? parsed.mcpServers : {};
      for (const name of Object.keys(servers).slice(0, MAX_MCP_PER_SOURCE)) addMcp(b, name, servers[name], "~/.claude.json");
    } catch {
      b.skipped.push({ from: "~/.claude.json", why: "not JSON Bloks can read" });
    }
  }
  addRules(b, join(root, "settings.json"));
  return finish(b, "~/.claude");
}

function codex(home: string): SourceScan | null {
  const root = join(home, ".codex");
  if (!isFolder(root)) return null;
  const b = begin(home, "codex");
  addText(b, "instructions", join(root, "AGENTS.md"));
  const path = join(root, "config.toml");
  const read = readKnown(path, MAX_SETTINGS_BYTES, /\.toml$/i);
  if (read && "skip" in read) b.skipped.push({ from: "~/.codex/config.toml", why: read.skip });
  if (read && "text" in read) {
    const servers = parseToml(read.text).mcp_servers;
    if (isRecord(servers)) {
      for (const name of Object.keys(servers).slice(0, MAX_MCP_PER_SOURCE)) addMcp(b, name, servers[name], "~/.codex/config.toml");
    }
  }
  return finish(b, "~/.codex");
}

function openclaw(home: string): SourceScan | null {
  const root = join(home, ".openclaw", "workspace");
  if (!isFolder(root)) return null;
  const b = begin(home, "openclaw");
  addText(b, "instructions", join(root, "SOUL.md"));
  addText(b, "instructions", join(root, "IDENTITY.md"));
  addText(b, "memory", join(root, "MEMORY.md"));
  addTopics(b, join(root, "memory"));
  for (const folder of foldersIn(join(root, "skills"), MAX_SKILLS_PER_SOURCE)) addSkill(b, join(root, "skills", folder));
  addFacts(b, join(root, "USER.md"));
  return finish(b, "~/.openclaw/workspace", identityName(join(root, "IDENTITY.md")));
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

/** Everything found, by source. Reads and never writes. */
export function detectSetup(home: string = homedir()): Scan {
  const sources = [claude(home), codex(home), openclaw(home), hermes(home)].filter(
    (s): s is SourceScan => s !== null && (s.items.length > 0 || s.skipped.length > 0),
  );
  const order: ItemKind[] = ["instructions", "memory", "skill", "mcp", "rule", "fact"];
  for (const source of sources) source.items.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
  return { home, sources };
}

// ── what came from where ───────────────────────────────────────────────

export interface RecordEntry {
  digest: string;
  at: number;
  to: Destination;
  botId?: string;
  /** What was made: a skill id, an MCP server id, a rule id or a note id. */
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

/** What the import needs from the rest of Bloks. Passed in, so the rules
 * of the import can be checked without a running workspace. */
export interface ImportDeps {
  agent(id: string): { id: string; name: string; description: string; busy: boolean } | null;
  createAgent(input: { name: string; title: string }): string;
  setInstructions(botId: string, text: string): void;
  /** null when the file is not there; throws when it cannot be read. */
  readMemory(botId: string, file: string): string | null;
  /** Through the memory journal, so it can be undone. */
  writeMemory(botId: string, file: string, before: string | null, after: string): void;
  skills(): Array<{ id: string; source: "builtin" | "user" }>;
  installSkill(input: { id: string; name: string; description: string; body: string }): string;
  mcpServers(): McpEntry[];
  saveMcpServers(list: McpEntry[]): void;
  newId(): string;
  rules(): Rule[];
  addRule(rule: Omit<Rule, "id" | "createdAt">): Rule | null;
  notes(): ProfileNote[];
  suggestNote(text: string, by: { id: string; name: string }): ProfileNote | null;
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
    default:
      return false;
  }
}

export interface ReviewItem {
  key: string;
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
  /** Ticked when the review opens. Rules wait for a person to tick them. */
  picked: boolean;
  skill?: { name: string; description: string };
  mcp?: { name: string; transport: "stdio" | "http"; needs: string[] };
  rule?: { effect: Effect; summary: string };
}

export interface Review {
  sources: Array<{ id: SourceId; name: string; folder: string; agentName: string; items: ReviewItem[]; skipped: Skipped[] }>;
  /** Items that are new or changed: what is worth offering. */
  fresh: number;
}

/** What the window shows: every item with a preview, where it would go,
 * and whether it was brought over before. */
export function reviewOf(scan: Scan, record: ImportRecord, deps: ImportDeps): Review {
  let fresh = 0;
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
      if (status !== "imported") fresh++;
      const usual = item.destinations[0];
      // Where it went last time, while that agent is still here, even if
      // what was added has since been undone: the person chose it once.
      const agentGone = (before?.to === "brief" || before?.to === "memory") && !(before.botId && deps.agent(before.botId));
      const again = before && item.destinations.includes(before.to) && !agentGone ? before : null;
      const to = again?.to ?? usual;
      const suggested = to === "brief" || to === "memory" ? { to, botId: again?.botId ?? "new" } : { to };
      return {
        key: item.key,
        kind: item.kind,
        title: item.title,
        from: item.from,
        preview: item.text.length > PREVIEW_CHARS ? `${item.text.slice(0, PREVIEW_CHARS).trimEnd()}\n…` : item.text,
        chars: item.text.length,
        digest: item.digest,
        notes: item.notes,
        status,
        destinations: item.destinations,
        suggested,
        picked: status !== "imported" && item.kind !== "rule",
        ...(item.skill ? { skill: { name: item.skill.name, description: item.skill.description } } : {}),
        ...(item.mcp
          ? { mcp: { name: item.mcp.name, transport: item.mcp.transport, needs: [...Object.keys(item.mcp.env ?? {}), ...Object.keys(item.mcp.headers ?? {})] } }
          : {}),
        ...(item.rule ? { rule: { effect: item.rule.effect, summary: item.text } } : {}),
      };
    }),
  }));
  return { sources, fresh };
}

export interface Pick {
  key: string;
  digest: string;
  to: Destination;
  /** An agent's id, or "new" for an agent made for this source. */
  botId?: string;
}

export interface ImportResult {
  key: string;
  ok: boolean;
  did?: "added" | "updated" | "unchanged";
  botId?: string;
  error?: string;
}

export interface ImportOutcome {
  results: ImportResult[];
  /** Agents made by this import. */
  created: string[];
  /** What changed, so the caller can tell open windows. */
  touched: { agents: Set<string>; memory: Set<string>; skills: boolean; mcp: boolean; rules: boolean; notes: boolean };
}

const DESTINATIONS = new Set<Destination>(["brief", "memory", "skills", "mcp", "rules", "about"]);

/** What a window may send, checked into shape. Anything else is dropped. */
export function cleanPicks(value: unknown): Pick[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: Pick[] = [];
  for (const raw of value.slice(0, 500)) {
    if (!isRecord(raw)) continue;
    const { key, digest, to, botId } = raw;
    if (typeof key !== "string" || key.length > 400 || seen.has(key)) continue;
    if (typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest)) continue;
    if (typeof to !== "string" || !DESTINATIONS.has(to as Destination)) continue;
    seen.add(key);
    out.push({
      key,
      digest,
      to: to as Destination,
      ...(typeof botId === "string" && /^[\w-]{1,64}$/.test(botId) ? { botId } : {}),
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

/**
 * Applies the ticked items, each on its own: one that cannot be imported
 * says why and the rest still go. Reads nothing from the window but which
 * items and where; the content is the scan's.
 */
export function applyImport(scan: Scan, picks: unknown, deps: ImportDeps, record: ImportRecord, now = Date.now()): ImportOutcome {
  const items = scan.sources.flatMap((s) => s.items);
  const byKey = new Map(items.map((item) => [item.key, item]));
  const sourceOf = new Map(scan.sources.map((s) => [s.id, s]));
  const order = new Map(items.map((item, i) => [item.key, i]));
  const wanted = cleanPicks(picks).sort((a, b) => (order.get(a.key) ?? Infinity) - (order.get(b.key) ?? Infinity));
  const outcome: ImportOutcome = {
    results: [],
    created: [],
    touched: { agents: new Set(), memory: new Set(), skills: false, mcp: false, rules: false, notes: false },
  };
  // one new agent per source per import, whatever number of items go to it
  const fresh = new Map<SourceId, string>();

  const agentFor = (pick: Pick, item: FoundItem): string => {
    if (pick.botId === "new") {
      const made = fresh.get(item.source);
      if (made && deps.agent(made)) return made;
      const source = sourceOf.get(item.source)!;
      const id = deps.createAgent({ name: source.agentName, title: `Brought over from ${source.name}` });
      fresh.set(item.source, id);
      outcome.created.push(id);
      return id;
    }
    if (!pick.botId || !deps.agent(pick.botId)) throw new Error("choose an agent for this, or a new one");
    return pick.botId;
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
          }
          record.set(item.key, { digest: item.digest, at: now, to: "brief", botId, applied: block });
          outcome.results.push({ key: item.key, ok: true, did, botId });
          break;
        }
        case "memory": {
          const botId = agentFor(pick, item);
          const bot = deps.agent(botId)!;
          if (bot.busy) throw new Error(`${bot.name} is working right now. Import this once it has finished.`);
          const file = item.topic ? `memory/${item.topic}` : "MEMORY.md";
          const before = deps.readMemory(botId, file);
          const block = item.topic ? item.text : `## From ${sourceName}: ${item.title}\n\n${item.text}`;
          const previous = last?.to === "memory" && last.botId === botId && last.file === file ? last.applied : undefined;
          const placed = placeBlock(before ?? "", block, previous);
          const after = placed.next.endsWith("\n") ? placed.next : `${placed.next}\n`;
          if (Buffer.byteLength(after, "utf8") > MEMORY_FILE_MAX_BYTES) {
            throw new Error(`${file} would pass 256 KB. Make room in ${bot.name}'s memory first.`);
          }
          if (placed.did !== "unchanged") {
            deps.writeMemory(botId, file, before, after);
            outcome.touched.memory.add(botId);
          }
          record.set(item.key, { digest: item.digest, at: now, to: "memory", botId, file, applied: block });
          outcome.results.push({ key: item.key, ok: true, did: placed.did, botId });
          break;
        }
        case "skills": {
          const skill = item.skill!;
          const library = deps.skills();
          const mine = last?.to === "skills" && last.ref && library.some((s) => s.id === last.ref && s.source === "user") ? last.ref : null;
          let id = mine;
          let did: ImportResult["did"] = mine ? (last!.digest === item.digest ? "unchanged" : "updated") : "added";
          if (!id) {
            // A skill already in the library under that name is somebody's,
            // and an import does not get to write over it.
            const taken = new Set(library.map((s) => s.id));
            const base = slugify(skill.id);
            id = [base, slugify(`${base}-${item.source}`), ...[2, 3, 4, 5].map((n) => slugify(`${base}-${item.source}-${n}`))].find((c) => !taken.has(c)) ?? null;
            if (!id) throw new Error("there are already skills by that name");
          }
          if (did !== "unchanged") {
            deps.installSkill({ id, name: skill.name, description: skill.description, body: skill.body });
            outcome.touched.skills = true;
          }
          record.set(item.key, { digest: item.digest, at: now, to: "skills", ref: id });
          outcome.results.push({ key: item.key, ok: true, did });
          break;
        }
        case "mcp": {
          const mcp = item.mcp!;
          const list = deps.mcpServers();
          const existing = last?.to === "mcp" && last.ref ? list.find((s) => s.id === last.ref) : undefined;
          const others = list.filter((s) => s !== existing);
          let name = mcp.name;
          if (others.some((s) => s.name.toLowerCase() === name.toLowerCase())) name = `${mcp.name} (${sourceName})`.slice(0, 40);
          // keep what the person filled in, for every name still asked for
          const keep = (fresh: Record<string, string> | undefined, had: Record<string, string> | undefined) =>
            fresh ? Object.fromEntries(Object.keys(fresh).map((n) => [n, had?.[n] ?? ""])) : undefined;
          const entry: McpEntry = {
            id: existing?.id ?? deps.newId(),
            name,
            transport: mcp.transport,
            ...(mcp.command !== undefined ? { command: mcp.command } : {}),
            ...(mcp.args ? { args: mcp.args } : {}),
            ...(mcp.url !== undefined ? { url: mcp.url } : {}),
            ...(mcp.env ? { env: keep(mcp.env, existing?.env) } : {}),
            ...(mcp.headers ? { headers: keep(mcp.headers, existing?.headers) } : {}),
          };
          let did: ImportResult["did"];
          if (existing) {
            did = last!.digest === item.digest ? "unchanged" : "updated";
            if (did === "updated") deps.saveMcpServers(list.map((s) => (s === existing ? entry : s)));
          } else {
            if (list.length >= MAX_MCP_SERVERS) {
              throw new Error(`Bloks holds ${MAX_MCP_SERVERS} MCP servers. Remove one under Settings, Apps and keys, then import this.`);
            }
            did = "added";
            deps.saveMcpServers([...list, entry]);
          }
          if (did !== "unchanged") outcome.touched.mcp = true;
          record.set(item.key, { digest: item.digest, at: now, to: "mcp", ref: entry.id });
          outcome.results.push({ key: item.key, ok: true, did });
          break;
        }
        case "rules": {
          const rule = item.rule!;
          const rules = deps.rules();
          let ref = last?.to === "rules" && last.ref && rules.some((r) => r.id === last.ref) ? last.ref : null;
          ref ??=
            rules.find(
              (r) => !r.botId && r.effect === rule.effect && r.field === rule.field && r.op === rule.op && r.value.toLowerCase() === rule.value.toLowerCase(),
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
          }
          record.set(item.key, { digest: item.digest, at: now, to: "rules", ref });
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
          }
          record.set(item.key, { digest: item.digest, at: now, to: "about", ref });
          outcome.results.push({ key: item.key, ok: true, did });
          break;
        }
      }
    } catch (error) {
      outcome.results.push({ key: item.key, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return outcome;
}
