import { useSettingsObservation } from "@/lib/useSettingsObservation";
import { useEffect, useMemo, useRef, useState } from "react";
import { BellDot } from "@/components/icons";
import { ClipboardCopy } from "@/components/icons";
import { Copy } from "@/components/icons";
import { Eraser } from "@/components/icons";
import { Pencil } from "@/components/icons";
import { Pin } from "@/components/icons";
import { PinOff } from "@/components/icons";
import { Plus } from "@/components/icons";
import { Loader2 } from "@/components/icons";
import { Archive } from "@/components/icons";
import { ChevronRight } from "@/components/icons";
import { Folder } from "@/components/icons";
import { FolderKanban } from "@/components/icons";
import { Bot as BotIcon } from "@/components/icons";
import { Search } from "@/components/icons";
import { Users } from "@/components/icons";
import { Trash2 } from "@/components/icons";
import { Target } from "@/components/icons";
import { api, sidebarRows, useStore, formatWhen, workingInRoom, type Action, type Blok, type Bot } from "@/state/store";
import { Button } from "@/components/ui/button";
import { confirm } from "@/components/ui/confirm";
import { toast } from "@/components/ui/toast";
import { AgentAvatar } from "./Avatar";
import { BloksLogo } from "./Brand";
import { cn } from "@/lib/cn";
import { usePageVisible } from "@/lib/pageVisible";
import { agentPreview, lastHeardAt, lastSaid, previewLine } from "@/lib/preview";
import {
  acceptsRow,
  landingOver,
  moveSection,
  movesRow,
  orderSections,
  pinPosition,
  placeOfRow,
  ROW_TYPE,
  SECTION_TYPE,
  sectionNames,
  shownInSection,
  sidebarLayout,
  sidebarOrder,
  type Landing,
  type Listed,
  type Place,
} from "@/lib/sections";
import { refreshCheckup, riskyCount, useSecurityCheckup } from "@/lib/securityCheckup";
import { ConversationRows, laneRowKeys, LaneRing, WaitingRow } from "./SidebarParts";
import { LaneMark } from "./TaskStrip";
import { RoomRename } from "./room/RoomRename";
import { CHAT_SIDEBAR, useChatSidebar } from "@/lib/chatSidebar";
import { CHAT_COLUMN } from "@/lib/sideColumn";
import { SideColumn } from "./SideColumn";
import { openSearch } from "./CommandPalette";
import { setLanesInSidebar, useConversationsView } from "@/lib/conversationsView";
import { ListTree } from "@/components/icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { formatList, t } from "@/lib/i18n";



interface MenuState {
  kind: "agent" | "room";
  id: string;
  x: number;
  y: number;
}

/** A row being moved right now, by the picker or by hand. */
interface FilingState {
  kind: "agent" | "room";
  id: string;
  name: string;
  current: string | null;
  pinned: boolean;
}

/** Puts a row somewhere: a section, held or not, and a place among the
 * pins. The picker, a drop and Pin in the menu all end here, so the ways
 * of moving a row can never come to mean different things. */
function placeIn(dispatch: React.Dispatch<Action>, row: FilingState, to: Place) {
  dispatch({ type: "placeRow", kind: row.kind, id: row.id, section: to.section, pinned: to.pinned, position: to.position });
}

/** Files a row under a section, or takes it out of one with null. A
 * pinned row stays pinned, after the pins already there. */
function fileUnder(dispatch: React.Dispatch<Action>, row: FilingState, section: string | null) {
  placeIn(dispatch, row, { section, pinned: row.pinned });
}

/** What a row in the full list is drawn from: the agent or room itself,
 * and what its place is decided by, with activity held still while the
 * pointer is over the list (see Sidebar). */
type Row = (Listed & { kind: "agent"; bot: Bot }) | (Listed & { kind: "room"; room: Blok });

/** Where a row in hand would land if let go now. */
interface RowDrop extends Place {
  line?: Landing["line"];
  /** Into another section than its own, which lights the section up. */
  filing?: boolean;
}

/** The line a drop would land on, drawn in the gap above or below a row. */
function DropLine({ edge }: { edge: "top" | "bottom" }) {
  return (
    <span
      className={cn(
        "pointer-events-none absolute inset-x-2 z-10 h-0.5 rounded-full bg-brand",
        edge === "top" ? "-top-px" : "-bottom-px",
      )}
    />
  );
}

/** What lets a row be dragged into another section, or to another place
 * among the pins of its own. The browser holds off until the pointer has
 * travelled a few pixels, so a click that does not move is still a click
 * and opens the row as it always has. */
function rowDrag(row: FilingState, onDrag?: (row: FilingState | null) => void) {
  if (!onDrag) return {};
  return {
    draggable: true,
    onDragStart: (e: React.DragEvent<HTMLElement>) => {
      e.dataTransfer.setData(ROW_TYPE, row.id);
      e.dataTransfer.effectAllowed = "move";
      onDrag(row);
      // Heard on the row itself rather than through React: a drop that
      // files the row redraws it in another part of the list, and the
      // old row, which is the one the drag ends on, is out of the page
      // by then and passes nothing up.
      e.currentTarget.addEventListener("dragend", () => onDrag(null), { once: true });
    },
  };
}

/**
 * The filing dialog: existing sections as one-click destinations, a
 * field for a new name, and a way back out. Sections come from what is
 * already filed, so this list is never stale and never empty-but-real.
 */
