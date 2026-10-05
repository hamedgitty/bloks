// ⌘, ⌘/ and ⌥↑↓: the keys that belong to the whole window rather than
// to one part of it, and the sheet that lists every key there is.
//
// The other window-wide keys stay with what they open (⌘K in the
// palette, ⌘N in the sidebar, ⌘F in the conversation), and so does
// Ctrl+Tab, in Switcher.tsx. What they all have in common is the list in
// src/lib/shortcuts.ts, which is what the sheet draws.
//
// Nothing here moves. Stepping through the sidebar is something people do
// dozens of times an hour, and a list that slides on every press would be
// slower to read than one that simply changes; the sheet comes in with
// the same short fade as the palette.
import { useEffect, useRef } from "react";
import { useStore } from "@/state/store";
import { chordLabel, platformOf, shortcutSheet } from "@/lib/shortcuts";
import { stepRow, type SidebarRow } from "@/lib/sidebarStep";
import { useEscape } from "@/lib/useEscape";
import { cn } from "@/lib/cn";

/** Key chords as small caps, drawn like the esc in the palette. */
export function Keys({ keys, className }: { keys: string[]; className?: string }) {
  if (!keys.length) return null;
  return (
    <span className={cn("flex shrink-0 items-center gap-1", className)}>
      {keys.map((label) => (
        <kbd key={label} className="rounded-md border px-1.5 py-0.5 text-[10.5px] text-muted-foreground">
          {label}
        </kbd>
      ))}
    </span>
  );
}

/** The agent and room rows the sidebar is showing, top to bottom, read
 * off the page (Sidebar.tsx marks each one). A row that is not drawn,
 * such as one in a folded section, counts as folded. */
function sidebarRows(): SidebarRow[] {
  return [...document.querySelectorAll<HTMLElement>("[data-sidebar-row]")].map((row) => ({
    id: row.dataset.sidebarRow ?? "",
    waiting: row.dataset.sidebarWaiting === "true",
    folded: row.getClientRects().length === 0,
  }));
}

/**
 * Whether ⌥↑ belongs to whatever has focus. In a field with words in it
 * the arrows move the caret (on a Mac, by paragraph), and taking them
 * away would be taking away editing; an empty field has nothing to move
 * through, so the key goes to the sidebar instead. A select opens on
 * Alt+↓, and a terminal sends the keys on to its shell.
 */
function keepsArrows(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.closest(".xterm")) return true;
  if (target instanceof HTMLSelectElement) return true;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) return target.value !== "";
  return target.isContentEditable && (target.textContent ?? "") !== "";
}

/** Something is open over the sidebar (a menu, a panel, this sheet), and
 * the arrows are its business rather than the list's underneath. */
const somethingOnTop = () =>
  Boolean(document.querySelector("[role=menu], [role=dialog], [data-radix-popper-content-wrapper]"));

/** The window-wide keys of this file, and the sheet when it is open. */
export function ShortcutKeys() {
  const { state, dispatch } = useStore();
  // read inside the listener, which is attached once
  const selected = useRef(state.selectedId);
  selected.current = state.selectedId;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // something nearer the focus already answered it, such as a
      // section heading moving itself on ⌥↑
      if (e.defaultPrevented) return;
      const mod = e.metaKey || e.ctrlKey;
      // Settings answers ⌘, from anywhere, the way every Mac app's does.
      // In the Mac app the menu bar has the same key (electron/app-menu.mjs)
      // and opening Settings twice is still one Settings; this is what
      // Windows, Linux and a browser tab have.
      if (mod && !e.altKey && e.key === ",") {
        e.preventDefault();
        dispatch({ type: "toggleAppSettings", open: true });
        return;
      }
      // Shift is allowed: on many keyboards / is a shifted key
      if (mod && !e.altKey && e.key === "/") {
        e.preventDefault();
        dispatch({ type: "toggleShortcuts" });
        return;
      }
      if (e.altKey && !mod && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
        if (keepsArrows(e.target) || somethingOnTop()) return;
        // the page itself would scroll by a screen on a Mac
        e.preventDefault();
        const next = stepRow(sidebarRows(), selected.current, e.key === "ArrowUp" ? -1 : 1, e.shiftKey);
        if (!next) return;
        dispatch({ type: "select", id: next });
        // Brought into view once it is drawn as the open row: at once,
        // because a list that glides on every press is a list you wait for.
        requestAnimationFrame(() =>
          document
            .querySelector(`[data-sidebar-row="${CSS.escape(next)}"]`)
            ?.scrollIntoView({ block: "nearest", inline: "nearest" }),
        );
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dispatch]);

  return state.shortcutsOpen ? <ShortcutsSheet /> : null;
}

/** Every shortcut, grouped, in this platform's own words: ⌘⌥⇧ on a Mac,
 * Ctrl, Alt and Shift everywhere else. */
function ShortcutsSheet() {
  const { dispatch } = useStore();
  const close = () => dispatch({ type: "toggleShortcuts", open: false });
  useEscape(close);
  const platform = platformOf();
  // a browser keeps some keys for its own tabs; only the app hears them
  const groups = shortcutSheet(Boolean(window.bloks));

  return (
    <div
      className="fixed inset-0 z-50 flex animate-fade-in items-center justify-center bg-black/40 p-4 dark:bg-black/60"
      onMouseDown={close}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        className="flex max-h-[84vh] w-[720px] max-w-full flex-col overflow-hidden rounded-2xl border bg-popover shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 border-b px-5 py-3.5">
          <div className="text-[15px] font-semibold text-foreground">Keyboard shortcuts</div>
          <Keys keys={[chordLabel(["Esc"], platform)]} />
        </div>
        <div className="min-h-0 gap-x-8 overflow-y-auto px-5 pb-1 pt-4 sm:columns-2">
          {groups.map((group) => (
            <section key={group.id} className="mb-5 break-inside-avoid">
              <h3 className="pb-1 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                {group.label}
              </h3>
              {group.shortcuts.map((shortcut) => (
                <div key={shortcut.id} className="flex items-start justify-between gap-3 py-[5px]">
                  <div className="min-w-0">
                    <div className="text-[13px] leading-snug text-foreground">{shortcut.does}</div>
                    {shortcut.when && (
                      <div className="text-[11.5px] leading-snug text-muted-foreground">{shortcut.when}</div>
                    )}
                  </div>
                  <Keys keys={shortcut.keys.map((chord) => chordLabel(chord, platform))} className="pt-px" />
                </div>
              ))}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
