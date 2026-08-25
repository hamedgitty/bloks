// Hand-written twin of window-state.mjs, so the tests typecheck against
// the same shapes the main process uses.

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowState {
  bounds: Rect;
  maximized: boolean;
}

export const DEFAULT_SIZE: Readonly<{ width: number; height: number }>;
export const MIN_SIZE: Readonly<{ width: number; height: number }>;

export function parseWindowState(raw: unknown): WindowState | null;
export function resolveWindowState(
  saved: unknown,
  workAreas: Rect[],
): { bounds: Rect; maximized: boolean };
export function normalizeBadgeCount(value: number): number;
