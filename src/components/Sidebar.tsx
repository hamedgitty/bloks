import { useEffect, useMemo, useRef, useState } from "react";
import BellDot from "lucide-react/dist/esm/icons/bell-dot.js";
import ClipboardCopy from "lucide-react/dist/esm/icons/clipboard-copy.js";
import Copy from "lucide-react/dist/esm/icons/copy.js";
import Moon from "lucide-react/dist/esm/icons/moon.js";
import Pencil from "lucide-react/dist/esm/icons/pencil.js";
import PanelLeftClose from "lucide-react/dist/esm/icons/panel-left-close.js";
import PanelLeftOpen from "lucide-react/dist/esm/icons/panel-left-open.js";
import Pin from "lucide-react/dist/esm/icons/pin.js";
import PinOff from "lucide-react/dist/esm/icons/pin-off.js";
import Plus from "lucide-react/dist/esm/icons/plus.js";
import Archive from "lucide-react/dist/esm/icons/archive.js";
import Puzzle from "lucide-react/dist/esm/icons/puzzle.js";
import Folder from "lucide-react/dist/esm/icons/folder.js";
import MapIcon from "lucide-react/dist/esm/icons/map.js";
import FolderKanban from "lucide-react/dist/esm/icons/folder-kanban.js";
import Activity from "lucide-react/dist/esm/icons/activity.js";
import BotIcon from "lucide-react/dist/esm/icons/bot.js";
import CalendarClock from "lucide-react/dist/esm/icons/calendar-clock.js";
import Search from "lucide-react/dist/esm/icons/search.js";
import SettingsIcon from "lucide-react/dist/esm/icons/settings-2.js";
import Sparkles from "lucide-react/dist/esm/icons/sparkles.js";
import Users from "lucide-react/dist/esm/icons/users.js";
import Sun from "lucide-react/dist/esm/icons/sun.js";
import Trash2 from "lucide-react/dist/esm/icons/trash-2.js";
import { api, useStore, formatWhen, type Blok, type Bot } from "@/state/store";
import { Button } from "@/components/ui/button";
import { useTheme } from "@/lib/theme";
import { AgentAvatar } from "./Avatar";
import { BloksLogo, BloksMark } from "./Brand";
import { cn } from "@/lib/cn";
import { usePageVisible } from "@/lib/pageVisible";
import { previewLine } from "@/lib/preview";
import { inSection, sectionNames } from "@/lib/sections";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const isElectron = navigator.userAgent.includes("Electron");

