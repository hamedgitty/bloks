// How full a conversation is, and what to do when it fills.
//
// A model can only be told so much at once. Until now this was handled by
// sending the last forty messages and letting the rest fall off the back,
// which is the worst version of both options: the agent quietly forgets
// what was said an hour ago, nobody is told, and on a small model forty
// long messages can still be too many.
//
// So: measure, show, and when it fills, summarise the old part and carry
// on. Three rules the rest of this file exists to keep.
//
//   Nothing is dropped silently. What falls out of the window is
//   summarised into the conversation, and the summary is a message people
//   can read rather than a hidden state.
//
//   Pressure is a fact about a lane, not about an agent. Two lanes on the
//   same agent are two conversations and fill up separately.
//
//   Being wrong about a limit costs a summary, never a broken thread. If
//   the guess is low we compact early; if it is high the provider says so
//   and that is recoverable too, which is why the error is recognised
//   rather than surfaced as a failed turn.
//
// Everything here is pure.

/**
 * How much a model will take.
 *
 * Approximations by family, because there is no reliable way to ask most
 * providers and a table that is roughly right beats no table: the cost of
 * being low is summarising sooner than strictly necessary, and the cost of
 * being high is one recoverable error. Both are better than the silent
 * forgetting this replaces.
 */
const LIMITS: Array<[RegExp, number]> = [
  [/^claude-fable-5-1(?:$|-)/i, 1_000_000],
  [/^claude-opus-5-5(?:$|-)/i, 1_000_000],
  [/^claude/i, 200_000],
  // Claude Code's aliases for the newest model in a family; the safe guess
  [/^(opus|sonnet|haiku)$/i, 200_000],
  [/^gemini/i, 1_000_000],
  [/^grok/i, 131_072],
  [/^(gpt-4o|gpt-4\.1|o[134])/i, 128_000],
  [/^gpt-5/i, 400_000],
  // Codex's default window is smaller than the GPT-6 API maximum. Point
  // releases count too (gpt-6.1-sol), which once fell to the default.
  [/^gpt-6(?:$|[-.])/i, 272_000],
  [/^deepseek/i, 65_536],
  [/^kimi|^moonshot/i, 131_072],
  [/^llama/i, 131_072],
  [/^mistral|^magistral|^devstral/i, 131_072],
  [/^qwen/i, 131_072],
  [/^glm/i, 131_072],
];

/** What we assume when the name says nothing. Deliberately small: a
 * conversation that compacts sooner than it had to is a conversation that
 * still works. */
export const DEFAULT_LIMIT = 32_000;

export function contextLimitFor(model: string | undefined | null): number {
  return knownLimitFor(model) ?? DEFAULT_LIMIT;
}

/** The table's number for a model, or null when the name says nothing.
 * The default above is a safety margin for the fold, not a fact, so a
 * decision that would act on a guess (compacting a session before a
 * turn) asks this instead. */
export function knownLimitFor(model: string | undefined | null): number | null {
  const name = (model ?? "").trim();
  for (const [pattern, limit] of LIMITS) {
    if (pattern.test(name)) return limit;
  }
  return null;
}

// ── what the engine itself says ────────────────────────────────────────
//
// The table is a guess, and the engines that keep their own session know
// better: Claude Code reports each request's prompt and, in its result,
// the model's window; Codex reports the latest request and the window it
// is using right now (which is not fixed per model); an ACP agent can
// send both as a `usage_update`. Their word wins over the table.
//
// A reading belongs to the engine and model that made it. A conversation
// moved to another engine has not been measured there yet, and showing
// Codex's numbers against Claude's window (or the other way round) is a
// claim nobody made.

/** One engine's latest word on how full a lane's session is. */
export interface Reading {
  /** The size of the latest request, in tokens. */
  used: number;
  /** The window the engine reported, when it did. */
  window: number | null;
  instanceId: string;
  model: string | null;
  at: number;
}

/** The reading, if it was made by the engine and model about to use it. */
export function readingFor(
  reading: Reading | null | undefined,
  selection: { instanceId: string; model?: string | null },
): Reading | null {
  if (!reading || reading.instanceId !== selection.instanceId) return null;
  if ((reading.model ?? null) !== (selection.model ?? null)) return null;
  return reading;
}

