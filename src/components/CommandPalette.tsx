// Cmd+K: everything, one field away.
//
// Empty query is a switcher, every agent and room, ready to jump to.
// Typing filters those by name (prefix matches first) and, after a short
// debounce, searches every transcript on the server; a message hit jumps
// to the exact conversation and lane it lives in. One flat keyboard
// cursor runs across all sections, because reaching for arrow keys
// should never care about headings.
import { useEffect, useMemo, useRef, useState } from "react";
import CornerDownLeft from "lucide-react/dist/esm/icons/corner-down-left.js";
import MessageSquare from "lucide-react/dist/esm/icons/message-square.js";
import Search from "lucide-react/dist/esm/icons/search.js";
import Users from "lucide-react/dist/esm/icons/users.js";
import { api, useStore, type Bot } from "@/state/store";
import { AgentAvatar } from "./Avatar";
import { cn } from "@/lib/cn";

interface MessageHit {
  threadId: string;
  messageId: string;
  at: number;
  snippet: string;
  botId?: string;
  blokId?: string;
  name: string;
  task?: string;
}

/** Name ranking: prefix beats substring, and input order (recency,
 * pinning) survives inside each tier. */
function rankByName<T>(items: T[], nameOf: (item: T) => string, query: string): T[] {
  if (!query) return items;
  const q = query.toLowerCase();
  const prefix: T[] = [];
  const inside: T[] = [];
  for (const item of items) {
    const name = nameOf(item).toLowerCase();
    if (name.startsWith(q)) prefix.push(item);
    else if (name.includes(q)) inside.push(item);
  }
  return [...prefix, ...inside];
}

export function CommandPalette() {
  const { state, dispatch } = useStore();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<MessageHit[]>([]);
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k" && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        setOpen((was) => !was);
        setQuery("");
        setHits([]);
        setCursor(0);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // transcript search rides a debounce; stale answers are dropped
  useEffect(() => {
    if (!open || !query.trim()) {
      setHits([]);
      return;
    }
    let alive = true;
    const t = setTimeout(() => {
      api(`/api/search?q=${encodeURIComponent(query.trim())}&limit=12`)
        .then((r) => alive && setHits(r.hits ?? []))
        .catch(() => alive && setHits([]));
    }, 150);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [open, query]);

  const bots = useMemo(
    () => rankByName(state.bots.filter((b) => !b.hidden), (b) => b.name, query.trim()),
    [state.bots, query],
  );
  const rooms = useMemo(
    () => rankByName(state.bloks, (r) => r.name, query.trim()),
    [state.bloks, query],
  );
  const total = bots.length + rooms.length + hits.length;

  useEffect(() => {
    setCursor((c) => Math.min(c, Math.max(0, total - 1)));
  }, [total]);

  if (!open) return null;

  const activate = (index: number) => {
    if (index < bots.length) {
      dispatch({ type: "select", id: bots[index].id });
    } else if (index < bots.length + rooms.length) {
      dispatch({ type: "select", id: rooms[index - bots.length].id });
    } else {
      const hit = hits[index - bots.length - rooms.length];
      if (!hit) return;
      if (hit.blokId) {
        dispatch({ type: "select", id: hit.blokId });
      } else if (hit.botId) {
        dispatch({ type: "select", id: hit.botId });
        const bot = state.bots.find((b) => b.id === hit.botId);
        // the hit may live in another lane; open that lane
        if (bot && bot.activeTaskId !== hit.threadId && bot.tasks?.some((t) => t.id === hit.threadId)) {
          dispatch({ type: "selectTask", botId: hit.botId, taskId: hit.threadId });
        }
      }
    }
    setOpen(false);
  };

  const move = (delta: number) => {
    if (!total) return;
    const next = (cursor + delta + total) % total;
    setCursor(next);
    listRef.current
      ?.querySelector(`[data-index="${next}"]`)
      ?.scrollIntoView({ block: "nearest" });
  };

  const row = (index: number, content: React.ReactNode, onPick: () => void) => (
    <button
      key={index}
      data-index={index}
      onClick={onPick}
      onMouseMove={() => setCursor(index)}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left",
        index === cursor ? "bg-accent" : "",
      )}
    >
      {content}
      {index === cursor && (
        <CornerDownLeft size={13} className="ml-auto shrink-0 text-muted-foreground/60" />
      )}
    </button>
  );

  let index = -1;

  return (
    <div
      className="fixed inset-0 z-50 flex animate-fade-in items-start justify-center bg-black/40 pt-[14vh] dark:bg-black/60"
      onMouseDown={() => setOpen(false)}
    >
      <div
        className="flex max-h-[60vh] w-[560px] max-w-[92vw] animate-pop-in flex-col overflow-hidden rounded-2xl border bg-popover shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2.5 border-b px-4">
          <Search size={16} className="shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") (e.preventDefault(), move(1));
              else if (e.key === "ArrowUp") (e.preventDefault(), move(-1));
              else if (e.key === "Enter") activate(cursor);
              else if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                setOpen(false);
              }
            }}
            placeholder="Jump to an agent, room, or anything anyone said…"
            className="h-12 w-full bg-transparent text-[14px] text-foreground outline-none placeholder:text-muted-foreground"
          />
          <kbd className="shrink-0 rounded-md border px-1.5 py-0.5 text-[10.5px] text-muted-foreground">
            esc
          </kbd>
        </div>

        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto p-2">
          {bots.length > 0 && (
            <Section label="Agents">
              {bots.map((bot: Bot) =>
                row(
                  ++index,
                  <>
                    <AgentAvatar bot={bot} size={26} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13.5px] font-medium text-foreground">
                        {bot.name}
                      </span>
                      {bot.title && (
                        <span className="block truncate text-[11.5px] text-muted-foreground">
                          {bot.title}
                        </span>
                      )}
                    </span>
                  </>,
                  () => activate(bots.indexOf(bot)),
                ),
              )}
            </Section>
          )}
          {rooms.length > 0 && (
            <Section label="Rooms">
              {rooms.map((room) =>
                row(
                  ++index,
                  <>
                    <span className="flex size-[26px] shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                      <Users size={13} />
                    </span>
                    <span className="truncate text-[13.5px] font-medium text-foreground">
                      {room.name}
                    </span>
                  </>,
                  () => activate(bots.length + rooms.indexOf(room)),
                ),
              )}
            </Section>
          )}
          {hits.length > 0 && (
            <Section label="Messages">
              {hits.map((hit, i) =>
                row(
                  ++index,
                  <>
                    <span className="flex size-[26px] shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                      <MessageSquare size={12} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12.5px] text-foreground">
                        {hit.snippet}
                      </span>
                      <span className="block truncate text-[11px] text-muted-foreground">
                        {hit.name}
                        {hit.task ? ` · ${hit.task}` : ""}
                      </span>
                    </span>
                  </>,
                  () => activate(bots.length + rooms.length + i),
                ),
              )}
            </Section>
          )}
          {total === 0 && (
            <div className="px-3 py-8 text-center text-[13px] text-muted-foreground">
              Nothing matches yet.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-1">
      <div className="px-3 pb-1 pt-2 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
        {label}
      </div>
      {children}
    </div>
  );
}
