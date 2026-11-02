// Agents' runs, written out as data to train a model on.
//
// A person who has spent months with their agents has something a model
// vendor would pay for: thousands of real asks, each with what the agent
// said, every call it made with what went in and what came back, and how
// it ended. This writes that out, on the person's say, to one file on this
// computer, in the shapes people fine-tune tool-calling models on.
//
// Three places hold a run, and none holds all of it.
//
//   The transcript (messages-<lane>.json) has the person's own words and
//   who said them, how a turn was answered, and what they thought of it:
//   a thumbs up, a Stop, an edit, a Redo. It has a tool's name and its
//   one-line command, never its arguments or what it returned.
//
//   The events file (events/<lane>.ndjson, server/harness/bus.ts) has the
//   turn as it ran: every reply and every call in order, with times, the
//   engine, the model, tokens and the price. The calls carry their
//   display line, not their arguments, and no results at all.
//
//   The native log (native/<lane>.ndjson, server/drivers/native.ts) has
//   each engine's own frames as they arrived. That is the only place a
//   tool's full input and its output exist, and only for the engines that
//   send them: Claude Code's tool_use and tool_result blocks, Codex's
//   items with their output, an ACP agent's raw input and output. An API
//   engine's tool loop runs inside Bloks and is not written there at all.
//
// So a record is the transcript's turn, timed and ordered by its events,
// with each call filled in from the native log where it can be, and every
// record says which of its calls are whole. A file that claimed complete
// tool results for an engine that never sent them would teach a model
// results that were never seen.
//
// What comes out is the person's to share, so it is cleaned on the way:
// anything shaped like a key always (the same scrubber Bring your setup
// uses, with the values this workspace has saved), and on request email
// addresses, phone numbers, the home folder, and the names of the people
// this workspace knows. Cleaning comes before shortening, so a key is
// never cut in two and left half recognisable. Other people's words and
// members' private conversations stay out unless the owner asks for them,
// and agent memory and descriptions too.
//
// Read only, all of it. Nothing here writes to the data folder, so the
// same code runs inside the server and from bloks-server with the app
// stopped.
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { createGunzip } from "node:zlib";

import type { RuntimeEvent } from "./contracts.ts";
import { CREDITS_SPEC } from "./credits.ts";
import { lineSplitter } from "./ndjson.ts";
import { CLI_PROVIDERS, PROVIDER_SPECS } from "./providers.ts";
import { scrubSecrets } from "./setup-import.ts";
import type { BotRecord, Message, TaskRecord } from "./store.ts";
import { buildTrace, slim } from "./trace.ts";

// ── what the person chooses ───────────────────────────────────────────

export type ExportFormat = "openai" | "sharegpt" | "trajectory";
export type ExportUnit = "turn" | "conversation";
export const EXPORT_FORMATS: readonly ExportFormat[] = ["openai", "sharegpt", "trajectory"];

export interface ExportChoice {
  format: ExportFormat;
  /** One record per turn, or one per conversation. */
  unit: ExportUnit;
  /** Agent ids. Null is every agent. */
  agents: string[] | null;
  /** Conversation (lane) ids. Null is every conversation of the agents. */
  conversations: string[] | null;
  /** Epoch milliseconds, either end open. */
  from: number | null;
  to: number | null;
  /** Driver kinds. Null is every engine. */
  engines: string[] | null;
  /** No error, and not stopped. */
  finishedWell: boolean;
  /** Not stopped, steered, edited, redone or given a thumbs down. */
  uncorrected: boolean;
  /** A thumbs up from the person on the turn's reply. */
  thumbsUp: boolean;
  /** Every call's result is in the record. */
  completeResults: boolean;
  /** Estimated tokens, of the record as written. */
  minTokens: number | null;
  maxTokens: number | null;
  privacy: { emails: boolean; phones: boolean; homePaths: boolean; names: boolean };
  include: { memberPrivate: boolean; otherPeople: boolean; systemPrompt: boolean; memory: boolean };
  compression: { toolResultChars: number | null; repeats: boolean; capTokens: number | null };
  /** A `metadata` key beside the OpenAI and ShareGPT shapes: what the
   * record is from and how it was cut. Some trainers refuse a key they do
   * not know, so it can be left out. The trajectory is all metadata. */
  metadata: boolean;
}

/** What a new export starts from: the safe end of every switch. */
export function defaultChoice(): ExportChoice {
  return {
    format: "openai",
    unit: "turn",
    agents: null,
    conversations: null,
    from: null,
    to: null,
    engines: null,
    finishedWell: true,
    uncorrected: false,
    thumbsUp: false,
    completeResults: false,
    minTokens: null,
    maxTokens: null,
    privacy: { emails: true, phones: true, homePaths: true, names: true },
    include: { memberPrivate: false, otherPeople: false, systemPrompt: false, memory: false },
    compression: { toolResultChars: DEFAULT_RESULT_CHARS, repeats: true, capTokens: null },
    metadata: true,
  };
}

/** Where a long result is cut when the person keeps the default. */
export const DEFAULT_RESULT_CHARS = 6_000;
/** Below this a shortened result is mostly the marker saying so. */
export const MIN_RESULT_CHARS = 200;
/** A result read from the native log is held to this before anything
 * else, so one enormous output cannot hold the whole export in memory.
 * Past it, it is shortened the same way and says so. */
export const READ_RESULT_CHARS = 200_000;
/** The preview is for reading, not for scrolling a megabyte. */
export const PREVIEW_CHARS = 60_000;
/** Ids are short and plain; anything else in a list is a mistake. */
const ID = /^[\w.:-]{1,200}$/;
const MAX_LIST = 2_000;
/** Four characters to a token, the rule of thumb server/context.ts uses. */
const CHARS_PER_TOKEN = 4;
/** How far a turn may start ahead of the message that started it: two
 * clocks, the transcript's and the bus's, stamp them a moment apart. */
const SKEW_MS = 2_000;
/** A frame written just after its turn said it was done still belongs
 * to it: Claude Code's result frame races the turn's end. */
const LATE_MS = 5_000;

const bool = (value: unknown, fallback: boolean) => (typeof value === "boolean" ? value : fallback);
function count(value: unknown, { min = 0, max = 10_000_000 } = {}): number | null | undefined {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) return undefined;
  return Math.round(n);
}
function ids(value: unknown): string[] | null | undefined {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value) || value.length > MAX_LIST || !value.every((v) => typeof v === "string" && ID.test(v))) return undefined;
  return [...new Set(value as string[])];
}
/** A day as the person picked it (2026-10-27), or milliseconds. A day
 * that ends a range ends with its last millisecond. */
export function dayOrTime(value: unknown, end = false): number | null | undefined {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : undefined;
  if (typeof value !== "string") return undefined;
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (day) {
    const at = new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3])).getTime();
    if (!Number.isFinite(at)) return undefined;
    return end ? at + 24 * 60 * 60_000 - 1 : at;
  }
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : undefined;
}

/**
 * A choice from a request body or the command line, or what is wrong
 * with it. Anything left out keeps its default, so a script that says
 * only `{ "format": "sharegpt" }` gets the safe export in that shape.
 */
export function readChoice(body: unknown): ExportChoice | string {
  const raw = (body && typeof body === "object" ? body : {}) as Record<string, any>;
  const base = defaultChoice();
  const format = raw.format ?? base.format;
  if (!EXPORT_FORMATS.includes(format)) return "format is openai, sharegpt or trajectory";
  const unit = raw.unit ?? base.unit;
  if (unit !== "turn" && unit !== "conversation") return "unit is turn or conversation";
  const agents = ids(raw.agents);
  if (agents === undefined) return "agents is a list of agent ids";
  const conversations = ids(raw.conversations);
  if (conversations === undefined) return "conversations is a list of conversation ids";
  const engines = ids(raw.engines);
  if (engines === undefined) return "engines is a list of engine kinds";
  const from = dayOrTime(raw.from);
  const to = dayOrTime(raw.to, true);
  if (from === undefined) return "from is a day, like 2026-10-01";
  if (to === undefined) return "to is a day, like 2026-10-31";
  if (from !== null && to !== null && from > to) return "from comes after to";
  const minTokens = count(raw.minTokens);
  const maxTokens = count(raw.maxTokens, { min: 1 });
  if (minTokens === undefined || maxTokens === undefined) return "lengths are whole numbers of tokens";
  if (minTokens !== null && maxTokens !== null && minTokens > maxTokens) return "the shortest is longer than the longest";
  const privacy = (raw.privacy ?? {}) as Record<string, unknown>;
  const include = (raw.include ?? {}) as Record<string, unknown>;
  const compression = (raw.compression ?? {}) as Record<string, unknown>;
  const toolResultChars = "toolResultChars" in compression ? count(compression.toolResultChars, { min: MIN_RESULT_CHARS }) : base.compression.toolResultChars;
  if (toolResultChars === undefined) return `tool results are shortened to ${MIN_RESULT_CHARS} characters or more`;
  const capTokens = count(compression.capTokens, { min: 100 });
  if (capTokens === undefined) return "the cap is 100 tokens or more";
  if (raw.metadata !== undefined && typeof raw.metadata !== "boolean") return "metadata is true or false";
  return {
    format,
    unit,
    agents,
    conversations,
    from,
    to,
    engines,
    finishedWell: bool(raw.finishedWell, base.finishedWell),
    uncorrected: bool(raw.uncorrected, base.uncorrected),
    thumbsUp: bool(raw.thumbsUp, base.thumbsUp),
    completeResults: bool(raw.completeResults, base.completeResults),
    minTokens,
    maxTokens,
    privacy: {
      emails: bool(privacy.emails, true),
      phones: bool(privacy.phones, true),
      homePaths: bool(privacy.homePaths, true),
      names: bool(privacy.names, true),
    },
    include: {
      memberPrivate: bool(include.memberPrivate, false),
      otherPeople: bool(include.otherPeople, false),
      systemPrompt: bool(include.systemPrompt, false),
      memory: bool(include.memory, false),
    },
    compression: { toolResultChars, repeats: bool(compression.repeats, base.compression.repeats), capTokens },
    metadata: bool(raw.metadata, base.metadata),
  };
}

