// Search: everything, one field away, from the sidebar's search button or
// ⌘K.
//
// Empty, it is a switcher: the chats you were most recently in, each a
// Ctrl+number away, then what can be done to the conversation on screen
// and the app's places. Typing filters the agents and rooms by name
// (prefix matches first), every action and settings page by what it
// says, and, after a short debounce, searches every transcript on the
// server, best match first (ranked as an agent's own recall is). A
// message hit opens the exact conversation and lane it lives in and
// lands on the message itself (src/lib/chatAsk.ts). One flat keyboard
// cursor runs across all sections, because reaching for arrow keys
// should never care about headings.
//
// Opened from the keyboard it is simply there: something reached for all
// day should never make you wait for it. Opened with the mouse it settles
// in, quickly, the way the rest of the app's panels do.
import { useEffect, useMemo, useRef, useState } from "react";
import { Bot as BotIcon } from "@/components/icons";
import { Brain } from "@/components/icons";
import { CircleStop } from "@/components/icons";
import { Keyboard } from "@/components/icons";
import { LayoutGrid } from "@/components/icons";
import { MessageSquare } from "@/components/icons";
import { Plus } from "@/components/icons";
import { Puzzle } from "@/components/icons";
import { Search } from "@/components/icons";
import { Settings as SettingsIcon } from "@/components/icons";
import { Usage as UsageIcon } from "@/components/icons";
import { SquarePen } from "@/components/icons";
import { SquareTerminal } from "@/components/icons";
import { Users } from "@/components/icons";
import { X } from "@/components/icons";
import { Zap } from "@/components/icons";
import { api, openLaneWorking, useStore, type Action, type Blok, type Bot } from "@/state/store";
import { AgentAvatar } from "./Avatar";
import { SETTINGS_PAGES } from "./AppSettingsPanel";
import { askChat } from "@/lib/chatAsk";
import { closeRefusal } from "@/lib/conversationKeys";
import { splitHighlight } from "@/lib/find";
import { keysFor, platformOf } from "@/lib/shortcuts";
import { cn } from "@/lib/cn";
import { openWorkspaceDialog, useWorkspaces } from "@/lib/workspaces";
import type { WorkspaceInfo } from "@/types/bridge";
import { WorkspaceMark } from "./WorkspaceMark";
import { running, useExtensions } from "@/lib/extensions";
import { runExtensionCommand } from "./extensions/ExtensionHost";
import { goToWorkspace } from "./WorkspaceSwitcher";
import { t, useLanguage } from "@/lib/i18n";

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

const OPEN_EVENT = "bloks:search";

/** Opens the search window from anywhere: the sidebar's button, a menu. */
export function openSearch() {
  window.dispatchEvent(new Event(OPEN_EVENT));
}

type Icon = React.ComponentType<{ size?: number; strokeWidth?: number }>;

/** Something to do, or somewhere to go. `id` is the command's line in
 * the shortcuts list, when it has a key there. */
interface Command {
  id: string;
  label: string;
  /** Words people search for that the label does not say. */
  keywords: string;
  icon: Icon;
  /** Shown once it is typed for, and not on the empty palette, which
   * keeps to what is reached for most. */
  quiet?: boolean;
  run: () => void;
}

/** How many recent chats an empty search offers, each with its Ctrl key. */
const RECENT = 6;

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

/** Every typed word somewhere in what a row says or is known by. */
const matches = (words: string[], text: string) => words.every((w) => text.toLowerCase().includes(w));

type Chat = { kind: "agent"; bot: Bot } | { kind: "room"; room: Blok };

