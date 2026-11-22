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
// team works. New team makes one here, with its lead and members, and each
// agent's card moves it between teams or makes it a team's lead; the
// server keeps the reporting lines in step only where they already
// matched the team (server/registry.ts). Archived agents
// wait at the bottom, each a click from coming back; deleting one for good
// stays behind the sidebar's archive, where the confirm names what goes.
import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowRight, Crown, MessageCircle, MoreHorizontal, Plus, RotateCcw, Search, Settings, Users } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { AgentAvatar } from "./Avatar";
import { useModelLabel } from "./NewRoomDialog";
import { NewTeamDialog } from "./NewTeamDialog";
import { SavedMark, SettingRow, SettingsEmpty, SettingsGroup, SettingsPageHeader, SettingsSelect, SettingsSkeleton } from "./SettingsLayout";
import { api, useStore, type Bot } from "@/state/store";
import {
  agentMatches,
  leadChoices,
  moveCarriesLine,
  reportingRows,
  teamsOf,
  teamsToJoin,
  unplacedAgents,
  type OrgAgent,
  type OrgTeam,
  type OrgView,
} from "@/lib/registry";
import { MAX_MEMBERS } from "@/lib/roomEdit";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";

/** Skills shown on a card before the rest fold into a count. */
const SKILLS_SHOWN = 4;

/** What a card's menu asks the page to do. */
interface CardActions {
  onSave: (path: string, body: Record<string, unknown>) => Promise<boolean>;
  onOpen: (id: string) => void;
  onSettings: (id: string) => void;
  onMakeLead: (team: OrgTeam, agent: OrgAgent) => void;
  onMove: (agent: OrgAgent) => void;
}

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
  const [newTeam, setNewTeam] = useState(false);
  const [moving, setMoving] = useState<OrgAgent | null>(null);
  // A team action answers with the chart as it now stands, or with the
  // reason it was refused, which the dialog that asked shows itself.
  const act = async (path: string, body: Record<string, unknown>): Promise<string | null> => {
    try {
      const done: { org: OrgView } = await api(path, { method: "POST", body: JSON.stringify(body) });
      setView(done.org);
      setError(null);
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  };
  const actions: CardActions = {
    onSave: save,
    onOpen: open,
    onSettings: (id) => {
      dispatch({ type: "select", id });
      dispatch({ type: "toggleSettings", open: true });
    },
    onMakeLead: (team, agent) => void act(`/api/registry/teams/${team.id}/lead`, { agentId: agent.id }).then((refused) => refused && setError(refused)),
    onMove: setMoving,
  };
  const shown = (a: OrgAgent) => agentMatches(a, bots.get(a.id)?.skills ?? [], query);
  const lines = view ? reportingRows(view).filter((row) => shown(row.agent)) : [];
  const loose = view ? unplacedAgents(view).filter(shown) : [];
  const anyLead = Boolean(view?.agents.some((a) => a.lead));
  const needle = query.trim().toLowerCase();
  const archived = state.bots.filter((b) => b.hidden && (!needle || b.name.toLowerCase().includes(needle) || (b.title ?? "").toLowerCase().includes(needle)));

  return (
    <main className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-background">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[880px] px-4 pb-20 pt-9 max-md:pt-16 sm:px-6 lg:px-10">
          <SettingsPageHeader
            title={t("agentsPage.title")}
            description={t("agentsPage.description")}
            actions={
              view && view.agents.length >= 2 ? (
                <Button onClick={() => setNewTeam(true)}>
                  <Plus size={15} aria-hidden />
                  {t("agentsPage.newTeam")}
                </Button>
              ) : undefined
            }
          />

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
                    <AgentRow key={agent.id} agent={agent} bot={bots.get(agent.id)} depth={depth} view={view} actions={actions} />
                  ))}
                </SettingsGroup>
              )}

              {loose.length > 0 && (
                <SettingsGroup
                  title={anyLead ? t("agentsPage.notPlaced") : t("common.agents")}
                  description={anyLead ? undefined : t("agentsPage.notPlacedLine")}
                >
                  {loose.map((agent) => (
                    <AgentRow key={agent.id} agent={agent} bot={bots.get(agent.id)} depth={0} view={view} actions={actions} />
                  ))}
                </SettingsGroup>
              )}

              {query && !lines.length && !loose.length && !archived.length && view.agents.length > 0 && (
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

              {archived.length > 0 && (
                <SettingsGroup title={t("agentsPage.archived")} description={t("agentsPage.archivedLine")}>
                  {archived.map((bot) => (
                    <SettingRow
                      key={bot.id}
                      rowId={`archived-${bot.id}`}
                      label={
                        <span className="flex min-w-0 items-center gap-2.5">
                          <AgentAvatar bot={bot} size={22} className="opacity-70" />
                          <span className="truncate">{bot.name}</span>
                        </span>
                      }
                      description={
                        <span className="block pl-8">
                          {bot.archivedBy
                            ? t(bot.archiveNote ? "sidebar.archivedByWithNote" : "sidebar.archivedBy", {
                                name: bots.get(bot.archivedBy)?.name ?? t("sidebar.theAgentThatHiredIt"),
                                note: bot.archiveNote ?? "",
                              })
                            : bot.title || t("agentsPage.noRole")}
                        </span>
                      }
                      control={
                        <Button size="sm" variant="secondary" onClick={() => dispatch({ type: "restoreBot", botId: bot.id })}>
                          <RotateCcw size={14} aria-hidden />
                          {t("sidebar.restore")}
                        </Button>
                      }
                    />
                  ))}
                </SettingsGroup>
              )}
            </>
          )}
        </div>
      </div>
      {newTeam && (
        <NewTeamDialog
          onClose={() => setNewTeam(false)}
          onMade={(org) => {
            setView(org);
            setError(null);
            setNewTeam(false);
          }}
        />
      )}
      {moving && view && (
        <MoveTeamDialog
          agent={moving}
          view={view}
          onClose={() => setMoving(null)}
          onMove={async (from, to) => {
            const refused = await act(`/api/registry/agents/${moving.id}/team`, { from: from?.id ?? null, to: to?.id ?? null });
            if (!refused) setMoving(null);
            return refused;
          }}
        />
      )}
    </main>
  );
}

