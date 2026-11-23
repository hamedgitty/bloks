// The Bloks browser's extensions button (GitHub 510): the toolbar popup
// and options page of each Chrome extension switched on in this
// workspace's browser, for the person to open, unlock and set up.
//
// Each opens as a page of its own where the extension runs, never as a
// tab: in the desktop app a small window in the workspace's browser
// session (electron/extension-windows.mjs), in a server's browser a page
// of its own shown over the panel as pictures (BrowserPanel's
// ExtensionView). No agent's tab list, picture or command reaches it,
// which the menu says.
import { useRef, useState } from "react";
import { Loader2, Puzzle, Settings } from "@/components/icons";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { toast } from "@/components/ui/toast";
import { Tip } from "@/components/ui/tooltip";
import { openableExtensions, type BrowserExtensionRow, type ExtensionPage, type ExtensionViewState } from "@/lib/browserExtensions";
import { api, useOptionalStore } from "@/state/store";
import { t } from "@/lib/i18n";

/** Where the extensions are and how one's page opens: the app's own
 * browser through its bridge, or a server's through its routes, which
 * answer the view it opened. */
export interface ExtensionSource {
  list(): Promise<BrowserExtensionRow[]>;
  open(slug: string, page: ExtensionPage, anchor: { x: number; y: number; width: number; height: number }): Promise<ExtensionViewState | null | void>;
}

/** The browser a server keeps for itself (server/browser-extension-routes.ts). */
export function serverExtensions(): ExtensionSource {
  return {
    list: () => api("/api/browser/extensions").then((said) => (said as { extensions?: BrowserExtensionRow[] }).extensions ?? []),
    open: (slug, page) =>
      api(`/api/browser/extensions/${encodeURIComponent(slug)}/open`, { method: "POST", body: JSON.stringify({ page }) }).then((said) => {
        const answer = said as { error?: string; view?: ExtensionViewState };
        if (answer.error) throw new Error(answer.error);
        return answer.view ?? null;
      }),
  };
}

/** The desktop app's own browser, when this app can open an extension's
 * pages (3.2.11 and later). */
export function appExtensions(): ExtensionSource | null {
  const bridge = typeof window === "undefined" ? undefined : window.bloks?.browserExtensions;
  const open = bridge?.open;
  if (!bridge || !open) return null;
  return {
    list: () => bridge.list(),
    open: (slug, page, anchor) => open(slug, page, anchor).then(() => null),
  };
}

const TRIGGER =
  "flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none transition-[background-color,color,scale] duration-150 ease-out hover:bg-accent hover:text-foreground active:scale-[0.96] data-[state=open]:bg-accent data-[state=open]:text-foreground";

export function ExtensionsMenu({ source, onOpened }: { source: ExtensionSource; onOpened?: (view: ExtensionViewState) => void }) {
  // a window of its own has no store, and no settings to open
  const dispatch = useOptionalStore()?.dispatch;
  const trigger = useRef<HTMLButtonElement>(null);
  const [rows, setRows] = useState<ReturnType<typeof openableExtensions> | null>(null);

  const open = (slug: string, page: ExtensionPage) => {
    const box = trigger.current?.getBoundingClientRect();
    const anchor = box ? { x: box.left, y: box.top, width: box.width, height: box.height } : { x: 0, y: 0, width: 0, height: 0 };
    void source
      .open(slug, page, anchor)
      .then((view) => view && onOpened?.(view))
      .catch((error: unknown) => toast.error(error instanceof Error ? error.message : String(error)));
  };

  return (
    <DropdownMenu
      modal={false}
      onOpenChange={(opened) => {
        if (!opened) return;
        void source
          .list()
          .then((list) => setRows(openableExtensions(list)))
          .catch(() => setRows([]));
      }}
    >
      <Tip label={t("browserPanel.extensions")}>
        <DropdownMenuTrigger ref={trigger} className={TRIGGER} aria-label={t("browserPanel.extensions")}>
          <Puzzle size={15} />
        </DropdownMenuTrigger>
      </Tip>
      <DropdownMenuContent align="end" className="w-[280px]" onCloseAutoFocus={(e) => e.preventDefault()}>
        <DropdownMenuLabel>{t("browserPanel.extensions")}</DropdownMenuLabel>
        {rows === null ? (
          <div className="flex items-center gap-2 px-2.5 py-1.5 text-body text-muted-foreground">
            <Loader2 size={13} className="animate-spin" />
            {t("common.loading2")}
          </div>
        ) : rows.length === 0 ? (
          <p className="px-2.5 py-1.5 text-body text-muted-foreground">{t("browserPanel.extensionsNone")}</p>
        ) : (
          rows.map((row) => (
            <div key={row.slug}>
              {row.popup && (
                <DropdownMenuItem onSelect={() => open(row.slug, "popup")}>
                  <Puzzle />
                  <span className="min-w-0 truncate">{row.name}</span>
                </DropdownMenuItem>
              )}
              {row.options && (
                <DropdownMenuItem onSelect={() => open(row.slug, "options")}>
                  <Settings />
                  <span className="min-w-0 truncate">{t("browserPanel.extensionOptions", { name: row.name })}</span>
                </DropdownMenuItem>
              )}
            </div>
          ))
        )}
        <DropdownMenuSeparator />
        {dispatch && (
          <DropdownMenuItem onSelect={() => dispatch({ type: "toggleAppSettings", open: true, page: "browser" })}>{t("browserPanel.manageExtensions")}</DropdownMenuItem>
        )}
        <p className="px-2.5 pb-1.5 pt-1 text-small text-pretty text-muted-foreground">{t("browserPanel.extensionsPrivate")}</p>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
