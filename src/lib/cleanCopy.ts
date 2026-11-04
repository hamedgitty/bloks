// What a copy out of the chat puts on the clipboard as HTML.
//
// Left to itself, Chromium writes the selection's computed styles into
// text/html: pasted into Mail, Docs or Word, a reply arrives in the
// theme's light grey on a dark ground, with the action row's buttons
// beside it. What a person copying a reply wants is the reply: its
// headings, paragraphs, lists, tables, links, code, bold and italic, and
// nothing about how Bloks draws them.
//
// cleanCopyHtml rebuilds the selection from an allowlist. A few elements
// are kept, bare, with no attribute but a link's own address (http,
// https and mailto, nothing that runs or reaches into this computer).
// Controls, icons, pictures, timestamps, what is hidden or drawn for a
// screen reader alone, and anything the page marks `data-copy="skip"` go
// with everything inside them. Every other element is unwrapped to its
// words, a block of them becoming a paragraph. Text is escaped; nothing
// of the page is ever passed through as markup.
//
// It reads a node by the few DOM fields it needs, so the tests can hand
// it plain objects. installCleanCopy, at the bottom, is the page's side:
// the one copy (and cut) listener, which hands this the selection.

/** A node as cleanCopyHtml reads it: a DOM node is one. */
export interface CopyNode {
  nodeType: number;
  nodeName: string;
  nodeValue: string | null;
  childNodes: ArrayLike<CopyNode>;
  getAttribute?(name: string): string | null;
}

const ELEMENT = 1;
const TEXT = 3;

/** Kept as themselves, bare. b and i are said as strong and em. */
const BLOCKS = new Set(["P", "H1", "H2", "H3", "H4", "H5", "H6", "UL", "OL", "LI", "BLOCKQUOTE", "PRE", "TABLE", "THEAD", "TBODY", "TFOOT", "TR", "TH", "TD"]);
const INLINES: Record<string, string> = { STRONG: "strong", B: "strong", EM: "em", I: "em", CODE: "code", A: "a" };

/** Gone with everything in them: controls, media, what is not text. */
const DROPPED = new Set([
  "BUTTON", "SVG", "IMG", "PICTURE", "VIDEO", "AUDIO", "CANVAS", "IFRAME", "OBJECT", "EMBED", "INPUT", "SELECT", "OPTION",
  "TEXTAREA", "SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT", "HEAD", "TITLE", "META", "LINK", "TIME", "HR",
]);

/** Unwrapped, but a run of words in one is a paragraph of its own. */
const BLOCKISH = new Set(["DIV", "SECTION", "ARTICLE", "MAIN", "HEADER", "FOOTER", "ASIDE", "NAV", "FIGURE", "FIGCAPTION", "DETAILS", "SUMMARY", "DL", "DT", "DD", "ADDRESS", "FORM", "FIELDSET", "BODY", "HTML"]);

const LINK = /^(?:https?:|mailto:)/i;

function attr(node: CopyNode, name: string): string | null {
  try {
    return node.getAttribute?.(name) ?? null;
  } catch {
    return null;
  }
}

function classes(node: CopyNode): string[] {
  return (attr(node, "class") ?? "").split(/\s+/);
}

/** Whether a node is chrome rather than words. A link-like button around
 * words (a shared file named in a reply) says `data-copy="keep"`. */
export function droppedFromCopy(node: CopyNode): boolean {
  if (node.nodeType !== ELEMENT) return false;
  const tag = node.nodeName.toUpperCase();
  const said = attr(node, "data-copy");
  if (said === "keep") return false;
  if (said === "skip" || DROPPED.has(tag)) return true;
  if (attr(node, "aria-hidden") === "true" || attr(node, "hidden") !== null) return true;
  const named = classes(node);
  // drawn for a screen reader alone, or said by the page to be no part
  // of any selection (a diff's line numbers, a prompt's "$ ")
  return named.includes("sr-only") || named.includes("select-none");
}

/** Text whose line breaks are the text's own (a person's message, drawn
 * with white-space: pre-wrap), rather than where the source wrapped. */