/**
 * How full a lane is for the engine and model it is on now.
 *
 * Its own engine's reading first, with the engine's window when it gave
 * one and the table's otherwise. A reading from another engine or model
 * counts as nothing measured. A lane from before readings were kept has
 * only `legacy`, the old per-turn number, and keeps showing it.
 */
export function laneFill(
  reading: Reading | null | undefined,
  legacy: number | undefined,
  selection: { instanceId: string; model?: string | null },
): Pressure & { window: "engine" | "table" } {
  const own = readingFor(reading, selection);
  const table = contextLimitFor(selection.model);
  if (own) {
    const window = own.window && own.window > 0 ? own.window : null;
    return { ...pressure(own.used, window ?? table), window: window ? "engine" : "table" };
  }
  return { ...pressure(reading ? 0 : (legacy ?? 0), table), window: "table" };
}

// ── compacting before a turn ───────────────────────────────────────────
//
// A native session (Claude Code, Codex, an ACP agent) sends its whole
// context again on every request, and a turn with twenty tool calls is
// twenty requests. A session at 170k turns one tool-heavy message into
// three and a half million input tokens, cached or not, and that is what
// emptied a five-hour limit in twenty minutes (GitHub 222, 223). So before
// a turn starts on a session that has grown past the line, the session is
// compacted first, by the engine's own means where it has them.
//
// The line is the lower of a share of the window and a ceiling in tokens.
// The share keeps room for the turn's own growth; the ceiling is there
// because a million-token window is a limit, not a budget, and a request
// of 800k is expensive however well it fits.

/** Past this share of the window, compact before the next turn. */
export const BEFORE_TURN_AT = 0.6;

/** And never let a request start above this many tokens. */
export const BEFORE_TURN_CEILING = 200_000;

export interface TurnStartLane {
  /** The latest request's size, from the engine about to run the turn. */
  used: number;
  /** That engine's window, its own word or the table's; null when
   * neither knows, and then only the ceiling applies. */
  window: number | null;
  /** The share of the window; out of range means the default. */
  at?: number;
  /** In tokens; 0 is off. */
  ceiling: number;
  /** What the lane measured when it was last compacted before a turn,
   * while it has not since come back under the line. */
  lastFrom?: number;
}

/** The line a lane is compacted at, in tokens. */
export function beforeTurnLine(lane: Pick<TurnStartLane, "window" | "at" | "ceiling">): number {
  const at = lane.at !== undefined && lane.at > 0 && lane.at < 1 ? lane.at : BEFORE_TURN_AT;
  const share = lane.window && lane.window > 0 ? Math.floor(lane.window * at) : Infinity;
  return Math.min(lane.ceiling, share);
}

/**
 * Whether to compact a resumed session before this turn.
 *
 * A compaction that did not bring the session under the line (an engine
 * that keeps a lot, or one that ignored the request) is not asked for
 * again on every message: only once the session has grown a tenth past
 * where the last one started.
 */
export function compactBeforeTurn(lane: TurnStartLane): boolean {
  if (!(lane.ceiling > 0) || !(lane.used > 0)) return false;
  if (lane.used <= beforeTurnLine(lane)) return false;
  if (lane.lastFrom !== undefined && lane.used < lane.lastFrom * 1.1) return false;
  return true;
}

// ── handing a conversation to a new session ────────────────────────────
//
// A new engine session on an old conversation (a switch of engine, a
// backup taking over, a session that could not be resumed, a rewind) is
// told the story so far in its first message. Told whole, a long
// conversation was a hundred thousand characters in one message, sent
// again with every tool call of that turn. So the story is bounded: the
// running summary, then the most recent messages whole while they fit,
// and a word about what was left out. Nothing is lost from the thread
// itself, which still has every message.

/** The most a handoff is given, in tokens, however big the window. */
export const HANDOFF_MAX_TOKENS = 16_000;

/** And at most this share of the window it goes to. */
export const HANDOFF_SHARE = 0.15;

export function handoffBudget(window: number | null | undefined): number {
  const share = window && window > 0 ? Math.floor(window * HANDOFF_SHARE) : HANDOFF_MAX_TOKENS;
  return Math.max(2_000, Math.min(HANDOFF_MAX_TOKENS, share));
}

