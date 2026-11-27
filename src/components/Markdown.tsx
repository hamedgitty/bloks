// A reply's markdown, drawn as elements.
//
// Headings, paragraphs, lists (nested ones keep their depth), quotes,
// rules, tables, code blocks and the inline marks: bold, italic, code and
// links. A link to a file an agent shared, or to where it saved one,
// opens the in-app viewer rather than a browser (SharedFileLink in
// ./Artifacts). Model output only ever reaches the page as text nodes and
// elements chosen here, never as HTML. Shared by solo chats and rooms,
// which is why a room can ask for its @mentions to be picked out as well.
//
// The spacing is a reading rhythm, not a list of rows: every block keeps
// the same distance from the one before it, a heading takes more above
// than below so it belongs to what it names, and the first block of a
// reply sits flush with whatever holds it.
import { memo, useMemo, useState, useSyncExternalStore, type CSSProperties } from "react";
import { Check } from "@/components/icons";
import { Copy } from "@/components/icons";
import { CornerDownLeft } from "@/components/icons";
import { splitBlocks, type CodeBlock, type TableBlock } from "@/lib/markdownTable";
import { proseBlocks, type List, type ProseBlock } from "@/lib/proseBlocks";
import { parseInline, type InlineToken } from "@/lib/inlineMarkdown";
import { highlight as colourCode, type Token, type TokenKind } from "@/lib/highlight";
import { cn } from "@/lib/cn";
import { splitHighlight } from "@/lib/find";
import { mentionRuns } from "@/lib/roomMentions";
import { looksShared } from "@/lib/sharedFile";
import { TableScroll } from "./TableScroll";
import { SharedFileLink } from "./Artifacts";
import { useDockHost } from "./dock/context";
import { modKey } from "@/lib/thisComputer";
import { GenUIBlock, useInsideGenUi } from "./genui/GenUIBlock";
import { isOpenUiLang } from "@/lib/genui/schema";
import { t } from "@/lib/i18n";

/** The gap every block keeps from the one above it, tighter under a
 * heading, and none at all for the first. */
const FLOW = "mt-3 first:mt-0 [:is(h1,h2,h3,h4)+&]:mt-2";

const HIT = "rounded-[3px] bg-warning/40 px-px text-inherit";

/** Wraps every occurrence of the query in the plain-text parts of an
 * already-rendered line. Elements are left alone: breaking a code span
 * to paint it yellow trades a working transcript for a search result. */
export function withHighlight(nodes: React.ReactNode[], query: string, keyPrefix = "h"): React.ReactNode[] {
  if (!query.trim()) return nodes;
  const out: React.ReactNode[] = [];
  nodes.forEach((node, i) => {
    if (typeof node !== "string") {
      out.push(node);
      return;
    }
    for (const [j, part] of splitHighlight(node, query).entries()) {
      out.push(
        part.hit ? (
          <mark key={`${keyPrefix}-${i}-${j}`} className={HIT}>
            {part.text}
          </mark>
        ) : (
          part.text
        ),
      );
    }
  });
  return out;
}

const INLINE_CODE = "rounded-[5px] bg-foreground/[0.06] px-[0.3em] py-px font-mono text-body";
// Mention pills share one shape on both sides of a room: a soft accent
// wash on neutral bubbles, and a frosted glass chip with a hairline ring
// on the reader's accent fill so it stays crisp instead of muddying the
// bubble colour in light or dark mode.
const ROOM_MENTION_PILL =
  "rounded-[6px] bg-brand-ink/[0.12] px-1.5 py-px font-medium text-brand-ink box-decoration-clone dark:bg-brand-ink/[0.16]";
const ROOM_MENTION_PILL_ON_ACCENT =
  "rounded-[6px] bg-brand-foreground/[0.16] px-1.5 py-px font-medium text-brand-foreground ring-1 ring-inset ring-brand-foreground/25 box-decoration-clone";

