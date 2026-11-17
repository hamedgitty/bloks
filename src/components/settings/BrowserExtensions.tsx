// Settings, Browser, Chrome extensions (GitHub 510): unpacked extensions
// in this workspace's Bloks browser, and in nothing else of the app.
//
// Adding one starts at the system's own folder window, and before it is
// added the owner sees what it is, the sites it reaches, and what of it
// works here and what does not (electron/browser-extensions.mjs reads
// that from its manifest). The desktop app only: the browser's session is
// the app's, and a phone or a browser tab has none to load one into.
import { useEffect, useState } from "react";
import { AlertTriangle, Check, Loader2, Trash2 } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { confirm } from "@/components/ui/confirm";
import { toast } from "@/components/ui/toast";
import { hostsLine, type BrowserExtensionLook, type BrowserExtensionRow, type Compatibility } from "@/lib/browserExtensions";
import { SettingRow, SettingsGroup } from "../SettingsLayout";
import { t } from "@/lib/i18n";

function Fit({ compatibility }: { compatibility: Compatibility }) {
  return (
    <div className="flex flex-col gap-3">
      {compatibility.works.length > 0 && (
        <div>
          <h4 className="mb-1 text-body font-medium text-foreground">{t("browserExtensions.works")}</h4>
          <ul className="flex flex-col gap-1">
            {compatibility.works.map((line) => (
              <li key={line} className="flex items-start gap-2 text-body text-muted-foreground">
                <Check size={14} className="mt-0.5 shrink-0 text-success" />
                {line}
              </li>
            ))}
          </ul>
        </div>
      )}
      {compatibility.missing.length > 0 && (
        <div>
          <h4 className="mb-1 text-body font-medium text-foreground">{t("browserExtensions.doesNotWork")}</h4>
          <ul className="flex flex-col gap-1">
            {compatibility.missing.map((line) => (
              <li key={line} className="flex items-start gap-2 text-body text-muted-foreground">
                <AlertTriangle size={14} className="mt-0.5 shrink-0 text-warning" />
                {line}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

const verdictWords = (c: Compatibility) =>
  c.verdict === "works" ? t("browserExtensions.verdict.works") : c.verdict === "partly" ? t("browserExtensions.verdict.partly") : t("browserExtensions.verdict.unlikely");

function Hosts({ hosts }: { hosts: readonly string[] }) {
  const line = hostsLine(hosts);
  if (!hosts.length) return <p className="text-body text-muted-foreground">{t("browserExtensions.noSites")}</p>;
  return (
    <p className="text-body text-foreground">
      {line.all ? t("browserExtensions.everySite") : t("browserExtensions.theseSites", { sites: line.shown.join(", ") })}
      {line.more > 0 && <span className="text-muted-foreground"> {t("browserExtensions.andMore", { count: line.more })}</span>}
    </p>
  );
}

export function BrowserExtensionsSection() {
  const bridge = window.bloks?.browserExtensions;
  const [rows, setRows] = useState<BrowserExtensionRow[] | null>(null);
  const [looked, setLooked] = useState<BrowserExtensionLook | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void bridge?.list().then(setRows).catch(() => setRows([]));
  }, [bridge]);

  if (!bridge) return null;
  const act = (run: () => Promise<BrowserExtensionRow[]>): Promise<void> =>
    run()
      .then(setRows)
      .catch((e: Error) => {
        toast.error(e.message);
      });

  return (
    <SettingsGroup title={t("browserExtensions.title")} footnote={t("browserExtensions.footnote")}>
      {rows === null ? (
        <p className="px-5 py-4 text-body text-muted-foreground">{t("common.loading2")}</p>
      ) : rows.length === 0 ? (
        <p className="px-5 py-4 text-body text-muted-foreground">{t("browserExtensions.none")}</p>
      ) : (
        rows.map((row) => (
          <SettingRow
            key={row.slug}
            label={`${row.name} ${row.version}`}
            description={row.problem ?? (row.compatibility ? verdictWords(row.compatibility) : undefined)}
            control={
              <div className="flex items-center gap-2">
                <Switch
                  checked={row.enabled}
                  onCheckedChange={(on) => void act(() => bridge.setEnabled(row.slug, on))}
                  aria-label={t("browserExtensions.switch", { name: row.name })}
                />
                <button
                  type="button"
                  aria-label={t("browserExtensions.remove", { name: row.name })}
                  title={t("browserExtensions.remove", { name: row.name })}
                  onClick={() =>
                    void confirm({
                      title: t("browserExtensions.removeTitle", { name: row.name }),
                      body: t("browserExtensions.removeBody"),
                      confirmLabel: t("extensions.remove"),
                      destructive: true,
                    }).then((yes) => {
                      if (yes) void act(() => bridge.remove(row.slug));
                    })
                  }
                  className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            }
          />
        ))
      )}
      <div className="px-5 py-3">
        <Button
          size="sm"
          variant="secondary"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void bridge
              .pick()
              .then((look) => look && setLooked(look))
              .finally(() => setBusy(false));
          }}
        >
          {busy && <Loader2 size={13} className="animate-spin" />}
          {t("browserExtensions.add")}
        </Button>
      </div>

      <Dialog open={looked !== null} onOpenChange={(open) => !open && setLooked(null)}>
        <DialogContent className="flex max-h-[88vh] max-w-[560px] flex-col overflow-y-auto p-7">
          <DialogTitle className="text-heading font-semibold">{looked?.info ? looked.info.name : t("browserExtensions.add")}</DialogTitle>
          {looked?.error ? (
            <p className="mt-4 text-body text-destructive">{looked.error}</p>
          ) : looked?.info && looked.compatibility ? (
            <div className="mt-4 flex flex-col gap-5">
              <p className="text-body text-muted-foreground">
                {t("browserExtensions.identity", { version: looked.info.version, manifest: String(looked.info.manifestVersion ?? "?") })}
              </p>
              {looked.info.description && <p className="text-pretty text-body text-foreground">{looked.info.description}</p>}
              <section>
                <h3 className="mb-1.5 text-ui font-semibold text-foreground">{t("browserExtensions.readsAndChanges")}</h3>
                <Hosts hosts={looked.info.hosts} />
              </section>
              {looked.info.permissions.length > 0 && (
                <section>
                  <h3 className="mb-1.5 text-ui font-semibold text-foreground">{t("browserExtensions.permissions")}</h3>
                  <p className="font-mono text-body text-muted-foreground">{looked.info.permissions.join(", ")}</p>
                </section>
              )}
              <section>
                <h3 className="mb-1.5 text-ui font-semibold text-foreground">{verdictWords(looked.compatibility)}</h3>
                <Fit compatibility={looked.compatibility} />
              </section>
              <div className="flex items-start gap-2.5 rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-body text-foreground">
                <AlertTriangle size={15} className="mt-0.5 shrink-0 text-warning" />
                {t("browserExtensions.warning")}
              </div>
            </div>
          ) : null}
          <div className="mt-7 flex items-center justify-end gap-2">
            <Button variant="ghost" onClick={() => setLooked(null)}>
              {t("common.cancel")}
            </Button>
            <Button
              disabled={!looked?.info}
              onClick={() => {
                const path = looked?.path;
                setLooked(null);
                if (path) void act(() => bridge.add(path)).then(() => toast(t("browserExtensions.added")));
              }}
            >
              {t("browserExtensions.addToBrowser")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </SettingsGroup>
  );
}
