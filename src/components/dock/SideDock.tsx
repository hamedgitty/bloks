// The side dock: the one column on a conversation's right (the rules are
// in src/lib/dock.ts).
//
// Its top is a strip of tabs, one for each panel open in this
// conversation, the shown one pressed, each with its own × that closes
// it; a + that lists every kind of panel this conversation offers, with
// what each holds and its key; and an × that hides the dock and keeps
// what is in it. On a tab a dot says what its panel is doing
// (src/lib/dockActivity.ts): blue while an agent works in it, orange while
// it waits on the person, purple while another person is at it; one on a
// panel that is not open marks the + instead. Below is the panel. One
// edge on its left sizes it, by drag or by the arrow keys, for every
// panel alike. When the row is too narrow
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
import { createPortal } from "react-dom";
import { Plus, X } from "@/components/icons";
import { HeaderButton } from "@/components/terminal/TerminalMenus";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/cn";
import { clampDockWidth, dock, DOCK_PANELS, DOCK_SIDE_BY_SIDE, placeIn, useDockState, type DockPanel } from "@/lib/dock";
import { strongest, type DockStatus } from "@/lib/dockActivity";
import { t, type MessageKey } from "@/lib/i18n";

const STATUS: Record<DockStatus, { dot: string; words: MessageKey; pulse: boolean }> = {
  working: { dot: "bg-working", words: "dock.status.working", pulse: true },
  waiting: { dot: "bg-warning", words: "dock.status.waiting", pulse: true },
  teammate: { dot: "bg-teammate", words: "dock.status.teammate", pulse: false },
};

export interface DockPane {
  id: DockPanel;
  /** What the icon is called, and the panel's name above it. */
  label: string;
  icon: ReactNode;
  /** A second line for the name: where the browser runs, say. */
  detail?: string;
  /** What it holds now, beside its name in the + menu: "+12 −3", "2
   * running". */
  count?: string;
  /** Its key, as the + menu writes it (src/lib/shortcuts.ts). */
  keys?: string;
  /** What is happening in it, as the dot under its icon. Work is not
   * marked on the panel in front, where it can be seen; waiting and a
   * teammate are, since they ask something of the person. */
  status?: DockStatus | null;
  /** Stays drawn out of sight, for what it keeps (see above). */
  keepAlive?: boolean;
  render: (shown: boolean) => ReactNode;
}

