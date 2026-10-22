// The composer's frame, apart from what it sends to.
//
// The tray, then the box: one skinny row at rest, a button at each end
// of the words, and whatever rides with the next message (a reply, the
// files, a rehearsal) inside the box above them. Under the box, outside
// it, a compact usage status and a quiet row of what the message runs with.
// None of it knows about agents: an agent's Composer fills it in, and a room can fill in the same
// frame with its own field, its @ list and its own send, and look like the
// same app doing the same job.
import { useEffect, useRef, type ComponentProps, type DragEvent, type ReactNode, type RefObject } from "react";
import { ArrowUp } from "@/components/icons";
import { Square } from "@/components/icons";
import { cn } from "@/lib/cn";
import { useEscape } from "@/lib/useEscape";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { NoticeTray, type Notice } from "./Tray";

/**
 * Send, which becomes Stop while the agent works and the box is empty.
 *
 * One button that changes, rather than two that swap. The fill fades in
 * when there is something to send, and the arrow turns into the square
 * in place, so the eye stays on one spot and reads it as the same press
 * meaning something else now. Only transform and opacity move; colours
 * are separate layers faded over each other. A faint ring turns round
 * the button while it means Stop, which is the one sign on the box that
 * work is going on.
 */
export function SendStop({
  mode,
  onSend,
  onStop,
  sendLabel = "Send",
  stopLabel = "Stop (Esc)",
}: {
  /** idle: nothing to send. send: something to send. stop: working, and
   * nothing typed to add to it. */
  mode: "idle" | "send" | "stop";
  onSend: () => void;
  onStop?: () => void;
  sendLabel?: string;
  stopLabel?: string;
}) {
  const stop = mode === "stop";
  const filled = mode !== "idle";
  return (
    <button
      type="button"
      onClick={stop ? onStop : onSend}
      disabled={mode === "idle"}
      title={stop ? stopLabel : sendLabel}
      aria-label={stop ? "Stop" : sendLabel}
      className="relative flex size-8 shrink-0 items-center justify-center rounded-full transition-transform duration-150 ease-out active:scale-90 disabled:cursor-not-allowed disabled:active:scale-100"
    >
      <span aria-hidden className="absolute inset-0 flex items-center justify-center rounded-full bg-muted text-muted-foreground/60">
        <ArrowUp size={17} strokeWidth={2.4} />
      </span>
      <span
        aria-hidden
        className={cn(
          "absolute inset-0 rounded-full bg-primary text-primary-foreground transition-[opacity,transform] duration-200 ease-out-quart",
          filled ? "scale-100 opacity-100" : "scale-75 opacity-0",
        )}
      >
        <span
          className={cn(
            "absolute inset-0 flex items-center justify-center transition-[opacity,transform] duration-200 ease-out-quart",
            stop ? "-rotate-90 scale-50 opacity-0" : "rotate-0 scale-100 opacity-100",
          )}
        >
          <ArrowUp size={17} strokeWidth={2.4} />
        </span>
        <span
          className={cn(
            "absolute inset-0 flex items-center justify-center transition-[opacity,transform] duration-200 ease-out-quart",
            stop ? "scale-100 opacity-100" : "scale-50 opacity-0",
          )}
        >
          <Square size={11} className="fill-current" />
        </span>
      </span>
      <span
        aria-hidden
        className={cn(
          "pointer-events-none absolute -inset-[3px] rounded-full border-[1.5px] border-transparent border-t-foreground/35 transition-opacity duration-200",
          stop ? "animate-spin opacity-100 [animation-duration:1.4s] motion-reduce:animate-none" : "opacity-0",
        )}
      />
    </button>
  );
}

/** A round button in the box, the size every one of them is. `hint` is
 * a fuller line for the tooltip, for a button whose icon needs saying. */