function AgentRow({
  agent,
  bot,
  depth,
  view,
  actions,
}: {
  agent: OrgAgent;
  bot: Bot | undefined;
  depth: number;
  view: OrgView;
  actions: CardActions;
}) {
  const { onSave, onOpen } = actions;
  const modelLabel = useModelLabel();
  const teams = teamsOf(view, agent.id);
  const skills = bot?.skills ?? [];
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
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1" style={{ paddingLeft: Math.min(depth, 6) * 20 + 32 }}>
          <span className="min-w-0 truncate">{agent.title || t("agentsPage.noRole")}</span>
          {bot && (
            <span className="max-w-[160px] shrink-0 truncate rounded-md bg-muted px-1.5 py-px text-caption text-muted-foreground" title={t("agentsPage.model")}>
              {modelLabel(bot)}
            </span>
          )}
          {teams.map((team) => (
            <span key={team.id} className="inline-flex max-w-[160px] shrink-0 items-center gap-1 rounded-md border px-1.5 py-px text-caption text-muted-foreground">
              {team.lead === agent.id && <Crown size={10} aria-label={t("agentsPage.leadsTeam", { team: team.name })} />}
              <span className="truncate">{team.name}</span>
            </span>
          ))}
        </span>
      }
      control={
        <div className="flex items-center gap-1.5">
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
          <AgentMenu agent={agent} view={view} teams={teams} actions={actions} />
        </div>
      }
    >
      {skills.length > 0 && (
        <div
          className="mt-2 flex flex-wrap items-center gap-1"
          style={{ paddingLeft: Math.min(depth, 6) * 20 + 32 }}
          aria-label={t("agentsPage.skillsOf", { name: agent.name })}
        >
          {skills.slice(0, SKILLS_SHOWN).map((skill) => (
            <span key={skill} className="max-w-[180px] truncate rounded-full bg-brand-soft px-2 py-px text-caption text-foreground/80">
              {skill}
            </span>
          ))}
          {skills.length > SKILLS_SHOWN && (
            <span className="text-caption tabular-nums text-muted-foreground" title={skills.slice(SKILLS_SHOWN).join(", ")}>
              {t("agentsPage.moreSkills", { count: skills.length - SKILLS_SHOWN })}
            </span>
          )}
        </div>
      )}
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

/** A card's menu: the agent's conversation and settings, then the team
 * actions, which are only offered where they can be done. */
