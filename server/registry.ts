// The registry: who reports to whom, and who to ask for what.
//
// The roster has always been flat. Every agent can message every other,
// and the only shape a workspace had was its rooms, each with a lead the
// person crowned or seniority chose. That is right for a handful of
// agents and wrong for thirty: nobody knows who owns what, and a new
// agent with a question writes to whoever it happens to find.
//
// So the owner may give the workspace a shape. Each agent may report to
// one other agent, its lead, and may carry a line in the owner's words on
// what to contact it for. Both are the owner's to set and nobody else's:
// no agent route writes here (server/agent-cli.ts keeps /api/registry on
// NEVER), because who answers to whom is exactly the kind of thing a
// steered agent would like to rearrange.
//
// Nothing here changes how agents talk until the owner says so. With no
// leads set the registry is empty and every route below answers "open".
// A hierarchy alone is a picture, a lookup and a line in each placed
// agent's briefing. Only with "Ask their lead before reaching across
// teams" on (leadFirst) does it hold a message, and then only one from an
// agent that has a lead, to an agent outside its team, that it shares no
// room with and is not answering. Rooms stay what they
// were: the owner put those agents together, so they may talk there.
//
// An agent's team is everyone under its lead: its lead, the lead's other
// reports, and everyone under any of them. Its chain of command, its lead
// and theirs up to the top, is always reachable too, so a question can
// always go up. An agent with no lead is at the top of its tree, or not
// in one, and has nobody to ask first, so it reaches anyone as before.
//
// A lead that is gone or archived is passed over for the nearest one
// above it that is still here, so archiving a manager never cuts its
// reports off from everyone.
//
// Plain functions over plain data, like server/access.ts, so the whole
// model can be read in one sitting and a test can walk it.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { isRecord, readSaved, writeFileAtomic } from "./atomic-write.ts";

export interface Registry {
  /** An agent's id to the id of the agent it reports to. */
  leads: Record<string, string>;
  /** An agent's id to what to contact it for, in the owner's words. */
  contactFor: Record<string, string>;
  /** Whether an agent with a lead asks it before messaging an agent
   * outside its team. Off unless the owner turns it on. */
  leadFirst: boolean;
}

export const EMPTY_REGISTRY: Registry = Object.freeze({ leads: {}, contactFor: {}, leadFirst: false }) as Registry;

/** The longest "contact for" line: one sentence, read in a list. */
export const MAX_CONTACT_FOR_CHARS = 200;
/** The most agents a lookup answers with. */
export const MAX_CONTACTS = 8;

/** What the registry needs to know of an agent. */
export interface RegistryAgent {
  id: string;
  name: string;
  title?: string;
  description?: string;
  skills?: string[];
  archivedAt?: number | null;
}

/** A room, as a team the registry shows. */
export interface RegistryRoom {
  id: string;
  name: string;
  memberIds: string[];
  /** The room's lead: the one the person crowned, or the most senior. */
  leadId: string | null;
}

const ID = /^[\w-]{1,80}$/;
/** No dashes of the long kinds, whatever was typed; the house style. */
const plain = (text: string) => text.replace(/\s*[\u2013\u2014]\s*/g, ", ");

/** A contact line as the owner typed it, tidied and clamped, or empty. */
export function contactLine(value: unknown): string {
  if (typeof value !== "string") return "";
  return plain(value.replace(/\s+/g, " ").trim()).slice(0, MAX_CONTACT_FOR_CHARS).trim();
}

/**
 * Whatever is on disk, or came in a request, as a registry we are
 * willing to act on. A hand-edited file can name a lead that loops back
 * to the agent itself; those edges are dropped as they are read, in a
 * fixed order, so the same file always reads the same way.
 */
export function normalizeRegistry(raw: unknown): Registry {
  if (!isRecord(raw)) return { leads: {}, contactFor: {}, leadFirst: false };
  const leads: Record<string, string> = {};
  const given = isRecord(raw.leads) ? raw.leads : {};
  for (const id of Object.keys(given).sort()) {
    const lead = given[id];
    if (!ID.test(id) || typeof lead !== "string" || !ID.test(lead) || lead === id) continue;
    if (wouldLoop(leads, id, lead)) continue;
    leads[id] = lead;
  }
  const contactFor: Record<string, string> = {};
  const lines = isRecord(raw.contactFor) ? raw.contactFor : {};
  for (const id of Object.keys(lines).sort()) {
    const line = contactLine(lines[id]);
    if (ID.test(id) && line) contactFor[id] = line;
  }
  return { leads, contactFor, leadFirst: raw.leadFirst === true };
}

