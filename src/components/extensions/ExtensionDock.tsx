// Extension panels, beside the chat (GitHub 507, and 524's "Apps" dock).
//
// The header's puzzle piece opens it when a running extension has a
// panel. Each panel is a tab; a panel opened once stays mounted while the
// window is open, hidden when another is shown, so switching keeps its
// state. Every panel is an ExtensionFrame: its own sandbox, its own
// origin, no network, talking only to the page.
import { Puzzle, RotateCw, X } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { openPanel, running, setDock, useDock, useExtensions, type ExtensionInfo } from "@/lib/extensions";
import { useState } from "react";
import { ExtensionFrame } from "./ExtensionHost";
import { t } from "@/lib/i18n";

interface PanelRef {
  key: string;
  ext: ExtensionInfo;
  id: string;
  title: string;
}

function panelsOf(list: ExtensionInfo[] | null): PanelRef[] {
  return running(list).flatMap((ext) => ext.panels.map((p) => ({ key: `${ext.id}/${p.id}`, ext, id: p.id, title: p.title })));
}

/** The header's button, shown when there is a panel to open. */
export function ExtensionDockButton() {
  const list = useExtensions();
  const dock = useDock();
  const panels = panelsOf(list);
  if (!panels.length) return null;
  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={() => (dock.open ? setDock({ open: false }) : openPanel(dock.shown && panels.some((p) => p.key === dock.shown) ? dock.shown : panels[0].key))}
      className={cn(dock.open && "bg-accent text-foreground")}
      title={t("extensions.panels")}
      aria-label={t("extensions.panels")}
      aria-pressed={dock.open}
    >
      <Puzzle size={17} />
    </Button>
  );
}

export function ExtensionDock() {
  const list = useExtensions();
  const dock = useDock();
  // bumped to load a panel again from the start
  const [fresh, setFresh] = useState<Record<string, number>>({});
  const panels = panelsOf(list);
  if (!dock.open || !panels.length) return null;
  const shown = panels.find((p) => p.key === dock.shown) ?? panels[0];
  const kept = panels.filter((p) => dock.kept.includes(p.key) || p.key === shown.key);
  return (
    <aside aria-label={t("extensions.panels")} className="flex min-h-0 w-[380px] shrink-0 flex-col border-l bg-card max-md:absolute max-md:inset-0 max-md:z-30 max-md:w-auto max-md:border-l-0">
      <div className="flex h-[42px] shrink-0 items-center gap-1 border-b px-2">
        <div role="tablist" className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {panels.map((p) => (
            <button
              key={p.key}
              role="tab"
              aria-selected={p.key === shown.key}
              onClick={() => openPanel(p.key)}
              title={`${p.title} · ${p.ext.name}`}
              className={cn(
                "flex h-7 shrink-0 items-center rounded-lg px-2.5 text-body font-medium transition-colors duration-150",
                p.key === shown.key ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              <span className="max-w-[160px] truncate">{p.title}</span>
            </button>
          ))}
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => setFresh((was) => ({ ...was, [shown.key]: (was[shown.key] ?? 0) + 1 }))}
          aria-label={t("extensions.reloadPanel")}
          title={t("extensions.reloadPanel")}
        >
          <RotateCw size={13} />
        </Button>
        <Button variant="ghost" size="icon-sm" onClick={() => setDock({ open: false })} aria-label={t("common.close")} title={t("common.close")}>
          <X size={15} />
        </Button>
      </div>
      <div className="relative min-h-0 flex-1">
        {kept.map((p) => (
          <div key={`${p.key}:${p.ext.updatedAt}:${fresh[p.key] ?? 0}`} className={cn("absolute inset-0", p.key !== shown.key && "invisible")}>
            <ExtensionFrame ext={p.ext} which={p.id} title={p.title} />
          </div>
        ))}
      </div>
      <div className="shrink-0 border-t px-3 py-2 text-small leading-relaxed text-muted-foreground">
        {t("extensions.panelFooter", { name: shown.ext.name })}
      </div>
    </aside>
  );
}
