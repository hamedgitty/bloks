// Hand-written twin of dock-window.mjs, so the tests typecheck against the
// same shapes the main process uses.
export const DOCK_WINDOW_PANELS: readonly string[];
export function dockWindowTarget(raw: unknown): { panel: string; botId: string; laneId: string } | null;
export function dockWindowQuery(raw: unknown): string | null;
export function isBrowserWindowQuery(query: unknown): boolean;
