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
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { attachRpc } from "../harness/jsonrpc-stdio.ts";
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

const DRIVER_KIND = "codex";
const NATIVE_SOURCE = "codex.app-server";

const MODELS = {
  default: "gpt-5.6-sol",
  options: [
    { id: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
    { id: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
    { id: "gpt-5.4", label: "GPT-5.4" },
  ],
};

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
const EDIT_APPROVAL_METHODS = new Set(["item/fileChange/requestApproval", "applyPatchApproval"]);

/** What the agent is asking to touch, in a word the transcript can show. */
function toolOf(method: string): string {
  if (EDIT_APPROVAL_METHODS.has(method)) return "edit";
  if (method === QUESTION_METHOD) return "ask_user";
  return "shell";
}

/** One line describing the request, from whichever field carries it. */
function summarise(params: any, fallback: string): string {
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
      return String(item.command ?? "shell").slice(0, 80);
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

    type Answer = (behavior: string, message?: string) => void;
    interface RunningTurn {
      turnId: string;
      abort: () => void;
      asks: Map<string, Answer>;
    }
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

      const env: Record<string, string | undefined> = {
        ...process.env,
        // the turn's own credential (see server/agent-cli.ts)
        ...(turn.env ?? {}),
        NPM_CONFIG_LOGLEVEL: "error",
      };
      // The CLI holds its own ChatGPT login. An inherited API key would
      // silently move the user onto pay-as-you-go billing.
      delete env.OPENAI_API_KEY;

      // The connectors, over the stdio bridge, because this CLI mounts
      // MCP servers as child processes and nothing else. The key rides
      // the environment and only its *name* appears in argv, so process
      // listings and diagnostics never see it.
      const appServerArgs = ["app-server"];
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

      const child = spawn(config.cli, appServerArgs, {
        cwd: turn.cwd ?? homedir(),
        env,
        stdio: ["pipe", "pipe", "pipe"],
        detached: true,
      });

      const asks = new Map<string, Answer>();
      let finished = false;

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
        onFrame: (msg, dir) => appendNative(threadId, { dir, source: NATIVE_SOURCE, msg }),
        onRequest: (msg) => onAgentRequest(msg),
        onNotify: (msg) => onAgentNotification(msg),
      });

      const finish = (ok: boolean, stopReason: string | null) => {
        if (finished) return;
        finished = true;
        for (const answer of [...asks.values()]) answer("deny", "Bloks: the turn ended");
        rpc.failPending(new Error("turn settled"));
        running.delete(threadId);
        emit({ ...envelope(threadId, turnId), type: "turn.completed", ok, stopReason, cost: null });
        abort();
      };

      // ── the agent asking us something ──
      function onAgentRequest(msg: any) {
        const method = String(msg.method ?? "");
        const params = msg.params ?? {};
        const legacy = LEGACY_APPROVAL_METHODS.has(method);
        const isQuestion = method === QUESTION_METHOD;
        const tool = toolOf(method);

        // fullAuto waives approvals but never questions: a question has no
        // safe automatic answer, only a less useful one.
        if (config.fullAuto && !isQuestion) {
          return rpc.reply(msg.id, { decision: legacy ? "approved" : "accept" });
        }

        const requestId = newId();

        const answer: Answer = (behavior, message) => {
          if (!asks.delete(requestId)) return;
          clearTimeout(timer);

          if (isQuestion) {
            // Each sub-question is answered by id; we put the same text
            // against all of them, since the card asked as one thing.
            const answers: Record<string, { answers: string[] }> = {};
            for (const q of Array.isArray(params.questions) ? params.questions : []) {
              answers[q.id] = { answers: [message || UNANSWERED_QUESTION] };
            }
            rpc.reply(msg.id, { answers });
          } else {
            const allowed = behavior === "allow";
            rpc.reply(msg.id, {
              decision: allowed ? (legacy ? "approved" : "accept") : legacy ? "denied" : "decline",
            });
          }

          emit({
            ...envelope(threadId, turnId),
            type: "request.resolved",
            requestId,
            behavior,
            source: "user",
          });
        };

        const timer = setTimeout(() => {
          if (isQuestion) answer("answer", UNANSWERED_QUESTION);
          else answer("deny", UNANSWERED_PERMISSION);
        }, ASK_TIMEOUT_MS);
        timer.unref?.();

        asks.set(requestId, answer);
        emit({
          ...envelope(threadId, turnId),
          type: "request.opened",
          requestId,
          requestType: isQuestion ? "question" : "permission",
          tool,
          summary: summarise(params, tool),
          choices: isQuestion
            ? (params.questions?.[0]?.options ?? []).map((o: any) => o.label).slice(0, 5)
            : undefined,
        });
      }

      // ── the agent narrating what it is doing ──
      function onAgentNotification(msg: any) {
        const params = msg.params ?? {};

        switch (msg.method) {
          case "item/started": {
            const item = params.item ?? {};
            const label = toolLabel(item);
            if (!label) break;
            emit({
              ...envelope(threadId, turnId),
              type: "item.started",
              itemType: "tool",
              itemId: item.id,
              title: label,
            });
            break;
          }

          case "item/completed": {
            const item = params.item ?? {};
            if (item.type === "agentMessage") {
              if (!item.text?.trim()) break;
              emit({
                ...envelope(threadId, turnId),
                type: "content.delta",
                streamKind: "assistant_text",
                delta: item.text,
              });
              emit({
                ...envelope(threadId, turnId),
                type: "item.completed",
                itemType: "assistant_text",
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
            const total = params.tokenUsage?.total;
            if (!total) break;
            emit({
              ...envelope(threadId, turnId),
              type: "thread.token-usage.updated",
              input: total.inputTokens ?? 0,
              output: total.outputTokens ?? 0,
            });
            break;
          }

          case "turn/completed": {
            const completed = params.turn ?? {};
            const ok = completed.status === "completed";
            finish(ok, ok ? null : (completed.error?.message ?? completed.status ?? "failed"));
            break;
          }

          case "error":
            if (params.message) {
              emit({ ...envelope(threadId, turnId), type: "runtime.error", message: params.message });
            }
            break;
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
            install: "npm i -g @openai/codex",
            signIn: "run `codex login`",
          }),
        });
        finish(false, "spawn_error");
      });

      child.on("close", (code) => {
        if (finished) return;
        emit({
          ...envelope(threadId, turnId),
          type: "runtime.error",
          message: describeEarlyExit(code, stderr, { name: "Codex", signIn: "run `codex login`" }),
        });
        finish(false, "exit_before_result");
      });

      running.set(threadId, { turnId, abort, asks });
      emit({ ...envelope(threadId, turnId), type: "turn.started" });

      // Handshake and kickoff. Anything that goes wrong in here has to end
      // the turn: a refused handshake would otherwise leave the composer
      // locked against a process that is never going to answer.
      void (async () => {
        try {
          await rpc.request("initialize", { clientInfo: { name: "bloks", version: "1" } });
          rpc.notify("initialized", {});

          const cursor = typeof turn.resumeCursor === "string" ? turn.resumeCursor : null;
          let codexThread: string | null = null;
          let reportedModel: string | null = null;

          if (cursor) {
            try {
              const resumed = await rpc.request("thread/resume", { threadId: cursor });
              codexThread = resumed?.thread?.id ?? cursor;
            } catch {
              /* forgotten or unsupported; a fresh thread below */
            }
          }

          if (!codexThread) {
            const startParams: Record<string, unknown> = {
              cwd: turn.cwd ?? homedir(),
              model: turn.model || null,
              // fullAuto is the user having said so explicitly; the default
              // keeps the agent inside its workspace and asking.
              sandbox: config.fullAuto ? "danger-full-access" : "workspace-write",
              approvalPolicy: config.fullAuto ? "never" : "on-request",
              ephemeral: false,
            };
            if (turn.effort) startParams.reasoningEffort = turn.effort;
            let started: any;
            try {
              started = await rpc.request("thread/start", startParams);
            } catch (error) {
              // An app-server old enough to refuse the effort field should
              // cost the user their preference, not their message.
              if (!turn.effort) throw error;
              delete startParams.reasoningEffort;
              started = await rpc.request("thread/start", startParams);
            }
            codexThread = started?.thread?.id ?? null;
            reportedModel = started?.model ?? null;
          }

          emit({
            ...envelope(threadId, turnId),
            type: "session.started",
            sessionId: codexThread,
            model: reportedModel ?? turn.model ?? null,
          });

          await rpc.request("turn/start", {
            threadId: codexThread,
            input: [
              { type: "text", text: turn.system ? `${turn.system}\n\n${turn.text}` : turn.text },
            ],
          });
        } catch (error) {
          if (finished) return;
          emit({
            ...envelope(threadId, turnId),
            type: "runtime.error",
            message: (error as Error).message,
          });
          finish(false, "rpc_error");
        }
      })();

      return { turnId };
    };

    const snapshot = async (): Promise<ProviderSnapshot> => {
      const version = await new Promise<string | null>((resolve) => {
        execFile(config.cli, ["--version"], { timeout: 8_000 }, (error, stdout) =>
          resolve(error ? null : stdout.trim()),
        );
      });
      if (!version) return { state: "unavailable", reason: `\`${config.cli}\` CLI not found` };
      // No cheap way to tell whether `codex login` has been run, so this
      // reports installed and lets a real turn surface the rest.
      return { state: "available", version };
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
        capabilities: { sessionModelSwitch: "unsupported" },
        sendTurn,

        interruptTurn: async (threadId) => running.get(threadId)?.abort(),

        respondToRequest: async (threadId, requestId, decision) => {
          const answer = running.get(threadId)?.asks.get(requestId);
          if (!answer) throw new Error("no such pending request");
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
        for (const turn of running.values()) turn.abort();
        listeners.clear();
      },
    };
  },
};