function preview(bot: Bot): string {
  // a lane waiting on a human outranks everything: that is the row the
  // user should open next
  if (bot.tasks?.some((t) => t.state === "needs-you")) return "Waiting for you…";
  if (bot.busy) return "Working…";
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
function SectionPicker({ filing, onClose }: { filing: FilingState; onClose: () => void }) {
  const { state, dispatch } = useStore();
  const [draft, setDraft] = useState("");
  const names = sectionNames(
    state.bots.filter((b) => !b.hidden),
    state.bloks,
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
      className="fixed z-40 w-[208px] animate-pop-in rounded-xl border bg-popover p-1 shadow-lg shadow-[--shadow-color]"
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
        item(<BellDot size={15} className="text-muted-foreground" />, "Mark as unread", () =>
          dispatch({ type: "markUnread", botId: bot.id }),
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
        // One reversible action here, and the irreversible one behind the
        // drawer where the confirm can name what goes. Archiving takes
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
}: {
  bot: Bot;
  onMenu: (menu: MenuState) => void;
  rail?: boolean;
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
          {bot.unread && <span className="size-2 shrink-0 rounded-full bg-brand" />}
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
              : `${members.length} agents`}
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
  const { resolvedTheme, setTheme } = useTheme();
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [filing, setFiling] = useState<FilingState | null>(null);
  const activity = useActivityCount();
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
  const [logoHover, setLogoHover] = useState(false);
  const toggleCollapsed = () => {
    const next = !rail;
    setChoice(next);
    localStorage.setItem("bloks-sidebar", next ? "rail" : "full");
  };

  // ⌘N new agent, ⌘K focus search, the two things you do most
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey && !e.ctrlKey) return;
      if (e.key === "n") {
        e.preventDefault();
        dispatch({ type: "toggleNewAgent", open: true });
      } else if (e.key === "k") {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
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
        New Bot
      </DropdownMenuItem>
      <DropdownMenuItem onClick={() => dispatch({ type: "toggleNewRoom", open: true })}>
        <Users size={15} />
        New Room
      </DropdownMenuItem>
      {/* On a phone the footer is gone, so everything that lives there
          has to be here instead. All four of them: a surface with no way
          in on the device somebody is holding is a surface that does not
          exist for them. */}
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
                <div className="px-2.5 pb-1 pt-3 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                  Agents
                </div>
              )}
            </>
          )}
          {(rail ? visibleBots : inSection(visibleBots, null)).map((b) => (
            <BotListItem key={b.id} bot={b} onMenu={setMenu} rail={rail} />
          ))}
          {!rail &&
            sectionNames(visibleBots, state.bloks).map((name) => {
              const rooms = inSection(state.bloks, name);
              const bots = inSection(visibleBots, name);
              if (!rooms.length && !bots.length) return null;
              return (
                <div key={name} className="flex flex-col gap-px">
                  <div className="flex items-center gap-1.5 px-2.5 pb-1 pt-3 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                    <Folder size={11} className="shrink-0" />
                    <span className="truncate">{name}</span>
                  </div>
                  {rooms.map((b) => (
                    <RoomListItem key={b.id} blok={b} onFile={setFiling} />
                  ))}
                  {bots.map((b) => (
                    <BotListItem key={b.id} bot={b} onMenu={setMenu} />
                  ))}
                </div>
              );
            })}
          {visibleBots.length === 0 && !rail && (
            <div className="px-3 py-8 text-center text-[13px] text-muted-foreground">
              {query ? "No agents match" : "No agents yet. Create one with +"}
            </div>
          )}
        </div>
      </div>

      {/* Footer */}
      <div className={cn("border-t pb-2 pt-1.5", rail ? "px-2" : "px-2")}>
        {(
          [
            [Activity, "Activity", () => dispatch({ type: "toggleActivity", open: true })],
            [MapIcon, "Map", () => dispatch({ type: "toggleMap", open: true })],
            [FolderKanban, "Projects", () => dispatch({ type: "toggleProjects", open: true })],
            [CalendarClock, "Routines", () => dispatch({ type: "toggleRoutines", open: true })],
            [Sparkles, "Skills", () => dispatch({ type: "toggleSkills", open: true })],
            [Puzzle, "Plugins", () => dispatch({ type: "togglePlugins", open: true })],
          ] as const
        ).map(([Icon, label, onClick]) => (
          <button
            key={label}
            onClick={onClick}
            title={label}
            className={cn(
              "flex items-center gap-2.5 rounded-lg py-1.5 text-left text-[13px] text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground",
              rail ? "relative mx-auto px-1.5" : "w-full px-2.5",
            )}
          >
            <Icon size={16} />
            {!rail && label}
            {((label === "Activity" && (activity.waiting > 0 || activity.running > 0)) ||
              (label === "Skills" && activity.suggested > 0)) && (
              <span
                className={cn(
                  "ml-auto rounded-md px-1.5 py-0.5 text-[10.5px] tabular-nums",
                  label === "Skills" || activity.waiting > 0
                    ? "bg-warning/15 text-warning"
                    : "bg-muted text-muted-foreground",
                  rail && "absolute right-1 top-0.5 ml-0 px-1",
                )}
              >
                {label === "Skills"
                  ? activity.suggested
                  : activity.waiting > 0
                    ? activity.waiting
                    : activity.running}
              </span>
            )}
          </button>
        ))}
        <div className={cn("mt-0.5 flex items-center", rail ? "flex-col gap-0.5" : "gap-0.5")}>
          <button
            onClick={() => dispatch({ type: "toggleAppSettings" })}
            title="Settings"
            className={cn(
              "flex items-center gap-2.5 rounded-lg py-1.5 text-left text-[13px] text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground",
              rail ? "px-1.5" : "min-w-0 flex-1 px-2.5",
            )}
          >
            <SettingsIcon size={16} />
            {!rail && "Settings"}
          </button>
          {!rail && (
            <button
              onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
              className="rounded-lg p-1.5 text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground active:scale-95"
              title={resolvedTheme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            >
              {resolvedTheme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
            </button>
          )}
        </div>
      </div>

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
                {bot.title && (
                  <span className="block truncate text-[11.5px] text-muted-foreground">{bot.title}</span>
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
