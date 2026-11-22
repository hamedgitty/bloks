// Where a conversation's header goes on a desktop: up in the title bar, in
// the row the window's own buttons sit in, the way many desktop apps use
// that strip. TitleBar.tsx leaves an empty slot; the chat renders who it
// is with, its buttons and the side dock's tabs into it with a portal,
// and its own tabs go where its header was. On a phone-narrow window the
// title bar is not drawn, so this answers null and the header stays in
// the conversation, where it was.
import { useEffect, useState, useSyncExternalStore } from "react";

export const TITLEBAR_TABS_ID = "titlebar-tabs";
const WIDE = "(min-width: 768px)";

function subscribe(onChange: () => void) {
  const query = window.matchMedia(WIDE);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

export function useTitlebarSlot(): HTMLElement | null {
  const wide = useSyncExternalStore(subscribe, () => window.matchMedia(WIDE).matches, () => false);
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setSlot(wide ? document.getElementById(TITLEBAR_TABS_ID) : null);
  }, [wide]);
  return slot;
}
