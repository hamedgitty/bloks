// An agent looking something up in its own past.
//
// A person can search every conversation from the command palette; until
// now an agent could not search any. Its memory notes hold what it chose
// to write down, and the rest (what was decided three weeks ago, the name
// of the vendor, the reason a plan changed) was gone the moment it fell
// out of the context window.
//
// So an agent can ask. What it can reach is exactly what it was part of:
// its own lanes and the rooms it sits in, never another agent's private
// conversations, and never anything taken back or rewound. A turn in a
// room shared with other people reaches that room and nothing else, since
// the owner's own conversations are not the guests' to hear about.
//
// Matching is words, in any order, because nobody remembers the exact
// sentence. Each hit comes with the message before it, since an answer
// without its question ("yes, go with the second one") is not recall.
//
// Everything here is pure; the server hands it the transcripts.

export interface RecallSource {
  threadId: string;
  /** Where it was said, as a person would name it: "DM, Launch plan". */
  where: string;
  messages: Array<{
    id: string;
    at: number;
    role: "user" | "bot";
    kind?: string;
    text?: string;
    from?: string;
    /** a member of a shared room, when a person other than the owner said it */
    author?: string;
    /** set when another agent sent it (store.ts, AgentNote) */
    agent?: { dir: string; peerId: string; peerName: string };
    deleted?: boolean;
  }>;
}

/** Who said something, as recall reports it. `by` is the part an agent
 * can rely on: only "person" is the owner's own word. */
export interface Speaker {
  who: string;
  by: "person" | "member" | "agent" | "self";
  /** The agent that said it, for "agent" and "self". */
  agentId?: string;
}

export interface RecallHit {
  threadId: string;
  messageId: string;
  at: number;
  where: string;
  who: string;
  /** Whose words these are. A message from another agent is never the
   * person's, however it arrived (GitHub 136). */
  by: Speaker["by"];
  agentId?: string;
  text: string;
  /** What was said just before, for context. */
  before?: { who: string; by: Speaker["by"]; agentId?: string; text: string };
}

const STOP = new Set(
  "a an and are as at be but by did do does for from had has have how i in is it its me my of on or our so that the their them then there they this to was we were what when where which who why will with you your".split(
    " ",
  ),
);

/** The words worth matching on. */
export function termsOf(query: string): string[] {
  const words = (query ?? "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}_$.#@/-]+/u)
    .map((w) => w.replace(/^[.\-/]+|[.\-/]+$/g, ""))
    .filter((w) => w.length >= 2 && !STOP.has(w));
  return [...new Set(words)].slice(0, 12);
}

const clip = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/**
 * The best matches for `query`, newest first among equals.
 *
 * A message counts when it holds most of the words: all of them for a
 * query of one or two, two thirds for longer ones. The exact phrase
 * scores above any scattering of the same words.
 */
export function recall(
  query: string,
  sources: RecallSource[],
  speakerOf: (message: RecallSource["messages"][number]) => Speaker,
  limit = 8,
): RecallHit[] {
  const terms = termsOf(query);
  if (!terms.length) return [];
  const phrase = query.trim().toLowerCase().replace(/\s+/g, " ");
  const need = terms.length <= 2 ? terms.length : Math.ceil((terms.length * 2) / 3);

  const scored: Array<{ hit: RecallHit; score: number }> = [];
  for (const source of sources) {
    let previous: RecallSource["messages"][number] | undefined;
    for (const message of source.messages) {
      const readable = !message.deleted && (message.kind ?? "text") === "text" && Boolean(message.text?.trim());
      if (!readable) continue;
      const text = message.text!.toLowerCase();
      const found = terms.filter((term) => text.includes(term)).length;
      if (found >= need) {
        const score = found * 10 + (phrase.length > 3 && text.includes(phrase) ? 25 : 0);
        const speaker = speakerOf(message);
        const earlier = previous ? speakerOf(previous) : null;
        scored.push({
          score,
          hit: {
            threadId: source.threadId,
            messageId: message.id,
            at: message.at,
            where: source.where,
            who: speaker.who,
            by: speaker.by,
            ...(speaker.agentId ? { agentId: speaker.agentId } : {}),
            text: clip(message.text!, 600),
            ...(previous && earlier
              ? {
                  before: {
                    who: earlier.who,
                    by: earlier.by,
                    ...(earlier.agentId ? { agentId: earlier.agentId } : {}),
                    text: clip(previous.text!, 300),
                  },
                }
              : {}),
          },
        });
      }
      previous = message;
    }
  }
  scored.sort((a, b) => b.score - a.score || b.hit.at - a.hit.at);
  return scored.slice(0, Math.max(1, Math.min(limit, 20))).map((s) => s.hit);
}

/** A name that says what kind of speaker it is, so a model reading the
 * lines cannot take another agent's report for the person's decision. */
function label(s: { who: string; by: Speaker["by"]; agentId?: string }): string {
  if (s.by === "agent") return `${s.who} (another agent${s.agentId ? `, ${s.agentId}` : ""})`;
  if (s.by === "member") return `${s.who} (a member of the room)`;
  if (s.by === "self") return `${s.who} (you)`;
  return s.who;
}

/** Hits as the few lines a model reads best. */
export function recallText(hits: RecallHit[], query: string): string {
  if (!hits.length) return `Nothing in your past conversations matches "${query}".`;
  return hits
    .map((hit) => {
      const when = new Date(hit.at).toISOString().slice(0, 16).replace("T", " ");
      const before = hit.before ? `\n  (just before, ${label(hit.before)}: ${hit.before.text})` : "";
      return `- ${when}, ${hit.where}, ${label(hit)}: ${hit.text}${before}`;
    })
    .join("\n");
}
