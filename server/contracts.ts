// The shape every provider is flattened into.
//
// Bloks talks to CLIs that spawn processes, to chat APIs that stream
// tokens, and to an agent running on a remote machine. None of them
// resemble each other. This file is the one description they all get
// converted to, and the reason the rest of the codebase can be written as
// if there were only one kind of agent.
//
// The conversion is deliberately lossy in one direction only: a driver may
// drop detail it cannot express, but it may never invent an event that did
// not happen. `raw` carries the untranslated original for anyone who needs
// to see behind the flattening.
//
// Plain promises and listener callbacks throughout. No effect system, no
// observables: a driver author should be able to read one file and write
// another, and every abstraction here is one they would have to learn
// first.

export type DriverKind = string;
export type InstanceId = string;
export type ThreadId = string;
export type TurnId = string;

// ── choosing a model ───────────────────────────────────────────────────

/**
 * Which engine and which model, carried on the request.
 *
 * Deliberately data rather than a binding to a service: an agent stores
 * this on its record and it is read fresh each turn, so changing model
 * mid-conversation is a field update rather than a reconnection.
 * `instanceId` is what routing keys on.
 */
export interface ModelSelection {
  instanceId: InstanceId;
  model: string;
}

// ── configuring an instance ────────────────────────────────────────────

/**
 * One configured engine.
 *
 * `driver` is an unvalidated slug on purpose. An instance naming a driver
 * this build does not have survives loading and reports itself
 * unavailable, so configuration written by a newer version downgrades
 * safely instead of being deleted. See server/harness/registry.ts.
 */
export interface InstanceConfig {
  driver: DriverKind;
  displayName?: string;
  accentColor?: string;
  environment?: Record<string, string>;
  enabled?: boolean;
  config?: unknown;
}

export type InstanceConfigMap = Record<InstanceId, InstanceConfig>;

// ── what a turn emits ──────────────────────────────────────────────────

/** Fields every event carries, whatever its type. */
export interface RuntimeEventBase {
  codexItem?: import("./codex-text.ts").CodexItemText;
  codexText?: import("./codex-text.ts").CodexText;
  eventId: string;
  provider: DriverKind;
  providerInstanceId?: InstanceId;
  threadId: ThreadId;
  createdAt: string;
  turnId?: TurnId;
  itemId?: string;
  requestId?: string;
  /** The provider's own message, untranslated. */
  raw?: { source: string; payload: unknown };
}

/**
 * Everything that can happen during a turn.
 *
 * Worth knowing about four of these:
 *
 *   `content.delta` is text as it is produced. Some providers stream token
 *   by token and some hand over a whole paragraph at once; both emit this,
 *   so the UI has one code path for live text.
 *
 *   `item.completed` with `assistant_text` is the settled version of that
 *   same text, and it is what gets written to the transcript. The delta is
 *   for watching, this is for keeping.
 *
 *   `request.opened` means the turn is now blocked on a human. Nothing
 *   proceeds until a matching `request.resolved` arrives.
 *
 *   `context.compacted` is the engine summarising its own session, which
 *   Bloks did not ask for unless it sent the turn that did it.
 */
