// A row of mutually exclusive choices, with the selection sliding to the
// one picked rather than blinking there.
//
// The slide is the point: it says "this replaced that" in the one place
// the eye is already looking. It is a shared layout animation keyed per
// instance, so two controls on one page never trade indicators.
//
// Never wider than where it sits: on a phone a long row (an engine's six
// effort levels) scrolls sideways instead of running past a card's edge,
// where the last choices were cut off and could not be picked. The side
// with more beyond it fades, so a row cut short does not read as whole.
import { useEffect, useId, useRef, useState } from "react";
import { motion } from "motion/react";
import { cn } from "@/lib/cn";

export interface SegmentedOption<T extends string | undefined> {
  value: T;
  label: React.ReactNode;
  /** For an icon-only or abbreviated label. */
  title?: string;
  /** Shown, and not to be chosen: what it needs is said beside it. */
  disabled?: boolean;
}

export function Segmented<T extends string | undefined>({
  value,
  options,
  onChange,
  className,
  size = "md",
  "aria-label": ariaLabel,
}: {
  value: T;
  options: Array<SegmentedOption<T>>;
  onChange: (value: T) => void;
  className?: string;
  size?: "sm" | "md";
  "aria-label"?: string;
}) {
  const id = useId();
  const row = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState({ before: false, after: false });
  useEffect(() => {
    const el = row.current;
    if (!el) return;
    const look = () => {
      const before = el.scrollLeft > 1;
      const after = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
      setMore((was) => (was.before === before && was.after === after ? was : { before, after }));
    };
    look();
    const sized = new ResizeObserver(look);
    sized.observe(el);
    el.addEventListener("scroll", look, { passive: true });
    return () => {
      sized.disconnect();
      el.removeEventListener("scroll", look);
    };
  }, []);
  // the picked one in view, so a choice past the edge is not hidden; the
  // row scrolls itself, never the page around it
  useEffect(() => {
    const el = row.current;
    const picked = el?.querySelector<HTMLElement>('[aria-checked="true"]');
    if (!el || !picked) return;
    const start = picked.getBoundingClientRect().left - el.getBoundingClientRect().left + el.scrollLeft;
    if (start < el.scrollLeft) el.scrollLeft = start - 4;
    else if (start + picked.offsetWidth > el.scrollLeft + el.clientWidth) el.scrollLeft = start + picked.offsetWidth - el.clientWidth + 4;
  }, [value]);
  const fade =
    more.before && more.after
      ? "[mask-image:linear-gradient(to_right,transparent,black_24px,black_calc(100%-24px),transparent)]"
      : more.after
        ? "[mask-image:linear-gradient(to_right,black_calc(100%-24px),transparent)]"
        : more.before
          ? "[mask-image:linear-gradient(to_right,transparent,black_24px)]"
          : null;
  return (
    <div
      ref={row}
      role="radiogroup"
      aria-label={ariaLabel}
      className={cn("flex max-w-full gap-0.5 overflow-x-auto rounded-[10px] bg-muted p-0.5 [scrollbar-width:none]", fade, className)}
    >
      {options.map((option) => {
        const on = option.value === value;
        return (
          <button
            key={String(option.value ?? "default")}
            type="button"
            role="radio"
            aria-checked={on}
            aria-disabled={option.disabled || undefined}
            disabled={option.disabled}
            title={option.title}
            onClick={() => onChange(option.value)}
            className={cn(
              "relative flex flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg font-medium outline-none transition-colors duration-150",
              size === "sm" ? "px-2.5 py-1 text-small" : "px-3 py-1.5 text-body",
              on ? "text-foreground" : "text-muted-foreground hover:text-foreground",
              option.disabled && "cursor-not-allowed opacity-50 hover:text-muted-foreground",
            )}
          >
            {on && (
              <motion.span
                layoutId={`segment-${id}`}
                transition={{ type: "spring", duration: 0.25, bounce: 0 }}
                className="absolute inset-0 rounded-lg bg-background shadow-[0_1px_2px_rgba(0,0,0,0.06),0_0_0_0.5px_rgba(0,0,0,0.06)] dark:shadow-[0_0_0_0.5px_rgba(255,255,255,0.08)]"
              />
            )}
            <span className="relative flex items-center gap-1.5">{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}
