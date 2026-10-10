// Backups of the whole workspace: made, checked and put back from here.
//
// The server does the work (server/backup.ts) and answers only this
// computer, so a phone or bloks.dev/web gets a sentence instead of the
// page. Restoring is the one thing in Settings that replaces everything,
// so it opens a dialog that says, in order, what will happen and what is
// kept before anything does, and then the page stays to show each step
// until Bloks restarts.
import { useCallback, useEffect, useState } from "react";
import Check from "lucide-react/dist/esm/icons/check.mjs";
import FolderOpen from "lucide-react/dist/esm/icons/folder-open.mjs";
import Loader2 from "lucide-react/dist/esm/icons/loader-2.mjs";
import Lock from "lucide-react/dist/esm/icons/lock.mjs";
import RotateCcw from "lucide-react/dist/esm/icons/rotate-ccw.mjs";
import ShieldCheck from "lucide-react/dist/esm/icons/shield-check.mjs";
import Trash2 from "lucide-react/dist/esm/icons/trash-2.mjs";
import TriangleAlert from "lucide-react/dist/esm/icons/triangle-alert.mjs";
import { api } from "@/state/store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/cn";
import { usePageVisible } from "@/lib/pageVisible";
import { deviceWord } from "@/lib/thisComputer";
import {
  backupDetails,
  kindLabel,
  passphraseProblem,
  restoreLine,
  restoreSteps,
  sizeText,
  type BackupItem,
  type RestoreProgress,
} from "@/lib/backups";
import { SettingRow, SettingsGroup } from "./SettingsLayout";

interface Status {
  folder: string;
  auto: boolean;
  keep: number;
  backups: BackupItem[];
  running: { kind: string; startedAt: number } | null;
  restore: RestoreProgress | null;
  pending: { from: string; at: number; aside: string } | null;
  lastRestore: { from: string; at: number; aside: string; safety?: string; keys: "restored" | "kept" } | null;
}

/** As a heading: "Today, 3:04 PM" or "Fri, Oct 10, 2026, 3:04 PM". */
function when(at: number): string {
  const date = new Date(at);
  const time = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (new Date().toDateString() === date.toDateString()) return `Today, ${time}`;
  return `${date.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric", year: "numeric" })}, ${time}`;
}

/** Inside a sentence: "at 3:04 PM today" or "on Oct 10, 2026 at 3:04 PM". */
function whenSaid(at: number): string {
  const date = new Date(at);
  const time = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (new Date().toDateString() === date.toDateString()) return `at ${time} today`;
  return `on ${date.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" })} at ${time}`;
}

const underWay = (restore: RestoreProgress | null | undefined) =>
  Boolean(restore && restore.phase !== "failed" && restore.phase !== "cancelled");

const errorOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The pid of the server answering now, to tell a restarted one apart. */
const serverPid = () =>
  fetch("/api/health")
    .then((r) => (r.ok ? r.json() : null))
    .then((h) => (h?.pid as number | undefined) ?? null)
    .catch(() => null);

export function BackupsSection() {
  // bloks.dev/web is a paired browser, and backups are the computer's own
  if (window.bloksWeb) return <Elsewhere />;
  return <Backups />;
}

function Elsewhere() {
  return (
    <SettingsGroup>
      <SettingRow
        label="Backups live on the computer Bloks runs on"
        description="Open Bloks on that computer to back up or restore its workspace."
      />
    </SettingsGroup>
  );
}

