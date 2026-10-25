// Watchers: when something changes, an agent does something about it.
//
// A routine runs on a clock, a webhook needs somebody to wire a service
// to it. A watcher needs a sentence: "when a new invoice lands in this
// folder, file it", "tell me when this page changes", "when this feed has
// a new post, summarise it". Three kinds of thing can be watched, all
// from this machine, nothing through anybody's cloud:
//
//   a folder     files added, changed or removed (a snapshot of names,
//                sizes and times, compared on each look)
//   a web page   its readable text, compared on each look, optionally
//                only when it mentions something
//   a feed       RSS or Atom; new entries since the last look
//
// When one changes, the agent gets a turn that says what changed and
// what it was asked to do about it, in the agent's first conversation or
// the one the watcher names, or as a rehearsal when the watcher was set
// to try things on a copy first.
//
// Three limits keep a watcher from becoming a way to spend money in a
// loop: a first look only takes a baseline and never fires, a watcher
// fires at most once per quiet period and a few times an hour, and a
// folder change made by the watcher's own agent while it works is not a
// change to react to.
//
// A fourth kind is a check: a short command the agent wrote once, run on
// a schedule without a model, so a turn is spent only when there is
// something to do ("use intelligence once to write the check, then run it
// without intelligence"). It runs in the agent's working folder, with the
// workspace's saved secrets but never the agent's workspace credential,
// under a timeout and an output cap. Because nobody is there to approve
// each run, a check an agent files runs only once the person has approved
// its command, unless that agent already runs commands without asking
// (approvals set to auto or full). Its outcome is the exit status:
//
//   0          there is something to do; what it printed says what
//   1          nothing to do (the grep and test convention)
//   other      the check itself is broken, shown on the watcher
//
// and, as with every watcher, the first look only takes a baseline and
// the same finding twice in a row is not news.
//
// A fifth kind is a place: the person arriving at one, or leaving it, as
// their own iPhone says where they are (server/location.ts). It does not
// look on a schedule. It is asked as each reading arrives, and once a
// minute only while a crossing waits to be acted on (its agent busy, say),
// and a crossing heard too late, or a fix that wobbles on the line, is
// not acted on. It can be told to act once and be done, or to stop at a
// time, since "when I land" is about one flight.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { DEFAULT_RADIUS, MAX_RADIUS, MIN_RADIUS, parsePlace } from "./location.ts";

export type WatchKind = "folder" | "page" | "feed" | "check" | "place";

export interface Watcher {
  id: string;
  botId: string;
  name: string;
  kind: WatchKind;
  /** A folder path, an http(s) URL, for a check the command it runs, and
   * for a place its name or "latitude,longitude". */
  target: string;
  /** What the agent should do when it changes. */
  instruction: string;
  /** Pages only: fire only when the new text mentions this. */
  mentions?: string;
  /** Places only: whether arriving or leaving is what it waits for. */
  when?: "arrive" | "leave";
  /** Places given by coordinates: how near counts as there, in metres. */
  radius?: number;
  /** Act once, then be done. */
  once?: boolean;
  /** Stop waiting after this time (epoch milliseconds). */
  until?: number;
  /** Finished on its own: it acted once as asked, or its time ran out.
   * Switched off at the same moment; switching it on again clears this. */
  done?: { at: number; why: "once" | "until" };
  /** Act in the real folder, or rehearse on a copy first. */
  mode: "act" | "rehearse";
  /** Minutes between looks, for pages and feeds. */
  every: number;
  enabled: boolean;
  createdAt: number;
  /** What the last look saw, to compare the next one with. */
  seen?: string;
  seenItems?: string[];
  lastCheck?: number;
  lastError?: string;
  laneId?: string;
  /** The conversation its turns go to, by title or by id, so the agent
   * hears in the context the work came from (GitHub 138). Absent means
   * the agent's first, General (GitHub 237); watchers from before that
   * were given the lane of their own they spoke in, "Watching: <name>".
   * Made if no conversation has the title; a busy one queues the turn
   * like a person's message. */
  thread?: string;
  fires: Array<{ at: number; summary: string }>;
  /** Checks only: who allowed its command to run unattended. "person"
   * is the owner, in the app; "mode" is the agent's own approvals being
   * auto or full when it filed it, which holds only while they still
   * are. Absent means nobody yet, and it does not run. */
  approvedBy?: "person" | "mode";
  /** Filed from an agent's turn: the place in a chain of agents'
   * messages its turns take (MAX_AGENT_CHAIN in server/index.ts). Absent
   * once the person has changed it or looked by hand. */
  chain?: number;
  /** Looks that failed in a row: the page would not load, the feed was
   * not one, the check broke. A look that worked puts it back to none. */
  failures?: number;
  /** Its looks on a schedule stopped after FAILS_TO_PAUSE failures in a
   * row, since when and why, as a routine's do (server/routines.ts). A
   * page that is gone answers the same error every few minutes forever.
   * The person changing it, or a look by hand that works, starts it
   * again. */
  failing?: { at: number; error: string };
}

