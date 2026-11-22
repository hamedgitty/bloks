// Hand-written twin of extension-windows.mjs, so the tests typecheck
// against the same shapes the main process uses.
export const POPUP_MIN: number;
export const POPUP_MAX: { width: number; height: number };
export const BLUR_GRACE_MS: number;

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function anchorFrom(rect: unknown): Rect | null;
export function popupSize(size: { width?: number; height?: number } | null | undefined): { width: number; height: number };
export function popupPosition(options: { anchor: Rect; zoom?: number; content: Rect; size: { width: number; height: number }; area: Rect }): { x: number; y: number };
export function windowOptions(options: { page: "popup" | "options"; partition: string; title: string; parent?: unknown }): Record<string, any> & { webPreferences: Record<string, unknown> };

export interface GuardedContents {
  on(event: string, listener: (event: any, ...args: any[]) => void): unknown;
  setWindowOpenHandler(handler: (details: { url: string }) => { action: "deny" | "allow" }): void;
}
export function guardExtensionWindow(wc: GuardedContents, extensionId: string, out?: (url: string) => void): void;

export function openExtensionWindow(options: {
  BrowserWindow: new (options: Record<string, unknown>) => any;
  screen: { getDisplayMatching(rect: Rect): { workArea: Rect } };
  parent: any;
  page: "popup" | "options";
  partition: string;
  title: string;
  url: string;
  extensionId: string;
  anchor?: unknown;
  out?: (url: string) => void;
  made?: (win: any) => void;
  now?: () => number;
}): Promise<any>;
