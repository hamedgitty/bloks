// The pages of a member's app beside its conversations: their own usage
// and limit, their "about you" notes and what agents remember of them,
// their own apps and keys, the workspace (what they are there, and
// leaving it), Members for an admin, making a solo agent, and the welcome
// they see once.
//
// Everything of the owner's (engines and keys, automations, the rest of
// the settings) is not drawn at all. The workspace page says, once and
// plainly, whose those are.
import { useEffect, useState } from "react";
import { Bot, Check, Cloud, Globe, Loader2, Lock, LogOut, MessagesSquare, Puzzle, Trash2, UserRound, Wifi } from "@/components/icons";
import { useWebDoor } from "@/lib/webDoor";
import { confirm } from "@/components/ui/confirm";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { SettingRow, SettingsGroup, SettingsPageHeader } from "@/components/SettingsLayout";
import { WorkspaceMark } from "@/components/WorkspaceMark";
import { MembersPage } from "@/components/members/MembersPage";
import { cn } from "@/lib/cn";
import { memberApi, soloRoom, type MemberAgent, type MemberMemory, type MemberNote, type MemberUsage, type MemberWorkspace } from "@/lib/memberMode";
import { firstName } from "@/lib/names";
import { act, reachLine, useWorkspaces } from "@/lib/workspaces";
import { MarkPicker } from "@/components/MarkPicker";
import { toast } from "@/components/ui/toast";
import type { WorkspaceInfo } from "@/types/bridge";
import { WebSignOutRow } from "@/components/web/WebSignOut";
import { formatDate, formatNumber, t, tr } from "@/lib/i18n";

function Page({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-0 min-w-0 flex-1 overflow-y-auto bg-background">
      <div className="mx-auto w-full max-w-[680px] px-8 pb-16 pt-10">{children}</div>
    </main>
  );
}

const money = (usd: number) => formatNumber(usd, { style: "currency", currency: "USD" });

function Meter({ used, of, label }: { used: number; of: number; label: string }) {
  const share = of > 0 ? Math.min(1, used / of) : 1;
  return (
    <div className="mt-2.5 h-1.5 w-full overflow-hidden rounded-full bg-muted" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={of} aria-valuenow={used}>
      <div
        className={cn("h-full origin-left rounded-full", share >= 1 ? "bg-destructive" : share >= 0.8 ? "bg-warning" : "bg-brand-ink")}
        style={{ transform: `scaleX(${share})`, width: "100%" }}
      />
    </div>
  );
}

export function UsagePage({ usage, workspace }: { usage: MemberUsage | null; workspace: MemberWorkspace }) {
  const owner = workspace.owner.name;
  const month = formatDate(new Date(), { month: "long" });
  return (
    <Page>
      <SettingsPageHeader
        title={t("memberPages.yourUsage")}
        description={t("memberPages.usage.description", { workspace: workspace.workspace.name, owner })}
      />
      {!usage ? (
        <Skeleton className="h-40 rounded-2xl" />
      ) : (
        <>
          {usage.stopped && (
            <div role="alert" className="mb-6 rounded-2xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-pretty text-ui text-foreground">
              {usage.stopped}
            </div>
          )}
          <SettingsGroup title={month}>
            <SettingRow
              label={t("memberPages.spentOnKeys")}
              description={usage.limits.monthlyUsd === null ? t("memberPages.noMonthlyLimitIsSet") : t("memberPages.usage.limit", { limit: money(usage.limits.monthlyUsd) })}
              control={<span className="text-lead tabular-nums text-foreground">{money(usage.spentUsd)}</span>}
            >
              {usage.limits.monthlyUsd !== null && <Meter used={usage.spentUsd} of={usage.limits.monthlyUsd} label={t("memberPages.spentOfYourMonthlyLimit")} />}
            </SettingRow>
            <SettingRow
              label="Bloks AI"
              description={usage.limits.aiPercent === null ? t("memberPages.noShareIsSetFor") : t("memberPages.usage.share", { share: usage.limits.aiPercent })}
              control={<span className="text-lead tabular-nums text-foreground">{usage.aiPercent === null ? t("memberPages.none") : t("memberPages.usage.percent", { percent: usage.aiPercent })}</span>}
            >
              {usage.limits.aiPercent !== null && usage.aiPercent !== null && <Meter used={usage.aiPercent} of={usage.limits.aiPercent} label={t("memberPages.bloksAiUsedOfYour")} />}
            </SettingRow>
            <SettingRow
              label={t("memberPages.soloAgents")}
              description={usage.limits.maxSolo === 0 ? t("memberPages.soloAgentsAreNotOn") : t("memberPages.usage.maxSolo", { max: usage.limits.maxSolo })}
              control={<span className="text-lead tabular-nums text-foreground">{t("memberPages.usage.soloOf", { made: usage.soloAgents, max: usage.limits.maxSolo })}</span>}
            />
          </SettingsGroup>
          <p className="px-1 text-pretty text-small text-muted-foreground">
            {t("memberPages.yourUsageCountsWhatYou")}
          </p>
        </>
      )}
    </Page>
  );
}

