// Hand-written twin of update-check.mjs, so the tests typecheck against the
// same shapes the main process uses.
export interface UpdateState {
  state: string;
  version?: string;
  percent?: number;
  reason?: string;
  draining?: unknown;
}

export type UpdateEvent = "checking" | "available" | "not-available" | "progress" | "downloaded" | "error";

export function updateFrame(
  current: UpdateState,
  event: UpdateEvent,
  detail?: { version?: string; percent?: number; reason?: string },
): UpdateState | null;

export function mayLookAgain(current: UpdateState): boolean;

export function newestBeforeInstall(
  updater: { checkForUpdates(): Promise<{ downloadPromise?: Promise<unknown> | null } | null> },
  options?: { within?: number },
): Promise<void>;