const SUMMARY_MARK = "[Earlier in this conversation, summarised]";

/** A long message cut down to its beginning and its end, which is where
 * a request and its conclusion usually are, saying how much went. */
export function clipText(text: string, max: number): string {
  if (text.length <= max) return text;
  const room = Math.max(40, max - 60);
  const head = Math.ceil(room * 0.6);
  const tail = room - head;
  const gone = text.length - head - tail;
  return `${text.slice(0, head)}\n[... ${gone} characters left out ...]\n${text.slice(text.length - tail)}`;
}

/**
 * The part of a transcript a new session is handed, within `budget`
 * tokens.
 *
 * A summary at the front is kept (clipped to a quarter of the budget),
 * then messages from the end while they fit, each clipped to a quarter of
 * the budget so one pasted log cannot crowd out everything else. The last
 * exchange is always kept, clipped, however tight it is: a story that is
 * only a summary has no thread to pull on. `left` is how many messages
 * between the summary and what was kept are not included.
 */
export function boundHandoff(turns: Turn[], budget: number): { turns: Turn[]; left: number } {
  const chars = Math.max(1, budget) * 4;
  const each = Math.max(400, Math.floor(chars / 4));
  const summary = turns[0]?.text.startsWith(SUMMARY_MARK) ? turns[0] : null;
  const rest = summary ? turns.slice(1) : turns;
  const head: Turn[] = summary ? [{ role: summary.role, text: clipText(summary.text, each) }] : [];
  let used = head.reduce((n, t) => n + t.text.length + 16, 0);
  const kept: Turn[] = [];
  for (let i = rest.length - 1; i >= 0; i--) {
    const turn = { role: rest[i].role, text: clipText(rest[i].text, each) };
    const cost = turn.text.length + 16;
    if (kept.length >= 2 && used + cost > chars) break;
    kept.unshift(turn);
    used += cost;
  }
  return { turns: [...head, ...kept], left: rest.length - kept.length };
}

/**
 * Roughly how many tokens a piece of text is.
 *
 * Four characters to a token is the usual rule of thumb and it is close
 * enough for a decision about when to summarise. A real tokenizer per
 * provider would be more accurate and would have to be right about a
 * dozen of them, and being ten percent out here costs nothing that
 * matters.
 */
export function estimateTokens(text: string): number {
  return Math.ceil((text ?? "").length / 4);
}

export interface Turn {
  role: "user" | "assistant";
  text: string;
}

export function transcriptTokens(turns: Turn[]): number {
  // a few tokens per message for whatever wrapping the provider adds
  return turns.reduce((total, turn) => total + estimateTokens(turn.text) + 4, 0);
}

/** Where the ring gets its number. */
export interface Pressure {
  used: number;
  limit: number;
  /** Zero to one. */
  fraction: number;
}

export function pressure(used: number, limit: number): Pressure {
  const safeLimit = limit > 0 ? limit : DEFAULT_LIMIT;
  const safeUsed = Math.max(0, used);
  return { used: safeUsed, limit: safeLimit, fraction: Math.min(1, safeUsed / safeLimit) };
}

/** Past this share of the window, summarise. A reasonable place to put
 * it: late enough that most conversations never reach it, early enough
 * to leave room for the reply. */
export const COMPACT_AT = 0.8;

export function shouldCompact(used: number, limit: number, at: number = COMPACT_AT): boolean {
  if (used <= 0 || limit <= 0) return false;
  if (at <= 0 || at >= 1) return false;
  return used / limit > at;
}

// ── deciding what to keep ──────────────────────────────────────────────

export interface Plan {
  /** Turns to summarise into the running summary. */
  fold: Turn[];
  /** Turns to send as they are. */
  keep: Turn[];
}

/**
 * Split a conversation into what gets summarised and what is sent whole.
 *
 * The end is what matters most, so the recent turns are kept and the older
 * ones fold. At least one exchange is always kept whole, however tight the
 * budget: a conversation that is nothing but a summary has no thread to
 * pull on.
 */
