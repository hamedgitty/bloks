// An agent looking something up in its own past.
//
// A person can search every conversation from the command palette; until
// now an agent could not search any. Its memory notes hold what it chose
// to write down, and the rest (what was decided three weeks ago, the name
// of the vendor, the reason a plan changed) was gone the moment it fell
// out of the context window.
//
// So an agent can ask. What it can reach is exactly what it was part of:
// its own lanes, the rooms it sits in and its own memory files, never
// another agent's private conversations, and never anything taken back
// or rewound. A turn in a room shared with other people reaches that room
// and nothing else, since the owner's own conversations are not the
// guests' to hear about.
//
// Matching is words, in any order, because nobody remembers the exact
// sentence, ranked by how telling they are (server/recall-index.ts). Each
// hit comes with the message before it, since an answer without its
// question ("yes, go with the second one") is not recall.
//
// Everything here is pure; the server hands it the transcripts, or the
// indexes it keeps of them.
import { excerpt, queryTerms, rank, TermIndex, type IndexedDoc, type RankOptions } from "./recall-index.ts";

export interface RecallMessage {
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
  /** still waiting for a turn, or never sent: not said yet */
  queued?: boolean;
  unsent?: boolean;
}

export interface RecallSource {
  threadId: string;
  /** Where it was said, as a person would name it: "DM, Launch plan". */
  where: string;
  messages: RecallMessage[];
}

/** A place recall searches with its index already built: a conversation
 * (with its messages, for who said a hit and what came before it), or
 * one of the agent's memory files. */
export interface IndexedSource {
  threadId: string;
  where: string;
  index: TermIndex;
  messages?: RecallMessage[];
  /** The memory file this is, by name ("MEMORY.md", "memory/vendors.md"). */
  memory?: string;
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
  /** About 600 characters around where the words were found; the whole
   * of it is a read by messageId away. */
  text: string;
  clipped?: boolean;
  /** What was said just before, for context. */
  before?: { who: string; by: Speaker["by"]; agentId?: string; text: string };
  /** Set when the hit is a piece of one of the agent's memory files. */
  memory?: string;
}

/** The words of a message recall can find, or null for one it never
 * should: taken back or rewound, not words at all, or not said yet. */
export function searchableText(message: RecallMessage): string | null {
  if (message.deleted || message.queued || message.unsent) return null;
  if ((message.kind ?? "text") !== "text") return null;
  return message.text?.trim() ? message.text : null;
}

export function indexMessages(messages: readonly RecallMessage[]): TermIndex {
  const index = new TermIndex();
  for (const message of messages) {
    const text = searchableText(message);
    if (text) index.add(message.id, message.at, text);
  }
  return index;
}

/** How long a piece of a memory file is, about. */
const PIECE = 600;

/**
 * A memory file as the pieces a hit can be: a section under its heading,
 * cut at blank lines (or, for one long paragraph, at line ends) so no
 * piece runs much past PIECE characters. Each piece keeps its heading,
 * since "- Sticker Mule, net 30" means little without "## Vendors".
 */
export function memoryPieces(text: string): string[] {
  const pieces: string[] = [];
  let heading = "";
  let lines: string[] = [];
  const flushSection = () => {
    const paragraphs: string[] = [];
    let current: string[] = [];
    for (const line of [...lines, ""]) {
      if (line.trim()) current.push(line);
      else if (current.length) {
        paragraphs.push(current.join("\n"));
        current = [];
      }
    }
    let piece = "";
    const flushPiece = () => {
      if (piece.trim()) pieces.push(heading ? `${heading}\n${piece.trim()}` : piece.trim());
      piece = "";
    };
    for (const paragraph of paragraphs) {
      for (const part of paragraph.length > PIECE ? paragraph.split("\n") : [paragraph]) {
        if (piece && piece.length + part.length + 1 > PIECE) flushPiece();
        piece = piece ? `${piece}\n${part}` : part;
      }
    }
    flushPiece();
    lines = [];
  };
  for (const line of (text ?? "").split("\n")) {
    if (/^#{1,6}\s/.test(line)) {
      flushSection();
      heading = line.trim();
    } else {
      lines.push(line);
    }
  }
  flushSection();
  return pieces;
}

/** One memory file's pieces, each dated by when the file last changed. */
export function indexMemory(text: string, at: number): TermIndex {
  const index = new TermIndex();
  memoryPieces(text).forEach((piece, n) => index.add(`piece-${n}`, at, piece));
  return index;
}

/** The words worth matching on, folded the way the index folds them. */
export function termsOf(query: string): string[] {
  return queryTerms(query).slice(0, 12);
}

/** Most of the words: all of them for a query of one or two, two
 * thirds for longer ones. What an agent's own search asks of a hit. */
export const mostOf = (terms: number) => (terms <= 2 ? terms : Math.ceil((terms * 2) / 3));

