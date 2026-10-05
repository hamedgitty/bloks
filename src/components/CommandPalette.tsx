// Cmd+K: everything, one field away.
//
// Empty query is a switcher, every agent and room, ready to jump to.
// Typing filters those by name (prefix matches first) and, after a short
// debounce, searches every transcript on the server; a message hit jumps
// to the exact conversation and lane it lives in. One flat keyboard
// cursor runs across all sections, because reaching for arrow keys
// should never care about headings.
//
// The few things the app can be told to do sit under the agents and
// rooms, each with its key beside it (from src/lib/shortcuts.ts), so the
// palette teaches the shortcut that would have skipped it next time.
import { useEffect, useMemo, useRef, useState } from "react";
import BotIcon from "lucide-react/dist/esm/icons/bot.mjs";
import CornerDownLeft from "lucide-react/dist/esm/icons/corner-down-left.mjs";
import Keyboard from "lucide-react/dist/esm/icons/keyboard.mjs";
import MessageSquare from "lucide-react/dist/esm/icons/message-square.mjs";
import Search from "lucide-react/dist/esm/icons/search.mjs";
import SettingsIcon from "lucide-react/dist/esm/icons/settings-2.mjs";
import Users from "lucide-react/dist/esm/icons/users.mjs";
import { api, useStore, type Action, type Bot } from "@/state/store";
import { AgentAvatar } from "./Avatar";
import { SETTINGS_PAGES } from "./AppSettingsPanel";
import { Keys } from "./Shortcuts";
import { keysFor, platformOf } from "@/lib/shortcuts";
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

/** Things to do rather than places to go. `id` is the command's line in
 * the shortcuts list, when it has a key. */
const COMMANDS: ReadonlyArray<{
  id: string;
  label: string;
  /** Words people search for that the label does not say. */
  keywords: string;
  icon: React.ComponentType<{ size?: number }>;
  action: Action;
}> = [
  { id: "newAgent", label: "New agent", keywords: "create add hire bot", icon: BotIcon, action: { type: "toggleNewAgent", open: true } },
  { id: "newRoom", label: "New room", keywords: "create add group team", icon: Users, action: { type: "toggleNewRoom", open: true } },
  { id: "settings", label: "Settings", keywords: "preferences options", icon: SettingsIcon, action: { type: "toggleAppSettings", open: true } },
  { id: "shortcuts", label: "Keyboard shortcuts", keywords: "keys hotkeys help", icon: Keyboard, action: { type: "toggleShortcuts", open: true } },
];

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
  // Every command on an empty query, at the foot of the switcher where
  // they cost the jump-to-an-agent habit nothing; the matching ones once
  // something is typed.
  const commands = useMemo(() => {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return COMMANDS.filter((c) => words.every((w) => `${c.label} ${c.keywords}`.toLowerCase().includes(w)));
  }, [query]);
  // Settings pages by what they hold, so "voice" or "telegram" goes
  // straight to the page rather than through the Settings menu.
  const pages = useMemo(() => {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    return SETTINGS_PAGES.flatMap((g) => g.pages).filter((p) =>
      words.every((w) => `${p.label} ${p.keywords}`.toLowerCase().includes(w)),
    );
  }, [query]);
  const total = bots.length + rooms.length + commands.length + pages.length + hits.length;

  useEffect(() => {
    setCursor((c) => Math.min(c, Math.max(0, total - 1)));
  }, [total]);

  if (!open) return null;

  // where each section starts in the one flat cursor
  const commandsAt = bots.length + rooms.length;
  const pagesAt = commandsAt + commands.length;
  const hitsAt = pagesAt + pages.length;

  const activate = (index: number) => {
    if (index < bots.length) {
      dispatch({ type: "select", id: bots[index].id });
    } else if (index < commandsAt) {
      dispatch({ type: "select", id: rooms[index - bots.length].id });
    } else if (index < pagesAt) {
      dispatch(commands[index - commandsAt].action);
    } else if (index < hitsAt) {
      dispatch({ type: "toggleAppSettings", open: true, page: pages[index - pagesAt].id });
    } else {
      const hit = hits[index - hitsAt];
      if (!hit) return;
      if (hit.blokId) {
        dispatch({ type: "select", id: hit.blokId });
      } else if (hit.botId) {
        const bot = state.bots.find((b) => b.id === hit.botId);
        // the hit may live in another lane; open that lane
        const lane = bot?.tasks?.some((t) => t.id === hit.threadId) ? hit.threadId : undefined;
        dispatch({ type: "select", id: hit.botId, lane });
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
  const platform = platformOf();

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
            placeholder="Jump to an agent, a room, a setting, or anything anyone said…"
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
          {commands.length > 0 && (
            <Section label="Commands">
              {commands.map((command, i) => {
                const Icon = command.icon;
                return row(
                  ++index,
                  <>
                    <span className="flex size-[26px] shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                      <Icon size={13} />
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-foreground">
                      {command.label}
                    </span>
                    <Keys keys={keysFor(command.id, platform)} />
                  </>,
                  () => activate(commandsAt + i),
                );
              })}
            </Section>
          )}
          {pages.length > 0 && (
            <Section label="Settings">
              {pages.map((page, i) => {
                const Icon = page.icon;
                return row(
                  ++index,
                  <>
                    <span className="flex size-[26px] shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                      <Icon size={13} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13.5px] font-medium text-foreground">{page.label}</span>
                      <span className="block truncate text-[11.5px] text-muted-foreground">{page.description}</span>
                    </span>
                  </>,
                  () => activate(pagesAt + i),
                );
              })}
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
                  () => activate(hitsAt + i),
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
