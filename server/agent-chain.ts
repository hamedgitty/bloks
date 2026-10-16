import { MAX_CHAIN_NAME_CHARS, MAX_CHAIN_EXCERPT_CHARS } from "./limits.ts";

/** Workspace limit for turns agents start through one another, by
 * default. The whole chain is counted, not each pair in it: that is what
 * makes the limit a bound on cost (GitHub 248). Mirrored for the desktop
 * in src/lib/turn-limit.ts. */
export const MAX_AGENT_CHAIN = 12;
/** The bounds a person may set it within. There is no Off: without a
 * bound, two agents can keep each other going until the usage runs out. */
export const MIN_AGENT_CHAIN_LIMIT = 1;
export const MAX_AGENT_CHAIN_LIMIT = 50;
export const CHAIN_LIMIT_TITLE = "Agents stopped at the limit";

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
  return `${what.replace(/\.$/, "")}: agents reached the limit of ${limit} consecutive turn${limit === 1 ? "" : "s"}. This limit helps prevent repeated messages from using up your plan. Change it in Settings > General > Working with agents.${excerpt ? ` Excerpt: "${excerpt}"` : ""}`;
}

/** The agent wraps up without assuming the person must continue the task. */
export function chainAgentRefusal(recipient: string, limit: number): string {
  return `${recipient} did not get this message: agents reached the limit of ${limit} consecutive turn${limit === 1 ? "" : "s"}. Finish this turn and report any unfinished work.`;
}
