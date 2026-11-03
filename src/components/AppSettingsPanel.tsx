// Settings, as a page of its own beside the sidebar: you, your plan, the
// workspace you are in, how agents work here, and what they connect to.
// Per-agent settings live in SettingsPanel; contextual Box-token entry
// also stays in ComputerPanel.
//
// A page rather than a window because it outgrew one: a dozen areas in a
// 720px box meant scrolling inside a scroll. One list, in groups people
// look in (Account, the workspace by its own name, Agents, Integrations,
// Connections, Data), and one search that finds the row a word lives on,
// not only its page. The workspace's own pages are in the same list,
// under its name and mark, so there is one Settings rather than two that
// link to each other.
//
// The list is a page column (SideColumn.tsx): its edge is dragged to size
// it, and folded (⌘B, the title bar's toggle, or a drag narrow enough) it
// becomes a strip of tabs along the top of the page, in the same groups
// and order, so every page is still a click away.
//
// What the pages are, and where an old page id goes now, is data
// (src/lib/settingsPages.ts); this file is the shell, and each page
// draws itself from the pieces in SettingsLayout.tsx.
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  BellDot,
  Cpu,
  Download,
  Globe,
  History,
  Info,
  LayoutGrid,
  Luggage,
  MessageCircle,
  MessagesSquare,
  House,
  Mic,
  Monitor,
  Puzzle,
  Search as SearchIcon,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  Smartphone,
  Sparkles,
  SquarePen,
  User as UserIcon,
  UserPlus,
  Users,
  Workflow,
  X,
} from "@/components/icons";
import { useStore } from "@/state/store";
import { cn } from "@/lib/cn";
import { useEscape } from "@/lib/useEscape";
import { riskyCount, useSecurityCheckup } from "@/lib/securityCheckup";
import { useWaitingCount } from "@/lib/members";
import { currentWorkspace, useWorkspaces } from "@/lib/workspaces";
import {
  SETTINGS_GROUPS,
  SETTINGS_PAGE_LIST,
  isWorkspaceSettingsPage,
  rowKey,
  searchSettings,
  settingsPage,
  type SettingsPageInfo,
} from "@/lib/settingsPages";
import { RecordPanel } from "./RecordPanel";
import { BackupsSection } from "./BackupsSection";
import { TrainingExportPage } from "./TrainingExport";
import { PluginSettings } from "./PluginSettings";
import { EnginesPanel } from "./EnginesPanel";
import { DevicesSection } from "./DevicesSection";
import { LocationSection } from "./LocationSection";
import { TelegramSection } from "./TelegramSection";
import { SignalSection } from "./SignalSection";
import { HomeAssistantPage } from "./HomeAssistantPage";
import { ChatSection } from "./ChatSection";
import { RemoteSection } from "./RemoteSection";
import { SecurityCheckup } from "./SecurityCheckup";
import { BringYourSetupPage } from "./BringYourSetup";
import { PastSessionsPage } from "./PastSessions";
import { AgentDefaults } from "./AgentDefaults";
import { SettingsPageHeader } from "./SettingsLayout";
import { SideColumn, SideTabs, type SideTabGroup } from "./SideColumn";
import { setColumnOpen, useColumnFolded, type SideColumnSize } from "@/lib/sideColumn";
import { WorkspaceMark } from "./WorkspaceMark";
import { WorkspacePageBody } from "./WorkspaceSettings";
import { AboutPage, DeploymentMark, deploymentKindOf } from "./settings/AboutPage";
import { BehaviourPage } from "./settings/BehaviourPage";
import { GeneralPage } from "./settings/GeneralPage";
import { PlanPage } from "./settings/PlanPage";
import { AboutYouPage, AppsPage, ComputersPage, RulesPage, VoicesPage } from "./settings/pages";
import { BrowserPage } from "./settings/BrowserPage";
import { inEnglish, t } from "@/lib/i18n";

type Icon = React.ComponentType<{ size?: number; className?: string }>;

const ICONS: Record<string, Icon> = {
  plan: Sparkles,
  general: SlidersHorizontal,
  "about-you": UserIcon,
  "workspace:general": SquarePen,
  "workspace:members": Users,
  "workspace:online": Globe,
  "workspace:notifications": BellDot,
  engines: Cpu,
  "new-agents": UserPlus,
  behaviour: Workflow,
  rules: ShieldCheck,
  security: ShieldAlert,
  voices: Mic,
  plugins: Puzzle,
  apps: LayoutGrid,
  devices: Smartphone,
  chat: MessageCircle,
  home: House,
  computers: Monitor,
  browser: Globe,
  "past-sessions": MessagesSquare,
  "bring-setup": Luggage,
  record: History,
  backups: Archive,
  training: Download,
  about: Info,
};

