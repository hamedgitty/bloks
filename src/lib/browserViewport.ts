// The size the Bloks browser lays its pages out at: the panel's own
// (responsive), or a fixed screen, a phone's or a tablet's or a laptop's,
// drawn scaled to fit wherever it shows (the panel, a minimized window).
// Kept on this device, like the panel's width: it is about how this
// screen looks at pages. Chosen from the browser's menu or the minimized
// browser's header; both read it here.
import { useSyncExternalStore } from "react";
import type { MessageKey } from "./i18n";

export type ViewportPreset = "responsive" | "mobile" | "tablet" | "4:3" | "16:10";

export interface ViewportChoice {
  id: ViewportPreset;
  label: MessageKey;
  /** The size pages lay out at; none for the panel's own. */
  size?: { width: number; height: number };
  /** Said beside the size in the menu. */
  note?: string;
  /** A phone or a tablet: the page is told it is on one. */
  mobile?: boolean;
}

export const VIEWPORTS: readonly ViewportChoice[] = [
  { id: "responsive", label: "browserViewport.responsive" },
  { id: "mobile", label: "browserViewport.mobile", size: { width: 375, height: 812 }, mobile: true },
  { id: "tablet", label: "browserViewport.tablet", size: { width: 768, height: 1024 }, mobile: true },
  { id: "4:3", label: "browserViewport.small", size: { width: 1024, height: 768 }, note: "4:3" },
  { id: "16:10", label: "browserViewport.laptop", size: { width: 1280, height: 800 }, note: "16:10" },
];

export function viewportOf(id: ViewportPreset): ViewportChoice {
  return VIEWPORTS.find((v) => v.id === id) ?? VIEWPORTS[0];
}

/** "375 × 812", as the menu writes a size. */
export function sizeWords(size: { width: number; height: number }): string {
  return `${size.width} × ${size.height}`;
}

/** Where a page of `size` sits in `box`: scaled down to fit (never up),
 * and centred. */
export function fitIn(box: { width: number; height: number }, size: { width: number; height: number }) {
  const scale = Math.min(1, box.width / size.width, box.height / size.height);
  const width = size.width * scale;
  const height = size.height * scale;
  return { scale, width, height, left: (box.width - width) / 2, top: (box.height - height) / 2 };
}

export const VIEWPORT_KEY = "bloks-browser-viewport";

export function parseViewport(raw: string | null): ViewportPreset {
  return VIEWPORTS.some((v) => v.id === raw) ? (raw as ViewportPreset) : "responsive";
}

let current: ViewportPreset = (() => {
  try {
    return parseViewport(typeof localStorage === "undefined" ? null : localStorage.getItem(VIEWPORT_KEY));
  } catch {
    return "responsive";
  }
})();
const listeners = new Set<() => void>();

export function setViewport(next: ViewportPreset): void {
  if (next === current) return;
  current = next;
  try {
    localStorage.setItem(VIEWPORT_KEY, next);
  } catch {
    /* kept for this window only */
  }
  for (const listener of listeners) listener();
}

export function useViewport(): ViewportPreset {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    () => current,
    () => "responsive",
  );
}