export type RuntimeEvent = RuntimeEventBase &
  (
    | { type: "session.started"; sessionId: string | null; model?: string | null }
    | { type: "commands.updated"; cwd: string | null; catalog: import("./agent-commands.ts").ClaudeCatalog }
    | { type: "session.exited"; reason?: string }
    | { type: "turn.started" }
    /** The Codex speed a turn is running at, said once its thread is open. */
    | { type: "codex.speed"; choice: import("./codex-speed.ts").CodexSpeedChoice; configuredTier: string | null; actualTier: null }
    | {
        type: "turn.completed";
        ok: boolean;
        stopReason?: string | null;
        /** Refused before the words reached the model (Fast that could
         * not be had): the message is unsent, not an engine failure. */
        preInputRefusal?: import("./codex-speed.ts").CodexSpeedRefusal;
        cost?: number | null;
        /** What the turn used, and on which model, when the provider put
         * no price on it: for pricing it from the providers' list prices
         * as an estimate (server/model-prices.ts). Only from an engine on
         * the person's own key, never from Bloks AI. */
        unpriced?: { model: string; input: number; output: number; cachedInput: number };
        denials?: string[];
      }
    | {
        type: "item.started";
        itemType: "tool" | "reasoning";
        title?: string;
        /** Command display detail. The bus redacts and bounds it before
         * logging or publishing; title stays the tool's counted kind. */
        command?: string;
        /** The files this call writes, when the engine says: what a change
         * card can be sure was this turn's own work (server/checkpoints.ts). */
        paths?: string[];
        /** This call may write files it does not name: a shell command, or
         * any call on an engine that never says which files it wrote. */
        mayWrite?: boolean;
        /** The tool and its arguments, normalised and hashed
         * (callSignature in server/repeats.ts), when the engine reports
         * the arguments. Two calls with one signature asked for the same
         * thing, which is how a turn going round in circles is noticed.
         * A hash rather than the arguments, which can carry a key. */
        signature?: string;
      }
    | { type: "item.updated"; itemType: "tool" | "reasoning"; tokens?: number | null }
    | { type: "item.completed"; itemType: "tool"; ok: boolean }
    | {
        type: "item.completed"; itemType: "assistant_text"; text: string;
        /** Reliable native phase, for notification selection only. */
        replyPhase?: import("./reply-notifications.ts").ReplyPhase;
        /** Adapter-generated chat placeholder, not provider-supplied text. */
        syntheticText?: true;
      }
    | { type: "content.delta"; streamKind: "assistant_text" | "reasoning_text"; delta: string }
    | {
        type: "request.opened";
        requestType: "permission" | "question";
        tool: string;
        /** The raw tool arguments, for asks the harness itself serves
         * (e.g. request_connection plants cards and answers instantly). */
        input?: unknown;
        summary: string;
        choices?: string[];
        /** Nothing is waiting on this question: the engine was told it was
         * taken and carried on (Codex's request_user_input_async). Its
         * answer is said in the conversation, as the person's words. */
        async?: true;
      }
    | {
        type: "request.resolved"; behavior: string; source: string;
        /** What the person answered an async question with, for the
         * harness to say in the conversation that asked it. */
        answer?: string;
      }
    | {
        type: "thread.token-usage.updated";
        input: number;
        output: number;
        /** The whole prompt this request carried, cache writes included,
         * which `input` leaves out. How full the session is right now. */
        context?: number;
        /** How long the provider keeps this prompt cached, when the
         * request wrote to the cache and said which lifetime it used. */
        cacheTtl?: "5m" | "1h";
      }
    | {
        /** How full the session is, in the engine's own numbers: the
         * size of the latest request, and the window it is measured
         * against. Either may be missing, and a missing one leaves the
         * last known value as it was. Kept apart from the token counts
         * above, which are what a turn spent, not how full it is. */
        type: "context.reading";
        used: number | null;
        window: number | null;
      }
    | {
        /** The engine summarised its own session. Token counts are what
         * the engine reported, either of which may be missing. */
        type: "context.compacted";
        trigger: string | null;
        before: number | null;
        after: number | null;
      }
    | {
        type: "runtime.error";
        message: string;
        preInputRefusal?: import("./codex-speed.ts").CodexSpeedRefusal;
        /** The Bloks credits balance ran out (a 402 from the credits
         * service, server/credits.ts). `message` is the service's words. */
        credits?: "empty";
      }
  );

export type RuntimeEventListener = (event: RuntimeEvent) => void;

// ── running a turn ─────────────────────────────────────────────────────

/** Frozen membership for additions to one initial input. The words are
 * re-read and authorized by commit at the physical input boundary. */
export interface FrozenPreparation {
  hasInputs: boolean;
  skillNames: string[];
  commit(): {
    text: string;
    skillNames: string[];
    images: import("./attachments.ts").TurnImage[];
    settle(outcome: "accepted" | "refused" | "uncertain"): void;
  };
}

export interface TurnPreparation {
  freeze(): FrozenPreparation;
  ready(turnId: string): void;
  /** The initial input has been dispatched and this adapter cannot steer. */
  withoutSteering?(): void;
  unavailable(): void;
}