interface SettingsPage {
  id: string;
  readonly label: string;
  icon: Icon;
  readonly description: string;
  readonly keywords: string;
}

/** Every page of the person's own Settings, grouped, with its icon: the
 * command palette offers them by name. The workspace's pages are reached
 * there through "Workspace settings". */
export const SETTINGS_PAGES: Array<{ readonly group: string; pages: SettingsPage[] }> = SETTINGS_GROUPS.filter((g) => g.id !== "workspace").map((g) => ({
  // read when asked for, so the palette names them in the language of the day
  get group() {
    return t(g.label);
  },
  pages: SETTINGS_PAGE_LIST.filter((p) => p.group === g.id).map((p) => ({
    id: p.id,
    get label() {
      return p.label;
    },
    icon: ICONS[p.id] ?? SlidersHorizontal,
    get description() {
      return p.description;
    },
    // the reader's words and the English ones, so either finds the page
    get keywords() {
      return [p.keywords, t(p.keywordsKey), inEnglish(p.labelKey), ...p.rows, ...p.rowMessages.map((key) => inEnglish(key))].join(" ");
    },
  })),
}));

function PageBody({ id }: { id: string }) {
  if (isWorkspaceSettingsPage(id)) return <WorkspacePageBody page={id} />;
  switch (id) {
    case "plan":
      return <PlanPage />;
    case "general":
      return <GeneralPage />;
    case "about-you":
      return <AboutYouPage />;
    case "engines":
      return <EnginesPanel />;
    case "new-agents":
      return <AgentDefaults />;
    case "behaviour":
      return <BehaviourPage />;
    case "rules":
      return <RulesPage />;
    case "security":
      return <SecurityCheckup />;
    case "voices":
      return <VoicesPage />;
    case "plugins":
      return <PluginSettings />;
    case "apps":
      return <AppsPage />;
    case "devices":
      return (
        <>
          <RemoteSection />
          <DevicesSection />
          <LocationSection />
        </>
      );
    case "chat":
      return (
        <>
          <TelegramSection />
          <SignalSection />
          <ChatSection />
        </>
      );
    case "home":
      return <HomeAssistantPage />;
    case "computers":
      return <ComputersPage />;
    case "browser":
      return <BrowserPage />;
    case "past-sessions":
      return <PastSessionsPage />;
    case "bring-setup":
      return <BringYourSetupPage />;
    case "record":
      return <RecordPanel />;
    case "backups":
      return <BackupsSection />;
    case "training":
      return <TrainingExportPage />;
    case "about":
      return <AboutPage />;
    default:
      return null;
  }
}

/** Pages that draw their own heading, with their own tools in it. */
const OWN_HEADER = new Set(["plugins", "workspace:members"]);

/** The list of pages beside the page: wide enough at its narrowest for
 * "Rules and approvals" and "Security checkup" with its count. */
const SETTINGS_COLUMN: SideColumnSize = { min: 200, max: 380, initial: 252, foldBelow: 150 };

const reducedMotion = () => typeof window !== "undefined" && Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);

