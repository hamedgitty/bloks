// The inline part of a reply's markdown: bold, code and links.
//
// Parsed into tokens rather than HTML, so a model's text only ever reaches
// the page as text nodes and elements the renderer chose. A link is the
// one place where model output becomes an attribute, so its target is
// held to a short list of schemes; anything else, javascript: first among
// them, stays on the page as the characters the model wrote.

export type InlineToken =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "bold"; children: InlineToken[] }
  | { kind: "link"; href: string; children: InlineToken[] };

/** The only link targets a reply can produce. mailto is not one: the Mac
 * shell hands only http(s) to the system browser, so a mail link would be
 * a link that does nothing when clicked. */
export function isSafeHref(href: string): boolean {
  return /^https?:\/\/[^\s/?#]/i.test(href);
}

/** Longer than any real label or link target. Caps the work a malformed
 * line can cost; the scans below are linear anyway. */
const MAX_LABEL = 1000;
const MAX_TARGET = 2048;

/** A bare URL, with none of the characters that end one in prose. It
 * also ends before "**", which closes the bold it sits in. */
const BARE = /https?:\/\/(?:[^\s<>"`*]|\*(?!\*))+/iy;

/** What starts a token. A bare URL must not continue a word, so
 * "foohttps://" and the url inside "[a](https://...)" are not seen here. */
const START = /`[^`]+`|\*\*[^*]+\*\*|\[|(?<![\w/@])https?:\/\//gi;

/**
 * Sentence punctuation after a bare URL belongs to the sentence, and a
 * closing bracket belongs to the URL only when the URL opened it, as in
 * Wikipedia's "Mercury_(planet)". Brackets are counted once, then trimmed
 * from the end, so a URL followed by a thousand ")" costs one pass.
 */
function trimBare(url: string): string {
  let open = 0;
  let close = 0;
  let openSquare = 0;
  let closeSquare = 0;
  for (const ch of url) {
    if (ch === "(") open++;
    else if (ch === ")") close++;
    else if (ch === "[") openSquare++;
    else if (ch === "]") closeSquare++;
  }
  let end = url.length;
  while (end > 0) {
    const last = url[end - 1];
    if (/[.,;:!?'*_~]/.test(last)) end--;
    else if (last === ")" && open < close) (end--, close--);
    else if (last === "]" && openSquare < closeSquare) (end--, closeSquare--);
    else break;
  }
  return url.slice(0, end);
}

/**
 * `[label](target)` at `at`, with balanced brackets in the target, or
 * nothing if it is not one or its target is not allowed.
 *
 * Neither scan passes a "[": a label cannot hold one, and a target that
 * holds one is refused. So each scan stops where the next candidate link
 * starts, and a line of "[x](" repeated costs one pass, not one per "[".
 */
function readLink(text: string, at: number): { label: string; href: string; end: number } | null {
  let close = -1;
  for (let j = at + 1; j < text.length && j <= at + 1 + MAX_LABEL; j++) {
    if (text[j] === "[") return null;
    if (text[j] === "]") {
      close = j;
      break;
    }
  }
  if (close <= at + 1 || text[close + 1] !== "(") return null;
  let depth = 0;
  const start = close + 2;
  for (let j = start; j < text.length && j <= start + MAX_TARGET; j++) {
    const ch = text[j];
    if (ch === "[" || ch === "]" || /\s/.test(ch)) return null;
    if (ch === "(") depth++;
    else if (ch === ")") {
      if (depth === 0) {
        const href = text.slice(start, j);
        return isSafeHref(href) ? { label: text.slice(at + 1, close), href, end: j + 1 } : null;
      }
      depth--;
    }
  }
  return null;
}

export function parseInline(text: string, links = true): InlineToken[] {
  const out: InlineToken[] = [];
  const pushText = (s: string) => {
    if (!s) return;
    const prev = out[out.length - 1];
    if (prev?.kind === "text") prev.text += s;
    else out.push({ kind: "text", text: s });
  };
  const re = new RegExp(START.source, START.flags);
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const at = m.index;
    const tok = m[0];
    if (tok.startsWith("`")) {
      pushText(text.slice(last, at));
      out.push({ kind: "code", text: tok.slice(1, -1) });
      last = at + tok.length;
    } else if (tok.startsWith("**")) {
      pushText(text.slice(last, at));
      out.push({ kind: "bold", children: parseInline(tok.slice(2, -2), links) });
      last = at + tok.length;
    } else if (tok === "[") {
      const link = links ? readLink(text, at) : null;
      if (!link) continue;
      pushText(text.slice(last, at));
      out.push({ kind: "link", href: link.href, children: parseInline(link.label, false) });
      last = link.end;
      re.lastIndex = link.end;
    } else {
      if (!links) continue;
      BARE.lastIndex = at;
      const raw = BARE.exec(text)?.[0] ?? "";
      const url = trimBare(raw);
      if (!isSafeHref(url)) {
        // Resume after the whole run, not inside it, or "https://?" repeated
        // rescans the rest of the line once per copy.
        re.lastIndex = at + Math.max(raw.length, 1);
        continue;
      }
      pushText(text.slice(last, at));
      out.push({ kind: "link", href: url, children: [{ kind: "text", text: url }] });
      last = at + url.length;
      re.lastIndex = last;
    }
  }
  pushText(text.slice(last));
  return out;
}
