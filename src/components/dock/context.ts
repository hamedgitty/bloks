// What a conversation with a side dock offers the things drawn inside it:
// a file card, a link to a shared file and an ordinary web link each open
// in the dock when there is one, and do what they always did when there is
// not (a dialog over the page, the person's own browser).
import { createContext, useContext } from "react";

export interface DockHost {
  /** An agent's shared file, in a tab of the dock's documents. */
  openDoc: (doc: { botId: string; name: string; mime: string; size: number }) => void;
  /** An http(s) address, in the Bloks browser in the dock; null where this
   * page has no browser it can drive, and the link opens outside. */
  openLink: ((url: string) => void) | null;
}

export const DockHostContext = createContext<DockHost | null>(null);

export function useDockHost(): DockHost | null {
  return useContext(DockHostContext);
}
