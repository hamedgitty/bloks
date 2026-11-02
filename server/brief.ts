// The morning brief: what your agents did while you were away.
//
// Opening Bloks after a night of work means opening every agent to find
// out. The brief does that once, at a time you choose: who worked on what,
// what is waiting on you, and what it cost, as a page to read and as a
// short spoken round in which each agent says its own part in its own
// voice.
//
// It is written from what is already on disk, the conversations, their
// change cards, the cards waiting for an answer, the day's usage, and
// not by a model. That keeps it free, instant, and honest: every line in
// it is something an agent actually said or did, with a link to where.
//
// It leads with outcomes (GitHub 378): what the routines and watchers the
// person set up last reported, each as a card of its own, comes before
// who talked to whom. The person arranges it: which of those feed it,
// which sections are pinned to the top, in what order, and which are
// hidden. And it is the one notification of the morning: a routine set
// to report here says nothing on its own, and the brief says it once.
// What waits on the person is counted, not read out of reports: a live
// question or approval, or a todo an agent put on their list because a
// report found something only they can do (server/todos.ts).
//
// Everything here is pure; the server gathers the inputs.

export interface BriefLane {
  threadId: string;
  title: string;
  messages: Array<{ at: number; role: "user" | "bot"; kind?: string; text?: string; deleted?: boolean; changes?: { total?: number }; quiet?: boolean; via?: string }>;
}

export interface BriefAgent {
  id: string;
  name: string;
  lanes: BriefLane[];
}

export interface BriefWaiting {
  botId: string;
  name: string;
  /** What it is asking, in its own words. */
  title: string;
  threadId: string;
  /** The card's message, or for a todo, the todo's own id. */
  messageId: string;
  requestId?: string;
  /** A todo (server/todos.ts) is something an agent found the person has
   * to do themselves, which no card in a conversation asks: a client that
   * knows only the first two kinds reads it as a question, and opening it
   * opens the conversation it was said in. */
  kind: "approval" | "question" | "todo";
  /** A todo's: its id, why in a line, the routine that said it, and when
   * it was first said. */
  todoId?: string;
  detail?: string;
  routine?: string;
  since?: number;
}

/** What the nightly tidy did to one agent's memory (server/memory-tidy.ts):
 * its diary in a line, and the run, so the line can lead to its review
 * and its undo. */
export interface BriefMemory {
  botId: string;
  name: string;
  text: string;
  runId: string;
}

/** An incident still open (server/incidents.ts), as the brief says it. */
export interface BriefIncident {
  id: string;
  title: string;
  why: string;
  state: string;
  /** Where its card is, or where it happened. */
  threadId?: string;
  /** What the person is asked, when they are. */
  needs?: string;
}

/** A routine or a watcher whose automatic runs stopped for failing. */
export interface BriefFailing {
  kind: "routine" | "watcher";
  id: string;
  name: string;
  error: string;
  since: number;
}

// ── what the person asked agents to track ──────────────────────────────

/** One routine's or watcher's latest word, as the brief shows it. */
export interface BriefResult {
  /** "routine:<id>" or "watcher:<id>": its section's key in the layout. */
  key: string;
  kind: "routine" | "watcher";
  id: string;
  name: string;
  /** The agent it reports through. */
  botId?: string;
  agent?: string;
  /**
   * reported   its last run said something (`text`)
   * quiet      its last run answered QUIET: nothing needed the person
   * changed    a watcher saw a change, and `text` is what came of it
   * unchanged  a watcher looked, and nothing had changed
   * failed     its last run or look failed, or it stopped for failing
   * late       a run was due (`dueAt`) and has not happened
   * running    a run is going now
   * none       it has not run or looked yet
   *
   * A run that went fine says only that the routine ran, never that what
   * it checked is healthy; that is what its own words are for.
   */
  state: "reported" | "quiet" | "changed" | "unchanged" | "failed" | "late" | "running" | "none";
  /** What it said, as its agent wrote it (markdown), cut at a line. */
  text?: string;
  /** `text` is the start of something longer, in the conversation. */
  more?: boolean;
  error?: string;
  /** When what it says was said. */
  at?: number;
  /** When it last ran or looked, whatever came of it. */
  checkedAt?: number;
  /** When a run that has not happened was due. */
  dueAt?: number;
  /** When it runs or looks next. */
  nextAt?: number;
  /** Said within the brief's stretch of time. Older words are shown as
   * older, never as this morning's. */
  fresh: boolean;
  /** The conversation the whole of it is in. */
  threadId?: string;
  /** It reports here instead of notifying on its own. */
  briefOnly?: boolean;
}

