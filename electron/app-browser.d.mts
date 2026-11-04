// Hand-written twin of app-browser.mjs: the shared shapes, and the
// things that are the app's alone.

import type { AppBrowser, TabHandle } from "../server/browser-core.mjs";

export * from "../server/browser-core.mjs";

export function partitionFor(workspaceId: string): string;

/** The parts of a webContents holdDialogs listens to. */
export interface DialogContents {
  listenerCount(event: string): number;
  removeAllListeners(event: string): unknown;
  on(event: "-run-dialog", listener: (info: { dialogType?: string; messageText?: string; defaultPromptText?: string }, callback: (accept: boolean, text: string) => void) => void): unknown;
  on(event: "-cancel-dialogs", listener: () => void): unknown;
  on(event: "will-prevent-unload", listener: (event: { preventDefault(): void }) => void): unknown;
  isDestroyed?(): boolean;
}

export function holdDialogs(options: {
  browser: AppBrowser;
  tab: TabHandle & { redo?: { at: number; run: () => unknown } | null };
  tabId: string;
  contents: DialogContents;
  log?: (line: string) => void;
  now?: () => number;
}): void;
