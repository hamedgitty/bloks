// Watching an agent's desktop without leaving the conversation.
//
// The viewer takes the screen; the chat rides wherever you put it. Dock
// it to either side or the bottom and drag its inner edge to taste, or
// float it and move it like a window, with a corner handle to resize.
// The close button never leaves the top corner, and Escape always works.
// The arrangement is remembered, because a layout you fixed once should
// stay fixed.
import { useCallback, useEffect, useRef, useState } from "react";
import ExternalLink from "lucide-react/dist/esm/icons/external-link.js";
import GripHorizontal from "lucide-react/dist/esm/icons/grip-horizontal.js";
import PanelBottom from "lucide-react/dist/esm/icons/panel-bottom.js";
import PanelLeft from "lucide-react/dist/esm/icons/panel-left.js";
import PanelRight from "lucide-react/dist/esm/icons/panel-right.js";
import PictureInPicture2 from "lucide-react/dist/esm/icons/picture-in-picture-2.js";
import X from "lucide-react/dist/esm/icons/x.js";
import { api, useStore, type Bot } from "@/state/store";
import { AgentAvatar } from "./Avatar";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";

type Dock = "left" | "right" | "bottom" | "float";

interface ChatLayout {
  dock: Dock;
  /** Side-dock width, bottom-dock height, and the float's box. */
  width: number;
  height: number;
  x: number;
  y: number;
}

const LAYOUT_KEY = "bloks-desktop-chat";
const LIMITS = {
  width: [260, 560],
  height: [180, 480],
  floatW: [280, 640],
  floatH: [300, 700],
} as const;

const clampTo = (value: number, [min, max]: readonly [number, number]) =>
  Math.max(min, Math.min(max, value));

function loadLayout(): ChatLayout {
  try {
    const saved = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? "");
    if (saved && ["left", "right", "bottom", "float"].includes(saved.dock)) {
      return {
        dock: saved.dock,
        width: clampTo(Number(saved.width) || 340, LIMITS.width),
        height: clampTo(Number(saved.height) || 260, LIMITS.height),
        // a float parked on last week's monitor must land inside this one
        x: Math.max(8, Math.min(window.innerWidth - 140, Number(saved.x) || 80)),
        y: Math.max(52, Math.min(window.innerHeight - 80, Number(saved.y) || 80)),
      };
    }
  } catch {}
  return { dock: "right", width: 340, height: 260, x: 80, y: 80 };
}

function SideChat({ bot }: { bot: Bot }) {
  const { state } = useStore();
  const live = state.bots.find((b) => b.id === bot.id) ?? bot;
  const [draft, setDraft] = useState("");
  const endRef = useRef<HTMLDivElement>(null);

  const messages = live.messages.filter((m) => m.kind === "text" && m.text);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length, live.busy]);

  const send = () => {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    void api(`/api/bots/${bot.id}/messages`, {
      method: "POST",
      body: JSON.stringify({ text }),
    }).catch(() => {});
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        <div className="flex flex-col gap-2">
          {messages.slice(-40).map((m) => (
            <div
              key={m.id}
              className={cn(
                "max-w-[85%] rounded-2xl px-3 py-1.5 text-[13px] leading-relaxed",
                m.role === "user"
                  ? "self-end bg-primary text-primary-foreground"
                  : "self-start bg-muted text-foreground",
              )}
            >
              {m.text}
            </div>
          ))}
          {live.busy && (
            <div className="self-start px-1 text-[12px] text-muted-foreground">Working…</div>
          )}
          <div ref={endRef} />
        </div>
      </div>
      <div className="shrink-0 border-t p-2.5">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
          placeholder={`Message ${bot.name}`}
          className="w-full rounded-xl border border-input bg-transparent px-3 py-2 text-[13px] text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-ring/60"
        />
      </div>
    </div>
  );
}