/** Failed looks in a row before a watcher stops looking on its own. */
export const FAILS_TO_PAUSE = 3;

export const MIN_EVERY = 5;
export const MAX_EVERY = 24 * 60;
/** No more than this many turns an hour from one watcher. */
export const FIRES_PER_HOUR = 6;
/** A folder has to be still this long before its changes count. */
export const SETTLE_MS = 20_000;
const MAX_FILES = 3_000;
const SKIP = new Set(["node_modules", ".git", ".DS_Store", "dist", "build", ".next", ".cache", "__pycache__"]);

// ── folders ────────────────────────────────────────────────────────────

/** name -> "size:mtime" for every file under `dir`, capped. */
export function folderSnapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  let count = 0;
  const walk = (at: string, depth: number) => {
    if (depth > 6 || count >= MAX_FILES) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(at, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (count >= MAX_FILES) return;
      if (entry.name.startsWith(".") || SKIP.has(entry.name)) continue;
      const full = join(at, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.isFile()) {
        try {
          const st = statSync(full);
          out[relative(dir, full)] = `${st.size}:${Math.round(st.mtimeMs)}`;
          count++;
        } catch {
          /* gone between listing and looking */
        }
      }
    }
  };
  walk(dir, 0);
  return out;
}

export function folderChanges(before: Record<string, string>, after: Record<string, string>) {
  const added = Object.keys(after).filter((f) => !(f in before));
  const removed = Object.keys(before).filter((f) => !(f in after));
  const changed = Object.keys(after).filter((f) => f in before && before[f] !== after[f]);
  return { added, removed, changed };
}

export function describeFolderChanges(c: ReturnType<typeof folderChanges>): string | null {
  const list = (label: string, files: string[]) =>
    files.length ? `${label}: ${files.slice(0, 15).join(", ")}${files.length > 15 ? `, and ${files.length - 15} more` : ""}` : null;
  const lines = [list("New", c.added), list("Changed", c.changed), list("Removed", c.removed)].filter(Boolean);
  return lines.length ? lines.join("\n") : null;
}

// ── pages ──────────────────────────────────────────────────────────────

/** The words a person reads on a page: no scripts, styles or tags. */
export function pageText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<(br|\/p|\/div|\/li|\/h\d|\/tr)\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

export const hashOf = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 32);

/** Lines on the page now that were not there before, which is what a
 * person means by "what changed". */
export function newLines(before: string, after: string, max = 20): string[] {
  const had = new Set(before.split("\n"));
  return after
    .split("\n")
    .filter((line) => line.length > 2 && !had.has(line))
    .slice(0, max);
}

// ── feeds ──────────────────────────────────────────────────────────────

export interface FeedItem {
  id: string;
  title: string;
  link?: string;
}

const tag = (xml: string, name: string) => {
  const found = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  return found ? found[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<[^>]+>/g, "").trim() : "";
};

/** RSS <item>s and Atom <entry>s, newest first as the feed lists them. */
export function parseFeed(xml: string): FeedItem[] {
  const items: FeedItem[] = [];
  for (const [, block] of xml.matchAll(/<(?:item|entry)\b[^>]*>([\s\S]*?)<\/(?:item|entry)>/gi)) {
    const atomLink = block.match(/<link[^>]*href="([^"]+)"/i)?.[1];
    const link = atomLink ?? (tag(block, "link") || undefined);
    const title = tag(block, "title") || "(untitled)";
    const id = tag(block, "guid") || tag(block, "id") || link || title;
    items.push({ id, title: title.slice(0, 200), ...(link ? { link } : {}) });
    if (items.length >= 100) break;
  }
  return items;
}

