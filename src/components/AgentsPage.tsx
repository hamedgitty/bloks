// Agents, a place on the main rail: the workspace's agents and teams as
// the owner arranged them (server/registry.ts).
//
// Who reports to whom is set here, one row per agent, with a line on what
// to contact it for. Agents read the same picture with `bloks org` and
// `bloks who`, and nothing about how they talk changes until the switch at
// the top says so: then an agent with a lead asks it before writing to an
// agent outside its team that it shares no room with.
//
// It is made of the settings page's own pieces (SettingsLayout.tsx), rows
// in a card, so it reads like the rest of the app and invents nothing.
// The teams are the rooms, each with its lead; a room is where a hired
// team works, and the place to open it is the sidebar's.
import { useCallback, useEffect, useMemo, useState } from "react";
import { Crown, Search, Users } from "@/components/icons";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { AgentAvatar } from "./Avatar";
import { SavedMark, SettingRow, SettingsEmpty, SettingsGroup, SettingsPageHeader, SettingsSelect, SettingsSkeleton } from "./SettingsLayout";
import { api, useStore, type Bot } from "@/state/store";
import { agentMatches, leadChoices, reportingRows, unplacedAgents, type OrgAgent, type OrgView } from "@/lib/registry";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";

function useOrg() {
  const [view, setView] = useState<OrgView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    api("/api/registry")
      .then((body: OrgView) => {
        setView(body);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, []);
  return { view, setView, error, setError, load };
}

export function AgentsPage() {
  const { state, dispatch } = useStore();
  const { view, setView, error, setError, load } = useOrg();
  const [query, setQuery] = useState("");
  // read on opening, and again when the roster changes under the page
  // (an agent hired, archived, renamed)
  const roster = state.bots.map((b) => `${b.id}:${b.name}:${b.archivedAt ?? ""}`).join("|");
  useEffect(load, [roster, load]);

  const bots = useMemo(() => new Map(state.bots.map((b) => [b.id, b])), [state.bots]);
  const save = async (path: string, body: Record<string, unknown>) => {
    try {
      const next: OrgView = await api(path, { method: "PATCH", body: JSON.stringify(body) });
      setView(next);
      setError(null);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  };

  const open = (id: string) => dispatch({ type: "select", id });
  const shown = (a: OrgAgent) => agentMatches(a, bots.get(a.id)?.skills ?? [], query);
  const lines = view ? reportingRows(view).filter((row) => shown(row.agent)) : [];
  const loose = view ? unplacedAgents(view).filter(shown) : [];
  const anyLead = Boolean(view?.agents.some((a) => a.lead));

  return (
    <main className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-background">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[880px] px-4 pb-20 pt-9 max-md:pt-16 sm:px-6 lg:px-10">
          <SettingsPageHeader title={t("agentsPage.title")} description={t("agentsPage.description")} />

          {!view && !error && <SettingsSkeleton rows={4} />}
          {error && (
            <p role="alert" className="mb-6 text-pretty text-small text-destructive">
              {error}
            </p>
          )}

          {view && (
            <>
              <SettingsGroup title={t("agentsPage.routing")}>
                <SettingRow
                  label={t("agentsPage.leadFirst")}
                  description={t("agentsPage.leadFirstLine")}
                  htmlFor="registry-lead-first"
                  control={
                    <Switch
                      id="registry-lead-first"
                      checked={view.leadFirst}
                      onCheckedChange={(on) => void save("/api/registry", { leadFirst: on })}
                    />
                  }
                />
                {view.leadFirst && !anyLead && (
                  <div className="px-5 pb-4 -mt-1 text-pretty text-small text-muted-foreground">{t("agentsPage.leadFirstNobody")}</div>
                )}
              </SettingsGroup>

              {view.agents.length > 0 && (
                <div className="relative mb-6">
                  <Search size={15} aria-hidden className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    type="search"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder={t("agentsPage.search")}
                    aria-label={t("agentsPage.search")}
                    className="pl-9"
                  />
                </div>
              )}

              {view.agents.length === 0 && (
                <SettingsGroup>
                  <SettingsEmpty icon={<Users size={16} />} title={t("agentsPage.noAgents")} body={t("agentsPage.noAgentsLine")} />
                </SettingsGroup>
              )}

              {lines.length > 0 && (
                <SettingsGroup title={t("agentsPage.reportingLines")}>
                  {lines.map(({ agent, depth }) => (
                    <AgentRow key={agent.id} agent={agent} bot={bots.get(agent.id)} depth={depth} view={view} onSave={save} onOpen={open} />
                  ))}
                </SettingsGroup>
              )}

              {loose.length > 0 && (
                <SettingsGroup
                  title={anyLead ? t("agentsPage.notPlaced") : t("common.agents")}
                  description={anyLead ? undefined : t("agentsPage.notPlacedLine")}
                >
                  {loose.map((agent) => (
                    <AgentRow key={agent.id} agent={agent} bot={bots.get(agent.id)} depth={0} view={view} onSave={save} onOpen={open} />
                  ))}
                </SettingsGroup>
              )}

              {query && !lines.length && !loose.length && view.agents.length > 0 && (
                <SettingsGroup>
                  <SettingsEmpty icon={<Search size={16} />} title={t("agentsPage.noMatch")} />
                </SettingsGroup>
              )}

              {view.teams.length > 0 && !query && (
                <SettingsGroup title={t("agentsPage.teams")} description={t("agentsPage.teamsLine")}>
                  {view.teams.map((team) => {
                    const lead = team.lead ? bots.get(team.lead) : undefined;
                    const members = team.members.map((id) => bots.get(id)).filter((b): b is Bot => Boolean(b));
                    return (
                      <SettingRow
                        key={team.id}
                        rowId={`team-${team.id}`}
                        label={
                          <button type="button" onClick={() => open(team.id)} className="truncate text-left hover:underline">
                            {team.name}
                          </button>
                        }
                        description={lead ? t("agentsPage.ledBy", { name: lead.name }) : t("agentsPage.noLead")}
                        control={
                          <div className="flex -space-x-1.5" aria-label={members.map((b) => b.name).join(", ")}>
                            {members.slice(0, 6).map((b) => (
                              <AgentAvatar key={b.id} bot={b} size={22} className="ring-2 ring-card" />
                            ))}
                            {members.length > 6 && (
                              <span className="flex size-[22px] items-center justify-center rounded-full bg-muted text-caption tabular-nums text-muted-foreground ring-2 ring-card">
                                +{members.length - 6}
                              </span>
                            )}
                          </div>
                        }
                      />
                    );
                  })}
                </SettingsGroup>
              )}
            </>
          )}
        </div>
      </div>
    </main>
  );
}

function AgentRow({
  agent,
  bot,
  depth,
  view,
  onSave,
  onOpen,
}: {
  agent: OrgAgent;
  bot: Bot | undefined;
  depth: number;
  view: OrgView;
  onSave: (path: string, body: Record<string, unknown>) => Promise<boolean>;
  onOpen: (id: string) => void;
}) {
  const [line, setLine] = useState(agent.contactFor);
  const [saved, setSaved] = useState(false);
  useEffect(() => setLine(agent.contactFor), [agent.contactFor]);
  const choices = leadChoices(view, agent.id);
  const path = `/api/registry/agents/${agent.id}`;
  const saveLine = async () => {
    if (line.trim() === agent.contactFor) return;
    if (await onSave(path, { contactFor: line })) {
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1400);
    }
  };
  const isLead = agent.reports.length > 0;
  return (
    <SettingRow
      rowId={`agent-${agent.id}`}
      className={cn(depth > 0 && "bg-muted/20")}
      label={
        <span className="flex min-w-0 items-center gap-2.5" style={{ paddingLeft: Math.min(depth, 6) * 20 }}>
          {bot && <AgentAvatar bot={bot} size={22} />}
          <button type="button" onClick={() => onOpen(agent.id)} className="truncate text-left hover:underline">
            {agent.name}
          </button>
          {isLead && (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-brand/10 px-1.5 py-px text-caption font-medium text-brand">
              <Crown size={11} aria-hidden />
              {t("agentsPage.leads", { count: agent.reports.length })}
            </span>
          )}
        </span>
      }
      description={
        <span className="block" style={{ paddingLeft: Math.min(depth, 6) * 20 + 32 }}>
          {agent.title || t("agentsPage.noRole")}
        </span>
      }
      control={
        <label className="flex items-center gap-2 text-small text-muted-foreground">
          {t("agentsPage.reportsTo")}
          <SettingsSelect
            aria-label={t("agentsPage.reportsToFor", { name: agent.name })}
            value={agent.lead ?? ""}
            onChange={(e) => void onSave(path, { lead: e.target.value || null })}
            className="w-[168px]"
          >
            <option value="">{t("agentsPage.nobody")}</option>
            {choices.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </SettingsSelect>
        </label>
      }
    >
      <div className="mt-3 flex items-center gap-2" style={{ paddingLeft: Math.min(depth, 6) * 20 + 32 }}>
        <Input
          value={line}
          onChange={(e) => setLine(e.target.value)}
          onBlur={() => void saveLine()}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
          maxLength={200}
          placeholder={t("agentsPage.contactForPlaceholder")}
          aria-label={t("agentsPage.contactForFor", { name: agent.name })}
          className="h-8 max-w-[520px] text-body"
        />
        <SavedMark on={saved} />
      </div>
    </SettingRow>
  );
}
