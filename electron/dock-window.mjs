// A panel of the side dock in a window of its own: which panel, for which
// agent and conversation, and the address that window loads. Plain Node,
// like terminal-window.mjs, so the tests can read it without starting
// Electron.
//
// The page asks with a panel's name and two ids, and that is all it can
// ask with: a panel this list does not have, or an id that is not one, is
// refused rather than pasted into an address the window will load. The
// terminal has its own window (terminal-window.mjs). The browser's window
// is the one panel window its pages may be laid over (main.mjs,
// browserMayShowIn): they move into it while it is open, and go back to
// the main window's panel once it closes. The computer stays where it is.

/** The panels that open in a window of their own. */
export const DOCK_WINDOW_PANELS = ["docs", "changes", "tasks", "browser"];

/** Whether a panel window's address is the browser's. */
export const isBrowserWindowQuery = (query) => typeof query === "string" && query.startsWith("dock=browser&");

const ID = /^[\w-]{1,64}$/;

/** What was asked for, checked, or null. */
export function dockWindowTarget(raw) {
  if (!raw || typeof raw !== "object") return null;
  const { panel, botId, laneId } = raw;
  if (!DOCK_WINDOW_PANELS.includes(panel)) return null;
  if (typeof botId !== "string" || !ID.test(botId) || typeof laneId !== "string" || !ID.test(laneId)) return null;
  return { panel, botId, laneId };
}

/** The query that makes the app's page draw only that panel (App.tsx), or
 * null for anything that is not a target. */
export function dockWindowQuery(raw) {
  const target = dockWindowTarget(raw);
  if (!target) return null;
  return `dock=${encodeURIComponent(target.panel)}&agent=${encodeURIComponent(target.botId)}&lane=${encodeURIComponent(target.laneId)}`;
}
