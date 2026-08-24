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
//   session/load          -> resumes a prior sessionId (loadSession capability)
//   session/prompt        -> blocks for the turn, returns { stopReason, usage }
//   session/update        <- streaming notifications (text, tools, thoughts)
//   session/request_permission <- a real request we must answer
//
// A turn spawns a process and kills it on settle, the same as the codex
// driver. Continuity comes from session/load with the stored id.
import { spawn, execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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
}

export interface AcpConfig {
  cli: string;
  /** Skip every approval prompt. Off by default: the whole point of ACP
   * here is that the user gets asked. */
  fullAuto: boolean;
}

const PROTOCOL_VERSION = 1;

/** ACP tool kinds, mapped to something worth reading in a transcript. */
function toolTitle(update: any): string {
  const title = typeof update?.title === "string" ? update.title : null;
  if (title) return title.slice(0, 100);
  return typeof update?.kind === "string" ? update.kind : "tool";
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
        const child = spawn(config.cli, argv, {
          cwd: turn.cwd ?? homedir(),
          env: childEnv(turn.env),
          stdio: ["pipe", "pipe", "pipe"],
          detached: true,
        });

        const state = { settled: false, text: "" };
        const asks = new Map<string, (behavior: string, message?: string) => void>();
        let nextId = 1;
        const rpcPending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

        const write = (obj: unknown) => {
          try {
            child.stdin.write(JSON.stringify(obj) + "\n");
          } catch {
            /* the child died; close() will settle the turn */
          }
          appendNative(threadId, { dir: "out", source: `${spec.kind}.acp`, msg: obj });
        };
        const request = (method: string, params: unknown) =>
          new Promise<any>((resolve, reject) => {
            const id = nextId++;
            rpcPending.set(id, { resolve, reject });
            write({ jsonrpc: "2.0", id, method, params });
          });
        const notify = (method: string, params: unknown) =>
          write({ jsonrpc: "2.0", method, params });

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

        // An interrupt goes through the protocol first, so the agent can
        // put its tools down properly. The kill is the backstop.
        let sessionId: string | null = null;
        const interrupt = () => {
          if (sessionId) notify("session/cancel", { sessionId });
          setTimeout(stop, 2_000).unref?.();
        };

        const settle = (ok: boolean, stopReason: string | null) => {
          if (state.settled) return;
          state.settled = true;
          for (const finish of [...asks.values()]) finish("deny", "Bloks: the turn ended");
          for (const p of rpcPending.values()) p.reject(new Error("turn settled"));
          rpcPending.clear();
          active.delete(threadId);
          if (state.text.trim()) {
            emit({ ...base(threadId, turnId), type: "item.completed", itemType: "assistant_text", text: state.text });
          }
          emit({ ...base(threadId, turnId), type: "turn.completed", ok, stopReason, cost: null });
          stop();
        };

        // ── agent asks the user for permission ──
        const handlePermission = (msg: any) => {
          const params = msg.params ?? {};
          const options: any[] = Array.isArray(params.options) ? params.options : [];
          const pick = (kinds: string[]) => options.find((o) => kinds.includes(o?.kind))?.optionId;
          const allowId = pick(["allow_once", "allow_always"]) ?? options[0]?.optionId;
          const denyId = pick(["reject_once", "reject_always"]) ?? options[options.length - 1]?.optionId;

          if (config.fullAuto && allowId) {
            return write({ jsonrpc: "2.0", id: msg.id, result: { outcome: { outcome: "selected", optionId: allowId } } });
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
            write({
              jsonrpc: "2.0",
              id: msg.id,
              result: optionId
                ? { outcome: { outcome: "selected", optionId } }
                : { outcome: { outcome: "cancelled" } },
            });
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
        };

        // ── streaming updates ──
        const handleUpdate = (params: any) => {
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
        };

        let buf = "";
        child.stdout.on("data", (chunk) => {
          buf += chunk;
          let nl;
          while ((nl = buf.indexOf("\n")) !== -1) {
            const line = buf.slice(0, nl);
            buf = buf.slice(nl + 1);
            if (!line.trim()) continue;
            let msg: any;
            try {
              msg = JSON.parse(line);
            } catch {
              continue; // a stray log line, not protocol
            }
            appendNative(threadId, { dir: "in", source: `${spec.kind}.acp`, msg });
            if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
              const pend = rpcPending.get(msg.id);
              if (!pend) continue;
              rpcPending.delete(msg.id);
              if (msg.error) pend.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
              else pend.resolve(msg.result);
            } else if (msg.id !== undefined && msg.method === "session/request_permission") {
              handlePermission(msg);
            } else if (msg.id !== undefined && msg.method) {
              // fs/* and terminal/* only arrive if we claimed the capability
              write({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "not supported by this client" } });
            } else if (msg.method === "session/update") {
              handleUpdate(msg.params);
            }
          }
        });

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
            await request("initialize", {
              protocolVersion: PROTOCOL_VERSION,
              // we do not lend the agent our filesystem or terminal; it has
              // its own, and every borrowed capability is another way in
              clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
              clientInfo: { name: "bloks", version: "1" },
            });

            const cursor = typeof turn.resumeCursor === "string" ? turn.resumeCursor : null;
            const cwd = turn.cwd ?? homedir();
            let session: any = null;
            if (cursor) {
              try {
                session = (await request("session/load", { cwd, mcpServers: [], sessionId: cursor })) ?? {};
                session.sessionId ??= cursor;
              } catch {
                /* the agent forgot this session; start a new one below */
              }
            }
            if (!session) session = await request("session/new", { cwd, mcpServers: [] });
            sessionId = session?.sessionId ?? null;
            if (!sessionId) throw new Error(`${spec.name} did not open a session`);

            // the agent knows its own model list better than we do
            const available: any[] = session?.models?.availableModels ?? [];
            if (available.length) {
              models.options = available.map((m) => ({
                id: String(m.modelId),
                label: String(m.name || m.modelId),
              }));
              models.default = String(session.models.currentModelId ?? models.options[0].id);
            }
            if (turn.model && available.some((m) => String(m.modelId) === turn.model)) {
              await request("session/set_model", { sessionId, modelId: turn.model }).catch(() => {});
            }
            if (config.fullAuto) {
              await request("session/set_mode", { sessionId, modeId: "yolo" }).catch(() => {});
            }

            emit({
              ...base(threadId, turnId),
              type: "session.started",
              sessionId,
              model: turn.model ?? models.default,
            });

            const result = await request("session/prompt", {
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
        const version = await new Promise<string | null>((resolve) => {
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
];
