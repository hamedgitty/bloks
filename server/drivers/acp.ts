// Agent Client Protocol driver: one implementation, many coding agents.
//
// ACP is a JSON-RPC protocol over stdio that agent CLIs speak so editors
// can drive them. It carries the things a chat API cannot: tool calls as
// they happen, and permission requests the user has to answer. That makes
// it the right shape for Bloks, where an approval card is a first-class
// thing, and it means adding another ACP agent is a catalog entry rather
// than another driver.
//
// Shapes here were read off the wire from gemini-cli 0.55.1, not guessed:
//   initialize            -> { protocolVersion, agentCapabilities, agentInfo }
//   session/new           -> { sessionId, models, modes }
//   session/load          -> resumes a prior sessionId (loadSession capability).
//                            The spec says the agent then replays the whole
//                            conversation as session/update; Bloks already
//                            has that transcript, so those frames are dropped.
//   session/prompt        -> blocks for the turn, returns { stopReason, usage }
//   session/update        <- streaming notifications (text, tools, thoughts)
//   session/request_permission <- a real request we must answer
//
// A turn spawns a process and kills it on settle, the same as the codex
// driver. Continuity comes from session/load with the stored id.
import { spawn, execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
import { attachRpc } from "../harness/jsonrpc-stdio.ts";
import { onPath, widenPath } from "../path.ts";
import { appendNative } from "./native.ts";
import { describeEarlyExit, describeSpawnError } from "./spawn-error.ts";

export interface AcpSpec {
  kind: string;
  name: string;
  /** The executable and the flag that puts it in ACP mode. */
  command: string;
  args: string[];
  /** Extra argv built per turn, for CLIs that take model or permission
   * flags on the command line rather than through the protocol. */
  turnArgs?: (opts: { fullAuto: boolean; model?: string; effort?: string }) => string[];
  /** Inherited env vars to strip before spawning. A CLI that owns its own
   * subscription login can silently flip to pay-as-you-go billing if a
   * same-vendor API key leaks through. */
  scrubEnv?: string[];
  /** Shown when the CLI is not on PATH. */
  install: string;
  /** What to do once it is installed, named in error messages. */
  signIn?: string;
  /** Credentials to hand the child, if the app has them. Some agents hold
   * their own login instead and ignore these entirely. */
  keyEnv?: string[];
  /** Paths under the home directory that mean the CLI holds a login of
   * its own. Checked so an installed-but-signed-out agent says so instead
   * of failing on the first message. */
  authFiles?: string[];
  /** Used until session/new reports what the agent actually serves. */
  models: ModelCatalog;
  /** When --version would start a session instead of printing a
   * version, the install probe is "is this binary on PATH". */
  probePath?: boolean;
  /** Engines whose catalog follows their own configuration (pi reads its
   * connected providers) stay behind the placeholder until the first
   * turn otherwise. Set to probe a throwaway session for the real
   * catalog, so the picker lists actual models from the start. */
  probeModels?: boolean;
}

export interface AcpConfig {
  cli: string;
  /** Skip every approval prompt. Off by default: the whole point of ACP
   * here is that the user gets asked. */
  fullAuto: boolean;
}

const PROTOCOL_VERSION = 1;

/** How long a probe session may take to report its catalog. A hung CLI
 * (pi-acp --version starts a session) will sit forever without this. */
const PROBE_TIMEOUT_MS = 15_000;

/** We do not lend the agent our filesystem or terminal; it has its own,
 * and every borrowed capability is another way in. */
const CLIENT_HELLO = {
  protocolVersion: PROTOCOL_VERSION,
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
  clientInfo: { name: "bloks", version: "1" },
};

/** The connectors bridge ships as TypeScript in development and compiled
 * JavaScript in the packaged app; resolve whichever is actually there. */
function connectorsHelper(): string {
  const asTypeScript = join(dirname(fileURLToPath(import.meta.url)), "..", "connectors-proxy.ts");
  return existsSync(asTypeScript) ? asTypeScript : asTypeScript.replace(/\.ts$/, ".js");
}

/** ACP tool kinds, mapped to something worth reading in a transcript. */
function toolTitle(update: any): string {
  const title = typeof update?.title === "string" ? update.title : null;
  if (title) return title.slice(0, 100);
  return typeof update?.kind === "string" ? update.kind : "tool";
}

function catalogFromSession(session: any): ModelCatalog | null {
  const available: any[] = session?.models?.availableModels ?? [];
  if (!available.length) return null;
  return {
    default: String(session.models.currentModelId ?? available[0].modelId),
    options: available.map((m) => ({ id: String(m.modelId), label: String(m.name || m.modelId) })),
  };
}

/** The catalog an ACP agent serves, from one throwaway session, or null
 * when the agent cannot be asked. ACP has no catalog without a session,
 * so there is no cheaper question. No prompt is sent: nothing is spent,
 * and the child is killed as soon as the answer lands. */
async function probeCatalog(spec: AcpSpec, cli: string, env: Record<string, string | undefined>): Promise<ModelCatalog | null> {
  const child = spawn(cli, spec.args, { cwd: tmpdir(), env, stdio: ["pipe", "pipe", "pipe"] });
  // a chatty CLI can fill stderr and stall if nobody reads it
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
    await rpc.request("initialize", CLIENT_HELLO);
    const session = await rpc.request("session/new", { cwd: tmpdir(), mcpServers: [] });
    return catalogFromSession(session);
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

export function acpDriver(spec: AcpSpec): ProviderDriver<AcpConfig> {
  const decodeConfig = (raw: unknown): AcpConfig => {
    const o = (raw ?? {}) as Record<string, unknown>;
    return {
      cli: typeof o.cli === "string" && o.cli ? o.cli : spec.command,
      fullAuto: o.fullAuto === true,
    };
  };

  return {
    driverKind: spec.kind,
    metadata: { displayName: spec.name, supportsMultipleInstances: true },
    models: spec.models,
    decodeConfig,
    defaultConfig: () => decodeConfig({}),

    async create(input: DriverCreateInput<AcpConfig>): Promise<ProviderInstance> {
      const { instanceId, config } = input;
      const listeners = new Set<RuntimeEventListener>();
      interface Turn {
        /** Ask the agent to stop, then kill it if it will not. */
        interrupt: () => void;
        stop: () => void;
        turnId: string;
        asks: Map<string, (behavior: string, message?: string) => void>;
      }
      const active = new Map<string, Turn>();

      // replaced the first time an agent tells us what it serves
      const models: ModelCatalog = { default: spec.models.default, options: [...spec.models.options] };

      const emit = (event: RuntimeEvent) => {
        for (const l of [...listeners]) l(event);
      };
      const base = (threadId: string, turnId: string) => ({
        eventId: newEventId(),
        provider: spec.kind,
        threadId,
        turnId,
        createdAt: new Date().toISOString(),
      });

      /** `extra` is the turn's own environment, where there is a turn:
       * the credential that lets an agent act on the workspace as itself. */
      const childEnv = (extra: Record<string, string> = {}) => {
        const env: Record<string, string | undefined> = { ...process.env, ...extra };
        for (const key of spec.keyEnv ?? []) {
          const value = input.environment[key];
          if (value) env[key] = value;
        }
        for (const key of spec.scrubEnv ?? []) delete env[key];
        return env;
      };

      // Engines that build their catalog from their own configuration
      // are probed once with a throwaway session, so the picker starts
      // with real models. A failed probe leaves the placeholder; the
      // first turn replaces it with what the agent serves.
      if (spec.probeModels) {
        widenPath();
        void probeCatalog(spec, config.cli, childEnv()).then((catalog) => {
          if (!catalog) return;
          models.options = catalog.options;
          models.default = catalog.default;
        });
      }

      const sendTurn = async (turn: SendTurnInput) => {
        const { threadId } = turn;
        if (active.has(threadId)) throw new Error("a turn is already running on this thread");
        const turnId = newId();

        const argv = [
          ...spec.args,
          ...(spec.turnArgs?.({
            fullAuto: config.fullAuto,
            model: turn.model,
            effort: turn.effort,
          }) ?? []),
        ];
        widenPath();
        const child = spawn(config.cli, argv, {
          cwd: turn.cwd ?? homedir(),
          env: childEnv(turn.env),
          stdio: ["pipe", "pipe", "pipe"],
          detached: true,
        });

        const state = { settled: false, text: "", live: false };
        const asks = new Map<string, (behavior: string, message?: string) => void>();

        const stop = () => {
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
          onFrame: (msg, dir) => appendNative(threadId, { dir, source: `${spec.kind}.acp`, msg }),
          onRequest: (msg) => {
            if (msg.method === "session/request_permission") handlePermission(msg);
            else rpc.replyError(msg.id, -32601, "not supported by this client");
          },
          onNotify: (msg) => {
            if (msg.method === "session/update") handleUpdate(msg.params);
          },
        });

        // An interrupt goes through the protocol first, so the agent can
        // put its tools down properly. The kill is the backstop.
        let sessionId: string | null = null;
        const interrupt = () => {
          if (sessionId) rpc.notify("session/cancel", { sessionId });
          setTimeout(stop, 2_000).unref?.();
        };

        const settle = (ok: boolean, stopReason: string | null) => {
          if (state.settled) return;
          state.settled = true;
          for (const finish of [...asks.values()]) finish("deny", "Bloks: the turn ended");
          rpc.failPending(new Error("turn settled"));
          active.delete(threadId);
          if (state.text.trim()) {
            emit({ ...base(threadId, turnId), type: "item.completed", itemType: "assistant_text", text: state.text });
          }
          emit({ ...base(threadId, turnId), type: "turn.completed", ok, stopReason, cost: null });
          stop();
        };

        // ── agent asks the user for permission ──
        function handlePermission(msg: any) {
          const params = msg.params ?? {};
          const options: any[] = Array.isArray(params.options) ? params.options : [];
          const pick = (kinds: string[]) => options.find((o) => kinds.includes(o?.kind))?.optionId;
          const allowId = pick(["allow_once", "allow_always"]) ?? options[0]?.optionId;
          const denyId = pick(["reject_once", "reject_always"]) ?? options[options.length - 1]?.optionId;

          if (config.fullAuto && allowId) {
            return rpc.reply(msg.id, { outcome: { outcome: "selected", optionId: allowId } });
          }

          const requestId = newId();
          const call = params.toolCall ?? {};
          const finish = (behavior: string, message?: string) => {
            if (!asks.delete(requestId)) return;
            clearTimeout(timer);
            // The card shows the agent's own labels ("Allow once", "Always
            // allow"), so the answer comes back as that text rather than a
            // bare allow/deny. Match it before falling back, or picking
            // "Allow once" would quietly deny.
            const named = message
              ? options.find((o) => String(o?.name ?? "").toLowerCase() === message.trim().toLowerCase())
              : null;
            const optionId = named?.optionId ?? (behavior === "allow" ? allowId : denyId);
            rpc.reply(
              msg.id,
              optionId
                ? { outcome: { outcome: "selected", optionId } }
                : { outcome: { outcome: "cancelled" } },
            );
            const denied = !optionId || optionId === denyId;
            emit({
              ...base(threadId, turnId),
              type: "request.resolved",
              requestId,
              behavior: denied ? "deny" : "allow",
              source: "user",
            });
          };
          const timer = setTimeout(() => finish("deny"), 15 * 60_000);
          timer.unref?.();
          asks.set(requestId, finish);
          emit({
            ...base(threadId, turnId),
            type: "request.opened",
            requestId,
            requestType: "permission",
            tool: typeof call.kind === "string" ? call.kind : "tool",
            summary: toolTitle(call),
            // the agent names its own choices, so use its words
            choices: options.map((o) => String(o?.name ?? "")).filter(Boolean).slice(0, 5),
          });
        }

        // ── streaming updates ──
        function handleUpdate(params: any) {
          // session/load replays history as the same notifications a live
          // turn uses. Until we have sent session/prompt, none of it is
          // this turn's output.
          if (!state.live) return;
          const update = params?.update ?? {};
          switch (update.sessionUpdate) {
            case "agent_message_chunk": {
              const text = update.content?.type === "text" ? String(update.content.text ?? "") : "";
              if (!text) break;
              state.text += text;
              emit({ ...base(threadId, turnId), type: "content.delta", streamKind: "assistant_text", delta: text });
              break;
            }
            case "agent_thought_chunk":
              emit({ ...base(threadId, turnId), type: "item.updated", itemType: "reasoning", tokens: null });
              break;
            case "tool_call":
              emit({
                ...base(threadId, turnId),
                type: "item.started",
                itemType: "tool",
                itemId: String(update.toolCallId ?? newId()),
                title: toolTitle(update),
              });
              break;
            case "tool_call_update": {
              const status = update.status;
              if (status !== "completed" && status !== "failed") break;
              emit({
                ...base(threadId, turnId),
                type: "item.completed",
                itemType: "tool",
                itemId: String(update.toolCallId ?? ""),
                ok: status === "completed",
              });
              break;
            }
          }
        }

        let stderr = "";
        child.stderr.on("data", (c) => {
          stderr += c;
          if (stderr.length > 8192) stderr = stderr.slice(-8192);
        });
        child.on("error", (e) => {
          emit({
            ...base(threadId, turnId),
            type: "runtime.error",
            message: describeSpawnError(e, {
              name: spec.name,
              command: config.cli,
              install: spec.install,
              signIn: spec.signIn,
            }),
          });
          settle(false, "spawn_error");
        });
        child.on("close", (code) => {
          if (state.settled) return;
          emit({
            ...base(threadId, turnId),
            type: "runtime.error",
            message: describeEarlyExit(code, stderr, { name: spec.name, signIn: spec.signIn }),
          });
          settle(false, "exit_before_result");
        });

        active.set(threadId, { interrupt, stop, turnId, asks });
        emit({ ...base(threadId, turnId), type: "turn.started" });

        (async () => {
          try {
            await rpc.request("initialize", CLIENT_HELLO);

            const cursor = typeof turn.resumeCursor === "string" ? turn.resumeCursor : null;
            const cwd = turn.cwd ?? homedir();
            // The connectors, over the stdio bridge, because ACP mounts
            // MCP servers as child processes it spawns itself. The key
            // travels as an env variable, never in argv.
            const mcpServers = turn.integrations?.composio?.key
              ? [
                  {
                    name: "bloks_connectors",
                    command: process.execPath,
                    args: [connectorsHelper()],
                    env: [
                      { name: "BLOKS_COMPOSIO_KEY", value: turn.integrations.composio.key },
                      ...(turn.integrations.composio.url
                        ? [{ name: "BLOKS_COMPOSIO_URL", value: turn.integrations.composio.url }]
                        : []),
                      { name: "ELECTRON_RUN_AS_NODE", value: "1" },
                    ],
                  },
                ]
              : [];
            let session: any = null;
            if (cursor) {
              try {
                session = (await rpc.request("session/load", { cwd, mcpServers, sessionId: cursor })) ?? {};
                session.sessionId ??= cursor;
              } catch {
                /* the agent forgot this session; start a new one below */
              }
            }
            if (!session) session = await rpc.request("session/new", { cwd, mcpServers });
            sessionId = session?.sessionId ?? null;
            if (!sessionId) throw new Error(`${spec.name} did not open a session`);

            // the agent knows its own model list better than we do
            const catalog = catalogFromSession(session);
            if (catalog) {
              models.options = catalog.options;
              models.default = catalog.default;
            }
            if (turn.model && catalog?.options.some((m) => m.id === turn.model)) {
              await rpc.request("session/set_model", { sessionId, modelId: turn.model }).catch(() => {});
            }
            if (config.fullAuto) {
              await rpc.request("session/set_mode", { sessionId, modeId: "yolo" }).catch(() => {});
            }

            emit({
              ...base(threadId, turnId),
              type: "session.started",
              sessionId,
              model: turn.model ?? models.default,
            });

            state.live = true;
            const result = await rpc.request("session/prompt", {
              sessionId,
              prompt: [{ type: "text", text: turn.system ? `${turn.system}\n\n${turn.text}` : turn.text }],
            });
            const usage = result?.usage;
            if (usage) {
              emit({
                ...base(threadId, turnId),
                type: "thread.token-usage.updated",
                input: usage.inputTokens ?? 0,
                output: usage.outputTokens ?? 0,
              });
            }
            const reason = String(result?.stopReason ?? "end_turn");
            settle(reason === "end_turn" || reason === "max_tokens", reason === "end_turn" ? null : reason);
          } catch (e) {
            if (state.settled) return;
            emit({ ...base(threadId, turnId), type: "runtime.error", message: (e as Error).message });
            settle(false, "rpc_error");
          }
        })();

        return { turnId };
      };

      const snapshot = async (): Promise<ProviderSnapshot> => {
        widenPath();
        const version = spec.probePath
          ? (onPath(config.cli) ? basename(config.cli) : null)
          : await new Promise<string | null>((resolve) => {
              execFile(config.cli, ["--version"], { timeout: 8_000 }, (err, stdout) =>
                resolve(err ? null : stdout.trim().split("\n").pop()!.trim()),
              );
            });
        if (!version) return { state: "unavailable", reason: `\`${config.cli}\` CLI not found` };
        const hasKey = (spec.keyEnv ?? []).some((k) => input.environment[k] || process.env[k]);
        const signedIn = (spec.authFiles ?? []).some((f) => existsSync(join(homedir(), f)));
        return { state: "available", version: `${spec.name} ${version}`, authenticated: hasKey || signedIn };
      };

      return {
        instanceId,
        driverKind: spec.kind,
        displayName: input.displayName ?? spec.name,
        enabled: input.enabled,
        models,
        snapshot,
        adapter: {
          provider: spec.kind,
          capabilities: { sessionModelSwitch: "in-session" },
          sendTurn,
          interruptTurn: async (threadId) => active.get(threadId)?.interrupt(),
          respondToRequest: async (threadId, requestId, decision) => {
            const finish = active.get(threadId)?.asks.get(requestId);
            if (!finish) throw new Error("no such pending request");
            finish(decision.behavior, decision.message);
          },
          hasSession: (threadId) => active.has(threadId),
          stopAll: async () => {
            for (const { stop } of active.values()) stop();
          },
          onEvent: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
        },
        dispose: async () => {
          for (const { stop } of active.values()) stop();
          listeners.clear();
        },
      };
    },
  };
}

/** Every ACP agent Bloks knows how to launch. */
export const ACP_SPECS: readonly AcpSpec[] = [
  {
    kind: "opencode",
    name: "OpenCode",
    command: "opencode",
    args: ["acp"],
    install: "npm i -g opencode-ai",
    signIn: "run `opencode auth login` to connect a provider",
    // it manages its own provider credentials; nothing of ours to pass
    authFiles: [".local/share/opencode/auth.json"],
    // placeholder until session/new reports the real catalog, which for
    // opencode depends entirely on which providers are connected
    models: {
      default: "auto",
      options: [{ id: "auto", label: "Auto" }],
    },
  },
  {
    kind: "grokCli",
    name: "Grok CLI",
    command: "grok",
    // The permission mode is stated on every run: the CLI's own config
    // file can flip it to auto-approve, and a session that never asks is
    // something the user should have chosen in Bloks, not inherited from
    // a dotfile.
    args: [],
    turnArgs: ({ fullAuto, model, effort }) => [
      "--permission-mode",
      fullAuto ? "bypassPermissions" : "default",
      ...(model ? ["-m", model] : []),
      ...(effort ? ["--reasoning-effort", effort] : []),
      "agent",
      "stdio",
    ],
    install: "curl -fsSL https://x.ai/cli/install.sh | bash",
    signIn: "run `grok login` in a terminal",
    // it binds the grok.com subscription; an inherited API key would move
    // the bill to pay-as-you-go without anyone deciding that
    scrubEnv: ["XAI_API_KEY"],
    authFiles: [".grok/auth.json"],
    models: {
      default: "grok-4.6",
      options: [
        { id: "grok-4.6", label: "Grok 4.6" },
        { id: "grok-4.5", label: "Grok 4.5" },
      ],
    },
  },
  {
    kind: "geminiCli",
    name: "Gemini CLI",
    command: "gemini",
    args: ["--acp"],
    install: "npm i -g @google/gemini-cli",
    signIn: "connect a Gemini key in Settings or run `gemini` to sign in with Google",
    // if a Gemini key is connected in Bloks the CLI picks it up, so one
    // credential covers both the chat engine and the agent
    keyEnv: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
    authFiles: [".gemini/oauth_creds.json"],
    models: {
      default: "auto",
      options: [
        { id: "auto", label: "Auto" },
        { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
      ],
    },
  },
  {
    kind: "pi",
    name: "Pi",
    // pi-acp on PATH, not npx: --version starts an ACP session and hangs,
    // so the install check is "is this name on PATH" after widenPath
    command: "pi-acp",
    args: [],
    probePath: true,
    // pi serves whatever providers its own settings connect, so the
    // catalog is pi's, not ours to guess
    probeModels: true,
    install: "npm i -g --ignore-scripts @earendil-works/pi-coding-agent && npm i -g pi-acp",
    signIn: "run `pi` (or `pi-acp --terminal-login`) and configure providers/login",
    // credentials live in Pi; nothing of ours to pass
    authFiles: [".pi/agent/auth.json"],
    models: {
      default: "auto",
      options: [{ id: "auto", label: "Auto" }],
    },
  },
];
