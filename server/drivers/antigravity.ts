// Antigravity, Google's agentic CLI, driven headless.
//
// agy runs one turn headless and emits newline-delimited JSON when asked
// for stream-json output. Continuity is agy's own conversation id, handed
// back in its first event and replayed with `--conversation` next turn.
//
// Two things about this CLI shape the driver:
//
//   The prompt travels on stdin. argv is readable by every process on the
//   machine through ps, and the persona carries whatever the person wrote
//   about themselves in settings, so since agy 1.1.15 the turn goes in as
//   one stream-json line on stdin, which is then closed: agy answers it
//   and exits. An agy older than that has no stdin path in print mode (a
//   bare --print just exits) and is still handed the prompt with --print.
//
//   There is no interactive permission channel in print mode. accept-edits
//   lets it edit files and refuses the rest; an agent on auto approvals
//   runs in agy's own Auto mode; full access and the full-auto setting
//   remove the guardrails entirely, which is the user's explicit call in
//   settings (agyMode). Approval cards therefore never originate here.
//
//   Print mode takes no MCP servers of the turn's own: agy reads them only
//   from its global mcp_config.json, and --settings carries settings.json
//   keys, which have none. So a turn that carries the agent's connected
//   apps or its MCP servers runs over `agy acp` instead, where ACP's
//   session/new takes them per session (GitHub 546). That turn is the ACP
//   driver's (acp.ts), with everything it does for the other ACP agents:
//   the connectors bridge, keys and headers over stdin and out of argv and
//   the native copy, and a plain refusal for what cannot be reached. agy
//   there can ask, so its questions become cards like any ACP agent's.
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { homedir } from "node:os";

import { lineSplitter } from "../ndjson.ts";

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
import { installCommand } from "../engine-commands.ts";
import { describeEarlyExit, describeSpawnError } from "./spawn-error.ts";
import { OWN_GROUP } from "../no-console.ts";
import { EngineProcesses, signalGroup } from "./engine-processes.ts";
import { DEFAULT_STALL_MINUTES, STOP_GRACE_MS, describeStall, isStalled, type OpenCall } from "./stall.ts";
import { TurnProcess } from "./turn-process.ts";
import { acpDriver, type AcpSpec } from "./acp.ts";

const DRIVER_KIND = "antigravity";

