// Watchers (server/watchers.ts): a folder, a page, a feed or a check, and
// what an agent should do when it changes.
//
// A check runs a command unattended, so one an agent filed shows the
// command and waits for an Approve here before it ever runs.
//
// The list on the left, the one you are looking at on the right: what is
// watched, what the agent is told, how often it looks, and the last few
// times it fired. A new one is a sentence and an address.
import { useCallback, useEffect, useState } from "react";
import Eye from "lucide-react/dist/esm/icons/eye.mjs";
import FlaskConical from "lucide-react/dist/esm/icons/flask-conical.mjs";
import Folder from "lucide-react/dist/esm/icons/folder.mjs";
import Globe from "lucide-react/dist/esm/icons/globe.mjs";
import Loader2 from "lucide-react/dist/esm/icons/loader-2.mjs";
import Rss from "lucide-react/dist/esm/icons/rss.mjs";
import ShieldCheck from "lucide-react/dist/esm/icons/shield-check.mjs";
import SquareTerminal from "lucide-react/dist/esm/icons/square-terminal.mjs";
import Trash2 from "lucide-react/dist/esm/icons/trash-2.mjs";
import { api, useStore } from "@/state/store";
import { AgentAvatar } from "./Avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/cn";

type Kind = "folder" | "page" | "feed" | "check";

interface WatcherRow {
  id: string;
  botId: string;
  name: string;
  kind: Kind;
  target: string;
  instruction: string;
  mentions?: string;
  mode: "act" | "rehearse";
  every: number;
  enabled: boolean;
  lastCheck?: number;
  lastError?: string;
  laneId?: string;
  /** the conversation its turns go to, by title; absent is a lane of its own */
  thread?: string;
  fires: Array<{ at: number; summary: string }>;
  approvedBy?: "person" | "mode";
}

const KIND: Record<Kind, { icon: typeof Folder; label: string; placeholder: string }> = {
  folder: { icon: Folder, label: "Folder", placeholder: "/Users/you/Invoices" },
  page: { icon: Globe, label: "Web page", placeholder: "https://example.com/pricing" },
  feed: { icon: Rss, label: "Feed", placeholder: "https://example.com/blog/rss.xml" },
  check: { icon: SquareTerminal, label: "Check", placeholder: "python3 scripts/supplier_replied.py" },
};

/** Whether a check may run now: approved here, or filed by an agent that
 * still runs commands without asking. Mirrors checkAllowed on the server. */
const mayRun = (w: WatcherRow, approvals?: string) =>
  w.kind !== "check" || w.approvedBy === "person" || (w.approvedBy === "mode" && (approvals === "auto" || approvals === "full"));

