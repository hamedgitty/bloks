// Small truths about the end and the beginning of a transcript.
//
// The tail: while an agent works, one line at the end says so, how long
// it has been at it, and how to stop it. A turn settles across three
// separate frames (the reply, the completion, the busy flip), and a line
// keyed on busy alone pops back for a beat between them, bouncing the
// layout, so a reply at the tail holds it off.
//
// The head: a long thread mounts hundreds of rows the reader has already
// read. Rendering the last window and offering the rest behind a pill
// keeps the DOM light without touching what is stored.
//
// And the last thing you said: ↑ in an empty composer opens it for
// editing, the way chat apps have taught everyone to expect.
//
// And what is not worth a row each: a run of quiet check-ins is one line.
import type { Message } from "@/state/reducer";
import { t } from "./i18n.ts";

/** How long a reply at the tail of a turn that is still working holds
 * the working line off. Long enough to cover the frames a finished turn
 * takes to settle; short enough that an agent which wrote a progress
 * note and went on working is not left looking finished. */
export const REPLY_HOLD_MS = 2000;

/**
 * Whether the working line is owed at the end of the transcript. It is
 * the one thing there that says the agent is at work: a call still
 * running at the tail does not hide it, because the call's own row only
 * says which step (and once had a spinner of its own, which drew two
 * indicators at once). Words streaming in keep it too, so it does not
 * blink out and back between a sentence and the next call.
 * `replyAgeMs` is how long the newest message has been on screen.
 */
export function workingLineOwed(
  working: boolean | undefined,
  streaming: string | undefined,
  last: Message | undefined,
  replyAgeMs: number,
): boolean {
  if (!working) return false;
  if (streaming || !last) return true;
  if (last.role === "bot" && last.kind === "text" && !last.deleted) return replyAgeMs >= REPLY_HOLD_MS;
  return true;
}

/**
 * When the running turn began, as the transcript tells it: the newest
 * message that started a turn (one said to the agent that did not go
 * into a turn already running; see turnFold.ts). Null when there is
 * none, and the caller falls back to when it first saw the work.
 */
export function turnStartedAt(messages: readonly Message[]): number | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "user" && m.kind === "text" && !m.midTurn && !m.queued && !m.unsent &&
        !(m.preparation?.dismissed && m.preparation.state !== "joined")) return m.at ?? null;
  }
  return null;
}

/** "8s", "1m 05s", "1h 02m": a running clock, fixed width within each
 * unit so it does not jitter as it counts. */
export function clock(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  // the units are the language's; the digits stay a clock's
  if (seconds < 60) return t("transcript.clockSeconds", { seconds: String(seconds) });
  const minutes = Math.floor(seconds / 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  if (minutes < 60) return t("transcript.clockMinutes", { minutes: String(minutes), seconds: pad(seconds % 60) });
  return t("transcript.clockHours", { hours: String(Math.floor(minutes / 60)), minutes: pad(minutes % 60) });
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

/** Only new rows before this request's boundary advance history. Live
 * tail arrivals and repeated page ids do not buy another automatic ask. */
export function earlierPrefix(page: readonly Message[], current: readonly Message[], before?: string): Message[] {
  const have = new Set(current.map((m) => m.id));
  const fresh: Message[] = [];
  for (const message of page) {
    if (message.id === before) break;
    if (!have.has(message.id)) {
      have.add(message.id);
      fresh.push(message);
    }
  }
  return fresh;
}

/** Automatic opening/resize fills stop at eight windows or pages. A
 * folded page can advance history without adding height, so only the
 * actual geometry, cursor progress and this finite ceiling bound it. */
export const AUTO_EARLIER_PAGES = 8;
export function shouldFillEarlier(o: { width: number; height: number; contentHeight: number;
  more: boolean; loading: boolean; stopped: boolean; attempts: number }): boolean {
  return o.width > 0 && o.height > 0 && o.contentHeight + 1 < o.height &&
    o.more && !o.loading && !o.stopped && o.attempts < AUTO_EARLIER_PAGES;
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
/**
 * The run of quiet check-ins a message starts, for showing as one muted
 * line: every quiet message from here until something that is not, or
 * null when this one is not quiet or the line was already drawn for the
 * run at an earlier message. A check-in every half hour would otherwise
 * be two bubbles every half hour saying nothing between what matters.
 */
export function quietRunAt<T extends Pick<Message, "quiet" | "deleted">>(messages: readonly T[], at: number): T[] | null {
  const quiet = (m: T | undefined) => Boolean(m?.quiet && !m.deleted);
  if (!quiet(messages[at]) || quiet(messages[at - 1])) return null;
  const run: T[] = [];
  for (let i = at; i < messages.length && quiet(messages[i]); i++) run.push(messages[i]);
  return run;
}

/** "3 quiet check-ins, last at 10:30": how many routine prompts the run
 * holds, and when the last of it was said, in the reader's own clock
 * (`time` is the chat's own stamp). */
export function quietLine(run: readonly Pick<Message, "role" | "at">[], time: (at: number) => string): string {
  const count = run.filter((m) => m.role === "user").length || 1;
  const last = run[run.length - 1];
  return last?.at ? t("transcript.quietLast", { count, time: time(last.at) }) : t("transcript.quiet", { count });
}

export function splitWaiting(messages: readonly Message[]): { said: Message[]; waiting: Message[] } {
  const said: Message[] = [];
  const waiting: Message[] = [];
  for (const m of messages) {
    if (!m.queued && !m.unsent) said.push(m);
    else if (!m.deleted) waiting.push(m);
  }
  return { said, waiting };
}