export function SideDock({
  placeKey,
  panes,
  onPick,
  headSlot,
}: {
  placeKey: string;
  /** The panels this conversation offers, in any order. */
  panes: readonly DockPane[];
  /** A panel picked on the ribbon, before it is shown: a terminal moved
   * into the dock, say. */
  onPick?: (panel: DockPanel) => void;
  /** Where its tabs go in the window's top row, over the dock, on a wide
   * window (ChatView.tsx); null keeps them at the dock's own top. */
  headSlot?: HTMLElement | null;
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
  // the open tabs, in the order they were opened; the one shown is always
  // among them, even from a place kept before there were tabs
  const tabs = [...place.tabs, ...(shown && !place.tabs.includes(shown) ? [shown] : [])]
    .map((id) => ordered.find((p) => p.id === id))
    .filter((p): p is DockPane => Boolean(p));
  // something asking for the person on a panel that is not open marks the +
  const behind = strongest(...ordered.filter((p) => !tabs.includes(p)).map((p) => (p.status === "working" ? null : p.status)));
  const pick = (panel: DockPanel) => {
    onPick?.(panel);
    dock.show(placeKey, panel);
  };
  // up in the window's top row while the dock shows beside the chat; at
  // its own top when it covers the chat or there is no top row
  const up = Boolean(headSlot && shown && !narrow);
  useLayoutEffect(() => {
    if (!headSlot) return;
    // the slot takes the dock's width and its edge's, so the tabs sit
    // right over the panel they belong to
    headSlot.style.width = up ? `${width + 6}px` : "0px";
  }, [headSlot, up, width]);
  const head = (
        <div className={cn("flex shrink-0 items-center gap-0.5 px-1.5", up ? "h-full border-l bg-card" : "h-[38px] border-b")}>
          <div
            role="tablist"
            aria-label={t("dock.panels")}
            className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto [scrollbar-width:none]"
          >
            {tabs.map((pane) => {
              const status = pane.status && !(pane.status === "working" && pane.id === shown) ? STATUS[pane.status] : null;
              const front = pane.id === shown;
              const label = status ? t("dock.status.labelled", { panel: pane.label, status: t(status.words) }) : pane.label;
              return (
                <div key={pane.id} className="group relative flex shrink-0 items-center">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={front}
                    aria-label={label}
                    title={pane.detail ? `${pane.label}, ${pane.detail}` : pane.label}
                    data-dock-tab={pane.id}
                    onClick={() => pick(pane.id)}
                    className={cn(
                      "relative flex h-7 max-w-[148px] items-center gap-1.5 rounded-md pl-2 pr-6 text-body outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring",
                      front ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                    )}
                  >
                    <span className="flex shrink-0 [&_svg]:size-[14px]" aria-hidden>
                      {pane.icon}
                    </span>
                    <span className="truncate">{pane.label}</span>
                    {status && (
                      <span
                        aria-hidden
                        data-dock-status={pane.status}
                        className={cn("absolute bottom-0.5 left-[13px] size-1.5 -translate-x-1/2 rounded-full", status.dot, status.pulse && "motion-safe:animate-pulse")}
                      />
                    )}
                  </button>
                  <button
                    type="button"
                    tabIndex={-1}
                    aria-label={t("dock.closeTab", { name: pane.label })}
                    title={t("dock.closeTab", { name: pane.label })}
                    onClick={() => dock.closeTab(placeKey, pane.id)}
                    className={cn(
                      "absolute right-1 flex size-5 items-center justify-center rounded text-muted-foreground transition-[opacity,background-color,color] duration-150 hover:bg-foreground/10 hover:text-foreground",
                      front ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
                    )}
                  >
                    <X size={12} />
                  </button>
                </div>
              );
            })}
          </div>
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger
              aria-label={t("dock.add")}
              title={t("dock.add")}
              className="relative flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none transition-[background-color,color,scale] duration-150 ease-out hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.96] data-[state=open]:bg-accent data-[state=open]:text-foreground"
            >
              <Plus size={16} />
              {behind && (
                <span
                  aria-hidden
                  data-dock-status={behind}
                  className={cn("absolute bottom-0.5 left-1/2 size-1.5 -translate-x-1/2 rounded-full", STATUS[behind].dot, STATUS[behind].pulse && "motion-safe:animate-pulse")}
                />
              )}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[232px]">
              {ordered.map((pane) => (
                <DropdownMenuItem key={pane.id} data-dock-kind={pane.id} onSelect={() => pick(pane.id)}>
                  {pane.icon}
                  <span className="flex-1 truncate">{pane.label}</span>
                  {pane.count && <span className="text-caption tabular-nums text-muted-foreground">{pane.count}</span>}
                  {pane.status && pane.status !== "working" && (
                    <span aria-hidden className={cn("size-1.5 rounded-full", STATUS[pane.status].dot)} />
                  )}
                  {pane.keys && <kbd className="font-sans text-caption text-muted-foreground">{pane.keys}</kbd>}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <HeaderButton label={t("dock.hide")} onClick={() => dock.hide(placeKey)}>
            <X size={16} />
          </HeaderButton>
        </div>
  );
  const drawn = ordered.filter((p) => p.id === shown || (p.keepAlive && kept.has(p.id)));

  return (
    <>
      {up && headSlot && createPortal(head, headSlot)}
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
        data-side-dock=""
        hidden={!shown}
        className={cn("flex min-h-0 min-w-0 shrink-0 flex-col border-l bg-card", narrow && "absolute inset-0 z-30 border-l-0 bg-background")}
        style={narrow ? undefined : { width }}
      >
        {!up && head}
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
