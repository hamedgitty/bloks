// Who said a message, where it matters that it was the person.
//
// A message the person typed carries nothing that says so: no author (the
// owner), no `agent` note, no `via`. Everything else marks itself, and
// "none of those marks" was read as "the person's own words" in a dozen
// places: whether a waiting burst is the owner's turn, whether it starts
// a chain of agents' messages over, which waiting words count as theirs,
// what they may edit or redo. One kind of message slipped through that:
// words an agent started with no other agent as sender, its own to itself
// or a job it posted, which are server marked `selfSent` (store.ts). These
// are the checks for it, in one place, so a new mark is added once.
import type { Message } from "./store.ts";

type Marks = Pick<Message, "agent" | "selfSent">;

/** An agent wrote it: another agent (`agent`), or one with no other agent
 * as sender (`selfSent`). Never the person's words, however they read. */
export function agentWrote(m: Marks | undefined): boolean {
  return Boolean(m && (m.agent || m.selfSent));
}

/** The person's own words as they wrote them here: a user message no
 * agent, routine, watcher, webhook, bridge or Telegram person, delegate
 * or group wrote. */
export function personsWords(m: Message | undefined): boolean {
  return Boolean(m && m.role === "user" && !agentWrote(m) && !m.via && !m.telegramPerson && !m.telegramDelegate && !m.telegramGroup && !m.telegramSent);
}

/** Whether waiting words start a chain of agents' messages over: only the
 * person writing does, never an agent's words or a machine's. */
export function startsChainOver(m: Message | undefined): boolean {
  return Boolean(m && !agentWrote(m) && !m.via);
}
