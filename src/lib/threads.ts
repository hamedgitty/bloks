// Two lenses on one transcript.
//
// A room is a single list of messages in the order they were said, which
// is right while two people are talking and wrong the moment four are. A
// reply to something from ten minutes ago lands at the bottom, next to
// three unrelated things, and the reader has to reassemble the
// conversation from the shape of the sentences.
//
// The messages already know what they answer: a reply carries the id of
// the message it replies to. That is enough to read the same transcript a
// second way, as topics with their replies gathered under them, without
// storing anything new or changing what is sent.
//
// Two decisions worth stating, both taken from how this settles elsewhere:
//
//   A thread is keyed by its root, not by its parent. A reply to a reply
//   belongs to the same conversation as the reply it answers, so it joins
//   that thread rather than starting one inside it. Arbitrary nesting is
//   easy to build and hard to read.
//
//   Nothing is hidden in either lens. The stream still shows every
//   message in the order it happened; the forum shows the same messages
//   grouped. A lens that omits something is a lens people learn not to
//   trust.
import type { Message } from "@/state/reducer";

export interface Thread {
  /** The message the conversation hangs off. */
  root: Message;
  /** Everything answering it, or answering an answer, oldest first. */
  replies: Message[];
  /** When the thread was last touched, root included. */
  lastAt: number;
  /** Everyone who has said something in it, in the order they arrived. */
  participants: string[];
}

/** Who a message is from, as a name a person would recognise. */
export type NameOf = (message: Message) => string;

const AT = (message: Message): number => (typeof message.at === "number" ? message.at : 0);

/**
 * Which conversation each message belongs to.
 *
 * Follows the chain of replies up to whatever started it. Written
 * iteratively with a seen set rather than recursively, because a message
 * that somehow answers itself, or a pair that answer each other, would
 * otherwise be a stack overflow rather than a shrug.
 */
export function rootIds(messages: Message[]): Map<string, string> {
  const byId = new Map(messages.map((message) => [message.id, message]));
  const roots = new Map<string, string>();

  for (const message of messages) {
    let current = message;
    const seen = new Set<string>([current.id]);
    for (;;) {
      const parentId = current.replyTo?.id;
      if (!parentId) break;
      // an answer to something no longer here is its own beginning: the
      // alternative is a thread with no root, which cannot be drawn
      const parent = byId.get(parentId);
      if (!parent || seen.has(parent.id)) break;
      seen.add(parent.id);
      current = parent;
      const known = roots.get(current.id);
      if (known) {
        current = byId.get(known) ?? current;
        break;
      }
    }
    roots.set(message.id, current.id);
  }
  return roots;
}

/**
 * The transcript as topics.
 *
 * Ordered by when each was last touched, so a conversation somebody
 * returned to comes back up rather than staying where it started. That is
 * the whole reason to have this lens: the stream already orders by when
 * things were said.
 */
export function threadsFrom(messages: Message[], nameOf: NameOf): Thread[] {
  const readable = messages.filter((m) => !m.deleted);
  const roots = rootIds(readable);
  const byId = new Map(readable.map((m) => [m.id, m]));

  const threads = new Map<string, Thread>();
  for (const message of readable) {
    const rootId = roots.get(message.id) ?? message.id;
    const root = byId.get(rootId);
    if (!root) continue;
    let thread = threads.get(rootId);
    if (!thread) {
      thread = { root, replies: [], lastAt: AT(root), participants: [] };
      threads.set(rootId, thread);
    }
    if (message.id !== rootId) thread.replies.push(message);
    thread.lastAt = Math.max(thread.lastAt, AT(message));
    const who = nameOf(message);
    if (who && !thread.participants.includes(who)) thread.participants.push(who);
  }

  for (const thread of threads.values()) {
    thread.replies.sort((a, b) => AT(a) - AT(b));
  }
  return [...threads.values()].sort((a, b) => b.lastAt - a.lastAt);
}

/** How many replies hang off each message, for the stream's own hint. */
export function replyCounts(messages: Message[]): Map<string, number> {
  const roots = rootIds(messages.filter((m) => !m.deleted));
  const counts = new Map<string, number>();
  for (const [id, rootId] of roots) {
    if (id === rootId) continue;
    counts.set(rootId, (counts.get(rootId) ?? 0) + 1);
  }
  return counts;
}

/** "3 replies", and nothing at all for none. */
export function replyLabel(count: number): string | null {
  if (count <= 0) return null;
  return count === 1 ? "1 reply" : `${count} replies`;
}

/** A line of a message short enough to stand in for it in a list. */
export function preview(message: Message, max = 140): string {
  const text = (message.text ?? "").replace(/\s+/g, " ").trim();
  if (text) return text.length > max ? `${text.slice(0, max - 1)}…` : text;
  switch (message.kind) {
    case "artifact":
      return message.artifact?.name ?? "a file";
    case "options":
      return message.card?.title ?? "a question";
    case "activity":
      return message.tool?.name ?? "did something";
    case "screen":
      return "a screenshot";
    default:
      return "…";
  }
}