export interface SendTurnInput {
  /** The owner or an admin started this turn in a team conversation or a
   * room, so the agent may message one person privately on their behalf
   * (server/access.ts). Claude Code gets a message_person tool for it. */
  messagePerson?: boolean;
  /** Codex speed, resolved when the turn is dispatched and kept for the
   * whole turn, steers included. Engines other than Codex ignore it. */
  codexSpeed?: import("./codex-speed.ts").CodexSpeedChoice;
  threadId: ThreadId;
  text: string;
  /** Internal callbacks for personal words admitted while this turn is
   * being prepared. Never supplied by a client. */
  preparation?: TurnPreparation;
  /** The pictures `text` attaches, read back as bytes, for an engine that
   * takes pictures rather than paths (capabilities.images). The words
   * still name each one. Set only for such an engine. */
  images?: import("./attachments.ts").TurnImage[];
  model?: string;
  /** Run without the engine's hooks (Claude Code: plugins and settings
   * hooks). Engines without hooks ignore it. */
  noHooks?: boolean;
  /** Reasoning effort, already one this engine and model take (dispatch
   * sends the nearest, server/effort.ts). Engines with no dial ignore it. */
  effort?: import("./effort.ts").Effort;
  /** The provider's own idea of where this conversation was, from the last
   * turn. A session id for the CLIs; unused by drivers that replay. */
  resumeCursor?: unknown;
  /** Earlier turns, for providers with no memory of their own. */
  transcript?: Array<{ role: "user" | "assistant"; text: string }>;
  /** Who this agent is, as a system prompt. */
  system?: string;
  /** How long a tool call may go without a word from the engine before
   * the turn is stopped; 0 is never. Drivers that cannot tell ignore it. */
  stallMs?: number;
  /** What happens to background work the turn starts once its reply is
   * written: the turn waits for it, or ends and stops it
   * (server/background-work.ts). Unset waits. Drivers whose engine runs
   * nothing in the background ignore it. */
  backgroundWork?: "finish" | "stop";
  /** Capabilities to hand the agent as tools, decided per turn because
   * they depend on the agent's settings and on what is provisioned. */
  integrations?: {
    composio?: { url?: string; key: string };
    /** The agent's cloud computer. */
    computer?: { boxId: string; token: string };
    /**
     * This Mac. The spawn details come verbatim from the descriptor
     * Electron wrote, and must be used as given: the daemon has to be the
     * one the app owns, because that is the process holding the macOS
     * permission grants. The harness only points the agent at it.
     */
    localComputer?: { command: string; args: string[]; env: Record<string, string> };
    /** A Linux container on this machine: shell and files, no display.
     * Resolved by the harness before the turn; drivers only relay it. */
    sandbox?: { runtime: string; name: string };
    /** A real browser, driven through its debugging protocol rather than
     * through pixels. Separate from `computer` on purpose: the web will
     * describe itself if asked, and a native app will not. Its port is
     * the profile's own browser's, found from the profile (cdp.ts). */
    browser?: { profileDir: string };
    /** User-registered MCP servers this agent may use, already resolved
     * to their full spawn/connect shape by the harness. */
    mcpServers?: Array<{
      name: string;
      transport: "stdio" | "http";
      command?: string;
      args?: string[];
      url?: string;
      headers?: Record<string, string>;
      /** A stdio server's own environment. Empty values are names still
       * waiting for the person, and a driver leaves them out. */
      env?: Record<string, string>;
    }>;
  };
  /**
   * Set when the turn is in a room the owner has shared with other
   * people. The driver must switch off every tool it has beyond what is
   * named here, and must not load the owner's own memory or settings:
   * the people reading the replies are not the owner. Only drivers the
   * harness lists as able to do this ever receive it (sharedSafe in
   * server/index.ts); the rest are kept out of shared rooms.
   *
   * "conversation": no tools at all. "desk": read and write files in cwd.
   * Any integrations on a shared turn are ones the owner opened to the
   * room, and the driver must ask before every call to them: nothing
   * of the owner's is pre-allowed. Only the Claude driver is trusted
   * with that (ownerToolsSafe in server/index.ts).
   */
  shared?: { tools: "conversation" | "desk" };
  /** The agent is in full access: the engine's own guards come off too
   * (no permission prompts, no sandbox), so nothing asks and nothing is
   * routed through the approval gate. Never set on a shared turn. */
  fullAccess?: boolean;
  /** Somebody the owner has not vouched for asked for this turn (an
   * email when anyone may write), and its approvals go to the owner as
   * cards. No driver skips its engine's guards for it, however its
   * instance is set, and one that pre-allows tools or edits of its own
   * accord (Claude Code) does not. Never with `fullAccess`. */
  untrusted?: boolean;
  /** A let-in Telegram person. Fresh native session, owner-only approvals
   * and a turn-bound reply tool, even on a full-access agent. */
  person?: import("./person-turn.ts").PersonTurn;
  /** A bound reply does not make an owner group turn untrusted. */
  reply?: { reply(input: unknown): Promise<string> };
  cwd?: string;
  /** Folders the agent may edit without asking, beyond its cwd. The
   * harness grants its own workspace (memory lives there) so an agent
   * with a custom working folder can still keep notes. */
  extraDirs?: string[];
  /** Extra environment for the process this turn runs in, where there is
   * one. This is how a turn's own credential reaches the agent: a driver
   * that runs a CLI merges it into the child's environment, and a driver
   * that talks to an API over HTTP has no process to put it in and
   * ignores it, which is the honest outcome rather than a missing
   * feature. */
  env?: Record<string, string>;
  /** What this turn is, and on a shared room member's turn whose it is,
   * for a service that picks the model by it (server/bloks-ai.ts). Only
   * sent on Bloks AI, whose engine sends it as headers on each call.
   * Others ignore it. */
  tags?: import("./bloks-ai.ts").CallTags;
  /**
   * The whole message to send instead of `text` when the session behind
   * `resumeCursor` turns out to be gone and the driver opens a new one:
   * the bounded story so far, then the words. Without it, a session the
   * engine has forgotten costs the agent everything said before.
   */
  handoff?: string;
  /**
   * A session that belongs to another program: one the person had in
   * this engine before Bloks and brought over (server/session-import.ts).
   * When `resumeCursor` is still this id, the driver continues it in a
   * copy (Claude Code's --fork-session, Codex's thread/fork) and never in
   * place, so the person's own session file is not written. A driver that
   * cannot copy it does not resume it at all, and sends `handoff`, the
   * conversation told, in a new session instead.
   */
  forkFrom?: string;
  /**
   * The resumed session has grown past the lane's line (compactBeforeTurn
   * in server/context.ts). A driver that says it can (`compactsFirst`)
   * compacts it by the engine's own means before the words go, and
   * reports `context.compacted`; if the engine cannot, it opens a new
   * session and sends `handoff` instead. Never set on a fresh session.
   */
  compactFirst?: boolean;
  /** An explicit Codex command: compact this session and stop there. */
  compactOnly?: boolean;
  /** Names found only in this segment's personal messages, before notes. */
  skillNames?: string[];
  /**
   * Set when the agent works somewhere else: in a Docker container or on
   * another machine over SSH (server/workplace-run.ts). A driver that
   * runs a process starts it with `place.spawn` instead of spawn, hands
   * it files with `place.file` instead of writing them here, and points
   * it at every MCP server through `place.mcp`, which keeps the server
   * itself on this computer. `cwd` is then the folder there, and
   * `extraDirs` are left out: they are folders on this computer.
   */
  place?: PlaceRun;
}

