import { MAX_CHAIN_NAME_CHARS, MAX_CHAIN_EXCERPT_CHARS } from "./limits.ts";

/** Workspace limit for turns agents start through one another, by
 * default. The whole chain is counted, not each pair in it: that is what
 * makes the limit a bound on cost (GitHub 248). A person who allows a
 * budget across separate tasks moves the whole chain's bound to it, and
 * the limit then counts each named task's run (chainPast). Mirrored for
 * the desktop in src/lib/turn-limit.ts. */
export const MAX_AGENT_CHAIN = 12;
/** The bounds a person may set it within. There is no Off: without a
 * bound, two agents can keep each other going until the usage runs out. */
export const MIN_AGENT_CHAIN_LIMIT = 1;
export const MAX_AGENT_CHAIN_LIMIT = 50;
export const CHAIN_LIMIT_TITLE = "Agents stopped at the limit";

/** The most turns in a row the person may allow across separate tasks
 * (agents.taskBudget, GitHub 326). Off unless they set it: then the
 * whole chain counts against the limit, as it always has. Mirrored for
 * the desktop in src/lib/turn-limit.ts. */
export const MIN_TASK_BUDGET = 2;
export const MAX_TASK_BUDGET = 100;
/** The longest name an agent may give the task a message hands off. */
export const MAX_TASK_NAME_CHARS = 60;

/**
 * A separate task an agent named for a handoff (`bloks say --task`), and
 * the place in the chain its handoffs started after.
 *
 * `from` is always the sending turn's own place, read by the server; the
 * agent only gives the name. So naming a new task starts that task's own
 * count, and never the chain's: the person's budget still counts every
 * turn since they last spoke.
 */
export interface ChainTask {
  name: string;
  from: number;
}

/** Which bound holds a message: the limit on the whole chain, the limit
 * on one named task's run within it, or the person's budget across
 * separate tasks. */
export type ChainBound = "limit" | "task" | "budget";

/** Whether a value is one the settings API accepts. */
export function validTurnLimit(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= MIN_AGENT_CHAIN_LIMIT && value <= MAX_AGENT_CHAIN_LIMIT;
}

/** The limit a stored value means. Hand-edited or older config never
 * switches the guard off: anything malformed is the default, and a number
 * past the bound is the bound. */
export function agentTurnLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < MIN_AGENT_CHAIN_LIMIT) return MAX_AGENT_CHAIN;
  return Math.min(value, MAX_AGENT_CHAIN_LIMIT);
}

export function pastAgentLimit(depth: number, limit: number): boolean {
  return depth > limit;
}

/** Whether a value is one the settings API accepts for the budget: a
 * whole number in its bounds, or null for off. */
export function validTaskBudget(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isSafeInteger(value) && value >= MIN_TASK_BUDGET && value <= MAX_TASK_BUDGET);
}

/** The budget a stored value means, or null for none. Anything malformed
 * is none, which is the stricter reading: the whole chain counts. A
 * number past the bound is the bound. */
export function agentTaskBudget(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < MIN_TASK_BUDGET) return null;
  return Math.min(value, MAX_TASK_BUDGET);
}

/** A task name as an agent gave it, with its spacing tidied, or why not. */
export function taskName(value: unknown): { name?: string; error?: string } {
  if (value === undefined || value === null) return {};
  const name = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (!name || name.length > MAX_TASK_NAME_CHARS) {
    return { error: `task is the name of the task this message hands off, from 1 to ${MAX_TASK_NAME_CHARS} characters` };
  }
  return { name };
}

/** The task a message from a turn carries: the one it names, counted from
 * the sending turn's place when that is not the turn's own task; else the
 * turn's own, if it has one. */
export function taskFor(turn: ChainTask | undefined, named: string | undefined, place: number): ChainTask | undefined {
  if (!named) return turn;
  if (turn?.name === named) return turn;
  return { name: named, from: place };
}

/**
 * Which bound a turn at `depth` in the chain would pass, or null when it
 * may start.
 *
 * Without a budget, or with one no higher than the limit, the whole chain
 * counts against the limit, as it always has. With one, a turn on a named
 * task counts its task's own run against the limit and the whole chain
 * against the budget; a turn on no named task still counts the whole
 * chain against the limit. Naming tasks can only move the first of those,
 * so a loop of any number of agents stops at the budget whatever it calls
 * its work.
 */
export function chainPast(depth: number, task: ChainTask | undefined, limit: number, budget: number | null): ChainBound | null {
  if (budget === null || budget <= limit) return depth > limit ? "limit" : null;
  if (depth > budget) return "budget";
  if (!task) return depth > limit ? "limit" : null;
  return depth - task.from > limit ? "task" : null;
}

/** Keep both names in the first clause, including the phone's short preview. */
export function chainName(name: string): string {
  return name.replace(/\s+/g, " ").trim().slice(0, MAX_CHAIN_NAME_CHARS);
}

