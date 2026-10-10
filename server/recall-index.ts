// How recall ranks what an agent has said before.
//
// Holding most of the words was enough for a few conversations and wrong
// for a year of them: a message that said "vendor" six times beat the one
// that named the vendor, and a word in every other message counted as
// much as a name said once. So this scores the way search engines have
// for decades (BM25): a word counts for more the rarer it is in this
// agent's own past, saying it again counts for less each time, and a long
// message does not win by being long. On top of that a little for being
// recent, and more when the words sit together or come in the order they
// were asked.
//
// Words are folded before they are compared, so "vendors", "vendor" and
// "vendoring" find each other, and the small words every sentence has are
// left out. The folding is deliberately simple and English only: a word
// in another language, a number or a file name is matched as written.
//
// An index is plain memory, one per conversation (or memory file), built
// the first time it is searched and grown as messages arrive. Nothing here
// reads a file or knows what a message is: server/recall.ts decides what
// counts as one, and server/index.ts keeps the indexes in step with the
// store and within IndexCache's budget.

/** Words too common to tell one message from another. */
export const STOPWORDS = new Set(
  `a about above after again against all also am an and any are aren as at be because been before being below
  between both but by can could did didn do does doesn doing don down during each either else even ever every
  few for from further get gets got had hadn has hasn have haven having he her here hers herself him himself his
  how i if in into is isn it its itself just let lets ll me might mine more most much must my myself no nor not
  now of off ok okay on once only or other our ours ourselves out over own please re same shall she should so
  some such than thank thanks that the their theirs them themselves then there these they this those through
  to too under until up upon us ve very was wasn we were weren what when where which while who whom why will
  with won would yeah yes yet you your yours yourself yourselves`.split(/\s+/),
);

/** How much of one message is read into the index. A pasted log or a
 * long report still gets found by what it opens with, and one of them
 * cannot take a whole budget by itself. */
export const INDEX_CHARS = 12_000;

/** Term frequency is kept beside the document number in one integer,
 * which is why it stops counting at 31: BM25 has long stopped caring. */
const TF_SLOTS = 32;
const K1 = 1.2;
const B = 0.75;
/** At most this many of a query's words are scored, the rarest first. */
const MAX_QUERY_TERMS = 16;
/** Positions apart that still count as "near". */
const NEAR_WINDOW = 8;
const PHRASE_BONUS = 0.5;
const NEAR_BONUS = 0.3;
/** Brand new is worth at most this much more, and the edge halves every
 * RECENCY_HALF_LIFE days, so a strong old match still beats a weak new one. */
const RECENCY_WEIGHT = 0.15;
const RECENCY_HALF_LIFE = 30 * 24 * 60 * 60 * 1000;

const STEMS = new Map<string, string>();
const STEMS_MAX = 100_000;

/**
 * One English word in the form its plural and its -ing and -ed forms
 * share: "vendors" and "vendor", "making" and "make", "planned" and
 * "plan". Nothing cleverer, because a stemmer that gets clever folds
 * words together that mean different things, and a missed match is
 * kinder than a wrong one here.
 */
export function stem(word: string): string {
  const known = STEMS.get(word);
  if (known !== undefined) return known;
  const folded = fold(word);
  if (STEMS.size >= STEMS_MAX) STEMS.clear();
  STEMS.set(word, folded);
  return folded;
}

function fold(word: string): string {
  let w = word;
  if (w.length < 3 || !/^[a-z]+$/.test(w)) return w;
  if (w.length > 4 && w.endsWith("ies")) w = `${w.slice(0, -3)}y`;
  else if (w.endsWith("sses")) w = w.slice(0, -2);
  else if (/(?:ch|sh|x|z)es$/.test(w)) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith("s") && !/(?:ss|us|is)$/.test(w)) w = w.slice(0, -1);
  if (w.endsWith("eed")) {
    // "agreed" is "agree", but "need" and "speed" are words of their own
    if (/[aeiouy]/.test(w.slice(0, -3))) w = w.slice(0, -1);
  } else {
    const suffix = w.endsWith("ing") ? 3 : w.endsWith("ed") ? 2 : 0;
    const base = suffix ? w.slice(0, -suffix) : "";
    if (base.length >= 2 && /[aeiouy]/.test(base)) {
      // "running" is "run", while "falling", "missed" and "added" keep theirs
      w = base.length >= 4 && /([^aeiouylsz])\1$/.test(base) ? base.slice(0, -1) : base;
    }
  }
  // a silent e goes too, which is what lets "make" meet "making"
  if (w.length >= 3 && w.endsWith("e")) w = w.slice(0, -1);
  return w;
}

