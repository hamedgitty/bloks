// The pages of a member's app beside its conversations: their own usage
// and limit, their "about you" notes, the workspace (what they are there,
// and leaving it), Members for an admin, and making a solo agent.
//
// Everything of the owner's (engines and keys, automations, the rest of
// the settings) is not drawn at all. The workspace page says, once and
// plainly, whose those are.
import { useEffect, useState } from "react";
import { Check, Loader2, Lock, LogOut, Trash2, Wifi, Cloud } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { SettingRow, SettingsGroup, SettingsPageHeader } from "@/components/SettingsLayout";
import { WorkspaceMark } from "@/components/WorkspaceMark";
import { MembersPage } from "@/components/members/MembersPage";
import { cn } from "@/lib/cn";
import { memberApi, soloRoom, type MemberAgent, type MemberNote, type MemberUsage, type MemberWorkspace } from "@/lib/memberMode";
import { act, reachLine, useWorkspaces } from "@/lib/workspaces";
import { MarkPicker } from "@/components/MarkPicker";
import { toast } from "@/components/ui/toast";
import type { WorkspaceInfo } from "@/types/bridge";

function Page({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-0 min-w-0 flex-1 overflow-y-auto bg-background">
      <div className="mx-auto w-full max-w-[680px] px-8 pb-16 pt-10">{children}</div>
    </main>
  );
}

