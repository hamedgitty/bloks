// The first ninety seconds.
//
// A first launch earns one cinematic moment, and only one: the mark
// assembling itself, block by block, before it scales up and bursts.
// Everything after it is quieter on purpose; the hero moment spends the
// drama budget and the rest of the sequence explains the product.
//
// Runs once. The flag lives in localStorage, a Skip control appears after
// a couple of seconds, and prefers-reduced-motion collapses every stage
// to a plain crossfade, because a dramatic intro that ignores that
// setting is a defect, not a flourish.
//
// The two "demonstrations" are scripted vignettes, not live agents:
// nothing is connected yet at this point in a first run, so a real demo
// is impossible by construction. Honest theater, clearly staged.
import { useEffect, useMemo, useState } from "react";
import { api } from "@/state/store";
import { BlokAvatar } from "./Avatar";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import type { BlokExpression } from "@/lib/mascot";

export const INTRO_KEY = "bloks-intro-v1";
/** Plugin picks made during the intro, read by the plugins panel later. */
export const INTRO_PLUGINS_KEY = "bloks-intro-plugins";

type Stage = "logo" | "workspace" | "welcome" | "computers" | "jobs" | "plugins";

/** The mark's blocks, taken verbatim from bloks-mark.svg (viewBox
 * 1272 x 1483.5) and expressed as percentages of that box. Build order is
 * the user-specified choreography: left, top, right, bottom, then the
 * inner ring. `from` is the direction a block arrives from; `dir` is the
 * vector it departs along when the mark bursts. */
const BLOCKS = [
  { x: 0, y: 0, w: 22.01, h: 77.39, color: "#004aad", from: [-1, 0], dir: [-1.2, -0.1] }, // left bar
  { x: 26.26, y: 0, w: 73.74, h: 18.87, color: "#ff751f", from: [0, -1], dir: [0.3, -1.2] }, // top bar
  { x: 77.99, y: 22.58, w: 22.01, h: 77.32, color: "#cb6ce6", from: [1, 0], dir: [1.2, 0.2] }, // right bar
  { x: 0, y: 81.09, w: 73.74, h: 18.87, color: "#ff3131", from: [0, 1], dir: [-0.3, 1.2] }, // bottom bar
  { x: 25.16, y: 25.68, w: 10.77, h: 37.61, color: "#5ce1e6", from: [-0.6, -0.4], dir: [-0.7, -0.5] }, // inner left
  { x: 37.89, y: 25.68, w: 35.77, h: 9.24, color: "#ff5757", from: [0.4, -0.6], dir: [0.6, -0.8] }, // inner top
  { x: 62.97, y: 36.67, w: 10.77, h: 37.61, color: "#7ed957", from: [0.6, 0.4], dir: [0.8, 0.6] }, // inner right
  { x: 25.16, y: 65.05, w: 35.77, h: 9.24, color: "#ffbd59", from: [-0.4, 0.6], dir: [-0.6, 0.9] }, // inner bottom
] as const;

/** The idle life of the loader mascot: where it looks, in order. */
const IDLE_EXPRESSIONS: BlokExpression[] = [
  "deadpan",
  "thinking",
  "friendly",
  "surprised",
  "focused",
  "excited",
];

/** The five-role reveal in the jobs vignette. */
const CAST = [
  { name: "Chief of Staff", color: "blue", shape: "star" },
  { name: "Research Analyst", color: "cyan", shape: "bit" },
  { name: "Growth Marketer", color: "pink", shape: "burst" },
  { name: "Inbox Manager", color: "green", shape: "diamond" },
  { name: "Support Agent", color: "orange", shape: "cloud" },
] as const;

/** The everyday-tools grid. Slugs match the connector catalog (the same
 * ones the Plugins panel connects through Composio), and the domains feed
 * the favicon fallback the panel uses for artwork. */
