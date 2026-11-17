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
