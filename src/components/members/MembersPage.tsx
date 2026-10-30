// Members: who is in the workspace, who is asking, and how people join
// (designs: Main, Mac-Approve, Mac-Joined).
//
// The page is the owner's and the admins' place to manage people, and a
// member's place to see who is here and what they themselves may spend.
// Requests to join sit at the very top, above everything, because they
// are the one thing on this page somebody is waiting on. Everything else
// is a list that reads like one: a row per person, a row per invite.
//
// It keeps itself current from the server's "workspace." frames, so a
// request arriving, a person let in on another device or an invite used
// all show here without a reload.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Copy, MoreHorizontal, Plus, Search, UserPlus, Users } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { confirm } from "@/components/ui/confirm";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import {
  activeWords,
  expiresIn,
  initials,
  membersApi,
  serverIdOf,
  roleName,
  shortDate,
  tintOf,
  useWorkspaceFrames,
  type AgentAccessRow,
  type Invite,
  type Member,
  type MembersData,
} from "@/lib/members";
import { BlockBurst } from "./BlockBurst";
import { InviteSheet } from "./InviteSheet";
import { AgentAccessDialog, LimitsDialog, PasswordDialog } from "./MemberDialogs";
import { RequestCard } from "./RequestCard";
import { NeedsTeam, UpgradeButton, UpgradeLink } from "../TeamLock";
import { AlertTriangle } from "@/components/icons";
import { distinctNames } from "@/lib/names";
import { formatList, formatNumber, t, type MessageKey } from "@/lib/i18n";

const DEVICE_WORD: Record<NonNullable<Member["device"]>, MessageKey> = {
  iphone: "membersMembersPage.device.iphone",
  mac: "membersMembersPage.device.mac",
  pc: "membersMembersPage.device.pc",
  computer: "settingsPanel.computer",
  browser: "membersMembersPage.device.browser",
};
const dollars = (n: number, cents = true) =>
  formatNumber(n, { style: "currency", currency: "USD", minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: 2 });
/** How long a newcomer's row says "New". */
const NEW_FOR_MS = 60_000;

function Avatar({ id, name, size = 34 }: { id: string; name: string; size?: number }) {
  return (
    <span
      aria-hidden
      className="grid shrink-0 place-items-center rounded-full font-semibold text-white/90"
      style={{ width: size, height: size, background: tintOf(id), fontSize: Math.round(size * 0.38) }}
    >
      {initials(name)}
    </span>
  );
}

