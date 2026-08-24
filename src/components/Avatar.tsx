// Blok avatars, pixel edition: each agent is a black pixel creature on a
// colored tile with smooth white eyes, crisp bitmap silhouettes, soft
// faces. Bodies are 16×16 bitmaps merged into single SVG paths at module
// load; a dithered band along the tile's foot gives the retro texture.
import { cn } from "@/lib/cn";
import { expressionForBot, shapeForBot } from "@/lib/mascot";
import { useId } from "react";
import {
  BLOK_COLORS,
  BLOK_SHAPES,
  type BlokColor,
  type BlokExpression,
  type BlokShape,
} from "@/lib/mascot";

const INK = "#101013";
const GRID = 16;
/** The creature box inside the 100×100 tile. */
const BOX = 72;
const BOX_OFFSET = (100 - BOX) / 2;
const CELL = BOX / GRID;

// '#' = body pixel. Rows are 16 wide; keep silhouettes chunky and
// symmetric, they must read at 28px.
const BITMAPS: Record<BlokShape, { rows: string[]; faceY: number }> = {
  star: {
    rows: [
      ".......##.......",
      ".......##.......",
      "......####......",
      "......####......",
      ".....######.....",
      "....########....",
      "..############..",
      "################",
      "################",
      "..############..",
      "....########....",
      ".....######.....",
      "......####......",
      "......####......",
      ".......##.......",
      ".......##.......",
    ],
    faceY: 7.5,
  },
  burst: {
    rows: [
      ".......##.......",
      ".......##.......",
      "..#....##....#..",
      "..##.######.##..",
      "...##########...",
      "...##########...",
      "..############..",
      "################",
      "################",
      "..############..",
      "...##########...",
      "...##########...",
      "..##.######.##..",
      "..#....##....#..",
      ".......##.......",
      ".......##.......",
    ],
    faceY: 7.5,
  },
  diamond: {
    rows: [
      "................",
      ".......##.......",
      "......####......",
      ".....######.....",
      "....########....",
      "...##########...",
      "..############..",
      ".##############.",
      ".##############.",
      "..############..",
      "...##########...",
      "....########....",
      ".....######.....",
      "......####......",
      ".......##.......",
      "................",
    ],
    faceY: 7.5,
  },
  bit: {
    rows: [
      "................",
      "................",
      "................",
      "................",
      "...##########...",
      "..############..",
      ".##############.",
      ".##############.",
      ".##############.",
      ".##############.",
      "..############..",
      "...##########...",
      "................",
      "................",
      "................",
      "................",
    ],
    faceY: 7.5,
  },
  triangle: {
    rows: [
      "................",
      "................",
      "................",
      ".....######.....",
      "....########....",
      "....########....",
      "...##########...",
      "...##########...",
      "..############..",
      "..############..",
      ".##############.",
      ".##############.",
      "..############..",
      "................",
      "................",
      "................",
    ],
    faceY: 8.5,
  },
  cloud: {
    rows: [
      "................",
      "................",
      "................",
      "....#####.......",
      "...#######.###..",
      "..#############.",
      ".##############.",
      ".##############.",
      ".##############.",
      ".##############.",
      "..############..",
      "...##########...",
      "................",
      "................",
      "................",
      "................",
    ],
    faceY: 7.5,
  },
  drop: {
    rows: [
      "................",
      ".......##.......",
      ".......##.......",
      "......####......",
      "......####......",
      ".....######.....",
      "....########....",
      "...##########...",
      "..############..",
      "..############..",
      "..############..",
      "...##########...",
      "....########....",
      ".....######.....",
      "................",
      "................",
    ],
    faceY: 9.5,
  },
  invader: {
    rows: [
      "................",
      "................",
      "...#........#...",
      "....#......#....",
      "...##########...",
      "..############..",
      ".##############.",
      ".##############.",
      ".##############.",
      ".##.########.##.",
      ".##.########.##.",
      "....##....##....",
      "...##......##...",
      "................",
      "................",
      "................",
    ],
    faceY: 7,
  },
};

