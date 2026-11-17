// A slim rail along the conversation's right edge, one tick a turn
// (GitHub 521, the rules in src/lib/turnTimeline.ts).
//
// The tick of the turn being read is solid and the rest are faint, so the
// rail says where you are in a long conversation at a glance. A pointer on
// it shows the nearest turn: who started it, when, its first line and what
// its work came to. A click goes there, through the conversation's own
// landing (the history it needs is drawn, the fold holding it opened, the
// message lit for a moment), so the scrubber and the palette arrive the
// same way. The way back to the end is the pill that was already there.
//
// One stop in the tab order, a slider: the arrow keys step a turn, the
// page keys ten, Home and End the first and the last, and each step goes
// there. A thousand turns are still one thing to tab past.
//
// Nothing moves on its own beyond the ticks' colour following the reading.
// The card comes and goes without travelling, which reduced motion keeps.
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { cn } from "@/lib/cn";
import { stamp } from "@/lib/when";
import { t } from "@/lib/i18n";
import {
  drawsTick,
  placeOf,
  railLayout,
  readingTurn,
  stepTurn,
  turnAtHeight,
  type TurnMark,
} from "@/lib/turnTimeline";

/** Where the reading line sits in the view, from its top: a turn counts as
 * being read once its start is above this. */
const READING_LINE = 0.3;
/** The fewest turns worth a rail: with one there is nowhere to go. */
const FEWEST = 2;

