import { MAX_CHAIN_NAME_CHARS, MAX_CHAIN_EXCERPT_CHARS } from "./limits.ts";

/** Workspace limit for turns agents start through one another. */
export const MAX_AGENT_CHAIN = 12;
export const CHAIN_LIMIT_TITLE = "Agents stopped at the limit";

/** Hand-edited or older config must never silently switch the guard off. */
export function agentTurnLimit(value: unknown): number | null {
  return value === null ? null : typeof value === "number" && Number.isSafeInteger(value) && value >= 1 ? value : MAX_AGENT_CHAIN;
}

export function pastAgentLimit(depth: number, limit: number | null): boolean {
  return limit !== null && depth > limit;
}

/** Keep both names in the first clause, including the phone's short preview. */
export function chainName(name: string): string {
  return name.replace(/\s+/g, " ").trim().slice(0, MAX_CHAIN_NAME_CHARS);
}

/** Redact before shortening: a cut key must not escape its recognisable shape. */
export function chainExcerpt(words: string, redact: (text: string) => string): string {
  return redact(words).replace(/\s+/g, " ").trim().slice(0, MAX_CHAIN_EXCERPT_CHARS);
}

/** Shared by the refusal, its notice and scheduled-work records. */
export function chainLimitText(what: string, depth: number, limit: number, excerpt?: string): string {
  return `${what} Nothing is held for delivery. Agents had started ${depth - 1} turns in a row; this turn would exceed the workspace limit of ${limit}. Each turn uses your plan. The limit stops agents keeping each other going until the plan's usage limit is spent. Your message in that conversation starts the count over, as does an independent routine, watcher or webhook turn. Raise or switch off Agents' turn limit in Settings > General > Working with agents.${excerpt ? ` Excerpt: "${excerpt}"` : ""}`;
}
