// Settings, About: the workspace server, when it is not the one inside
// this app (server/server-update.ts; GitHub 396).
//
// The desktop app can be a window onto a bloks-server on another
// computer, and updating the app never updated that server, while the
// page said only one version and so read as though it had. So the two are
// said apart: this app's version beside its own updater, and the
// server's, on the computer it runs on, beside its own. The owner checks
// GitHub for a newer server, reads what changed, and installs it from
// here when the server can update itself (systemd starting the new
// version, where systemd runs it), or reads the steps to do it by hand
// when it cannot. The server inside the app is the app's to update, so
// it gets no row of its own.
import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2 } from "@/components/icons";
import { ChevronRight } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { api } from "@/state/store";
import { cn } from "@/lib/cn";
import { SettingRow } from "../SettingsLayout";
import { t } from "@/lib/i18n";

type Phase = "downloading" | "unpacking" | "draining" | "restarting" | "failed" | "cancelled";

export interface ServerUpdateStatus {
  version: string;
  computer: string;
  install: { kind: string; canInstall: boolean; why: string; manager?: string };
  check: {
    at: number;
    latest?: { version: string; notes: string; page: string; publishedAt?: string; checksum: boolean };
    newer: boolean;
    error?: string;
  } | null;
  job: { phase: Phase; version: string; from: string; percent?: number; running?: number; deadline?: number; error?: string } | null;
  last: {
    from: string;
    to: string;
    at: number;
    pending?: boolean;
    ok: boolean;
    rolledBack?: boolean;
    running?: string;
    error?: string;
    log: string;
    /** The service manager that started the new version (systemd), when one did. */
    manager?: string;
  } | null;
  steps: string[];
}

/** What the page knows about the workspace server: its status, or that it
 * is older than this and only says its version, or nothing to show. */
export type ServerView =
  | { kind: "loading" }
  | { kind: "none" }
  | { kind: "older"; version: string }
  | { kind: "status"; status: ServerUpdateStatus };

/** A check older than this is asked again when the page opens. */
const STALE_MS = 6 * 60 * 60_000;
/** How long a restart is waited for before the page says it is taking long. */
const RESTART_PATIENCE_MS = 4 * 60_000;
const ACTIVE: Phase[] = ["downloading", "unpacking", "draining", "restarting"];

/** The workspace server's update status, kept fresh while an update runs
 * and through the restart that ends it. */
