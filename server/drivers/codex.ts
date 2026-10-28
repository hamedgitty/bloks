// Codex, driven through its app-server protocol.
//
// `codex app-server` is the CLI's headless mode: JSON-RPC over stdio, with
// the agent as a peer rather than a command. That peer relationship is why
// this driver is simpler than the Claude one despite doing more. When
// Codex wants permission it sends *us* a JSON-RPC request and waits for
// the reply, so approvals need no side channel: no MCP proxy, no unix
// socket, just an id we hold until a person answers.
//
// One process per turn, killed on completion. The app-server has no notion
// of being finished and will sit there indefinitely otherwise.
//
// The resume cursor is Codex's own thread id. A turn tries to resume it and
// quietly starts a new thread if that fails, because a thread the CLI has
// forgotten should cost the user their history, not their message.
import { codexItemText } from "../codex-text.ts";
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

import { attachRpc, RpcResponseError, type RpcLink } from "../harness/jsonrpc-stdio.ts";
import { readCodexSkills, MAX_CODEX_SKILL_ITEMS, type CodexSkill } from "../codex-skills.ts";
import type {
  DriverCreateInput,
  ModelCatalog,
  PlanUsage,
  ProviderDriver,
  ProviderInstance,
  ProviderSnapshot,
  RuntimeEvent,
  RuntimeEventListener,
  SendTurnInput,
} from "../contracts.ts";
import { newEventId, newId } from "../contracts.ts";
import { knownEfforts, type Effort } from "../effort.ts";
import { codexPlanUsage } from "../plan-usage.ts";
import { callSignature } from "../repeats.ts";
import { appendNative } from "./native.ts";
import { describeEarlyExit, describeSpawnError } from "./spawn-error.ts";
import { within } from "./deadline.ts";
import { OWN_GROUP } from "../no-console.ts";
import { EngineProcesses } from "./engine-processes.ts";
import { CODEX_PERSON_HOLD, CODEX_PERSON_NEXT, personTurnHold } from "../person-turn.ts";
import { CodexSpeedUnavailable, type CodexSpeedRefusal, FAST_TIER, fastRefusal, requireFastTier, resolveCodexSpeed } from "../codex-speed.ts";
import { createAskBroker, type AskBroker } from "../harness/ask-broker.ts";
import { checkCodexReplyEndpoint, makeCodexReplyFolder } from "../person-turn.ts";
import { isConnectionEnvName } from "../connections.ts";

const DRIVER_KIND = "codex";
const NATIVE_SOURCE = "codex.app-server";

/** What the picker shows until the CLI says what it serves. The installed
 * Codex is asked for its own list (`model/list`) when the engine starts,
 * so a model OpenAI ships next week appears without a Bloks release, and
 * one the installed CLI is too old to run is not offered. */
