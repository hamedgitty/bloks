// The workspace's own pages in Settings: everything that belongs to the
// workspace you are in rather than to you (its name and mark, its
// members, whether it is online, when it may interrupt you).
//
// They are pages of Settings like any other (state.settingsPage
// "workspace:<page>"), in a group of the list titled with the workspace's
// name and mark, so moving between them and your own pages is one list,
// one search, one Back. Settings draws the shell (AppSettingsPanel.tsx);
// this file draws the pages. Members is the members work's page
// (MembersPage.tsx). The workspace's Engines and keys and Usage were only
// ever links to pages Settings already has, so their old addresses lead
// there now (src/lib/settingsPages.ts).
import { useCallback, useEffect, useState } from "react";
import { ArrowRight, BellOff, Loader2, Trash2, Upload } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import { Switch } from "@/components/ui/switch";
import { confirm } from "@/components/ui/confirm";
import { toast } from "@/components/ui/toast";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useStore } from "@/state/store";
import { cn } from "@/lib/cn";
import { thisComputer } from "@/lib/thisComputer";
import { MUTE_CHOICES, act, currentWorkspace, muteLabel, useWorkspaces } from "@/lib/workspaces";
import type { WorkspaceInfo, WorkspaceNotify } from "@/types/bridge";
import { SettingRow, SettingsEmpty, SettingsGroup } from "./SettingsLayout";
import { ConnectionError, HealthLine, type Health } from "./ConnectionKit";
import { MembersPage } from "./MembersPage";
import { MembersPage as Members } from "./members/MembersPage";
import { ensureYourName } from "./YourNameDialog";
import { WorkspaceMark } from "./WorkspaceMark";
import { MarkPicker } from "./MarkPicker";
import { MoveHome } from "./hosting/MoveHome";
import { membersApi } from "@/lib/members";
import { formatNumber, t, type MessageKey } from "@/lib/i18n";

export const WORKSPACE_PAGES: ReadonlyArray<{ id: "general" | "members" | "online" | "notifications"; label: MessageKey }> = [
  { id: "general", label: "workspaceSettings.page.general" },
  { id: "members", label: "workspaceSettings.page.members" },
  { id: "online", label: "workspaceSettings.page.online" },
  { id: "notifications", label: "workspaceSettings.notifications" },
];

export type WorkspacePage = (typeof WORKSPACE_PAGES)[number]["id"];

/** Whether a Settings page id is one of these. */
export const isWorkspacePage = (page: string | null | undefined) => Boolean(page?.startsWith("workspace:"));

const pageOf = (settingsPage: string): WorkspacePage => {
  const id = settingsPage.slice("workspace:".length);
  return (WORKSPACE_PAGES.find((p) => p.id === id)?.id ?? "general") as WorkspacePage;
};

/** Says a workspace action's error where it happened, or nothing. */
async function run(work: Promise<{ error?: string } | undefined> | undefined) {
  const error = await act(work);
  if (error) toast.error(error);
  return !error;
}

// ── General ────────────────────────────────────────────────────────────

function NameRow({ ws }: { ws: WorkspaceInfo }) {
  const [name, setName] = useState(ws.name);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setName(ws.name);
  }, [ws.name]);
  const save = async () => {
    const clean = name.replace(/\s+/g, " ").trim();
    if (clean === ws.name) return setName(ws.name);
    const said = await act(window.bloks?.workspaceUpdate?.(ws.id, { name: clean }));
    setError(said);
    if (said) setName(ws.name);
  };
  return (
    <SettingRow
      label={t("common.name")}
      htmlFor="workspace-name"
      description={t("workspaceSettings.howItIsCalledIn")}
      control={
        <Input
          id="workspace-name"
          value={name}
          maxLength={40}
          onChange={(e) => {
            setName(e.target.value);
            setError(null);
          }}
          onBlur={() => void save()}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
            if (e.key === "Escape" && name !== ws.name) {
              e.stopPropagation();
              setName(ws.name);
            }
          }}
          className="w-[240px]"
        />
      }
    >
      {error && <div className="mt-2 text-small text-destructive">{error}</div>}
    </SettingRow>
  );
}