/** Splits plain text into text and room @mention pills, painting any
 * search highlight inside both so searching inside a name keeps the pill
 * whole. */
export function withRoomMentions(
  text: string,
  mentions: readonly string[] | undefined,
  highlight = "",
  { onAccent = false, keyPrefix = "rm" }: { onAccent?: boolean; keyPrefix?: string } = {},
): React.ReactNode[] {
  if (!mentions?.length) return withHighlight([text], highlight, `${keyPrefix}-h`);
  const pill = onAccent ? ROOM_MENTION_PILL_ON_ACCENT : ROOM_MENTION_PILL;
  return mentionRuns(text, mentions).flatMap((run, i) =>
    run.mention
      ? [
          <span key={`${keyPrefix}-${i}`} className={pill}>
            {withHighlight([run.text], highlight, `${keyPrefix}-${i}-h`)}
          </span>,
        ]
      : withHighlight([run.text], highlight, `${keyPrefix}-${i}-h`),
  );
}

/** Bold, code and links, as elements, with the search highlight painted
 * into the text of each, links and bold included. */
function inlineMd(text: string, keyBase: string, highlight: string, mentions?: readonly string[]): React.ReactNode[] {
  const render = (tokens: InlineToken[], key: string): React.ReactNode[] =>
    tokens.flatMap((token, i): React.ReactNode[] => {
      const k = `${key}-${i}`;
      switch (token.kind) {
        case "text":
          return withRoomMentions(token.text, mentions, highlight, { keyPrefix: k });
        case "code":
          // a path to a file in an agent's deliverables, written in
          // backticks the way agents tend to, opens like a link to it
          if (looksShared(token.text)) {
            return [
              <SharedFileLink key={k} href={token.text.trim()} className="no-underline">
                <code className={cn(INLINE_CODE, "underline decoration-dotted underline-offset-2")}>{token.text}</code>
              </SharedFileLink>,
            ];
          }
          return [
            <code key={k} className={INLINE_CODE}>
              {token.text}
            </code>,
          ];
        case "file":
          return [
            <SharedFileLink key={k} href={token.href}>
              {render(token.children, k)}
            </SharedFileLink>,
          ];
        case "bold":
          return [
            <strong key={k} className="font-semibold">
              {render(token.children, k)}
            </strong>,
          ];
        case "italic":
          return [<em key={k}>{render(token.children, k)}</em>];
        case "link":
          return [
            <WebLink key={k} href={token.href}>
              {render(token.children, k)}
            </WebLink>,
          ];
      }
    });
  return render(parseInline(text), keyBase);
}

/**
 * A web address in a reply. Beside a chat with a side dock it opens in
 * the Bloks browser there, so the page is read next to the conversation
 * (GitHub 509); ⌘ or Ctrl with the click, or the middle button, still
 * opens it in the person's own browser, and so does the browser panel's
 * own button. Anywhere else it is the plain link it always was, and so
 * it is where that browser cannot open a page or the person chose their
 * own browser for links (lib/chatLinks.ts, GitHub 539).
 */
function WebLink({ href, children }: { href: string; children: React.ReactNode }) {
  const host = useDockHost();
  const inside = host?.openLink && /^https?:\/\//i.test(href) ? host.openLink : null;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      title={inside ? `${href}\n${t("markdown.linkOpensInDock", { mod: modKey() })}` : href}
      onClick={(e) => {
        if (!inside || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
        e.preventDefault();
        inside(href);
      }}
      // anywhere, not break-word: only anywhere lets a long URL
      // stop setting the width of a table cell it sits in
      className="text-brand-ink underline decoration-brand-ink/35 underline-offset-3 transition-[text-decoration-color] duration-150 [overflow-wrap:anywhere] hover:decoration-brand-ink"
    >
      {children}
    </a>
  );
}