// ── where it reads from ───────────────────────────────────────────────

export interface ExportSource {
  bots: readonly BotRecord[];
  messages(threadId: string): readonly Message[];
  eventsDir: string;
  nativeDir: string;
  /** The people this workspace knows by name: its members and guests,
   * the people let in on Telegram, and the owner. */
  names: readonly string[];
  /** Values saved in this workspace that are keys: taken out wherever
   * they appear, whatever they look like. */
  secrets: readonly string[];
  home: string;
  /** "Owner and admins can read members' private conversations"
   * (server/access.ts). Off, no export reaches them either. */
  privateReadable: boolean;
  /** A member's name, for their conversation's label. */
  personName(personId: string): string | null;
  /** An agent's MEMORY.md. */
  memory(botId: string): string | null;
  /** A settled turn's price when its engine put none on it: the harness's
   * estimate from its tokens. Absent, such a turn has no cost. */
  price?: (completed: Extract<RuntimeEvent, { type: "turn.completed" }>) => number | null;
  /** Lanes with a turn running now, whose last turn is not over. */
  busy?: (threadId: string) => boolean;
}

/** JSON from a file, or the fallback, never a write: readSaved moves a
 * damaged file aside, which a read for an export has no business doing. */
function readJson<T>(file: string, fallback: T, valid: (value: unknown) => boolean): T {
  try {
    const value = JSON.parse(readFileSync(file, "utf8"));
    return valid(value) ? (value as T) : fallback;
  } catch {
    return fallback;
  }
}
const isObject = (v: unknown): v is Record<string, any> => v !== null && typeof v === "object" && !Array.isArray(v);

/** Every value in a config that is a key, for taking out by value. The
 * same fields redactSecrets in server/index.ts knows. */
export function storedSecrets(cfg: Record<string, any>): string[] {
  const values: unknown[] = [
    cfg.xai?.key,
    cfg.composio?.key,
    cfg.composio?.apiKey,
    cfg.box?.token,
    cfg.home?.token,
    ...Object.values(isObject(cfg.providers) ? cfg.providers : {}).map((p: any) => p?.key),
    ...(Array.isArray(cfg.custom) ? cfg.custom : []).flatMap((endpoint: any) => (Array.isArray(endpoint?.keys) ? endpoint.keys.map((k: any) => k?.key) : [])),
    ...Object.values(isObject(cfg.secrets) ? cfg.secrets : {}),
    ...(Array.isArray(cfg.connections) ? cfg.connections : []).map((c: any) => c?.token),
    cfg.credits?.licence,
    cfg.credits?.token,
    cfg.chat?.slack?.botToken,
    cfg.chat?.slack?.appToken,
    cfg.chat?.discord?.token,
    cfg.chat?.whatsapp?.token,
    ...Object.values(isObject(cfg.telegram?.bots) ? cfg.telegram.bots : {}).map((b: any) => b?.token),
  ];
  return [...new Set(values.filter((v): v is string => typeof v === "string" && v.length >= 8))];
}

/** Names from the people file, the Telegram and Signal people and the owner's own. */
export function knownNames(people: unknown, cfg: Record<string, any>): string[] {
  const names: unknown[] = [cfg.profile?.name];
  const list = isObject(people) && Array.isArray(people.people) ? people.people : [];
  for (const person of list) names.push(person?.name);
  for (const bot of Object.values(isObject(cfg.telegram?.bots) ? cfg.telegram.bots : {}) as any[]) {
    for (const person of Object.values(isObject(bot?.people) ? bot.people : {}) as any[]) names.push(person?.name);
  }
  for (const bot of Object.values(isObject(cfg.signal?.bots) ? cfg.signal.bots : {}) as any[]) {
    names.push(bot?.ownerName);
    for (const person of Object.values(isObject(bot?.people) ? bot.people : {}) as any[]) names.push(person?.name);
  }
  return [...new Set(names.filter((n): n is string => typeof n === "string" && n.trim().length >= 2).map((n) => n.trim()))];
}

/** The data folder as files, for bloks-server with the app stopped or
 * running: every store replaces its file whole, so a read beside a
 * running server sees one version or the other. */
export function diskSource(dataDir: string, home: string = homedir()): ExportSource {
  const bots = readJson<BotRecord[]>(join(dataDir, "bots.json"), [], Array.isArray).filter((b) => isObject(b) && typeof b.id === "string");
  for (const bot of bots) {
    if (!Array.isArray(bot.tasks) || !bot.tasks.length) {
      bot.tasks = [{ id: bot.threadId, title: "General", resumeCursors: {}, createdAt: bot.createdAt }];
    }
  }
  const cfg = readJson<Record<string, any>>(join(dataDir, "config.json"), {}, isObject);
  const people = readJson<Record<string, any>>(join(dataDir, "people.json"), {}, isObject);
  const joining = readJson<Record<string, any>>(join(dataDir, "joining.json"), {}, isObject);
  const persons = new Map<string, string>(
    (Array.isArray(people.people) ? people.people : []).filter((p: any) => typeof p?.id === "string").map((p: any) => [p.id, String(p.name ?? "")]),
  );
  return {
    bots,
    messages: (threadId) => (ID.test(threadId) ? readJson<Message[]>(join(dataDir, `messages-${threadId}.json`), [], Array.isArray) : []),
    eventsDir: join(dataDir, "events"),
    nativeDir: join(dataDir, "native"),
    names: knownNames(people, cfg),
    secrets: storedSecrets(cfg),
    home,
    privateReadable: joining.privateReadable === true,
    personName: (id) => persons.get(id) || null,
    memory: (botId) => {
      if (!ID.test(botId)) return null;
      try {
        return readFileSync(join(dataDir, "workspaces", botId, "MEMORY.md"), "utf8");
      } catch {
        return null;
      }
    },
  };
}

// ── engines, and what each one leaves behind ──────────────────────────

/** Whether a record's calls carry what they need: every one, some, none,
 * or there were no calls. */
export type Completeness = "complete" | "partial" | "missing" | "none";

const ENGINE_NAMES = new Map<string, string>([...PROVIDER_SPECS, CREDITS_SPEC, ...CLI_PROVIDERS].map((spec) => [spec.kind, spec.name]));
const ACP_KINDS = new Set(["opencode", "commandcode", "grokCli", "cursor", "cline", "geminiCli", "pi"]);

export function engineName(kind: string): string {
  return ENGINE_NAMES.get(kind) ?? kind;
}

/** What each engine writes down of its calls, as the page says it
 * before anything is read: a promise about the engine, which each
 * record then checks against what it actually found. */
export function engineResults(kind: string): Exclude<Completeness, "none"> {
  if (kind === "claudeAgent") return "complete";
  // commands, file changes and connector calls come back whole; a web
  // search says what it looked for and never what it found
  if (kind === "codex" || ACP_KINDS.has(kind)) return "partial";
  return "missing";
}

// ── a turn as it ran, from the events file ────────────────────────────

/** A step with its own clock, before the record's start is known. */
interface ToolStep {
  type: "tool";
  at: number;
  end: number | null;
  id: string;
  name: string;
  input: unknown;
  /** True once the engine's own arguments were found. */
  inputWhole: boolean;
  output: string | null;
  ok: boolean | null;
  /** Characters the read itself left out (READ_RESULT_CHARS). */
  readCut?: number;
  turn: number;
}
type RawStep =
  | { type: "user"; at: number; text: string; from: string; turn: number }
  | { type: "assistant"; at: number; text: string; turn: number }
  | { type: "model"; at: number; end: number; name: string; tokens?: number; turn: number }
  | ToolStep
  | { type: "wait"; at: number; end: number | null; summary: string; turn: number }
  | { type: "error"; at: number; message: string; turn: number }
  | { type: "compacted"; at: number; turn: number };

interface EngineTurn {
  turnId: string;
  engine: string;
  startedAt: number;
  endedAt: number | null;
  ok: boolean | null;
  stopReason: string | null;
  model: string | null;
  cost: number | null;
  costEstimated: boolean;
  input: number;
  output: number;
  modelCalls: number;
  steps: RawStep[];
  tools: Map<string, ToolStep>;
}

const PER_MESSAGE_USAGE = new Set(["claudeAgent"]);

/** A Codex or API title says the call and its first argument together
 * ("web_fetch: https://..."); the name is the part before. */
function toolName(title: string | undefined): { name: string; detail?: string } {
  const text = (title ?? "").trim() || "tool";
  const split = /^([A-Za-z0-9_.-]{1,64}): (.+)$/.exec(text);
  return split ? { name: split[1], detail: split[2] } : { name: text };
}

/**
 * Every turn in a lane's events file, in order, each with its steps.
 *
 * The whole file, streamed: a turn anybody exports may be a year old,
 * and the events of one turn are its own lines. With a window, turns
 * starting outside it are passed over without being kept.
 */
