// When this workspace next has work of its own to do, for a machine that
// sleeps while nobody needs it.
//
// A hosted workspace may run on a machine that is put to sleep when it is
// idle and woken by Bloks Cloud when something arrives for it. A message
// arrives through Bloks Cloud, so it wakes the machine by arriving; a
// routine or a watcher is due on this machine's own clock, and nothing
// arrives for it. So the workspace tells Bloks Cloud when the next one is
// due (server/relay-link.ts, nextDue), and is woken then.
//
// Earliest of every routine that will run and every page, feed or check
// watcher that will look. A folder watcher is left out: a folder on this
// machine only changes while it is awake. So is a place watcher, which
// has no schedule of its own: it is asked as a reading arrives. A watcher
// holding a finding back for the hourly cap is due when the cap allows.
import { nextScheduledAfter, type Routine } from "./routines.ts";
import { nextAllowedAt, type Watcher } from "./watchers.ts";

export interface NextDueInput {
  routines: readonly Routine[];
  watchers: readonly Watcher[];
  /** Whether an agent's own work is held (archived): its routines and
   * watchers do not run, so they do not wake anything. */
  suspended: (botId: string) => boolean;
  now: number;
}

/** Epoch milliseconds of the next routine or look, or null when nothing
 * is scheduled. A watcher already overdue is due now. */
export function nextDueAt({ routines, watchers, suspended, now }: NextDueInput): number | null {
  let soonest: number | null = null;
  const consider = (at: number | null | undefined) => {
    if (typeof at !== "number" || !Number.isFinite(at)) return;
    if (soonest === null || at < soonest) soonest = at;
  };
  for (const routine of routines) {
    if (!routine.enabled || routine.failing) continue;
    if (routine.targetKind === "agent" && suspended(routine.targetId)) continue;
    consider(nextScheduledAfter(routine, new Date(now))?.getTime());
  }
  for (const watcher of watchers) {
    if (!watcher.enabled || watcher.failing || watcher.kind === "place" || watcher.kind === "app") continue;
    if (suspended(watcher.botId)) continue;
    // a finding held back by the hourly cap is work waiting on this
    // machine's clock, a folder's included (GitHub 496)
    if (watcher.held !== undefined) consider(Math.max(now, nextAllowedAt(watcher, now)));
    // a folder, a place and an app are told when something happens; only
    // what looks on a schedule needs waking for
    if (watcher.kind === "folder") continue;
    const every = Math.max(1, Number(watcher.every) || 0) * 60_000;
    consider(Math.max(now, (watcher.lastCheck ?? 0) + every));
  }
  return soonest;
}
