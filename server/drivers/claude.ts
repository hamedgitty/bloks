// Claude Code, driven as a subprocess.
//
// The CLI is run once per turn with JSON on both ends of the pipe: the
// prompt goes in on stdin as a stream-json message, and a sequence of
// stream-json events comes back on stdout. Stdin stays open while the
// turn runs, so the person can say more and the agent reads it after the
// step it is on (GitHub 213); closing it is what lets a -p process end,
// so it is closed at the first result. Continuity across turns is the
// CLI's own `--resume`, keyed on a session id it hands us in its first
// event, which we store as the thread's resume cursor.
//
// Why per-turn rather than one long-lived process: a turn is the unit that
// can be interrupted, and a process is the only thing that reliably stops
// when told to. Killing the group at the end also reaps the MCP servers it
// spawned, which a persistent process would leak.
//
// Three MCP servers may be attached to a run, all of them ours:
//   bloks      the permission bridge, so the agent can ask the user
//   computer   the agent's cloud desktop, or this Mac
//   composio   whatever third-party accounts are connected
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { DATA_DIR } from "../config.ts";
import { lineSplitter } from "../ndjson.ts";
import { outReason } from "../failover.ts";
import { claudePlanUsage } from "../plan-usage.ts";
import { SessionCosts } from "./session-costs.ts";
import { readClaudeCommands, classifyClaudeCommands, type ClaudeCommandRow } from "../agent-commands.ts";
import { createAskBroker, summarise, type AskBroker } from "../harness/ask-broker.ts";

/** The answerable options of an ask, wherever the tool put them: a flat
 * choices list, or AskUserQuestion's nested option objects. */
/** Claude Code's own file tools, and the file each one writes. A command
 * that writes a file says nothing about it, which is the honest gap. */
const FILE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

function editedPaths(name: unknown, input: any): string[] {
  if (typeof name !== "string" || !FILE_TOOLS.has(name)) return [];
  const path = input?.file_path ?? input?.notebook_path;
  return typeof path === "string" && path ? [path] : [];
}

function askChoices(input: any): string[] | undefined {
  if (Array.isArray(input?.choices)) return (input.choices as string[]).slice(0, 5);
  const options = input?.questions?.[0]?.options;
  if (Array.isArray(options)) {
    const labels = options
      .map((o: any) => (typeof o === "string" ? o : typeof o?.label === "string" ? o.label : null))
      .filter((l: unknown): l is string => Boolean(l));
    if (labels.length) return labels.slice(0, 5);
  }
  return undefined;
}
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
import { appendNative } from "./native.ts";
import { describeEarlyExit, describeSpawnError } from "./spawn-error.ts";
import { DEFAULT_STALL_MINUTES, STOP_GRACE_MS, describeStall, isStalled, type OpenCall } from "./stall.ts";
import { OWN_GROUP } from "../no-console.ts";

/** Each session's last reported total, so a turn is charged its own share. */
const sessionCosts = new SessionCosts();

const DRIVER_KIND = "claudeAgent";

/**
 * Claude Code has no way to list the models an account can use, so this
 * list ships with Bloks and only changes with a release. Two things keep
 * it from going stale in between: the "Latest" entries are Claude Code's
 * own aliases, which always mean the newest model in that family, and any
 * other model id can be typed into the picker, since the CLI takes
 * whatever `--model` it is given. The picker says which of these it is.
 */