export async function readEngineTurns(
  file: string,
  { from = null, to = null, price }: { from?: number | null; to?: number | null; price?: ExportSource["price"] } = {},
): Promise<EngineTurn[]> {
  if (!existsSync(file)) return [];
  const turns: EngineTurn[] = [];
  let current: (EngineTurn & { slim: RuntimeEvent[]; perMessage: boolean; high: number; anonymous: number }) | null = null;
  const lo = from === null ? -Infinity : from - 6 * 60 * 60_000;
  const hi = to === null ? Infinity : to + 6 * 60 * 60_000;

  const settle = () => {
    if (!current) return;
    const trace = buildTrace(current.slim, { now: current.endedAt ?? current.startedAt });
    for (const span of trace.spans) {
      if (span.kind !== "model" || span.end === null) continue;
      current.steps.push({
        type: "model",
        at: trace.startedAt + span.start,
        end: trace.startedAt + span.end,
        name: span.name,
        ...(span.tokens ? { tokens: span.tokens } : {}),
        turn: 0,
      });
    }
    current.modelCalls = trace.totals.modelCalls;
    current.steps.sort((a, b) => a.at - b.at);
    const { slim: _slim, perMessage: _p, high: _h, anonymous: _a, ...turn } = current;
    turns.push(turn);
    current = null;
  };

  await new Promise<void>((resolve) => {
    const stream = createReadStream(file);
    const split = lineSplitter((line) => {
      if (!line.trim()) return;
      let event: RuntimeEvent;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (!event || typeof event !== "object" || typeof event.type !== "string") return;
      const t = Date.parse(event.createdAt);
      if (event.type === "turn.started") {
        settle();
        if (!Number.isFinite(t) || t < lo || t > hi) return;
        current = {
          turnId: event.turnId ?? `turn-${t}`,
          engine: event.provider,
          startedAt: t,
          endedAt: null,
          ok: null,
          stopReason: null,
          model: null,
          cost: null,
          costEstimated: false,
          input: 0,
          output: 0,
          modelCalls: 0,
          steps: [],
          tools: new Map(),
          slim: [],
          perMessage: PER_MESSAGE_USAGE.has(event.provider),
          high: 0,
          anonymous: 0,
        };
      }
      const turn = current;
      if (!turn) return;
      // a late word from a turn that is over is not this one's
      if (event.turnId && event.turnId !== turn.turnId) return;
      const kept = slim(event);
      if (kept && turn.slim.length < 20_000) turn.slim.push(kept);
      const at = Number.isFinite(t) ? Math.max(t, turn.startedAt) : turn.startedAt;
      switch (event.type) {
        case "session.started":
          if (typeof event.model === "string" && event.model) turn.model = event.model;
          break;
        case "item.completed":
          if (event.itemType === "assistant_text") {
            if (event.syntheticText || !event.text?.trim()) break;
            turn.steps.push({ type: "assistant", at, text: event.text, turn: 0 });
          } else if (event.itemId) {
            const tool = turn.tools.get(event.itemId);
            if (tool) {
              tool.ok = event.ok;
              tool.end = at;
            }
          }
          break;
        case "item.started": {
          if (event.itemType !== "tool") break;
          const id = event.itemId ?? `call-${turn.anonymous++}`;
          if (turn.tools.has(id)) break;
          const { name, detail } = toolName(event.title);
          const input = event.command !== undefined ? { command: event.command } : event.paths?.length ? { paths: event.paths } : detail ? { detail } : null;
          const tool: ToolStep = { type: "tool", at, end: null, id, name, input, inputWhole: false, output: null, ok: null, turn: 0 };
          turn.tools.set(id, tool);
          turn.steps.push(tool);
          break;
        }
        case "request.opened":
          if (!event.async) turn.steps.push({ type: "wait", at, end: null, summary: event.summary ?? "", turn: 0 });
          break;
        case "request.resolved": {
          const wait = [...turn.steps].reverse().find((s) => s.type === "wait" && s.end === null);
          if (wait && wait.type === "wait") wait.end = at;
          break;
        }
        case "runtime.error":
          turn.steps.push({ type: "error", at, message: event.message ?? "", turn: 0 });
          break;
        case "context.compacted":
          turn.steps.push({ type: "compacted", at, turn: 0 });
          break;
        case "thread.token-usage.updated": {
          const input = Number(event.input) || 0;
          const output = Number(event.output) || 0;
          if (turn.perMessage) {
            turn.input += input;
            turn.output += output;
          } else if (input + output >= turn.high) {
            // a running total for the turn: its highest is the turn's
            turn.high = input + output;
            turn.input = input;
            turn.output = output;
          }
          break;
        }
        case "turn.completed": {
          turn.ok = event.ok;
          turn.stopReason = event.stopReason ?? null;
          turn.endedAt = at;
          turn.model ??= event.unpriced?.model ?? null;
          if (typeof event.cost === "number") turn.cost = event.cost;
          else {
            const estimate = price?.(event) ?? null;
            if (typeof estimate === "number") {
              turn.cost = estimate;
              turn.costEstimated = true;
            }
          }
          for (const tool of turn.tools.values()) if (tool.end === null) tool.end = at;
          for (const step of turn.steps) if (step.type === "wait" && step.end === null) step.end = at;
          settle();
          break;
        }
      }
    });
    stream.on("data", split);
    stream.on("error", () => resolve());
    stream.on("close", () => resolve());
    stream.on("end", () => resolve());
  });
  settle();
  return turns;
}

// ── each call's input and output, from the native log ─────────────────

/** A lane's native files, oldest first: the moved-aside copies, then the
 * live one. */
export function nativeFiles(dir: string, threadId: string): string[] {
  const files: string[] = [];
  try {
    for (const name of readdirSync(join(dir, "archive")).sort()) {
      if (name.startsWith(`${threadId}.`) && (name.endsWith(".ndjson.gz") || name.endsWith(".ndjson"))) files.push(join(dir, "archive", name));
    }
  } catch {}
  const live = join(dir, `${threadId}.ndjson`);
  if (existsSync(live)) files.push(live);
  return files;
}

/** A result as text: blocks of text joined, a picture named. */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block: any) => {
        if (typeof block === "string") return block;
        if (block?.type === "text" && typeof block.text === "string") return block.text;
        if (block?.type === "image") return "[image]";
        if (block?.type === "content") return resultText([block.content]);
        if (block?.type === "diff") return `[diff of ${block.path ?? "a file"}]`;
        return block === null || block === undefined ? "" : JSON.stringify(block);
      })
      .filter(Boolean)
      .join("\n");
  }
  if (content === null || content === undefined) return "";
  return JSON.stringify(content);
}

/** Held to READ_RESULT_CHARS on the way in. */
function held(text: string): { text: string; cut: number } {
  if (text.length <= READ_RESULT_CHARS) return { text, cut: 0 };
  const half = READ_RESULT_CHARS / 2;
  const cut = text.length - READ_RESULT_CHARS;
  return { text: `${text.slice(0, half)}${gapMarker(cut)}${text.slice(-half)}`, cut };
}

interface Found {
  id: string;
  input?: unknown;
  output?: string;
  ok?: boolean;
}

/** The calls one native line says something about, by engine. */
function callsIn(entry: Record<string, any>): Found[] {
  if (entry.dir !== "in") return [];
  const msg = entry.msg;
  if (!isObject(msg)) return [];
  const source = String(entry.source ?? "");
  if (source === "claude.sdk.message") {
    // a sub-agent's own frames are its work inside the parent's call
    if (msg.parent_tool_use_id != null) return [];
    const blocks = Array.isArray(msg.message?.content) ? msg.message.content : [];
    if (msg.type === "assistant") {
      return blocks.filter((b: any) => b?.type === "tool_use" && typeof b.id === "string").map((b: any) => ({ id: b.id, input: b.input ?? {} }));
    }
    if (msg.type === "user") {
      return blocks
        .filter((b: any) => b?.type === "tool_result" && typeof b.tool_use_id === "string")
        .map((b: any) => ({ id: b.tool_use_id, output: resultText(b.content), ok: b.is_error !== true }));
    }
    return [];
  }
  if (source === "codex.app-server") {
    if (msg.method !== "item/started" && msg.method !== "item/completed") return [];
    const item = msg.params?.item;
    if (!isObject(item) || typeof item.id !== "string") return [];
    const done = msg.method === "item/completed";
    switch (item.type) {
      case "commandExecution": {
        const found: Found = { id: item.id, input: { command: item.command, ...(typeof item.cwd === "string" ? { cwd: item.cwd } : {}) } };
        if (done && typeof item.aggregatedOutput === "string") {
          const code = typeof item.exitCode === "number" && item.exitCode !== 0 ? `\n[exit code ${item.exitCode}]` : "";
          found.output = item.aggregatedOutput + code;
        }
        return [found];
      }
      case "fileChange":
        return [{ id: item.id, input: { changes: item.changes ?? [] }, ...(done ? { output: String(item.status ?? "completed") } : {}) }];
      case "mcpToolCall": {
        const found: Found = { id: item.id, input: item.arguments ?? {} };
        if (done) found.output = item.error ? resultText(item.error?.message ?? item.error) : resultText(item.result?.content ?? item.result ?? "");
        return [found];
      }
      case "webSearch":
        return typeof item.query === "string" && item.query ? [{ id: item.id, input: { query: item.query } }] : [];
      default:
        return [];
    }
  }
  if (source.endsWith(".acp")) {
    if (msg.method !== "session/update") return [];
    const update = msg.params?.update;
    if (!isObject(update) || update.toolCallId === undefined) return [];
    const id = String(update.toolCallId);
    const found: Found = { id };
    if (update.rawInput !== undefined) found.input = update.rawInput;
    if (update.sessionUpdate === "tool_call_update" && (update.status === "completed" || update.status === "failed")) {
      found.output = update.rawOutput !== undefined ? resultText(update.rawOutput) : resultText(update.content ?? "");
      found.ok = update.status === "completed";
    }
    return found.input === undefined && found.output === undefined ? [] : [found];
  }
  return [];
}

/** Only lines that can name a call are parsed. */
const MAY_HOLD = ['"tool_use"', '"tool_result"', '"item/started"', '"item/completed"', '"tool_call'];

/**
 * Fills each turn's calls in from the lane's native log: the engine's
 * own arguments, and what came back. A line goes to the turn running
 * when it was written, and only to a call that turn made, so an id an
 * engine reuses in a later turn is never mixed up with this one.
 */