export function CommandPalette() {
  const { state, dispatch } = useStore();
  // null is closed; otherwise how it was opened, which decides whether
  // it settles in or is simply there
  const [open, setOpen] = useState<null | "keys" | "pointer">(null);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<MessageHit[]>([]);
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const platform = platformOf();
  const extensions = useExtensions();

  useEffect(() => {
    const show = (how: "keys" | "pointer", toggle: boolean) => {
      setOpen((was) => (toggle && was ? null : how));
      setQuery("");
      setHits([]);
      setCursor(0);
    };
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k" && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        show("keys", true);
      }
    };
    const onOpen = () => show("pointer", false);
    window.addEventListener("keydown", onKey);
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(OPEN_EVENT, onOpen);
    };
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
    const timer = setTimeout(() => {
      api(`/api/search?q=${encodeURIComponent(query.trim())}&limit=12`)
        .then((r) => alive && setHits(r.hits ?? []))
        .catch(() => alive && setHits([]));
    }, 150);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [open, query]);

  const q = query.trim();
  const words = useMemo(() => q.toLowerCase().split(/\s+/).filter(Boolean), [q]);

  // The agent whose conversation is on screen, or would be with the
  // pages closed: the one App.tsx shows. A room has no lanes, terminal or
  // stop of its own here, so with one open the agent's actions go.
  const room = state.bloks.find((b) => b.id === state.selectedId);
  const bot = room
    ? null
    : (state.bots.find((b) => b.id === state.selectedId && !b.hidden) ?? state.bots.find((b) => !b.hidden) ?? null);
  const working = bot ? openLaneWorking(bot) : false;
  // the labels below are words, kept in memos: a new language makes them again
  const language = useLanguage();

  // Agents and rooms together, as the sidebar lists them: most recently
  // with you first. Empty, only the latest few; typed, every match.
  const chats = useMemo<Chat[]>(() => {
    const all: Array<Chat & { at: number; name: string }> = [
      ...state.bots.filter((b) => !b.hidden).map((bot) => ({ kind: "agent" as const, bot, at: bot.activeWithYouAt ?? 0, name: bot.name })),
      ...state.bloks.map((room) => ({ kind: "room" as const, room, at: room.activeWithYouAt ?? 0, name: room.name })),
    ].sort((a, b) => b.at - a.at);
    return q ? rankByName(all, (c) => c.name, q) : all.slice(0, RECENT);
  }, [state.bots, state.bloks, q]);

  // What can be done here: the conversation on screen first, then the
  // app's own. Each action on a conversation brings the chat back first,
  // closing whatever page covers it, so the result is seen happening.
  const actions = useMemo<Command[]>(() => {
    const go = (action: Action) => () => dispatch(action);
    const list: Command[] = [];
    if (bot) {
      const toChat = () => dispatch({ type: "select", id: bot.id });
      list.push(
        {
          id: "newConversation",
          label: t("commandPalette.newConversation"),
          keywords: `${bot.name} lane thread task chat start fresh`,
          icon: Plus,
          run: () => (toChat(), dispatch({ type: "newTask", botId: bot.id })),
        },
        {
          id: "find",
          label: t("commandPalette.findInConversation"),
          keywords: "search this thread text",
          icon: Search,
          run: () => (askChat({ kind: "find", botId: bot.id }), toChat()),
        },
      );
      // only while the open one can go: General stays, and one at work
      // is stopped first
      if (!closeRefusal(bot.tasks ?? [], bot.activeTaskId ?? bot.threadId)) {
        list.push({
          id: "closeConversation",
          label: t("commandPalette.closeConversation"),
          keywords: `${bot.name} lane thread task tab delete end`,
          icon: X,
          run: () => (askChat({ kind: "close", botId: bot.id }), toChat()),
        });
      }
      if (working) {
        list.push({
          id: "stop",
          label: t("commandPalette.stopAgent", { name: bot.name }),
          keywords: "stop interrupt cancel halt agent",
          icon: CircleStop,
          run: go({ type: "interrupt", botId: bot.id }),
        });
      }
      list.push({
        // named for its line in the shortcut list, so the row shows ⌃`
        id: "terminalToggle",
        label: t("commandPalette.openTerminal"),
        keywords: `shell console command line ${bot.name} folder`,
        icon: SquareTerminal,
        run: () => (askChat({ kind: "terminal", botId: bot.id }), toChat()),
      });
    }
    list.push(
      { id: "newAgent", label: t("commandPalette.newAgent"), keywords: "create add hire bot", icon: SquarePen, run: go({ type: "toggleNewAgent", open: true }) },
      { id: "newRoom", label: t("commandPalette.newRoom"), keywords: "create add group team", icon: Users, quiet: true, run: go({ type: "toggleNewRoom", open: true }) },
      { id: "shortcuts", label: t("commandPalette.keyboardShortcuts"), keywords: "keys hotkeys help", icon: Keyboard, quiet: true, run: go({ type: "toggleShortcuts", open: true }) },
    );
    // what running extensions add (src/components/extensions/ExtensionHost.tsx):
    // shown once typed for, named with the extension they come from
    for (const ext of running(extensions)) {
      for (const command of ext.commands) {
        list.push({
          id: `extension:${ext.id}:${command.id}`,
          label: t("commandPalette.extensionCommand", { name: ext.name, command: command.title }),
          keywords: `extension ${ext.name} ${command.description ?? ""}`,
          icon: Puzzle,
          quiet: true,
          run: () => runExtensionCommand(ext, command.id),
        });
      }
    }
    return list;
  }, [bot, working, dispatch, language, extensions]);

  // The other workspaces are places too, and the way to them at any
  // width: the switcher lives in the title bar, which a narrow window hides.
  const workspaces = useWorkspaces();
  const elsewhere = useMemo<Command[]>(() => {
    if (!workspaces.available) return [];
    const markOf = (ws: WorkspaceInfo): Icon => {
      const Mark = ({ size = 16 }: { size?: number }) => <WorkspaceMark mark={ws.mark} logo={ws.logo} size={size} />;
      return Mark;
    };
    return [
      ...workspaces.workspaces
        .filter((ws) => ws.id !== workspaces.current && ws.status !== "failed")
        .map((ws) => ({
          id: `workspace:${ws.id}`,
          label: t("commandPalette.switchTo", { name: ws.name }),
          keywords: "workspace switch go open",
          icon: markOf(ws),
          run: () => void goToWorkspace(ws.id),
        })),
      { id: "workspaceSettings", label: t("commandPalette.workspaceSettings"), keywords: "workspace name mark members online notifications mute", icon: SettingsIcon, quiet: true, run: () => dispatch({ type: "toggleAppSettings", open: true, page: "workspace:general" }) },
      { id: "newWorkspace", label: t("commandPalette.newWorkspace"), keywords: "workspace create add business team", icon: Plus, quiet: true, run: () => openWorkspaceDialog("new") },
    ];
  }, [workspaces, dispatch, language]);

  // The app's places, as the rail has them.
  const places = useMemo<Command[]>(
    () => [
      { id: "overview", label: t("commandPalette.overview"), keywords: "home today brief activity", icon: LayoutGrid, run: () => dispatch({ type: "openPage", page: "overview" }) },
      { id: "automations", label: t("commandPalette.automations"), keywords: "routines schedules watchers workflows webhooks jobs", icon: Zap, run: () => dispatch({ type: "toggleRoutines", open: true }) },
      { id: "agents", label: t("commandPalette.agents"), keywords: "registry org chart hierarchy reports lead teams who contact", icon: Users, run: () => dispatch({ type: "openPage", page: "agents" }) },
      { id: "memory", label: t("common.memory"), keywords: "notes remember about you", icon: Brain, run: () => dispatch({ type: "openPage", page: "memory" }) },
      { id: "plugins", label: t("common.plugins"), keywords: "apps skills connectors integrations tools mcp", icon: Puzzle, run: () => dispatch({ type: "openPage", page: "plugins" }) },
      { id: "usage", label: t("commandPalette.usage"), keywords: "cost spend tokens spending limit plan billing", icon: UsageIcon, run: () => dispatch({ type: "openPage", page: "usage" }) },
      { id: "settings", label: t("common.settings"), keywords: "preferences options", icon: SettingsIcon, run: () => dispatch({ type: "toggleAppSettings", open: true }) },
      ...elsewhere,
    ],
    [dispatch, elsewhere, language],
  );

  const commands = useMemo(
    () => actions.filter((c) => (words.length ? matches(words, `${c.label} ${c.keywords}`) : !c.quiet)),
    [actions, words],
  );
  const goTo = useMemo(
    () => places.filter((c) => (words.length ? matches(words, `${c.label} ${c.keywords}`) : !c.quiet)),
    [places, words],
  );
  // Settings pages by what they hold, so "voice" or "telegram" goes
  // straight to the page rather than through the Settings menu. Only
  // once typed for: empty, Settings itself is one of the places.
  const pages = useMemo(() => {
    if (!words.length) return [];
    return SETTINGS_PAGES.flatMap((g) => g.pages).filter((p) => matches(words, `${p.label} ${p.keywords}`));
  }, [words]);
  const total = chats.length + commands.length + goTo.length + pages.length + hits.length;

  useEffect(() => {
    setCursor((c) => Math.min(c, Math.max(0, total - 1)));
  }, [total]);

  if (!open) return null;

  // where each section starts in the one flat cursor
  const commandsAt = chats.length;
  const goToAt = commandsAt + commands.length;
  const pagesAt = goToAt + goTo.length;
  const hitsAt = pagesAt + pages.length;

  const activate = (index: number) => {
    if (index < commandsAt) {
      const chat = chats[index];
      dispatch({ type: "select", id: chat.kind === "agent" ? chat.bot.id : chat.room.id });
    } else if (index < goToAt) {
      commands[index - commandsAt].run();
    } else if (index < pagesAt) {
      goTo[index - goToAt].run();
    } else if (index < hitsAt) {
      dispatch({ type: "toggleAppSettings", open: true, page: pages[index - pagesAt].id });
    } else {
      const hit = hits[index - hitsAt];
      if (!hit) return;
      if (hit.blokId) {
        // the room lands on the message too, once it has it
        askChat({ kind: "landRoom", roomId: hit.blokId, messageId: hit.messageId });
        dispatch({ type: "select", id: hit.blokId });
      } else if (hit.botId) {
        const target = state.bots.find((b) => b.id === hit.botId);
        // the hit may live in another lane; open that lane
        const lane = target?.tasks?.some((task) => task.id === hit.threadId) ? hit.threadId : undefined;
        // the conversation lands on the message once it has it
        askChat({ kind: "land", botId: hit.botId, threadId: hit.threadId, messageId: hit.messageId });
        dispatch({ type: "select", id: hit.botId, lane });
      }
    }
    setOpen(null);
  };

  const move = (delta: number) => {
    if (!total) return;
    const next = (cursor + delta + total) % total;
    setCursor(next);
    listRef.current?.querySelector(`[data-index="${next}"]`)?.scrollIntoView({ block: "nearest" });
  };

  const ctrl = platform === "mac" ? "⌃" : "Ctrl+";
  const row = (index: number, icon: React.ReactNode, label: React.ReactNode, meta?: React.ReactNode, keys?: string[]) => (
    <button
      key={index}
      data-index={index}
      id={`palette-row-${index}`}
      role="option"
      aria-selected={index === cursor}
      tabIndex={-1}
      onClick={() => activate(index)}
      onMouseMove={() => setCursor(index)}
      className={cn(
        "flex h-10 w-full items-center gap-3 rounded-lg px-3 text-left outline-none",
        index === cursor && "bg-accent",
      )}
    >
      <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground">{icon}</span>
      <span className="min-w-0 flex-1 truncate text-ui text-foreground">{label}</span>
      {meta && <span className="max-w-[40%] shrink-0 truncate text-body text-muted-foreground">{meta}</span>}
      {keys && keys.length > 0 && (
        <span className="flex shrink-0 items-center gap-1">
          {keys.map((k) => (
            <kbd
              key={k}
              className="min-w-[26px] rounded-md bg-muted px-1.5 py-0.5 text-center font-sans text-caption tabular-nums text-muted-foreground"
            >
              {k}
            </kbd>
          ))}
        </span>
      )}
    </button>
  );
  const command = (index: number, c: Command) => {
    const Icon = c.icon;
    // a browser tab never passes ⌘T or ⌘W on, so it shows no key for them
    return row(index, <Icon size={16} strokeWidth={1.75} />, c.label, undefined, keysFor(c.id, platform, Boolean(window.bloks)));
  };

  const settles = open === "pointer";
  return (
    <div
      className={cn(
        "fixed inset-0 z-50 flex items-start justify-center bg-black/30 pt-[18vh] dark:bg-black/50",
        settles && "animate-fade-in",
      )}
      onMouseDown={() => setOpen(null)}
    >
      <div
        role="dialog"
        aria-label={t("common.search")}
        className={cn(
          "flex max-h-[min(560px,64vh)] w-[680px] max-w-[92vw] flex-col overflow-hidden rounded-2xl border bg-popover shadow-2xl shadow-(color:--shadow-color)",
          settles && "animate-pop-in",
        )}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label={t("commandPalette.searchChatsMessagesAndCommands")}
          role="combobox"
          aria-expanded
          aria-controls="palette-results"
          aria-activedescendant={total ? `palette-row-${cursor}` : undefined}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") (e.preventDefault(), move(1));
            else if (e.key === "ArrowUp") (e.preventDefault(), move(-1));
            else if (e.key === "Enter") activate(cursor);
            else if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              setOpen(null);
            } else if (e.ctrlKey && !e.metaKey && /^[1-9]$/.test(e.key)) {
              // Ctrl+number opens that chat, as its key says
              const n = Number(e.key) - 1;
              if (n < Math.min(chats.length, RECENT)) (e.preventDefault(), activate(n));
            }
          }}
          placeholder={t("commandPalette.searchChatsMessagesAndCommands")}
          className="h-14 w-full shrink-0 bg-transparent px-5 text-lead text-foreground outline-none placeholder:text-muted-foreground"
        />

        <div ref={listRef} id="palette-results" role="listbox" className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {chats.length > 0 && (
            <Section label={t("commandPalette.chats")}>
              {chats.map((chat, i) =>
                chat.kind === "agent"
                  ? row(
                      i,
                      <AgentAvatar bot={chat.bot} size={20} />,
                      chat.bot.name,
                      chat.bot.section ?? chat.bot.title,
                      i < RECENT ? [`${ctrl}${i + 1}`] : undefined,
                    )
                  : row(
                      i,
                      <Users size={16} strokeWidth={1.75} />,
                      chat.room.name,
                      chat.room.section ?? t("commandPalette.room"),
                      i < RECENT ? [`${ctrl}${i + 1}`] : undefined,
                    ),
              )}
            </Section>
          )}
          {commands.length > 0 && (
            <Section label={t("commandPalette.actions")}>
              {commands.map((c, i) => command(commandsAt + i, c))}
            </Section>
          )}
          {goTo.length > 0 && <Section label={t("commandPalette.goTo")}>{goTo.map((c, i) => command(goToAt + i, c))}</Section>}
          {pages.length > 0 && (
            <Section label={t("common.settings")}>
              {pages.map((page, i) => {
                const Icon = page.icon;
                return row(pagesAt + i, <Icon size={16} />, page.label, page.description);
              })}
            </Section>
          )}
          {hits.length > 0 && (
            <Section label={t("commandPalette.messages")}>
              {hits.map((hit, i) =>
                row(
                  hitsAt + i,
                  <MessageSquare size={15} strokeWidth={1.75} />,
                  <Snippet text={hit.snippet} query={q} />,
                  `${hit.name}${hit.task ? ` · ${hit.task}` : ""}`,
                ),
              )}
            </Section>
          )}
          {total === 0 && (
            <div className="flex flex-col items-center gap-1 px-3 py-10 text-center">
              <BotIcon size={18} className="text-muted-foreground" />
              <div className="text-ui text-muted-foreground">{t("commandPalette.nothingMatches", { query: q })}</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** A message hit with the words that found it a shade stronger, so the
 * eye goes straight to why it is in the list. A match far into a long
 * snippet would be cut off by the row's end, so the line starts a few
 * words before it instead. */
function Snippet({ text, query }: { text: string; query: string }) {
  const at = text.toLowerCase().indexOf(query.trim().toLowerCase());
  const from = at > 48 ? text.lastIndexOf(" ", at - 24) : -1;
  const shown = from > 0 ? `…${text.slice(from + 1)}` : text;
  return (
    <>
      {splitHighlight(shown, query).map((part, i) =>
        part.hit ? (
          <mark key={i} className="bg-transparent font-semibold text-foreground">
            {part.text}
          </mark>
        ) : (
          <span key={i} className="text-foreground/80">
            {part.text}
          </span>
        ),
      )}
    </>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="pb-1" role="group" aria-label={label}>
      <div className="px-3 pb-1.5 pt-2.5 text-body font-medium text-muted-foreground">{label}</div>
      {children}
    </div>
  );
}
