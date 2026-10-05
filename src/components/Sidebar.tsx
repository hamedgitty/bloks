import { useEffect, useMemo, useRef, useState } from "react";
import BellDot from "lucide-react/dist/esm/icons/bell-dot.mjs";
import ClipboardCopy from "lucide-react/dist/esm/icons/clipboard-copy.mjs";
import Copy from "lucide-react/dist/esm/icons/copy.mjs";
import Eraser from "lucide-react/dist/esm/icons/eraser.mjs";
import Pencil from "lucide-react/dist/esm/icons/pencil.mjs";
import PanelLeftClose from "lucide-react/dist/esm/icons/panel-left-close.mjs";
import PanelLeftOpen from "lucide-react/dist/esm/icons/panel-left-open.mjs";
import Pin from "lucide-react/dist/esm/icons/pin.mjs";
import PinOff from "lucide-react/dist/esm/icons/pin-off.mjs";
import Plus from "lucide-react/dist/esm/icons/plus.mjs";
import Loader2 from "lucide-react/dist/esm/icons/loader-2.mjs";
import Archive from "lucide-react/dist/esm/icons/archive.mjs";
import Puzzle from "lucide-react/dist/esm/icons/puzzle.mjs";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right.mjs";
import Folder from "lucide-react/dist/esm/icons/folder.mjs";
import FolderKanban from "lucide-react/dist/esm/icons/folder-kanban.mjs";
import Activity from "lucide-react/dist/esm/icons/activity.mjs";
import Brain from "lucide-react/dist/esm/icons/brain.mjs";
import FlaskConical from "lucide-react/dist/esm/icons/flask-conical.mjs";
import BotIcon from "lucide-react/dist/esm/icons/bot.mjs";
import CalendarClock from "lucide-react/dist/esm/icons/calendar-clock.mjs";
import Search from "lucide-react/dist/esm/icons/search.mjs";
import SettingsIcon from "lucide-react/dist/esm/icons/settings-2.mjs";
import Sparkles from "lucide-react/dist/esm/icons/sparkles.mjs";
import Users from "lucide-react/dist/esm/icons/users.mjs";
import Trash2 from "lucide-react/dist/esm/icons/trash-2.mjs";
import { api, useStore, formatWhen, type Blok, type Bot } from "@/state/store";
import { Button } from "@/components/ui/button";
import { AgentAvatar } from "./Avatar";
import { BloksLogo, BloksMark } from "./Brand";
import { cn } from "@/lib/cn";
import { usePageVisible } from "@/lib/pageVisible";
import { previewLine } from "@/lib/preview";
import { inSection, moveSection, orderSections, sectionNames, shownInSection } from "@/lib/sections";
import { useProfileNotes } from "./AboutYou";
import { useBriefs } from "./BriefPanel";
import { ConversationRows, LaneRing, SidebarFooter, WaitingRow } from "./SidebarParts";
import { UpdateCard } from "./UpdateCard";
import { setLanesInSidebar, useConversationsView } from "@/lib/conversationsView";
import ListTree from "lucide-react/dist/esm/icons/list-tree.mjs";
import Sunrise from "lucide-react/dist/esm/icons/sunrise.mjs";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { plural } from "@/lib/plural";

const isElectron = navigator.userAgent.includes("Electron");

function preview(bot: Bot): string {
  // a lane waiting on a human outranks everything: that is the row the
  // user should open next
  if (bot.tasks?.some((t) => t.state === "needs-you")) return "Waiting for you…";
  if (bot.busy) return "Working…";
  // an empty lane on an agent that has others is a fresh conversation,
  // not a fresh agent, which is what the shared wording would say
  if (!bot.messages.length && (bot.tasks?.length ?? 0) > 1) return "New conversation";
  return previewLine(bot.messages[bot.messages.length - 1]);
}

interface MenuState {
  botId: string;
  x: number;
  y: number;
}

/** What is being filed under a section right now, if anything. */
interface FilingState {
  kind: "bot" | "room";
  id: string;
  name: string;
  current: string | null;
}

/**
 * The filing dialog: existing sections as one-click destinations, a
 * field for a new name, and a way back out. Sections come from what is
 * already filed, so this list is never stale and never empty-but-real.
 */
/** The order sections were dragged into on this device (see Sidebar). */
function savedSectionOrder(): string[] {
  try {
    const saved = JSON.parse(localStorage.getItem("bloks-section-order") ?? "[]");
    return Array.isArray(saved) ? saved.filter((n) => typeof n === "string") : [];
  } catch {
    return [];
  }
}

