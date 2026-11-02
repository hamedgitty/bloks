// The whole app as a member of somebody else's workspace (or a guest of
// some of its rooms) sees it. App.tsx draws this instead of the owner's
// shell once the member routes have answered for this credential
// (src/lib/memberMode.ts), so no owner route is ever called from here.
//
// The frame is the owner's own: the title bar with the switcher, a
// sidebar, and the work on a panel beside it. The sidebar lists the team
// agents this person reaches, their own solo agents (each marked "Only
// you"), and their rooms; the pages that are theirs sit at its foot.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Gauge, Menu, Plus, Settings, UserRound, Users, X } from "@/components/icons";
import { confirm } from "@/components/ui/confirm";
import { toast } from "@/components/ui/toast";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { WorkspaceSwitcher } from "@/components/WorkspaceSwitcher";
import { WorkspaceDialogs } from "@/components/WorkspaceDialogs";
import { WorkspaceMark } from "@/components/WorkspaceMark";
import { cn } from "@/lib/cn";
import { act, currentWorkspace, useWorkspaces } from "@/lib/workspaces";
import {
  agentGroups,
  defaultLane,
  firstPlace,
  memberApi,
  memberPages,
  startMemberStream,
  useMemberConnected,
  useMemberFrames,
  type AppMode,
  type MemberAgent,
  type MemberPlace,
  type MemberRoomRow,
  type MemberUsage,
  type MemberWorkspace,
} from "@/lib/memberMode";
import { AgentFace, OnlyYou } from "./MemberParts";
import { AgentView, RoomView } from "./MemberViews";
import { distinctNames } from "@/lib/names";
import { ownerOrNull } from "@/lib/yourName";
import { AboutYouPage, MembersAdminPage, NewSoloAgentDialog, UsagePage, WorkspacePage } from "./MemberPages";
import { t, useLanguage } from "@/lib/i18n";
import { thisComputer } from "@/lib/thisComputer";

const isElectron = navigator.userAgent.includes("Electron");
const PLACE_KEY = "bloks-member-place";

function readPlace(): MemberPlace | null {
  try {
    const raw = JSON.parse(localStorage.getItem(PLACE_KEY) ?? "null");
    return raw && typeof raw === "object" && typeof raw.kind === "string" ? (raw as MemberPlace) : null;
  } catch {
    return null;
  }
}
function keepPlace(place: MemberPlace) {
  try {
    localStorage.setItem(PLACE_KEY, JSON.stringify(place));
  } catch {
    /* the place is a convenience; without storage the app opens on its first */
  }
}

const PAGE_ICON = { usage: Gauge, about: UserRound, members: Users, settings: Settings } as const;

/** Leaves the joined workspace this window shows, after asking. */
async function leaveWorkspace(id: string, name: string, owner: string, started: () => void): Promise<boolean> {
  const yes = await confirm({
    title: t("memberApp.leave.title", { name }),
    body: `${t("memberApp.leave.body", { name, owner })}\n\n${t("memberApp.leave.again")}`,
    confirmLabel: t("memberApp.leave.confirm"),
    destructive: true,
  });
  if (!yes) return false;
  started();
  const said = await window.bloks?.workspaceLeave?.(id);
  if (said?.unreachable) {
    const anyway = await confirm({
      title: t("memberApp.leave.unreachableTitle", { owner }),
      body: t("memberApp.leave.unreachableBody", { name, owner, computer: thisComputer() }),
      confirmLabel: t("memberApp.leave.removeAnyway", { computer: thisComputer() }),
      destructive: true,
    });
    if (!anyway) return false;
    const forced = await act(window.bloks?.workspaceLeave?.(id, { force: true }));
    if (forced) toast.error(forced);
    return !forced;
  }
  if (said?.error) {
    toast.error(said.error);
    return false;
  }
  return true;
}

