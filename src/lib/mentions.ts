// The composer's @ list in an agent's conversation: which of the person's
// other conversations and which tabs of the Bloks browser match what is
// being typed, and how a chip lives in the words.
//
// In the box a chip is its label after an @, "@Launch plan", marked
// behind the text the way a skill is, and a small table beside the words
// says what each label points at. On the way out each chip becomes a
// Markdown link, `[@Launch plan](bloks://agent/<agent>?lane=<lane>)` or
// `[@Pricing](https://example.com/pricing)`, which is all the server
// reads (server/mentions.ts, which writes and reads the same shape), and
// which the iPhone app draws as the label and opens on a tap. Words that
// come back to the box (a rewind, a failed send) turn back into chips.
//
// Kept apart from the component so it can be tested without a DOM.
import { t } from "./i18n.ts";

export interface Mention {
  kind: "conversation" | "tab";
  /** What follows the @ in the box, and the link's words on the way out. */
  label: string;
  href: string;
}

/** A conversation the list can offer. */
export interface ConversationOption {
  botId: string;
  laneId: string;
  agent: string;
  title: string;
  /** This conversation's own agent, listed first. */
  own: boolean;
  /** The agent's first conversation, which is the agent to the person
   * more than it is a title: most are called General. */
  first?: boolean;
  lastAt: number;
}

/** A tab the list can offer. */
export interface TabOption {
  id: string;
  url: string;
  title: string;
  host: string;
}

export type MentionOption =
  | ({ kind: "conversation" } & ConversationOption)
  | ({ kind: "tab" } & TabOption);

/** The longest label a chip carries, as the server keeps it. */
export const LABEL_MAX = 80;
/** How many of each the list shows at once. */
export const LIST_LIMIT = { conversations: 6, tabs: 6 } as const;
/** Past this many characters after the @, it is a sentence, not a name. */
const QUERY_MAX = 40;

const LINK = /\[@((?:\\[\s\S]|[^\]\\\n])+)\]\(((?:bloks:\/\/agent\/|https?:\/\/)[^\s)]+)\)/g;

/** A conversation's link, the shape the iPhone app opens one by. */
export function conversationHref(botId: string, laneId: string): string {
  return `bloks://agent/${encodeURIComponent(botId)}?lane=${encodeURIComponent(laneId)}`;
}

/** Where a chip's link goes: one of the person's conversations, or a page. */
export function hrefTarget(href: string): { kind: "conversation"; botId: string; laneId: string } | { kind: "tab"; url: string } | null {
  const ours = href.match(/^bloks:\/\/agent\/([\w-]{1,80})\?lane=([\w-]{1,80})$/);
  if (ours) return { kind: "conversation", botId: ours[1]!, laneId: ours[2]! };
  try {
    const url = new URL(href);
    return url.protocol === "http:" || url.protocol === "https:" ? { kind: "tab", url: url.href } : null;
  } catch {
    return null;
  }
}

/** A label as a chip carries it: one line, short. */
export function cleanLabel(label: string): string {
  return label.replace(/\s+/g, " ").trim().slice(0, LABEL_MAX).trim();
}

/** The label for a conversation: its title, with its agent's name in
 * front when it is another agent's, so "General" says whose. */
export function conversationLabel(option: Pick<ConversationOption, "agent" | "title" | "own" | "first">): string {
  if (option.own) return cleanLabel(option.title);
  return cleanLabel(option.first ? option.agent : `${option.agent}: ${option.title}`);
}

/** A label no other chip in the words has for something else: two tabs
 * called "Inbox" become "Inbox" and "Inbox (2)". */
export function uniqueLabel(label: string, href: string, mentions: readonly Mention[]): string {
  const taken = new Set(mentions.filter((m) => m.href !== href).map((m) => m.label.toLowerCase()));
  if (!taken.has(label.toLowerCase())) return label;
  for (let n = 2; ; n++) {
    const next = `${label} (${n})`;
    if (!taken.has(next.toLowerCase())) return next;
  }
}

/** Where each chip is in the words: an @ and a known label, at the start
 * of a word and ending one, longest labels first, each span once. */
