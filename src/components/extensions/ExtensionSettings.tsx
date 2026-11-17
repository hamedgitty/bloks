// Settings, Plugins, Extensions: installing one from a folder, what it
// was granted, switching it off, its settings, and taking it out
// (server/extensions.ts has the rules).
//
// Installing is two steps on purpose. Look reads the folder and says,
// in words, everything it asks for and everything wrong with it; Install
// sends back exactly what was shown, the files' hash and the list of
// permissions, and the server refuses if either is no longer true. An
// update is the same, with what it asks for that the installed one was
// not given said on its own.
import { useEffect, useState } from "react";
import { AlertTriangle, ChevronRight, Loader2, Puzzle, ShieldCheck, Trash2 } from "@/components/icons";
import { api, useStore } from "@/state/store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { BrowseFolderButton } from "@/components/ui/browse-folder";
import { confirm } from "@/components/ui/confirm";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import { loadExtensions, openPanel, type ExtensionInfo } from "@/lib/extensions";
import { BackLink } from "../McpServers";
import { extensionError, onExtensionErrors, runExtensionCommand } from "./ExtensionHost";
import { t } from "@/lib/i18n";

interface Inspected {
  ok: boolean;
  problems: string[];
  digest: string;
  files: number;
  bytes: number;
  manifest?: {
    id: string;
    name: string;
    version: string;
    description: string;
    author?: string;
    bloks: string;
    panels: Array<{ id: string; title: string }>;
    background: boolean;
    commands: Array<{ id: string; title: string }>;
    events: string[];
    settings: unknown[];
  };
  permissions?: ExtensionInfo["permissions"];
  installed?: { version: string; added: string[]; removed: string[] };
}

const field = "h-10 rounded-xl text-ui";
const label = "mb-1.5 block text-ui font-medium text-foreground";

/** What it asks for, one line each, the ones reaching past its own panel
 * marked. */
