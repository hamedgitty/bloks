// Settings, Plugins: managing what agents can reach, where the Plugins
// page in the rail is for finding it. Four lists under one switch, Apps,
// MCPs, CLIs and Skills, each counted, each searchable, and each item
// opening a page of its own: an app's connection and who may use it, a
// server's connection, values and agents, a CLI on this computer and the
// protected connection beside it (src/components/CliPlugins.tsx), a
// skill's text and the agents using it.
//
// The switches here are the ones Bloks really has. Apps are connected or
// not, and each agent may use connected apps or not; servers and skills
// are attached to agents one by one. Nothing pretends to switch an app
// off without disconnecting it.
import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown } from "@/components/icons";
import { ChevronRight } from "@/components/icons";
import { Loader2 } from "@/components/icons";
import { Lock } from "@/components/icons";
import { MessageSquare } from "@/components/icons";
import { Plus } from "@/components/icons";
import { Puzzle } from "@/components/icons";
import { RefreshCw } from "@/components/icons";
import { Search } from "@/components/icons";
import { Settings } from "@/components/icons";
import { Sparkles } from "@/components/icons";
import { Trash2 } from "@/components/icons";
import { api, useStore, type PluginFocus, type Skill } from "@/state/store";
import { useConnectors, type ToolkitCard } from "@/lib/useConnectors";
import { detailsFor } from "@/lib/appDetails";
import { tryPrompt } from "@/lib/tryPrompt";
import { AddMcpServerDialog, BackLink, McpServerSettings, McpTargetLine, useMcpServers } from "./McpServers";
import { cliPluginLine, GitHubPluginSettings, useCliPlugins } from "./CliPlugins";
import { GitHubMark } from "./ProviderIcons";
import { AddSkillDialog } from "./SkillsPanel";
import { SkillDetail } from "./SkillVersions";
import { ServiceIcon } from "./Customize";
import { ComposioKeyDialog } from "./ComposioKeyDialog";
import { AgentAvatar } from "./Avatar";
import { Switch } from "@/components/ui/switch";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { confirm } from "@/components/ui/confirm";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import { t, tr, type MessageKey } from "@/lib/i18n";

type List = "apps" | "mcps" | "clis" | "skills";

const pill =
  "flex h-9 items-center rounded-full outline-none transition-[background-color,color,scale,opacity] duration-150 ease-out active:scale-[0.97]";

function Tile({ children, size = 10 }: { children: React.ReactNode; size?: 10 | 14 }) {
  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center rounded-xl border bg-background text-muted-foreground",
        size === 14 ? "size-14 rounded-2xl" : "size-10",
      )}
    >
      {children}
    </span>
  );
}