export async function fillFromNative(files: readonly string[], turns: readonly EngineTurn[]): Promise<void> {
  if (!turns.length || !files.length) return;
  const starts = turns.map((t) => t.startedAt);
  const turnAt = (at: number): EngineTurn | null => {
    // the latest turn to start by then
    let lo = 0;
    let hi = starts.length - 1;
    let best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (starts[mid] <= at + 1_000) {
        best = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    if (best < 0) return null;
    const turn = turns[best];
    return turn.endedAt === null || at <= turn.endedAt + LATE_MS ? turn : null;
  };
  const first = starts[0] - 60_000;
  const last = turns.reduce((n, t) => Math.max(n, t.endedAt ?? Infinity), -Infinity) + LATE_MS;
  for (const file of files) {
    await new Promise<void>((resolve) => {
      let stream: NodeJS.ReadableStream;
      try {
        const raw = createReadStream(file);
        raw.on("error", () => resolve());
        stream = file.endsWith(".gz") ? raw.pipe(createGunzip()) : raw;
      } catch {
        return resolve();
      }
      const split = lineSplitter((line) => {
        if (!MAY_HOLD.some((mark) => line.includes(mark))) return;
        // written as {"at":"<iso>", ... }, so the time is read before the line is
        const quick = /^\{"at":"([^"]+)"/.exec(line);
        const stamped = quick ? Date.parse(quick[1]) : Number.NaN;
        if (Number.isFinite(stamped) && (stamped < first || stamped > last)) return;
        let entry: Record<string, any>;
        try {
          entry = JSON.parse(line);
        } catch {
          return;
        }
        const at = Date.parse(entry.at);
        if (!Number.isFinite(at)) return;
        const turn = turnAt(at);
        if (!turn) return;
        for (const found of callsIn(entry)) {
          const tool = turn.tools.get(found.id);
          if (!tool) continue;
          if (found.input !== undefined) {
            tool.input = found.input;
            tool.inputWhole = true;
          }
          if (found.output !== undefined) {
            const kept = held(found.output);
            tool.output = kept.text;
            if (kept.cut) tool.readCut = kept.cut;
            if (found.ok !== undefined && tool.ok === null) tool.ok = found.ok;
          }
        }
      });
      stream.on("data", split);
      stream.on("error", () => resolve());
      stream.on("end", () => resolve());
      stream.on("close", () => resolve());
    });
  }
}

// ── the transcript's turns ────────────────────────────────────────────

const OWNER_EMOJI_UP = /^\u{1F44D}[\u{1F3FB}-\u{1F3FF}]?$/u;
const OWNER_EMOJI_DOWN = /^\u{1F44E}[\u{1F3FB}-\u{1F3FF}]?$/u;
/** Where someone other than the owner speaks from. */
const OTHERS_VIA = new Set(["email", "whatsapp", "slack", "discord"]);

/** Said to the agent and part of the conversation. */
const said = (m: Message) => m.role === "user" && m.kind === "text" && !m.queued && !m.unsent;
/** The owner's own words, typed here or from their own Telegram or Signal. */
const ownWords = (m: Message) => said(m) && !m.agent && !m.via && !othersWords(m);
function othersWords(m: Message): boolean {
  if (m.role !== "user") return false;
  if (m.author && m.author !== "owner") return true;
  if (m.telegramPerson || m.telegramDelegate) return true;
  // a person the owner let in on Signal; the owner's own Signal has no personId
  if (m.fromSignal?.personId) return true;
  return Boolean(m.via && OTHERS_VIA.has(m.via));
}
/** Who said a message that opened or joined a turn, as a record says it. */
function speaker(m: Message): string {
  if (m.agent) return `agent:${m.agent.peerName}`;
  if (m.author && m.author !== "owner") return "member";
  if (m.telegramPerson || m.telegramDelegate) return "telegram";
  if (m.fromSignal?.personId) return "signal";
  if (m.via) return m.via;
  return "owner";
}

export interface AskTurn {
  laneId: string;
  /** When it started: its first message. */
  at: number;
  /** The messages that opened it, said together. */
  opened: Message[];
  /** Everything up to the next turn, the opening messages included. */
  messages: Message[];
  rewound: boolean;
  takenBack: boolean;
  others: boolean;
  /** Stopped, steered, edited, or given a thumbs down by the owner. */
  corrected: boolean;
  thumbsUp: boolean;
  engineTurns: EngineTurn[];
}

/**
 * A transcript as turns, the way server/redo.ts reads one: a turn starts
 * with something said to the agent that did not join a turn already
 * running, or with a burst that waited and went together (one
 * `deliveredAt`), and runs to the next.
 */
export function transcriptTurns(laneId: string, messages: readonly Message[]): AskTurn[] {
  const turns: AskTurn[] = [];
  let open: AskTurn | null = null;
  for (const m of messages) {
    const opens = said(m) && !m.midTurn;
    // still the burst: nothing but its own messages since it opened, and
    // delivered in the same moment
    const burst =
      opens && open !== null && m.deliveredAt !== undefined && open.messages.at(-1) === open.opened.at(-1) && open.opened.at(-1)?.deliveredAt === m.deliveredAt;
    if (opens && !burst) {
      open = { laneId, at: m.at, opened: [m], messages: [m], rewound: false, takenBack: false, others: false, corrected: false, thumbsUp: false, engineTurns: [] };
      turns.push(open);
      continue;
    }
    if (!open) continue;
    if (burst) open.opened.push(m);
    open.messages.push(m);
  }
  for (const turn of turns) {
    turn.rewound = turn.opened.some((m) => m.rewound);
    turn.takenBack = !turn.rewound && turn.opened.some((m) => m.deleted);
    turn.others = turn.messages.some((m) => said(m) && othersWords(m));
    const steered = turn.messages.some((m) => m.midTurn && said(m) && ownWords(m));
    const edited = turn.opened.some((m) => m.editedAt !== undefined);
    const reacted = (pattern: RegExp) =>
      turn.messages.some((m) => m.role === "bot" && Object.entries(m.reactions ?? {}).some(([emoji, who]) => pattern.test(emoji) && who.includes("user")));
    turn.thumbsUp = reacted(OWNER_EMOJI_UP);
    turn.corrected = steered || edited || reacted(OWNER_EMOJI_DOWN);
  }
  return turns;
}

/** Each engine turn onto the transcript turn it answered: the latest to
 * start by the time it did. One started by Bloks itself to go on (a
 * retry, a backup engine, a pickup after a restart) has no message of
 * its own, so it joins the one before, which is what it was. */
function attach(asks: AskTurn[], engineTurns: readonly EngineTurn[]) {
  let i = 0;
  for (const turn of engineTurns) {
    while (i + 1 < asks.length && asks[i + 1].at <= turn.startedAt + SKEW_MS) i++;
    if (asks[i] && asks[i].at <= turn.startedAt + SKEW_MS) asks[i].engineTurns.push(turn);
  }
}

// ── one record, before it is cleaned and shaped ───────────────────────

export type TrajectoryStep =
  | { type: "user"; at: number; text: string; from: string }
  | { type: "assistant"; at: number; text: string }
  | { type: "model"; at: number; ms: number; name: string; tokens?: number }
  | {
      type: "tool";
      at: number;
      ms: number | null;
      id: string;
      name: string;
      input: unknown;
      inputComplete: boolean;
      output: string | null;
      ok: boolean | null;
      note?: string;
    }
  | { type: "wait"; at: number; ms: number | null; summary: string }
  | { type: "error"; at: number; message: string }
  | { type: "compacted"; at: number };

export interface Removed {
  secrets: number;
  emails: number;
  phones: number;
  homePaths: number;
  names: number;
}
const noneRemoved = (): Removed => ({ secrets: 0, emails: 0, phones: 0, homePaths: 0, names: 0 });

export interface TrajectoryRecord {
  format: "bloks.trajectory";
  version: 1;
  id: string;
  unit: ExportUnit;
  agent: { id: string; name: string };
  conversation: { id: string; title: string; kind: "own" | "team" | "member" };
  engine: { kind: string; name: string; model: string | null };
  /** A conversation that ran on more than one engine says each. */
  engines?: Array<{ kind: string; name: string; model: string | null; turns: number }>;
  startedAt: string;
  endedAt: string | null;
  durationMs: number;
  outcome: { status: "ok" | "failed" | "stopped" | "unknown"; stopReason: string | null };
  feedback: { thumbsUp: boolean; corrected: boolean };
  usage: { inputTokens: number | null; outputTokens: number | null; cost: number | null; costEstimated: boolean; modelCalls: number; toolCalls: number };
  toolInputs: Completeness;
  toolResults: Completeness;
  /** In a conversation record: the turns in it, and the ones left out of
   * it by the choice (each still counted in the summary). */
  turns?: number;
  turnsLeftOut?: number;
  /** Where each turn of a conversation record starts in its steps, for
   * the cap to drop whole turns by. Never written out. */
  turnStarts?: number[];
  system: string | null;
  steps: TrajectoryStep[];
  removed: Removed;
  compression: { rule: string | null; shortened: number; repeats: number; capped: boolean; droppedTurns: number };
}

type Status = TrajectoryRecord["outcome"]["status"];
function statusOf(ask: AskTurn, busy: boolean): Status | "running" {
  const last = ask.engineTurns.at(-1);
  if (!last) return "unknown";
  if (last.endedAt === null) return busy ? "running" : "unknown";
  if (last.ok) return "ok";
  return last.stopReason === "interrupted" ? "stopped" : "failed";
}

function completeness(flags: boolean[]): Completeness {
  if (!flags.length) return "none";
  const whole = flags.filter(Boolean).length;
  return whole === flags.length ? "complete" : whole === 0 ? "missing" : "partial";
}

