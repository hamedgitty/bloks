// Workstreams: one agent, several tasks in flight.
//
// The design premise, and where this deliberately goes past the obvious
// dropdown-of-threads: tasks are VISIBLE, parallel, and interruptible.
// A slim strip lives under the chat header, one chip per task. The chip
// wears the task's live state, a blue dot that pulses while it works, an
// amber dot when it is waiting on you, a green dot when it finished and
// nobody has opened it yet, so an agent juggling three jobs reads at a
// glance, without opening anything.
//
// The interaction rule that makes parallelism feel right: the composer
// always talks to the active chip, and starting a new task never asks
// permission, if the current task is mid-run you just open another
// lane and keep talking. Switching lanes is one click; nothing queues
// behind anything else.
//
// Up to twenty lanes per agent, each running one turn at a time. Any of
// them can be closed except General, the first, which is cleared instead,
// because an agent always has somewhere to be talked to. Most agents have
// only that one, so the strip appears once there is a second (ChatView);
// the sidebar row opens one.
//
// A lane names itself from the first words of its first message, which
// often say nothing about what it became. A double click renames it.
import { useRef, useState } from "react";
import { Plus } from "@/components/icons";
import { X } from "@/components/icons";
import { cn } from "@/lib/cn";
import { contextTitle, measuredContext, type LaneContext } from "@/lib/contextCard";
import { rovingTo } from "@/lib/conversationKeys";
import { t } from "@/lib/i18n";

export type TaskState = "working" | "needs-you" | "idle";

export interface TaskChipData {
  id: string;
  title: string;
  state: TaskState;
  usage?: { input: number; output: number; turns: number };
  /** How full this lane's conversation is. See server/context.ts. */
  context?: LaneContext;
  /** Something landed here that nobody has opened yet. */
  unread?: boolean;
}

/** 842 tokens reads as itself; larger sums read as 12.3k or 1.2M. Zero
 * returns nothing so the chip stays clean until a lane has history. */