/** One row of a list: its mark, its name and line, what sits on the right. */
function Row({
  tile,
  name,
  line,
  aside,
  onOpen,
}: {
  tile: React.ReactNode;
  name: string;
  line?: React.ReactNode;
  aside?: React.ReactNode;
  onOpen: () => void;
}) {
  return (
    <div className="group flex items-center gap-3.5 px-4 py-3.5 transition-colors duration-150 hover:bg-accent/30">
      <button onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-3.5 text-left outline-none">
        {tile}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-ui font-medium text-foreground">{name}</span>
          {line && <span className="mt-0.5 block truncate text-body text-muted-foreground">{line}</span>}
        </span>
      </button>
      {aside}
    </div>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return <div className="divide-y overflow-hidden rounded-2xl border bg-card">{children}</div>;
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="px-6 py-12 text-center text-ui text-muted-foreground">{children}</div>;
}

const usedBy = (n: number) => (n === 0 ? t("pluginSettings.noAgents") : t("pluginSettings.agentCount", { count: n }));

export function PluginSettings() {
  const { state, dispatch } = useStore();
  const focus = state.pluginFocus;
  const setFocus = (next: PluginFocus | null) => dispatch({ type: "openPluginSettings", focus: next });
  const connectors = useConnectors();
  const { servers, reload: reloadServers } = useMcpServers();
  const { plugins: clis, error: cliError } = useCliPlugins();
  const [skills, setSkills] = useState<Skill[] | null>(null);
  const loadSkills = () =>
    api("/api/skills")
      .then((r) => setSkills(r.skills ?? []))
      .catch(() => setSkills([]));
  useEffect(() => {
    void loadSkills();
  }, []);
  const [list, setList] = useState<List>("apps");
  const [query, setQuery] = useState("");
  const [addingServer, setAddingServer] = useState(false);
  const [addingSkill, setAddingSkill] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const agents = state.bots.filter((b) => !b.hidden);

  // a page opened from elsewhere (Manage on an app) shows its own list
  // behind it, so Back lands where it belongs
  useEffect(() => {
    if (focus) setList(focus.kind === "app" ? "apps" : focus.kind === "mcp" ? "mcps" : focus.kind === "cli" ? "clis" : "skills");
  }, [focus]);

  const q = query.trim().toLowerCase();
  const apps = useMemo(
    () => connectors.installed.filter((c) => !q || `${c.label} ${c.blurb}`.toLowerCase().includes(q)),
    [connectors.installed, q],
  );
  const shownServers = (servers ?? []).filter((s) => !q || `${s.name} ${s.target}`.toLowerCase().includes(q));
  const shownClis = (clis ?? []).filter((p) => !q || `${p.name} git gh cli`.toLowerCase().includes(q));
  const shownSkills = (skills ?? []).filter((s) => !q || `${s.name} ${s.description}`.toLowerCase().includes(q));

  if (focus?.kind === "mcp") {
    return (
      <McpServerSettings
        id={focus.id}
        onBack={() => {
          setFocus(null);
          reloadServers();
        }}
      />
    );
  }
  if (focus?.kind === "cli") return <GitHubPluginSettings onBack={() => setFocus(null)} />;
  if (focus?.kind === "app") {
    const card = connectors.cards?.find((c) => c.slug === focus.id);
    return card ? (
      <>
        <AppSettings card={card} connected={Boolean(connectors.status[card.slug]?.connected)} connectors={connectors} onBack={() => setFocus(null)} />
        <ComposioKeyDialog connectors={connectors} />
      </>
    ) : (
      <div>
        <BackLink onBack={() => setFocus(null)} />
        <div className="mt-6 flex items-center gap-2 text-ui text-muted-foreground">
          {connectors.cards === null ? (
            <>
              <Loader2 size={14} className="animate-spin" /> {t("common.loading2")}
            </>
          ) : (
            t("pluginSettings.appNotFound")
          )}
        </div>
      </div>
    );
  }
  if (focus?.kind === "skill") {
    const skill = skills?.find((s) => s.id === focus.id);
    return skill ? (
      <SkillSettings
        skill={skill}
        onBack={() => setFocus(null)}
        onChanged={() => void loadSkills()}
        onRemoved={() => {
          setFocus(null);
          void loadSkills();
        }}
      />
    ) : (
      <div>
        <BackLink onBack={() => setFocus(null)} />
        <p className="mt-6 text-ui text-muted-foreground">{skills === null ? t("common.loading2") : t("pluginSettings.skillNotFound")}</p>
      </div>
    );
  }

  // null while a list is still being asked for: a 0 there read as "none"
  // for the moment before the real number came
  const counts: Record<List, number | null> = {
    apps: connectors.cards === null ? null : connectors.installed.length,
    mcps: servers === null ? null : servers.length,
    clis: clis === null ? null : clis.length,
    skills: skills === null ? null : skills.length,
  };

  return (
    <div>
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-display font-semibold text-foreground">{t("common.plugins")}</h2>
          <p className="mt-1.5 text-ui text-muted-foreground">{t("pluginSettings.manageAppsMcpServersClis")}</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => dispatch({ type: "openCustomize", tab: list === "skills" ? "skills" : "plugins" })}
            className={cn(pill, "border bg-card px-4 text-body font-medium text-foreground hover:bg-accent")}
          >
            {t("pluginSettings.browseDirectory")}
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger className={cn(pill, "gap-1 bg-foreground px-4 text-body font-medium text-background hover:opacity-90")}>
              {t("common.add")}
              <ChevronDown size={14} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[220px]">
              <DropdownMenuItem onClick={() => setAddingServer(true)}>
                <Puzzle />
                {t("pluginSettings.addCustomMcpServer")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setAddingSkill(true)}>
                <Sparkles />
                {t("pluginSettings.addASkill")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      <div className="mt-7 flex flex-wrap items-center justify-between gap-3">
        <div role="tablist" className="flex items-center gap-1">
          {(
            [
              ["apps", "pluginSettings.tab.apps"],
              ["mcps", "pluginSettings.tab.mcps"],
              ["clis", "pluginSettings.tab.clis"],
              ["skills", "common.skills"],
            ] as const satisfies ReadonlyArray<readonly [string, MessageKey]>
          ).map(([value, text]) => (
            <button
              key={value}
              role="tab"
              aria-selected={list === value}
              onClick={() => setList(value)}
              className={cn(
                "flex h-8 items-center gap-1.5 rounded-lg px-3 text-ui font-medium transition-colors duration-150",
                list === value ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {t(text)}
              {counts[value] === null ? (
                <span className="inline-block h-2.5 w-3 animate-pulse rounded-sm bg-muted-foreground/25" aria-hidden />
              ) : (
                <span className="tabular-nums text-muted-foreground">{counts[value]}</span>
              )}
            </button>
          ))}
        </div>
        <label className="flex h-9 w-full max-w-[280px] items-center gap-2 rounded-xl border bg-card px-3 focus-within:border-ring/50">
          <Search size={15} className="shrink-0 text-muted-foreground" />
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={list === "apps" ? t("pluginSettings.searchApps") : list === "mcps" ? t("pluginSettings.searchMcpServers") : list === "clis" ? t("pluginSettings.searchClis") : t("pluginSettings.searchSkills")}
            aria-label={t("common.search")}
            className="min-w-0 flex-1 bg-transparent text-ui text-foreground outline-none placeholder:text-muted-foreground"
          />
        </label>
      </div>

      <div className="mt-5">
        {list === "apps" &&
          (connectors.cards === null ? (
            <Loading />
          ) : !connectors.configured ? (
            <Empty>
              {tr("pluginSettings.needsAComposioKey", {
                addKey: (
                  <button onClick={() => connectors.askForKey()} className="text-foreground underline underline-offset-2">
                    {t("pluginSettings.addAKey")}
                  </button>
                ),
              })}
            </Empty>
          ) : apps.length === 0 ? (
            <Empty>
              {q ? t("pluginSettings.noAppsMatch", { query: query.trim() }) : t("pluginSettings.noAppsConnectedYet")}{" "}
              {!q && (
                <button onClick={() => dispatch({ type: "openCustomize", tab: "plugins" })} className="text-foreground underline underline-offset-2">
                  {t("pluginSettings.browseTheDirectory")}
                </button>
              )}
            </Empty>
          ) : (
            <Card>
              {apps.map((card) => (
                <Row
                  key={card.slug}
                  onOpen={() => setFocus({ kind: "app", id: card.slug })}
                  tile={
                    <Tile>
                      <ServiceIcon card={card} />
                    </Tile>
                  }
                  name={card.label}
                  line={detailsFor(card).about}
                  aside={
                    <button
                      onClick={() => setFocus({ kind: "app", id: card.slug })}
                      aria-label={`${card.label} settings`}
                      className="flex items-center gap-2 text-body text-muted-foreground"
                    >
                      {t("common.connected")}
                      <ChevronRight size={16} />
                    </button>
                  }
                />
              ))}
            </Card>
          ))}

        {list === "mcps" &&
          (servers === null ? (
            <Loading />
          ) : shownServers.length === 0 ? (
            <Empty>
              {q ? t("pluginSettings.noServersMatch", { query: query.trim() }) : t("pluginSettings.noMcpServersYet")}{" "}
              {!q && (
                <button onClick={() => setAddingServer(true)} className="text-foreground underline underline-offset-2">
                  {t("pluginSettings.addOne")}
                </button>
              )}
            </Empty>
          ) : (
            <>
              <h3 className="mb-2.5 text-ui font-semibold text-foreground">{t("pluginSettings.servers")}</h3>
              <Card>
                {shownServers.map((server) => {
                  const n = agents.filter((b) => b.mcpServers?.includes(server.id)).length;
                  return (
                    <Row
                      key={server.id}
                      onOpen={() => setFocus({ kind: "mcp", id: server.id })}
                      tile={
                        <Tile>
                          <Puzzle size={17} />
                        </Tile>
                      }
                      name={server.name}
                      line={<McpTargetLine server={server} />}
                      aside={
                        <span className="flex shrink-0 items-center gap-3">
                          {(server.needs ?? []).length > 0 && (
                            <button
                              onClick={() => setFocus({ kind: "mcp", id: server.id })}
                              className="rounded-lg border px-2.5 py-1 text-body font-medium text-foreground transition-colors hover:bg-accent"
                            >
                              {t("pluginSettings.finishSetup")}
                            </button>
                          )}
                          <span className="text-body tabular-nums text-muted-foreground">{usedBy(n)}</span>
                          <button
                            onClick={() => setFocus({ kind: "mcp", id: server.id })}
                            aria-label={`${server.name} settings`}
                            title={t("common.settings")}
                            className="flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                          >
                            <Settings size={16} />
                          </button>
                        </span>
                      }
                    />
                  );
                })}
              </Card>
            </>
          ))}

        {list === "clis" &&
          (clis === null ? (
            <Loading />
          ) : cliError ? (
            <Empty>{cliError}</Empty>
          ) : shownClis.length === 0 ? (
            <Empty>{t("pluginSettings.noClisMatch", { query: query.trim() })}</Empty>
          ) : (
            <>
              <p className="mb-2.5 text-pretty text-body text-muted-foreground">{t("pluginSettings.toolsOnThisComputerThat")}</p>
              <Card>
                {shownClis.map((plugin) => (
                  <Row
                    key={plugin.id}
                    onOpen={() => setFocus({ kind: "cli", id: plugin.id })}
                    tile={
                      <Tile>
                        <GitHubMark size={18} />
                      </Tile>
                    }
                    name={plugin.name}
                    line={cliPluginLine(plugin)}
                    aside={
                      <button
                        onClick={() => setFocus({ kind: "cli", id: plugin.id })}
                        aria-label={t("pluginSettings.pluginSettingsLabel", { plugin: plugin.name })}
                        className="flex shrink-0 items-center gap-2 text-body text-muted-foreground"
                      >
                        {plugin.enabled ? t("pluginSettings.on") : t("common.off")}
                        <ChevronRight size={16} />
                      </button>
                    }
                  />
                ))}
              </Card>
            </>
          ))}

        {list === "skills" &&
          (skills === null ? (
            <Loading />
          ) : shownSkills.length === 0 ? (
            <Empty>{q ? t("pluginSettings.noSkillsMatch", { query: query.trim() }) : t("pluginSettings.noSkillsYet")}</Empty>
          ) : (
            <Card>
              {shownSkills.map((skill) => {
                const n = agents.filter((b) => b.skillIds?.includes(skill.id)).length;
                return (
                  <Row
                    key={skill.id}
                    onOpen={() => setFocus({ kind: "skill", id: skill.id })}
                    tile={<Tile>{skill.source === "builtin" ? <Lock size={16} /> : <Sparkles size={17} />}</Tile>}
                    name={skill.name}
                    line={skill.description}
                    aside={
                      <span className="flex shrink-0 items-center gap-3 text-body text-muted-foreground">
                        <span>{skill.source === "builtin" ? t("pluginSettings.builtIn") : t("pluginSettings.yoursVersion", { version: String(skill.revision ?? 1) })}</span>
                        {skill.uses ? <span className="tabular-nums">{t("pluginSettings.uses", { count: skill.uses })}</span> : null}
                        <span className="tabular-nums">{usedBy(n)}</span>
                        <ChevronRight size={16} />
                      </span>
                    }
                  />
                );
              })}
            </Card>
          ))}
      </div>

      <AddMcpServerDialog
        open={addingServer}
        onOpenChange={setAddingServer}
        onAdded={(id) => {
          reloadServers();
          setFocus({ kind: "mcp", id });
        }}
      />
      <AddSkillDialog open={addingSkill} onOpenChange={setAddingSkill} onInstalled={() => void loadSkills()} />
      <ComposioKeyDialog connectors={connectors} />
    </div>
  );
}

function Loading() {
  return (
    <div className="flex items-center gap-2 py-10 text-body text-muted-foreground">
      <Loader2 size={14} className="animate-spin" /> {t("common.loading2")}
    </div>
  );
}

function Section({ title, says, children }: { title: string; says?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border bg-card p-5">
      <h3 className="text-lead font-semibold text-foreground">{title}</h3>
      {says && <p className="mt-1 text-pretty text-body text-muted-foreground">{says}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

/** An app's page in Settings: its connection, and which agents may use
 * connected apps (one switch per agent covers every app; Bloks has no
 * switch for one app alone). */
function AppSettings({
  card,
  connected,
  connectors,
  onBack,
}: {
  card: ToolkitCard;
  connected: boolean;
  connectors: ReturnType<typeof useConnectors>;
  onBack: () => void;
}) {
  const { state, dispatch } = useStore();
  const agents = state.bots.filter((b) => !b.hidden);
  const details = detailsFor(card);
  const busy = connectors.busySlug === card.slug;
  return (
    <div>
      <BackLink onBack={onBack} />
      <div className="mt-6 flex flex-wrap items-center justify-between gap-4">
        <div className="min-w-0">
          <h2 className="flex min-w-0 items-center gap-3 text-display font-semibold text-foreground">
            <ServiceIcon card={card} />
            <span className="truncate">{card.label}</span>
          </h2>
          <p className="mt-0.5 text-ui text-muted-foreground">{t("pluginSettings.categoryThroughComposio", { category: details.category })}</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => dispatch({ type: "openCustomize", tab: "plugins", app: card.slug })}
            className={cn(pill, "border bg-card px-4 text-body font-medium text-foreground hover:bg-accent")}
          >
            {t("pluginSettings.viewDetails")}
          </button>
          {connected && (
            <button
              onClick={() => tryPrompt(state, dispatch, t("appDetails.usingApp", { app: card.label, prompt: details.prompts[0] }))}
              className={cn(pill, "gap-1.5 bg-foreground px-4 text-body font-medium text-background hover:opacity-90")}
            >
              <MessageSquare size={15} />
              {t("pluginSettings.tryNow")}
            </button>
          )}
        </div>
      </div>

      <div className="mt-7 flex flex-col gap-4">
        <Section title={t("pluginSettings.connection")}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="flex items-center gap-2 text-ui text-foreground">
              <span className={cn("size-2 rounded-full", connected ? "bg-success" : "bg-muted-foreground/50")} />
              {connected ? t("common.connected") : t("pluginSettings.notConnected")}
            </span>
            <span className="flex items-center gap-2">
              {busy && <Loader2 size={15} className="animate-spin text-muted-foreground" />}
              <button
                onClick={() => connectors.connect(card.slug)}
                disabled={busy}
                className="flex h-8 items-center gap-1.5 rounded-lg border px-3 text-body font-medium text-foreground transition-colors hover:bg-accent disabled:opacity-40"
              >
                {connected ? <RefreshCw size={14} /> : <Plus size={14} />}
                {connected ? t("pluginSettings.signInAgain") : t("common.connect")}
              </button>
              {connected && (
                <button
                  onClick={() => connectors.disconnect(card.slug)}
                  disabled={busy}
                  className="flex h-8 items-center gap-1.5 rounded-lg px-3 text-body font-medium text-destructive transition-colors hover:bg-destructive/10"
                >
                  <Trash2 size={14} />
                  {t("common.disconnect")}
                </button>
              )}
            </span>
          </div>
        </Section>

        <Section
          title={t("pluginSettings.agentsThatCanUseApps")}
          says={t("pluginSettings.eachSwitchCoversAllConnected")}
        >
          <div className="flex flex-col divide-y">
            {agents.map((bot) => (
              <div key={bot.id} className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
                <AgentAvatar bot={bot} size={26} />
                <span className="min-w-0 flex-1 truncate text-ui text-foreground">{bot.name}</span>
                <Switch
                  checked={bot.composio !== false}
                  aria-label={t("pluginSettings.agentCanUseApps", { agent: bot.name })}
                  onCheckedChange={(on) => dispatch({ type: "updateBot", botId: bot.id, patch: { composio: on } })}
                />
              </div>
            ))}
          </div>
        </Section>
      </div>
    </div>
  );
}

/** A skill's page in Settings: what it says, every version it has been,
 * and which agents use it. */
function SkillSettings({
  skill,
  onBack,
  onChanged,
  onRemoved,
}: {
  skill: Skill;
  onBack: () => void;
  onChanged: () => void;
  onRemoved: () => void;
}) {
  const { state, dispatch } = useStore();
  const agents = state.bots.filter((b) => !b.hidden);
  const remove = async () => {
    const yes = await confirm({
      title: t("pluginSettings.removeSkillTitle", { skill: skill.name }),
      body: t("pluginSettings.removeSkillBody"),
      confirmLabel: t("common.remove"),
      destructive: true,
    });
    if (!yes) return;
    void api(`/api/skills/${skill.id}`, { method: "DELETE" })
      .then(() => {
        onRemoved();
        toast(t("pluginSettings.removedSkill", { skill: skill.name }));
      })
      .catch(() => {});
  };
  return (
    <div>
      <BackLink onBack={onBack} />
      <div className="mt-6 flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-center gap-4">
          <Tile size={14}>{skill.source === "builtin" ? <Lock size={20} /> : <Sparkles size={22} />}</Tile>
          <div className="min-w-0">
            <h2 className="truncate text-display font-semibold text-foreground">{skill.name}</h2>
            <p className="mt-0.5 text-ui text-muted-foreground">{skill.source === "builtin" ? t("pluginSettings.builtIn") : t("pluginSettings.yours")}</p>
          </div>
        </div>
        {skill.source === "user" && (
          <button
            onClick={remove}
            className="flex h-9 items-center gap-1.5 rounded-xl bg-destructive/10 px-3.5 text-ui font-medium text-destructive transition-colors hover:bg-destructive/15"
          >
            <Trash2 size={15} />
            {t("common.remove")}
          </button>
        )}
      </div>
      {skill.description && <p className="mt-4 text-pretty text-ui text-foreground">{skill.description}</p>}

      <div className="mt-6 flex flex-col gap-4">
        <Section title={t("pluginSettings.agentsThatUseIt")}>
          <div className="flex flex-col divide-y">
            {agents.map((bot) => {
              const ids = bot.skillIds ?? [];
              const on = ids.includes(skill.id);
              return (
                <div key={bot.id} className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
                  <AgentAvatar bot={bot} size={26} />
                  <span className="min-w-0 flex-1 truncate text-ui text-foreground">{bot.name}</span>
                  <Switch
                    checked={on}
                    aria-label={t("pluginSettings.agentUsesSkill", { agent: bot.name, skill: skill.name })}
                    onCheckedChange={(next) =>
                      dispatch({
                        type: "updateBot",
                        botId: bot.id,
                        patch: { skillIds: next ? [...ids, skill.id] : ids.filter((x) => x !== skill.id) },
                      })
                    }
                  />
                </div>
              );
            })}
          </div>
        </Section>
        <Section title={t("common.instructions")}>
          <SkillDetail skill={skill} onChanged={onChanged} />
        </Section>
      </div>
    </div>
  );
}
