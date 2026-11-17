// The side dock: the one column on a conversation's right (the rules are
// in src/lib/dock.ts).
//
// Its top is a ribbon of small icons, one for each panel this conversation
// offers, the shown one pressed, and an × that hides the dock and keeps
// what is in it. Below is the panel. One edge on its left sizes it, by drag
// or by the arrow keys, for every panel alike. When the row is too narrow
// for the chat and the dock side by side, the dock covers the chat until
// it is hidden, as the browser always did.
//
// A panel that keeps something of its own worth keeping (the documents'
// places, a terminal's shells and screens, the computer's rewind tape)
// stays drawn while another panel is in front or the dock is hidden, only
// out of sight; one that is a view onto something kept elsewhere (the
// browser's tabs live in the app or on the server, a trace on the server)
// is drawn while it is shown, and costs nothing otherwise.
import { useLayoutEffect, useState, type ReactNode } from "react";
import { X } from "@/components/icons";
import { HeaderButton } from "@/components/terminal/TerminalMenus";
import { cn } from "@/lib/cn";
import { clampDockWidth, dock, DOCK_PANELS, DOCK_SIDE_BY_SIDE, placeIn, useDockState, type DockPanel } from "@/lib/dock";
import { t } from "@/lib/i18n";

export interface DockPane {
  id: DockPanel;
  /** What the icon is called, and the panel's name above it. */
  label: string;
  icon: ReactNode;
  /** A second line for the name: where the browser runs, say. */
  detail?: string;
  /** Something is happening in it while it is out of sight. */
  dot?: boolean;
  /** Stays drawn out of sight, for what it keeps (see above). */
  keepAlive?: boolean;
  render: (shown: boolean) => ReactNode;
}

export function SideDock({
  placeKey,
  panes,
  onPick,
}: {
  placeKey: string;
  /** The panels this conversation offers, in any order. */
  panes: readonly DockPane[];
  /** A panel picked on the ribbon, before it is shown: a terminal moved
   * into the dock, say. */
  onPick?: (panel: DockPanel) => void;
}) {
  const state = useDockState();
  const place = placeIn(state, placeKey);
  const ordered = DOCK_PANELS.map((id) => panes.find((p) => p.id === id)).filter((p): p is DockPane => Boolean(p));
  const shown = place.open && ordered.some((p) => p.id === place.panel) ? place.panel : null;
  const [room, setRoom] = useState(0);
  const [dragging, setDragging] = useState<number | null>(null);
  const [holder, setHolder] = useState<HTMLElement | null>(null);
  // panels drawn so far that keep themselves drawn out of sight
  const [kept, setKept] = useState<ReadonlySet<DockPanel>>(() => new Set());
  if (shown && !kept.has(shown) && ordered.find((p) => p.id === shown)?.keepAlive) setKept(new Set(kept).add(shown));

  // the room the chat and the dock share, measured on the row they share
  useLayoutEffect(() => {
    const row = holder?.parentElement;
    if (!row) return;
    const measure = () => setRoom(row.getBoundingClientRect().width);
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(row);
    return () => watch.disconnect();
  }, [holder]);

  const narrow = room > 0 && room < DOCK_SIDE_BY_SIDE;
  const width = narrow ? room : clampDockWidth(dragging ?? state.width, room || window.innerWidth);
  const current = ordered.find((p) => p.id === shown);
  const drawn = ordered.filter((p) => p.id === shown || (p.keepAlive && kept.has(p.id)));

  return (
    <>
      {shown && !narrow && (
        <Edge
          width={width}
          room={room}
          onDrag={setDragging}
          onDone={(next) => {
            setDragging(null);
            dock.setWidth(next);
          }}
        />
      )}
      <aside
        ref={setHolder}
        aria-label={t("dock.label")}
        hidden={!shown}
        className={cn("flex min-h-0 min-w-0 shrink-0 flex-col border-l bg-card", narrow && "absolute inset-0 z-30 border-l-0 bg-background")}
        style={narrow ? undefined : { width }}
      >
        <div className="flex h-[38px] shrink-0 items-center gap-0.5 border-b px-1.5">
          <div role="toolbar" aria-label={t("dock.panels")} className="flex shrink-0 items-center gap-0.5">
            {ordered.map((pane) => (
              <HeaderButton
                key={pane.id}
                label={pane.label}
                pressed={pane.id === shown}
                onClick={() => {
                  onPick?.(pane.id);
                  dock.show(placeKey, pane.id);
                }}
                className="relative"
              >
                {pane.icon}
                {pane.dot && pane.id !== shown && (
                  <span aria-hidden className="absolute right-1 top-1 size-1.5 rounded-full bg-brand motion-safe:animate-pulse" />
                )}
              </HeaderButton>
            ))}
          </div>
          <div className="mx-1.5 h-4 w-px shrink-0 bg-border" aria-hidden />
          <div className="flex min-w-0 flex-1 items-baseline gap-1.5">
            <span className="truncate text-small font-medium text-foreground">{current?.label}</span>
            {current?.detail && <span className="truncate text-caption text-muted-foreground">{current.detail}</span>}
          </div>
          <HeaderButton label={t("dock.hide")} onClick={() => dock.hide(placeKey)}>
            <X size={16} />
          </HeaderButton>
        </div>
        {drawn.map((pane) => (
          <div key={pane.id} hidden={pane.id !== shown} className="flex min-h-0 min-w-0 flex-1 flex-col">
            {pane.render(pane.id === shown && dragging === null)}
          </div>
        ))}
      </aside>
    </>
  );
}

/** The edge between the chat and the dock: drag it, or focus it and use
 * the arrow keys (Shift for bigger steps). */
function Edge({ width, room, onDrag, onDone }: { width: number; room: number; onDrag: (w: number) => void; onDone: (w: number) => void }) {
  const clamp = (w: number) => clampDockWidth(w, room || window.innerWidth);
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={t("dock.resize")}
      aria-valuenow={Math.round(width)}
      tabIndex={0}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        e.preventDefault();
        const start = e.clientX;
        let last = width;
        const move = (event: PointerEvent) => {
          last = clamp(width + (start - event.clientX));
          onDrag(last);
        };
        const up = () => {
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", up);
          window.removeEventListener("pointercancel", up);
          onDone(last);
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
        window.addEventListener("pointercancel", up);
      }}
      onKeyDown={(e) => {
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
        e.preventDefault();
        const step = (e.shiftKey ? 64 : 16) * (e.key === "ArrowLeft" ? 1 : -1);
        onDone(clamp(width + step));
      }}
      className="w-1.5 shrink-0 cursor-ew-resize bg-transparent outline-none transition-colors duration-150 hover:bg-accent focus-visible:bg-accent"
    />
  );
}
