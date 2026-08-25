// The workspace as a picture.
//
// Sections are neighborhoods, rooms are the tables people share, and
// the color on an agent says what it is doing right now: pulsing brand
// while it works, warning when it stopped to ask, quiet otherwise.
// Everything on screen is store state the sidebar already keeps live,
// so the map updates the moment anything changes and polls nothing.
// Clicking an agent or a room goes there; the map is a door, not a
// dashboard.
import { useMemo, useRef, useLayoutEffect, useState } from "react";
import Users from "lucide-react/dist/esm/icons/users.js";
import X from "lucide-react/dist/esm/icons/x.js";
import { useStore, type Bot } from "@/state/store";
import { AgentAvatar } from "./Avatar";
import { layoutTeamMap } from "@/lib/teamMap";
import { cn } from "@/lib/cn";

export function TeamMapPanel() {
  const { state, dispatch } = useStore();
  const frame = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(720);
  useLayoutEffect(() => {
    const el = frame.current;
    if (!el) return;
    const measure = () => setWidth(Math.max(360, el.clientWidth - 32));
    measure();
    const watcher = new ResizeObserver(measure);
    watcher.observe(el);
    return () => watcher.disconnect();
  }, []);

  const bots = state.bots.filter((b) => !b.hidden);
  const byId = new Map(bots.map((b) => [b.id, b]));
  const { nodes, edges, clusters, height } = useMemo(
    () =>
      layoutTeamMap(
        bots.map((b) => ({
          id: b.id,
          section: b.section,
          busy: b.busy,
          needsYou: b.tasks?.some((t) => t.state === "needs-you"),
        })),
        state.bloks.map((r) => ({ id: r.id, name: r.name, memberIds: r.memberIds })),
        width,
      ),
    [state.bots, state.bloks, width],
  );
  const needsYou = new Set(
    bots.filter((b) => b.tasks?.some((t) => t.state === "needs-you")).map((b) => b.id),
  );
  const roomsById = new Map(state.bloks.map((r) => [r.id, r]));

  const open = (id: string) => {
    dispatch({ type: "select", id });
    dispatch({ type: "toggleMap", open: false });
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4 md:p-10">
      <div
        ref={frame}
        className="flex max-h-full w-full max-w-[980px] flex-col overflow-hidden rounded-2xl border bg-background shadow-xl"
      >
        <div className="flex items-center justify-between border-b px-4 py-3">
          <div>
            <div className="text-[14px] font-semibold text-foreground">Team map</div>
            <div className="text-[12px] text-muted-foreground">
              Who is where, and what they are up to right now
            </div>
          </div>
          <button
            onClick={() => dispatch({ type: "toggleMap", open: false })}
            className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>
        <div className="overflow-auto p-4">
          <div className="relative" style={{ width, height }}>
            <svg width={width} height={height} className="absolute inset-0">
              {clusters.map((c) => (
                <g key={c.name}>
                  <rect
                    x={c.x + 8}
                    y={c.y + 8}
                    width={c.width - 16}
                    height={c.height - 16}
                    rx={20}
                    className="fill-muted/40 stroke-border"
                  />
                  <text
                    x={c.x + 24}
                    y={c.y + 30}
                    className="fill-[--color-muted-foreground] text-[11px] font-medium uppercase tracking-[0.08em]"
                  >
                    {c.name}
                  </text>
                </g>
              ))}
              {edges.map((edge, i) => {
                const from = nodes.find((n) => n.id === edge.from);
                const to = nodes.find((n) => n.id === edge.to);
                if (!from || !to) return null;
                return (
                  <line
                    key={i}
                    x1={from.x}
                    y1={from.y}
                    x2={to.x}
                    y2={to.y}
                    className={cn(
                      "stroke-border",
                      edge.active && "animate-pulse stroke-[--color-brand]",
                    )}
                    strokeWidth={edge.active ? 2 : 1.25}
                  />
                );
              })}
            </svg>
            {nodes.map((node) => {
              if (node.kind === "room") {
                const room = roomsById.get(node.id);
                return (
                  <button
                    key={node.id}
                    onClick={() => open(node.id)}
                    title={room?.name}
                    style={{ left: node.x, top: node.y }}
                    className="absolute flex -translate-x-1/2 -translate-y-1/2 items-center gap-1.5 rounded-xl border bg-card px-2.5 py-1.5 text-[12px] font-medium text-foreground shadow-sm transition-transform hover:scale-105"
                  >
                    <Users size={12} className="text-muted-foreground" />
                    <span className="max-w-[110px] truncate">{room?.name}</span>
                  </button>
                );
              }
              const bot = byId.get(node.id) as Bot | undefined;
              if (!bot) return null;
              return (
                <button
                  key={node.id}
                  onClick={() => open(node.id)}
                  title={`${bot.name}${bot.busy ? " (working)" : needsYou.has(bot.id) ? " (waiting for you)" : ""}`}
                  style={{ left: node.x, top: node.y }}
                  className="absolute flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-1 transition-transform hover:scale-105"
                >
                  <span
                    className={cn(
                      "rounded-2xl ring-2 ring-transparent",
                      bot.busy && "animate-pulse ring-[--color-brand]",
                      needsYou.has(bot.id) && "ring-[--color-warning]",
                    )}
                  >
                    <AgentAvatar bot={bot} size={44} />
                  </span>
                  <span className="max-w-[86px] truncate text-[11px] text-foreground">
                    {bot.name}
                  </span>
                </button>
              );
            })}
          </div>
          {bots.length === 0 && (
            <div className="py-16 text-center text-[13px] text-muted-foreground">
              No agents yet. The map fills in as you hire.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