/** One turn's process on another side. See SendTurnInput.place. */
export interface PlaceRun {
  /** Where, for a sentence: "container bloks-scout", "build-box". */
  label: string;
  /** The working folder there. */
  cwd: string;
  /** The engine, started there with its stdio carried here. `command` is
   * the program as this computer would run it; the place says what it is
   * called there. Only the turn's own environment and the driver's own
   * switches in `env` go with it, never this computer's. */
  spawn: (command: string, args: string[], options?: { env?: Record<string, string | undefined> }) => import("node:child_process").ChildProcessWithoutNullStreams;
  /** A private file there for this turn, written ahead of the engine;
   * answers its path there. Call before spawn. */
  file(name: string, content: string): string;
  /** An MCP server, as the engine there reaches it: over HTTP, through
   * Bloks' gate, with the turn's own gate token. The server runs here
   * (stdio) or is called from here (HTTP), with its own keys added here.
   * Null for one that cannot be carried. */
  mcp(
    name: string,
    server: { transport?: string; command?: string; args?: string[]; env?: Record<string, string>; url?: string; headers?: Record<string, string> },
  ): { url: string; headers: Record<string, string> } | null;
}

export interface TurnStartResult {
  turnId: TurnId;
}

/**
 * What a driver has to provide.
 *
 * Sessions start implicitly on the first turn rather than being opened;
 * there is no connect step to get wrong, and a provider that died between
 * turns is simply started again.
 */
