// Two small truths about the end and the beginning of a transcript.
//
// The tail: a turn settles across three separate frames (the reply, the
// completion, the busy flip), and a typing indicator keyed on busy alone
// pops back for a beat between them, bouncing the layout. The dots
// should show only while something is genuinely still owed.
//
// The head: a long thread mounts hundreds of rows the reader has already
// read. Rendering the last window and offering the rest behind a pill
// keeps the DOM light without touching what is stored.
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
