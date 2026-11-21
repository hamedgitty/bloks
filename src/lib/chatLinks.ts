// Where a web link in a chat opens: the Bloks browser in the side dock,
// or the person's own browser (GitHub 539).
//
// Kept on this device, like the other view choices: the browser a person
// reaches for is the one on the computer in front of them, not the
// workspace's. Settings flips it and every chat hears it through a window
// event rather than a second copy of the state.
import { useEffect, useState } from "react";
import type { BrowserWhere } from "./appBrowser.ts";

/** "bloks" is the dock's browser, the default; "own" is the person's. */
export type ChatLinksIn = "bloks" | "own";

const KEY = "bloks-chat-links";
const EVENT = "bloks:chat-links";

export function readChatLinksIn(storage: { getItem(key: string): string | null } | undefined = globalThis.localStorage): ChatLinksIn {
  try {
    return storage?.getItem(KEY) === "own" ? "own" : "bloks";
  } catch {
    return "bloks";
  }
}

/**
 * Whether a plain click on a chat link opens it in the dock. Only where
 * this page has a browser that can open a page: the desktop app's own, or
 * a server's that is running. A server with no Chrome, or with its browser
 * turned off, would only show a panel saying so, and the link would never
 * open; there it goes to the person's own browser as a plain link does.
 */
export function linksOpenInDock(where: BrowserWhere, choice: ChatLinksIn): boolean {
  if (choice === "own") return false;
  if (where.home === "own") return true;
  return where.home === "server" && where.missing === null && where.available;
}

export function useChatLinksIn(): [ChatLinksIn, (next: ChatLinksIn) => void] {
  const [choice, setChoice] = useState<ChatLinksIn>(() => readChatLinksIn());
  useEffect(() => {
    const sync = () => setChoice(readChatLinksIn());
    window.addEventListener(EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);
  const set = (next: ChatLinksIn) => {
    try {
      localStorage.setItem(KEY, next);
    } catch {
      // private mode: the choice lasts as long as the window does
    }
    setChoice(next);
    window.dispatchEvent(new Event(EVENT));
  };
  return [choice, set];
}
