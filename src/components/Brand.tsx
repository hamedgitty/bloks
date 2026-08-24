import { CreatureMark } from "./Avatar";
import { cn } from "@/lib/cn";

/**
 * The Bloks mark: two interlocking pinwheels, every block its own color.
 * Geometry and palette lifted 1:1 from the brand file
 * (public/brand/bloks-mark.svg), don't eyeball-edit these rects.
 * Pass `fill` for a single-color version in subdued contexts.
 */
const MARK_BLOCKS: Array<{ x: number; y: number; w: number; h: number; c: string }> = [
  { x: 0, y: 0, w: 279, h: 1147, c: "#004aad" },
  { x: 334, y: 0, w: 937, h: 279, c: "#ff751f" },
  { x: 992, y: 335, w: 279, h: 1147, c: "#cb6ce6" },
  { x: 0, y: 1203, w: 937, h: 279, c: "#ff3131" },
  { x: 320, y: 381, w: 136, h: 557, c: "#5ce1e6" },
  { x: 482, y: 381, w: 455, h: 136, c: "#ff5757" },
  { x: 801, y: 544, w: 136, h: 557, c: "#7ed957" },
  { x: 320, y: 965, w: 455, h: 136, c: "#ffbd59" },
];

export function BloksMark({
  size = 32,
  fill,
  className,
}: {
  size?: number;
  /** Single-color override; omit for the full-color brand mark. */
  fill?: string;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 1272 1483"
      role="img"
      aria-label="Bloks"
      className={cn("shrink-0", className)}
    >
      {MARK_BLOCKS.map((b, i) => (
        <rect key={i} x={b.x} y={b.y} width={b.w} height={b.h} fill={fill ?? b.c} />
      ))}
    </svg>
  );
}

/** A pixel sparkle: five squares in a plus. */
function Sparkle({ size, color }: { size: number; color: string }) {
  const c = size / 3;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
      <g fill={color}>
        <rect x={c} y={0} width={c} height={c} />
        <rect x={0} y={c} width={c} height={c} />
        <rect x={c * 2} y={c} width={c} height={c} />
        <rect x={c} y={c * 2} width={c} height={c} />
      </g>
    </svg>
  );
}

/**
 * Decorative pixel weather behind full-screen moments (onboarding, new
 * agent): stepped clouds, sparkles, stray blocks. Pointer-transparent.
 */
export function BlockField() {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 overflow-hidden opacity-[0.16] dark:opacity-[0.14]"
    >
      <CreatureMark
        shape="cloud"
        size={110}
        fill="#3fc3f0"
        className="absolute left-[7%] top-[13%]"
      />
      <CreatureMark
        shape="cloud"
        size={72}
        fill="#a468f7"
        className="absolute right-[9%] top-[24%]"
      />
      <CreatureMark
        shape="drop"
        size={46}
        fill="#2ec9a9"
        className="absolute left-[22%] bottom-[24%]"
      />
      <div className="absolute left-[15%] top-[58%]">
        <Sparkle size={21} color="#f972b6" />
      </div>
      <div className="absolute right-[18%] top-[64%]">
        <Sparkle size={27} color="#ffd93b" />
      </div>
      <div className="absolute right-[28%] top-[10%]">
        <Sparkle size={15} color="#3bc76b" />
      </div>
      <div className="absolute left-[36%] bottom-[12%]">
        <Sparkle size={18} color="#4c86f5" />
      </div>
      <div className="absolute right-[7%] bottom-[18%] size-[22px] bg-[#ff9432]" />
      <div className="absolute left-[9%] bottom-[38%] size-[13px] bg-[#f04438]" />
    </div>
  );
}

/** The full wordmark from the brand file, swapped per theme. */
export function BloksLogo({
  compact = false,
  className = "h-12",
}: {
  compact?: boolean;
  className?: string;
}) {
  if (compact) return <BloksMark size={28} />;
  return (
    <>
      <img
        src="/brand/bloks-wordmark-light.png"
        alt="Bloks"
        className={`${className} w-auto dark:hidden`}
      />
      <img
        src="/brand/bloks-wordmark-dark.png"
        alt="Bloks"
        className={`hidden ${className} w-auto dark:block`}
      />
    </>
  );
}
