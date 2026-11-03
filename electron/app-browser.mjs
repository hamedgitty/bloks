// The browser inside the Bloks window: what is the desktop app's alone.
//
// Its rules and an agent's commands are shared with the browser a server
// with no app behind it keeps for itself (server/browser-core.mjs), so
// the two can never come to answer the same page differently. What is
// left here is only the app's: the session each workspace browses in.
// main.mjs owns the Electron half, the WebContentsView for each tab and
// the window it sits in.

export * from "../server/browser-core.mjs";

/** Each workspace browses in a session of its own, kept on disk: its
 * cookies and sign-ins are that workspace's, and never the app's. */
export function partitionFor(workspaceId) {
  const safe = String(workspaceId ?? "").replace(/[^\w-]/g, "_").slice(0, 64) || "personal";
  return `persist:bloks-browser-${safe}`;
}
