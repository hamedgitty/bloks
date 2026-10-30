// Moving the whole workspace to a hosted one, on the Backups page.
//
// Two halves, and a workspace usually shows one of them. Where the work
// is, one file is written out: every agent, lane, room, routine, watcher,
// intent, memory, skill and setting, with the keys left behind and named
// (server/workspace-move.ts). Where it is going, an empty workspace takes
// that file in and restarts to put it in place. Nothing is ever moved
// over somebody's work: a workspace with anything in it does not offer
// the second half, and the server refuses it anyway.
import { useEffect, useRef, useState } from "react";
import { Download } from "@/components/icons";
import { FolderOpen } from "@/components/icons";
import { Loader2 } from "@/components/icons";
import { Upload } from "@/components/icons";
import { api } from "@/state/store";
import { Button } from "@/components/ui/button";
import { confirm } from "@/components/ui/confirm";
import { toast } from "@/components/ui/toast";
import { deviceWord, yourComputer } from "@/lib/thisComputer";
import { keysToEnter } from "@/lib/backups";
import { SettingRow, SettingsGroup } from "./SettingsLayout";
import { formatNumber, t } from "@/lib/i18n";

interface MoveStatus {
  empty: boolean;
  hosted: boolean;
  /** Writing one out answers only the computer the workspace is on. */
  canWrite?: boolean;
  /** Set when the file may go in parts of this many bytes, which is how
   * it reaches a workspace through Bloks Cloud. An older server takes it
   * whole, in one request. */
  partSize?: number;
}

interface Written {
  name: string;
  toEnter: string[];
}

/** Parts in flight at once: enough to keep the line busy, few enough
 * that a slow one is not a crowd behind it. */
const LANES = 3;
/** Tries per part before the send stops and says so. */
const TRIES = 6;

/** Where a send in parts got to, kept in this window's storage so a send
 * that stopped (a closed window, a lost line, a machine that slept)
 * carries on rather than starting over. Never the file itself, which a
 * page cannot keep: the person picks it again, and it is known by its
 * name, size and date. */
const SENDING_KEY = "bloks.moveSending";
interface Sending {
  id: string;
  name: string;
  size: number;
  modified: number;
}

function readSending(): Sending | null {
  try {
    const raw = JSON.parse(localStorage.getItem(SENDING_KEY) ?? "null");
    return raw && typeof raw.id === "string" && typeof raw.size === "number" ? raw : null;
  } catch {
    return null;
  }
}

function keepSending(sending: Sending | null) {
  try {
    if (sending) localStorage.setItem(SENDING_KEY, JSON.stringify(sending));
    else localStorage.removeItem(SENDING_KEY);
  } catch {
    /* only the resuming is lost */
  }
}

async function asked<T>(path: string, init?: RequestInit): Promise<{ ok: boolean; status: number; body: T & { error?: string; needsPassphrase?: boolean } }> {
  const res = await fetch(path, init);
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

/**
 * Sends a workspace file in numbered parts (server/move-upload.ts), a few
 * at once, each tried again on its own when it fails, and answers the
 * upload's id once every part is there. The same file picked again after
 * a send stopped carries on with the parts still to come.
 */
async function sendInParts(file: File, onProgress: (sent: number) => void): Promise<string> {
  let upload: { id: string; partSize: number; parts: number; missing: number[] } | null = null;
  const kept = readSending();
  if (kept && kept.name === file.name && kept.size === file.size && kept.modified === file.lastModified) {
    const was = await asked<{ id: string; size: number; partSize: number; parts: number; missing: number[] }>(`/api/workspace/move/upload/${kept.id}`);
    if (was.ok && was.body.size === file.size && Array.isArray(was.body.missing)) upload = was.body;
  }
  if (!upload) {
    const started = await asked<{ id: string; partSize: number; parts: number }>("/api/workspace/move/upload", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ size: file.size }),
    });
    if (!started.ok) throw new Error(started.body.error ?? `${started.status}`);
    upload = { ...started.body, missing: Array.from({ length: started.body.parts }, (_, i) => i) };
    keepSending({ id: upload.id, name: file.name, size: file.size, modified: file.lastModified });
  }
  const { id, partSize, parts } = upload;
  const sizeOf = (index: number) => (index === parts - 1 ? file.size - index * partSize : partSize);
  const queue = [...upload.missing];
  let sent = file.size - queue.reduce((n, index) => n + sizeOf(index), 0);
  onProgress(sent);

  const one = async (index: number) => {
    for (let attempt = 1; ; attempt++) {
      let failed: string;
      try {
        const res = await fetch(`/api/workspace/move/upload/${id}/${index}`, {
          method: "PUT",
          headers: { "content-type": "application/octet-stream" },
          body: file.slice(index * partSize, index * partSize + sizeOf(index)),
        });
        if (res.ok) return;
        const body = await res.json().catch(() => ({}));
        failed = body.error ?? `${res.status} ${res.statusText}`;
        // gone, or refused for what it is: sending it again changes nothing
        if (res.status === 404 || res.status === 400 || res.status === 409 || res.status === 413) {
          if (res.status === 404) keepSending(null);
          throw Object.assign(new Error(failed), { final: true });
        }
      } catch (e) {
        if ((e as { final?: boolean }).final) throw e;
        failed = e instanceof Error ? e.message : String(e);
      }
      if (attempt >= TRIES) throw new Error(t("moveWorkspace.partFailed", { reason: failed }));
      await new Promise((r) => setTimeout(r, Math.min(1_000 * 2 ** attempt, 20_000)));
    }
  };
  const lane = async () => {
    while (queue.length) {
      const index = queue.shift()!;
      await one(index);
      sent += sizeOf(index);
      onProgress(sent);
    }
  };
  await Promise.all(Array.from({ length: Math.min(LANES, Math.max(1, queue.length)) }, lane));
  return id;
}

