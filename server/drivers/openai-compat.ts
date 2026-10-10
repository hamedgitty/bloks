// One driver for every provider that speaks OpenAI's /chat/completions.
//
// This started as the Grok driver and grew a spec argument, because
// Gemini, Kimi, Llama, DeepSeek, Mistral, Groq, OpenRouter and Ollama all
// answer the same two endpoints. Unlike the CLI drivers this one is
// transcript-replay: the server hands it the folded thread history each
// turn (SendTurnInput.transcript) and it emits token-level content.delta.
//
// Model lists are fetched from GET /models rather than hardcoded. Labs
// rename models faster than anyone ships a release, so a baked-in catalog
// is wrong within weeks; the spec's list is only the fallback for when
// that call cannot be made.
import { execFile } from "node:child_process";

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
import { callMcpTool, listMcpTools, type McpAccess } from "../composio.ts";
import { newEventId, newId } from "../contracts.ts";
import type { ProviderSpec } from "../providers.ts";
import { appendNative } from "./native.ts";
import { BOAT_API } from "../boat.ts";
import { callSignature } from "../repeats.ts";

export interface CompatConfig {
  url: string;
  apiKeyEnv: string;
}

/** How long a streamed reply may go without a byte before it is treated
 * as dead. Generous: some providers pause while a long tool call is
 * planned, but none go quiet for this long and come back. Tests shorten
 * it through the environment. */
const STREAM_IDLE_MS = Number(process.env.BLOKS_STREAM_IDLE_MS) || 90_000;
/** One round of the tool loop, which does not stream: a whole answer. */
const ROUND_TIMEOUT_MS = 5 * 60_000;

/** How long a fetched model list is trusted before we look again. */
const CATALOG_TTL_MS = 10 * 60_000;

/** Turns "meta-llama/llama-4-maverick" into "Llama 4 Maverick". */
function labelFor(id: string): string {
  const free = /:free$/i.test(id);
  const tail = (id.split("/").pop() ?? id).replace(/:free$/i, "");
  const label = tail
    .replace(/[-_]/g, " ")
    .replace(/\b(gpt|ai|llm|fp8|moe)\b/gi, (s) => s.toUpperCase())
    .replace(/\b[a-z]/g, (s) => s.toUpperCase())
    .trim();
  return free ? `${label} (free)` : label;
}

/**
 * Narrows a provider's raw model list to something a picker can hold.
 * OpenRouter alone lists hundreds; without this the rail is unusable.
 */
export function chooseModels(
  spec: ProviderSpec,
  ids: string[],
  /** Ids the provider says can call tools, when it says. An agent needs
   * tools, so a free model that cannot use them is not worth offering. */
  toolCapable?: Set<string>,
  /** When each model was added, in seconds, when the provider says. */
  created?: Map<string, number>,
): ModelCatalog | null {
  const clean = [...new Set(ids.filter((id) => typeof id === "string" && id))]
    // embeddings, images and audio are not chat models
    .filter((id) => !/embed|whisper|tts|guard|moderation|image|vision-only|rerank/i.test(id));
  if (!clean.length) return null;
  // An agent sends tools on every turn, so a model the provider says
  // cannot take them would fail the first message. Only when it says.
  const usable = toolCapable ? clean.filter((id) => toolCapable.has(id)) : clean;
  if (!usable.length) return null;
  // With free slots, free models are listed together after the paid ones
  // rather than scattered through the shortlist. A gateway's routing
  // variant (OpenRouter's ":batch", ":nitro" and the rest) of a model that
  // is listed anyway is the same model twice, and the plain one is the one
  // an agent wants. Named suffixes only: Ollama's "qwen3:8b" is a size.
  const listed = new Set(usable);
  const variant = (id: string) => {
    const m = /^(.+):(batch|nitro|floor|online|thinking|extended|exacto|beta)$/i.exec(id);
    return Boolean(m && listed.has(m[1]));
  };
  const pool = usable.filter((id) => !variant(id) && !(spec.freeSlots && /:free$/i.test(id)));

  const limit = spec.limit ?? 20;
  const ranked = spec.prefer?.length ? byFamily(spec, pool, limit, created) : [];
  const shortlist = ranked.length ? ranked : [...pool].sort().slice(0, limit);

  // keep the configured default if the provider still serves it, so a
  // refresh never silently moves an agent onto a different model
  // Free models, in their own slots after the paid shortlist, preferred
  // families first. They would otherwise never make the cut: the paid
  // flagship of every preferred family ranks ahead of them.
  const rankOf = (id: string) => {
    const r = spec.prefer?.findIndex((re) => re.test(id)) ?? -1;
    return r === -1 ? Number.MAX_SAFE_INTEGER : r;
  };
  const free = spec.freeSlots
    ? usable
        .filter((id) => /:free$/i.test(id))
        .sort((a, b) => rankOf(a) - rankOf(b) || a.localeCompare(b))
        .slice(0, spec.freeSlots)
    : [];

  // A key that only reaches free models still gets a picker.
  if (!shortlist.length && !free.length) return null;
  const preferredDefault = shortlist.includes(spec.models.default)
    ? spec.models.default
    : (shortlist[0] ?? free[0]);
  return {
    default: preferredDefault,
    options: [...shortlist, ...free].map((id) => ({ id, label: labelFor(id) })),
  };
}

