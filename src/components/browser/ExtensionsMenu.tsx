// The Bloks browser's extensions button (GitHub 510): the toolbar popup
// and options page of each Chrome extension switched on in this
// workspace's browser, for the person to open, unlock and set up.
//
// Each opens as a page of its own where the extension runs, never as a
// tab: in the desktop app a small window in the workspace's browser
// session (electron/main.mjs openExtensionPage). No agent's tab list,
// picture or command reaches it, which the menu says.
import { useRef, useState } from "react";
import { Loader2, Puzzle, Settings } from "@/components/icons";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { toast } from "@/components/ui/toast";
import { openableExtensions, type BrowserExtensionRow, type ExtensionPage } from "@/lib/browserExtensions";
import { useStore } from "@/state/store";
import { t } from "@/lib/i18n";

/** Where the extensions are and how one's page opens: the app's own
 * browser through its bridge. */
export interface ExtensionSource {
  list(): Promise<BrowserExtensionRow[]>;
  open(slug: string, page: ExtensionPage, anchor: { x: number; y: number; width: number; height: number }): Promise<unknown>;
}

/** The desktop app's own browser, when this app can open an extension's
 * pages (3.2.11 and later). */
export function appExtensions(): ExtensionSource | null {
  const bridge = typeof window === "undefined" ? undefined : window.bloks?.browserExtensions;
  const open = bridge?.open;
  if (!bridge || !open) return null;
  return {
    list: () => bridge.list(),
    open: (slug, page, anchor) => open(slug, page, anchor),
  };
}

const TRIGGER =
  "flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none transition-[background-color,color,scale] duration-150 ease-out hover:bg-accent hover:text-foreground active:scale-[0.96] data-[state=open]:bg-accent data-[state=open]:text-foreground";

export function ExtensionsMenu({ source }: { source: ExtensionSource }) {
  const { dispatch } = useStore();
  const trigger = useRef<HTMLButtonElement>(null);
  const [rows, setRows] = useState<ReturnType<typeof openableExtensions> | null>(null);

  const open = (slug: string, page: ExtensionPage) => {
    const box = trigger.current?.getBoundingClientRect();
    const anchor = box ? { x: box.left, y: box.top, width: box.width, height: box.height } : { x: 0, y: 0, width: 0, height: 0 };
    void source.open(slug, page, anchor).catch((error: unknown) => toast.error(error instanceof Error ? error.message : String(error)));
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
      <DropdownMenuTrigger ref={trigger} className={TRIGGER} aria-label={t("browserPanel.extensions")} title={t("browserPanel.extensions")}>
        <Puzzle size={15} />
      </DropdownMenuTrigger>
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
        <DropdownMenuItem onSelect={() => dispatch({ type: "toggleAppSettings", open: true, page: "browser" })}>{t("browserPanel.manageExtensions")}</DropdownMenuItem>
        <p className="px-2.5 pb-1.5 pt-1 text-small text-pretty text-muted-foreground">{t("browserPanel.extensionsPrivate")}</p>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