/** Redact before shortening: a cut key must not escape its recognisable shape. */
export function chainExcerpt(words: string, redact: (text: string) => string): string {
  return redact(words).replace(/\s+/g, " ").trim().slice(0, MAX_CHAIN_EXCERPT_CHARS);
}

/** The person's notice names only the undelivered item or skipped run.
 * Reset mechanics do not establish that the task needs their attention. */
export function chainLimitText(what: string, limit: number, excerpt?: string): string {
  return heldText(what, `agents reached the limit of ${turns(limit)}`, excerpt);
}

/** What held a message, as chainPast found it, and the numbers it held at. */
export interface ChainHold {
  bound: ChainBound;
  limit: number;
  budget: number | null;
  /** The task's name, for a hold on one task's run. */
  task?: string;
}

/** The person's notice for any of the three bounds. The budget is the
 * person's own, so the notice says it is theirs and how much it was. */
export function chainHoldText(what: string, hold: ChainHold, excerpt?: string): string {
  if (hold.bound === "task" && hold.task) {
    return heldText(what, `agents reached the limit of ${turns(hold.limit)} on the task "${hold.task}"`, excerpt);
  }
  if (hold.bound === "budget" && hold.budget !== null) {
    return heldText(what, `agents used all ${hold.budget} turns in a row you allowed across separate tasks`, excerpt);
  }
  return chainLimitText(what, hold.limit, excerpt);
}

function turns(n: number): string {
  return `${n} consecutive turn${n === 1 ? "" : "s"}`;
}

function heldText(what: string, reached: string, excerpt?: string): string {
  return `${what.replace(/\.$/, "")}: ${reached}. This limit helps prevent repeated messages from using up your plan. Change it in Settings > Behaviour.${excerpt ? ` Excerpt: "${excerpt}"` : ""}`;
}

/** The agent wraps up without assuming the person must continue the task.
 * A hold on one task's run reads as the limit it is, so it is not taken
 * as a hint to call the same work by another name. */
export function chainAgentRefusal(recipient: string, limit: number, budget?: number, kept = false): string {
  const reached = budget === undefined ? `the limit of ${turns(limit)}` : `the budget of ${budget} turns in a row for separate tasks`;
  // kept: it goes in with the recipient's next turn, which it never starts
  const later = kept ? ` It is kept for ${recipient}'s next turn, whenever something else starts one; it does not start one.` : "";
  return `${recipient} did not get this message: agents reached ${reached}. Finish this turn and report any unfinished work.${later}`;
}

/** The most of one held message an agent is given later (heldSaysText);
 * past it, the start, and how much was left out. */
export const MAX_HELD_SAY_CHARS = 4_000;
/** The most held messages one hold notice keeps: a loop held at the
 * limit cannot grow a conversation without bound. The newest are kept. */
export const MAX_HELD_SAYS = 20;

/**
 * A message held at the chain limit, kept on the hold notice in the
 * recipient's conversation (GitHub 376). It is never delivered as a
 * message and never starts a turn: it goes in with the recipient's next
 * turn that starts for any other reason, once, at that turn's own place
 * in the chain, so it cannot carry a chain past the limit.
 */
export interface HeldSay {
  /** The sending agent's id and name. */
  from: string;
  name: string;
  at: number;
  /** The words, cut at MAX_HELD_SAY_CHARS. */
  text: string;
  /** How many characters were cut, if any. */
  cut?: number;
  /** When a turn of the recipient's took it. */
  delivered?: number;
}

export function heldSay(from: { botId: string; name: string }, words: string, at: number): HeldSay {
  const cut = Math.max(0, words.length - MAX_HELD_SAY_CHARS);
  return { from: from.botId, name: chainName(from.name), at, text: cut ? words.slice(0, MAX_HELD_SAY_CHARS) : words, ...(cut ? { cut } : {}) };
}

/** A notice's held messages with one more, the newest MAX_HELD_SAYS kept. */
export function withHeldSay(held: readonly HeldSay[] | undefined, say: HeldSay): HeldSay[] {
  return [...(held ?? []), say].slice(-MAX_HELD_SAYS);
}

/** What a turn opens with for messages held from it: who sent each, when,
 * and the words. Said as a record, not a request: nothing here started
 * the turn, and the agent decides whether any of it needs doing now. */
export function heldSaysText(says: readonly HeldSay[], time: (at: number) => string): string {
  const one = says.length === 1;
  const head = one
    ? "(A message to you was held at the limit of consecutive agent turns and not delivered then. It is here so you know of it; it did not start this turn.)"
    : `(${says.length} messages to you were held at the limit of consecutive agent turns and not delivered then. They are here so you know of them; they did not start this turn.)`;
  const items = says.map((s) => {
    const cut = s.cut ? `\n[${s.cut} more characters were left out]` : "";
    return `From ${s.name} at ${time(s.at)}:\n${s.text}${cut}`;
  });
  return [head, ...items].join("\n\n");
}