const EVERYDAY: { slug: string; label: string; domain: string; icon?: string }[] = [
  { slug: "slack", label: "Slack", domain: "slack.com" },
  { slug: "gmail", label: "Gmail", domain: "gmail.com", icon: "https://ssl.gstatic.com/images/branding/product/1x/gmail_2020q4_32dp.png" },
  { slug: "outlook", label: "Outlook", domain: "outlook.com" },
  { slug: "microsoft_teams", label: "Teams", domain: "teams.microsoft.com" },
  { slug: "excel", label: "Excel", domain: "microsoft.com" },
  { slug: "one_drive", label: "OneDrive", domain: "onedrive.live.com" },
  { slug: "googlecalendar", label: "Calendar", domain: "calendar.google.com", icon: "https://ssl.gstatic.com/images/branding/product/1x/calendar_2020q4_32dp.png" },
  { slug: "googledrive", label: "Drive", domain: "drive.google.com", icon: "https://ssl.gstatic.com/images/branding/product/1x/drive_2020q4_32dp.png" },
  { slug: "googlesheets", label: "Sheets", domain: "sheets.google.com", icon: "https://ssl.gstatic.com/images/branding/product/1x/sheets_2020q4_32dp.png" },
  { slug: "notion", label: "Notion", domain: "notion.so" },
  { slug: "github", label: "GitHub", domain: "github.com" },
  { slug: "linear", label: "Linear", domain: "linear.app" },
  { slug: "x", label: "X", domain: "x.com" },
  { slug: "instagram", label: "Instagram", domain: "instagram.com" },
  { slug: "facebook", label: "Facebook", domain: "facebook.com" },
  { slug: "whatsapp", label: "WhatsApp", domain: "whatsapp.com" },
  { slug: "stripe", label: "Stripe", domain: "stripe.com" },
  { slug: "figma", label: "Figma", domain: "figma.com" },
  { slug: "hubspot", label: "HubSpot", domain: "hubspot.com" },
];

export function introPending(): boolean {
  try {
    return !localStorage.getItem(INTRO_KEY);
  } catch {
    return false;
  }
}

export function Intro({ onDone }: { onDone: () => void }) {
  const reduced = useMemo(
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    [],
  );
  // ?intro=jobs (etc.) jumps straight to a stage and holds it, for design
  // review; a bare ?intro plays the whole film
  const pinned = useMemo(() => {
    const forced = new URLSearchParams(location.search).get("intro");
    const stages: Stage[] = ["logo", "workspace", "welcome", "computers", "jobs", "plugins"];
    return forced && stages.includes(forced as Stage) ? (forced as Stage) : null;
  }, []);
  const [stage, setStage] = useState<Stage>(pinned ?? (reduced ? "welcome" : "logo"));
  const [skippable, setSkippable] = useState(false);

  const finish = (connected?: string[]) => {
    try {
      localStorage.setItem(INTRO_KEY, String(Date.now()));
      if (connected?.length) localStorage.setItem(INTRO_PLUGINS_KEY, JSON.stringify(connected));
    } catch {}
    onDone();
  };

  useEffect(() => {
    const t = setTimeout(() => setSkippable(true), 2000);
    return () => clearTimeout(t);
  }, []);

  // the two automatic stages advance themselves; everything after has a
  // button, because reading speed is not ours to schedule
  useEffect(() => {
    if (pinned) return;
    if (stage === "logo") {
      const t = setTimeout(() => setStage("workspace"), 5600);
      return () => clearTimeout(t);
    }
    if (stage === "workspace") {
      const t = setTimeout(() => setStage("welcome"), 2800);
      return () => clearTimeout(t);
    }
  }, [stage]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-hidden bg-background">
      {stage === "logo" && <LogoStage loop={pinned === "logo"} />}
      {stage === "workspace" && <WorkspaceStage />}
      {stage === "welcome" && (
        <Panel key="welcome">
          <img
            src="/brand/bloks-wordmark-light.png"
            alt="Bloks"
            className="intro-rise mx-auto h-12 dark:hidden"
          />
          <img
            src="/brand/bloks-wordmark-dark.png"
            alt=""
            aria-hidden
            className="intro-rise mx-auto hidden h-12 dark:block"
          />
          <h1 className="intro-rise mt-6 text-[28px] font-semibold text-foreground [animation-delay:120ms]">
            Welcome to Bloks
          </h1>
          <p className="intro-rise mt-2 text-[14.5px] text-muted-foreground [animation-delay:240ms]">
            Personal AI agents that live on your machine, not in someone
            else's cloud.
          </p>
          <Button className="intro-rise mt-8 [animation-delay:360ms]" onClick={() => setStage("computers")}>
            Next
          </Button>
        </Panel>
      )}
      {stage === "computers" && <ComputersStage onNext={() => setStage("jobs")} />}
      {stage === "jobs" && <JobsStage onNext={() => setStage("plugins")} />}
      {stage === "plugins" && <PluginsStage onDone={finish} />}

      {skippable && stage !== "plugins" && (
        <button
          onClick={() => finish()}
          className="absolute bottom-5 right-6 rounded-lg px-2 py-1 text-[12px] text-muted-foreground/70 transition-colors hover:text-foreground"
        >
          Skip intro
        </button>
      )}
    </div>
  );
}

