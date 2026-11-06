// A small toolbar over words selected inside one message: Quote, and on
// an agent's answer Branch with this (src/lib/selectionQuote.ts has the
// rules it places itself by).
//
// It waits for the selection to settle before it shows: the mouse let go,
// the keyboard still for a moment, or on a touch screen the handles left
// alone, where it sits below the words so the system's own menu above
// them keeps its place. It never covers what is selected, goes on a
// scroll, a click elsewhere or Escape, and takes nothing from a copy:
// pressing it keeps the selection, and the copy listener reads the same
// selection it always did. A selection across two messages, or one that
// reaches into anything that is not a message's words, shows nothing.
// ⌘' (Ctrl+' elsewhere) quotes a selection without it.
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { GitBranch, Quote } from "@/components/icons";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import { isQuoteKey, quoteOf, toolbarSpot } from "@/lib/selectionQuote";
import { platformOf } from "@/lib/shortcuts";
import { t } from "@/lib/i18n";

/** What the view says about a message the selection is in: who said it,
 * how its reply excerpt reads, and whether it is an answer to branch
 * from. Null for a message that takes no quote. */
export type QuoteSource = { author: string; excerpt: string; branchable: boolean } | null;

export interface QuoteDraft {
  id: string;
  author: string;
  excerpt: string;
  quote: string;
}

/** How long the keyboard or a finger is left still before it shows. */
const SETTLE_MS = { keys: 250, touch: 550 } as const;

function editable(node: Node | null): boolean {
  const el = node instanceof Element ? node : node?.parentElement;
  return Boolean(el?.closest("input, textarea, [contenteditable]:not([contenteditable='false'])"));
}

