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
import { within } from "./deadline.ts";
import { OWN_GROUP } from "../no-console.ts";

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
      options.push({ id, label: codexLabel(m.displayName, id) });
      if (m.isDefault === true && !defaultId) defaultId = id;
    }
  }
  if (!options.length) return null;
  return { default: defaultId || options[0].id, options };
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

function rememberTotal(thread: string, total: TokenCount) {
  threadTotals.delete(thread);
  threadTotals.set(thread, total);
  while (threadTotals.size > MAX_THREADS) threadTotals.delete(threadTotals.keys().next().value!);
}

/** Asks the installed CLI what it can run. No thread is started and
 * nothing is spent; the process is killed as soon as the list lands. */
async function probeCatalog(cli: string): Promise<ModelCatalog | null> {
  const env: Record<string, string | undefined> = { ...process.env, NPM_CONFIG_LOGLEVEL: "error" };
  delete env.OPENAI_API_KEY;
  let child;
  try {
    child = spawn(cli, ["app-server"], { cwd: homedir(), env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
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
    const pages: any[] = [];
    let cursor: string | null = null;
    // a handful of pages is every model there is; the cap stops a CLI
    // that keeps handing back a cursor from holding the probe open
    for (let i = 0; i < 5; i++) {
      const page: any = await rpc.request("model/list", cursor ? { cursor } : {});
      pages.push(page);
      cursor = typeof page?.nextCursor === "string" && page.nextCursor ? page.nextCursor : null;
      if (!cursor) break;
    }
    return catalogFromModelList(pages);
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

    // replaced in place once the CLI answers; a failed probe (not
    // installed, too old to know model/list) keeps the list above
    const models: ModelCatalog = { default: MODELS.default, options: [...MODELS.options] };
    const catalogReady = probeCatalog(config.cli).then((catalog) => {
      if (!catalog) return;
      models.options = catalog.options;
      models.default = catalog.default;
    });

    type Answer = (behavior: string, message?: string, source?: string, reply?: boolean) => void;
    interface RunningTurn {
      turnId: string;
      abort: () => void;
      /** More words for this turn; false when Codex would not take them. */
      steer: (text: string) => Promise<boolean>;
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
        detached: OWN_GROUP,
        windowsHide: true,
      });

      const asks = new Map<string, Answer>();
      const rpcAsks = new Map<unknown, { requestId: string; providerThreadId: unknown }>();
      let finished = false;
      // the thread's token total before this turn, set by its first update
      let tokenBase: TokenCount | null = null;
      // set once turn/start goes out; usage reported before it is history
      let turnSent = false;
      // Codex's own names for the conversation and the turn running in it,
      // which turn/steer has to quote back
      let codexThread: string | null = null;
      let codexTurn: string | null = null;

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
        for (const answer of [...asks.values()]) answer("deny", "Bloks: the turn ended", "turn-ended");
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
        // useful one.
        if ((config.fullAuto || turn.fullAccess) && !isQuestion) {
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
          case "serverRequest/resolved": {
            const pending = rpcAsks.get(params.requestId);
            if (pending && pending.providerThreadId === params.threadId) {
              asks.get(pending.requestId)?.("deny", "Bloks: the request closed", "engine", false);
            }
            break;
          }
          case "item/started": {
            const item = params.item ?? {};
            const label = toolLabel(item);
            if (!label) break;
            // a patch names every file it touches, a rename both ends
            const paths =
              item.type === "fileChange" && Array.isArray(item.changes)
                ? item.changes.flatMap((c: any) => [c?.path, c?.kind?.move_path].filter((p) => typeof p === "string" && p))
                : [];
            emit({
              ...envelope(threadId, turnId),
              type: "item.started",
              itemType: "tool",
              itemId: item.id,
              title: label,
              ...(paths.length ? { paths } : {}),
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
            emit({
              ...envelope(threadId, turnId),
              type: "thread.token-usage.updated",
              input: Math.max(0, total.input - tokenBase.input),
              output: Math.max(0, total.output - tokenBase.output),
            });
            break;
          }

          case "turn/started": {
            if (typeof params.turn?.id === "string") codexTurn = params.turn.id;
            break;
          }

          case "turn/completed": {
            const completed = params.turn ?? {};
            const ok = completed.status === "completed";
            finish(ok, ok ? null : (completed.error?.message ?? completed.status ?? "failed"));
            break;
          }

          case "error": {
            // The app-server nests the text (`error.message`); older ones
            // had it at the top. One it is about to retry is not the end
            // of the turn, so only the last one is said.
            const message = params.error?.message ?? params.message;
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
        emit({
          ...envelope(threadId, turnId),
          type: "runtime.error",
          message: describeEarlyExit(code, stderr, { name: "Codex", signIn: "run `codex login`" }),
        });
        finish(false, "exit_before_result");
      });

      // Codex checks expectedTurnId against the turn it is running and
      // refuses the call if that turn has ended, so a refusal means the
      // words were not taken and can go to the next turn instead.
      const steer = async (text: string) => {
        if (finished || !codexThread || !codexTurn) return false;
        try {
          await rpc.request("turn/steer", { threadId: codexThread, expectedTurnId: codexTurn, input: [{ type: "text", text }] });
          return true;
        } catch {
          return false;
        }
      };

      running.set(threadId, { turnId, abort, steer, asks });
      emit({ ...envelope(threadId, turnId), type: "turn.started" });

      // Handshake and kickoff. Anything that goes wrong in here has to end
      // the turn: a refused handshake would otherwise leave the composer
      // locked against a process that is never going to answer.
      void (async () => {
        try {
          await within(rpc.request("initialize", { clientInfo: { name: "bloks", version: "1" } }), "starting up", "Codex");
          rpc.notify("initialized", {});

          const cursor = typeof turn.resumeCursor === "string" ? turn.resumeCursor : null;
          let reportedModel: string | null = null;
          // fullAuto is the engine set that way; fullAccess is this agent.
          // Either takes the sandbox off and stops Codex asking. Stated on
          // resume too, so switching an agent's mode takes on its next turn.
          const full = config.fullAuto || Boolean(turn.fullAccess);
          const guard = {
            sandbox: full ? "danger-full-access" : "workspace-write",
            approvalPolicy: full ? "never" : "on-request",
          };

          if (cursor) {
            // The picked model is stated on resume too. Without it a thread
            // keeps the model and the provider it started with, so a model
            // picked later never reached Codex. With it, Codex serves the
            // model from its configured provider, as it does a new thread.
            const resumeParams: Record<string, unknown> = { threadId: cursor, ...guard };
            if (turn.model) resumeParams.model = turn.model;
            try {
              const resumed = await within(
                rpc.request("thread/resume", resumeParams),
                "reopening the conversation",
                "Codex",
              );
              codexThread = resumed?.thread?.id ?? cursor;
              reportedModel = resumed?.model ?? null;
            } catch {
              /* forgotten or unsupported; a fresh thread below */
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
            if (turn.effort) startParams.reasoningEffort = turn.effort;
            let started: any;
            try {
              started = await within(rpc.request("thread/start", startParams), "opening a conversation", "Codex");
            } catch (error) {
              // An app-server old enough to refuse the effort field should
              // cost the user their preference, not their message.
              if (!turn.effort) throw error;
              delete startParams.reasoningEffort;
              started = await within(rpc.request("thread/start", startParams), "opening a conversation", "Codex");
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

          turnSent = true;
          const begun: any = await within(rpc.request("turn/start", {
            threadId: codexThread,
            input: [
              { type: "text", text: turn.system ? `${turn.system}\n\n${turn.text}` : turn.text },
            ],
          }), "starting the turn", "Codex");
          if (typeof begun?.turn?.id === "string") codexTurn ??= begun.turn.id;
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

      adapter: {
        provider: DRIVER_KIND,
        capabilities: { sessionModelSwitch: "unsupported" },
        sendTurn,

        steerTurn: async (threadId, text) => (await running.get(threadId)?.steer(text)) ?? false,

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
        for (const turn of running.values()) turn.abort();
        listeners.clear();
      },
    };
  },
};