function SectionPicker({ filing, onClose }: { filing: FilingState; onClose: () => void }) {
  const { state, dispatch } = useStore();
  const [draft, setDraft] = useState("");
  // listed in the same order as the sidebar's headings
  const names = orderSections(
    sectionNames(
      state.bots.filter((b) => !b.hidden),
      state.bloks,
    ),
    savedSectionOrder(),
  );

  const fileTo = (section: string | null) => {
    if (filing.kind === "bot") {
      dispatch({ type: "updateBot", botId: filing.id, patch: { section } });
    } else {
      dispatch({ type: "patchRoom", blokId: filing.id, patch: { section } });
    }
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      onKeyDown={(e) => e.key === "Escape" && onClose()}
    >
      <div className="w-[300px] animate-pop-in rounded-2xl border bg-popover p-4 shadow-lg">
        <div className="text-[13.5px] font-semibold text-foreground">
          File {filing.name} under…
        </div>
        <div className="mt-3 flex flex-col gap-1">
          {names.map((name) => (
            <button
              key={name}
              onClick={() => fileTo(name)}
              className={cn(
                "flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] text-foreground hover:bg-accent",
                name === filing.current && "bg-accent/60 font-medium",
              )}
            >
              <Folder size={14} className="text-muted-foreground" />
              {name}
            </button>
          ))}
          {names.length === 0 && (
            <div className="px-1 py-1 text-[12.5px] text-muted-foreground">
              No sections yet. Name the first one below.
            </div>
          )}
        </div>
        <form
          className="mt-2 flex gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            if (draft.trim()) fileTo(draft.trim());
          }}
        >
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="New section"
            maxLength={60}
            className="w-full rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-[13px] text-foreground outline-none placeholder:text-muted-foreground focus:border-ring/60"
          />
          <Button type="submit" size="sm" variant="secondary" disabled={!draft.trim()}>
            File
          </Button>
        </form>
        {filing.current && (
          <button
            onClick={() => fileTo(null)}
            className="mt-2 w-full rounded-lg px-2.5 py-1.5 text-left text-[12.5px] text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            Remove from {filing.current}
          </button>
        )}
      </div>
    </div>
  );
}

function BotContextMenu({
  menu,
  onClose,
  onFile,
}: {
  menu: MenuState;
  onClose: () => void;
  onFile: (filing: FilingState) => void;
}) {
  const { state, dispatch } = useStore();
  const bot = state.bots.find((b) => b.id === menu.botId);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest("[data-bot-menu]")) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  if (!bot) return null;

  const general = bot.tasks?.[0];

  // keep the menu on-screen near the click
  const top = Math.min(menu.y, window.innerHeight - 300);
  const left = Math.min(menu.x, window.innerWidth - 220);

  const item = (
    icon: React.ReactNode,
    label: string,
    onClick?: () => void,
    opts?: { danger?: boolean },
  ) => (
    <button
      key={label}
      onClick={() => {
        onClick?.();
        onClose();
      }}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px]",
        opts?.danger
          ? "text-destructive hover:bg-destructive/10"
          : "text-foreground hover:bg-accent",
      )}
    >
      {icon}
      {label}
    </button>
  );
  const divider = (key: string) => <div key={key} className="mx-2 my-1 h-px bg-border" />;

  return (
    <div
      data-bot-menu
      style={{ top, left }}
      className="fixed z-40 w-[208px] animate-pop-in rounded-xl border bg-popover p-1 shadow-lg shadow-(color:--shadow-color)"
    >
      {[
        item(
          bot.pinned ? (
            <PinOff size={15} className="text-muted-foreground" />
          ) : (
            <Pin size={15} className="text-muted-foreground" />
          ),
          bot.pinned ? "Unpin" : "Pin",
          () => dispatch({ type: "updateBot", botId: bot.id, patch: { pinned: !bot.pinned } }),
        ),
        // the agent stands for General, so that is the conversation it marks
        item(
          <BellDot size={15} className="text-muted-foreground" />,
          "Mark as unread",
          () => general && dispatch({ type: "markLaneUnread", botId: bot.id, taskId: general.id }),
        ),
        item(<Folder size={15} className="text-muted-foreground" />, "Move to section…", () =>
          onFile({ kind: "bot", id: bot.id, name: bot.name, current: bot.section ?? null }),
        ),
        divider("d1"),
        item(<Pencil size={15} className="text-muted-foreground" />, "Edit profile", () => {
          dispatch({ type: "select", id: bot.id });
          dispatch({ type: "toggleSettings", open: true });
        }),
        item(<Copy size={15} className="text-muted-foreground" />, "Duplicate", () =>
          dispatch({ type: "duplicateBot", botId: bot.id }),
        ),
        item(<ClipboardCopy size={15} className="text-muted-foreground" />, "Copy conversation ID", () => {
          void navigator.clipboard?.writeText(bot.threadId);
        }),
        divider("d2"),
        // General is cleared, never closed; not while it is working
        general &&
          general.state !== "working" &&
          item(
            <Eraser size={15} />,
            "Clear conversation",
            () => {
              if (window.confirm("Clear this conversation? Its messages are deleted.")) {
                dispatch({ type: "clearTask", botId: bot.id, taskId: general.id });
              }
            },
            { danger: true },
          ),
        // Archiving is reversible, so it lives here; deleting the agent is
        // behind the drawer where the confirm can name what goes. Archiving takes
        // the agent out of the list and stops it working; it keeps the
        // conversations, the rules, the rooms and the key.
        item(<Archive size={15} className="text-muted-foreground" />, "Archive", () =>
          dispatch({ type: "deleteBot", botId: bot.id }),
        ),
      ]}
    </div>
  );
}

