// Where the terminal panel sits around a conversation, and the edge you
// drag to size it.
//
// The panel can be on any side of the chat, half of it, or over the whole
// window, and it moves between those without being rebuilt. Rebuilding
// would mean new xterms, every tab's screen replayed from the server, and
// a flash of empty terminal on every move. So the panel is drawn once,
// into an element of its own (a portal), and that element is what moves:
// each place it can go is an empty slot, and whichever slot is on screen
// takes the element in. Moving a DOM node keeps everything inside it,
// screens and scroll positions included; the terminals refit to their new
// box and the keyboard is put back in the open tab.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { TerminalPanel } from "@/components/Terminal";
import { cn } from "@/lib/cn";
import {
  across,
  arrangeTerminal,
  clampDock,
  dockSide,
  resizeTerminal,
  shownSize,
  TERMINAL_SIZE,
  type TerminalPosition,
} from "@/lib/terminalLayout";
import { useEscape } from "@/lib/useEscape";
import { useTerminalLayout } from "@/lib/useTerminalSettings";
import { t } from "@/lib/i18n";

const EDGE: Record<TerminalPosition, string> = {
  left: "border-r",
  right: "border-l",
  top: "border-b",
  bottom: "border-t",
};

/** Whether this page can put a terminal in a window of its own: the
 * desktop app can, a browser tab opens a popup, and the web app reaching
 * another computer cannot, since its shells are not this page's to open. */
function popOutWay(): ((botId: string) => void) | null {
  if (window.bloks?.terminalWindow) return (botId) => void window.bloks!.terminalWindow!(botId);
  if (window.bloks || window.bloksWeb) return null;
  return (botId) => {
    window.open(
      `${location.pathname}?terminal=${encodeURIComponent(botId)}`,
      `bloks-terminal-${botId}`,
      "popup,width=900,height=560",
    );
  };
}

