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
  for (const name of SHELL_NAMES) {
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
 * or a `config` it does not know at all. */
const SHELL_REFUSED = /shell_environment_policy|unknown field `?config\b/i;

/** Said once in a conversation whose Codex would not take it. */
export const SHELL_REFUSED_NOTICE =
  "This Codex would not take the setting Bloks uses to hand its command line to the agent's shell, so it carried on without it. " +
  "Where this project's Codex config narrows shell_environment_policy, the agent's commands cannot reach Bloks. Updating Codex should fix it.";

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
    /** Conversations already told their Codex would not take the shell's
     * config (SHELL_REFUSED_NOTICE), so a lane hears it once, not every turn. */
    const toldShellRefused = new Set<string>();
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
      // back the thread config carrying it (shellConfig).
      const hiddenTokens = [turn.env?.BLOKS_TOKEN, turn.env?.BLOKS_REPLY_TOKEN].filter((value): value is string => typeof value === "string" && value.length > 0);
      const hide = <T>(text: T): T =>
        (typeof text === "string" ? hiddenTokens.reduce((safe, token) => safe.split(token).join("[redacted]"), text) : text) as T;

      let ownerReplyFolder: ReturnType<typeof makeCodexReplyFolder> | undefined;
      let replyBroker: AskBroker | undefined;

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
        appServerArgs.push("-c", `${prefix}.command=${JSON.stringify(process.execPath)}`,
          "-c", `${prefix}.args=${JSON.stringify([helper, ownerReplyFolder.socketPath])}`,
          "-c", `${prefix}.default_tools_approval_mode="approve"`,
          "-c", `${prefix}.env.ELECTRON_RUN_AS_NODE="1"`,
          "-c", `${prefix}.env.BLOKS_PUBLISH="reply_to_sender"`);
      }
      if (turn.integrations?.composio?.key) {
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
        try { return spawn(config.cli, appServerArgs, {
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
          appendNative(threadId, { dir, source: NATIVE_SOURCE, msg }, undefined, hiddenTokens);
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

      // News of a thread other than the one this turn is in. Before the
      // turn knows its thread, or from an app-server that does not say
      // which thread it means, nothing counts as elsewhere.
      const elsewhere = (params: any) =>
        typeof params.threadId === "string" && codexThread !== null && params.threadId !== codexThread;

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
            const reading = contextReading(params.tokenUsage);
            if (reading.used !== null) lastUsed = reading.used;
            if (!compacting && (reading.used !== null || reading.window !== null)) {
              emit({ ...envelope(threadId, turnId), type: "context.reading", ...reading });
            }
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
          // all that a policy without that list needs.
          let shell = shellConfig(turn.env);
          if (shell) {
            try {
              const read: any = await within(rpc.request("config/read", { cwd: turn.cwd ?? homedir() }), "reading its settings", "Codex", PROBE_TIMEOUT_MS);
              shell = shellConfig(turn.env, read?.config?.shell_environment_policy?.include_only);
            } catch {
              /* the set entries alone */
            }
          }
          // A Codex that will not take that config still gets its thread,
          // without it, and the conversation is told once why the bloks
          // command may not reach the agent's commands, rather than left
          // to find out from a command that did nothing and said so to
          // nobody (GitHub 336).
          const shellOrNot = async <T>(params: Record<string, unknown>, ask: () => Promise<T>): Promise<T> => {
            try {
              return await ask();
            } catch (error) {
              if (!params.config || !SHELL_REFUSED.test(String((error as Error)?.message ?? ""))) throw error;
              delete params.config;
              shell = null;
              const answer = await ask();
              if (!toldShellRefused.has(threadId)) {
                toldShellRefused.add(threadId);
                emit({ ...envelope(threadId, turnId), type: "runtime.error", message: SHELL_REFUSED_NOTICE });
              }
              return answer;
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
            // shell's config: the resume after it could not.
            const forkParams: Record<string, unknown> = { threadId: cursor, ...(shell ? { config: shell } : {}) };
            try {
              forked = await shellOrNot(forkParams, () => within(rpc.request("thread/fork", forkParams), "copying the conversation", "Codex"));
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
            // this turn's credential, not the one the thread started with
            if (shell) resumeParams.config = shell;
            const resume = () => shellOrNot(resumeParams, () => within(rpc.request("thread/resume", resumeParams), "reopening the conversation", "Codex"));
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
            if (shell) startParams.config = shell;
            let started: any;
            try {
              started = await shellOrNot(startParams, () => within(rpc.request("thread/start", startParams), "opening a conversation", "Codex"));
            } catch (error) {
              throw (fast ? fastRefusal(error) : null) ?? error;
            }
            if (fast) requireFastTier(started);
            if (typeof started?.serviceTier === "string") configuredTier = started.serviceTier;
            codexThread = started?.thread?.id ?? null;
            reportedModel = started?.model ?? null;
          }

          emit({
            ...envelope(threadId, turnId),
            type: "session.started",
            sessionId: codexThread,
            model: reportedModel ?? turn.model ?? null,
          });
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
        for (const turn of running.values()) turn.abort();
        listeners.clear();
        await engines.end();
      },
    };
  },
};