const ago = (at?: number) => {
  if (!at) return "never";
  const minutes = Math.round((Date.now() - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours} h ago` : new Date(at).toLocaleDateString();
};

function Draft({ onMade }: { onMade: (id: string) => void }) {
  const { state } = useStore();
  const bots = state.bots.filter((b) => !b.hidden && !b.archivedAt);
  const [botId, setBotId] = useState(bots[0]?.id ?? "");
  const [kind, setKind] = useState<Kind>("page");
  const [target, setTarget] = useState("");
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pick = async () => {
    const path = await window.bloks?.pickFolder?.();
    if (path) setTarget(path);
  };
  const make = () => {
    setBusy(true);
    setError(null);
    api("/api/watchers", { method: "POST", body: JSON.stringify({ botId, kind, target, instruction }) })
      .then((r) => onMade(r.watcher.id))
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  };
  return (
    <div className="flex flex-col gap-3">
      <div className="text-[15px] font-semibold text-foreground">A new watcher</div>
      <div className="flex gap-1 rounded-xl bg-muted p-1">
        {(Object.keys(KIND) as Kind[]).map((k) => {
          const Icon = KIND[k].icon;
          return (
            <button
              key={k}
              onClick={() => setKind(k)}
              className={cn(
                "flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-[12.5px] transition-colors",
                kind === k ? "bg-background font-medium text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Icon size={13} /> {KIND[k].label}
            </button>
          );
        })}
      </div>
      <div className="flex gap-2">
        <Input value={target} onChange={(e) => setTarget(e.target.value)} placeholder={KIND[kind].placeholder} className="text-[13px]" />
        {kind === "folder" && window.bloks?.pickFolder && (
          <Button variant="secondary" onClick={pick}>
            Choose
          </Button>
        )}
      </div>
      <Textarea
        value={instruction}
        onChange={(e) => setInstruction(e.target.value)}
        placeholder={
          kind === "folder"
            ? "When a new invoice arrives, rename it by date and vendor and add it to the expenses sheet."
            : kind === "page"
              ? "If the price drops below $400, tell me."
              : kind === "check"
                ? "A supplier replied: read it and decide the next step."
                : "Summarise each new post in two lines and tell me if it mentions us."
        }
        className="min-h-[90px] text-[13px]"
      />
      <label className="flex items-center gap-2 text-[13px] text-muted-foreground">
        Who acts on it
        <select
          value={botId}
          onChange={(e) => setBotId(e.target.value)}
          className="rounded-lg border bg-background px-2 py-1 text-[13px] text-foreground"
        >
          {bots.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
      </label>
      {error && <div className="text-[12.5px] text-destructive">{error}</div>}
      <div>
        <Button disabled={busy || !botId || !target.trim() || !instruction.trim()} onClick={make}>
          {busy && <Loader2 size={14} className="animate-spin" />} Start watching
        </Button>
      </div>
      <p className="text-[12px] leading-relaxed text-muted-foreground">
        The first look only notes how things are. From then on, a change gives the agent a turn in a lane of its own. Pages,
        feeds and checks are looked at every 30 minutes; folders within seconds. A check is a command run in the agent's
        folder without waking it: exit 0 means act on what it printed, exit 1 means nothing to do. You can also tell an
        agent in a chat to keep an eye on something, and it files the watcher itself.
      </p>
    </div>
  );
}

function Detail({ w, onChanged }: { w: WatcherRow; onChanged: () => void }) {
  const { state, dispatch } = useStore();
  const bot = state.bots.find((b) => b.id === w.botId);
  const [instruction, setInstruction] = useState(w.instruction);
  const [thread, setThread] = useState(w.thread ?? "");
  useEffect(() => setThread(w.thread ?? ""), [w.id, w.thread]);
  // where its turns land: the named conversation, or its own lane
  const laneId = w.thread ? bot?.tasks?.find((t) => t.title === w.thread)?.id : w.laneId;
  const [checking, setChecking] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => setInstruction(w.instruction), [w.id, w.instruction]);
  const patch = (body: Partial<WatcherRow> & { approved?: boolean }) =>
    api(`/api/watchers/${w.id}`, { method: "PATCH", body: JSON.stringify(body) }).then(onChanged).catch((e: Error) => setNote(e.message));
  const check = () => {
    setChecking(true);
    setNote(null);
    api(`/api/watchers/${w.id}/check`, { method: "POST" })
      .then((r) => setNote(r.note || "looked"))
      .catch((e: Error) => setNote(e.message))
      .finally(() => setChecking(false));
  };
  const Icon = (KIND[w.kind] ?? KIND.page).icon;
  const waiting = !mayRun(w, bot?.approvals);
  return (
    <div className="flex flex-col gap-4">
      {w.kind === "check" && waiting && (
        <div className="flex flex-col gap-2 rounded-xl border border-warning/40 bg-warning/10 px-3.5 py-3 text-[12.5px] text-foreground">
          <div className="flex items-center gap-2 font-medium">
            <ShieldCheck size={14} className="text-warning" /> {bot?.name ?? "An agent"} wants to run this command on its own
          </div>
          <code className="block break-all rounded-lg bg-background px-2.5 py-1.5 font-mono text-[12px]">{w.target}</code>
          <div className="text-muted-foreground">
            Every {w.every < 60 ? `${w.every} minutes` : `${Math.round(w.every / 60)} hours`}, in its working folder, without asking each time.
            It does not run until you approve it.
          </div>
          <div>
            <Button size="sm" onClick={() => patch({ approved: true })}>
              Approve this command
            </Button>
          </div>
        </div>
      )}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[15px] font-semibold text-foreground">
            <Icon size={15} className="text-muted-foreground" /> {w.name}
          </div>
          <div className="mt-0.5 break-all font-mono text-[12px] text-muted-foreground">{w.target}</div>
          {w.kind === "check" && !waiting && (
            <div className="mt-1 flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
              <ShieldCheck size={12} />
              {w.approvedBy === "person" ? "You approved this command." : `Runs because ${bot?.name ?? "its agent"} may run commands without asking.`}
              {w.approvedBy === "person" && (
                <button className="underline underline-offset-2" onClick={() => patch({ approved: false })}>
                  Withdraw
                </button>
              )}
            </div>
          )}
        </div>
        <Switch checked={w.enabled} onCheckedChange={(on) => patch({ enabled: on })} aria-label="Watching" />
      </div>
      <label className="flex flex-col gap-1.5 text-[12.5px] text-muted-foreground">
        What {bot?.name ?? "the agent"} does when it changes
        <Textarea
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          onBlur={() => instruction.trim() && instruction !== w.instruction && patch({ instruction })}
          className="min-h-[80px] text-[13px] text-foreground"
        />
      </label>
      <label className="flex flex-col gap-1.5 text-[12.5px] text-muted-foreground">
        Which conversation it speaks in
        <Input
          value={thread}
          onChange={(e) => setThread(e.target.value)}
          onBlur={() => thread.trim() !== (w.thread ?? "") && patch({ thread: thread.trim() })}
          placeholder={`Its own, "Watching: ${w.name}"`}
          className="text-[13px] text-foreground"
        />
        <span className="text-[11.5px]">
          Name one, like General, for work the agent started there; it is made if it does not exist, and a busy one queues the turn.
        </span>
      </label>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-[12.5px] text-muted-foreground">
        {w.kind !== "folder" && (
          <label className="flex items-center gap-1.5">
            Every
            <select
              value={w.every}
              onChange={(e) => patch({ every: Number(e.target.value) })}
              className="rounded-md border bg-background px-1.5 py-0.5 text-foreground"
            >
              {[5, 15, 30, 60, 180, 720, 1440].map((m) => (
                <option key={m} value={m}>
                  {m < 60 ? `${m} min` : m < 1440 ? `${m / 60} h` : "day"}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="flex items-center gap-1.5">
          <Switch checked={w.mode === "rehearse"} onCheckedChange={(on) => patch({ mode: on ? "rehearse" : "act" })} aria-label="Rehearse first" />
          <FlaskConical size={13} /> Try it on a copy first
        </label>
        <span>Last look {ago(w.lastCheck)}</span>
      </div>
      {w.lastError && <div className="rounded-lg bg-warning/10 px-3 py-2 text-[12.5px] text-warning">{w.lastError}</div>}
      <div>
        <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Fired</div>
        {w.fires.length === 0 ? (
          <div className="text-[12.5px] text-muted-foreground">
            {w.kind === "check" ? "Not yet. It fires when the check finds something new." : "Not yet. It fires the first time something changes."}
          </div>
        ) : (
          <ul className="flex flex-col gap-1">
            {w.fires.map((f) => (
              <li key={f.at} className="flex gap-3 text-[12.5px]">
                <span className="w-[86px] shrink-0 text-muted-foreground">{ago(f.at)}</span>
                <span className="min-w-0 truncate text-foreground">{f.summary}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" size="sm" disabled={checking} onClick={check}>
          {checking ? <Loader2 size={13} className="animate-spin" /> : <Eye size={13} />} Look now
        </Button>
        {laneId && bot && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              dispatch({ type: "select", id: bot.id, lane: laneId });
            }}
          >
            Open its lane
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto text-destructive hover:text-destructive"
          onClick={() => api(`/api/watchers/${w.id}`, { method: "DELETE" }).then(onChanged).catch(() => {})}
        >
          <Trash2 size={13} /> Stop watching
        </Button>
      </div>
      {note && <div className="text-[12.5px] text-muted-foreground">{note}</div>}
    </div>
  );
}

export function WatchersTab() {
  const { state } = useStore();
  const [rows, setRows] = useState<WatcherRow[] | null>(null);
  const [selected, setSelected] = useState<string | "new" | null>(null);
  const load = useCallback(() => {
    api("/api/watchers")
      .then((r) => setRows(r.watchers ?? []))
      .catch(() => setRows([]));
  }, []);
  useEffect(load, [load, state.ticks.watchers]);
  const current = rows?.find((w) => w.id === selected) ?? null;
  const showing = selected === "new" || (!current && rows?.length === 0) ? "new" : (current ?? rows?.[0] ?? null);

  return (
    <div className="flex min-h-0 flex-1 flex-col md:flex-row">
      <div className="flex max-h-[200px] w-full shrink-0 flex-col border-b md:max-h-none md:w-[260px] md:border-b-0 md:border-r">
        <div className="flex items-center justify-between px-4 pb-1 pt-3">
          <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Watching</span>
          <button onClick={() => setSelected("new")} className="rounded-lg px-1.5 py-1 text-[11.5px] text-muted-foreground hover:bg-accent hover:text-foreground">
            + New
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {(rows ?? []).map((w) => {
            const bot = state.bots.find((b) => b.id === w.botId);
            const Icon = (KIND[w.kind] ?? KIND.page).icon;
            const waiting = !mayRun(w, bot?.approvals);
            const active = showing !== "new" && showing?.id === w.id;
            return (
              <button
                key={w.id}
                onClick={() => setSelected(w.id)}
                className={cn("flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left transition-colors", active ? "bg-accent" : "hover:bg-accent/60")}
              >
                {bot ? <AgentAvatar bot={bot} size={26} /> : <Icon size={16} />}
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5 truncate text-[13px] font-medium text-foreground">
                    <Icon size={12} className="shrink-0 text-muted-foreground" />
                    <span className="truncate">{w.name}</span>
                  </span>
                  <span className={cn("block truncate text-[11px]", waiting || w.lastError ? "text-warning" : w.enabled ? "text-muted-foreground" : "text-muted-foreground/70")}>
                    {!w.enabled ? "Paused" : waiting ? "Needs your approval" : w.lastError ? "Needs a look" : w.fires[0] ? `Fired ${ago(w.fires[0].at)}` : `Looked ${ago(w.lastCheck)}`}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        {rows === null ? null : showing === "new" ? (
          <Draft
            onMade={(id) => {
              setSelected(id);
              load();
            }}
          />
        ) : showing ? (
          <Detail key={showing.id} w={showing} onChanged={load} />
        ) : null}
      </div>
    </div>
  );
}