export function MemberApp({ mode }: { mode: Exclude<AppMode, { mode: "owner" }> }) {
  const [workspace, setWorkspace] = useState<MemberWorkspace | null>(mode.mode === "member" ? mode.workspace : null);
  const [agents, setAgents] = useState<MemberAgent[]>([]);
  const [rooms, setRooms] = useState<MemberRoomRow[]>(mode.mode === "guest" ? mode.rooms : []);
  const [loaded, setLoaded] = useState(false);
  const [place, setPlace] = useState<MemberPlace | null>(null);
  const [usage, setUsage] = useState<MemberUsage | null>(null);
  const [making, setMaking] = useState(false);
  const [navigationOpen, setNavigationOpen] = useState(false);
  const navigationTrigger = useRef<HTMLButtonElement>(null);
  const desktopNavigation = useRef<HTMLDivElement>(null);
  // Match the CSS boundary: a drawer left open while widening must not
  // keep a desktop conversation behind a hidden modal.
  useEffect(() => {
    const wide = window.matchMedia("(min-width: 768px)");
    const resized = () => { if (wide.matches) setNavigationOpen(false); };
    wide.addEventListener("change", resized);
    return () => wide.removeEventListener("change", resized);
  }, []);
  const focusNavigation = () => {
    if (window.matchMedia("(min-width: 768px)").matches) {
      desktopNavigation.current?.querySelector<HTMLButtonElement>("button")?.focus();
    } else navigationTrigger.current?.focus();
  };
  const makeSolo = () => {
    setMaking(true);
    setNavigationOpen(false);
  };
  const [leaving, setLeaving] = useState(false);
  const connected = useMemberConnected();
  const switcher = useWorkspaces();
  const entry = currentWorkspace(switcher);
  const member = mode.mode === "member";
  const me = workspace?.you.personId ?? "";
  const owner = workspace?.owner.name ?? (mode.mode === "guest" ? mode.host : t("memberApp.theOwner"));
  // Everybody in the workspace a name could be mistaken among, the owner
  // included: each conversation tells its people apart against them all
  // (src/lib/names.ts), so somebody is called the same everywhere.
  const known = useMemo(
    () => [...(ownerOrNull(owner) ? [{ id: "owner", name: owner }] : []), ...(workspace?.members ?? [])],
    [owner, workspace?.members],
  );
  const called = useMemo(() => distinctNames(known), [known]);
  // its words follow the language, so it is made again when that changes
  const language = useLanguage();
  const nameOf = useCallback(
    (id: string) => (id === me ? t("memberApp.you") : (called.get(id) ?? (id === "owner" ? owner : t("memberApp.someone")))),
    [called, owner, me, language],
  );

  const refresh = useCallback(async () => {
    const [ws, list, mine] = await Promise.all([
      member ? memberApi.workspace().catch(() => null) : Promise.resolve(null),
      member ? memberApi.agents().then((r) => r.agents).catch(() => null) : Promise.resolve([] as MemberAgent[]),
      memberApi.me().then((r) => r.rooms).catch(() => null),
    ]);
    if (ws) setWorkspace(ws);
    if (ws?.paused) {
      // nothing is reachable while paused; it all comes back with Team
      setAgents([]);
      setRooms([]);
    } else {
      if (list) setAgents(list);
      if (mine) setRooms(mine);
    }
    setLoaded(true);
  }, [member]);
  const refreshUsage = useCallback(() => {
    if (member) memberApi.usage().then(setUsage).catch(() => {});
  }, [member]);

  // Paused (the owner is not on Bloks Team): nothing to stream or count,
  // and the workspace is asked again now and then, so the app is back by
  // itself the moment it is.
  const paused = workspace?.paused ?? null;
  useEffect(() => {
    if (paused) {
      void refresh();
      const timer = setInterval(() => void refresh(), 30_000);
      return () => clearInterval(timer);
    }
    startMemberStream();
    void refresh();
    refreshUsage();
    const timer = setInterval(refreshUsage, 60_000);
    return () => clearInterval(timer);
  }, [refresh, refreshUsage, paused]);

  // and its owner's name, when they change it (workspace.owner)
  useEffect(() => {
    const named = ownerOrNull(workspace?.owner.name);
    if (member && named) void window.bloks?.workspaceHost?.(named)?.catch(() => {});
  }, [member, workspace?.owner.name]);

  // the switcher's Member or Admin follows what the server says
  useEffect(() => {
    if (workspace?.you.role) void window.bloks?.workspaceRole?.(workspace.you.role)?.catch(() => {});
  }, [workspace?.you.role]);

  useMemberFrames(
    useCallback(
      (frame) => {
        if (frame.kind === "hello" || frame.kind.startsWith("workspace.") || frame.kind === "room.people") void refresh();
        if (frame.kind === "member.lane") {
          setAgents((list) => list.map((a) => (a.team?.threadId === frame.threadId || a.private?.threadId === frame.threadId ? { ...a, busy: frame.busy === true } : a)));
          if (frame.busy === false) refreshUsage();
        }
        if (frame.kind === "workspace.left" && workspace?.you.role === "admin") {
          const person = frame.person as { name?: string } | undefined;
          toast(t("memberApp.left", { name: person?.name ?? t("memberApp.someone"), workspace: workspace.workspace.name }));
        }
      },
      [refresh, refreshUsage, workspace],
    ),
  );

  // where to be, once the lists are in, and again when what was open goes
  useEffect(() => {
    if (!loaded) return;
    setPlace((was) => {
      const wanted = was ?? readPlace();
      const next = firstPlace(agents, rooms, wanted);
      if (next.kind === "page" && next.page === "members" && workspace?.you.role !== "admin") return { kind: "page", page: "usage" };
      return next;
    });
  }, [loaded, agents, rooms, workspace?.you.role]);
  const go = (next: MemberPlace) => {
    setPlace(next);
    keepPlace(next);
    setNavigationOpen(false);
  };

  const groups = useMemo(() => agentGroups(agents), [agents]);
  const pages = member ? memberPages(workspace?.you.role ?? null) : [];
  const openAgent = place?.kind === "agent" ? agents.find((a) => a.id === place.id) : undefined;

  const leave = async () => {
    if (!entry || !workspace) return;
    // busy only once the person has said yes, while the owner is told
    const gone = await leaveWorkspace(entry.id, workspace.workspace.name, owner, () => setLeaving(true));
    if (!gone) setLeaving(false);
  };

  const deleteAgent = async (agent: MemberAgent) => {
    const yes = await confirm({
      title: t("memberApp.deleteAgent.title", { agent: agent.name }),
      body: t("memberApp.deleteAgent.body", { agent: agent.name, owner }),
      confirmLabel: t("memberApp.deleteAgent.confirm"),
      destructive: true,
    });
    if (!yes) return;
    try {
      await memberApi.dropAgent(agent.id);
      toast(t("memberApp.deleteAgent.done", { agent: agent.name }));
      setPlace(null);
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const navigation = (
    <nav aria-label={t("memberApp.agentsAndRooms")} className="flex min-h-0 w-full flex-1 flex-col bg-sidebar">
      <div className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-3 pt-1">
        {member && !paused && (
          <Section title={t("memberApp.teamAgents")}>
            {groups.team.map((a) => (
              <AgentRow key={a.id} agent={a} on={openAgent?.id === a.id} onOpen={() => go({ kind: "agent", id: a.id, lane: defaultLane(a) })} />
            ))}
            {loaded && !groups.team.length && <Empty>{t("memberApp.noTeamAgentsAreOpen")}</Empty>}
          </Section>
        )}
        {member && !paused && (
          <Section
            title={t("memberApp.yourAgents")}
            action={
              <button
                type="button"
                onClick={makeSolo}
                aria-label={t("memberApp.newSoloAgent")}
                className="grid size-6 place-items-center rounded-md text-muted-foreground outline-none transition-[background-color,color,scale] duration-150 hover:bg-accent hover:text-foreground active:scale-[0.94]"
              >
                <Plus size={14} />
              </button>
            }
          >
            {groups.mine.map((a) => (
              <AgentRow key={a.id} agent={a} on={openAgent?.id === a.id} onOpen={() => go({ kind: "agent", id: a.id, lane: "private" })} />
            ))}
            {loaded && !groups.mine.length && (
              <button type="button" onClick={makeSolo} className="w-full rounded-lg px-2.5 py-2 text-left text-body text-muted-foreground outline-none hover:bg-accent hover:text-foreground">
                {t("memberApp.makeAnAgentOnlyYou")}
              </button>
            )}
          </Section>
        )}
        {!paused && <Section title={t("memberApp.rooms")}>
          {rooms.map((r) => (
            <Row key={r.id} on={place?.kind === "room" && place.id === r.id} onClick={() => go({ kind: "room", id: r.id })}>
              <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-muted text-small font-semibold text-muted-foreground" aria-hidden>
                #
              </span>
              <span className="min-w-0 flex-1 truncate">{r.name}</span>
              {r.role === "viewer" && <span className="text-caption text-muted-foreground">{t("memberApp.readOnly")}</span>}
            </Row>
          ))}
          {loaded && !rooms.length && <Empty>{t("memberApp.youAreNotInAny")}</Empty>}
        </Section>}
      </div>
      {pages.length > 0 && !paused && (
        <div className="flex flex-col gap-0.5 border-t border-border/60 px-2.5 py-2">
          {pages.map((p) => {
            const Icon = PAGE_ICON[p.page];
            return (
              <Row key={p.page} on={place?.kind === "page" && place.page === p.page} onClick={() => go({ kind: "page", page: p.page })} small>
                <Icon size={15} className="shrink-0 text-muted-foreground" />
                <span className="flex-1 truncate">{p.label}</span>
                {p.page === "usage" && usage?.stopped && <span className="size-1.5 rounded-full bg-destructive" aria-label={t("memberApp.yourLimitIsReached")} />}
              </Row>
            );
          })}
        </div>
      )}
    </nav>
  );

  return (
    <TooltipProvider delayDuration={400}>
      <div className="relative flex h-full min-w-0 flex-col overflow-hidden bg-sidebar">
        <div className="titlebar-drag relative flex h-11 shrink-0 items-center bg-sidebar">
          <div className={cn("shrink-0", isElectron ? "w-[78px]" : "w-4")} />
          <Dialog open={navigationOpen} onOpenChange={setNavigationOpen}>
            <DialogTrigger asChild>
              <Button ref={navigationTrigger} variant="ghost" size="icon" className="mr-1 size-11 md:hidden" aria-label={t("memberApp.openNavigation")}>
                <Menu size={20} />
              </Button>
            </DialogTrigger>
            <DialogContent
              showCloseButton={false}
              aria-describedby={undefined}
              className="left-0 top-0 flex h-dvh w-[min(320px,88vw)] max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none rounded-r-2xl border-y-0 border-l-0 p-0"
              onCloseAutoFocus={(event) => {
                // Creation owns focus next. On desktop the mobile trigger
                // is hidden, so return to a visible navigation control.
                if (making) event.preventDefault();
                else if (window.matchMedia("(min-width: 768px)").matches) {
                  event.preventDefault();
                  focusNavigation();
                }
              }}
            >
              <div className="flex h-14 shrink-0 items-center justify-between gap-2 px-3">
                <DialogTitle className="text-ui">{t("memberApp.agentsAndRooms")}</DialogTitle>
                <DialogClose asChild>
                  <Button variant="ghost" size="icon" className="size-11" aria-label={t("memberApp.closeNavigation")}><X size={20} /></Button>
                </DialogClose>
              </div>
              {navigation}
            </DialogContent>
          </Dialog>
          {switcher.available ? (
            <WorkspaceSwitcher
              onSettings={member ? () => go({ kind: "page", page: "settings" }) : undefined}
              onLeave={member ? () => void leave() : undefined}
            />
          ) : workspace ? (
            // outside the desktop app there is no list to switch in: the
            // workspace you are in, and what you are there
            <span className="flex h-7 min-w-0 items-center gap-1.5 pl-1 text-body font-medium text-foreground">
              <WorkspaceMark mark={workspace.workspace.mark} size={18} />
              <span className="truncate">{workspace.workspace.name}</span>
              <span className="ml-1 shrink-0 rounded-full bg-muted px-2 py-px text-small font-normal text-muted-foreground">
                {workspace.you.role === "admin" ? t("memberApp.admin") : t("memberApp.member")}
              </span>
            </span>
          ) : null}
          {!connected && loaded && !paused && (
            <span className="ml-3 flex min-w-0 items-center gap-1.5 text-small text-muted-foreground" role="status">
              <span className="size-1.5 shrink-0 rounded-full bg-warning" aria-hidden />
              <span className="truncate">{t("memberApp.reaching", { owner })}</span>
            </span>
          )}
        </div>
        <div className="relative flex min-h-0 min-w-0 flex-1">
          <div ref={desktopNavigation} className="hidden w-[264px] shrink-0 md:flex">
            {navigation}
          </div>
          <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden rounded-tl-xl border-l border-t bg-background">
            {paused && workspace ? (
              <PausedPanel workspace={workspace} line={paused} onLeave={() => void leave()} leaving={leaving} />
            ) : !place || !workspace && member ? null : place.kind === "agent" && openAgent ? (
              <AgentView
                key={openAgent.id}
                agent={openAgent}
                lane={place.lane}
                me={me}
                owner={owner}
                usage={usage}
                onLane={(lane) => go({ kind: "agent", id: openAgent.id, lane })}
                onDelete={() => void deleteAgent(openAgent)}
                onSent={refreshUsage}
                nameOf={nameOf}
                known={known}
              />
            ) : place.kind === "room" ? (
              <RoomView key={place.id} roomId={place.id} me={me} usage={usage} nameOf={nameOf} known={known} />
            ) : place.kind === "page" && workspace ? (
              place.page === "usage" ? (
                <UsagePage usage={usage} workspace={workspace} />
              ) : place.page === "about" ? (
                <AboutYouPage workspace={workspace} />
              ) : place.page === "members" ? (
                <MembersAdminPage />
              ) : (
                <WorkspacePage workspace={workspace} entry={entry} onLeave={() => void leave()} leaving={leaving} />
              )
            ) : (
              <main className="flex flex-1 items-center justify-center text-body text-muted-foreground">{t("memberApp.nothingIsOpenToYou")}</main>
            )}
          </div>
        </div>
        {workspace && (
          <NewSoloAgentDialog
            open={making}
            onOpenChange={setMaking}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              focusNavigation();
            }}
            workspace={workspace}
            onMade={(agent) => {
              setAgents((list) => [...list.filter((a) => a.id !== agent.id), agent]);
              go({ kind: "agent", id: agent.id, lane: "private" });
              void refresh();
            }}
          />
        )}
        <WorkspaceDialogs />
      </div>
    </TooltipProvider>
  );
}

