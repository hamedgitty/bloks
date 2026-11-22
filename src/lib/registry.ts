// The Agents page's reading of the registry (server/registry.ts): the
// reporting lines as rows in order, who an agent may be put under, and
// what a search finds. Pure, so the page stays a picture of it.

export interface OrgAgent {
  id: string;
  name: string;
  title: string;
  lead: string | null;
  reports: string[];
  contactFor: string;
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
  tops: string[];
  unplaced: string[];
  teams: OrgTeam[];
}

export interface OrgRow {
  agent: OrgAgent;
  /** How far down its tree, 0 at the top. */
  depth: number;
}

/** The reporting lines, each tree top down with reports under their
 * lead in name order, and nothing twice whatever the data says. */
export function reportingRows(view: OrgView): OrgRow[] {
  const byId = new Map(view.agents.map((a) => [a.id, a]));
  const byName = (a: string, b: string) => (byId.get(a)?.name ?? "").localeCompare(byId.get(b)?.name ?? "");
  const rows: OrgRow[] = [];
  const seen = new Set<string>();
  const walk = (id: string, depth: number) => {
    const agent = byId.get(id);
    if (!agent || seen.has(id)) return;
    seen.add(id);
    rows.push({ agent, depth });
    for (const report of [...agent.reports].sort(byName)) walk(report, depth + 1);
  };
  for (const top of [...view.tops].sort(byName)) walk(top, 0);
  return rows;
}

/** The agents with no place yet, by name. */
export function unplacedAgents(view: OrgView): OrgAgent[] {
  const ids = new Set(view.unplaced);
  return view.agents.filter((a) => ids.has(a.id)).sort((a, b) => a.name.localeCompare(b.name));
}

/** Who an agent may report to: anyone but itself and those under it,
 * which would put it above itself. */
export function leadChoices(view: OrgView, id: string): OrgAgent[] {
  const byId = new Map(view.agents.map((a) => [a.id, a]));
  const under = new Set<string>([id]);
  const stack = [id];
  while (stack.length) {
    for (const report of byId.get(stack.pop()!)?.reports ?? []) {
      if (under.has(report)) continue;
      under.add(report);
      stack.push(report);
    }
  }
  return view.agents.filter((a) => !under.has(a.id)).sort((a, b) => a.name.localeCompare(b.name));
}

/** Whether an agent answers a search, by name, role, contact line or
 * skills. Every word has to be found somewhere. */
export function agentMatches(agent: OrgAgent, skills: readonly string[], query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = [agent.name, agent.title, agent.contactFor, ...skills].join(" ").toLowerCase();
  return words.every((w) => hay.includes(w));
}

/** The teams an agent is in, by name. */
export function teamsOf(view: OrgView, id: string): OrgTeam[] {
  return view.teams.filter((team) => team.members.includes(id)).sort((a, b) => a.name.localeCompare(b.name));
}

/** Where an agent could be moved to: every team it is not in yet and that
 * has a seat left. */
export function teamsToJoin(view: OrgView, id: string, max: number): OrgTeam[] {
  return view.teams.filter((team) => !team.members.includes(id) && team.members.length < max).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Whether moving an agent carries its reporting line with it, as the
 * server decides it (server/registry.ts, afterTeamMove): only when it
 * reports to the lead of the team it leaves, and then to the lead of the
 * team it joins, or to nobody when that has none.
 */
export function moveCarriesLine(view: OrgView, id: string, from: OrgTeam | null, to: OrgTeam | null): boolean {
  const agent = view.agents.find((a) => a.id === id);
  if (!agent?.lead || !from?.lead || agent.lead !== from.lead) return false;
  return (to?.lead ?? null) !== from.lead;
}