/** How much of a report a card shows before "the rest is in the chat". */
export const RESULT_TEXT_MAX = 700;

/** The start of a report, cut where a line ends when one is near, so a
 * list keeps whole items and a tally line is never cut in half. */
export function excerpt(text: string, max = RESULT_TEXT_MAX): { text: string; more: boolean } {
  const clean = (text ?? "").replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (clean.length <= max) return { text: clean, more: false };
  const cut = clean.slice(0, max);
  const line = cut.lastIndexOf("\n");
  if (line >= max * 0.4) return { text: cut.slice(0, line).trimEnd(), more: true };
  return { text: `${cut.slice(0, max - 1).replace(/\s+\S*$/, "")}…`, more: true };
}

/** What the server knows about one routine, for its card. */
export interface RoutineSource {
  id: string;
  name: string;
  botId: string;
  agent: string;
  briefOnly?: boolean;
  /** Newest first, as routines.json keeps them. */
  runs: Array<{ startedAt: number; endedAt?: number; state: "running" | "ok" | "failed"; summary?: string; quiet?: boolean; error?: string; heldSlot?: number; threadId?: string }>;
  lastReport?: { at: number; summary: string };
  failing?: { at: number; error: string };
  lastRunAt?: number;
  /** The slot it was last due, at or before now. */
  dueAt?: number | null;
  nextAt?: number | null;
  /** Where it runs, when no run says. */
  threadId?: string;
}

/** A run due this long ago that has not happened is late. The routine
 * timer looks twice a minute and a busy agent holds it a little, so a
 * few minutes is not late, it is on its way. */
export const LATE_AFTER_MS = 10 * 60_000;

export function routineResult(r: RoutineSource, since: number, now: number): BriefResult {
  const base = {
    key: `routine:${r.id}`,
    kind: "routine" as const,
    id: r.id,
    name: r.name,
    botId: r.botId,
    agent: r.agent,
    ...(r.briefOnly ? { briefOnly: true } : {}),
    ...(r.nextAt ? { nextAt: r.nextAt } : {}),
  };
  const run = r.runs.find((x) => x.heldSlot === undefined);
  const held = r.runs.find((x) => x.heldSlot !== undefined);
  const threadId = run?.threadId ?? r.threadId;
  const where = threadId ? { threadId } : {};
  const said = (at: number) => at >= since && at <= now;
  // the report it last made, kept whole on the routine, when that is
  // what the newest run said
  const report = (at: number, fallback?: string) => {
    const words = r.lastReport && Math.abs(r.lastReport.at - at) < 5_000 ? r.lastReport.summary : fallback;
    return words ? excerpt(words) : null;
  };
  if (r.failing) {
    return { ...base, ...where, state: "failed", error: r.failing.error, at: r.failing.at, checkedAt: run?.endedAt ?? r.failing.at, fresh: said(r.failing.at) };
  }
  // A slot that came and went with no run: said as late, with when it was
  // due, rather than leaving yesterday's report to stand in for today's.
  const due = r.dueAt ?? null;
  if (due !== null && due >= since && now - due > LATE_AFTER_MS && (r.lastRunAt ?? 0) < due && run?.state !== "running") {
    const old = run && run.state === "ok" && !run.quiet ? report(run.endedAt ?? run.startedAt, run.summary) : null;
    return {
      ...base,
      ...where,
      state: "late",
      dueAt: due,
      ...(held?.heldSlot === due && held.error ? { error: held.error } : {}),
      ...(old ? { text: old.text, more: old.more, at: run!.endedAt ?? run!.startedAt } : {}),
      ...(run?.endedAt ? { checkedAt: run.endedAt } : {}),
      fresh: true,
    };
  }
  if (!run) return { ...base, ...where, state: "none", fresh: false };
  if (run.state === "running") {
    const old = r.lastReport ? excerpt(r.lastReport.summary) : null;
    return { ...base, ...where, state: "running", checkedAt: run.startedAt, ...(old ? { text: old.text, more: old.more, at: r.lastReport!.at } : {}), fresh: said(run.startedAt) };
  }
  const ended = run.endedAt ?? run.startedAt;
  if (run.state === "failed") {
    return { ...base, ...where, state: "failed", error: run.error ?? "The run did not finish.", at: ended, checkedAt: ended, fresh: said(ended) };
  }
  if (run.quiet) return { ...base, ...where, state: "quiet", at: ended, checkedAt: ended, fresh: said(ended) };
  const words = report(ended, run.summary);
  if (!words?.text) return { ...base, ...where, state: "quiet", at: ended, checkedAt: ended, fresh: said(ended) };
  return { ...base, ...where, state: "reported", text: words.text, more: words.more, at: ended, checkedAt: ended, fresh: said(ended) };
}

