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

/** The only link targets a reply can produce. */
export function isSafeHref(href: string): boolean {
  return /^https?:\/\/[^\s/?#]/i.test(href) || /^mailto:[^\s]+$/i.test(href);
}

/** A bare URL, with none of the characters that end one in prose. */
const BARE = /https?:\/\/[^\s<>"`]+/y;

/** What starts a token. A bare URL must not continue a word, so
 * "foohttps://" and the url inside "[a](https://...)" are not seen here. */
const START = /`[^`]+`|\*\*[^*]+\*\*|\[|(?<![\w/@])https?:\/\//g;

/**
 * Sentence punctuation after a bare URL belongs to the sentence, and a
 * closing bracket belongs to the URL only when the URL opened it, as in
 * Wikipedia's "Mercury_(planet)".
 */
function trimBare(url: string): string {
  for (;;) {
    const last = url[url.length - 1];
    if (/[.,;:!?'*_~]/.test(last)) url = url.slice(0, -1);
    else if (last === ")" && count(url, "(") < count(url, ")")) url = url.slice(0, -1);
    else if (last === "]" && count(url, "[") < count(url, "]")) url = url.slice(0, -1);
    else return url;
  }
}

function count(text: string, ch: string): number {
  return text.split(ch).length - 1;
}

/** `[label](target)` at `at`, with balanced brackets in the target, or
 * nothing if it is not one or its target is not allowed. */
function readLink(text: string, at: number): { label: string; href: string; end: number } | null {
  const close = text.indexOf("]", at + 1);
  if (close <= at + 1 || text[close + 1] !== "(") return null;
  const label = text.slice(at + 1, close);
  if (label.includes("[")) return null;
  let depth = 0;
  for (let j = close + 2; j < text.length; j++) {
    const ch = text[j];
    if (/\s/.test(ch)) return null;
    if (ch === "(") depth++;
    else if (ch === ")") {
      if (depth === 0) {
        const href = text.slice(close + 2, j);
        return isSafeHref(href) ? { label, href, end: j + 1 } : null;
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
  const re = new RegExp(START.source, "g");
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
      const url = trimBare(BARE.exec(text)?.[0] ?? "");
      if (!isSafeHref(url)) continue;
      pushText(text.slice(last, at));
      out.push({ kind: "link", href: url, children: [{ kind: "text", text: url }] });
      last = at + url.length;
      re.lastIndex = last;
    }
  }
  pushText(text.slice(last));
  return out;
}