/** Whether `id` reporting to `lead` would put `id` above itself. */
function wouldLoop(leads: Record<string, string>, id: string, lead: string): boolean {
  const seen = new Set<string>();
  for (let at: string | undefined = lead; at; at = leads[at]) {
    if (at === id) return true;
    if (seen.has(at)) return true;
    seen.add(at);
  }
  return false;
}

/** The agents by id, for the walks below. */
export type Roster = ReadonlyMap<string, RegistryAgent>;

export function rosterOf(agents: readonly RegistryAgent[]): Roster {
  return new Map(agents.map((a) => [a.id, a]));
}

const present = (roster: Roster, id: string) => {
  const agent = roster.get(id);
  return Boolean(agent && !agent.archivedAt);
};

/** The lead an agent answers to now: the one the owner set, or, when
 * that one is gone or archived, the nearest one above it still here. */
export function leadNow(registry: Registry, id: string, roster: Roster): string | null {
  const seen = new Set<string>([id]);
  for (let at = registry.leads[id]; at; at = registry.leads[at]) {
    if (seen.has(at)) return null;
    seen.add(at);
    if (present(roster, at)) return at;
  }
  return null;
}

/** An agent's chain of command, its lead first, up to the top. */
export function chainOfCommand(registry: Registry, id: string, roster: Roster): string[] {
  const chain: string[] = [];
  const seen = new Set<string>([id]);
  for (let at = leadNow(registry, id, roster); at && !seen.has(at); at = leadNow(registry, at, roster)) {
    seen.add(at);
    chain.push(at);
  }
  return chain;
}

/** Who reports to an agent directly, as things stand now. */
export function reportsOf(registry: Registry, id: string, roster: Roster): string[] {
  return [...roster.values()].filter((a) => !a.archivedAt && a.id !== id && leadNow(registry, a.id, roster) === id).map((a) => a.id);
}

/** Whether `below` is anywhere under `above`. */
export function isUnder(registry: Registry, below: string, above: string, roster: Roster): boolean {
  return chainOfCommand(registry, below, roster).includes(above);
}

/** Whether the owner has given this agent a place: a lead, or reports. */
export function placed(registry: Registry, id: string, roster: Roster): boolean {
  return leadNow(registry, id, roster) !== null || reportsOf(registry, id, roster).length > 0;
}

/**
 * The registry with `id` reporting to `lead`, or to nobody for null; or
 * why not, in words the owner can act on.
 */
export function withLead(registry: Registry, id: string, lead: string | null, roster: Roster): { registry: Registry } | { error: string } {
  const agent = roster.get(id);
  if (!agent) return { error: "no such agent" };
  const leads = { ...registry.leads };
  if (lead === null) {
    delete leads[id];
    return { registry: { ...registry, leads } };
  }
  const chosen = roster.get(lead);
  if (!chosen) return { error: "no such agent to report to" };
  if (lead === id) return { error: `${agent.name} cannot report to itself` };
  if (wouldLoop(leads, id, lead)) return { error: `${chosen.name} is already under ${agent.name}, so ${agent.name} cannot report to ${chosen.name}` };
  leads[id] = lead;
  return { registry: { ...registry, leads } };
}

/** The registry with what to contact `id` for, or none for an empty line. */
export function withContactFor(registry: Registry, id: string, line: unknown): Registry {
  const contactFor = { ...registry.contactFor };
  const said = contactLine(line);
  if (said) contactFor[id] = said;
  else delete contactFor[id];
  return { ...registry, contactFor };
}

/**
 * The registry without an agent that is gone for good. Its reports move
 * up to its own lead, so deleting a manager keeps the tree beneath it in
 * one piece rather than scattering it to the top.
 */
export function forgetAgent(registry: Registry, id: string): Registry {
  const above = registry.leads[id];
  const leads: Record<string, string> = {};
  for (const [agent, lead] of Object.entries(registry.leads)) {
    if (agent === id) continue;
    if (lead !== id) leads[agent] = lead;
    else if (above && above !== agent) leads[agent] = above;
  }
  const { [id]: _gone, ...contactFor } = registry.contactFor;
  return { ...registry, leads, contactFor };
}