/** What the server knows about one watcher, for its card. */
export interface WatcherSource {
  id: string;
  name: string;
  botId: string;
  agent: string;
  lastCheck?: number;
  lastError?: string;
  failing?: { at: number; error: string };
  /** Newest first. */
  fires: Array<{ at: number; summary: string }>;
  /** What its agent said about the newest change, and where. */
  reply?: { text: string; at: number; threadId: string };
  threadId?: string;
  nextAt?: number | null;
}

export function watcherResult(w: WatcherSource, since: number, now: number): BriefResult {
  const base = {
    key: `watcher:${w.id}`,
    kind: "watcher" as const,
    id: w.id,
    name: w.name,
    botId: w.botId,
    agent: w.agent,
    ...(w.threadId ? { threadId: w.threadId } : {}),
    ...(w.nextAt ? { nextAt: w.nextAt } : {}),
    ...(w.lastCheck ? { checkedAt: w.lastCheck } : {}),
  };
  const said = (at: number) => at >= since && at <= now;
  if (w.failing) return { ...base, state: "failed", error: w.failing.error, at: w.failing.at, fresh: said(w.failing.at) };
  const fire = w.fires[0];
  // an error newer than its newest change is where it stands now
  if (w.lastError && w.lastCheck && (!fire || w.lastCheck > fire.at)) {
    return { ...base, state: "failed", error: w.lastError, at: w.lastCheck, fresh: said(w.lastCheck) };
  }
  if (fire && said(fire.at)) {
    const words = excerpt(w.reply && w.reply.at >= fire.at ? w.reply.text : fire.summary);
    return {
      ...base,
      ...(w.reply && w.reply.at >= fire.at ? { threadId: w.reply.threadId } : {}),
      state: "changed",
      text: words.text,
      more: words.more,
      at: w.reply && w.reply.at >= fire.at ? w.reply.at : fire.at,
      fresh: true,
    };
  }
  if (w.lastCheck) return { ...base, state: "unchanged", ...(fire ? { at: fire.at } : {}), fresh: said(w.lastCheck) };
  return { ...base, state: "none", fresh: false };
}

/** Whether a card is news this morning: words that came in, or a gap
 * where words should have been. Quiet and unchanged are the opposite of
 * news, and a card left over from before is not this morning's. */
export function resultIsNews(r: BriefResult): boolean {
  if (!r.fresh) return false;
  return r.state === "reported" || r.state === "changed" || r.state === "failed" || r.state === "late";
}

// ── how the person arranges it ─────────────────────────────────────────

/** The brief's own sections, besides a card per routine and watcher, in
 * the order they come when nobody has arranged them. */