/**
 * The shortlist for a provider that lists families: every family gets a
 * turn before any family gets a second one. Ranked family by family and
 * cut at the limit, the first family alone filled it: OpenRouter serves
 * dozens of Google models that take tools, so a sign-in that reaches
 * every lab offered Gemini and nothing else.
 *
 * Within a family the models this app names in its own catalog go first,
 * then the newest, so a family's turn goes to its current flagship rather
 * than to whatever sorts first by name. The result reads lab by lab, in
 * the order the spec prefers them.
 */
function byFamily(spec: ProviderSpec, pool: string[], limit: number, created?: Map<string, number>): string[] {
  const prefer = spec.prefer ?? [];
  const named = new Set(spec.models.options.map((o) => o.id));
  const families: string[][] = prefer.map(() => []);
  for (const id of pool) {
    const rank = prefer.findIndex((re) => re.test(id));
    if (rank !== -1) families[rank].push(id);
  }
  for (const family of families) {
    family.sort(
      (a, b) =>
        Number(named.has(b)) - Number(named.has(a)) ||
        (created?.get(b) ?? 0) - (created?.get(a) ?? 0) ||
        a.localeCompare(b),
    );
  }
  const picked = new Set<string>();
  for (let turn = 0; picked.size < limit && families.some((f) => f.length > turn); turn++) {
    for (const family of families) {
      if (picked.size >= limit) break;
      if (turn < family.length) picked.add(family[turn]);
    }
  }
  return families.flatMap((family) => family.filter((id) => picked.has(id)));
}

// ── the tool loop ──────────────────────────────────────────────────────
// API models get tools the same way people do: a list of functions, and a
// conversation that grows as they use them. Two are always offered; the
// computer pair appears when the agent actually has a computer. Iterations
// are non-streaming on purpose: accumulating fragmented tool_call deltas
// is where OpenAI-compatible gateways disagree with each other most, and
// a wrong reassembly silently corrupts arguments.

const MAX_TOOL_ROUNDS = 10;
const ASK_TIMEOUT_MS = 15 * 60_000;
const UNANSWERED =
  "Nobody answered in time. Use your best judgment and continue.";


