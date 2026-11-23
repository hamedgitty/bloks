// The side dock's panes: one on each side of a conversation it is asked
// for (the rules are in src/lib/dock.ts). The right pane is the dock as it
// always was; a tab moved to the left, the top or the bottom opens a pane
// there, with a strip of its own.
//
// Each pane's top is one quiet row: a strip of tabs, one for each panel
// open on that side, each its icon and name, the shown one a bordered
// pill, an × on the one under the pointer; right after the last tab (so
// on the far left when there is none) a + that lists every kind of panel
// this conversation offers, with what each holds and its key, and adds it
// to this pane; and on the far right the pane's own icon, which hides it and keeps what is in
// it. A panel that holds several things of its own (terminal shells,
// browser pages) shows each as a tab of its own in the strip, flat beside
// the rest; selecting one brings that panel forward on it, and its ×
// closes that shell or page. A tab's own menu (right click, or Shift+F10
// on it) moves it to another side, expands the pane, or opens it in a
// window of its own. On a tab a dot says what its panel is doing
// (src/lib/dockActivity.ts): blue while an agent works in it, orange while
// it waits on the person, purple while another person is at it; one on a
// panel that is not open marks the + instead.
//
// The right pane open with no tab in it (opened from the header, or its
// last tab closed) lists what it can show, one row each with what it
// holds now and its key, in the middle of the pane: nothing is opened for
// the person until they pick.
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
import { AppWindow, Collapse, DockBottom, DockLeft, DockRight, DockTop, Expand, Minimize, PanelBottom, PanelLeft, PanelRight, PanelTop, Plus, X } from "@/components/icons";
import { setDockActions, setDockExpanded } from "@/lib/dockActions";
import { Tip } from "@/components/ui/tooltip";
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
  canMinimize,
  minimizedIn,
  sideForNew,
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
  /** What it holds now, beside its name in the + menu and the list: "3",
   * "2 running". */
  count?: string;
  /** Lines added and removed, drawn green and red in place of `count`. */
  delta?: { added: number; removed: number };
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
  /** Whether it can be minimized now: the browser only with a page in it.
   * Any panel can, otherwise. */
  minimizable?: boolean;
  /** What its small window shows when minimized, where drawing the panel
   * itself there would not do (the browser's page is the app's view, so a
   * picture of it). The panel itself otherwise. */
  mini?: () => ReactNode;
  /** Its minimized window's own controls, before the way back and the X
   * (the browser's viewport). */
  miniActions?: () => ReactNode;
  /** Its minimized window's shape, height over width (a phone's page is
   * tall). The page's usual shape otherwise. */
  miniAspect?: number;
  /** What its minimized window is called, when not its name: the page in
   * front, for the browser. */
  miniLabel?: string;
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

/** What a panel holds now, beside its name: lines added and removed in
 * their colours, or its count. */
function Holds({ p }: { p: DockPane }) {
  if (p.delta)
    return (
      <span className="flex shrink-0 gap-1 text-small tabular-nums">
        <span className="text-success">+{p.delta.added}</span>
        <span className="text-destructive">{"\u2212"}{p.delta.removed}</span>
      </span>
    );
  return p.count ? <span className="shrink-0 text-small tabular-nums text-muted-foreground">{p.count}</span> : null;
}

const ROUND_BUTTON =
  "relative flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none transition-[background-color,color,scale] duration-150 ease-out hover:bg-accent hover:text-foreground active:scale-[0.96] data-[state=open]:bg-accent data-[state=open]:text-foreground";

