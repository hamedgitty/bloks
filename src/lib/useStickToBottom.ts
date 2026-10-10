import { useEffect, type RefObject } from "react";

/**
 * Keeps a conversation at its end while the reader is there.
 *
 * Scrolling to the bottom when a message arrives is not enough: what is
 * already on screen keeps changing size after that scroll, as a font
 * loads, markdown and cards lay out, an image arrives, or the composer
 * below grows or shrinks. Each of those left the last lines under the
 * composer of a conversation that still counted itself as followed, most
 * of all on a phone. So while `pinned` says the reader is at the end, any
 * change of size in the scroller or what is in it takes it back there.
 * Once they scroll up, `pinned` is false and nothing moves under them.
 */
export function useStickToBottom(scrollRef: RefObject<HTMLElement | null>, pinned: RefObject<boolean>) {
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const stick = () => {
      if (pinned.current) el.scrollTop = el.scrollHeight;
    };
    const sizes = new ResizeObserver(stick);
    const watch = () => {
      sizes.disconnect();
      sizes.observe(el);
      for (const child of Array.from(el.children)) sizes.observe(child);
    };
    watch();
    // what it holds is replaced now and then (an earlier page, a lens)
    const swaps = new MutationObserver(() => {
      watch();
      stick();
    });
    swaps.observe(el, { childList: true });
    return () => {
      sizes.disconnect();
      swaps.disconnect();
    };
  }, [scrollRef, pinned]);
}