function Backups() {
  const [status, setStatus] = useState<Status | null>(null);
  const [refused, setRefused] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [restoring, setRestoring] = useState<BackupItem | null>(null);
  /** Set once a restore is under way: the pid before, to know the new one. */
  const [watch, setWatch] = useState<{ pid: number | null } | null>(null);
  const [restartNote, setRestartNote] = useState<string | null>(null);

  const load = useCallback(() => {
    api("/api/backups")
      .then((s: Status) => {
        setStatus(s);
        setError(null);
      })
      .catch((e: Error & { status?: number }) => {
        if (e.status === 403) setRefused(true);
        else setError(e.message);
      });
  }, []);

  const visible = usePageVisible();
  const working = Boolean(status?.running) || underWay(status?.restore);
  useEffect(() => {
    // read once whatever the window is doing; only the polling waits
    // for somebody to be looking
    load();
    if (!visible) return;
    // a backup or restore started elsewhere (the daily one, another
    // window, the command line) shows up here as it goes
    const poll = setInterval(load, working ? 1_500 : 20_000);
    return () => clearInterval(poll);
  }, [load, visible, working]);

  // A restore ends this server. When it says it is restarting, or stops
  // answering partway, the desktop app relaunches into the restored
  // workspace; a browser waits for the server to come back on its own.
  useEffect(() => {
    if (!watch) return;
    let done = false;
    const finish = async () => {
      if (done) return;
      done = true;
      if (window.bloks?.relaunch) {
        await window.bloks.relaunch();
        return;
      }
      for (let waited = 0; waited < 60_000; waited += 1_000) {
        await new Promise((r) => setTimeout(r, 1_000));
        const pid = await serverPid();
        if (pid && pid !== watch.pid) {
          location.reload();
          return;
        }
      }
      setRestartNote("The restore is ready. Restart Bloks to open the restored workspace.");
    };
    const tick = setInterval(() => {
      fetch("/api/backups/restore")
        .then((r) => r.json())
        .then(({ restore }: { restore: RestoreProgress | null }) => {
          setStatus((s) => (s ? { ...s, restore } : s));
          if (restore?.phase === "restarting") void finish();
          if (!underWay(restore)) setWatch(null);
        })
        .catch(() => void finish());
    }, 1_000);
    return () => {
      done = true;
      clearInterval(tick);
    };
  }, [watch]);

  if (refused) return <Elsewhere />;
  if (!status) {
    return (
      <div className="flex items-center gap-2 px-1 py-6 text-[13px] text-muted-foreground">
        {error ? <span className="text-destructive">{error}</span> : <Loader2 size={14} className="animate-spin" />}
      </div>
    );
  }

  const reveal = deviceWord() === "Mac" ? "Show in Finder" : "Show in folder";

  return (
    <>
      <RestoreBanner status={status} note={restartNote} onCancel={() => void api("/api/backups/restore", { method: "DELETE" }).then(load)} />
      <SettingsGroup title="Automatically">
        <AutoBackup status={status} onChange={setStatus} />
      </SettingsGroup>
      <SettingsGroup title="Back up now">
        <BackUpNow busy={working} folder={status.folder} onDone={load} />
      </SettingsGroup>
      <SettingsGroup title={status.backups.length ? `Backups (${status.backups.length})` : "Backups"}>
        {status.backups.length === 0 ? (
          <SettingRow label="No backups yet" description={`They are kept in ${status.folder}.`} />
        ) : (
          status.backups.map((backup) => (
            <BackupRow
              key={backup.name}
              backup={backup}
              busy={working}
              revealLabel={reveal}
              onRestore={() => setRestoring(backup)}
              onChanged={load}
            />
          ))
        )}
      </SettingsGroup>
      {restoring && (
        <RestoreDialog
          backup={restoring}
          folder={status.folder}
          onClose={() => setRestoring(null)}
          onStarted={(pid, restore) => {
            setRestoring(null);
            setRestartNote(null);
            setStatus((s) => (s ? { ...s, restore } : s));
            setWatch({ pid });
          }}
        />
      )}
    </>
  );
}

/** What a restore is doing now, what the last one did, or one waiting
 * for a restart. Nothing at all when there is nothing to say. */