export interface ProviderAdapter {
  readonly provider: DriverKind;
  readonly capabilities: {
    sessionModelSwitch: "in-session" | "unsupported";
    /** True when the driver replays the whole transcript itself every
     * turn (API engines); false for session-cursor engines, which need
     * the harness to replay history after an engine switch. */
    replaysNatively?: boolean;
    /** An API engine can call the harness's bound sender-reply function. */
    replyToSender?: boolean;
    /** An API engine runs the harness's tool loop on its turns, so its
     * prompt can name the tools that live there (ask_user, the memory
     * tools, request_secret). Per instance, not per driver: a custom host
     * has it only once its owner switched tools on. */
    toolLoop?: boolean;
    /** Takes `compactFirst` on a turn (see SendTurnInput). */
    compactsFirst?: boolean;
    /** Takes a turn's attached pictures as pictures (SendTurnInput.images).
     * Absent on an engine that is sent only their paths, which one with a
     * shell opens itself and an API model cannot see at all. */
    images?: boolean;
    /** The reasoning effort levels this driver passes on to its engine,
     * least first. Absent is an engine with no dial, whose turns are sent
     * no effort (server/effort.ts). */
    efforts?: readonly import("./effort.ts").Effort[];
  };
  sendTurn(input: SendTurnInput): Promise<TurnStartResult>;
  /**
   * More words from the person for the turn running on this thread, read
   * by the engine after the step it is on, without interrupting it.
   * True once the running turn has them; false when it cannot take them
   * (no turn running, the turn is ending, the engine refused), and the
   * harness then keeps them for the next turn instead. A driver must
   * never answer false for words the engine may still act on, or they
   * would be said twice. Optional: an engine that cannot take input
   * mid-turn leaves it out and everything waits for the next turn.
   * onDispatch, when supplied for a reserved report, runs immediately before
   * the physical write. Errors after that attempt must propagate, not fall back.
   */
  steerTurn?(threadId: ThreadId, text: string, options?: { skillNames?: string[]; onAccepted?: (turnId: string) => void; onDispatch?: () => void }): Promise<boolean>;
  /** Preparation-bound steering distinguishes refusal from an outcome
   * that may have reached the engine but has no matching receipt. */
  steerPrepared?(threadId: ThreadId, expectedTurnId: TurnId, text: string, options: { skillNames?: string[]; onDispatch: () => void; onAcceptedLate?: () => void }): Promise<"accepted" | "refused" | "uncertain">;
  interruptTurn(threadId: ThreadId, turnId?: TurnId): Promise<void>;
  respondToRequest(
    threadId: ThreadId,
    requestId: string,
    decision: { behavior: "allow" | "deny" | "answer"; message?: string },
  ): Promise<void>;
  hasSession(threadId: ThreadId): boolean;
  stopAll(): Promise<void>;
  onEvent(listener: RuntimeEventListener): () => void;
}

// ── is this engine usable ──────────────────────────────────────────────

/** `authenticated` is separate from `state` because installed and signed
 * in are different problems with different fixes, and telling someone to
 * install a CLI they already have is worse than saying nothing. */
export interface ProviderSnapshot {
  state: "available" | "unavailable";
  reason?: string;
  authenticated?: boolean;
  version?: string | null;
}

// ── what a plan has left ───────────────────────────────────────────────

/** One limit of the subscription an engine is signed in with, as the
 * engine reported it (server/plan-usage.ts). */
export interface PlanWindow {
  /** The engine's own name for it: five_hour, seven_day, primary. */
  id: string;
  /** How long the window is, when the engine says or its name does. */
  minutes: number | null;
  /** The share used, from 0. Past 1 when usage ran over the cap. */
  used: number;
  /** When it starts again, in epoch milliseconds, when known. */
  resetsAt: number | null;
  /** The engine's own word that this one is near its limit, or at it. */
  status?: "warning" | "rejected";
}

export interface PlanUsage {
  windows: PlanWindow[];
  /** The plan's name, when the engine says (Codex does). */
  plan: string | null;
  /** When the engine last said, in epoch milliseconds. */
  at: number;
}

/** How much a usage notice asks for: worth knowing, near a limit, at one. */
export type UsageLevel = "info" | "warn" | "stop";

/**
 * A notice in the composer about a limit, as GET /api/usage-notices
 * sends it to this app and to a paired phone. From Bloks AI's own word
 * (source "bloks-ai"), from an engine's plan windows, or from a spending
 * limit on an engine on the person's own key (source is the engine
 * instance). A share and a time, never an amount.
 */