function BotListItem({
  bot,
  onMenu,
  rail,
  compact,
}: {
  bot: Bot;
  onMenu: (menu: MenuState) => void;
  rail?: boolean;
  /** The conversations view: one line per agent, with its other
   * conversations listed underneath instead of one conversation's preview. */
  compact?: boolean;
}) {
  const { state, dispatch } = useStore();
  const selected = state.selectedId === bot.id;
  const last = bot.messages[bot.messages.length - 1];
  if (rail) {
    // the collapsed sidebar: just the face, with the unread dot riding
    // the avatar the way the phone app does it
    return (
      <button
        onClick={() => dispatch({ type: "select", id: bot.id })}
        onContextMenu={(e) => {
          e.preventDefault();
          onMenu({ botId: bot.id, x: e.clientX, y: e.clientY });
        }}
        title={bot.name}
        className={cn(
          "relative flex shrink-0 self-center rounded-xl p-1.5 transition-[background-color,transform] duration-150 active:scale-95",
          selected ? "bg-accent" : "hover:bg-accent/60",
        )}
      >
        <AgentAvatar bot={bot} size={36} />
        {bot.unread && (
          <span className="absolute bottom-1 right-1 size-2.5 rounded-full bg-brand ring-2 ring-sidebar" />
        )}
      </button>
    );
  }
  if (compact) {
    // the agent's row is General; the others are listed beneath it
    const general = bot.tasks?.[0];
    const generalOpen = selected && (bot.activeTaskId ?? bot.threadId) === general?.id;
    const timestamp = general ? (general.lastAt ?? general.createdAt) : 0;

    return (
      <div className="group/agent relative">
        <button
          onClick={() => dispatch({ type: "select", id: bot.id, lane: general?.id })}
          onContextMenu={(e) => {
            e.preventDefault();
            onMenu({ botId: bot.id, x: e.clientX, y: e.clientY });
          }}
          className={cn(
            "flex h-[38px] w-full items-center gap-2.5 rounded-xl px-2.5 text-left transition-[background-color,scale] duration-150 ease-out active:scale-[0.99]",
            generalOpen ? "bg-accent" : "hover:bg-accent/60",
          )}
        >
          <AgentAvatar bot={bot} size={24} />
          <span className="flex min-w-0 flex-1 items-center gap-1.5 truncate text-[13.5px] font-semibold text-foreground">
            {bot.pinned && <Pin size={11} className="shrink-0 text-muted-foreground" />}
            <span className="truncate">{bot.name}</span>
          </span>
          {/* the trailing state steps aside for the + on hover, all of it,
              so the two never sit on top of each other */}
          <span className="flex shrink-0 items-center gap-1.5 transition-opacity duration-150 group-hover/agent:opacity-0">
            {general && <LaneRing lane={general} />}
            {general?.state === "needs-you" ? (
              <span className="text-[11px] text-warning">waiting</span>
            ) : general?.state === "working" ? (
              <Loader2
                size={12}
                className="animate-spin text-brand motion-reduce:animate-none"
                aria-label="working"
              />
            ) : (
              timestamp > 0 && (
                <span className="text-[11px] tabular-nums text-muted-foreground/80">{formatWhen(timestamp)}</span>
              )
            )}
            {general?.unread && <span className="size-1.5 rounded-full bg-brand" />}
          </span>
        </button>
        {/* a new conversation, from the agent it is with */}
        <button
          onClick={() => {
            dispatch({ type: "select", id: bot.id });
            dispatch({ type: "newTask", botId: bot.id });
          }}
          title={`New conversation with ${bot.name}`}
          aria-label={`New conversation with ${bot.name}`}
          className="absolute right-1.5 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-[opacity,background-color,color] duration-150 hover:bg-background hover:text-foreground focus-visible:opacity-100 group-hover/agent:opacity-100"
        >
          <Plus size={14} />
        </button>
      </div>
    );
  }
  return (
    <button
      onClick={() => dispatch({ type: "select", id: bot.id })}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu({ botId: bot.id, x: e.clientX, y: e.clientY });
      }}
      className={cn(
        "flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left transition-[background-color,transform] duration-150 active:scale-[0.99]",
        selected ? "bg-accent" : "hover:bg-accent/60",
      )}
    >
      <AgentAvatar bot={bot} size={42} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="flex min-w-0 items-center gap-1.5 truncate text-[14px] font-semibold text-foreground">
            {bot.pinned && <Pin size={11} className="shrink-0 text-muted-foreground" />}
            <span className="truncate">{bot.name}</span>
          </span>
          {last && (
            <span className="shrink-0 text-[11.5px] tabular-nums text-muted-foreground">
              {formatWhen(last.at)}
            </span>
          )}
        </div>
        <div className="mt-px flex items-center justify-between gap-2">
          <span
            className={cn(
              "truncate text-[13px]",
              bot.unread ? "font-medium text-foreground" : "text-muted-foreground",
            )}
          >
            {preview(bot)}
          </span>
          {bot.busy && !bot.tasks?.some((t) => t.state === "needs-you") ? (
            <Loader2 size={13} className="shrink-0 animate-spin text-brand motion-reduce:animate-none" aria-label="working" />
          ) : (
            bot.unread && <span className="size-2 shrink-0 rounded-full bg-brand" />
          )}
        </div>
      </div>
    </button>
  );
}