/** Merge a bitmap's rows into one path: each run of # becomes a rect subpath. */
function bitmapPath(rows: string[], cell: number, ox: number, oy: number): string {
  let d = "";
  rows.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      if (row[x] === "#") {
        let w = 0;
        while (row[x + w] === "#") w++;
        d += `M${(ox + x * cell).toFixed(2)} ${(oy + y * cell).toFixed(2)}h${(w * cell).toFixed(2)}v${cell.toFixed(2)}h${(-w * cell).toFixed(2)}Z`;
        x += w;
      } else x++;
    }
  });
  return d;
}

const BODIES: Record<BlokShape, { d: string; faceY: number }> = Object.fromEntries(
  BLOK_SHAPES.map((shape) => {
    const spec = BITMAPS[shape];
    return [
      shape,
      {
        d: bitmapPath(spec.rows, CELL, BOX_OFFSET, BOX_OFFSET),
        // face glyphs are drawn relative to the tile center (50,50)
        faceY: BOX_OFFSET + spec.faceY * CELL - 50,
      },
    ];
  }),
) as Record<BlokShape, { d: string; faceY: number }>;

/** Checkerboard cells along the tile's foot, the dither band. */
const DITHER_CELLS: Array<{ x: number; y: number }> = (() => {
  const cells: Array<{ x: number; y: number }> = [];
  const n = 20;
  for (let y = 17; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if ((x + y) % 2 === 0 && (y > 17 || x % 4 < 2)) cells.push({ x, y });
    }
  }
  return cells;
})();

function mix(hex: string, target: string, amount: number): string {
  const a = parseInt(hex.slice(1), 16);
  const b = parseInt(target.slice(1), 16);
  const channel = (shift: number) => {
    const from = (a >> shift) & 0xff;
    const to = (b >> shift) & 0xff;
    return Math.round(from + (to - from) * amount);
  };
  return `#${((channel(16) << 16) | (channel(8) << 8) | channel(0))
    .toString(16)
    .padStart(6, "0")}`;
}

