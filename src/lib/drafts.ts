// What was being written in each conversation, kept while you look at
// another one.
//
// The composer was one box for every agent: switching agents kept what
// was in it, so a half-written message and the files riding with it
// followed you to an agent they were never meant for, and Enter sent them
// there. A composer now belongs to one conversation, and what it held is
// kept here by that conversation's key when it goes, so coming back finds
// it where it was and going elsewhere finds that one's own.
//
// In memory only. A draft is for the next few minutes, not for after a
// restart.
import type { Attachment } from "./attachments.js";

export interface Draft<A = unknown> {
  text: string;
  attachments: A[];
}

const drafts = new Map<string, Draft>();

/** Nothing worth keeping: no words, no chips. */
export function isEmptyDraft(draft: Draft | undefined): boolean {
  return !draft || (!draft.text.trim() && !draft.attachments.length);
}

/** The draft left in a conversation, or an empty one. */
export function readDraft<A>(key: string): Draft<A> {
  return (drafts.get(key) as Draft<A> | undefined) ?? { text: "", attachments: [] };
}

/** Keep what a conversation's box holds as it goes. An empty box forgets. */
export function keepDraft<A>(key: string, draft: Draft<A>): void {
  if (isEmptyDraft(draft)) drafts.delete(key);
  else drafts.set(key, draft);
}

/**
 * What the box should hold after a send that failed: the words and chips
 * that went, when it is still empty. The box clears the moment you send,
 * so without this a refusal took the message with it. Anything typed
 * since is the newer thought and stays, and then this says nothing.
 */
export function takeBack<A>(current: Draft<A>, sent: Draft<A>): Draft<A> | null {
  return isEmptyDraft(current) ? sent : null;
}

export interface FailedDraft {
  id: string;
  draft: Draft<Attachment>;
}

// A newer draft keeps the box, but not at the cost of the failed input.
// These belong to the same conversation key and window as drafts above;
// only an explicit restore or discard consumes one, never another failure.
const failed = new Map<string, FailedDraft[]>();
let recoveryId = 0;
type DraftRef<A = Attachment> = { current: Draft<A> };
const snapshot = (draft: Draft<Attachment>): Draft<Attachment> => ({
  text: draft.text,
  attachments: draft.attachments.map((a) => ({ ...a })),
});

export function readRecoveries(key: string): readonly FailedDraft[] {
  return failed.get(key) ?? [];
}

/** Accepted typing/intake and recovery share this synchronous view, while
 * React may still be batching the corresponding screen update. */
export function acceptDraft<A>(box: DraftRef<A>, next: Draft<A>): Draft<A> {
  box.current = next;
  return next;
}

/** Set the ref before React batches its renders: a second failure must
 * see the first restored draft, not the empty box from the last render. */
export function recoverDraft(key: string, box: DraftRef, sent: Draft<Attachment>): Draft<Attachment> | null {
  const saved = snapshot(sent);
  const back = takeBack(box.current, saved);
  if (back) {
    return acceptDraft(box, back);
  }
  const item = { id: `recovery-${++recoveryId}`, draft: saved };
  failed.set(key, [...readRecoveries(key), item]);
  return null;
}

export function discardRecovery(key: string, id: string): void {
  const rest = readRecoveries(key).filter((item) => item.id !== id);
  if (rest.length) failed.set(key, rest);
  else failed.delete(key);
}

/** Restoring fills an empty box, not a newer thought. An id from a stale
 * render cannot consume an item appended since that render, or resend it. */
export function restoreRecovery(key: string, id: string, box: DraftRef): Draft<Attachment> | null {
  const item = readRecoveries(key).find((entry) => entry.id === id);
  if (!item || !isEmptyDraft(box.current)) return null;
  const back = snapshot(item.draft);
  acceptDraft(box, back);
  discardRecovery(key, id);
  return back;
}

/** The box on screen for each conversation, by key, to hand a failed send
 * back to. A send can fail after you left and came back, and then the box
 * that sent it is gone while a new one for the same conversation is up;
 * writing the words into the kept draft would leave them where nothing
 * reads them until that box goes too, and it would save its empty self
 * over them. */
const live = new Map<string, (sent: Draft) => void>();

/** Register the box on screen for a conversation. Returns its unregister. */
export function showBox<A>(key: string, receive: (sent: Draft<A>) => void): () => void {
  const fn = receive as (sent: Draft) => void;
  live.set(key, fn);
  return () => {
    if (live.get(key) === fn) live.delete(key);
  };
}

/** The box on screen for a conversation, if one is. */
export function boxFor<A>(key: string): ((sent: Draft<A>) => void) | undefined {
  return live.get(key) as ((sent: Draft<A>) => void) | undefined;
}

/** Whether the box that just went had the keyboard, so the one that
 * replaces it (another agent, another lane) takes it, rather than the
 * typing that follows going nowhere. */
let focusCarried = false;
export function carryFocus(had: boolean): void {
  focusCarried = had;
}
export function takeFocus(): boolean {
  const had = focusCarried;
  focusCarried = false;
  return had;
}
