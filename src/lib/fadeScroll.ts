// A strip of tabs that runs past its room (the conversation's tabs, a dock
// pane's tabs) scrolls sideways with no scrollbar drawn, and its edges fade
// out on the side where there is more to see: a mask over the strip,
// present only on the side that overflows (useFadeScroll). A mouse wheel
// turned up or down scrolls it sideways, as a trackpad does, and the tab
// in front is kept in view. The pure part is here for the tests.
import { useCallback, useEffect, useLayoutEffect, useState, type RefObject } from "react";

/** How far the fade reaches into the strip, in pixels. */
export const FADE = 28;

/** The mask for a strip scrolled `left` of `scroll` in `client`: a fade on
 * each side that has more beyond it, or nothing when it all fits. A pixel
 * of slack keeps rounding from drawing a fade at an end already reached. */
export function fadeMask(left: number, scroll: number, client: number, fade = FADE): string | undefined {
  const before = left > 1;
  const after = left + client < scroll - 1;
  if (!before && !after) return undefined;
  const start = before ? `transparent 0, #000 ${fade}px` : "#000 0";
  const end = after ? `#000 calc(100% - ${fade}px), transparent 100%` : "#000 100%";
  return `linear-gradient(to right, ${start}, ${end})`;
}

/** How a wheel turn moves a sideways strip: a vertical turn scrolls it
 * sideways, a sideways one (a trackpad) as it is. */
export function wheelToSideways(deltaX: number, deltaY: number): number {
  return Math.abs(deltaY) > Math.abs(deltaX) ? deltaY : deltaX;
}

/**
 * The fade and the wheel for a strip, and the tab in front kept in view:
 * `activeKey` changing scrolls the element marked `[aria-selected=true]`
 * into the strip's view. Returns the style to put on the strip.
 */
export function useFadeScroll(ref: RefObject<HTMLElement | null>, activeKey?: string | null): { maskImage?: string; WebkitMaskImage?: string } {
  const [mask, setMask] = useState<string | undefined>(undefined);
  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    setMask(fadeMask(el.scrollLeft, el.scrollWidth, el.clientWidth));
  }, [ref]);
  // the tab in front brought inside the strip, clear of the fades
  const keepFront = useCallback(() => {
    const el = ref.current;
    const front = el?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!el || !front) return;
    const box = el.getBoundingClientRect();
    const at = front.getBoundingClientRect();
    if (at.left < box.left + FADE) el.scrollLeft -= box.left + FADE - at.left;
    else if (at.right > box.right - FADE) el.scrollLeft += at.right - (box.right - FADE);
  }, [ref]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    measure();
    // a strip that changes size (the dock opening beside it, a window
    // made narrower) keeps the tab in front in view
    let width = el.clientWidth;
    const watch = new ResizeObserver(() => {
      if (el.clientWidth !== width) {
        width = el.clientWidth;
        keepFront();
      }
      measure();
    });
    watch.observe(el);
    for (const child of Array.from(el.children)) watch.observe(child);
    const wheel = (e: WheelEvent) => {
      if (el.scrollWidth <= el.clientWidth) return;
      const by = wheelToSideways(e.deltaX, e.deltaY);
      if (!by) return;
      e.preventDefault();
      el.scrollLeft += by;
    };
    el.addEventListener("scroll", measure, { passive: true });
    el.addEventListener("wheel", wheel, { passive: false });
    return () => {
      watch.disconnect();
      el.removeEventListener("scroll", measure);
      el.removeEventListener("wheel", wheel);
    };
  }, [ref, measure, keepFront]);
  // tabs come and go: the fade follows what the strip now holds
  useLayoutEffect(measure);
  useEffect(keepFront, [keepFront, activeKey]);
  return mask ? { maskImage: mask, WebkitMaskImage: mask } : {};
}