function RestoreBanner({ status, note, onCancel }: { status: Status; note: string | null; onCancel: () => void }) {
  const restore = status.restore;
  if (restore) {
    const live = underWay(restore);
    const stopped = restore.phase === "failed";
    return (
      <div
        role="status"
        className={cn(
          "mb-6 flex items-start gap-3 rounded-2xl border p-4",
          stopped ? "border-destructive/40 bg-destructive/5" : "bg-card",
        )}
      >
        <span className="mt-0.5 shrink-0">
          {live ? (
            <Loader2 size={15} className="animate-spin text-muted-foreground" />
          ) : stopped ? (
            <TriangleAlert size={15} className="text-destructive" />
          ) : (
            <Check size={15} className="text-muted-foreground" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-pretty text-[13px] font-medium text-foreground">{note ?? restoreLine(restore)}</div>
          <div className="mt-0.5 break-all text-[12px] text-muted-foreground">{restore.from}</div>
        </div>
        {restore.phase === "draining" && (
          <Button size="sm" variant="secondary" onClick={onCancel}>
            Call off
          </Button>
        )}
      </div>
    );
  }
  if (status.pending) {
    return (
      <div role="status" className="mb-6 rounded-2xl border bg-card p-4 text-[13px] text-foreground">
        A restore of <span className="break-all font-medium">{status.pending.from}</span> is checked and ready. It is put in
        place when Bloks next starts.
      </div>
    );
  }
  const last = status.lastRestore;
  // said for a week, then it is just history
  if (last && Date.now() - last.at < 7 * 24 * 60 * 60_000) {
    return (
      <div role="status" className="mb-6 flex items-start gap-3 rounded-2xl border bg-card p-4">
        <ShieldCheck size={15} className="mt-0.5 shrink-0 text-success" />
        <div className="min-w-0 text-pretty text-[12.5px] leading-relaxed text-muted-foreground">
          <span className="font-medium text-foreground">Restored {whenSaid(last.at)}</span> from{" "}
          <span className="break-all">{last.from}</span>.
          {last.aside && (
            <>
              {" "}
              The workspace it replaced is in <span className="break-all font-mono text-[11.5px]">{last.aside}</span>.
            </>
          )}
          {last.keys === "kept" ? " The keys on this computer were kept." : " Its saved keys came back with it."}
        </div>
      </div>
    );
  }
  return null;
}

function AutoBackup({ status, onChange }: { status: Status; onChange: (s: Status) => void }) {
  const [saving, setSaving] = useState(false);
  const set = (auto: boolean) => {
    setSaving(true);
    api("/api/backups/settings", { method: "PUT", body: JSON.stringify({ auto }) })
      .then(onChange)
      .catch(() => {})
      .finally(() => setSaving(false));
  };
  return (
    <SettingRow
      label="Back up every day"
      info="Made once a day while Bloks is open and nothing is running. They leave out saved keys and the Undo history, since nobody is there to give a passphrase. Backups you make yourself stay until you delete them."
      description={`Keeps the newest ${status.keep}, in ${status.folder}.`}
      control={<Switch aria-label="Back up every day" checked={status.auto} disabled={saving} onCheckedChange={set} />}
    />
  );
}

function BackUpNow({ busy, folder, onDone }: { busy: boolean; folder: string; onDone: () => void }) {
  const [undo, setUndo] = useState(false);
  const [seal, setSeal] = useState(false);
  const [keys, setKeys] = useState(true);
  const [passphrase, setPassphrase] = useState("");
  const [again, setAgain] = useState("");
  const [working, setWorking] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const problem = seal ? passphraseProblem(passphrase, again) : null;
  const start = () => {
    setWorking(true);
    setResult(null);
    api("/api/backups", {
      method: "POST",
      body: JSON.stringify({ undo, ...(seal ? { passphrase, secrets: keys } : {}) }),
    })
      .then(({ backup }: { backup: BackupItem }) => {
        setResult({ ok: true, text: `Backed up, ${sizeText(backup.size)}.${seal ? " Keep the passphrase somewhere safe: without it this backup cannot be opened." : ""}` });
        setPassphrase("");
        setAgain("");
        onDone();
      })
      .catch((e) => setResult({ ok: false, text: errorOf(e) }))
      .finally(() => setWorking(false));
  };

  return (
    <>
      <SettingRow
        label="Include Undo history"
        description="Every earlier version of the files your agents changed, so changes can still be undone after a restore. It can make a backup much bigger."
        control={<Switch aria-label="Include Undo history" checked={undo} onCheckedChange={setUndo} />}
      />
      <SettingRow
        label="Seal with a passphrase"
        description="Nobody can open a sealed backup without it, Bloks included, so keep it somewhere safe."
        control={<Switch aria-label="Seal with a passphrase" checked={seal} onCheckedChange={setSeal} />}
      >
        {seal && (
          <div className="mt-3 flex flex-col gap-2">
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                type="password"
                autoComplete="new-password"
                aria-label="Passphrase"
                placeholder="Passphrase"
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
              />
              <Input
                type="password"
                autoComplete="new-password"
                aria-label="Passphrase again"
                placeholder="Again, to be sure"
                value={again}
                onChange={(e) => setAgain(e.target.value)}
              />
            </div>
            {passphrase && problem && <div className="text-[12px] text-muted-foreground">{problem}</div>}
            <div className="flex items-center gap-3 pt-1">
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-medium text-foreground">Include saved keys</div>
                <div className="mt-0.5 text-pretty text-[12px] leading-relaxed text-muted-foreground">
                  Engine keys, tokens and paired devices, so a restore on another computer is ready to go. Only ever in a
                  sealed backup.
                </div>
              </div>
              <Switch aria-label="Include saved keys" checked={keys} onCheckedChange={setKeys} />
            </div>
          </div>
        )}
      </SettingRow>
      <SettingRow
        label="Back up now"
        description={
          result ? (
            <span className={result.ok ? "text-success" : "text-destructive"}>{result.text}</span>
          ) : (
            `Agents, rooms, conversations, skills and settings, ${seal && keys ? "with" : "without"} saved keys. Kept in ${folder} until you delete it.`
          )
        }
        control={
          <Button size="sm" disabled={busy || working || Boolean(problem)} onClick={start} className="min-w-[112px]">
            {working ? <Loader2 size={13} className="animate-spin" /> : null}
            {working ? "Backing up" : "Back up now"}
          </Button>
        }
      />
    </>
  );
}

function BackupRow({
  backup,
  busy,
  revealLabel,
  onRestore,
  onChanged,
}: {
  backup: BackupItem;
  busy: boolean;
  revealLabel: string;
  onRestore: () => void;
  onChanged: () => void;
}) {
  const [asking, setAsking] = useState(false);
  const [passphrase, setPassphrase] = useState("");
  const [checking, setChecking] = useState(false);
  const [line, setLine] = useState<{ ok: boolean; text: string } | null>(null);
  const label = kindLabel(backup.kind);
  const base = `/api/backups/${encodeURIComponent(backup.name)}`;

  const verify = () => {
    if (backup.encrypted && !passphrase) {
      setAsking(true);
      return;
    }
    setChecking(true);
    setLine(null);
    api(`${base}/verify`, { method: "POST", body: JSON.stringify(passphrase ? { passphrase } : {}) })
      .then((r: { ok: boolean; files: number; problems: string[] }) => {
        setAsking(false);
        setPassphrase("");
        setLine(
          r.ok
            ? { ok: true, text: `All ${r.files.toLocaleString()} files check out.` }
            : { ok: false, text: r.problems.slice(0, 3).join(" ") },
        );
      })
      .catch((e) => setLine({ ok: false, text: errorOf(e) }))
      .finally(() => setChecking(false));
  };

  const show = () =>
    void api(`${base}/reveal`, { method: "POST" })
      .then((r: { path: string; shown: boolean }) => {
        if (!r.shown) setLine({ ok: true, text: r.path });
      })
      .catch((e) => setLine({ ok: false, text: errorOf(e) }));

  const remove = () => {
    if (!window.confirm(`Delete the backup from ${when(backup.created)}?\n\nIt is gone for good once deleted.`)) return;
    void api(base, { method: "DELETE" })
      .then(onChanged)
      .catch((e) => setLine({ ok: false, text: errorOf(e) }));
  };

  return (
    <div className="px-4 py-3.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-[13.5px] font-medium text-foreground">{when(backup.created)}</span>
        {label && <span className="rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">{label}</span>}
        {backup.encrypted && <Lock size={12} aria-label="Sealed with a passphrase" className="text-muted-foreground" />}
      </div>
      <div className={cn("mt-0.5 text-pretty text-[12.5px] leading-relaxed", backup.damaged ? "text-destructive" : "text-muted-foreground")}>
        {backupDetails(backup)}
      </div>
      {line && (
        <div className={cn("mt-1.5 break-words text-[12px]", line.ok ? "text-success" : "text-destructive")} aria-live="polite">
          {line.text}
        </div>
      )}
      {asking && (
        <form
          className="mt-2.5 flex flex-col gap-2 sm:flex-row"
          onSubmit={(e) => {
            e.preventDefault();
            if (passphrase) verify();
          }}
        >
          <Input
            type="password"
            autoComplete="off"
            autoFocus
            aria-label="Passphrase for this backup"
            placeholder="Passphrase for this backup"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
          />
          <div className="flex gap-1.5">
            <Button type="submit" size="sm" className="h-9" disabled={!passphrase || checking}>
              Verify
            </Button>
            <Button size="sm" variant="ghost" className="h-9" onClick={() => setAsking(false)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
      <div className="mt-2.5 flex flex-wrap gap-1.5">
        {!asking && (
          <Button size="sm" variant="secondary" disabled={checking || backup.damaged} onClick={verify}>
            {checking ? <Loader2 size={13} className="animate-spin" /> : <ShieldCheck size={13} />}
            Verify
          </Button>
        )}
        <Button size="sm" variant="secondary" onClick={show}>
          <FolderOpen size={13} />
          {revealLabel}
        </Button>
        <Button size="sm" variant="secondary" disabled={busy || backup.damaged} onClick={onRestore}>
          <RotateCcw size={13} />
          Restore…
        </Button>
        <Button size="sm" variant="ghost" className="hover:text-destructive" disabled={busy} onClick={remove}>
          <Trash2 size={13} />
          Delete
        </Button>
      </div>
    </div>
  );
}

function RestoreDialog({
  backup,
  folder,
  onClose,
  onStarted,
}: {
  backup: BackupItem;
  folder: string;
  onClose: () => void;
  onStarted: (pid: number | null, restore: RestoreProgress) => void;
}) {
  const [passphrase, setPassphrase] = useState("");
  const [starting, setStarting] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const { steps, notes } = restoreSteps(backup, folder);

  const start = async () => {
    setStarting(true);
    setProblem(null);
    const pid = await serverPid();
    try {
      const { restore } = await api(`/api/backups/${encodeURIComponent(backup.name)}/restore`, {
        method: "POST",
        body: JSON.stringify(backup.encrypted ? { passphrase } : {}),
      });
      onStarted(pid, restore);
    } catch (e) {
      setProblem(errorOf(e));
      setStarting(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !starting && onClose()}>
      <DialogContent className="max-h-[85vh] w-[calc(100%-2rem)] max-w-[480px] overflow-y-auto">
        <DialogTitle>Restore this backup?</DialogTitle>
        <DialogDescription>
          Everything in Bloks goes back to how it was {whenSaid(backup.created)}: agents, rooms, conversations, skills
          and settings.
        </DialogDescription>
        <ol className="mt-4 flex list-decimal flex-col gap-1.5 pl-5 text-[12.5px] leading-relaxed text-foreground marker:text-muted-foreground">
          {steps.map((step) => (
            <li key={step} className="text-pretty break-words">
              {step}
            </li>
          ))}
        </ol>
        <div className="mt-3 flex flex-col gap-1 text-pretty text-[12.5px] leading-relaxed text-muted-foreground">
          {notes.map((note) => (
            <p key={note}>{note}</p>
          ))}
        </div>
        {backup.encrypted && (
          <Input
            type="password"
            autoComplete="off"
            autoFocus
            aria-label="Passphrase for this backup"
            placeholder="Passphrase for this backup"
            className="mt-4"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && passphrase && !starting) void start();
            }}
          />
        )}
        {problem && <div className="mt-3 text-[12.5px] text-destructive">{problem}</div>}
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <Button variant="secondary" disabled={starting} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="destructive" disabled={starting || (backup.encrypted && !passphrase)} onClick={() => void start()}>
            {starting ? <Loader2 size={13} className="animate-spin" /> : <RotateCcw size={13} />}
            Restore and restart
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