function toolSchemas(hasComputer: boolean, hasSandbox: boolean) {
  const tools: any[] = [
    {
      type: "function",
      function: {
        name: "ask_user",
        description:
          "Ask the person you work for a question and wait for their answer. Use it for decisions that are genuinely theirs: preferences, missing facts, sign-off before something consequential.",
        parameters: {
          type: "object",
          properties: {
            question: { type: "string", description: "The question, with enough context to answer at a glance" },
            choices: {
              type: "array",
              items: { type: "string" },
              description: "Optional 2-5 likely answers, offered as one-tap buttons",
            },
          },
          required: ["question"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "search_history",
        description:
          "Search your own past conversations with this person and the rooms you are in. Use it when something may have come up before: a decision, a name, a number, a preference. Returns the matching messages with when and where they were said.",
        parameters: {
          type: "object",
          properties: { query: { type: "string", description: "A few words to look for, in any order" } },
          required: ["query"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "read_message",
        description:
          "Read in full one message that search_history found but cut short (it says which message id has the rest).",
        parameters: {
          type: "object",
          properties: { message_id: { type: "string", description: "The message id search_history gave" } },
          required: ["message_id"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "note_about_person",
        description:
          "Suggest one short, lasting note about the person you work for (how they like answers, their role, their timezone, names they use). They decide whether to keep it. Never secrets or anything sensitive.",
        parameters: {
          type: "object",
          properties: { fact: { type: "string", description: "One fact, one sentence" } },
          required: ["fact"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "request_secret",
        description:
          "Ask the user for an API key or other secret via a secure field in the chat. The value reaches your tools as an environment variable on your next turn and never appears in the conversation. After calling this, wrap up your turn; the task resumes when they save it.",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string", description: "What the secret is, e.g. Transistor API key" },
            hint: { type: "string", description: "Where to find it, one line" },
          },
          required: ["name"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "request_connection",
        description:
          "Ask the user to connect an app (Slack, Gmail, GitHub...) so you can use it. A sign-in card appears in the chat; never paste sign-in links yourself. After calling this, wrap up your turn: the task resumes automatically once the user connects.",
        parameters: {
          type: "object",
          properties: {
            apps: {
              type: "array",
              items: { type: "string" },
              description: "App slugs to connect, lowercase",
            },
            reason: { type: "string", description: "One line on why, shown to the user" },
          },
          required: ["apps"],
        },
      },
    },
  ];
  if (hasSandbox) {
    tools.push({
      type: "function",
      function: {
        name: "sandbox_exec",
        description:
          "Run a shell command in your own Linux sandbox (Ubuntu, persistent /work). Returns stdout, stderr and the exit code. Shell and files only; there is no display.",
        parameters: {
          type: "object",
          properties: { command: { type: "string" } },
          required: ["command"],
        },
      },
    });
  }
  if (hasComputer) {
    tools.push(
      {
        type: "function",
        function: {
          name: "computer_exec",
          description:
            "Run a shell command on your own cloud computer (Linux, passwordless sudo). Returns stdout, stderr and the exit code.",
          parameters: {
            type: "object",
            properties: { command: { type: "string" } },
            required: ["command"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "open_url",
          description: "Open a URL in the cloud computer's own browser.",
          parameters: {
            type: "object",
            properties: { url: { type: "string" } },
            required: ["url"],
          },
        },
      },
    );
  }
  return tools;
}

/** Run one command on the agent's box. Same REST the computer panel uses;
 * duplicated here rather than imported so this driver stays free of the
 * config plumbing box.ts carries. */
async function boxExec(
  computer: { boxId: string; token: string },
  command: string,
): Promise<string> {
  const res = await fetch(`${BOAT_API}/sandboxes/${computer.boxId}/commands`, {
    method: "POST",
    headers: { authorization: `Bearer ${computer.token}`, "content-type": "application/json" },
    body: JSON.stringify({ command: command.slice(0, 4000), timeoutSeconds: 120 }),
    signal: AbortSignal.timeout(120_000),
  });
  const body: any = await res.json().catch(() => null);
  if (!res.ok) return `the computer refused: HTTP ${res.status}`;
  const stderr = body?.stderr ? `\n[stderr]\n${String(body.stderr).slice(-1500)}` : "";
  return `exit ${body?.exitCode ?? "?"}\n${String(body?.stdout ?? "").slice(-5000)}${stderr}`;
}

/** Run one command in the agent's local sandbox via the container
 * runtime. Local process, no credential involved. */
function sandboxExec(handle: { runtime: string; name: string }, command: string): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      handle.runtime,
      ["exec", handle.name, "sh", "-lc", command.slice(0, 4000)],
      { timeout: 120_000, maxBuffer: 4_000_000, windowsHide: true },
      (error, stdout, stderr) => {
        const code = error ? ((error as any).code ?? 1) : 0;
        const tail = stderr ? `\n[stderr]\n${String(stderr).slice(-1500)}` : "";
        resolve(`exit ${code}\n${String(stdout).slice(-5000)}${tail}`);
      },
    );
  });
}

export function openAiCompatDriver(spec: ProviderSpec): ProviderDriver<CompatConfig> {
  const keyEnv = `${spec.kind.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;

  const decodeConfig = (raw: unknown): CompatConfig => {
    const o = (raw ?? {}) as Record<string, unknown>;
    return {
      url: typeof o.url === "string" && o.url ? o.url.replace(/\/+$/, "") : spec.url,
      apiKeyEnv: typeof o.apiKeyEnv === "string" ? o.apiKeyEnv : keyEnv,
    };
  };

  return {
    driverKind: spec.kind,
    metadata: { displayName: spec.name, supportsMultipleInstances: true },
    models: spec.models,
    decodeConfig,
    defaultConfig: () => decodeConfig({}),

    async create(input: DriverCreateInput<CompatConfig>): Promise<ProviderInstance> {
      const { instanceId, config } = input;
      // legacy XAI_API_KEY is still honoured for the grok instance
      const apiKey =
        input.environment[config.apiKeyEnv] ??
        process.env[config.apiKeyEnv] ??
        (spec.kind === "grok" ? (input.environment.XAI_API_KEY ?? process.env.XAI_API_KEY) : "") ??
        "";
      const needsKey = spec.auth !== "none";
      const listeners = new Set<RuntimeEventListener>();
      const active = new Map<
        string,
        {
          abort: AbortController;
          turnId: string;
          asks: Map<string, (answer: string) => void>;
        }
      >();

      // mutable so a refresh is visible to registry.describe(), which
      // reads .models straight after awaiting snapshot()
      const models: ModelCatalog = { default: spec.models.default, options: [...spec.models.options] };
      let catalogAt = 0;
      let refreshing: Promise<void> | null = null;
      /** Set when the provider told us the credential is no good. A key
       * with a typo used to read as connected right up until the first
       * message failed. */
      let rejected: string | null = null;

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
      const headers = () => ({
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        "content-type": "application/json",
        ...spec.headers,
      });

      const refreshCatalog = () => {
        if (refreshing) return refreshing;
        refreshing = (async () => {
          try {
            const res = await fetch(`${config.url}/models`, {
              headers: headers(),
              signal: AbortSignal.timeout(8_000),
            });
            // 401/403 is the provider saying the key is wrong; a 404 just
            // means it does not publish a model list, which is fine
            rejected = res.status === 401 || res.status === 403 ? "that key was rejected" : null;
            if (!res.ok) return;
            const json: any = await res.json();
            const rows: any[] = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : [];
            // OpenRouter says which models take tools; others say nothing,
            // and then nothing is filtered on it.
            const described = rows.some((r) => Array.isArray(r?.supported_parameters));
            const toolCapable = described
              ? new Set(
                  rows
                    .filter((r) => Array.isArray(r?.supported_parameters) && r.supported_parameters.includes("tools"))
                    .map((r) => String(r.id)),
                )
              : undefined;
            // OpenRouter dates its models, which is how a family's newest
            // gets its turn in the shortlist ahead of last year's
            const created = new Map<string, number>(
              rows
                .filter((r) => typeof r?.created === "number" && r?.id)
                .map((r) => [String(r.id), Number(r.created)] as [string, number]),
            );
            const next = chooseModels(
              spec,
              rows.map((r) => String(r?.id ?? r?.name ?? "")),
              toolCapable,
              created.size ? created : undefined,
            );
            if (next) {
              models.default = next.default;
              models.options = next.options;
            }
            catalogAt = Date.now();
          } catch {
            // provider does not expose /models, or the network is down.
            // The spec's list stays, which is the whole point of having one.
          } finally {
            refreshing = null;
          }
        })();
        return refreshing;
      };

      const complete = async (
        messages: Array<{ role: string; content: string }>,
        model: string,
        opts: { stream: boolean; signal?: AbortSignal; onDelta?: (d: string) => void },
      ): Promise<{ text: string; usage: { input: number; output: number } | null }> => {
        const res = await fetch(`${config.url}/chat/completions`, {
          method: "POST",
          headers: headers(),
          body: JSON.stringify({ model, messages, stream: opts.stream }),
          signal: opts.signal ?? AbortSignal.timeout(120_000),
        });
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          throw new Error(`${spec.name} HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
        }
        if (!opts.stream) {
          const json: any = await res.json();
          return {
            text: json.choices?.[0]?.message?.content ?? "",
            usage: json.usage
              ? { input: json.usage.prompt_tokens ?? 0, output: json.usage.completion_tokens ?? 0 }
              : null,
          };
        }
        let text = "";
        let usage: { input: number; output: number } | null = null;
        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        // A stream that stops sending is dead, not thinking: an API streams
        // its keepalives and tokens as it goes. Without this, a turn with
        // its own abort signal (every chat turn) had no deadline at all and
        // sat on "working" until someone pressed stop.
        const read = () =>
          new Promise<{ done: boolean; value?: Uint8Array }>((resolve, reject) => {
            const timer = setTimeout(() => {
              void reader.cancel().catch(() => {});
              reject(new Error(`${spec.name} stopped sending for ${STREAM_IDLE_MS / 1000} seconds, so this reply was cut off. Send it again.`));
            }, STREAM_IDLE_MS);
            reader.read().then(
              (r) => {
                clearTimeout(timer);
                resolve(r);
              },
              (e) => {
                clearTimeout(timer);
                reject(e);
              },
            );
          });
        for (let ended = false; !ended; ) {
          const { done, value } = await read();
          if (done) {
            // the last event can arrive without its trailing newline
            buf += decoder.decode() + "\n";
            ended = true;
          } else {
            buf += decoder.decode(value, { stream: true });
          }
          let nl;
          while ((nl = buf.indexOf("\n")) !== -1) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line.startsWith("data:")) continue;
            const data = line.slice(5).trim();
            if (data === "[DONE]") continue;
            let chunk: any;
            try {
              chunk = JSON.parse(data);
            } catch {
              continue;
            }
            // some gateways surface provider failures inside the stream
            if (chunk.error) throw new Error(String(chunk.error.message ?? chunk.error).slice(0, 200));
            const delta = chunk.choices?.[0]?.delta?.content;
            if (delta) {
              text += delta;
              opts.onDelta?.(delta);
            }
            if (chunk.usage) {
              usage = {
                input: chunk.usage.prompt_tokens ?? 0,
                output: chunk.usage.completion_tokens ?? 0,
              };
            }
          }
        }
        return { text, usage };
      };

      /** One non-streaming completion, returning the whole assistant
       * message so the caller can see tool_calls. */
      const completeRaw = async (
        messages: any[],
        model: string,
        tools: any[],
        signal: AbortSignal,
      ): Promise<{ message: any; usage: { input: number; output: number } | null }> => {
        // The turn's own signal ends it on stop; the bound ends it when the
        // provider simply never answers, which the turn signal never does.
        const bounded = AbortSignal.any([signal, AbortSignal.timeout(ROUND_TIMEOUT_MS)]);
        let res: Response;
        try {
          res = await fetch(`${config.url}/chat/completions`, {
            method: "POST",
            headers: headers(),
            body: JSON.stringify({ model, messages, tools, stream: false }),
            signal: bounded,
          });
        } catch (e) {
          if ((e as Error).name === "TimeoutError") {
            throw new Error(`${spec.name} took more than ${ROUND_TIMEOUT_MS / 60_000} minutes to answer, so this reply was stopped. Send it again.`);
          }
          throw e;
        }
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          throw new Error(`${spec.name} HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
        }
        const json: any = await res.json();
        return {
          message: json.choices?.[0]?.message ?? {},
          usage: json.usage
            ? { input: json.usage.prompt_tokens ?? 0, output: json.usage.completion_tokens ?? 0 }
            : null,
        };
      };

      /**
       * The agentic path: rounds of completion, tools between them.
       *
       * The conversation the model sees grows in place: its own tool_calls
       * message, then one tool result per call, then another completion.
       * The loop ends the round the model answers in prose, or at the cap,
       * which exists so a model that calls tools forever costs a bounded
       * amount rather than an unbounded one.
       */
      const runWithTools = async (
        threadId: string,
        turnId: string,
        messages: any[],
        model: string,
        turn: SendTurnInput,
        signal: AbortSignal,
      ) => {
        const computer = turn.integrations?.computer;
        const sandbox = turn.integrations?.sandbox;
        const tools = toolSchemas(Boolean(computer), Boolean(sandbox));
        // The connectors, as callable tools rather than a rumor. The CLI
        // engines mount Composio's MCP server themselves; API models have
        // no MCP client, so the harness is theirs: list the meta-tools
        // once per turn and relay calls. Without this, an API model could
        // ask the user to connect Slack and then not touch it, which
        // reads as "connections don't work" and is exactly what it is.
        const connectors: McpAccess | null = turn.integrations?.composio?.key
          ? turn.integrations.composio
          : null;
        const connectorTools = new Set<string>();
        if (connectors) {
          try {
            for (const tool of await listMcpTools(connectors)) {
              connectorTools.add(tool.name);
              tools.push({
                type: "function",
                function: {
                  name: tool.name,
                  description: tool.description.slice(0, 1024),
                  parameters: tool.inputSchema,
                },
              });
            }
          } catch {
            // unreachable connector service: the turn goes on with the
            // built-in tools rather than failing before it starts
          }
        }
        let usageTotal = { input: 0, output: 0 };

        for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
          const { message, usage } = await completeRaw(messages, model, tools, signal);
          if (usage) {
            usageTotal = { input: usageTotal.input + usage.input, output: usageTotal.output + usage.output };
            // Each request has its own prompt, while accounting still
            // receives the whole turn's sum below.
            if (Number.isFinite(usage.input) && usage.input > 0) {
              emit({ ...base(threadId, turnId), type: "context.reading", used: usage.input, window: null });
            }
          }
          const calls: any[] = Array.isArray(message.tool_calls) ? message.tool_calls : [];

          if (!calls.length) {
            const text = typeof message.content === "string" ? message.content : "";
            if (text.trim()) {
              emit({ ...base(threadId, turnId), type: "content.delta", streamKind: "assistant_text", delta: text });
              emit({ ...base(threadId, turnId), type: "item.completed", itemType: "assistant_text", text });
            }
            if (usageTotal.input || usageTotal.output) {
              emit({ ...base(threadId, turnId), type: "thread.token-usage.updated", ...usageTotal });
            }
            return;
          }

          messages.push(message);
          for (const call of calls) {
            const name = call.function?.name ?? "tool";
            let args: any = {};
            let parsed = true;
            try {
              args = JSON.parse(call.function?.arguments || "{}");
            } catch {
              // a malformed call is the model's mistake to hear about, not
              // a crash for the person watching
              parsed = false;
            }

            emit({
              ...base(threadId, turnId),
              type: "item.started",
              itemType: "tool",
              itemId: call.id,
              title: name === "ask_user" ? "ask_user" : `${name}: ${String(args.command ?? args.url ?? args.query ?? args.fact ?? "").slice(0, 60)}`,
              // the same malformed text twice is the same call twice
              signature: callSignature(name, parsed ? args : String(call.function?.arguments ?? "")),
            });

            let result: string;
            let ok = true;
            if (name === "ask_user") {
              result = await askUser(threadId, turnId, args);
            } else if (name === "request_connection") {
              result = await requestConnection(threadId, turnId, args);
            } else if (name === "request_secret") {
              result = await requestSecret(threadId, turnId, args);
            } else if (name === "search_history" || name === "read_message" || name === "note_about_person") {
              result = await askWorkspace(threadId, turnId, name, args ?? {});
            } else if (name === "sandbox_exec" && sandbox) {
              result = await sandboxExec(sandbox, String(args.command ?? ""));
            } else if (name === "computer_exec" && computer) {
              result = await boxExec(computer, String(args.command ?? ""));
              ok = !result.startsWith("the computer refused");
            } else if (name === "open_url" && computer) {
              const url = String(args.url ?? "");
              if (/^https?:\/\//.test(url)) {
                const quoted = url.replace(/'/g, "%27");
                result = await boxExec(
                  computer,
                  "export DISPLAY=${DISPLAY:-:0}; " +
                    `(google-chrome '${quoted}' || chromium '${quoted}' || xdg-open '${quoted}') >/dev/null 2>&1 & sleep 2; echo opened`,
                );
              } else {
                result = "only http(s) URLs can be opened";
                ok = false;
              }
            } else if (connectors && connectorTools.has(name)) {
              try {
                result = await callMcpTool(connectors, name, args);
              } catch (error) {
                result = `the connector call failed: ${error instanceof Error ? error.message : "unknown error"}`;
                ok = false;
              }
            } else {
              result = `the tool "${name}" is not available in this session`;
              ok = false;
            }

            emit({ ...base(threadId, turnId), type: "item.completed", itemType: "tool", itemId: call.id, ok });
            messages.push({ role: "tool", tool_call_id: call.id, content: result });
          }
        }
        throw new Error("the turn used its whole tool budget without finishing; interrupted");
      };

      /** Put a question in front of the person and wait. The card is the
       * same one every other engine raises; the answer text goes straight
       * back to the model as the tool result. */
      const askUser = (threadId: string, turnId: string, args: any): Promise<string> => {
        const requestId = newId();
        const question = String(args.question ?? "The agent needs your input.");
        const choices = Array.isArray(args.choices)
          ? args.choices.map((c: unknown) => String(c)).slice(0, 5)
          : undefined;

        return new Promise<string>((resolve) => {
          const entry = active.get(threadId);
          if (!entry) return resolve(UNANSWERED);

          const timer = setTimeout(() => {
            entry.asks.delete(requestId);
            emit({
              ...base(threadId, turnId),
              type: "request.resolved",
              requestId,
              behavior: "answer",
              source: "timeout",
            });
            resolve(UNANSWERED);
          }, ASK_TIMEOUT_MS);
          timer.unref?.();

          entry.asks.set(requestId, (answer) => {
            clearTimeout(timer);
            entry.asks.delete(requestId);
            emit({
              ...base(threadId, turnId),
              type: "request.resolved",
              requestId,
              behavior: "answer",
              source: "user",
            });
            resolve(answer);
          });

          emit({
            ...base(threadId, turnId),
            type: "request.opened",
            requestId,
            requestType: "question",
            tool: "ask_user",
            summary: question.slice(0, 300),
            choices,
          });
        });
      };

      const requestSecret = (threadId: string, turnId: string, args: any): Promise<string> => {
        const requestId = newId();
        return new Promise<string>((resolve) => {
          const entry = active.get(threadId);
          if (!entry) return resolve(UNANSWERED);
          entry.asks.set(requestId, (answer) => {
            entry.asks.delete(requestId);
            emit({
              ...base(threadId, turnId),
              type: "request.resolved",
              requestId,
              behavior: "answer",
              source: "user",
            });
            resolve(answer);
          });
          emit({
            ...base(threadId, turnId),
            type: "request.opened",
            requestId,
            requestType: "question",
            tool: "request_secret",
            input: { name: args.name, hint: args.hint },
            summary: "Request a secret",
          });
        });
      };

      /** A tool the workspace answers itself, straight away: no card, no
       * person. The server replies through respondToRequest. */
      const askWorkspace = (threadId: string, turnId: string, tool: string, input: Record<string, unknown>): Promise<string> => {
        const requestId = newId();
        return new Promise<string>((resolve) => {
          const entry = active.get(threadId);
          if (!entry) return resolve("The workspace did not answer.");
          const timer = setTimeout(() => {
            entry.asks.delete(requestId);
            resolve("The workspace did not answer in time.");
          }, 30_000);
          entry.asks.set(requestId, (answer) => {
            clearTimeout(timer);
            entry.asks.delete(requestId);
            resolve(answer);
          });
          emit({ ...base(threadId, turnId), type: "request.opened", requestId, requestType: "question", tool, input, summary: tool });
        });
      };

      const requestConnection = (threadId: string, turnId: string, args: any): Promise<string> => {
        const requestId = newId();
        return new Promise<string>((resolve) => {
          const entry = active.get(threadId);
          if (!entry) return resolve(UNANSWERED);
          entry.asks.set(requestId, (answer) => {
            entry.asks.delete(requestId);
            emit({
              ...base(threadId, turnId),
              type: "request.resolved",
              requestId,
              behavior: "answer",
              source: "user",
            });
            resolve(answer);
          });
          emit({
            ...base(threadId, turnId),
            type: "request.opened",
            requestId,
            requestType: "question",
            tool: "request_connection",
            input: { apps: args.apps, reason: args.reason },
            summary: "Connect apps",
          });
        });
      };

      const sendTurn = async (turn: SendTurnInput) => {
        const { threadId } = turn;
        if (needsKey && !apiKey) throw new Error(`${spec.name} is not connected yet`);
        if (active.has(threadId)) throw new Error("a turn is already running on this thread");
        const turnId = newId();
        const abort = new AbortController();
        const asks = new Map<string, (answer: string) => void>();
        active.set(threadId, { abort, turnId, asks });

        const messages = [
          ...(turn.system ? [{ role: "system", content: turn.system }] : []),
          ...(turn.transcript ?? []).map((m) => ({
            role: m.role === "assistant" ? "assistant" : "user",
            content: m.text,
          })),
          { role: "user", content: turn.text },
        ];
        appendNative(threadId, {
          dir: "out",
          source: `${spec.kind}.chat.completions`,
          msg: { model: turn.model, messages },
        });

        emit({ ...base(threadId, turnId), type: "turn.started" });
        emit({
          ...base(threadId, turnId),
          type: "session.started",
          sessionId: null,
          model: turn.model ?? models.default,
        });

        (async () => {
          try {
            if (spec.tools) {
              await runWithTools(
                threadId,
                turnId,
                messages,
                turn.model || models.default,
                turn,
                abort.signal,
              );
              active.delete(threadId);
              emit({ ...base(threadId, turnId), type: "turn.completed", ok: true, stopReason: null, cost: null });
              return;
            }
            const { text, usage } = await complete(messages, turn.model || models.default, {
              stream: true,
              signal: abort.signal,
              onDelta: (delta) =>
                emit({ ...base(threadId, turnId), type: "content.delta", streamKind: "assistant_text", delta }),
            });
            appendNative(threadId, { dir: "in", source: `${spec.kind}.chat.completions`, msg: { text, usage } });
            if (text.trim()) {
              emit({ ...base(threadId, turnId), type: "item.completed", itemType: "assistant_text", text });
            }
            if (usage) {
              emit({ ...base(threadId, turnId), type: "thread.token-usage.updated", ...usage,
                ...(Number.isFinite(usage.input) && usage.input > 0 ? { context: usage.input } : {}),
              });
            }
            active.delete(threadId);
            emit({ ...base(threadId, turnId), type: "turn.completed", ok: true, stopReason: null, cost: null });
          } catch (e) {
            const entry = active.get(threadId);
            for (const settle of entry?.asks.values() ?? []) settle("The turn ended before you answered.");
            active.delete(threadId);
            const aborted = (e as Error).name === "AbortError";
            if (!aborted) {
              emit({ ...base(threadId, turnId), type: "runtime.error", message: (e as Error).message });
            }
            emit({
              ...base(threadId, turnId),
              type: "turn.completed",
              ok: false,
              stopReason: aborted ? "interrupted" : "error",
              cost: null,
            });
          }
        })();

        return { turnId };
      };

      const snapshot = async (): Promise<ProviderSnapshot> => {
        if (needsKey && !apiKey) {
          return { state: "unavailable", reason: `${spec.name} is not connected. ${spec.keyHint}.` };
        }
        if (Date.now() - catalogAt > CATALOG_TTL_MS) {
          // Wait a beat on the first look so the picker opens with real
          // model names, then never block on it again.
          const first = catalogAt === 0;
          const refresh = refreshCatalog();
          if (first) await Promise.race([refresh, new Promise((r) => setTimeout(r, 2_500))]);
        }
        if (spec.auth === "none") {
          // a local server either answers or it does not
          try {
            const res = await fetch(`${config.url}/models`, { signal: AbortSignal.timeout(1_500) });
            if (!res.ok) throw new Error(String(res.status));
          } catch {
            return { state: "unavailable", reason: `${spec.name} is not running on this machine` };
          }
        }
        if (rejected) {
          return { state: "unavailable", reason: `${spec.name}: ${rejected}. ${spec.keyHint}.` };
        }
        return { state: "available", authenticated: needsKey ? true : undefined, version: null };
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
          capabilities: { sessionModelSwitch: "in-session", replaysNatively: true },
          sendTurn,
          interruptTurn: async (threadId) => active.get(threadId)?.abort.abort(),
          respondToRequest: async (threadId, requestId, decision) => {
            const settle = active.get(threadId)?.asks.get(requestId);
            if (!settle) throw new Error("no such pending request (it may have timed out)");
            settle(decision.message ?? decision.behavior);
          },
          hasSession: (threadId) => active.has(threadId),
          stopAll: async () => {
            for (const { abort } of active.values()) abort.abort();
          },
          onEvent: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
        },
        generateText: async (prompt: string) => {
          const { text } = await complete([{ role: "user", content: prompt }], spec.small || models.default, {
            stream: false,
          });
          return text;
        },
        dispose: async () => {
          for (const { abort } of active.values()) abort.abort();
          listeners.clear();
        },
      };
    },
  };
}
