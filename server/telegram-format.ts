// An agent's reply, as messages Telegram will take.
//
// Two things stand between a reply and a phone. Telegram refuses a
// message over 4096 characters, so a long answer has to go as several,
// in order, rather than losing its tail. And agents write Markdown,
// which Telegram shows as asterisks and brackets unless it is turned
// into the HTML its parse_mode reads.
//
// Both are done from one reading of the text. The reply is parsed into
// runs that each have one look (bold, code, a link) before anything is
// cut, so a cut can only fall between runs or split one run into two
// with the same look. Every message closes what it opens, and a link
// cut in half is two links to the same place, never a label in one
// message and its target in the next.

/** Under Telegram's 4096, which it counts after the markup is read. Every
 * size here is measured on the plain text with links written out, which
 * is never shorter than what Telegram counts, so either form fits. */
export const MESSAGE_CHARS = 4_000;

/** A run of text with one look. A link is a run with somewhere to go. */
interface Run {
  text: string;
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  code?: boolean;
  url?: string;
}

type Look = Omit<Run, "text">;

type Item =
  | { kind: "line"; runs: Run[] }
  | { kind: "blank" }
  | { kind: "code"; lang: string; lines: string[] };

/** A paragraph or a code block: what is kept together when it can be.
 * `gap` says a blank line stood before it, so one is put back. */
interface Unit {
  items: Item[];
  gap: boolean;
}

export interface Chunk {
  /** For parse_mode HTML. Absent when the text was not Markdown. */
  html?: string;
  /** The same words with no markup and every link's address written out,
   * for when Telegram will not take the HTML. */
  plain: string;
}

const BLANK: Item = { kind: "blank" };

// ── reading Markdown ───────────────────────────────────────────────────

const LINK = /^\[([^\]\n]+)\]\(\s*((?:https?:\/\/|mailto:|tg:\/\/)[^\s)]+)\s*\)/i;
const ESCAPABLE = /[!-/:-@[-`{-~]/;
const WORD = /[\p{L}\p{N}]/u;
const SPACE = /\s/;

/** How many of `char` there are in a row from `at`. */
function runOf(source: string, at: number, char: string): number {
  let n = 0;
  while (source[at + n] === char) n++;
  return n;
}

/**
 * Where an emphasis marker opened at `at` closes, or -1 when it does not.
 *
 * The rules are the ones people expect from chat apps rather than the
 * whole CommonMark algorithm: the words inside may not start or end with
 * a space, and an underscore inside a word is part of the word, so
 * snake_case_names stay as they are.
 */
function closes(source: string, at: number, marker: string): number {
  const char = marker[0]!;
  const start = at + marker.length;
  const first = source[start];
  if (!first || SPACE.test(first)) return -1;
  if (char === "_" && at > 0 && WORD.test(source[at - 1]!)) return -1;
  let j = source.indexOf(marker, start + 1);
  while (j >= 0) {
    const run = runOf(source, j, char);
    // A single marker passes over doubled ones, which belong to bold
    // inside it. A double marker closes on the last two of a longer run,
    // so ***both*** reads as bold around italic.
    if (marker.length === 1 && run > 1) {
      j = source.indexOf(marker, j + run);
      continue;
    }
    if (marker.length === 2) j += run - 2;
    const next = source[j + marker.length];
    const fine = !SPACE.test(source[j - 1]!) && !(char === "_" && next && WORD.test(next));
    if (fine) return j;
    j = source.indexOf(marker, j + marker.length);
  }
  return -1;
}

/** One line's worth of inline Markdown, as runs. */
function inline(source: string, look: Look = {}): Run[] {
  const out: Run[] = [];
  let text = "";
  const settle = () => {
    if (text) out.push({ ...look, text });
    text = "";
  };
  let i = 0;
  while (i < source.length) {
    const char = source[i]!;
    if (char === "\\" && ESCAPABLE.test(source[i + 1] ?? "")) {
      text += source[i + 1];
      i += 2;
      continue;
    }
    if (char === "`") {
      const fence = runOf(source, i, "`");
      // Closed only by a run of the same length, so ``a ` b`` keeps its
      // single backtick inside.
      let end = -1;
      for (let j = source.indexOf("`", i + fence); j >= 0; ) {
        const run = runOf(source, j, "`");
        if (run === fence) {
          end = j;
          break;
        }
        j = source.indexOf("`", j + run);
      }
      if (end >= 0) {
        let inside = source.slice(i + fence, end);
        if (inside.length > 2 && inside.startsWith(" ") && inside.endsWith(" ")) inside = inside.slice(1, -1);
        settle();
        if (inside) out.push({ ...look, text: inside, code: true });
        i = end + fence;
        continue;
      }
      text += "`".repeat(fence);
      i += fence;
      continue;
    }
    if (char === "[" && !look.url) {
      const link = LINK.exec(source.slice(i));
      if (link) {
        settle();
        out.push(...inline(link[1]!, { ...look, url: link[2]! }));
        i += link[0].length;
        continue;
      }
    }
    const marker =
      source.startsWith("**", i) || source.startsWith("__", i)
        ? source.slice(i, i + 2)
        : source.startsWith("~~", i)
          ? "~~"
          : char === "*" || char === "_"
            ? char
            : "";
    if (marker) {
      const end = closes(source, i, marker);
      if (end >= 0) {
        settle();
        const style: Look =
          marker === "~~" ? { strike: true } : marker.length === 2 ? { bold: true } : { italic: true };
        out.push(...inline(source.slice(i + marker.length, end), { ...look, ...style }));
        i = end + marker.length;
        continue;
      }
      // Not emphasis after all: the whole run is ordinary text, so the
      // second star of ** is not tried again as an opening of its own.
      const run = runOf(source, i, char);
      text += source.slice(i, i + run);
      i += run;
      continue;
    }
    text += char;
    i++;
  }
  settle();
  return out;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)/;
