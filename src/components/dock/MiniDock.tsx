// The panels minimized out of the side panel (src/lib/dock.ts, minimizeTab):
// each a small window over the conversation, in one of its four corners,
// the bottom two above where you type. Two at most; two in one corner
// stand one above the other.
//
// A window shows its panel as it is (a terminal goes on working in it),
// or, where the panel cannot be drawn small (the browser's page is the
// app's own view), a picture of it kept fresh (DockPane.mini). Resting the
// pointer on it brings up a quiet header on top of it, the window growing
// by the header rather than the header covering any of it: its name, a
// handle to drag it by, and on the right the panel's own controls (the
// browser's viewport), the way back into the side panel, and an X that
// closes the window and leaves the panel a tab of the side panel for next
// time. Every window keeps a header's room above it for that.
//
// Dragged, it follows the pointer and, let go, springs to the nearest
// corner, carrying the speed it was let go at, so a flick toward a corner
// lands there. With reduced motion it moves there at once.
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { AnimatePresence, animate, motion, useDragControls, useMotionValue, useReducedMotion, type PanInfo } from "motion/react";
import { Expand, X } from "@/components/icons";
import { Tip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import { dock, minimizedIn, placeIn, useDockState, type DockCorner } from "@/lib/dock";
import { t } from "@/lib/i18n";
import type { DockPane } from "./SideDock";

/** Space between two windows in one corner, besides the header's room. */
const GAP = 10;
/** The header that comes up on top of a window on hover. */
const HEADER = 32;
const EASE_OUT = [0.23, 1, 0.32, 1] as const;
/** A button in a minimized window's header. */
export const MINI_BUTTON =
  "flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none transition-[background-color,color,scale] duration-150 ease-out hover:bg-accent hover:text-foreground active:scale-[0.96] data-[state=open]:bg-accent data-[state=open]:text-foreground";
/** How small a live panel is drawn in its window. */
const LIVE_SCALE = 0.6;

export function MiniDock({ placeKey, panes }: { placeKey: string; panes: readonly DockPane[] }) {
  const place = placeIn(useDockState(), placeKey);
  const minis = minimizedIn(place).filter((m) => panes.some((p) => p.id === m.panel));
  const box = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setRoom({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    return () => watch.disconnect();
  }, []);
  // a third of the conversation's width, within reason, at the shape of
  // what it shows (a phone's page is tall), never taller than half the
  // conversation
  const w = Math.round(Math.min(360, Math.max(220, room.w * 0.36)));
  const heightOf = (pane: DockPane) => Math.round(Math.max(w * 0.5, Math.min(w * (pane.miniAspect ?? 0.62), w * 1.6, Math.max(w * 0.5, room.h * 0.55))));
  // each window has a header's room above it, so the header never covers
  // the one above or falls off the top; the ones before it in its corner
  // are stepped over
  const slot = (corner: DockCorner, before: number, h: number) => ({
    x: corner.endsWith("left") ? 0 : Math.max(0, room.w - w),
    y: corner.startsWith("top") ? HEADER + before : Math.max(HEADER, room.h - h - before),
  });
  return (
    <div ref={box} className="pointer-events-none absolute inset-3 z-20">
      <AnimatePresence>
        {room.w > 0 &&
          minis.map((m) => {
            const pane = panes.find((p) => p.id === m.panel)!;
            const h = heightOf(pane);
            const same = minis.filter((o) => o.corner === m.corner);
            const before = same
              .slice(0, same.findIndex((o) => o.panel === m.panel))
              .reduce((sum, o) => sum + heightOf(panes.find((p) => p.id === o.panel)!) + HEADER + GAP, 0);
            return (
              <MiniWindow
                key={m.panel}
                pane={pane}
                corner={m.corner}
                target={slot(m.corner, before, h)}
                size={{ w, h }}
                room={room}
                onCorner={(corner) => dock.moveMini(placeKey, m.panel, corner)}
                onRestore={() => dock.restore(placeKey, m.panel)}
                onClose={() => dock.dismissMini(placeKey, m.panel)}
              />
            );
          })}
      </AnimatePresence>
    </div>
  );
}

function MiniWindow({
  pane,
  corner,
  target,
  size,
  room,
  onCorner,
  onRestore,
  onClose,
}: {
  onClose: () => void;
  pane: DockPane;
  corner: DockCorner;
  target: { x: number; y: number };
  size: { w: number; h: number };
  room: { w: number; h: number };
  onCorner: (corner: DockCorner) => void;
  onRestore: () => void;
}) {
  const x = useMotionValue(target.x);
  const y = useMotionValue(target.y);
  const reduced = useReducedMotion();
  const controls = useDragControls();
  const dragging = useRef(false);
  // the speed it was let go at, carried into the spring to its corner
  const thrown = useRef({ x: 0, y: 0 });
  const settle = () => {
    const spring = (velocity: number) => (reduced ? { duration: 0 } : { type: "spring" as const, stiffness: 380, damping: 32, mass: 0.9, velocity });
    animate(x, target.x, spring(thrown.current.x));
    animate(y, target.y, spring(thrown.current.y));
    thrown.current = { x: 0, y: 0 };
  };
  // to its place whenever the place moves: a new corner, the other window
  // leaving, the conversation resized
  useEffect(() => {
    if (!dragging.current) settle();
  }, [target.x, target.y]); // eslint-disable-line react-hooks/exhaustive-deps

  const land = (info: PanInfo) => {
    dragging.current = false;
    thrown.current = { x: info.velocity.x, y: info.velocity.y };
    // where it would come to rest, a flick counted, decides the corner
    const cx = x.get() + size.w / 2 + info.velocity.x * 0.12;
    const cy = y.get() + size.h / 2 + info.velocity.y * 0.12;
    const next = `${cy < room.h / 2 ? "top" : "bottom"}-${cx < room.w / 2 ? "left" : "right"}` as DockCorner;
    if (next !== corner) onCorner(next);
    else settle();
  };
  // the arrow keys on the handle move it a corner over
  const onKey = (e: KeyboardEvent) => {
    const [v, hz] = corner.split("-") as ["top" | "bottom", "left" | "right"];
    const next =
      e.key === "ArrowLeft" ? `${v}-left` : e.key === "ArrowRight" ? `${v}-right` : e.key === "ArrowUp" ? `top-${hz}` : e.key === "ArrowDown" ? `bottom-${hz}` : null;
    if (!next) return;
    e.preventDefault();
    if (next !== corner) onCorner(next as DockCorner);
  };
  // a picture can be dragged anywhere on it; a live panel only by its
  // header, so its own clicks and selection still work
  const byBody = Boolean(pane.mini);
  return (
    <motion.div
      role="region"
      aria-label={t("dock.mini.label", { name: pane.label })}
      data-dock-mini={pane.id}
      style={{ x, y, width: size.w, height: size.h }}
      initial={{ opacity: 0, scale: 0.94 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.94 }}
      transition={reduced ? { duration: 0 } : { duration: 0.18, ease: EASE_OUT }}
      drag
      dragControls={controls}
      dragListener={byBody}
      dragMomentum={false}
      dragElastic={0.12}
      dragConstraints={{ left: 0, top: HEADER, right: Math.max(0, room.w - size.w), bottom: Math.max(HEADER, room.h - size.h) }}
      whileDrag={reduced ? undefined : { scale: 1.02 }}
      onDragStart={() => (dragging.current = true)}
      onDragEnd={(_, info) => land(info)}
      className={cn("group pointer-events-auto absolute left-0 top-0", byBody && "cursor-grab active:cursor-grabbing")}
    >
      {/* the face: the panel or its picture, never covered */}
      <div className="absolute inset-0 overflow-hidden rounded-xl border bg-card shadow-lg shadow-(color:--shadow-color) transition-[border-radius] duration-150 ease-out group-hover:rounded-t-none group-focus-within:rounded-t-none">
      {pane.mini ? (
        <div className="absolute inset-0 flex min-h-0 min-w-0 flex-col">{pane.mini()}</div>
      ) : (
        // a live panel laid out at the size it has in the side panel and
        // drawn small, so it reads as the panel rather than a cramped one
        <div
          className="absolute left-0 top-0 flex min-h-0 min-w-0 origin-top-left flex-col"
          style={{ width: size.w / LIVE_SCALE, height: size.h / LIVE_SCALE, transform: `scale(${LIVE_SCALE})` }}
        >
          {pane.render(true)}
        </div>
      )}
      </div>
      {/* the header, on top of the face: the window grows by it on hover */}
      <div
        onPointerDown={(e) => controls.start(e)}
        style={{ height: HEADER }}
        className="absolute inset-x-0 bottom-full z-10 flex translate-y-1 cursor-grab items-center gap-1.5 rounded-t-xl border border-b-0 bg-card px-1.5 opacity-0 transition-[opacity,translate] duration-150 ease-out pointer-events-none active:cursor-grabbing group-hover:pointer-events-auto group-hover:translate-y-0 group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:translate-y-0 group-focus-within:opacity-100"
      >
        <Tip label={t("dock.mini.move", { name: pane.label })}>
          <button
            type="button"
            aria-label={t("dock.mini.move", { name: pane.label })}
            onKeyDown={onKey}
            className="flex min-w-0 flex-1 cursor-grab items-center gap-1.5 rounded-md px-1 text-left text-small text-foreground outline-none active:cursor-grabbing"
          >
            <span aria-hidden className="flex shrink-0 text-muted-foreground [&_svg]:size-[14px]">
              {pane.icon}
            </span>
            <span className="truncate">{pane.miniLabel ?? pane.label}</span>
          </button>
        </Tip>
        {/* its own controls, then back to the side panel, then close */}
        <span onPointerDown={(e) => e.stopPropagation()} className="flex shrink-0 items-center gap-0.5">
          {pane.miniActions?.()}
          <Tip label={t("dock.mini.restore", { name: pane.label })}>
            <button type="button" aria-label={t("dock.mini.restore", { name: pane.label })} onClick={onRestore} className={MINI_BUTTON}>
              <Expand size={14} />
            </button>
          </Tip>
          <Tip label={t("dock.mini.close", { name: pane.label })}>
            <button type="button" aria-label={t("dock.mini.close", { name: pane.label })} onClick={onClose} className={MINI_BUTTON}>
              <X size={14} />
            </button>
          </Tip>
        </span>
      </div>
    </motion.div>
  );
}