// A word is a run of letters and digits (and the _ $ # @ that names and
// tags use), and the dots, slashes, hyphens and apostrophes between two
// of them hold a file name, a version or a contraction together. Read a
// character at a time rather than with one Unicode regex, which was most
// of the cost of indexing a long history.
const ASCII_WORD = new Uint8Array(128);
for (const c of "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_$#@") ASCII_WORD[c.charCodeAt(0)] = 1;
const OTHER_WORD = new Map<number, boolean>();
const LETTER = /[\p{L}\p{N}]/u;
function wordCode(c: number): boolean {
  if (c < 128) return ASCII_WORD[c] === 1;
  // half of a pair (an emoji, mostly) is not a letter on its own
  if (c >= 0xd800 && c <= 0xdfff) return false;
  let known = OTHER_WORD.get(c);
  if (known === undefined) {
    known = LETTER.test(String.fromCharCode(c));
    OTHER_WORD.set(c, known);
  }
  return known;
}
const APOSTROPHE = 39;
const CURLY_APOSTROPHE = 0x2019;
const joiner = (c: number) => c === 46 || c === 47 || c === 45 || c === APOSTROPHE || c === CURLY_APOSTROPHE;
const PART = /[./-]+/;

const keep = (word: string) => word.length >= 2 && !STOPWORDS.has(word);

/**
 * Every word of `text` worth matching on, folded, in order, with where
 * each starts. A word joined from parts ("follow-up", "server/index.ts")
 * is given whole and then part by part, so either finds it. Positions
 * count only the words kept, so "price of the plan" has "price" and
 * "plan" side by side, the way someone asking for it would say it.
 */
export function eachTerm(text: string, visit: (term: string, at: number) => void, maxChars = INDEX_CHARS): void {
  const lower = (text.length > maxChars ? text.slice(0, maxChars) : text).toLowerCase();
  const n = lower.length;
  let i = 0;
  while (i < n) {
    while (i < n && !wordCode(lower.charCodeAt(i))) i++;
    if (i >= n) break;
    const start = i;
    // a possessive or a contraction is the word in front of it
    let cut = -1;
    let joined = false;
    while (i < n) {
      const c = lower.charCodeAt(i);
      if (wordCode(c)) {
        i++;
        continue;
      }
      if (!joiner(c) || i + 1 >= n || !wordCode(lower.charCodeAt(i + 1))) break;
      if (c === APOSTROPHE || c === CURLY_APOSTROPHE) {
        if (cut < 0) cut = i;
      } else if (cut < 0) {
        joined = true;
      }
      i++;
    }
    const token = lower.slice(start, cut < 0 ? i : cut);
    if (!joined) {
      if (keep(token)) visit(stem(token), start);
      continue;
    }
    if (keep(token)) visit(token, start);
    for (const part of token.split(PART)) if (keep(part)) visit(stem(part), start);
  }
}

/** A query's words, folded, each once, in the order they were asked. */
export function queryTerms(query: string, max = 32): string[] {
  const seen = new Set<string>();
  eachTerm(query ?? "", (term) => {
    if (seen.size < max) seen.add(term);
  }, 4_000);
  return [...seen];
}

export interface IndexedDoc {
  id: string;
  at: number;
  /** Words kept, which is what length normalisation measures. */
  len: number;
  /** The words as written. The same string the store holds, so keeping
   * it here costs nothing, and it is what a hit is cut from. */
  text: string;
}

/** One conversation's words, ready to score. */
export class TermIndex {
  docs: IndexedDoc[] = [];
  byId = new Map<string, number>();
  /** Each word to the documents holding it, as document * 32 + count. */
  postings = new Map<string, number[]>();
  totalLen = 0;
  /** How many postings this holds, which is what IndexCache budgets. */
  size = 0;

  add(id: string, at: number, text: string): void {
    if (this.byId.has(id)) return;
    const doc = this.docs.length;
    // Documents only ever arrive in order, so a word already seen in this
    // one is the last entry on its list: counting happens in place, with
    // one lookup a word and no map of counts per message.
    const first = doc * TF_SLOTS + 1;
    let len = 0;
    let added = 0;
    eachTerm(text, (term) => {
      len++;
      const list = this.postings.get(term);
      if (!list) {
        this.postings.set(term, [first]);
        added++;
        return;
      }
      const last = list[list.length - 1];
      if (last < first) {
        list.push(first);
        added++;
      } else if (last - first < TF_SLOTS - 2) {
        list[list.length - 1] = last + 1;
      }
    });
    this.docs.push({ id, at, len, text });
    this.byId.set(id, doc);
    this.totalLen += len;
    this.size += added;
  }

