// The side dock's panes: one on each side of a conversation it is asked
// for (the rules are in src/lib/dock.ts). The right pane is the dock as it
// always was; a tab moved to the left, the top or the bottom opens a pane
// there, with a strip of its own.
//
// Each pane's top is a strip of tabs, one for each panel open on that
// side, the shown one pressed, each with its own ×. A panel that holds
// several things of its own (terminal shells, browser pages) shows each as
// a tab of its own in the strip, flat beside the rest; selecting one
// brings that panel forward on it, and its × closes that shell or page.
// After the tabs: a + that lists every kind of panel this conversation
// offers, with what each holds and its key, and adds it to this pane; a
// ⋯ for the tab in front (move it to another side, expand, open it in a
// window of its own); expand; and an × that hides the pane and keeps what
// is in it. On a tab a dot says what its panel is doing
// (src/lib/dockActivity.ts): blue while an agent works in it, orange while
// it waits on the person, purple while another person is at it; one on a
// panel that is not open marks the + instead.
//
// One edge on a pane's inner side sizes it, by drag or by the arrow keys:
// the right and left panes' width, the top and bottom panes' height, each
// kept on this device. When there is no room for the conversation beside
// a pane, or the pane is expanded (⇧⌘\), it covers the conversation until
// it is hidden or put back.
//
// A panel that keeps something of its own worth keeping (the documents'
// places, a terminal's shells and screens, the computer's rewind tape)
// stays drawn while another panel is in front or the pane is hidden, only
// out of sight; one that is a view onto something kept elsewhere (the
// browser's tabs live in the app or on the server, a trace on the server)
// is drawn while it is shown, and costs nothing otherwise. A panel is
// drawn by one pane at a time: the one on its side.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useFadeScroll } from "@/lib/fadeScroll";
import { createPortal } from "react-dom";
import { AppWindow, Maximize2, Minimize2, MoreHorizontal, PanelBottom, PanelLeft, PanelRight, PanelTop, Plus, X } from "@/components/icons";
import { HeaderButton } from "@/components/terminal/TerminalMenus";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/cn";
import {
  ACROSS_SIZE,
  clampDockWidth,
  clampPaneHeight,
  dock,
  DOCK_PANELS,
  DOCK_SIDE_BY_SIDE,
  paneOf,
  placeIn,
  sideOf,
  tabsOn,
  useDockState,
  type DockPanel,
  type DockSide,
} from "@/lib/dock";
import { strongest, type DockStatus } from "@/lib/dockActivity";
import { t, type MessageKey } from "@/lib/i18n";
import { keysFor, platformOf } from "@/lib/shortcuts";

const STATUS: Record<DockStatus, { dot: string; words: MessageKey; pulse: boolean }> = {
  working: { dot: "bg-working", words: "dock.status.working", pulse: true },
  waiting: { dot: "bg-warning", words: "dock.status.waiting", pulse: true },
  teammate: { dot: "bg-teammate", words: "dock.status.teammate", pulse: false },
};

/** One thing a panel holds, drawn as a tab of its own: a shell, a page. */
export interface DockItem {
  id: string;
  label: string;
  icon?: ReactNode;
  /** Said on hover, and to a screen reader after the label. */
  title?: string;
  /** The one the panel shows when it is in front. */
  active: boolean;
  onSelect: () => void;
  /** Its own ×: ends that shell, closes that page. */
  onClose?: () => void;
}

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
  /** What it holds, each a tab of its own in the strip. */
  items?: readonly DockItem[];
  /** The + asked for it: a new shell or page, where it holds several. */
  onAdd?: () => void;
  /** Opens it in a window of its own (the desktop app only). */
  popOut?: () => void;
  render: (shown: boolean) => ReactNode;
}

// ⇧⌘\ expands the pane the keyboard is in, or the first one open
const expandAsks = new Set<(side: DockSide) => void>();

/** Expand or put back one side's pane (⇧⌘\ in ChatView.tsx). */
export function toggleExpand(side: DockSide) {
  for (const ask of expandAsks) ask(side);
}

/** The side whose pane holds the keyboard, if one does. */
export function focusedSide(): DockSide | null {
  const el = typeof document === "undefined" ? null : (document.activeElement as HTMLElement | null);
  const side = el?.closest?.("[data-dock-side]")?.getAttribute("data-dock-side");
  return side === "right" || side === "left" || side === "top" || side === "bottom" ? side : null;
}