export function formatTokens(n: number): string | null {
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(Math.round(n / 100) / 10).toFixed(1).replace(/\.0$/, "")}k`;
  return `${(Math.round(n / 100_000) / 10).toFixed(1).replace(/\.0$/, "")}M`;
}

/** The server's bound (MAX_TASKS in server/store.ts). */
export const MAX_TASKS = 20;

/** The server keeps a lane title to one line of 40 characters. */
const MAX_TITLE = 40;

/**
 * The chip while it is being renamed. Its own element rather than an
 * input inside the chip's button, which is not valid HTML and loses
 * clicks in some browsers. Enter or clicking away keeps the new name;
 * Escape, or leaving it blank or unchanged, keeps the old one.
 */
function RenameChip({ title, onDone }: { title: string; onDone: (next: string | null) => void }) {
  const [value, setValue] = useState(title);
  // Escape ends it, and so does the blur that follows as the field goes
  // away; only the first one counts, or Escape would save what it undid
  const ended = useRef(false);
  const end = (next: string | null) => {
    if (ended.current) return;
    ended.current = true;
    onDone(next);
  };
  const finish = () => {
    const next = value.replace(/\s+/g, " ").trim();
    end(next && next !== title ? next : null);
  };
  return (
    <input
      autoFocus
      value={value}
      maxLength={MAX_TITLE}
      aria-label={t("taskStrip.renameThisConversation")}
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setValue(e.target.value)}
      onBlur={finish}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") end(null);
      }}
      size={Math.max(8, Math.min(MAX_TITLE, value.length + 1))}
      className="w-full min-w-0 rounded-md bg-accent px-2 py-1 text-body font-medium text-foreground outline-none"
    />
  );
}

/**
 * How full a lane is, as a ring rather than a number.
 *
 * A percentage invites arithmetic nobody wants to do; a ring is read
 * without being read. It only appears once a lane has enough in it to be
 * worth watching, because a ring at three percent on every chip is
 * decoration.
 */
export function ContextRing({
  fraction,
  summarised,
  size = 13,
}: {
  fraction: number;
  summarised: boolean;
  size?: number;
}) {
  const radius = (size - 3) / 2;
  const circumference = 2 * Math.PI * radius;
  const filled = Math.max(0, Math.min(1, fraction));
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className="shrink-0"
      aria-hidden
    >
      <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="currentColor" strokeWidth={1.6} opacity={0.22} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.6}
        strokeLinecap={filled > 0 ? "round" : "butt"}
        strokeDasharray={circumference}
        strokeDashoffset={circumference - filled * circumference}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
        className="transition-[stroke-dashoffset] duration-500 ease-out"
        opacity={summarised ? 0.55 : 0.85}
      />
    </svg>
  );
}

/** Below this a ring says nothing anybody needs. */
export const RING_FROM = 0.25;

/** A conversation's state as a mark, the same on a tab and in the
 * sidebar: working is a blue dot that pulses (still under reduced
 * motion), waiting on you is amber, finished and not opened yet is green,
 * idle or read shows nothing. `slot` keeps an empty place for idle, so
 * titles in a list stay on one edge. */
export function LaneMark({ state, unread, slot }: { state: string; unread?: boolean; slot?: boolean }) {
  if (state === "working") {
    return (
      <span role="img" aria-label={t("sidebarParts.working")} className="relative flex size-2 shrink-0">
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-brand opacity-60 motion-reduce:hidden" />
        <span className="relative inline-flex size-2 rounded-full bg-brand" />
      </span>
    );
  }
  if (state === "needs-you") return <span className="size-2 shrink-0 rounded-full bg-warning" />;
  if (unread) return <span className="size-2 shrink-0 rounded-full bg-success" />;
  return slot ? <span className="size-2 shrink-0" /> : null;
}

export function TaskStrip({
  tasks,
  activeId,
  onSelect,
  onNew,
  onClose,
  onClear,
  onRename,
  inTitleBar,
}: {
  /** Up in the window's title bar (lib/titlebarSlot.ts): the bar is the
   * band, so the strip draws none of its own and fills the bar's height. */
  inTitleBar?: boolean;
  tasks: TaskChipData[];
  activeId: string;
  onSelect: (id: string) => void;
  onNew: () => void;
  onClose: (id: string) => void;
  onClear: (id: string) => void;
  onRename?: (id: string, title: string) => void;
}) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const running = tasks.filter((t) => t.state === "working").length;
  const needsYou = tasks.filter((t) => t.state === "needs-you").length;

  // Tabs the way a browser draws them: a band, each conversation a tab on
  // it, and the open one lifted into the page below with a curve where it
  // meets the band on each side (.tab-joined in styles.css). Thin lines
  // part the others, except beside the open tab, where the curve does.
  const activeIndex = tasks.findIndex((t) => t.id === activeId);
  return (
    <div
      role="tablist"
      aria-label={t("taskStrip.conversations")}
      className={cn(
        "flex shrink-0 items-end gap-0 overflow-x-auto max-md:[scrollbar-width:none] max-md:[&::-webkit-scrollbar]:hidden",
        inTitleBar ? "h-full min-w-0 flex-1 pt-1.5 pr-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" : "h-[38px] bg-tab-strip px-3 pt-1.5 md:px-4",
      )}
    >
      {tasks.map((task, index) => {
        const active = task.id === activeId;
        // General, the first, is cleared rather than closed
        const isGeneral = index === 0;
        const parted = !active && index !== activeIndex - 1 && index !== tasks.length - 1;
        const total = (task.usage?.input ?? 0) + (task.usage?.output ?? 0);
        const usage = formatTokens(total)
          ? ` · ${t("taskStrip.usage", { input: task.usage!.input, output: task.usage!.output, count: task.usage!.turns })}`
          : "";
        if (renaming === task.id) {
          return (
            <div key={task.id} className="tab-joined relative flex h-full min-w-[140px] items-center rounded-t-[10px] bg-background px-2">
              <RenameChip
                title={task.title}
                onDone={(next) => {
                  setRenaming(null);
                  if (next) onRename?.(task.id, next);
                }}
              />
            </div>
          );
        }
        return (
          <div
            key={task.id}
            role="tab"
            aria-selected={active}
            // One stop in the tab order, the open tab, and the arrows,
            // Home and End from there, as a tab strip has them. They move
            // the keyboard and Enter opens: opening one asks the server
            // for it and reads it, which is not for every tab passed on
            // the way.
            tabIndex={active || (activeIndex < 0 && index === 0) ? 0 : -1}
            onClick={() => onSelect(task.id)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") return (e.preventDefault(), onSelect(task.id));
              const tabs = [...(e.currentTarget.parentElement?.querySelectorAll<HTMLElement>("[role=tab]") ?? [])];
              const to = rovingTo(e.key, tabs.indexOf(e.currentTarget), tabs.length, "horizontal");
              if (to === null) return;
              e.preventDefault();
              tabs[to].focus();
            }}
            onDoubleClick={onRename ? () => setRenaming(task.id) : undefined}
            title={`${onRename ? t("taskStrip.titleRename", { title: task.title }) : task.title}${usage}`}
            className={cn(
              "group/tab relative flex h-full min-w-[96px] max-w-[220px] flex-1 basis-[200px] cursor-default items-center gap-2 rounded-t-[10px] pl-3 pr-1.5 text-body outline-none transition-colors duration-150",
              active
                ? "tab-joined z-[1] bg-background text-foreground"
                : "text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground",
            )}
          >
            <LaneMark state={task.state} unread={task.unread} />
            <span className={cn("min-w-0 flex-1 truncate", active && "font-medium")}>{task.title}</span>
            {task.context && ((measuredContext(task.context) && task.context.fraction >= RING_FROM) || task.context.summarised) && (
              <span className="shrink-0 text-muted-foreground" title={contextTitle(task.context)}>
                <ContextRing fraction={measuredContext(task.context) ? task.context.fraction : 0} summarised={task.context.summarised} />
              </span>
            )}
            {/* Shown on the open tab and under the pointer, as a browser's
                is; a touch screen never hovers, so there it always shows. */}
            {/* A running conversation cannot be closed or cleared (the
                server refuses), so its × says so instead of trying; the
                sidebar's menu says the same. */}
            <button
              tabIndex={-1}
              disabled={task.state === "working"}
              aria-label={isGeneral ? t("taskStrip.clearNamed", { title: task.title }) : t("taskStrip.closeNamed", { title: task.title })}
              title={
                task.state === "working"
                  ? t("taskStrip.stopItBeforeClosing")
                  : isGeneral
                    ? t("taskStrip.clearThisConversation")
                    : t("taskStrip.closeThisConversation")
              }
              onClick={(e) => {
                e.stopPropagation();
                (isGeneral ? onClear : onClose)(task.id);
              }}
              className={cn(
                "flex size-5 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-[opacity,background-color] duration-150 hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-30 pointer-coarse:opacity-100",
                active ? "opacity-100" : "opacity-0 group-hover/tab:opacity-100",
              )}
            >
              <X size={12} />
            </button>
            {parted && (
              <span aria-hidden className="pointer-events-none absolute right-0 top-1/2 h-4 w-px -translate-y-1/2 bg-border transition-opacity duration-150 group-hover/tab:opacity-0" />
            )}
          </div>
        );
      })}

      {tasks.length < MAX_TASKS && (
        <button
          onClick={onNew}
          aria-label={t("taskStrip.newConversation")}
          title={t("taskStrip.newConversationRunsAlongsideThis")}
          className="mb-1 ml-1 flex size-7 shrink-0 items-center justify-center self-center rounded-full text-muted-foreground transition-[background-color,color,scale] duration-150 ease-out hover:bg-accent hover:text-foreground active:scale-[0.94]"
        >
          <Plus size={15} />
        </button>
      )}

      <span className="mb-2 ml-auto shrink-0 self-center pl-3 text-caption text-muted-foreground/80">
        {needsYou > 0
          ? t("taskStrip.waitingOnYou", { count: needsYou })
          : running > 0
            ? t("taskStrip.running", { count: running })
            : null}
      </span>
    </div>
  );
}