/** Smooth white eyes on the pixel body, the contrast is the charm. */
function Face({ expression, fy }: { expression: BlokExpression; fy: number }) {
  const stroke = {
    fill: "none",
    stroke: "#fff",
    strokeWidth: 3.4,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  const eye = (x: number, tilt = 0, dy = 0) => (
    <ellipse
      cx={x}
      cy={fy - 3 + dy}
      rx="4"
      ry="6.5"
      fill="#fff"
      transform={tilt ? `rotate(${tilt} ${x} ${fy - 3 + dy})` : undefined}
    />
  );

  switch (expression) {
    case "deadpan":
      return (
        <>
          {eye(-8)}
          {eye(8)}
        </>
      );
    case "friendly":
      return (
        <>
          {eye(-8, -8)}
          {eye(8, 8)}
          <path d={`M-6 ${fy + 8} Q0 ${fy + 12} 6 ${fy + 8}`} {...stroke} />
        </>
      );
    case "focused":
      return (
        <>
          <path
            d={`M-13 ${fy - 3} H-4 M4 ${fy - 3} H13 M-5 ${fy + 8} H5`}
            {...stroke}
          />
        </>
      );
    case "thinking":
      return (
        <>
          {eye(-8, 12, -1.5)}
          {eye(8, -12, -1.5)}
          <path d={`M-5 ${fy + 9} L6 ${fy + 6}`} {...stroke} />
        </>
      );
    case "excited":
      return (
        <>
          <path
            d={`M-12 ${fy - 2} Q-8 ${fy - 8.5} -4 ${fy - 2} M4 ${fy - 2} Q8 ${fy - 8.5} 12 ${fy - 2}`}
            {...stroke}
          />
          <path d={`M-7 ${fy + 5} Q0 ${fy + 13} 7 ${fy + 5} Q0 ${fy + 8} -7 ${fy + 5} Z`} fill="#fff" />
        </>
      );
    case "sleepy":
      return (
        <>
          <path
            d={`M-12 ${fy - 4} Q-8 ${fy} -4 ${fy - 4} M4 ${fy - 4} Q8 ${fy} 12 ${fy - 4}`}
            {...stroke}
          />
          <ellipse cx="0" cy={fy + 8} rx="2.6" ry="3.2" fill="#fff" />
        </>
      );
    case "surprised":
      return (
        <>
          <circle cx="-8" cy={fy - 3} r="4.6" fill="#fff" />
          <circle cx="8" cy={fy - 3} r="4.6" fill="#fff" />
          <circle cx="0" cy={fy + 8} r="3.4" fill="#fff" />
        </>
      );
    case "skeptical":
      return (
        <>
          <path d={`M-13 ${fy - 6} L-4 ${fy - 4}`} {...stroke} />
          {eye(8, 0, -1)}
          <path d={`M-6 ${fy + 9} Q0 ${fy + 6} 6 ${fy + 9}`} {...stroke} />
        </>
      );
    case "worried":
      return (
        <>
          <path
            d={`M-12 ${fy - 2} Q-8 ${fy - 7} -4 ${fy - 2} M4 ${fy - 2} Q8 ${fy - 7} 12 ${fy - 2}`}
            {...stroke}
          />
          <path d={`M-6 ${fy + 11} Q0 ${fy + 6} 6 ${fy + 11}`} {...stroke} />
        </>
      );
    case "mischievous":
      return (
        <>
          <path d={`M-13 ${fy - 8} L-4 ${fy - 4} M13 ${fy - 8} L4 ${fy - 4}`} {...stroke} />
          <path d={`M-7 ${fy + 6} Q1 ${fy + 12} 8 ${fy + 4} Q1 ${fy + 8} -7 ${fy + 6} Z`} fill="#fff" />
        </>
      );
  }
}

export function BlokAvatar({
  color,
  shape = "star",
  expression = "deadpan",
  size = 40,
  label,
  className,
}: {
  color: BlokColor;
  shape?: BlokShape;
  expression?: BlokExpression;
  size?: number;
  label?: string;
  className?: string;
}) {
  const uid = useId();
  const base = BLOK_COLORS[color] ?? BLOK_COLORS.green;
  const deep = mix(base, "#000000", 0.22);
  const body = BODIES[shape] ?? BODIES.star;
  const clipId = `${uid}c`;
  const dcell = 5;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      className={className ? `shrink-0 ${className}` : "shrink-0"}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <defs>
        <clipPath id={clipId}>
          <rect width="100" height="100" rx="24" />
        </clipPath>
      </defs>
      <g clipPath={`url(#${clipId})`}>
        <rect width="100" height="100" fill={base} />
        <g fill={deep}>
          {DITHER_CELLS.map(({ x, y }) => (
            <rect key={`${x}-${y}`} x={x * dcell} y={y * dcell} width={dcell} height={dcell} />
          ))}
        </g>
      </g>
      <path d={body.d} fill={INK} shapeRendering="crispEdges" />
      <g transform="translate(50 50)">
        <Face expression={expression} fy={body.faceY} />
      </g>
    </svg>
  );
}

/** The creature silhouette alone (no tile), brand marks, empty states. */
export function CreatureMark({
  shape = "star",
  size = 24,
  fill = "currentColor",
  className,
}: {
  shape?: BlokShape;
  size?: number;
  fill?: string;
  className?: string;
}) {
  const body = BODIES[shape] ?? BODIES.star;
  return (
    <svg width={size} height={size} viewBox="14 14 72 72" className={className} aria-hidden>
      <path d={body.d} fill={fill} shapeRendering="crispEdges" />
    </svg>
  );
}

export function InitialsAvatar({
  initials,
  size = 32,
}: {
  initials: string;
  size?: number;
}) {
  return (
    <div
      className="flex shrink-0 items-center justify-center rounded-full bg-secondary font-medium text-muted-foreground"
      style={{ width: size, height: size, fontSize: size * 0.38 }}
    >
      {initials}
    </div>
  );
}


/** The face everything renders: the uploaded photo when there is one,
 * the pixel identity otherwise. Callers pass the whole bot so this stays
 * the single place that knows a photo can exist at all. */
export function AgentAvatar({
  bot,
  size,
  className,
}: {
  bot: { id: string; color: BlokColor; avatarAt?: number | null } & Parameters<typeof shapeForBot>[0];
  size: number;
  className?: string;
}) {
  if (bot.avatarAt) {
    return (
      <img
        src={`/api/bots/${bot.id}/avatar?v=${bot.avatarAt}`}
        width={size}
        height={size}
        alt=""
        className={cn("shrink-0 rounded-full object-cover", className)}
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <BlokAvatar
      color={bot.color}
      shape={shapeForBot(bot)}
      expression={expressionForBot(bot)}
      size={size}
      className={className}
    />
  );
}
