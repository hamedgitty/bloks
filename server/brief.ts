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
// Everything here is pure; the server gathers the inputs.

export interface BriefLane {
  threadId: string;
  title: string;
  messages: Array<{ at: number; role: "user" | "bot"; kind?: string; text?: string; deleted?: boolean; changes?: { total?: number }; quiet?: boolean }>;
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
  messageId: string;
  requestId?: string;
  kind: "approval" | "question";
}

export interface BriefInput {
  since: number;
  now: number;
  person?: string;
  agents: BriefAgent[];
  waiting: BriefWaiting[];
  spend: { turns: number; cost: number; costKnown: boolean };
  /** Other things ready for a look: rehearsals, suggested notes, skills.
   * `many` is the plural when adding an s would be wrong. */
  ready?: Array<{ label: string; many?: string; count: number }>;
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
  const parts = out.match(/[^.!?]+[.!?]+(?=\s|$)|[^.!?]+$/g) ?? [out];
  out = parts.slice(0, sentences).map((p) => p.trim()).join(" ").trim();
  if (out.length > max) out = `${out.slice(0, max - 1).replace(/\s+\S*$/, "")}…`;
  return out;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function timeOfDay(now: number): string {
  const hour = new Date(now).getHours();
  return hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
}

/** What one agent did in the window, lane by lane, newest last, and how
 * many of the things in it are work (`work`): a count of quiet check-ins
 * rides along at the end, said once as a number rather than listed, since
 * "nothing needed you" twelve times over is not twelve pieces of news. */
function agentPart(agent: BriefAgent, since: number, now: number): { part: BriefPart; work: number } | null {
  const items: BriefItem[] = [];
  let checkIns = 0;
  let checkedIn = "";
  for (const lane of agent.lanes) {
    const inTime = lane.messages.filter((m) => m.at >= since && m.at <= now && !m.deleted);
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
  const said = input.agents
    .map((agent) => agentPart(agent, input.since, input.now))
    .filter((p): p is { part: BriefPart; work: number } => p !== null);
  const parts = said.map((p) => p.part);
  // quiet check-ins are not work, and a night of nothing but them is
  // still a quiet night: no headline about them, and no phone woken
  const worked = said.filter((p) => p.work > 0).length;
  const things = said.reduce((n, p) => n + p.work, 0);
  const waiting = input.waiting.slice(0, 20);
  const ready = (input.ready ?? []).filter((r) => r.count > 0);
  const quiet = worked === 0 && waiting.length === 0;

  const who = input.person ? `, ${input.person}` : "";
  const headline = quiet
    ? "A quiet night: nothing new, and nothing waiting on you."
    : [
        worked ? `${plural(worked, "agent")} worked on ${plural(things, "thing")}` : "Nothing new overnight",
        waiting.length ? `${plural(waiting.length, "thing")} waiting on you` : "nothing waiting on you",
      ].join(", ") + ".";

  const cost =
    input.spend.costKnown && input.spend.cost > 0 ? ` It cost about $${input.spend.cost.toFixed(2)} where the provider reports a price.` : "";
  const opening: BriefPart = {
    botId: null,
    name: "Bloks",
    items: [],
    script: `${timeOfDay(input.now)}${who}. ${headline}${cost}`,
  };

  const closingLines = [
    ...waiting.slice(0, 5).map((w) => `${w.name} ${w.kind === "approval" ? "wants your OK to" : "asks"}: ${gist(w.title, 1, 140)}`),
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
    quiet,
  };
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