/** The message a selection lies wholly inside, and its words, or null. */
function readSelection(container: HTMLElement, source: (id: string) => QuoteSource) {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return null;
  const { anchorNode, focusNode } = selection;
  if (!anchorNode || !focusNode || !container.contains(anchorNode) || !container.contains(focusNode)) return null;
  if (editable(anchorNode) || editable(focusNode)) return null;
  const row = (node: Node) => (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>("[data-message-id]") ?? null;
  const at = row(anchorNode);
  if (!at || at !== row(focusNode)) return null;
  // the action row, a timestamp, a reply's quoted card: the app's, not words
  const range = selection.getRangeAt(0);
  const common = range.commonAncestorContainer;
  if ((common instanceof Element ? common : common.parentElement)?.closest("[data-copy='skip']")) return null;
  const id = at.dataset.messageId!;
  const said = source(id);
  const quote = quoteOf(selection.toString());
  if (!said || !quote) return null;
  return { id, said, quote, rect: range.getBoundingClientRect() };
}

export function SelectionQuote({
  container,
  source,
  onQuote,
  onBranch,
  branchBlocked,
}: {
  container: RefObject<HTMLElement | null>;
  source: (messageId: string) => QuoteSource;
  onQuote: (draft: QuoteDraft) => void;
  /** Absent where nothing branches (a room). */
  onBranch?: (draft: QuoteDraft) => void;
  /** Why Branch with this cannot be done now, said when it is pressed. */
  branchBlocked?: string | null;
}) {
  const [shown, setShown] = useState<{ draft: QuoteDraft; branchable: boolean; rect: DOMRect; below: boolean; top: number; left: number; side: "above" | "below" } | null>(null);
  // placed first by a guess at its size, then again by its real one, in
  // the same frame, before it is painted
  useLayoutEffect(() => {
    const el = toolbar.current;
    if (!shown || !el) return;
    const spot = toolbarSpot(shown.rect, { width: el.offsetWidth, height: el.offsetHeight }, { width: window.innerWidth, height: window.innerHeight }, { below: shown.below });
    if (spot.top !== shown.top || spot.left !== shown.left || spot.side !== shown.side) setShown({ ...shown, ...spot });
  }, [shown]);
  const toolbar = useRef<HTMLDivElement>(null);
  const pointer = useRef<{ down: boolean; touch: boolean }>({ down: false, touch: false });
  const latest = useRef({ source, onQuote });
  latest.current = { source, onQuote };

  const take = (draft: QuoteDraft, then: (draft: QuoteDraft) => void) => {
    setShown(null);
    window.getSelection()?.removeAllRanges();
    then(draft);
    // the words to go with it are typed next
    requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>("textarea[data-composer-input]")?.focus());
  };

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const hide = () => setShown(null);
    const place = () => {
      const el = container.current;
      const read = el ? readSelection(el, latest.current.source) : null;
      if (!read) return hide();
      const below = pointer.current.touch;
      const size = { width: read.said.branchable ? 236 : 96, height: 36 };
      const spot = toolbarSpot(read.rect, size, { width: window.innerWidth, height: window.innerHeight }, { below });
      setShown({
        draft: { id: read.id, author: read.said.author, excerpt: read.said.excerpt, quote: read.quote },
        branchable: read.said.branchable,
        rect: read.rect,
        below,
        ...spot,
      });
    };
    const soon = (ms: number) => {
      clearTimeout(timer);
      timer = setTimeout(place, ms);
    };
    const changed = () => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) {
        clearTimeout(timer);
        return hide();
      }
      // a mouse still dragging shows it on letting go; a finger moving
      // the handles, and the keyboard, once they have been still a moment
      if (pointer.current.down && !pointer.current.touch) return hide();
      soon(pointer.current.touch ? SETTLE_MS.touch : SETTLE_MS.keys);
    };
    const down = (e: PointerEvent) => {
      if (toolbar.current?.contains(e.target as Node)) return;
      pointer.current = { down: true, touch: e.pointerType !== "mouse" };
    };
    const up = (e: PointerEvent) => {
      pointer.current = { down: false, touch: e.pointerType !== "mouse" };
      if (e.pointerType === "mouse") soon(10);
    };
    const keys = (e: KeyboardEvent) => {
      if (e.key === "Escape") return hide();
      if (!isQuoteKey(e, platformOf() === "mac")) return;
      const el = container.current;
      const read = el ? readSelection(el, latest.current.source) : null;
      if (!read) return;
      e.preventDefault();
      take({ id: read.id, author: read.said.author, excerpt: read.said.excerpt, quote: read.quote }, latest.current.onQuote);
    };
    const scroller = container.current;
    document.addEventListener("selectionchange", changed);
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("pointerup", up, true);
    document.addEventListener("keydown", keys);
    scroller?.addEventListener("scroll", hide, { passive: true });
    window.addEventListener("resize", hide);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("selectionchange", changed);
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("pointerup", up, true);
      document.removeEventListener("keydown", keys);
      scroller?.removeEventListener("scroll", hide);
      window.removeEventListener("resize", hide);
    };
  }, [container]);

  if (!shown) return null;
  const branch = shown.branchable && onBranch;
  return createPortal(
    <div
      ref={toolbar}
      role="toolbar"
      aria-label={t("selectionQuote.label")}
      data-copy="skip"
      // pressing it must not take the selection away
      onPointerDown={(e) => e.preventDefault()}
      onMouseDown={(e) => e.preventDefault()}
      style={{ top: shown.top, left: shown.left }}
      className={cn(
        "fixed z-50 flex animate-pop-in items-center gap-0.5 rounded-full border bg-popover p-[3px] shadow-lg shadow-(color:--shadow-color)",
        shown.side === "above" ? "origin-bottom" : "origin-top",
      )}
    >
      <button
        type="button"
        onClick={() => take(shown.draft, onQuote)}
        title={t("selectionQuote.quoteHint", { key: platformOf() === "mac" ? "⌘'" : "Ctrl+'" })}
        className="flex h-7 items-center gap-1.5 rounded-full px-2.5 text-small font-medium text-foreground transition-colors duration-150 hover:bg-accent active:scale-95 motion-reduce:transition-none"
      >
        <Quote size={14} strokeWidth={1.8} className="text-muted-foreground" />
        {t("selectionQuote.quote")}
      </button>
      {branch && (
        <button
          type="button"
          aria-disabled={branchBlocked ? true : undefined}
          title={branchBlocked ?? undefined}
          onClick={() => (branchBlocked ? toast.info(branchBlocked, { id: "branch-blocked" }) : take(shown.draft, onBranch))}
          className={cn(
            "flex h-7 items-center gap-1.5 rounded-full px-2.5 text-small font-medium text-foreground transition-colors duration-150 hover:bg-accent active:scale-95 motion-reduce:transition-none",
            branchBlocked && "opacity-40",
          )}
        >
          <GitBranch size={13} strokeWidth={1.8} className="text-muted-foreground" />
          {t("selectionQuote.branch")}
        </button>
      )}
    </div>,
    document.body,
  );
}