/** Said plainly, in place of everything, while the owner is not on
 * Bloks Team: why, and that nothing is lost. */
function PausedPanel({ workspace, line, onLeave, leaving }: { workspace: MemberWorkspace; line: string; onLeave: () => void; leaving: boolean }) {
  return (
    <main className="flex flex-1 items-center justify-center p-8">
      <div role="status" className="flex max-w-[420px] flex-col items-center gap-4 text-center">
        <WorkspaceMark mark={workspace.workspace.mark} size={48} />
        <div className="flex flex-col gap-1.5">
          <h1 className="text-balance text-title font-semibold text-foreground">{t("memberApp.pausedTitle", { workspace: workspace.workspace.name })}</h1>
          <p className="text-pretty text-ui leading-relaxed text-muted-foreground">{line}</p>
          <p className="text-pretty text-body leading-relaxed text-muted-foreground">
            {t("memberApp.nothingOfYoursIsGone")}
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={onLeave} disabled={leaving} className="text-muted-foreground">
          {t("memberApp.leaveWorkspace", { workspace: workspace.workspace.name })}
        </Button>
      </div>
    </main>
  );
}

function Section({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="mt-3 flex flex-col gap-0.5">
      <div className="flex h-7 items-center justify-between px-2.5">
        <h2 className="text-small font-medium text-muted-foreground">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="px-2.5 py-1.5 text-pretty text-body text-muted-foreground">{children}</p>;
}

function Row({ on, onClick, children, small }: { on: boolean; onClick: () => void; children: React.ReactNode; small?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={on ? "page" : undefined}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-ui text-foreground outline-none transition-[background-color,scale] duration-150 ease-out active:scale-[0.985] focus-visible:bg-accent",
        small ? "h-8 text-body" : "py-1.5",
        on ? "bg-accent font-medium" : "hover:bg-accent/60",
      )}
    >
      {children}
    </button>
  );
}

function AgentRow({ agent, on, onOpen }: { agent: MemberAgent; on: boolean; onOpen: () => void }) {
  return (
    <Row on={on} onClick={onOpen}>
      <span className="relative shrink-0">
        <AgentFace agent={agent} size={28} />
        {agent.busy && <span className="absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full bg-brand-ink ring-2 ring-sidebar" aria-label={t("memberApp.working")} />}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate leading-tight">{agent.name}</span>
        {agent.solo ? (
          <OnlyYou className="mt-0.5 self-start" />
        ) : (
          <span className="truncate text-small font-normal leading-tight text-muted-foreground">{agent.team ? agent.title || t("memberApp.teamAgent") : t("memberApp.throughARoomPrivately")}</span>
        )}
      </span>
    </Row>
  );
}