// ── teams and the reporting lines ──────────────────────────────────────
//
// A team is a room (server/bloks.ts): its members and its lead, crowned or
// the most senior. The reporting lines above are the owner's chart, and
// they need not match the rooms. When the owner works on a team from the
// Agents page, the lines follow only where they already matched it, or
// where the owner asked for them to: a new team's members may be put
// under its lead, an agent moved between teams changes lead only if it
// reported to the lead of the team it left, and a new team lead takes the
// old one's place only if the team reported to the old one.

/**
 * The registry with each of `members` reporting to `lead`, the lead
 * itself left where it is; or why not, before anything is changed.
 */
export function withTeamLead(registry: Registry, members: readonly string[], lead: string, roster: Roster): { registry: Registry } | { error: string } {
  let next = registry;
  for (const id of members) {
    if (id === lead) continue;
    const placed = withLead(next, id, lead, roster);
    if ("error" in placed) return placed;
    next = placed.registry;
  }
  return { registry: next };
}

/**
 * The registry after `id` moves from a team led by `fromLead` to one led
 * by `toLead` (null for no team, or a team with no lead). Its line moves
 * only when it reported to the lead of the team it left, and never onto
 * itself or into a loop; otherwise it stays as the owner set it.
 */
export function afterTeamMove(
  registry: Registry,
  id: string,
  fromLead: string | null,
  toLead: string | null,
  roster: Roster,
): { registry: Registry; followed: boolean } {
  if (!fromLead || registry.leads[id] !== fromLead || fromLead === toLead) return { registry, followed: false };
  if (!toLead || toLead === id) {
    const placed = withLead(registry, id, null, roster);
    return "error" in placed ? { registry, followed: false } : { registry: placed.registry, followed: true };
  }
  const placed = withLead(registry, id, toLead, roster);
  return "error" in placed ? { registry, followed: false } : { registry: placed.registry, followed: true };
}

/**
 * The registry after `next` takes over a team from `previous`. Only when
 * some of the team reported to the previous lead: then they report to the
 * new one, the new one reports wherever the previous one did, and the
 * previous one reports to the new one. A team the chart never mirrored
 * keeps its lines, and only the crown moves.
 */
export function afterHandover(
  registry: Registry,
  team: readonly string[],
  previous: string | null,
  next: string,
): { registry: Registry; followed: boolean } {
  if (!previous || previous === next) return { registry, followed: false };
  const under = team.filter((id) => id !== previous && registry.leads[id] === previous);
  if (!under.length) return { registry, followed: false };
  const leads = { ...registry.leads };
  for (const id of under) if (id !== next) leads[id] = next;
  const above = registry.leads[previous];
  if (above && above !== next) leads[next] = above;
  else delete leads[next];
  leads[previous] = next;
  // the whole change or none of it: a loop anywhere leaves the lines alone
  const candidate = { ...registry, leads };
  const read = normalizeRegistry(candidate);
  if (Object.keys(read.leads).length !== Object.keys(leads).length) return { registry, followed: false };
  return { registry: read, followed: true };
}

/** Why a message may go, or the lead it has to go through. */
export type Route =
  | { ok: true; why: "open" | "self" | "no lead" | "up" | "team" | "room" | "exchange" }
  | { ok: false; via: string };

/**
 * Whether `from` may message `to` directly, under the registry.
 *
 * `sharesRoom` and `inExchange` are the server's to say: whether the two
 * are in a room together, and whether the sender's turn is answering a
 * message from the other. A reply is never held, or two agents could be
 * left unable to finish what one of them started.
 */
export function routeMessage(
  registry: Registry,
  from: string,
  to: string,
  roster: Roster,
  ctx: { sharesRoom: boolean; inExchange: boolean },
): Route {
  if (!registry.leadFirst) return { ok: true, why: "open" };
  if (from === to) return { ok: true, why: "self" };
  const lead = leadNow(registry, from, roster);
  if (!lead) return { ok: true, why: "no lead" };
  if (chainOfCommand(registry, from, roster).includes(to)) return { ok: true, why: "up" };
  if (isUnder(registry, to, lead, roster)) return { ok: true, why: "team" };
  if (ctx.sharesRoom) return { ok: true, why: "room" };
  if (ctx.inExchange) return { ok: true, why: "exchange" };
  return { ok: false, via: lead };
}