export function planCompaction(turns: Turn[], budget: number, minKeep = 6): Plan {
  if (turns.length <= minKeep) return { fold: [], keep: turns };

  const keep: Turn[] = [];
  let used = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    const cost = estimateTokens(turns[i].text) + 4;
    // always take the minimum, then take what fits
    if (keep.length >= minKeep && used + cost > budget) break;
    keep.unshift(turns[i]);
    used += cost;
  }
  return { fold: turns.slice(0, turns.length - keep.length), keep };
}

/** What the model is asked, when it is asked to summarise. */
export function summaryPrompt(existing: string | null, fold: Turn[]): string {
  const conversation = fold
    .map((turn) => `${turn.role === "user" ? "Them" : "You"}: ${turn.text}`)
    .join("\n\n")
    .slice(0, 40_000);
  return [
    existing
      ? "Here is a summary of a conversation so far, and the part that came after it. Produce one summary covering both."
      : "Summarise this part of a conversation so it can be carried forward.",
    "",
    ...(existing ? ["Summary so far:", existing, ""] : []),
    "The conversation:",
    conversation,
    "",
    "Keep: decisions made, facts established, anything asked for that is not finished, names, numbers, file paths, and how the person wants to be worked with.",
    "Drop: pleasantries, restatements, and anything already superseded.",
    "Write it as notes to yourself, in the second person about them. Under 400 words. No preamble.",
  ].join("\n");
}

/** The line put in the transcript so a summary is visibly a summary and
 * not something the person said. */
export function summaryTurn(summary: string): Turn {
  return {
    role: "assistant",
    text: `[Earlier in this conversation, summarised]\n${summary}`,
  };
}

/** What people see in the thread when it happens. Compaction is a normal
 * state, so it says what it did rather than apologising. */
export function compactionNotice(folded: number, why: "limit" | "handoff" = "limit"): string {
  const because =
    why === "handoff"
      ? "This conversation went to a new session, which is told a shortened version"
      : "This conversation reached the model's limit";
  return folded === 1
    ? `${because}, so the earliest message was summarised. Everything since is intact, and the summary carries forward what mattered.`
    : `${because}, so the earliest ${folded} messages were summarised. Everything since is intact, and the summary carries forward what mattered.`;
}

/** A token count the way the marker shows it: 320k, 1.2M. */
export function shortTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(Math.max(0, Math.round(n)));
}

/**
 * The marker for an engine compacting its own session, in the place it
 * happened. Short on purpose: it is a fact about the conversation, like
 * a date line, not something to read. Whatever the engine did not report
 * is left out rather than guessed.
 */
export function compactedNotice(c: { before: number | null; after: number | null; idle?: boolean }): string {
  const what = c.idle ? "Compacted while idle" : "Compacted";
  if (c.before !== null && c.after !== null) return `${what} · ${shortTokens(c.before)} → ${shortTokens(c.after)}`;
  if (c.before !== null) return `${what} · from ${shortTokens(c.before)}`;
  if (c.after !== null) return `${what} · now ${shortTokens(c.after)}`;
  return what;
}

// ── compacting before the cache goes cold ──────────────────────────────
//
// A Claude Code session is cached by the provider for an hour after its
// last request. A conversation that goes quiet for longer pays to write
// its whole context to the cache again on the next message, which for a
// long-lived agent is about 170k tokens at twice the input price. Asking
// the session to compact a few minutes before the hour is up reads that
// context while it is still cached, and the next message writes a third
// of it instead (GitHub 162).
//
// The hour is Claude Code's choice, not ours: Bloks sets no cache
// lifetime and signs the CLI in with the person's own account, which
// caches for an hour. With an API key it caches for five minutes, and
// compacting a conversation every time someone pauses for four would
// cost detail for nothing, so a lane is only compacted when its last
// cache write says it was an hour (`cacheTtl` on the usage event).

/** How long the provider keeps the prompt cached after a request. */
export const CACHE_LIFETIME_MS = 60 * 60_000;

/** Below this a conversation is cheap to write again anyway. Replaying a
 * month of agents showed the saving flat from 60k to 150k. */
export const IDLE_COMPACT_MIN_TOKENS = 100_000;

