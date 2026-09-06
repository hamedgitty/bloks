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
 * Worth knowing about three of these:
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
 */
export type RuntimeEvent = RuntimeEventBase &
  (
    | { type: "session.started"; sessionId: string | null; model?: string | null }
    | { type: "session.exited"; reason?: string }
    | { type: "turn.started" }
    | {
        type: "turn.completed";
        ok: boolean;
        stopReason?: string | null;
        cost?: number | null;
        denials?: string[];
      }
    | { type: "item.started"; itemType: "tool" | "reasoning"; title?: string }
    | { type: "item.updated"; itemType: "tool" | "reasoning"; tokens?: number | null }
    | { type: "item.completed"; itemType: "tool"; ok: boolean }
    | { type: "item.completed"; itemType: "assistant_text"; text: string }
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
      }
    | { type: "request.resolved"; behavior: string; source: string }
    | { type: "thread.token-usage.updated"; input: number; output: number }
    | { type: "runtime.error"; message: string }
  );

export type RuntimeEventListener = (event: RuntimeEvent) => void;

// ── running a turn ─────────────────────────────────────────────────────

export interface SendTurnInput {
  threadId: ThreadId;
  text: string;
  model?: string;
  /** Reasoning effort, for engines with the dial. Others ignore it. */
  effort?: "low" | "medium" | "high";
  /** The provider's own idea of where this conversation was, from the last
   * turn. A session id for the CLIs; unused by drivers that replay. */
  resumeCursor?: unknown;
  /** Earlier turns, for providers with no memory of their own. */
  transcript?: Array<{ role: "user" | "assistant"; text: string }>;
  /** Who this agent is, as a system prompt. */
  system?: string;
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
     * describe itself if asked, and a native app will not. */
    browser?: { profileDir: string; port: number };
    /** User-registered MCP servers this agent may use, already resolved
     * to their full spawn/connect shape by the harness. */
    mcpServers?: Array<{
      name: string;
      transport: "stdio" | "http";
      command?: string;
      args?: string[];
      url?: string;
      headers?: Record<string, string>;
    }>;
  };
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
  };
  sendTurn(input: SendTurnInput): Promise<TurnStartResult>;
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

// ── defining a driver ──────────────────────────────────────────────────

export interface ModelCatalog {
  default: string;
  options: Array<{ id: string; label: string }>;
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
  snapshot(): Promise<ProviderSnapshot>;
  /** A cheap one-shot completion, for naming and summarising. Optional:
   * not every engine has something small enough to be worth using. */
  generateText?(prompt: string): Promise<string>;
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
