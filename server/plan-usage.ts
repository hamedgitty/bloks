// What an engine's plan has left, in the engine's own numbers.
//
// Claude Code and Codex both report the limits of the subscription they
// are signed in with, on the side of every turn: Claude Code as a
// `rate_limit_event`, Codex as `account/rateLimits/updated`. Antigravity
// does not carry quota in ACP frames, so the ACP driver asks its
// read-only `agy -p "/usage" --output-format json` command for its
// model-group buckets (Gemini models, and Claude and GPT models). Bloks
// read Claude Code's only to know when a limit had stopped a turn (see
// server/failover.ts). Kept, the same numbers answer the question a
// person has before sending something long: starting a fresh
// conversation does not help when the week's limit is nearly used up
// (GitHub 224).
//
// Only the latest is kept, per engine, in memory: it describes right
// now, a restart forgets it, and the next turn brings it back. It is for
// the person at this Mac to read. An agent is never told it.
//
// The same numbers also say when a limit is coming before anyone opens
// the card: a notice in the composer when a window is used up, nearly
// used up, or being used faster than it renews (planNotices).
//
// Everything here is pure.

import type { PlanUsage, PlanWindow, UsageLevel, UsageNotice } from "./contracts.ts";
import { NAMED_PLAN_WINDOWS, planWindowName, reportedPlanWindow } from "./plan-window.ts";

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

/** How long one of Antigravity's buckets is, from its window token
 * ("5h", "weekly") or its known bucket id. */
function antigravityWindowMinutes(window: unknown, id: string): number | null {
  if (typeof window === "string") {
    const token = window.trim().toLowerCase();
    if (token === "weekly") return 7 * 24 * 60;
    if (token === "daily") return 24 * 60;
    const match = /^(\d+)\s*([mhd])$/.exec(token);
    if (match) {
      const amount = Number(match[1]);
      if (Number.isSafeInteger(amount) && amount > 0) {
        return match[2] === "d" ? amount * 24 * 60 : match[2] === "h" ? amount * 60 : amount;
      }
    }
  }
  if (id === "gemini-5h" || id === "3p-5h") return 5 * 60;
  if (id === "gemini-weekly" || id === "3p-weekly") return 7 * 24 * 60;
  return null;
}

/** An ISO 8601 reset time (or numeric epoch) in milliseconds. Untouched
 * Antigravity buckets report the Unix epoch ("1970-01-01T00:00:00Z"),
 * which means no reset is scheduled yet rather than an expired window. */
function resetTimeMs(value: unknown): number | null {
  if (typeof value === "number") return epochMs(value);
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : null;
}

/**
 * The plan's windows from Antigravity's read-only print-mode usage
 * command (`agy -p "/usage" --output-format json`).
 *
 * Each model group (Gemini models, Claude and GPT models) carries its
 * own 5-hour and weekly buckets as `remaining_fraction` in [0, 1],
 * converted here to the share used. Untouched buckets report the Unix
 * epoch for `reset_time`, which becomes null so the window stays visible.
 * Disabled or non-numeric buckets are skipped. Null when nothing
 * measurable is in the payload.
 */
export function antigravityPlanUsage(payload: unknown, plan: string | null = null, now = Date.now()): PlanUsage | null {
  if (!payload || typeof payload !== "object") return null;
  const root = payload as Record<string, any>;
  if (typeof root.status === "string" && root.status.toUpperCase() !== "SUCCESS") return null;
  const data = root.command && typeof root.command === "object" ? root.command.data : root;
  const groups = Array.isArray(data?.groups) ? data.groups : null;
  if (!groups) return null;
  const windows: PlanWindow[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    if (!group || typeof group !== "object" || !Array.isArray(group.buckets)) continue;
    const groupName = typeof group.name === "string" ? group.name.trim() : "";
    for (const bucket of group.buckets) {
      if (!bucket || typeof bucket !== "object" || bucket.disabled === true) continue;
      const remaining = bucket.remaining_fraction;
      if (typeof remaining !== "number" || !Number.isFinite(remaining) || remaining < 0 || remaining > 1) continue;
      const rawId = typeof bucket.id === "string" && bucket.id.trim()
        ? bucket.id.trim()
        : [
            groupName,
            typeof bucket.window === "string" ? bucket.window.trim() : typeof bucket.name === "string" ? bucket.name.trim() : "",
          ].filter(Boolean).join(" ");
      if (!rawId || !planWindowName(rawId)) continue;
      const id = Array.from(rawId).slice(0, 200).join("");
      if (seen.has(id)) continue;
      seen.add(id);
      windows.push({
        id,
        minutes: antigravityWindowMinutes(bucket.window, id),
        used: Math.max(0, 1 - remaining),
        resetsAt: resetTimeMs(bucket.reset_time),
      });
    }
  }
  if (!windows.length) return null;
  const rawPlan = typeof plan === "string" && plan.trim()
    ? plan
    : typeof data?.tier?.name === "string"
      ? data.tier.name
      : typeof data?.tier === "string"
        ? data.tier
        : null;
  const cleanPlan = rawPlan ? (planWindowName(rawPlan) || null) : null;
  return { windows, plan: cleanPlan, at: now };
}