export const BRIEF_SECTIONS = ["waiting", "failed", "agents", "memory"] as const;
export type BriefSectionId = (typeof BRIEF_SECTIONS)[number];

/** What the person chose: an order, what is pinned to the top, what is
 * hidden. Keys are a section's id or a source's key. */
export interface BriefLayout {
  order: string[];
  pinned: string[];
  hidden: string[];
}

export interface BriefSection {
  key: string;
  pinned: boolean;
  hidden: boolean;
}

const SECTION_KEY = /^(?:waiting|failed|agents|memory|(?:routine|watcher):[\w-]{1,64})$/;
/** More keys than anyone has routines and watchers, fewer than a file
 * edited by hand could make a problem of. */
const MAX_LAYOUT_KEYS = 200;

function keyList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter((k): k is string => typeof k === "string" && SECTION_KEY.test(k)))].slice(0, MAX_LAYOUT_KEYS);
}

/** A layout as saved or sent, with anything that is not a section key
 * left out, rather than trusted. */
export function parseLayout(raw: unknown): BriefLayout {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return { order: keyList(o.order), pinned: keyList(o.pinned), hidden: keyList(o.hidden) };
}

/**
 * The sections in the order they show. `available` is every section
 * there is now, in the default order. What the person ordered keeps its
 * place; anything new (a routine made since) goes in beside its kind's
 * neighbours from the default order, so a new routine joins the other
 * cards and is not dropped at the bottom; and pinned sections come first,
 * in the same order among themselves. Nothing arranged is nothing
 * changed: the default order, nothing pinned, nothing hidden.
 */
export function arrangeSections(available: string[], layout: BriefLayout): BriefSection[] {
  const here = new Set(available);
  const out = layout.order.filter((k) => here.has(k));
  for (const key of available) {
    if (out.includes(key)) continue;
    const before = available.slice(0, available.indexOf(key)).reverse().find((k) => out.includes(k));
    out.splice(before === undefined ? 0 : out.indexOf(before) + 1, 0, key);
  }
  const pinned = new Set(layout.pinned);
  const hidden = new Set(layout.hidden);
  return [...out.filter((k) => pinned.has(k)), ...out.filter((k) => !pinned.has(k))].map((key) => ({
    key,
    pinned: pinned.has(key),
    hidden: hidden.has(key),
  }));
}

/** The brief's settings as config.json keeps them, read with their
 * defaults: on, at eight, one notification on a morning with news and
 * none on a quiet one, and nothing arranged. */
export interface BriefSettings {
  enabled: boolean;
  time: string;
  /** Whether the brief notifies at all. */
  notify: boolean;
  /** Whether a quiet morning notifies too, to say all is clear. */
  allClear: boolean;
  layout: BriefLayout;
}

export function briefSettings(raw: unknown): BriefSettings {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    enabled: o.enabled !== false,
    time: parseBriefTime(o.time) ?? "08:00",
    notify: o.notify !== false,
    allClear: o.allClear === true,
    layout: parseLayout(o.layout),
  };
}

/** The one notification a brief makes, or null for none: none when the
 * person turned them off, and none on a quiet morning unless they asked
 * to hear that all is clear. Opening it opens this brief, not whichever
 * is newest by the time it is tapped. */
export function briefNotice(brief: Pick<Brief, "id" | "headline" | "quiet">, settings: Pick<BriefSettings, "notify" | "allClear">): { title: string; body: string } | null {
  if (!settings.notify) return null;
  if (brief.quiet && !settings.allClear) return null;
  return { title: "Your morning brief is ready", body: brief.quiet ? "All clear: nothing new, and nothing waiting on you." : brief.headline };
}