function SectionPicker({ filing, onClose }: { filing: FilingState; onClose: () => void }) {
  const { state, dispatch } = useStore();
  const [draft, setDraft] = useState("");
  // listed in the same order as the sidebar's headings
  const names = orderSections(
    sectionNames(
      state.bots.filter((b) => !b.hidden),
      state.bloks,
    ),
    state.sectionOrder,
  );

  const fileTo = (section: string | null) => {
    fileUnder(dispatch, filing, section);
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      onKeyDown={(e) => e.key === "Escape" && onClose()}
    >
      <div className="w-[300px] animate-pop-in rounded-2xl border bg-popover p-4 shadow-lg">
        <div className="text-ui font-semibold text-foreground">
          {t("sidebar.fileUnder", { name: filing.name })}
        </div>
        <div className="mt-3 flex flex-col gap-1">
          {names.map((name) => (
            <button
              key={name}
              onClick={() => fileTo(name)}
              className={cn(
                "flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-body text-foreground hover:bg-accent",
                name === filing.current && "bg-accent/60 font-medium",
              )}
            >
              <Folder size={14} className="text-muted-foreground" />
              {name}
            </button>
          ))}
          {names.length === 0 && (
            <div className="px-1 py-1 text-body text-muted-foreground">
              {t("sidebar.noSectionsYet")}
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
            placeholder={t("sidebar.newSection")}
            maxLength={60}
            className="w-full rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-body text-foreground outline-none placeholder:text-muted-foreground focus:border-ring/60"
          />
          <Button type="submit" size="sm" variant="secondary" disabled={!draft.trim()}>
            {t("sidebar.file")}
          </Button>
        </form>
        {filing.current && (
          <button
            onClick={() => fileTo(null)}
            className="mt-2 w-full rounded-lg px-2.5 py-1.5 text-left text-body text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            {t("sidebar.removeFrom", { section: filing.current })}
          </button>
        )}
      </div>
    </div>
  );
}

/** A row as it is moved: its name, its section and whether it is pinned. */
function filingOf(kind: "agent", row: Bot): FilingState;
function filingOf(kind: "room", row: Blok): FilingState;
function filingOf(kind: "agent" | "room", row: Bot | Blok): FilingState {
  return { kind, id: row.id, name: row.name, current: row.section ?? null, pinned: Boolean(row.pinned) };
}

/** Right-click on a row. A room's menu is the part of an agent's that
 * applies to a room: where it sits in the sidebar, and its name, which
 * is edited on the row itself as a conversation's title is. */
function RowMenu({
  menu,
  onClose,
  onFile,
  onRename,
}: {
  menu: MenuState;
  onClose: () => void;
  onFile: (filing: FilingState) => void;
  /** A room's row becomes a field for its name. */
  onRename: (roomId: string) => void;
}) {
  const { state, dispatch } = useStore();
  const bot = menu.kind === "agent" ? state.bots.find((b) => b.id === menu.id) : undefined;
  const room = menu.kind === "room" ? state.bloks.find((b) => b.id === menu.id) : undefined;

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

  const filing = bot ? filingOf("agent", bot) : room ? filingOf("room", room) : null;
  if (!filing) return null;

  const general = bot?.tasks?.[0];

  // keep the menu on-screen near the click
  const top = Math.min(menu.y, window.innerHeight - (bot ? 372 : 140));
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
        "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-body",
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
  // Pinning from here holds it after the pins already in its section;
  // dragging is how it gets a particular place.
  const pin = item(
    filing.pinned ? (
      <PinOff size={15} className="text-muted-foreground" />
    ) : (
      <Pin size={15} className="text-muted-foreground" />
    ),
    filing.pinned ? t("sidebar.unpin") : t("sidebar.pin"),
    () => placeIn(dispatch, filing, { section: filing.current, pinned: !filing.pinned }),
  );
  const move = item(<Folder size={15} className="text-muted-foreground" />, t("sidebar.moveToSection"), () => onFile(filing));

  return (
    <div
      data-bot-menu
      style={{ top, left }}
      className="fixed z-40 w-[208px] animate-pop-in rounded-xl border bg-popover p-1 shadow-lg shadow-(color:--shadow-color)"
    >
      {!bot ? [
        pin,
        move,
        divider("d1"),
        item(<Pencil size={15} className="text-muted-foreground" />, t("sidebar.renameEllipsis"), () => onRename(filing.id)),
      ] : [
        pin,
        // the agent stands for General, so that is the conversation it marks
        item(
          <BellDot size={15} className="text-muted-foreground" />,
          t("sidebar.markAsUnread"),
          () => general && dispatch({ type: "markLaneUnread", botId: bot.id, taskId: general.id }),
        ),
        move,
        divider("d1"),
        item(<Pencil size={15} className="text-muted-foreground" />, t("sidebar.editProfile"), () => {
          dispatch({ type: "select", id: bot.id });
          dispatch({ type: "toggleSettings", open: true });
        }),
        item(<Copy size={15} className="text-muted-foreground" />, t("sidebar.duplicate"), () =>
          dispatch({ type: "duplicateBot", botId: bot.id }),
        ),
        item(<ClipboardCopy size={15} className="text-muted-foreground" />, t("sidebar.copyConversationId"), () => {
          // the menu closes on the click, so the toast is the only sign it worked
          void navigator.clipboard?.writeText(bot.threadId).then(() => toast.success(t("sidebar.copiedConversationId")));
        }),
        divider("d2"),
        // The chat shows no tabs while an agent has one conversation
        // (GitHub 237), so a second one starts here as well as from the +
        // the conversations view puts on the row.
        item(<Plus size={15} className="text-muted-foreground" />, t("sidebar.newConversation"), () => {
          dispatch({ type: "select", id: bot.id });
          dispatch({ type: "newTask", botId: bot.id });
        }),
        // a goal for General, which is the conversation this row stands for
        general &&
          !general.noGoals &&
          item(<Target size={15} className="text-muted-foreground" />, general.goal ? t("sidebar.setANewGoal") : t("sidebar.setAGoal"), () => {
            dispatch({ type: "select", id: bot.id, lane: general.id });
            dispatch({ type: "openGoal", botId: bot.id, taskId: general.id });
          }),
        // General is cleared, never closed; not while it is working
        general &&
          general.state !== "working" &&
          item(
            <Eraser size={15} />,
            t("sidebar.clearConversation"),
            () =>
              void confirm({
                title: t("sidebar.clearThisConversation"),
                body: t("sidebar.itsMessagesAreDeleted"),
                confirmLabel: t("common.clear"),
                destructive: true,
              }).then((yes) => yes && dispatch({ type: "clearTask", botId: bot.id, taskId: general.id })),
            { danger: true },
          ),
        // Archiving is reversible, so it lives here, asks nothing, and
        // offers its own undo; deleting the agent is behind the drawer
        // where the confirm can name what goes. Archiving takes the agent
        // out of the list and stops it working; it keeps the
        // conversations, the rules, the rooms and the key.
        item(<Archive size={15} className="text-muted-foreground" />, t("sidebar.archive"), () => {
          const wasOpen = state.selectedId === bot.id;
          dispatch({ type: "deleteBot", botId: bot.id });
          toast.success(t("sidebar.archived", { name: bot.name }), {
            id: `archive-${bot.id}`,
            action: {
              label: t("sidebar.undo"),
              onClick: () => {
                dispatch({ type: "restoreBot", botId: bot.id });
                if (wasOpen) dispatch({ type: "select", id: bot.id });
              },
            },
          });
        }),
      ]}
    </div>
  );
}

function BotListItem({
  bot,
  onMenu,
  onDrag,
  compact,
}: {
  bot: Bot;
  onMenu: (menu: MenuState) => void;
  /** Given in the full list, where a row can be dragged to a place. */
  onDrag?: (row: FilingState | null) => void;
  /** The conversations view: one line per agent, with its other
   * conversations listed underneath instead of one conversation's preview. */
  compact?: boolean;
}) {
  const { state, dispatch } = useStore();
  const selected = state.selectedId === bot.id;
  const heardAt = lastHeardAt(bot);
  const drag = rowDrag(filingOf("agent", bot), onDrag);
  if (compact) {
    // the agent's row is General; the others are listed beneath it
    const general = bot.tasks?.[0];
    const generalOpen = selected && (bot.activeTaskId ?? bot.threadId) === general?.id;
    const timestamp = general ? (general.lastAt ?? general.createdAt) : 0;

    return (
      <div
        className="group/agent relative"
        data-sidebar-row={bot.id}
        data-sidebar-waiting={Boolean(bot.unread || bot.tasks?.some((task) => task.state === "needs-you"))}
      >
        <button
          data-lane-of={bot.id}
          onKeyDown={(e) => laneRowKeys(e, bot.id)}
          onClick={() => dispatch({ type: "select", id: bot.id, lane: general?.id })}
          onContextMenu={(e) => {
            e.preventDefault();
            onMenu({ kind: "agent", id: bot.id, x: e.clientX, y: e.clientY });
          }}
          {...drag}
          className={cn(
            "flex h-[38px] w-full items-center gap-2.5 rounded-xl px-2.5 text-left transition-[background-color,scale] duration-150 ease-out active:scale-[0.99]",
            generalOpen ? "bg-accent" : "hover:bg-accent/60",
          )}
        >
          <AgentAvatar bot={bot} size={24} />
          {/* No pin on the row: the line under a list's last pin says what
              is held, and every name starts on the same edge. */}
          <span className="min-w-0 flex-1 truncate text-ui font-medium text-foreground">{bot.name}</span>
          {/* the trailing state steps aside for the + on hover, all of it,
              so the two never sit on top of each other */}
          <span className="flex shrink-0 items-center gap-1.5 transition-opacity duration-150 group-hover/agent:opacity-0">
            {general && <LaneRing lane={general} />}
            {general?.state === "needs-you" ? (
              <span className="text-caption text-warning">{t("sidebar.waiting")}</span>
            ) : general?.state === "working" ? (
              <LaneMark state="working" />
            ) : (
              timestamp > 0 && (
                <span className="text-caption tabular-nums text-muted-foreground/80">{formatWhen(timestamp)}</span>
              )
            )}
            {general?.unread && <span className="size-1.5 rounded-full bg-success" />}
          </span>
        </button>
        {/* a new conversation, from the agent it is with */}
        <button
          onClick={() => {
            dispatch({ type: "select", id: bot.id });
            dispatch({ type: "newTask", botId: bot.id });
          }}
          title={t("sidebar.newConversationWith", { name: bot.name })}
          aria-label={t("sidebar.newConversationWith", { name: bot.name })}
          className="absolute right-1.5 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-[opacity,background-color,color] duration-150 hover:bg-background hover:text-foreground focus-visible:opacity-100 group-hover/agent:opacity-100"
        >
          <Plus size={14} />
        </button>
      </div>
    );
  }
  return (
    <button
      data-sidebar-row={bot.id}
      data-sidebar-waiting={Boolean(bot.unread || bot.tasks?.some((task) => task.state === "needs-you"))}
      onClick={() => dispatch({ type: "select", id: bot.id })}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu({ kind: "agent", id: bot.id, x: e.clientX, y: e.clientY });
      }}
      {...drag}
      className={cn(
        "flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left transition-[background-color,transform] duration-150 active:scale-[0.99]",
        selected ? "bg-accent" : "hover:bg-accent/60",
      )}
    >
      <AgentAvatar bot={bot} size={42} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="min-w-0 truncate text-ui font-medium text-foreground">{bot.name}</span>
          {heardAt !== undefined && (
            <span className="shrink-0 text-small tabular-nums text-muted-foreground">
              {formatWhen(heardAt)}
            </span>
          )}
        </div>
        <div className="mt-px flex items-center justify-between gap-2">
          <span
            className={cn(
              "truncate text-body",
              bot.unread ? "font-medium text-foreground" : "text-muted-foreground",
            )}
          >
            {agentPreview(bot)}
          </span>
          {bot.busy && !bot.tasks?.some((task) => task.state === "needs-you") ? (
            <Loader2 size={13} className="shrink-0 animate-spin text-brand motion-reduce:animate-none" aria-label={t("sidebar.working")} />
          ) : (
            bot.unread && <span className="size-2 shrink-0 rounded-full bg-success" />
          )}
        </div>
      </div>
    </button>
  );
}