/** What an agent is told when a message across teams is held. It names
 * the lead and its id, so the next step is one command, not a search. */
export function acrossRefusal(to: { name: string }, lead: { id: string; name: string }): string {
  return `${to.name} is outside your team, and the owner has agents ask their lead before reaching across teams. Nothing was sent. Message your lead ${lead.name} (\`bloks say ${lead.id} <text>\`) with what you need from ${to.name} and why; ${lead.name} can pass it on or answer it.`;
}

// ── reading it ─────────────────────────────────────────────────────────

export interface OrgAgent {
  id: string;
  name: string;
  title: string;
  lead: string | null;
  reports: string[];
  contactFor: string;
  /** The rooms it is in, by id. */
  rooms: string[];
}

export interface OrgTeam {
  id: string;
  name: string;
  lead: string | null;
  members: string[];
}

export interface OrgView {
  leadFirst: boolean;
  agents: OrgAgent[];
  /** Agents at the top of a tree: no lead, and someone reporting to them. */
  tops: string[];
  /** Agents with no place yet: no lead and nobody reporting to them. */
  unplaced: string[];
  /** The rooms, which are the teams people hire. */
  teams: OrgTeam[];
}

/** The whole registry as the app and `bloks org` read it: archived
 * agents left out, everyone else with their lead and reports now. */
export function orgView(registry: Registry, agents: readonly RegistryAgent[], rooms: readonly RegistryRoom[]): OrgView {
  const roster = rosterOf(agents);
  const live = agents.filter((a) => !a.archivedAt);
  const liveIds = new Set(live.map((a) => a.id));
  const rows: OrgAgent[] = live.map((a) => ({
    id: a.id,
    name: a.name,
    title: a.title ?? "",
    lead: leadNow(registry, a.id, roster),
    reports: reportsOf(registry, a.id, roster),
    contactFor: registry.contactFor[a.id] ?? "",
    rooms: rooms.filter((r) => r.memberIds.includes(a.id)).map((r) => r.id),
  }));
  return {
    leadFirst: registry.leadFirst,
    agents: rows,
    tops: rows.filter((r) => !r.lead && r.reports.length).map((r) => r.id),
    unplaced: rows.filter((r) => !r.lead && !r.reports.length).map((r) => r.id),
    teams: rooms.map((r) => ({
      id: r.id,
      name: r.name,
      lead: r.leadId && liveIds.has(r.leadId) ? r.leadId : null,
      members: r.memberIds.filter((id) => liveIds.has(id)),
    })),
  };
}

const STOP = new Set(["a", "an", "and", "the", "for", "to", "of", "on", "in", "with", "who", "what", "about", "can", "help", "me", "my", "is", "it", "or", "do", "i", "we", "our"]);

/** The words of a phrase worth matching on, lower case. */
export function wordsOf(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => !STOP.has(w));
}

/** How well a field's words answer the asked words: each asked word met
 * by a word that starts with it, so "review" finds "reviews". */
function hits(asked: readonly string[], field: string): number {
  const have = wordsOf(field);
  return asked.filter((w) => have.some((h) => h.startsWith(w) || (h.length >= 4 && w.startsWith(h)))).length;
}

export interface Contact {
  id: string;
  name: string;
  title: string;
  contactFor: string;
  lead: string | null;
  /** Whether the asker may message it directly, and if not, through whom. */
  route: { direct: true } | { direct: false; via: string; viaName: string };
  /** What matched, for the asker to judge the answer by. */
  matched: string[];
}

/**
 * Who to contact for something: the agents whose "contact for" line,
 * role, skills or brief answer the asked words, best first. The owner's
 * own line counts most, since it is the one written for this question.
 *
 * With `from`, each answer also says whether that agent may message it
 * directly under the registry, or through which lead. `ctx` says, for a
 * candidate, whether the two share a room or are already in exchange.
 * With no words, everyone the owner wrote a line for.
 */