function Section({ title, aside, children }: { title: React.ReactNode; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2.5">
      <div className="flex min-h-8 items-center justify-between gap-4 px-0.5">
        <h2 className="text-body font-medium text-muted-foreground">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

function Card({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("flex flex-col divide-y overflow-hidden rounded-[14px] border bg-card", className)}>{children}</div>;
}

function useCopy() {
  const [copied, setCopied] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  return [
    copied,
    (key: string, text: string) =>
      void navigator.clipboard.writeText(text).then(() => {
        setCopied(key);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(null), 1600);
      }),
  ] as const;
}

export function MembersPage({
  onOpenRoom,
  workspace,
  onCount,
}: {
  onOpenRoom?: () => void;
  /** The workspace as the app lists it, when there is a list: its name and
   * mark are told to the server, which puts them on invites. */
  workspace?: { id: string; name: string; kind: string; mark: { color: string; pattern: string } | null };
  /** How many people are in it, the owner included, for the switcher. */
  onCount?: (count: number) => void;
} = {}) {
  const [data, setData] = useState<MembersData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [inviting, setInviting] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [limitsFor, setLimitsFor] = useState<Member | null>(null);
  const [agents, setAgents] = useState<AgentAccessRow[] | null>(null);
  const [accessFor, setAccessFor] = useState<AgentAccessRow | null>(null);
  const [newcomer, setNewcomer] = useState<{ id: string; at: number } | null>(null);
  const [copied, copy] = useCopy();

  const load = useCallback(() => {
    membersApi
      .list()
      .then((next) => {
        setData(next);
        setError(null);
        if (next.invites) membersApi.access().then((a) => setAgents(a.agents)).catch(() => {});
      })
      .catch((e: Error) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  // The app's name and mark for this workspace are the truth; the server
  // only borrows them for invites, so it is told when they differ. Only
  // when the server that answered is this workspace's: mid switch, the list
  // can already name the next workspace while the page still reads the last.
  useEffect(() => {
    if (!data || data.you.role !== "owner" || !workspace?.mark) return;
    const id = serverIdOf(workspace);
    if (data.workspace.id !== id) return;
    const same = data.workspace.name === workspace.name && data.workspace.mark.color === workspace.mark.color && data.workspace.mark.pattern === workspace.mark.pattern;
    if (same) return;
    void membersApi.setIdentity({ id, name: workspace.name, kind: workspace.kind, mark: workspace.mark }).then(load).catch(() => {});
  }, [data, workspace, load]);

  const people = data ? data.members.length + 1 : null;
  useEffect(() => {
    if (people !== null) onCount?.(people);
  }, [people, onCount]);

  useWorkspaceFrames(
    useCallback(
      (frame) => {
        if (frame.kind === "workspace.joined") {
          const person = frame.person as { id: string; name: string; role: "member" | "admin" };
          setNewcomer({ id: person.id, at: Date.now() });
          const first = person.name.split(" ")[0] || person.name;
          const admin = person.role === "admin";
          const said = frame.workspace
            ? t(admin ? "membersMembersPage.joined.admin" : "membersMembersPage.joined.member", { name: first, workspace: String(frame.workspace) })
            : t(admin ? "membersMembersPage.joined.adminUnnamed" : "membersMembersPage.joined.memberUnnamed", { name: first });
          toast.success(said, {
            id: `joined-${person.id}`,
            ...(onOpenRoom ? { action: { label: t("membersMembersPage.sayHello"), onClick: onOpenRoom } } : {}),
          });
        }
        load();
      },
      [load, onOpenRoom],
    ),
  );

  // the "New" mark and its burst last a minute, then the row is a row
  useEffect(() => {
    if (!newcomer) return;
    const timer = setTimeout(() => setNewcomer(null), NEW_FOR_MS);
    return () => clearTimeout(timer);
  }, [newcomer]);

  const manage = data ? data.you.role !== "member" : false;
  // people come in on Bloks Team only (server/plan-limits.ts); a server
  // from before that said nothing, and stays as it was
  const teamOn = data?.team !== false;
  const owner = data?.you.role === "owner";
  // Not on Bloks Team, and nobody else in yet: there is nothing here to
  // manage, so the page says what Team brings and the one way to it,
  // rather than offering a greyed button and settings for invites that
  // cannot be sent. Members already in are the paused case below.
  const locked = Boolean(data) && !teamOn && !data!.paused && (data!.members.length === 0);
  const members = useMemo(() => {
    const list = data?.members ?? [];
    const q = query.trim().toLowerCase();
    const shown = q ? list.filter((m) => m.name.toLowerCase().includes(q)) : list;
    // somebody just let in leads the list while they are new
    return newcomer ? [...shown].sort((a, b) => (a.id === newcomer.id ? -1 : b.id === newcomer.id ? 1 : 0)) : shown;
  }, [data?.members, query, newcomer]);

  if (!data) {
    return (
      <div className="flex flex-col gap-6" aria-busy="true">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-4 w-96" />
        <Skeleton className="h-44 rounded-[14px]" />
        <Skeleton className="h-28 rounded-[14px]" />
        {error && <p role="alert" className="text-body text-destructive">{error}</p>}
      </div>
    );
  }

  const ws = data.workspace;
  const joining = data.joining;
  const total = data.members.length + 1;
  const invites = data.invites ?? [];
  const requests = data.requests ?? [];
  const ownerMatches = !query.trim() || data.owner.name.toLowerCase().includes(query.trim().toLowerCase());

  const run = async (work: () => Promise<unknown>) => {
    try {
      await work();
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const remove = async (m: Member) => {
    const yes = await confirm({
      title: t("membersMembersPage.remove.title", { name: m.name, workspace: ws.name }),
      body: `${t("membersMembersPage.remove.body", { name: m.name })}\n\n${t("membersMembersPage.remove.again")}`,
      confirmLabel: t("membersMembersPage.remove.confirm"),
      destructive: true,
    });
    if (yes) await run(() => membersApi.remove(m.id));
  };

  const cancelInvite = async (inv: Invite) => {
    const yes = await confirm({
      title: inv.name ? t("membersMembersPage.cancelInvite.titleNamed", { name: inv.name }) : t("membersMembersPage.cancelInvite.title"),
      body: t("membersMembersPage.cancelInvite.body"),
      confirmLabel: t("membersMembersPage.cancelInvite.confirm"),
      cancelLabel: t("membersMembersPage.cancelInvite.keep"),
      destructive: true,
    });
    if (yes) await run(() => membersApi.cancel(inv.id));
  };

  const clearPassword = async () => {
    const yes = await confirm({
      title: t("membersMembersPage.clearPassword.title"),
      body: t("membersMembersPage.clearPassword.body"),
      confirmLabel: t("membersMembersPage.removePassword"),
      destructive: true,
    });
    if (yes) await run(() => membersApi.clearPassword());
  };

  return (
    <div className="flex flex-col gap-[26px]">
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between gap-6">
          {/* the same heading every Settings page has, with the one thing
              this page offers beside it */}
          <h1 className="text-balance text-heading font-semibold text-foreground">{t("common.members")}</h1>
          {manage && !locked && (
            <div className="flex shrink-0 flex-col items-end gap-1.5">
              <Button size="lg" onClick={() => setInviting(true)} disabled={!teamOn}>
                <Plus size={16} />
                {t("membersMembersPage.inviteSomeone")}
              </Button>
              {/* while paused, the banner below says it once, with the way */}
              {!teamOn && !data.paused && <NeedsTeam />}
            </div>
          )}
        </div>
        <p className="max-w-[560px] text-pretty text-body leading-relaxed text-muted-foreground">
          {t("membersMembersPage.intro", { workspace: ws.name })}{" "}
          {joining?.approveEach === false ? t("membersMembersPage.theRightCodeLetsPeople") : t("membersMembersPage.nobodyGetsInUntilYou")}
        </p>
      </div>

      {manage && locked && (
        <section aria-label={t("membersMembersPage.bloksTeam")} className="flex items-start gap-4 rounded-2xl border bg-card p-6 max-sm:flex-col max-sm:p-5">
          <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-brand-soft text-brand-ink" aria-hidden>
            <Users size={20} />
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <h2 className="text-pretty text-ui font-semibold text-foreground">{t("membersMembersPage.bringPeopleInto", { workspace: ws.name })}</h2>
            <p className="max-w-[52ch] text-pretty text-body leading-relaxed text-muted-foreground">
              {t("membersMembersPage.withBloksTeamInvitePeople")}
            </p>
          </div>
          <UpgradeButton />
        </section>
      )}

      {/* the owner is not on Bloks Team, and people are in: they are
          paused, said once and plainly, with the way back */}
      {data.paused && manage && (
        <div role="status" className="flex items-start gap-3 rounded-[14px] border border-warning/30 bg-warning/5 px-4 py-3.5">
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-warning" />
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="text-pretty text-ui font-medium text-foreground">{t("membersMembersPage.membersArePaused")}</span>
            <span className="text-pretty text-body leading-relaxed text-muted-foreground">
              {t("membersMembersPage.pausedBody", { workspace: ws.name })}
            </span>
          </div>
          <UpgradeLink className="mt-0.5 shrink-0 text-body" />
        </div>
      )}

      {requests.map((r) => (
        <RequestCard
          key={r.inviteId}
          request={r}
          onApprove={async () => {
            await membersApi.approve(r.inviteId);
            load();
          }}
          onDecline={async () => {
            await membersApi.decline(r.inviteId);
            load();
          }}
        />
      ))}

      <Section
        title={<span className="tabular-nums">{t("membersMembersPage.memberCount", { count: total })}</span>}
        aside={
          total > 4 && (
            <label className="flex h-8 w-60 items-center gap-2 rounded-lg border bg-background px-2.5 text-body text-muted-foreground transition-[border-color] duration-150 focus-within:border-ring/60 max-sm:w-40">
              <Search size={14} />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t("membersMembersPage.searchMembers")}
                aria-label={t("membersMembersPage.searchMembers")}
                className="min-w-0 flex-1 bg-transparent text-body text-foreground outline-none placeholder:text-muted-foreground"
              />
            </label>
          )
        }
      >
        <Card>
          {ownerMatches && (
            <div className="flex items-center gap-3.5 px-[18px] py-3.5">
              <Avatar id="owner" name={data.owner.name} />
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate text-ui font-medium text-foreground">
                  {data.owner.name}
                  {owner && <span className="font-normal text-muted-foreground"> {t("membersMembersPage.you")}</span>}
                </span>
                <span className="text-body text-muted-foreground">{t("membersMembersPage.ownerOf", { workspace: ws.name })}</span>
              </div>
              <span className="rounded-full bg-brand-soft px-2.5 py-1 text-small font-semibold text-brand-ink">{t("membersMembersPage.owner")}</span>
            </div>
          )}
          {members.map((m) => (
            <MemberRow
              key={m.id}
              member={m}
              you={m.id === data.you.personId}
              manage={manage}
              isNew={newcomer?.id === m.id}
              mark={ws.mark.color}
              onRole={(role) => void run(() => membersApi.setRole(m.id, role))}
              onLimits={() => setLimitsFor(m)}
              onRemove={() => void remove(m)}
            />
          ))}
          {query && !members.length && !ownerMatches && (
            <p className="px-[18px] py-4 text-body text-muted-foreground">{t("membersMembersPage.nobodyHereIsCalledThat")}</p>
          )}
        </Card>
        {!manage && <p className="px-0.5 text-pretty text-small text-muted-foreground">{data.privacy.line}</p>}
      </Section>

      {manage && joining && !locked && (
        <Section title={t("membersMembersPage.joining")}>
          <Card>
            <div className="flex items-center gap-4 px-[18px] py-4">
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-ui font-medium text-foreground">{t("membersMembersPage.joinPassword")}</span>
                <span className="text-pretty text-body leading-relaxed text-muted-foreground">
                  {t("membersMembersPage.askedForAfterTheInvite")}
                </span>
              </div>
              {joining.password && <span className="shrink-0 text-body text-muted-foreground">{t("membersMembersPage.setOn", { date: shortDate(joining.password.setAt) })}</span>}
              {owner &&
                (joining.password ? (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="outline" size="sm">{t("common.change")}</Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onSelect={() => setPasswordOpen(true)}>{t("membersMembersPage.changePassword")}</DropdownMenuItem>
                      <DropdownMenuItem variant="destructive" onSelect={() => void clearPassword()}>
                        {t("membersMembersPage.removePassword")}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                ) : (
                  <Button variant="outline" size="sm" onClick={() => setPasswordOpen(true)}>
                    {t("membersMembersPage.set")}
                  </Button>
                ))}
            </div>
            <label className="flex items-center gap-4 px-[18px] py-4">
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-ui font-medium text-foreground">{t("membersMembersPage.approveEachPerson")}</span>
                <span className="text-pretty text-body text-muted-foreground">
                  {joining.approveEach ? t("membersMembersPage.youCheckFourWordsWith") : t("membersMembersPage.theRightCodeAndPassword")}
                </span>
              </div>
              <Switch
                checked={joining.approveEach}
                disabled={!owner}
                onCheckedChange={(on) => void run(() => membersApi.setJoining({ approveEach: on }))}
                aria-label={t("membersMembersPage.approveEachPerson")}
              />
            </label>
            <label className="flex items-center gap-4 px-[18px] py-4">
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-ui font-medium text-foreground">{t("membersMembersPage.ownerAndAdminsCanRead")}</span>
                <span className="text-pretty text-body text-muted-foreground">
                  {t("membersMembersPage.offWhatAMemberSays")}
                </span>
              </div>
              <Switch
                checked={joining.privateReadable}
                disabled={!owner}
                onCheckedChange={(on) => void run(() => membersApi.setJoining({ privateReadable: on }))}
                aria-label={t("membersMembersPage.ownerAndAdminsCanRead")}
              />
            </label>
          </Card>
        </Section>
      )}

      {manage && agents && data.members.length > 0 && agents.some((a) => !a.solo) && (
        <Section title={t("membersMembersPage.teamAgents")}>
          <Card>
            {agents
              .filter((a) => !a.solo)
              .map((a) => (
                <div key={a.id} className="flex items-center gap-3.5 px-[18px] py-3">
                  <span className="flex-1 truncate text-ui text-foreground">{a.name}</span>
                  <span className="shrink-0 text-body text-muted-foreground">{accessWords(a, data.members)}</span>
                  <Button variant="ghost" size="sm" onClick={() => setAccessFor(a)} aria-label={t("membersMembersPage.whoCanUse", { agent: a.name })}>
                    {t("common.change")}
                  </Button>
                </div>
              ))}
          </Card>
        </Section>
      )}

      {manage && !locked && (
        <Section
          title={t("membersMembersPage.invitations")}
          aside={<span className="text-body tabular-nums text-muted-foreground">{invites.length ? t("membersMembersPage.waiting", { count: invites.length }) : t("membersMembersPage.noneWaiting")}</span>}
        >
          {invites.length ? (
            <Card>
              {invites.map((inv) => (
                <div key={inv.id} className="flex items-center gap-3.5 px-[18px] py-3">
                  <span className="grid size-[34px] shrink-0 place-items-center rounded-full border border-dashed text-muted-foreground" aria-hidden>
                    <UserPlus size={16} />
                  </span>
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="truncate text-ui font-medium text-foreground">{inv.name ?? t("membersMembersPage.anyoneWithTheCode")}</span>
                    <span className="text-body text-muted-foreground">
                      {inv.online
                        ? t("membersMembersPage.inviteLine", { role: roleName(inv.role), expires: expiresIn(inv.expiresAt) })
                        : t("membersMembersPage.inviteLineLocal", { role: roleName(inv.role), expires: expiresIn(inv.expiresAt) })}
                    </span>
                  </div>
                  <span className="shrink-0 select-all font-mono text-ui font-semibold tracking-[0.06em] text-foreground tabular-nums max-sm:hidden">{inv.code}</span>
                  <Button variant="ghost" size="sm" onClick={() => copy(inv.id, inv.link)} aria-label={inv.name ? t("membersMembersPage.copyLinkFor", { name: inv.name }) : t("membersMembersPage.copyLinkForThis")}>
                    {copied === inv.id ? <Check size={14} className="text-success" /> : <Copy size={14} />}
                    <span aria-live="polite">{copied === inv.id ? t("common.copied") : t("common.copy")}</span>
                  </Button>
                  <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={() => void cancelInvite(inv)}>
                    {t("common.cancel")}
                  </Button>
                </div>
              ))}
            </Card>
          ) : (
            <div className="flex flex-col items-center gap-3 rounded-[14px] border border-dashed px-6 py-[22px] text-center">
              <p className="text-pretty text-ui leading-relaxed text-muted-foreground">
                {t("membersMembersPage.eachInviteWorksOnceAnd")}
              </p>
              {teamOn ? (
                <Button variant="secondary" size="sm" onClick={() => setInviting(true)}>
                  {t("membersMembersPage.inviteSomeone")}
                </Button>
              ) : (
                <NeedsTeam />
              )}
            </div>
          )}
          {!data.online.available && <p className="px-0.5 text-pretty text-small text-muted-foreground">{data.online.why}</p>}
        </Section>
      )}

      {manage && (
        <InviteSheet
          open={inviting}
          onOpenChange={setInviting}
          workspace={ws}
          passwordSet={Boolean(joining?.password)}
          approveEach={joining?.approveEach !== false}
          onChanged={load}
        />
      )}
      <PasswordDialog open={passwordOpen} onOpenChange={setPasswordOpen} changing={Boolean(joining?.password)} onSaved={load} />
      <LimitsDialog member={limitsFor} engines={data.engines ?? []} onOpenChange={(o) => !o && setLimitsFor(null)} onSaved={load} />
      <AgentAccessDialog agent={accessFor} members={data.members} owner={owner} onOpenChange={(o) => !o && setAccessFor(null)} onSaved={load} />
    </div>
  );
}

function accessWords(agent: AgentAccessRow, members: Member[]): string {
  const a = agent.access;
  if (!a || a.mode === "everyone") return t("membersMembersPage.access.everyone");
  // first names, told apart where two share one (src/lib/names.ts)
  const called = distinctNames(members);
  const names = a.people.map((id) => called.get(id)).filter(Boolean) as string[];
  const list =
    names.length <= 2
      ? formatList(names)
      : t("membersMembersPage.access.andMore", { names: formatList(names.slice(0, 2), { type: "unit", style: "short" }), count: names.length - 2 });
  if (a.mode === "only") return names.length ? t("membersMembersPage.access.onlyYouAnd", { list }) : t("membersMembersPage.access.onlyYou");
  return names.length ? t("membersMembersPage.access.except", { list }) : t("membersMembersPage.access.everyone");
}

function MemberRow({
  member: m,
  you,
  manage,
  isNew,
  mark,
  onRole,
  onLimits,
  onRemove,
}: {
  member: Member;
  you: boolean;
  manage: boolean;
  isNew: boolean;
  mark: string;
  onRole: (role: "member" | "admin") => void;
  onLimits: () => void;
  onRemove: () => void;
}) {
  const line = [
    isNew ? t("membersMembersPage.joinedJustNow") : t("membersMembersPage.joinedOn", { date: shortDate(m.joinedAt) }),
    activeWords(m.lastActive),
    // a kind this page does not know yet (a newer workspace's) is a computer
    m.device ? t(DEVICE_WORD[m.device] ?? DEVICE_WORD.computer) : null,
  ].filter(Boolean);
  const spend = m.spend && m.limits;
  const usage = spend
    ? [
        m.soloAgents ? t("membersMembersPage.soloAgents", { count: m.soloAgents }) : null,
        m.limits!.monthlyUsd !== null
          ? t("membersMembersPage.spentOfCap", { spent: dollars(m.spend!.usd), cap: dollars(m.limits!.monthlyUsd, false) })
          : m.spend!.usd > 0
            ? t("membersMembersPage.spentThisMonth", { spent: dollars(m.spend!.usd) })
            : null,
        m.limits!.aiPercent !== null && m.spend!.aiPercent !== null ? t("membersMembersPage.aiOfShare", { used: m.spend!.aiPercent, share: m.limits!.aiPercent }) : null,
      ].filter(Boolean)
    : [];
  const atLimit = Boolean(spend && m.limits!.monthlyUsd !== null && m.spend!.usd >= m.limits!.monthlyUsd);
  return (
    <div
      className={cn(
        "relative flex items-center gap-3.5 px-[18px] py-3.5 transition-[background-color,box-shadow] duration-500",
        isNew && "bg-[color-mix(in_srgb,var(--mark)_10%,transparent)] shadow-[inset_3px_0_0_var(--mark)]",
      )}
      style={{ ["--mark" as string]: mark }}
    >
      <span className="relative">
        <Avatar id={m.id} name={m.name} />
        {isNew && <BlockBurst color={mark} spread={44} count={12} />}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-1.5 text-ui font-medium text-foreground">
          <span className="truncate">{m.name}</span>
          {you && <span className="font-normal text-muted-foreground">{t("membersMembersPage.you")}</span>}
          {isNew && (
            <span className="animate-pop-in rounded-full px-2 py-0.5 text-caption font-semibold" style={{ background: `color-mix(in srgb, ${mark} 18%, transparent)`, color: mark }}>
              {t("common.new")}
            </span>
          )}
        </span>
        <span className="truncate text-body text-muted-foreground">{line.join(" · ")}</span>
        {usage.length > 0 && (
          <span className={cn("truncate text-small tabular-nums", atLimit ? "text-destructive" : "text-muted-foreground")}>
            {(atLimit ? [...usage, t("membersMembersPage.atLimit")] : usage).join(" · ")}
          </span>
        )}
      </div>
      {manage ? (
        <>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="text-foreground/80" aria-label={t("membersMembersPage.roleFor", { name: m.name, role: roleName(m.role) })}>
                {roleName(m.role)}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuRadioGroup value={m.role} onValueChange={(v) => onRole(v as "member" | "admin")}>
                <DropdownMenuRadioItem value="member">{t("membersMembersPage.member")}</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="admin">{t("membersMembersPage.admin")}</DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label={t("membersMembersPage.moreFor", { name: m.name })}>
                <MoreHorizontal size={16} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={onLimits}>{t("membersMembersPage.limitsAndEngines")}</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onRole(m.role === "admin" ? "member" : "admin")}>
                {m.role === "admin" ? t("membersMembersPage.makeAMember") : t("membersMembersPage.makeAnAdmin")}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={onRemove}>
                {t("membersMembersPage.removeFromWorkspace")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      ) : (
        <span className="shrink-0 px-2.5 text-body text-muted-foreground">{roleName(m.role)}</span>
      )}
    </div>
  );
}