function RoomListItem({
  blok,
  rail,
  onFile,
}: {
  blok: Blok;
  rail?: boolean;
  onFile?: (filing: FilingState) => void;
}) {
  const { state, dispatch } = useStore();
  const selected = state.selectedId === blok.id;
  const members = blok.memberIds
    .map((id) => state.bots.find((b) => b.id === id))
    .filter(Boolean) as Bot[];
  const last = blok.messages[blok.messages.length - 1];
  const working = members.filter((m) => m.busy);

  if (rail) {
    return (
      <button
        onClick={() => dispatch({ type: "select", id: blok.id })}
        title={blok.name}
        className={cn(
          "flex shrink-0 self-center rounded-xl p-1.5 transition-[background-color,transform] duration-150 active:scale-95",
          selected ? "bg-accent" : "hover:bg-accent/60",
        )}
      >
        <span className="flex size-9 items-center justify-center rounded-xl bg-muted">
          <span className="flex -space-x-1.5">
            {members.slice(0, 2).map((m) => (
              <AgentAvatar key={m.id} bot={m} size={16} className="rounded-md ring-2 ring-muted" />
            ))}
          </span>
        </span>
      </button>
    );
  }
  return (
    <button
      onClick={() => dispatch({ type: "select", id: blok.id })}
      onContextMenu={(e) => {
        if (!onFile) return;
        e.preventDefault();
        onFile({ kind: "room", id: blok.id, name: blok.name, current: blok.section ?? null });
      }}
      className={cn(
        "flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left transition-[background-color,transform] duration-150 active:scale-[0.99]",
        selected ? "bg-accent" : "hover:bg-accent/60",
      )}
    >
      <span className="flex size-[42px] shrink-0 items-center justify-center rounded-xl bg-muted">
        <span className="flex -space-x-1.5">
          {members.slice(0, 3).map((m) => (
            <AgentAvatar
              key={m.id}
              bot={m}
              size={18}
              className="rounded-md ring-2 ring-muted"
            />
          ))}
        </span>
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="flex min-w-0 items-center gap-1.5 truncate text-[14px] font-semibold text-foreground">
            <Users size={11} className="shrink-0 text-muted-foreground" />
            <span className="truncate">{blok.name}</span>
          </span>
          {last && (
            <span className="shrink-0 text-[11.5px] tabular-nums text-muted-foreground">
              {formatWhen(last.at)}
            </span>
          )}
        </div>
        <div className="mt-px truncate text-[13px] text-muted-foreground">
          {working.length
            ? `${working.map((m) => m.name).join(", ")} working…`
            : last
              ? previewLine(last)
              : plural(members.length, "agent")}
        </div>
      </div>
    </button>
  );
}

/**
 * How many things are running and how many want you.
 *
 * Polled rather than pushed: the counts change when a turn starts or a
 * card opens, both of which already broadcast, but the arithmetic lives on
 * the server and a second copy of it here would be a second answer. Slow
 * on purpose, because this is an ambient number and not a readout.
 */
