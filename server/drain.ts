// Finishing what is running before a planned restart (GitHub 161).
//
// An update used to restart Bloks whenever the person pressed the button,
// and whatever was running was cut off and picked up again afterwards
// (server/cut-off.ts). That works, but a turn that gets to finish is
// better than one that has to pick itself up. So before a planned
// restart Bloks drains: nothing new starts, what is running carries on,
// and the restart waits until it is all done or a deadline passes,
// whichever is first. A turn still running at the deadline is cut off
// like any other and picked up the same way.
//
// Nothing that arrives meanwhile is turned away. It waits where it
// would have waited for a busy lane, in the lane's queue, which is on
// disk, so the restart does not lose it and it goes in its own lane
// when Bloks is back.
//
// Kept in memory. A restart ends a drain by definition, and a drain left
// on by a restart that never came would hold every message forever.

/** How long a drain waits when nobody says. */
export const DRAIN_DEFAULT_MS = 20 * 60_000;

/** The longest anybody may ask for. Under the two hours a routine may
 * fire late (server/routines.ts), so one held back by a drain still
 * fires once Bloks is back. */
export const DRAIN_MAX_MS = 60 * 60_000;

/** How long a drain waits, from what was asked: seconds, defaulted and
 * kept within bounds. */
export function drainWindow(seconds: unknown): number {
  const asked = typeof seconds === "number" ? seconds : typeof seconds === "string" && seconds.trim() ? Number(seconds) : NaN;
  if (!Number.isFinite(asked) || asked <= 0) return DRAIN_DEFAULT_MS;
  return Math.min(Math.round(asked * 1000), DRAIN_MAX_MS);
}

export interface DrainStatus {
  draining: boolean;
  since?: number;
  deadline?: number;
  /** Turns still running, as the list of turns in flight has them. */
  running: Array<{ laneId: string; botId: string; roomId?: string; startedAt: number; tool?: string }>;
  /** Nothing is running. */
  idle: boolean;
  /** Safe to restart now: draining, and idle or out of time. */
  done: boolean;
}

export class Drain {
  private window: { since: number; deadline: number } | null = null;

  /** Starts a drain, or moves the deadline of the one under way. */
  start(ms: number, now = Date.now()) {
    this.window = { since: this.window?.since ?? now, deadline: now + ms };
    return this.window;
  }

  /** Ends it. True when there was one to end. */
  stop(): boolean {
    const was = Boolean(this.window);
    this.window = null;
    return was;
  }

  get on(): boolean {
    return this.window !== null;
  }

  status(running: DrainStatus["running"], busy: boolean, now = Date.now()): DrainStatus {
    const idle = running.length === 0 && !busy;
    if (!this.window) return { draining: false, running, idle, done: false };
    return {
      draining: true,
      since: this.window.since,
      deadline: this.window.deadline,
      running,
      idle,
      done: idle || now >= this.window.deadline,
    };
  }
}

/** What anybody who tries to start something now is told. */
export const DRAINING_TEXT = "Bloks is finishing what is running before it restarts. This waits until it is back.";
