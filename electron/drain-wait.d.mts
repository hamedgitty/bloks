// Hand-written twin of drain-wait.mjs, so the tests typecheck against the
// same shapes the main process uses.
export interface DrainState {
  draining: boolean;
  deadline?: number;
  running: unknown[];
  done: boolean;
}

export function drainWait(
  ask: (method: "POST" | "GET" | "DELETE") => Promise<DrainState | null>,
  options?: { every?: number; onProgress?: (state: DrainState) => void },
): {
  finished: Promise<"done" | "now" | "cancel">;
  stop(why: "now" | "cancel"): void;
};
