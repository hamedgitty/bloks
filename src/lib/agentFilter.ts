// Favorites or All: how many agents the sidebar lists (GitHub 525).
//
// A workspace of forty agents is a list nobody scrolls. Favorites keeps the
// ones the person pinned (a pin is what favoriting an agent is here: held
// at the top of its list, by hand), and lets in any other agent only while
// it has something for them: an unread reply, or a conversation stopped
// to ask them something. The agent on screen stays listed too, so opening
// one from the Agents page or a search never leaves its row missing. All
// is the list as it always was.
//
// The rest are a click away: a line under the list counts them and opens
// the Agents page, which lists everyone. Rooms are never filtered; they
// are few, and each is a team.
//
// The choice is kept on this device, as folding a section is. No React in
// the part the tests read; the hook at the end is the app's.
import { useEffect, useState } from "react";

export type AgentFilter = "favorites" | "all";

export interface ListedAgent {
  id: string;
  pinned?: boolean;
  unread?: boolean;
  tasks?: ReadonlyArray<{ state?: string; unread?: boolean }>;
}

/** Whether Favorites lists this agent: pinned, the one open, or with
 * something waiting for the person. */
export function inFavorites(bot: ListedAgent, selectedId: string | null): boolean {
  if (bot.pinned || bot.id === selectedId || bot.unread) return true;
  return (bot.tasks ?? []).some((task) => task.unread || task.state === "needs-you");
}

/** The agents the sidebar lists under this choice, and how many it leaves
 * to the Agents page. */
export function filterAgents<T extends ListedAgent>(bots: readonly T[], filter: AgentFilter, selectedId: string | null): { shown: T[]; more: number } {
  if (filter === "all") return { shown: [...bots], more: 0 };
  const shown = bots.filter((b) => inFavorites(b, selectedId));
  return { shown, more: bots.length - shown.length };
}

export const AGENT_FILTER_KEY = "bloks-sidebar-agents";
const EVENT = "bloks:sidebar-agents";

type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;

export function readAgentFilter(storage: Storage | undefined): AgentFilter {
  try {
    return storage?.getItem(AGENT_FILTER_KEY) === "favorites" ? "favorites" : "all";
  } catch {
    return "all";
  }
}

export function writeAgentFilter(storage: Storage | undefined, filter: AgentFilter): void {
  try {
    storage?.setItem(AGENT_FILTER_KEY, filter);
  } catch {
    // private mode: the choice lasts as long as the window does
  }
}

const local = (): Storage | undefined => (typeof localStorage === "undefined" ? undefined : localStorage);

/** The choice, the same in every window of this device. All by default. */
export function useAgentFilter(): [AgentFilter, (next: AgentFilter) => void] {
  const [filter, setFilter] = useState(() => readAgentFilter(local()));
  useEffect(() => {
    const sync = () => setFilter(readAgentFilter(local()));
    window.addEventListener(EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);
  const set = (next: AgentFilter) => {
    writeAgentFilter(local(), next);
    setFilter(next);
    window.dispatchEvent(new Event(EVENT));
  };
  return [filter, set];
}