export function BoxButton({
  children,
  onClick,
  title,
  hint,
  pressed,
  className,
  ...rest
}: {
  children: ReactNode;
  onClick?: () => void;
  title: string;
  hint?: string;
  pressed?: boolean;
  className?: string;
} & Omit<ComponentProps<"button">, "title" | "onClick" | "className" | "children">) {
  const button = (
    <button
      type="button"
      onClick={onClick}
      title={hint ? undefined : title}
      aria-label={title}
      aria-pressed={pressed}
      {...rest}
      className={cn(
        "flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-[background-color,color,transform] duration-150 ease-out hover:bg-accent hover:text-foreground active:scale-95 data-[state=open]:bg-accent data-[state=open]:text-foreground",
        pressed && "bg-brand-soft text-brand-ink hover:bg-brand-soft hover:text-brand-ink",
        className,
      )}
    >
      {children}
    </button>
  );
  if (!hint) return button;
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>{button}</TooltipTrigger>
        <TooltipContent side="top">{hint}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/**
 * A word in the row under the box that opens something: the approval
 * mode, the model, the speed. Quiet until pointed at, like the text it
 * sits among, so the row reads as a line of facts and not a toolbar.
 */
export const quietButton =
  "flex h-7 min-w-0 items-center gap-1.5 rounded-lg px-2 text-body text-muted-foreground transition-[background-color,color,transform] duration-150 ease-out hover:bg-accent hover:text-foreground active:scale-[0.98] aria-expanded:bg-accent aria-expanded:text-foreground";

/**
 * Closes a hand-made popover the way a Radix one closes: a press outside
 * it, or Escape. Escape goes through the app's one stack, so while the
 * popover is open the composer does not read the key as "stop the agent".
 * `portal` is the popover itself when it is drawn elsewhere in the page,
 * where a press on it is still a press inside.
 */
export function useDismiss(open: boolean, close: () => void, portal?: RefObject<HTMLElement | null>) {
  const ref = useRef<HTMLDivElement>(null);
  useEscape(close, open);
  const latest = useRef(close);
  latest.current = close;
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!ref.current?.contains(target) && !portal?.current?.contains(target)) latest.current();
    };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [open]);
  return ref;
}

export function ComposerShell({
  notices,
  status,
  popover,
  chips,
  children,
  lead,
  trail,
  belowStart,
  belowEnd,
  overlay,
  onDragOver,
  onDrop,
}: {
  /** What the tray says, in any order: it sorts them. */
  notices: Notice[];
  /** Usage status outside the writing box, beside its run controls. */
  status?: ReactNode;
  /** A list over the box, such as `/` or `@`. */
  popover?: ReactNode;
  /** What the next message carries besides its words. */
  chips?: ReactNode;
  /** The text field. */
  children: ReactNode;
  /** Before the words, on their last line: adding things. */
  lead?: ReactNode;
  /** After the words, on their last line: the voice and Send. */
  trail?: ReactNode;
  /** Under the box, outside it: what the message runs with. */
  belowStart?: ReactNode;
  belowEnd?: ReactNode;
  /** Drawn over the window, such as the drop target. */
  overlay?: ReactNode;
  onDragOver?: (e: DragEvent<HTMLDivElement>) => void;
  onDrop?: (e: DragEvent<HTMLDivElement>) => void;
}) {
  const tray = notices.length > 0;
  const below = Boolean(belowStart || belowEnd);
  return (
    <div className={cn("px-4 pt-1 md:px-6", below ? "pb-2 md:pb-3" : "pb-4 md:pb-5")} onDragOver={onDragOver} onDrop={onDrop}>
      {overlay}
      <div className="mx-auto max-w-[var(--transcript-width,760px)]">
        <NoticeTray notices={notices} />
        <div
          className={cn(
            "relative z-10 rounded-2xl border bg-background shadow-[0_1px_3px_var(--shadow-color)] transition-[border-color,box-shadow] duration-150",
            "focus-within:border-ring/50 focus-within:shadow-[0_4px_18px_-6px_var(--shadow-color)]",
            tray && "-mt-3",
          )}
        >
          {popover && <div className="absolute inset-x-0 bottom-full z-20 mb-2">{popover}</div>}
          {chips && <div className="flex flex-wrap gap-1.5 px-3 pt-3">{chips}</div>}
          {/* The buttons sit on the last line of the words, so a box grown
              for a long message keeps them where the thumb already is. */}
          <div className="flex items-end gap-1 p-2">
            {lead && <div className="flex shrink-0 items-center">{lead}</div>}
            <div className="min-w-0 flex-1">{children}</div>
            {trail && <div className="flex shrink-0 items-center gap-1">{trail}</div>}
          </div>
        </div>
        {status}
        {below && (
          // relative: the popovers in this row hang from it, so they line
          // up with the box's edge whichever word opened them
          <div className="relative flex min-w-0 items-center gap-1 px-1.5 pt-1.5">
            <div className="flex min-w-0 shrink items-center">{belowStart}</div>
            <div className="ml-auto flex min-w-0 items-center gap-0.5">{belowEnd}</div>
          </div>
        )}
      </div>
    </div>
  );
}
