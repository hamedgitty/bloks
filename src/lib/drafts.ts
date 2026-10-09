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
