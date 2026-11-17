// How tall an agent's row in the sidebar is.
//
// Three shapes, from two choices kept on this device:
//
//   full   the agent's face, its name, when it last spoke and a line of
//          its last conversation, two lines tall. The list as it always was.
//   line   one line with a small face, which is what "Show conversations"
//          gives each agent, its other conversations listed under it.
//   bare   one line with no face at all: the name, and the marks that say
//          what it is doing. For someone who picks agents by name and wants
//          as many of them in view as the column holds (GitHub 508).
//
// Compact rows win over either view: they take away the face and its height,
// and leave nested conversations exactly as the other switch says. Nothing a
// row does changes with its shape, only how much room it takes.
//
// No React in the part the tests read; the hook at the end is the app's.
import { useEffect, useState } from "react";

export type AgentRowShape = "full" | "line" | "bare";

export function agentRowShape(choice: { compact: boolean; conversations: boolean }): AgentRowShape {
  if (choice.compact) return "bare";
  return choice.conversations ? "line" : "full";
}

/** The row's height in pixels for each shape, so a list can say how many
 * agents fit, and a bare row stays a comfortable thing to click or tap. */
export const AGENT_ROW_HEIGHT: Record<AgentRowShape, number> = { full: 58, line: 38, bare: 32 };

/** What sits after the name on a bare row: a spinner while the agent works,
 * the waiting word and mark when it has stopped for you, the unread mark,
 * and otherwise when it last spoke. Said here so the row and its tests read
 * the same rule. */
export function bareTrailing(lane: { state: string; unread?: boolean } | undefined): "working" | "waiting" | "unread" | "time" | null {
  if (!lane) return null;
  if (lane.state === "working") return "working";
  if (lane.state === "needs-you") return "waiting";
  if (lane.unread) return "unread";
  return "time";
}

export const COMPACT_ROWS_KEY = "bloks-compact-agent-rows";
const EVENT = "bloks:compact-agent-rows";

type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;

export function readCompactRows(storage: Storage | undefined): boolean {
  try {
    return storage?.getItem(COMPACT_ROWS_KEY) === "on";
  } catch {
    return false;
  }
}

export function writeCompactRows(storage: Storage | undefined, on: boolean): void {
  try {
    storage?.setItem(COMPACT_ROWS_KEY, on ? "on" : "off");
  } catch {
    // private mode: the choice lasts as long as the window does
  }
}

const local = (): Storage | undefined => (typeof localStorage === "undefined" ? undefined : localStorage);

/** The choice, heard in the sidebar and in Settings alike, as the
 * conversations view is (src/lib/conversationsView.ts). Off by default. */
export function useCompactAgentRows(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(() => readCompactRows(local()));
  useEffect(() => {
    const sync = () => setOn(readCompactRows(local()));
    window.addEventListener(EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);
  const set = (next: boolean) => {
    writeCompactRows(local(), next);
    setOn(next);
    window.dispatchEvent(new Event(EVENT));
  };
  return [on, set];
}