const HEADING = /^ {0,3}#{1,6}\s+(.*?)\s*#*\s*$/;
const BULLET = /^(\s*)[-*+]\s+(.*)$/;

/** A line of prose, with headings and bullets put the way a chat shows
 * them: Telegram has neither, so a heading is bold and a bullet is a dot. */
function line(source: string): Item {
  const heading = HEADING.exec(source);
  if (heading) return { kind: "line", runs: inline(heading[1]!, { bold: true }) };
  const bullet = BULLET.exec(source);
  if (bullet) return { kind: "line", runs: [{ text: `${bullet[1]}• ` }, ...inline(bullet[2]!)] };
  return { kind: "line", runs: inline(source) };
}

/** The text, read into paragraphs and code blocks. Text that is not
 * Markdown is read as lines and nothing else. */
function units(text: string, markdown: boolean): Unit[] {
  const out: Unit[] = [];
  let paragraph: Item[] = [];
  let paragraphGap = false;
  let blank = false;
  const end = () => {
    if (paragraph.length) out.push({ items: paragraph, gap: paragraphGap });
    paragraph = [];
  };
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const source = lines[i]!;
    if (!source.trim()) {
      end();
      blank = true;
      continue;
    }
    const fence = markdown ? FENCE.exec(source) : null;
    if (fence) {
      end();
      const marker = fence[1]!;
      const lang = /^[\w#+.-]{1,32}$/.test(fence[2]!) ? fence[2]! : "";
      const code: string[] = [];
      // An unclosed fence runs to the end, which is how every renderer
      // reads it, and better than showing the rest as prose.
      for (i++; i < lines.length; i++) {
        const closing = lines[i]!.trim();
        if (closing.startsWith(marker) && runOf(closing, 0, marker[0]!) === closing.length) break;
        code.push(lines[i]!);
      }
      if (code.join("").trim()) out.push({ items: [{ kind: "code", lang, lines: code }], gap: blank });
      blank = false;
      continue;
    }
    if (!paragraph.length) {
      paragraphGap = blank;
      blank = false;
    }
    paragraph.push(markdown ? line(source) : { kind: "line", runs: [{ text: source }] });
  }
  end();
  return out;
}

// ── sizes and cuts ─────────────────────────────────────────────────────

/** A link written out in plain text: its words, then where it goes. */
function plainRun(run: Run): string {
  return run.url && run.url !== run.text ? `${run.text} (${run.url})` : run.text;
}

function width(item: Item): number {
  if (item.kind === "blank") return 0;
  if (item.kind === "code") return item.lines.join("\n").length;
  return item.runs.reduce((sum, run) => sum + plainRun(run).length, 0);
}

/** A cut at `at` that does not part the two halves of an emoji or any
 * other character that takes two units to write. */
function safe(text: string, at: number): number {
  const code = text.charCodeAt(at - 1);
  return at > 1 && code >= 0xd800 && code <= 0xdbff ? at - 1 : at;
}

/** The last space at or before `upto`, or -1. */
function lastSpace(text: string, upto: number): number {
  for (let i = Math.min(upto, text.length - 1); i >= 0; i--) if (SPACE.test(text[i]!)) return i;
  return -1;
}

/** Split run `index` at `at`, dropping the space there when `drop`. */
function splitRuns(runs: Run[], index: number, at: number, drop: boolean): [Run[], Run[]] {
  const run = runs[index]!;
  const head = run.text.slice(0, at);
  const tail = run.text.slice(at + (drop ? 1 : 0));
  return [
    [...runs.slice(0, index), ...(head ? [{ ...run, text: head }] : [])],
    [...(tail ? [{ ...run, text: tail }] : []), ...runs.slice(index + 1)],
  ];
}

/**
 * A line too long for the room left, cut to fit: at the last space that
 * fits if there is one, else between runs, else through a word.
 */