export function chipRanges(text: string, mentions: readonly Mention[]): Array<{ start: number; end: number; mention: Mention }> {
  const lower = text.toLowerCase();
  const taken: Array<{ start: number; end: number; mention: Mention }> = [];
  for (const mention of [...mentions].sort((a, b) => b.label.length - a.label.length)) {
    const needle = `@${mention.label.toLowerCase()}`;
    for (let at = lower.indexOf(needle); at !== -1; at = lower.indexOf(needle, at + 1)) {
      const end = at + needle.length;
      const before = text[at - 1];
      const after = text[end];
      if (before !== undefined && !/[\s([{"'“‘]/.test(before)) continue;
      if (after !== undefined && /[\p{L}\p{N}_]/u.test(after)) continue;
      if (taken.some((r) => at < r.end && end > r.start)) continue;
      taken.push({ start: at, end, mention });
    }
  }
  return taken.sort((a, b) => a.start - b.start);
}

/** The words cut into plain runs and chips, every character in exactly
 * one run, so runs laid over the textarea line up with what is typed. */
export function chipRuns(text: string, mentions: readonly Mention[]): Array<{ text: string; mention?: Mention }> {
  const out: Array<{ text: string; mention?: Mention }> = [];
  let from = 0;
  for (const range of chipRanges(text, mentions)) {
    if (range.start > from) out.push({ text: text.slice(from, range.start) });
    out.push({ text: text.slice(range.start, range.end), mention: range.mention });
    from = range.end;
  }
  if (from < text.length) out.push({ text: text.slice(from) });
  return out;
}

/** The chip a Backspace at `caret` takes whole: one that ends there.
 * Forward Delete takes one that starts there. */
export function chipAt(text: string, caret: number, mentions: readonly Mention[], direction: "back" | "forward"): { start: number; end: number } | null {
  for (const range of chipRanges(text, mentions)) {
    if (direction === "back" && range.end === caret) return { start: range.start, end: range.end };
    if (direction === "forward" && range.start === caret) return { start: range.start, end: range.end };
  }
  return null;
}

/** Only the mentions whose chip is still in the words. */
export function keptMentions(text: string, mentions: readonly Mention[]): Mention[] {
  const used = new Set(chipRanges(text, mentions).map((r) => r.mention));
  return mentions.filter((m) => used.has(m));
}

/**
 * The `@words` being typed at the caret, or null. An @ counts at the
 * start of a word, so an address like a@b.com never opens the list, and
 * not on a chip already there. The words may hold spaces, since titles
 * do, but not a line break or another @.
 */
export function mentionAt(text: string, caret: number, mentions: readonly Mention[] = []): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const start = before.lastIndexOf("@");
  if (start === -1) return null;
  if (start > 0 && !/\s/.test(before[start - 1]!)) return null;
  const query = before.slice(start + 1);
  if (query.length > QUERY_MAX || /[\n@]/.test(query)) return null;
  if (chipRanges(text, mentions).some((r) => r.start === start && caret <= r.end + 1)) return null;
  return { start, query };
}

/** The words with the half-typed @words replaced by a chip, and where the
 * caret goes after it: past the space that follows, ready for more. */
export function insertMention(text: string, start: number, end: number, label: string): { text: string; caret: number } {
  const after = text.slice(end);
  const spaced = after.startsWith(" ") ? "" : " ";
  return { text: `${text.slice(0, start)}@${label}${spaced}${after}`, caret: start + label.length + 2 };
}

/** How well some words match what was typed, higher is better, -1 for
 * none: a word that starts with it, then words containing it, then its
 * letters in order. */
function score(fields: string[], query: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 1;
  let best = -1;
  for (const [i, raw] of fields.entries()) {
    const field = raw.toLowerCase();
    const weight = i === 0 ? 1 : 0.9;
    if (field.startsWith(q) || field.split(/[\s:·|/-]+/).some((word) => word.startsWith(q))) best = Math.max(best, 300 * weight - field.length / 100);
    else if (field.includes(q)) best = Math.max(best, 200 * weight - field.indexOf(q) / 100);
    else if (inOrder(field, q.replace(/\s+/g, ""))) best = Math.max(best, 100 * weight - field.length / 100);
  }
  return best;
}

function inOrder(field: string, q: string): boolean {
  let at = 0;
  for (const ch of field) if (ch === q[at]) at++;
  return at === q.length;
}

/**
 * What the list shows for what was typed, in the order it draws it and
 * the arrow keys walk it: conversations, this agent's first and then the
 * rest, most recent first within each when nothing is typed and best
 * match first when something is; then the browser's tabs.
 */
export function mentionOptions(
  conversations: readonly ConversationOption[],
  tabs: readonly TabOption[],
  query: string,
): MentionOption[] {
  const rank = <T,>(items: readonly T[], fields: (item: T) => string[], tie: (a: T, b: T) => number) =>
    items
      .map((item) => ({ item, s: score(fields(item), query) }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => b.s - a.s || tie(a.item, b.item))
      .map((x) => x.item);
  const ownFirst = (a: ConversationOption, b: ConversationOption) => Number(b.own) - Number(a.own) || b.lastAt - a.lastAt;
  const found = rank(conversations, (c) => [c.title, c.agent], ownFirst);
  // nothing typed, the conversations read as the sidebar does: this
  // agent's, then the rest, newest first
  const ordered = query.trim() ? found : [...found].sort(ownFirst);
  return [
    ...ordered.slice(0, LIST_LIMIT.conversations).map((c) => ({ kind: "conversation" as const, ...c })),
    ...rank(tabs, (tab) => [tab.title, tab.host, tab.url], () => 0)
      .slice(0, LIST_LIMIT.tabs)
      .map((tab) => ({ kind: "tab" as const, ...tab })),
  ];
}

/** The chip an option becomes. */
export function mentionOf(option: MentionOption): Mention {
  if (option.kind === "conversation") return { kind: "conversation", label: conversationLabel(option), href: conversationHref(option.botId, option.laneId) };
  return { kind: "tab", label: cleanLabel(option.title || option.host || t("mentions.untitledTab")), href: option.url };
}

const escapeLabel = (label: string) => label.replace(/([\[\]\\])/g, "\\$1");
const unescapeLabel = (raw: string) => raw.replace(/\\([\[\]\\])/g, "$1");

/** The words as they are sent: every chip a link. */
export function outgoing(text: string, mentions: readonly Mention[]): string {
  let out = "";
  let from = 0;
  for (const range of chipRanges(text, mentions)) {
    out += `${text.slice(from, range.start)}[@${escapeLabel(range.mention.label)}](${range.mention.href})`;
    from = range.end;
  }
  return out + text.slice(from);
}

/** Sent words back in the box: every link a chip again. */
export function incoming(text: string): { text: string; mentions: Mention[] } {
  const mentions: Mention[] = [];
  const words = text.replace(LINK, (whole, raw: string, href: string) => {
    const target = hrefTarget(href);
    if (!target) return whole;
    const label = uniqueLabel(cleanLabel(unescapeLabel(raw)), href, mentions);
    if (!mentions.some((m) => m.href === href && m.label === label)) mentions.push({ kind: target.kind, label, href });
    return `@${label}`;
  });
  return { text: words, mentions };
}

/** A sent message's words cut into plain runs and chips, for the bubble. */
export function messageRuns(text: string): Array<{ text: string } | { mention: Mention }> {
  const out: Array<{ text: string } | { mention: Mention }> = [];
  let from = 0;
  for (const m of text.matchAll(LINK)) {
    const at = m.index ?? 0;
    const target = hrefTarget(m[2]!);
    if (!target) continue;
    if (at > from) out.push({ text: text.slice(from, at) });
    out.push({ mention: { kind: target.kind, label: unescapeLabel(m[1]!), href: m[2]! } });
    from = at + m[0].length;
  }
  if (from < text.length) out.push({ text: text.slice(from) });
  return out;
}

/** The words with each chip said as @label, for a copy or a preview. */
export function plainMentions(text: string): string {
  return text.replace(LINK, (whole, raw: string, href: string) => (hrefTarget(href) ? `@${unescapeLabel(raw)}` : whole));
}

/** The same page, whatever its fragment says. */
export function sameAddress(a: string, b: string): boolean {
  const key = (url: string) => {
    try {
      const parsed = new URL(url);
      parsed.hash = "";
      return parsed.href;
    } catch {
      return url;
    }
  };
  return key(a) === key(b);
}
