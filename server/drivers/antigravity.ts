// Antigravity, Google's agentic CLI, driven headless.
//
// `agy --print` runs one turn and emits newline-delimited JSON when asked
// for stream-json output. Continuity is agy's own conversation id, handed
// back in its first event and replayed with `--conversation` next turn.
//
// Two things about this CLI shape the driver:
//
//   The prompt travels in argv. agy has no stdin path in print mode (a
//   bare --print just exits), so this is the one engine where the turn
//   text is briefly visible to `ps`. There is nothing to route around
//   that with; anyone for whom that matters should prefer an engine that
//   reads stdin.
//
//   There is no interactive permission channel in print mode. accept-edits
//   lets it edit files and refuses the rest; the full-auto setting removes
//   the guardrails entirely, which is the user's explicit call in settings.
//   Approval cards therefore never originate here.
import { execFile, spawn } from "node:child_process";
import { homedir } from "node:os";

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

const DRIVER_KIND = "antigravity";

const MODELS = {
  default: "gemini-3.1-pro-high",
  options: [
    { id: "gemini-3.1-pro-high", label: "Gemini 3.1 Pro (High)" },
    { id: "gemini-3.1-pro-low", label: "Gemini 3.1 Pro (Low)" },
    { id: "gemini-3.6-flash-high", label: "Gemini 3.6 Flash (High)" },
    { id: "gemini-3.6-flash-medium", label: "Gemini 3.6 Flash (Medium)" },
    { id: "gemini-3.6-flash-low", label: "Gemini 3.6 Flash (Low)" },
    { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6 (Thinking)" },
    { id: "claude-opus-4-6-thinking", label: "Claude Opus 4.6 (Thinking)" },
    { id: "gpt-oss-120b-medium", label: "GPT-OSS 120B (Medium)" },
  ],
};

export interface AntigravityConfig {
  cli: string;
  fullAuto: boolean;
}

function decodeConfig(raw: unknown): AntigravityConfig {
  const source = (raw ?? {}) as Record<string, unknown>;
  return {
    cli: typeof source.cli === "string" && source.cli ? source.cli : "agy",
    fullAuto: source.fullAuto === true,
  };
}

export const AntigravityDriver: ProviderDriver<AntigravityConfig> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "Antigravity", supportsMultipleInstances: true },
  models: MODELS,
  decodeConfig,
  defaultConfig: () => decodeConfig({}),

  async create(input: DriverCreateInput<AntigravityConfig>): Promise<ProviderInstance> {
    const { instanceId, config } = input;
    const listeners = new Set<RuntimeEventListener>();
    const running = new Map<string, { turnId: string; abort: () => void }>();

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

      // The persona rides ahead of the message in the same prompt, since
      // print mode offers no separate system channel.
      const prompt = turn.system ? `${turn.system}\n\n${turn.text}` : turn.text;

      const argv = [
        "--print", prompt,
        "--output-format", "stream-json",
        // agy's own ceiling on a stuck turn; without it a wedged tool call
        // would pin the composer forever
        "--print-timeout", "10m",
      ];
      if (config.fullAuto) argv.push("--dangerously-skip-permissions");
      else argv.push("--mode", "accept-edits");
      if (turn.model) argv.push("--model", turn.model);
      if (resume) argv.push("--conversation", resume);

      const child = spawn(config.cli, argv, {
        cwd: turn.cwd ?? homedir(),
        // the turn's own credential (see server/agent-cli.ts)
        env: { ...process.env, ...(turn.env ?? {}) },
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });

      let finished = false;
      const finish = (ok: boolean, stopReason: string | null) => {
        if (finished) return;
        finished = true;
        running.delete(threadId);
        emit({ ...envelope(threadId, turnId), type: "turn.completed", ok, stopReason, cost: null });
      };

      // agy frames as {event, conversation_id, <event-name>: payload}
      let conversationId: string | null = null;
      const consume = (raw: string) => {
        let frame: any;
        try {
          frame = JSON.parse(raw);
        } catch {
          return;
        }
        appendNative(threadId, { dir: "in", source: "agy.stream", msg: frame });
        const payload = frame[frame.event] ?? {};

        switch (frame.event) {
          case "init":
            conversationId = frame.conversation_id ?? null;
            emit({
              ...envelope(threadId, turnId),
              type: "session.started",
              sessionId: conversationId,
              model: turn.model ?? null,
            });
            break;

          case "step_update":
            if (payload.step_type === "tool") {
              // steps are indexed, not id'd; the conversation plus the
              // index is the stable name for one tool run
              const itemId = `${conversationId ?? "conv"}:${payload.step_index}`;
              if (payload.state === "ACTIVE") {
                emit({
                  ...envelope(threadId, turnId),
                  type: "item.started",
                  itemType: "tool",
                  itemId,
                  title: payload.tool_name,
                });
              } else if (payload.state === "DONE" || payload.state === "ERROR") {
                emit({
                  ...envelope(threadId, turnId),
                  type: "item.completed",
                  itemType: "tool",
                  itemId,
                  ok: payload.state === "DONE",
                });
              }
            } else if (payload.step_type === "agent_response" && payload.usage) {
              emit({
                ...envelope(threadId, turnId),
                type: "thread.token-usage.updated",
                input: (payload.usage.input_tokens || 0) + (payload.usage.cache_read_tokens || 0),
                output: payload.usage.output_tokens || 0,
              });
            }
            break;

          case "result": {
            // the assistant text arrives here, whole, not streamed
            const text = typeof payload.response === "string" ? payload.response : "";
            if (text) {
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
            if (payload.usage) {
              emit({
                ...envelope(threadId, turnId),
                type: "thread.token-usage.updated",
                input: (payload.usage.input_tokens || 0) + (payload.usage.cache_read_tokens || 0),
                output: payload.usage.output_tokens || 0,
              });
            }
            finish(payload.status === "SUCCESS", payload.status ?? null);
            break;
          }
        }
      };

      // multibyte text can split across chunks; decode as utf8 stream
      child.stdout.setEncoding("utf8");
      let pending = "";
      child.stdout.on("data", (chunk: string) => {
        pending += chunk;
        for (;;) {
          const cut = pending.indexOf("\n");
          if (cut === -1) break;
          const line = pending.slice(0, cut);
          pending = pending.slice(cut + 1);
          if (line.trim()) consume(line);
        }
      });

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
            name: "Antigravity",
            command: config.cli,
            install: "curl -fsSL https://antigravity.google/cli/install.sh | bash",
            signIn: "run `agy` once to sign in with Google",
          }),
        });
        finish(false, "spawn_error");
      });

      child.on("close", (code) => {
        if (finished) return;
        emit({
          ...envelope(threadId, turnId),
          type: "runtime.error",
          message: describeEarlyExit(code, stderr, {
            name: "Antigravity",
            signIn: "run `agy` once in a terminal",
          }),
        });
        finish(false, "exit_before_result");
      });

      const abort = () => {
        try {
          process.kill(-child.pid!, "SIGTERM");
        } catch {
          try {
            child.kill("SIGTERM");
          } catch {
            /* gone */
          }
        }
      };

      running.set(threadId, { turnId, abort });
      emit({ ...envelope(threadId, turnId), type: "turn.started" });
      appendNative(threadId, { dir: "out", source: "agy.stream", msg: { argv: argv.slice(2) } });

      return { turnId };
    };

    const snapshot = async (): Promise<ProviderSnapshot> => {
      const version = await new Promise<string | null>((resolve) => {
        execFile(config.cli, ["--version"], { timeout: 8_000 }, (error, stdout) =>
          resolve(error ? null : stdout.trim()),
        );
      });
      if (!version) return { state: "unavailable", reason: `\`${config.cli}\` CLI not found` };
      // agy keeps its login in the system keyring, which leaves no file to
      // check. Installed is all that can honestly be reported.
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
        capabilities: { sessionModelSwitch: "in-session" },
        sendTurn,
        interruptTurn: async (threadId) => running.get(threadId)?.abort(),
        respondToRequest: async () => {
          throw new Error("Antigravity's print mode has no permission channel");
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