interface Built {
  record: TrajectoryRecord;
  /** The steps with absolute times, kept for joining a conversation. */
  raw: RawStep[];
  start: number;
  end: number | null;
  status: Status;
}

/** The turn's steps on one clock, the person's words included. */
function stepsOf(ask: AskTurn, index: number): RawStep[] {
  const steps: RawStep[] = [];
  for (const m of ask.messages) {
    if (!said(m) || m.deleted || !m.text) continue;
    steps.push({ type: "user", at: m.at, text: m.text, from: speaker(m), turn: index });
  }
  if (ask.engineTurns.length) {
    for (const turn of ask.engineTurns) for (const step of turn.steps) steps.push({ ...step, turn: index } as RawStep);
  } else {
    // No events for this turn (older than the events file, or it lost
    // them): what the transcript says, with every call marked as missing.
    let n = 0;
    for (const m of ask.messages) {
      if (m.role !== "bot" || m.deleted) continue;
      if (m.kind === "text" && m.text) steps.push({ type: "assistant", at: m.at, text: m.text, turn: index });
      if (m.kind === "activity" && m.tool) {
        const { name } = toolName(m.tool.name);
        steps.push({
          type: "tool",
          at: m.at,
          end: null,
          id: `${m.id}-${n++}`,
          name,
          input: m.tool.command ? { command: m.tool.command } : null,
          inputWhole: false,
          output: null,
          ok: m.tool.ok ?? null,
          turn: index,
        });
      }
    }
  }
  // the person's words before what answered them, at the same moment
  const rank = (s: RawStep) => (s.type === "user" ? 0 : 1);
  return steps.sort((a, b) => a.at - b.at || rank(a) - rank(b));
}

function relative(steps: readonly RawStep[], start: number): TrajectoryStep[] {
  return steps.map((s): TrajectoryStep => {
    const at = Math.max(0, s.at - start);
    switch (s.type) {
      case "user":
        return { type: "user", at, text: s.text, from: s.from };
      case "assistant":
        return { type: "assistant", at, text: s.text };
      case "model":
        return { type: "model", at, ms: Math.max(0, s.end - s.at), name: s.name, ...(s.tokens ? { tokens: s.tokens } : {}) };
      case "tool":
        return {
          type: "tool",
          at,
          ms: s.end === null ? null : Math.max(0, s.end - s.at),
          id: s.id,
          name: s.name,
          input: s.input,
          inputComplete: s.inputWhole,
          output: s.output,
          ok: s.ok,
          ...(s.readCut ? { note: `${s.readCut.toLocaleString("en-US")} characters were left out of the middle when it was read` } : {}),
        };
      case "wait":
        return { type: "wait", at, ms: s.end === null ? null : Math.max(0, s.end - s.at), summary: s.summary };
      case "error":
        return { type: "error", at, message: s.message };
      case "compacted":
        return { type: "compacted", at };
    }
  });
}

function laneKind(task: TaskRecord): TrajectoryRecord["conversation"]["kind"] {
  return task.personId ? "member" : task.team ? "team" : "own";
}

function build(bot: BotRecord, task: TaskRecord, title: string, ask: AskTurn, index: number, status: Status, system: string | null): Built {
  const raw = stepsOf(ask, index);
  const start = ask.at;
  const last = ask.engineTurns.at(-1);
  const ends = ask.engineTurns.map((t) => t.endedAt).filter((t): t is number => t !== null);
  const end = ends.length ? Math.max(...ends) : last ? null : (ask.messages.at(-1)?.at ?? ask.at);
  const engine = last?.engine ?? "unknown";
  const model = [...ask.engineTurns].reverse().find((t) => t.model)?.model ?? null;
  const tools = raw.filter((s): s is ToolStep => s.type === "tool");
  const costs = ask.engineTurns.map((t) => t.cost).filter((c): c is number => c !== null);
  const usage = {
    inputTokens: ask.engineTurns.length ? ask.engineTurns.reduce((n, t) => n + t.input, 0) : null,
    outputTokens: ask.engineTurns.length ? ask.engineTurns.reduce((n, t) => n + t.output, 0) : null,
    cost: costs.length ? costs.reduce((a, b) => a + b, 0) : null,
    costEstimated: ask.engineTurns.some((t) => t.costEstimated),
    modelCalls: ask.engineTurns.reduce((n, t) => n + t.modelCalls, 0),
    toolCalls: tools.length,
  };
  const record: TrajectoryRecord = {
    format: "bloks.trajectory",
    version: 1,
    id: `${task.id}:${last?.turnId ?? ask.opened[0].id}`,
    unit: "turn",
    agent: { id: bot.id, name: bot.name },
    conversation: { id: task.id, title, kind: laneKind(task) },
    engine: { kind: engine, name: engine === "unknown" ? "Not recorded" : engineName(engine), model },
    startedAt: new Date(start).toISOString(),
    endedAt: end === null ? null : new Date(end).toISOString(),
    durationMs: end === null ? 0 : Math.max(0, end - start),
    outcome: { status, stopReason: last?.stopReason ?? null },
    feedback: { thumbsUp: ask.thumbsUp, corrected: ask.corrected || status === "stopped" },
    usage,
    toolInputs: completeness(tools.map((t) => t.inputWhole)),
    toolResults: completeness(tools.map((t) => t.output !== null)),
    system,
    steps: relative(raw, start),
    removed: noneRemoved(),
    compression: { rule: null, shortened: 0, repeats: 0, capped: false, droppedTurns: 0 },
  };
  return { record, raw, start, end, status };
}

/** A conversation's kept turns as one record, on the first one's clock. */
function joinTurns(built: readonly Built[], leftOut: number): TrajectoryRecord {
  const first = built[0].record;
  const start = built[0].start;
  const raw = built.flatMap((b) => b.raw);
  const tools = raw.filter((s): s is ToolStep => s.type === "tool");
  const ends = built.map((b) => b.end).filter((t): t is number => t !== null);
  const end = ends.length ? Math.max(...ends) : null;
  const sum = (pick: (r: TrajectoryRecord) => number | null) => {
    const values = built.map((b) => pick(b.record)).filter((v): v is number => v !== null);
    return values.length ? values.reduce((a, b) => a + b, 0) : null;
  };
  const engines = new Map<string, { kind: string; name: string; model: string | null; turns: number }>();
  for (const b of built) {
    const key = `${b.record.engine.kind}\0${b.record.engine.model ?? ""}`;
    const seen = engines.get(key) ?? { ...b.record.engine, turns: 0 };
    seen.turns++;
    engines.set(key, seen);
  }
  const lastRecord = built.at(-1)!.record;
  return {
    ...first,
    id: `${first.conversation.id}:conversation`,
    unit: "conversation",
    engine: lastRecord.engine,
    ...(engines.size > 1 ? { engines: [...engines.values()] } : {}),
    endedAt: end === null ? null : new Date(end).toISOString(),
    durationMs: end === null ? 0 : Math.max(0, end - start),
    outcome: lastRecord.outcome,
    feedback: { thumbsUp: built.some((b) => b.record.feedback.thumbsUp), corrected: built.some((b) => b.record.feedback.corrected) },
    usage: {
      inputTokens: sum((r) => r.usage.inputTokens),
      outputTokens: sum((r) => r.usage.outputTokens),
      cost: sum((r) => r.usage.cost),
      costEstimated: built.some((b) => b.record.usage.costEstimated),
      modelCalls: built.reduce((n, b) => n + b.record.usage.modelCalls, 0),
      toolCalls: tools.length,
    },
    toolInputs: completeness(tools.map((t) => t.inputWhole)),
    toolResults: completeness(tools.map((t) => t.output !== null)),
    turns: built.length,
    turnsLeftOut: leftOut,
    turnStarts: raw.flatMap((s, i) => (i === 0 || raw[i - 1].turn !== s.turn ? [i] : [])),
    steps: relative(raw, start),
  };
}

// ── taking things out ─────────────────────────────────────────────────

const REMOVED = "[removed]";
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
/** Something written as a phone number: a + and digits, a number with an
 * area code in brackets, or three groups of digits. Checked for its
 * digits after, so a date or a version is left alone. */
const PHONE = /(?<![\w+])(?:\+\d[\d ().-]{6,}\d|\(\d{2,5}\)[ .-]?\d[\d .-]{4,}\d|\d{3}[ .-]\d{3}[ .-]\d{4})(?![\w])/g;
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Cleans text, counting what it takes out. Secrets always; the rest as
 * the person chose. One per export, so the counts add up across it, and
 * one per record for the record's own line.
 */
export class Scrubber {
  readonly removed: Removed = noneRemoved();
  private readonly secrets: string[];
  private readonly home: string | null;
  private readonly fullNames: RegExp | null;
  private readonly firstNames: RegExp | null;
  private readonly privacy: ExportChoice["privacy"];

  constructor(privacy: ExportChoice["privacy"], { secrets, home, names }: { secrets: readonly string[]; home: string; names: readonly string[] }) {
    this.privacy = privacy;
    // the longest first, so one key inside another is taken whole
    this.secrets = [...secrets].filter((s) => s.length >= 8).sort((a, b) => b.length - a.length);
    this.home = privacy.homePaths && home && home !== sep && home.length > 1 ? home.replace(/[\\/]+$/, "") : null;
    const whole = privacy.names ? [...new Set(names)].filter((n) => n.length >= 2).sort((a, b) => b.length - a.length) : [];
    // A name is taken out whole wherever it is, in any case. Its first
    // word alone too, as it is written, capitalised: "Sam" is somebody,
    // "sam" in a path or a command is more likely not.
    const firsts = [...new Set(whole.map((n) => n.split(/\s+/)[0]).filter((n) => n.length >= 3 && /^\p{Lu}/u.test(n)))];
    const bounded = (list: string[], flags: string) =>
      list.length ? new RegExp(`(?<![\\p{L}\\p{N}_])(?:${list.map(escape).join("|")})(?![\\p{L}\\p{N}_])`, flags) : null;
    this.fullNames = bounded(whole, "giu");
    this.firstNames = bounded(firsts, "gu");
  }

