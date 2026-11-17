// Extension panels, as one panel of the side dock (GitHub 507, and 524's
// panels for sidecars; dock/SideDock.tsx and src/lib/dock.ts have the
// dock).
//
// The ribbon has one puzzle piece while any running extension has a
// panel. It opens, hides and is remembered per conversation like the
// dock's other panels; inside it, each extension panel is a tab. A panel
// opened once stays mounted while the window is open, hidden when
// another is in front, so switching keeps its state. Every panel is an
// ExtensionFrame: its own sandbox, its own origin, no network, talking
// only to the page.
import { useState } from "react";
import { Puzzle, RotateCw } from "@/components/icons";
import { HeaderButton } from "@/components/terminal/TerminalMenus";
import { cn } from "@/lib/cn";
import { running, showExtensionPanel, useExtensionPanels, useExtensions, type ExtensionInfo } from "@/lib/extensions";
import type { DockPane } from "../dock/SideDock";
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

/** The dock's extensions panel, for a conversation to offer; null while
 * no running extension has a panel, and then the ribbon has no icon. */
export function useExtensionsPane(): DockPane | null {
  const list = useExtensions();
  const panels = panelsOf(list);
  if (!panels.length) return null;
  return {
    id: "extensions",
    label: t("extensions.panels"),
    icon: <Puzzle size={15} />,
    // their documents keep what they hold while another panel is in front
    keepAlive: true,
    render: () => <ExtensionPanels panels={panels} />,
  };
}

function ExtensionPanels({ panels }: { panels: PanelRef[] }) {
  const { shown: picked, kept } = useExtensionPanels();
  // bumped to load a panel again from the start
  const [fresh, setFresh] = useState<Record<string, number>>({});
  const shown = panels.find((p) => p.key === picked) ?? panels[0];
  const mounted = panels.filter((p) => kept.includes(p.key) || p.key === shown.key);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-[34px] shrink-0 items-center gap-1 border-b px-1.5">
        <div role="tablist" aria-label={t("extensions.panels")} className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {panels.map((p) => (
            <button
              key={p.key}
              role="tab"
              aria-selected={p.key === shown.key}
              onClick={() => showExtensionPanel(p.key)}
              title={`${p.title} · ${p.ext.name}`}
              className={cn(
                "flex h-6 shrink-0 items-center rounded-md px-2 text-small font-medium transition-colors duration-150",
                p.key === shown.key ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              <span className="max-w-[160px] truncate">{p.title}</span>
            </button>
          ))}
        </div>
        <HeaderButton label={t("extensions.reloadPanel")} onClick={() => setFresh((was) => ({ ...was, [shown.key]: (was[shown.key] ?? 0) + 1 }))}>
          <RotateCw size={13} />
        </HeaderButton>
      </div>
      <div className="relative min-h-0 flex-1">
        {mounted.map((p) => (
          <div key={`${p.key}:${p.ext.updatedAt}:${fresh[p.key] ?? 0}`} className={cn("absolute inset-0", p.key !== shown.key && "invisible")}>
            <ExtensionFrame ext={p.ext} which={p.id} title={p.title} />
          </div>
        ))}
      </div>
      <div className="shrink-0 border-t px-3 py-2 text-small leading-relaxed text-muted-foreground">
        {t("extensions.panelFooter", { name: shown.ext.name })}
      </div>
    </div>
  );
}