function KindRows({ ws, all }: { ws: WorkspaceInfo; all: WorkspaceInfo[] }) {
  const businessElsewhere = all.some((w) => w.kind === "business" && w.id !== ws.id);
  return (
    <>
      <SettingRow
        label={t("workspaceSettings.kind")}
        description={
          ws.kind === "personal"
            ? t("workspaceSettings.personalIsTheWorkspaceBloks")
            : ws.kind === "business"
              ? t("workspaceSettings.businessWearsTheSameMark")
              : ws.kind === "hosted"
                ? t("workspaceSettings.yourWorkspaceOnAMachine")
                : ws.kind === "remote"
                  ? t("workspaceSettings.yourWorkspaceOnAServer", { host: ws.host || t("workspaceSettings.aServerOfYours") })
                  : t("workspaceSettings.aWorkspaceWithAName")
        }
        control={
          ws.kind === "personal" || ws.kind === "joined" || ws.kind === "hosted" || ws.kind === "remote" || (ws.kind === "custom" && businessElsewhere) ? (
            // one option is not a choice, so it is said rather than offered
            <span className="text-body text-muted-foreground">
              {ws.kind === "personal"
                ? t("workspaceSettings.personal")
                : ws.kind === "joined"
                  ? t("workspaceSettings.joined")
                  : ws.kind === "hosted"
                    ? t("workspaceSettings.hosted")
                    : ws.kind === "remote"
                      ? t("workspaceSettings.server")
                      : t("workspaceSettings.itsOwnName")}
            </span>
          ) : (
            <Segmented<"business" | "custom">
              aria-label={t("workspaceSettings.kind")}
              value={ws.kind}
              onChange={(kind) => void run(window.bloks?.workspaceUpdate?.(ws.id, { kind }))}
              options={[
                ...(businessElsewhere ? [] : [{ value: "business" as const, label: t("workspaceSettings.business") }]),
                { value: "custom", label: t("workspaceSettings.itsOwnName") },
              ]}
            />
          )
        }
      />
      {ws.kind !== "joined" && ws.kind !== "hosted" && ws.kind !== "remote" && (
        <SettingRow
          label={t("workspaceSettings.whoUsesIt")}
          description={
            ws.team
              ? t("workspaceSettings.youAndThePeopleYou")
              : ws.kind === "personal"
                ? t("workspaceSettings.onlyYouForATeam")
                : t("workspaceSettings.onlyYou")
          }
          control={
            ws.kind === "personal" && !ws.team ? (
              // Personal is yours alone, so there is nothing to choose
              <span className="text-body text-muted-foreground">{t("workspaceSettings.justYou")}</span>
            ) : (
            <Segmented<"solo" | "team">
              aria-label={t("workspaceSettings.whoUsesIt")}
              value={ws.team ? "team" : "solo"}
              onChange={async (next) => {
                // people are invited from here on, and they see your name
                if (next === "team" && !(await ensureYourName({ why: t("workspaceSettings.nameWhy", { name: ws.name }) }))) return;
                void run(window.bloks?.workspaceUpdate?.(ws.id, { team: next === "team" }));
              }}
              options={[
                { value: "solo", label: t("workspaceSettings.justMe") },
                { value: "team", label: t("workspaceSettings.team") },
              ]}
            />
            )
          }
        />
      )}
    </>
  );
}

/** What the mark row says under its name: who sees the mark, and where
 * else it can be changed. */
export function markWords(ws: Pick<WorkspaceInfo, "kind" | "logo">): string {
  if (ws.logo) return t("workspaceSettings.markWords.logo");
  if (ws.kind === "joined") return t("workspaceSettings.markWords.joined");
  if (ws.kind === "hosted" || ws.kind === "remote") return t("workspaceSettings.markWords.hosted");
  return t("workspaceSettings.markWords.own");
}