/** One line of inline markdown on its own, for places that are not a
 * reply but should draw links the way a reply does: a table card's cells. */
export function InlineMarkdown({ text }: { text: string }) {
  return <>{inlineMd(text, "i", "")}</>;
}

/**
 * A table a model wrote, drawn as one.
 *
 * Scrolls inside its own box rather than widening the reply: a
 * six-column comparison should not decide how wide the transcript is.
 */
function MarkdownTable({ block, highlight, mentions }: { block: TableBlock; highlight: string; mentions?: readonly string[] }) {
  const align = (i: number) => {
    const a = block.aligns[i] ?? "left";
    return a === "right" ? "text-right" : a === "center" ? "text-center" : "text-left";
  };
  return (
    <TableScroll className={cn(FLOW, "rounded-xl border")}>
      <table className="w-full border-collapse text-body">
        <thead>
          <tr className="border-b bg-foreground/[0.03]">
            {block.columns.map((column, i) => (
              <th key={i} className={cn("px-3 py-2 font-semibold whitespace-nowrap", align(i))}>
                {inlineMd(column, `th${i}`, highlight, mentions)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {block.rows.map((row, r) => (
            <tr key={r} className="border-b last:border-b-0">
              {row.map((cell, c) => (
                <td key={c} className={cn("px-3 py-2 align-top tabular-nums", align(c))}>
                  {inlineMd(cell, `td${r}-${c}`, highlight, mentions)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </TableScroll>
  );
}

/**
 * The colours code is drawn in. Each one is a theme colour leaned toward
 * the text colour, so it stays quiet: the light theme's darken, the dark
 * theme's soften, and every one reads at least as well as the hue it
 * came from, because the palette test already holds those to 4.5 to 1.
 */
const SYNTAX = {
  "--code-bg": "color-mix(in srgb, var(--foreground) 3.5%, var(--background))",
  "--sx-keyword": "color-mix(in srgb, var(--brand-ink) 78%, var(--foreground))",
  "--sx-function": "color-mix(in srgb, var(--brand-ink) 48%, var(--foreground))",
  "--sx-string": "color-mix(in srgb, var(--success) 80%, var(--foreground))",
  "--sx-number": "color-mix(in srgb, var(--warning) 85%, var(--foreground))",
  "--sx-type": "color-mix(in srgb, var(--warning) 60%, var(--foreground))",
  "--sx-property": "color-mix(in srgb, var(--destructive) 55%, var(--foreground))",
  "--sx-tag": "color-mix(in srgb, var(--destructive) 72%, var(--foreground))",
} as CSSProperties;

// A diff line is tinted edge to edge, past the block's own padding, so a
// run of changes reads as a band rather than as highlighted words.
const DIFF_LINE = "-mx-4 inline-block min-w-[calc(100%+2rem)] px-4";

const TOKEN_CLASS: Record<TokenKind, string> = {
  keyword: "text-(--sx-keyword)",
  function: "text-(--sx-function)",
  string: "text-(--sx-string)",
  number: "text-(--sx-number)",
  literal: "text-(--sx-number)",
  type: "text-(--sx-type)",
  property: "text-(--sx-property)",
  tag: "text-(--sx-tag)",
  variable: "text-(--sx-property)",
  comment: "italic text-muted-foreground",
  punct: "text-muted-foreground",
  meta: "text-muted-foreground",
  inserted: cn(DIFF_LINE, "bg-success/10 text-(--sx-string)"),
  deleted: cn(DIFF_LINE, "bg-destructive/10 text-(--sx-tag)"),
};

/** Coloured pieces, with the find highlight painted across them: a hit
 * like `foo.bar` spans three pieces, so the hits are found in the whole
 * text first and each piece is cut where a hit starts or ends. */
function codeNodes(code: string, tokens: Token[], query: string): React.ReactNode[] {
  const hits: Array<[number, number]> = [];
  if (query.trim()) {
    let at = 0;
    for (const part of splitHighlight(code, query)) {
      if (part.hit) hits.push([at, at + part.text.length]);
      at += part.text.length;
    }
  }
  let offset = 0;
  return tokens.map((token, i) => {
    const start = offset;
    const end = start + token.text.length;
    offset = end;
    let body: React.ReactNode = token.text;
    const inside = hits.filter(([a, b]) => a < end && b > start);
    if (inside.length) {
      const parts: React.ReactNode[] = [];
      let cursor = start;
      inside.forEach(([a, b], j) => {
        const from = Math.max(a, start);
        const to = Math.min(b, end);
        if (from > cursor) parts.push(code.slice(cursor, from));
        parts.push(
          <mark key={j} className={HIT}>
            {code.slice(from, to)}
          </mark>,
        );
        cursor = to;
      });
      if (cursor < end) parts.push(code.slice(cursor, end));
      body = parts;
    }
    return token.kind ? (
      <span key={i} className={TOKEN_CLASS[token.kind]}>
        {body}
      </span>
    ) : (
      <span key={i}>{body}</span>
    );
  });
}

// Whether long lines wrap is a preference about reading code, not about
// one block, so it holds for every block and survives a restart. Stored
// on this computer only; a private window starts unwrapped and still works.
const WRAP_KEY = "bloks-code-wrap";
const wrapListeners = new Set<() => void>();
let wrapping = (() => {
  try {
    return localStorage.getItem(WRAP_KEY) === "1";
  } catch {
    return false;
  }
})();
function useCodeWrap(): [boolean, () => void] {
  const wrap = useSyncExternalStore(
    (onChange) => {
      wrapListeners.add(onChange);
      return () => wrapListeners.delete(onChange);
    },
    () => wrapping,
  );
  const toggle = () => {
    wrapping = !wrapping;
    try {
      localStorage.setItem(WRAP_KEY, wrapping ? "1" : "0");
    } catch {
      // nowhere to keep it; it still holds until the window closes
    }
    wrapListeners.forEach((run) => run());
  };
  return [wrap, toggle];
}

const CODE_BUTTON =
  "flex h-6 items-center gap-1 rounded-md px-1.5 transition-colors duration-150 hover:bg-foreground/[0.06] hover:text-foreground active:scale-95";

/**
 * Code a model wrote, as code: monospaced, kept exactly as written, and
 * coloured where the language is one we know. It scrolls inside its own
 * box so a long line does not widen the reply, unless lines are set to
 * wrap. The bar with the copy button rides the top of the screen while a
 * long block scrolls past, because the copy button is the reason code is
 * worth drawing apart at all and it should not need a scroll back up.
 */
function MarkdownCode({ block, highlight }: { block: CodeBlock; highlight: string }) {
  const [copied, setCopied] = useState(false);
  const [wrap, toggleWrap] = useCodeWrap();
  const tokens = useMemo(() => colourCode(block.code, block.lang), [block.code, block.lang]);
  return (
    // clip, not hidden: hidden would make this box the thing the bar
    // sticks inside, and the bar would never move
    <div style={SYNTAX} className={cn(FLOW, "max-w-full overflow-clip rounded-xl border bg-(--code-bg)")}>
      {/* the bar is the app's: a copy across the block takes the code alone */}
      <div data-copy="skip" className="sticky top-0 z-[1] flex h-8 items-center gap-1 border-b bg-(--code-bg) pr-1 pl-4 text-caption text-muted-foreground">
        <span className="min-w-0 flex-1 truncate font-mono">{block.lang}</span>
        <button
          onClick={toggleWrap}
          aria-pressed={wrap}
          aria-label={t("markdown.wrapLongLines")}
          title={wrap ? t("markdown.stopWrappingLongLines") : t("markdown.wrapLongLines")}
          className={cn(CODE_BUTTON, "w-6 justify-center px-0", wrap && "bg-foreground/[0.06] text-foreground")}
        >
          <CornerDownLeft size={13} strokeWidth={1.8} />
        </button>
        <button
          onClick={() => {
            void navigator.clipboard?.writeText(block.code);
            setCopied(true);
            setTimeout(() => setCopied(false), 1400);
          }}
          className={CODE_BUTTON}
        >
          {copied ? (
            <Check size={13} strokeWidth={2.2} className="text-success" />
          ) : (
            <Copy size={13} strokeWidth={1.8} />
          )}
          <span aria-live="polite">{copied ? t("common.copied") : t("common.copy")}</span>
        </button>
      </div>
      <pre
        className={cn(
          "overflow-x-auto px-4 py-3 font-mono text-body",
          wrap ? "whitespace-pre-wrap [overflow-wrap:anywhere]" : "whitespace-pre",
        )}
      >
        <code>{codeNodes(block.code, tokens, highlight)}</code>
      </pre>
    </div>
  );
}

/** Code on its own, outside a reply: an interface answer's CodeBlock,
 * or the text of one that could not be drawn. */
export function CodeView({ lang, code }: { lang: string; code: string }) {
  return <MarkdownCode block={{ kind: "code", lang, code }} highlight="" />;
}

/** Lines that belong together, with the breaks the model chose kept. */
function linesOf(lines: string[], key: string, highlight: string, mentions?: readonly string[]): React.ReactNode[] {
  return lines.flatMap((line, i) => [
    ...(i > 0 ? [<br key={`${key}-br${i}`} />] : []),
    ...inlineMd(line, `${key}-${i}`, highlight, mentions),
  ]);
}

// Bullets change shape as they nest, so a glance tells the levels apart.
const BULLETS = ["list-disc", "list-[circle]", "list-[square]"];

function MarkdownList({
  list,
  depth,
  keyBase,
  highlight,
  mentions,
}: {
  list: List;
  depth: number;
  keyBase: string;
  highlight: string;
  mentions?: readonly string[];
}) {
  const Tag = list.ordered ? "ol" : "ul";
  return (
    <Tag
      start={list.ordered && list.start !== 1 ? list.start : undefined}
      className={cn(
        // markers sit in the gutter, so wrapped lines line up with the
        // first word rather than under the bullet
        "pl-6 marker:text-muted-foreground",
        list.ordered ? "list-decimal marker:tabular-nums" : BULLETS[Math.min(depth, BULLETS.length - 1)],
        depth === 0 ? FLOW : "mt-1",
      )}
    >
      {list.items.map((item, i) => (
        <li
          key={i}
          className={cn(
            "pl-1 [overflow-wrap:anywhere]",
            i > 0 && (list.loose ? "mt-2" : "mt-1"),
            item.task !== null && "relative list-none",
          )}
        >
          {item.task !== null && (
            <span
              aria-hidden
              className={cn(
                "absolute top-[0.3em] -left-5 flex size-3.5 items-center justify-center rounded-[4px] border",
                item.task ? "border-transparent bg-foreground text-background" : "border-foreground/30",
              )}
            >
              {item.task && <Check size={10} strokeWidth={3} />}
            </span>
          )}
          {item.task !== null && <span className="sr-only">{`${item.task ? t("markdown.taskDone") : t("markdown.taskToDo")} `}</span>}
          <span className={cn(item.task && "text-muted-foreground")}>
            {linesOf(item.lines, `${keyBase}-${i}`, highlight, mentions)}
          </span>
          {item.children.map((child, c) => (
            <MarkdownList
              key={c}
              list={child}
              depth={depth + 1}
              keyBase={`${keyBase}-${i}-${c}`}
              highlight={highlight}
              mentions={mentions}
            />
          ))}
        </li>
      ))}
    </Tag>
  );
}

const HEADING_CLASS: Record<1 | 2 | 3 | 4, string> = {
  1: "mt-7 text-heading font-semibold",
  2: "mt-6 text-title font-semibold",
  3: "mt-5 text-lead font-semibold",
  4: "mt-4 text-ui font-semibold",
};

function Prose({
  block,
  keyBase,
  highlight,
  mentions,
}: {
  block: ProseBlock;
  keyBase: string;
  highlight: string;
  mentions?: readonly string[];
}) {
  switch (block.kind) {
    case "heading": {
      const Tag = `h${block.level}` as "h1";
      return (
        <Tag className={cn(HEADING_CLASS[block.level], "text-balance text-foreground first:mt-0 [:is(h1,h2,h3,h4)+&]:mt-2")}>
          {inlineMd(block.text, keyBase, highlight, mentions)}
        </Tag>
      );
    }
    case "paragraph":
      // a long unbroken run (a hash, a path, a URL) breaks where it must
      // instead of pushing the whole transcript sideways
      return <p className={cn(FLOW, "text-pretty [overflow-wrap:anywhere]")}>{linesOf(block.lines, keyBase, highlight, mentions)}</p>;
    case "rule":
      return <hr className="my-6 border-border first:mt-0" />;
    case "quote":
      // What an agent is answering, or a forward's original. A rule down
      // the side and quieter text, because the point is that it is
      // somebody else's words. Drawn in the current colour, so it reads
      // on any ground the reply sits on.
      return (
        <blockquote className={cn(FLOW, "border-l-2 border-current/15 pl-4 text-current/75")}>
          <MarkdownishBlocks text={block.text} highlight={highlight} mentions={mentions} />
        </blockquote>
      );
    case "list":
      return <MarkdownList list={block} depth={0} keyBase={keyBase} highlight={highlight} mentions={mentions} />;
  }
}

interface MarkdownishProps {
  text: string;
  highlight?: string;
  /** Names whose @mentions are picked out, in a room. */
  mentions?: readonly string[];
  /** The reply is still arriving: an interface answer in it is drawn as
   * it grows, and waits to be clicked until it is done. */
  streaming?: boolean;
}

/**
 * Drawn again only when what it would draw changes. While a reply
 * streams, the transcript renders with every word, and each settled
 * reply above it parsed its whole text again for nothing. A room hands
 * over a fresh list of names each time, so the names are compared by
 * what they say.
 */
export const Markdownish = memo(
  MarkdownishBlocks,
  (a, b) =>
    a.text === b.text &&
    Boolean(a.streaming) === Boolean(b.streaming) &&
    (a.highlight ?? "") === (b.highlight ?? "") &&
    (a.mentions ?? []).length === (b.mentions ?? []).length &&
    (a.mentions ?? []).every((name, i) => name === b.mentions![i]),
);

function MarkdownishBlocks({ text, highlight = "", mentions, streaming }: MarkdownishProps) {
  // an answer's own markdown draws a fence of its own as code
  const nested = useInsideGenUi();
  return (
    <>
      {splitBlocks(text).flatMap((block, b) =>
        block.kind === "table" ? (
          [<MarkdownTable key={`t${b}`} block={block} highlight={highlight} mentions={mentions} />]
        ) : block.kind === "code" && isOpenUiLang(block.lang) && !nested ? (
          // An answer drawn as interface (src/components/genui). The
          // gap above it is the one every block keeps.
          [
            <div key={`u${b}`} data-genui className={FLOW}>
              <GenUIBlock code={block.code} streaming={streaming} />
            </div>,
          ]
        ) : block.kind === "code" ? (
          [<MarkdownCode key={`c${b}`} block={block} highlight={highlight} />]
        ) : (
          proseBlocks(block.lines).map((prose, p) => (
            <Prose
              key={`p${b}-${p}`}
              block={prose}
              keyBase={`${b}-${p}`}
              highlight={highlight}
              mentions={mentions}
            />
          ))
        ),
      )}
    </>
  );
}
