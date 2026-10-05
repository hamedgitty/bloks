// Claude Code, driven as a subprocess.
//
// The CLI is run once per turn with JSON on both ends of the pipe: the
// prompt goes in on stdin as a stream-json message, and a sequence of
// stream-json events comes back on stdout. Continuity across turns is the
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
import { SessionCosts } from "./session-costs.ts";
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

    interface RunningTurn {
      turnId: string;
      abort: () => void;
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

      // Nothing asks when the engine is set to bypass, or when this agent is
      // in full access; a shared room is never either.
      const bypass = !turn.shared && (config.permissionMode === "bypassPermissions" || Boolean(turn.fullAccess));
      const argv = [
        "-p",
        "--output-format", "stream-json",
        "--input-format", "stream-json",
        "--verbose", // stream-json output is refused without it
        // A shared room never bypasses: the approval bridge below is what
        // holds the owner's tools to a yes. acceptEdits only waves through
        // file edits, which --restricted confines to the room's folder.
        "--permission-mode",
        turn.shared
          ? "acceptEdits"
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
      if (turn.system) {
        personaDir = mkdtempSync(join(tmpdir(), "bloks-persona-"));
        const personaFile = join(personaDir, "system.md");
        writeFileSync(personaFile, turn.system, { mode: 0o600 });
        argv.push("--append-system-prompt-file", personaFile);
      }

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

      // bypassPermissions means nothing would ever ask, so there is nothing
      // to broker. Every other mode gets the bridge.
      let broker: AskBroker | undefined;
      if (!bypass) {
        const socketPath = brokerSocket(threadId, turnId);
        broker = createAskBroker({
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
        argv.push("--permission-prompt-tool", "mcp__bloks__approve");
        mcpServers.bloks = {
          command: process.execPath,
          args: [PERMISSION_HELPER, socketPath],
          env: { ...RUN_AS_NODE },
        };
        allowed.push("mcp__bloks");
      }

      if (Object.keys(mcpServers).length) {
        argv.push("--mcp-config", JSON.stringify({ mcpServers }));
        // In a shared room nothing of the owner's is pre-allowed: every
        // call to a connector, the browser or the computer goes through
        // the bridge and becomes an approval, which is the point.
        const allowList = turn.shared ? allowed.filter((tool) => tool === "mcp__bloks") : allowed;
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
      // A result that did nothing (see `case "result"`), held until the
      // real one arrives or the process ends without one.
      let held: any = null;
      let watch: ReturnType<typeof setInterval> | null = null;
      const finish = (ok: boolean, stopReason: string | null, cost: number | null = null) => {
        if (finished) return;
        finished = true;
        if (watch) clearInterval(watch);
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
        const total = typeof frame.total_cost_usd === "number" && Number.isFinite(frame.total_cost_usd) ? frame.total_cost_usd : null;
        const session = typeof frame.session_id === "string" ? frame.session_id : sessionId;
        if (stopping) {
          finish(false, stalled ? "tool_stalled" : "interrupted", total !== null && session ? sessionCosts.turn(session, total, Boolean(resume)) : null);
          return;
        }
        finish(
          frame.is_error !== true,
          // a failed turn's own words say why ("usage limit reached"),
          // which is what a backup engine and a routine's log need
          (frame.is_error === true && typeof frame.result === "string" && frame.result.trim()
            ? frame.result.trim().slice(0, 400)
            : null) ??
            frame.stop_reason ??
            frame.terminal_reason ??
            null,
          total !== null && session ? sessionCosts.turn(session, total, Boolean(resume)) : null,
        );
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
        appendNative(threadId, { dir: "in", source: "claude.sdk.message", msg: frame });

        switch (frame.type) {
          case "system":
            if (frame.subtype === "init") {
              if (typeof frame.session_id === "string") sessionId = frame.session_id;
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
              emit({
                ...envelope(threadId, turnId),
                type: "runtime.error",
                message:
                  frame.error === "authentication_failed"
                    ? "Claude Code is not signed in on this computer. Open Terminal, run claude and sign in, then send this again. Or pick another engine for this agent."
                    : text.trim() || `Claude Code could not run this turn (${frame.error}).`,
              });
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
              emit({
                ...envelope(threadId, turnId),
                type: "thread.token-usage.updated",
                // cache reads are still input the user paid attention to,
                // even when they cost less
                input: (message.usage.input_tokens || 0) + (message.usage.cache_read_input_tokens || 0),
                output: message.usage.output_tokens || 0,
              });
            }
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
            // On --resume Claude Code can first settle something the last
            // session left running (a background shell it stopped) with a
            // result of its own: no model turns, no API time. The answer to
            // this turn comes after it in the same process, so that result
            // is held rather than taken as the end. Ending there revoked the
            // turn's credential while the agent was still working and showed
            // it idle, so a second turn could start on the same session
            // (GitHub 134).
            if (frame.is_error !== true && frame.num_turns === 0 && !frame.duration_api_ms) {
              held = frame;
              break;
            }
            settle(frame);
            break;
        }
      };

      let stdout = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
        for (;;) {
          const cut = stdout.indexOf("\n");
          if (cut === -1) break;
          const line = stdout.slice(0, cut);
          stdout = stdout.slice(cut + 1);
          if (line.trim()) consume(line);
        }
      });

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

      running.set(threadId, { turnId, abort, broker });
      emit({ ...envelope(threadId, turnId), type: "turn.started" });

      // Over stdin, never argv: a pasted document would blow past ARG_MAX,
      // and argv is readable by every process on the machine.
      const prompt = { type: "user", message: { role: "user", content: turn.text } };
      child.stdin.write(JSON.stringify(prompt) + "\n");
      child.stdin.end();
      appendNative(threadId, { dir: "out", source: "claude.sdk.message", msg: prompt });

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

      adapter: {
        provider: DRIVER_KIND,
        capabilities: { sessionModelSwitch: "in-session" },
        sendTurn,

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

      generateText: (prompt: string) =>
        new Promise((resolve, reject) => {
          execFile(
            config.cli,
            ["-p", prompt, "--model", ONE_SHOT_MODEL, "--output-format", "text"],
            { timeout: 60_000, env: { ...process.env }, windowsHide: true },
            (error, stdout) => (error ? reject(error) : resolve(stdout.trim())),
          );
        }),

      dispose: async () => {
        for (const turn of running.values()) turn.abort();
        listeners.clear();
      },
    };
  },
};