  /**
   * A document already written has changed. New words (a queued message
   * that has now been said) are added; the same words at another time
   * (a reaction, a delivery) only move the time. Anything else, an edit
   * or a deletion, cannot be taken back out of the postings cheaply, so
   * this says false and the caller drops the index to be built again.
   */
  update(id: string, at: number, text: string | null): boolean {
    const doc = this.byId.get(id);
    if (doc === undefined) {
      if (text) this.add(id, at, text);
      return true;
    }
    if (text !== this.docs[doc].text) return false;
    this.docs[doc].at = at;
    return true;
  }
}

export interface Ranked {
  /** Which of the indexes searched, by position. */
  source: number;
  doc: IndexedDoc;
  score: number;
  /** How many of the query's words it holds. */
  matched: number;
  /** The share of the query's weight it holds: its words, each weighted
   * by how rare it is. 1 when it has every word the corpus knows. */
  strength: number;
  /** Where in the text the words sit closest, for cutting an excerpt. */
  focus: number;
}

export interface RankOptions {
  limit?: number;
  now?: number;
  /** How many of the query's words a hit has to hold, given how many
   * were scored. One by default. */
  need?: (terms: number) => number;
  /** Below this strength a document is not a hit. */
  minStrength?: number;
  /** Below this final score a document is not a hit. */
  minScore?: number;
  /** Documents never to return, decided before anything is cut. */
  skip?: (source: number, doc: IndexedDoc) => boolean;
}

/**
 * The best documents for `query` across `sources`, which together are
 * the corpus: how rare a word is, and how long a message usually is, are
 * read over all of them, so each agent's ranking is about its own past.
 */
export function rank(query: string, sources: readonly TermIndex[], options: RankOptions = {}): Ranked[] {
  const asked = queryTerms(query);
  if (!asked.length) return [];
  let docs = 0;
  let length = 0;
  for (const source of sources) {
    docs += source.docs.length;
    length += source.totalLen;
  }
  if (!docs) return [];
  const avg = Math.max(1, length / docs);

  // A word the corpus has never seen cannot be matched, so it neither
  // scores nor weighs; past the cap only the rarest words are kept, in
  // the order they were asked, so a long message is read by what makes
  // it particular rather than by how it opens.
  const known = asked
    .map((term) => {
      let df = 0;
      for (const source of sources) df += source.postings.get(term)?.length ?? 0;
      return { term, df, idf: Math.log(1 + (docs - df + 0.5) / (df + 0.5)) };
    })
    .filter((t) => t.df > 0);
  const scored = known.length > MAX_QUERY_TERMS
    ? new Set([...known].sort((a, b) => b.idf - a.idf).slice(0, MAX_QUERY_TERMS))
    : null;
  const terms = scored ? known.filter((t) => scored.has(t)) : known;
  if (!terms.length) return [];
  const weight = terms.reduce((sum, t) => sum + t.idf, 0);
  const need = Math.max(1, Math.min(terms.length, Math.ceil(options.need?.(terms.length) ?? 1)));
  const now = options.now ?? Date.now();

  const pool: Array<{ source: number; doc: IndexedDoc; base: number; matched: number; strength: number }> = [];
  sources.forEach((source, s) => {
    let score: Float64Array | null = null;
    let matched: Uint8Array | null = null;
    let mass: Float64Array | null = null;
    for (const { term, idf } of terms) {
      const list = source.postings.get(term);
      if (!list) continue;
      if (!score) {
        score = new Float64Array(source.docs.length);
        matched = new Uint8Array(source.docs.length);
        mass = new Float64Array(source.docs.length);
      }
      for (const entry of list) {
        const d = Math.floor(entry / TF_SLOTS);
        const tf = entry % TF_SLOTS;
        score[d] += (idf * tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * source.docs[d].len) / avg));
        matched![d]++;
        mass![d] += idf;
      }
    }
    if (!score) return;
    for (let d = 0; d < score.length; d++) {
      if (matched![d] < need) continue;
      const strength = mass![d] / weight;
      if (strength < (options.minStrength ?? 0)) continue;
      const doc = source.docs[d];
      if (options.skip?.(s, doc)) continue;
      pool.push({ source: s, doc, base: score[d] * recency(doc.at, now), matched: matched![d], strength });
    }
  });

  // Closeness costs a pass over each document's words, so only the ones
  // already near the top are read again for it.
  const limit = Math.max(1, options.limit ?? 8);
  pool.sort((a, b) => b.base - a.base || b.doc.at - a.doc.at);
  const order = terms.map((t) => t.term);
  const ranked: Ranked[] = pool.slice(0, Math.max(40, limit * 4)).map((hit) => {
    const near = closeness(hit.doc.text, order);
    const bonus = near.phrase ? PHRASE_BONUS : order.length > 1 && near.best > 1 ? (NEAR_BONUS * (near.best - 1)) / (order.length - 1) : 0;
    return { source: hit.source, doc: hit.doc, score: hit.base * (1 + bonus), matched: hit.matched, strength: hit.strength, focus: near.focus };
  });
  return ranked
    .filter((hit) => hit.score >= (options.minScore ?? 0))
    .sort((a, b) => b.score - a.score || b.doc.at - a.doc.at)
    .slice(0, limit);
}

