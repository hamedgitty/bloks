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
  // subscription and plan limits, and API rate limits. Claude Code names
  // the limit it hit ("You've hit your session limit"), so the kind of
  // limit is left open rather than listed.
  // (Moonshot, Kimi's API, says "exceeded your current token quota" and
  // "exceeded_current_quota_error")
  ["limit", /usage limit|(?:hit|reached) your (?:[\w-]+ )?limit|(?:session|5-hour|five-hour|opus|sonnet) limit|limit (?:reached|exceeded)|rate[ _-]?limit|too many requests|\b429\b|quota (?:exceeded|exhausted)|exceeded (?:your |the )?(?:current )?(?:[\w-]+ )?quota|exceeded_current_quota|resource[_ ]exhausted|out of (?:usage|messages)|weekly limit|daily limit/i],
  // the provider, not the account
  ["overloaded", /overloaded|\b529\b|\b503\b|service unavailable|temporarily unavailable|capacity (?:constraints|limits)|server is busy/i],
  // money ("余额不足" is "insufficient balance", from providers in China)
  ["credit", /credit balance is too low|insufficient[_ ](?:quota|credits|funds|(?:account )?balance)|billing (?:hard )?limit|payment required|\b402\b|out of credits|check your plan and billing|余额不足/i],
  // the engine cannot act for this person at all right now ("Authentication
  // required" is what an ACP agent answers when its login has lapsed)
  ["signedOut", /not (?:logged|signed) in|please (?:run \/login|log ?in|sign in)|invalid api key|incorrect api key|invalid x-api-key|authentication (?:failed|error|required)|unauthori[sz]ed|\b401\b|oauth token (?:has )?expired/i],
];

/** Why the engine is out, or null when the failure is about the work. */
export function outReason(text: string | null | undefined): OutReason | null {
  const said = (text ?? "").slice(0, 4000);
  if (!said.trim()) return null;
  for (const [reason, pattern] of PATTERNS) if (pattern.test(said)) return reason;
  return null;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
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

/** A zone's wall clock at an instant, read as if it were UTC. */
function wallParts(zone: string, at: number): { year: number; month: number; day: number; asUtc: number } | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    }).formatToParts(new Date(at));
    const n = (type: string) => Number(parts.find((p) => p.type === type)?.value);
    const [year, month, day] = [n("year"), n("month") - 1, n("day")];
    return { year, month, day, asUtc: Date.UTC(year, month, day, n("hour"), n("minute"), n("second")) };
  } catch {
    // a zone this runtime does not know
    return null;
  }
}

/** How far a zone's clock is ahead of UTC at an instant, or null for an unknown zone. */
function offsetIn(zone: string, at: number): number | null {
  const wall = wallParts(zone, at);
  return wall ? wall.asUtc - Math.floor(at / 1000) * 1000 : null;
}

/** The date it is in a zone at an instant. */
function wallDate(zone: string, at: number) {
  return wallParts(zone, at);
}

/**
 * When the engine said it would be usable again, as a time, or null.
 * Reads the shapes providers actually use: an epoch after a pipe (Claude
 * Code's "usage limit reached|1759000000"), "try again in 20m" or "in 1
 * hour 5 minutes", "retry after 30 seconds", a clock time like "resets
 * 3pm" or "resets at 15:30", and a date and time like "resets Oct 9, 3pm",
 * each in the zone named after it ("(Asia/Yerevan)") when there is one.
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

  // a weekly limit names the day too: "resets Oct 9, 3pm"
  const dated = said.match(/resets?(?: on)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:,|\s+at)?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  const clock = dated ? null : said.match(/resets?(?: at)?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  const time = dated ? dated.slice(3) : clock?.slice(1);
  if (time) {
    let hour = Number(time[0]);
    const minute = Number(time[1] ?? 0);
    const half = time[2]?.toLowerCase();
    if (half === "pm" && hour < 12) hour += 12;
    if (half === "am" && hour === 12) hour = 0;
    if (hour < 24 && minute < 60 && (half || time[1])) {
      // Claude Code says whose clock it means: "resets 3:20pm
      // (Asia/Yerevan)" is the account's zone, which need not be this
      // computer's (a server in another country, a laptop that
      // travelled). Read without it, the engine rests hours too long or
      // comes back while it is still out.
      const zone = said.match(/\(([A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)+|UTC|GMT)\)/)?.[1];
      const wall = zone && offsetIn(zone, now) !== null ? zone : null;
      const today = wall ? wallDate(wall, now) : null;
      const at = (year: number, month: number, day: number) => {
        if (!wall) return new Date(year, month, day, hour, minute, 0, 0).getTime();
        // the instant whose wall clock there reads this, settled twice so
        // a daylight saving change between now and then is counted
        const guess = Date.UTC(year, month, day, hour, minute);
        const first = guess - (offsetIn(wall, guess) ?? 0);
        return guess - (offsetIn(wall, first) ?? 0);
      };
      const local = new Date(now);
      const year = today?.year ?? local.getFullYear();
      if (dated) {
        const month = MONTHS.indexOf(dated[1].toLowerCase());
        const day = Number(dated[2]);
        const then = at(year, month, day);
        // a date already past this year means next year's
        return then > now ? then : at(year + 1, month, day);
      }
      const month = today?.month ?? local.getMonth();
      const day = today?.day ?? local.getDate();
      const then = at(year, month, day);
      // a reset time already past today means tomorrow's
      return then > now ? then : at(year, month, day + 1);
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
  const today = new Date(now);
  if (today.toDateString() === at.toDateString()) return `until ${time}`;
  const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  if (tomorrow.toDateString() === at.toDateString()) return `until ${time} tomorrow`;
  // a weekly limit can be days away, and "tomorrow" would be a promise
  return `until ${at.toLocaleDateString([], { weekday: "long" })} ${time}`;
}

export const REASON_WORDS: Record<OutReason, string> = {
  limit: "is out of usage",
  overloaded: "is overloaded",
  credit: "is out of credit",
  signedOut: "is not signed in",
};