// ── checks ─────────────────────────────────────────────────────────────

/** A check that has not answered in this long is stopped and counts as
 * broken, so a stuck one cannot pile up behind itself. */
export const CHECK_TIMEOUT_MS = 30_000;
/** What a check may print before the rest is ignored, and how much of it
 * the agent is shown. */
export const CHECK_MAX_BYTES = 64_000;
export const CHECK_SHOWN_CHARS = 4_000;
export const MAX_CHECK_COMMAND = 500;
/** The existing saved-text caps, counted as JavaScript string lengths. */
export const MAX_WATCHER_INSTRUCTION = 1_000;
export const MAX_WATCHER_TARGET = 1_000;

export interface CheckResult {
  code: number | null;
  output: string;
  errors: string;
  timedOut: boolean;
}

/** Runs one check: its own process group, killed whole on timeout.
 * `tail` keeps the end of what it prints rather than the start, for a
 * check like a test run that says what went wrong last (a goal's check,
 * server/goals.ts). */
export function runCheck(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs = CHECK_TIMEOUT_MS,
  options: { tail?: boolean } = {},
): Promise<CheckResult> {
  return new Promise((resolve) => {
    const windows = process.platform === "win32";
    let output = "";
    let errors = "";
    let timedOut = false;
    const keep = (kept: string, chunk: Buffer, max: number) =>
      options.tail
        ? (kept + chunk.toString("utf8")).slice(-max)
        : kept.length < max
          ? kept + chunk.toString("utf8").slice(0, max - kept.length)
          : kept;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, { cwd, env, shell: true, detached: !windows, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (e) {
      resolve({ code: null, output: "", errors: (e as Error).message, timedOut: false });
      return;
    }
    const kill = () => {
      try {
        if (!windows && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      output = keep(output, chunk, CHECK_MAX_BYTES);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      errors = keep(errors, chunk, 4_000);
    });
    child.on("error", (e) => {
      errors ||= e.message;
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      // anything the check left running in the background goes with it
      if (!windows) kill();
      resolve({ code: timedOut ? null : code, output, errors, timedOut });
    });
  });
}

/**
 * What one run of a check means, given what the last run saw. `seen` is
 * what to remember for next time; `what` is set when the agent should get
 * a turn; `error` when the check itself is broken.
 */
export function checkOutcome(
  result: CheckResult,
  previous: string | undefined,
): { seen: string | undefined; what: string | null; error: string | null } {
  if (result.timedOut) return { seen: previous, what: null, error: `The check took longer than ${CHECK_TIMEOUT_MS / 1000} seconds and was stopped.` };
  if (result.code !== 0 && result.code !== 1) {
    const why = result.errors.trim().split("\n")[0]?.slice(0, 160);
    return { seen: previous, what: null, error: `The check failed (exit ${result.code ?? "unknown"})${why ? `: ${why}` : "."}` };
  }
  const printed = result.output.trim();
  const now = { state: result.code === 0 ? "yes" : "no", hash: hashOf(printed) };
  let before: { state?: string; hash?: string } | null = null;
  try {
    before = previous ? JSON.parse(previous) : null;
  } catch {
    before = null;
  }
  const seen = JSON.stringify(now);
  // the first look is the baseline; after that, only a new finding
  const news = before !== null && now.state === "yes" && (before.state !== "yes" || before.hash !== now.hash);
  if (!news) return { seen, what: null, error: null };
  const shown = printed.length > CHECK_SHOWN_CHARS ? `${printed.slice(0, CHECK_SHOWN_CHARS)}\n(and more, cut off here)` : printed;
  return { seen, what: shown || "The check passed and printed nothing.", error: null };
}

/** Whether a check's command may run now, for an agent with these approvals. */
export function checkAllowed(w: Pick<Watcher, "kind" | "approvedBy">, approvals: string | undefined): boolean {
  if (w.kind !== "check") return true;
  if (w.approvedBy === "person") return true;
  return w.approvedBy === "mode" && (approvals === "auto" || approvals === "full");
}

// ── lanes ──────────────────────────────────────────────────────────────

/** How a watcher's own lane is titled. A lane keeps no note of what made
 * it, so this is the only mark, and it counts only alongside nothing
 * else claiming the lane (orphanWatcherLanes). */
export const WATCHING = "Watching: ";

/** Why a watcher has nowhere to speak: its agent has every conversation
 * it may have. Names them, short enough to fit a watcher's last error,
 * and the way out that needs nothing closed (GitHub 166). */
export function laneLimitError(name: string, titles: string[], room = 200): string {
  const head = `${name} has ${titles.length} conversations open, the most it can`;
  const tail = ". Close one, or give this watcher one of them with --thread.";
  for (let shown = Math.min(titles.length, 6); shown > 0; shown--) {
    const more = titles.length - shown;
    const said = `${head} (${titles.slice(0, shown).join(", ")}${more ? `, and ${more} more` : ""})${tail}`;
    if (said.length <= room) return said;
  }
  return `${head}${tail}`;
}

/**
 * Lanes left behind by watchers that are gone, from before removing a
 * watcher closed its lane. Each one counts against the agent's limit, and
 * an agent cannot close a lane it is not in. Only a lane that looks like
 * a watcher's own, that no watcher still uses, that is idle, and where
 * nobody but a watcher ever spoke: one the person talked in is theirs.
 */
export function orphanWatcherLanes(
  tasks: Array<{ id: string; title: string; busy?: boolean }>,
  watchers: Array<Pick<Watcher, "laneId" | "thread">>,
  spokenIn: (laneId: string) => boolean,
): string[] {
  const used = new Set(watchers.map((w) => w.laneId));
  const named = new Set(watchers.map((w) => w.thread));
  return tasks
    .slice(1)
    .filter((t) => t.title.startsWith(WATCHING) && !used.has(t.id) && !named.has(t.title) && !t.busy && !spokenIn(t.id))
    .map((t) => t.id);
}

// ── failing ────────────────────────────────────────────────────────────

/**
 * One look, counted toward the watcher stopping for failing. A look
 * that worked clears the count and starts it again if it had stopped.
 * True when this failure is the one that stopped it. A hold (paused,
 * waiting for approval, past the chain limit) is not a look at all and
 * is never counted here.
 */
export function countLook(w: Pick<Watcher, "failures" | "failing">, ok: boolean, error: string, at: number): boolean {
  if (ok) {
    delete w.failures;
    delete w.failing;
    return false;
  }
  w.failures = (w.failures ?? 0) + 1;
  if (w.failing || w.failures < FAILS_TO_PAUSE) return false;
  w.failing = { at, error: error.slice(0, 300) };
  return true;
}

// ── firing ─────────────────────────────────────────────────────────────

/** Whether the watcher may start another turn now. */
export function mayFire(w: Pick<Watcher, "fires">, now: number): boolean {
  return w.fires.filter((f) => now - f.at < 60 * 60 * 1000).length < FIRES_PER_HOUR;
}

/** What the agent is told. */
export function watcherTurn(w: Pick<Watcher, "kind" | "target" | "instruction" | "name" | "once">, what: string): string {
  if (w.kind === "place") {
    return [
      `Your watcher "${w.name}": ${what}`,
      "",
      `What you were asked to do when this happens: ${w.instruction}`,
      "",
      w.once ? "It was set to act once, so it is done after this turn." : null,
      "If this does not call for that, say so in one line and stop.",
    ]
      .filter((line) => line !== null)
      .join("\n");
  }
  if (w.kind === "check") {
    return [
      `Your watcher "${w.name}" ran its check (\`${w.target}\`) and it found something.`,
      "",
      "What the check printed:",
      what,
      "",
      `What you were asked to do when this happens: ${w.instruction}`,
      "",
      "If this does not call for that, say so in one line and stop.",
    ].join("\n");
  }
  const where = w.kind === "folder" ? `the folder ${w.target}` : w.kind === "feed" ? `the feed ${w.target}` : `the page ${w.target}`;
  return [
    `Your watcher "${w.name}" noticed a change in ${where}.`,
    "",
    "What changed:",
    what,
    "",
    `What you were asked to do when this happens: ${w.instruction}`,
    "",
    "If this change does not call for that, say so in one line and stop.",
  ].join("\n");
}

/** Place-specific fields, validated separately from the common lifetime. */
export type PlaceFields = Pick<Watcher, "when" | "radius">;

export function cleanWatcher(raw: Record<string, unknown>, botExists: (id: string) => boolean, now = Date.now()):
  | { ok: true; value: Pick<Watcher, "botId" | "name" | "kind" | "target" | "instruction" | "mentions" | "mode" | "every" | "enabled" | "thread" | "once" | "until"> & PlaceFields }
  | { ok: false; error: string } {
  const kind = raw.kind;
  if (kind !== "folder" && kind !== "page" && kind !== "feed" && kind !== "check" && kind !== "place") return { ok: false, error: "kind is folder, page, feed, check or place" };
  const botId = typeof raw.botId === "string" ? raw.botId : "";
  if (!botExists(botId)) return { ok: false, error: "no such agent" };
  const target = String(raw.target ?? "").trim();
  if (kind !== "check" && target.length > MAX_WATCHER_TARGET) return { ok: false, error: "a watcher target is at most 1,000 characters" };
  if (kind === "check") {
    if (!target) return { ok: false, error: "a check is the command to run" };
    // one line: a longer script belongs in a file the check runs
    if (/[\r\n\0]/.test(target)) return { ok: false, error: "a check is one command on one line; put anything longer in a script and run that" };
    if (target.length > MAX_CHECK_COMMAND) return { ok: false, error: `a check is at most ${MAX_CHECK_COMMAND} characters` };
  } else if (kind === "folder") {
    if (!target.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(target)) return { ok: false, error: "a folder is a full path" };
  } else if (kind === "place") {
    if (!parsePlace(target)) return { ok: false, error: 'a place is a name as the phone would put it ("Toronto", "Shinjuku, Tokyo") or "latitude,longitude"' };
  } else if (!/^https?:\/\/[^\s]+$/i.test(target)) {
    return { ok: false, error: "a page or feed is an http or https address" };
  }
  let place: PlaceFields = {};
  if (kind === "place") {
    const when = raw.when ?? "arrive";
    if (when !== "arrive" && when !== "leave") return { ok: false, error: "a place watcher waits to arrive or to leave" };
    const point = parsePlace(target)?.kind === "point";
    const asked = raw.radius === undefined || raw.radius === null ? DEFAULT_RADIUS : Number(raw.radius);
    if (!Number.isFinite(asked)) return { ok: false, error: "a radius is a number of metres" };
    place = {
      when,
      ...(point ? { radius: Math.min(MAX_RADIUS, Math.max(MIN_RADIUS, Math.round(asked))) } : {}),
    };
  }
  if (raw.once !== undefined && typeof raw.once !== "boolean") return { ok: false, error: "once is true or false" };
  let until: number | undefined;
  if (raw.until !== undefined && raw.until !== null && raw.until !== "") {
    if (typeof raw.until !== "number" && typeof raw.until !== "string") return { ok: false, error: "until is a date and time, like 2026-10-24T18:00" };
    until = typeof raw.until === "number" ? raw.until : Date.parse(raw.until);
    if (!Number.isFinite(until)) return { ok: false, error: "until is a date and time, like 2026-10-24T18:00" };
    if (until <= now) return { ok: false, error: "until is already past" };
  }
  const instruction = String(raw.instruction ?? "").trim();
  if (!instruction) return { ok: false, error: "say what the agent should do when it changes" };
  if (instruction.length > MAX_WATCHER_INSTRUCTION) return { ok: false, error: "a watcher instruction is at most 1,000 characters" };
  const every = Math.min(MAX_EVERY, Math.max(MIN_EVERY, Math.round(Number(raw.every) || 30)));
  const mentions = String(raw.mentions ?? "").trim().slice(0, 120);
  // a lane title or id: one line, as short as any other lane's
  const thread = typeof raw.thread === "string" ? raw.thread.replace(/\s+/g, " ").trim().slice(0, 40) : "";
  const named = kind === "check" ? target.split(/\s+/).slice(0, 3).join(" ") : kind === "place" ? `${place.when === "leave" ? "Leaving" : "Arriving at"} ${target}` : target.split(/[\\/]/).filter(Boolean).pop();
  return {
    ok: true,
    value: {
      ...place,
      ...(raw.once === true ? { once: true } : {}),
      ...(until !== undefined ? { until: Math.round(until) } : {}),
      botId,
      kind,
      target,
      name: (String(raw.name ?? "").trim() || named || kind).slice(0, 60),
      instruction,
      ...(mentions && kind === "page" ? { mentions } : {}),
      mode: raw.mode === "rehearse" ? "rehearse" : "act",
      thread: thread || undefined,
      every,
      enabled: raw.enabled !== false,
    },
  };
}
