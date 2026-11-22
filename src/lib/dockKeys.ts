// ⌘⌥B (Ctrl+Alt+B elsewhere) shows and hides the side dock, the right-hand
// twin of ⌘B for the sidebar. Read by the key's position, since Option
// turns the letter into something else on a Mac keyboard.
import type { Platform } from "./shortcuts.ts";

interface KeyLike {
  key: string;
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

export function dockChord(e: KeyLike, platform: Platform): boolean {
  if (!e.altKey || e.shiftKey) return false;
  const mod = platform === "mac" ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  return mod && (e.code === "KeyB" || (!e.code && e.key.toLowerCase() === "b"));
}

/** The panels with a key of their own, as the dock's + menu lists them:
 * ⇧⌘F Files, ⇧⌘D Changes, ⇧⌘B Browser, ⌘J Terminal (Ctrl for ⌘ off a
 * Mac). Read by the key's place, as the dock's own chord is. */
export type PanelKey = "docs" | "changes" | "browser" | "terminal";

export function panelChord(e: KeyLike, platform: Platform): PanelKey | null {
  if (e.altKey) return null;
  const mod = platform === "mac" ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  if (!mod) return null;
  const letter = e.code?.startsWith("Key") ? e.code.slice(3).toLowerCase() : e.key.toLowerCase();
  if (e.shiftKey) {
    if (letter === "f") return "docs";
    if (letter === "d") return "changes";
    if (letter === "b") return "browser";
    return null;
  }
  return letter === "j" ? "terminal" : null;
}

/** ⇧⌘\ (Ctrl+Shift+\ off a Mac): expand the pane the keyboard is in, or
 * the first one open, over the conversation, and put it back. */
export function expandChord(e: KeyLike, platform: Platform): boolean {
  if (!e.shiftKey || e.altKey) return false;
  const mod = platform === "mac" ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  return mod && (e.code === "Backslash" || e.key === "|" || e.key === "\\");
}