export function AboutYouPage({ workspace }: { workspace: MemberWorkspace }) {
  const [notes, setNotes] = useState<MemberNote[] | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const load = () => memberApi.notes().then((r) => setNotes(r.notes)).catch((e: Error) => setError(e.message));
  useEffect(() => {
    void load();
  }, []);
  const run = async (work: () => Promise<unknown>) => {
    setError(null);
    try {
      await work();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const kept = notes?.filter((n) => n.state === "kept") ?? [];
  const suggested = notes?.filter((n) => n.state === "suggested") ?? [];
  return (
    <Page>
      <SettingsPageHeader
        title={t("memberPages.aboutYou")}
        description={t("memberPages.about.description", { workspace: workspace.workspace.name })}
      />
      <form
        className="mb-8 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const text = draft.trim();
          if (text) void run(async () => {
            await memberApi.addNote(text);
            setDraft("");
          });
        }}
      >
        <Input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={t("memberPages.addSomethingTheyShouldKnow")} aria-label={t("memberPages.aNoteAboutYou")} className="flex-1" />
        <Button type="submit" disabled={!draft.trim()}>{t("common.add")}</Button>
      </form>
      {error && <p role="alert" className="-mt-5 mb-6 px-1 text-small text-destructive">{error}</p>}
      {!notes ? (
        <Skeleton className="h-28 rounded-2xl" />
      ) : (
        <>
          {suggested.length > 0 && (
            <SettingsGroup title={t("memberPages.suggestedByAgents")}>
              {suggested.map((n) => (
                <SettingRow
                  key={n.id}
                  label={<span className="font-normal">{n.text}</span>}
                  description={t("memberPages.about.from", { name: n.by.name })}
                  control={
                    <div className="flex gap-1">
                      <Button size="sm" variant="secondary" onClick={() => void run(() => memberApi.keepNote(n.id))}>
                        <Check size={13} />
                        {t("common.keep")}
                      </Button>
                      <Button size="icon-sm" variant="ghost" aria-label={t("memberPages.notThisOne")} onClick={() => void run(() => memberApi.dropNote(n.id))}>
                        <Trash2 size={14} />
                      </Button>
                    </div>
                  }
                />
              ))}
            </SettingsGroup>
          )}
          {kept.length ? (
            <SettingsGroup title={t("memberPages.kept")}>
              {kept.map((n) => (
                <SettingRow
                  key={n.id}
                  label={<span className="font-normal">{n.text}</span>}
                  control={
                    <Button size="icon-sm" variant="ghost" aria-label={t("memberPages.about.remove", { text: n.text })} onClick={() => void run(() => memberApi.dropNote(n.id))}>
                      <Trash2 size={14} />
                    </Button>
                  }
                />
              ))}
            </SettingsGroup>
          ) : (
            <div className="rounded-2xl border border-dashed px-6 py-6 text-center text-pretty text-ui text-muted-foreground">
              {t("memberPages.nothingKeptYetAddA")}
            </div>
          )}
        </>
      )}
      <Remembered />
    </Page>
  );
}

