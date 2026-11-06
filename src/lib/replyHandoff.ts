// A reply handed to a conversation that is not on screen yet: Branch
// with this opens a new conversation and puts the quote in its box. The
// branch can arrive (by the stream) before the answer that names it, or
// after, so the reply waits here for that conversation's view to take
// it, or goes straight to the view already listening.

export interface HandedReply {
  id?: string;
  author: string;
  excerpt: string;
  quote?: string;
}

const waiting = new Map<string, HandedReply>();
const listening = new Map<string, (reply: HandedReply) => void>();

/** For the conversation keyed `agent:lane`. */
export function handReply(key: string, reply: HandedReply): void {
  const listener = listening.get(key);
  if (listener) listener(reply);
  else waiting.set(key, reply);
}

/** A conversation's view listening while it is on screen; what waited
 * for it comes at once. Returns the way to stop. */
export function listenForReply(key: string, take: (reply: HandedReply) => void): () => void {
  listening.set(key, take);
  const handed = waiting.get(key);
  if (handed) {
    waiting.delete(key);
    take(handed);
  }
  return () => {
    if (listening.get(key) === take) listening.delete(key);
  };
}
