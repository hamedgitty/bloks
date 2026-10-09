// What an engine's plan has left, in the engine's own numbers.
//
// Claude Code and Codex both report the limits of the subscription they
// are signed in with, on the side of every turn: Claude Code as a
// `rate_limit_event`, Codex as `account/rateLimits/updated`. Bloks read
// Claude Code's only to know when a limit had stopped a turn (see
// server/failover.ts). Kept, the same numbers answer the question a
// person has before sending something long: starting a fresh
// conversation does not help when the week's limit is nearly used up
// (GitHub 224).
//
// Only the latest is kept, per engine, in memory: it describes right
// now, a restart forgets it, and the next turn brings it back. It is for
// the person at this Mac to read. An agent is never told it.
//
// Everything here is pure.

import type { PlanUsage, PlanWindow } from "./contracts.ts";

/** How long each of Claude Code's windows is, by its name for it. */
const CLAUDE_WINDOW_MINUTES: Record<string, number> = {
  five_hour: 5 * 60,
  seven_day: 7 * 24 * 60,
  seven_day_opus: 7 * 24 * 60,
  seven_day_sonnet: 7 * 24 * 60,
  seven_day_overage_included: 7 * 24 * 60,
};

/** An epoch the engines give in seconds, in milliseconds. One that is
 * already in milliseconds is taken as it is. */
function epochMs(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return Math.round(value > 1e12 ? value : value * 1000);
}

/** A share used, or null for anything that is not one. Past 1 is kept:
 * Claude Code says usage can run past a window's cap. */
function share(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * The plan's windows after one of Claude Code's `rate_limit_info`.
 *
 * Newer builds send every window at once in `unifiedWindows`, each a
 * share used and a reset, and that replaces what was known. Older ones
 * speak of one window at a time (`rateLimitType`, `utilization`), which
 * is folded into what was known, and some say nothing measurable at
 * all. `status` is the engine's own warning, about the window it names.
 * Returns what was known when this says nothing usable.
 */
export function claudePlanUsage(info: unknown, previous: PlanUsage | null = null, now = Date.now()): PlanUsage | null {
  if (!info || typeof info !== "object") return previous;
  const said = info as Record<string, any>;
  const named = typeof said.rateLimitType === "string" ? said.rateLimitType : null;
  const status = said.status === "allowed_warning" ? "warning" : said.status === "rejected" ? "rejected" : undefined;
  const unified = said.unifiedWindows && typeof said.unifiedWindows === "object" ? said.unifiedWindows : null;
  const windows: PlanWindow[] = [];
  if (unified) {
    for (const [id, window] of Object.entries(unified as Record<string, any>)) {
      const used = share(window?.utilization);
      if (used === null) continue;
      windows.push({ id, minutes: CLAUDE_WINDOW_MINUTES[id] ?? null, used, resetsAt: epochMs(window?.resetsAt) });
    }
  } else {
    const used = share(said.utilization);
    if (named && used !== null) {
      windows.push({ id: named, minutes: CLAUDE_WINDOW_MINUTES[named] ?? null, used, resetsAt: epochMs(said.resetsAt) });
    }
    // one window's news, and the others stand as they were
    for (const known of previous?.windows ?? []) {
      if (!windows.some((w) => w.id === known.id)) windows.push({ ...known });
    }
  }
  if (!windows.length) return previous;
  // the warning is about the window it names, and an "allowed" clears it
  const at = named === null ? -1 : windows.findIndex((w) => w.id === named);
  if (at >= 0) {
    const { status: _was, ...window } = windows[at];
    windows[at] = status ? { ...window, status } : window;
  }
  return { windows, plan: previous?.plan ?? null, at: now };
}

/**
 * The plan's windows from Codex's `account/rateLimits/updated`, whose
 * `rateLimits` names a primary and a secondary window, each a percent
 * used, its length in minutes and a reset. Each update is the whole
 * picture. Null when it has nothing measurable in it.
 */
export function codexPlanUsage(rateLimits: unknown, now = Date.now()): PlanUsage | null {
  if (!rateLimits || typeof rateLimits !== "object") return null;
  const said = rateLimits as Record<string, any>;
  const windows: PlanWindow[] = [];
  for (const id of ["primary", "secondary"]) {
    const window = said[id];
    const percent = share(window?.usedPercent);
    if (percent === null) continue;
    const minutes = window.windowDurationMins;
    windows.push({
      id,
      minutes: typeof minutes === "number" && Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes) : null,
      used: percent / 100,
      resetsAt: epochMs(window.resetsAt),
    });
  }
  if (!windows.length) return null;
  const plan = typeof said.planType === "string" && said.planType.trim() ? said.planType.trim() : null;
  return { windows, plan, at: now };
}