  /** A string, cleaned. */
  text(input: string): string {
    if (!input) return input;
    let text = input;
    for (const secret of this.secrets) {
      if (!text.includes(secret)) continue;
      const parts = text.split(secret);
      this.removed.secrets += parts.length - 1;
      text = parts.join(REMOVED);
    }
    const scrubbed = scrubSecrets(text);
    this.removed.secrets += scrubbed.removed;
    text = scrubbed.text;
    if (this.home) {
      // the folder itself, written either way round on Windows
      for (const spelling of new Set([this.home, this.home.replace(/\\/g, "/")])) {
        const pattern = new RegExp(`${escape(spelling)}(?=$|[\\\\/\\s"'\`),;:])`, "g");
        text = text.replace(pattern, () => {
          this.removed.homePaths++;
          return "~";
        });
      }
    }
    if (this.privacy.emails) {
      text = text.replace(EMAIL, () => {
        this.removed.emails++;
        return "[email]";
      });
    }
    if (this.privacy.phones) {
      text = text.replace(PHONE, (match) => {
        const digits = match.replace(/\D/g, "");
        // a date, a time or a version is not a phone number
        if (digits.length < 9 || digits.length > 15 || /^\d{4}[-./]\d{2}[-./]\d{2}/.test(match)) return match;
        this.removed.phones++;
        return "[phone]";
      });
    }
    for (const pattern of [this.fullNames, this.firstNames]) {
      if (!pattern) continue;
      text = text.replace(pattern, () => {
        this.removed.names++;
        return "[person]";
      });
    }
    return text;
  }

  /** Every string in a value, keys left as they are. */
  value(input: unknown): unknown {
    if (typeof input === "string") return this.text(input);
    if (Array.isArray(input)) return input.map((v) => this.value(v));
    if (isObject(input)) return Object.fromEntries(Object.entries(input).map(([k, v]) => [k, this.value(v)]));
    return input;
  }
}

/** A record with everything in it cleaned, and what came out said on it. */
function scrubRecord(record: TrajectoryRecord, make: () => Scrubber): TrajectoryRecord {
  const scrub = make();
  const steps = record.steps.map((step): TrajectoryStep => {
    switch (step.type) {
      case "user":
      case "assistant":
        return { ...step, text: scrub.text(step.text) };
      case "tool":
        return { ...step, input: scrub.value(step.input), output: step.output === null ? null : scrub.text(step.output) };
      case "wait":
        return { ...step, summary: scrub.text(step.summary) };
      case "error":
        return { ...step, message: scrub.text(step.message) };
      default:
        return step;
    }
  });
  return {
    ...record,
    agent: { ...record.agent, name: record.agent.name },
    conversation: { ...record.conversation, title: scrub.text(record.conversation.title) },
    system: record.system === null ? null : scrub.text(record.system),
    steps,
    removed: scrub.removed,
  };
}

// ── shortening long runs ──────────────────────────────────────────────

const gapMarker = (cut: number) => `\n\n[... ${cut.toLocaleString("en-US")} characters left out ...]\n\n`;

/** Head and tail of a text, with a marked gap, to `keep` characters. */
export function shorten(text: string, keep: number): string {
  if (text.length <= keep) return text;
  const head = Math.ceil(keep / 2);
  const tail = Math.floor(keep / 2);
  return `${text.slice(0, head)}${gapMarker(text.length - head - tail)}${text.slice(text.length - tail)}`;
}

/** What a record holds that a model would read: words, arguments and
 * results. */
export function recordChars(record: Pick<TrajectoryRecord, "steps" | "system">): number {
  let n = record.system?.length ?? 0;
  for (const step of record.steps) {
    if (step.type === "user" || step.type === "assistant") n += step.text.length;
    else if (step.type === "tool") n += step.name.length + (step.input === null ? 0 : JSON.stringify(step.input).length) + (step.output?.length ?? 0);
  }
  return n;
}
export const recordTokens = (record: Pick<TrajectoryRecord, "steps" | "system">) => Math.ceil(recordChars(record) / CHARS_PER_TOKEN);

/** The rule a record was shortened by, in words, for its own metadata. */
export function compressionRule(compression: ExportChoice["compression"]): string | null {
  const parts: string[] = [];
  if (compression.toolResultChars !== null) {
    parts.push(
      `Tool results longer than ${compression.toolResultChars.toLocaleString("en-US")} characters keep their first and last ${Math.floor(compression.toolResultChars / 2).toLocaleString("en-US")}, with the gap marked.`,
    );
  }
  if (compression.repeats) parts.push("A call with the same tool, input and result as an earlier one in the record keeps the call and points at the earlier result.");
  if (compression.capTokens !== null) {
    parts.push(
      `Records over ${compression.capTokens.toLocaleString("en-US")} tokens (four characters each) have their longest results shortened further, then lose their earliest turns, and are left out if neither is enough.`,
    );
  }
  return parts.length ? parts.join(" ") : null;
}

/**
 * Shortens a record as the person chose. Null when it is still over the
 * cap with nothing left to shorten, which leaves it out.
 */
function compress(record: TrajectoryRecord, compression: ExportChoice["compression"]): TrajectoryRecord | null {
  const steps = record.steps.map((s) => ({ ...s })) as TrajectoryStep[];
  const notes = { shortened: 0, repeats: 0, capped: false, droppedTurns: 0 };
  const tools = () => steps.filter((s): s is Extract<TrajectoryStep, { type: "tool" }> => s.type === "tool");
  // the result as read, so shortening twice never shortens a marker
  const whole = new Map<Extract<TrajectoryStep, { type: "tool" }>, string>();
  if (compression.repeats) {
    const seen = new Map<string, string>();
    for (const tool of tools()) {
      if (tool.output === null) continue;
      const key = `${tool.name}\0${JSON.stringify(tool.input)}\0${tool.output}`;
      const earlier = seen.get(key);
      if (earlier === undefined) {
        seen.set(key, tool.id);
        continue;
      }
      tool.output = `[Same result as call ${earlier}, left out]`;
      tool.note = `same input and result as call ${earlier}`;
      notes.repeats++;
    }
  }
  if (compression.toolResultChars !== null) {
    for (const tool of tools()) {
      if (tool.output === null || tool.output.length <= compression.toolResultChars) continue;
      whole.set(tool, tool.output);
      tool.output = shorten(tool.output, compression.toolResultChars);
      tool.note = `shortened from ${(whole.get(tool) ?? "").length.toLocaleString("en-US")} characters`;
      notes.shortened++;
    }
  }
  let shaped: TrajectoryRecord = { ...record, steps };
  const cap = compression.capTokens;
  if (cap !== null && recordTokens(shaped) > cap) {
    notes.capped = true;
    // the longest result first, halved, until it fits or nothing is long
    for (;;) {
      if (recordTokens(shaped) <= cap) break;
      const longest = tools()
        .filter((t) => t.output !== null && t.output.length > MIN_RESULT_CHARS * 2)
        .sort((a, b) => b.output!.length - a.output!.length)[0];
      if (!longest) break;
      const original = whole.get(longest) ?? longest.output!;
      if (!whole.has(longest)) {
        whole.set(longest, original);
        notes.shortened++;
      }
      longest.output = shorten(original, Math.max(MIN_RESULT_CHARS, Math.floor(longest.output!.length / 2)));
      longest.note = `shortened from ${original.length.toLocaleString("en-US")} characters`;
    }
    // a conversation then loses its earliest turns, whole
    if (recordTokens(shaped) > cap && record.unit === "conversation" && record.turnStarts && record.turnStarts.length > 1) {
      const marks = record.turnStarts;
      let k = 1;
      while (k < marks.length - 1 && recordTokens({ ...shaped, steps: steps.slice(marks[k]) }) > cap) k++;
      const kept = steps.slice(marks[k]);
      const shift = kept[0]?.at ?? 0;
      notes.droppedTurns = k;
      shaped = { ...shaped, turns: (record.turns ?? marks.length) - k, steps: kept.map((s) => ({ ...s, at: s.at - shift })) };
    }
    if (recordTokens(shaped) > cap) return null;
  }
  const { turnStarts: _starts, ...written } = shaped;
  return {
    ...written,
    compression: { rule: compressionRule(compression), ...notes },
  };
}

// ── the shapes it is written in ───────────────────────────────────────

/** OpenAI wants function names of letters, digits, _ and -, up to 64. */
export function functionName(name: string): string {
  const clean = name.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 64);
  return clean || "tool";
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
function typeOf(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value === "object" ? "object" : typeof value;
}

/**
 * The tools a record's calls used, as function definitions. Bloks never
 * sees an engine's own definitions, so each is read off the calls made
 * with it, and says so: a property is required when every call gave it.
 */