function MarkRow({ ws, all }: { ws: WorkspaceInfo; all: WorkspaceInfo[] }) {
  const [busy, setBusy] = useState<"mark" | "logo" | null>(null);
  const taken = all.filter((w) => w.id !== ws.id && w.mark).map((w) => w.mark!);
  const doing = async (what: "mark" | "logo", work: Promise<{ error?: string } | undefined> | undefined) => {
    setBusy(what);
    await run(work);
    setBusy(null);
  };
  return (
    <SettingRow
      label={t("workspaceSettings.mark")}
      description={markWords(ws)}
      control={
        <div className="flex items-center gap-3">
          <span key={ws.logo ?? (ws.mark ? `${ws.mark.color}${ws.mark.pattern}` : "none")} className="flex animate-pop-in">
            <WorkspaceMark mark={ws.mark} logo={ws.logo} size={44} label={t("workspaceSettings.markOf", { name: ws.name })} />
          </span>
          <div className="flex flex-col gap-1.5">
            {ws.logo ? (
              <Button variant="ghost" size="sm" className="gap-1.5" disabled={busy !== null} onClick={() => void doing("logo", window.bloks?.workspaceLogoClear?.(ws.id))}>
                <Trash2 size={13} />
                {t("workspaceSettings.removeLogo")}
              </Button>
            ) : (
              <Button variant="ghost" size="sm" className="gap-1.5" disabled={busy !== null} onClick={() => void doing("logo", window.bloks?.workspaceLogoPick?.(ws.id))}>
                {busy === "logo" ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />}
                {t("workspaceSettings.uploadLogo")}
              </Button>
            )}
          </div>
        </div>
      }
    >
      {/* a logo stands in for the mark, so there is nothing to choose
          until it is removed */}
      {!ws.logo && (
        <MarkPicker
          className="mt-4"
          value={ws.mark}
          taken={taken}
          defaultMark={ws.markDefault ?? null}
          disabled={busy !== null}
          onChange={(mark) => void doing("mark", window.bloks?.workspaceUpdate?.(ws.id, { mark }))}
          onShuffle={() => void doing("mark", window.bloks?.workspaceReroll?.(ws.id))}
        />
      )}
    </SettingRow>
  );
}

/** "Its 3 agents, 2 rooms…": what a delete takes, counted from what this
 * window has loaded, which is this workspace. */
function deleteWords(ws: WorkspaceInfo, agents: number, rooms: number) {
  const counted = { agents: t("workspaceSettings.delete.agents", { count: agents }), rooms: t("workspaceSettings.delete.rooms", { count: rooms }) };
  const body = ws.dataDir
    ? t("workspaceSettings.delete.body", { ...counted, folder: ws.dataDir })
    : t("workspaceSettings.delete.bodyNoFolder", counted);
  return `${body}\n\n${t("workspaceSettings.delete.untouched")}`;
}