// ── stage 6: connect your everyday tools, for real ─────────────────────
//
// This screen does the actual work or gets out of the way; there is no
// pick-tools-into-the-void state. Without a Composio key it asks for one
// (validating it against Composio before moving on) or lets the user skip
// entirely. With a working key it shows the tool grid live: clicking a
// tool starts that service's real OAuth flow and the card turns green
// when the connection lands, exactly like the Plugins panel.
function PluginsStage({ onDone }: { onDone: (connected: string[]) => void }) {
  // null while probing whether a key already exists
  const [step, setStep] = useState<"probe" | "key" | "grid">("probe");
  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<Record<string, { connected: boolean }>>({});
  const [busySlug, setBusySlug] = useState<string | null>(null);

  const refreshStatus = (slugs: string[]) =>
    api(`/api/connectors?services=${slugs.join(",")}`)
      .then((r: any) => setStatus((prev) => ({ ...prev, ...(r.services ?? {}) })))
      .catch(() => {});

  useEffect(() => {
    api("/api/config")
      .then((c: any) => {
        if (c?.composio?.configured) {
          setStep("grid");
          void refreshStatus(EVERYDAY.map((t) => t.slug));
        } else {
          setStep("key");
        }
      })
      .catch(() => setStep("key"));
  }, []);

  const saveKey = () => {
    const trimmed = key.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    setError(null);
    api("/api/config", { method: "PUT", body: JSON.stringify({ composio: { key: trimmed } }) })
      // prove the key actually reaches Composio before showing the grid
      .then(() => api("/api/connectors?services=slack"))
      .then((r: any) => {
        if (!r?.configured) throw new Error("that key did not reach Composio");
        setStep("grid");
        void refreshStatus(EVERYDAY.map((t) => t.slug));
      })
      .catch(() => setError("That key didn't work. Check it and try again, or skip for now."))
      .finally(() => setSaving(false));
  };

  const connect = (slug: string) => {
    if (busySlug) return;
    if (status[slug]?.connected) return;
    setBusySlug(slug);
    setError(null);
    api(`/api/connectors/${slug}/authorize`, { method: "POST" })
      .then(({ url }: { url: string }) => {
        window.open(url);
        // the user finishes OAuth in the browser; poll a few times to catch it
        let tries = 0;
        const timer = setInterval(() => {
          void refreshStatus([slug]);
          if (++tries >= 12) clearInterval(timer);
        }, 5000);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusySlug(null));
  };

  const connected = EVERYDAY.filter((t) => status[t.slug]?.connected).map((t) => t.slug);

  if (step === "probe") return null;

  if (step === "key") {
    return (
      <Panel key="plugins-key">
        <h2 className="intro-rise text-[22px] font-semibold text-foreground">
          Connect your everyday tools
        </h2>
        <p className="intro-rise mt-2 text-[13.5px] text-muted-foreground [animation-delay:100ms]">
          Agents reach Slack, Gmail, Notion and the rest through Composio.
          Paste a Connect key and you can link your tools right here; a
          free key takes a minute at composio.dev.
        </p>
        <div className="intro-rise mx-auto mt-6 max-w-[380px] text-left [animation-delay:200ms]">
          <input
            value={key}
            onChange={(e) => setKey(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && saveKey()}
            placeholder="ck_…"
            spellCheck={false}
            autoComplete="off"
            className="w-full rounded-lg border bg-background px-3 py-2.5 text-[13.5px] text-foreground outline-none transition-colors focus:border-brand"
          />
          {error && <div className="mt-2 text-[12.5px] text-destructive">{error}</div>}
        </div>
        <div className="intro-rise mt-6 flex items-center justify-center gap-4 [animation-delay:300ms]">
          <Button onClick={saveKey} disabled={saving || !key.trim()}>
            {saving ? "Checking key…" : "Connect"}
          </Button>
          <button
            onClick={() => onDone([])}
            className="text-[13px] text-muted-foreground transition-colors hover:text-foreground"
          >
            Skip for now
          </button>
        </div>
        <p className="intro-rise mt-4 text-[11.5px] text-muted-foreground/70 [animation-delay:380ms]">
          You can always do this later, in Plugins.
        </p>
      </Panel>
    );
  }

  return (
    <Panel key="plugins-grid" wide>
      <h2 className="intro-rise text-[22px] font-semibold text-foreground">
        What do you use every day?
      </h2>
      <p className="intro-rise mt-2 text-[13.5px] text-muted-foreground [animation-delay:100ms]">
        Click a tool to connect it now; each one opens its own sign-in.
      </p>
      <div className="intro-rise mt-6 grid grid-cols-4 gap-2 sm:grid-cols-5 [animation-delay:200ms]">
        {EVERYDAY.map(({ slug, label, domain, icon }) => {
          const isConnected = Boolean(status[slug]?.connected);
          const isBusy = busySlug === slug;
          return (
            <button
              key={slug}
              onClick={() => connect(slug)}
              disabled={isBusy}
              className={cn(
                "relative flex flex-col items-center gap-1.5 rounded-xl border px-2 py-2.5 text-[11.5px] transition-all duration-150",
                isConnected
                  ? "border-success/60 bg-success/10 font-medium text-foreground"
                  : "text-muted-foreground hover:border-foreground/25 hover:text-foreground",
                isBusy && "opacity-60",
              )}
            >
              {isConnected && (
                <span className="absolute right-1.5 top-1.5 text-[11px] text-success">✓</span>
              )}
              <ToolIcon label={label} domain={domain} icon={icon} />
              {isBusy ? "Opening…" : label}
            </button>
          );
        })}
      </div>
      {error && <div className="mt-3 text-[12.5px] text-destructive">{error}</div>}
      <p className="mt-4 text-[11.5px] text-muted-foreground/70">
        Finished signing in? The card turns green by itself. Everything
        else lives in Plugins later.
      </p>
      <Button className="mt-5" onClick={() => onDone(connected)}>
        {connected.length ? `Continue with ${connected.length} connected` : "Continue"}
      </Button>
    </Panel>
  );
}

/** Tool artwork: official product art when a stable URL exists, else the
 * service's favicon, else a letter; the same degradation the Plugins
 * panel uses. */
function ToolIcon({ label, domain, icon }: { label: string; domain: string; icon?: string }) {
  const [stage, setStage] = useState(icon ? 0 : 1);
  if (stage === 0 && icon) {
    return <img src={icon} alt="" className="size-7 rounded-lg" onError={() => setStage(1)} />;
  }
  if (stage === 1) {
    return (
      <img
        src={`https://www.google.com/s2/favicons?domain=${domain}&sz=64`}
        alt=""
        className="size-7 rounded-lg"
        onError={() => setStage(2)}
      />
    );
  }
  return (
    <div className="flex size-7 items-center justify-center rounded-lg bg-muted text-[12px] font-semibold text-muted-foreground">
      {label.slice(0, 1).toUpperCase()}
    </div>
  );
}

/** Shared stage frame: centered, softly entering content. */
function Panel({ children, wide }: { children: React.ReactNode; wide?: boolean }) {
  return (
    <div className={cn("intro-fade-in px-8 text-center", wide ? "max-w-[560px]" : "max-w-[440px]")}>
      {children}
    </div>
  );
}

// ── stage 1: the mark builds itself, then bursts ───────────────────────
function LogoStage({ loop }: { loop?: boolean }) {
  // "prime" exists for the browser, not the viewer: dropping the build
  // animation and starting the burst transition in one style commit makes
  // the transition never fire (the blocks teleport), so prime removes the
  // animation while pinning identical values, and burst lands a frame
  // later with a clean before-state to transition from.
  const [phase, setPhase] = useState<"build" | "shake" | "prime" | "burst">("build");
  // remounts the block tree on each replay so the build animation reruns
  const [run, setRun] = useState(0);

  useEffect(() => {
    setPhase("build");
    // the settled mark rattles with building pressure, then the release
    // is one motion: accelerating straight through swelling into flying
    // apart, no pause anywhere
    const shake = setTimeout(() => setPhase("shake"), 2620);
    const prime = setTimeout(() => setPhase("prime"), 4240);
    const burst = setTimeout(() => setPhase("burst"), 4280);
    // pinned for design review: play the whole sequence on a loop
    const replay = loop ? setTimeout(() => setRun((r) => r + 1), 6200) : undefined;
    return () => {
      clearTimeout(shake);
      clearTimeout(prime);
      clearTimeout(burst);
      if (replay) clearTimeout(replay);
    };
  }, [run, loop]);

  return (
    <div
      key={run}
      className={cn(
        // the mark's real proportions; slightly taller than wide
        "relative w-[210px] transition-transform",
        // pressure building before the release
        phase === "shake" && "intro-shake",
        // one continuous motion: ease-in from rest means the zoom reads
        // as a swell that keeps going until the mark blows out far past
        // the frame, blocks separating as it grows
        phase === "burst" && "scale-[9] duration-[1100ms] ease-in",
      )}
      style={{ aspectRatio: "1272 / 1483.5" }}
    >
      {BLOCKS.map((block, i) => (
        <div
          key={i}
          className={cn("absolute rounded-[2px]", phase === "build" && "intro-block-in")}
          style={{
            left: `${block.x}%`,
            top: `${block.y}%`,
            width: `${block.w}%`,
            height: `${block.h}%`,
            background: block.color,
            // each block flies in from fully outside the frame, along its
            // own side's direction
            "--from-x": `${block.from[0] * 100}vw`,
            "--from-y": `${block.from[1] * 100}vh`,
            // outer bars first, one by one; the inner ring follows as a
            // second, gentler wave
            animationDelay:
              phase === "build" ? `${i < 4 ? i * 320 : 1280 + (i - 4) * 150}ms` : undefined,
            animationDuration: phase === "build" ? `${i < 4 ? 650 : 850}ms` : undefined,
            ...(phase === "prime" ? { transform: "translate(0, 0)", opacity: 1 } : undefined),
            ...(phase === "burst"
              ? {
                  // separation rides the same accelerating clock as the
                  // zoom; opacity holds until the blocks are at the edges
                  transition:
                    "transform 1100ms cubic-bezier(0.55, 0, 0.85, 0.4), opacity 450ms ease-in 620ms",
                  transform: `translate(${block.dir[0] * 160}px, ${block.dir[1] * 160}px) rotate(${block.dir[0] * 40}deg) scale(0.9)`,
                  opacity: 0,
                }
              : undefined),
          } as React.CSSProperties}
        />
      ))}
    </div>
  );
}

// ── stage 2: the workspace loader, with a mascot that is alive ─────────
function WorkspaceStage() {
  const [expression, setExpression] = useState(0);

  useEffect(() => {
    const t = setInterval(() => setExpression((e) => e + 1), 650);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="intro-fade-in flex flex-col items-center">
      <div className="intro-hover">
        <BlokAvatar
          color="blue"
          shape="star"
          expression={IDLE_EXPRESSIONS[expression % IDLE_EXPRESSIONS.length]}
          size={104}
        />
      </div>
      <div className="mt-6 text-[15px] font-medium text-foreground">
        Setting up your Bloks workspace
        <span className="intro-ellipsis" />
      </div>
      <div className="mt-4 h-1 w-44 overflow-hidden rounded-full bg-muted">
        <div className="intro-progress h-full w-1/3 rounded-full bg-brand" />
      </div>
    </div>
  );
}

// ── stage 4: agents have their own computers ───────────────────────────
//
// A miniature desktop with the agent's own cursor working it: the cursor
// glides to the dock, opens a browser onto a dashboard, opens a
// spreadsheet, fills the week's numbers in, and a toast confirms the
// report. Choreographed with one step counter so every actor reads off
// the same clock.
const SHEET_ROWS = [
  ["Day", "Sessions", "Revenue"],
  ["Mon", "1,204", "$8.2k"],
  ["Tue", "1,377", "$9.1k"],
  ["Wed", "1,890", "$11.4k"],
  ["Thu", "2,041", "$12.9k"],
] as const;

const STAT_TILES = [
  ["Revenue", "$41.6k", "+12%"],
  ["Sessions", "6,512", "+8%"],
  ["Signups", "214", "+19%"],
] as const;

function ComputersStage({ onNext }: { onNext: () => void }) {
  // 0 idle · 1 cursor to dock · 2 browser opens, charts rise · 3 cursor to
  // sheets · 4 sheet opens, cells fill · 5 toast
  const [step, setStep] = useState(0);

  useEffect(() => {
    const BEATS = [500, 900, 2400, 900, 2800];
    let i = 0;
    let t: ReturnType<typeof setTimeout>;
    const next = () => {
      if (i >= BEATS.length) return;
      t = setTimeout(() => {
        i += 1;
        setStep(i);
        next();
      }, BEATS[i]);
    };
    next();
    return () => clearTimeout(t);
  }, []);

  // where the agent's cursor is, per step, in percent of the screen area
  const cursor = step < 1 ? { x: 84, y: 78 } : step < 3 ? { x: 43, y: 89 } : step < 4 ? { x: 53, y: 89 } : { x: 64, y: 52 };

  return (
    <Panel key="computers" wide>
      <div className="intro-rise mx-auto w-[600px] max-w-[92vw] overflow-hidden rounded-2xl border bg-card text-left shadow-[0_24px_70px_-24px_rgba(0,0,0,0.4)]">
        <div className="flex items-center gap-1.5 border-b px-3.5 py-2.5">
          <span className="size-3 rounded-full bg-[#ff5f57]" />
          <span className="size-3 rounded-full bg-[#febc2e]" />
          <span className="size-3 rounded-full bg-[#28c840]" />
          <span className="ml-2 text-[12px] text-muted-foreground">
            Research Analyst's computer
          </span>
        </div>

        <div className="relative h-[340px] bg-gradient-to-br from-muted/60 to-muted">
          {/* browser window */}
          <div
            className={cn(
              "absolute left-[4%] top-[6%] w-[66%] overflow-hidden rounded-xl border bg-card shadow-lg transition-all duration-300",
              step >= 2 ? "scale-100 opacity-100" : "scale-90 opacity-0",
            )}
          >
            <div className="flex items-center gap-2 border-b bg-muted/50 px-3 py-2">
              <span className="size-2 rounded-full bg-foreground/15" />
              <span className="size-2 rounded-full bg-foreground/15" />
              <div className="ml-1 flex-1 rounded-md bg-background px-2.5 py-1 text-[10.5px] text-muted-foreground">
                dashboard.bloks.dev
              </div>
            </div>
            <div className="px-4 pb-1 pt-3 text-[11.5px] font-semibold text-foreground">
              Revenue dashboard
            </div>
            {/* stat tiles land one by one before the chart rises */}
            <div className="flex gap-2 px-4 pt-1.5">
              {STAT_TILES.map(([label, value, delta], i) => (
                <div
                  key={label}
                  className="flex-1 rounded-lg border bg-background/60 px-2.5 py-1.5 transition-all duration-300"
                  style={{
                    opacity: step >= 2 ? 1 : 0,
                    transform: step >= 2 ? "translateY(0)" : "translateY(6px)",
                    transitionDelay: `${150 + i * 130}ms`,
                  }}
                >
                  <div className="text-[8.5px] text-muted-foreground">{label}</div>
                  <div className="text-[12px] font-semibold tabular-nums text-foreground">
                    {value} <span className="text-[8.5px] font-medium text-success">{delta}</span>
                  </div>
                </div>
              ))}
            </div>
            <div className="flex h-[104px] items-end gap-2.5 px-4 pb-3.5 pt-2.5">
              {[34, 48, 42, 60, 74, 90].map((height, i) => (
                <div key={i} className="flex h-full flex-1 flex-col justify-end">
                  <div
                    className="rounded-t-[3px] bg-brand/80 transition-all duration-700 ease-out"
                    style={{
                      height: step >= 2 ? `${height}%` : "4%",
                      transitionDelay: `${450 + i * 110}ms`,
                    }}
                  />
                </div>
              ))}
            </div>
          </div>

          {/* spreadsheet window, opening over the browser */}
          <div
            className={cn(
              "absolute right-[4%] top-[13%] w-[52%] overflow-hidden rounded-xl border bg-card shadow-xl transition-all duration-300",
              step >= 4 ? "scale-100 opacity-100" : "scale-90 opacity-0",
            )}
          >
            <div className="border-b bg-muted/50 px-3 py-1.5 text-[10.5px] font-medium text-muted-foreground">
              Weekly numbers · Q3
            </div>
            <table className="w-full border-collapse">
              <tbody>
                {SHEET_ROWS.map((row, r) => (
                  <tr key={r} className={cn("border-b last:border-0", r === 0 && "bg-muted/40")}>
                    {row.map((cell, c) => {
                      const order = r * row.length + c;
                      return (
                        <td
                          key={c}
                          className={cn(
                            "border-r px-2.5 py-[5px] text-[10.5px] tabular-nums last:border-0",
                            r === 0
                              ? "font-medium text-muted-foreground"
                              : c === 0
                                ? "text-muted-foreground"
                                : "text-foreground",
                            step >= 4 ? "opacity-100" : "opacity-0",
                          )}
                          style={{ transition: "opacity 150ms", transitionDelay: `${250 + order * 90}ms` }}
                        >
                          {cell}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* toast */}
          <div
            className={cn(
              "absolute right-3 top-3 z-20 flex items-center gap-1.5 rounded-lg border bg-card px-3 py-2 text-[11px] font-medium text-success shadow-md transition-all duration-300",
              step >= 5 ? "translate-y-0 opacity-100" : "-translate-y-2 opacity-0",
            )}
          >
            ✓ Report updated, 4 charts refreshed
          </div>

          {/* dock */}
          <div className="absolute bottom-2.5 left-1/2 flex -translate-x-1/2 gap-2.5 rounded-2xl border bg-card/80 px-3 py-2 shadow backdrop-blur">
            <DockIcon label="Browser" active={step >= 2}>
              <div className="size-full rounded-full border-[3px] border-brand" />
            </DockIcon>
            <DockIcon label="Sheets" active={step >= 4}>
              <div className="grid size-full grid-cols-2 gap-[2px]">
                {[0, 1, 2, 3].map((i) => (
                  <div key={i} className="rounded-[1.5px] bg-success/80" />
                ))}
              </div>
            </DockIcon>
            <DockIcon label="Mail" active={false}>
              <div className="flex size-full items-center justify-center rounded-[3px] border-[2px] border-foreground/30">
                <div className="h-0 w-0 border-x-[5px] border-t-[4px] border-x-transparent border-t-foreground/30" />
              </div>
            </DockIcon>
          </div>

          {/* the agent's cursor, name tag riding along like a multiplayer
              cursor, so it reads as somebody working, not a screensaver */}
          <div
            className="absolute z-10 transition-all duration-700 ease-in-out"
            style={{ left: `${cursor.x}%`, top: `${cursor.y}%` }}
          >
            <svg width="17" height="17" viewBox="0 0 24 24" className="drop-shadow">
              <path d="M4 2 L20 12 L12.5 13.5 L9 21 Z" fill="var(--brand-ink)" stroke="var(--background)" strokeWidth="1.5" />
            </svg>
            <span className="ml-2.5 whitespace-nowrap rounded-full bg-brand-ink px-2 py-0.5 text-[10px] font-medium text-brand-foreground shadow">
              Research Analyst
            </span>
            {/* click ripple on each landing */}
            {(step === 2 || step === 4) && (
              <span className="intro-click absolute -left-1 -top-1 size-7 rounded-full border-2 border-brand" />
            )}
          </div>
        </div>
      </div>

      <h2 className="intro-rise mt-7 text-[22px] font-semibold text-foreground [animation-delay:150ms]">
        Every agent gets its own computer
      </h2>
      <p className="intro-rise mt-2 text-[13.5px] text-muted-foreground [animation-delay:250ms]">
        A real machine to browse, run tools and finish work on, while you
        do something better with your afternoon.
      </p>
      <Button className="intro-rise mt-7 [animation-delay:350ms]" onClick={onNext}>
        Next
      </Button>
    </Panel>
  );
}

function DockIcon({
  label,
  active,
  children,
}: {
  label: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-0.5">
      <div
        className={cn(
          "flex size-7 items-center justify-center rounded-lg border bg-background p-1.5 transition-transform",
          active && "scale-110",
        )}
        title={label}
      >
        {children}
      </div>
      <span className={cn("size-[3px] rounded-full", active ? "bg-foreground/60" : "bg-transparent")} />
    </div>
  );
}

// ── stage 5: one agent becomes a team ──────────────────────────────────
function JobsStage({ onNext }: { onNext: () => void }) {
  const [spread, setSpread] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setSpread(true), 550);
    return () => clearTimeout(t);
  }, []);

  const R = 118; // orbit radius in px

  return (
    <Panel key="jobs" wide>
      <div className="relative mx-auto h-[300px] w-[300px]">
        {/* the sweep: one slow ring of light while the cast takes its
            places, then it fades rather than looping forever */}
        <div className={cn("intro-sweep absolute inset-4 rounded-full", !spread && "opacity-0")} />
        {CAST.map((member, i) => {
          const angle = -90 + i * (360 / CAST.length);
          const x = Math.cos((angle * Math.PI) / 180) * R;
          const y = Math.sin((angle * Math.PI) / 180) * R;
          return (
            <div
              key={member.name}
              className="absolute left-1/2 top-1/2"
              style={{
                transform: spread
                  ? `translate(calc(-50% + ${x}px), calc(-50% + ${y}px))`
                  : "translate(-50%, -50%)",
                transition: `transform 650ms cubic-bezier(0.34, 1.4, 0.5, 1) ${i * 70}ms`,
              }}
            >
              <div className="flex flex-col items-center gap-1.5">
                <BlokAvatar
                  color={member.color}
                  shape={member.shape}
                  expression="friendly"
                  size={56}
                />
                <span
                  className={cn(
                    "whitespace-nowrap text-[11px] font-medium text-muted-foreground transition-opacity duration-500",
                    spread ? "opacity-100" : "opacity-0",
                  )}
                  style={{ transitionDelay: `${350 + i * 70}ms` }}
                >
                  {member.name}
                </span>
              </div>
            </div>
          );
        })}
      </div>
      <h2 className="intro-rise mt-2 text-[22px] font-semibold text-foreground">
        Give every agent a job
      </h2>
      <p className="intro-rise mt-2 text-[13.5px] text-muted-foreground [animation-delay:120ms]">
        Each one carries its own role, skills and memory. Put them in a
        room together and the most senior one runs the meeting.
      </p>
      <Button className="intro-rise mt-6 [animation-delay:240ms]" onClick={onNext}>
        Next
      </Button>
    </Panel>
  );
}
