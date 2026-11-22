// Settings, Browser, Chrome extensions (GitHub 510): unpacked extensions
// in this workspace's Bloks browser, and in nothing else of the app.
//
// Before one is added the owner sees what it is, the sites it reaches,
// and what of it works here and what does not (server/browser-extensions.mjs
// reads that from its manifest). Where the browser is decides the rest:
//
//   The desktop app's own browser, for a workspace the app runs: adding
//   starts at the system's own folder window, through the app's bridge.
//
//   A server's own headless Chrome: the folder is sent from this device
//   to the server, file by file, read there for the same review, and kept
//   only on the owner's yes (server/browser-extension-routes.ts). From the
//   desktop app or the server's own page alike.
//
// A phone, or a browser tab on a workspace the desktop app runs, has no
// browser to load one into, and shows none of this.
import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, Loader2, Trash2 } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { confirm } from "@/components/ui/confirm";
import { toast } from "@/components/ui/toast";
import { hostsLine, folderPath, type BrowserExtensionLook, type BrowserExtensionRow, type Compatibility } from "@/lib/browserExtensions";
import { api } from "@/state/store";
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

/** The list, and how it changes, wherever the browser is. */
interface ExtensionStore {
  list(): Promise<BrowserExtensionRow[]>;
  setEnabled(slug: string, enabled: boolean): Promise<BrowserExtensionRow[]>;
  remove(slug: string): Promise<BrowserExtensionRow[]>;
  /** Keeps what was looked at: a folder the app picked, or what was sent
   * to the server, by the `path` its look answered. */
  add(path: string): Promise<BrowserExtensionRow[]>;
  /** Lets go of what was looked at and not added. */
  drop?(path: string): void;
}

function appStore(): ExtensionStore | null {
  const bridge = window.bloks?.browserExtensions;
  if (!bridge) return null;
  return { list: () => bridge.list(), setEnabled: (slug, on) => bridge.setEnabled(slug, on), remove: (slug) => bridge.remove(slug), add: (path) => bridge.add(path) };
}

const rowsOf = (said: unknown) => (said as { extensions?: BrowserExtensionRow[] }).extensions ?? [];
const one = (slug: string) => `/api/browser/extensions/${encodeURIComponent(slug)}`;

const serverStore: ExtensionStore = {
  list: () => api("/api/browser/extensions").then(rowsOf),
  setEnabled: (slug, enabled) => api(one(slug), { method: "PATCH", body: JSON.stringify({ enabled }) }).then(rowsOf),
  remove: (slug) => api(one(slug), { method: "DELETE" }).then(rowsOf),
  add: (staging) => api("/api/browser/extensions", { method: "POST", body: JSON.stringify({ staging }) }).then(rowsOf),
  drop: (staging) => void api(`/api/browser/extensions/staging/${staging}`, { method: "DELETE" }).catch(() => {}),
};

/** The server's own limits, checked here first so a folder too big is
 * not sent at all. */
const MAX_FILES = 5_000;
const MAX_BYTES = 100 * 1024 * 1024;

/**
 * A folder the person chose on this device, sent to the server file by
 * file, a few at a time, and read there: what comes back is the look the
 * review shows, its `path` naming what was sent.
 */
async function sendFolder(files: readonly File[], progress: (done: number, total: number) => void): Promise<BrowserExtensionLook> {
  if (files.length > MAX_FILES) throw new Error(t("browserExtensions.tooManyFiles", { max: MAX_FILES }));
  if (files.reduce((sum, f) => sum + f.size, 0) > MAX_BYTES) throw new Error(t("browserExtensions.tooBig"));
  const { id } = (await api("/api/browser/extensions/staging", { method: "POST" })) as { id: string };
  const queue = files.map((file) => ({ file, path: folderPath((file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name) }));
  let done = 0;
  const worker = async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      if (!next.path) continue;
      await api(`/api/browser/extensions/staging/${id}/files?path=${encodeURIComponent(next.path)}`, {
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
        body: next.file,
      });
      progress(++done, files.length);
    }
  };
  try {
    await Promise.all([worker(), worker(), worker(), worker()]);
  } catch (error) {
    serverStore.drop?.(id);
    throw error;
  }
  return (await api(`/api/browser/extensions/staging/${id}/look`, { method: "POST" })) as BrowserExtensionLook;
}

export function BrowserExtensionsSection({ home }: { home: "own" | "server" }) {
  const onServer = home === "server";
  const [store] = useState<ExtensionStore | null>(() => (onServer ? serverStore : appStore()));
  const [rows, setRows] = useState<BrowserExtensionRow[] | null>(null);
  const [looked, setLooked] = useState<BrowserExtensionLook | null>(null);
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState<{ done: number; total: number } | null>(null);
  const folderInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void store?.list().then(setRows).catch(() => setRows([]));
  }, [store]);

  if (!store) return null;
  const act = (run: () => Promise<BrowserExtensionRow[]>): Promise<void> =>
    run()
      .then(setRows)
      .catch((e: Error) => {
        toast.error(e.message);
      });
  const pick = () => {
    if (onServer) return folderInput.current?.click();
    const bridge = window.bloks?.browserExtensions;
    if (!bridge) return;
    setBusy(true);
    void bridge
      .pick()
      .then((look) => look && setLooked(look))
      .finally(() => setBusy(false));
  };
  const sent = (files: File[]) => {
    if (!files.length) return;
    setBusy(true);
    setSending({ done: 0, total: files.length });
    void sendFolder(files, (done, total) => setSending({ done, total }))
      .then(setLooked)
      .catch((e: Error) => toast.error(e.message))
      .finally(() => {
        setBusy(false);
        setSending(null);
      });
  };
  const dismiss = (keep: boolean) => {
    const path = looked?.path;
    setLooked(null);
    if (!keep && onServer && path) store.drop?.(path);
  };

  return (
    <SettingsGroup title={t("browserExtensions.title")} footnote={onServer ? t("browserExtensions.footnoteServer") : t("browserExtensions.footnote")}>
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
                  onCheckedChange={(on) => void act(() => store.setEnabled(row.slug, on))}
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
                      if (yes) void act(() => store.remove(row.slug));
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
      <div className="flex items-center gap-3 px-5 py-3">
        <Button size="sm" variant="secondary" disabled={busy} onClick={pick}>
          {busy && <Loader2 size={13} className="animate-spin" />}
          {t("browserExtensions.add")}
        </Button>
        {sending && <span className="text-small tabular-nums text-muted-foreground">{t("browserExtensions.sending", { done: sending.done, total: sending.total })}</span>}
        {onServer && (
          <input
            ref={folderInput}
            type="file"
            multiple
            hidden
            {...{ webkitdirectory: "" }}
            onChange={(e) => {
              const files = [...(e.currentTarget.files ?? [])];
              e.currentTarget.value = "";
              sent(files);
            }}
          />
        )}
      </div>

      <Dialog open={looked !== null} onOpenChange={(open) => !open && dismiss(false)}>
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
            <Button variant="ghost" onClick={() => dismiss(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              disabled={!looked?.info}
              onClick={() => {
                const path = looked?.path;
                dismiss(true);
                if (path) void act(() => store.add(path)).then(() => toast(onServer ? t("browserExtensions.addedServer") : t("browserExtensions.added")));
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
