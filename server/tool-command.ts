// Display detail is sanitized before the event log, store or subscribers.
// Keep source offsets while reading shell words, including a Codex POSIX
// shell's quoted -lc or -c argument. Replace only the credential spans.
const COMMAND_LIMIT = 2000;
const SECRET_NAME = /token|password|passwd|secret|credential|api[_-]?key|private[_-]?key|access[_-]?key/i;

interface Word {
  text: string;
  start: number;
  end: number;
  from: number[];
  to: number[];
  quoted: boolean;
  wholeQuoted: boolean;
}

/** A display-only shell reader, not an interpreter. Nothing is executed. */
function words(text: string): Word[] {
  const result: Word[] = [];
  let i = 0;
  while (i < text.length) {
    if (/[\s;&|<>]/.test(text[i])) { i++; continue; }
    const start = i;
    const chars: string[] = [], from: number[] = [], to: number[] = [];
    let quote = "", quoted = false;
    const wholeQuoted = text[i] === "'" || text[i] === '"';
    while (i < text.length) {
      const c = text[i];
      if (!quote && /[\s;&|<>]/.test(c)) break;
      if ((!quote && (c === "'" || c === '"')) || c === quote) {
        quote = quote ? "" : c;
        quoted = true;
        i++;
        continue;
      }
      const begin = i;
      if (c === "\\" && quote !== "'" && i + 1 < text.length &&
          (!quote || /[$\x60"\\\n]/.test(text[i + 1]))) {
        i++;
        if (text[i] === "\n") { i++; continue; }
      }
      chars.push(text[i]); from.push(begin); to.push(++i);
    }
    result.push({ text: chars.join(""), start, end: i, from, to, quoted, wholeQuoted });
  }
  return result;
}

/** End of a JSON/string value embedded inside a shell word. */
function valueEnd(text: string, start: number): [number, number] {
  const quote = text[start];
  if (quote !== "'" && quote !== '"') return [start, text.length];
  let end = start + 1;
  while (end < text.length) {
    if (text[end] === "\\") { end += 2; continue; }
    if (text[end] === quote) break;
    end++;
  }
  return [start + 1, Math.min(end, text.length)];
}

function maskCredentials(text: string): string {
  // Difference marks merge overlapping masks in linear time, even for
  // a large command with thousands of adjacent credential-shaped values.
  const marks = new Int32Array(text.length + 1);
  const outer = words(text);
  function collect(input: string, list: Word[], parent?: Word) {
    function mask(word: Word, start = 0, end = word.text.length) {
      if (start >= end) return;
      let a = word.from[start], b = word.to[end - 1];
      if (parent) { a = parent.from[a]; b = parent.to[b - 1]; }
      marks[a]++; marks[b]--;
    }
    let headerPending = false, valuePending = false, previous = 0;
    for (const word of list) {
      if (headerPending && (/[\r\n;&|<>]/.test(input.slice(previous, word.start)) || word.text.startsWith("-"))) headerPending = false;
      if (headerPending || valuePending) {
        mask(word);
        valuePending = false;
        if (word.wholeQuoted) headerPending = false;
      }
      previous = word.end;
      const assignment = /^([A-Za-z_][A-Za-z0-9_]*|--[A-Za-z0-9_-]+)=/.exec(word.text);
      if (assignment && SECRET_NAME.test(assignment[1])) mask(word, assignment[0].length);
      if (/^--[A-Za-z0-9_-]+$/.test(word.text) && SECRET_NAME.test(word.text)) valuePending = true;

      // Header names also cover prefixes such as Proxy-Authorization.
      const headers = /(?:authorization|x-api-key|x-auth-token|private-token|cookie)["']?\s*[:=]\s*/gi;
      for (const hit of word.text.matchAll(headers)) {
        const start = hit.index! + hit[0].length;
        const [a, b] = valueEnd(word.text, start);
        mask(word, a, b);
        if (!word.quoted || start === word.text.length) headerPending = true;
      }
      const bearers = /\bbearer(?:\s+|$)/gi;
      for (const hit of word.text.matchAll(bearers)) {
        const start = hit.index! + hit[0].length;
        const [a, b] = valueEnd(word.text, start);
        mask(word, a, b);
        if (start === word.text.length) valuePending = true;
      }

      // Scan an authority once, and keep its last @. A password may
      // itself contain an unescaped @; a bare user has no password.
      let cursor = 0;
      for (;;) {
        const colon = word.text.indexOf("://", cursor);
        if (colon < 0) break;
        let scheme = colon - 1;
        while (scheme >= 0 && /[a-z0-9+.-]/i.test(word.text[scheme])) scheme--;
        if (!/^[a-z]/i.test(word.text.slice(scheme + 1, colon))) { cursor = colon + 3; continue; }
        const begin = colon + 3;
        let end = begin;
        while (end < word.text.length && !/[\s/?#"'<>]/.test(word.text[end])) end++;
        const authority = word.text.slice(begin, end);
        const at = authority.lastIndexOf("@"), password = authority.indexOf(":");
        if (password >= 0 && password < at) mask(word, begin + password + 1, begin + at);
        cursor = Math.max(end, begin);
      }
    }
  }
  if (/(?:^|\/)(?:ba|z|da|k)?sh$/.test(outer[0]?.text ?? "") && /^-l?c$/.test(outer[1]?.text ?? "") && outer[2]) {
    collect(outer[2].text, words(outer[2].text), outer[2]);
    collect(text, outer.slice(3));
  } else {
    collect(text, outer);
  }
  const chunks: string[] = [];
  let depth = 0, start = 0;
  for (let i = 0; i <= text.length; i++) {
    const next = depth + marks[i];
    if (!depth && next) chunks.push(text.slice(start, i), "[redacted]");
    if (depth && !next) start = i;
    depth = next;
  }
  chunks.push(text.slice(start));
  return chunks.join("");
}

export function toolCommand(value: unknown, redact: (text: string) => string): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  // Redact before cutting: a partial credential may evade its pattern.
  const text = maskCredentials(redact(value));
  if (text.length <= COMMAND_LIMIT) return text;
  let head = text.slice(0, COMMAND_LIMIT - 1);
  if (/[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1);
  return head + "…";
}

/** Preserve the input used by existing server consumers of a tool title. */
export function legacyToolTitle(event: { provider: string; title?: string; command?: string }): string {
  return event.provider === "codex" && event.command ? event.command.slice(0, 80) : event.title ?? "tool";
}
