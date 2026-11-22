// Request share, for a file link the server says was never shared into
// the chat (GitHub 543). The chat that can take the request provides it:
// the owner's own conversation with the agent, whose composer it writes
// the request into for the owner to read, change or send. Anywhere else
// (a member's app, a room) nothing provides it, and the dialog says to
// ask the agent instead. Writing into the composer sends nothing.
import { createContext, useContext } from "react";

export type RequestShare = (href: string) => void;

export const ShareRequestContext = createContext<RequestShare | null>(null);

export function useRequestShare(): RequestShare | null {
  return useContext(ShareRequestContext);
}
