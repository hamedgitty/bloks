// Backup engines: when the one an agent runs on runs out, another answers.
//
// Every engine an agent can run on is somebody's quota. A Claude or
// ChatGPT subscription stops at its limit until a reset hours away, an
// API key hits its rate limit or its credit, a provider is overloaded
// for twenty minutes. Until now each of those ended the turn with an
// error, and the work waited for a person to notice, pick another model
// and say it again.
//
// An agent can name a backup. When a turn fails because its engine is
// out (not because the task went wrong), the same message is handed to
// the backup, which picks the conversation up the way any engine switch
// does: the story so far is replayed to it. The engine that ran out is
// left alone until it should be usable again, for every agent on it,
// since a limit belongs to the account and not to one agent. After that
// the agent goes back to its own engine by itself.
//
// Deciding "out" is reading error text, which no two providers phrase
// alike. The patterns are deliberately about capacity and access, never
// about the work: a failed test or a refused command must stay a failed
// turn, or the backup would get to repeat whatever went wrong.
//
// Everything here is pure except the cooldown table, which lives in
// memory: after a restart the first turn simply tries the main engine
// again, which costs one failed attempt at most.

export type OutReason = "limit" | "overloaded" | "credit" | "signedOut";

const PATTERNS: Array<[OutReason, RegExp]> = [
  // subscription and plan limits, and API rate limits
  ["limit", /usage limit|hit your (?:usage )?limit|you'?ve hit your limit|limit (?:reached|exceeded)|rate[ _-]?limit|too many requests|\b429\b|quota (?:exceeded|exhausted)|exceeded your (?:current )?quota|resource[_ ]exhausted|out of (?:usage|messages)|weekly limit|daily limit/i],
  // the provider, not the account
  ["overloaded", /overloaded|\b529\b|\b503\b|service unavailable|temporarily unavailable|capacity (?:constraints|limits)|server is busy/i],
  // money
  ["credit", /credit balance is too low|insufficient[_ ](?:quota|credits|funds|balance)|billing (?:hard )?limit|payment required|\b402\b|out of credits/i],
  // the engine cannot act for this person at all right now
  ["signedOut", /not (?:logged|signed) in|please (?:run \/login|log ?in|sign in)|invalid api key|incorrect api key|invalid x-api-key|authentication (?:failed|error)|unauthori[sz]ed|\b401\b|oauth token (?:has )?expired/i],
];

/** Why the engine is out, or null when the failure is about the work. */
export function outReason(text: string | null | undefined): OutReason | null {
  const said = (text ?? "").slice(0, 4000);
  if (!said.trim()) return null;
  for (const [reason, pattern] of PATTERNS) if (pattern.test(said)) return reason;
  return null;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** How long to leave an engine alone when it says nothing about when. */
const DEFAULT_REST: Record<OutReason, number> = {
  limit: 30 * MINUTE,
  overloaded: 10 * MINUTE,
  credit: 6 * HOUR,
  signedOut: 6 * HOUR,
};
/** Never longer than this, whatever the text claims: a misread reset
 * should cost an afternoon on the backup, not a week. */
const MAX_REST = 12 * HOUR;

/**
 * When the engine said it would be usable again, as a time, or null.
 * Reads the shapes providers actually use: an epoch after a pipe (Claude
 * Code's "usage limit reached|1759000000"), "try again in 20m" or "in 1
 * hour 5 minutes", "retry after 30 seconds", and a clock time like
 * "resets 3pm" or "resets at 15:30".
 */
export function resetAt(text: string, now = Date.now()): number | null {
  const said = text ?? "";

  const epoch = said.match(/\|\s*(\d{10,13})\b/);
  if (epoch) {
    const n = Number(epoch[1]);
    const ms = n < 1e12 ? n * 1000 : n;
    if (ms > now) return ms;
  }

  const after = said.match(/(?:try again|retry|available again|resets?)(?: after| in)\s+((?:\d+(?:\.\d+)?\s*(?:h(?:ours?|rs?)?|m(?:in(?:ute)?s?)?|s(?:ec(?:ond)?s?)?)\s*,?\s*(?:and\s*)?)+)/i);
  if (after) {
    let ms = 0;
    for (const [, amount, unit] of after[1].matchAll(/(\d+(?:\.\d+)?)\s*([hms])/gi)) {
      const n = Number(amount);
      ms += unit.toLowerCase() === "h" ? n * HOUR : unit.toLowerCase() === "m" ? n * MINUTE : n * 1000;
    }
    if (ms > 0) return now + ms;
  }

  const clock = said.match(/resets?(?: at)?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (clock) {
    let hour = Number(clock[1]);
    const minute = Number(clock[2] ?? 0);
    const half = clock[3]?.toLowerCase();
    if (half === "pm" && hour < 12) hour += 12;
    if (half === "am" && hour === 12) hour = 0;
    if (hour < 24 && minute < 60 && (half || clock[2])) {
      const at = new Date(now);
      at.setHours(hour, minute, 0, 0);
      // a reset time already past today means tomorrow's
      if (at.getTime() <= now) at.setDate(at.getDate() + 1);
      return at.getTime();
    }
  }
  return null;
}

/** When to try an engine again after it said `text`. */
export function restUntil(reason: OutReason, text: string, now = Date.now()): number {
  const said = resetAt(text, now);
  const until = said ?? now + DEFAULT_REST[reason];
  return Math.min(until, now + MAX_REST);
}

export interface Rest {
  until: number;
  reason: OutReason;
}

/** Engines resting after running out, by instance id. */
export class Cooldowns {
  private resting = new Map<string, Rest>();

  rest(instanceId: string, reason: OutReason, text: string, now = Date.now()): Rest {
    const rest = { until: restUntil(reason, text, now), reason };
    this.resting.set(instanceId, rest);
    return rest;
  }

  /** The rest an engine is on, or undefined once it is over. */
  of(instanceId: string, now = Date.now()): Rest | undefined {
    const rest = this.resting.get(instanceId);
    if (rest && rest.until <= now) {
      this.resting.delete(instanceId);
      return undefined;
    }
    return rest;
  }

  clear(instanceId: string) {
    this.resting.delete(instanceId);
  }

  all(now = Date.now()): Record<string, Rest> {
    const out: Record<string, Rest> = {};
    for (const id of [...this.resting.keys()]) {
      const rest = this.of(id, now);
      if (rest) out[id] = rest;
    }
    return out;
  }
}

/** "until 3:00 PM", "for about 20 minutes": for the note in the chat. */
export function describeRest(rest: Rest, now = Date.now()): string {
  const left = rest.until - now;
  if (left < 90 * MINUTE) {
    const minutes = Math.max(1, Math.round(left / MINUTE));
    return `for about ${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  const at = new Date(rest.until);
  const time = at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const sameDay = new Date(now).toDateString() === at.toDateString();
  return sameDay ? `until ${time}` : `until ${time} tomorrow`;
}

export const REASON_WORDS: Record<OutReason, string> = {
  limit: "is out of usage",
  overloaded: "is overloaded",
  credit: "is out of credit",
  signedOut: "is not signed in",
};