/** What each agent remembers of this member, from their private
 * conversation with it: kept for them alone, read here, and forgotten
 * with one press. */
function Remembered() {
  const [memories, setMemories] = useState<MemberMemory[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => memberApi.memories().then((r) => setMemories(r.memories)).catch((e: Error) => setError(e.message));
  useEffect(() => {
    void load();
  }, []);
  const forget = async (m: MemberMemory) => {
    const agent = m.agent ?? t("memberMemory.formerAgent");
    const yes = await confirm({
      title: t("memberMemory.forgetTitle", { agent }),
      body: t("memberMemory.forgetBody", { agent }),
      confirmLabel: t("memberMemory.forget"),
      destructive: true,
    });
    if (!yes) return;
    try {
      await memberApi.forgetMemory(m.botId);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <SettingsGroup title={t("memberMemory.title")} footnote={t("memberMemory.footnote")} className="mt-9">
      {error && <p role="alert" className="px-5 py-3 text-small text-destructive">{error}</p>}
      {!memories ? (
        <div className="px-5 py-4"><Skeleton className="h-10 rounded-xl" /></div>
      ) : memories.length ? (
        memories.map((m) => (
          <SettingRow
            key={m.botId}
            label={m.agent ?? t("memberMemory.formerAgent")}
            description={t("memberMemory.files", { count: m.files.length })}
            control={
              <Button size="sm" variant="ghost" onClick={() => void forget(m)}>
                <Trash2 size={13} />
                {t("memberMemory.forget")}
              </Button>
            }
          >
            <div className="mt-3 max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded-xl bg-muted/50 px-3 py-2.5 text-small leading-relaxed text-muted-foreground">
              {m.files.map((f) => f.text.replace(/^# Memory\s*/, "").trim()).filter(Boolean).join("\n\n")}
            </div>
          </SettingRow>
        ))
      ) : (
        <p className="px-5 py-4 text-pretty text-body text-muted-foreground">{t("memberMemory.none")}</p>
      )}
    </SettingsGroup>
  );
}

export function MembersAdminPage({ onCount }: { onCount?: (count: number) => void }) {
  return (
    <Page>
      <MembersPage onCount={onCount} />
    </Page>
  );
}

export function WorkspacePage({
  workspace,
  entry,
  onLeave,
  leaving,
}: {
  workspace: MemberWorkspace;
  entry: WorkspaceInfo | null;
  onLeave: () => void;
  leaving: boolean;
}) {
  const ws = workspace.workspace;
  const owner = workspace.owner.name;
  const reach = entry ? reachLine(entry) : null;
  // opened at the server's own address, through its web door
  const door = useWebDoor()?.signedIn ?? false;
  const all = useWorkspaces();
  const taken = all.available ? all.workspaces.filter((w) => w.id !== entry?.id && w.mark).map((w) => w.mark!) : [];
  const [marking, setMarking] = useState(false);
  // yours for it when you chose one (the app's list keeps it, and nobody
  // else sees it), else the one its owner chose
  const shown = entry?.mark ?? ws.mark;
  const choose = async (work: Promise<{ error?: string } | undefined> | undefined) => {
    setMarking(true);
    const error = await act(work);
    setMarking(false);
    if (error) toast.error(error);
  };
  return (
    <Page>
      <div className="mb-8 flex items-center gap-4">
        <WorkspaceMark mark={shown} logo={entry?.logo ?? null} size={48} />
        <div className="min-w-0">
          <h1 className="truncate text-heading font-semibold text-foreground">{ws.name}</h1>
          <p className="text-body text-muted-foreground">
            {workspace.you.role === "admin" ? t("memberPages.workspace.adminOf", { owner }) : t("memberPages.workspace.memberOf", { owner })}
          </p>
        </div>
      </div>
      <SettingsGroup>
        <SettingRow
          label={t("memberPages.howItIsReached")}
          description={reach ?? (door ? t("webDoor.reachedAt", { host: window.location.host }) : t("memberPages.workspace.throughCloud", { owner }))}
          control={reach ? <Wifi size={16} className="text-muted-foreground" /> : door ? <Globe size={16} className="text-muted-foreground" /> : <Cloud size={16} className="text-muted-foreground" />}
        />
        <SettingRow label={t("memberPages.yourPrivateConversations")} description={workspace.privacy.line} control={<Lock size={15} className="text-muted-foreground" />} />
        {/* in a browser at the server's own address: who it is signed in as */}
        <WebSignOutRow />
        {entry && window.bloks?.workspaceUpdate && (
          <SettingRow label={t("memberPages.yourMarkForIt")} description={t("memberPages.workspace.markOnlyYou", { owner })}>
            <MarkPicker
              className="mt-4"
              value={shown}
              taken={taken}
              defaultMark={entry.markDefault ?? ws.mark}
              disabled={marking}
              onChange={(mark) => void choose(window.bloks?.workspaceUpdate?.(entry.id, { mark }))}
              onShuffle={() => void choose(window.bloks?.workspaceReroll?.(entry.id))}
            />
          </SettingRow>
        )}
        <SettingRow
          label={t("memberPages.everythingElse")}
          description={workspace.you.role === "admin" ? t("memberPages.workspace.elseAdmin", { owner }) : t("memberPages.workspace.else", { owner })}
        />
      </SettingsGroup>
      <SettingsGroup title={t("memberPages.leave")}>
        <SettingRow
          label={t("memberPages.workspace.leaveTitle", { workspace: ws.name })}
          description={t("memberPages.workspace.leaveDescription", { owner })}
          control={
            <Button variant="destructive" onClick={onLeave} disabled={leaving || !entry}>
              {leaving ? <Loader2 size={14} className="animate-spin" /> : <LogOut size={14} />}
              {t("memberPages.leave")}
            </Button>
          }
        />
      </SettingsGroup>
    </Page>
  );
}

export function NewSoloAgentDialog({
  open,
  onOpenChange,
  workspace,
  onMade,
  onCloseAutoFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspace: MemberWorkspace;
  onMade: (agent: MemberAgent) => void;
  onCloseAutoFocus?: React.ComponentProps<typeof DialogContent>["onCloseAutoFocus"];
}) {
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [engine, setEngine] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setName("");
    setTitle("");
    setError(null);
    setEngine(workspace.engines[0]?.id ?? "");
  }, [open, workspace.engines]);
  const room = soloRoom(workspace.solo, workspace.engines.length, workspace.owner.name);
  const make = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const { agent } = await memberApi.newAgent({ name: name.trim(), ...(title.trim() ? { title: title.trim() } : {}), ...(engine ? { engine: { instanceId: engine } } : {}) });
      onMade(agent);
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[calc(100%-2rem)] max-w-[420px]" onCloseAutoFocus={onCloseAutoFocus}>
        <DialogTitle>{t("memberPages.newSoloAgent")}</DialogTitle>
        {!room.ok ? (
          <>
            <DialogDescription className="text-pretty">{room.why}</DialogDescription>
            <div className="mt-5 flex justify-end">
              <Button variant="secondary" onClick={() => onOpenChange(false)}>{t("common.close")}</Button>
            </div>
          </>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void make();
            }}
          >
            <DialogDescription className="text-pretty">
              {t("memberPages.solo.description", { owner: workspace.owner.name })} {t("memberPages.solo.made", { made: workspace.solo.count, max: workspace.solo.max })}
            </DialogDescription>
            <div className="mt-5 flex flex-col gap-3.5">
              <label className="flex flex-col gap-1.5">
                <span className="text-body font-medium text-foreground">{t("common.name")}</span>
                <Input autoFocus value={name} maxLength={40} onChange={(e) => setName(e.target.value)} placeholder={t("memberPages.ivy")} />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-body font-medium text-foreground">{tr("memberPages.solo.itsJob", { optional: <span className="font-normal text-muted-foreground">{t("memberPages.optional")}</span> })}</span>
                <Input value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} placeholder={t("memberPages.researchAssistant")} />
              </label>
              {workspace.engines.length > 1 && (
                <label className="flex flex-col gap-1.5">
                  <span className="text-body font-medium text-foreground">{t("common.engine")}</span>
                  <select
                    value={engine}
                    onChange={(e) => setEngine(e.target.value)}
                    className="h-8 rounded-lg border bg-background px-2.5 text-body text-foreground outline-none focus:border-ring/60"
                  >
                    {workspace.engines.map((e) => (
                      <option key={e.id} value={e.id}>{e.name}</option>
                    ))}
                  </select>
                </label>
              )}
            </div>
            {error && <p role="alert" className="mt-3 text-small text-destructive">{error}</p>}
            <div className="mt-5 flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button>
              <Button type="submit" disabled={!name.trim() || busy}>
                {busy && <Loader2 size={14} className="animate-spin" />}
                {t("memberPages.solo.make")}
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * What a member sees once, the first time they open a workspace they
 * joined, on whichever device that is (GitHub 431): who they are signed
 * in as, whose computer this runs on, what is shared and what is theirs,
 * and the things worth doing first. Everything it says is what the
 * server holds to, not a promise of its own.
 */
export function WelcomePanel({
  workspace,
  onDone,
  onAbout,
  onConnections,
  onAgent,
}: {
  workspace: MemberWorkspace;
  onDone: () => void;
  onAbout: () => void;
  onConnections: () => void;
  onAgent: (() => void) | null;
}) {
  const owner = workspace.owner.name;
  const name = workspace.workspace.name;
  const first = firstName(workspace.you.name) || workspace.you.name;
  const points = [
    { icon: MessagesSquare, title: t("memberWelcome.sharedTitle"), text: t("memberWelcome.sharedText") },
    { icon: Lock, title: t("memberWelcome.privateTitle"), text: `${workspace.privacy.line} ${t("memberWelcome.privateMemory")}` },
    { icon: Puzzle, title: t("memberWelcome.ownTitle"), text: t("memberWelcome.ownText") },
  ];
  return (
    <main className="min-h-0 min-w-0 flex-1 overflow-y-auto bg-background">
      <div className="mx-auto flex w-full max-w-[560px] flex-col px-4 pb-16 pt-12 sm:px-8">
        <WorkspaceMark mark={workspace.workspace.mark} size={44} />
        <h1 className="mt-5 text-balance text-heading font-semibold text-foreground">{t("memberWelcome.title", { workspace: name, name: first })}</h1>
        <p className="mt-1.5 text-pretty text-ui leading-relaxed text-muted-foreground">
          {t("memberWelcome.signedIn", { name: workspace.you.name, owner, workspace: name })}
        </p>
        <ul className="mt-7 flex flex-col gap-4">
          {points.map(({ icon: Icon, title, text }) => (
            <li key={title} className="flex gap-3">
              <span aria-hidden className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
                <Icon size={16} />
              </span>
              <div className="min-w-0">
                <h2 className="text-ui font-medium text-foreground">{title}</h2>
                <p className="mt-0.5 text-pretty text-body leading-relaxed text-muted-foreground">{text}</p>
              </div>
            </li>
          ))}
        </ul>
        <p className="mt-6 text-pretty text-small leading-relaxed text-muted-foreground">{t("memberWelcome.host", { owner })}</p>
        <div className="mt-7 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          <Button onClick={onDone} autoFocus>{t("memberWelcome.start")}</Button>
          <Button variant="secondary" onClick={onAbout}>
            <UserRound size={14} />
            {t("memberWelcome.about")}
          </Button>
          <Button variant="secondary" onClick={onConnections}>
            <Puzzle size={14} />
            {t("memberWelcome.connect")}
          </Button>
          {onAgent && (
            <Button variant="secondary" onClick={onAgent}>
              <Bot size={14} />
              {t("memberWelcome.agent")}
            </Button>
          )}
        </div>
      </div>
    </main>
  );
}