export interface UsageNotice {
  /** Stable while it says the same thing, so putting it away holds. */
  id: string;
  source: string;
  level: UsageLevel;
  title: string;
  /** A whole percent, 0 to 100. */
  usedPercent: number;
  /** Epoch milliseconds, when known. */
  resetsAt: number | null;
  /** "spend" for a spending limit on the person's own key, whose month
   * starts again rather than a window resetting. Absent for the rest; a
   * client that does not know it says "Resets" for every notice. */
  kind?: "spend";
}

// ── defining a driver ──────────────────────────────────────────────────

export interface ModelCatalog {
  default: string;
  /** codexFast: whether Codex offers Fast for the model, where it said.
   * efforts: the effort levels the engine listed for the model, where it
   * said; a model without them has the engine's own (server/effort.ts). */
  options: Array<{ id: string; label: string; codexFast?: boolean; efforts?: import("./effort.ts").Effort[] }>;
  /** When the engine last reported the list, so an old answer about Fast
   * is not taken as current. */
  checkedAt?: number;
  /** Where the list came from, said in the picker, when it is not the
   * engine reporting it live (a list built into Bloks, for one). */
  note?: string;
  /** The engine takes any model id it is given, so the picker offers to
   * use one typed in that the list does not have yet. */
  acceptsAnyId?: boolean;
}

export interface DriverCreateInput<Config> {
  instanceId: InstanceId;
  displayName: string | undefined;
  environment: Record<string, string>;
  enabled: boolean;
  config: Config;
}

export interface ProviderInstance {
  readonly instanceId: InstanceId;
  readonly driverKind: DriverKind;
  readonly displayName: string | undefined;
  readonly enabled: boolean;
  readonly models: ModelCatalog;
  readonly adapter: ProviderAdapter;
  /** Resolves when a deferred catalog probe has finished, if this engine
   * has one. The picker loads before that, so the harness refetches. */
  catalogReady?: Promise<void>;
  /** Read-only native skill discovery. Paths are server-only. */
  skills?(cwd: string): Promise<import("./codex-skills.ts").CodexSkill[] | null>;
  snapshot(): Promise<ProviderSnapshot>;
  /** A cheap one-shot completion, for naming and summarising. Optional:
   * not every engine has something small enough to be worth using.
   * `quick` is for an answer someone is waiting on as they type: the
   * engine skips any thinking it would do before writing, which it may
   * ignore when it has none to skip. */
  generateText?(prompt: string, options?: { quick?: boolean; work?: import("./bloks-ai.ts").WorkTag }): Promise<string>;
  /** Whether generateText runs on a model its provider names as small and
   * cheap, rather than the engine's main one. What a decision made on
   * every message is allowed to use (server/delivery.ts); a slower or
   * dearer one is left to the work that is worth it. */
  smallText?: boolean;
  /** The model generateText runs on, so a setting that spends it can
   * say which. Absent where the engine does not say. */
  textModel?: string;
  /** The latest the engine said about its plan's limits, kept in memory
   * on the instance and null until it says anything. Optional: only an
   * engine signed in to a subscription has limits to report. For the
   * person to read; never part of a prompt. */
  planUsage?(): PlanUsage | null;
  dispose(): Promise<void>;
}

/**
 * A driver is a plain record, not a class to extend.
 *
 * Two rules for `create`: it owns all per-instance state, so two calls
 * share nothing, and it must reject rather than throw synchronously. The
 * registry turns a rejection into an unavailable placeholder, and a
 * synchronous throw would escape that and take down startup.
 */
export interface ProviderDriver<Config = unknown> {
  readonly driverKind: DriverKind;
  readonly metadata: { displayName: string; supportsMultipleInstances?: boolean };
  /** Throw on invalid config; the instance becomes a placeholder. */
  decodeConfig(raw: unknown): Config;
  defaultConfig(): Config;
  readonly models: ModelCatalog;
  create(input: DriverCreateInput<Config>): Promise<ProviderInstance>;
}

export type AnyProviderDriver = ProviderDriver<any>;

// ── ids ────────────────────────────────────────────────────────────────

let eventCounter = 0;

/** Sortable and unique within a process. Events are written in order and
 * read back in order, so a counter beats randomness here. */
export const newEventId = () => `ev-${Date.now().toString(36)}-${(eventCounter++).toString(36)}`;

export const newId = () => crypto.randomUUID();
