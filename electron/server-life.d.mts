// Hand-written twin of server-life.mjs, so the tests typecheck against
// the same shapes the main process uses.
export const RESTART_DELAYS: number[];
export const STEADY_MS: number;

/** What the keeper needs of a server: Electron's UtilityProcess has it. */
export interface ServerChild {
  once(event: "exit", listener: (code: number) => void): unknown;
  kill(): unknown;
}

export function keepServerUp<Child extends ServerChild>(options: {
  start: () => Promise<Child | null> | Child | null;
  quitting: () => boolean;
  onBack?: (child: Child) => void;
  onGaveUp?: () => void;
  delays?: number[];
  steadyMs?: number;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
}): { watch(child: Child): void };