function AgentMenu({ agent, view, teams, actions }: { agent: OrgAgent; view: OrgView; teams: OrgTeam[]; actions: CardActions }) {
  const crownable = teams.filter((team) => team.lead !== agent.id);
  const movable = teams.length > 0 || teamsToJoin(view, agent.id, MAX_MEMBERS).length > 0;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="icon" variant="ghost" className="size-8" aria-label={t("agentsPage.moreFor", { name: agent.name })}>
          <MoreHorizontal size={16} aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[220px]">
        <DropdownMenuItem onSelect={() => actions.onOpen(agent.id)}>
          <MessageCircle aria-hidden />
          {t("agentsPage.openChat")}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => actions.onSettings(agent.id)}>
          <Settings aria-hidden />
          {t("agentsPage.openSettings")}
        </DropdownMenuItem>
        {(crownable.length > 0 || movable) && <DropdownMenuSeparator />}
        {crownable.map((team) => (
          <DropdownMenuItem key={team.id} onSelect={() => actions.onMakeLead(team, agent)}>
            <Crown aria-hidden />
            <span className="truncate">{t("agentsPage.makeLeadOf", { team: team.name })}</span>
          </DropdownMenuItem>
        ))}
        {movable && (
          <DropdownMenuItem onSelect={() => actions.onMove(agent)}>
            <ArrowRight aria-hidden />
            {teams.length ? t("agentsPage.moveToTeam") : t("agentsPage.addToTeam")}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Moving an agent between teams: which team it leaves, when it is in
 * more than one, and which it joins, or none. What happens to its
 * reporting line is said before it is done, by the server's own rule.
 */
function MoveTeamDialog({
  agent,
  view,
  onClose,
  onMove,
}: {
  agent: OrgAgent;
  view: OrgView;
  onClose: () => void;
  onMove: (from: OrgTeam | null, to: OrgTeam | null) => Promise<string | null>;
}) {
  const teams = teamsOf(view, agent.id);
  const choices = teamsToJoin(view, agent.id, MAX_MEMBERS);
  const [fromId, setFromId] = useState(teams[0]?.id ?? "");
  const [toId, setToId] = useState(choices[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const from = teams.find((team) => team.id === fromId) ?? null;
  const to = choices.find((team) => team.id === toId) ?? null;
  const byId = new Map(view.agents.map((a) => [a.id, a]));
  const carries = moveCarriesLine(view, agent.id, from, to);
  const tooSmall = Boolean(from && from.members.length <= 2);
  const nothing = !from && !to;
  const line = carries
    ? to?.lead
      ? t("agentsPage.moveLineFollows", { name: agent.name, lead: byId.get(to.lead)?.name ?? "" })
      : t("agentsPage.moveLineClears", { name: agent.name })
    : t("agentsPage.moveLineStays", { name: agent.name });
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="w-[calc(100vw-24px)] max-w-[460px]">
        <DialogTitle className="text-heading">{t("agentsPage.moveTitle", { name: agent.name })}</DialogTitle>
        <DialogDescription>{t("agentsPage.moveLine")}</DialogDescription>
        <div className="mt-2 grid gap-3">
          {teams.length > 0 && (
            <label className="grid gap-1.5 text-body font-medium text-muted-foreground">
              {t("agentsPage.moveFrom")}
              <SettingsSelect value={fromId} onChange={(e) => setFromId(e.target.value)} aria-label={t("agentsPage.moveFrom")}>
                {teams.map((team) => (
                  <option key={team.id} value={team.id}>
                    {team.name}
                  </option>
                ))}
                {teams.length > 0 && choices.length > 0 && <option value="">{t("agentsPage.stayInAll")}</option>}
              </SettingsSelect>
            </label>
          )}
          <label className="grid gap-1.5 text-body font-medium text-muted-foreground">
            {t("agentsPage.moveTo")}
            <SettingsSelect value={toId} onChange={(e) => setToId(e.target.value)} aria-label={t("agentsPage.moveTo")}>
              {choices.map((team) => (
                <option key={team.id} value={team.id}>
                  {team.name}
                </option>
              ))}
              {teams.length > 0 && <option value="">{t("agentsPage.noTeam")}</option>}
            </SettingsSelect>
          </label>
          <p className="text-pretty text-small leading-relaxed text-muted-foreground">
            {tooSmall && from ? t("agentsPage.moveTooSmall", { team: from.name }) : line}
          </p>
          {refused && (
            <p role="alert" className="text-pretty text-small text-destructive">
              {refused}
            </p>
          )}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            disabled={busy || nothing || tooSmall}
            onClick={async () => {
              setBusy(true);
              setRefused(await onMove(from, to));
              setBusy(false);
            }}
          >
            {t("agentsPage.move")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
