// Claude Code, driven as a subprocess.
//
// The CLI is run once per turn with JSON on both ends of the pipe: the
// prompt goes in on stdin as a stream-json message, and a sequence of
// stream-json events comes back on stdout. Stdin stays open while the
// turn runs, so the person can say more and the agent reads it after the
// step it is on (GitHub 213). Supported CLIs attribute completion to each
// accepted input; older versions close input at the first result.
// Continuity across turns is the
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
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { homedir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

import { DATA_DIR } from "../config.ts";
import { lineSplitter } from "../ndjson.ts";
import { apiRefusal, isRefusal, outReason } from "../failover.ts";
import { claudePlanUsage } from "../plan-usage.ts";
import { callSignature } from "../repeats.ts";
import { SessionCosts } from "./session-costs.ts";
import { readClaudeCommands, classifyClaudeCommands, type ClaudeCommandRow } from "../agent-commands.ts";
import { bridgeSocketPath, createAskBroker, summarise, type AskBroker } from "../harness/ask-broker.ts";
import { checkPersonClaudeInit, checkPersonClaudeStatus, personClaudeDenials, personTurnHold, readPersonClaudeInstructions } from "../person-turn.ts";

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
import type { Effort } from "../effort.ts";
import { appendNative } from "./native.ts";
import { describeEarlyExit, describeSpawnError } from "./spawn-error.ts";
import { DEFAULT_STALL_MINUTES, STOP_GRACE_MS, describeStall, isStalled, type OpenCall } from "./stall.ts";
import { OWN_GROUP } from "../no-console.ts";
import { EngineProcesses, signalGroup } from "./engine-processes.ts";
import { TurnProcess } from "./turn-process.ts";
import { ClaudeInputs } from "./claude-inputs.ts";

/** Each session's last reported total, so a turn is charged its own share. */
const sessionCosts = new SessionCosts();
/** An unconfirmed owner survives instance replacement. A settings reload
 * must not make the same lane runnable beside its predecessor. */
const processOwners = new Map<string, TurnProcess>();

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

/** What `--effort <level>` takes, as `claude --help` lists it. */
const CLAUDE_EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];

/** Model used for the cheap one-shot calls (naming an agent, and similar).
 * Always the smallest one: nobody is reading it, they are reading its
 * two-line output. */
const ONE_SHOT_MODEL = "claude-haiku-4-5";

/** How long a steered turn's process may say nothing after a result,
 * with no call of its own still open, before that result is taken as
 * the end. Only a CLI that does not say which input a result answers
 * needs it. Usually the process exits first; one kept alive by a
 * background task it started would otherwise hold the lane busy for as
 * long as that task runs. */
const STEER_QUIET_MS = 30_000;

/** How long a turn that waited on background work gives the CLI, once
 * that work has ended, to start telling the agent about it. The CLI
 * starts within a fraction of a second; this only covers one that does
 * not say whether it is busy (session_state_changed). */
const BACKGROUND_GRACE_MS = 2_000;

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
 * unix socket paths have a length limit that full ids would risk. A home
 * deep enough to break it anyway moves the socket to the temp folder
 * (bridgeSocketPath in the ask broker). */
function brokerSocket(threadId: string, turnId: string) {
  const tag = threadId.replace(/[^\w-]/g, "").slice(0, 8);
  // per turn too: a finished turn's process can outlive it, and its
  // broker must not share a path with the next turn's
  const turn = turnId.replace(/[^\w-]/g, "").slice(-6);
  return join(DATA_DIR, `perm-${tag}-${turn}.sock`);
}

/** What the person reads when no socket path can be found for the bridge:
 * the data folder and the temp folder are both too deep for one. */
const NO_BRIDGE =
  "Bloks could not set up approvals for this turn, so it did not start: its data folder and the temp folder are both too deep for the socket approvals travel over. Point TMPDIR at a shorter folder (such as /tmp) and restart Bloks.";

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

/**
 * The environment a turn's CLI starts in. Exported so the rules below are
 * held by a test rather than by reading a spawn.
 *
 * Claude Code always runs on the person's own Claude plan or key: the
 * sign-in the CLI has on this computer, or whatever its own settings and
 * this machine's environment point it at. Nothing here gives it another
 * base or another token.
 */
