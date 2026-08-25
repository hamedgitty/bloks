// Watching what an agent is doing.
//
// Which machine the agent works on changes everything about this panel, so
// the mode is settled first and the rest follows from it.
//
//   cloud    its own box. Opening the panel provisions one if needed,
//            which is safe to repeat, and the preview arrives either as
//            pushed frames or a slow screenshot poll.
//   local    this Mac. Frames come from the desktop shell, because the
//            screen belongs to the app and not to the harness.
//   off      nothing to show.
//
// Left unset, an agent picks for itself: its own box when it has one,
// otherwise this Mac.
//
// The mode also decides what may be called. Box endpoints are reachable
// only on the cloud path, so an agent working locally can never end up
// rendering an error response where a screenshot should be.
import { useEffect, useRef, useState } from "react";
import ExternalLink from "lucide-react/dist/esm/icons/external-link.js";
import Loader2 from "lucide-react/dist/esm/icons/loader-2.js";
import Monitor from "lucide-react/dist/esm/icons/monitor.js";
import Moon from "lucide-react/dist/esm/icons/moon.js";
import Power from "lucide-react/dist/esm/icons/power.js";
import SettingsIcon from "lucide-react/dist/esm/icons/settings-2.js";
import X from "lucide-react/dist/esm/icons/x.js";
import { useStore, type Bot } from "@/state/store";
import { usePageVisible } from "@/lib/pageVisible";
import { DesktopOverlay } from "./DesktopOverlay";
import { ApiKeyRow } from "./ApiKeys";
import { RoutinesSection } from "./RoutinesSection";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/cn";

async function api(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(path, { headers: { "content-type": "application/json" }, ...init });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  return body;
}

/**
 * Rewind: every frame the preview ever showed goes onto a small tape,
 * and a scrubber lets you drag back through the agent's last several
 * minutes of screen time. Watching what an agent DID, not just what it
 * is doing, is the difference between trusting it and hoping.
 */
const TAPE_BYTE_BUDGET = 48_000_000; // ~48MB of base64, tens of frames

function RewindableFrame({ src, alt }: { src: string; alt: string }) {
  const tape = useRef<Array<{ at: number; frame: string }>>([]);
  const tapeBytes = useRef(0);
  const [cursor, setCursor] = useState<number | null>(null);

  const last = tape.current[tape.current.length - 1];
  // while the user is scrubbing, the tape holds still: frames arriving
  // under a paused cursor would slide the picture out from their thumb
  if (src && last?.frame !== src && cursor === null) {
    tape.current.push({ at: Date.now(), frame: src });
    tapeBytes.current += src.length;
    while (tapeBytes.current > TAPE_BYTE_BUDGET && tape.current.length > 1) {
      tapeBytes.current -= tape.current.shift()!.frame.length;
    }
  }

  const showing = cursor !== null ? tape.current[cursor] : null;
  const live = showing === null;

  return (
    <div className="group/rewind relative h-full w-full">
      <img
        src={showing?.frame ?? src}
        alt={alt}
        className="h-full w-full object-contain"
      />
      {!live && (
        <span className="absolute left-2 top-2 rounded-md bg-black/70 px-1.5 py-0.5 text-[10.5px] font-semibold tabular-nums text-white">
          {new Date(showing!.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })}
        </span>
      )}
      {tape.current.length > 1 && (
        <div
          className={cn(
            "absolute inset-x-2 bottom-2 flex items-center gap-2 rounded-lg bg-black/60 px-2.5 py-1.5 backdrop-blur transition-opacity",
            live && "opacity-0 group-hover/rewind:opacity-100",
          )}
        >
          <input
            type="range"
            min={0}
            max={tape.current.length - 1}
            value={cursor ?? tape.current.length - 1}
            onChange={(e) => {
              const v = Number(e.target.value);
              setCursor(v >= tape.current.length - 1 ? null : v);
            }}
            className="h-1 min-w-0 flex-1 cursor-pointer accent-[--brand]"
            aria-label="Rewind through recent frames"
          />
          <button
            onClick={() => setCursor(null)}
            className={cn(
              "shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold tracking-wide",
              live ? "text-white/60" : "bg-destructive text-white",
            )}
          >
            LIVE
          </button>
        </div>
      )}
    </div>
  );
}

