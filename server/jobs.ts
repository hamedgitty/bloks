// A job board: work posted without naming who does it.
//
// With one agent you talk to it. With six, saying the same thing six
// times to find out who is the right one is worse than having one, and
// picking yourself means you have to hold what each of them is for. So a
// job is posted to nobody in particular, and an agent takes it.
//
// Taking it is real rather than decorative. The board ranks who looks
// suited from what they are for and what they can do, offers it to the
// best of them, and that agent may decline: an agent that says it is not
// their kind of work hands the job back and it goes to the next. What a
// person sees is who took it, what they said, and what came of it.
//
// The ranking is a plain word overlap rather than a model call. It is
// good enough to order six agents by relevance, it costs nothing, and it
// cannot fail: an offer is a proposal the agent gets to refuse, so the
// consequence of ranking badly is one wasted turn rather than a wrong
// answer.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { DATA_DIR } from "./config.ts";
import { newId } from "./contracts.ts";

export type JobState = "open" | "claimed" | "done" | "failed" | "cancelled";

export interface JobOffer {
  botId: string;
  name: string;
  at: number;
  /** Set when they handed it back, in their own words. */
  passed?: string;
}

export interface Job {
  id: string;
  title: string;
  brief: string;
  postedAt: number;
  state: JobState;
  /** Everyone it has been put to, in order, refusals included. */
  offers: JobOffer[];
  claimedBy?: string;
  claimedName?: string;
  claimedAt?: number;
  /** The lane the work is running in, so the thread can be opened. */
  threadId?: string;
  finishedAt?: number;
  /** The agent's own account of what it did, or why it could not. */
  result?: string;
}

export const MAX_JOBS = 200;
export const MAX_TITLE = 120;
export const MAX_BRIEF = 4_000;
export const MAX_RESULT = 2_000;

/** A reply that begins with this is the agent handing the job back. */
export const PASS_MARKER = "PASS";

// ── who it should go to ────────────────────────────────────────────────

/** What the board knows about an agent when it is deciding. */
export interface Candidate {
  id: string;
  name: string;
  title?: string;
  description?: string;
  skills?: string[];
  seniority?: number;
  hidden?: boolean;
}

/** Words worth matching on: no punctuation, nothing tiny, nothing that
 * appears in every sentence ever written. */
const NOISE = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "your", "our",
  "you", "are", "was", "were", "will", "can", "should", "would", "have", "has",
  "any", "all", "out", "get", "make", "made", "one", "two", "new", "who", "how",
  "what", "when", "where", "some", "each", "them", "they", "their", "then",
  "than", "over", "under", "about", "please", "need", "needs", "want", "job",
  "work", "task", "help", "using", "use", "way", "off", "not", "but",
]);

export function words(text: string): string[] {
  return (text ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 3 && !NOISE.has(word));
}

/** A crude stem, so "reporting" matches "reports". Not linguistics: the
 * point is that a plural should not read as a different subject. */
function stem(word: string): string {
  return word
    .replace(/(ing|ers|ed|es|s)$/,
      (suffix) => (word.length - suffix.length >= 4 ? "" : suffix))
    .slice(0, 12);
}

function bag(text: string): Set<string> {
  return new Set(words(text).map(stem));
}

/**
 * How well one agent fits one job, from nothing to one.
 *
 * What an agent is *for* counts for more than what it happens to say
 * about itself: a role and its named skills are deliberate, a description
 * is prose. Seniority only breaks ties, because the most senior agent is
 * not automatically the right one to do a small thing.
 */
export function scoreAgent(job: { title: string; brief: string }, agent: Candidate): number {
  const asked = bag(`${job.title} ${job.brief}`);
  if (!asked.size) return 0;

  const role = bag(`${agent.title ?? ""} ${agent.name ?? ""}`);
  const skills = bag((agent.skills ?? []).join(" "));
  const about = bag(agent.description ?? "");

  let hit = 0;
  for (const word of asked) {
    if (role.has(word)) hit += 1;
    else if (skills.has(word)) hit += 0.8;
    else if (about.has(word)) hit += 0.4;
  }
  const overlap = Math.min(1, hit / asked.size);
  // a whisper of seniority, well below anything a real match is worth
  const rank = ((agent.seniority ?? 3) - 3) * 0.01;
  return Math.max(0, Math.min(1, overlap + rank));
}

export interface Ranked {
  agent: Candidate;
  score: number;
}

/**
 * Everyone who could take it, best first.
 *
 * Nobody is filtered out by a low score. An agent with no words in common
 * with a job may still be the only one who can do it, and the offer is a
 * question rather than an instruction, so the cost of asking the wrong
 * one is that they say no.
 */
export function rankAgents(
  job: { title: string; brief: string },
  agents: Candidate[],
  passedOver: string[] = [],
): Ranked[] {
  const already = new Set(passedOver);
  return agents
    .filter((agent) => !agent.hidden && !already.has(agent.id))
    .map((agent) => ({ agent, score: scoreAgent(job, agent) }))
    .sort((a, b) => b.score - a.score || a.agent.name.localeCompare(b.agent.name));
}

/** Who to put it to next, or nobody. */
export function nextFor(job: Job, agents: Candidate[]): Candidate | null {
  const asked = job.offers.map((offer) => offer.botId);
  return rankAgents(job, agents, asked)[0]?.agent ?? null;
}

// ── what the agent said back ───────────────────────────────────────────

export type Claim =
  | { taken: true; result: string }
  | { taken: false; because: string };

/**
 * Whether an agent took the job or handed it back.
 *
 * A refusal has to be recognisable without reading it, so it is a marker
 * at the very start of the reply and nothing else counts. An agent that
 * mentions passing halfway through a paragraph did the work and is
 * talking about it.
 */
