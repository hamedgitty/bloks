/**
 * How far agents may pass a room along between themselves, and what the
 * room says when a mention goes no further.
 *
 * A mention that was held used to be stored, answered 201 and dropped
 * without a word, so it read as delivered and the named agent as choosing
 * not to answer (GitHub 268). A held mention now leaves a notice, worded
 * here so the two bounds that can hold one say it the same way.
 */

/**
 * How many agent-triggered turns may follow one human message. Without a
 * ceiling two agents that keep naming each other would talk forever, on
 * the user's tokens and without their attention.
 */
export const MAX_AGENT_HOPS = 3;

import { chainLimitText, chainName, pastAgentLimit } from "./agent-chain.ts";

/** The room's notice for a mention held at MAX_AGENT_HOPS. */
export function hopsNotice(from: string, named: readonly string[]): string {
  return `${from} named ${named.join(", ")} after agents had already passed the room along ${MAX_AGENT_HOPS} times in a row without you, so nobody was woken. Post in the room to carry on.`;
}

/**
 * The room's notice for a mention that wakes nobody, or null for one that
 * goes through. `hops` and `chain` are the places the turn it would start
 * would take: one more than the speaking turn's own. The room's bound is
 * asked first, and one notice covers a mention both would hold: the
 * person's next post in the room starts both over.
 */
export function heldMention(
  from: string,
  named: readonly string[],
  at: { hops: number; chain: number },
  maxChain: number,
  excerpt?: string,
): string | null {
  if (at.hops > MAX_AGENT_HOPS) return hopsNotice(from, named);
  if (pastAgentLimit(at.chain, maxChain)) {
    return chainLimitText(`A mention from ${chainName(from)} to ${named.map(chainName).join(", ")} in this room woke nobody.`, maxChain, excerpt);
  }
  return null;
}
