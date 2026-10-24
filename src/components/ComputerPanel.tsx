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
// A hosted workspace (server/hosted.ts) is the agents' computer already:
// there is no box, no VM and no Mac to choose, only this machine or off,
// and what is shown is the machine's virtual desktop, passed through the
// server under a ticket.
//
// The mode also decides what may be called. Box endpoints are reachable
// only on the cloud path, so an agent working locally can never end up
// rendering an error response where a screenshot should be.
import { useEffect, useRef, useState } from "react";
import { ExternalLink } from "@/components/icons";
import { Loader2 } from "@/components/icons";
import { Monitor } from "@/components/icons";
import { Moon } from "@/components/icons";
import { Power } from "@/components/icons";
import { X } from "@/components/icons";
import { useStore, type Bot } from "@/state/store";
import type { CuaPermissions } from "@/types/bridge";
import { usePageVisible } from "@/lib/pageVisible";
import { DesktopOverlay } from "./DesktopOverlay";
import { ApiKeyRow } from "./ApiKeys";
import { RoutinesSection } from "./RoutinesSection";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/cn";
import { thisComputer } from "@/lib/thisComputer";
import { computerOptions, offersThisComputer } from "@/lib/hosted";
import { useEscape } from "@/lib/useEscape";

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
        <span className="absolute left-2 top-2 rounded-md bg-black/70 px-1.5 py-0.5 text-caption font-semibold tabular-nums text-white">
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
            className="h-1 min-w-0 flex-1 cursor-pointer accent-(--brand)"
            aria-label="Rewind through recent frames"
          />
          <button
            onClick={() => setCursor(null)}
            className={cn(
              "shrink-0 rounded px-1.5 py-0.5 text-micro font-bold tracking-wide",
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
  | "no-own-screen"
  | "hosted"
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
      <div className="mb-1.5 flex items-center justify-between text-body font-medium text-muted-foreground">
        <span>{bot.name}'s Local VM</span>
        {status?.inUseBy && <span className="text-caption font-normal">{status.inUseBy} is using it</span>}
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
            <span className="text-small">
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
          <div className="text-body leading-relaxed text-muted-foreground">
            A free Linux desktop in a container on {thisComputer()}, separate from yours.
          </div>
          <Button
            variant="secondary"
            size="sm"
            className="mt-2.5"
            onClick={() => dispatch({ type: "toggleAppSettings", open: true, page: "computers" })}
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
  const hosted = Boolean(state.config?.hosted?.on);
  // Off a Mac nothing can work this computer's own screen, so the server
  // leaves it out of the choices and Automatic never falls back on it.
  const ownScreen = offersThisComputer(state.config?.hosted?.computers);
  useEscape(() => dispatch({ type: "toggleComputer", open: false }));
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
    // a hosted machine is the computer: nothing to provision or find
    if (hosted) {
      setPhase(bot.computer === "off" ? "off" : "hosted");
      return;
    }
    // sandbox has its own card and no screen to chase
    if (bot.computer === "off" || bot.computer === "sandbox") {
      setPhase("off");
      return;
    }
    if (bot.computer === "local") {
      setPhase(!ownScreen ? "no-own-screen" : isElectron ? "local" : "local-unavailable");
      return;
    }
    // or left to decide for itself
    api(`/api/bots/${bot.id}/computer`)
      .then((status) => {
        if (!alive) return;
        const autoLocal = bot.computer !== "cloud" && isElectron && ownScreen;
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
  }, [bot.id, bot.computer, retry, hosted, ownScreen]);

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

  const emptyState: Record<Exclude<Phase, "ready" | "local" | "hosted">, string> = {
    checking: "Checking…",
    starting: "Starting your agent's computer…",
    unconfigured: "No cloud computer configured",
    "local-unavailable": "Local preview needs the desktop app",
    "no-own-screen": "Agents can work this computer's own screen only on a Mac. Choose Local VM below.",
    off: "This agent's computer is off",
    error: "Couldn't reach the computer",
  };

  return (
    <aside className="fixed inset-0 z-50 flex w-full animate-panel-in flex-col bg-background md:static md:z-auto md:h-full md:w-[380px] md:max-w-[85vw] md:shrink-0 md:border-l">
      {/* Header */}
      {/* The title and the way out, nothing else: the agent's settings
          are one click away in the chat header already, and a second door
          to them here only crowded the panel. */}
      <div className="flex h-[52px] shrink-0 items-center justify-between border-b pl-4 pr-3">
        <span className="text-ui font-semibold text-foreground">Computer</span>
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
        {phase === "hosted" ? (
          <>
            <TakeTheWheel bot={bot} />
            <HostedDesktop bot={bot} desktop={Boolean(state.config?.hosted?.desktop)} />
          </>
        ) : bot.computer === "sandbox" && !hosted ? (
          <LocalVmCard bot={bot} />
        ) : (
          <>
        <TakeTheWheel bot={bot} />

        {/* Screen preview */}
        <div className="mb-1.5 mt-3 flex items-center justify-between text-body font-medium text-muted-foreground">
          <span>{bot.name}'s screen</span>
          {phase === "local" && <span className="text-caption font-normal">this computer</span>}
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
              <span className="text-small">
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
          <div className="mt-2 rounded-xl bg-destructive/10 px-3 py-2 text-small text-destructive">
            {error}
          </div>
        )}
        {phase === "unconfigured" && (
          <div className="mt-3 rounded-2xl border bg-card p-4">
            <div className="mb-3 text-body leading-relaxed text-muted-foreground">
              {ownScreen
                ? "Add a Boat API key to give this agent a cloud computer."
                : "Add a Boat API key to give this agent a cloud computer, or choose Local VM below for a free Linux desktop here."}
            </div>
            <ApiKeyRow
              bare
              section="box"
              label="Boat API key"
              placeholder="Paste your Boat API key"
              info={{
                text: "A private cloud Linux computer for your agents. Boat is paid after its trial.",
                linkLabel: "How to get a Boat API key",
                linkHref: "https://docs.boat.dev/api-keys",
              }}
              onSaved={(configured) => configured && setRetry((n) => n + 1)}
            />
          </div>
        )}

        {phase === "local" && <ComputerPermissions visible={visible} />}

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
          <div className="text-ui font-semibold text-foreground">Runs on</div>
          {/* The same homes the settings card offers, in the same shape,
              from the same list (src/lib/hosted.ts). One setting, two
              doors; they must never disagree about what the options are. */}
          <div className="mt-3 flex items-center justify-between gap-3">
            <div>
              <div className="text-body text-foreground">Automatic</div>
              <div className="text-small text-muted-foreground">
                {hosted
                  ? "This machine"
                  : ownScreen
                    ? "Cloud box if there is one, else this computer"
                    : "Cloud box if there is one, else none"}
              </div>
            </div>
            <Switch
              checked={!bot.computer}
              onCheckedChange={(on) =>
                dispatch({
                  type: "updateBot",
                  botId: bot.id,
                  patch: { computer: on ? null : ownScreen || hosted ? "local" : "sandbox" },
                })
              }
            />
          </div>
          {!hosted && !bot.computer && !state.config?.box?.configured && (
            <div className="mt-2 rounded-xl bg-muted/60 px-3 py-2 text-small text-muted-foreground">
              {ownScreen
                ? "No cloud box yet, so this computer is used."
                : "No cloud box yet, so it has no computer. Turn Automatic off and choose Local VM."}
            </div>
          )}
          <div
            className={cn(
              "mt-3 grid grid-cols-2 gap-1 rounded-xl bg-muted p-1 transition-opacity duration-150",
              !bot.computer && "pointer-events-none opacity-45",
            )}
          >
            {computerOptions(state.config?.hosted?.computers).map(([mode, label]) => (
              <button
                key={mode}
                onClick={() => dispatch({ type: "updateBot", botId: bot.id, patch: { computer: mode } })}
                className={cn(
                  "rounded-lg py-1.5 text-body transition-colors duration-150",
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
 * A hosted machine's virtual desktop, as noVNC draws it, through a ticket
 * the server mints for this panel (server/hosted.ts). Minted when the
 * panel opens and never kept: a ticket that lapses is replaced by opening
 * the panel again, and the address is not one to save or share.
 */
function HostedDesktop({ bot, desktop }: { bot: Bot; desktop: boolean }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!desktop) return;
    let alive = true;
    setUrl(null);
    setError(null);
    api("/api/hosted/desktop", { method: "POST", body: "{}" })
      .then((r) => alive && setUrl(r.url))
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [desktop, bot.id]);

  return (
    <>
      <div className="mb-1.5 mt-3 flex items-center justify-between text-body font-medium text-muted-foreground">
        <span>This machine's desktop</span>
        {url && (
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-caption font-normal hover:text-foreground"
          >
            <ExternalLink size={12} />
            Open
          </a>
        )}
      </div>
      <div className="flex aspect-[16/10] w-full items-center justify-center overflow-hidden rounded-xl border bg-muted/50">
        {url ? (
          <iframe title={`${bot.name}'s desktop`} src={url} referrerPolicy="no-referrer" className="h-full w-full border-0" />
        ) : (
          <div className="flex flex-col items-center gap-2 px-6 text-center text-muted-foreground">
            {desktop && !error ? <Loader2 size={18} className="animate-spin" /> : <Monitor size={22} />}
            <span className="text-small">
              {error ?? (desktop ? "Opening the desktop…" : `${bot.name} works in this machine's browser. No virtual desktop is set up to watch.`)}
            </span>
          </div>
        )}
      </div>
    </>
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
/**
 * The two macOS grants computer use needs, for Bloks itself. Shown only
 * when something is missing: a panel that is working has nothing to say
 * about permissions. Checked on a timer while open, because the person
 * grants them in System Settings, outside this window.
 */
function ComputerPermissions({ visible }: { visible: boolean }) {
  const [perms, setPerms] = useState<CuaPermissions | null>(null);
  const [asking, setAsking] = useState(false);
  const [asked, setAsked] = useState(false);

  useEffect(() => {
    if (!visible || !window.bloks?.cuaPermissions) return;
    let alive = true;
    const check = () =>
      window.bloks
        ?.cuaPermissions?.()
        .then((next) => alive && setPerms(next))
        .catch(() => {});
    void check();
    const timer = setInterval(check, 4000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [visible]);

  // Only Bloks' own grants are Bloks' to ask for. A developer's separate
  // CuaDriver install manages its own.
  if (!perms?.available || perms.owner !== "bloks") return null;
  const missing = [
    !perms.accessibility && { label: "Accessibility", pane: "accessibility" as const },
    !perms.screenRecording && { label: "Screen Recording", pane: "screen" as const },
  ].filter(Boolean) as Array<{ label: string; pane: "accessibility" | "screen" }>;
  if (!missing.length) return null;

  const ask = async () => {
    setAsking(true);
    const next = await window.bloks?.cuaRequestPermissions?.().catch(() => null);
    if (next) setPerms(next);
    setAsked(true);
    setAsking(false);
  };

  return (
    <div className="mt-3 rounded-2xl border bg-card p-4">
      <div className="text-body font-medium text-foreground">Computer use needs permission</div>
      <div className="mt-1 text-body leading-relaxed text-muted-foreground">
        To see and use {thisComputer()}, Bloks needs {missing.map((m) => m.label).join(" and ")}.
        {asked && " No prompt? Turn Bloks on in System Settings."}
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {!asked && (
          <Button size="sm" onClick={ask} disabled={asking}>
            {asking && <Loader2 size={14} className="animate-spin" />}
            Grant access
          </Button>
        )}
        {missing.map((m) => (
          <Button
            key={m.pane}
            size="sm"
            variant="secondary"
            onClick={() => window.bloks?.permOpenSettings(m.pane)}
          >
            Open {m.label} settings
          </Button>
        ))}
      </div>
    </div>
  );
}

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
        <div className="text-body text-foreground">
          {hold ? "You have the wheel" : "Take the wheel"}
        </div>
        <div className="mt-0.5 text-small leading-relaxed text-muted-foreground">
          {hold
            ? `${bot.name} waits until you hand it back` +
              (hold.turnedAway ? `. ${hold.turnedAway} ${hold.turnedAway === 1 ? "thing" : "things"} turned away so far.` : ".")
            : `Use it yourself. ${bot.name} waits while you do.`}
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
