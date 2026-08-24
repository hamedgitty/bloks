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
  [/^claude/i, 200_000],
  [/^gemini/i, 1_000_000],
  [/^grok/i, 131_072],
  [/^(gpt-4o|gpt-4\.1|o[134])/i, 128_000],
  [/^gpt-5/i, 400_000],
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
  const name = (model ?? "").trim();
  for (const [pattern, limit] of LIMITS) {
    if (pattern.test(name)) return limit;
  }
  return DEFAULT_LIMIT;
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
export function compactionNotice(folded: number): string {
  return folded === 1
    ? "This conversation reached the model's limit, so the earliest message was summarised. Everything since is intact, and the summary carries forward what mattered."
    : `This conversation reached the model's limit, so the earliest ${folded} messages were summarised. Everything since is intact, and the summary carries forward what mattered.`;
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