export function TurnTimeline({
  marks,
  scroller,
  rowOf,
  onJump,
  authorOf,
  tick,
  className,
}: {
  marks: readonly TurnMark[];
  scroller: RefObject<HTMLDivElement | null>;
  /** The row a turn's message is drawn in, when it is drawn. */
  rowOf: (id: string) => string;
  onJump: (mark: TurnMark) => void;
  /** Who started a turn, as the conversation names them. */
  authorOf: (mark: TurnMark) => string;
  /** Changes whenever the conversation's rows may have moved. */
  tick: unknown;
  className?: string;
}) {
  const [rail, setRail] = useState<HTMLDivElement | null>(null);
  const [height, setHeight] = useState(0);
  const [reading, setReading] = useState(-1);
  const [pointing, setPointing] = useState<number | null>(null);
  const [focused, setFocused] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const cardId = useId();
  const count = marks.length;
  const layout = railLayout(count, height);

  useLayoutEffect(() => {
    if (!rail) return;
    const measure = () => setHeight(rail.clientHeight);
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(rail);
    return () => watch.disconnect();
  }, [rail]);

  // Which turn is being read, worked out at most once a frame as the
  // conversation scrolls or changes. Only drawn rows are asked about.
  const marksRef = useRef(marks);
  marksRef.current = marks;
  const measure = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    setOverflows(el.scrollHeight > el.clientHeight + 24);
    const box = el.getBoundingClientRect();
    const list = marksRef.current;
    const at = readingTurn(
      list.length,
      (i) => {
        const row = el.querySelector(rowOf(list[i].id));
        return row ? row.getBoundingClientRect().top - box.top + el.scrollTop : null;
      },
      el.scrollTop + el.clientHeight * READING_LINE,
    );
    // at the very end, the last turn is the one being read, however short
    const atEnd = el.scrollHeight - el.scrollTop - el.clientHeight < 4;
    setReading(atEnd ? list.length - 1 : at);
  }, [scroller, rowOf]);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    let frame = 0;
    const soon = () => {
      if (!frame) frame = requestAnimationFrame(() => ((frame = 0), measure()));
    };
    soon();
    el.addEventListener("scroll", soon, { passive: true });
    const watch = new ResizeObserver(soon);
    watch.observe(el);
    return () => {
      el.removeEventListener("scroll", soon);
      watch.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [scroller, measure]);
  useEffect(() => {
    const frame = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(frame);
  }, [tick, count, measure]);

  if (count < FEWEST || !overflows) return null;

  const shown = pointing ?? (focused ? reading : null);
  const mark = shown !== null ? marks[shown] : null;
  const jump = (index: number) => {
    const target = marks[index];
    if (!target) return;
    setReading(index);
    onJump(target);
  };
  const valueText = (index: number) => {
    const m = marks[index];
    if (!m) return "";
    return t("turnTimeline.valueText", { at: index + 1, total: count, who: authorOf(m), line: m.line || t("turnTimeline.noWords") });
  };

  return (
    <div className={cn("pointer-events-none absolute bottom-14 right-1 top-3 z-10 hidden w-5 md:block", className)}>
      <div
        ref={setRail}
        role="slider"
        tabIndex={0}
        aria-label={t("turnTimeline.label")}
        aria-orientation="vertical"
        aria-valuemin={1}
        aria-valuemax={count}
        aria-valuenow={Math.max(0, reading) + 1}
        aria-valuetext={valueText(Math.max(0, reading))}
        aria-describedby={mark ? cardId : undefined}
        onPointerMove={(e) => {
          const box = e.currentTarget.getBoundingClientRect();
          setPointing(turnAtHeight(layout, count, e.clientY - box.top));
        }}
        onPointerLeave={() => setPointing(null)}
        onClick={(e) => {
          const box = e.currentTarget.getBoundingClientRect();
          jump(turnAtHeight(layout, count, e.clientY - box.top));
        }}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            jump(Math.max(0, reading));
            return;
          }
          const next = stepTurn(e.key, reading, count);
          if (next === null) return;
          e.preventDefault();
          jump(next);
        }}
        className="group/rail pointer-events-auto relative h-full w-full cursor-pointer rounded-full outline-none focus-visible:shadow-[0_0_0_2px_var(--ring)]"
      >
        {marks.map((m, i) =>
          drawsTick(layout, count, i, reading) ? (
            <span
              key={m.id}
              aria-hidden
              className={cn(
                "absolute right-1 h-[2px] -translate-y-1/2 rounded-full transition-[width,background-color] duration-150 ease-out motion-reduce:transition-none",
                i === reading
                  ? "w-3 bg-foreground/70"
                  : i === pointing
                    ? "w-3 bg-foreground/45"
                    : "w-2 bg-muted-foreground/30 group-hover/rail:w-2.5",
              )}
              style={{ top: placeOf(layout, i) }}
            />
          ) : null,
        )}
      </div>
      {mark && shown !== null && (
        <TurnCard
          id={cardId}
          mark={mark}
          index={shown}
          count={count}
          author={authorOf(mark)}
          top={Math.min(Math.max(0, placeOf(layout, shown) - 18), Math.max(0, height - 92))}
        />
      )}
    </div>
  );
}

function TurnCard({
  id,
  mark,
  index,
  count,
  author,
  top,
}: {
  id: string;
  mark: TurnMark;
  index: number;
  count: number;
  author: string;
  top: number;
}) {
  return (
    <div
      id={id}
      role="tooltip"
      className="pointer-events-none absolute right-6 w-[min(280px,60vw)] rounded-xl border bg-popover px-3 py-2 text-popover-foreground shadow-[0_8px_24px_-12px_var(--shadow-color)]"
      style={{ top }}
    >
      <div className="flex items-baseline gap-1.5 text-caption text-muted-foreground">
        <span className="tabular-nums">{t("turnTimeline.turnOf", { at: index + 1, total: count })}</span>
        {mark.at > 0 && (
          <>
            <span aria-hidden>·</span>
            <span className="tabular-nums">{stamp(mark.at)}</span>
          </>
        )}
      </div>
      <div className="mt-0.5 truncate text-small font-medium text-foreground">{author}</div>
      <div className="mt-0.5 line-clamp-2 text-small text-foreground/90">{mark.line || t("turnTimeline.noWords")}</div>
      {mark.work && <div className="mt-1 truncate text-caption text-muted-foreground">{mark.work}</div>}
    </div>
  );
}