/** A label with the search's words in bold where it says them. */
function Marked({ text, words }: { text: string; words: string[] }) {
  if (!words.length) return <>{text}</>;
  const lower = text.toLowerCase();
  const hits = new Array<boolean>(text.length).fill(false);
  for (const w of words) {
    let at = lower.indexOf(w);
    while (at >= 0) {
      for (let i = at; i < at + w.length; i++) hits[i] = true;
      at = lower.indexOf(w, at + w.length);
    }
  }
  const parts: Array<{ text: string; hit: boolean }> = [];
  for (let i = 0; i < text.length; i++) {
    const last = parts.at(-1);
    if (last && last.hit === hits[i]) last.text += text[i];
    else parts.push({ text: text[i]!, hit: Boolean(hits[i]) });
  }
  return (
    <>
      {parts.map((p, i) =>
        p.hit ? (
          <mark key={i} className="bg-transparent font-semibold text-foreground">
            {p.text}
          </mark>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </>
  );
}

export function AppSettingsPanel() {
  const { state, dispatch } = useStore();
  const [query, setQuery] = useState("");
  // a row a search result asked for, scrolled to and lit once its page is in
  const [target, setTarget] = useState<{ page: string; row: string; at: number } | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const workspaces = useWorkspaces();
  const ws = currentWorkspace(workspaces);
  const waiting = useWaitingCount();
  // only what is risky earns a number in the list; worth a look waits on the page
  const risky = riskyCount(useSecurityCheckup().report);

  // the workspace's own pages are there where there are workspaces, and
  // Members only where there can be people: a team, or a workspace joined
  // or hosted. A Just me workspace, Personal always, has nobody to manage.
  const soloWorkspace = Boolean(ws) && !ws!.team && (ws!.kind === "personal" || ws!.kind === "business" || ws!.kind === "custom");
  // A browser has no list of workspaces, but the one it shows still has
  // people: Members is there for its owner, the way it is in the app, and
  // General, which says this server is one workspace and how to have another.
  const browser = !workspaces.available && !window.bloks;
  const pages = useMemo(
    () =>
      SETTINGS_PAGE_LIST.filter(
        (p) => (!p.workspace || Boolean(ws) || (browser && (p.id === "workspace:members" || p.id === "workspace:general"))) && !(p.id === "workspace:members" && soloWorkspace),
      ),
    [ws, soloWorkspace, browser],
  );
  const pageId = settingsPage(state.settingsPage) ? state.settingsPage : "general";
  const page = settingsPage(pageId)!;
  const close = () => dispatch({ type: "toggleAppSettings", open: false });
  const go = (id: string, row?: string) => {
    dispatch({ type: "toggleAppSettings", open: true, page: id });
    setTarget(row ? { page: id, row: rowKey(row), at: Date.now() } : null);
  };

  // A row asked for from outside the list, such as an agent's card in a
  // conversation: the same scroll and light a search result gets.
  const asked = state.settingsRow;
  useEffect(() => {
    if (asked) setTarget({ page: asked.page, row: rowKey(asked.row), at: asked.at });
  }, [asked]);

  // a new page starts at its top, not wherever the last one was left
  const targetRef = useRef(target);
  targetRef.current = target;
  useEffect(() => {
    if (targetRef.current?.page !== pageId) scroller.current?.scrollTo({ top: 0 });
  }, [pageId]);

  // A row found by search: its page may still be loading, so it is looked
  // for a few times before giving up quietly. Lit with the accent's soft
  // tint, which the row lets go of slowly (its own colour transition).
  useEffect(() => {
    if (!target || target.page !== pageId) return;
    let tries = 0;
    let unlight: ReturnType<typeof setTimeout> | undefined;
    const look = setInterval(() => {
      const row = scroller.current?.querySelector<HTMLElement>(`[data-setting-row="${target.row}"]`);
      if (!row && ++tries < 15) return;
      clearInterval(look);
      if (!row) return;
      row.scrollIntoView({ block: "center", behavior: reducedMotion() ? "auto" : "smooth" });
      row.classList.add("bg-brand-soft");
      unlight = setTimeout(() => row.classList.remove("bg-brand-soft"), 1400);
    }, 80);
    return () => {
      clearInterval(look);
      clearTimeout(unlight);
    };
  }, [target, pageId]);

  // Escape leaves, unless something opened on top of the page takes it first
  useEscape(close);

  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matches = searchSettings(query, pages);
  const groups = SETTINGS_GROUPS.map((g) => ({ ...g, matches: matches.filter((m) => m.page.group === g.id) })).filter((g) => g.matches.length);

  // Up and down walk the list, the way a sidebar of pages reads; Home and
  // End reach its ends, and up from the first goes back to the search.
  const walk = (e: React.KeyboardEvent) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    const items = [...(list.current?.querySelectorAll<HTMLButtonElement>("[data-nav-item]") ?? [])].filter((b) => b.offsetParent !== null);
    if (!items.length) return;
    e.preventDefault();
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : e.key === "ArrowDown" ? Math.min(items.length - 1, at + 1) : at - 1;
    if (next < 0) search.current?.focus();
    else items[next]?.focus();
  };

  // Every group is headed by what kind of settings it holds; the workspace
  // group says so too, and keeps which workspace it is on the right, small,
  // so its pages are never mistaken for the app's own.
  const groupTitle = (id: string, label: string) =>
    id === "workspace" && ws ? (
      <span className="flex w-full min-w-0 items-center justify-between gap-2">
        <span className="shrink-0">{label}</span>
        <span className="flex min-w-0 items-center gap-1.5 font-normal">
          <WorkspaceMark mark={ws.mark} logo={ws.logo} size={12} />
          <span className="truncate">{ws.name}</span>
        </span>
      </span>
    ) : (
      label
    );

  const item = (p: SettingsPageInfo, rows: string[]) => {
    const Icon = ICONS[p.id] ?? SlidersHorizontal;
    const on = p.id === pageId && !query;
    return (
      <div key={p.id} className="flex shrink-0 flex-col">
        <button
          type="button"
          data-nav-item
          onClick={() => {
            go(p.id, rows[0]);
            if (query) setQuery("");
          }}
          aria-current={on ? "page" : undefined}
          className={cn(
            "flex shrink-0 items-center gap-2.5 whitespace-nowrap rounded-lg px-2.5 py-1.5 text-left text-body outline-none transition-[background-color,color] duration-150",
            on ? "bg-background font-medium text-foreground shadow-[0_0_0_0.5px_var(--border)]" : "text-muted-foreground hover:bg-accent/70 hover:text-foreground",
          )}
        >
          <Icon size={16} className={cn("shrink-0", on ? "text-foreground" : "text-muted-foreground")} />
          <span className="truncate">
            <Marked text={p.label} words={words} />
          </span>
          {p.id === "security" && risky > 0 && (
            <span aria-label={t("appSettingsPanel.risky", { count: risky })} className="ml-auto rounded-md bg-destructive/10 px-1.5 py-0.5 text-caption font-medium tabular-nums text-destructive">
              {risky}
            </span>
          )}
          {/* somebody asking to join is said where the eye goes (design: Mac-Approve) */}
          {p.id === "workspace:members" && waiting > 0 && <span className="ml-auto text-small font-semibold tabular-nums text-warning">{t("appSettingsPanel.waiting", { count: waiting })}</span>}
        </button>
        {/* the rows a search found on this page, each a way straight to it */}
        {rows.map((row) => (
          <button
            key={row}
            type="button"
            data-nav-item
            onClick={() => {
              go(p.id, row);
              setQuery("");
            }}
            className="ml-[34px] hidden truncate rounded-md px-2 py-1 text-left text-small text-muted-foreground outline-none transition-colors duration-150 hover:bg-accent/70 hover:text-foreground md:block"
          >
            <Marked text={row} words={words} />
          </button>
        ))}
      </div>
    );
  };

  const workspacePage = isWorkspaceSettingsPage(pageId);

  // Folded, the list becomes tabs along the top of the page: every page,
  // in the list's groups and order, with what the list counts beside it.
  const folded = useColumnFolded("settings", SETTINGS_COLUMN);
  const tabGroups: SideTabGroup[] = SETTINGS_GROUPS.map((g) => ({
    id: g.id,
    name: g.id === "workspace" && ws ? t("appSettingsPanel.workspaceNamed", { name: ws.name }) : t(g.label),
    // "General" is in two groups, so the workspace's says whose it is
    label:
      g.id === "workspace" && ws ? (
        <>
          <WorkspaceMark mark={ws.mark} logo={ws.logo} size={12} />
          <span className="max-w-[140px] truncate">{ws.name}</span>
        </>
      ) : (
        t(g.label)
      ),
    tabs: pages
      .filter((p) => p.group === g.id)
      .map((p) => ({
        id: p.id,
        label: p.label,
        badge:
          p.id === "security" && risky > 0 ? (
            <span aria-label={t("appSettingsPanel.risky", { count: risky })} className="rounded-md bg-destructive/10 px-1.5 py-px text-caption font-medium tabular-nums text-destructive">
              {risky}
            </span>
          ) : p.id === "workspace:members" && waiting > 0 ? (
            <span aria-label={t("appSettingsPanel.waiting", { count: waiting })} className="text-small font-semibold tabular-nums text-warning">
              {waiting}
            </span>
          ) : undefined,
      })),
  })).filter((g) => g.tabs.length);
  // search lives in the list, so the strip's search opens it there
  const searchInList = () => {
    setColumnOpen("settings", true);
    requestAnimationFrame(() => requestAnimationFrame(() => search.current?.focus()));
  };

  return (
    <main className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-background md:flex-row">
      <SideColumn id="settings" size={SETTINGS_COLUMN} as="nav" label={t("common.settings")} className="border-b bg-sidebar/60 md:border-b-0">
        {/* No back button of its own: the title bar's Back (or Esc) leaves,
            and on a phone the pill's drawer does; the room on the left
            there is the pill's. */}
        <div className="flex h-[52px] items-center gap-2 px-4 max-md:pl-16">
          <span className="text-lead font-semibold text-foreground">{t("common.settings")}</span>
          {deploymentKindOf(state.config) && <DeploymentMark kind={deploymentKindOf(state.config)!} />}
        </div>
        <div className="px-3 pb-2">
          <div className="flex items-center gap-2 rounded-xl bg-accent/70 px-3 py-[7px] transition-colors duration-150 focus-within:bg-accent">
            <SearchIcon size={15} className="shrink-0 text-muted-foreground" />
            <input
              ref={search}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape" && query) {
                  e.preventDefault();
                  e.stopPropagation();
                  setQuery("");
                } else if (e.key === "Enter" && matches[0]) {
                  go(matches[0].page.id, matches[0].rows[0]);
                  setQuery("");
                } else if (e.key === "ArrowDown") {
                  e.preventDefault();
                  list.current?.querySelector<HTMLButtonElement>("[data-nav-item]")?.focus();
                }
              }}
              placeholder={t("appSettingsPanel.searchSettings")}
              aria-label={t("appSettingsPanel.searchSettings")}
              aria-controls="settings-pages"
              className="w-full bg-transparent text-ui text-foreground outline-none placeholder:text-muted-foreground"
            />
            {query && (
              <button
                type="button"
                aria-label={t("appSettingsPanel.clearSearch")}
                onClick={() => {
                  setQuery("");
                  search.current?.focus();
                }}
                className="-mr-1 rounded-md p-0.5 text-muted-foreground transition-colors hover:text-foreground"
              >
                <X size={13} />
              </button>
            )}
          </div>
        </div>
        <div
          id="settings-pages"
          ref={list}
          onKeyDown={walk}
          className="flex gap-0.5 overflow-x-auto px-2 pb-2 [scrollbar-width:none] md:flex-1 md:flex-col md:overflow-y-auto md:pb-4 [&::-webkit-scrollbar]:hidden"
        >
          {groups.map((g) => (
            <div
              key={g.id}
              role="group"
              aria-label={g.id === "workspace" && ws ? t("appSettingsPanel.workspaceNamed", { name: ws.name }) : t(g.label)}
              className="flex shrink-0 gap-0.5 md:flex-col"
            >
              <div className="hidden px-2.5 pb-1 pt-3 text-small font-medium text-muted-foreground md:flex">{groupTitle(g.id, t(g.label))}</div>
              {/* a phone has no room for headings: the workspace's own pages
                  are set apart by its mark instead */}
              {g.id === "workspace" && ws && (
                <span aria-hidden className="flex items-center border-l pl-3 pr-1 md:hidden">
                  <WorkspaceMark mark={ws.mark} logo={ws.logo} size={16} />
                </span>
              )}
              {g.matches.map((m) => item(m.page, m.rows))}
            </div>
          ))}
          {groups.length === 0 && (
            <div className="flex flex-col gap-1 px-3 py-6 text-body text-muted-foreground">
              <span>{t("appSettingsPanel.nothingMatches", { query: query.trim() })}</span>
              <button type="button" onClick={() => setQuery("")} className="w-fit rounded text-small font-medium text-foreground underline-offset-2 hover:underline">
                {t("appSettingsPanel.clearTheSearch")}
              </button>
            </div>
          )}
        </div>
      </SideColumn>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {folded && (
          <SideTabs
            column="settings"
            label={t("common.settings")}
            groups={tabGroups}
            current={pageId}
            onPick={(id) => go(id)}
            tools={
              <button
                type="button"
                onClick={searchInList}
                aria-label={t("appSettingsPanel.searchSettings")}
                title={t("appSettingsPanel.searchSettings")}
                className="flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground outline-none transition-[background-color,color,scale] duration-150 ease-out hover:bg-accent hover:text-foreground active:scale-[0.96]"
              >
                <SearchIcon size={15} />
              </button>
            }
          />
        )}
        <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto">
          {/* Plugins draws its own header, with its tools, and lists that
              want the room of a wider column */}
          <div className={cn("mx-auto w-full px-5 pb-16 pt-8 md:px-10", pageId === "plugins" ? "max-w-[960px]" : "max-w-[760px]")}>
            {!OWN_HEADER.has(pageId) && (
              <SettingsPageHeader
                title={page.label}
                description={page.description}
                eyebrow={
                  workspacePage && ws ? (
                    <>
                      <WorkspaceMark mark={ws.mark} logo={ws.logo} size={16} />
                      <span className="truncate">{t("appSettingsPanel.workspaceNamed", { name: ws.name })}</span>
                    </>
                  ) : undefined
                }
              />
            )}
            <PageBody id={pageId} />
          </div>
        </div>
      </div>
    </main>
  );
}
