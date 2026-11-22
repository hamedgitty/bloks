// A panel of the side dock in a window of its own: which panel, for which
// agent and conversation, and the address that window loads. Plain Node,
// like terminal-window.mjs, so the tests can read it without starting
// Electron.
//
// The page asks with a panel's name and two ids, and that is all it can
// ask with: a panel this list does not have, or an id that is not one, is
// refused rather than pasted into an address the window will load. The
// terminal has its own window (terminal-window.mjs); the browser and the
// computer draw over the window they belong to, and stay there.

/** The panels that open in a window of their own. */
export const DOCK_WINDOW_PANELS = ["docs", "changes", "tasks"];

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
