// Which of a list's headings are pinned right now (`position: sticky` at
// the top of the scroller), marked `data-stuck` so the fade under them
// shows only then (the sidebar, `.sidebar-pin` in styles.css). CSS cannot
// ask this everywhere Bloks runs, the browsers at the web door included,
// so it is measured: at most once a frame, on scroll and whenever the
// list changes size or what is in it. Set straight on the elements, so a
// scroll draws nothing again in React.
import { useEffect } from "react";

export function usePinnedHeads(el: HTMLElement | null) {
  useEffect(() => {
    if (!el) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const top = el.getBoundingClientRect().top;
      for (const head of el.querySelectorAll<HTMLElement>("[data-pin]")) {
        // pinned is held at the top edge while the list has moved under it;
        // at rest a heading sits a little below the edge, where it belongs
        const stuck = el.scrollTop > 0 && Math.abs(head.getBoundingClientRect().top - top) < 1;
        if (stuck !== head.hasAttribute("data-stuck")) head.toggleAttribute("data-stuck", stuck);
      }
    };
    const soon = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    measure();
    el.addEventListener("scroll", soon, { passive: true });
    const sizes = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(soon);
    sizes?.observe(el);
    if (el.firstElementChild) sizes?.observe(el.firstElementChild);
    const changes = new MutationObserver(soon);
    changes.observe(el, { childList: true, subtree: true });
    return () => {
      cancelAnimationFrame(frame);
      el.removeEventListener("scroll", soon);
      sizes?.disconnect();
      changes.disconnect();
    };
  }, [el]);
}