/** Rehearsals waiting on a decision, re-read whenever one moves. */
function useRehearsalsReady(): number {
  const { state } = useStore();
  const [ready, setReady] = useState(0);
  useEffect(() => {
    let live = true;
    api("/api/rehearsals")
      .then((r) => live && setReady((r.rehearsals ?? []).filter((x: { state: string }) => x.state === "ready").length))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [state.rehearsalsTick]);
  return ready;
}

function useActivityCount(): { running: number; waiting: number; suggested: number } {
  const [count, setCount] = useState({ running: 0, waiting: 0, suggested: 0 });
  const visible = usePageVisible();
  useEffect(() => {
    if (!visible) return;
    let alive = true;
    const load = () =>
      Promise.all([
        fetch("/api/activity").then((r) => (r.ok ? r.json() : null)),
        fetch("/api/skills/proposals").then((r) => (r.ok ? r.json() : null)),
      ])
        .then(([a, s]) => {
          if (!alive) return;
          setCount({
            running: a?.running?.length ?? 0,
            waiting: a?.waiting?.length ?? 0,
            suggested: s?.proposals?.length ?? 0,
          });
        })
        .catch(() => {});
    load();
    const timer = setInterval(load, 5_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [visible]);
  return count;
}

export function Sidebar() {
  const { state, dispatch } = useStore();
  const [conversations, setConversations] = useConversationsView();
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [filing, setFiling] = useState<FilingState | null>(null);
  const activity = useActivityCount();
  const rehearsalsReady = useRehearsalsReady();
  const notesWaiting = (useProfileNotes().notes ?? []).filter((n) => n.state === "suggested").length;
  const latestBrief = useBriefs().data?.briefs[0];
  const briefNew = Boolean(latestBrief && !latestBrief.readAt && !latestBrief.quiet);
  const [showArchived, setShowArchived] = useState(false);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  // Three layouts by width and choice: the full column, a rail of faces
  // (chosen, or forced when a 320px column would crowd the window), and
  // a top header on phone-narrow windows where no column fits at all.
  // null means "no opinion yet", so width decides; once the person
  // clicks, their choice is the answer at any width. Without this a
  // narrow window pinned the rail open and the expand control did
  // nothing, which reads as a broken button.
  const [choice, setChoice] = useState<boolean | null>(() => {
    const saved = localStorage.getItem("bloks-sidebar");
    return saved === "rail" ? true : saved === "full" ? false : null;
  });
  const [narrow, setNarrow] = useState(() => window.innerWidth < 1000);
  const [mobile, setMobile] = useState(() => window.innerWidth < 768);
  useEffect(() => {
    const narrowMedia = window.matchMedia("(max-width: 999px)");
    const mobileMedia = window.matchMedia("(max-width: 767px)");
    const onChange = () => {
      setNarrow(narrowMedia.matches);
      setMobile(mobileMedia.matches);
    };
    narrowMedia.addEventListener("change", onChange);
    mobileMedia.addEventListener("change", onChange);
    return () => {
      narrowMedia.removeEventListener("change", onChange);
      mobileMedia.removeEventListener("change", onChange);
    };
  }, []);
  const rail = choice ?? narrow;
  useEffect(() => {
    setLanesInSidebar(conversations && !rail && !mobile);
  }, [conversations, rail, mobile]);
  const [logoHover, setLogoHover] = useState(false);
  const toggleCollapsed = () => {
    const next = !rail;
    setChoice(next);
    localStorage.setItem("bloks-sidebar", next ? "rail" : "full");
  };
  // Folded sections, by name. Kept on this device like the rail choice:
  // how much of the list you want in view depends on the screen, not on
  // the workspace. A name that stops existing just sits here unused.
  const [folded, setFolded] = useState<string[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("bloks-folded-sections") ?? "[]");
      return Array.isArray(saved) ? saved.filter((n) => typeof n === "string") : [];
    } catch {
      return [];
    }
  });
  const toggleFolded = (name: string) => {
    const next = folded.includes(name) ? folded.filter((n) => n !== name) : [...folded, name];
    setFolded(next);
    localStorage.setItem("bloks-folded-sections", JSON.stringify(next));
  };

  // The order sections are dragged into, by name, kept on this device
  // like folding. Until someone drags one, they stay alphabetical.
  const [sectionOrder, setSectionOrder] = useState<string[]>(savedSectionOrder);
  const saveSectionOrder = (next: string[]) => {
    setSectionOrder(next);
    try {
      localStorage.setItem("bloks-section-order", JSON.stringify(next));
    } catch {
      /* kept for this visit only */
    }
  };
  // which heading a dragged section would land against, and on which side
  const [sectionDrop, setSectionDrop] = useState<{ name: string; place: "before" | "after" } | null>(null);

  // ⌘N for a new agent. ⌘K is the command palette's (CommandPalette.tsx),
  // which searches everything this box does and more; both answering it
  // meant two things grabbing focus at once.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey && !e.ctrlKey) return;
      if (e.key === "n") {
        e.preventDefault();
        dispatch({ type: "toggleNewAgent", open: true });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dispatch]);

  // The project the app is looking through, if any. A lens rather than a
  // container: the agents are still there, this is just what is on screen.
  const [projectMembers, setProjectMembers] = useState<string[] | null>(null);
  const [projectName, setProjectName] = useState<string>("");
  useEffect(() => {
    if (!state.projectId) {
      setProjectMembers(null);
      setProjectName("");
      return;
    }
    let live = true;
    api("/api/projects")
      .then((r) => {
        if (!live) return;
        const found = (r.projects ?? []).find((p: { id: string }) => p.id === state.projectId);
        // a project that has gone stops filtering rather than emptying
        // the sidebar, which would look like the agents had gone with it
        setProjectMembers(found ? found.memberIds : null);
        setProjectName(found ? found.name : "");
        if (!found) dispatch({ type: "openProject", id: null });
      })
      .catch(() => setProjectMembers(null));
    return () => {
      live = false;
    };
  }, [state.projectId, dispatch]);

  const visibleBots = useMemo(
    () =>
      state.bots
        .filter((b) => !b.hidden)
        .filter((b) => !projectMembers || projectMembers.includes(b.id))
        .filter(
          (b) =>
            !query.trim() ||
            `${b.name} ${b.title}`.toLowerCase().includes(query.trim().toLowerCase()),
        )
        .sort((a, b) => Number(b.pinned ?? false) - Number(a.pinned ?? false)),
    [state.bots, query, projectMembers],
  );

  const newMenuItems = (
    <DropdownMenuContent align="end" className="min-w-[160px]">
      <DropdownMenuItem onClick={() => dispatch({ type: "toggleNewAgent", open: true })}>
        <BotIcon size={15} />
        New agent
      </DropdownMenuItem>
      <DropdownMenuItem onClick={() => dispatch({ type: "toggleNewRoom", open: true })}>
        <Users size={15} />
        New room
      </DropdownMenuItem>
      {/* On a phone the footer is gone, so everything behind it has to
          be here instead: a surface with no way in on the device somebody
          is holding is a surface that does not exist for them. */}
      {mobile && (
        <DropdownMenuItem onClick={() => dispatch({ type: "toggleBrief", open: true })}>
          <Sunrise size={15} />
          Morning brief
        </DropdownMenuItem>
      )}
      {mobile && (
        <DropdownMenuItem onClick={() => dispatch({ type: "toggleActivity", open: true })}>
          <Activity size={15} />
          Activity
        </DropdownMenuItem>
      )}
      {mobile && (
        <DropdownMenuItem onClick={() => dispatch({ type: "toggleProjects", open: true })}>
          <FolderKanban size={15} />
          Projects
        </DropdownMenuItem>
      )}
      {mobile && (
        <DropdownMenuItem onClick={() => dispatch({ type: "toggleRehearsals", open: true })}>
          <FlaskConical size={15} />
          Rehearsals
        </DropdownMenuItem>
      )}
      {mobile && (
        <DropdownMenuItem onClick={() => dispatch({ type: "toggleMemory", open: true, botId: null })}>
          <Brain size={15} />
          Memory
        </DropdownMenuItem>
      )}
      {mobile && (
        <DropdownMenuItem onClick={() => dispatch({ type: "toggleRoutines", open: true })}>
          <CalendarClock size={15} />
          Routines
        </DropdownMenuItem>
      )}
      {mobile && (
        <DropdownMenuItem onClick={() => dispatch({ type: "toggleSkills", open: true })}>
          <Sparkles size={15} />
          Skills
        </DropdownMenuItem>
      )}
      {mobile && (
        <DropdownMenuItem onClick={() => dispatch({ type: "togglePlugins", open: true })}>
          <Puzzle size={15} />
          Plugins
        </DropdownMenuItem>
      )}
      {state.bots.some((b) => b.hidden) && (
        <DropdownMenuItem onClick={() => setShowArchived(true)}>
          <Archive size={15} />
          Archived agents
          <span className="ml-auto pl-3 text-[11px] text-muted-foreground">
            {state.bots.filter((b) => b.hidden).length}
          </span>
        </DropdownMenuItem>
      )}
    </DropdownMenuContent>
  );

  // Phone-narrow: no column fits, so the sidebar becomes a header: the
  // roster as a horizontal strip, everything else behind + and settings.
  if (mobile) {
    return (
      <>
        <header className="flex h-[54px] w-full shrink-0 items-center gap-1 border-b bg-sidebar pl-3 pr-1.5">
          <BloksMark size={17} />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                className="rounded-lg p-1.5 text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground active:scale-95"
                title="New…"
              >
                <Plus size={17} strokeWidth={2} />
              </button>
            </DropdownMenuTrigger>
            {newMenuItems}
          </DropdownMenu>
          <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto px-0.5">
            {state.bloks.map((b) => (
              <RoomListItem key={b.id} blok={b} rail />
            ))}
            {visibleBots.map((b) => (
              <BotListItem key={b.id} bot={b} onMenu={setMenu} rail />
            ))}
          </div>
          <button
            onClick={() => dispatch({ type: "toggleAppSettings" })}
            title="Settings"
            className="rounded-lg p-1.5 text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground"
          >
            <SettingsIcon size={16} />
          </button>
        </header>
        {menu && <BotContextMenu menu={menu} onClose={() => setMenu(null)} onFile={setFiling} />}
        {filing && <SectionPicker filing={filing} onClose={() => setFiling(null)} />}
        {showArchived && <ArchivedAgents onClose={() => setShowArchived(false)} />}
      </>
    );
  }

  return (
    <aside
      className={cn(
        "flex h-full shrink-0 flex-col border-r bg-sidebar transition-[width] duration-200",
        // 96px is not arbitrary: macOS draws its three buttons as a 52px
        // cluster, so a 22px inset leaves exactly 22px on the other side
        // and the group sits centred with real air around it. See BUTTONS
        // in electron/main.mjs, which holds the matching inset.
        rail ? "w-[96px]" : "w-[320px]",
      )}
    >
      {/* macOS draws its traffic lights into the top-left corner of the
          desktop shell; they get a slim strip of their own so nothing
          below ever has to dodge them. */}
      {isElectron && (
        <div className="h-[44px] shrink-0" style={{ WebkitAppRegion: "drag" } as React.CSSProperties} />
      )}
      {rail ? (
        <div
          className={cn("flex flex-col items-center gap-1 px-2 pb-1", isElectron ? "pt-0.5" : "pt-3.5")}
          style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
        >
          {/* the mark doubles as the way back: hovering it reveals the
              open-sidebar control, the way ChatGPT's logo does */}
          <button
            onMouseEnter={() => setLogoHover(true)}
            onMouseLeave={() => setLogoHover(false)}
            onClick={toggleCollapsed}
            title="Open sidebar"
            aria-label="Open sidebar"
            className="flex size-8 items-center justify-center rounded-lg transition-colors duration-150 hover:bg-accent" 
            style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
          >
            {logoHover ? (
              <PanelLeftOpen size={17} className="text-muted-foreground" />
            ) : (
              <BloksMark size={17} />
            )}
          </button>
          {/* new things live right above the first face */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                className="rounded-lg p-1.5 text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground active:scale-95"
                style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
                title="New…"
              >
                <Plus size={17} strokeWidth={2} />
              </button>
            </DropdownMenuTrigger>
            {newMenuItems}
          </DropdownMenu>
        </div>
      ) : (
        <div
          className={cn("flex items-center justify-between pl-4 pr-3 pb-2", isElectron ? "pt-1" : "pt-3.5")}
          style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
        >
          {/* the full lockup, flush left, same as the phone's header */}
          <BloksLogo className="h-[20px]" />
          <div
            className="flex items-center gap-0.5"
            style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
          >
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  className="rounded-lg p-1.5 text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground active:scale-95"
                  title="New…"
                >
                  <Plus size={17} strokeWidth={2} />
                </button>
              </DropdownMenuTrigger>
              {newMenuItems}
            </DropdownMenu>
            <button
              onClick={toggleCollapsed}
              title="Close sidebar"
              className="rounded-lg p-1.5 text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground"
            >
              <PanelLeftClose size={16} />
            </button>
          </div>
        </div>
      )}

      {/* Search */}
      {!rail && (
        <div className="px-3 pb-2 pt-1">
          <div className="flex items-center gap-2 rounded-xl bg-accent/70 px-3 py-[7px] transition-colors duration-150 focus-within:bg-accent">
            <Search size={15} className="shrink-0 text-muted-foreground" />
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && (setQuery(""), e.currentTarget.blur())}
              placeholder="Search"
              className="w-full bg-transparent text-[13.5px] text-foreground outline-none placeholder:text-muted-foreground"
            />
          </div>
        </div>
      )}

      {/* Looking through a project: say which, and how to stop. Without
          this a filtered sidebar reads as agents having gone missing,
          which is why the collapsed rail gets it too rather than only the
          version with room for words. */}
      {projectMembers && (
        <button
          onClick={() => dispatch({ type: "openProject", id: null })}
          title={`Looking through ${projectName}. Click to show the whole workspace again`}
          className={cn(
            "mb-1 flex items-center rounded-lg bg-accent/70 text-foreground transition-colors duration-150 hover:bg-accent",
            rail ? "mx-auto justify-center p-1.5" : "mx-2 gap-2 px-2.5 py-1.5 text-left text-[12px]",
          )}
        >
          <FolderKanban size={13} className="shrink-0 text-muted-foreground" />
          {!rail && (
            <>
              <span className="min-w-0 flex-1 truncate">{projectName}</span>
              <span className="shrink-0 text-[11px] text-muted-foreground">leave</span>
            </>
          )}
        </button>
      )}

      <WaitingRow rail={rail} />

      {/* The list. Filed rows stand under their section's heading; the
          unfiled majority keeps the plain Rooms and Agents lists it has
          always had, so sections cost nothing until the first one is
          named. The rail has no room for headings and stays flat. */}
      <div className="flex-1 overflow-y-auto px-2 pt-1">
        <div className={cn("flex flex-col", rail ? "gap-1" : "gap-px")}>
          {(rail ? state.bloks : inSection(state.bloks, null)).length > 0 && (
            <>
              {!rail && (
                <div className="flex items-center justify-between px-2.5 pb-1 pt-1 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                  Rooms
                  <button
                    onClick={() => dispatch({ type: "toggleNewRoom", open: true })}
                    className="rounded p-0.5 transition-colors hover:text-foreground"
                    title="New room"
                  >
                    <Plus size={12} />
                  </button>
                </div>
              )}
              {(rail ? state.bloks : inSection(state.bloks, null)).map((b) => (
                <RoomListItem key={b.id} blok={b} rail={rail} onFile={setFiling} />
              ))}
              {rail ? (
                <div className="mx-3 my-1 border-t" />
              ) : (
                <div className="flex items-center justify-between px-2.5 pb-1 pt-3 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                  Agents
                  <button
                    onClick={() => setConversations(!conversations)}
                    aria-pressed={conversations}
                    className={cn(
                      "rounded p-0.5 transition-colors hover:text-foreground",
                      conversations && "text-foreground",
                    )}
                    title={conversations ? "Hide conversations" : "Show each agent's conversations"}
                  >
                    <ListTree size={12} />
                  </button>
                </div>
              )}
            </>
          )}
          {(rail ? visibleBots : inSection(visibleBots, null)).map((b) => (
            <div key={b.id} className="flex flex-col">
              <BotListItem bot={b} onMenu={setMenu} rail={rail} compact={conversations} />
              {!rail && <ConversationRows bot={b} open={conversations} />}
            </div>
          ))}
          {!rail &&
            (() => {
              const shownSections = orderSections(sectionNames(visibleBots, state.bloks), sectionOrder);
              const SECTION_TYPE = "application/x-bloks-section";
              return shownSections.map((name, index) => {
              const rooms = inSection(state.bloks, name);
              const bots = inSection(visibleBots, name);
              if (!rooms.length && !bots.length) return null;
              const isFolded = folded.includes(name);
              const searching = Boolean(query.trim());
              // A folded heading still says something is waiting inside.
              const waiting = isFolded && !searching && bots.some((b) => b.unread);
              const hint = sectionDrop?.name === name ? sectionDrop.place : null;
              return (
                <div key={name} className="relative flex flex-col gap-px">
                  {hint && (
                    <span
                      className={cn(
                        "pointer-events-none absolute inset-x-2 z-10 h-0.5 rounded-full bg-brand",
                        hint === "before" ? "top-1" : "-bottom-px",
                      )}
                    />
                  )}
                  <button
                    onClick={() => toggleFolded(name)}
                    aria-expanded={!isFolded}
                    title={isFolded ? "Show this section. Drag to reorder" : "Fold this section. Drag to reorder"}
                    // Drag a heading to put the sections in your own order;
                    // Alt with an arrow key does the same from the keyboard.
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData(SECTION_TYPE, name);
                      e.dataTransfer.effectAllowed = "move";
                    }}
                    onDragOver={(e) => {
                      if (!e.dataTransfer.types.includes(SECTION_TYPE)) return;
                      e.preventDefault();
                      const box = e.currentTarget.getBoundingClientRect();
                      const place = e.clientY < box.top + box.height / 2 ? "before" : "after";
                      if (sectionDrop?.name !== name || sectionDrop.place !== place) setSectionDrop({ name, place });
                    }}
                    onDragLeave={() => setSectionDrop((d) => (d?.name === name ? null : d))}
                    onDrop={(e) => {
                      const dragged = e.dataTransfer.getData(SECTION_TYPE);
                      setSectionDrop(null);
                      if (!dragged) return;
                      e.preventDefault();
                      saveSectionOrder(moveSection(shownSections, dragged, name, hint ?? "before"));
                    }}
                    onDragEnd={() => setSectionDrop(null)}
                    onKeyDown={(e) => {
                      if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
                      e.preventDefault();
                      const neighbour = shownSections[index + (e.key === "ArrowUp" ? -1 : 1)];
                      if (neighbour) saveSectionOrder(moveSection(shownSections, name, neighbour, e.key === "ArrowUp" ? "before" : "after"));
                    }}
                    className="flex cursor-grab items-center gap-1.5 rounded px-2.5 pb-1 pt-3 text-left text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground transition-colors hover:text-foreground active:cursor-grabbing"
                  >
                    <Folder size={11} className="shrink-0" />
                    <span className="truncate">{name}</span>
                    {isFolded && !searching && (
                      <span className="shrink-0 normal-case tracking-normal">{rooms.length + bots.length}</span>
                    )}
                    {waiting && <span className="size-1.5 shrink-0 rounded-full bg-brand" />}
                    <ChevronRight
                      size={11}
                      className={cn("ml-auto shrink-0 transition-transform", !isFolded && "rotate-90")}
                    />
                  </button>
                  {shownInSection(rooms, isFolded, state.selectedId, searching).map((b) => (
                    <RoomListItem key={b.id} blok={b} onFile={setFiling} />
                  ))}
                  {shownInSection(bots, isFolded, state.selectedId, searching).map((b) => (
                    <div key={b.id} className="flex flex-col">
                      <BotListItem bot={b} onMenu={setMenu} compact={conversations} />
                      <ConversationRows bot={b} open={conversations && !isFolded} />
                    </div>
                  ))}
                </div>
              );
              });
            })()}
          {visibleBots.length === 0 && !rail && (query || state.hydrated) && (
            <div className="px-3 py-8 text-center text-[13px] text-muted-foreground">
              {query ? "No agents match" : "No agents yet. Create one with +"}
            </div>
          )}
        </div>
      </div>

      <UpdateCard rail={rail} />
      <SidebarFooter
        rail={rail}
        counts={{
          briefNew,
          waiting: activity.waiting,
          running: activity.running,
          rehearsalsReady,
          skillsSuggested: activity.suggested,
          notesWaiting,
        }}
      />

      {menu && <BotContextMenu menu={menu} onClose={() => setMenu(null)} onFile={setFiling} />}
      {filing && <SectionPicker filing={filing} onClose={() => setFiling(null)} />}
      {showArchived && <ArchivedAgents onClose={() => setShowArchived(false)} />}
    </aside>
  );
}