type Phase =
  | "checking"
  | "unconfigured"
  | "starting"
  | "ready"
  | "local"
  | "local-unavailable"
  | "off"
  | "error";

/** The Local VM as this agent sees it: a live desktop preview when the
 * VM is ready, and honest directions to Settings when it is not. Setup
 * itself lives in App Settings; this card never duplicates it. */
function LocalVmCard({ bot }: { bot: Bot }) {
  const { dispatch } = useStore();
  const [desktop, setDesktop] = useState<string | null>(null);
  const [status, setStatus] = useState<{
    ready: boolean;
    problem: string | null;
    viewerUrl: string | null;
    inUseBy: string | null;
  } | null>(null);
  const [frame, setFrame] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      api("/api/local-vm")
        .then((s) => alive && setStatus(s))
        .catch(() => {});
    load();
    const t = setInterval(load, 5_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [bot.id]);

  // the preview: one frame every few seconds while the desktop is up
  // and somebody is looking; a hidden window captures nothing
  const visible = usePageVisible();
  useEffect(() => {
    if (!status?.ready || !visible) return;
    let alive = true;
    let busy = false;
    const shoot = () => {
      if (busy) return;
      busy = true;
      api("/api/local-vm/screenshot", { method: "POST" })
        .then((r) => alive && r.frame && setFrame(r.frame))
        .catch(() => {})
        .finally(() => {
          busy = false;
        });
    };
    shoot();
    const t = setInterval(shoot, 3_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [status?.ready, visible]);

  return (
    <div className="mt-3">
      <div className="mb-1.5 flex items-center justify-between text-[12.5px] font-medium text-muted-foreground">
        <span>{bot.name}'s Local VM</span>
        {status?.inUseBy && <span className="text-[11px] font-normal">{status.inUseBy} is using it</span>}
      </div>
      <div className="flex aspect-[16/10] w-full items-center justify-center overflow-hidden rounded-xl border bg-muted/50">
        {frame && status?.ready ? (
          <RewindableFrame key={bot.id} src={frame} alt="The Local VM's desktop" />
        ) : (
          <div className="flex flex-col items-center gap-2 px-6 text-center text-muted-foreground">
            {status === null || status.ready ? (
              <Loader2 size={18} className="animate-spin" />
            ) : (
              <Monitor size={22} />
            )}
            <span className="text-[12px]">
              {status === null
                ? "Checking…"
                : status.ready
                  ? "Waiting for the first frame…"
                  : (status.problem ?? "The Local VM is not set up yet.")}
            </span>
          </div>
        )}
      </div>
      {status?.ready && status.viewerUrl ? (
        <Button
          variant="secondary"
          className="mt-3 w-full"
          onClick={() => setDesktop(status.viewerUrl)}
        >
          <ExternalLink size={14} />
          Open desktop
        </Button>
      ) : status !== null && !status.ready ? (
        <div className="mt-3 rounded-2xl border bg-card p-4">
          <div className="text-[12.5px] leading-relaxed text-muted-foreground">
            The Local VM is a Cua Linux desktop in a container on this Mac. Free, and separate
            from your own desktop.
          </div>
          <Button
            variant="secondary"
            size="sm"
            className="mt-2.5"
            onClick={() => dispatch({ type: "toggleAppSettings" })}
          >
            Set it up in Settings
          </Button>
        </div>
      ) : null}
      {desktop && <DesktopOverlay bot={bot} url={desktop} onClose={() => setDesktop(null)} />}
    </div>
  );
}

export function ComputerPanel({ bot }: { bot: Bot }) {
  const { state, dispatch } = useStore();
  const [phase, setPhase] = useState<Phase>("checking");
  const [boxState, setBoxState] = useState<string | null>(null);
  const [polledFrame, setPolledFrame] = useState<{ png: string; mime: string } | null>(null);
  const [localFrame, setLocalFrame] = useState<string | null>(null);
  const [pending, setPending] = useState<"join" | "sleep" | null>(null);
  const [desktop, setDesktop] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // bumped when a Box token is saved inline, to re-run the spin-up flow
  const [retry, setRetry] = useState(0);

  // Settle which machine this is before anything else runs.
  useEffect(() => {
    let alive = true;
    setPhase("checking");
    setPolledFrame(null);
    setLocalFrame(null);
    setError(null);
    const isElectron = Boolean(window.bloks);
    // sandbox has its own card and no screen to chase
    if (bot.computer === "off" || bot.computer === "sandbox") {
      setPhase("off");
      return;
    }
    if (bot.computer === "local") {
      setPhase(isElectron ? "local" : "local-unavailable");
      return;
    }
    // or left to decide for itself
    api(`/api/bots/${bot.id}/computer`)
      .then((status) => {
        if (!alive) return;
        const autoLocal = bot.computer !== "cloud" && isElectron;
        if (!status.configured) {
          setPhase(autoLocal ? "local" : "unconfigured");
          return;
        }
        if (!status.box && autoLocal) {
          setPhase("local");
          return;
        }
        setPhase("starting");
        return api(`/api/bots/${bot.id}/computer/provision`, { method: "POST" }).then((r) => {
          if (!alive) return;
          setBoxState(r.state ?? null);
          setPhase("ready");
        });
      })
      .catch((e) => {
        if (!alive) return;
        setError(e.message);
        setPhase("error");
      });
    return () => {
      alive = false;
    };
  }, [bot.id, bot.computer, retry]);

  // a bot switch must never paint the previous agent's screen, even for
  // one frame; the reset happens during render, before anything shows
  const [frameOwner, setFrameOwner] = useState(bot.id);
  if (frameOwner !== bot.id) {
    setFrameOwner(bot.id);
    setPolledFrame(null);
    setLocalFrame(null);
  }

  // cloud preview: SSE frames win while the agent works; otherwise poll,
  // and only while the window is actually on screen
  const live = state.screens[bot.id];
  const sseFlowing = Boolean(bot.busy && live);
  const inFlight = useRef(false);
  const visible = usePageVisible();
  useEffect(() => {
    if (phase !== "ready" || sseFlowing || !visible) return;
    let alive = true;
    const shoot = async () => {
      if (inFlight.current) return;
      inFlight.current = true;
      try {
        const { png, format } = await api(`/api/bots/${bot.id}/computer/screenshot`, { method: "POST" });
        if (alive) setPolledFrame({ png, mime: format === "jpeg" ? "image/jpeg" : "image/png" });
      } catch {
        /* box mid-command or asleep, next tick */
      } finally {
        inFlight.current = false;
      }
    };
    void shoot();
    const timer = setInterval(shoot, 4000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [phase, sseFlowing, bot.id, visible]);

  // local preview: frames from the Electron main process
  useEffect(() => {
    if (phase !== "local" || !window.bloks || !visible) return;
    let alive = true;
    const shoot = async () => {
      try {
        const url = await window.bloks!.screenFrame();
        if (alive && url) setLocalFrame(url);
      } catch {
        /* capture denied or transient, next tick */
      }
    };
    void shoot();
    const timer = setInterval(shoot, 3000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [phase, visible]);

  const lastScreenMessage = [...bot.messages].reverse().find((m) => m.kind === "screen" && m.png);
  const cloudFrame =
    (sseFlowing ? live : null) ??
    polledFrame ??
    (lastScreenMessage ? { png: lastScreenMessage.png!, mime: lastScreenMessage.mime ?? "image/png" } : null);
  const frameSrc =
    phase === "local"
      ? localFrame
      : phase === "ready" || phase === "starting"
        ? cloudFrame && `data:${cloudFrame.mime};base64,${cloudFrame.png}`
        : null;

  const run = (kind: "join" | "sleep") => {
    setPending(kind);
    setError(null);
    api(`/api/bots/${bot.id}/computer/${kind}`, { method: "POST" })
      .then((result) => {
        // this URL carries a token that rotates every time the box
        // sleeps, so it is minted per click and never stored
        if (kind === "join" && result.joinUrl) setDesktop(result.joinUrl);
        if (kind === "sleep") setBoxState("archived");
      })
      .catch((e) => setError(e.message))
      .finally(() => setPending(null));
  };

  const emptyState: Record<Exclude<Phase, "ready" | "local">, string> = {
    checking: "Checking…",
    starting: "Starting your agent's computer…",
    unconfigured: "No cloud computer configured",
    "local-unavailable": "Local preview needs the desktop app. Run pnpm dev:desktop",
    off: "This agent's computer is off",
    error: "Couldn't reach the computer",
  };

  return (
    <aside className="fixed inset-0 z-50 flex w-full animate-panel-in flex-col bg-background md:static md:z-auto md:h-full md:w-[380px] md:max-w-[85vw] md:shrink-0 md:border-l">
      {/* Header */}
      <div className="flex h-[52px] shrink-0 items-center justify-between border-b px-3">
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => dispatch({ type: "toggleSettings", open: true })}
          title="Agent settings"
        >
          <SettingsIcon size={16} />
        </Button>
        <span className="text-[13.5px] font-semibold text-foreground">Computer</span>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Close computer panel"
          onClick={() => dispatch({ type: "toggleComputer", open: false })}
        >
          <X size={16} />
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto px-5 pb-6">
        {/* The Local VM brings its own preview; the header and the Runs
            on picker stay put so there is always a way back. */}
        {bot.computer === "sandbox" ? (
          <LocalVmCard bot={bot} />
        ) : (
          <>
        <TakeTheWheel bot={bot} />

        {/* Screen preview */}
        <div className="mb-1.5 mt-3 flex items-center justify-between text-[12.5px] font-medium text-muted-foreground">
          <span>{bot.name}'s screen</span>
          {phase === "local" && <span className="text-[11px] font-normal">this computer</span>}
        </div>
        <div className="flex aspect-[16/10] w-full items-center justify-center overflow-hidden rounded-xl border bg-muted/50">
          {frameSrc ? (
            <RewindableFrame key={bot.id} src={frameSrc} alt={`${bot.name}'s screen`} />
          ) : (
            <div className="flex flex-col items-center gap-2 px-6 text-center text-muted-foreground">
              {phase === "checking" || phase === "starting" || phase === "local" ? (
                <Loader2 size={18} className="animate-spin" />
              ) : phase === "off" ? (
                <Power size={22} />
              ) : (
                <Monitor size={22} />
              )}
              <span className="text-[12px]">
                {phase === "ready"
                  ? "Waiting for the first frame…"
                  : phase === "local"
                    ? "Capturing this computer's screen…"
                    : emptyState[phase]}
              </span>
            </div>
          )}
        </div>

        {error && (
          <div className="mt-2 rounded-xl bg-destructive/10 px-3 py-2 text-[12px] text-destructive">
            {error}
          </div>
        )}
        {phase === "unconfigured" && (
          <div className="mt-3 rounded-2xl border bg-card p-4">
            <div className="mb-3 text-[12.5px] leading-relaxed text-muted-foreground">
              Paste a Box API key to give this agent a cloud computer. It spins up right here.
            </div>
            <ApiKeyRow
              section="box"
              label="Box API key"
              placeholder="Paste your Box API key"
              info={{
                text: "Gives agents an isolated remote Linux computer with a desktop and a terminal. Box is a paid service after its trial, so usage can incur charges.",
                linkLabel: "Open the Box API key guide",
                linkHref: "https://docs.ascii.dev/box/api-keys",
              }}
              onSaved={(configured) => configured && setRetry((n) => n + 1)}
            />
          </div>
        )}

        {/* Cloud-only actions */}
        {phase === "ready" && (
          <div className="mt-3 flex gap-2">
            <Button
              variant="secondary"
              onClick={() => run("join")}
              disabled={pending === "join"}
              className="flex-1"
            >
              {pending === "join" ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <ExternalLink size={14} />
              )}
              Open desktop
            </Button>
            {boxState !== "archived" && (
              <Button
                variant="secondary"
                onClick={() => run("sleep")}
                disabled={pending === "sleep"}
                title="Put the computer to sleep"
              >
                {pending === "sleep" ? <Loader2 size={14} className="animate-spin" /> : <Moon size={14} />}
                Sleep
              </Button>
            )}
          </div>
        )}
          </>
        )}

        {/* Computer source */}
        <div className="mt-4 rounded-2xl border bg-card p-4">
          <div className="text-[13.5px] font-semibold text-foreground">Runs on</div>
          <div className="mt-0.5 text-[12.5px] leading-relaxed text-muted-foreground">
            {bot.computer ? "" : "Auto: the cloud box when one exists, else this computer. "}Pick where
            this agent's computer lives.
          </div>
          {/* The same four homes the settings card offers, in the same
              2x2 shape. One setting, two doors; they must never disagree
              about what the options are. */}
          <div className="mt-3 flex items-center justify-between gap-3">
            <div>
              <div className="text-[13px] text-foreground">Automatic</div>
              <div className="text-[12px] text-muted-foreground">
                The cloud box when one exists, else this computer
              </div>
            </div>
            <Switch
              checked={!bot.computer}
              onCheckedChange={(on) =>
                dispatch({ type: "updateBot", botId: bot.id, patch: { computer: on ? null : "local" } })
              }
            />
          </div>
          {!bot.computer && !state.config?.box?.configured && (
            <div className="mt-2 rounded-xl bg-muted/60 px-3 py-2 text-[12px] text-muted-foreground">
              No cloud box is set up, so Auto will use this computer. Add a Box
              token below to give this agent a computer of its own.
            </div>
          )}
          <div
            className={cn(
              "mt-3 grid grid-cols-2 gap-1 rounded-xl bg-muted p-1 transition-opacity duration-150",
              !bot.computer && "pointer-events-none opacity-45",
            )}
          >
                        {(
              [
                ["cloud", "Cloud box"],
                ["sandbox", "Local VM"],
                ["local", "This computer"],
                ["off", "Off"],
              ] as const
            ).map(([mode, label]) => (
              <button
                key={mode}
                onClick={() => dispatch({ type: "updateBot", botId: bot.id, patch: { computer: mode } })}
                className={cn(
                  "rounded-lg py-1.5 text-[12.5px] transition-colors duration-150",
                  bot.computer === mode
                    ? "bg-background font-medium text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* Routines. Real now: see server/routines.ts. */}
        <RoutinesSection targetId={bot.id} targetKind="agent" targetName={bot.name} />
      </div>
      {desktop && <DesktopOverlay bot={bot} url={desktop} onClose={() => setDesktop(null)} />}
    </aside>
  );
}

/**
 * Driving it yourself for a minute.
 *
 * The button says what it does to the agent, because "take control" reads
 * as a view mode and this is not one: while you hold it, anything the
 * agent would have asked permission for is refused, and it is told to
 * wait rather than to find another way.
 */
function TakeTheWheel({ bot }: { bot: Bot }) {
  // The hold rides on the agent, so this reads it rather than polling a
  // second endpoint every five seconds: taking it broadcasts the agent,
  // which is the same moment every other surface learns about it.
  const hold = bot.held ?? null;
  const [busy, setBusy] = useState(false);

  const set = (take: boolean) => {
    setBusy(true);
    api(`/api/bots/${bot.id}/wheel`, {
      method: take ? "POST" : "DELETE",
      ...(take ? { body: JSON.stringify({ why: "you are using it" }) } : {}),
    })
      .catch(() => {})
      .finally(() => setBusy(false));
  };

  return (
    <div
      className={cn(
        "mt-3 flex items-start justify-between gap-3 rounded-xl border px-3 py-2.5",
        hold ? "border-warning/40 bg-warning/5" : "bg-card",
      )}
    >
      <div className="min-w-0">
        <div className="text-[13px] text-foreground">
          {hold ? "You have the wheel" : "Take the wheel"}
        </div>
        <div className="mt-0.5 text-[11.5px] leading-relaxed text-muted-foreground">
          {hold
            ? `${bot.name} is waiting. It will not start anything until you hand it back` +
              (hold.turnedAway ? `, and ${hold.turnedAway} ${hold.turnedAway === 1 ? "thing has" : "things have"} been turned away since.` : ".")
            : `Drive this yourself. While you do, ${bot.name} stops rather than working around you.`}
        </div>
      </div>
      <Button
        variant={hold ? "secondary" : "ghost"}
        size="sm"
        className="shrink-0"
        disabled={busy}
        onClick={() => set(!hold)}
      >
        {hold ? "Hand it back" : "Take it"}
      </Button>
    </div>
  );
}
