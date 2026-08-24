// Finding a line in the conversation you are already reading.
//
// The command palette searches every thread and answers "which
// conversation was that in". This answers a different question, the one
// you ask with Cmd-F: "where in THIS conversation did we say that". It
// has to look at the whole thread rather than the rendered slice of it,
// because a long transcript only renders its tail, and the line you are
// hunting for is usually not in the tail.
export interface FindableMessage {
  kind?: string;
  text?: string;
  deleted?: boolean;
}

/** Indices into the full message list, in the order they appear. */
export function findHits(messages: readonly FindableMessage[], query: string): number[] {
  const needle = query.trim().toLowerCase();
  if (needle.length < 2) return [];
  const hits: number[] = [];
  messages.forEach((message, index) => {
    // A taken-back message has no words to find, and a screen frame's
    // base64 would match half the alphabet.
    if (message.deleted) return;
    if (message.kind && message.kind !== "text" && message.kind !== "notice") return;
    if ((message.text ?? "").toLowerCase().includes(needle)) hits.push(index);
  });
  return hits;
}

/**
 * One string split into the parts that matched and the parts that did
 * not, alternating, starting with a non-match (possibly empty). Case is
 * ignored for matching and preserved in the output, because showing
 * somebody their own text in the wrong case is its own small insult.
 */
export function splitHighlight(text: string, query: string): Array<{ text: string; hit: boolean }> {
  const needle = query.trim();
  if (needle.length < 2) return [{ text, hit: false }];
  const parts: Array<{ text: string; hit: boolean }> = [];
  const lower = text.toLowerCase();
  const target = needle.toLowerCase();
  let at = 0;
  for (;;) {
    const found = lower.indexOf(target, at);
    if (found === -1) break;
    if (found > at) parts.push({ text: text.slice(at, found), hit: false });
    parts.push({ text: text.slice(found, found + target.length), hit: true });
    at = found + target.length;
  }
  if (at < text.length) parts.push({ text: text.slice(at), hit: false });
  return parts.length ? parts : [{ text, hit: false }];
}

/** Wraps around at both ends, so n keeps working past the last hit. */
export function stepHit(current: number, total: number, by: number): number {
  if (total === 0) return 0;
  return (current + by + total) % total;
}