export function readClaim(reply: string): Claim {
  const text = (reply ?? "").trim();
  const first = text.split("\n")[0]?.trim() ?? "";
  if (new RegExp(`^${PASS_MARKER}\\b`).test(first)) {
    const because = first.slice(PASS_MARKER.length).replace(/^[\s:,.-]+/, "").trim();
    return { taken: false, because: (because || "no reason given").slice(0, MAX_RESULT) };
  }
  return { taken: true, result: text.slice(0, MAX_RESULT) };
}

/** What the agent is actually asked. Written here so the wording is one
 * thing rather than a string built at the call site. */
export function offerText(job: Job): string {
  return [
    "This came in on the job board. Nobody has been named for it.",
    "",
    job.title,
    job.brief && job.brief !== job.title ? `\n${job.brief}` : "",
    "",
    `If this is not your kind of work, reply with one line starting with ${PASS_MARKER} and why, and do nothing else.`,
    "Otherwise take it, do it, and finish with one line saying what you did.",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

// ── the board ──────────────────────────────────────────────────────────

const JOBS_FILE = join(DATA_DIR, "jobs.json");

export class JobStore {
  jobs: Job[] = [];

  constructor() {
    try {
      const parsed = JSON.parse(readFileSync(JOBS_FILE, "utf8"));
      if (Array.isArray(parsed)) this.jobs = parsed.filter((job) => job?.id && job?.title);
    } catch {
      /* no board yet */
    }
    // Work that was running when the app stopped did not carry on
    // running. Saying so beats a job that claims to be in progress
    // forever with nobody doing it.
    for (const job of this.jobs) {
      if (job.state === "claimed") {
        job.state = "failed";
        job.result = "Bloks closed while this was running.";
        job.finishedAt = Date.now();
      }
    }
  }

  private save() {
    try {
      mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
      writeFileSync(JOBS_FILE, JSON.stringify(this.jobs, null, 2), { mode: 0o600 });
    } catch {
      /* a board that cannot be written is still a board for this session */
    }
  }

  list(): Job[] {
    return [...this.jobs].sort((a, b) => b.postedAt - a.postedAt);
  }

  get(id: string): Job | null {
    return this.jobs.find((job) => job.id === id) ?? null;
  }

  post(input: { title: string; brief: string; now: number }): Job {
    const job: Job = {
      id: newId(),
      title: input.title.trim().slice(0, MAX_TITLE),
      brief: input.brief.trim().slice(0, MAX_BRIEF),
      postedAt: input.now,
      state: "open",
      offers: [],
    };
    this.jobs.unshift(job);
    if (this.jobs.length > MAX_JOBS) this.jobs.length = MAX_JOBS;
    this.save();
    return job;
  }

  patch(id: string, patch: Partial<Job>): Job | null {
    const job = this.get(id);
    if (!job) return null;
    Object.assign(job, patch);
    this.save();
    return job;
  }

  /** Record that it has been put to someone, and that they are on it. */
  offer(id: string, agent: Candidate, threadId: string, now: number): Job | null {
    const job = this.get(id);
    if (!job) return null;
    job.offers.push({ botId: agent.id, name: agent.name, at: now });
    job.state = "claimed";
    job.claimedBy = agent.id;
    job.claimedName = agent.name;
    job.claimedAt = now;
    job.threadId = threadId;
    this.save();
    return job;
  }

  /** They handed it back. It is open again, and they will not be asked
   * for this one a second time. */
  passed(id: string, because: string, now: number): Job | null {
    const job = this.get(id);
    if (!job) return null;
    const last = job.offers[job.offers.length - 1];
    if (last) last.passed = because.slice(0, MAX_RESULT);
    job.state = "open";
    job.claimedBy = undefined;
    job.claimedName = undefined;
    job.claimedAt = undefined;
    job.threadId = undefined;
    job.finishedAt = now;
    this.save();
    return job;
  }

  finish(id: string, outcome: { ok: boolean; result: string; now: number }): Job | null {
    const job = this.get(id);
    if (!job) return null;
    job.state = outcome.ok ? "done" : "failed";
    job.result = outcome.result.slice(0, MAX_RESULT);
    job.finishedAt = outcome.now;
    this.save();
    return job;
  }

  cancel(id: string, now: number): Job | null {
    const job = this.get(id);
    if (!job) return null;
    job.state = "cancelled";
    job.finishedAt = now;
    this.save();
    return job;
  }

  remove(id: string): boolean {
    const before = this.jobs.length;
    this.jobs = this.jobs.filter((job) => job.id !== id);
    if (this.jobs.length === before) return false;
    this.save();
    return true;
  }

  /** An agent that is deleted leaves whatever it was holding open. */
  /**
   * Whoever was holding these is not coming back, so they go on the
   * board again.
   *
   * `why` is a parameter because there are three ways an agent stops
   * being available and only one of them is a deletion. A job put back
   * because somebody took the wheel should not tell the person the agent
   * was deleted.
   *
   * No finishedAt: the job is open, and stamping a finish on something
   * still waiting to be done makes every list that sorts by it lie.
   */
  releaseAgent(botId: string, _now: number, why = "The agent that took this was deleted.") {
    let touched = false;
    for (const job of this.jobs) {
      if (job.claimedBy !== botId) continue;
      job.state = "open";
      job.claimedBy = undefined;
      job.claimedName = undefined;
      job.threadId = undefined;
      job.result = why;
      job.finishedAt = undefined;
      touched = true;
    }
    if (touched) this.save();
  }
}
