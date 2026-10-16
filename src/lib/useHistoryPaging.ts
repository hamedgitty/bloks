import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { Message } from "@/state/store";
import { useEarlier } from "./useEarlier";
import { AUTO_EARLIER_PAGES, shouldFillEarlier, shouldLoadEarlier, TRANSCRIPT_WINDOW, windowStart } from "./transcript";

type Anchor = { row: Element; top: number };
type Expansion = { local: boolean; first?: string; boundary?: number; anchor: Anchor | null };

/** Opening a short visible tail should fill the window, not require a
 * scroll that an underfilled window cannot make. All three ways of paging
 * share the same latch and restore an identified row, not the height that
 * happened to be there when a request left. */
export function useHistoryPaging(
  kind: "bot" | "room",
  target: { id: string; threadId: string; messages: Message[]; olderMessages?: number },
  messages: Message[],
  scrollRef: RefObject<HTMLElement | null>,
  pinned: RefObject<boolean>,
  enabled = true,
) {
  const scope = `${kind}:${target.id}:${target.threadId}`;
  const makeVisit = () => ({
    scope, active: true, generation: 0, top: 0, attempts: 0, stopped: false, dimensions: "",
    cursors: new Set<string>(), pending: null as Expansion | null,
    schedule: () => {},
  });
  const visit = useRef(makeVisit());
  if (visit.current.scope !== scope) visit.current = makeVisit();
  const life = visit.current;
  const [window, setWindow] = useState({ visit: life, boundary: null as number | null });
  const boundary = window.visit === life ? window.boundary : null;
  const start = windowStart(messages.length, boundary);
  const earlier = useEarlier(kind, target);
  const [, redraw] = useState(0);
  const latest = useRef({ start, earlier, target, enabled });
  latest.current = { start, earlier, target, enabled };
  const current = () => visit.current === life && life.active;
  const reset = () => {
    life.attempts = 0;
    life.stopped = false;
    life.cursors.clear();
  };
  const resized = (el: HTMLElement): boolean => {
    const column = el.firstElementChild;
    const viewport = el.getBoundingClientRect();
    const size = `${viewport.width}:${viewport.height}:${column ? getComputedStyle(column).maxWidth : ""}`;
    const changed = life.dimensions !== "" && size !== life.dimensions;
    if (changed) {
      reset();
      // Growing the viewport clamps scrollTop too. That is not the
      // reader asking for an earlier page, even when it lands near 0.
      life.top = el.scrollTop;
    }
    life.dimensions = size;
    return changed;
  };
  const anchor = (): Anchor | null => {
    const el = scrollRef.current;
    if (!el || pinned.current) return null;
    const viewport = el.getBoundingClientRect();
    const rows = Array.from(el.querySelectorAll("[data-message-id], [data-room-msg], [data-turn-fold]"));
    // Cards and grouped rows also keep their keyed DOM element. Prefer
    // an identified message, then a visible top-level transcript row.
    const column = el.firstElementChild;
    const row = [...rows, ...Array.from(column?.children ?? []).filter((r) => r.tagName !== "BUTTON")].find((r) => {
      const box = r.getBoundingClientRect();
      return box.bottom > viewport.top && box.top < viewport.bottom;
    });
    return row ? { row, top: row.getBoundingClientRect().top } : null;
  };
  const load = (automatic = false) => {
    const now = latest.current;
    if (!current() || life.pending || now.earlier.loading || !(now.start > 0 || now.earlier.remaining > 0)) return;
    if (!automatic) reset();
    const cursor = now.start > 0 ? `local:${messages[now.start]?.id}` : `server:${now.target.messages[0]?.id ?? ""}`;
    if (automatic && (life.stopped || life.attempts >= AUTO_EARLIER_PAGES || life.cursors.has(cursor))) return;
    life.cursors.add(cursor);
    if (automatic) life.attempts++;
    if (!automatic) pinned.current = false;
    const pending: Expansion = { local: now.start > 0, anchor: null };
    const generation = life.generation;
    life.pending = pending;
    redraw((n) => n + 1);
    if (pending.local) {
      pending.boundary = Math.max(0, now.start - TRANSCRIPT_WINDOW);
      pending.anchor = anchor();
      setWindow({ visit: life, boundary: pending.boundary });
    } else {
      void now.earlier.load((first) => {
        if (!current() || life.generation !== generation || life.pending !== pending) return;
        pending.first = first;
        // Capture after the wait, including any reader scroll or new tail.
        pending.anchor = anchor();
      }).then((progress) => {
        if (!current() || life.generation !== generation || life.pending !== pending) return;
        if (!progress) {
          life.pending = null;
          life.stopped = true;
          redraw((n) => n + 1);
        }
        life.schedule();
      });
    }
  };
  const loadRef = useRef(load);
  loadRef.current = load;

  // A prepend has committed. The same element keeps its screen position
  // even when new content grew at the other end while the page was out.
  useLayoutEffect(() => {
    if (!enabled && life.pending) {
      earlier.cancel();
      life.generation++;
      life.pending = null;
    }
    const pending = life.pending;
    const el = scrollRef.current;
    if (current() && pending && el && (pending.local ? boundary === pending.boundary : pending.first !== undefined && pending.first === target.messages[0]?.id)) {
      life.pending = null;
      if (pinned.current) el.scrollTop = el.scrollHeight;
      else if (pending.anchor && el.contains(pending.anchor.row)) {
        el.scrollTop += pending.anchor.row.getBoundingClientRect().top - pending.anchor.top;
      }
      life.top = el.scrollTop;
      redraw((n) => n + 1);
    }
    life.schedule();
  });

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    life.active = true;
    pinned.current = true;
    el.scrollTop = el.scrollHeight;
    life.top = el.scrollTop;
    resized(el);
    let frame = 0;
    let column: Element | null = null;
    const sizes = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => schedule());
    const measure = () => {
      frame = 0;
      if (!current()) return;
      const child = el.firstElementChild;
      if (child !== column) {
        if (column) sizes?.unobserve(column);
        column = child;
        if (column) sizes?.observe(column);
      }
      if (!column) return;
      const viewport = el.getBoundingClientRect();
      // A scrollbar or a loading button can change the inner width. They
      // are not an external resize and must not buy another eight pages.
      resized(el);
      const now = latest.current;
      if (now.enabled && shouldFillEarlier({ width: viewport.width, height: el.clientHeight,
        contentHeight: column.getBoundingClientRect().height,
        more: now.start > 0 || now.earlier.remaining > 0,
        loading: Boolean(life.pending) || now.earlier.loading,
        stopped: life.stopped, attempts: life.attempts })) loadRef.current(true);
    };
    const schedule = () => {
      if (!current() || frame) return;
      const generation = life.generation;
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (life.generation === generation) measure();
      });
    };
    life.schedule = schedule;
    sizes?.observe(el);
    const swaps = new MutationObserver(schedule);
    swaps.observe(el, { childList: true });
    schedule();
    return () => {
      life.active = false;
      life.generation++;
      life.pending = null;
      life.schedule = () => {};
      cancelAnimationFrame(frame);
      sizes?.disconnect();
      swaps.disconnect();
    };
  }, [life, scrollRef, pinned]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el || !current()) return;
    if (resized(el)) {
      life.schedule();
      return;
    }
    const lastTop = life.top;
    life.top = el.scrollTop;
    if (!latest.current.enabled) return;
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80 || (pinned.current && el.scrollTop >= lastTop);
    if (shouldLoadEarlier({ top: el.scrollTop, lastTop,
      more: start > 0 || earlier.remaining > 0, loading: Boolean(life.pending) || earlier.loading })) load();
  };
  const showAll = () => {
    if (!current()) return;
    earlier.cancel();
    life.generation++;
    life.pending = null;
    setWindow({ visit: life, boundary: 0 });
  };
  return { start, remaining: earlier.remaining, loading: Boolean(life.pending) || earlier.loading, onScroll,
    showEarlier: () => load(), showAll };
}
