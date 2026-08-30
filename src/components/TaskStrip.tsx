// Workstreams: one agent, several tasks in flight.
//
// The design premise, and where this deliberately goes past the obvious
// dropdown-of-threads: tasks are VISIBLE, parallel, and interruptible.
// A slim strip lives under the chat header, one chip per task. The chip
// wears the task's live state, a pulsing dot while it works, an amber
// glow when it is waiting on you, quiet grey when idle, so an agent
// juggling three jobs reads at a glance, without opening anything.
//
// The interaction rule that makes parallelism feel right: the composer
// always talks to the active chip, and starting a new task never asks
// permission, if the current task is mid-run you just open another
// lane and keep talking. Switching lanes is one click; nothing queues
// behind anything else.
//
// Capped at three running tasks per agent: enough to feel parallel,
// few enough that each still gets real attention (and real compute).
import Plus from "lucide-react/dist/esm/icons/plus.mjs";
import X from "lucide-react/dist/esm/icons/x.mjs";
import { cn } from "@/lib/cn";

export type TaskState = "working" | "needs-you" | "idle";

export interface TaskChipData {
  id: string;
  title: string;
  state: TaskState;
  usage?: { input: number; output: number; turns: number };
  /** How full this lane's conversation is. See server/context.ts. */
  context?: { used: number; limit: number; fraction: number; summarised: boolean };
}

/** 842 tokens reads as itself; larger sums read as 12.3k or 1.2M. Zero
 * returns nothing so the chip stays clean until a lane has history. */
export function formatTokens(n: number): string | null {
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(Math.round(n / 100) / 10).toFixed(1).replace(/\.0$/, "")}k`;
  return `${(Math.round(n / 100_000) / 10).toFixed(1).replace(/\.0$/, "")}M`;
}

const MAX_TASKS = 3;

/**
 * How full a lane is, as a ring rather than a number.
 *
 * A percentage invites arithmetic nobody wants to do; a ring is read
 * without being read. It only appears once a lane has enough in it to be
 * worth watching, because a ring at three percent on every chip is
 * decoration.
 */
function ContextRing({
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
const RING_FROM = 0.25;

function StateDot({ state }: { state: TaskState }) {
  if (state === "working") {
    return (
      <span className="relative flex size-2 shrink-0">
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-brand opacity-60" />
        <span className="relative inline-flex size-2 rounded-full bg-brand" />
      </span>
    );
  }
  if (state === "needs-you") {
    return <span className="size-2 shrink-0 rounded-full bg-warning shadow-[0_0_6px_var(--warning)]" />;
  }
  // idle has nothing to say; an empty slot would just be crooked padding
  return null;
}

export function TaskStrip({
  tasks,
  activeId,
  onSelect,
  onNew,
  onClose,
}: {
  tasks: TaskChipData[];
  activeId: string;
  onSelect: (id: string) => void;
  onNew: () => void;
  onClose: (id: string) => void;
}) {
  const running = tasks.filter((t) => t.state === "working").length;
  const needsYou = tasks.filter((t) => t.state === "needs-you").length;

  return (
    <div className="flex shrink-0 items-center gap-1.5 overflow-x-auto border-b bg-background/95 px-3 py-2.5 md:px-4">
      {tasks.map((task) => {
        const active = task.id === activeId;
        const canClose = tasks.length > 1;
        return (
          <button
            key={task.id}
            onClick={() => onSelect(task.id)}
            className={cn(
              "group/chip flex max-w-[220px] shrink-0 items-center gap-2 rounded-full border py-1 text-[12px] transition-all duration-150",
              canClose ? "pl-2.5 pr-1.5" : "px-2.5",
              active
                ? "border-foreground/25 bg-foreground text-background shadow-sm"
                : "text-muted-foreground hover:border-foreground/25 hover:text-foreground",
              task.state === "needs-you" && !active && "border-warning/50 bg-warning/10 text-foreground",
            )}
          >
            <StateDot state={task.state} />
            <span className="truncate font-medium">{task.title}</span>
            {task.context && (task.context.fraction >= RING_FROM || task.context.summarised) && (
              <span
                className={cn("shrink-0", active ? "opacity-80" : "text-muted-foreground")}
                title={
                  `${Math.round(task.context.fraction * 100)}% of what this model will take` +
                  (task.context.summarised ? ", and the earlier part has been summarised" : "")
                }
              >
                <ContextRing fraction={task.context.fraction} summarised={task.context.summarised} />
              </span>
            )}
            {(() => {
              const total = (task.usage?.input ?? 0) + (task.usage?.output ?? 0);
              const label = formatTokens(total);
              return label ? (
                <span
                  className={cn("shrink-0 text-[10.5px] tabular-nums", active ? "opacity-70" : "text-muted-foreground/70")}
                  title={`${task.usage!.input.toLocaleString()} in · ${task.usage!.output.toLocaleString()} out · ${task.usage!.turns} turns`}
                >
                  {label}
                </span>
              ) : null;
            })()}
            {canClose && (
              <span
                role="button"
                tabIndex={-1}
                aria-label={`Close ${task.title}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(task.id);
                }}
                className={cn(
                  "flex size-4 items-center justify-center rounded-full opacity-0 transition-opacity duration-150 group-hover/chip:opacity-100",
                  active ? "hover:bg-background/20" : "hover:bg-accent",
                )}
              >
                <X size={11} />
              </span>
            )}
          </button>
        );
      })}

      {tasks.length < MAX_TASKS && (
        <button
          onClick={onNew}
          title="New task: a separate thread, running in parallel"
          className="flex size-6 shrink-0 items-center justify-center rounded-full border border-dashed text-muted-foreground transition-colors duration-150 hover:border-foreground/30 hover:text-foreground"
        >
          <Plus size={13} />
        </button>
      )}

      <span className="ml-auto shrink-0 pl-2 text-[11px] text-muted-foreground/70">
        {needsYou > 0
          ? `${needsYou} waiting on you`
          : running > 0
            ? `${running} running`
            : null}
      </span>
    </div>
  );
}
