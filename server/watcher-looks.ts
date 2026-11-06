// What a watcher's last looks found (GitHub 496).
//
// A watcher's last error says only how its latest look went, and the next
// ordinary look clears it. A finding held back by the hourly limit, or a
// look skipped while the agent worked, left no trace at all, so "why did
// it not wake me at four?" had no answer. Each watcher keeps its last
// fifty looks here: when, what came of it (it started a turn, found
// nothing new, was held back by its limit, was skipped while the agent
// was busy, or failed) and a short line saying what or why.
//
// Looks that say the same thing in a row are one entry with a count and
// a span: a quiet page looked at every five minutes, or a long turn that
// has every minute's look skipped, would otherwise push the one held
// back look out of the fifty within hours. What it acted on, and what
// failed, always stand alone.
//
// A watcher can look every minute, and watchers.json is written whole, so
// the looks are not kept in it. Each look is one line appended to a file
// of their own, and the file is written again only when it holds a few
// times what is kept, or a watcher is removed, so nothing it found stays
// on disk after it.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

import { writeFileAtomic } from "./atomic-write.ts";
import { MAX_WATCHERS } from "./watchers.ts";

export type LookOutcome = "fired" | "quiet" | "held" | "busy" | "failed";

export interface Look {
  /** When it looked; for several alike in a row, the latest of them. */
  at: number;
  /** fired: it started a turn (or queued one behind a busy conversation,
   * or a rehearsal); quiet: nothing new, its first look's baseline among
   * them; held: a finding past its hourly limit, kept for the next turn
   * allowed; busy: skipped while its agent worked, so nothing was used
   * up; failed: the look itself went wrong. */
  outcome: LookOutcome;
  /** One line: the first of what it found, the error, or why it skipped. */
  detail?: string;
  /** Held back: when its limit next allows a turn. */
  nextAt?: number;
  /** Several alike in a row: how many, and when the first was. */
  count?: number;
  from?: number;
}

/** Entries kept per watcher. */
export const MAX_LOOKS = 50;
/** What one entry's line may say. */
export const MAX_DETAIL = 200;
/** Outcomes that repeat in a row as one entry. A turn started and a
 * failure are each worth their own line. */
const RUNS: ReadonlySet<LookOutcome> = new Set(["quiet", "busy", "held"]);
/** Lines the file may hold before it is written again with only what is
 * kept: a few times the most fifty watchers keep. */
const MAX_LINES = 4 * MAX_WATCHERS * MAX_LOOKS;

/** A look as it is kept: its line clipped to one line of MAX_DETAIL. */
function tidy(look: Look): Look {
  const detail = look.detail?.split("\n").find((line) => line.trim())?.trim().slice(0, MAX_DETAIL);
  return {
    at: look.at,
    outcome: look.outcome,
    ...(detail ? { detail } : {}),
    ...(look.nextAt !== undefined ? { nextAt: look.nextAt } : {}),
    ...(look.count !== undefined && look.count > 1 ? { count: look.count } : {}),
    ...(look.from !== undefined && look.count !== undefined && look.count > 1 ? { from: look.from } : {}),
  };
}

/**
 * The list with one more look, newest first and at most MAX_LOOKS. A look
 * that says what the newest entry says, for an outcome that runs, joins
 * it: one more to its count, its time the newer one, its next allowed
 * turn the newer one's. An entry carrying a count of its own (read back
 * from the file) adds its whole count.
 */
export function addLook(list: readonly Look[], look: Look): Look[] {
  const next = tidy(look);
  const newest = list[0];
  if (newest && RUNS.has(next.outcome) && newest.outcome === next.outcome && newest.detail === next.detail && next.at >= newest.at) {
    const joined = tidy({
      ...next,
      count: (newest.count ?? 1) + (next.count ?? 1),
      from: Math.min(newest.from ?? newest.at, next.from ?? next.at),
    });
    return [joined, ...list.slice(1)];
  }
  return [next, ...list].slice(0, MAX_LOOKS);
}

/**
 * A watcher's history as it is shown: its looks, then the turns it started
 * before the oldest of them, from before looks were kept or pushed out
 * since, so a watcher that rarely acts still shows when it last did. Each
 * turn a look started is kept at the turn's own time, which tells the two
 * apart. At most MAX_LOOKS in all.
 */
export function lookHistory(looks: readonly Look[], fires: ReadonlyArray<{ at: number; summary: string }>): Look[] {
  const oldest = looks.reduce((at, look) => Math.min(at, look.from ?? look.at), Infinity);
  const earlier = fires
    .filter((f) => f.at < oldest)
    .sort((a, b) => b.at - a.at)
    .map((f): Look => ({ at: f.at, outcome: "fired", ...(f.summary ? { detail: f.summary } : {}) }));
  return [...looks, ...earlier].slice(0, MAX_LOOKS);
}

interface Line extends Look {
  /** The watcher it is a look of. */
  w: string;
}

/** Every watcher's looks, kept in memory and in a file of one line each. */
export class LookLog {
  private readonly file: string;
  private readonly looks = new Map<string, Look[]>();
  private lines = 0;

  constructor(file: string) {
    this.file = file;
    if (!existsSync(file)) return;
    let text = "";
    try {
      text = readFileSync(file, "utf8");
    } catch {
      return;
    }
    // oldest first, as they were written, so they join as they did then
    for (const raw of text.split("\n")) {
      if (!raw.trim()) continue;
      this.lines++;
      try {
        const { w, ...look } = JSON.parse(raw) as Line;
        if (typeof w !== "string" || typeof look.at !== "number" || typeof look.outcome !== "string") continue;
        this.looks.set(w, addLook(this.looks.get(w) ?? [], look));
      } catch {
        /* a line cut short by a crash */
      }
    }
  }

  /** One watcher's looks, newest first. */
  list(watcherId: string): Look[] {
    return this.looks.get(watcherId) ?? [];
  }

  /** One more look. Never throws: a history that cannot be written is
   * not a reason for a look to fail. */
  record(watcherId: string, look: Look) {
    this.looks.set(watcherId, addLook(this.list(watcherId), look));
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      appendFileSync(this.file, `${JSON.stringify({ w: watcherId, ...tidy(look) })}\n`, { mode: 0o600 });
      this.lines++;
      if (this.lines > MAX_LINES) this.compact();
    } catch {
      /* kept in memory; written whole next time it is compacted */
    }
  }

  /** A watcher removed: its looks go with it, from the file too. */
  forget(watcherId: string) {
    if (this.looks.delete(watcherId)) this.compactQuietly();
  }

  /** Only these watchers' looks are kept, for looks left by watchers
   * removed while the file could not be written. */
  keepOnly(watcherIds: Iterable<string>) {
    const keep = new Set(watcherIds);
    let dropped = false;
    for (const id of [...this.looks.keys()]) {
      if (keep.has(id)) continue;
      this.looks.delete(id);
      dropped = true;
    }
    if (dropped) this.compactQuietly();
  }

  /** The file written again with only what is kept, oldest first. */
  private compact() {
    const out: string[] = [];
    for (const [w, list] of this.looks) {
      for (const look of [...list].reverse()) out.push(JSON.stringify({ w, ...look }));
    }
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    writeFileAtomic(this.file, out.length ? `${out.join("\n")}\n` : "", 0o600, { flush: false });
    this.lines = out.length;
  }

  private compactQuietly() {
    try {
      this.compact();
    } catch {
      /* the lines stay until the next time; keepOnly drops them at start */
    }
  }
}
