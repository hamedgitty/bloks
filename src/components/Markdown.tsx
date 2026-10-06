// A reply's markdown, drawn as elements.
//
// Headings, lists (nested ones keep their depth), quotes, tables, code
// blocks and the inline marks: bold, italic, code and links. Model output
// only ever reaches the page as text nodes and elements chosen here, never
// as HTML. Shared by solo chats and rooms, which is why a room can ask for
// its @mentions to be picked out as well.
import { useState } from "react";
import { splitBlocks, type CodeBlock, type TableBlock } from "@/lib/markdownTable";
import { parseInline, type InlineToken } from "@/lib/inlineMarkdown";
import { cn } from "@/lib/cn";
import { splitHighlight } from "@/lib/find";

/** Wraps every occurrence of the query in the plain-text parts of an
 * already-rendered line. Elements are left alone: breaking a code span
 * to paint it yellow trades a working transcript for a search result. */
export function withHighlight(nodes: React.ReactNode[], query: string): React.ReactNode[] {
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
          <mark key={`h-${i}-${j}`} className="rounded-[3px] bg-warning/40 px-px text-inherit">
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

/** Bold, code and links, as elements, with the search highlight painted
 * into the text of each, links and bold included. */
function inlineMd(text: string, keyBase: string, highlight: string, mentions?: RegExp | null): React.ReactNode[] {
  const render = (tokens: InlineToken[], key: string): React.ReactNode[] =>
    tokens.flatMap((token, i): React.ReactNode[] => {
      const k = `${key}-${i}`;
      switch (token.kind) {
        case "text":
          return withHighlight([token.text], highlight).flatMap((node, j) =>
            typeof node !== "string"
              ? [<span key={`${k}-${j}`}>{node}</span>]
              : mentions
                ? node.split(mentions).map((part, m) =>
                    // split with a capture group puts each mention at an odd index
                    m % 2 === 1 ? (
                      <span key={`${k}-${j}-${m}`} className="font-medium text-brand-ink">
                        {part}
                      </span>
                    ) : (
                      part
                    ),
                  )
                : [node],
          );
        case "code":
          return [
            <code key={k} className="rounded bg-foreground/[0.07] px-1 py-px font-mono text-[12.5px]">
              {token.text}
            </code>,
          ];
        case "bold":
          return [<strong key={k}>{render(token.children, k)}</strong>];
        case "italic":
          return [<em key={k}>{render(token.children, k)}</em>];
        case "link":
          return [
            <a
              key={k}
              href={token.href}
              target="_blank"
              rel="noreferrer"
              title={token.href}
              // anywhere, not break-word: only anywhere lets a long URL
              // stop setting the width of a table cell it sits in
              className="underline underline-offset-2 [overflow-wrap:anywhere] hover:opacity-80"
            >
              {render(token.children, k)}
            </a>,
          ];
      }
    });
  return render(parseInline(text), keyBase);
}

/** One line of inline markdown on its own, for places that are not a
 * reply but should draw links the way a reply does: a table card's cells. */
export function InlineMarkdown({ text }: { text: string }) {
  return <>{inlineMd(text, "i", "")}</>;
}

/**
 * A table a model wrote, drawn as one.
 *
 * Scrolls inside its own box rather than widening the bubble: a
 * six-column comparison should not decide how wide the transcript is.
 */
function MarkdownTable({ block, highlight }: { block: TableBlock; highlight: string }) {
  const align = (i: number) => {
    const a = block.aligns[i] ?? "left";
    return a === "right" ? "text-right" : a === "center" ? "text-center" : "text-left";
  };
  return (
    <div className="my-1.5 max-w-full overflow-x-auto rounded-xl border">
      <table className="w-full border-collapse text-[12.5px]">
        <thead>
          <tr className="border-b bg-foreground/[0.04]">
            {block.columns.map((column, i) => (
              <th
                key={i}
                className={cn("px-2.5 py-1.5 font-semibold whitespace-nowrap", align(i))}
              >
                {inlineMd(column, `th${i}`, highlight)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {block.rows.map((row, r) => (
            <tr key={r} className="border-b last:border-b-0">
              {row.map((cell, c) => (
                <td key={c} className={cn("px-2.5 py-1.5 align-top", align(c))}>
                  {inlineMd(cell, `td${r}-${c}`, highlight)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Code a model wrote, as code: monospaced, kept exactly as written, and
 * scrolling inside its own box so a long line does not widen the bubble.
 * The copy button is the reason code is worth drawing apart at all.
 */
function MarkdownCode({ block, highlight }: { block: CodeBlock; highlight: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="group/code relative my-1.5 max-w-full overflow-hidden rounded-xl border bg-foreground/[0.04]">
      <div className="flex items-center justify-between border-b px-2.5 py-1 text-[11px] text-muted-foreground">
        <span className="font-mono">{block.lang || "code"}</span>
        <button
          onClick={() => {
            void navigator.clipboard?.writeText(block.code);
            setCopied(true);
            setTimeout(() => setCopied(false), 1400);
          }}
          className="rounded px-1.5 py-0.5 transition-colors duration-150 hover:bg-foreground/[0.06] hover:text-foreground"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="overflow-x-auto px-3 py-2 font-mono text-[12.5px] leading-relaxed">
        <code>{withHighlight([block.code], highlight)}</code>
      </pre>
    </div>
  );
}

/** The pattern that picks out a room's @mentions, or null for none. */
function mentionPattern(names: string[] | undefined): RegExp | null {
  if (!names?.length) return null;
  const escaped = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`(@(?:${escaped.join("|")}))`, "gi");
}

export function Markdownish({
  text,
  highlight = "",
  mentions,
}: {
  text: string;
  highlight?: string;
  /** Names whose @mentions are picked out, in a room. */
  mentions?: string[];
}) {
  const names = mentionPattern(mentions);
  const blocks = splitBlocks(text);
  if (blocks.some((block) => block.kind !== "lines")) {
    return (
      <>
        {blocks.map((block, b) =>
          block.kind === "table" ? (
            <MarkdownTable key={`t${b}`} block={block} highlight={highlight} />
          ) : block.kind === "code" ? (
            <MarkdownCode key={`c${b}`} block={block} highlight={highlight} />
          ) : (
            <Markdownish key={`l${b}`} text={block.lines.join("\n")} highlight={highlight} mentions={mentions} />
          ),
        )}
      </>
    );
  }
  return (
    <>
      {text.split("\n").map((line, i) => {
        const heading = line.match(/^#{1,4}\s+(.*)$/);
        if (heading) {
          return (
            <div key={i} className="mt-1.5 font-semibold">
              {inlineMd(heading[1], `h${i}`, highlight, names)}
            </div>
          );
        }
        // Nested items keep their depth: two or more spaces in is one
        // level, capped where a bubble would run out of room.
        const depth = (lead: string) => Math.min(3, Math.floor(lead.replace(/\t/g, "  ").length / 2));
        const bullet = line.match(/^(\s*)[-•*]\s+(.*)$/);
        if (bullet) {
          return (
            <div key={i} className="flex gap-2 pl-1" style={{ marginLeft: `${depth(bullet[1]) * 1.1}rem` }}>
              <span className="text-muted-foreground">•</span>
              <span className="min-w-0 [overflow-wrap:anywhere]">{inlineMd(bullet[2], `b${i}`, highlight, names)}</span>
            </div>
          );
        }
        const numbered = line.match(/^(\s*)(\d+)\.\s+(.*)$/);
        if (numbered) {
          return (
            <div key={i} className="flex gap-2 pl-1" style={{ marginLeft: `${depth(numbered[1]) * 1.1}rem` }}>
              <span className="text-muted-foreground tabular-nums">{numbered[2]}.</span>
              <span className="min-w-0 [overflow-wrap:anywhere]">{inlineMd(numbered[3], `n${i}`, highlight, names)}</span>
            </div>
          );
        }
        // A quoted line: what an agent is answering, or a forward's
        // original. Left rule and quieter text, because the point is that
        // it is somebody else's words, not this message's own.
        const quoted = line.match(/^\s*>\s?(.*)$/);
        if (quoted) {
          return (
            <div
              key={i}
              className="my-0.5 border-l-2 border-current/25 pl-2.5 text-current/70"
            >
              {quoted[1] ? inlineMd(quoted[1], `q${i}`, highlight, names) : null}
            </div>
          );
        }
        if (!line.trim()) return <div key={i} className="h-2.5" />;
        // a long unbroken run (a hash, a path, a URL) breaks where it must
        // instead of pushing the whole transcript sideways
        return (
          <div key={i} className="[overflow-wrap:anywhere]">
            {inlineMd(line, `p${i}`, highlight, names)}
          </div>
        );
      })}
    </>
  );
}