export function SideDock({
  placeKey,
  panes,
  onPick,
  headSlot,
  side = "right",
  canMove = true,
  expandedSlot,
}: {
  /** Where its own buttons go while it is expanded over the conversation:
   * the conversation's top row, in place of its buttons (ChatView.tsx). */
  expandedSlot?: HTMLElement | null;
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
  // the right pane shows while open, on its list when no tab is in front;
  // another side's only with a tab in it
  const visible = side === "right" ? pane.open : Boolean(shown);
  // the panels minimized here are drawn in their small windows instead
  // (MiniDock.tsx)
  const minimized = new Set(minimizedIn(place).map((m) => m.panel));
  // where the panel in front puts its own buttons (src/lib/dockActions.ts)
  const [actionSlot, setActionSlot] = useState<HTMLSpanElement | null>(null);
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
  // A new tab of a kind already open in another pane goes to that pane: a
  // page opened from the terminal's pane joins the browser's, wherever the
  // browser sits, and a shell opened from the browser's pane joins the
  // terminal's. Only a kind open nowhere comes to this pane.
  const add = (p: DockPane) => {
    if (sideForNew(place, p.id, side) !== side) {
      onPick?.(p.id);
      dock.show(placeKey, p.id);
    } else pick(p.id);
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
  const up = Boolean(headSlot && visible && !covering && side === "right");
  useLayoutEffect(() => {
    if (!headSlot) return;
    // the slot takes the pane's width (its edge takes none), so the tabs sit
    // right over the panel they belong to
    headSlot.style.width = up ? `${size}px` : "0px";
  }, [headSlot, up, size]);

  useLayoutEffect(() => {
    if (!shown) return;
    setDockActions(shown, actionSlot);
    return () => setDockActions(shown, null);
  }, [shown, actionSlot]);

  const tab = (key: string, p: DockPane, label: string, icon: ReactNode, isFront: boolean, onSelect: () => void, onClose: () => void, title?: string) => {
    const status = p.status && !(p.status === "working" && isFront) ? STATUS[p.status] : null;
    const said = status ? t("dock.status.labelled", { panel: label, status: t(status.words) }) : label;
    return (
      <div
        key={key}
        className="group relative flex shrink-0 items-center"
      >
        <button
          type="button"
          role="tab"
          aria-selected={isFront}
          aria-label={said}
          title={title ?? (p.detail ? `${label}, ${p.detail}` : label)}
          data-dock-tab={key}
          onClick={onSelect}
          // the tab in front a bordered pill, the rest plain words until
          // the pointer is on them
          className={cn(
            "relative flex h-7.5 max-w-[180px] items-center gap-2 rounded-lg border px-2.5 text-ui outline-none transition-[background-color,border-color,color] duration-150",
            isFront ? "border-border bg-accent text-foreground" : "border-transparent text-muted-foreground hover:bg-accent hover:text-foreground",
          )}
        >
          <span className="flex shrink-0 [&_img]:size-[15px] [&_svg]:size-[15px]" aria-hidden>
            {icon}
          </span>
          <span className="truncate">{label}</span>
          {status && (
            <span
              aria-hidden
              data-dock-status={p.status}
              className={cn("absolute bottom-0.5 left-[17px] size-1.5 -translate-x-1/2 rounded-full", status.dot, status.pulse && "motion-safe:animate-pulse")}
            />
          )}
        </button>
        <button
          type="button"
          tabIndex={-1}
          aria-label={t("dock.closeTab", { name: label })}
          title={t("dock.closeTab", { name: label })}
          onClick={onClose}
          // only on the tab under the pointer, over the end of its words on
          // the tab's own colour, so a short title never makes room for it
          className="absolute right-1.5 flex size-5 items-center justify-center rounded-md bg-accent text-muted-foreground opacity-0 transition-[opacity,color] duration-150 hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
        >
          <X size={12} />
        </button>
      </div>
    );
  };

  const plus = (
    <DropdownMenu modal={false}>
      <Tip label={t("dock.add")}>
      <DropdownMenuTrigger aria-label={t("dock.add")} className={ROUND_BUTTON}>
        <Plus size={16} />
        {behind && (
          <span
            aria-hidden
            data-dock-status={behind}
            className={cn("absolute bottom-0.5 left-1/2 size-1.5 -translate-x-1/2 rounded-full", STATUS[behind].dot, STATUS[behind].pulse && "motion-safe:animate-pulse")}
          />
        )}
      </DropdownMenuTrigger>
      </Tip>
      <DropdownMenuContent align="start" className="min-w-[240px]">
        {ordered.map((p) => (
          <DropdownMenuItem key={p.id} data-dock-kind={p.id} onSelect={() => add(p)}>
            {p.icon}
            <span className="truncate">{p.label}</span>
            <Holds p={p} />
            <span className="flex-1" />
            {p.status && p.status !== "working" && <span aria-hidden className={cn("size-1.5 rounded-full", STATUS[p.status].dot)} />}
            {p.keys && <kbd className="font-sans text-caption text-muted-foreground">{p.keys}</kbd>}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
  // Expanded over a conversation whose top row has room for them (the
  // right pane, ChatView.tsx), these go up there, in place of the
  // conversation's own buttons, so the panel icon is not shown twice.
  const moveUp = Boolean(expanded && expandedSlot && side === "right" && visible);
  const cluster = (
    <>
      {/* the panel in front's own buttons, then minimize, expand (and its
            menu on hover) and the pane's own icon, which hides it */}
        <span ref={setActionSlot} className="flex shrink-0 items-center gap-1 empty:hidden" />
        {front && (
          <HeaderButton
            label={canMinimize(place, front.id) ? t("dock.minimize") : t("dock.minimizeFull")}
            disabled={front.minimizable === false || !canMinimize(place, front.id)}
            onClick={() => {
              setExpanded(false);
              dock.minimize(placeKey, front.id);
            }}
          >
            <Minimize size={16} />
          </HeaderButton>
        )}
        {front && (
          <ExpandControl
            expanded={expanded}
            onToggle={() => setExpanded(!expanded)}
            side={side}
            canMove={canMove}
            onMove={(to) => dock.move(placeKey, front.id, to)}
            popOut={front.popOut}
            tabs={front.items?.length ?? 1}
          />
        )}
        <HeaderButton label={t("dock.hide")} onClick={() => dock.hide(placeKey, side)}>
          {SIDE_ICON[side]}
        </HeaderButton>
    </>
  );
  useEffect(() => {
    if (side !== "right") return;
    setDockExpanded(placeKey, expanded && visible);
    return () => setDockExpanded(placeKey, false);
  }, [placeKey, side, expanded, visible]);
  const head = (
    <div className={cn("flex shrink-0 items-center gap-1 px-2", up ? "h-full border-l bg-card" : "h-[42px] border-b")}>
      <div
        ref={strip}
        style={fade}
        role="tablist"
        aria-label={t("dock.panels")}
        className="flex min-w-0 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
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
      {/* right after the last tab, and first when there is none */}
      {plus}
      <span className="flex-1" />
      {!moveUp && cluster}
    </div>
  );
  // the right pane with no tab in front: what it can show, one row each
  const list = (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto p-6">
      <div role="list" aria-label={t("dock.panels")} className="flex w-full max-w-[300px] flex-col gap-0.5">
        {ordered.map((p) => (
          <div role="listitem" key={p.id}>
            <button
              type="button"
              data-dock-kind={p.id}
              onClick={() => add(p)}
              title={p.detail ? `${p.label}, ${p.detail}` : p.label}
              className="flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-ui text-foreground outline-none transition-[background-color,scale] duration-150 ease-out hover:bg-accent active:scale-[0.98]"
            >
              <span aria-hidden className="flex shrink-0 [&_svg]:size-4">
                {p.icon}
              </span>
              <span className="truncate">{p.label}</span>
              <Holds p={p} />
              {p.status && (
                <span
                  aria-hidden
                  data-dock-status={p.status}
                  className={cn("size-1.5 shrink-0 rounded-full", STATUS[p.status].dot, STATUS[p.status].pulse && "motion-safe:animate-pulse")}
                />
              )}
              <span className="flex-1" />
              {p.keys && <kbd className="shrink-0 font-sans text-caption text-muted-foreground">{p.keys}</kbd>}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
  const drawn = ordered.filter((p) => !minimized.has(p.id) && (p.id === shown || (p.keepAlive && kept.has(p.id) && sideOf(place, p.id) === side)));
  const edge = visible && !covering && (
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
      {moveUp && createPortal(<div className="flex items-center gap-1">{cluster}</div>, expandedSlot!)}
      {(side === "right" || side === "bottom") && edge}
      <aside
        ref={setHolder}
        aria-label={t("dock.label")}
        data-side-dock=""
        data-dock-side={side}
        hidden={!visible}
        className={cn(
          "flex min-h-0 min-w-0 shrink-0 flex-col bg-card",
          { right: "border-l", left: "border-r", top: "border-b", bottom: "border-t" }[side],
          covering && "absolute inset-0 z-30 border-0 bg-background",
        )}
        style={covering ? undefined : across ? { height: size } : { width: size }}
      >
        {!up && head}
        {visible && !shown && list}
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

const MOVE_ICON: Record<DockSide, ReactNode> = {
  left: <DockLeft size={18} />,
  right: <DockRight size={18} />,
  top: <DockTop size={18} />,
  bottom: <DockBottom size={18} />,
};

/**
 * Expand, at the pane's top right. A click expands the pane over the
 * conversation, and once it has, the button says Show conversation and
 * puts it back. Resting the pointer on it opens its menu: the four sides
 * the tab can move to, Expand with its key, and a window of its own. The
 * keyboard opens the menu, whose Expand does the same.
 */
function ExpandControl({
  expanded,
  onToggle,
  side,
  canMove,
  onMove,
  popOut,
  tabs,
}: {
  /** How many tabs of the strip move with it: a browser's pages, a
   * terminal's shells. */
  tabs: number;
  expanded: boolean;
  onToggle: () => void;
  side: DockSide;
  canMove: boolean;
  onMove: (to: DockSide) => void;
  popOut?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  // a short rest before it opens, so passing over it opens nothing; a
  // moment's grace on the way out, so the pointer can cross to the menu
  const rest = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(true), open ? 0 : 350);
  };
  const leave = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(false), 180);
  };
  const keys = keysFor("dockExpand", platformOf())[0];
  return (
    <DropdownMenu modal={false} open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger
        aria-label={expanded ? t("dock.showConversation") : t("dock.expand")}
        onPointerEnter={rest}
        onPointerLeave={leave}
        // a click expands; only the keyboard and a rest open the menu
        onPointerDown={(e) => e.pointerType !== "touch" && e.button === 0 && e.preventDefault()}
        onClick={() => {
          clearTimeout(timer.current);
          setOpen(false);
          onToggle();
        }}
        className={cn(ROUND_BUTTON, expanded && "w-auto gap-1.5 px-2 text-small text-foreground")}
      >
        {expanded ? <Collapse size={15} /> : <Expand size={15} />}
        {expanded && <span className="whitespace-nowrap">{t("dock.showConversation")}</span>}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[220px]" onPointerEnter={rest} onPointerLeave={leave}>
        {canMove && (
          <>
            <DropdownMenuLabel>{tabs > 1 ? t("dock.moveTabs", { count: tabs }) : t("dock.moveTo")}</DropdownMenuLabel>
            <div role="group" aria-label={tabs > 1 ? t("dock.moveTabs", { count: tabs }) : t("dock.moveTo")} className="flex gap-1 px-1 pb-1">
              {(["left", "right", "top", "bottom"] as const).map((to) => (
                <DropdownMenuItem
                  key={to}
                  data-dock-move={to}
                  aria-label={t(SIDE_WORDS[to])}
                  title={t(SIDE_WORDS[to])}
                  aria-current={to === side ? "true" : undefined}
                  onSelect={() => to !== side && onMove(to)}
                  className={cn("size-9 justify-center p-0", to === side && "bg-accent text-foreground")}
                >
                  {MOVE_ICON[to]}
                </DropdownMenuItem>
              ))}
            </div>
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuItem onSelect={onToggle}>
          {expanded ? <Collapse /> : <Expand />}
          <span className="flex-1">{expanded ? t("dock.showConversation") : t("dock.expand")}</span>
          <kbd className="font-sans text-caption text-muted-foreground">{keys}</kbd>
        </DropdownMenuItem>
        {popOut && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => popOut()}>
              <AppWindow />
              <span className="flex-1">{t("dock.newWindow")}</span>
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
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
    // no room of its own: a zero-width rail on the pane's border line, its
    // grip laid over the line, so nothing shows between the conversation
    // and the pane
    <div className={cn("relative z-10 shrink-0", across ? "h-0" : "w-0")}>
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
        "absolute bg-transparent outline-none transition-colors duration-150 hover:bg-accent focus-visible:bg-accent",
        across ? "inset-x-0 -top-[3px] h-1.5 cursor-ns-resize" : "inset-y-0 -left-[3px] w-1.5 cursor-ew-resize",
      )}
    />
    </div>
  );
}