export interface BriefInput {
  since: number;
  now: number;
  person?: string;
  agents: BriefAgent[];
  waiting: BriefWaiting[];
  /** `estimated` is the part of `cost` worked out from tokens, which makes
   * the figure an estimate, written "~$" as the Usage page writes it. */
  spend: { turns: number; cost: number; costKnown: boolean; estimated?: number };
  /** Other things ready for a look: rehearsals, suggested notes, skills.
   * `many` is the plural when adding an s would be wrong. */
  ready?: Array<{ label: string; many?: string; count: number }>;
  /** The night's memory tidies, one per agent. */
  memory?: BriefMemory[];
  /** Incidents still open, newest first. */
  incidents?: BriefIncident[];
  /** Automations stopped for failing. */
  failing?: BriefFailing[];
  /** The cards of the routines and watchers that feed the brief, in the
   * order the person arranged, hidden ones left out. */
  results?: BriefResult[];
}

export interface BriefItem {
  text: string;
  threadId: string;
}

export interface BriefPart {
  /** null for the opening and closing, which are the brief's own. */
  botId: string | null;
  name: string;
  items: BriefItem[];
  /** What is read aloud for this part. */
  script: string;
}

export interface Brief {
  id: string;
  at: number;
  since: number;
  headline: string;
  parts: BriefPart[];
  waiting: BriefWaiting[];
  spend: BriefInput["spend"];
  ready: Array<{ label: string; many?: string; count: number }>;
  /** One line per agent whose memory was tidied overnight. Housekeeping,
   * not news: it is on the page and never in the headline or the spoken
   * round, and a night of nothing else is still a quiet one. */
  memory: BriefMemory[];
  /** Open incidents and automations stopped for failing. Absent on a
   * brief made before they were said, which a client reads as none. */
  incidents?: BriefIncident[];
  failing?: BriefFailing[];
  /** What the routines and watchers that feed it last said, as it stood
   * when it was made. Absent on a brief made before there were cards, or
   * with nothing feeding it, which a client reads as none. */
  results?: BriefResult[];
  /** Nothing happened and nothing is waiting. */
  quiet: boolean;
}

/** A reply as a sentence or two a person could say: no markdown, no code,
 * no links, cut at a sentence end. */
