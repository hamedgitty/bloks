// Settings, About and updates: which Bloks this is, the way to the next
// one, and the two ways to tell us something is wrong. Where the app is a
// window onto a workspace server on another computer, that server's
// version and its own way to the next one are said apart from the app's
// (ServerUpdate.tsx).
import { useEffect, useState } from "react";
import { Check } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { useStore } from "@/state/store";
import type { UpdateState } from "@/types/bridge";
import { drainingLine } from "../UpdateCard";
import { SettingRow, SettingsGroup } from "../SettingsLayout";
import { ServerUpdateRow, useServerUpdate } from "./ServerUpdate";
import { t } from "@/lib/i18n";
import { yourComputer } from "@/lib/thisComputer";

/** The small mark a hosted workspace wears in Settings, so nobody wonders
 * why the Mac's own options are not there. */
export function HostedMark() {
  return (
    <span className="inline-flex items-center rounded-md bg-muted px-1.5 py-0.5 text-caption font-medium text-muted-foreground">
      {t("aboutPage.hosted")}
    </span>
  );
}

/**
 * What version this is, and the way to the next one.
 *
 * The updater already runs on its own at launch; this card exists so a
 * person can ask instead of waiting, watch the download when there is
 * one, and restart into it the moment it is ready. In a plain browser
 * tab there is no updater and the card says only what it knows.
 */
export function AboutPage() {
  const { state } = useStore();
  const hosted = Boolean(state.config?.hosted?.on);
  const [version, setVersion] = useState<string | null>(null);
  const [update, setUpdate] = useState<UpdateState>({ state: "idle" });
  // the workspace server, when it is not the one inside this app
  const server = useServerUpdate();
  const apart = server.view.kind === "status" || server.view.kind === "older";
  const bridge = Boolean(window.bloks?.appVersion);
  const serverVersion =
    server.view.kind === "status" ? server.view.status.version : server.view.kind === "older" ? server.view.version : null;
  // the issue's own words, in English for whoever reads the report
  const serverLine = serverVersion ? `, workspace server Bloks ${serverVersion}` : "";

  useEffect(() => {
    // A window without the desktop app (a hosted workspace in a browser)
    // has no app to ask, so the server says which build it runs.
    if (!window.bloks?.appVersion) {
      void fetch("/api/health")
        .then((r) => r.json())
        .then((health: { version?: string }) => setVersion(health.version || null))
        .catch(() => {});
    }
    void window.bloks?.appVersion?.().then(setVersion);
    void window.bloks?.updateState?.().then(setUpdate);
    return window.bloks?.onUpdateState?.(setUpdate);
  }, []);

  const line =
    update.state === "checking"
      ? t("common.checking")
      : update.state === "downloading"
        ? update.version
          ? update.percent
            ? t("aboutPage.downloadingVersionPercent", { version: update.version, percent: update.percent })
            : t("aboutPage.downloadingVersion", { version: update.version })
          : update.percent
            ? t("aboutPage.downloadingUpdatePercent", { percent: update.percent })
            : t("aboutPage.downloadingUpdate")
        : update.state === "current"
          ? t("aboutPage.latest")
          : update.state === "ready"
            ? update.draining
              ? drainingLine(update.draining)
              : update.version
                ? t("aboutPage.versionReady", { version: update.version })
                : t("aboutPage.updateReady")
            : update.state === "error"
              ? update.reason === "install"
                ? t("aboutPage.error.install")
                : update.reason === "server"
                  ? t("aboutPage.error.server")
                  : t("aboutPage.error.unreachable")
              : update.state === "dev"
                ? t("aboutPage.devBuild")
                : null;
  // a restart into an update that came back on the same version says so
  // before whatever the updater is doing now
  const said = update.notInstalled
    ? line
      ? t("aboutPage.notInstalledThen", { line })
      : t("aboutPage.notInstalled")
    : (line ?? t("aboutPage.updatesOnTheirOwn"));
  // beside a server of its own, which this updater never touches
  const description = apart ? t("aboutPage.appNotServer", { said }) : said;

  return (
    <>
    <SettingsGroup title={t("aboutPage.version")}>
      {hosted && (
        <SettingRow
          label={
            <>
              {t("aboutPage.thisWorkspace")} <HostedMark />
            </>
          }
          description={t("aboutPage.itRunsOnAMachine", { computer: yourComputer() })}
        />
      )}
      {/* A browser has no app of its own to update; the server row below
          says which Bloks it reaches. */}
      {(bridge || !apart) && (
        <SettingRow
          rowId="check-for-updates"
          label={apart ? t("aboutPage.thisAppVersion", { version: version ?? "" }) : `Bloks ${version ?? ""}`}
          description={description}
          control={
            update.state === "ready" ? (
              <Button size="sm" disabled={Boolean(update.draining)} onClick={() => void window.bloks?.updateInstall?.()}>
                {t("aboutPage.restartToUpdate")}
              </Button>
            ) : (
              <Button
                size="sm"
                variant="secondary"
                disabled={!window.bloks || update.state === "checking" || update.state === "downloading"}
                onClick={() => void window.bloks?.updateCheck?.().then(setUpdate)}
              >
                {t("aboutPage.checkForUpdates")}
              </Button>
            )
          }
        />
      )}
      <ServerUpdateRow state={server} />
    </SettingsGroup>
    <SettingsGroup title={t("aboutPage.help")}>
      <SettingRow
        label={t("aboutPage.somethingBrokenOrMissing")}
        description={t("aboutPage.opensAGithubIssue")}
        control={
          <Button size="sm" variant="secondary" asChild>
            <a
              href={`https://github.com/hamedgitty/bloks/issues/new?body=${encodeURIComponent(`\n\n---\nBloks ${version ?? ""} on ${navigator.platform}${serverLine}`)}`}
              target="_blank"
              rel="noreferrer"
            >
              {t("aboutPage.sendFeedback")}
            </a>
          </Button>
        }
      />
      <Diagnostics />
    </SettingsGroup>
    </>
  );
}

/**
 * One button between "it doesn't work" and a useful bug report. The
 * server assembles the facts (versions, engine states, which
 * credentials exist as booleans, never values) and this copies them,
 * ready to paste into a GitHub issue.
 */
function Diagnostics() {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const copy = async () => {
    try {
      const report = await fetch("/api/diagnostics").then((r) => {
        if (!r.ok) throw new Error();
        return r.text();
      });
      await navigator.clipboard.writeText(report);
      setFailed(false);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      setFailed(true);
    }
  };
  return (
    <SettingRow
      label={t("aboutPage.diagnostics")}
      info={t("aboutPage.versionsConnectionStatesWhichKeys")}
      description={t("aboutPage.aShortReportToPaste")}
      error={failed ? t("aboutPage.reportFailed") : null}
      control={
        <Button size="sm" variant="secondary" onClick={() => void copy()} className="min-w-[128px]">
          {copied ? (
            <>
              <Check size={14} /> {t("common.copied")}
            </>
          ) : (
            t("aboutPage.copyDiagnostics")
          )}
        </Button>
      }
    />
  );
}