function keepsLines(node: CopyNode): boolean {
  return classes(node).some((name) => /^whitespace-pre(?:-wrap|-line)?$/.test(name));
}

function escape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** A piece of what is being built: words that flow, or a block. */
type Piece = { inline: string } | { block: string };

interface Context {
  pre: boolean;
  lines: boolean;
}

function textOf(raw: string, at: Context): string {
  if (at.pre) return escape(raw);
  if (at.lines) {
    return raw
      .split(/\r?\n/)
      .map((line) => escape(line.replace(/[ \t\f]+/g, " ")))
      .join("<br>");
  }
  return escape(raw.replace(/\s+/g, " "));
}

const blank = (html: string) => html.replace(/<br>|&nbsp;|\s/g, "") === "";

/** Words between blocks become paragraphs; a run of nothing but space is
 * the gap between two blocks and goes. */
function asBlocks(pieces: Piece[]): string {
  let out = "";
  let run = "";
  const close = () => {
    if (!blank(run)) out += `<p>${run.trim()}</p>`;
    run = "";
  };
  for (const piece of pieces) {
    if ("inline" in piece) run += piece.inline;
    else {
      close();
      out += piece.block;
    }
  }
  close();
  return out;
}

/** Everything inside, as flowing words, blocks included in place: what a
 * list item, a cell or a link holds. */
function asFlow(pieces: Piece[]): string {
  const hasBlocks = pieces.some((piece) => "block" in piece);
  if (!hasBlocks) return pieces.map((piece) => ("inline" in piece ? piece.inline : "")).join("");
  return asBlocks(pieces);
}

function walk(node: CopyNode, at: Context): Piece[] {
  if (node.nodeType === TEXT) {
    const value = node.nodeValue ?? "";
    return value ? [{ inline: textOf(value, at) }] : [];
  }
  const children = (inner: Context): Piece[] => {
    const pieces: Piece[] = [];
    for (let i = 0; i < node.childNodes.length; i++) pieces.push(...walk(node.childNodes[i], inner));
    return pieces;
  };
  // a fragment, or a document: what it holds
  if (node.nodeType !== ELEMENT) return children(at);
  if (droppedFromCopy(node)) return [];
  const tag = node.nodeName.toUpperCase();
  const inner: Context = { pre: at.pre || tag === "PRE", lines: at.lines || keepsLines(node) };
  if (tag === "BR") return [{ inline: at.pre ? "\n" : "<br>" }];
  if (tag in INLINES) {
    const content = asFlow(children(inner));
    if (blank(content)) return content ? [{ inline: content }] : [];
    const name = INLINES[tag];
    if (name === "a") {
      const href = (attr(node, "href") ?? "").trim();
      return [{ inline: LINK.test(href) ? `<a href="${escape(href)}">${content}</a>` : content }];
    }
    return [{ inline: `<${name}>${content}</${name}>` }];
  }
  if (BLOCKS.has(tag)) {
    const name = tag.toLowerCase();
    const pieces = children(inner);
    // a list or a table holds its items and rows, not the space between
    const joined = () => pieces.map((piece) => ("inline" in piece ? piece.inline : piece.block)).join("");
    // a quote holds paragraphs; an item or a cell holds its words as
    // they are, beside any list nested in it
    const content = ["UL", "OL", "TABLE", "THEAD", "TBODY", "TFOOT", "TR"].includes(tag)
      ? pieces.filter((piece) => "block" in piece).map((piece) => (piece as { block: string }).block).join("")
      : tag === "PRE"
        ? joined().replace(/\n$/, "")
        : tag === "BLOCKQUOTE"
          ? asFlow(pieces).trim()
          : joined().trim();
    if (blank(content) && tag !== "TD" && tag !== "TH") return [];
    return [{ block: `<${name}>${content}</${name}>` }];
  }
  const pieces = children(inner);
  if (!BLOCKISH.has(tag)) return pieces;
  // inside code, a box is a line
  if (at.pre) return [...pieces, { inline: "\n" }];
  // a box of words is a paragraph; a box of blocks is just its blocks
  return pieces.some((piece) => "block" in piece) ? [{ block: asBlocks(pieces) }] : blank(asFlow(pieces)) ? [] : [{ block: `<p>${asFlow(pieces).trim()}</p>` }];
}

