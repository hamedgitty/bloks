// A message in a conversation of more than two (src/lib/participants.ts):
// the reader's own on the right in their accent, everyone else's on the
// left on a quiet surface with a face and a name, a run from one sender
// drawn as one. Rooms, team conversations and a member's app all draw
// their group messages with this, so they read the same.
import { useState } from "react";
import { cn } from "@/lib/cn";
import { initials, tintOf } from "@/lib/members";
import { seenLine } from "@/lib/participants";
import { stamp } from "@/lib/when";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

/** A person's face: their initials on a quiet tint steady per person,
 * never an agent's colour, so a person is never taken for an agent. */
export function PersonAvatar({ id, name, size = 28, className }: { id: string; name: string; size?: number; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("grid shrink-0 place-items-center rounded-full font-semibold text-white/90", className)}
      style={{ width: size, height: size, background: tintOf(id), fontSize: Math.max(8, Math.round(size * 0.4)) }}
    >
      {initials(name)}
    </span>
  );
}

/** The width a bubble may take of the column: enough for a table or a
 * card to breathe, while still reading as somebody's message. */
const COLUMN = "max-w-[85%] max-sm:max-w-[92%]";

export function GroupMessage({
  mine,
  first,
  last,
  face,
  name,
  at,
  rich,
  bubble,
  under,
  actions,
  receipts,
  readId,
  rowRef,
  onPointerUp,
  className,
  bubbleClassName,
}: {
  /** The reader's own words: right, in the accent. */
  mine: boolean;
  /** First of a run from one sender: the face and the name go here. */
  first: boolean;
  /** Last of a run: its time shows under it. */
  last: boolean;
  face?: React.ReactNode;
  name?: string;
  at: number;
  /** A table, a card, generated interface, code or pictures: the bubble
   * takes the whole column so nothing in it is cramped. */
  rich?: boolean;
  /** What goes inside the bubble. */
  bubble: React.ReactNode;
  /** Under the bubble, inside the column: reactions, notes. */
  under?: React.ReactNode;
  /** The message's verbs, floated on the bubble's top edge on hover. */
  actions?: React.ReactNode;
  receipts?: React.ReactNode;
  /** The id the reader's place is said by (src/lib/readReceipts.ts). */
  readId?: string;
  rowRef?: React.Ref<HTMLDivElement>;
  onPointerUp?: (e: React.PointerEvent) => void;
  className?: string;
  bubbleClassName?: string;
}) {
  return (
    <div
      ref={rowRef}
      data-read-id={readId}
      data-bubble={mine ? "mine" : "theirs"}
      className={cn("group relative flex w-full gap-2", mine ? "flex-row-reverse" : "flex-row", className)}
    >
      {!mine && <div className="w-7 shrink-0 pt-0.5">{first ? face : null}</div>}
      {actions && (
        // At the far end of the row, over the space a bubble leaves
        // there: a hover moves nothing and covers no one's words or name.
        <div className={cn("absolute -top-3 z-10", mine ? "left-0" : "right-0")}>{actions}</div>
      )}
      <div className={cn("flex min-w-0 flex-col", COLUMN, mine ? "items-end" : "items-start", rich && "w-full")}>
        {first && !mine && name && <div className="mb-1 truncate px-1 text-small font-medium text-muted-foreground">{name}</div>}
        <div className={cn("relative min-w-0 max-w-full", rich && "w-full")}>
          <div
            onPointerUp={onPointerUp}
            className={cn(
              "min-w-0 rounded-2xl text-lead [overflow-wrap:anywhere]",
              rich ? "w-full px-3.5 py-3" : "px-3.5 py-2",
              mine ? "bg-brand-ink text-brand-foreground" : "bg-muted text-foreground",
              // a run reads as one: the corners where it joins are tucked in
              mine ? [!first && "rounded-tr-md", !last && "rounded-br-md"] : [!first && "rounded-tl-md", !last && "rounded-bl-md"],
              bubbleClassName,
            )}
          >
            {bubble}
          </div>
        </div>
        {under}
        {(last || receipts) && (
          <div data-copy="skip" className={cn("mt-1 flex min-h-4 items-center gap-1.5 px-1", mine ? "flex-row-reverse" : "flex-row")}>
            {last && (
              <time dateTime={new Date(at).toISOString()} className="text-caption tabular-nums text-muted-foreground">
                {stamp(at)}
              </time>
            )}
            {receipts}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Who has read up to here: their faces, small and overlapping, and on a
 * hover or a tap, "Seen by Sam, Ana". People only: an agent shows that it
 * is working instead.
 */
export function SeenBy({ people }: { people: Array<{ id: string; name: string }> }) {
  const [open, setOpen] = useState(false);
  if (!people.length) return null;
  const line = seenLine(people.map((p) => p.name));
  const shown = people.slice(0, 4);
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={line}
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
            className="flex items-center gap-1 rounded-full outline-none"
          >
            <span className="flex -space-x-1">
              {shown.map((p) => (
                <PersonAvatar key={p.id} id={p.id} name={p.name} size={16} className="ring-2 ring-background" />
              ))}
            </span>
            {people.length > shown.length && <span className="text-caption tabular-nums text-muted-foreground">+{people.length - shown.length}</span>}
            {/* a tap where nothing hovers says it in words */}
            {open && <span className="text-caption text-muted-foreground">{line}</span>}
          </button>
        </TooltipTrigger>
        {!open && <TooltipContent side="top">{line}</TooltipContent>}
      </Tooltip>
    </TooltipProvider>
  );
}