const megabytes = (bytes: number) => {
  if (bytes >= 1e9) return t("moveWorkspace.sizeGb", { size: formatNumber(bytes / 1e9, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) });
  const digits = bytes >= 1e8 ? 0 : 1;
  return t("moveWorkspace.sizeMb", { size: formatNumber(Math.max(0.1, bytes / 1e6), { minimumFractionDigits: digits, maximumFractionDigits: digits }) });
};

/** The pid of the server answering now, to tell a restarted one apart. */
const serverPid = () =>
  fetch("/api/health")
    .then((r) => (r.ok ? r.json() : null))
    .then((h) => (h?.pid as number | undefined) ?? null)
    .catch(() => null);

export function MoveWorkspace() {
  const [status, setStatus] = useState<MoveStatus | null>(null);
  const [writing, setWriting] = useState(false);
  const [written, setWritten] = useState<Written | null>(null);
  const [writeRefused, setWriteRefused] = useState(false);
  const [arriving, setArriving] = useState<{ toEnter: string[]; pid: number | null } | null>(null);
  const [sending, setSending] = useState(false);
  const [progress, setProgress] = useState<{ sent: number; size: number } | null>(null);
  // the restart was waited for and never came: said where it draws
  const [stuck, setStuck] = useState(false);
  const [resumable] = useState(() => readSending());
  const picker = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api("/api/workspace/move")
      .then(setStatus)
      .catch(() => setStatus(null));
  }, []);

  // Taking a workspace in ends this server, the way a restore does: the
  // desktop app relaunches, a browser waits for it to come back.
  useEffect(() => {
    if (!arriving) return;
    let done = false;
    void (async () => {
      await new Promise((r) => setTimeout(r, 2_000));
      // the app relaunches for a workspace it runs itself; a hosted one is
      // on its own machine, which comes back by itself, and is waited for
      if (window.bloks?.relaunch && !status?.hosted) {
        await window.bloks.relaunch();
        return;
      }
      for (let waited = 0; waited < 120_000 && !done; waited += 1_500) {
        await new Promise((r) => setTimeout(r, 1_500));
        const pid = await serverPid();
        if (pid && pid !== arriving.pid) {
          location.reload();
          return;
        }
      }
      if (!done) setStuck(true);
    })();
    return () => {
      done = true;
    };
  }, [arriving]);

  if (!status) return null;
  const canWrite = status.canWrite !== false && !writeRefused;
  if (!canWrite && !status.empty) return null;

  const write = () => {
    setWriting(true);
    api("/api/workspace/move", { method: "POST", body: "{}" })
      .then(({ backup, toEnter }: { backup: { name: string }; toEnter: string[] }) => setWritten({ name: backup.name, toEnter }))
      .catch((e: Error & { status?: number }) => {
        if (e.status === 403) setWriteRefused(true);
        else toast.error(e.message);
      })
      .finally(() => setWriting(false));
  };

  const reveal = (name: string) => {
    api(`/api/backups/${encodeURIComponent(name)}/reveal`, { method: "POST" }).catch((e: Error) => toast.error(e.message));
  };

  const take = async (file: File) => {
    const ok = await confirm({
      title: t("moveWorkspace.take.title"),
      body: t("moveWorkspace.take.body", { name: file.name }),
      confirmLabel: t("moveWorkspace.take.confirm"),
    });
    if (!ok) return;
    setSending(true);
    const pid = await serverPid();
    try {
      let body: { toEnter?: unknown; error?: string };
      if (status.partSize) {
        // in parts, which is how it reaches a workspace through Bloks
        // Cloud, and how a send that stops carries on
        setProgress({ sent: 0, size: file.size });
        const id = await sendInParts(file, (sent) => setProgress({ sent, size: file.size }));
        const done = await asked<{ toEnter?: unknown }>(`/api/workspace/move/upload/${id}/finish`, { method: "POST" });
        if (!done.ok) throw new Error(done.body.error ?? `${done.status}`);
        keepSending(null);
        body = done.body;
      } else {
        const res = await fetch("/api/workspace/move/import", {
          method: "POST",
          headers: { "content-type": "application/octet-stream" },
          body: file,
        });
        body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`);
      }
      setArriving({ toEnter: Array.isArray(body.toEnter) ? body.toEnter : [], pid });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
      setProgress(null);
    }
  };

  const showIn = deviceWord() === "Mac" ? t("moveWorkspace.showInFinder") : t("moveWorkspace.showInFolder");

  return (
    <SettingsGroup title={t("moveWorkspace.moveToAHostedWorkspace")}>
      {canWrite && (
        <SettingRow
          label={t("moveWorkspace.writeOutThisWorkspace")}
          info={t("moveWorkspace.oneFileWithEveryAgent")}
          description={t("moveWorkspace.oneFileToBringInto")}
          control={
            <Button size="sm" variant="secondary" disabled={writing} onClick={write}>
              {writing && <Loader2 size={14} className="animate-spin" />}
              {t("moveWorkspace.writeTheFile")}
            </Button>
          }
        >
          {written && (
            <div className="mt-3 rounded-xl bg-muted/60 px-3 py-2.5 text-small leading-relaxed text-muted-foreground">
              <div className="break-all font-medium text-foreground">{written.name}</div>
              <div className="mt-1 text-pretty">{keysToEnter(written.toEnter)}</div>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button size="sm" variant="secondary" asChild>
                  <a href={`/api/workspace/move/${encodeURIComponent(written.name)}`} download={written.name}>
                    <Download size={14} />
                    {t("moveWorkspace.download")}
                  </a>
                </Button>
                {window.bloks && (
                  <Button size="sm" variant="ghost" onClick={() => reveal(written.name)}>
                    <FolderOpen size={14} />
                    {showIn}
                  </Button>
                )}
              </div>
            </div>
          )}
        </SettingRow>
      )}
      {status.empty && (
        <SettingRow
          label={t("moveWorkspace.bringAWorkspaceHere")}
          description={
            status.hosted
              ? t("moveWorkspace.thisHostedWorkspaceIsEmpty", { computer: yourComputer() })
              : t("moveWorkspace.thisWorkspaceIsEmptySo")
          }
          control={
            <>
              <input
                ref={picker}
                type="file"
                accept=".gz,.enc,application/gzip,application/octet-stream"
                className="sr-only"
                aria-label={t("moveWorkspace.workspaceFile")}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (file) void take(file);
                }}
              />
              <Button size="sm" variant="secondary" disabled={sending || Boolean(arriving)} onClick={() => picker.current?.click()}>
                {sending ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
                {t("moveWorkspace.chooseTheFile")}
              </Button>
            </>
          }
        >
          {progress && (
            <div role="status" className="mt-3 rounded-xl bg-muted/60 px-3 py-2.5 text-small leading-relaxed text-muted-foreground">
              <div className="flex items-center justify-between gap-3 font-medium text-foreground">
                <span>{t("moveWorkspace.sendingTheWorkspace")}</span>
                <span className="tabular-nums">{formatNumber(Math.floor((progress.sent / Math.max(1, progress.size)) * 100) / 100, { style: "percent" })}</span>
              </div>
              <div
                role="progressbar"
                aria-label={t("moveWorkspace.sendingTheWorkspace")}
                aria-valuemin={0}
                aria-valuemax={progress.size}
                aria-valuenow={progress.sent}
                className="mt-2 h-1.5 overflow-hidden rounded-full bg-background"
              >
                <div className="h-full origin-left bg-brand-ink transition-transform duration-300 ease-out" style={{ transform: `scaleX(${progress.sent / Math.max(1, progress.size)})` }} />
              </div>
              <div className="mt-1.5 text-pretty tabular-nums">
                {t("moveWorkspace.sentOf", { sent: megabytes(progress.sent), size: megabytes(progress.size) })}
              </div>
            </div>
          )}
          {!progress && !arriving && resumable && status.partSize && (
            <p className="mt-2 text-pretty text-small text-muted-foreground">
              {t("moveWorkspace.stoppedPartWay", { name: resumable.name })}
            </p>
          )}
          {arriving && (
            <div role="status" className="mt-3 rounded-xl bg-muted/60 px-3 py-2.5 text-small leading-relaxed text-muted-foreground">
              <div className="flex items-center gap-2 font-medium text-foreground">
                {!stuck && <Loader2 size={13} className="animate-spin" />}
                {stuck ? t("moveWorkspace.restartToFinish") : t("moveWorkspace.puttingTheWorkspaceInPlace")}
              </div>
              <div className="mt-1 text-pretty">{keysToEnter(arriving.toEnter)}</div>
            </div>
          )}
        </SettingRow>
      )}
    </SettingsGroup>
  );
}
