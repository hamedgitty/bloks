import { dismissedPreparation } from "./preparation-state.ts";
// Redo: editing a message the agent already read, and having it start
// again from the new words (GitHub 258).
//
// Saving an edit only rewrites the stored text. The agent read the old
// words and carries on with them, and the transcript then shows a request
// it never got. Redo is the edit that reaches the agent: stop it if it is
// working, rewind to before the message, send the new words. It adds no
// undo of its own. What comes back is what a rewind brings back, by the
// same rules.
//
// Where it rewinds to is the one thing a rewind does not already know.
// Files are undone a turn at a time: a checkpoint covers a whole turn and
// is dated when the turn ends, so rewinding to a message said into the
// middle of a turn puts back the files changed before it too, while what
// the agent said before it would stay and describe work that is gone. So
// a Redo goes back to the start of the turn the message was part of, and
// the person's messages from that turn go again, in order, with the
// change.
//
// The orchestration is in server/index.ts, beside the rewind and the send
// it is made of. What is here is pure: which turn a message belongs to,
// whether it can be redone from the person's box, and what a redo takes
// back, read from what the transcript has stored and nothing else.
import type { Message } from "./store.ts";

/** Why a message cannot be redone:
 *   "waiting"      it has not gone to the agent yet, so there is nothing
 *                  to take back; it is edited where it waits (GitHub 155)
 *   "not-yours"    it is not the person's own words, typed here: an
 *                  agent's, a routine's, a watcher's, mail, a chat app
 *   "others-turn"  it joined a turn somebody else started, and their
 *                  request cannot be sent again from the person's box */
export type RedoRefusal = "waiting" | "not-yours" | "others-turn";

export interface RedoPlan {
  /** Where the rewind starts: the first message of the turn. */
  start: number;
  /** The person's messages from that turn, in the order they were said.
   * These go again, the edited one with its new words. */
  resend: Message[];
}

/** The person's own words, typed in this conversation. A message another
 * agent sent carries who; one from a routine, a watcher, mail or a
 * webhook says so in `via`; one the person said from Telegram is marked
 * as that, and one that waited for a turn there keeps the chat it
 * answers. */
function own(m: Message): boolean {
  return m.role === "user" && m.kind === "text" && !m.agent && !m.via && !m.fromTelegram && !m.telegramReply;
}

/** Something said to the agent that is part of the conversation: not
 * still waiting above the composer, and not already rewound. One taken
 * back counts, since the turn it started is still there. */
function said(m: Message): boolean {
  return m.role === "user" && m.kind === "text" && !m.queued && !m.unsent && !dismissedPreparation(m) && !m.rewound;
}

/**
 * The turn a message is part of, and what a Redo of it would send again;
 * a refusal when it cannot be redone; null when there is no such message
 * of the person's to redo.
 *
 * A turn starts with a message, or with a burst that waited and went
 * together (one `deliveredAt`), and takes in every message after that
 * which joined it while it ran (`midTurn`), up to the next message that
 * started a turn of its own. A turn Bloks started by itself to go on
 * with the one before (a saved key, a backup engine, a pickup after a
 * restart) has no message of its own, so it reads as part of that one,
 * which is what it was.
 */
export function redoPlan(messages: readonly Message[], messageId: string): RedoPlan | RedoRefusal | null {
  const at = messages.findIndex((m) => m.id === messageId);
  const target = messages[at];
  if (!target || target.role !== "user" || target.kind !== "text" || target.deleted || !target.text) return null;
  if (target.queued || target.unsent || dismissedPreparation(target)) return "waiting";
  if (!own(target)) return "not-yours";

  // back to the message that started the turn this one joined
  let start = at;
  if (target.midTurn) {
    for (let i = at - 1; i >= 0; i--) {
      // an earlier rewind ends everything before it
      if (messages[i].rewound) break;
      if (!said(messages[i])) continue;
      start = i;
      if (!messages[i].midTurn) break;
    }
  }
  // and to the first of a burst that started it together
  const burst = messages[start].midTurn ? undefined : messages[start].deliveredAt;
  if (burst !== undefined) {
    for (let i = start - 1; i >= 0; i--) {
      if (!said(messages[i])) continue;
      if (messages[i].midTurn || messages[i].deliveredAt !== burst) break;
      start = i;
    }
  }

  const resend: Message[] = [];
  for (let i = start; i < messages.length; i++) {
    const m = messages[i];
    if (!said(m)) continue;
    const opened = i === start || (!m.midTurn && burst !== undefined && m.deliveredAt === burst);
    // the next turn's own start
    if (!opened && !m.midTurn) break;
    if (opened && !own(m)) return "others-turn";
    if (own(m) && !m.deleted && m.text) resend.push(m);
  }
  return { start, resend };
}

/** What rewinding to `from` takes back: every message from there on that
 * is still standing. A Redo leaves what is waiting above the composer
 * where it is (`keepWaiting`): the agent never read it, so there is
 * nothing of it to take back, and it goes after the redone turn as it
 * would have gone after the old one. */
export function takenBack(messages: readonly Message[], from: number, keepWaiting = false): Message[] {
  return messages.slice(from).filter((m) => !m.deleted && !(keepWaiting && (m.queued || m.unsent || dismissedPreparation(m))));
}

/** What a redo would take back, as the line under the editor counts it. */
export interface RedoCounts {
  /** Messages, counted the way the chat counts a rewind: what was said,
   * not the tool rows, cards and notes around it. */
  messages: number;
  /** The turns taken back sent something that stays sent. Read from the
   * record each agent's message leaves in the sender's conversation;
   * what a turn did outside the folder some other way leaves none. */
  sent: boolean;
}

export function redoCounts(taken: readonly Message[]): RedoCounts {
  const words = taken.filter((m) => m.kind === "text" && m.text).length;
  return {
    messages: words || taken.length,
    sent: taken.some((m) => m.agent?.dir === "out" && m.agent.status !== "failed"),
  };
}
