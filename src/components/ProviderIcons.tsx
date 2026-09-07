// Provider brand marks, keyed by driver kind. Monochrome marks use
// currentColor/fill-foreground so they read in both themes.
import Monitor from "lucide-react/dist/esm/icons/monitor.mjs";
import { cn } from "@/lib/cn";

export interface IconProps {
  size?: number;
  className?: string;
}

export function GrokMark({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={cn("fill-foreground", className)}>
      <path d="M9.26905 15.284L17.2479 9.36086C17.6391 9.07047 18.1981 9.18374 18.3845 9.63478C19.3655 12.0135 18.9272 14.8721 16.9755 16.8349C15.0238 18.7976 12.3082 19.228 9.8261 18.2477L7.1146 19.5102C11.0037 22.1834 15.7263 21.5223 18.6774 18.5525C21.0182 16.1985 21.7432 12.9897 21.0653 10.0961L21.0714 10.1023C20.0884 5.85143 21.3131 4.15233 23.8218 0.677913C23.8812 0.595532 23.9406 0.513151 24 0.428711L20.6987 3.74866V3.73836L9.267 15.2861" />
      <path d="M7.62249 16.7237C4.83113 14.0422 5.3124 9.89222 7.69417 7.49905C9.45541 5.72786 12.341 5.00497 14.86 6.06768L17.5653 4.81138C17.0779 4.45714 16.4533 4.07613 15.7365 3.80839C12.4966 2.46764 8.6178 3.13492 5.98413 5.78141C3.45081 8.32904 2.65415 12.2463 4.02219 15.5889C5.04412 18.0871 3.36889 19.8541 1.68137 21.6377C1.08337 22.2699 0.483318 22.9022 0 23.5716L7.62045 16.7257" />
    </svg>
  );
}

/** The Grok CLI. The app tile, while the API engine keeps the bare
 * swoosh: same brand, two different things to click. */
export function GrokCliMark({ size = 16, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 512 509.641"
      shapeRendering="geometricPrecision"
      textRendering="geometricPrecision"
      imageRendering="optimizeQuality"
      fillRule="evenodd"
      clipRule="evenodd"
      className={cn(className)}
    >
      <path d="M115.612 0h280.776C459.975 0 512 52.026 512 115.612v278.416c0 63.587-52.025 115.613-115.612 115.613H115.612C52.026 509.641 0 457.615 0 394.028V115.612C0 52.026 52.026 0 115.612 0z" fill="#000" />
      <path
        fill="#fff"
        d="M213.235 306.019l178.976-180.002v.169l51.695-51.763c-.924 1.32-1.86 2.605-2.785 3.89-39.281 54.164-58.46 80.649-43.07 146.922l-.09-.101c10.61 45.11-.744 95.137-37.398 131.836-46.216 46.306-120.167 56.611-181.063 14.928l42.462-19.675c38.863 15.278 81.392 8.57 111.947-22.03 30.566-30.6 37.432-75.159 22.065-112.252-2.92-7.025-11.67-8.795-17.792-4.263l-124.947 92.341zm-25.786 22.437l-.033.034L68.094 435.217c7.565-10.429 16.957-20.294 26.327-30.149 26.428-27.803 52.653-55.359 36.654-94.302-21.422-52.112-8.952-113.177 30.724-152.898 41.243-41.254 101.98-51.661 152.706-30.758 11.23 4.172 21.016 10.114 28.638 15.639l-42.359 19.584c-39.44-16.563-84.629-5.299-112.207 22.313-37.298 37.308-44.84 102.003-1.128 143.81z"
      />
    </svg>
  );
}