function DeleteRow({ ws }: { ws: WorkspaceInfo }) {
  const { state } = useStore();
  const [busy, setBusy] = useState(false);
  if (ws.kind === "personal") {
    return (
      <SettingRow
        label={t("workspaceSettings.deleteWorkspace")}
        description={t("workspaceSettings.personalCannotBeDeletedIt")}
      />
    );
  }
  const agents = state.bots.filter((b) => !b.hidden).length;
  const rooms = state.bloks.length;
  // A server of yours is only forgotten here: its workspace stays on it,
  // running, for every other device paired with it.
  if (ws.kind === "remote") {
    return (
      <SettingRow
        label={t("workspaceSettings.removeServer")}
        description={t("workspaceSettings.removeServerDescription", { name: ws.name })}
        control={
          <Button
            variant="destructive"
            disabled={busy}
            className="gap-1.5"
            onClick={async () => {
              const yes = await confirm({
                title: t("remoteSection.removeTitle", { name: ws.name }),
                body: t("remoteSection.removeBody", { computer: thisComputer() }),
                confirmLabel: t("remoteSection.remove"),
                destructive: true,
              });
              if (!yes) return;
              setBusy(true);
              if (!(await run(window.bloks?.workspaceDelete?.(ws.id)))) setBusy(false);
            }}
          >
            {busy ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
            {t("remoteSection.remove")}
          </Button>
        }
      />
    );
  }
  return (
    <SettingRow
      label={t("workspaceSettings.deleteWorkspace")}
      description={t("workspaceSettings.delete.description", { name: ws.name })}
      control={
        <Button
          variant="destructive"
          disabled={busy}
          className="gap-1.5"
          onClick={async () => {
            const yes = await confirm({
              title: t("workspaceSettings.delete.title", { name: ws.name }),
              body: deleteWords(ws, agents, rooms),
              confirmLabel: t("workspaceSettings.deleteWorkspace"),
              destructive: true,
            });
            if (!yes) return;
            setBusy(true);
            // on success the window is already on its way to Personal
            if (!(await run(window.bloks?.workspaceDelete?.(ws.id)))) setBusy(false);
          }}
        >
          {busy ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
          {t("common.delete")}
        </Button>
      }
    />
  );
}

function GeneralPage({ ws, all, go }: { ws: WorkspaceInfo; all: WorkspaceInfo[]; go: (page: WorkspacePage) => void }) {
  const muted = muteLabel(ws.mute);
  return (
    <>
      <SettingsGroup title={t("workspaceSettings.workspace")}>
        <NameRow ws={ws} />
        <KindRows ws={ws} all={all} />
        <MarkRow ws={ws} all={all} />
      </SettingsGroup>
      <SettingsGroup title={t("workspaceSettings.notifications")}>
        <SettingRow
          label={t(LEVELS.find((l) => l.value === ws.notify)?.label ?? "workspaceSettings.allActivity")}
          description={muted ? t("workspaceSettings.mutedFor", { when: muted }) : t("workspaceSettings.notMuted")}
          control={
            <Button variant="secondary" size="sm" className="gap-1.5" onClick={() => go("notifications")}>
              {t("common.change")}
              <ArrowRight size={13} />
            </Button>
          }
        />
      </SettingsGroup>
      {/* your hosted workspace, brought home to this Mac when you choose */}
      {ws.kind === "hosted" && <div className="mb-9"><MoveHome only={ws.id} /></div>}
      {/* what cannot be undone sits apart, at the end, in its own colour */}
      <SettingsGroup title={t("workspaceSettings.dangerZone")} tone={ws.kind === "personal" ? "default" : "danger"}>
        <DeleteRow ws={ws} />
      </SettingsGroup>
    </>
  );
}

// ── Notifications ──────────────────────────────────────────────────────

// Keys, read where the list is drawn.
const LEVELS: Array<{ value: WorkspaceNotify; label: MessageKey; says: MessageKey }> = [
  { value: "all", label: "workspaceSettings.allActivity", says: "workspaceSettings.level.allSays" },
  { value: "needs-me", label: "workspaceSettings.level.needsMe", says: "workspaceSettings.level.needsMeSays" },
  { value: "nothing", label: "workspaceSettings.level.nothing", says: "workspaceSettings.level.nothingSays" },
];

function NotificationsPage({ ws }: { ws: WorkspaceInfo }) {
  const muted = muteLabel(ws.mute);
  return (
    <>
      <SettingsGroup title={t("workspaceSettings.tellMeAbout")}>
        <div role="radiogroup" aria-label={t("workspaceSettings.tellMeAbout")} className="flex flex-col divide-y">
          {LEVELS.map((level) => {
            const on = ws.notify === level.value;
            return (
              <button
                key={level.value}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => !on && void run(window.bloks?.workspaceUpdate?.(ws.id, { notify: level.value }))}
                className="flex items-center gap-4 px-5 py-4 text-left outline-none transition-colors duration-150 hover:bg-accent/50 focus-visible:bg-accent/60"
              >
                <span
                  aria-hidden
                  className={cn(
                    "flex size-[18px] shrink-0 items-center justify-center rounded-full border transition-colors duration-150",
                    on ? "border-brand-ink bg-brand-ink" : "border-input",
                  )}
                >
                  {on && <span className="size-1.5 rounded-full bg-brand-foreground" />}
                </span>
                <span className="flex min-w-0 flex-col">
                  <span className="text-ui font-medium text-foreground">{t(level.label)}</span>
                  <span className="text-pretty text-body text-muted-foreground">{t(level.says)}</span>
                </span>
              </button>
            );
          })}
        </div>
      </SettingsGroup>
      <SettingsGroup title={t("workspaceSettings.mute")}>
        <SettingRow
          label={muted ? t("workspaceSettings.muted") : t("workspaceSettings.notMutedLabel")}
          description={
            muted
              ? t("workspaceSettings.mutedMeanwhile", { when: muted, name: ws.name })
              : t("workspaceSettings.quietFor", { name: ws.name })
          }
          control={
            <div className="flex items-center gap-2">
              {muted && (
                <Button variant="outline" size="sm" onClick={() => void run(window.bloks?.workspaceMute?.(ws.id, "off"))}>
                  {t("workspaceSettings.turnBackOn")}
                </Button>
              )}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant={muted ? "ghost" : "outline"} size="sm" className="gap-1.5">
                    <BellOff size={13} />
                    {muted ? t("common.change") : t("workspaceSettings.mute")}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-[220px]">
                  {MUTE_CHOICES.map((choice) => (
                    <DropdownMenuItem key={choice.id} onSelect={() => void run(window.bloks?.workspaceMute?.(ws.id, choice.id))}>
                      {choice.label}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          }
        />
      </SettingsGroup>
    </>
  );
}

// ── Reachable online ───────────────────────────────────────────────────

interface RelayStatus {
  enabled: boolean;
  connected: boolean;
  delivering?: boolean;
  spaceId: string | null;
  problem?: string | null;
  pairing?: boolean;
}
interface RelayPlan {
  plan: string | null;
  spaces: { online: number; limit: number | null } | null;
  licence: boolean;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { headers: { "content-type": "application/json" }, ...init });
  const body = await res.json().catch(() => ({}));
  // the relay's own words, a plan limit above all: it says what to do
  if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  return body as T;
}

function ReachableOnline({ ws }: { ws: WorkspaceInfo }) {
  const { dispatch } = useStore();
  const [status, setStatus] = useState<RelayStatus | null>(null);
  const [plan, setPlan] = useState<RelayPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsKey, setNeedsKey] = useState(false);
  const toPlan = () => dispatch({ type: "toggleAppSettings", open: true, page: "plan" });

  const load = useCallback(() => {
    call<RelayStatus>("/api/relay/status").then(setStatus).catch(() => setStatus({ enabled: false, connected: false, spaceId: null }));
    call<RelayPlan>("/api/relay/plan").then(setPlan).catch(() => setPlan(null));
  }, []);
  useEffect(() => {
    load();
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, [load]);

  const on = status?.enabled ?? false;
  const working = Boolean(status?.connected) && status?.delivering !== false;
  const health: { tone: Health; label: string } | null = !status
    ? null
    : !on
      ? { tone: "off", label: t("workspaceSettings.health.offline") }
      : working
        ? { tone: "on", label: t("workspaceSettings.online") }
        : status.pairing === false
          ? { tone: "issue", label: t("workspaceSettings.health.paused") }
          : { tone: "wait", label: t("workspaceSettings.health.connecting") };

  const flip = async (next: boolean) => {
    setError(null);
    setNeedsKey(false);
    if (next && !plan?.licence) {
      // no key on this computer yet: it goes in on Plan, the one place
      // the key lives, and activating there puts this workspace online
      setNeedsKey(true);
      return;
    }
    setBusy(true);
    try {
      if (next) await call("/api/relay/activate", { method: "POST", body: JSON.stringify({ again: true }) });
      else await call("/api/relay/space", { method: "DELETE" });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      load();
    }
  };

  const phonesOn = async () => {
    setBusy(true);
    setError(null);
    try {
      await call("/api/pair", { method: "PATCH", body: JSON.stringify({ enabled: true }) });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      load();
    }
  };

  const online = plan?.spaces;
  return (
    <>
      <SettingsGroup
        footnote={
          <>
            {t("workspaceSettings.onlineFootnote")}{" "}
            <button type="button" onClick={toPlan} className="rounded font-medium text-foreground underline-offset-2 hover:underline">
              {t("workspaceSettings.seeYourPlan")}
            </button>
          </>
        }
      >
        <SettingRow
          label={t("workspaceSettings.online")}
          description={t("workspaceSettings.onlineDescription", { name: ws.name })}
          control={
            <div className="flex items-center gap-3">
              {busy && <Loader2 size={14} className="animate-spin text-muted-foreground" />}
              <Switch aria-label={t("workspaceSettings.online")} checked={on} disabled={busy || status === null} onCheckedChange={(next) => void flip(next)} />
            </div>
          }
        >
          <ConnectionError>{error}</ConnectionError>
          {needsKey && (
            <div role="status" className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-brand-soft px-3.5 py-2.5">
              <span className="text-pretty text-body text-foreground">{t("workspaceSettings.needsKey", { name: ws.name })}</span>
              <Button size="sm" variant="brand" onClick={toPlan}>
                {t("workspaceSettings.openPlan")}
              </Button>
            </div>
          )}
        </SettingRow>
        <SettingRow label={t("workspaceSettings.status")} control={health ? <HealthLine tone={health.tone} label={health.label} /> : <Loader2 size={14} className="animate-spin text-muted-foreground" />}>
          {/* Phone access is the master switch, Cloud included: turning it
              off is how somebody cuts every phone loose at once, so a
              workspace can be online and still reach nobody */}
          {on && status?.pairing === false ? (
            <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
              <span className="text-pretty text-small text-muted-foreground">{t("workspaceSettings.phoneAccessOff", { name: ws.name })}</span>
              <Button size="sm" variant="secondary" disabled={busy} onClick={() => void phonesOn()}>
                {t("workspaceSettings.turnOnPhoneAccess")}
              </Button>
            </div>
          ) : (
            status?.problem && on && !working && <div className="mt-1 text-pretty text-small text-muted-foreground">{status.problem}</div>
          )}
        </SettingRow>
        {on && status?.spaceId && (
          <SettingRow
            label={t("common.address")}
            description={t("workspaceSettings.itsOwnSpaceAtBloks")}
            control={<span className="font-mono text-small text-muted-foreground">{status.spaceId}</span>}
          />
        )}
        {online && (
          <SettingRow
            label={t("workspaceSettings.workspacesOnline")}
            description={
              online.limit === null
                ? t("workspaceSettings.yourPlanKeepsEveryWorkspace")
                : t("workspaceSettings.limitOnline", { limit: online.limit })
            }
            control={
              <span className="text-body tabular-nums text-foreground">
                {online.limit === null ? formatNumber(online.online) : t("workspaceSettings.onlineOf", { online: online.online, limit: online.limit })}
              </span>
            }
          />
        )}
      </SettingsGroup>
    </>
  );
}

// ── a server opened in a browser ───────────────────────────────────────

/** How to run a second server beside the first. */
const SECOND_SERVER_GUIDE = "https://github.com/hamedgitty/bloks/blob/main/docs/SELF_HOSTING.md#more-than-one-workspace";

/** The workspace page a browser has. A server is one workspace, and a
 * browser shows the one it opened: there is no list of others here to
 * add to, so the page says what this one is and how another is had. */
function ServerWorkspacePage() {
  const { state } = useStore();
  const [name, setName] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    membersApi
      .list()
      .then((data) => live && setName(data.workspace.name))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  const computer = state.config?.deployment?.computer || t("workspaceSettings.server.thisServer");
  return (
    <SettingsGroup>
      <SettingRow
        label={t("workspaceSettings.server.thisWorkspace")}
        description={t("workspaceSettings.server.runsOn", { computer })}
        control={name ? <span className="text-ui font-medium text-foreground">{name}</span> : undefined}
      />
      <SettingRow
        label={t("workspaceSettings.server.another")}
        description={
          <>
            <span className="block">{t("workspaceSettings.server.anotherBody", { computer })}</span>
            <span className="mt-1 block">
              {t("workspaceSettings.server.anotherApp")}{" "}
              <a href={SECOND_SERVER_GUIDE} target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-foreground">
                {t("workspaceSettings.server.guide")}
              </a>
            </span>
          </>
        }
      />
    </SettingsGroup>
  );
}

// ── the page ───────────────────────────────────────────────────────────

/** One of the workspace's pages, for the workspace this window shows. */
export function WorkspacePageBody({ page }: { page: string }) {
  const { dispatch } = useStore();
  const s = useWorkspaces();
  const ws = currentWorkspace(s);
  const id = pageOf(page);
  const go = (next: WorkspacePage) => dispatch({ type: "toggleAppSettings", open: true, page: `workspace:${next}` });
  // in a browser, Members is the one page of these there is: the people of
  // the workspace this page shows, managed as in the app, with the name and
  // mark the server says (it has no workspace list to name it from)
  if (!s.available && !window.bloks && id === "members") return <Members onOpenRoom={() => dispatch({ type: "toggleAppSettings", open: false })} />;
  // and General says which workspace this server is, and how to have another
  if (!s.available && !window.bloks && id === "general") return <ServerWorkspacePage />;
  if (!s.available || !ws) {
    return (
      <SettingsGroup>
        <SettingsEmpty title={t("workspaceSettings.workspacesLiveInTheBloks")} body={t("workspaceSettings.openBloksOnYourComputer")} />
      </SettingsGroup>
    );
  }
  if (id === "general") return <GeneralPage ws={ws} all={s.workspaces} go={go} />;
  if (id === "members") return <MembersPage workspace={ws} />;
  if (id === "online") return <ReachableOnline ws={ws} />;
  return <NotificationsPage ws={ws} />;
}