function cutLine(runs: Run[], room: number): [Run[], Run[]] {
  let used = 0;
  let best: [index: number, at: number] | null = null;
  for (let index = 0; index < runs.length; index++) {
    const run = runs[index]!;
    const extra = plainRun(run).length - run.text.length;
    const fits = room - used - extra;
    if (fits >= run.text.length) {
      const space = lastSpace(run.text, run.text.length - 1);
      if (space > 0 || (space === 0 && index > 0)) best = [index, space];
      used += plainRun(run).length;
      continue;
    }
    if (fits > 0) {
      const space = lastSpace(run.text, fits);
      if (space > 0 || (space === 0 && index > 0)) best = [index, space];
    }
    if (best) return splitRuns(runs, best[0], best[1], true);
    if (index > 0) return [runs.slice(0, index), runs.slice(index)];
    return splitRuns(runs, 0, safe(run.text, Math.max(1, fits)), false);
  }
  return [runs, []];
}

/** As much of a code block as fits, as a block of its own, and the rest.
 * A line longer than a whole message goes on in the next one's block. */
function cutCode(item: Extract<Item, { kind: "code" }>, room: number): [Item, Item] {
  let size = 0;
  let n = 0;
  for (const text of item.lines) {
    const next = text.length + (n ? 1 : 0);
    if (size + next > room) break;
    size += next;
    n++;
  }
  if (n > 0) return [{ ...item, lines: item.lines.slice(0, n) }, { ...item, lines: item.lines.slice(n) }];
  const first = item.lines[0]!;
  const at = safe(first, room);
  return [
    { ...item, lines: [first.slice(0, at)] },
    { ...item, lines: [first.slice(at), ...item.lines.slice(1)] },
  ];
}

function cut(item: Item, room: number): [Item, Item] {
  if (item.kind === "code") return cutCode(item, room);
  if (item.kind === "blank") return [item, item];
  const [head, tail] = cutLine(item.runs, room);
  return [
    { kind: "line", runs: head },
    { kind: "line", runs: tail },
  ];
}

/**
 * Units into messages, in order, none over `limit`.
 *
 * A paragraph that would straddle two messages starts the next one when
 * it fits there whole, so a break falls between paragraphs where it can.
 * One too long for any message is laid in line by line, and a line too
 * long for one is cut where a space allows.
 */
function pack(all: Unit[], limit: number): Item[][] {
  const out: Item[][] = [];
  let current: Item[] = [];
  let used = 0;
  const room = () => limit - used - (current.length ? 1 : 0);
  const add = (item: Item) => {
    used += (current.length ? 1 : 0) + width(item);
    current.push(item);
  };
  const flush = () => {
    while (current.at(-1)?.kind === "blank") current.pop();
    if (current.length) out.push(current);
    current = [];
    used = 0;
  };
  // Less room than this at the end of a message is not worth starting a
  // long line in; it reads better from the top of the next.
  const worth = Math.floor(limit / 4);
  const place = (item: Item) => {
    if (width(item) <= room()) return add(item);
    if (width(item) <= limit) {
      flush();
      return add(item);
    }
    let rest = item;
    for (;;) {
      if (room() < worth) flush();
      if (width(rest) <= room()) return add(rest);
      const [head, tail] = cut(rest, room());
      add(head);
      flush();
      rest = tail;
    }
  };
  for (const unit of all) {
    const size = unit.items.reduce((sum, item, i) => sum + width(item) + (i ? 1 : 0), 0);
    const gap = current.length > 0 && unit.gap;
    if (size + (gap ? 1 : 0) <= room()) {
      if (gap) add(BLANK);
      unit.items.forEach(add);
      continue;
    }
    if (size <= limit) {
      flush();
      unit.items.forEach(add);
      continue;
    }
    if (gap && room() > 0) add(BLANK);
    unit.items.forEach(place);
  }
  flush();
  return out;
}

// ── writing it out ─────────────────────────────────────────────────────

function escape(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** One run as Telegram HTML. Each run opens and closes its own tags, so
 * no run can leave anything open for the next message to inherit. */
function htmlRun(run: Run): string {
  let out = escape(run.text);
  if (run.code) out = `<code>${out}</code>`;
  if (run.italic) out = `<i>${out}</i>`;
  if (run.bold) out = `<b>${out}</b>`;
  if (run.strike) out = `<s>${out}</s>`;
  if (run.url) out = `<a href="${escape(run.url).replaceAll('"', "&quot;")}">${out}</a>`;
  return out;
}

function htmlItem(item: Item): string {
  if (item.kind === "blank") return "";
  if (item.kind === "line") return item.runs.map(htmlRun).join("");
  const code = escape(item.lines.join("\n"));
  return item.lang ? `<pre><code class="language-${item.lang}">${code}</code></pre>` : `<pre>${code}</pre>`;
}

function plainItem(item: Item): string {
  if (item.kind === "blank") return "";
  if (item.kind === "line") return item.runs.map(plainRun).join("");
  return item.lines.join("\n");
}

/**
 * A reply as the messages that carry it, in order.
 *
 * With `markdown`, each message comes as Telegram HTML and as plain text
 * to fall back on. Without, it is the text as written, only split.
 */
export function messages(text: string, markdown: boolean, limit = MESSAGE_CHARS): Chunk[] {
  return pack(units(text, markdown), limit)
    .map((items) => ({
      plain: items.map(plainItem).join("\n"),
      ...(markdown ? { html: items.map(htmlItem).join("\n") } : {}),
    }))
    .filter((chunk) => chunk.plain.trim());
}