export interface IdleLane {
  /** The idle compaction setting. */
  enabled: boolean;
  now: number;
  /** When the lane's session last made a request, if known. */
  lastRequestAt: number | null;
  /** How big that request's prompt was. */
  context: number;
  /** The cache lifetime that request wrote with, if it said. */
  cacheTtl?: "5m" | "1h";
  /** A turn running, or starting. */
  busy: boolean;
  /** Messages waiting for the lane, or an editor holding them. */
  queued: boolean;
  /** A question or approval card still open. */
  waiting: boolean;
  /** Archived, held, or otherwise not to be woken. */
  paused: boolean;
  /** The cache lifetime; tests shorten it. */
  lifetime?: number;
}

/**
 * Whether to compact a quiet lane now.
 *
 * The window opens five minutes before the cache expires and closes two
 * and a half minutes before. A compaction takes about a minute, and the
 * request that reads the context has to reach the provider before the
 * hour is up; one that starts late pays the full rewrite and the summary
 * both, which is worse than leaving it alone. So a lane whose window has
 * passed (the computer slept, too many lanes went quiet at once) is
 * skipped, not caught up.
 */
export function idleCompactionDue(lane: IdleLane): boolean {
  if (!lane.enabled || lane.lastRequestAt === null) return false;
  if (lane.cacheTtl !== "1h") return false;
  if (lane.context < IDLE_COMPACT_MIN_TOKENS) return false;
  if (lane.busy || lane.queued || lane.waiting || lane.paused) return false;
  const lifetime = lane.lifetime ?? CACHE_LIFETIME_MS;
  const idle = lane.now - lane.lastRequestAt;
  return idle >= lifetime * (55 / 60) && idle < lifetime * (57.5 / 60);
}

// ── paying the same bill in instalments ────────────────────────────────
//
// The fold above is one large call: when a lane crosses the threshold it
// summarises everything older than the budget at once. That is correct and
// it is also a stall, and occupancy sawtooths up to the threshold and back
// forever.
//
// The alternative is to absorb one message per turn into the same running
// summary, so the per-pass cost is bounded however long the conversation
// runs and the window settles rather than climbing. Two rules make it
// worth having rather than merely different.
//
//   User messages are never summarised. What a person asked for is the
//   source intent; what an agent replied is mostly an account of what it
//   did, and an account survives summarising in a way an instruction does
//   not. So the cursor moves past them and they are sent verbatim for the
//   whole conversation.
//
//   The summary itself gets re-summarised once it grows baggy, or it
//   accumulates scaffolding until the summary is the problem it was
//   supposed to solve.
//
// It is off by default, and the reason is the honest one: absorbing after
// every turn rewrites history every turn, which breaks the provider's
// prompt cache prefix every turn where a threshold fold breaks it once. On
// a provider with deep cache discounts that can cost more than the stall
// it removes.

/** Recent messages never absorbed, so the end of the conversation is
 * always whole. */
export const MICRO_TAIL = 8;

/** Past this many tokens the running summary is re-summarised. */
export const DEFRAG_AT = 2_000;

export interface MicroPlan {
  /** The message to summarise into the running summary, or null when
   * there is nothing to absorb this turn. */
  absorb: Turn | null;
  /** Where the cursor lands. Equal to the old one when nothing moves. */
  through: number;
  /** True when the cursor moved past something carried verbatim rather
   * than summarised. */
  verbatim: boolean;
}

/**
 * The one message to absorb next, if any.
 *
 * Deliberately one at a time. Absorbing a batch would be the threshold
 * fold again under another name, and the whole point is that the cost of a
 * pass does not grow with the conversation.
 */
export function planMicro(turns: Turn[], through: number, tail: number = MICRO_TAIL): MicroPlan {
  const at = Math.max(0, Math.min(through, turns.length));
  const nothing: MicroPlan = { absorb: null, through: at, verbatim: false };
  // the tail is protected, and so is anything that would leave nothing
  if (turns.length - at <= Math.max(1, tail)) return nothing;

  const next = turns[at];
  if (!next) return nothing;
  // A user message is stepped over rather than absorbed: the cursor has
  // to pass it to reach what follows, and the caller sends it whole.
  if (next.role === "user") return { absorb: null, through: at + 1, verbatim: true };
  if (!next.text.trim()) return { absorb: null, through: at + 1, verbatim: true };
  return { absorb: next, through: at + 1, verbatim: false };
}