export function ClaudeMark({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 256 257" preserveAspectRatio="xMidYMid" className={cn("fill-[#d97757]", className)}>
      <path d="m50.228 170.321 50.357-28.257.843-2.463-.843-1.361h-2.462l-8.426-.518-28.775-.778-24.952-1.037-24.175-1.296-6.092-1.297L0 125.796l.583-3.759 5.12-3.434 7.324.648 16.202 1.101 24.304 1.685 17.629 1.037 26.118 2.722h4.148l.583-1.685-1.426-1.037-1.101-1.037-25.147-17.045-27.22-18.017-14.258-10.37-7.713-5.25-3.888-4.925-1.685-10.758 7-7.713 9.397.649 2.398.648 9.527 7.323 20.35 15.75L94.817 91.9l3.889 3.24 1.555-1.102.195-.777-1.75-2.917-14.453-26.118-15.425-26.572-6.87-11.018-1.814-6.61c-.648-2.723-1.102-4.991-1.102-7.778l7.972-10.823L71.42 0 82.05 1.426l4.472 3.888 6.61 15.101 10.694 23.786 16.591 32.34 4.861 9.592 2.592 8.879.973 2.722h1.685v-1.556l1.36-18.211 2.528-22.36 2.463-28.776.843-8.1 4.018-9.722 7.971-5.25 6.222 2.981 5.12 7.324-.713 4.73-3.046 19.768-5.962 30.98-3.889 20.739h2.268l2.593-2.593 10.499-13.934 17.628-22.036 7.778-8.749 9.073-9.657 5.833-4.601h11.018l8.1 12.055-3.628 12.443-11.342 14.388-9.398 12.184-13.48 18.147-8.426 14.518.778 1.166 2.01-.194 30.46-6.481 16.462-2.982 19.637-3.37 8.88 4.148.971 4.213-3.5 8.62-20.998 5.184-24.628 4.926-36.682 8.685-.454.324.519.648 16.526 1.555 7.065.389h17.304l32.21 2.398 8.426 5.574 5.055 6.805-.843 5.184-12.962 6.611-17.498-4.148-40.83-9.721-14-3.5h-1.944v1.167l11.666 11.406 21.387 19.314 26.767 24.887 1.36 6.157-3.434 4.86-3.63-.518-23.526-17.693-9.073-7.972-20.545-17.304h-1.36v1.814l4.73 6.935 25.017 37.59 1.296 11.536-1.814 3.76-6.481 2.268-7.13-1.297-14.647-20.544-15.1-23.138-12.185-20.739-1.49.843-7.194 77.448-3.37 3.953-7.778 2.981-6.48-4.925-3.436-7.972 3.435-15.749 4.148-20.544 3.37-16.333 3.046-20.285 1.815-6.74-.13-.454-1.49.194-15.295 20.999-23.267 31.433-18.406 19.702-4.407 1.75-7.648-3.954.713-7.064 4.277-6.286 25.47-32.405 15.36-20.092 9.917-11.6-.065-1.686h-.583L44.07 198.125l-12.055 1.555-5.185-4.86.648-7.972 2.463-2.593 20.35-13.999-.064.065Z" />
    </svg>
  );
}

export function CodexMark({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 256 260" preserveAspectRatio="xMidYMid" className={cn("fill-foreground", className)}>
      <path d="M239.184 106.203a64.716 64.716 0 0 0-5.576-53.103C219.452 28.459 191 15.784 163.213 21.74A65.586 65.586 0 0 0 52.096 45.22a64.716 64.716 0 0 0-43.23 31.36c-14.31 24.602-11.061 55.634 8.033 76.74a64.665 64.665 0 0 0 5.525 53.102c14.174 24.65 42.644 37.324 70.446 31.36a64.72 64.72 0 0 0 48.754 21.744c28.481.025 53.714-18.361 62.414-45.481a64.767 64.767 0 0 0 43.229-31.36c14.137-24.558 10.875-55.423-8.083-76.483Zm-97.56 136.338a48.397 48.397 0 0 1-31.105-11.255l1.535-.87 51.67-29.825a8.595 8.595 0 0 0 4.247-7.367v-72.85l21.845 12.636c.218.111.37.32.409.563v60.367c-.056 26.818-21.783 48.545-48.601 48.601Zm-104.466-44.61a48.345 48.345 0 0 1-5.781-32.589l1.534.921 51.722 29.826a8.339 8.339 0 0 0 8.441 0l63.181-36.425v25.221a.87.87 0 0 1-.358.665l-52.335 30.184c-23.257 13.398-52.97 5.431-66.404-17.803ZM23.549 85.38a48.499 48.499 0 0 1 25.58-21.333v61.39a8.288 8.288 0 0 0 4.195 7.316l62.874 36.272-21.845 12.636a.819.819 0 0 1-.767 0L41.353 151.53c-23.211-13.454-31.171-43.144-17.804-66.405v.256Zm179.466 41.695-63.08-36.63L161.73 77.86a.819.819 0 0 1 .768 0l52.233 30.184a48.6 48.6 0 0 1-7.316 87.635v-61.391a8.544 8.544 0 0 0-4.4-7.213Zm21.742-32.69-1.535-.922-51.619-30.081a8.39 8.39 0 0 0-8.492 0L99.98 99.808V74.587a.716.716 0 0 1 .307-.665l52.233-30.133a48.652 48.652 0 0 1 72.236 50.391v.205ZM88.061 139.097l-21.845-12.585a.87.87 0 0 1-.41-.614V65.685a48.652 48.652 0 0 1 79.757-37.346l-1.535.87-51.67 29.825a8.595 8.595 0 0 0-4.246 7.367l-.051 72.697Zm11.868-25.58 28.138-16.217 28.188 16.218v32.434l-28.086 16.218-28.188-16.218-.052-32.434Z" />
    </svg>
  );
}

export function ComputerMark({ size = 16, className }: IconProps) {
  return <Monitor size={size} className={cn("text-muted-foreground", className)} />;
}

export function GeminiMark({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={cn("fill-[#3186ff]", className)}>
      <path d="M12 24A14.3 14.3 0 0 0 0 12 14.3 14.3 0 0 0 12 0a14.3 14.3 0 0 0 12 12 14.3 14.3 0 0 0-12 12Z" />
    </svg>
  );
}

/** The Gemini CLI. The same spark, over a prompt caret, because in the
 * rail it sits next to plain Gemini and they are not the same engine. */
export function GeminiCliMark({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={cn(className)}>
      <path
        d="M14.5 13a9.5 9.5 0 0 0 8-8 9.5 9.5 0 0 0 8 8 9.5 9.5 0 0 0-8 8 9.5 9.5 0 0 0-8-8Z"
        transform="translate(-8 -3.5) scale(0.86)"
        className="fill-[#3186ff]"
      />
      <path
        d="M3 15.5 5.5 18 3 20.5M8 20.5h5"
        fill="none"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="stroke-foreground"
      />
    </svg>
  );
}

/** Moonshot's Kimi. A crescent, which is what the name means. */
export function KimiMark({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={cn("fill-foreground", className)}>
      <path d="M12 1a11 11 0 1 0 8.5 18A9 9 0 0 1 9.7 4.4 11 11 0 0 1 12 1Z" />
      <circle cx="17.5" cy="6.5" r="2.6" />
    </svg>
  );
}

/** Meta's Llama. An infinity loop, drawn as two rings. */
export function LlamaMark({ size = 16, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      strokeWidth="2.1"
      className={cn("stroke-[#0064e0]", className)}
    >
      <circle cx="7" cy="12" r="4.6" />
      <circle cx="17" cy="12" r="4.6" />
    </svg>
  );
}

/** OpenRouter routes between labs, so: a junction. */
export function RouterMark({ size = 16, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      strokeWidth="2"
      strokeLinecap="round"
      className={cn("stroke-foreground", className)}
    >
      <path d="M2 12h5l4-5h5" />
      <path d="M11 17h5" />
      <circle cx="19" cy="7" r="2.4" fill="currentColor" stroke="none" />
      <circle cx="19" cy="17" r="2.4" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** A generic mark for engines without a drawn one: the first letter in a
 * tile, which reads better in the rail than two grey characters. */
function LetterMark({ letter, tone, size = 16, className }: IconProps & { letter: string; tone: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={cn(className)}>
      <rect width="24" height="24" rx="6" fill={tone} />
      <text
        x="12"
        y="16.5"
        textAnchor="middle"
        fontSize="13"
        fontWeight="600"
        fill="#fff"
        fontFamily="Inter, system-ui, sans-serif"
      >
        {letter}
      </text>
    </svg>
  );
}

/** Pi. Their wordmark, on the dark tile the press kit shows it on,
 * because the white paths vanish on a light rail. */
export function PiMark({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 800 800" className={cn(className)}>
      <rect width="800" height="800" rx="150" fill="#09090b" />
      <path
        fill="#fff"
        fillRule="evenodd"
        d="M165.29 165.29H517.36V400H400V517.36H282.65V634.72H165.29ZM282.65 282.65V400H400V282.65Z"
      />
      <path fill="#fff" d="M517.36 400H634.72V634.72H517.36Z" />
    </svg>
  );
}

const LETTERED: Record<string, { letter: string; tone: string }> = {
  deepseek: { letter: "D", tone: "#4d6bfe" },
  mistral: { letter: "M", tone: "#fa520f" },
  groq: { letter: "G", tone: "#f55036" },
  ollama: { letter: "O", tone: "#6b7280" },
  custom: { letter: "C", tone: "#6b7280" },
};

export function ProviderMark({ driverKind, size, className }: IconProps & { driverKind: string }) {
  switch (driverKind) {
    case "grok":
      return <GrokMark size={size} className={className} />;
    case "grokCli":
      return <GrokCliMark size={size} className={className} />;
    case "claudeAgent":
      return <ClaudeMark size={size} className={className} />;
    case "codex":
      return <CodexMark size={size} className={className} />;
    case "boxAgent":
      return <ComputerMark size={size} className={className} />;
    case "gemini":
      return <GeminiMark size={size} className={className} />;
    case "geminiCli":
      return <GeminiCliMark size={size} className={className} />;
    case "kimi":
      return <KimiMark size={size} className={className} />;
    case "llama":
      return <LlamaMark size={size} className={className} />;
    case "openrouter":
      return <RouterMark size={size} className={className} />;
    case "pi":
      return <PiMark size={size} className={className} />;
  }
  const lettered = LETTERED[driverKind];
  if (lettered) return <LetterMark {...lettered} size={size} className={className} />;
  return (
    <span className="text-[11px] font-semibold text-muted-foreground">
      {driverKind.slice(0, 2).toUpperCase()}
    </span>
  );
}