export function useServerUpdate(): {
  view: ServerView;
  check: () => Promise<void>;
  install: (version: string) => Promise<void>;
  cancel: () => Promise<void>;
  busy: boolean;
  problem: string | null;
  /** Restarting into this version, and not heard back from yet. */
  restartingTo: string | null;
  slow: boolean;
} {
  const [view, setView] = useState<ServerView>({ kind: "loading" });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [restartingTo, setRestartingTo] = useState<string | null>(null);
  const [slow, setSlow] = useState(false);
  const restartAt = useRef(0);
  const checked = useRef(false);

  const take = useCallback((status: ServerUpdateStatus) => {
    setView(status.install.kind === "desktop" ? { kind: "none" } : { kind: "status", status });
    if (status.job?.phase === "restarting") {
      if (!restartAt.current) restartAt.current = Date.now();
      setRestartingTo(status.job.version);
    } else if (status.last && !status.last.pending && Date.now() - status.last.at < 10 * 60_000) {
      // the helper has said how it went: the restart is over either way
      restartAt.current = 0;
      setRestartingTo(null);
      setSlow(false);
    }
  }, []);

  const load = useCallback(async (): Promise<ServerUpdateStatus | null> => {
    try {
      const status = (await api("/api/server-update")) as ServerUpdateStatus;
      take(status);
      return status;
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status === 404) {
        // a server from before 3.0.14, which says only its version
        const health = await api("/api/health").catch(() => null);
        setView(health?.version ? { kind: "older", version: String(health.version) } : { kind: "none" });
      } else if (status === 403) {
        setView({ kind: "none" });
      } else if (restartAt.current) {
        // gone while it restarts, which is expected for a while
        if (Date.now() - restartAt.current > RESTART_PATIENCE_MS) setSlow(true);
      } else {
        setView((current) => (current.kind === "loading" ? { kind: "none" } : current));
      }
      return null;
    }
  }, [take]);

  const check = useCallback(async () => {
    setBusy(true);
    setProblem(null);
    try {
      take((await api("/api/server-update/check", { method: "POST" })) as ServerUpdateStatus);
    } catch (e) {
      setProblem((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [take]);

  // once on opening: what it is, and a fresh look at GitHub if the last
  // one is old and nothing is under way
  useEffect(() => {
    void load().then((status) => {
      if (!status || checked.current || status.install.kind === "desktop" || status.install.kind === "hosted") return;
      checked.current = true;
      const stale = !status.check || Date.now() - status.check.at > STALE_MS;
      if (stale && !(status.job && ACTIVE.includes(status.job.phase))) void check();
    });
  }, [load, check]);

  // while an update runs, and through its restart, keep asking
  const running = view.kind === "status" && Boolean(view.status.job && ACTIVE.includes(view.status.job.phase));
  const pending = view.kind === "status" && Boolean(view.status.last?.pending);
  useEffect(() => {
    if (!running && !pending && !restartingTo) return;
    const timer = setInterval(() => void load(), 1500);
    return () => clearInterval(timer);
  }, [running, pending, restartingTo, load]);

  const install = useCallback(
    async (version: string) => {
      setBusy(true);
      setProblem(null);
      try {
        take((await api("/api/server-update/install", { method: "POST", body: JSON.stringify({ version }) })) as ServerUpdateStatus);
      } catch (e) {
        setProblem((e as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [take],
  );

  const cancel = useCallback(async () => {
    setBusy(true);
    try {
      take((await api("/api/server-update/install", { method: "DELETE" })) as ServerUpdateStatus);
    } catch (e) {
      setProblem((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [take]);

  return { view, check, install, cancel, busy, problem, restartingTo, slow };
}

/** What a running update is doing, in a line. */
function jobLine(job: NonNullable<ServerUpdateStatus["job"]>, now = Date.now()): string {
  switch (job.phase) {
    case "downloading":
      return job.percent
        ? t("serverUpdate.job.downloadingPercent", { version: job.version, percent: job.percent })
        : t("serverUpdate.job.downloading", { version: job.version });
    case "unpacking":
      return t("serverUpdate.job.unpacking", { version: job.version, from: job.from });
    case "draining": {
      const n = job.running ?? 0;
      const minutes = job.deadline ? Math.ceil((job.deadline - now) / 60_000) : null;
      const version = job.version;
      // a whole sentence for each case, so a language orders it its own way
      if (n > 0) {
        if (minutes === null) return t("serverUpdate.job.finishingReplies", { count: n, version });
        return minutes > 1
          ? t("serverUpdate.job.finishingRepliesMinutes", { count: n, version, minutes })
          : t("serverUpdate.job.finishingRepliesUnderMinute", { count: n, version });
      }
      if (minutes === null) return t("serverUpdate.job.finishingRunning", { version });
      return minutes > 1
        ? t("serverUpdate.job.finishingRunningMinutes", { version, minutes })
        : t("serverUpdate.job.finishingRunningUnderMinute", { version });
    }
    case "restarting":
      return t("serverUpdate.job.restarting", { version: job.version });
    case "failed":
      return job.error ? t("serverUpdate.job.failedWhy", { error: job.error }) : t("serverUpdate.job.failed");
    case "cancelled":
      return t("serverUpdate.job.cancelled");
  }
}

/**
 * The workspace server's row: its version on its computer, what an
 * update would do or is doing, and the one button that fits. Under it,
 * the new version's notes and, where it does not update itself, the
 * steps to do it by hand.
 */
export function ServerUpdateRow({ state }: { state: ReturnType<typeof useServerUpdate> }) {
  const { view, check, install, cancel, busy, problem, restartingTo, slow } = state;
  if (view.kind === "loading" || view.kind === "none") return null;

  if (view.kind === "older") {
    return (
      <SettingRow
        rowId="workspace-server"
        label={t("serverUpdate.label", { version: view.version })}
        description={
          <>
            {t("serverUpdate.older", { version: "3.0.14" })}{" "}
            <a href="https://bloks.dev/docs#server" target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-foreground">
              {t("serverUpdate.howToUpdateIt")}
            </a>
          </>
        }
      />
    );
  }

  const { status } = view;
  const { install: how, check: looked, job, last } = status;
  const latest = looked?.latest;
  const recent = last && !last.pending && Date.now() - last.at < 24 * 60 * 60_000 ? last : null;
  const active = Boolean(job && ACTIVE.includes(job.phase));
  const fixed = how.kind === "hosted" || how.kind === "disabled";

  const line = restartingTo
    ? slow
      ? t("serverUpdate.line.slow", { version: restartingTo })
      : t("serverUpdate.line.restarting", { version: restartingTo })
    : job && (active || job.phase === "failed" || job.phase === "cancelled")
      ? jobLine(job)
      : recent && recent.to === status.version && recent.ok
        ? recent.manager
          ? t("serverUpdate.line.updatedBy", { from: recent.from, to: recent.to, manager: recent.manager, log: recent.log })
          : t("serverUpdate.line.updated", { from: recent.from, to: recent.to, log: recent.log })
        : recent && !recent.ok
          ? recent.rolledBack
            ? recent.error
              ? t("serverUpdate.line.rolledBackWhy", { to: recent.to, from: recent.from, error: recent.error })
              : t("serverUpdate.line.rolledBack", { to: recent.to, from: recent.from })
            : recent.error
              ? t("serverUpdate.line.didNotStartWhy", { to: recent.to, error: recent.error })
              : t("serverUpdate.line.didNotStart", { to: recent.to })
          : how.kind === "hosted"
            ? how.why
            : looked?.error
              ? looked.error
              : looked?.newer && latest
                ? how.canInstall
                  ? t("serverUpdate.line.outInstallable", { version: latest.version })
                  : t("serverUpdate.line.out", { version: latest.version })
                : looked
                  ? t("serverUpdate.line.latest")
                  : busy
                    ? t("common.checking")
                    : t("serverUpdate.line.checksGithub");

  const control = fixed ? null : active && job?.phase !== "restarting" ? (
    <Button size="sm" variant="secondary" disabled={busy} onClick={() => void cancel()}>
      {t("serverUpdate.callOff")}
    </Button>
  ) : restartingTo || job?.phase === "restarting" ? (
    <Button size="sm" variant="secondary" disabled>
      <Loader2 size={14} className="animate-spin" /> {t("serverUpdate.restarting")}
    </Button>
  ) : looked?.newer && latest && how.canInstall && latest.checksum ? (
    <Button size="sm" disabled={busy} onClick={() => void install(latest.version)}>
      {t("serverUpdate.install", { version: latest.version })}
    </Button>
  ) : (
    <Button size="sm" variant="secondary" disabled={busy} onClick={() => void check()}>
      {busy ? t("common.checking") : t("serverUpdate.checkForUpdates")}
    </Button>
  );

  return (
    <SettingRow
      rowId="workspace-server"
      label={t("serverUpdate.label", { version: status.version })}
      description={
        <>
          <span className="block">{t("serverUpdate.runsOn", { computer: status.computer })}</span>
          <span className={cn("mt-1 block", job?.phase === "failed" || (recent && !recent.ok) ? "text-destructive" : undefined)} aria-live="polite">
            {line}
          </span>
        </>
      }
      error={problem}
      control={control}
    >
      {looked?.newer && latest && !restartingTo && (
        <div className="mt-3 flex flex-col gap-3">
          {latest.notes && (
            <details className="group">
              <summary className="flex cursor-pointer list-none items-center gap-1 text-small text-muted-foreground transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden">
                <ChevronRight size={12} className="transition-transform duration-150 group-open:rotate-90" />
                {t("serverUpdate.whatsNew", { version: latest.version })}
              </summary>
              <div className="mt-2 max-h-[280px] overflow-auto whitespace-pre-wrap break-words rounded-lg border bg-muted/40 p-3 text-small leading-relaxed text-foreground">
                {latest.notes}
              </div>
              <a href={latest.page} target="_blank" rel="noreferrer" className="mt-1.5 inline-block text-small text-muted-foreground underline underline-offset-2 hover:text-foreground">
                {t("serverUpdate.releasePage")}
              </a>
            </details>
          )}
          {!how.canInstall && !fixed && (
            <div className="rounded-lg border bg-card p-3">
              <div className="text-small leading-relaxed text-muted-foreground">{how.why}</div>
              {status.steps.length > 0 && (
                <pre className="mt-2 overflow-x-auto whitespace-pre rounded-md bg-muted/60 p-2.5 font-mono text-caption leading-relaxed text-foreground">
                  {status.steps.join("\n")}
                </pre>
              )}
            </div>
          )}
          {how.canInstall && !latest.checksum && (
            <div className="text-small text-muted-foreground">{t("serverUpdate.thisReleasePublishesNoChecksum")}</div>
          )}
        </div>
      )}
    </SettingRow>
  );
}