/**
 * What still gets sent whole from the part the summary covers.
 *
 * Everything the person said between where micro-compaction took over and
 * where its cursor has reached. Their relative order is unchanged and all
 * of it precedes the unabsorbed part, so putting the summary first and
 * these after it is the original conversation with the agent's own older
 * replies lifted out.
 */
export function carriedVerbatim(turns: Turn[], from: number, through: number): Turn[] {
  const start = Math.max(0, Math.min(from, turns.length));
  const end = Math.max(start, Math.min(through, turns.length));
  return turns.slice(start, end).filter((t) => t.role === "user");
}

export function needsDefrag(summary: string, at: number = DEFRAG_AT): boolean {
  return estimateTokens(summary ?? "") > Math.max(1, at);
}

/** What the model is asked when the summary itself has grown baggy. */
export function defragPrompt(summary: string): string {
  return [
    "This is a running summary of a conversation, written in pieces over time.",
    "Rewrite it as one summary, keeping every fact and dropping the repetition and the scaffolding.",
    "",
    summary,
    "",
    "Keep: decisions made, facts established, anything asked for that is not finished, names, numbers, file paths, and how the person wants to be worked with.",
    "Write it as notes to yourself, in the second person about them. Under 400 words. No preamble.",
  ].join("\n");
}

/** What the model is asked when absorbing one message into the summary. */
export function absorbPrompt(existing: string | null, one: Turn): string {
  return [
    existing
      ? "Here is a running summary of a conversation, and one more thing that was said after it. Fold the new part into the summary and return the whole thing."
      : "Summarise this so it can be carried forward as the beginning of a running summary.",
    "",
    ...(existing ? ["Summary so far:", existing, ""] : []),
    "Newly said:",
    `${one.role === "user" ? "Them" : "You"}: ${one.text.slice(0, 20_000)}`,
    "",
    "Keep: decisions made, facts established, anything asked for that is not finished, names, numbers, file paths, and how the person wants to be worked with.",
    "Drop: pleasantries, restatements, and anything already superseded.",
    "Write it as notes to yourself, in the second person about them. Under 400 words. No preamble.",
  ].join("\n");
}

/** What a lane's summary covers, as the transcript builder needs it. */
export interface Covered {
  summary: string;
  /** How many of the lane's settled messages the summary accounts for. */
  through: number;
  /** Where micro-compaction took over, when it has. */
  microFrom?: number;
}

/**
 * The conversation as the model will be given it.
 *
 * Three pieces in order: the summary of what came before, then whatever
 * the person said inside the part micro-compaction has absorbed, then the
 * recent messages sent whole. That order is the original conversation with
 * the agent's older replies lifted out, which is the whole trick.
 *
 * The last message is left off because the driver is given it separately,
 * as the thing this turn is answering.
 */
export function assembleTranscript(
  all: Turn[],
  covered: Covered | null,
  budget: number,
): { turns: Turn[]; dropped: number } {
  const after = covered ? all.slice(covered.through) : all;
  const plan = planCompaction(after.slice(0, -1), budget);
  const spoken =
    covered && covered.microFrom !== undefined
      ? carriedVerbatim(all, covered.microFrom, covered.through)
      : [];
  return {
    turns: [...(covered ? [summaryTurn(covered.summary)] : []), ...spoken, ...plan.keep],
    dropped: plan.fold.length,
  };
}

// ── recovering when the guess was wrong ────────────────────────────────

const TOO_LONG = [
  /context[_ ]length/i,
  /maximum context/i,
  /context window/i,
  /too many tokens/i,
  /prompt is too long/i,
  /reduce the length/i,
  /input length and `max_tokens`/i,
  /exceeds the (model|maximum)/i,
  /string too long/i,
];

/**
 * Is this failure the conversation being too big.
 *
 * Providers all word it differently and none of them use a code we could
 * key on, so this is a list of the ways they say it. A miss here is not a
 * disaster: it means one turn fails visibly, which is what happened
 * before this existed.
 */
export function isContextError(message: string | null | undefined): boolean {
  const text = message ?? "";
  return TOO_LONG.some((pattern) => pattern.test(text));
}