export function inferTools(steps: readonly TrajectoryStep[]): Array<{ type: "function"; function: { name: string; description: string; parameters: Json } }> {
  const byName = new Map<string, { calls: number; props: Map<string, { types: Set<string>; seen: number }> }>();
  for (const step of steps) {
    if (step.type !== "tool") continue;
    const name = functionName(step.name);
    const tool = byName.get(name) ?? { calls: 0, props: new Map() };
    tool.calls++;
    if (isObject(step.input)) {
      for (const [key, value] of Object.entries(step.input)) {
        const prop = tool.props.get(key) ?? { types: new Set<string>(), seen: 0 };
        prop.types.add(typeOf(value));
        prop.seen++;
        tool.props.set(key, prop);
      }
    }
    byName.set(name, tool);
  }
  return [...byName.entries()].map(([name, tool]) => {
    const properties: Record<string, Json> = {};
    for (const [key, prop] of tool.props) {
      const types = [...prop.types].filter((t) => t !== "null");
      properties[key] = types.length === 1 ? { type: types[0] } : types.length ? { type: types } : {};
    }
    const required = [...tool.props.entries()].filter(([, p]) => p.seen === tool.calls).map(([k]) => k);
    return {
      type: "function" as const,
      function: {
        name,
        description: "Read off the calls in this record. Bloks does not keep the engine's own tool definitions.",
        parameters: { type: "object", properties, ...(required.length ? { required } : {}) },
      },
    };
  });
}

/** What a call without a recorded result says in its place. */
const NOT_RECORDED = "[The result of this call was not recorded by this engine.]";

/** The record's facts, beside the training data, in every shape. */
function metadataOf(record: TrajectoryRecord) {
  return {
    source: "Bloks",
    id: record.id,
    unit: record.unit,
    agent: record.agent.name,
    conversation: record.conversation.title,
    conversationKind: record.conversation.kind,
    engine: record.engine.kind,
    engineName: record.engine.name,
    model: record.engine.model,
    ...(record.engines ? { engines: record.engines } : {}),
    startedAt: record.startedAt,
    durationMs: record.durationMs,
    outcome: record.outcome.status,
    thumbsUp: record.feedback.thumbsUp,
    corrected: record.feedback.corrected,
    inputTokens: record.usage.inputTokens,
    outputTokens: record.usage.outputTokens,
    cost: record.usage.cost,
    costEstimated: record.usage.costEstimated,
    toolInputs: record.toolInputs,
    toolResults: record.toolResults,
    ...(record.turns !== undefined ? { turns: record.turns, turnsLeftOut: record.turnsLeftOut ?? 0 } : {}),
    removed: record.removed,
    compression: record.compression,
  };
}

/** The steps a model is trained on, grouped into what each message of a
 * chat would hold: calls made together share one assistant message. */
interface ChatGroup {
  user?: string;
  text?: string;
  calls?: Array<Extract<TrajectoryStep, { type: "tool" }>>;
}
function chatGroups(steps: readonly TrajectoryStep[]): ChatGroup[] {
  const groups: ChatGroup[] = [];
  let calls: Array<Extract<TrajectoryStep, { type: "tool" }>> | null = null;
  let firstEnd = Infinity;
  for (const step of steps) {
    if (step.type === "user") {
      calls = null;
      groups.push({ user: step.text });
    } else if (step.type === "assistant") {
      calls = null;
      groups.push({ text: step.text });
    } else if (step.type === "tool") {
      // A call started before any of the group's had come back was made
      // in the same breath; one after, the model had seen a result first.
      if (calls && step.at <= firstEnd) {
        calls.push(step);
        if (step.ms !== null) firstEnd = Math.min(firstEnd, step.at + step.ms);
        continue;
      }
      const last = groups.at(-1);
      calls = [step];
      firstEnd = step.ms === null ? Infinity : step.at + step.ms;
      // the words just before a call are the message that made it
      if (last && last.text !== undefined && !last.calls) last.calls = calls;
      else groups.push({ calls });
    }
  }
  return groups;
}

const argumentsOf = (input: unknown) => JSON.stringify(input ?? {});

export function toOpenAI(record: TrajectoryRecord) {
  const messages: Array<Record<string, unknown>> = [];
  if (record.system) messages.push({ role: "system", content: record.system });
  for (const group of chatGroups(record.steps)) {
    if (group.user !== undefined) {
      messages.push({ role: "user", content: group.user });
      continue;
    }
    if (!group.calls) {
      messages.push({ role: "assistant", content: group.text ?? "" });
      continue;
    }
    messages.push({
      role: "assistant",
      content: group.text ?? null,
      tool_calls: group.calls.map((call) => ({ id: call.id, type: "function", function: { name: functionName(call.name), arguments: argumentsOf(call.input) } })),
    });
    for (const call of group.calls) messages.push({ role: "tool", tool_call_id: call.id, content: call.output ?? NOT_RECORDED });
  }
  const tools = inferTools(record.steps);
  return { messages, ...(tools.length ? { tools } : {}), metadata: metadataOf(record) };
}

/** ShareGPT, as Hermes-style function-calling sets write it: the calls in
 * the model's own turn as <tool_call> blocks, the results in a tool turn
 * as <tool_response> blocks, and the tools beside as a JSON string, the
 * way LLaMA-Factory reads a ShareGPT set. */
export function toShareGPT(record: TrajectoryRecord) {
  const conversations: Array<{ from: "system" | "human" | "gpt" | "tool"; value: string }> = [];
  const say = (from: "human" | "gpt" | "tool", value: string) => {
    const last = conversations.at(-1);
    // two of the same side in a row are one turn in this shape
    if (last && last.from === from && from !== "human") last.value += `\n\n${value}`;
    else conversations.push({ from, value });
  };
  if (record.system) conversations.push({ from: "system", value: record.system });
  for (const group of chatGroups(record.steps)) {
    if (group.user !== undefined) {
      say("human", group.user);
      continue;
    }
    const parts = [group.text ?? "", ...(group.calls ?? []).map((c) => `<tool_call>\n${JSON.stringify({ name: functionName(c.name), arguments: c.input ?? {} })}\n</tool_call>`)];
    say("gpt", parts.filter(Boolean).join("\n"));
    if (group.calls?.length) {
      say(
        "tool",
        group.calls.map((c) => `<tool_response>\n${JSON.stringify({ name: functionName(c.name), content: c.output ?? NOT_RECORDED })}\n</tool_response>`).join("\n"),
      );
    }
  }
  const tools = inferTools(record.steps);
  return { conversations, tools: JSON.stringify(tools), metadata: metadataOf(record) };
}

export function toTrajectory(record: TrajectoryRecord) {
  return record;
}

export function shaped(record: TrajectoryRecord, format: ExportFormat, metadata = true): unknown {
  if (format === "trajectory") return toTrajectory(record);
  const { metadata: about, ...rest } = format === "openai" ? toOpenAI(record) : toShareGPT(record);
  return metadata ? { ...rest, metadata: about } : rest;
}

// ── the export ────────────────────────────────────────────────────────

/** Why a turn is not in the file. In the order the summary says them. */
export const LEFT_OUT_REASONS = {
  dates: "outside the dates",
  engine: "on another engine",
  running: "still running",
  unknown: "no record of how they ended",
  failed: "ended with an error",
  stopped: "stopped before they finished",
  corrected: "you corrected",
  thumbsUp: "without a thumbs up",
  incomplete: "missing some tool results",
  rewound: "rewound or redone",
  takenBack: "taken back",
  others: "with other people's words",
  memberPrivate: "in members' private conversations",
  empty: "with nothing said",
  tooShort: "shorter than the shortest",
  tooLong: "longer than the longest, or over the cap",
} as const;
export type LeftOutReason = keyof typeof LEFT_OUT_REASONS;

export interface ExportSummary {
  format: ExportFormat;
  unit: ExportUnit;
  records: number;
  /** Turns written, across the records. */
  turns: number;
  /** Turns looked at in the chosen agents' and conversations' history. */
  considered: number;
  leftOut: { total: number; reasons: Array<{ reason: LeftOutReason; label: string; count: number }> };
  removed: Removed;
  compression: { rule: string | null; shortened: number; repeats: number; capped: number; droppedTurns: number };
  engines: Array<{ kind: string; name: string; turns: number; toolResults: Completeness }>;
  toolResults: Record<Completeness, number>;
  bytes: number;
  /** Set when the export asked for what needs a warning. */
  warnings: string[];
}

export interface ExportResult {
  summary: ExportSummary;
  /** The first record as it is written, pretty, for reading. */
  preview: string | null;
  previewOf: { agent: string; conversation: string; startedAt: string } | null;
  /** The same record, whole, for a script asking for JSON. */
  first: unknown;
  /** Where it was written, when it was. */
  file: string | null;
}

function systemOf(bot: BotRecord, choice: ExportChoice, source: ExportSource): string | null {
  const parts: string[] = [];
  if (choice.include.systemPrompt) {
    const intro = [`You are ${bot.name}${bot.title ? `, ${bot.title}` : ""}.`, bot.description?.trim() ?? ""].filter(Boolean).join(" ");
    parts.push(intro);
  }
  if (choice.include.memory) {
    const memory = source.memory(bot.id)?.trim();
    if (memory) parts.push(`Your memory:\n\n${memory}`);
  }
  return parts.length ? parts.join("\n\n") : null;
}

/** Each lane the choice reaches, with its owner and its label. */
function lanesOf(source: ExportSource, choice: ExportChoice): Array<{ bot: BotRecord; task: TaskRecord; title: string }> {
  const lanes: Array<{ bot: BotRecord; task: TaskRecord; title: string }> = [];
  for (const bot of source.bots) {
    if (choice.agents && !choice.agents.includes(bot.id)) continue;
    for (const task of bot.tasks ?? []) {
      if (choice.conversations && !choice.conversations.includes(task.id)) continue;
      const person = task.personId ? source.personName(task.personId) : null;
      const title = task.personId ? `${person ?? "A member"}'s conversation` : task.title || "Conversation";
      lanes.push({ bot, task, title });
    }
  }
  return lanes;
}

/**
 * The export: every chosen turn read, joined up, cleaned, shortened and
 * shaped, then written to `out` when there is one. Without, a dry run:
 * the same counts and the first record, and nothing written.
 *
 * Written beside its name and moved into place once whole, so a file
 * with that name is always a finished export.
 */