function recency(at: number, now: number): number {
  const age = Math.max(0, now - at);
  return 1 + RECENCY_WEIGHT * 0.5 ** (age / RECENCY_HALF_LIFE);
}

/**
 * How close the query's words sit in one text: whether they appear in the
 * order asked and side by side, the most distinct ones inside any window
 * of NEAR_WINDOW words, and where that window starts.
 */
export function closeness(text: string, terms: readonly string[]): { phrase: boolean; best: number; focus: number } {
  const slot = new Map(terms.map((term, i) => [term, i]));
  const seq: number[] = [];
  const offsets: number[] = [];
  eachTerm(text, (term, at) => {
    seq.push(slot.get(term) ?? -1);
    offsets.push(at);
  });
  let best = 0;
  let focus = -1;
  let phrase = false;
  for (let i = 0; i < seq.length; i++) {
    if (seq[i] < 0) continue;
    if (focus < 0) focus = offsets[i];
    if (!phrase && terms.length > 1 && seq[i] === 0) {
      let run = 1;
      while (run < terms.length && seq[i + run] === run) run++;
      if (run === terms.length) {
        phrase = true;
        best = terms.length;
        focus = offsets[i];
      }
    }
    if (phrase) continue;
    let seen = 0;
    let distinct = 0;
    for (let j = i; j < Math.min(seq.length, i + NEAR_WINDOW); j++) {
      const t = seq[j];
      if (t < 0 || t > 30 || seen & (1 << t)) continue;
      seen |= 1 << t;
      distinct++;
    }
    if (distinct > best) {
      best = distinct;
      focus = offsets[i];
    }
  }
  return { phrase, best, focus: Math.max(0, focus) };
}

/**
 * At most `max` characters of `text` around `focus`, cut at spaces, with
 * an ellipsis where something was left off, and whitespace flattened.
 */
export function excerpt(text: string, focus: number, max: number): string {
  const flat = (s: string) => s.replace(/\s+/g, " ").trim();
  const whole = flat(text);
  if (whole.length <= max) return whole;
  // room for an ellipsis at either end
  const room = Math.max(1, max - 2);
  let start = Math.max(0, Math.min(focus - Math.floor(room / 4), text.length - room));
  if (start > 0) {
    const space = text.indexOf(" ", start);
    if (space > 0 && space - start < 40) start = space + 1;
  }
  let end = Math.min(text.length, start + room);
  if (end < text.length) {
    const space = text.lastIndexOf(" ", end);
    if (space > start + room / 2) end = space;
  }
  const before = text.slice(0, start).trim() ? "…" : "";
  const after = text.slice(end).trim() ? "…" : "";
  return `${before}${flat(text.slice(start, end))}${after}`;
}

/** What the index cache holds at most, in postings, before the ones
 * searched longest ago go. Each is a few bytes, so this is tens of
 * megabytes at worst, far less than the transcripts themselves. */
export const INDEX_BUDGET = 3_000_000;

/**
 * Indexes by key (a thread id, or a memory file), built when first asked
 * for and kept while they fit the budget. A `stamp` that no longer
 * matches (a memory file's size and time) builds the index again.
 */
export class IndexCache {
  private entries = new Map<string, { index: TermIndex; stamp?: string }>();
  private budget: number;

  constructor(budget = INDEX_BUDGET) {
    this.budget = budget;
  }

  get(key: string, build: () => TermIndex, stamp?: string): TermIndex {
    const hit = this.entries.get(key);
    // read again, it moves to the newest end
    this.entries.delete(key);
    if (hit && hit.stamp === stamp) {
      this.entries.set(key, hit);
      return hit.index;
    }
    const index = build();
    this.entries.set(key, { index, stamp });
    return index;
  }

  /** Only what is already built: growing an index nobody has searched
   * would be paying for it before anyone needs it. */
  peek(key: string): TermIndex | undefined {
    return this.entries.get(key)?.index;
  }

  drop(key: string): void {
    this.entries.delete(key);
  }

  get size(): number {
    let total = 0;
    for (const { index } of this.entries.values()) total += index.size;
    return total;
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  /** Back under budget, oldest first, never one of `using`: a search
   * that needs more than the budget holds it only while it runs. */
  trim(using: ReadonlySet<TermIndex> = new Set()): void {
    let total = this.size;
    for (const [key, { index }] of this.entries) {
      if (total <= this.budget) break;
      if (using.has(index)) continue;
      this.entries.delete(key);
      total -= index.size;
    }
  }
}
