// The address a side dock panel's own window loads, read back by the page
// (src/components/dock/DockWindow.tsx, electron/dock-window.mjs). No React
// and no page: the tests read it.

export type DockWindowPanel = "docs" | "changes" | "tasks" | "browser";

/** What a dock window was opened for, if the address names it. */
export function dockWindowFor(search: string): { panel: DockWindowPanel; botId: string; laneId: string } | null {
  const q = new URLSearchParams(search);
  const panel = q.get("dock");
  const botId = q.get("agent") ?? "";
  const laneId = q.get("lane") ?? "";
  if (panel !== "docs" && panel !== "changes" && panel !== "tasks" && panel !== "browser") return null;
  if (!/^[\w-]{1,64}$/.test(botId) || !/^[\w-]{1,64}$/.test(laneId)) return null;
  return { panel, botId, laneId };
}