export function useTerminalDock({
  open,
  botId,
  botName,
  onClose,
  askNew,
  sideDock = false,
}: {
  open: boolean;
  botId: string;
  botName: string;
  onClose: () => void;
  askNew: number;
  /** The conversation has a side dock (dock/SideDock.tsx): a terminal on
   * the right is one of its panels, drawn in `dockSlot`, rather than a
   * column of its own with its own edge. */
  sideDock?: boolean;
}) {
  const [layout, setLayout] = useTerminalLayout();
  const [holder] = useState(() => {
    const element = document.createElement("div");
    element.className = "flex h-full min-h-0 w-full min-w-0 flex-col";
    return element;
  });
  const body = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }));
  const [dragging, setDragging] = useState<number | null>(null);
  const [focusNonce, setFocusNonce] = useState(0);
  const fill = layout.arrangement === "fill";
  const side = open ? dockSide(layout) : null;

  // The room the chat and the terminal share, for keeping both usable.
  useEffect(() => {
    const element = body.current;
    if (!element) return;
    const measure = () => {
      const box = element.getBoundingClientRect();
      if (box.width > 0 && box.height > 0) setRoom({ width: box.width, height: box.height });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Moved, or opened: the keyboard goes back into the open tab, since
  // moving a node loses its focus.
  useEffect(() => {
    if (open) setFocusNonce((n) => n + 1);
  }, [open, layout.position, layout.arrangement]);

  // Escape leaves the full window, unless the keyboard is in the shell,
  // where Escape belongs to whatever is running (vim would be unusable).
  // xterm keeps the keys it uses to itself, so only an Escape pressed
  // outside it ever gets here.
  useEscape(() => setLayout((l) => arrangeTerminal(l, "fill")), open && fill);

  const attach = useCallback(
    (node: HTMLDivElement | null) => {
      if (node && holder.parentNode !== node) node.appendChild(holder);
    },
    [holder],
  );

  const size = dragging ?? shownSize(layout, room);
  const way = popOutWay();

  // on the right, in the dock: the dock sizes it and draws its edge
  const inDock = sideDock && dockSide(layout) === "right";
  const dockSlot = open && inDock ? <div key="terminal" ref={attach} className="flex h-full min-h-0 w-full min-w-0 flex-col" /> : null;

  const slot = (at: TerminalPosition): ReactNode => {
    if (side !== at || (at === "right" && inDock)) return null;
    const piece = (
      <div
        key="terminal"
        ref={attach}
        className={cn("flex min-h-0 min-w-0 shrink-0 flex-col", EDGE[at])}
        style={across(at) ? { width: size } : { height: size }}
      />
    );
    const edge = (
      <ResizeEdge
        key="edge"
        side={at}
        size={size}
        room={room}
        onDrag={setDragging}
        onDone={(next) => {
          setDragging(null);
          setLayout((l) => resizeTerminal(l, next, room));
        }}
      />
    );
    return at === "left" || at === "top" ? [piece, edge] : [edge, piece];
  };

  const overlay =
    open && fill
      ? createPortal(
          <div className="fixed inset-0 z-40 flex animate-fade-in flex-col bg-card">
            <div ref={attach} className="flex min-h-0 flex-1 flex-col" />
          </div>,
          document.body,
        )
      : null;

  const panel = open
    ? createPortal(
        <TerminalPanel
          botId={botId}
          botName={botName}
          mode={fill ? "fill" : "docked"}
          onClose={onClose}
          onPopOut={
            way
              ? () => {
                  way(botId);
                  onClose();
                }
              : undefined
          }
          askNew={askNew}
          focusNonce={focusNonce}
          flat={inDock && !fill}
        />,
        holder,
      )
    : null;

  /** Opens it in a window of its own, where this page can. */
  const popOut = way
    ? () => {
        way(botId);
        onClose();
      }
    : undefined;
  return { layout, setLayout, inDock, body, slot, dockSlot, overlay, panel, popOut };
}

/**
 * The edge between the terminal and the chat. Drag it, or focus it and
 * use the arrow keys (Shift for bigger steps). The size is kept per side
 * once the drag ends, not on every frame of it.
 */
function ResizeEdge({
  side,
  size,
  room,
  onDrag,
  onDone,
}: {
  side: TerminalPosition;
  size: number;
  room: { width: number; height: number };
  onDrag: (size: number) => void;
  onDone: (size: number) => void;
}) {
  const wide = across(side);
  // which way is bigger: toward the chat
  const grow = side === "left" || side === "top" ? 1 : -1;
  const min = wide ? TERMINAL_SIZE.minWidth : TERMINAL_SIZE.minHeight;
  const max = Math.max(min, wide ? room.width - TERMINAL_SIZE.chatWidth : room.height - TERMINAL_SIZE.chatHeight);
  return (
    <div
      role="separator"
      aria-orientation={wide ? "vertical" : "horizontal"}
      aria-label={t("terminalDock.resizeTheTerminal")}
      aria-valuenow={Math.round(size)}
      aria-valuemin={min}
      aria-valuemax={Math.round(max)}
      tabIndex={0}
      onPointerDown={(e) => {
        // Pointer capture rather than window listeners, so a fast drag
        // that leaves the strip keeps working.
        e.currentTarget.setPointerCapture(e.pointerId);
        e.preventDefault();
        const start = wide ? e.clientX : e.clientY;
        let last = size;
        const move = (event: PointerEvent) => {
          const moved = (wide ? event.clientX : event.clientY) - start;
          last = clampDock(side, size + grow * moved, room);
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
        const keys = wide ? ["ArrowLeft", "ArrowRight"] : ["ArrowUp", "ArrowDown"];
        const at = keys.indexOf(e.key);
        if (at < 0) return;
        e.preventDefault();
        // ArrowRight and ArrowDown move the edge right or down
        const toward = at === 1 ? 1 : -1;
        onDone(clampDock(side, size + grow * toward * (e.shiftKey ? 64 : 16), room));
      }}
      className={cn(
        "shrink-0 bg-transparent outline-none transition-colors duration-150 hover:bg-accent focus-visible:bg-accent",
        wide ? "w-1.5 cursor-ew-resize" : "h-1.5 cursor-ns-resize",
      )}
    />
  );
}