/**
 * The selection as clean HTML, or "" when nothing in it is words (a
 * selection of a button, an icon, a timestamp). Words alone stay words,
 * so a phrase pasted into a sentence does not become a paragraph.
 */
export function cleanCopyHtml(root: CopyNode): string {
  const pieces = walk(root, { pre: false, lines: false });
  const html = pieces.some((piece) => "block" in piece) ? asBlocks(pieces) : asFlow(pieces).trim();
  return blank(html) ? "" : html;
}

// ── the page's side ──

/** Tags a selection keeps from the elements around it, when it lies
 * wholly inside them: a few words of code are still code. */
const WRAPPING = new Set(["PRE", "CODE", "A", "STRONG", "B", "EM", "I"]);
/** Containers whose items the selection is made of, when it starts and
 * ends in different ones: cloned items need their list or table back. */
const ROWS = new Set(["UL", "OL", "TABLE", "THEAD", "TBODY", "TFOOT", "TR"]);

function editable(node: Node | null): boolean {
  const element = node instanceof Element ? node : node?.parentElement;
  return Boolean(element?.closest("input, textarea, [contenteditable]:not([contenteditable='false'])"));
}

/** One range as a fragment with the elements it needs from around it, or
 * null when it lies inside something that is not words. */
function rangeFragment(range: Range): Node | null {
  const start = range.commonAncestorContainer;
  const around: Element[] = [];
  for (let el = start instanceof Element ? start : start.parentElement; el && el !== document.body; el = el.parentElement) {
    if (droppedFromCopy(el)) return null;
    around.push(el);
  }
  let node: Node = range.cloneContents();
  // the rows of a list or table first, from the innermost container out
  // to the table itself, then the inline marks and code around it all
  for (const el of around) {
    if (!ROWS.has(el.tagName)) break;
    const shell = el.cloneNode(false) as Element;
    shell.appendChild(node);
    node = shell;
    if (el.tagName === "TABLE" || el.tagName === "UL" || el.tagName === "OL") break;
  }
  let lines = false;
  for (const el of around) {
    if (WRAPPING.has(el.tagName)) {
      const shell = el.cloneNode(false) as Element;
      shell.appendChild(node);
      node = shell;
    }
    if (!lines && el.tagName !== "PRE" && keepsLines(el)) lines = true;
  }
  // words from a person's message keep their line breaks
  if (lines && !around.some((el) => el.tagName === "PRE")) {
    const span = document.createElement("span");
    span.className = "whitespace-pre-wrap";
    span.appendChild(node);
    node = span;
  }
  return node;
}

/** The selection's text and clean HTML, or null to leave the copy to the
 * browser: nothing selected, or a selection in a field being typed in. */
export function cleanCopyOf(selection: Selection | null): { text: string; html: string } | null {
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  if (editable(selection.anchorNode) || editable(selection.focusNode) || editable(document.activeElement)) return null;
  const holder = document.createDocumentFragment();
  for (let r = 0; r < selection.rangeCount; r++) {
    const fragment = rangeFragment(selection.getRangeAt(r));
    if (fragment) holder.appendChild(fragment);
  }
  return { text: selection.toString(), html: cleanCopyHtml(holder) };
}

/** The one listener, for every copy and cut in the window. A handler of
 * a component's own that already wrote the clipboard is left be, and so
 * is a field being typed in. Call once, before the app renders. */
export function installCleanCopy(target: Document = document): void {
  const write = (event: ClipboardEvent) => {
    if (event.defaultPrevented || !event.clipboardData) return;
    let copy: { text: string; html: string } | null = null;
    try {
      copy = cleanCopyOf(target.getSelection());
    } catch {
      // whatever went wrong, the browser's own copy still works
      return;
    }
    if (!copy || !copy.text) return;
    event.preventDefault();
    event.clipboardData.setData("text/plain", copy.text);
    if (copy.html) event.clipboardData.setData("text/html", `<meta charset="utf-8">${copy.html}`);
  };
  target.addEventListener("copy", write);
  target.addEventListener("cut", write);
}
