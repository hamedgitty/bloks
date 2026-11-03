// Settings, Browser: which sites agents may use in the Bloks browser,
// and whether a new one asks first.
//
// The rules are the workspace's own and live on its server
// (server/app-browser.ts), so this page reads and changes them from any
// of the person's devices. The browser itself, its downloads and its
// sign-ins are the desktop app's when the app runs the workspace, and
// those rows show only there; a server that keeps the browser itself
// shows them on every device the person uses.
import { useEffect, useState } from "react";
import { api } from "@/state/store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import { confirm } from "@/components/ui/confirm";
import { toast } from "@/components/ui/toast";
import { X } from "@/components/icons";
import { browserIsHere } from "@/lib/appBrowser";
import { SavedMark, SettingRow, SettingsGroup, SettingsSkeleton } from "../SettingsLayout";
import { t } from "@/lib/i18n";

interface Settings {
  mode: "ask" | "auto";
  allow: string[];
  deny: string[];
}

export function BrowserPage() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [folder, setFolder] = useState("");
  // whose browser the last rows are about: the app's here, the server's,
  // or neither for this page
  const [home, setHome] = useState<"own" | "server" | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api("/api/browser/settings")
      .then(async (said: { settings: Settings; downloads: string; where?: string }) => {
        setSettings(said.settings);
        setFolder(said.downloads);
        setHome(said.where === "server" ? "server" : (await browserIsHere()) ? "own" : null);
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  const save = async (patch: Partial<Settings>) => {
    try {
      const said = (await api("/api/browser/settings", { method: "PUT", body: JSON.stringify(patch) })) as { settings: Settings };
      setSettings(said.settings);
      setError(null);
      setSaved(true);
      setTimeout(() => setSaved(false), 1600);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    }
  };

  const chooseMode = async (mode: Settings["mode"]) => {
    if (!settings || mode === settings.mode) return;
    // letting agents go anywhere is a widening, and asks who is there
    if (mode === "auto" && window.bloks?.authConfirm) {
      const answer = await window.bloks.authConfirm(t("browserPage.confirmAuto"));
      if (answer === "denied" || answer === "cancelled") return;
    }
    void save({ mode });
  };

  if (error && !settings) return <p className="text-body text-destructive">{error}</p>;
  if (!settings) return <SettingsSkeleton rows={3} label={t("browserPage.loadingBrowserSettings")} />;

  return (
    <>
      <SettingsGroup
        title={t("browserPage.whenAnAgentOpensA")}
        footnote={t("browserPage.typingAPasswordOrA")}
      >
        <SettingRow
          label={t("browserPage.asks")}
          description={
            settings.mode === "ask"
              ? t("browserPage.aSiteThatIsNot")
              : t("browserPage.anySiteButTheOnes")
          }
          control={
            <div className="flex items-center gap-2">
              <SavedMark on={saved} />
              <Segmented
                aria-label={t("browserPage.whenAnAgentOpensA")}
                value={settings.mode}
                onChange={(mode) => void chooseMode(mode)}
                options={[
                  { value: "ask", label: t("browserPage.askFirst") },
                  { value: "auto", label: t("browserPage.auto") },
                ]}
              />
            </div>
          }
        />
      </SettingsGroup>

      <SiteList
        title={t("browserPage.sitesAgentsMayUse")}
        addLabel={t("browserPage.addToAllowed")}
        empty={t("browserPage.noneYetPressAlwaysAllow")}
        sites={settings.allow}
        onChange={(allow) => save({ allow })}
        footnote={settings.mode === "auto" ? t("browserPage.inAutoEverySiteIs") : t("browserPage.aSiteCoversItsSubdomains")}
      />
      <SiteList
        title={t("browserPage.sitesAgentsNeverUse")}
        addLabel={t("browserPage.addToBlocked")}
        empty={t("browserPage.noneAgentsMayBeAsked")}
        sites={settings.deny}
        onChange={(deny) => save({ deny })}
        footnote={t("browserPage.blockedBeatsAllowedAPage")}
      />
      {error && (
        <p role="alert" className="-mt-6 mb-9 px-1 text-small text-destructive">
          {error}
        </p>
      )}

      {home && (
        <SettingsGroup
          title={t("browserPage.thisWorkspacesBrowser")}
          footnote={home === "server" ? t("browserPage.itRunsOnTheServer") : t("browserPage.itsSignInsAreThis")}
        >
          <SettingRow
            label={t("browserPage.downloads")}
            description={<span className="break-all">{folder}</span>}
            control={
              home === "own" ? (
                <Button size="sm" variant="secondary" onClick={() => void window.bloks?.browserDo?.("openDownloads")}>
                  {t("common.open")}
                </Button>
              ) : undefined
            }
          />
          <SettingRow
            label={t("browserPage.signOutOfEverySite")}
            description={t("browserPage.clearsTheCookiesSavedSign")}
            control={
              <Button
                size="sm"
                variant="destructive"
                onClick={() =>
                  void confirm({
                    title: t("browserPage.signOutTitle"),
                    body: t("browserPage.signOutBody"),
                    confirmLabel: t("browserPage.signOut"),
                    destructive: true,
                  }).then(async (yes) => {
                    if (!yes) return;
                    const said =
                      home === "server"
                        ? await api("/api/browser/do", { method: "POST", body: JSON.stringify({ action: "forgetSites" }) }).catch((e: Error) => ({ error: e.message }))
                        : await window.bloks?.browserDo?.("forgetSites");
                    if (said?.error) toast.error(said.error);
                    else toast.success(t("browserPage.signedOut"));
                  })
                }
              >
                {t("browserPage.signOut")}
              </Button>
            }
          />
        </SettingsGroup>
      )}
    </>
  );
}

function SiteList({
  title,
  addLabel,
  empty,
  sites,
  onChange,
  footnote,
}: {
  title: string;
  /** The add field's name, said whole rather than built from the title. */
  addLabel: string;
  empty: string;
  sites: string[];
  onChange: (sites: string[]) => Promise<boolean>;
  footnote: string;
}) {
  const [adding, setAdding] = useState("");
  const add = async () => {
    const site = adding.trim();
    if (!site) return;
    if (await onChange([...sites, site])) setAdding("");
  };
  return (
    <SettingsGroup title={title} footnote={footnote}>
      {sites.length === 0 ? (
        <p className="px-5 py-4 text-body text-muted-foreground">{empty}</p>
      ) : (
        <ul className="divide-y">
          {sites.map((site) => (
            <li key={site} className="flex items-center gap-3 px-5 py-2.5">
              <span className="min-w-0 flex-1 truncate text-ui text-foreground">{site}</span>
              <button
                type="button"
                aria-label={t("browserPage.removeSite", { site })}
                title={t("browserPage.removeSite", { site })}
                onClick={() => void onChange(sites.filter((s) => s !== site))}
                className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground"
              >
                <X size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="flex items-center gap-2 px-5 py-3"
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <Input
          value={adding}
          onChange={(e) => setAdding(e.target.value)}
          placeholder="example.com"
          aria-label={addLabel}
          spellCheck={false}
          autoCapitalize="off"
          className="h-8 flex-1"
        />
        <Button size="sm" variant="secondary" type="submit" disabled={!adding.trim()}>
          {t("common.add")}
        </Button>
      </form>
    </SettingsGroup>
  );
}