export function turnEnvironment(
  base: NodeJS.ProcessEnv,
  turn: Pick<SendTurnInput, "env" | "shared" | "person">,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    ...base,
    NPM_CONFIG_LOGLEVEL: "error",
    // the turn's own credential, so the agent can act on the
    // workspace as itself rather than only describe what should happen
    ...(turn.env ?? {}),
  };
  if (turn.shared || turn.person) {
    env.CLAUDE_CODE_DISABLE_CLAUDE_MDS = "1";
    env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = "1";
  }
  if (turn.person) env.ENABLE_CLAUDEAI_MCP_SERVERS = "false";
  // A subscription login gets billed as pay-as-you-go if a key leaks
  // through, and the two CLAUDECODE markers would make the child think
  // it is a nested session of whatever spawned this server.
  delete env.ANTHROPIC_API_KEY;
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  // The CLI's own word on whether it is busy or idle, which is how a turn
  // that waits on its background work knows the agent has finished
  // answering what that work found (server/background-work.ts).
  env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS = "1";
  return env;
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
    // --fork-session came well before 2.0. Unknown means no: a session
    // brought over from before Bloks is then told as a story rather than
    // resumed in place, which would write to the person's own file.
    let forkSupported = false;
    let attributedCompletionSupported = false;
    // --effort takes all five levels from 2.1.252 on, the oldest CLI its
    // --help was read from; where it began is not known. An older or
    // unrecognised CLI is sent no effort, as before, rather than a flag
    // it would refuse along with the turn.
    let effortSupported = false;
    const readVersion = () => new Promise<string | null>((resolve) => {
      execFile(config.cli, ["--version"], { timeout: 8_000, windowsHide: true }, (error, stdout) => {
        const version = error ? null : stdout.trim();
        const parts = version?.match(/^(\d+)\.(\d+)\.(\d+)(?:\s|$)/);
        const [major, minor, patch] = parts?.slice(1).map(Number) ?? [];
        snapshotOffSupported = major > 2 || (major === 2 && (minor > 1 || (minor === 1 && patch >= 257)));
        forkSupported = major >= 2;
        attributedCompletionSupported = major > 2 || (major === 2 && (minor > 1 || (minor === 1 && patch >= 300)));
        effortSupported = major > 2 || (major === 2 && (minor > 1 || (minor === 1 && patch >= 252)));
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
      cleanup: () => Promise<boolean>;
      /** More words for this turn, or false when it can no longer take them. */
      steer: (text: string, onDispatch?: () => void) => boolean;
      steerPrepared: (text: string, options: { onDispatch: () => void; onAcceptedLate?: () => void }) => Promise<"accepted" | "refused" | "uncertain">;
      broker?: AskBroker;
    }
    /** At most one turn per thread. A second send while one is live is a
     * caller bug, not a queue to manage. */
    const running = new Map<string, RunningTurn>();
    /** Every engine process this instance started, ended on dispose (engine-processes.ts). */
    const engines = new EngineProcesses();

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
      if (running.has(threadId) || processOwners.has(threadId)) throw new Error("a turn is already running on this thread");

      const turnId = newId();
      // A health refresh cannot change the protocol of an already running CLI.
      const attributed = attributedCompletionSupported;
      // The version probe describes the local CLI, not one spawned by a
      // workplace. Until its capability is known, leave preparation inputs
      // for the next turn; ordinary steering keeps its existing behavior.
      const attributedPreparation = attributed && !turn.place;
      const inputs = attributed ? new ClaudeInputs() : null;
      let sealed = false;
      let closingBroker = false;
      let completionTimer: ReturnType<typeof setTimeout> | null = null;
      let checkCompletion = () => {};
      // Where the permission bridge will listen, settled before anything
      // starts. With nowhere to listen every approval would be denied
      // without a card, so the turn fails out loud instead, the way an
      // engine that cannot start does.
      const socketPath = bridgeSocketPath(brokerSocket(threadId, turnId));
      if (!socketPath) {
        emit({ ...envelope(threadId, turnId), type: "turn.started" });
        setImmediate(() => {
          emit({ ...envelope(threadId, turnId), type: "runtime.error", message: NO_BRIDGE });
          emit({ ...envelope(threadId, turnId), type: "turn.completed", ok: false, stopReason: "no_bridge", cost: null });
        });
        return { turnId };
      }
      // A session brought over from before Bloks is carried on in a copy,
      // or, where this CLI cannot copy one, not resumed at all.
      const cursor = !turn.person && typeof turn.resumeCursor === "string" ? turn.resumeCursor : null;
      const forking = cursor !== null && turn.forkFrom === cursor;
      const resume = forking && !forkSupported ? null : cursor;
      const words = forking && !resume ? (turn.handoff ?? turn.text) : turn.text;

      // Tool calls the engine has started and not yet reported back on,
      // whether somebody is being asked something, and when the engine
      // last said anything at all: what tells a silent call from work
      // (GitHub 146). See stall.ts.
      const openCalls = new Map<string, OpenCall>();
      // Background work (server/background-work.ts). What the turn started
      // to run on after its reply, by task id, as the CLI reports it; every
      // root tool call by id, to name a background task by what it runs;
      // whether the CLI's set of background tasks has been heard, which is
      // then the whole truth; whether this turn has had any; and whether
      // the CLI says it is busy or idle. A person's turn leaves nothing
      // running after it, whatever the owner chose for their own agents.
      const letFinish = turn.backgroundWork !== "stop" && !turn.person;
      const background = new Map<string, OpenCall>();
      const toolCalls = new Map<string, { name: string; input: unknown }>();
      const named = new Map<string, { name: string; input: unknown }>();
      let levelSeen = false;
      let hadBackground = false;
      let cliState: string | null = null;
      // in the order the CLI said them: the last time it said it was idle,
      // and the last time its background tasks ran out
      let said = 0;
      let idleAt = 0;
      let emptiedAt = 0;
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
      const bypass = !turn.person && !turn.shared && !turn.untrusted && (config.permissionMode === "bypassPermissions" || Boolean(turn.fullAccess));
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
          : turn.person || turn.untrusted
            ? "default"
            : bypass
              ? "bypassPermissions"
              : config.permissionMode === "auto" ? "acceptEdits" : config.permissionMode,
      ];
      if (attributed) argv.push("--include-partial-messages");
      // Resuming continues the CLI's own session; otherwise name the new
      // one ourselves so the id exists before its first event arrives.
      if (resume) {
        argv.push("--resume", resume);
        if (forking) argv.push("--fork-session");
        // Continue the same history, but use this turn's current persona
        // rather than the system prompt the session started with.
        if (snapshotOffSupported) argv.push("--system-prompt-snapshot", "off");
      } else argv.push("--session-id", newId());
      if (turn.model) argv.push("--model", turn.model);
      // every turn is a new process, so the effort is said on every one;
      // left out, the CLI thinks at its own default, whatever was chosen
      if (turn.effort && effortSupported) argv.push("--effort", turn.effort);
      // this agent's owner switched hooks off: a plugin's session-start
      // text would otherwise land in its context as if it were an order
      if (turn.noHooks || turn.person) argv.push("--settings", JSON.stringify({ disableAllHooks: true }));
      if (turn.person) {
        argv.push("--setting-sources", "", "--strict-mcp-config", "--no-session-persistence");
        // one value per flag, so a folder name with a comma or a space in
        // it cannot split a rule in two
        for (const rule of personClaudeDenials(DATA_DIR)) argv.push("--disallowedTools", rule);
      }
      // extra editable folders, chiefly the agent's own workspace: memory
      // updates must not stall on approval cards when cwd points elsewhere.
      // Folders on this computer, so none for a turn that works elsewhere.
      if (!turn.place) for (const dir of turn.extraDirs ?? []) argv.push("--add-dir", dir);

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

      // The persona and the MCP config travel as files, never as
      // arguments. argv is readable by every process on the machine
      // through ps: the system prompt carries whatever the user wrote
      // about themselves in settings, and the MCP config carries the
      // Composio key and any header or token a server needs. A private
      // file, in a folder of this turn's own, read only by the CLI, is not.
      const system = (turn.system ?? "") + (turn.person && !turn.place ? readPersonClaudeInstructions(turn.cwd ?? homedir()) : "");
      let privateDir: string | null = null;
      const privateFile = (name: string, content: string) => {
        // there, written ahead of the CLI by the place, in a folder of
        // the turn's own that goes when the turn does
        if (turn.place) return turn.place.file(name, content);
        privateDir ??= mkdtempSync(join(tmpdir(), "bloks-turn-"));
        const file = join(privateDir, name);
        writeFileSync(file, content, { mode: 0o600 });
        return file;
      };
      if (system) argv.push("--append-system-prompt-file", privateFile("system.md", system));

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
        // A name with no value is one the person has not filled in yet
        // (a server brought over from another tool arrives that way). An
        // empty Authorization header or API key would only turn a clear
        // "missing key" from the server into a confusing one.
        const filled = (map?: Record<string, string>) => {
          const entries = Object.entries(map ?? {}).filter(([, value]) => value);
          return entries.length ? Object.fromEntries(entries) : undefined;
        };
        const headers = filled(server.headers);
        const env = filled(server.env);
        mcpServers[slug] =
          server.transport === "http"
            ? { type: "http", url: server.url, ...(headers ? { headers } : {}) }
            : { command: server.command, args: server.args ?? [], ...(env ? { env } : {}) };
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
          },
        };
        allowed.push("mcp__browser");
      }

      // Every mode gets the bridge. bypassPermissions has no permission
      // checks for it to answer, but the agent can still ask its owner
      // something: a question, a key, an app to connect (GitHub 172). So
      // there it publishes only those, and the CLI is never pointed at
      // approve.
      let personReady = !turn.person;
      const broker = createAskBroker({
        socketPath,
        ...(turn.person || turn.reply ? { onReply: async (input: unknown) => {
          if (sealed) throw new Error("This turn has ended.");
          if (!personReady) throw personTurnHold("Claude's startup permissions have not been verified.");
          const response = await (turn.person ?? turn.reply)!.reply(input);
          if (sealed) throw new Error("This turn has ended.");
          return response;
        } } : {}),
        onAsk: (ask) => {
          if (sealed) { broker.answer(ask.id, "deny", "This turn has ended."); return; }
          if (!personReady) { broker.answer(ask.id, "deny", "The person's permissions have not been verified."); return; }
          asking++;
          inputs?.setAsking(true);
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
          checkCompletion();
        },
        onResolve: (resolved) => {
          // Closing this turn's already-open cards is part of the selected
          // terminal outcome, not new authority for a late broker callback.
          if (sealed && !closingBroker) return;
          asking = Math.max(0, asking - 1);
          inputs?.setAsking(asking > 0);
          // the call only starts running once it has its answer
          lastSign = Date.now();
          emit({
            ...envelope(threadId, turnId),
            type: "request.resolved",
            requestId: resolved.id,
            behavior: resolved.behavior,
            source: resolved.source,
          });
          checkCompletion();
        },
      });
      if (!bypass) argv.push("--permission-prompt-tool", "mcp__bloks__approve");
      // request_connection only where there is something to connect
      // with, the same test the prompt uses before mentioning it
      const askingTools = ["ask_user", "request_secret", ...(turn.person || turn.integrations?.composio?.key ? ["request_connection"] : [])];
      const personTools = ["approve", ...askingTools, "reply_to_sender"];
      // A turn the owner or an admin started in a team conversation or a
      // room may message one person on their behalf; the bridge publishes
      // the tool by name for it, beside what it publishes anyway.
      const messageTools = turn.messagePerson && !turn.person
        ? [...(bypass ? askingTools : ["approve", "request_connection", "request_secret", "ask_user"]), "message_person"]
        : null;
      mcpServers.bloks = {
        command: process.execPath,
        args: [PERMISSION_HELPER, socketPath],
        env: { ...RUN_AS_NODE, ...(turn.person ? { BLOKS_PUBLISH: personTools.join(",") } : turn.reply ? { BLOKS_PUBLISH: [...(messageTools ?? (bypass ? askingTools : ["approve", "request_connection", "request_secret", "ask_user"])), "reply_to_sender"].join(",") } : messageTools ? { BLOKS_PUBLISH: messageTools.join(",") } : bypass ? { BLOKS_PUBLISH: askingTools.join(",") } : {}) },
      };
      allowed.push("mcp__bloks");

      // Working elsewhere, every server stays on this computer, the bridge
      // first among them: the CLI there reaches each over HTTP through
      // Bloks' gate, with the turn's gate token and nothing else. A
      // server's own key is added here, so it never leaves either.
      if (turn.place) {
        for (const [slug, server] of Object.entries(mcpServers)) {
          const spec = server as { type?: string; command?: string; args?: string[]; env?: Record<string, string>; url?: string; headers?: Record<string, string> };
          const reached = turn.place.mcp(slug, { transport: spec.type === "http" ? "http" : "stdio", ...spec });
          if (reached) mcpServers[slug] = { type: "http", url: reached.url, headers: reached.headers };
          else {
            delete mcpServers[slug];
            const at = allowed.indexOf(`mcp__${slug}`);
            if (at !== -1) allowed.splice(at, 1);
          }
        }
      }

      if (Object.keys(mcpServers).length) {
        // A file too, for the same reason: the servers' headers carry the
        // Composio key, a person's own MCP credentials and the box token.
        argv.push("--mcp-config", privateFile("mcp.json", JSON.stringify({ mcpServers })));
        // In a shared room nothing of the owner's is pre-allowed: every
        // call to a connector, the browser or the computer goes through
        // the bridge and becomes an approval, which is the point. The
        // same for a turn the owner did not vouch for.
        const allowList = turn.person || turn.shared || turn.untrusted ? allowed.filter((tool) => tool === "mcp__bloks") : allowed;
        if (allowList.length) argv.push("--allowedTools", allowList.join(","));
      }

      const env = turnEnvironment(process.env, turn);

      const child = turn.place
        ? turn.place.spawn(config.cli, argv, { env })
        : spawn(config.cli, argv, {
            cwd: turn.cwd ?? homedir(),
            env,
            stdio: ["pipe", "pipe", "pipe"],
            // its own process group, so killing -pid takes the MCP servers too
            detached: OWN_GROUP,
            windowsHide: true,
          });
      engines.add(child);

      let finished = false;
      let finishing = false;
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
      // These callbacks are keyed by the input UUID, never result.uuid.
      // A process exit or timer ends the wait without calling it delivered.
      const confirmations = new Map<string, { accepted: () => void; ended: () => void }>();
      /** Words were written after the prompt, so a result may not be the last. */
      let steered = false;
      /** Whether any assistant frame carried usage this turn. */
      let reportedUsage = false;
      // The CLI saying this turn's engine is out (a limit, signed out) or
      // that the provider refused the message, and when its rate limit
      // said it resets, in epoch seconds. A turn that ends on that notice
      // failed, whatever its result frame says, or no backup takes it and
      // the engine is never rested.
      let outNotice: string | null = null;
      let resetsAt: number | null = null;
      let watch: ReturnType<typeof setInterval> | null = null;
      let quiet: ReturnType<typeof setInterval> | null = null;
      /** Set while the reply is done and the turn waits on its background
       * work: how it ends once that work is. */
      let waiting: (() => void) | null = null;
      let waitTimer: ReturnType<typeof setInterval> | null = null;
      /** A result the CLI gave by itself while the turn waited: the agent
       * answering what its background work found. The turn ends on it. */
      let lastWork: any = null;
      const release = () => {
        if (!finished || !owner.confirmed) return;
        if (running.get(threadId)?.turnId === turnId) running.delete(threadId);
        if (processOwners.get(threadId) === owner) processOwners.delete(threadId);
      };
      const owner = new TurnProcess(child, { onConfirmed: release });
      processOwners.set(threadId, owner);
      const finish = (ok: boolean, stopReason: string | null, cost: number | null = null) => {
        if (finishing) return;
        finishing = true;
        // Seal synchronously, including buffered lines and broker continuations.
        sealed = true;
        if (watch) clearInterval(watch);
        if (quiet) clearInterval(quiet);
        if (waitTimer) clearInterval(waitTimer);
        waiting = null;
        if (completionTimer) clearTimeout(completionTimer);
        for (const waiting of confirmations.values()) waiting.ended();
        confirmations.clear();
        closingBroker = true;
        try { broker.close(); } finally { closingBroker = false; }
        closeInput();
        void owner.end().then((confirmed) => {
          if (!confirmed) {
            emit({ ...envelope(threadId, turnId), type: "runtime.error",
              message: "Claude Code did not finish stopping its process and helpers. This session cannot start another turn until they have ended." });
          }
          if (privateDir) {
            try { rmSync(privateDir, { recursive: true, force: true }); } catch { /* tmpdir cleanup */ }
          }
          finished = true;
          release();
          emit({ ...envelope(threadId, turnId), type: "turn.completed",
            ok: confirmed && ok, stopReason: confirmed ? stopReason : "interrupted", cost });
        });
      };

      /** End the turn on a result frame, charging only this turn's share
       * of the session's running total (GitHub 137). */
      const settle = (frame: any, selected = false) => {
        if (sealed && !selected) return;
        // Select before accounting callbacks can admit another steer.
        sealed = true;
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
        const outcome = inputs?.failureResult ?? frame;
        if (!outNotice && isLimitNotice(outcome.result)) {
          const said: string = outcome.result.trim();
          outNotice = said;
          emit({ ...envelope(threadId, turnId), type: "runtime.error", message: said });
        }
        // a failed turn's own words say why ("usage limit reached"),
        // which is what a backup engine and a routine's log need
        const providerError = outcome.is_error === true || (Array.isArray(outcome.errors) && outcome.errors.length > 0);
        let why: string | null =
          outNotice ?? (providerError
            ? (typeof outcome.result === "string" && outcome.result.trim() ? outcome.result.trim()
              : Array.isArray(outcome.errors) ? outcome.errors.filter((v: unknown) => typeof v === "string").join(" ") : null)
            : null);
        // the model declining the message, said only by the stop reason:
        // a failed turn, in words failover.ts reads as a refusal
        const declined = outcome.stop_reason === "refusal";
        if (!why && declined) why = "The provider declined this message (stop reason: refusal).";
        // the reset the rate limit gave, in the shape failover.ts reads
        // first: "resets 3pm" alone leaves the day and the zone to guess
        if (why && resetsAt && outReason(why)) why = `${why.slice(0, 380)}|${resetsAt}`;
        finish(
          !providerError && !outNotice && !declined,
          why?.slice(0, 400) ?? outcome.stop_reason ?? outcome.terminal_reason ?? null,
          total !== null && session ? sessionCosts.turn(session, total, Boolean(resume)) : null,
        );
      };

      const accountChild = (frame: any) => {
        const usage = frame.type === "assistant" ? frame.message?.usage : null;
        if (!usage) return;
        reportedUsage = true;
        const ttl = cacheTtlOf(usage);
        emit({ ...envelope(threadId, turnId), type: "thread.token-usage.updated",
          input: (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0),
          output: usage.output_tokens || 0, ...(ttl ? { cacheTtl: ttl } : {}) });
      };
      /** Whether background work this turn started is still going: a task
       * the CLI lists as live; or, once there has been one, the CLI saying
       * it is busy (telling the agent what a task found), or the last task
       * having just ended with no word yet that the CLI is idle since, in
       * the moment before it starts on that. A turn that started nothing
       * in the background never waits here. */
      const backgroundBusy = () =>
        background.size > 0 ||
        (hadBackground && (cliState === "running" || cliState === "requires_action" ||
          (!(cliState === "idle" && idleAt > emptiedAt) && Date.now() - lastSign < BACKGROUND_GRACE_MS)));
      const checkBackground = () => {
        if (!waiting || sealed) return;
        if (backgroundBusy() || openCalls.size > 0 || asking > 0) return;
        const end = waiting;
        waiting = null;
        if (waitTimer) clearInterval(waitTimer);
        waitTimer = null;
        end();
      };
      /** End the turn with `end`: now, or, when it waits for its
       * background work, once that work is done and the agent has said
       * what came of it. Meanwhile it is a running turn like any other:
       * words go into it or wait, and a silent task is a silent call. */
      const afterBackground = (end: () => void) => {
        if (!letFinish || !backgroundBusy()) {
          end();
          return;
        }
        waiting = end;
        waitTimer ??= setInterval(checkBackground, 250);
        waitTimer.unref?.();
      };
      /** What the CLI says about its background tasks (task_started and
       * the rest are edges, background_tasks_changed the level). */
      const noteBackground = (frame: any) => {
        if (frame.type !== "system") return;
        const label = (id: string, description: unknown) =>
          named.get(id) ?? { name: typeof description === "string" && description ? `The background task "${description.slice(0, 80)}"` : "A background task", input: undefined };
        switch (frame.subtype) {
          case "session_state_changed":
            if (typeof frame.state !== "string") break;
            cliState = frame.state;
            if (cliState === "idle") idleAt = ++said;
            break;
          case "background_tasks_changed": {
            if (!Array.isArray(frame.tasks)) break;
            levelSeen = true;
            const live = new Map<string, OpenCall>();
            for (const task of frame.tasks) {
              // housekeeping the CLI runs for itself, and a run some call
              // of the agent's is already waiting on, are not left behind
              if (typeof task?.task_id !== "string" || task.ambient === true || task.awaited === true) continue;
              live.set(task.task_id, background.get(task.task_id) ?? { ...label(task.task_id, task.description), since: Date.now() });
            }
            background.clear();
            for (const [id, task] of live) background.set(id, task);
            break;
          }
          case "task_started": {
            if (typeof frame.task_id !== "string") break;
            const call = typeof frame.tool_use_id === "string" ? toolCalls.get(frame.tool_use_id) : undefined;
            const name = call ? { name: `${call.name} in the background`, input: call.input } : label(frame.task_id, frame.description);
            named.set(frame.task_id, name);
            const known = background.get(frame.task_id);
            if (known) background.set(frame.task_id, { ...known, ...name });
            else if (!levelSeen && frame.is_backgrounded === true && frame.skip_transcript !== true && frame.awaited !== true) {
              background.set(frame.task_id, { ...name, since: Date.now() });
            }
            break;
          }
          case "task_updated":
            if (levelSeen || typeof frame.task_id !== "string") break;
            if (frame.patch?.is_backgrounded === true) background.set(frame.task_id, { ...label(frame.task_id, frame.patch?.description), since: Date.now() });
            if (["completed", "failed", "killed"].includes(frame.patch?.status)) background.delete(frame.task_id);
            break;
          case "task_notification":
            if (!levelSeen && typeof frame.task_id === "string") background.delete(frame.task_id);
            break;
          default:
            return;
        }
        if (background.size > 0) hadBackground = true;
        else if (hadBackground && frame.subtype !== "session_state_changed" && emptiedAt <= idleAt) emptiedAt = ++said;
        checkBackground();
      };
      checkCompletion = () => {
        if (!inputs || sealed) return;
        if (completionTimer) clearTimeout(completionTimer);
        completionTimer = null;
        const expired = inputs.poll();
        if (expired.expired.length) {
          sealed = true;
          emit({ ...envelope(threadId, turnId), type: "runtime.error",
            message: "Claude Code did not answer while waiting for this input's request or completion for 900 seconds, so this turn was stopped. " +
              "Send the message again; if it keeps happening, run the Claude Code CLI once in a terminal to see what it is waiting for." });
          stopping = true;
          const result = inputs.selectedResult;
          if (result) settle(result, true); else finish(false, "interrupted");
          return;
        }
        const failed = inputs.failedTerminal;
        if (failed) {
          sealed = true;
          const result = inputs.selectedResult;
          if (result?.is_error) settle(result, true);
          else {
            emit({ ...envelope(threadId, turnId), type: "runtime.error", message: failed });
            stopping = true;
            if (result) settle(result, true); else finish(false, "interrupted");
          }
          return;
        }
        // Every accepted input has its own completion, steers included, so
        // there is nothing left to wait out: a quiet spell is only how a
        // CLI that does not say which input a result answers is read. What
        // is left is background work, when the turn waits for it.
        if (inputs.ready) {
          afterBackground(() => settle(lastWork ?? inputs.selectedResult));
          return;
        }
        const wait = inputs.nextWaitMs;
        if (wait !== null) {
          completionTimer = setTimeout(checkCompletion, Math.max(1, wait));
          completionTimer.unref?.();
        }
      };

      const initializeId = newId();
      const startupReplies = new Map<string, (response: any) => void>();
      let initialized: (response: any) => void;
      const personInitialized = new Promise<any>((resolve) => { initialized = resolve; });
      let commands: ClaudeCommandRow[] | null = null;
      let initSkills: unknown;
      let terminalCommands: unknown;
      const reportCommands = () => {
        const catalog = classifyClaudeCommands(commands, initSkills, terminalCommands);
        if (catalog) emit({ ...envelope(threadId, turnId), type: "commands.updated", cwd: turn.cwd ?? null, catalog });
      };
      const consume = (raw: string) => {
        // A person leaves no background authority behind: late frames
        // cannot become the next owner's text, session or approvals.
        if (abandoned || sealed) return;
        let frame: any;
        try {
          frame = JSON.parse(raw);
        } catch {
          return; // a log line, not protocol
        }
        // Partial frames are deliberately unused, even for activity clocks.
        if (frame.type === "stream_event") return;
        // Anything else is the process at work, a subagent's frames too: a
        // foreground subagent is the parent's open call making progress,
        // not a call gone silent (GitHub 146).
        lastSign = Date.now();
        // Native child text/errors/tools cannot impersonate the parent.
        // Keep usage, without changing the parent's context reading.
        if (frame.parent_tool_use_id != null) {
          appendNative(threadId, { dir: "in", source: "claude.sdk.message", msg: frame });
          accountChild(frame);
          return;
        }
        const acceptedIds: string[] = frame.type === "command_lifecycle" && ["started", "completed"].includes(frame.state) && typeof frame.command_uuid === "string"
          ? [frame.command_uuid]
          : frame.type === "system" && frame.subtype === "status" && frame.status === "requesting" && Array.isArray(frame.user_message_uuids)
            ? frame.user_message_uuids.filter((id: unknown): id is string => typeof id === "string")
            : [];
        for (const id of acceptedIds) {
          const wait = confirmations.get(id);
          if (wait) { confirmations.delete(id); wait.accepted(); }
        }
        noteBackground(frame);
        if (inputs && frame.type === "command_lifecycle") {
          if (inputs.terminal(frame)) checkCompletion();
          return;
        }
        if (inputs && frame.type === "system" && frame.subtype === "status" && frame.status === "requesting") {
          if (inputs.requesting(frame)) checkCompletion();
          return;
        }
        if (inputs && frame.type === "result") {
          if (inputs.result(frame)) {
            appendNative(threadId, { dir: "in", source: "claude.sdk.message", msg: frame });
            lastWork = null;
            checkCompletion();
          } else if (waiting && frame !== lastWork && (typeof frame.uuid !== "string" || frame.uuid !== lastWork?.uuid)) {
            // the CLI's own turn, telling the agent what its background
            // work found: no input of ours, but this turn's all the same
            appendNative(threadId, { dir: "in", source: "claude.sdk.message", msg: frame });
            lastWork = frame;
            checkBackground();
          }
          return;
        }
        // initialize also returns account, models, pid and session state.
        // None of those belong in Bloks' logs, transcript or event stream.
        if (frame.type === "control_response") {
          if (frame.response?.request_id === initializeId && frame.response?.subtype === "success") {
            commands = readClaudeCommands(frame.response.response?.commands);
            reportCommands();
            initialized(frame.response.response);
          }
          startupReplies.get(frame.response?.request_id)?.(frame.response);
          startupReplies.delete(frame.response?.request_id);
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
              if (turn.person) {
                try { checkPersonClaudeInit(frame, Object.keys(mcpServers)); }
                catch (error) {
                  personReady = false;
                  sealed = true;
                  emit({ ...envelope(threadId, turnId), type: "runtime.error", message: (error as Error).message });
                  finish(false, "person_guard"); return;
                }
              }
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
            // Not a 403, though: that is the service turning this person
            // away in a sentence of its own, which signing in again does
            // not change, so the CLI's words stand and the notice says the
            // service's (failover.ts errorWords).
            if (typeof frame.error === "string" && frame.error) {
              const said =
                frame.error === "authentication_failed" && apiRefusal(text)?.status !== 403
                  ? "Claude Code is not signed in on this computer. Open Terminal, run claude and sign in, then send this again. Or pick another engine for this agent."
                  : text.trim() || `Claude Code could not run this turn (${frame.error}).`;
              // a safety refusal fails the turn too, so it is asked again
              // in a new session rather than read as an answer (GitHub 284)
              if (outReason(said) || isLimitNotice(said) || isRefusal(said)) outNotice = said;
              emit({ ...envelope(threadId, turnId), type: "runtime.error", message: said });
              break;
            }
            // Versions that mark nothing still speak as "<synthetic>", or
            // say nothing but the limit notice. Either is the engine being
            // out, not the agent's reply.
            const calls = Array.isArray(message.content) && message.content.some((block: any) => block?.type === "tool_use");
            if (!calls && ((message.model === "<synthetic>" && (outReason(text) || isRefusal(text))) || isLimitNotice(text))) {
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
                toolCalls.set(block.id, { name: String(block.name ?? "A tool call"), input: block.input });
              }
              const paths = editedPaths(block.name, block.input);
              emit({
                ...envelope(threadId, turnId),
                type: "item.started",
                itemType: "tool",
                itemId: block.id,
                title: block.name,
                ...(block.name === "Bash" && typeof block.input?.command === "string" ? { command: block.input.command } : {}),
                ...(paths.length ? { paths } : {}),
                // a command writes what it writes, and says nothing of it
                ...(block.name === "Bash" ? { mayWrite: true } : {}),
                signature: callSignature(block.name, block.input),
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
                // A call still running, or a question still open, is not
                // quiet: the model says nothing while a long command runs,
                // and ending there left that command, and the process it
                // ran in, going on beside the next turn (GitHub 330).
                if (sealed || openCalls.size > 0 || asking > 0 || Date.now() - lastSign < STEER_QUIET_MS) return;
                if (letFinish && backgroundBusy()) return;
                if (held) settle(held);
              }, 1_000);
              quiet.unref?.();
              break;
            }
            // Background work still going, when the turn waits for it: the
            // CLI goes on with it, input closed, tells the agent what each
            // part found, and exits once all of it is done. Each result on
            // the way is the latest the turn would end on.
            if (letFinish && (waiting || backgroundBusy())) {
              held = frame;
              if (!waiting) afterBackground(() => { if (held) settle(held); });
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
        if (sealed) return;
        sealed = true;
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
        if (sealed) return;
        if (inputs && !inputs.exited()) {
          sealed = true;
          emit({ ...envelope(threadId, turnId), type: "runtime.error", message: describeEarlyExit(code, stderr, { name: "Claude Code", signIn: "run `claude` once in a terminal" }) });
          stopping = true;
          const result = inputs.selectedResult;
          if (result) settle(result, true); else finish(false, "interrupted");
          return;
        }
        if (inputs?.selectedResult) return settle(lastWork ?? inputs.selectedResult);
        if (stopping) return endStopped();
        // a held result was the whole turn after all
        if (held) return settle(held);
        // Exiting without a `result` frame means it never got as far as
        // answering, so stderr is the only thing that can explain it.
        sealed = true;
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
        ended(code);
      });

      // The output can outlive the process: something it started that
      // escaped the group still holds the pipe, and "close" waits for
      // that. The process is what the turn was, so give the pipe a moment
      // and then stop waiting on it.
      child.on("exit", (code) => {
        const late = setTimeout(() => {
          if (sealed) return;
          abandoned = true;
          ended(code);
        }, STOP_GRACE_MS);
        late.unref?.();
      });

      const abort = () => {
        if (sealed || stopping) return;
        stopping = true;
        const result = (inputs && lastWork) ?? inputs?.selectedResult ?? held;
        if (result) settle(result); else endStopped();
      };

      // A call gone silent ends the turn, and says which call it was.
      const limitMs = typeof turn.stallMs === "number" ? turn.stallMs : DEFAULT_STALL_MINUTES * 60_000;
      if (limitMs > 0) {
        watch = setInterval(() => {
          if (sealed || stopping) return;
          const now = Date.now();
          // Once the reply is done and the turn waits on its background
          // work, each task is a call of the turn's: one gone silent for
          // the limit stops it, as a silent call would.
          const waitingOn = waiting ? [...background.values()] : [];
          if (!isStalled({ open: openCalls.size + waitingOn.length, asking, lastSign, now, limitMs })) return;
          const oldest = [...openCalls.values(), ...waitingOn].sort((a, b) => a.since - b.since)[0];
          stalled = describeStall(oldest, now - lastSign);
          sealed = true;
          stopping = true;
          emit({ ...envelope(threadId, turnId), type: "runtime.error", message: stalled });
          const result = (inputs && lastWork) ?? inputs?.selectedResult ?? held;
          if (result) settle(result, true); else endStopped();
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
      const inputFailed = () => {
        if (sealed) return;
        // A failed spawn has no stdin recipient. Let its error listener
        // preserve the CLI/install error and ordinary startup recovery.
        if (!child.pid) return;
        sealed = true;
        emit({ ...envelope(threadId, turnId), type: "runtime.error",
          message: "Claude Code stopped accepting input, so this turn was stopped. Send the message again." });
        stopping = true;
        const result = inputs?.selectedResult ?? held;
        if (result) settle(result, true); else finish(false, "interrupted");
      };
      const say = (text: string, onDispatch?: () => void, onId?: (id: string | null) => void): boolean => {
        // Over stdin, never argv: a pasted document would blow past
        // ARG_MAX, and argv is readable by every process on the machine.
        if (sealed || !inputOpen || child.stdin.destroyed || !child.stdin.writable) return false;
        const id = inputs ? newId() : null;
        const message = { type: "user", message: { role: "user", content: text }, ...(id ? { uuid: id } : {}) };
        if (id) inputs!.register(id);
        onId?.(id);
        // Words for a turn waiting on its background work: the turn ends
        // once these are answered too, and what it waits on is asked again.
        if (waiting) {
          waiting = null;
          if (waitTimer) clearInterval(waitTimer);
          waitTimer = null;
        }
        // Reserved-report admission must run immediately before the effect.
        try { onDispatch?.(); } catch (error) {
          if (id) inputs!.forget(id);
          throw error;
        }
        try {
          child.stdin.write(JSON.stringify(message) + "\n", (error) => {
            if (!error || sealed) return;
            if (id) inputs!.forget(id);
            inputFailed();
          });
        } catch (error) {
          if (id) inputs!.forget(id);
          inputFailed();
          throw error;
        }
        appendNative(threadId, { dir: "out", source: "claude.sdk.message", msg: message });
        checkCompletion();
        return true;
      };
      const steer = (text: string, onDispatch?: () => void) => {
        if (sealed || stopping || exited || !inputOpen) return false;
        const previous = steered;
        try {
          const accepted = say(text, () => { onDispatch?.(); steered = true; });
          if (!accepted) steered = previous;
          return accepted;
        } catch (error) { steered = previous; throw error; }
      };

      const steerPrepared: RunningTurn["steerPrepared"] = async (text, options) => {
        if (sealed || stopping || exited || !inputOpen || !personReady) return "refused";
        return new Promise((resolve) => {
          let done = false;
          let timer: ReturnType<typeof setTimeout> | undefined;
          const settle = (outcome: "accepted" | "refused" | "uncertain") => {
            if (done) return;
            done = true;
            if (timer) clearTimeout(timer);
            resolve(outcome);
          };
          let id: string | null = null, dispatched = false;
          try {
            const sent = say(text, () => { options.onDispatch(); dispatched = true; steered = true; }, (value) => {
              id = value;
              if (!value) return;
              confirmations.set(value, {
                accepted: () => { if (done) options.onAcceptedLate?.(); else settle("accepted"); },
                ended: () => settle("uncertain"),
              });
            });
            if (!sent) return settle("refused");
            if (!id) return settle("uncertain");
            timer = setTimeout(() => settle("uncertain"), 30_000);
            timer.unref?.();
          } catch {
            if (id) confirmations.delete(id);
            settle(dispatched ? "uncertain" : "refused");
          }
        });
      };

      running.set(threadId, { turnId, abort, steer, steerPrepared, broker, cleanup: () => {
        // Disposal's instance-wide helper may have forgotten this leader
        // after its exit. Its resistant owned helpers still need escalation.
        if (!owner.confirmed) signalGroup(child, "SIGKILL");
        return owner.end();
      } });
      emit({ ...envelope(threadId, turnId), type: "turn.started" });

      // Bare metadata request: does not change permissions, hooks or tools.
      // Do not await it; an older CLI can ignore it and still run this turn.
      const initialize = { type: "control_request", request_id: initializeId, request: { subtype: "initialize" } };
      child.stdin.write(JSON.stringify(initialize) + "\n");
      appendNative(threadId, { dir: "out", source: "claude.sdk.message", msg: initialize });
      const sendInitial = (baseWords: string) => {
        // Older or unknown CLIs cannot identify accepted inputs. Keep their
        // existing running-turn steering, and leave preparation additions
        // for the normal next-turn queue instead of guessing delivery.
        if (!attributedPreparation) turn.preparation?.unavailable();
        const prepared = attributedPreparation ? turn.preparation?.freeze().commit() : undefined;
        let inputId: string | null = null;
        try {
          const sent = say(prepared?.text ? `${baseWords}\n\n${prepared.text}` : baseWords, undefined, (id) => {
            inputId = id;
            if (!id || !prepared?.text) return;
            let ended = false;
            const timer = setTimeout(() => {
              ended = true;
              prepared.settle("uncertain");
            }, 30_000);
            timer.unref?.();
            confirmations.set(id, {
              accepted: () => { clearTimeout(timer); prepared.settle("accepted"); if (!ended) turn.preparation?.ready(turnId); },
              ended: () => { clearTimeout(timer); if (!ended) prepared.settle("uncertain"); },
            });
          });
          if (!sent) { prepared?.settle("refused"); turn.preparation?.unavailable(); return false; }
          if (attributedPreparation && !prepared?.text) turn.preparation?.ready(turnId);
          else if (prepared?.text && !inputId) prepared.settle("uncertain");
          return true;
        } catch (error) {
          prepared?.settle("uncertain");
          throw error;
        }
      };
      if (turn.person) {
        void (async () => {
          const end = Date.now() + 20_000;
          const withDeadline = <T,>(pending: Promise<T>): Promise<T> => new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(personTurnHold("Claude did not report startup permissions in time.")), Math.max(1, end - Date.now()));
            pending.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
          });
          try {
            const metadata = await withDeadline(personInitialized);
            for (;;) {
              if (sealed || stopping) return;
              const id = newId();
              const response = new Promise<any>((resolve) => startupReplies.set(id, resolve));
              child.stdin.write(JSON.stringify({ type: "control_request", request_id: id, request: { subtype: "mcp_status" } }) + "\n");
              const status = await withDeadline(response);
              if (status.subtype !== "success") throw personTurnHold("Claude did not report its mounted tools.");
              if (checkPersonClaudeStatus(metadata.current_permission_mode, status.response, Object.keys(mcpServers), personTools)) break;
              await new Promise((resolve) => setTimeout(resolve, 100));
            }
            if (sealed || stopping) return;
            personReady = true;
            if (!sendInitial(turn.text)) inputFailed();
          } catch (error) {
            if (sealed) return;
            sealed = true;
            emit({ ...envelope(threadId, turnId), type: "runtime.error", message: (error as Error).message });
            finish(false, "person_guard");
          }
        })();
      } else if (!sendInitial(words)) inputFailed();

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
        capabilities: { sessionModelSwitch: "in-session", efforts: CLAUDE_EFFORTS },
        sendTurn,

        steerTurn: async (threadId, text, options) => running.get(threadId)?.steer(text, options?.onDispatch) ?? false,

        steerPrepared: async (threadId, expectedTurnId, text, options) => {
          const active = running.get(threadId);
          return active && active.turnId === expectedTurnId ? active.steerPrepared(text, options) : "refused";
        },

        interruptTurn: async (threadId) => running.get(threadId)?.abort(),

        respondToRequest: async (threadId, requestId, decision) => {
          const brokers = [running.get(threadId)?.broker].filter(
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
        },

        onEvent: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },

      textModel: ONE_SHOT_MODEL,
      // The prompt goes in on stdin, like a turn's: a summary prompt is the
      // conversation itself, and argv is readable by every process on the
      // machine. The same variables a turn drops are dropped here, or a key
      // in the environment would bill these summaries to the API instead
      // of the person's subscription.
      generateText: (prompt: string, options?: { quick?: boolean }) =>
        new Promise((resolve, reject) => {
          const env: Record<string, string | undefined> = { ...process.env };
          delete env.ANTHROPIC_API_KEY;
          delete env.CLAUDECODE;
          delete env.CLAUDE_CODE_ENTRYPOINT;
          // Thinking first is most of the wait on a short answer: a new
          // agent's draft took 9 to 30 seconds with it and about 4 without,
          // the same model writing much the same thing.
          if (options?.quick) env.MAX_THINKING_TOKENS = "0";
          // This writes text, not work in the server's project. Keep the
          // sign-in home, but load none of its customizations or tools.
          const cwd = mkdtempSync(join(tmpdir(), "bloks-text-"));
          const tidy = () => {
            try {
              rmSync(cwd, { recursive: true, force: true, maxRetries: 3 });
            } catch (error) {
              console.error("[claude-text] could not remove the temporary folder:", error);
            }
          };
          const cli = /[/\\]/.test(config.cli) ? resolvePath(config.cli) : config.cli;
          let child: ChildProcessWithoutNullStreams;
          try {
            child = spawn(cli, [
              "-p", "--model", ONE_SHOT_MODEL, "--output-format", "text",
              "--safe-mode", "--setting-sources", "", "--tools", "",
              "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
              "--no-session-persistence",
            ], { cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
          } catch (error) {
            tidy();
            reject(error);
            return;
          }
          let out = "";
          let err = "";
          let killTimer: ReturnType<typeof setTimeout> | undefined;
          const timer = setTimeout(() => {
            // asked to stop first, so it can take its own children with it,
            // and only then made to
            child.kill("SIGTERM");
            killTimer = setTimeout(() => child.kill("SIGKILL"), 3_000);
            killTimer.unref?.();
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
            clearTimeout(killTimer);
            tidy();
            if (code === 0) resolve(out.trim());
            else reject(new Error(err.trim() || `Claude Code exited with ${code}`));
          });
          child.stdin.end(prompt);
        }),

      dispose: async () => {
        const turns = [...running.values()];
        for (const turn of turns) turn.abort();
        listeners.clear();
        await engines.end();
        await Promise.all(turns.map(turn => turn.cleanup()));
      },
    };
  },
};