export function DesktopOverlay({
  bot,
  url,
  onClose,
}: {
  bot: Bot;
  url: string;
  onClose: () => void;
}) {
  const [layout, setLayout] = useState<ChatLayout>(loadLayout);
  // pointer capture over an iframe dies the moment the cursor crosses
  // it; a shield div during any drag keeps the events coming
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    // settle-debounced: a drag emits dozens of layouts a second, and
    // none of the intermediate ones is worth a synchronous disk write
    const t = setTimeout(() => localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout)), 250);
    return () => clearTimeout(t);
  }, [layout]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    // a shrinking window pulls the float back inside it
    const onResize = () =>
      setLayout((cur) =>
        cur.dock === "float"
          ? {
              ...cur,
              x: Math.max(8, Math.min(window.innerWidth - 140, cur.x)),
              y: Math.max(52, Math.min(window.innerHeight - 80, cur.y)),
            }
          : cur,
      );
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
    };
  }, [onClose]);

  const trackPointer = useCallback(
    (onMove: (e: PointerEvent) => void) => {
      setDragging(true);
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        setDragging(false);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    },
    [],
  );

  /** Dragging the divider between viewer and chat resizes the dock. */
  const beginEdgeResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const start = { x: e.clientX, y: e.clientY, w: layout.width, h: layout.height };
    trackPointer((ev) => {
      setLayout((cur) => {
        if (cur.dock === "right")
          return { ...cur, width: clampTo(start.w + (start.x - ev.clientX), LIMITS.width) };
        if (cur.dock === "left")
          return { ...cur, width: clampTo(start.w + (ev.clientX - start.x), LIMITS.width) };
        return { ...cur, height: clampTo(start.h + (start.y - ev.clientY), LIMITS.height) };
      });
    });
  };

  /** Dragging the grip moves the float; from a dock it tears it off. */
  const beginMove = (e: React.PointerEvent) => {
    e.preventDefault();
    const offset = { x: e.clientX - layout.x, y: e.clientY - layout.y };
    if (layout.dock !== "float") {
      setLayout((cur) => ({
        ...cur,
        dock: "float",
        x: e.clientX - 140,
        y: e.clientY - 16,
      }));
      offset.x = 140;
      offset.y = 16;
    }
    trackPointer((ev) => {
      setLayout((cur) => ({
        ...cur,
        x: Math.max(8, Math.min(window.innerWidth - 120, ev.clientX - offset.x)),
        y: Math.max(52, Math.min(window.innerHeight - 60, ev.clientY - offset.y)),
      }));
    });
  };

  const beginCornerResize = (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const start = { x: e.clientX, y: e.clientY, w: layout.width, h: layout.height };
    trackPointer((ev) => {
      setLayout((cur) => ({
        ...cur,
        width: clampTo(start.w + (ev.clientX - start.x), LIMITS.floatW),
        height: clampTo(start.h + (ev.clientY - start.y), LIMITS.floatH),
      }));
    });
  };

  const dockButtons = (
    <div className="flex items-center gap-0.5">
      {(
        [
          ["left", PanelLeft, "Dock left"],
          ["bottom", PanelBottom, "Dock bottom"],
          ["right", PanelRight, "Dock right"],
          ["float", PictureInPicture2, "Float"],
        ] as const
      ).map(([dock, Icon, label]) => (
        <button
          key={dock}
          onClick={() => setLayout((cur) => ({ ...cur, dock }))}
          title={label}
          className={cn(
            "rounded-md p-1 transition-colors",
            layout.dock === dock
              ? "bg-accent text-foreground"
              : "text-muted-foreground/60 hover:text-foreground",
          )}
        >
          <Icon size={13} />
        </button>
      ))}
    </div>
  );

  const chatCard = (
    <div
      className={cn(
        "flex min-h-0 min-w-0 flex-col bg-background",
        layout.dock === "float" &&
          "fixed z-[70] overflow-hidden rounded-2xl border shadow-2xl shadow-[--shadow-color]",
      )}
      style={
        layout.dock === "float"
          ? { left: layout.x, top: layout.y, width: layout.width, height: layout.height }
          : layout.dock === "bottom"
            ? { height: layout.height }
            : { width: layout.width }
      }
    >
      {/* the chat's own header: grip to move, docks to place */}
      <div
        onPointerDown={beginMove}
        className="flex shrink-0 cursor-grab select-none items-center justify-between border-b px-2 py-1 active:cursor-grabbing"
      >
        <div className="flex items-center gap-1.5 pl-1">
          <GripHorizontal size={13} className="text-muted-foreground/50" />
          <span className="text-[11.5px] font-medium text-muted-foreground">Chat</span>
        </div>
        <div onPointerDown={(e) => e.stopPropagation()}>{dockButtons}</div>
      </div>
      <SideChat bot={bot} />
      {layout.dock === "float" && (
        <div
          onPointerDown={beginCornerResize}
          className="absolute bottom-0 right-0 size-4 cursor-nwse-resize"
          title="Resize"
        >
          <div className="absolute bottom-1 right-1 size-2 rounded-sm border-b-2 border-r-2 border-muted-foreground/40" />
        </div>
      )}
    </div>
  );

  const divider = (
    <div
      onPointerDown={beginEdgeResize}
      className={cn(
        "shrink-0 bg-border transition-colors hover:bg-ring/50",
        layout.dock === "bottom" ? "h-1 w-full cursor-row-resize" : "w-1 cursor-col-resize",
      )}
    />
  );

  const viewer = (
    <iframe
      src={url}
      title={`${bot.name}'s desktop`}
      className={cn("min-h-0 w-full flex-1 border-0 bg-black", dragging && "pointer-events-none")}
      allow="clipboard-read; clipboard-write"
    />
  );

  return (
    <div className="fixed inset-0 z-[60] flex animate-fade-in flex-col bg-background">
      <div className="flex h-[48px] shrink-0 items-center justify-between border-b px-3">
        <div className="flex items-center gap-2">
          <AgentAvatar bot={bot} size={26} />
          <span className="text-[13.5px] font-semibold text-foreground">
            {bot.name}'s desktop
          </span>
        </div>
        <div className="flex items-center gap-1">
          <a href={url} target="_blank" rel="noreferrer" title="Open in a browser window">
            <Button variant="ghost" size="icon-sm" aria-label="Open in browser">
              <ExternalLink size={15} />
            </Button>
          </a>
          <Button variant="secondary" size="icon-sm" aria-label="Close desktop view" onClick={onClose}>
            <X size={16} />
          </Button>
        </div>
      </div>

      {layout.dock === "float" ? (
        <>
          <div className="flex min-h-0 flex-1 flex-col">{viewer}</div>
          {chatCard}
        </>
      ) : layout.dock === "bottom" ? (
        <div className="flex min-h-0 flex-1 flex-col">
          {viewer}
          {divider}
          {chatCard}
        </div>
      ) : (
        <div className={cn("flex min-h-0 flex-1", layout.dock === "left" && "flex-row-reverse")}>
          {viewer}
          {divider}
          {chatCard}
        </div>
      )}
    </div>
  );
}