export async function runExport(source: ExportSource, choice: ExportChoice, { out = null }: { out?: string | null } = {}): Promise<ExportResult> {
  const reasons = new Map<LeftOutReason, number>();
  const leave = (reason: LeftOutReason, n = 1) => n > 0 && reasons.set(reason, (reasons.get(reason) ?? 0) + n);
  const total = noneRemoved();
  const compressionTotals = { shortened: 0, repeats: 0, capped: 0, droppedTurns: 0 };
  const engines = new Map<string, { kind: string; name: string; turns: number; flags: Completeness[] }>();
  const results: Record<Completeness, number> = { complete: 0, partial: 0, missing: 0, none: 0 };
  const warnings: string[] = [];
  let considered = 0;
  let records = 0;
  let turnsWritten = 0;
  let bytes = 0;
  let preview: string | null = null;
  let previewOf: ExportResult["previewOf"] = null;
  let first: unknown = null;

  if (choice.include.memberPrivate) {
    warnings.push(
      source.privateReadable
        ? "Members' private conversations are in this export. They wrote them to an agent, not to you: ask them before you share it."
        : "Members' private conversations stay out: reading them is off for this workspace.",
    );
  }
  if (choice.include.otherPeople) warnings.push("Other people's messages are in this export: members, people on Telegram and Signal, email and chat apps.");
  if (choice.include.memory) warnings.push("Agent memory is in this export, in each record's system message.");

  const partial = out ? `${out}.partial` : null;
  const sink = partial ? createWriteStream(partial, { mode: 0o600 }) : null;
  const write = async (line: string) => {
    bytes += Buffer.byteLength(line) + 1;
    if (!sink) return;
    if (!sink.write(line + "\n")) await new Promise((r) => sink.once("drain", r));
  };
  const scrubber = () => new Scrubber(choice.privacy, { secrets: source.secrets, home: source.home, names: source.names });

  /** A record that passed, out to the file. */
  const emit = async (record: TrajectoryRecord, turns: number) => {
    const cleaned = scrubRecord(record, scrubber);
    const short = compress(cleaned, choice.compression);
    if (!short) return leave("tooLong", turns);
    const tokens = recordTokens(short);
    if (choice.minTokens !== null && tokens < choice.minTokens) return leave("tooShort", turns);
    if (choice.maxTokens !== null && tokens > choice.maxTokens) return leave("tooLong", turns);
    const shape = shaped(short, choice.format, choice.metadata);
    await write(JSON.stringify(shape));
    records++;
    turnsWritten += turns;
    for (const key of Object.keys(total) as Array<keyof Removed>) total[key] += short.removed[key];
    compressionTotals.shortened += short.compression.shortened;
    compressionTotals.repeats += short.compression.repeats;
    compressionTotals.droppedTurns += short.compression.droppedTurns;
    if (short.compression.capped) compressionTotals.capped++;
    results[short.toolResults]++;
    if (preview === null) {
      first = shape;
      const pretty = JSON.stringify(shape, null, 2);
      preview = pretty.length > PREVIEW_CHARS ? `${pretty.slice(0, PREVIEW_CHARS)}\n\n[The preview stops here. The record in the file is whole.]` : pretty;
      previewOf = { agent: short.agent.name, conversation: short.conversation.title, startedAt: short.startedAt };
    }
  };

  try {
    for (const { bot, task, title } of lanesOf(source, choice)) {
      // A member's private conversation is theirs (server/access.ts): only
      // when the owner asked for them, and only while reading them is on.
      // Off, not even counted, so a summary cannot say that one exists.
      if (task.personId && !source.privateReadable) continue;
      const asks = transcriptTurns(task.id, source.messages(task.id));
      if (!asks.length) continue;
      considered += asks.length;
      if (task.personId && !choice.include.memberPrivate) {
        leave("memberPrivate", asks.length);
        continue;
      }
      // a guest's mail, or the conversation a person on Signal is answered
      // in, is somebody else's words, every turn of it
      const lane = task.guestMail || task.signalPerson ? asks.map((a) => ({ ...a, others: true })) : asks;
      const inDates = lane.filter((a) => (choice.from === null || a.at >= choice.from) && (choice.to === null || a.at <= choice.to));
      leave("dates", lane.length - inDates.length);
      if (!inDates.length) continue;

      const engineTurns = await readEngineTurns(join(source.eventsDir, `${task.id}.ndjson`), { from: choice.from, to: choice.to, price: source.price });
      attach(lane, engineTurns);
      const wanted = inDates.flatMap((a) => a.engineTurns);
      await fillFromNative(nativeFiles(source.nativeDir, task.id), wanted);

      const system = systemOf(bot, choice, source);
      const kept: Built[] = [];
      let leftHere = 0;
      const busy = source.busy?.(task.id) ?? false;
      for (const ask of inDates) {
        const index = lane.indexOf(ask);
        const status = statusOf(ask, busy && index === lane.length - 1);
        const why: LeftOutReason | null =
          ask.rewound ? "rewound"
          : ask.takenBack ? "takenBack"
          : ask.others && !choice.include.otherPeople ? "others"
          : status === "running" ? "running"
          : choice.engines && !choice.engines.includes(ask.engineTurns.at(-1)?.engine ?? "unknown") ? "engine"
          : choice.finishedWell && status === "unknown" ? "unknown"
          : choice.finishedWell && status === "failed" ? "failed"
          : choice.finishedWell && status === "stopped" ? "stopped"
          : choice.uncorrected && (ask.corrected || status === "stopped") ? "corrected"
          : choice.thumbsUp && !ask.thumbsUp ? "thumbsUp"
          : null;
        if (why) {
          leave(why);
          leftHere++;
          continue;
        }
        const built = build(bot, task, title, ask, index, status as Status, system);
        if (!built.record.steps.some((s) => s.type === "assistant" || s.type === "tool")) {
          leave("empty");
          leftHere++;
          continue;
        }
        if (choice.completeResults && (built.record.toolResults === "partial" || built.record.toolResults === "missing")) {
          leave("incomplete");
          leftHere++;
          continue;
        }
        const engine = engines.get(built.record.engine.kind) ?? { kind: built.record.engine.kind, name: built.record.engine.name, turns: 0, flags: [] };
        engine.turns++;
        engine.flags.push(built.record.toolResults);
        engines.set(engine.kind, engine);
        if (choice.unit === "turn") await emit(built.record, 1);
        else kept.push(built);
      }
      if (choice.unit === "conversation" && kept.length) await emit(joinTurns(kept, leftHere), kept.length);
    }
    if (sink) {
      await new Promise<void>((resolve, reject) => sink.end((error?: Error | null) => (error ? reject(error) : resolve())));
      if (records) renameSync(partial!, out!);
      else rmSync(partial!, { force: true });
    }
  } catch (error) {
    sink?.destroy();
    if (partial) rmSync(partial, { force: true });
    throw error;
  }

  const order = Object.keys(LEFT_OUT_REASONS) as LeftOutReason[];
  const reasonList = order.filter((r) => reasons.has(r)).map((reason) => ({ reason, label: LEFT_OUT_REASONS[reason], count: reasons.get(reason)! }));
  return {
    summary: {
      format: choice.format,
      unit: choice.unit,
      records,
      turns: turnsWritten,
      considered,
      leftOut: { total: reasonList.reduce((n, r) => n + r.count, 0), reasons: reasonList },
      removed: total,
      compression: { rule: compressionRule(choice.compression), ...compressionTotals },
      engines: [...engines.values()].map((e) => ({
        kind: e.kind,
        name: e.name,
        turns: e.turns,
        toolResults: e.flags.every((f) => f === "none") ? "none" : e.flags.every((f) => f === "complete" || f === "none") ? "complete" : e.flags.every((f) => f === "missing" || f === "none") ? "missing" : "partial",
      })),
      toolResults: results,
      bytes,
      warnings,
    },
    preview,
    previewOf,
    first,
    file: out && records ? out : null,
  };
}

// ── the files ─────────────────────────────────────────────────────────

/** Beside the data folder, like its backups: ~/.bloks-exports. */
export function exportsDirFor(dataDir: string): string {
  return `${dataDir}-exports`;
}

const EXPORT_NAME = /^bloks-training-(openai|sharegpt|trajectory)-(turn|conversation)-\d{8}T\d{6}Z?(?:-\d+)?\.jsonl$/;
export const isExportName = (name: string) => EXPORT_NAME.test(name);

/** A new file's name, never one already there. */
export function exportName(dir: string, choice: Pick<ExportChoice, "format" | "unit">, now = Date.now()): string {
  const stamp = new Date(now).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const base = `bloks-training-${choice.format}-${choice.unit}-${stamp}`;
  let name = `${base}.jsonl`;
  for (let n = 2; existsSync(join(dir, name)); n++) name = `${base}-${n}.jsonl`;
  return name;
}

export function ensureExportsDir(dataDir: string): string {
  const dir = exportsDirFor(dataDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export interface ExportFile {
  name: string;
  size: number;
  created: number;
  format: ExportFormat;
  unit: ExportUnit;
}

/** The exports written so far, newest first. */
export function listExports(dataDir: string): ExportFile[] {
  const dir = exportsDirFor(dataDir);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const files: ExportFile[] = [];
  for (const name of names) {
    const m = EXPORT_NAME.exec(name);
    if (!m) continue;
    try {
      const stat = statSync(join(dir, name));
      if (!stat.isFile()) continue;
      files.push({ name, size: stat.size, created: stat.mtimeMs, format: m[1] as ExportFormat, unit: m[2] as ExportUnit });
    } catch {}
  }
  return files.sort((a, b) => b.created - a.created);
}

/** An export's path by its name, or null for a name that is not one. */
export function exportPath(dataDir: string, name: string): string | null {
  if (!isExportName(name)) return null;
  const path = join(exportsDirFor(dataDir), name);
  return existsSync(path) ? path : null;
}
