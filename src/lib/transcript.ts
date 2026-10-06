// Small truths about the end and the beginning of a transcript.
//
// The tail: a turn settles across three separate frames (the reply, the
// completion, the busy flip), and a typing indicator keyed on busy alone
// pops back for a beat between them, bouncing the layout. The dots
// should show only while something is genuinely still owed.
//
// The head: a long thread mounts hundreds of rows the reader has already
// read. Rendering the last window and offering the rest behind a pill
// keeps the DOM light without touching what is stored.
//
// And the last thing you said: ↑ in an empty composer opens it for
// editing, the way chat apps have taught everyone to expect.
import type { Message } from "@/state/reducer";

/** Whether the typing dots are owed. Not busy or already streaming means
 * no; a settled bot reply at the tail means the wait is over even if the
 * busy flag has not caught up yet. */
export function showTypingDots(
  busy: boolean | undefined,
  streaming: string | undefined,
  last: Message | undefined,
): boolean {
  if (!busy || streaming) return false;
  if (!last) return true;
  return !(last.role === "bot" && last.kind === "text");
}

/** The last window of a long transcript, plus how much stays folded. */
export const TRANSCRIPT_WINDOW = 120;

export function windowStart(total: number, boundary: number | null): number {
  // a stale boundary from a thread that shrank falls back to a fresh tail
  if (boundary === null || boundary >= total) return Math.max(0, total - TRANSCRIPT_WINDOW);
  return Math.max(0, boundary);
}

/** How close to the top, in pixels, scrolling up starts on the next
 * page, so it is usually there before the reader reaches the edge. */
export const EARLIER_AHEAD_PX = 400;

/**
 * Whether a scroll should bring in earlier messages: only while the
 * reader is moving up, near the top, with more to show and nothing
 * already on its way. Moving up is what makes it the reader's doing: the
 * jump to the newest message on opening, and the place being restored
 * after a page lands, both move down and never start another.
 */
export function shouldLoadEarlier(o: { top: number; lastTop: number; more: boolean; loading: boolean }): boolean {
  return o.more && !o.loading && o.top < o.lastTop && o.top <= EARLIER_AHEAD_PX;
}

/**
 * The message ↑ in an empty composer opens for editing: the newest one
 * you typed here that still has words to edit. A message taken back has
 * none left, so the one before it is the last thing you said. What came
 * in another way (a watcher, an email, a chat app) and what passed
 * between agents is not yours to rewrite from this box, and is passed
 * over the same way, as is one never sent, which is sent again instead.
 */
export function lastEditable(messages: readonly Message[]): Message | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user" || m.deleted || m.unsent || m.via || m.agent) continue;
    if (m.kind === "text" && m.text) return m;
  }
  return null;
}

/**
 * A conversation and what is waiting to join it. A message queued behind
 * a turn, or one not sent after a restart, is not part of the
 * conversation yet: it waits above the composer, in the order it was
 * sent, and enters the conversation when it goes, after everything the
 * agent said meanwhile (GitHub 170). One taken back while it waited
 * never entered at all, so it shows in neither.
 */
export function splitWaiting(messages: readonly Message[]): { said: Message[]; waiting: Message[] } {
  const said: Message[] = [];
  const waiting: Message[] = [];
  for (const m of messages) {
    if (!m.queued && !m.unsent) said.push(m);
    else if (!m.deleted) waiting.push(m);
  }
  return { said, waiting };
}