export function contactsFor(
  query: string,
  registry: Registry,
  agents: readonly RegistryAgent[],
  from?: { id: string; ctx: (to: string) => { sharesRoom: boolean; inExchange: boolean } },
): Contact[] {
  const roster = rosterOf(agents);
  const asked = wordsOf(query);
  const scored: Array<{ agent: RegistryAgent; score: number; matched: string[] }> = [];
  for (const agent of agents) {
    if (agent.archivedAt || agent.id === from?.id) continue;
    const line = registry.contactFor[agent.id] ?? "";
    if (!asked.length) {
      if (line) scored.push({ agent, score: 1, matched: ["contact for"] });
      continue;
    }
    const fields: Array<[string, string, number]> = [
      ["contact for", line, 4],
      ["name", agent.name, 3],
      ["role", agent.title ?? "", 3],
      ["skills", (agent.skills ?? []).join(" "), 2],
      ["about", agent.description ?? "", 1],
    ];
    let score = 0;
    const matched: string[] = [];
    for (const [label, text, weight] of fields) {
      const n = hits(asked, text);
      if (!n) continue;
      score += n * weight;
      matched.push(label);
    }
    if (score > 0) scored.push({ agent, score, matched });
  }
  scored.sort((a, b) => b.score - a.score || a.agent.name.localeCompare(b.agent.name));
  return scored.slice(0, MAX_CONTACTS).map(({ agent, matched }) => {
    const route = from ? routeMessage(registry, from.id, agent.id, roster, from.ctx(agent.id)) : ({ ok: true, why: "open" } as Route);
    return {
      id: agent.id,
      name: agent.name,
      title: agent.title ?? "",
      contactFor: registry.contactFor[agent.id] ?? "",
      lead: leadNow(registry, agent.id, roster),
      route: route.ok ? { direct: true } : { direct: false, via: route.via, viaName: roster.get(route.via)?.name ?? "your lead" },
      matched,
    };
  });
}

/**
 * What a placed agent is told of its place, in its briefing, or null for
 * an agent the owner gave no place (which is every agent until the owner
 * sets a hierarchy, so nothing changes for them).
 */
export function hierarchyBriefing(registry: Registry, id: string, roster: Roster, owner: string, cli: string | null): string | null {
  const lead = leadNow(registry, id, roster);
  const reports = reportsOf(registry, id, roster);
  if (!lead && !reports.length) return null;
  const name = (at: string) => {
    const agent = roster.get(at);
    return agent ? `${agent.name} (${at})` : at;
  };
  const list = (ids: string[]) => (ids.length <= 2 ? ids.map(name).join(" and ") : `${ids.slice(0, -1).map(name).join(", ")} and ${name(ids.at(-1)!)}`);
  const parts = [`Your place in this workspace, as ${owner} set it:`];
  if (lead) parts.push(`you report to ${name(lead)}.`);
  else parts.push("nobody is above you.");
  if (reports.length) parts.push(`${list(reports)} ${reports.length === 1 ? "reports" : "report"} to you; brief them, delegate to them and review what they send back.`);
  if (lead && registry.leadFirst) {
    const leadName = roster.get(lead)?.name ?? "your lead";
    parts.push(`Your team is everyone under ${leadName}. Before you message an agent outside it that you share no room with, ask ${leadName}: a message across teams is held, and goes through your lead.`);
  }
  if (cli) parts.push(`\`${cli} who <what you need>\` says who to contact for something, and \`${cli} org\` shows the whole chart.`);
  return parts.join(" ");
}

// ── on disk ────────────────────────────────────────────────────────────

/** One small JSON file under the data folder, rewritten whole on each
 * change, like the team library beside it. */
export class RegistryStore {
  private registry: Registry;
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    this.registry = normalizeRegistry(readSaved<unknown>(file, {}, isRecord));
  }

  get(): Registry {
    return this.registry;
  }

  put(next: Registry): Registry {
    this.registry = normalizeRegistry(next);
    writeFileAtomic(this.file, JSON.stringify(this.registry, null, 2), 0o600);
    return this.registry;
  }

  /** An agent deleted for good; nothing written when it had no place. */
  forget(id: string): void {
    const had = id in this.registry.leads || id in this.registry.contactFor || Object.values(this.registry.leads).includes(id);
    if (had) this.put(forgetAgent(this.registry, id));
  }
}