const MODELS: ModelCatalog = {
  default: "claude-sonnet-5",
  options: [
    { id: "claude-fable-5-1", label: "Claude Fable 5.1" },
    { id: "claude-opus-5-5", label: "Claude Opus 5.5" },
    { id: "claude-fable-5", label: "Claude Fable 5" },
    { id: "claude-opus-5", label: "Claude Opus 5" },
    { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
    { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
    { id: "opus", label: "Latest Opus" },
    { id: "sonnet", label: "Latest Sonnet" },
    { id: "haiku", label: "Latest Haiku" },
  ],
  note: "Built into this version of Bloks, not fetched: Claude Code cannot list models. The Latest entries always mean the newest model in that family, and you can type any other model id above.",
  acceptsAnyId: true,
};

/** Model used for the cheap one-shot calls (naming an agent, and similar).
 * Always the smallest one: nobody is reading it, they are reading its
 * two-line output. */
const ONE_SHOT_MODEL = "claude-haiku-4-5";

/** How long a steered turn's process may say nothing after a result
 * before that result is taken as the end. Usually the process exits
 * first; one kept alive by a background task it started would otherwise
 * hold the lane busy for as long as that task runs. */
const STEER_QUIET_MS = 30_000;

export interface ClaudeConfig {
  cli: string;
  permissionMode: "acceptEdits" | "auto" | "bypassPermissions";
}

const PERMISSION_MODES = ["acceptEdits", "auto", "bypassPermissions"] as const;

function decodeConfig(raw: unknown): ClaudeConfig {
  const source = (raw ?? {}) as Record<string, unknown>;
  const mode = source.permissionMode;

  if (mode !== undefined && !PERMISSION_MODES.includes(mode as (typeof PERMISSION_MODES)[number])) {
    throw new Error(`claude: invalid permissionMode ${JSON.stringify(mode)}`);
  }
  return {
    cli: typeof source.cli === "string" ? source.cli : "claude",
    permissionMode: (mode as ClaudeConfig["permissionMode"]) ?? "acceptEdits",
  };
}

// ── the helper processes we hand the CLI ───────────────────────────────

/** Our MCP entry points ship as TypeScript in development and as compiled
 * JavaScript inside the packaged app. Resolve whichever is actually there
 * rather than guessing from an env flag. */
function helperEntry(name: string): string {
  const asTypeScript = join(dirname(fileURLToPath(import.meta.url)), "..", `${name}.ts`);
  return existsSync(asTypeScript) ? asTypeScript : asTypeScript.replace(/\.ts$/, ".js");
}

const COMPUTER_HELPER = helperEntry("computer-proxy");
const SANDBOX_HELPER = helperEntry("sandbox-proxy");
const BROWSER_HELPER = helperEntry("browser-proxy");
const PERMISSION_HELPER = helperEntry("permission-proxy");

/** In the packaged app `process.execPath` is Electron, not node. This makes
 * it behave as plain node for anything we spawn with it, and does nothing
 * in development where it already is node. */
const RUN_AS_NODE = { ELECTRON_RUN_AS_NODE: "1" };

/** Socket path for a turn's permission bridge. Short and thread-derived:
 * unix socket paths have a length limit that full ids would risk. */
function brokerSocket(threadId: string, turnId: string) {
  const tag = threadId.replace(/[^\w-]/g, "").slice(0, 8);
  // per turn too: a finished turn's process can outlive it, and its
  // broker must not share a path with the next turn's
  const turn = turnId.replace(/[^\w-]/g, "").slice(-6);
  return join(DATA_DIR, `perm-${tag}-${turn}.sock`);
}

/** Pull readable text out of a message's content blocks. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text" && block.text)
    .map((block) => block.text)
    .join("");
}

/** A count the CLI reported, or null for anything that is not one. */
function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
}

/**
 * What a `compact_boundary` frame says happened. Claude Code puts the
 * numbers under `compact_metadata`; older builds put some of them on the
 * frame itself, so both are read. Null for any other frame.
 */
export function readCompactBoundary(frame: any): { trigger: string | null; before: number | null; after: number | null } | null {
  if (frame?.type !== "system" || frame.subtype !== "compact_boundary" || frame.parent_tool_use_id != null) return null;
  const meta = frame.compact_metadata && typeof frame.compact_metadata === "object" ? frame.compact_metadata : frame;
  return {
    trigger: typeof meta.trigger === "string" ? meta.trigger : null,
    before: count(meta.pre_tokens),
    after: count(meta.post_tokens),
  };
}

/** Everything one request sent: the new part, what was read from the
 * cache, and what was written to it. */
export function promptSize(usage: any): number {
  return (count(usage?.input_tokens) ?? 0) + (count(usage?.cache_read_input_tokens) ?? 0) + (count(usage?.cache_creation_input_tokens) ?? 0);
}

/**
 * The window of the model a turn ran on, from a result's `modelUsage`,
 * which Claude Code keys by model. A turn can use more than one (a
 * smaller model for side work), so the turn's own is looked for by the
 * name it was asked for and the name its session reported, and taken
 * alone only when there is no other. Null when it said nothing usable.
 */
export function contextWindowOf(frame: any, ...names: Array<string | null | undefined>): number | null {
  const usage = frame?.modelUsage;
  if (!usage || typeof usage !== "object") return null;
  const entries = Object.entries(usage as Record<string, any>);
  const named = names.filter((n): n is string => typeof n === "string" && n.length > 0);
  const own = entries.find(([id]) => named.includes(id)) ?? (entries.length === 1 ? entries[0] : undefined);
  const window = count(own?.[1]?.contextWindow);
  return window && window > 0 ? window : null;
}

/** Which cache lifetime a request wrote with, when it wrote at all. The
 * CLI decides this, not Bloks, so it is read off what it reports. */
export function cacheTtlOf(usage: any): "5m" | "1h" | undefined {
  const written = usage?.cache_creation;
  if ((count(written?.ephemeral_1h_input_tokens) ?? 0) > 0) return "1h";
  if ((count(written?.ephemeral_5m_input_tokens) ?? 0) > 0) return "5m";
  return undefined;
}

/**
 * Claude Code's own words when a subscription runs out, as the whole of a
 * message: "Claude AI usage limit reached|1759000000", "You've hit your
 * limit · resets 3pm (Europe/Berlin)", "5-hour limit reached ∙ resets 3pm",
 * "Weekly limit reached ∙ resets Oct 9, 3pm". The CLI can send that as an
 * ordinary reply and end the turn as a success, so the shape is what tells
 * it apart from an agent talking about limits: short, one line, and
 * starting with the notice itself.
 */
export function isLimitNotice(text: unknown): text is string {
  if (typeof text !== "string") return false;
  const said = text.trim();
  if (!said || said.length > 300 || said.includes("\n")) return false;
  return /^(?:claude(?: ai)? usage limit reached|you['’]?ve (?:hit|reached) your (?:[\w-]+ )?limit|(?:5-hour|five-hour|session|daily|weekly|opus(?: weekly)?|sonnet(?: weekly)?|usage) limit reached)\b/i.test(
    said,
  );
}

export const ClaudeDriver: ProviderDriver<ClaudeConfig> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "Claude", supportsMultipleInstances: true },
  models: MODELS,
  decodeConfig,
  defaultConfig: () => decodeConfig({}),

  async create(input: DriverCreateInput<ClaudeConfig>): Promise<ProviderInstance> {
    const { instanceId, config } = input;
    const listeners = new Set<RuntimeEventListener>();

    // Snapshot control was added in Claude Code 2.1.257. Probe before any
    // turns can start, and refresh with the normal health check after a CLI
    // update. An older or unrecognised CLI keeps its existing arguments.
    let snapshotOffSupported = false;
    const readVersion = () => new Promise<string | null>((resolve) => {
      execFile(config.cli, ["--version"], { timeout: 8_000, windowsHide: true }, (error, stdout) => {
        const version = error ? null : stdout.trim();
        const parts = version?.match(/^(\d+)\.(\d+)\.(\d+)(?:\s|$)/);
        const [major, minor, patch] = parts?.slice(1).map(Number) ?? [];
        snapshotOffSupported = major > 2 || (major === 2 && (minor > 1 || (minor === 1 && patch >= 257)));
        resolve(version);
      });
    });
    await readVersion();

    // What the plan signed in here has left, as the CLI last said, for
    // the composer's card (server/plan-usage.ts). The limits belong to
    // the account, so one for the instance, whichever turn said it.
    let plan: PlanUsage | null = null;

    interface RunningTurn {
      turnId: string;
      abort: () => void;
      /** More words for this turn, or false when it can no longer take them. */
      steer: (text: string) => boolean;
      broker?: AskBroker;
    }
    /** At most one turn per thread. A second send while one is live is a
     * caller bug, not a queue to manage. */
    const running = new Map<string, RunningTurn>();
    /** Brokers of turns that have ended while their process runs on. A
     * background task or subagent can still ask for permission after the
     * result, and its answer has to reach the broker it asked, not the
     * next turn's (which has never heard of it). Each is closed when its
     * process exits. */
    const afterTurn = new Map<string, Set<AskBroker>>();

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
      if (running.has(threadId)) throw new Error("a turn is already running on this thread");

      const turnId = newId();
      const resume = typeof turn.resumeCursor === "string" ? turn.resumeCursor : null;

      // Tool calls the engine has started and not yet reported back on,
      // whether somebody is being asked something, and when the engine
      // last said anything at all: what tells a silent call from work
      // (GitHub 146). See stall.ts.
      const openCalls = new Map<string, OpenCall>();
      let asking = 0;
      let lastSign = Date.now();
      /** Set once Stop (or a stalled call) has asked this process to end. */
      let stopping = false;
      /** What a stalled call was, as the person read it. */
      let stalled: string | null = null;
      /** The turn ended without the process letting go; ignore it from here. */
      let abandoned = false;

      // No permission is asked when the engine is set to bypass, or when
      // this agent is in full access; a shared room is never either, and
      // nor is a turn the owner did not vouch for, whose asks are theirs.
      const bypass = !turn.shared && !turn.untrusted && (config.permissionMode === "bypassPermissions" || Boolean(turn.fullAccess));
      const argv = [
        "-p",
        "--output-format", "stream-json",
        "--input-format", "stream-json",
        "--verbose", // stream-json output is refused without it
        // A shared room never bypasses: the approval bridge below is what
        // holds the owner's tools to a yes. acceptEdits only waves through
        // file edits, which --restricted confines to the room's folder.
        // A turn the owner did not vouch for works in the owner's own
        // folders, with nothing confining it, so it asks before edits too.
        "--permission-mode",
        turn.shared
          ? "acceptEdits"
          : turn.untrusted
            ? "default"
            : bypass
              ? "bypassPermissions"
              : config.permissionMode === "auto" ? "acceptEdits" : config.permissionMode,
      ];
      // Resuming continues the CLI's own session; otherwise name the new
      // one ourselves so the id exists before its first event arrives.
      if (resume) {
        argv.push("--resume", resume);
        // Continue the same history, but use this turn's current persona
        // rather than the system prompt the session started with.
        if (snapshotOffSupported) argv.push("--system-prompt-snapshot", "off");
      } else argv.push("--session-id", newId());
      if (turn.model) argv.push("--model", turn.model);
      // this agent's owner switched hooks off: a plugin's session-start
      // text would otherwise land in its context as if it were an order
      if (turn.noHooks) argv.push("--settings", JSON.stringify({ disableAllHooks: true }));
      // extra editable folders, chiefly the agent's own workspace: memory
      // updates must not stall on approval cards when cwd points elsewhere
      for (const dir of turn.extraDirs ?? []) argv.push("--add-dir", dir);

      // A shared room: other people are reading. --restricted drops the
      // tools that run code and ignores the owner's settings files,
      // --strict-mcp-config keeps the owner's own MCP servers out, and
      // --tools names exactly what is left: nothing, or file tools that
      // --restricted confines to the room's own folder. The two env
      // switches below keep the owner's CLAUDE.md and auto memory out of
      // the session, which --restricted alone does not promise.
      if (turn.shared) {
        argv.push("--restricted", "--tools", turn.shared.tools === "desk" ? "Read,Write,Edit,Glob,Grep" : "");
        // and only the MCP servers this turn names: never the owner's own,
        // which --restricted would otherwise still load
        argv.push("--strict-mcp-config");
      }

      // The persona travels as a file, never as an argument. argv is
      // readable by every process on the machine through ps, and the
      // system prompt carries whatever the user wrote about themselves
      // in settings. A private file read only by the CLI is not.
      let personaDir: string | null = null;
      const privateFile = (name: string, content: string) => {
        personaDir ??= mkdtempSync(join(tmpdir(), "bloks-persona-"));
        const file = join(personaDir, name);
        writeFileSync(file, content, { mode: 0o600 });
        return file;
      };
      if (turn.system) argv.push("--append-system-prompt-file", privateFile("system.md", turn.system));

      // Every MCP server has to be named in --allowedTools as well as
      // --mcp-config. A headless acceptEdits run denies anything unlisted
      // without saying so, which looks exactly like the tool not working.
      const mcpServers: Record<string, unknown> = {};
      const allowed: string[] = [];

      for (const server of turn.integrations?.mcpServers ?? []) {
        // the user's own server, under a prefixed slug so it can never
        // collide with the harness's bloks/composio mounts
        const slug = "u_" + server.name.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 40);
        if (slug === "u_" || mcpServers[slug]) continue;
        mcpServers[slug] =
          server.transport === "http"
            ? { type: "http", url: server.url, ...(server.headers ? { headers: server.headers } : {}) }
            : { command: server.command, args: server.args ?? [] };
        allowed.push(`mcp__${slug}`);
      }

      if (turn.integrations?.composio?.key) {
        mcpServers.composio = {
          type: "http",
          url: turn.integrations.composio.url || "https://connect.composio.dev/mcp",
          headers: { "x-consumer-api-key": turn.integrations.composio.key },
        };
        allowed.push("mcp__composio");
      }

      // Cloud box and local Mac are the same tool surface from the agent's
      // side, so both are published under one name: it has a computer.
      if (turn.integrations?.computer) {
        mcpServers.computer = {
          command: process.execPath,
          args: [COMPUTER_HELPER],
          env: {
            ...RUN_AS_NODE,
            BLOKS_BOX_ID: turn.integrations.computer.boxId,
            BLOKS_BOX_TOKEN: turn.integrations.computer.token,
          },
        };
        allowed.push("mcp__computer");
      } else if (turn.integrations?.localComputer) {
        mcpServers.computer = { ...turn.integrations.localComputer };
        allowed.push("mcp__computer");
      }

      if (turn.integrations?.sandbox) {
        // resolved here rather than in the proxy: the proxy holds no
        // probing logic, only a runtime name it was handed
        mcpServers.sandbox = {
          command: process.execPath,
          args: [SANDBOX_HELPER],
          env: {
            ...RUN_AS_NODE,
            BLOKS_SBX_RUNTIME: turn.integrations.sandbox.runtime,
            BLOKS_SBX_NAME: turn.integrations.sandbox.name,
          },
        };
        allowed.push("mcp__sandbox");
      }

      if (turn.integrations?.browser) {
        mcpServers.browser = {
          command: process.execPath,
          args: [BROWSER_HELPER],
          env: {
            ...RUN_AS_NODE,
            BLOKS_BROWSER_PROFILE: turn.integrations.browser.profileDir,
            BLOKS_BROWSER_PORT: String(turn.integrations.browser.port),
          },
        };
        allowed.push("mcp__browser");
      }

      // Every mode gets the bridge. bypassPermissions has no permission
      // checks for it to answer, but the agent can still ask its owner
      // something: a question, a key, an app to connect (GitHub 172). So
      // there it publishes only those, and the CLI is never pointed at
      // approve.
      const socketPath = brokerSocket(threadId, turnId);
      const broker = createAskBroker({
        socketPath,
        onAsk: (ask) => {
          asking++;
          lastSign = Date.now();
          emit({
            ...envelope(threadId, turnId),
            type: "request.opened",
            requestId: ask.id,
            requestType: ask.kind,
            tool: ask.tool,
            input: ask.input,
            summary: summarise(ask),
            choices: askChoices(ask.input),
          });
        },
        onResolve: (resolved) => {
          asking = Math.max(0, asking - 1);
          // the call only starts running once it has its answer
          lastSign = Date.now();
          emit({
            ...envelope(threadId, turnId),
            type: "request.resolved",
            requestId: resolved.id,
            behavior: resolved.behavior,
            source: resolved.source,
          });
        },
      });
      if (!bypass) argv.push("--permission-prompt-tool", "mcp__bloks__approve");
      // request_connection only where there is something to connect
      // with, the same test the prompt uses before mentioning it
      const askingTools = ["ask_user", "request_secret", ...(turn.integrations?.composio?.key ? ["request_connection"] : [])];
      mcpServers.bloks = {
        command: process.execPath,
        args: [PERMISSION_HELPER, socketPath],
        env: { ...RUN_AS_NODE, ...(bypass ? { BLOKS_PUBLISH: askingTools.join(",") } : {}) },
      };
      allowed.push("mcp__bloks");

      if (Object.keys(mcpServers).length) {
        // A file too, for the same reason: the servers' headers carry the
        // Composio key, a person's own MCP credentials and the box token.
        argv.push("--mcp-config", privateFile("mcp.json", JSON.stringify({ mcpServers })));
        // In a shared room nothing of the owner's is pre-allowed: every
        // call to a connector, the browser or the computer goes through
        // the bridge and becomes an approval, which is the point. The
        // same for a turn the owner did not vouch for.
        const allowList = turn.shared || turn.untrusted ? allowed.filter((tool) => tool === "mcp__bloks") : allowed;
        if (allowList.length) argv.push("--allowedTools", allowList.join(","));
      }

      const env: Record<string, string | undefined> = {
        ...process.env,
        NPM_CONFIG_LOGLEVEL: "error",
        // the turn's own credential, so the agent can act on the
        // workspace as itself rather than only describe what should happen
        ...(turn.env ?? {}),
      };
      if (turn.shared) {
        env.CLAUDE_CODE_DISABLE_CLAUDE_MDS = "1";
        env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = "1";
      }
      // A subscription login gets billed as pay-as-you-go if a key leaks
      // through, and the two CLAUDECODE markers would make the child think
      // it is a nested session of whatever spawned this server.
      delete env.ANTHROPIC_API_KEY;
      delete env.CLAUDECODE;
      delete env.CLAUDE_CODE_ENTRYPOINT;

      const child = spawn(config.cli, argv, {
        cwd: turn.cwd ?? homedir(),
        env,
        stdio: ["pipe", "pipe", "pipe"],
        // its own process group, so killing -pid takes the MCP servers too
        detached: OWN_GROUP,
        windowsHide: true,
      });

      let finished = false;
      let exited = false;
      // the session this process reports for, from its init frame
      let sessionId: string | null = resume;
      // the model the session says it runs, which names its window
      let sessionModel: string | null = null;
      // A result that did nothing (see `case "result"`), held until the
      // real one arrives or the process ends without one. After a steer,
      // a real one is held too, since another may follow it.
      let held: any = null;
      /** Whether stdin still takes words for this turn. */
      let inputOpen = true;
      /** Words were written after the prompt, so a result may not be the last. */
      let steered = false;
      /** Whether any assistant frame carried usage this turn. */
      let reportedUsage = false;
      // The CLI saying this turn's engine is out (a limit, signed out), and
      // when its rate limit said it resets, in epoch seconds. A turn that
      // ends on that notice failed, whatever its result frame says, or no
      // backup takes it and the engine is never rested.
      let outNotice: string | null = null;
      let resetsAt: number | null = null;
      let watch: ReturnType<typeof setInterval> | null = null;
      let quiet: ReturnType<typeof setInterval> | null = null;
      const finish = (ok: boolean, stopReason: string | null, cost: number | null = null) => {
        if (finished) return;
        finished = true;
        if (watch) clearInterval(watch);
        if (quiet) clearInterval(quiet);
        if (broker && !exited && !abandoned) {
          broker.retire();
          const kept = afterTurn.get(threadId) ?? new Set<AskBroker>();
          kept.add(broker);
          afterTurn.set(threadId, kept);
        } else {
          broker?.close();
        }
        if (personaDir) {
          try {
            rmSync(personaDir, { recursive: true, force: true });
          } catch {
            /* tmpdir cleanup owns stragglers */
          }
        }
        running.delete(threadId);
        emit({ ...envelope(threadId, turnId), type: "turn.completed", ok, stopReason, cost });
      };

      /** End the turn on a result frame, charging only this turn's share
       * of the session's running total (GitHub 137). */
      const settle = (frame: any) => {
        // A turn that never spoke as the assistant, /compact for one, still
        // made requests, and the result is the only place they are counted.
        // No context size: what /compact read is not what the session holds
        // after it.
        if (!reportedUsage && frame.usage) {
          emit({
            ...envelope(threadId, turnId),
            type: "thread.token-usage.updated",
            input: (count(frame.usage.input_tokens) ?? 0) + (count(frame.usage.cache_read_input_tokens) ?? 0),
            output: count(frame.usage.output_tokens) ?? 0,
          });
        }
        // The window is in the result, not in each message: the table's
        // guess for a model is wrong as soon as the CLI serves it with a
        // bigger one (GitHub 224).
        const window = contextWindowOf(frame, turn.model, sessionModel);
        if (window) emit({ ...envelope(threadId, turnId), type: "context.reading", used: null, window });
        const total = typeof frame.total_cost_usd === "number" && Number.isFinite(frame.total_cost_usd) ? frame.total_cost_usd : null;
        const session = typeof frame.session_id === "string" ? frame.session_id : sessionId;
        if (stopping) {
          finish(false, stalled ? "tool_stalled" : "interrupted", total !== null && session ? sessionCosts.turn(session, total, Boolean(resume)) : null);
          return;
        }
        // A limit can also arrive as a successful result whose text is
        // only the notice, with nothing before it that we recognised.
        if (!outNotice && isLimitNotice(frame.result)) {
          const said: string = frame.result.trim();
          outNotice = said;
          emit({ ...envelope(threadId, turnId), type: "runtime.error", message: said });
        }
        // a failed turn's own words say why ("usage limit reached"),
        // which is what a backup engine and a routine's log need
        let why: string | null =
          outNotice ?? (frame.is_error === true && typeof frame.result === "string" && frame.result.trim() ? frame.result.trim() : null);
        // the reset the rate limit gave, in the shape failover.ts reads
        // first: "resets 3pm" alone leaves the day and the zone to guess
        if (why && resetsAt && outReason(why)) why = `${why.slice(0, 380)}|${resetsAt}`;
        finish(
          frame.is_error !== true && !outNotice,
          why?.slice(0, 400) ?? frame.stop_reason ?? frame.terminal_reason ?? null,
          total !== null && session ? sessionCosts.turn(session, total, Boolean(resume)) : null,
        );
      };

      const initializeId = newId();
      let commands: ClaudeCommandRow[] | null = null;
      let initSkills: unknown;
      let terminalCommands: unknown;
      const reportCommands = () => {
        const catalog = classifyClaudeCommands(commands, initSkills, terminalCommands);
        if (catalog) emit({ ...envelope(threadId, turnId), type: "commands.updated", cwd: turn.cwd ?? null, catalog });
      };
      const consume = (raw: string) => {
        if (abandoned) return;
        lastSign = Date.now();
        let frame: any;
        try {
          frame = JSON.parse(raw);
        } catch {
          return; // a log line, not protocol
        }
        // initialize also returns account, models, pid and session state.
        // None of those belong in Bloks' logs, transcript or event stream.
        if (frame.type === "control_response") {
          if (frame.response?.request_id === initializeId && frame.response?.subtype === "success") {
            commands = readClaudeCommands(frame.response.response?.commands);
            reportCommands();
          }
          return;
        }
        if (frame.type === "system" && frame.subtype === "commands_changed") {
          commands = readClaudeCommands(frame.commands);
          reportCommands();
          return;
        }
        appendNative(threadId, { dir: "in", source: "claude.sdk.message", msg: frame });

        switch (frame.type) {
          case "system":
            if (frame.subtype === "init") {
              initSkills = frame.skills;
              terminalCommands = frame.terminal_slash_commands;
              reportCommands();
              if (typeof frame.session_id === "string") sessionId = frame.session_id;
              if (typeof frame.model === "string") sessionModel = frame.model;
              emit({
                ...envelope(threadId, turnId),
                type: "session.started",
                sessionId: frame.session_id,
                model: frame.model,
              });
            } else if (frame.subtype === "thinking_tokens") {
              emit({
                ...envelope(threadId, turnId),
                type: "item.updated",
                itemType: "reasoning",
                tokens: frame.estimated_tokens,
              });
            } else {
              const compacted = readCompactBoundary(frame);
              if (compacted) emit({ ...envelope(threadId, turnId), type: "context.compacted", ...compacted });
            }
            break;

          case "assistant": {
            const message = frame.message ?? {};
            const text = textOf(message.content);
            // The CLI speaks for itself in the assistant's voice when it
            // cannot run a turn at all ("Not logged in · Please run /login"),
            // marked with an error. That is not the agent talking, and
            // /login means nothing outside the CLI's own terminal, so it
            // becomes an error that says what to do. The wording keeps
            // "not signed in", which is what a backup engine listens for.
            if (typeof frame.error === "string" && frame.error) {
              const said =
                frame.error === "authentication_failed"
                  ? "Claude Code is not signed in on this computer. Open Terminal, run claude and sign in, then send this again. Or pick another engine for this agent."
                  : text.trim() || `Claude Code could not run this turn (${frame.error}).`;
              if (outReason(said) || isLimitNotice(said)) outNotice = said;
              emit({ ...envelope(threadId, turnId), type: "runtime.error", message: said });
              break;
            }
            // Versions that mark nothing still speak as "<synthetic>", or
            // say nothing but the limit notice. Either is the engine being
            // out, not the agent's reply.
            const calls = Array.isArray(message.content) && message.content.some((block: any) => block?.type === "tool_use");
            if (!calls && ((message.model === "<synthetic>" && outReason(text)) || isLimitNotice(text))) {
              outNotice = text.trim().slice(0, 600);
              emit({ ...envelope(threadId, turnId), type: "runtime.error", message: outNotice });
              break;
            }
            // The CLI delivers whole blocks, not tokens, so the same text
            // is both the "stream" and the settled item. Emitting both
            // keeps the client's streaming buffer and its transcript fold
            // on one code path with genuinely streaming drivers.
            if (text.trim()) {
              emit({
                ...envelope(threadId, turnId),
                type: "content.delta",
                streamKind: "assistant_text",
                delta: text,
              });
              emit({
                ...envelope(threadId, turnId),
                type: "item.completed",
                itemType: "assistant_text",
                text,
              });
            }
            for (const block of Array.isArray(message.content) ? message.content : []) {
              if (block.type !== "tool_use") continue;
              if (typeof block.id === "string") {
                openCalls.set(block.id, { name: String(block.name ?? "A tool call"), input: block.input, since: Date.now() });
              }
              const paths = editedPaths(block.name, block.input);
              emit({
                ...envelope(threadId, turnId),
                type: "item.started",
                itemType: "tool",
                itemId: block.id,
                title: block.name,
                ...(paths.length ? { paths } : {}),
              });
            }
            if (message.usage) {
              reportedUsage = true;
              const ttl = cacheTtlOf(message.usage);
              emit({
                ...envelope(threadId, turnId),
                type: "thread.token-usage.updated",
                // cache reads are still input the user paid attention to,
                // even when they cost less
                input: (message.usage.input_tokens || 0) + (message.usage.cache_read_input_tokens || 0),
                output: message.usage.output_tokens || 0,
                // Forwarded subagent usage is still accounted for, but it
                // measured the child's session rather than this lane's.
                ...(frame.parent_tool_use_id == null ? { context: promptSize(message.usage) } : {}),
                ...(ttl ? { cacheTtl: ttl } : {}),
              });
            }
            break;
          }

          case "rate_limit_event": {
            // Newer versions report the subscription's limit on the side.
            // "rejected" is the one that stops the turn, and its resetsAt is
            // the most exact reset there is.
            const info = frame.rate_limit_info ?? {};
            const at = Number(info.resetsAt);
            if (info.status === "rejected" && Number.isFinite(at) && at > 0) {
              resetsAt = Math.floor(at > 1e12 ? at / 1000 : at);
            }
            // and how much of each window is used, which it says every turn
            plan = claudePlanUsage(info, plan);
            break;
          }

          case "user":
            // tool results come back addressed to the tool_use they answer
            for (const block of Array.isArray(frame.message?.content) ? frame.message.content : []) {
              if (block.type !== "tool_result") continue;
              openCalls.delete(block.tool_use_id);
              emit({
                ...envelope(threadId, turnId),
                type: "item.completed",
                itemType: "tool",
                itemId: block.tool_use_id,
                ok: !block.is_error,
              });
            }
            break;

          case "result":
            // With stdin open the process waits for more after a result
            // instead of exiting, so the first result shuts the door. Words
            // already written before it are still read and answered by the
            // same process; anything later waits for the next turn.
            closeInput();
            // On --resume Claude Code can first settle something the last
            // session left running (a background shell it stopped) with a
            // result of its own: no model turns, no API time. The answer to
            // this turn comes after it in the same process, so that result
            // is held rather than taken as the end. Ending there revoked the
            // turn's credential while the agent was still working and showed
            // it idle, so a second turn could start on the same session
            // (GitHub 134).
            if (frame.is_error !== true && frame.num_turns === 0 && !frame.duration_api_ms) {
              held ??= frame;
              break;
            }
            // A steer written just as the engine finished can reach it
            // after this result, and then it answers that with a result of
            // its own. There is no telling which from here, so the turn
            // runs until the process ends and the last result is the one
            // it ends on. Ending here would answer the words in a turn
            // nobody is watching, or drop them.
            if (steered) {
              held = frame;
              quiet ??= setInterval(() => {
                if (finished || Date.now() - lastSign < STEER_QUIET_MS) return;
                if (held) settle(held);
              }, 1_000);
              quiet.unref?.();
              break;
            }
            settle(frame);
            break;
        }
      };

      // read in linear time, however long a line (see lineSplitter)
      child.stdout.on(
        "data",
        lineSplitter((line) => {
          if (line.trim()) consume(line);
        }),
      );

      // Keep only the tail: if this process dies early, the last thing it
      // said is the part that explains why.
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
            name: "Claude Code",
            command: config.cli,
            install: "curl -fsSL https://claude.ai/install.sh | bash",
            signIn: "run `claude` once to sign in",
          }),
        });
        finish(false, "spawn_error");
      });

      /** A stopped turn ends quietly: the person asked for it, or the
       * stall has already said why. */
      const endStopped = () => finish(false, stalled ? "tool_stalled" : "interrupted");

      const ended = (code: number | null) => {
        if (finished) return;
        if (stopping) return endStopped();
        // a held result was the whole turn after all
        if (held) return settle(held);
        // Exiting without a `result` frame means it never got as far as
        // answering, so stderr is the only thing that can explain it.
        emit({
          ...envelope(threadId, turnId),
          type: "runtime.error",
          message: describeEarlyExit(code, stderr, {
            name: "Claude Code",
            signIn: "run `claude` once in a terminal",
          }),
        });
        finish(false, "exit_before_result");
      };

      child.on("close", (code) => {
        exited = true;
        const kept = afterTurn.get(threadId);
        if (broker && kept?.delete(broker)) {
          broker.close();
          if (!kept.size) afterTurn.delete(threadId);
        }
        ended(code);
      });

      // The output can outlive the process: something it started that
      // escaped the group still holds the pipe, and "close" waits for
      // that. The process is what the turn was, so give the pipe a moment
      // and then stop waiting on it.
      child.on("exit", (code) => {
        const late = setTimeout(() => {
          if (finished) return;
          abandoned = true;
          ended(code);
        }, STOP_GRACE_MS);
        late.unref?.();
      });

      const signal = (sig: NodeJS.Signals) => {
        try {
          process.kill(-child.pid!, sig);
        } catch {
          // no process group (already reaped, or platform quirk)
          try {
            child.kill(sig);
          } catch {
            /* gone */
          }
        }
      };

      // SIGTERM, then SIGKILL, then the turn ends whether or not the
      // process let go. A CLI stuck in a tool call sat through SIGTERM
      // for two hours (GitHub 146), and a process blocked in a read the
      // kernel will not interrupt survives SIGKILL too, until the read
      // returns. Whatever it says after that is dropped.
      const abort = () => {
        if (finished || stopping) return;
        stopping = true;
        signal("SIGTERM");
        const kill = setTimeout(() => {
          if (!exited) signal("SIGKILL");
        }, STOP_GRACE_MS);
        kill.unref?.();
        const giveUp = setTimeout(() => {
          if (finished) return;
          abandoned = true;
          endStopped();
        }, STOP_GRACE_MS * 2);
        giveUp.unref?.();
      };

      // A call gone silent ends the turn, and says which call it was.
      const limitMs = typeof turn.stallMs === "number" ? turn.stallMs : DEFAULT_STALL_MINUTES * 60_000;
      if (limitMs > 0) {
        watch = setInterval(() => {
          if (finished || stopping) return;
          const now = Date.now();
          if (!isStalled({ open: openCalls.size, asking, lastSign, now, limitMs })) return;
          const oldest = [...openCalls.values()].sort((a, b) => a.since - b.since)[0];
          stalled = describeStall(oldest, now - lastSign);
          emit({ ...envelope(threadId, turnId), type: "runtime.error", message: stalled });
          abort();
        }, Math.max(250, Math.min(15_000, limitMs / 4)));
        watch.unref?.();
      }

      // A write to a process that has just gone is not worth a crash; the
      // exit says what happened.
      child.stdin.on("error", () => {});
      function closeInput() {
        if (!inputOpen) return;
        inputOpen = false;
        child.stdin.end();
      }
      const say = (text: string) => {
        // Over stdin, never argv: a pasted document would blow past
        // ARG_MAX, and argv is readable by every process on the machine.
        const message = { type: "user", message: { role: "user", content: text } };
        child.stdin.write(JSON.stringify(message) + "\n");
        appendNative(threadId, { dir: "out", source: "claude.sdk.message", msg: message });
      };
      const steer = (text: string) => {
        if (finished || stopping || exited || !inputOpen) return false;
        steered = true;
        say(text);
        return true;
      };

      running.set(threadId, { turnId, abort, steer, broker });
      emit({ ...envelope(threadId, turnId), type: "turn.started" });

      // Bare metadata request: does not change permissions, hooks or tools.
      // Do not await it; an older CLI can ignore it and still run this turn.
      const initialize = { type: "control_request", request_id: initializeId, request: { subtype: "initialize" } };
      child.stdin.write(JSON.stringify(initialize) + "\n");
      appendNative(threadId, { dir: "out", source: "claude.sdk.message", msg: initialize });
      say(turn.text);

      return { turnId };
    };

    const snapshot = async (): Promise<ProviderSnapshot> => {
      const version = await readVersion();
      if (!version) return { state: "unavailable", reason: `\`${config.cli}\` CLI not found` };

      // Installed and signed in are different states, and the difference is
      // the whole content of the error a user would otherwise hit on their
      // first message. The CLI itself is the authority: current versions
      // keep the login in the macOS Keychain, where no file check can see
      // it. Older ones lack the subcommand, so the file is the fallback.
      //
      // Read stdout before looking at `error`: `claude auth status` prints
      // its JSON and *exits 1* when there is no login, and execFile surfaces
      // a non-zero exit as an error, so branching on the error first throws
      // away the one answer that is authoritative and lands on the file check
      // the comment above already says cannot see a Keychain login. The file
      // is only a fallback for a CLI old enough not to answer at all.
      const authenticated = await new Promise<boolean>((resolve) => {
        execFile(config.cli, ["auth", "status"], { timeout: 8_000, windowsHide: true }, (error, stdout) => {
          try {
            const { loggedIn } = JSON.parse(stdout) as { loggedIn?: unknown };
            if (typeof loggedIn === "boolean") return resolve(loggedIn);
          } catch {
            /* not JSON: an older CLI, or one that died before printing */
          }
          if (error) {
            return resolve(existsSync(join(homedir(), ".claude", ".credentials.json")));
          }
          // it answered without erroring, which older CLIs do not
          resolve(true);
        });
      });
      return { state: "available", version, authenticated };
    };

    return {
      instanceId,
      driverKind: DRIVER_KIND,
      displayName: input.displayName,
      enabled: input.enabled,
      models: MODELS,
      snapshot,
      planUsage: () => plan,

      adapter: {
        provider: DRIVER_KIND,
        capabilities: { sessionModelSwitch: "in-session" },
        sendTurn,

        steerTurn: async (threadId, text) => running.get(threadId)?.steer(text) ?? false,

        interruptTurn: async (threadId) => running.get(threadId)?.abort(),

        respondToRequest: async (threadId, requestId, decision) => {
          // the running turn's broker first, then any finished turn's whose
          // process is still at work and asked after its result
          const brokers = [running.get(threadId)?.broker, ...(afterTurn.get(threadId) ?? [])].filter(
            (b): b is AskBroker => b !== undefined,
          );
          if (!brokers.length) throw new Error("nothing on this thread is waiting to be answered");
          if (!brokers.some((b) => b.answer(requestId, decision.behavior, decision.message))) {
            throw new Error("no such pending request (it may have timed out)");
          }
        },

        hasSession: (threadId) => running.has(threadId),

        stopAll: async () => {
          for (const turn of running.values()) turn.abort();
          for (const kept of afterTurn.values()) for (const b of kept) b.close();
          afterTurn.clear();
        },

        onEvent: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },

      // The prompt goes in on stdin, like a turn's: a summary prompt is the
      // conversation itself, and argv is readable by every process on the
      // machine. The same variables a turn drops are dropped here, or a key
      // in the environment would bill these summaries to the API instead
      // of the person's subscription.
      generateText: (prompt: string) =>
        new Promise((resolve, reject) => {
          const env: Record<string, string | undefined> = { ...process.env };
          delete env.ANTHROPIC_API_KEY;
          delete env.CLAUDECODE;
          delete env.CLAUDE_CODE_ENTRYPOINT;
          const child = spawn(config.cli, ["-p", "--model", ONE_SHOT_MODEL, "--output-format", "text"], {
            env,
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
          });
          let out = "";
          let err = "";
          const timer = setTimeout(() => {
            // asked to stop first, so it can take its own children with it,
            // and only then made to
            child.kill("SIGTERM");
            setTimeout(() => child.kill("SIGKILL"), 3_000).unref?.();
            reject(new Error("Claude Code did not answer within a minute"));
          }, 60_000);
          timer.unref?.();
          child.stdout.on("data", (chunk) => (out += chunk));
          child.stderr.on("data", (chunk) => (err = (err + chunk).slice(-2_000)));
          child.stdin.on("error", () => {});
          child.on("error", (error) => {
            clearTimeout(timer);
            reject(error);
          });
          child.on("close", (code) => {
            clearTimeout(timer);
            if (code === 0) resolve(out.trim());
            else reject(new Error(err.trim() || `Claude Code exited with ${code}`));
          });
          child.stdin.end(prompt);
        }),

      dispose: async () => {
        for (const turn of running.values()) turn.abort();
        listeners.clear();
      },
    };
  },
};