const money = (usd: number) => `$${usd.toFixed(2)}`;

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
  const month = new Date().toLocaleDateString(undefined, { month: "long" });
  return (
    <Page>
      <SettingsPageHeader
        title="Your usage"
        description={`What you have used in ${workspace.workspace.name} this month, against the limits ${owner} or an admin set for you. It runs on ${owner}'s engines and keys.`}
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
              label="Spent on keys"
              description={usage.limits.monthlyUsd === null ? "No monthly limit is set for you." : `Your limit is ${money(usage.limits.monthlyUsd)} a month.`}
              control={<span className="text-lead tabular-nums text-foreground">{money(usage.spentUsd)}</span>}
            >
              {usage.limits.monthlyUsd !== null && <Meter used={usage.spentUsd} of={usage.limits.monthlyUsd} label="Spent of your monthly limit" />}
            </SettingRow>
            <SettingRow
              label="Bloks AI"
              description={usage.limits.aiPercent === null ? "No share is set for you." : `Your share is ${usage.limits.aiPercent}% of the workspace's monthly allowance.`}
              control={<span className="text-lead tabular-nums text-foreground">{usage.aiPercent === null ? "None" : `${usage.aiPercent}%`}</span>}
            >
              {usage.limits.aiPercent !== null && usage.aiPercent !== null && <Meter used={usage.aiPercent} of={usage.limits.aiPercent} label="Bloks AI used of your share" />}
            </SettingRow>
            <SettingRow
              label="Solo agents"
              description={usage.limits.maxSolo === 0 ? "Solo agents are not on for you here." : `You may make up to ${usage.limits.maxSolo}.`}
              control={<span className="text-lead tabular-nums text-foreground">{usage.soloAgents} of {usage.limits.maxSolo}</span>}
            />
          </SettingsGroup>
          <p className="px-1 text-pretty text-small text-muted-foreground">
            Your usage counts what you start: your solo agents, and the work you ask team agents for. When you reach a limit, your own requests stop with a message; nobody else is affected.
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
        title="About you"
        description={`What the agents in ${workspace.workspace.name} know about you. These notes are yours: other people here never see them, and agents only read them in your own conversations.`}
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
        <Input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Add something they should know, like how you like answers" aria-label="A note about you" className="flex-1" />
        <Button type="submit" disabled={!draft.trim()}>Add</Button>
      </form>
      {error && <p role="alert" className="-mt-5 mb-6 px-1 text-small text-destructive">{error}</p>}
      {!notes ? (
        <Skeleton className="h-28 rounded-2xl" />
      ) : (
        <>
          {suggested.length > 0 && (
            <SettingsGroup title="Suggested by agents">
              {suggested.map((n) => (
                <SettingRow
                  key={n.id}
                  label={<span className="font-normal">{n.text}</span>}
                  description={`From ${n.by.name}`}
                  control={
                    <div className="flex gap-1">
                      <Button size="sm" variant="secondary" onClick={() => void run(() => memberApi.keepNote(n.id))}>
                        <Check size={13} />
                        Keep
                      </Button>
                      <Button size="icon-sm" variant="ghost" aria-label="Not this one" onClick={() => void run(() => memberApi.dropNote(n.id))}>
                        <Trash2 size={14} />
                      </Button>
                    </div>
                  }
                />
              ))}
            </SettingsGroup>
          )}
          {kept.length ? (
            <SettingsGroup title="Kept">
              {kept.map((n) => (
                <SettingRow
                  key={n.id}
                  label={<span className="font-normal">{n.text}</span>}
                  control={
                    <Button size="icon-sm" variant="ghost" aria-label={`Remove "${n.text}"`} onClick={() => void run(() => memberApi.dropNote(n.id))}>
                      <Trash2 size={14} />
                    </Button>
                  }
                />
              ))}
            </SettingsGroup>
          ) : (
            <div className="rounded-2xl border border-dashed px-6 py-6 text-center text-pretty text-ui text-muted-foreground">
              Nothing kept yet. Add a line above, or keep one an agent suggests.
            </div>
          )}
        </>
      )}
    </Page>
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
            {workspace.you.role === "admin" ? "You are an Admin here" : "You are a Member here"} · {owner}'s workspace
          </p>
        </div>
      </div>
      <SettingsGroup>
        <SettingRow
          label="How it is reached"
          description={reach ?? `Through Bloks Cloud, from anywhere, while ${owner}'s computer is on.`}
          control={reach ? <Wifi size={16} className="text-muted-foreground" /> : <Cloud size={16} className="text-muted-foreground" />}
        />
        <SettingRow label="Your private conversations" description={workspace.privacy.line} control={<Lock size={15} className="text-muted-foreground" />} />
        {entry && window.bloks?.workspaceUpdate && (
          <SettingRow label="Your mark for it" description={`Only you see it. Everyone else sees the one ${owner} chose.`}>
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
          label="Everything else"
          description={`Engines and keys, automations and the rest of the settings are ${owner}'s, on ${owner}'s computer.${workspace.you.role === "admin" ? " As an Admin you can invite and manage people in Members." : ""}`}
        />
      </SettingsGroup>
      <SettingsGroup title="Leave">
        <SettingRow
          label={`Leave ${ws.name}`}
          description={`You lose every room and agent here at once, and your solo agents and private conversations are deleted from ${owner}'s computer. ${owner} is told.`}
          control={
            <Button variant="destructive" onClick={onLeave} disabled={leaving || !entry}>
              {leaving ? <Loader2 size={14} className="animate-spin" /> : <LogOut size={14} />}
              Leave
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
        <DialogTitle>New solo agent</DialogTitle>
        {!room.ok ? (
          <>
            <DialogDescription className="text-pretty">{room.why}</DialogDescription>
            <div className="mt-5 flex justify-end">
              <Button variant="secondary" onClick={() => onOpenChange(false)}>Close</Button>
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
              An agent of your own. Only you see it and talk with it; it runs on {workspace.owner.name}'s computer and is kept there.
              {` ${workspace.solo.count} of ${workspace.solo.max} made.`}
            </DialogDescription>
            <div className="mt-5 flex flex-col gap-3.5">
              <label className="flex flex-col gap-1.5">
                <span className="text-body font-medium text-foreground">Name</span>
                <Input autoFocus value={name} maxLength={40} onChange={(e) => setName(e.target.value)} placeholder="Ivy" />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-body font-medium text-foreground">Its job <span className="font-normal text-muted-foreground">(optional)</span></span>
                <Input value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} placeholder="Research assistant" />
              </label>
              {workspace.engines.length > 1 && (
                <label className="flex flex-col gap-1.5">
                  <span className="text-body font-medium text-foreground">Engine</span>
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
              <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button type="submit" disabled={!name.trim() || busy}>
                {busy && <Loader2 size={14} className="animate-spin" />}
                Make agent
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