function PermissionList({ permissions, added }: { permissions: ExtensionInfo["permissions"]; added?: string[] }) {
  if (!permissions.length) return <p className="text-body text-muted-foreground">{t("extensions.noPermissions")}</p>;
  return (
    <ul className="flex flex-col gap-2">
      {permissions.map((p) => (
        <li key={p.id} className="flex items-start gap-2.5 text-body text-foreground">
          {p.high ? <AlertTriangle size={15} className="mt-0.5 shrink-0 text-warning" /> : <ShieldCheck size={15} className="mt-0.5 shrink-0 text-muted-foreground" />}
          <span className="min-w-0">
            {p.words}
            <span className="ml-1.5 font-mono text-small text-muted-foreground">{p.id}</span>
            {added?.includes(p.id) && <span className="ml-1.5 rounded-md bg-warning/15 px-1.5 py-0.5 text-small font-medium text-warning">{t("extensions.newInThisVersion")}</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** What it adds, in a line. */
function addsLine(m: { panels: unknown[]; commands: unknown[]; background: boolean; events: unknown[] }): string {
  const parts = [
    m.panels.length ? t("extensions.addsPanels", { count: m.panels.length }) : null,
    m.commands.length ? t("extensions.addsCommands", { count: m.commands.length }) : null,
    m.events.length ? t("extensions.addsEvents", { count: m.events.length }) : null,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : t("extensions.addsNothingVisible");
}

export function InstallExtensionDialog({
  open,
  onOpenChange,
  startPath,
  onInstalled,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** An installed one's folder, to look at again for an update. */
  startPath?: string;
  onInstalled?: (id: string) => void;
}) {
  const [path, setPath] = useState("");
  const [looked, setLooked] = useState<Inspected | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setPath(startPath ?? "");
    setLooked(null);
    setError(null);
  }, [open, startPath]);

  const look = (folder = path) => {
    if (!folder.trim()) return;
    setBusy(true);
    setError(null);
    setLooked(null);
    api("/api/extensions/inspect", { method: "POST", body: JSON.stringify({ path: folder.trim() }) })
      .then((r: Inspected) => setLooked(r))
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  };

  const install = () => {
    if (!looked?.ok || !looked.manifest) return;
    setBusy(true);
    setError(null);
    api("/api/extensions", {
      method: "POST",
      body: JSON.stringify({ path: path.trim(), digest: looked.digest, grant: (looked.permissions ?? []).map((p) => p.id) }),
    })
      .then((r: { extension: ExtensionInfo }) => {
        onOpenChange(false);
        void loadExtensions();
        toast(t(looked.installed ? "extensions.updated" : "extensions.installed", { name: r.extension.name }));
        onInstalled?.(r.extension.id);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  };

  const m = looked?.manifest;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[88vh] max-w-[580px] flex-col overflow-y-auto p-7">
        <DialogTitle className="text-heading font-semibold">{startPath ? t("extensions.updateTitle") : t("extensions.installTitle")}</DialogTitle>
        <p className="mt-1.5 text-pretty text-body leading-relaxed text-muted-foreground">{t("extensions.installLine")}</p>

        <div className="mt-6">
          <span className={label}>{t("extensions.folder")}</span>
          <div className="flex gap-2">
            <Input
              value={path}
              onChange={(e) => {
                setPath(e.target.value);
                setLooked(null);
              }}
              onKeyDown={(e) => e.key === "Enter" && look()}
              placeholder={t("extensions.folderPlaceholder")}
              className={cn(field, "flex-1 font-mono text-body")}
            />
            <BrowseFolderButton
              className="h-10"
              onPick={(picked) => {
                setPath(picked);
                look(picked);
              }}
            />
            <Button variant="outline" onClick={() => look()} disabled={!path.trim() || busy}>
              {t("extensions.look")}
            </Button>
          </div>
        </div>

        {looked && (
          <div className="mt-6 flex flex-col gap-5">
            {m && (
              <div className="flex items-start gap-3.5">
                <span className="flex size-12 shrink-0 items-center justify-center rounded-2xl border bg-background text-muted-foreground">
                  <Puzzle size={20} />
                </span>
                <span className="min-w-0">
                  <span className="block text-lead font-semibold text-foreground">{m.name}</span>
                  <span className="block text-body text-muted-foreground">
                    {[t("extensions.versionOf", { version: m.version }), m.author, m.id].filter(Boolean).join(" · ")}
                  </span>
                  {m.description && <span className="mt-1.5 block text-pretty text-body text-foreground">{m.description}</span>}
                  <span className="mt-1.5 block text-body text-muted-foreground">{addsLine(m)}</span>
                </span>
              </div>
            )}
            {looked.installed && (
              <p className="rounded-xl border bg-background px-4 py-3 text-body text-foreground">
                {t("extensions.replaces", { version: looked.installed.version })}
              </p>
            )}
            {looked.permissions && (
              <section>
                <h3 className="mb-2.5 text-ui font-semibold text-foreground">{t("extensions.itAsksTo")}</h3>
                <PermissionList permissions={looked.permissions} added={looked.installed?.added} />
              </section>
            )}
            <div className="flex items-start gap-2.5 rounded-xl border bg-background px-4 py-3 text-body leading-relaxed text-muted-foreground">
              <ShieldCheck size={15} className="mt-0.5 shrink-0" />
              <span>{t("extensions.sandboxLine")}</span>
            </div>
            {looked.problems.length > 0 && (
              <section className="rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3">
                <h3 className="mb-1.5 text-ui font-semibold text-destructive">{t("extensions.cannotInstall")}</h3>
                <ul className="list-disc pl-5 text-body text-destructive">
                  {looked.problems.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        )}

        {error && <p className="mt-4 text-body text-destructive">{error}</p>}

        <div className="mt-7 flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button onClick={install} disabled={!looked?.ok || busy}>
            {busy && <Loader2 size={14} className="animate-spin" />}
            {looked?.installed ? t("extensions.updateAndGrant") : t("extensions.installAndGrant")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** A row's line: what it is, or why it is not running. */
export function extensionLine(ext: ExtensionInfo): string {
  if (!ext.intact) return t("extensions.filesChanged");
  return ext.description || addsLine(ext);
}

/** One installed extension's page. */
export function ExtensionPage({ ext, onBack }: { ext: ExtensionInfo; onBack: () => void }) {
  const { dispatch } = useStore();
  const [updating, setUpdating] = useState(false);
  const [error, setError] = useState<string | undefined>(() => extensionError(ext.id));
  useEffect(() => onExtensionErrors(() => setError(extensionError(ext.id))), [ext.id]);

  const patch = (body: Record<string, unknown>) =>
    api(`/api/extensions/${ext.id}`, { method: "PATCH", body: JSON.stringify(body) })
      .then(() => loadExtensions())
      .catch((e: Error) => toast.error(e.message));

  const remove = async () => {
    const yes = await confirm({
      title: t("extensions.removeTitle", { name: ext.name }),
      body: t("extensions.removeBody"),
      confirmLabel: t("extensions.remove"),
      destructive: true,
    });
    if (!yes) return;
    api(`/api/extensions/${ext.id}`, { method: "DELETE" })
      .then(() => {
        toast(t("extensions.removed", { name: ext.name }));
        onBack();
        return loadExtensions();
      })
      .catch((e: Error) => toast.error(e.message));
  };

  return (
    <div>
      <BackLink onBack={onBack} />
      <header className="mt-6 flex flex-wrap items-start gap-4">
        <span className="flex size-14 shrink-0 items-center justify-center rounded-2xl border bg-background text-muted-foreground">
          <Puzzle size={22} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-display font-semibold text-foreground">{ext.name}</h2>
          <p className="mt-1 text-ui text-muted-foreground">
            {[t("extensions.versionOf", { version: ext.version }), ext.author, ext.id].filter(Boolean).join(" · ")}
          </p>
          {ext.description && <p className="mt-2 max-w-[560px] text-pretty text-ui text-foreground">{ext.description}</p>}
        </div>
        <label className="flex items-center gap-2.5 text-ui text-foreground">
          {ext.enabled ? t("pluginSettings.on") : t("common.off")}
          <Switch checked={ext.enabled} onCheckedChange={(on) => void patch({ enabled: on })} aria-label={t("extensions.switchOn", { name: ext.name })} />
        </label>
      </header>

      {!ext.intact && (
        <div className="mt-5 flex items-start gap-2.5 rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-body text-foreground">
          <AlertTriangle size={15} className="mt-0.5 shrink-0 text-warning" />
          {t("extensions.filesChangedLong")}
        </div>
      )}
      {error && ext.enabled && (
        <div className="mt-5 flex flex-wrap items-center gap-3 rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-body text-destructive">
          <span className="min-w-0 flex-1">{t("extensions.lastError", { error })}</span>
          <Button variant="outline" size="sm" onClick={() => void patch({ enabled: false })}>
            {t("extensions.switchOff")}
          </Button>
        </div>
      )}

      <div className="mt-6 flex flex-col gap-4">
        <section className="rounded-2xl border bg-card p-5">
          <h3 className="text-lead font-semibold text-foreground">{t("extensions.granted")}</h3>
          <p className="mt-1 text-pretty text-body text-muted-foreground">{t("extensions.sandboxLine")}</p>
          <div className="mt-4">
            <PermissionList permissions={ext.permissions} />
          </div>
        </section>

        {(ext.panels.length > 0 || ext.commands.length > 0) && (
          <section className="rounded-2xl border bg-card p-5">
            <h3 className="text-lead font-semibold text-foreground">{t("extensions.whatItAdds")}</h3>
            <div className="mt-3 divide-y">
              {ext.panels.map((p) => (
                <div key={p.id} className="flex items-center gap-3 py-2.5">
                  <span className="min-w-0 flex-1 text-body text-foreground">{t("extensions.panelNamed", { title: p.title })}</span>
                  <Button variant="outline" size="sm" disabled={!ext.enabled || !ext.intact} onClick={() => {
                      // in the dock of the conversation last on screen, which
                      // is where this takes you
                      openPanel(`${ext.id}/${p.id}`);
                      dispatch({ type: "toggleAppSettings", open: false });
                    }}>
                    {t("extensions.open")}
                  </Button>
                </div>
              ))}
              {ext.commands.map((c) => (
                <div key={c.id} className="flex items-center gap-3 py-2.5">
                  <span className="min-w-0 flex-1">
                    <span className="block text-body text-foreground">{t("extensions.commandNamed", { title: c.title })}</span>
                    {c.description && <span className="block text-small text-muted-foreground">{c.description}</span>}
                  </span>
                  <Button variant="outline" size="sm" disabled={!ext.enabled || !ext.intact} onClick={() => runExtensionCommand(ext, c.id)}>
                    {t("extensions.run")}
                  </Button>
                </div>
              ))}
            </div>
            {ext.events.length > 0 && <p className="mt-3 text-body text-muted-foreground">{t("extensions.hears", { events: ext.events.join(", ") })}</p>}
          </section>
        )}

        {ext.settings.length > 0 && (
          <section className="rounded-2xl border bg-card p-5">
            <h3 className="text-lead font-semibold text-foreground">{t("common.settings")}</h3>
            <p className="mt-1 text-pretty text-body text-muted-foreground">{t("extensions.settingsLine")}</p>
            <div className="mt-4 flex flex-col gap-4">
              {ext.settings.map((s) => (
                <SettingField key={s.key} setting={s} value={ext.values[s.key]} onSave={(value) => void patch({ settings: { [s.key]: value } })} />
              ))}
            </div>
          </section>
        )}

        <section className="rounded-2xl border bg-card p-5">
          <h3 className="text-lead font-semibold text-foreground">{t("extensions.whereFrom")}</h3>
          <p className="mt-1 break-all font-mono text-body text-muted-foreground">{ext.source.kind === "folder" ? ext.source.path : ext.source.url}</p>
          <div className="mt-4 flex flex-wrap gap-2">
            {ext.source.kind === "folder" && (
              <Button variant="outline" onClick={() => setUpdating(true)}>
                {t("extensions.lookForUpdate")}
              </Button>
            )}
            <Button variant="outline" onClick={() => void remove()} className="text-destructive">
              <Trash2 size={14} />
              {t("extensions.remove")}
            </Button>
          </div>
        </section>
      </div>
      <InstallExtensionDialog open={updating} onOpenChange={setUpdating} startPath={ext.source.kind === "folder" ? ext.source.path : undefined} />
    </div>
  );
}

function SettingField({
  setting,
  value,
  onSave,
}: {
  setting: ExtensionInfo["settings"][number];
  value: string | boolean | number | undefined;
  onSave: (value: string | boolean | number) => void;
}) {
  const [text, setText] = useState(String(value ?? setting.default));
  useEffect(() => setText(String(value ?? setting.default)), [value, setting.default]);
  if (setting.type === "boolean") {
    return (
      <label className="flex items-center justify-between gap-3 text-body text-foreground">
        {setting.label}
        <Switch checked={Boolean(value ?? setting.default)} onCheckedChange={(on) => onSave(on)} aria-label={setting.label} />
      </label>
    );
  }
  const commit = () => {
    if (setting.type === "number") {
      const n = Number(text);
      if (Number.isFinite(n) && n !== value) onSave(n);
      return;
    }
    if (text !== value) onSave(text);
  };
  return (
    <label>
      <span className={label}>{setting.label}</span>
      <Input
        value={text}
        inputMode={setting.type === "number" ? "decimal" : undefined}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && commit()}
        className={field}
      />
    </label>
  );
}

/** The aside of a row in the list. */
export function ExtensionRowAside({ ext, onOpen }: { ext: ExtensionInfo; onOpen: () => void }) {
  return (
    <button onClick={onOpen} aria-label={t("pluginSettings.pluginSettingsLabel", { plugin: ext.name })} className="flex shrink-0 items-center gap-2 text-body text-muted-foreground">
      {!ext.intact ? t("extensions.stopped") : ext.enabled ? t("pluginSettings.on") : t("common.off")}
      <ChevronRight size={16} />
    </button>
  );
}