const MODELS = {
  default: "gpt-6-sol",
  options: [
    { id: "gpt-6-astra", label: "GPT-6 Astra" },
    { id: "gpt-6-sol", label: "GPT-6 Sol" },
    { id: "gpt-6-luna", label: "GPT-6 Luna" },
    { id: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
    { id: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
    { id: "gpt-5.6-luna", label: "GPT-5.6 Luna" },
  ],
};

/** The effort levels turn/start is given, as Codex 0.145's model/list
 * spells them. Each model's own list narrows these; until the CLI has
 * said, a model is offered all of them. Codex also lists "ultra" for some
 * models, which hands work to helpers of its own and is not offered. */
const CODEX_EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];

const PROBE_TIMEOUT_MS = 20_000;

/** "GPT-6-Luna" as Codex spells it, "GPT-6 Luna" as the picker does. */
export function codexLabel(displayName: string | undefined, id: string): string {
  const name = (displayName || id).trim();
  return name
    .replace(/^(gpt-[\d.]+)-([a-z])/i, (_, head: string, first: string) => `${head} ${first.toUpperCase()}`)
    .replace(/^gpt/i, "GPT");
}

/** The catalog out of one `model/list` page set: visible models, in the
 * CLI's order, with its default first choice. Null when there is none. */
export function catalogFromModelList(pages: any[]): ModelCatalog | null {
  const options: ModelCatalog["options"] = [];
  let defaultId = "";
  for (const page of pages) {
    for (const m of Array.isArray(page?.data) ? page.data : []) {
      const id = typeof m?.model === "string" && m.model ? m.model : typeof m?.id === "string" ? m.id : "";
      if (!id || m.hidden === true || options.some((o) => o.id === id)) continue;
      options.push({
        id,
        label: codexLabel(m.displayName, id),
        // whether this model offers Fast, where the catalog says at all
        ...(Array.isArray(m.serviceTiers) ? { codexFast: m.serviceTiers.some((tier: any) => tier?.id === FAST_TIER) } : {}),
        // and which effort levels it takes, which differ by model
        ...(Array.isArray(m.supportedReasoningEfforts)
          ? { efforts: knownEfforts(m.supportedReasoningEfforts.map((e: any) => (typeof e === "string" ? e : e?.reasoningEffort))) }
          : {}),
      });
      if (m.isDefault === true && !defaultId) defaultId = id;
    }
  }
  if (!options.length) return null;
  return { default: defaultId || options[0].id, options, checkedAt: Date.now() };
}

// ── a turn's own tokens ────────────────────────────────────────────────
//
// `thread/tokenUsage/updated` carries `total`, the count for the whole
// thread so far, which carries on across turns and across resume. Passed
// on as it was, every turn was charged for every turn before it (GitHub
// 173). A turn's own tokens are the thread's total now less the total
// before the turn started.

export interface TokenCount {
  input: number;
  output: number;
}

/** Threads remembered, most recent last. Enough for every lane in use. */
const MAX_THREADS = 2_000;

/** Each Codex thread's total as last reported here, by Codex's thread id. */
const threadTotals = new Map<string, TokenCount>();

export function tokenCount(raw: any): TokenCount | null {
  if (!raw || typeof raw !== "object") return null;
  return { input: Number(raw.inputTokens) || 0, output: Number(raw.outputTokens) || 0 };
}

/**
 * The thread's total before this turn, from its first update.
 *
 * The total last seen for the thread is exact, and it also counts work
 * Codex did at the start of the turn before the first model call. When
 * there is none (the first turn after a restart, or a thread resumed from
 * somewhere else) the total less `last`, the call just reported, is the
 * total before it. Without `last` the turn starts counting from here,
 * which leaves out one call rather than charging the whole thread again.
 */
export function turnBaseline(known: TokenCount | undefined, total: TokenCount, last: TokenCount | null): TokenCount {
  // a total below the one remembered is a thread that started its count again
  if (known && known.input <= total.input && known.output <= total.output) return known;
  return {
    input: Math.max(0, total.input - (last?.input ?? 0)),
    output: Math.max(0, total.output - (last?.output ?? 0)),
  };
}

// ── how full the thread is ─────────────────────────────────────────────
//
// The same notification says how full the thread is, and that is a
// different number from what a turn spent: `last` is the request just
// made, the whole context it carried, and `modelContextWindow` is the
// window Codex is holding it to. The turn's sum above, read as fullness,
// put every Codex conversation at 100% (GitHub 224).

/** The latest request's size and the window, either null when absent. */
export function contextReading(tokenUsage: any): { used: number | null; window: number | null } {
  const used = Number(tokenUsage?.last?.inputTokens);
  const window = Number(tokenUsage?.modelContextWindow);
  return {
    used: Number.isFinite(used) && used > 0 ? Math.round(used) : null,
    window: Number.isFinite(window) && window > 0 ? Math.round(window) : null,
  };
}

/** How long a compaction asked for before a turn may take before the
 * words go to a new thread instead. The person's message waits for it,
 * so a longer one keeps more compactions but holds more messages. Ten
 * minutes: measured Codex compactions of long threads took about two and
 * a half minutes as a rule and up to eight and a half, and five cut those
 * off and cost the agent its thread (GitHub 234). */
export const COMPACT_LIMIT_MS = 10 * 60_000;

function rememberTotal(thread: string, total: TokenCount) {
  threadTotals.delete(thread);
  threadTotals.set(thread, total);
  while (threadTotals.size > MAX_THREADS) threadTotals.delete(threadTotals.keys().next().value!);
}

// ── the bloks command, from the agent's shell ──────────────────────────
//
// A turn's credential reaches the app-server in its environment (see
// server/agent-cli.ts), and Codex hands its shell commands only what the
// person's shell_environment_policy lets through. Under `inherit = "core"`
// that was none of the three, and the bloks command quietly did nothing
// (GitHub 336). So the thread's own config states them too, as `set`
// entries, which Codex applies after it has inherited and excluded: the
// rest of the policy stays the person's, and nothing else it keeps out
// comes back. Dotted keys, so a `set` table of their own is added to, not
// replaced. Sent with the request over stdin, never in argv or a file,
// and on every start, resume and fork, so a thread carried on has this
// turn's credential and not the one it started with.

const SHELL_NAMES = ["BLOKS_CLI", "BLOKS_URL", "BLOKS_TOKEN", "BLOKS_REPLY_TOKEN", "BLOKS_REPLY_PATH"] as const;

/**
 * The thread config that hands the bloks command to the shell, or null
 * for a turn without a credential. `includeOnly` is the person's own
 * list, when they keep one: Codex filters by it after `set`, so it is
 * stated again with the three names added and nothing else.
 */
export function shellConfig(env: Record<string, string | undefined> | undefined, includeOnly?: unknown): Record<string, unknown> | null {
  const config: Record<string, unknown> = {};
  const named: string[] = [];
  // A connection's address and git's pointer to it (server/connections.ts)
  // ride the same way: Codex's default policy leaves out any name with
  // KEY in it, which GIT_CONFIG_KEY_0 has, and a clone would then go
  // straight to github.com with no address at all.
  const connection = Object.keys(env ?? {}).filter((name) => isConnectionEnvName(name));
  for (const name of [...SHELL_NAMES, ...connection]) {
    const value = env?.[name];
    if (typeof value !== "string" || !value) continue;
    config[`shell_environment_policy.set.${name}`] = value;
    named.push(name);
  }
  if (!named.length) return null;
  if (Array.isArray(includeOnly) && includeOnly.length) {
    const kept = includeOnly.filter((pattern): pattern is string => typeof pattern === "string");
    config["shell_environment_policy.include_only"] = [...kept, ...named.filter((name) => !kept.includes(name))];
  }
  return config;
}

/** How an app-server says no to that config: the key it could not load,
 * or a `config` it does not know at all, which is no to all of it. */
const SHELL_REFUSED = /shell_environment_policy/i;
const CONFIG_REFUSED = /unknown field `?config\b/i;

/** Said once in a conversation whose Codex would not take it. */
export const SHELL_REFUSED_NOTICE =
  "This Codex would not take the setting Bloks uses to hand its command line to the agent's shell, so it carried on without it. " +
  "Where this project's Codex config narrows shell_environment_policy, the agent's commands cannot reach Bloks. Updating Codex should fix it.";

// ── Codex's own goals ──────────────────────────────────────────────────
//
// An agent could give itself a goal with Codex's create_goal tool, on by
// default, and Codex then starts a turn of its own to carry on with it
// straight after each one ends. Bloks ends the process there, so that
// turn was cut off every time, and the next one opened told to keep
// working toward a goal nobody was holding (GitHub 380). So the thread's
// config turns Codex's goals off, on every start, resume and fork, and a
// thread that already has one has it cleared once, when it is resumed.

const GOALS_OFF = { "features.goals": false } as const;

// ── the agent's own MCP servers ────────────────────────────────────────
//
// The servers attached to an agent under Settings, Apps and keys were
// mounted for Claude Code and never for Codex, which went without their
// tools and said nothing (GitHub 358). They go in the thread's own config
// now, beside the shell's names: over stdin with the request, on every
// start, resume and fork. Not as `-c` in argv, where any process listing
// reads a header or a key, and not in the app-server's environment, which
// the agent's shell commands inherit. Each server is one key holding
// its whole table, under the name Claude Code gives it. A name the
// person's own Codex config already uses is passed over: Codex merges a
// table into one of the same name, and a stdio table merged into an HTTP
// one refuses the whole thread.

type AttachedServer = NonNullable<NonNullable<SendTurnInput["integrations"]>["mcpServers"]>[number];

/** Where the agent's servers sit in the thread config. Claude Code's
 * prefix, so none of them can land on a bloks_ mount. */
const SERVER_KEY = "mcp_servers.u_";

/** A header name as HTTP allows it. Codex quietly drops any other, which
 * would leave a server short of the very header that carries its key. */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
/** A name an environment variable can have on every system Codex runs on. */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** An http or https address with somewhere to go. */
function webAddress(url: string): boolean {
  try {
    const read = new URL(url);
    return (read.protocol === "http:" || read.protocol === "https:") && read.hostname.length > 0;
  } catch {
    return false;
  }
}

/** Shorter than this, a value is no key, and taking it out of everything
 * written down would take every "1" and "true" with it. */
const MIN_HIDDEN = 8;

/** How an app-server says no to the servers: the key it could not load. */
const SERVERS_REFUSED = /mcp_servers/i;

/** Said once in a conversation whose Codex would not take its servers. */
export const SERVERS_REFUSED_NOTICE =
  "This Codex would not take the MCP servers attached to this agent, so it carried on without them. Updating Codex should fix it.";

/** Said for the servers Codex cannot be handed as they are, with why. */
export function leftOutNotice(left: readonly string[]): string {
  const one = left.length === 1;
  return `Codex cannot use ${one ? "one" : left.length} of the MCP servers attached to this agent, so ${one ? "it is" : "they are"} left out. ${left.map((why) => `${why}.`).join(" ")}`;
}

export interface ServerConfig {
  /** Thread config entries, one per server mounted. */
  config: Record<string, unknown>;
  /** Header and environment values, kept out of everything written down. */
  secrets: string[];
  /** Each server Codex cannot be handed, by its own name and why. */
  leftOut: string[];
}

/**
 * The thread config that mounts an agent's servers. `approve` is a turn
 * the owner vouched for: Claude Code pre-allows these same servers, every
 * tool on them, and so does this. On any other turn Codex asks, and the
 * question reaches the owner as a card. `taken` is the person's own
 * server names, as Codex reads them where the thread runs.
 */
export function serverConfig(servers: readonly AttachedServer[] | undefined, options: { approve: boolean; taken?: Iterable<string> }): ServerConfig {
  const config: Record<string, unknown> = {};
  const secrets = new Set<string>();
  const leftOut: string[] = [];
  const used = new Set(options.taken ?? []);
  // A name with no value is one the person has not filled in yet (a
  // server brought over from another tool arrives that way). An empty
  // Authorization header or API key would only turn a clear "missing
  // key" from the server into a confusing one.
  const filled = (map?: Record<string, string>) => {
    const entries = Object.entries(map ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0);
    return entries.length ? Object.fromEntries(entries) : undefined;
  };
  for (const server of servers ?? []) {
    const name = typeof server.name === "string" ? server.name : "";
    const label = name.replace(/[\x00-\x1f\x7f]/g, "").trim() || "A server with no name";
    // unset is stdio, as Claude Code reads it
    const transport = String(server.transport ?? "stdio");
    let table: Record<string, unknown>;
    let values: string[];
    if (transport === "http") {
      const url = typeof server.url === "string" ? server.url.trim() : "";
      // read as an address, not only by how it starts: "https://" alone
      // was mounted as one and failed inside Codex with nothing said
      // here (GitHub 372)
      if (!webAddress(url)) {
        leftOut.push(`${label}: it has no http or https address`);
        continue;
      }
      const headers = filled(server.headers);
      const bad = Object.entries(headers ?? {}).find(([header, value]) => !HEADER_NAME.test(header) || /[\r\n\0]/.test(value));
      if (bad) {
        leftOut.push(HEADER_NAME.test(bad[0]) ? `${label}: its ${bad[0]} header has a line break in it` : `${label}: "${bad[0]}" is not a header name HTTP allows`);
        continue;
      }
      // streamable HTTP, which is what Bloks and Claude Code speak too
      table = { url, ...(headers ? { http_headers: headers } : {}) };
      values = Object.values(headers ?? {});
    } else if (transport === "stdio") {
      if (typeof server.command !== "string" || !server.command.trim()) {
        leftOut.push(`${label}: it has no command to run`);
        continue;
      }
      if (server.command.includes("\0")) {
        leftOut.push(`${label}: its command has a character no command line can carry`);
        continue;
      }
      // Every argument as given or none of them: one dropped quietly is a
      // different command line from the one the person wrote (GitHub 372).
      const given: unknown = server.args;
      if (given !== undefined && (!Array.isArray(given) || given.some((arg) => typeof arg !== "string" || arg.includes("\0")))) {
        leftOut.push(`${label}: its arguments must each be plain text`);
        continue;
      }
      const env = filled(server.env);
      // by name only: a value here can be a key, and this line is shown
      const badEnv = Object.entries(env ?? {}).find(([key, value]) => !ENV_NAME.test(key) || value.includes("\0"));
      if (badEnv) {
        leftOut.push(ENV_NAME.test(badEnv[0]) ? `${label}: the value of ${badEnv[0]} has a character no environment can carry` : `${label}: "${badEnv[0].replace(/[\x00-\x1f\x7f]/g, "").slice(0, 40)}" is not a name an environment variable can have`);
        continue;
      }
      const args = (given as string[] | undefined) ?? [];
      table = { command: server.command, args, ...(env ? { env } : {}) };
      values = Object.values(env ?? {});
    } else {
      // Codex has no other transport, SSE included, to hand it to
      const said = transport.replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, 40);
      leftOut.push(`${label}: Codex speaks stdio and streamable HTTP, not ${said || "an unnamed transport"}`);
      continue;
    }
    if (options.approve) table.default_tools_approval_mode = "approve";
    // Claude Code's slug, which is all lowercase letters, digits and
    // underscores: a bare key in TOML and a name Codex accepts. Two that
    // come out the same, or one the person's Codex has, get a number.
    const slug = "u_" + name.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 40);
    const base = slug === "u_" ? "u_server" : slug;
    let key = base;
    for (let n = 2; used.has(key); n++) key = `${base}_${n}`;
    used.add(key);
    config[`mcp_servers.${key}`] = table;
    for (const value of values) if (value.length >= MIN_HIDDEN) secrets.add(value);
  }
  return { config, secrets: [...secrets], leftOut };
}

/** A thread request as the native copy keeps it: the agent's servers by
 * name and shape, every value in them taken out. An address, a command
 * line and a header are each somewhere a server's key can live, and a
 * value short enough to be left in by MIN_HIDDEN can still be one. */
export function withoutServerValues(msg: any): any {
  const config = msg?.params?.config;
  if (!config || typeof config !== "object") return msg;
  const keys = Object.keys(config).filter((key) => key.startsWith(SERVER_KEY));
  if (!keys.length) return msg;
  const shape = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(shape)
      : value && typeof value === "object"
        ? Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, shape(inner)]))
        : "[redacted]";
  return { ...msg, params: { ...msg.params, config: { ...config, ...Object.fromEntries(keys.map((key) => [key, shape(config[key])])) } } };
}

/** Asks the installed CLI what it can run. No thread is started and
 * nothing is spent; the process is killed as soon as the list lands. */
async function probe<T>(cli: string, cwd: string, read: (rpc: RpcLink) => Promise<T>): Promise<T | null> {
  const env: Record<string, string | undefined> = { ...process.env, NPM_CONFIG_LOGLEVEL: "error" };
  delete env.OPENAI_API_KEY;
  let child;
  try {
    child = spawn(cli, ["app-server"], { cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  } catch {
    return null;
  }
  child.stderr?.resume();
  const rpc = attachRpc({
    stdin: child.stdin,
    stdout: child.stdout,
    onRequest: (msg) => rpc.replyError(msg.id, -32601, "not supported by this client"),
    onNotify: () => {},
  });
  const timer = setTimeout(() => rpc.failPending(new Error("timed out")), PROBE_TIMEOUT_MS);
  timer.unref?.();
  child.on("error", (e) => rpc.failPending(e instanceof Error ? e : new Error(String(e))));
  child.on("close", () => rpc.failPending(new Error("exited")));
  try {
    await rpc.request("initialize", { clientInfo: { name: "bloks", version: "1" } });
    rpc.notify("initialized", {});
    return await read(rpc);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    try {
      child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
    rpc.failPending(new Error("probe ended"));
  }
}

async function probeCatalog(cli: string): Promise<ModelCatalog | null> {
  return probe(cli, homedir(), async (rpc) => {
    const pages: any[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 5; i++) {
      const page: any = await rpc.request("model/list", cursor ? { cursor } : {});
      pages.push(page);
      cursor = typeof page?.nextCursor === "string" && page.nextCursor ? page.nextCursor : null;
      if (!cursor) break;
    }
    return catalogFromModelList(pages);
  });
}

export interface CodexConfig {
  cli: string;
  fullAuto: boolean;
}

function decodeConfig(raw: unknown): CodexConfig {
  const source = (raw ?? {}) as Record<string, unknown>;
  return {
    cli: typeof source.cli === "string" ? source.cli : "codex",
    fullAuto: source.fullAuto === true,
  };
}

/** Same asymmetry as everywhere else: an unanswered permission denies, an
 * unanswered question hands back guidance so the turn can still land. */
const UNANSWERED_QUESTION = "No answer was given. Use your best judgment.";
const UNANSWERED_PERMISSION =
  "Bloks: nobody answered this permission request in time. Skip this action and finish what you can without it.";
const ASK_TIMEOUT_MS = 15 * 60_000;

/** Codex renamed its approval methods and both spellings are still in the
 * wild, so the decision vocabulary depends on which one asked. */
const LEGACY_APPROVAL_METHODS = new Set(["execCommandApproval", "applyPatchApproval"]);
const QUESTION_METHOD = "item/tool/requestUserInput";
const MCP_ELICITATION_METHOD = "mcpServer/elicitation/request";
const EDIT_APPROVAL_METHODS = new Set(["item/fileChange/requestApproval", "applyPatchApproval"]);

// ── questions that do not wait ────────────────────────────────────────
//
// Codex has a second way to ask, request_user_input_async, and it is not
// a request at all: the tool tells the agent its question was taken, the
// agent carries on, and the question arrives as a finished agentMessage
// with `delivery: "async"` and the questions themselves beside its text.
// Read as a reply, it was words in the transcript with nothing to answer
// and nobody told (GitHub 402). It opens the same card a blocking
// question does now, and since no call is left to hear the answer, the
// answer goes to the conversation as the person's words.

/** Outstanding async questions an instance keeps, and the items it
 * remembers having carded. Past these the oldest goes. */
const MAX_ASYNC_ASKS = 256;
const MAX_ASYNC_SEEN = 1_024;

/** An async question item, read the way a blocking question's card is:
 * every question's title, and the first one's choices. Null for an item
 * that is only words, or one whose questions name nothing to ask. */
export function asyncQuestion(item: any): { summary: string; choices: string[] } | null {
  if (item?.delivery !== "async" || !Array.isArray(item.questions)) return null;
  const said = (value: unknown, max: number) => (typeof value === "string" ? value.trim().slice(0, max) : "");
  const asked = item.questions
    .map((q: any) => ({ title: said(q?.title ?? q?.question ?? q?.header, 500), options: Array.isArray(q?.options) ? q.options : [] }))
    .filter((q: { title: string }) => q.title);
  if (!asked.length) return null;
  // a choice is a plain string here, a { label } on the blocking path
  const choices: string[] = asked[0].options.map((o: any) => said(typeof o === "string" ? o : o?.label, 200)).filter(Boolean);
  return { summary: asked.map((q: { title: string }) => q.title).join(" · "), choices: [...new Set(choices)].slice(0, 5) };
}

/** What the agent is asking to touch, in a word the transcript can show. */
function toolOf(method: string, params: any): string {
  if (EDIT_APPROVAL_METHODS.has(method)) return "edit";
  if (method === QUESTION_METHOD) return "ask_user";
  if (method === MCP_ELICITATION_METHOD) return `mcp__${params.serverName ?? "unknown"}`;
  return "shell";
}

/**
 * What an approval request is about, in the fields the rules read: the
 * command, and every file a change touches. Left out, a rule about a
 * command or a path could never match a Codex request, and only rules on
 * the tool's name applied. A legacy patch names its files itself; a
 * current one names its item, whose files came with item/started.
 */
export function requestInput(params: any, itemPaths: ReadonlyMap<string, string[]>): Record<string, unknown> {
  const command = Array.isArray(params?.command)
    ? params.command.filter((part: unknown) => typeof part === "string").join(" ")
    : typeof params?.command === "string"
      ? params.command
      : "";
  const paths =
    params?.fileChanges && typeof params.fileChanges === "object"
      ? // a rename names where it goes as well as where it was
        Object.entries(params.fileChanges).flatMap(([path, change]: [string, any]) =>
          [path, change?.move_path, change?.update?.move_path].filter((p): p is string => typeof p === "string" && p.length > 0),
        )
      : typeof params?.itemId === "string"
        ? (itemPaths.get(params.itemId) ?? [])
        : [];
  return {
    ...(command ? { command } : {}),
    ...(paths.length ? { path: paths[0], paths } : {}),
  };
}

/** One line describing the request, from whichever field carries it. */
function summarise(params: any, fallback: string): string {
  if (typeof params.message === "string") return params.message;
  if (typeof params.command === "string") return params.command.slice(0, 200);
  if (Array.isArray(params.questions)) {
    return params.questions
      .map((q: any) => q.question ?? q.header)
      .filter(Boolean)
      .join(" · ");
  }
  if (typeof params.reason === "string") return params.reason;
  return fallback;
}

/** Which item types are tool activity worth a chip in the transcript, and
 * what to label them. Returns null for anything that is not. */
function toolLabel(item: any): string | null {
  switch (item.type) {
    case "commandExecution":
      return "shell";
    case "fileChange":
      return "edit";
    case "mcpToolCall":
      return item.tool ?? item.name ?? "mcp";
    case "webSearch":
      return "web_search";
    default:
      return null;
  }
}

const TOOL_ITEM_TYPES = new Set(["commandExecution", "fileChange", "mcpToolCall"]);

/** What an item asked for, as a signature (server/repeats.ts). Only the
 * request's own fields: an item also carries its id, its status and, once
 * it has run, its output, none of which make two calls different asks. */
export function codexSignature(item: any): string | undefined {
  switch (item?.type) {
    case "commandExecution":
      return callSignature(item.type, { command: item.command, cwd: item.cwd });
    case "fileChange":
      return callSignature(item.type, { changes: item.changes });
    case "mcpToolCall":
      return callSignature(item.type, { server: item.server, tool: item.tool ?? item.name, arguments: item.arguments });
    case "webSearch":
      // An opening item may not know its query yet. Unknown asks are
      // still activity, but are not evidence of an identical request.
      if (typeof item.query !== "string" || !item.query.trim()) return undefined;
      return callSignature(item.type, { query: item.query });
    default:
      return undefined;
  }
}

/** The connectors bridge ships as TypeScript in development and compiled
 * JavaScript in the packaged app; resolve whichever is actually there. */
function connectorsHelper(): string {
  const asTypeScript = join(dirname(fileURLToPath(import.meta.url)), "..", "connectors-proxy.ts");
  return existsSync(asTypeScript) ? asTypeScript : asTypeScript.replace(/\.ts$/, ".js");
}

export const CodexDriver: ProviderDriver<CodexConfig> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "Codex", supportsMultipleInstances: true },
  models: MODELS,
  decodeConfig,
  defaultConfig: () => decodeConfig({}),

  async create(input: DriverCreateInput<CodexConfig>): Promise<ProviderInstance> {
    const { instanceId, config } = input;
    const listeners = new Set<RuntimeEventListener>();

    // replaced in place once the CLI answers; a failed probe (not
    // installed, too old to know model/list) keeps the list above
    const models: ModelCatalog = { default: MODELS.default, options: [...MODELS.options] };
    const catalogReady = probeCatalog(config.cli).then((catalog) => {
      if (!catalog) return;
      models.options = catalog.options;
      models.default = catalog.default;
      models.checkedAt = catalog.checkedAt;
    });

    type Answer = (behavior: string, message?: string, source?: string, reply?: boolean) => void;
    interface RunningTurn {
      turnId: string;
      abort: () => void;
      /** More words for this turn; false when Codex would not take them. */
      steer: (text: string, options?: { skillNames?: string[]; onAccepted?: (turnId: string) => void; onDispatch?: () => void }) => Promise<boolean>;
      asks: Map<string, Answer>;
    }
    const running = new Map<string, RunningTurn>();
    /** Async questions still open, by the request id on their card, with
     * the conversation and turn that asked. The instance's, not the
     * turn's: the turn that asked has often ended by the time anyone
     * answers, and the answer still has somewhere to go. */
    const asyncAsks = new Map<string, { threadId: string; turnId: string }>();
    /** The async question items already carded, by conversation, Codex
     * turn and item, so the same item said again is not a second card. */
    const asyncSeen = new Set<string>();
    /** Conversations already told their Codex would not take the shell's
     * config (SHELL_REFUSED_NOTICE), so a lane hears it once, not every turn. */
    const toldShellRefused = new Set<string>();
    /** The same for the agent's MCP servers (SERVERS_REFUSED_NOTICE). */
    const toldServersRefused = new Set<string>();
    /** Codex threads already asked to clear a goal of Codex's own. */
    const goalsCleared = new Set<string>();
    /** What each conversation was last told Codex could not be handed
     * (leftOutNotice), so it hears again only when that changes. */
    const toldLeftOut = new Map<string, string>();
    /** Every engine process this instance started, ended on dispose (engine-processes.ts). */
    const engines = new EngineProcesses();
    // Busy transitions and several open windows share a short menu
    // read. A different folder or engine never borrows another's rows.
    const skillCatalogs = new Map<string, { at: number; result: Promise<CodexSkill[] | null> }>();
    const skills = (cwd: string): Promise<CodexSkill[] | null> => {
      if (!isAbsolute(cwd) || /[\x00-\x1f\x7f]/.test(cwd)) return Promise.resolve(null);
      const now = Date.now();
      for (const [key, entry] of skillCatalogs) if (now - entry.at >= 60_000) skillCatalogs.delete(key);
      const cached = skillCatalogs.get(cwd);
      if (cached) return cached.result;
      if (skillCatalogs.size >= 32) skillCatalogs.delete(skillCatalogs.keys().next().value!);
      const result = probe(config.cli, homedir(), async (rpc) => readCodexSkills(await rpc.request("skills/list", { cwds: [cwd], forceReload: true }), cwd));
      skillCatalogs.set(cwd, { at: now, result });
      return result;
    };
    // What the plan signed in here has left, as Codex last said, for the
    // composer's card (server/plan-usage.ts). The limits belong to the
    // account, so one for the instance, whichever turn heard it.
    let plan: PlanUsage | null = null;

    const emit = (event: RuntimeEvent) => {
      for (const listener of [...listeners]) listener(event);
    };
    const envelope = (threadId: string, turnId: string) => ({
      eventId: newEventId(),
      provider: DRIVER_KIND,
      threadId,
      turnId,
      createdAt: new Date().toISOString(),
    });

    const sendTurn = async (turn: SendTurnInput) => {
      const { threadId } = turn;
      // Even read-only, Codex's sandbox reads the whole disk without
      // asking: Bloks' saved keys and every agent's bot token included,
      // and a person's turn can send what it reads straight back. The
      // harness holds these turns before here; this is the second line.
      if (turn.person) throw personTurnHold(CODEX_PERSON_HOLD, CODEX_PERSON_NEXT);
      // Fixed for the whole turn: a steer, or a setting changed while it
      // runs, applies from the next turn.
      const speedChoice = Object.freeze({ ...(turn.codexSpeed ?? resolveCodexSpeed({})) });
      const fast = speedChoice.resolved === "fast";
      // A model the catalog just said has no Fast is refused here, before
      // a process starts. An old or missing answer proves nothing.
      const offersFast = models.options.find((m) => m.id === (turn.model || models.default))?.codexFast;
      if (fast && offersFast === false && models.checkedAt && Date.now() - models.checkedAt < 300_000) {
        throw new CodexSpeedUnavailable("Codex does not offer Fast for this model. Choose Standard, or a model that offers Fast.");
      }
      if (running.has(threadId)) throw new Error("a turn is already running on this thread");
      const turnId = newId();

      const env: Record<string, string | undefined> = {
        ...process.env,
        // the turn's own credential (see server/agent-cli.ts)
        ...(turn.env ?? {}),
        NPM_CONFIG_LOGLEVEL: "error",
      };
      // The CLI holds its own ChatGPT login. An inherited API key would
      // silently move the user onto pay-as-you-go billing.
      delete env.OPENAI_API_KEY;
      // This turn's credential, kept out of everything written down: the
      // native copy (appendNative takes it out), and any error that quotes
      // back the thread config carrying it (shellConfig). The agent's MCP
      // servers add their keys once they are read (serverConfig).
      const hiddenTokens = [turn.env?.BLOKS_TOKEN, turn.env?.BLOKS_REPLY_TOKEN].filter((value): value is string => typeof value === "string" && value.length > 0);
      const hide = <T>(text: T): T =>
        (typeof text === "string" ? hiddenTokens.reduce((safe, token) => safe.split(token).join("[redacted]"), text) : text) as T;

      let ownerReplyFolder: ReturnType<typeof makeCodexReplyFolder> | undefined;
      let replyBroker: AskBroker | undefined;
      // Working elsewhere, Bloks' own bridges are named in the thread
      // config over stdin, at their address through the gate, rather
      // than in argv as a command to run here.
      const bridgesThere: Record<string, unknown> = {};
      const bridgeThere = (name: string, server: { command: string; args: string[]; env: Record<string, string> }, approve = false) => {
        const reached = turn.place?.mcp(name, { transport: "stdio", ...server });
        if (!reached) return;
        bridgesThere[`mcp_servers.${name}`] = { url: reached.url, http_headers: reached.headers, ...(approve ? { default_tools_approval_mode: "approve" } : {}) };
        for (const value of Object.values(reached.headers)) hiddenTokens.push(value, value.replace(/^Bearer /, ""));
      };

      // The connectors, over the stdio bridge, because this CLI mounts
      // MCP servers as child processes and nothing else. The key rides
      // the environment and only its *name* appears in argv, so process
      // listings and diagnostics never see it.
      const appServerArgs = ["app-server"];
      // Fast stated for this process, so a host config that switched the
      // feature off does not quietly turn the request into Standard
      if (fast) appServerArgs.push("-c", "features.fast_mode=true");
      if (turn.reply && !turn.person) {
        ownerReplyFolder = makeCodexReplyFolder();
        const ext = import.meta.url.endsWith(".ts") ? "ts" : "js";
        const helper = fileURLToPath(new URL(`../permission-proxy.${ext}`, import.meta.url));
        // Readiness is part of this turn, before a process exists. Use
        // the same interrupt/dispose ownership as the running process.
        const readiness = new AbortController();
        const pending: RunningTurn = {
          turnId, abort: () => readiness.abort(new Error("Stopped before Codex started.")),
          steer: async () => false, asks: new Map(),
        };
        running.set(threadId, pending);
        try {
          replyBroker = createAskBroker({ socketPath: ownerReplyFolder.socketPath,
            onAsk: (ask) => replyBroker?.answer(ask.id, "deny", "This server only replies to the sender."), onResolve: () => {},
            onReply: (input) => turn.reply!.reply(input) });
          await checkCodexReplyEndpoint(ownerReplyFolder.socketPath, readiness.signal);
        } catch (error) { replyBroker?.close(); ownerReplyFolder.close(); throw error; }
        finally { if (running.get(threadId) === pending) running.delete(threadId); }
        const prefix = "mcp_servers.bloks_reply";
        if (turn.place) {
          // the bridge stays here; Codex there reaches it through the gate
          bridgeThere("bloks_reply", { command: process.execPath, args: [helper, ownerReplyFolder.socketPath], env: { ELECTRON_RUN_AS_NODE: "1", BLOKS_PUBLISH: "reply_to_sender" } }, true);
        } else appServerArgs.push("-c", `${prefix}.command=${JSON.stringify(process.execPath)}`,
          "-c", `${prefix}.args=${JSON.stringify([helper, ownerReplyFolder.socketPath])}`,
          "-c", `${prefix}.default_tools_approval_mode="approve"`,
          "-c", `${prefix}.env.ELECTRON_RUN_AS_NODE="1"`,
          "-c", `${prefix}.env.BLOKS_PUBLISH="reply_to_sender"`);
      }
      if (turn.integrations?.composio?.key && turn.place) {
        // the connectors' key stays on this computer with the bridge
        bridgeThere("bloks_connectors", {
          command: process.execPath,
          args: [connectorsHelper()],
          env: {
            BLOKS_COMPOSIO_KEY: turn.integrations.composio.key,
            ...(turn.integrations.composio.url ? { BLOKS_COMPOSIO_URL: turn.integrations.composio.url } : {}),
            ELECTRON_RUN_AS_NODE: "1",
          },
        });
      } else if (turn.integrations?.composio?.key) {
        env.BLOKS_COMPOSIO_KEY = turn.integrations.composio.key;
        if (turn.integrations.composio.url) env.BLOKS_COMPOSIO_URL = turn.integrations.composio.url;
        // in the packaged app process.execPath is Electron; this makes it
        // behave as plain node for the bridge
        env.ELECTRON_RUN_AS_NODE = "1";
        const prefix = "mcp_servers.bloks_connectors";
        appServerArgs.push(
          "-c", `${prefix}.command=${JSON.stringify(process.execPath)}`,
          "-c", `${prefix}.args=${JSON.stringify([connectorsHelper()])}`,
          "-c", `${prefix}.env_vars=${JSON.stringify(["BLOKS_COMPOSIO_KEY", "BLOKS_COMPOSIO_URL", "ELECTRON_RUN_AS_NODE"])}`,
        );
      }

      const child = (() => {
        try { return turn.place ? turn.place.spawn(config.cli, appServerArgs, { env }) : spawn(config.cli, appServerArgs, {
          cwd: turn.cwd ?? homedir(),
          env,
          stdio: ["pipe", "pipe", "pipe"],
          detached: OWN_GROUP,
          windowsHide: true,
        }); }
        catch (error) { replyBroker?.close(); ownerReplyFolder?.close(); throw error; }
      })();
      engines.add(child);
      child.once("close", () => { replyBroker?.close(); ownerReplyFolder?.close(); });

      const asks = new Map<string, Answer>();
      const rpcAsks = new Map<unknown, { requestId: string; providerThreadId: unknown }>();
      let finished = false;
      let stopping = false;
      // the thread's token total before this turn, set by its first update
      let tokenBase: TokenCount | null = null;
      // what this turn has been charged so far, and the part of it spent
      // on a thread the turn has since left, which a new thread's count
      // carries on from rather than replacing
      let spent: TokenCount = { input: 0, output: 0 };
      let carried: TokenCount = { input: 0, output: 0 };
      // threads this turn gave up on reopening (see onAgentNotification)
      const abandoned = new Set<string>();
      // the files each change item touches, for its approval (requestInput)
      const itemPaths = new Map<string, string[]>();
      // set once turn/start goes out; usage reported before it is history
      let turnSent = false;
      // Codex's own names for the conversation and the turn running in it,
      // which turn/steer has to quote back
      let codexThread: string | null = null;
      let codexTurn: string | null = null;
      // the thread's latest request, for what a compaction started from
      let lastUsed: number | null = null;
      // set while a compaction asked for before the turn is running, and
      // called with whether it worked when it ends
      let compacting: ((ok: boolean) => void) | null = null;
      let compactError: string | null = null;
      // A process requests at most one compaction. Keep its native turn
      // id after the wait ends, so late item frames still belong to it.
      let requestedCompaction: string | null = null;
      const compactionStarts = new Map<string, number | null>();
      const compactionDone = new Set<string>();
      // requests whose frames stay out of the native copy: the skills
      // menu, whose paths stay on the server, and the person's Codex
      // settings, which can hold keys of their own
      const quietCalls = new Set<unknown>();
      const skillNamesSent = new Set<string>();

      const abort = () => {
        try {
          process.kill(-child.pid!, "SIGTERM");
        } catch {
          try {
            child.kill("SIGTERM");
          } catch {
            /* already gone */
          }
        }
      };

      const rpc = attachRpc({
        stdin: child.stdin,
        stdout: child.stdout,
        onFrame: (msg, dir) => {
          if (dir === "out" && (msg.method === "skills/list" || msg.method === "config/read")) { quietCalls.add(msg.id); return; }
          if (dir === "in" && !msg.method && quietCalls.has(msg.id)) { quietCalls.delete(msg.id); return; }
          if (msg.method === "skills/changed") return;
          appendNative(threadId, { dir, source: NATIVE_SOURCE, msg: dir === "out" ? withoutServerValues(msg) : msg }, undefined, hiddenTokens);
        },
        onRequest: (msg) => onAgentRequest(msg),
        onNotify: (msg) => onAgentNotification(msg),
      });

      const finish = (ok: boolean, stopReason: string | null, preInputRefusal?: CodexSpeedRefusal) => {
        if (finished) return;
        finished = true;
        compacting?.(false);
        for (const answer of [...asks.values()]) answer("deny", "Bloks: the turn ended", "turn-ended");
        rpc.failPending(new Error("turn settled"));
        running.delete(threadId);
        emit({ ...envelope(threadId, turnId), type: "turn.completed", ok, stopReason, cost: null, ...(preInputRefusal ? { preInputRefusal } : {}) });
        abort();
      };

      // ── the agent asking us something ──
      function onAgentRequest(msg: any) {
        const method = String(msg.method ?? "");
        const params = msg.params ?? {};
        const legacy = LEGACY_APPROVAL_METHODS.has(method);
        const isQuestion = method === QUESTION_METHOD;
        const isMcp = method === MCP_ELICITATION_METHOD;
        const tool = toolOf(method, params);

        // MCP tool approval is an empty form. Other elicitations need a
        // form/URL UI; an Allow button cannot supply their requested data.
        if (isMcp && !(
          params.mode === "form" &&
          params.requestedSchema?.type === "object" &&
          Object.keys(params.requestedSchema.properties ?? {}).length === 0 &&
          (params.requestedSchema.required ?? []).length === 0
        )) {
          rpc.reply(msg.id, { action: "cancel", content: null, _meta: null });
          emit({
            ...envelope(threadId, turnId),
            type: "runtime.error",
            message: "Bloks cannot display this MCP input form or URL confirmation yet. The request was cancelled.",
          });
          return;
        }

        const permissionReply = (allowed: boolean, source: string) =>
          isMcp
            ? {
                action: allowed ? "accept" : source === "user" ? "decline" : "cancel",
                content: allowed ? {} : null,
                _meta: null,
              }
            : { decision: allowed ? (legacy ? "approved" : "accept") : legacy ? "denied" : "decline" };

        const requestId = newId();
        const logDecision = (stage: string, behavior?: string, source?: string) =>
          appendNative(threadId, {
            dir: "out",
            source: "bloks.approval",
            msg: {
              stage, requestId, rpcRequestId: msg.id, method, threadId, turnId,
              providerThreadId: params.threadId, providerTurnId: params.turnId, behavior, source,
            },
          });
        logDecision("opened");

        // fullAuto, or an agent in full access, waives approvals but never
        // questions: a question has no safe automatic answer, only a less
        // useful one. A turn the owner did not vouch for asks anyway.
        if (((config.fullAuto && !turn.untrusted) || turn.fullAccess) && !isQuestion) {
          logDecision("resolved", "allow", "auto");
          return rpc.reply(msg.id, permissionReply(true, "auto"));
        }

        const answer: Answer = (behavior, message, source = "user", reply = true) => {
          if (!asks.delete(requestId)) return;
          rpcAsks.delete(msg.id);
          clearTimeout(timer);
          logDecision("resolved", behavior, source);

          if (reply && isQuestion) {
            // Each sub-question is answered by id; we put the same text
            // against all of them, since the card asked as one thing.
            const answers: Record<string, { answers: string[] }> = {};
            for (const q of Array.isArray(params.questions) ? params.questions : []) {
              answers[q.id] = { answers: [message || UNANSWERED_QUESTION] };
            }
            rpc.reply(msg.id, { answers });
          } else if (reply) {
            const allowed = behavior === "allow";
            rpc.reply(msg.id, permissionReply(allowed, source));
          }

          emit({
            ...envelope(threadId, turnId),
            type: "request.resolved",
            requestId,
            behavior,
            source,
          });
        };

        const timer = setTimeout(() => {
          if (isQuestion) answer("answer", UNANSWERED_QUESTION, "timeout");
          else answer("deny", UNANSWERED_PERMISSION, "timeout");
          if (isMcp) emit({
            ...envelope(threadId, turnId),
            type: "runtime.error",
            message: "The MCP approval timed out. Bloks cancelled the request because no answer arrived in time.",
          });
        }, ASK_TIMEOUT_MS);
        timer.unref?.();

        asks.set(requestId, answer);
        rpcAsks.set(msg.id, { requestId, providerThreadId: params.threadId });
        emit({
          ...envelope(threadId, turnId),
          type: "request.opened",
          requestId,
          requestType: isQuestion ? "question" : "permission",
          tool,
          ...(isQuestion || isMcp ? {} : { input: requestInput(params, itemPaths) }),
          summary: summarise(params, tool),
          choices: isQuestion
            ? (params.questions?.[0]?.options ?? []).map((o: any) => o.label).slice(0, 5)
            : undefined,
        });
      }

      // An async question's card. Nothing here waits on it and nothing
      // times it out: the agent is working on, and the card is open until
      // somebody answers or puts it aside, or Bloks stops.
      function askAsync(params: any, question: { summary: string; choices: string[] }) {
        const item = params.item;
        const said = typeof item.id === "string" && item.id ? item.id : question.summary;
        const key = JSON.stringify([threadId, typeof params.turnId === "string" ? params.turnId : "", said]);
        if (asyncSeen.has(key)) return;
        asyncSeen.add(key);
        while (asyncSeen.size > MAX_ASYNC_SEEN) asyncSeen.delete(asyncSeen.keys().next().value!);
        const requestId = newId();
        asyncAsks.set(requestId, { threadId, turnId });
        appendNative(threadId, {
          dir: "out",
          source: "bloks.approval",
          msg: {
            stage: "opened", requestId, method: "request_user_input_async", threadId, turnId,
            providerThreadId: params.threadId, providerTurnId: params.turnId, itemId: item.id,
          },
        });
        emit({
          ...envelope(threadId, turnId),
          type: "request.opened",
          requestId,
          requestType: "question",
          tool: "ask_user",
          summary: question.summary,
          choices: question.choices,
          async: true,
        });
        // One nobody ever answers is let go of, the oldest first, and its
        // card says it closed rather than staying open for good.
        while (asyncAsks.size > MAX_ASYNC_ASKS) {
          const [oldest, asked] = asyncAsks.entries().next().value!;
          asyncAsks.delete(oldest);
          emit({ ...envelope(asked.threadId, asked.turnId), type: "request.resolved", requestId: oldest, behavior: "deny", source: "engine" });
        }
      }

      // News of a thread other than the one this turn is in. Before the
      // turn knows its thread, or from an app-server that does not say
      // which thread it means, nothing counts as elsewhere.
      const elsewhere = (params: any) =>
        typeof params.threadId === "string" && codexThread !== null && params.threadId !== codexThread;

      type ContextReading = ReturnType<typeof contextReading>;
      // A reply and usage can share one stdout chunk, before the await
      // that selects codexThread runs. Keep bounded numeric summaries,
      // never guess which thread is the parent. The first positive used
      // resolves a pending marker; merged fields retain partial updates.
      const openingReadings = new Map<string, { first: ContextReading | null; latest: ContextReading }>();
      function applyReading(reading: ContextReading) {
        if (reading.used !== null) lastUsed = reading.used;
        if (!compacting && (reading.used !== null || reading.window !== null)) {
          emit({ ...envelope(threadId, turnId), type: "context.reading", ...reading });
        }
      }
      function noteContext(params: any) {
        const id = params.threadId;
        if (typeof id !== "string" || !id || id.length > 256 || /[\x00-\x1f\x7f]/.test(id)) return;
        const reading = contextReading(params.tokenUsage);
        if (reading.used === null && reading.window === null) return;
        if (codexThread !== null) {
          if (id === codexThread) applyReading(reading);
          return;
        }
        const was = openingReadings.get(id);
        // At capacity, an already-admitted parent keeps its updates. A
        // parent first seen later is unknown until selection, not a child.
        if (!was && openingReadings.size >= 64) return;
        const latest = { used: reading.used ?? was?.latest.used ?? null, window: reading.window ?? was?.latest.window ?? null };
        openingReadings.set(id, { first: was?.first ?? (reading.used !== null ? { ...latest } : null), latest });
      }
      let sessionAnnounced = false;
      function announceSession(model: string | null) {
        if (sessionAnnounced) return;
        sessionAnnounced = true;
        // Bind the server's cursor before a buffered request can resolve
        // a marker belonging to the session this turn just replaced.
        emit({
          ...envelope(threadId, turnId),
          type: "session.started",
          sessionId: codexThread,
          model: model ?? turn.model ?? null,
        });
      }
      function takeOpeningReadings(model: string | null) {
        lastUsed = null;
        const pending = codexThread ? openingReadings.get(codexThread) : undefined;
        openingReadings.clear();
        if (pending) announceSession(model);
        if (pending?.first) applyReading(pending.first);
        if (pending && (!pending.first || pending.latest.used !== pending.first.used || pending.latest.window !== pending.first.window)) applyReading(pending.latest);
      }

      // ── the agent narrating what it is doing ──
      function compactionItem(params: any, completed: boolean) {
        const item = params.item;
        if (params.threadId !== codexThread || typeof params.turnId !== "string" || typeof item?.id !== "string" || !params.turnId || !item.id || params.turnId.length > 256 || item.id.length > 256 || /[\x00-\x1f\x7f]/.test(params.turnId + item.id)) return;
        const key = `${params.turnId}\0${item.id}`;
        if (compactionDone.has(key)) return;
        if (!completed) {
          if (!compactionStarts.has(key) && compactionStarts.size < 256) compactionStarts.set(key, lastUsed);
          return;
        }
        // Bounded for a hostile stream; never forget a completed id and
        // mistake its replay for another operation in this process.
        const before = compactionStarts.has(key) ? compactionStarts.get(key)! : lastUsed;
        compactionStarts.delete(key);
        if (compactionDone.size >= 256) return;
        compactionDone.add(key);
        if (params.turnId === requestedCompaction) return;
        emit({ ...envelope(threadId, turnId), type: "context.compacted", trigger: "auto", before, after: null });
      }

      function onAgentNotification(msg: any) {
        if (finished) return;
        const params = msg.params ?? {};
        // A resume that ran out of time can still be answered, late, on
        // this same process, along with that old thread's restored usage.
        // Read as this turn's, its total became the baseline and the new
        // thread's turn reported nothing at all (GitHub 230).
        if (typeof params.threadId === "string" && abandoned.has(params.threadId)) return;

        switch (msg.method) {
          case "skills/changed": skillCatalogs.clear(); break;
          case "serverRequest/resolved": {
            const pending = rpcAsks.get(params.requestId);
            if (pending && pending.providerThreadId === params.threadId) {
              asks.get(pending.requestId)?.("deny", "Bloks: the request closed", "engine", false);
            }
            break;
          }
          case "item/started": {
            const item = params.item ?? {};
            if (item.type === "contextCompaction") { compactionItem(params, false); break; }
            const label = toolLabel(item);
            if (!label) break;
            // a patch names every file it touches, a rename both ends
            const paths =
              item.type === "fileChange" && Array.isArray(item.changes)
                ? item.changes.flatMap((c: any) => [c?.path, c?.kind?.move_path].filter((p) => typeof p === "string" && p))
                : [];
            // kept for the approval the change may ask for next
            if (paths.length && typeof item.id === "string") itemPaths.set(item.id, paths);
            const signature = codexSignature(item);
            emit({
              ...envelope(threadId, turnId),
              type: "item.started",
              itemType: "tool",
              itemId: item.id,
              title: label,
              ...(item.type === "commandExecution" && typeof item.command === "string" ? { command: item.command } : {}),
              ...(paths.length ? { paths } : {}),
              // a command writes what it writes, and says nothing of it
              ...(item.type === "commandExecution" ? { mayWrite: true } : {}),
              ...(signature ? { signature } : {}),
            });
            break;
          }

          case "item/completed": {
            const item = params.item ?? {};
            if (item.type === "contextCompaction") { compactionItem(params, true); break; }
            if (item.type === "agentMessage") {
              if (elsewhere(params)) break;
              // A question, card only, as a blocking one is: its text is
              // the same question written out, and said as well it would
              // read as a reply to be answered by typing.
              const question = asyncQuestion(item);
              if (question) {
                askAsync(params, question);
                break;
              }
              if (!item.text?.trim()) break;
              // read once, so the streamed text and the stored text agree
              const codexItem = codexItemText(item);
              emit({
                ...envelope(threadId, turnId),
                itemId: typeof item.id === "string" ? item.id : undefined,
                codexItem,
                type: "content.delta",
                streamKind: "assistant_text",
                delta: item.text,
              });
              emit({
                ...envelope(threadId, turnId),
                itemId: typeof item.id === "string" ? item.id : undefined,
                codexItem,
                type: "item.completed",
                itemType: "assistant_text",
                ...(item.phase === "commentary" || item.phase === "final_answer" ? { replyPhase: item.phase } : {}),
                text: item.text,
              });
            } else if (TOOL_ITEM_TYPES.has(item.type)) {
              emit({
                ...envelope(threadId, turnId),
                type: "item.completed",
                itemType: "tool",
                itemId: item.id,
                // declined is a real outcome, not a crash, but it did not
                // succeed either
                ok: item.status !== "failed" && item.status !== "declined",
              });
            } else if (item.type === "reasoning") {
              emit({
                ...envelope(threadId, turnId),
                type: "item.updated",
                itemType: "reasoning",
                tokens: null,
              });
            }
            break;
          }

          case "thread/tokenUsage/updated": {
            // How full the thread is: the latest request, not the turn's
            // sum, against the window Codex says it is using now, which
            // changes between turns of one thread (GitHub 224). Not while
            // compacting, when the latest request is the compaction
            // reading the old context, about to be replaced.
            noteContext(params);
            const total = tokenCount(params.tokenUsage?.total);
            if (!total) break;
            const thread = typeof params.threadId === "string" ? params.threadId : null;
            if (!turnSent) {
              // what a resumed thread had already spent, not this turn's
              tokenBase = total;
              if (thread) rememberTotal(thread, total);
              break;
            }
            tokenBase ??= turnBaseline(
              thread ? threadTotals.get(thread) : undefined,
              total,
              tokenCount(params.tokenUsage?.last),
            );
            if (thread) rememberTotal(thread, total);
            // Each update restates the total, so a repeated one changes
            // nothing here, where summing `last` would count it twice.
            spent = {
              input: carried.input + Math.max(0, total.input - tokenBase.input),
              output: carried.output + Math.max(0, total.output - tokenBase.output),
            };
            emit({ ...envelope(threadId, turnId), type: "thread.token-usage.updated", ...spent });
            break;
          }

          case "account/rateLimits/updated": {
            // about the account, not this thread, so nothing is elsewhere
            plan = codexPlanUsage(params.rateLimits) ?? plan;
            break;
          }

          case "turn/started": {
            if (elsewhere(params)) break;
            if (typeof params.turn?.id === "string") {
              codexTurn = params.turn.id;
              if (compacting && params.threadId === codexThread) requestedCompaction = params.turn.id;
            }
            break;
          }

          case "turn/completed": {
            if (stopping) break;
            // Only the thread the turn is in can end it. Another one
            // ending (a compaction left behind) said the person's turn
            // was done while it was still working, and the process was
            // killed under it (GitHub 234).
            if (elsewhere(params)) break;
            const completed = params.turn ?? {};
            const ok = completed.status === "completed";
            if (!compacting && requestedCompaction && completed.id === requestedCompaction) break;
            // the compaction runs as a turn of its own, and its end is
            // where the person's words go, not the end of this one
            if (compacting) {
              if (!ok) compactError = completed.error?.message ?? "Codex could not compact this conversation.";
              compacting(ok);
              break;
            }
            finish(ok, ok ? null : hide(completed.error?.message ?? completed.status ?? "failed"));
            break;
          }

          case "error": {
            if (stopping) break;
            // The app-server nests the text (`error.message`); older ones
            // had it at the top. One it is about to retry is not the end
            // of the turn, so only the last one is said. A compaction that
            // fails is not the turn failing: a new thread takes the words.
            const message = hide(params.error?.message ?? params.message);
            if (compacting) {
              if (turn.compactOnly && params.willRetry !== true) {
                compactError = typeof message === "string" ? message : "Codex could not compact this conversation.";
                compacting(false);
              }
              break;
            }
            if (typeof message === "string" && message.trim() && params.willRetry !== true) {
              emit({ ...envelope(threadId, turnId), type: "runtime.error", message });
            }
            break;
          }
        }
      }

      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
        if (stderr.length > 8192) stderr = stderr.slice(-8192);
      });

      child.on("error", (error) => {
        emit({
          ...envelope(threadId, turnId),
          type: "runtime.error",
          message: describeSpawnError(error, {
            name: "Codex",
            command: config.cli,
            install: "npm i -g --prefix ~/.local @openai/codex",
            signIn: "run `codex login`",
          }),
        });
        finish(false, "spawn_error");
      });

      child.on("close", (code) => {
        if (finished) return;
        if (stopping) return finish(false, "interrupted");
        emit({
          ...envelope(threadId, turnId),
          type: "runtime.error",
          message: describeEarlyExit(code, hide(stderr), { name: "Codex", signIn: "run `codex login`" }),
        });
        finish(false, "exit_before_result");
      });

      const selectedSkills = async (names?: string[]): Promise<CodexSkill[]> => {
        if (!names?.length) return [];
        try {
          const cwd = turn.cwd ?? homedir();
          const listed = readCodexSkills(await within(rpc.request("skills/list", { cwds: [cwd], forceReload: true }), "listing skills", "Codex", PROBE_TIMEOUT_MS), cwd) ?? [];
          return [...new Set(names)].filter((name) => !skillNamesSent.has(name)).flatMap((name) => listed.find((skill) => skill.name === name) ?? []).slice(0, Math.max(0, MAX_CODEX_SKILL_ITEMS - skillNamesSent.size));
        } catch {
          // The unchanged dollar words remain Codex's own fallback.
          return [];
        }
      };
      // Codex checks expectedTurnId against the turn it is running and
      // refuses the call if that turn has ended, so a refusal means the
      // words were not taken and can go to the next turn instead.
      const canSteer = () => Boolean(!finished && !compacting && codexThread && codexTurn && ![...compactionStarts.keys()].some((key) => requestedCompaction === null || !key.startsWith(`${requestedCompaction}\0`)));
      const steer = async (text: string, options?: { skillNames?: string[]; onAccepted?: (turnId: string) => void; onDispatch?: () => void }) => {
        // during a compaction the turn running is the compaction's
        if (!canSteer()) return false;
        const skills = await selectedSkills(options?.skillNames);
        if (!canSteer()) return false;
        for (const skill of skills) skillNamesSent.add(skill.name);
        try {
          const expectedTurnId = codexTurn;
          const accepted = await rpc.request("turn/steer", { threadId: codexThread, expectedTurnId, input: [{ type: "text", text }, ...skills.map(({ name, path }) => ({ type: "skill", name, path }))] }, options?.onDispatch);
          // A successful RPC may have consumed the words even if its receipt
          // cannot verify the join identity. Do not queue them for replay.
          if ((accepted as { turnId?: unknown } | null)?.turnId === expectedTurnId) options?.onAccepted?.(turnId);
          return true;
        } catch (error) {
          for (const skill of skills) skillNamesSent.delete(skill.name);
          // An error reply is Codex answering no: the turn it names has
          // ended, so the words were not taken and wait for the next one,
          // reserved report or not. Anything else (the pipe closing, the
          // turn torn down while we waited) leaves it unknown whether the
          // words arrived, and a reserved report must not go twice.
          if (options?.onDispatch && !(error instanceof RpcResponseError)) throw error;
          return false;
        }
      };

      running.set(threadId, { turnId, abort: turn.compactOnly ? () => {
        if (finished) return;
        emit({ ...envelope(threadId, turnId), type: "runtime.error", message: "Compaction was stopped." });
        finish(false, "interrupted");
      } : () => {
        // finish also aborts for cleanup, which is not a requested stop.
        stopping = true;
        abort();
      }, steer, asks });
      emit({ ...envelope(threadId, turnId), type: "turn.started" });

      // Handshake and kickoff. Anything that goes wrong in here has to end
      // the turn: a refused handshake would otherwise leave the composer
      // locked against a process that is never going to answer.
      void (async () => {
        try {
          await within(rpc.request("initialize", { clientInfo: { name: "bloks", version: "1" } }), "starting up", "Codex");
          rpc.notify("initialized", {});

          const cursor = typeof turn.resumeCursor === "string" ? turn.resumeCursor : null;
          if (turn.compactOnly && !cursor) throw new Error("There is no Codex conversation to compact yet.");
          let reportedModel: string | null = null;
          // the tier Codex said it set up, for the running turn's status
          let configuredTier: string | null = null;
          // the words go into the thread the cursor named, not a new one
          let carriedOn = false;
          // fullAuto is the engine set that way; fullAccess is this agent.
          // Either takes the sandbox off and stops Codex asking. Stated on
          // resume too, so switching an agent's mode takes on its next turn.
          // A turn the owner did not vouch for keeps both, however set.
          const full = (config.fullAuto && !turn.untrusted) || Boolean(turn.fullAccess);
          const guard = {
            sandbox: full ? "danger-full-access" : "workspace-write",
            approvalPolicy: full ? "never" : "on-request",
          };

          // The bloks command for the shell (shellConfig above), with the
          // person's include_only as Codex reads it where the thread runs.
          // A Codex that cannot say still gets the `set` entries, which are
          // all that a policy without that list needs. The same read names
          // the person's own MCP servers, which the agent's keep clear of.
          let shell = shellConfig(turn.env);
          // Working elsewhere, each of the agent's servers is reached
          // through the gate, so its command runs here and its key is added
          // here; Codex there is handed only the address.
          const attached = (turn.integrations?.mcpServers ?? []).flatMap((server) => {
            if (!turn.place) return [server];
            const reached = turn.place.mcp(server.name ?? "server", server);
            return reached ? [{ name: server.name, transport: "http" as const, url: reached.url, headers: reached.headers }] : [];
          });
          let theirs: string[] = [];
          if (shell || attached.length) {
            try {
              const read: any = await within(rpc.request("config/read", { cwd: turn.cwd ?? homedir() }), "reading its settings", "Codex", PROBE_TIMEOUT_MS);
              if (shell) shell = shellConfig(turn.env, read?.config?.shell_environment_policy?.include_only);
              const listed = read?.config?.mcp_servers;
              if (listed && typeof listed === "object") theirs = Object.keys(listed);
            } catch {
              /* the set entries alone, and the names as they come */
            }
          }
          const own = serverConfig(attached, { approve: !turn.untrusted && !turn.shared, taken: theirs });
          hiddenTokens.push(...own.secrets);
          let servers: Record<string, unknown> | null = Object.keys(own.config).length || Object.keys(bridgesThere).length ? { ...bridgesThere, ...own.config } : null;
          // A server Codex cannot be handed is said, not dropped without a
          // word: once in the conversation, and again when what is left
          // out changes, not on every turn.
          const leftOut = own.leftOut.join("\n");
          if (!leftOut) toldLeftOut.delete(threadId);
          else if (toldLeftOut.get(threadId) !== leftOut) {
            toldLeftOut.set(threadId, leftOut);
            emit({ ...envelope(threadId, turnId), type: "runtime.error", message: leftOutNotice(own.leftOut) });
          }
          // Codex's goals off (GOALS_OFF), dropped only by a Codex that
          // takes no thread config at all
          let goals: Record<string, unknown> | null = GOALS_OFF;
          const threadConfig = () => (shell || servers || goals ? { ...goals, ...shell, ...servers } : null);

          // A Codex that will not take that config still gets its thread,
          // without the part it refused, and the conversation is told once
          // why: that the bloks command may not reach the agent's commands,
          // rather than left to find out from a command that did nothing
          // and said so to nobody (GitHub 336), or that the agent's MCP
          // servers are not there (GitHub 358). Each part goes at most
          // once, so this asks three times at the very most.
          const configOrNot = async <T>(params: Record<string, unknown>, ask: () => Promise<T>): Promise<T> => {
            let shellDropped = false;
            let serversDropped = false;
            for (;;) {
              try {
                const answer = await ask();
                if (shellDropped && !toldShellRefused.has(threadId)) {
                  toldShellRefused.add(threadId);
                  emit({ ...envelope(threadId, turnId), type: "runtime.error", message: SHELL_REFUSED_NOTICE });
                }
                if (serversDropped && !toldServersRefused.has(threadId)) {
                  toldServersRefused.add(threadId);
                  emit({ ...envelope(threadId, turnId), type: "runtime.error", message: SERVERS_REFUSED_NOTICE });
                }
                return answer;
              } catch (error) {
                const said = String((error as Error)?.message ?? "");
                const all = CONFIG_REFUSED.test(said);
                const shellOut = Boolean(shell) && (all || SHELL_REFUSED.test(said));
                const serversOut = Boolean(servers) && (all || SERVERS_REFUSED.test(said));
                const goalsOut = Boolean(goals) && all;
                if (!params.config || (!shellOut && !serversOut && !goalsOut)) throw error;
                if (goalsOut) goals = null;
                if (shellOut) {
                  shell = null;
                  shellDropped = true;
                }
                if (serversOut) {
                  servers = null;
                  serversDropped = true;
                }
                const config = threadConfig();
                if (config) params.config = config;
                else delete params.config;
              }
            }
          };

          // A thread from before Bloks is carried on in a fork of it, so
          // the person's own rollout file is never written. A Codex that
          // cannot fork it gets a new thread told the story instead, the
          // way a thread it has forgotten does: never the thread itself.
          let target = cursor;
          if (cursor && turn.forkFrom === cursor && !turn.compactOnly) {
            let forked: any = null;
            // A fork is running once it answers, and a resume of a running
            // thread rejoins it as it is, so the fork itself carries the
            // shell's config and the servers: the resume after it could not.
            const forkConfig = threadConfig();
            const forkParams: Record<string, unknown> = { threadId: cursor, ...(forkConfig ? { config: forkConfig } : {}) };
            try {
              forked = await configOrNot(forkParams, () => within(rpc.request("thread/fork", forkParams), "copying the conversation", "Codex"));
            } catch {
              forked = null;
            }
            const id = typeof forked?.thread?.id === "string" ? forked.thread.id : null;
            target = id && id !== cursor ? id : null;
            if (!target) abandoned.add(cursor);
          }

          if (target) {
            // The picked model is stated on resume too. Without it a thread
            // keeps the model and the provider it started with, so a model
            // picked later never reached Codex. With it, Codex serves the
            // model from its configured provider, as it does a new thread.
            // excludeTurns: only the thread's state, not its history.
            // Bloks reads the id and the model from the answer, and the
            // history of a long thread is tens of megabytes on one line,
            // which took long enough to read that the resume timed out
            // and the agent lost its session (GitHub 230).
            const resumeParams: Record<string, unknown> = { threadId: target, ...guard, excludeTurns: true };
            if (turn.model) resumeParams.model = turn.model;
            // Standard says nothing about the tier, as before there was a
            // choice; only Fast is asked for, and checked.
            if (fast) resumeParams.serviceTier = FAST_TIER;
            // this turn's credential, not the one the thread started with,
            // and the servers attached to the agent now
            const resumeConfig = threadConfig();
            if (resumeConfig) resumeParams.config = resumeConfig;
            const resume = () => configOrNot(resumeParams, () => within(rpc.request("thread/resume", resumeParams), "reopening the conversation", "Codex"));
            try {
              let resumed: any;
              try {
                resumed = await resume();
              } catch (error) {
                // A Codex that cannot take the tier cannot run Fast, here
                // or in a fresh thread, so the turn is refused, unsent.
                const refused = fast ? fastRefusal(error) : null;
                if (refused) throw refused;
                // an app-server older than the field says so; it still
                // resumes, just with the history in the answer
                if (!/exclude_?turns|unknown field/i.test(String((error as Error)?.message ?? ""))) throw error;
                delete resumeParams.excludeTurns;
                resumed = await resume();
              }
              if (fast) requireFastTier(resumed);
              if (typeof resumed?.serviceTier === "string") configuredTier = resumed.serviceTier;
              codexThread = resumed?.thread?.id ?? target;
              if (turn.compactOnly && (typeof resumed?.thread?.id !== "string" || codexThread !== cursor)) throw new Error("That Codex conversation is no longer available to compact.");
              reportedModel = resumed?.model ?? null;
              carriedOn = true;
              takeOpeningReadings(reportedModel);
              // A goal set before its goals were turned off would still
              // be there, waiting. Clearing it is all it needs; a Codex
              // without the method, or with goals off for good, says no,
              // and then there is nothing to clear.
              if (goals && codexThread && !goalsCleared.has(codexThread)) {
                goalsCleared.add(codexThread);
                try {
                  await within(rpc.request("thread/goal/clear", { threadId: codexThread }), "clearing its goal", "Codex", PROBE_TIMEOUT_MS);
                } catch {
                  /* nothing to clear */
                }
              }
            } catch (error) {
              // Fast that was not had: refused, and the session kept
              if (error instanceof CodexSpeedUnavailable) throw error;
              // forgotten or unsupported; a fresh thread below. Anything
              // still to come about the old one is not about this turn.
              abandoned.add(target);
              if (turn.compactOnly) throw error;
            }
          }

          // The thread has grown past the lane's line: Codex compacts it
          // first, as a turn of its own, and the words go into the
          // compacted thread. One that cannot (an app-server without the
          // method, a compaction that fails) gets a new thread instead,
          // told the bounded story, rather than the old one at full size.
          if (codexThread && (turn.compactFirst || turn.compactOnly)) {
            // what the compaction spends is this turn's, not history
            turnSent = true;
            const before = lastUsed;
            const thread: string = codexThread;
            let timedOut = false;
            const ok = await new Promise<boolean>((resolve) => {
              const timer = setTimeout(() => {
                timedOut = true;
                compactError = "Codex compaction timed out.";
                compacting?.(false);
              }, COMPACT_LIMIT_MS);
              timer.unref?.();
              compacting = (worked) => {
                compacting = null;
                clearTimeout(timer);
                resolve(worked);
              };
              rpc.request("thread/compact/start", { threadId: thread }).catch((error) => {
                compactError = error instanceof Error ? error.message : "Codex could not compact this conversation.";
                compacting?.(false);
              });
            });
            const compaction = codexTurn;
            codexTurn = null;
            if (finished) return;
            if (ok) {
              emit({ ...envelope(threadId, turnId), type: "context.compacted", trigger: "manual", before, after: null });
              if (turn.compactOnly) { finish(true, null); return; }
            } else {
              if (turn.compactOnly) throw new Error(compactError ?? "Codex could not compact this conversation.");
              // A compaction past the limit is still running in this same
              // process, and finishes minutes later on the thread left
              // behind. Its end, its usage and its reading are not this
              // turn's, so the thread is let go of as a failed resume is,
              // and the compaction is asked to stop rather than spend on
              // a thread nobody will use.
              abandoned.add(thread);
              if (timedOut && compaction) {
                rpc.request("turn/interrupt", { threadId: thread, turnId: compaction }).catch(() => {});
              }
              // the new thread counts from its own start, on top of what
              // the compaction already spent
              tokenBase = null;
              carried = spent;
              codexThread = null;
              sessionAnnounced = false;
              lastUsed = null;
              openingReadings.clear();
              carriedOn = false;
              // said, since the agent loses its own history here and the
              // message has already waited for the compaction
              const why = timedOut
                ? `Codex took more than ${Math.round(COMPACT_LIMIT_MS / 60_000)} minutes to compact this conversation`
                : "Codex could not compact this conversation";
              emit({
                ...envelope(threadId, turnId),
                type: "runtime.error",
                message: `${why}, so it went to a new Codex session${turn.handoff ? ", which is told a shortened version of it" : ""}.`,
              });
            }
          }

          if (!codexThread) {
            const startParams: Record<string, unknown> = {
              cwd: turn.cwd ?? homedir(),
              model: turn.model || null,
              // full access is the user having said so explicitly; the
              // default keeps the agent inside its workspace and asking.
              ...guard,
              ephemeral: false,
            };
            if (fast) startParams.serviceTier = FAST_TIER;
            const startConfig = threadConfig();
            if (startConfig) startParams.config = startConfig;
            let started: any;
            try {
              started = await configOrNot(startParams, () => within(rpc.request("thread/start", startParams), "opening a conversation", "Codex"));
            } catch (error) {
              throw (fast ? fastRefusal(error) : null) ?? error;
            }
            if (fast) requireFastTier(started);
            if (typeof started?.serviceTier === "string") configuredTier = started.serviceTier;
            codexThread = started?.thread?.id ?? null;
            reportedModel = started?.model ?? null;
            takeOpeningReadings(reportedModel);
          }

          announceSession(reportedModel);
          emit({ ...envelope(threadId, turnId), type: "codex.speed", choice: speedChoice, configuredTier, actualTier: null });

          turnSent = true;
          // A cursor that did not lead back to its thread is a new thread
          // after all, and is told the story rather than only the words.
          const words = cursor && !carriedOn && turn.handoff ? turn.handoff : turn.text;
          const skills = await selectedSkills(turn.skillNames);
          if (finished) return;
          for (const skill of skills) skillNamesSent.add(skill.name);
          const turnParams: Record<string, unknown> = {
            threadId: codexThread,
            input: [
              { type: "text", text: turn.system ? `${turn.system}\n\n${words}` : words },
              ...skills.map(({ name, path }) => ({ type: "skill", name, path })),
            ],
          };
          // Effort is a turn/start input, not thread/start.reasoningEffort
          // (a response field). Stating it every turn covers resumes too.
          if (turn.effort) turnParams.effort = turn.effort;
          let begun: any;
          try {
            begun = await within(rpc.request("turn/start", turnParams), "starting the turn", "Codex");
          } catch (error) {
            // An older app-server refusing the field costs the preference,
            // not the message. Other failures must not submit the words twice.
            if (finished || stopping || !turn.effort || !/effort|unknown field/i.test(String((error as Error)?.message ?? ""))) throw error;
            delete turnParams.effort;
            begun = await within(rpc.request("turn/start", turnParams), "starting the turn", "Codex");
          }
          if (typeof begun?.turn?.id === "string") codexTurn ??= begun.turn.id;
        } catch (error) {
          if (finished || stopping) return;
          // Fast refused before the words went in: the message is unsent,
          // and recovery treats it as that, not as an engine failing
          const refusal = error instanceof CodexSpeedUnavailable ? { ...error.refusal, reason: hide(error.refusal.reason) } : undefined;
          emit({
            ...envelope(threadId, turnId),
            type: "runtime.error",
            message: hide((error as Error).message),
            ...(refusal ? { preInputRefusal: refusal } : {}),
          });
          finish(false, "rpc_error", refusal);
        }
      })();

      return { turnId };
    };

    const snapshot = async (): Promise<ProviderSnapshot> => {
      const version = await new Promise<string | null>((resolve) => {
        execFile(config.cli, ["--version"], { timeout: 8_000, windowsHide: true }, (error, stdout) =>
          resolve(error ? null : stdout.trim()),
        );
      });
      if (!version) return { state: "unavailable", reason: `\`${config.cli}\` CLI not found` };
      // Installed is not signed in, and the gap between them is the first
      // message failing. `codex login status` answers with its exit code;
      // a CLI too old to know the subcommand falls back to the file its
      // login writes, and a key in the environment counts as signed in.
      const authenticated = await new Promise<boolean>((resolve) => {
        if (process.env.OPENAI_API_KEY) return resolve(true);
        execFile(config.cli, ["login", "status"], { timeout: 8_000, windowsHide: true }, (error, stdout, stderr) => {
          if (!error) return resolve(true);
          const said = `${stdout}\n${stderr}`;
          if (/not logged in|logged out/i.test(said)) return resolve(false);
          resolve(existsSync(join(process.env.CODEX_HOME || join(homedir(), ".codex"), "auth.json")));
        });
      });
      return { state: "available", version, authenticated };
    };

    return {
      instanceId,
      driverKind: DRIVER_KIND,
      displayName: input.displayName,
      enabled: input.enabled,
      models,
      snapshot,
      catalogReady,
      skills,
      planUsage: () => plan,

      adapter: {
        provider: DRIVER_KIND,
        capabilities: { sessionModelSwitch: "unsupported", compactsFirst: true, efforts: CODEX_EFFORTS },
        sendTurn,

        steerTurn: async (threadId, text, options) => (await running.get(threadId)?.steer(text, options)) ?? false,

        interruptTurn: async (threadId) => running.get(threadId)?.abort(),

        respondToRequest: async (threadId, requestId, decision) => {
          // An async question has no call to reply to. Its answer goes
          // back to the harness, to say in the conversation (the
          // contract's request.resolved answer); put aside, it is only
          // settled, since the agent already went on without it.
          const asked = asyncAsks.get(requestId);
          if (asked && asked.threadId === threadId) {
            asyncAsks.delete(requestId);
            const answer = decision.behavior === "answer" && decision.message?.trim() ? decision.message : undefined;
            appendNative(threadId, {
              dir: "out",
              source: "bloks.approval",
              msg: { stage: "resolved", requestId, method: "request_user_input_async", threadId, turnId: asked.turnId, behavior: decision.behavior, source: "user" },
            });
            emit({
              ...envelope(threadId, asked.turnId),
              type: "request.resolved",
              requestId,
              behavior: decision.behavior,
              source: "user",
              ...(answer ? { answer } : {}),
            });
            return;
          }
          const answer = running.get(threadId)?.asks.get(requestId);
          if (!answer) {
            appendNative(threadId, {
              dir: "out",
              source: "bloks.approval",
              msg: { stage: "unavailable", threadId, requestId, reason: "no matching pending request" },
            });
            throw new Error("no such pending request");
          }
          answer(decision.behavior, decision.message);
        },

        // The agent taking back a question it asked without waiting, the
        // person having settled it some other way. Only such a question,
        // in the conversation that asked it: it is settled as withdrawn,
        // with no answer, and the agent is told nothing.
        withdrawAsk: (threadId, requestId) => {
          const asked = asyncAsks.get(requestId);
          if (!asked || asked.threadId !== threadId) return false;
          asyncAsks.delete(requestId);
          appendNative(threadId, {
            dir: "out",
            source: "bloks.approval",
            msg: { stage: "resolved", requestId, method: "request_user_input_async", threadId, turnId: asked.turnId, behavior: "withdrawn", source: "agent" },
          });
          emit({ ...envelope(threadId, asked.turnId), type: "request.resolved", requestId, behavior: "withdrawn", source: "agent" });
          return true;
        },

        hasSession: (threadId) => running.has(threadId),

        stopAll: async () => {
          for (const turn of running.values()) turn.abort();
        },

        onEvent: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },

      dispose: async () => {
        skillCatalogs.clear();
        asyncAsks.clear();
        for (const turn of running.values()) turn.abort();
        listeners.clear();
        await engines.end();
      },
    };
  },
};