/** Hidden agents, listed for restoring. Archiving keeps the whole
 * conversation; this is the drawer it waits in. */
function ArchivedAgents({ onClose }: { onClose: () => void }) {
  const { state, dispatch } = useStore();
  const archived = state.bots.filter((b) => b.hidden);

  useEffect(() => {
    if (archived.length === 0) onClose();
  }, [archived.length, onClose]);

  return (
    <div
      className="fixed inset-0 z-40 flex animate-fade-in items-center justify-center bg-black/40 dark:bg-black/60"
      onClick={onClose}
    >
      <div
        className="w-[420px] max-w-[92vw] animate-pop-in rounded-2xl border bg-popover p-4 shadow-2xl sm:p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-[16px] font-semibold text-foreground">Archived agents</div>
        <div className="mt-0.5 text-[12.5px] leading-relaxed text-muted-foreground">
          Their conversations, rules and rooms are kept, and so is the key they sign with. Restoring
          puts one back in the sidebar and back to work.
        </div>
        <div className="mt-4 flex max-h-[50vh] flex-col gap-1 overflow-y-auto">
          {archived.map((bot) => (
            <div key={bot.id} className="flex items-center gap-2.5 rounded-xl px-2 py-1.5 hover:bg-accent/60">
              <AgentAvatar bot={bot} size={30} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13.5px] font-medium text-foreground">{bot.name}</span>
                {bot.archivedBy ? (
                  <span className="block truncate text-[11.5px] text-muted-foreground" title={bot.archiveNote}>
                    Archived by {state.bots.find((b) => b.id === bot.archivedBy)?.name ?? "the agent that hired it"}
                    {bot.archiveNote ? `: ${bot.archiveNote}` : ""}
                  </span>
                ) : (
                  bot.title && <span className="block truncate text-[11.5px] text-muted-foreground">{bot.title}</span>
                )}
              </span>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  dispatch({ type: "restoreBot", botId: bot.id });
                  dispatch({ type: "select", id: bot.id });
                  onClose();
                }}
              >
                Restore
              </Button>
              {/* The only door to a real delete, and it says what goes.
                  The key is the part worth naming: every entry this agent
                  signed verifies against that fingerprint and no other,
                  so a new key is not the same agent, it is a different
                  one wearing the name. */}
              <Button
                size="icon-sm"
                variant="ghost"
                title={`Delete ${bot.name} for good`}
                aria-label={`Delete ${bot.name} for good`}
                className="text-muted-foreground hover:text-destructive"
                onClick={() => {
                  const sure = confirm(
                    `Delete ${bot.name} for good?\n\nIts conversations go, and so does the key it signs with, which cannot be remade. What it already signed in the record stays readable but can never be re-signed.\n\nThis cannot be undone.`,
                  );
                  if (sure) dispatch({ type: "deleteBot", botId: bot.id, forget: true });
                }}
              >
                <Trash2 size={14} />
              </Button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