// ── notices ────────────────────────────────────────────────────────────

/** Antigravity's model-group buckets, by the group's name in English.
 * Must match SCOPED_WINDOWS in src/lib/contextCard.ts. */
const SCOPED_WINDOWS: Record<string, string> = {
  "gemini-5h": "Gemini",
  "gemini-weekly": "Gemini",
  "3p-5h": "Claude and GPT",
  "3p-weekly": "Claude and GPT",
};

/** Past this share a window is close to its limit, whatever the engine said. */
const NEAR = 0.8;
/** A window this new has not been used long enough to say much about pace. */
const PACE_AFTER = 0.1;
/** Under this share nobody needs telling, however fast it went. */
const PACE_FROM = 0.25;

/** Worst first, for sorting. */
export const LEVEL_ORDER: Record<UsageLevel, number> = { stop: 0, warn: 1, info: 2 };

/** A readable fallback for clients which do not yet understand planWindow,
 * in the words the Usage card uses for the same window (planWindowLabel in
 * src/lib/contextCard.ts). Null for a window whose details cannot be used,
 * which keeps the old title. */
function noticeWindow(window: PlanWindow): string | null {
  const reported = reportedPlanWindow(window);
  if (!reported) return null;
  const { id, name, minutes } = reported;
  if (id === "seven_day_opus") return "Weekly limit, Opus";
  if (id === "seven_day_sonnet") return "Weekly limit, Sonnet";
  if (id === "seven_day_overage_included") return "Weekly limit, with extra usage";
  let label = "Limit";
  if (minutes !== null) {
    if (minutes === 7 * 24 * 60) label = "Weekly limit";
    else if (minutes === 24 * 60) label = "Daily limit";
    else if (minutes % (24 * 60) === 0) label = `${minutes / (24 * 60)}-day limit`;
    else if (minutes % 60 === 0) label = `${minutes / 60}-hour limit`;
    else label = `${minutes}-minute limit`;
  }
  if (Object.hasOwn(SCOPED_WINDOWS, id)) return `${label}, ${SCOPED_WINDOWS[id]}`;
  return NAMED_PLAN_WINDOWS.has(id) ? label : `${label} (${name})`;
}

/**
 * What one engine's plan should say in the composer, worst first, at
 * most one per window, in the few words Bloks AI's own notices use:
 * a window label plus "Limit reached", or "Approaching limit" for near
 * it and on pace alike. Clients can also localize the reported window.
 *
 * At the limit is the engine's own "rejected" or a share used up; near
 * it is the engine's warning or past 80%; on pace is a share used ahead
 * of the share of the window gone by, once a tenth of the window has
 * passed and a quarter is used, so the first busy minutes of a new
 * window do not read as a run on it.
 *
 * A window whose reset has passed says nothing: its numbers were
 * replaced by ones nobody has heard yet. The id carries the window, the
 * level and the reset, so a notice put away comes back for a new window
 * or a worse level, and not before.
 */
export function planNotices(instanceId: string, usage: PlanUsage | null | undefined, now = Date.now()): UsageNotice[] {
  if (!usage || !Array.isArray(usage.windows)) return [];
  const notices: UsageNotice[] = [];
  for (const window of usage.windows) {
    if (!Number.isFinite(window.used) || window.used < 0) continue;
    if (window.resetsAt !== null && window.resetsAt <= now) continue;
    let level: UsageLevel | null = null;
    if (window.status === "rejected" || window.used >= 1) level = "stop";
    else if (window.status === "warning" || window.used >= NEAR) level = "warn";
    else if (window.minutes && window.resetsAt !== null) {
      const elapsed = 1 - (window.resetsAt - now) / (window.minutes * 60_000);
      if (elapsed >= PACE_AFTER && window.used >= PACE_FROM && window.used / elapsed > 1) level = "info";
    }
    if (!level) continue;
    const status = level === "stop" ? "Limit reached" : "Approaching limit";
    const label = noticeWindow(window);
    notices.push({
      id: `${instanceId}:${window.id}:${level}:${window.resetsAt}`,
      source: instanceId,
      level,
      title: label ? `${label}: ${status}` : status,
      usedPercent: Math.min(100, Math.max(0, Math.round(window.used * 100))),
      resetsAt: window.resetsAt,
      planWindow: { id: window.id, minutes: window.minutes },
    });
  }
  return sortNotices(notices);
}

/** Worst first, and the fuller of two alike first. */
export function sortNotices(notices: UsageNotice[]): UsageNotice[] {
  return [...notices].sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level] || b.usedPercent - a.usedPercent);
}