const MODELS = {
  default: "gemini-3.1-pro-high",
  options: [
    { id: "gemini-3.1-pro-high", label: "Gemini 3.1 Pro (High)" },
    { id: "gemini-3.1-pro-low", label: "Gemini 3.1 Pro (Low)" },
    { id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High)" },
    { id: "gemini-3.8-flash-medium", label: "Gemini 3.8 Flash (Medium)" },
    { id: "gemini-3.8-flash-low", label: "Gemini 3.8 Flash (Low)" },
    { id: "gemini-3.7-flash-high", label: "Gemini 3.7 Flash (High)" },
    { id: "gemini-3.7-flash-medium", label: "Gemini 3.7 Flash (Medium)" },
    { id: "gemini-3.7-flash-low", label: "Gemini 3.7 Flash (Low)" },
    { id: "gemini-3.6-flash-high", label: "Gemini 3.6 Flash (High)" },
    { id: "gemini-3.6-flash-medium", label: "Gemini 3.6 Flash (Medium)" },
    { id: "gemini-3.6-flash-low", label: "Gemini 3.6 Flash (Low)" },
    { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6 (Thinking)" },
    { id: "claude-opus-4-6-thinking", label: "Claude Opus 4.6 (Thinking)" },
    { id: "gpt-oss-120b-medium", label: "GPT-OSS 120B (Medium)" },
  ],
};

/** "gemini-3.8-flash-high" as "Gemini 3.8 Flash (High)", the way the
 * list above spells its own. */
export function antigravityLabel(id: string): string {
  const known = MODELS.options.find((o) => o.id === id);
  if (known) return known.label;
  const parts = id.split("-");
  const level = /^(high|medium|low|thinking)$/i.test(parts[parts.length - 1] ?? "") ? parts.pop()! : "";
  const words = parts.map((w) => (/^gpt$|^oss$/i.test(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)));
  const name = words.join(" ").replace(/^GPT OSS/, "GPT-OSS");
  return level ? `${name} (${level.charAt(0).toUpperCase()}${level.slice(1)})` : name;
}

/** The models out of `agy models`. Its output is for people, so this
 * takes the word on each line that looks like a model id (letters, a
 * dash, a digit somewhere), with any "provider/" in front dropped
 * because the CLI only accepts the bare id. Null when nothing on
 * the page looks like one, which covers the signed-out message. */
export function catalogFromAgyModels(stdout: string): ModelCatalog | null {
  const options: ModelCatalog["options"] = [];
  for (const raw of stdout.split("\n")) {
    // a table may put a display name first; the id is the first word
    // on the line that is shaped like one
    const id = raw
      .split(/[\s|,;()]+/)
      .map((w) => w.replace(/^[a-z0-9-]+\//i, "").replace(/[:.]$/, ""))
      .find((w) => /^[a-z0-9.-]+$/i.test(w) && /^[a-z][a-z0-9.]*-[a-z0-9.-]*\d/i.test(w));
    if (!id || options.some((o) => o.id === id)) continue;
    options.push({ id, label: antigravityLabel(id) });
  }
  if (!options.length) return null;
  const keep = options.find((o) => o.id === MODELS.default);
  return { default: keep ? keep.id : options[0].id, options };
}

/** How long a list agy gave is taken as current, and how soon one it
 * could not give is asked for again. */
const CATALOG_FRESH_MS = 10 * 60_000;
const CATALOG_RETRY_MS = 60_000;

/** Said in the picker while the list is ours rather than agy's. */
const BUILT_IN_NOTE = "Antigravity did not list this account's models, so these are the ones built into Bloks. Run `agy` once in a terminal to sign in, and Bloks asks it again.";

/** agy refusing the model it was given, in print mode's words or its
 * error's ("invalid model selection ... not recognized as a known model"). */
export function modelRefused(text: string): boolean {
  return /\bmodel\b/i.test(text) && /not recognized|invalid model|unknown model|available models|not (?:a )?known model/i.test(text);
}

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

/** How much agy may do on its own this turn, from the agent's approvals.
 * Print mode cannot raise an approval card, and whatever agy would have
 * asked about it refuses instead, so the agent's setting has to be told
 * to agy before the turn rather than answered during it (GitHub 542).
 * Full access takes agy's guard off. Auto is agy's own Auto mode: edits
 * and the commands agy's reviewer clears go ahead, and only what that
 * reviewer would still ask about is refused. Ask and edits stay in
 * accept-edits, where edits go ahead and every command is refused,
 * because a command nobody can approve is a command nobody approved. A
 * turn the owner did not vouch for gets accept-edits, however the agent
 * or the engine is set. */
export function agyMode(config: AntigravityConfig, turn: SendTurnInput): string[] {
  if ((config.fullAuto && !turn.untrusted) || (turn.fullAccess && !turn.shared)) return ["--dangerously-skip-permissions"];
  if (turn.autoApproves && !turn.untrusted && !turn.shared && !turn.forOthers && !turn.person) return ["--mode", "auto"];
  return ["--mode", "accept-edits"];
}

/** agy's argv for one turn, never with the prompt unless this agy is too
 * old to read it on stdin. No --print-timeout: that caps the whole turn,
 * so long work that is still moving was cut off at the mark. A wedged
 * tool call is the stall limit's to end, the way it is for Claude Code. */
function agyArgv(config: AntigravityConfig, turn: SendTurnInput, viaStdin: boolean, prompt: string, resume: string | null) {
  const argv = [
    ...(viaStdin ? ["--input-format", "stream-json"] : ["--print", prompt]),
    "--output-format", "stream-json",
  ];
  argv.push(...agyMode(config, turn));
  if (turn.model) argv.push("--model", turn.model);
  if (resume) argv.push("--conversation", resume);
  return argv;
}

/** `agy acp` as the ACP driver launches it, for the turns print mode
 * cannot carry. Never one of the engines on offer: it is this driver's
 * own way to run such a turn, under this engine's name. Full access is
 * agy's flag, as print mode has it; every other turn opens in agy's
 * default mode, so what agy would ask about goes to the approval gate,
 * which answers it as the agent's approvals say. */
export const AGY_ACP: AcpSpec = {
  kind: DRIVER_KIND,
  name: "Antigravity",
  command: "agy",
  args: ["acp"],
  turnArgs: ({ fullAuto, fullAccess }) => (fullAuto || fullAccess ? ["--dangerously-skip-permissions"] : []),
  permissionModes: { default: "default", fullAuto: "default" },
  install: installCommand("antigravity") ?? "curl -fsSL https://antigravity.google/cli/install.sh | bash",
  signIn: "run `agy` once to sign in with Google",
  models: MODELS,
};

/** What of a turn's integrations agy is handed: its connected apps and
 * its MCP servers, exactly as the harness granted them, and nothing else.
 * The browser and the computers stay out (the adapter claims no screens),
 * so this turn is never given what its agent was told it does not have.
 * Null when there is neither, and the turn stays in print mode. */
export function agyIntegrations(turn: Pick<SendTurnInput, "integrations">): SendTurnInput["integrations"] | null {
  const composio = turn.integrations?.composio?.key ? turn.integrations.composio : undefined;
  const mcpServers = turn.integrations?.mcpServers?.length ? turn.integrations.mcpServers : undefined;
  if (!composio && !mcpServers) return null;
  return { ...(composio ? { composio } : {}), ...(mcpServers ? { mcpServers } : {}) };
}

/** A request's tokens as agy counts them, cache reads as input. */
function tokensOf(usage: any) {
  return {
    input: (usage.input_tokens || 0) + (usage.cache_read_tokens || 0),
    output: usage.output_tokens || 0,
  };
}

/** Once agy has given its result it exits by itself. It gets until then,
 * or the stop grace, before anything is signalled, so no signal cuts
 * short what it does on its way out. */
function exitOrGrace(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, STOP_GRACE_MS);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
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
    /** A thread's turn, held until agy and everything it started have
     * ended (turn-process.ts), so a second agy never runs beside it. */
    const running = new Map<string, { turnId: string; abort: () => void; cleanup: () => Promise<boolean> }>();
    /** Every engine process this instance started, ended on dispose (engine-processes.ts). */
    const engines = new EngineProcesses();
    // The turns that carry integrations, over `agy acp` (AGY_ACP), started
    // the first time one comes. Its events are this engine's.
    let overAcp: ProviderInstance | null = null;
    const acpTurns = async () => {
      if (overAcp) return overAcp;
      const made = await acpDriver(AGY_ACP).create({ ...input, config: { cli: config.cli, fullAuto: config.fullAuto } });
      if (overAcp) {
        void made.dispose();
        return overAcp;
      }
      made.adapter.onEvent((event) => emit(event));
      overAcp = made;
      return made;
    };
    const busy = (threadId: string) => running.has(threadId) || Boolean(overAcp?.adapter.hasSession(threadId));

    // Whether this agy takes its prompt on stdin (1.1.15 and later), asked
    // of the CLI once. A version it does not print plainly is taken to be
    // a current one: the prompt stays out of argv unless agy is known to be
    // too old to read it anywhere else.
    let stdinPath: Promise<boolean> | null = null;
    const readsStdin = () =>
      (stdinPath ??= new Promise<boolean>((resolve) => {
        execFile(config.cli, ["--version"], { timeout: 8_000, windowsHide: true }, (error, stdout) => {
          const found = error ? null : /(\d+)\.(\d+)\.(\d+)/.exec(String(stdout));
          if (!found) return resolve(true);
          const [major, minor, patch] = found.slice(1).map(Number);
          resolve(major > 1 || (major === 1 && (minor > 1 || (minor === 1 && patch >= 15))));
        });
      }));

    // What this account can run, from the CLI itself; signed out or
    // unreadable leaves the list above in place, and says so. Read again
    // as it goes stale (freshenCatalog): an account gains and loses models
    // without the CLI changing, an upgrade for one, and a list read once
    // at start kept offering what agy no longer ran (GitHub 542).
    const models: ModelCatalog = { default: MODELS.default, options: [...MODELS.options] };
    const catalogListeners = new Set<() => void>();
    let catalogAsked = 0;
    let reading: Promise<void> | null = null;
    const readCatalog = () =>
      (reading ??= new Promise<void>((resolve) => {
        catalogAsked = Date.now();
        execFile(config.cli, ["models"], { timeout: 20_000, windowsHide: true }, (error, stdout) => {
          reading = null;
          const catalog = error ? null : catalogFromAgyModels(String(stdout));
          const before = JSON.stringify([models.default, models.options, models.note]);
          if (catalog) {
            models.options = catalog.options;
            models.default = catalog.default;
            models.checkedAt = Date.now();
            delete models.note;
          } else if (!models.checkedAt) {
            // a list agy gave earlier is still the better guess than ours
            models.note = BUILT_IN_NOTE;
          }
          if (JSON.stringify([models.default, models.options, models.note]) !== before) {
            for (const listener of [...catalogListeners]) listener();
          }
          resolve();
        });
      }));
    const catalogReady = readCatalog();
    const freshenCatalog = () => {
      if (Date.now() - catalogAsked >= (models.checkedAt ? CATALOG_FRESH_MS : CATALOG_RETRY_MS)) void readCatalog();
    };

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
      if (busy(threadId)) throw new Error("a turn is already running on this thread");

      freshenCatalog();
      // A model agy listed once and lists no longer fails every turn in
      // print mode, so the list's default answers instead and the person
      // is told. Only against a list agy itself gave: ours is a guess.
      const unlisted = Boolean(turn.model && models.checkedAt && !models.options.some((o) => o.id === turn.model));
      const model = unlisted ? models.default : turn.model;

      // The agent's connected apps or MCP servers: a turn over `agy acp`,
      // handed those and nothing more of the integrations.
      const integrations = agyIntegrations(turn);
      if (integrations) {
        const acp = await acpTurns();
        if (busy(threadId)) throw new Error("a turn is already running on this thread");
        const { integrations: _all, ...rest } = turn;
        return acp.adapter.sendTurn({ ...rest, model, integrations });
      }

      const turnId = newId();
      const resume = typeof turn.resumeCursor === "string" ? turn.resumeCursor : null;

      // An agy elsewhere is not probed on this computer.
      const viaStdin = turn.place ? true : await readsStdin();
      const prepared = turn.preparation?.freeze().commit();
      const words = prepared?.text ? `${turn.text}\n\n${prepared.text}` : turn.text;
      // The persona rides ahead of the message in the same prompt, since
      // headless agy offers no separate system channel.
      const prompt = turn.system ? `${turn.system}\n\n${words}` : words;
      const argv = agyArgv(config, { ...turn, model }, viaStdin, prompt, resume);

      const child = (() => {
        try {
          return turn.place
            ? turn.place.spawn(config.cli, argv, { env: { ...process.env, ...(turn.env ?? {}) } })
            : spawn(config.cli, argv, {
                cwd: turn.cwd ?? homedir(),
                env: { ...process.env, ...(turn.env ?? {}) },
                stdio: ["pipe", "pipe", "pipe"],
                detached: OWN_GROUP,
                windowsHide: true,
              });
        } catch (error) {
          prepared?.settle("refused");
          turn.preparation?.unavailable();
          throw error;
        }
      })();
      engines.add(child);
      // before the error listener below, so a spawn that failed is seen as ended
      let completed = false;
      const release = () => {
        if (completed && owner.confirmed && running.get(threadId)?.turnId === turnId) running.delete(threadId);
      };
      const owner = new TurnProcess(child, { onConfirmed: release });
      // The turn as one line, then the end of input: agy answers it and
      // exits. An older agy reads nothing here and gets the end at once.
      // A process that died at once closes its end first; its exit says why.
      child.stdin.on("error", () => {});
      child.stdin.end(viaStdin ? `${JSON.stringify({ event: "user", message: { content: prompt } })}\n` : undefined);
      turn.preparation?.withoutSteering?.();
      // Neither the argv launch nor a pipe write is a native receipt.
      let preparationSettled = false;
      const settlePreparation = (outcome: "accepted" | "refused" | "uncertain") => {
        if (preparationSettled) return;
        preparationSettled = true;
        prepared?.settle(outcome);
        turn.preparation?.unavailable();
      };

      // Tool steps agy has started and not finished, and when agy last
      // said anything at all: what the stall limit reads.
      const openCalls = new Map<string, OpenCall>();
      let lastSign = Date.now();
      let watch: ReturnType<typeof setInterval> | null = null;

      // How the turn ends is chosen once, and sealed: nothing agy prints
      // after that, a result written while it handles SIGTERM for one, can
      // reach this turn or the next. The turn completes once agy and what
      // it started are gone; after a result, agy first gets to exit itself.
      let sealed = false;
      const finish = (ok: boolean, stopReason: string | null, stop = true) => {
        if (sealed) return;
        sealed = true;
        if (watch) clearInterval(watch);
        settlePreparation("uncertain");
        const ended = stop ? owner.end(STOP_GRACE_MS) : exitOrGrace(child).then(() => owner.end(STOP_GRACE_MS));
        void ended.then((confirmed) => {
          if (!confirmed) {
            emit({ ...envelope(threadId, turnId), type: "runtime.error",
              message: "Antigravity did not finish stopping its process and the commands it started. This conversation cannot start another turn until they have ended." });
          }
          completed = true;
          release();
          emit({ ...envelope(threadId, turnId), type: "turn.completed",
            ok: confirmed && ok, stopReason: confirmed ? stopReason : "interrupted", cost: null });
        });
      };

      // agy frames as {event, conversation_id, <event-name>: payload}
      let conversationId: string | null = null;
      // Result usage is the conversation's lifetime total, even after a
      // resume. Only this turn's indexed requests belong in its bill.
      const requests = new Map<number, { input: number; output: number }>();
      let inputTokens = 0;
      let outputTokens = 0;
      const onToolStep = (payload: any) => {
        // steps are indexed, not id'd; the conversation plus the index is
        // the stable name for one tool run
        const itemId = `${conversationId ?? "conv"}:${payload.step_index}`;
        if (payload.state === "ACTIVE") {
          if (!openCalls.has(itemId)) openCalls.set(itemId, { name: payload.tool_name ?? "A tool call", input: null, since: Date.now() });
          // agy never says which files a step wrote
          emit({ ...envelope(threadId, turnId), type: "item.started", itemType: "tool", itemId, title: payload.tool_name, mayWrite: true });
        } else if (payload.state === "DONE" || payload.state === "ERROR") {
          openCalls.delete(itemId);
          emit({ ...envelope(threadId, turnId), type: "item.completed", itemType: "tool", itemId, ok: payload.state === "DONE" });
        }
      };

      const onRequestUsage = (payload: any) => {
        const { input, output } = tokensOf(payload.usage);
        const before = requests.get(payload.step_index);
        inputTokens += input - (before?.input ?? 0);
        outputTokens += output - (before?.output ?? 0);
        requests.set(payload.step_index, { input, output });
        emit({ ...envelope(threadId, turnId), type: "thread.token-usage.updated", input: inputTokens, output: outputTokens, context: input });
      };

      const onResult = (payload: any) => {
        settlePreparation(payload.status === "SUCCESS" ? "accepted" : "uncertain");
        // chosen before anything is said, so nothing said can choose again
        finish(payload.status === "SUCCESS", payload.status ?? null, false);
        // the assistant text arrives here, whole, not streamed
        const text = typeof payload.response === "string" ? payload.response : "";
        if (text) {
          emit({ ...envelope(threadId, turnId), type: "content.delta", streamKind: "assistant_text", delta: text });
          emit({ ...envelope(threadId, turnId), type: "item.completed", itemType: "assistant_text", text });
        }
        // Older result-only streams can measure a fresh turn, but a
        // resumed conversation's total cannot tell what this turn spent.
        if (!requests.size && !resume && payload.usage) {
          emit({ ...envelope(threadId, turnId), type: "thread.token-usage.updated", ...tokensOf(payload.usage) });
        }
        if (payload.status !== "SUCCESS") {
          const message = typeof payload.error === "string" && payload.error
            ? payload.error : `Antigravity ended with status ${payload.status ?? "unknown"}.`;
          if (modelRefused(message)) void readCatalog();
          emit({ ...envelope(threadId, turnId), type: "runtime.error", message });
        }
      };

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
              model: model ?? null,
            });
            break;

          case "step_update":
            if (payload.step_type === "tool") onToolStep(payload);
            else if (payload.step_type === "agent_response" && payload.usage) onRequestUsage(payload);
            break;

          case "result":
            onResult(payload);
            break;
        }
      };

      // multibyte text can split across chunks; decode as utf8 stream
      child.stdout.setEncoding("utf8");
      // read in linear time, however long a line (see lineSplitter)
      child.stdout.on(
        "data",
        lineSplitter((line) => {
          if (sealed) return;
          lastSign = Date.now();
          if (line.trim()) consume(line);
        }),
      );

      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
        if (stderr.length > 8192) stderr = stderr.slice(-8192);
      });

      child.on("error", (error) => {
        if (sealed) return;
        settlePreparation(child.pid ? "uncertain" : "refused");
        finish(false, "spawn_error");
        emit({
          ...envelope(threadId, turnId),
          type: "runtime.error",
          message: describeSpawnError(error, {
            name: "Antigravity",
            command: config.cli,
            install: installCommand("antigravity"),
            signIn: "run `agy` once to sign in with Google",
          }),
        });
      });

      child.on("close", (code) => {
        if (sealed) return;
        // agy exits listing what it has when --model names something else
        if (modelRefused(stderr)) void readCatalog();
        finish(false, "exit_before_result");
        emit({
          ...envelope(threadId, turnId),
          type: "runtime.error",
          message: describeEarlyExit(code, stderr, {
            name: "Antigravity",
            signIn: "run `agy` once in a terminal",
          }),
        });
      });

      // Stop: SIGTERM to the group, then SIGKILL, whatever the stall limit
      // (turn-process.ts). Nothing agy says while it stops is the answer.
      const abort = () => finish(false, "interrupted");

      // A tool step gone silent for the person's limit ends the turn and
      // says which step it was. Print mode never asks anyone anything, so
      // no time here is the person's.
      const limitMs = typeof turn.stallMs === "number" ? turn.stallMs : DEFAULT_STALL_MINUTES * 60_000;
      if (limitMs > 0) {
        watch = setInterval(() => {
          const now = Date.now();
          if (sealed || !isStalled({ open: openCalls.size, asking: 0, lastSign, now, limitMs })) return;
          const oldest = [...openCalls.values()].sort((a, b) => a.since - b.since)[0];
          finish(false, "tool_stalled");
          emit({ ...envelope(threadId, turnId), type: "runtime.error", message: describeStall(oldest, now - lastSign) });
        }, Math.max(250, Math.min(15_000, limitMs / 4)));
        watch.unref?.();
      }

      running.set(threadId, { turnId, abort, cleanup: () => {
        // Disposal's instance-wide helper may have forgotten this leader
        // after its exit; what it left in the group still has to end now.
        if (!owner.confirmed) signalGroup(child, "SIGKILL");
        return owner.end(STOP_GRACE_MS);
      } });
      emit({ ...envelope(threadId, turnId), type: "turn.started" });
      // A notice, not a failure: the turn goes on, on the model named. Not
      // to a Telegram person, whom an engine's error tells the agent
      // cannot answer; the owner's own next turn says it.
      if (unlisted && !turn.person) {
        emit({ ...envelope(threadId, turnId), type: "runtime.error",
          message: `Antigravity no longer offers ${antigravityLabel(turn.model!)} on this account, so this turn runs on ${antigravityLabel(model!)}. Pick one of the models it offers now in this agent's settings.` });
      }
      // never the prompt, which an older agy has in its argv
      appendNative(threadId, { dir: "out", source: "agy.stream", msg: { argv: viaStdin ? argv : argv.slice(2) } });

      return { turnId };
    };

    const snapshot = async (): Promise<ProviderSnapshot> => {
      const version = await new Promise<string | null>((resolve) => {
        execFile(config.cli, ["--version"], { timeout: 8_000, windowsHide: true }, (error, stdout) =>
          resolve(error ? null : stdout.trim()),
        );
      });
      if (!version) return { state: "unavailable", reason: `\`${config.cli}\` CLI not found` };
      // Settings asking after the engine is the moment to look at its
      // models again too, a sign-in or an upgrade since being the likely
      // reason it is asked
      freshenCatalog();
      // agy keeps its login in the system keyring, which leaves no file to
      // check. Installed is all that can honestly be reported.
      return { state: "available", version };
    };

    return {
      instanceId,
      driverKind: DRIVER_KIND,
      displayName: input.displayName,
      enabled: input.enabled,
      models,
      snapshot,
      catalogReady,
      refreshCatalog: readCatalog,
      onCatalogChange: (listener) => {
        catalogListeners.add(listener);
        return () => catalogListeners.delete(listener);
      },

      adapter: {
        provider: DRIVER_KIND,
        capabilities: { sessionModelSwitch: "in-session" },
        sendTurn,
        interruptTurn: async (threadId, turnId) => {
          if (overAcp?.adapter.hasSession(threadId)) return overAcp.adapter.interruptTurn(threadId, turnId);
          running.get(threadId)?.abort();
        },
        // only a turn over `agy acp` can ask anything
        respondToRequest: async (threadId, requestId, decision) => {
          if (overAcp?.adapter.hasSession(threadId)) return overAcp.adapter.respondToRequest(threadId, requestId, decision);
          throw new Error("Antigravity's print mode has no permission channel");
        },
        hasSession: (threadId) => busy(threadId),
        stopAll: async () => {
          for (const turn of running.values()) turn.abort();
          await overAcp?.adapter.stopAll();
        },
        onEvent: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },

      dispose: async () => {
        const turns = [...running.values()];
        for (const turn of turns) turn.abort();
        listeners.clear();
        catalogListeners.clear();
        await engines.end();
        await Promise.all([...turns.map((turn) => turn.cleanup()), overAcp?.dispose()]);
      },
    };
  },
};
