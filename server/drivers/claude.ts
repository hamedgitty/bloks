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
import { createAskBroker, summarise, type AskBroker } from "../harness/ask-broker.ts";

/** The answerable options of an ask, wherever the tool put them: a flat
 * choices list, or AskUserQuestion's nested option objects. */
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

const DRIVER_KIND = "claudeAgent";

const MODELS = {
  default: "claude-sonnet-5",
  options: [
    { id: "claude-fable-5-1", label: "Claude Fable 5.1" },
    { id: "claude-fable-5", label: "Claude Fable 5" },
    { id: "claude-opus-5", label: "Claude Opus 5" },
    { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
    { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
  ],
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
const PERMISSION_HELPER = helperEntry("permission-proxy");

/** In the packaged app `process.execPath` is Electron, not node. This makes
 * it behave as plain node for anything we spawn with it, and does nothing
 * in development where it already is node. */
const RUN_AS_NODE = { ELECTRON_RUN_AS_NODE: "1" };

/** Socket path for a turn's permission bridge. Short and thread-derived:
 * unix socket paths have a length limit that full ids would risk. */
function brokerSocket(threadId: string) {
  const tag = threadId.replace(/[^\w-]/g, "").slice(0, 8);
  return join(DATA_DIR, `perm-${tag}.sock`);
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

    interface RunningTurn {
      turnId: string;
      abort: () => void;
      broker?: AskBroker;
    }
    /** At most one turn per thread. A second send while one is live is a
     * caller bug, not a queue to manage. */
    const running = new Map<string, RunningTurn>();

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

      const argv = [
        "-p",
        "--output-format", "stream-json",
        "--input-format", "stream-json",
        "--verbose", // stream-json output is refused without it
        "--permission-mode", config.permissionMode === "auto" ? "acceptEdits" : config.permissionMode,
      ];
      // Resuming continues the CLI's own session; otherwise name the new
      // one ourselves so the id exists before its first event arrives.
      if (resume) argv.push("--resume", resume);
      else argv.push("--session-id", newId());
      if (turn.model) argv.push("--model", turn.model);
      // extra editable folders, chiefly the agent's own workspace: memory
      // updates must not stall on approval cards when cwd points elsewhere
      for (const dir of turn.extraDirs ?? []) argv.push("--add-dir", dir);

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

      // bypassPermissions means nothing would ever ask, so there is nothing
      // to broker. Every other mode gets the bridge.
      let broker: AskBroker | undefined;
      if (config.permissionMode !== "bypassPermissions") {
        const socketPath = brokerSocket(threadId);
        broker = createAskBroker({
          socketPath,
          onAsk: (ask) =>
            emit({
              ...envelope(threadId, turnId),
              type: "request.opened",
              requestId: ask.id,
              requestType: ask.kind,
              tool: ask.tool,
              input: ask.input,
              summary: summarise(ask),
              choices: askChoices(ask.input),
            }),
          onResolve: (resolved) =>
            emit({
              ...envelope(threadId, turnId),
              type: "request.resolved",
              requestId: resolved.id,
              behavior: resolved.behavior,
              source: resolved.source,
            }),
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
        argv.push("--allowedTools", allowed.join(","));
      }

      const env: Record<string, string | undefined> = {
        ...process.env,
        NPM_CONFIG_LOGLEVEL: "error",
        // the turn's own credential, so the agent can act on the
        // workspace as itself rather than only describe what should happen
        ...(turn.env ?? {}),
      };
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
        detached: true,
      });

      let finished = false;
      const finish = (ok: boolean, stopReason: string | null, cost: number | null = null) => {
        if (finished) return;
        finished = true;
        broker?.close();
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

      const consume = (raw: string) => {
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
              emit({
                ...envelope(threadId, turnId),
                type: "item.started",
                itemType: "tool",
                itemId: block.id,
                title: block.name,
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
            finish(
              frame.is_error !== true,
              frame.stop_reason ?? frame.terminal_reason ?? null,
              frame.total_cost_usd ?? null,
            );
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
            install: "npm i -g @anthropic-ai/claude-code",
            signIn: "run `claude` once to sign in",
          }),
        });
        finish(false, "spawn_error");
      });

      child.on("close", (code) => {
        if (finished) return;
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
      });

      const abort = () => {
        try {
          process.kill(-child.pid!, "SIGTERM");
        } catch {
          // no process group (already reaped, or platform quirk)
          try {
            child.kill("SIGTERM");
          } catch {
            /* gone */
          }
        }
      };

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
      const version = await new Promise<string | null>((resolve) => {
        execFile(config.cli, ["--version"], { timeout: 8_000 }, (error, stdout) =>
          resolve(error ? null : stdout.trim()),
        );
      });
      if (!version) return { state: "unavailable", reason: `\`${config.cli}\` CLI not found` };

      // Installed and signed in are different states, and the difference is
      // the whole content of the error a user would otherwise hit on their
      // first message. The CLI itself is the authority: current versions
      // keep the login in the macOS Keychain, where no file check can see
      // it. Older ones lack the subcommand, so the file is the fallback.
      const authenticated = await new Promise<boolean>((resolve) => {
        execFile(config.cli, ["auth", "status"], { timeout: 8_000 }, (error, stdout) => {
          if (error) {
            return resolve(existsSync(join(homedir(), ".claude", ".credentials.json")));
          }
          try {
            resolve(JSON.parse(stdout).loggedIn === true);
          } catch {
            // it answered without erroring, which older CLIs do not
            resolve(true);
          }
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
          const broker = running.get(threadId)?.broker;
          if (!broker) throw new Error("nothing on this thread is waiting to be answered");
          if (!broker.answer(requestId, decision.behavior, decision.message)) {
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

      generateText: (prompt: string) =>
        new Promise((resolve, reject) => {
          execFile(
            config.cli,
            ["-p", prompt, "--model", ONE_SHOT_MODEL, "--output-format", "text"],
            { timeout: 60_000, env: { ...process.env } },
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