const SIDE_ICON: Record<DockSide, ReactNode> = {
  left: <PanelLeft size={15} />,
  right: <PanelRight size={15} />,
  top: <PanelTop size={15} />,
  bottom: <PanelBottom size={15} />,
};
const SIDE_WORDS: Record<DockSide, MessageKey> = {
  left: "dock.move.left",
  right: "dock.move.right",
  top: "dock.move.top",
  bottom: "dock.move.bottom",
};

const ROUND_BUTTON =
  "relative flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none transition-[background-color,color,scale] duration-150 ease-out hover:bg-accent hover:text-foreground active:scale-[0.96] data-[state=open]:bg-accent data-[state=open]:text-foreground";

export function SideDock({
  placeKey,
  panes,
  onPick,
  headSlot,
  side = "right",
  canMove = true,
}: {
  placeKey: string;
  /** The panels this conversation offers, in any order. */
  panes: readonly DockPane[];
  /** A panel picked, before it is shown: a terminal moved into the dock,
   * say. */
  onPick?: (panel: DockPanel) => void;
  /** Where its tabs go in the window's top row, over the pane, on a wide
   * window (the right pane only, ChatView.tsx); null keeps them at the
   * pane's own top. */
  headSlot?: HTMLElement | null;
  side?: DockSide;
  /** Whether tabs may move to other sides: a room keeps its one pane. */
  canMove?: boolean;
}) {
  const state = useDockState();
  const place = placeIn(state, placeKey);
  const across = side === "top" || side === "bottom";
  const ordered = DOCK_PANELS.map((id) => panes.find((p) => p.id === id)).filter((p): p is DockPane => Boolean(p));
  const pane = paneOf(place, side);
  const shown = pane.open && pane.panel && sideOf(place, pane.panel) === side && ordered.some((p) => p.id === pane.panel) ? pane.panel : null;
  const [room, setRoom] = useState(0);
  const [dragging, setDragging] = useState<number | null>(null);
  const [holder, setHolder] = useState<HTMLElement | null>(null);
  // panels drawn so far that keep themselves drawn out of sight
  const [kept, setKept] = useState<ReadonlySet<DockPanel>>(() => new Set());
  if (shown && !kept.has(shown) && ordered.find((p) => p.id === shown)?.keepAlive) setKept(new Set(kept).add(shown));

  // the room the conversation and the pane share, measured on what holds
  // them both: a row for the side panes, a column for the others
  useLayoutEffect(() => {
    const row = holder?.parentElement;
    if (!row) return;
    const measure = () => {
      const box = row.getBoundingClientRect();
      setRoom(across ? box.height : box.width);
    };
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(row);
    return () => watch.disconnect();
  }, [holder, across]);

  // Expanded, the pane covers the conversation as it does where there is
  // no room, until it is put back; for this window only
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    const ask = (which: DockSide) => which === side && setExpanded((e) => !e);
    expandAsks.add(ask);
    return () => void expandAsks.delete(ask);
  }, [side]);
  const fits = across ? room === 0 || room >= ACROSS_SIZE.min + ACROSS_SIZE.chat : room === 0 || room >= DOCK_SIDE_BY_SIDE;
  const covering = !fits || expanded;
  const stored = side === "right" ? state.width : state.sizes?.[side];
  const size = across
    ? clampPaneHeight(dragging ?? stored ?? ACROSS_SIZE.fallback, room || window.innerHeight)
    : clampDockWidth(dragging ?? stored ?? 320, room || window.innerWidth);
  // the open tabs on this side, in the order they were opened; the one
  // shown is always among them, even from a place kept before tabs
  const onSide = tabsOn(place, side);
  const tabs = [...onSide, ...(shown && !onSide.includes(shown) ? [shown] : [])]
    .map((id) => ordered.find((p) => p.id === id))
    .filter((p): p is DockPane => Boolean(p));
  // something asking for the person on a panel that is not open anywhere
  // marks the right pane's +
  const behind =
    side === "right" ? strongest(...ordered.filter((p) => !place.tabs.includes(p.id)).map((p) => (p.status === "working" ? null : p.status))) : null;
  const pick = (panel: DockPanel) => {
    onPick?.(panel);
    if (sideOf(place, panel) !== side) dock.move(placeKey, panel, side);
    else dock.show(placeKey, panel);
  };
  const add = (p: DockPane) => {
    pick(p.id);
    p.onAdd?.();
  };
  const front = ordered.find((p) => p.id === shown);
  // past its room the strip scrolls sideways and fades on the side with
  // more, the tab in front kept in view (src/lib/fadeScroll.ts)
  const strip = useRef<HTMLDivElement>(null);
  const frontKey = `${shown ?? ""}:${front?.items?.find((i) => i.active)?.id ?? ""}`;
  const fade = useFadeScroll(strip, frontKey);
  // up in the window's top row while the pane shows beside the
  // conversation; at its own top when it covers it or there is no top row
  const up = Boolean(headSlot && shown && !covering && side === "right");
  useLayoutEffect(() => {
    if (!headSlot) return;
    // the slot takes the pane's width and its edge's, so the tabs sit
    // right over the panel they belong to
    headSlot.style.width = up ? `${size + 6}px` : "0px";
  }, [headSlot, up, size]);

  const tab = (key: string, p: DockPane, label: string, icon: ReactNode, isFront: boolean, onSelect: () => void, onClose: () => void, title?: string) => {
    const status = p.status && !(p.status === "working" && isFront) ? STATUS[p.status] : null;
    const said = status ? t("dock.status.labelled", { panel: label, status: t(status.words) }) : label;
    return (
      <div key={key} className="group relative flex shrink-0 items-center">
        <button
          type="button"
          role="tab"
          aria-selected={isFront}
          aria-label={said}
          title={title ?? (p.detail ? `${label}, ${p.detail}` : label)}
          data-dock-tab={key}
          onClick={onSelect}
          className={cn(
            "relative flex h-7 max-w-[160px] items-center gap-1.5 rounded-md pl-2 pr-6 text-body outline-none transition-colors duration-150",
            isFront ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
          )}
        >
          <span className="flex shrink-0 [&_svg]:size-[14px]" aria-hidden>
            {icon}
          </span>
          <span className="truncate">{label}</span>
          {status && (
            <span
              aria-hidden
              data-dock-status={p.status}
              className={cn("absolute bottom-0.5 left-[13px] size-1.5 -translate-x-1/2 rounded-full", status.dot, status.pulse && "motion-safe:animate-pulse")}
            />
          )}
        </button>
        <button
          type="button"
          tabIndex={-1}
          aria-label={t("dock.closeTab", { name: label })}
          title={t("dock.closeTab", { name: label })}
          onClick={onClose}
          className={cn(
            "absolute right-1 flex size-5 items-center justify-center rounded text-muted-foreground transition-[opacity,background-color,color] duration-150 hover:bg-foreground/10 hover:text-foreground",
            isFront ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
          )}
        >
          <X size={12} />
        </button>
      </div>
    );
  };

  const head = (
    <div className={cn("flex shrink-0 items-center gap-0.5 px-1.5", up ? "h-full border-l bg-card" : "h-[38px] border-b")}>
      <div
        ref={strip}
        style={fade}
        role="tablist"
        aria-label={t("dock.panels")}
        className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {tabs.flatMap((p) =>
          p.items?.length
            ? p.items.map((item) =>
                tab(
                  `${p.id}:${item.id}`,
                  p,
                  item.label,
                  item.icon ?? p.icon,
                  p.id === shown && item.active,
                  () => {
                    pick(p.id);
                    item.onSelect();
                  },
                  () => (item.onClose ? item.onClose() : dock.closeTab(placeKey, p.id)),
                  item.title,
                ),
              )
            : [tab(p.id, p, p.label, p.icon, p.id === shown, () => pick(p.id), () => dock.closeTab(placeKey, p.id))],
        )}
      </div>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger aria-label={t("dock.add")} title={t("dock.add")} className={ROUND_BUTTON}>
          <Plus size={16} />
          {behind && (
            <span
              aria-hidden
              data-dock-status={behind}
              className={cn("absolute bottom-0.5 left-1/2 size-1.5 -translate-x-1/2 rounded-full", STATUS[behind].dot, STATUS[behind].pulse && "motion-safe:animate-pulse")}
            />
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-[240px]">
          {ordered.map((p) => (
            <DropdownMenuItem key={p.id} data-dock-kind={p.id} onSelect={() => add(p)}>
              {p.icon}
              <span className="flex-1 truncate">{p.label}</span>
              {p.count && <span className="text-caption tabular-nums text-muted-foreground">{p.count}</span>}
              {p.status && p.status !== "working" && <span aria-hidden className={cn("size-1.5 rounded-full", STATUS[p.status].dot)} />}
              {p.keys && <kbd className="font-sans text-caption text-muted-foreground">{p.keys}</kbd>}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {front && (
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger aria-label={t("dock.tabMenu", { name: front.label })} title={t("dock.tabMenu", { name: front.label })} className={ROUND_BUTTON}>
            <MoreHorizontal size={16} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-[220px]">
            {canMove && (
              <>
                <DropdownMenuLabel>{t("dock.moveTo")}</DropdownMenuLabel>
                {(["left", "right", "top", "bottom"] as const).map((to) => (
                  <DropdownMenuItem key={to} data-dock-move={to} disabled={to === side} onSelect={() => dock.move(placeKey, front.id, to)}>
                    {SIDE_ICON[to]}
                    <span className="flex-1">{t(SIDE_WORDS[to])}</span>
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
              </>
            )}
            <DropdownMenuItem onSelect={() => setExpanded(!expanded)}>
              {expanded ? <Minimize2 /> : <Maximize2 />}
              <span className="flex-1">{expanded ? t("dock.restore") : t("dock.expand")}</span>
              <kbd className="font-sans text-caption text-muted-foreground">{keysFor("dockExpand", platformOf())[0]}</kbd>
            </DropdownMenuItem>
            {front.popOut && (
              <DropdownMenuItem onSelect={() => front.popOut?.()}>
                <AppWindow />
                <span className="flex-1">{t("dock.newWindow")}</span>
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {(expanded || fits) && (
        <HeaderButton label={expanded ? t("dock.restore") : t("dock.expand")} pressed={expanded} onClick={() => setExpanded(!expanded)}>
          {expanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
        </HeaderButton>
      )}
      <HeaderButton label={t("dock.hide")} onClick={() => dock.hide(placeKey, side)}>
        <X size={16} />
      </HeaderButton>
    </div>
  );
  const drawn = ordered.filter((p) => p.id === shown || (p.keepAlive && kept.has(p.id) && sideOf(place, p.id) === side));
  const edge = shown && !covering && (
    <Edge
      side={side}
      size={size}
      room={room}
      onDrag={setDragging}
      onDone={(next) => {
        setDragging(null);
        if (side === "right") dock.setWidth(next);
        else dock.setSize(side, next);
      }}
    />
  );
  // nothing on this side, nothing drawn: a pane that was never asked for
  // takes no room and adds no edge
  if (side !== "right" && !onSide.length && !shown && !drawn.length) return null;

  return (
    <>
      {up && headSlot && createPortal(head, headSlot)}
      {(side === "right" || side === "bottom") && edge}
      <aside
        ref={setHolder}
        aria-label={t("dock.label")}
        data-side-dock=""
        data-dock-side={side}
        hidden={!shown}
        className={cn(
          "flex min-h-0 min-w-0 shrink-0 flex-col bg-card",
          { right: "border-l", left: "border-r", top: "border-b", bottom: "border-t" }[side],
          covering && "absolute inset-0 z-30 border-0 bg-background",
        )}
        style={covering ? undefined : across ? { height: size } : { width: size }}
      >
        {!up && head}
        {drawn.map((p) => (
          <div key={p.id} hidden={p.id !== shown} className="flex min-h-0 min-w-0 flex-1 flex-col">
            {p.render(p.id === shown && dragging === null)}
          </div>
        ))}
      </aside>
      {(side === "left" || side === "top") && edge}
    </>
  );
}

/** The edge between the conversation and a pane: drag it, or focus it and
 * use the arrow keys (Shift for bigger steps). */
function Edge({ side, size, room, onDrag, onDone }: { side: DockSide; size: number; room: number; onDrag: (n: number) => void; onDone: (n: number) => void }) {
  const across = side === "top" || side === "bottom";
  const clamp = (n: number) => (across ? clampPaneHeight(n, room || window.innerHeight) : clampDockWidth(n, room || window.innerWidth));
  // dragging toward the conversation makes the pane larger
  const grows = side === "right" || side === "bottom" ? -1 : 1;
  return (
    <div
      role="separator"
      aria-orientation={across ? "horizontal" : "vertical"}
      aria-label={t("dock.resize")}
      aria-valuenow={Math.round(size)}
      tabIndex={0}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        e.preventDefault();
        const start = across ? e.clientY : e.clientX;
        let last = size;
        const move = (event: PointerEvent) => {
          last = clamp(size + grows * ((across ? event.clientY : event.clientX) - start));
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
        const keys = across ? ["ArrowUp", "ArrowDown"] : ["ArrowLeft", "ArrowRight"];
        if (!keys.includes(e.key)) return;
        e.preventDefault();
        const toward = e.key === keys[0] ? -1 : 1;
        onDone(clamp(size + grows * toward * (e.shiftKey ? 64 : 16)));
      }}
      className={cn(
        "shrink-0 bg-transparent outline-none transition-colors duration-150 hover:bg-accent focus-visible:bg-accent",
        across ? "h-1.5 cursor-ns-resize" : "w-1.5 cursor-ew-resize",
      )}
    />
  );
}
