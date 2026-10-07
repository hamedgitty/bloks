// What part of a Claude Code persona may move between turns (GitHub 193).
//
// The system prompt sits in front of the whole conversation in the
// prompt cache, so one changed character in it makes the next request
// write the entire session to the cache again: hundreds of thousands of
// tokens after a pause of a few minutes. An agent's MEMORY.md and the
// notes about the person change far more often than anything else in
// it, the first whenever the agent curates its memory and the second for
// every agent at once when a note is kept.
//
// So a resumed session keeps the copy of those two its session started
// with, and a change since the agent last heard is said in the turn's
// own message, which comes after the cached history and costs only
// itself. A fresh session has no cache to keep, and gets the current
// text in its system prompt as before.

/** The parts of a persona that change between turns. Null is a part
 * this turn does not carry at all (a shared room, no notes yet). */
export interface Standing {
  memory: string | null;
  notes: string | null;
}

/** What one lane's session has been given. */
export interface StandingRecord {
  /** The engine instance the session belongs to. */
  instanceId: string;
  /** The copy in the session's system prompt, unchanged while it resumes. */
  frozen: Standing;
  /** The newest copy the session has been told, there or in a message. */
  told: Standing;
  /** The last room message this session has been shown, by room. */
  roomSeen: Record<string, string>;
}

/**
 * What goes in this turn's system prompt, what (if anything) goes in
 * front of its message, and what to remember once it is sent.
 *
 * A turn without a cursor, on another engine, or with no record (Bloks
 * restarted) starts the record from the current text: nothing cached is
 * known to match, so there is nothing to keep stable.
 */
export function standingFor(
  previous: StandingRecord | undefined,
  current: Standing,
  turn: { instanceId: string; resuming: boolean },
): { system: Standing; preamble: string | null; next: StandingRecord } {
  if (!turn.resuming || !previous || previous.instanceId !== turn.instanceId) {
    return {
      system: current,
      preamble: null,
      next: { instanceId: turn.instanceId, frozen: current, told: current, roomSeen: {} },
    };
  }
  const changed: string[] = [];
  if (current.memory !== previous.told.memory && current.memory !== null) {
    changed.push(
      `Since your last turn, your memory changed. This replaces the copy in your instructions:\n\n${current.memory}`,
    );
  }
  if (current.notes !== previous.told.notes) {
    changed.push(
      current.notes
        ? `Since your last turn, the notes about the person you work for changed. This replaces the list in your instructions:\n\n${current.notes}`
        : "Since your last turn, the notes about the person you work for were all removed. Disregard the list in your instructions.",
    );
  }
  return {
    system: previous.frozen,
    preamble: changed.length ? changed.map((part) => `(${part})`).join("\n\n") : null,
    next: { ...previous, told: current },
  };
}