function RoomListItem({
  blok,
  onMenu,
  onDrag,
  renaming,
  onRenamed,
}: {
  blok: Blok;
  onMenu?: (menu: MenuState) => void;
  /** Given in the full list, where a row can be dragged to a place. */
  onDrag?: (row: FilingState | null) => void;
  /** The name is a field, from the row's menu. */
  renaming?: boolean;
  onRenamed?: (next: string | null) => void;
}) {
  const { state, dispatch } = useStore();
  const selected = state.selectedId === blok.id;
  const members = blok.memberIds
    .map((id) => state.bots.find((b) => b.id === id))
    .filter(Boolean) as Bot[];
  const last = lastSaid(blok.messages);
  // working in this room, as the room itself shows it (workingInRoom)
  const working = members.filter((m) => workingInRoom(m, blok.id));

  const faces = (
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
  );
  const preview = (
    <div className="mt-px truncate text-body text-muted-foreground">
      {working.length
        ? t("sidebar.roomWorking", { names: formatList(working.map((m) => m.name), { type: "unit" }) })
        : last
          ? previewLine(last)
          : t("sidebar.agentCount", { count: members.length })}
    </div>
  );

  // A field cannot sit inside the row's button, so while the name is
  // being edited the row is a plain box of the same shape.
  if (renaming) {
    return (
      <div
        data-sidebar-row={blok.id}
        className={cn("flex w-full items-center gap-3 rounded-xl px-2.5 py-2", selected ? "bg-accent" : "bg-accent/60")}
      >
        {faces}
        <div className="min-w-0 flex-1">
          <RoomRename name={blok.name} onDone={(next) => onRenamed?.(next)} className="block w-full text-ui font-medium" />
          {preview}
        </div>
      </div>
    );
  }

  return (
    <button
      data-sidebar-row={blok.id}
      onClick={() => dispatch({ type: "select", id: blok.id })}
      onContextMenu={(e) => {
        if (!onMenu) return;
        e.preventDefault();
        onMenu({ kind: "room", id: blok.id, x: e.clientX, y: e.clientY });
      }}
      {...rowDrag(filingOf("room", blok), onDrag)}
      className={cn(
        "flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left transition-[background-color,transform] duration-150 active:scale-[0.99]",
        selected ? "bg-accent" : "hover:bg-accent/60",
      )}
    >
      {faces}
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="flex min-w-0 items-center gap-1.5 truncate text-ui font-medium text-foreground">
            <Users size={11} className="shrink-0 text-muted-foreground" />
            <span className="truncate">{blok.name}</span>
          </span>
          {last && (
            <span className="shrink-0 text-small tabular-nums text-muted-foreground">
              {formatWhen(last.at)}
            </span>
          )}
        </div>
        {preview}
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
export function useRehearsalsReady(): number {
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

/**
 * How many security checkup findings are risky, for the dot on Settings.
 * Asked again every ten minutes while the window shows, when Settings
 * closes (where most fixes are made), and when an agent goes into or out
 * of full access from its own settings, the commonest risky finding.
 */
export function useSecurityRisky(): number {
  const { state } = useStore();
  const { report } = useSecurityCheckup();
  const visible = usePageVisible();
  useEffect(() => {
    if (!visible) return;
    const timer = setInterval(() => void refreshCheckup(), 10 * 60_000);
    return () => clearInterval(timer);
  }, [visible]);
  const settingsOpen = state.appSettingsOpen;
  const fullAccess = state.bots
    .filter((b) => b.approvals === "full")
    .map((b) => b.id)
    .join(",");
  const seen = useRef({ settingsOpen, fullAccess });
  useEffect(() => {
    const before = seen.current;
    seen.current = { settingsOpen, fullAccess };
    if ((before.settingsOpen && !settingsOpen) || before.fullAccess !== fullAccess) void refreshCheckup();
  }, [settingsOpen, fullAccess]);
  return riskyCount(report);
}

/** The chat sidebar: a column beside the chat, or, on a phone, the same
 * column inside the drawer the pill opens (MobileNav.tsx). */
export function Sidebar({ drawer = false }: { drawer?: boolean } = {}) {
  const { state, dispatch } = useStore();
  const [conversations, setConversations] = useConversationsView();
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [filing, setFiling] = useState<FilingState | null>(null);
  // the room whose row is a field for its name
  const [renaming, setRenaming] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const sidebar = useChatSidebar();
  // Phone-narrow windows have no room for two columns, so the sidebar
  // becomes a header (below); everywhere else it is a column whose width
  // is dragged, never collapsed to a rail of faces.
  const [mobile, setMobile] = useState(() => window.innerWidth < 768);
  useEffect(() => {
    const mobileMedia = window.matchMedia("(max-width: 767px)");
    const onChange = () => setMobile(mobileMedia.matches);
    mobileMedia.addEventListener("change", onChange);
    return () => mobileMedia.removeEventListener("change", onChange);
  }, []);
  useEffect(() => {
    setLanesInSidebar(conversations && sidebar.open && !mobile);
  }, [conversations, sidebar.open, mobile]);
  // ⌘B is the title bar's now (TitleBar.tsx): it folds whichever column
  // the place in view keeps, and this list is only one of them.
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
  useSettingsObservation({
    "sidebar.preference": { status: "observed", value: sidebar.open ? "full" : "rail" },
    "sidebar.applied": { status: "observed", value: mobile ? "mobile" : sidebar.open ? "full" : "rail" },
    "sidebar.foldsConfigured": { status: "observed", value: folded.length > 0 },
    "conversations.preference": { status: "observed", value: conversations },
    "conversations.applied": { status: "observed", value: conversations && sidebar.open && !mobile },
  });
  const toggleFolded = (name: string) => {
    const next = folded.includes(name) ? folded.filter((n) => n !== name) : [...folded, name];
    setFolded(next);
    localStorage.setItem("bloks-folded-sections", JSON.stringify(next));
  };

  // The order sections are dragged into, by name. Kept with the workspace,
  // unlike folding, so the Mac and the phone list them the same way;
  // until someone drags one, they stay alphabetical.
  const saveSectionOrder = (next: string[]) => dispatch({ type: "moveSections", order: next });
  // which heading a dragged section would land against, and on which side
  const [sectionDrop, setSectionDrop] = useState<{ name: string; place: "before" | "after" } | null>(null);

  // What is not pinned sorts by the last time it had something to do with
  // you, which moves while you are looking. While the pointer is over the
  // list that part holds still, as it stood when the pointer arrived, so a
  // row cannot slide away just as it is clicked; the list catches up when
  // the pointer leaves. Pins, sections and drops are your own doing and
  // show at once.
  const [heldActivity, setHeldActivity] = useState<Map<string, number> | null>(null);
  const holdActivity = () =>
    setHeldActivity(
      new Map([...state.bots, ...state.bloks].map((row) => [row.id, row.activeWithYouAt ?? 0] as const)),
    );

  // Moving by drag, which files exactly as Move to section does and also
  // places: dropped among a list's pins, a row takes that place and is
  // pinned; dropped below them, it sorts by activity. Three pieces: the
  // row in hand, read by each list as it passes over; the same row for
  // drawing, which catches up a moment later (see below); and where it
  // would land if let go now.
  const draggedRow = useRef<FilingState | null>(null);
  const [dragging, setDragging] = useState<FilingState | null>(null);
  const [rowDrop, setRowDrop] = useState<RowDrop | null>(null);
  const onRowDrag = (row: FilingState | null) => {
    draggedRow.current = row;
    if (row) {
      // Redrawing the list inside dragstart can make the browser give up
      // on the drag, and would shift the row before its picture is
      // taken, so the list only hears about it once the drag is under way.
      setTimeout(() => setDragging(draggedRow.current));
    } else {
      setDragging(null);
      setRowDrop(null);
    }
  };
  /**
   * Where the row in hand lands if let go over this list now, or null
   * when that would leave it exactly where it is. `drawn` is the list as
   * it is on screen for this row: a section's rows, or in the unfiled
   * list only the Rooms or the Agents, since a room let go among the
   * agents still stands with the rooms. A row under the pointer sets the
   * place (landingOver); anywhere else in the list, the heading of a
   * folded section included, files it and keeps whatever pin it has.
   */
  const planDrop = (
    row: FilingState,
    section: string | null,
    drawn: readonly Listed[],
    e: React.DragEvent<HTMLElement>,
  ): RowDrop | null => {
    const over = (e.target as HTMLElement).closest<HTMLElement>("[data-row]");
    const overId = over?.dataset.row;
    let landing: Landing = { pinned: row.pinned };
    if (over && overId && drawn.some((r) => r.id === overId)) {
      const box = over.getBoundingClientRect();
      landing = landingOver(drawn, row.id, overId, e.clientY < box.top + box.height / 2 ? "top" : "bottom");
    }
    // The place is counted among every pin in the section, not only the
    // ones a search or a project is showing, so a hidden pin keeps its own.
    const everything = sidebarRows(state);
    const pins = sidebarOrder(everything.filter((r) => r.id !== row.id && r.pinned && (r.section ?? null) === section));
    const to: Place = {
      section,
      pinned: landing.pinned,
      ...(landing.pinned && landing.line ? { position: pinPosition(pins, landing.line) } : {}),
    };
    const from = placeOfRow(everything, row.id);
    if (!from || !movesRow(from, to)) return null;
    return landing.line ? { ...to, line: landing.line } : to;
  };
  // Each section, and the unfiled list, answers only to a row, and only
  // where letting go would change something: another section, or another
  // place among the pins of its own. A heading being dragged passes over
  // them untouched.
  const fileZone = (section: string | null, drawn: (kind: FilingState["kind"]) => readonly Listed[]) => ({
    onDragOver: (e: React.DragEvent<HTMLElement>) => {
      const row = draggedRow.current;
      if (!row || !e.dataTransfer.types.includes(ROW_TYPE)) return;
      const plan = planDrop(row, section, drawn(row.kind), e);
      if (!plan) {
        setRowDrop((d) => (d?.section === section ? null : d));
        return;
      }
      e.preventDefault();
      // the list lights up only for a row coming in from elsewhere; inside
      // its own, the line alone says where it goes
      const filing = acceptsRow(e.dataTransfer.types, row.current, section);
      setRowDrop((d) =>
        d &&
        d.section === plan.section &&
        d.filing === filing &&
        d.pinned === plan.pinned &&
        d.position === plan.position &&
        d.line?.id === plan.line?.id &&
        d.line?.edge === plan.line?.edge
          ? d
          : { ...plan, filing },
      );
    },
    onDragLeave: (e: React.DragEvent<HTMLElement>) => {
      // Crossing from one row to the next fires a leave as well; the
      // pointer has only left once it is outside the whole box.
      const box = e.currentTarget.getBoundingClientRect();
      if (e.clientX > box.left && e.clientX < box.right && e.clientY > box.top && e.clientY < box.bottom) return;
      setRowDrop((d) => (d?.section === section ? null : d));
    },
    onDrop: (e: React.DragEvent<HTMLElement>) => {
      const row = draggedRow.current;
      if (!row || !e.dataTransfer.types.includes(ROW_TYPE)) return;
      const plan = planDrop(row, section, drawn(row.kind), e);
      if (!plan) return;
      e.preventDefault();
      onRowDrag(null);
      placeIn(dispatch, row, plan);
    },
  });

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
        .filter((b) => !projectMembers || projectMembers.includes(b.id)),
    [state.bots, projectMembers],
  );

  // The whole list in the one order every surface follows (sidebarLayout
  // in src/lib/sections.ts), with activity held still under the pointer.
  const layout = useMemo(() => {
    const rows: Row[] = [
      ...state.bloks.map((room) => ({
        kind: "room" as const,
        id: room.id,
        section: room.section ?? null,
        pinned: room.pinned,
        pinOrder: room.pinOrder,
        activeWithYouAt: heldActivity?.get(room.id) ?? room.activeWithYouAt,
        createdAt: room.createdAt,
        room,
      })),
      ...visibleBots.map((bot) => ({
        kind: "agent" as const,
        id: bot.id,
        section: bot.section ?? null,
        pinned: bot.pinned,
        pinOrder: bot.pinOrder,
        activeWithYouAt: heldActivity?.get(bot.id) ?? bot.activeWithYouAt,
        createdAt: bot.createdAt,
        bot,
      })),
    ];
    return sidebarLayout(rows, state.sectionOrder);
  }, [state.bloks, visibleBots, heldActivity, state.sectionOrder]);

  const newMenuItems = (
    <DropdownMenuContent align="end" className="min-w-[160px]">
      <DropdownMenuItem onClick={() => dispatch({ type: "toggleNewAgent", open: true })}>
        <BotIcon size={15} />
        {t("sidebar.newAgent")}
      </DropdownMenuItem>
      <DropdownMenuItem onClick={() => dispatch({ type: "toggleNewRoom", open: true })}>
        <Users size={15} />
        {t("sidebar.newRoom")}
      </DropdownMenuItem>
      {state.bots.some((b) => b.hidden) && (
        <DropdownMenuItem onClick={() => setShowArchived(true)}>
          <Archive size={15} />
          {t("sidebar.archivedAgents")}
          <span className="ml-auto pl-3 text-caption text-muted-foreground">
            {state.bots.filter((b) => b.hidden).length}
          </span>
        </DropdownMenuItem>
      )}
    </DropdownMenuContent>
  );

  // A phone has no room for a column beside the chat; there the list lives
  // in the drawer the pill opens, which draws this same column.
  if (mobile && !drawer) return null;

  const unfiledRooms = layout.unfiled.rooms;
  const unfiledBots = layout.unfiled.agents;
  // Rows drag wherever there is a place to put them: into a section, or
  // to a place among the pins of their own list.
  const fileDrag = onRowDrag;
  // The unfiled list is the way out of a section. With everything on
  // show filed it has no rows to let go over, so while a filed row is in
  // hand it opens a place for one.
  const unfiling = !unfiledRooms.length && !unfiledBots.length ? (dragging?.current ?? null) : null;

  /** One list as it is drawn: each row with the line a drop would land
   * on, and a hairline under the last pin when rows sorted by activity
   * follow it. That line is the whole of what pinning shows: above it is
   * held in your order, below it moves with what you are doing. */
  const drawList = (rows: readonly Row[], folded = false) =>
    rows.map((row, i) => {
      const line = rowDrop?.line?.id === row.id ? rowDrop.line.edge : null;
      const next = rows[i + 1];
      return (
        <div key={row.id} className="flex flex-col">
          <div data-row={row.id} className="relative flex flex-col">
            {line && <DropLine edge={line} />}
            {row.kind === "room" ? (
              <RoomListItem
                blok={row.room}
                onMenu={setMenu}
                onDrag={fileDrag}
                renaming={renaming === row.room.id}
                onRenamed={(next) => {
                  setRenaming(null);
                  // shown at once, here and in the room's header
                  if (next) dispatch({ type: "patchRoom", blokId: row.room.id, patch: { name: next } });
                }}
              />
            ) : (
              <>
                <BotListItem bot={row.bot} onMenu={setMenu} onDrag={fileDrag} compact={conversations} />
                <ConversationRows bot={row.bot} open={conversations && !folded} />
              </>
            )}
          </div>
          {row.pinned && next && !next.pinned && (
            <div
              role="separator"
              aria-label={t("sidebar.pinnedAboveRecentBelow")}
              className="mx-3 my-1 h-px bg-border/70"
            />
          )}
        </div>
      );
    });

  // The list itself, the same in the column and in the phone's drawer. The
  // column is a page column like the rest (SideColumn.tsx), with the
  // brand line for its edge: dragged to size it, folded by the title
  // bar's toggle, ⌘B, or a drag narrower than it can usefully be.
  const body = (
    <>
      {/* the same height as the chat's header beside it, so the two read
          as one strip; it is the window's handle too */}
      <div
        className="flex h-[52px] shrink-0 items-center justify-between pl-4 pr-2.5"
        style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
      >
        <BloksLogo className="h-[19px]" />
        <div className="flex items-center gap-0.5" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                className="flex size-8 items-center justify-center rounded-lg text-muted-foreground outline-none transition-[background-color,color,scale] duration-150 ease-out hover:bg-accent hover:text-foreground active:scale-[0.96] data-[state=open]:bg-accent data-[state=open]:text-foreground"
                title={t("sidebar.newAgentOrRoom")}
                aria-label={t("sidebar.newAgentOrRoom")}
              >
                <Plus size={17} strokeWidth={1.9} />
              </button>
            </DropdownMenuTrigger>
            {newMenuItems}
          </DropdownMenu>
          <button
            onClick={openSearch}
            className="flex size-8 items-center justify-center rounded-lg text-muted-foreground outline-none transition-[background-color,color,scale] duration-150 ease-out hover:bg-accent hover:text-foreground active:scale-[0.96]"
            title={t("sidebar.searchK")}
            aria-label={t("common.search")}
          >
            <Search size={16} strokeWidth={1.9} />
          </button>
        </div>
      </div>

      {/* Looking through a project: say which, and how to stop. Without
          this a filtered sidebar reads as agents having gone missing. */}
      {projectMembers && (
        <button
          onClick={() => dispatch({ type: "openProject", id: null })}
          title={t("sidebar.showingProject", { name: projectName })}
          className="mx-2 mb-1 flex items-center gap-2 rounded-lg bg-accent/70 px-2.5 py-1.5 text-left text-small text-foreground transition-colors duration-150 hover:bg-accent"
        >
          <FolderKanban size={13} className="shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate">{projectName}</span>
          <span className="shrink-0 text-caption text-muted-foreground">{t("sidebar.leave")}</span>
        </button>
      )}

      <WaitingRow />

      {/* The list. Filed rows stand under their section's heading; the
          unfiled majority keeps the plain Rooms and Agents lists it has
          always had, so sections cost nothing until the first one is
          named. Inside each list, pins first in your order, then the
          rest by recent activity with you. */}
      <div
        className="flex-1 overflow-y-auto px-2 pt-1"
        onMouseEnter={holdActivity}
        onMouseLeave={() => setHeldActivity(null)}
      >
        <div className="flex flex-col gap-px">
          {(unfiledRooms.length > 0 || unfiledBots.length > 0 || unfiling) && (
            <div
              {...fileZone(null, (kind) => (kind === "room" ? unfiledRooms : unfiledBots))}
              className={cn(
                "flex flex-col gap-px rounded-xl transition-colors duration-150",
                rowDrop?.section === null && rowDrop.filing && "bg-brand-soft",
              )}
            >
              {unfiledRooms.length > 0 && (
                <>
                  <div className="flex items-center justify-between px-2.5 pb-1 pt-1 text-small font-medium text-muted-foreground">
                    {t("sidebar.rooms")}
                    <button
                      onClick={() => dispatch({ type: "toggleNewRoom", open: true })}
                      className="rounded p-0.5 transition-colors hover:text-foreground"
                      title={t("sidebar.newRoom")}
                    >
                      <Plus size={12} />
                    </button>
                  </div>
                  {drawList(unfiledRooms)}
                  <div className="flex items-center justify-between px-2.5 pb-1 pt-3 text-small font-medium text-muted-foreground">
                    {t("sidebar.agents")}
                    <button
                      onClick={() => setConversations(!conversations)}
                      aria-pressed={conversations}
                      className={cn(
                        "rounded p-0.5 transition-colors hover:text-foreground",
                        conversations && "text-foreground",
                      )}
                      title={conversations ? t("sidebar.hideConversations") : t("sidebar.showConversations")}
                    >
                      <ListTree size={12} />
                    </button>
                  </div>
                </>
              )}
              {drawList(unfiledBots)}
              {unfiling && (
                <div
                  className={cn(
                    "rounded-xl border border-dashed px-2.5 py-2 text-center text-small text-muted-foreground transition-colors duration-150",
                    rowDrop?.section === null && "border-brand/40 text-foreground",
                  )}
                >
                  {t("sidebar.removeFrom", { section: unfiling })}
                </div>
              )}
            </div>
          )}
          {layout.sections.map(({ name, rows }, index) => {
            const shownSections = layout.sections.map((s) => s.name);
            const isFolded = folded.includes(name);
            const shown = shownInSection(rows, isFolded, state.selectedId, false);
            // A folded heading still says something is waiting inside.
            const waiting = isFolded && rows.some((row) => row.kind === "agent" && row.bot.unread);
            const hint = sectionDrop?.name === name ? sectionDrop.place : null;
            return (
              <div
                key={name}
                // the whole section takes a row, heading and rows alike,
                // so a folded one still does and stays folded after
                {...fileZone(name, () => shown)}
                className={cn(
                  "relative flex flex-col gap-px rounded-xl transition-colors duration-150",
                  rowDrop?.section === name && rowDrop.filing && "bg-brand-soft",
                )}
              >
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
                  title={isFolded ? t("sidebar.showSectionDragToReorder") : t("sidebar.foldSectionDragToReorder")}
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
                  className="flex cursor-grab items-center gap-1.5 rounded px-2.5 pb-1 pt-3 text-left text-small font-medium text-muted-foreground transition-colors hover:text-foreground active:cursor-grabbing"
                >
                  <Folder size={11} className="shrink-0" />
                  <span className="truncate">{name}</span>
                  {isFolded && (
                    <span className="shrink-0 normal-case tracking-normal">{rows.length}</span>
                  )}
                  {waiting && <span className="size-1.5 shrink-0 rounded-full bg-success" />}
                  <ChevronRight
                    size={11}
                    className={cn("ml-auto shrink-0 transition-transform", !isFolded && "rotate-90")}
                  />
                </button>
                {drawList(shown, isFolded)}
              </div>
            );
          })}
          {visibleBots.length === 0 && state.hydrated && (
            <div className="px-3 py-8 text-center text-body text-muted-foreground">{t("sidebar.noAgentsYetCreateOne")}</div>
          )}
        </div>
      </div>

      {menu && <RowMenu menu={menu} onClose={() => setMenu(null)} onFile={setFiling} onRename={setRenaming} />}
      {filing && <SectionPicker filing={filing} onClose={() => setFiling(null)} />}
      {showArchived && <ArchivedAgents onClose={() => setShowArchived(false)} />}
    </>
  );

  if (drawer) {
    return (
      <aside aria-label={t("sidebar.agentsAndRooms")} className="relative flex h-full min-w-0 flex-1 flex-col bg-sidebar">
        {body}
      </aside>
    );
  }
  return (
    <SideColumn id={CHAT_COLUMN} size={CHAT_SIDEBAR} label={t("sidebar.agentsAndRooms")} page={false} className="relative h-full bg-sidebar">
      {body}
    </SideColumn>
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
        <div className="text-title font-semibold text-foreground">{t("sidebar.archivedAgents")}</div>
        <div className="mt-0.5 text-body leading-relaxed text-muted-foreground">
          {t("sidebar.theirChatsRulesAndRooms")}
        </div>
        <div className="mt-4 flex max-h-[50vh] flex-col gap-1 overflow-y-auto">
          {archived.map((bot) => (
            <div key={bot.id} className="flex items-center gap-2.5 rounded-xl px-2 py-1.5 hover:bg-accent/60">
              <AgentAvatar bot={bot} size={30} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-ui font-medium text-foreground">{bot.name}</span>
                {bot.archivedBy ? (
                  <span className="block truncate text-small text-muted-foreground" title={bot.archiveNote}>
                    {t(bot.archiveNote ? "sidebar.archivedByWithNote" : "sidebar.archivedBy", {
                      name: state.bots.find((b) => b.id === bot.archivedBy)?.name ?? t("sidebar.theAgentThatHiredIt"),
                      note: bot.archiveNote ?? "",
                    })}
                  </span>
                ) : (
                  bot.title && <span className="block truncate text-small text-muted-foreground">{bot.title}</span>
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
                {t("sidebar.restore")}
              </Button>
              {/* The only door to a real delete, and it says what goes.
                  The key is the part worth naming: every entry this agent
                  signed verifies against that fingerprint and no other,
                  so a new key is not the same agent, it is a different
                  one wearing the name. */}
              <Button
                size="icon-sm"
                variant="ghost"
                title={t("sidebar.deleteForGoodNamed", { name: bot.name })}
                aria-label={t("sidebar.deleteForGoodNamed", { name: bot.name })}
                className="text-muted-foreground hover:text-destructive"
                onClick={() =>
                  void confirm({
                    title: t("sidebar.deleteForGoodQuestion", { name: bot.name }),
                    body: t("sidebar.deleteForGoodBody"),
                    confirmLabel: t("sidebar.deleteForGood"),
                    destructive: true,
                  }).then((sure) => sure && dispatch({ type: "deleteBot", botId: bot.id, forget: true }))
                }
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