export interface RecallOptions extends Pick<RankOptions, "now" | "need" | "minStrength" | "minScore"> {
  limit?: number;
  /** How long each hit's text may be, about. */
  excerpt?: number;
  skip?: (source: IndexedSource, doc: IndexedDoc) => boolean;
}

const flat = (text: string) => text.replace(/\s+/g, " ").trim();
const clip = (text: string, max: number) => {
  const words = flat(text);
  return words.length > max ? `${words.slice(0, max - 1)}…` : words;
};

/**
 * The best matches for `query` among sources already indexed, best
 * first. A hit must hold most of the words unless `need` says otherwise.
 */
export function recallFrom(
  query: string,
  sources: readonly IndexedSource[],
  speakerOf: (message: RecallMessage) => Speaker,
  options: RecallOptions = {},
): RecallHit[] {
  const max = options.excerpt ?? 600;
  const skip = options.skip;
  const ranked = rank(
    query,
    sources.map((source) => source.index),
    {
      limit: Math.max(1, Math.min(options.limit ?? 8, 20)),
      now: options.now,
      need: options.need ?? mostOf,
      minStrength: options.minStrength,
      minScore: options.minScore,
      ...(skip ? { skip: (i: number, doc: IndexedDoc) => skip(sources[i], doc) } : {}),
    },
  );
  const hits: RecallHit[] = [];
  for (const found of ranked) {
    const source = sources[found.source];
    const text = excerpt(found.doc.text, found.focus, max);
    const clipped = flat(found.doc.text).length > max;
    if (source.memory) {
      hits.push({
        threadId: source.threadId,
        messageId: found.doc.id,
        at: found.doc.at,
        where: source.where,
        who: "your notes",
        by: "self",
        text,
        memory: source.memory,
      });
      continue;
    }
    const messages = source.messages ?? [];
    const position = messages.findIndex((m) => m.id === found.doc.id);
    // an index a step behind its transcript: the message has gone since
    if (position < 0) continue;
    const speaker = speakerOf(messages[position]);
    let previous: RecallMessage | undefined;
    for (let i = position - 1; i >= 0 && !previous; i--) if (searchableText(messages[i])) previous = messages[i];
    const earlier = previous ? speakerOf(previous) : null;
    hits.push({
      threadId: source.threadId,
      messageId: found.doc.id,
      at: found.doc.at,
      where: source.where,
      who: speaker.who,
      by: speaker.by,
      ...(speaker.agentId ? { agentId: speaker.agentId } : {}),
      text,
      ...(clipped ? { clipped: true } : {}),
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
    });
  }
  return hits;
}

/**
 * The best matches for `query` in transcripts handed over whole, best
 * first: most of the words, ranked by how telling they are, with the
 * exact phrase above any scattering of the same words.
 */
export function recall(
  query: string,
  sources: RecallSource[],
  speakerOf: (message: RecallMessage) => Speaker,
  limit = 8,
): RecallHit[] {
  const indexed = sources.map((source) => ({ ...source, index: indexMessages(source.messages) }));
  return recallFrom(query, indexed, speakerOf, { limit });
}

/** A name that says what kind of speaker it is, so a model reading the
 * lines cannot take another agent's report for the person's decision. */
function label(s: { who: string; by: Speaker["by"]; agentId?: string }): string {
  if (s.by === "agent") return `${s.who} (another agent${s.agentId ? `, ${s.agentId}` : ""})`;
  if (s.by === "member") return `${s.who} (a member of the room)`;
  if (s.by === "self") return `${s.who} (you)`;
  return s.who;
}

const stampOf = (at: number) => new Date(at).toISOString().slice(0, 16).replace("T", " ");

/** Hits as the few lines a model reads best. */
export function recallText(hits: RecallHit[], query: string): string {
  if (!hits.length) return `Nothing in your past conversations matches "${query}".`;
  return hits
    .map((hit) => {
      if (hit.memory) return `- ${stampOf(hit.at)}, ${hit.where}: ${hit.text}`;
      const before = hit.before ? `\n  (just before, ${label(hit.before)}: ${hit.before.text})` : "";
      const cut = hit.clipped ? ` [cut short: message ${hit.messageId} has the rest]` : "";
      return `- ${stampOf(hit.at)}, ${hit.where}, ${label(hit)}: ${hit.text}${cut}${before}`;
    })
    .join("\n");
}

/**
 * What recall found before a turn, as the block that goes ahead of the
 * person's words. Framed as found rather than said, since it was matched
 * on words and may be beside the point, and the agent is told it may
 * leave it be.
 */
export function recallBlock(hits: RecallHit[]): string {
  const lines = hits.map((hit) =>
    hit.memory
      ? `- ${stampOf(hit.at)}, ${hit.where}: "${hit.text}"`
      : `- ${stampOf(hit.at)}, ${hit.where}, ${label(hit)}: "${hit.text}"`,
  );
  return `(From your other conversations, in case it helps. Bloks found these by the words in the message below, so they may be beside the point: use what fits and ignore the rest.\n${lines.join("\n")})`;
}