export function gist(text: string, sentences = 2, max = 240): string {
  let out = (text ?? "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, "")
    .replace(/[*_~]{1,3}([^*_~]+)[*_~]{1,3}/g, "$1")
    .replace(/\|/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  // A sentence ends at its stop with a space or the end after it. A dot
  // with more after it belongs to the word: a file (post.md), a version,
  // an address, a decimal. Splitting there dropped the words before it
  // and started a sentence at "md".
  const parts = out.match(/\S[\s\S]*?(?:[.!?]+(?=\s|$)|$)/g) ?? [out];
  out = parts.slice(0, sentences).map((p) => p.trim()).join(" ").trim();
  if (out.length > max) out = `${out.slice(0, max - 1).replace(/\s+\S*$/, "")}…`;
  return out;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Words said aloud end as a sentence does, so the next line is heard as
 * the next one: a todo's title is written as a line, with no stop. */
const sentence = (words: string) => (!words || /[.!?…]$/.test(words) ? words : `${words}.`);

function timeOfDay(now: number): string {
  const hour = new Date(now).getHours();
  return hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
}

/** What one agent did in the window, lane by lane, newest last, and how
 * many of the things in it are work (`work`): a count of quiet check-ins
 * rides along at the end, said once as a number rather than listed, since
 * "nothing needed you" twelve times over is not twelve pieces of news. */
function agentPart(agent: BriefAgent, since: number, now: number, carded: Set<string> = new Set()): { part: BriefPart; work: number } | null {
  const items: BriefItem[] = [];
  let checkIns = 0;
  let checkedIn = "";
  for (const lane of agent.lanes) {
    // A turn a routine or a watcher started is on its card already, when
    // that kind has cards, and is not said again as the agent's night.
    let carding = false;
    const inTime = lane.messages.filter((m) => {
      if (m.at < since || m.at > now || m.deleted) return false;
      if (m.role === "user") carding = Boolean(m.via && carded.has(m.via));
      return !carding;
    });
    // one prompt per quiet check-in, so the prompts are the count
    const quiet = inTime.filter((m) => m.quiet && m.role === "user").length;
    if (quiet) {
      checkIns += quiet;
      checkedIn = lane.threadId;
    }
    const recent = inTime.filter((m) => !m.quiet);
    // only work that answered something: a greeting on the day an agent
    // was made is not an agent having worked
    const asked = recent.some((m) => m.role === "user");
    const replies = recent.filter((m) => m.role === "bot" && (m.kind ?? "text") === "text" && m.text?.trim());
    const files = recent.reduce((n, m) => n + (m.kind === "changes" ? (m.changes?.total ?? 0) : 0), 0);
    if ((!replies.length || !asked) && !files) continue;
    const last = replies[replies.length - 1];
    const said = last ? gist(last.text!) : "";
    const where = lane.title && lane.title !== "General" ? `${lane.title}: ` : "";
    const touched = files ? ` (${plural(files, "file")} changed)` : "";
    if (said || touched) items.push({ text: `${where}${said || "Worked in the folder."}${touched}`, threadId: lane.threadId });
  }
  if (!items.length && !checkIns) return null;
  const shown = items.slice(-4);
  const quietly = checkIns ? { text: `${plural(checkIns, "quiet check-in")}, nothing needed you.`, threadId: checkedIn } : null;
  const spoken = [...shown, ...(quietly ? [quietly] : [])].map((item) => item.text.replace(/ \(\d+ files? changed\)$/, "")).join(" ");
  return {
    part: {
      botId: agent.id,
      name: agent.name,
      items: [...shown, ...(quietly ? [quietly] : [])],
      script: `${agent.name} here. ${spoken}`,
    },
    work: shown.length,
  };
}

export function composeBrief(input: BriefInput, id: string): Brief {
  const carded = new Set((input.results ?? []).map((r) => r.kind));
  const said = input.agents
    .map((agent) => agentPart(agent, input.since, input.now, carded))
    .filter((p): p is { part: BriefPart; work: number } => p !== null);
  const parts = said.map((p) => p.part);
  // quiet check-ins are not work, and a night of nothing but them is
  // still a quiet night: no headline about them, and no phone woken
  const worked = said.filter((p) => p.work > 0).length;
  const things = said.reduce((n, p) => n + p.work, 0);
  const waiting = input.waiting.slice(0, 20);
  const ready = (input.ready ?? []).filter((r) => r.count > 0);
  const incidents = (input.incidents ?? []).slice(0, 20);
  const failing = (input.failing ?? []).slice(0, 20);
  // Something that failed is never a quiet night, whatever else happened:
  // a brief that said "nothing waiting" over a routine that stopped is
  // the late news this exists to bring early.
  const results = (input.results ?? []).slice(0, 60);
  // A card already counted as an automation paused for failing is not
  // a second piece of bad news in the headline.
  const pausedIds = new Set(failing.map((f) => `${f.kind}:${f.id}`));
  const news = results.filter(resultIsNews);
  const reports = news.filter((r) => r.state === "reported" || r.state === "changed").length;
  const gaps = news.filter((r) => (r.state === "failed" || r.state === "late") && !pausedIds.has(r.key)).length;
  const quiet = worked === 0 && waiting.length === 0 && incidents.length === 0 && failing.length === 0 && news.length === 0;
  const broke = [
    incidents.length ? `${plural(incidents.length, "open incident")}` : "",
    failing.length ? `${plural(failing.length, "automation")} paused for failing` : "",
  ].filter(Boolean);

  const who = input.person ? `, ${input.person}` : "";
  const waitingWords = waiting.length ? `${plural(waiting.length, "thing")} waiting on you` : "nothing waiting on you";
  // With cards feeding it, the headline is their outcome and what waits
  // on the person; who worked on what is on the page, under them.
  // Without any, it is the headline it always was.
  const headline = quiet
    ? "A quiet night: nothing new, and nothing waiting on you."
    : results.length
      ? [
          reports ? `${plural(reports, "report")} in` : "No new reports",
          ...(gaps ? [`${plural(gaps, "report")} missing`] : []),
          waitingWords,
          ...broke,
        ].join(", ") + "."
      : [
          worked ? `${plural(worked, "agent")} worked on ${plural(things, "thing")}` : "Nothing new overnight",
          waitingWords,
          ...broke,
        ].join(", ") + ".";
  // what came in, said in the opening, a sentence a card
  const resultWords = news
    .map((r) => {
      if (r.state === "late") return `${r.name} has not reported yet.`;
      if (r.state === "failed") return `${r.name} failed.`;
      // a report opens with its outcome, so its first line is what is said
      const said = gist((r.text ?? "").split("\n").find((line) => line.trim()) ?? "", 1, 160);
      return said ? `${r.name}: ${/[.!?…]$/.test(said) ? said : `${said}.`}` : "";
    })
    .filter(Boolean)
    .slice(0, 6);

  const cost =
    input.spend.costKnown && input.spend.cost > 0
      ? (input.spend.estimated ?? 0) > 0
        ? ` It cost ~$${input.spend.cost.toFixed(2)}, estimated in part from the tokens used.`
        : ` It cost about $${input.spend.cost.toFixed(2)} where the provider reports a price.`
      : "";
  const opening: BriefPart = {
    botId: null,
    name: "Bloks",
    items: [],
    script: `${timeOfDay(input.now)}${who}. ${headline}${resultWords.length ? ` ${resultWords.join(" ")}` : ""}${cost}`,
  };

  const closingLines = [
    ...waiting
      .slice(0, 5)
      .map((w) =>
        w.kind === "todo"
          ? `For you, from ${w.name}: ${sentence(gist(w.title, 1, 140))}`
          : `${w.name} ${w.kind === "approval" ? "wants your OK to" : "asks"}: ${gist(w.title, 1, 140)}`,
      ),
    ...incidents.slice(0, 5).map((i) => `${i.title} failed: ${gist(i.why, 1, 140)}.${i.needs ? ` It needs you: ${gist(i.needs, 1, 140)}` : ""}`),
    ...failing.slice(0, 5).map((f) => `The ${f.kind} ${f.name} kept failing, so it is paused: ${gist(f.error, 1, 140)}.`),
    ...ready.map((r) => `${plural(r.count, r.label, r.many)} ready for a look.`),
  ];
  const closing: BriefPart | null = closingLines.length
    ? {
        botId: null,
        name: "Waiting on you",
        items: [],
        script: `Waiting on you. ${closingLines.join(" ")}`,
      }
    : null;

  return {
    id,
    at: input.now,
    since: input.since,
    headline,
    parts: [opening, ...parts, ...(closing ? [closing] : [])],
    waiting,
    spend: input.spend,
    ready,
    memory: memoryLines(input.memory ?? []),
    ...(incidents.length ? { incidents } : {}),
    ...(failing.length ? { failing } : {}),
    ...(results.length ? { results } : {}),
    quiet,
  };
}

/** The latest tidy per agent, its diary kept to a line. */
function memoryLines(tidies: BriefMemory[]): BriefMemory[] {
  const latest = new Map<string, BriefMemory>();
  for (const tidy of tidies) if (tidy.text.trim()) latest.set(tidy.botId, tidy);
  return [...latest.values()].map((tidy) => ({ ...tidy, text: tidy.text.length > 280 ? `${tidy.text.slice(0, 279).replace(/\s+\S*$/, "")}…` : tidy.text }));
}

/** "08:00" style times; anything else is refused. */
export function parseBriefTime(raw: unknown): string | null {
  const found = String(raw ?? "").match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  return found ? `${found[1]}:${found[2]}` : null;
}

/**
 * Whether the brief is due: the chosen time has passed today and today's
 * has not been made yet. `lastDay` is the local date of the newest brief.
 */
export function briefDue(time: string, lastDay: string | null, now: Date): boolean {
  const [hour, minute] = time.split(":").map(Number);
  const due = new Date(now);
  due.setHours(hour, minute, 0, 0);
  if (now.getTime() < due.getTime()) return false;
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  return lastDay !== today;
}
