// The terminal panel: a place to type, in the folder the agent works in.
//
// The shell lives on the server and outlives this component. Opening the
// panel attaches to whatever is already running and replays what it
// printed while you were away; closing it detaches and leaves the shell
// alone. That is the point of it being here rather than a spawn per open:
// a build you started is still going when you come back.
//
// Output arrives as base64 over an event stream, because the stream is
// bytes and a multi-byte character or an escape sequence split across two
// frames would arrive broken. Input goes back as a POST per keystroke
// burst, which is more requests than a socket would take and exactly as
// many round trips, over loopback to this same machine.
import { useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal as Xterm, type ITheme } from "@xterm/xterm";
import Loader2 from "lucide-react/dist/esm/icons/loader-2.js";
import RotateCw from "lucide-react/dist/esm/icons/rotate-cw.js";
import X from "lucide-react/dist/esm/icons/x.js";
import "@xterm/xterm/css/xterm.css";
import { api, type Bot } from "@/state/store";
import { useTheme } from "@/lib/theme";
import { cn } from "@/lib/cn";

interface TerminalInfo {
  botId: string;
  cwd: string;
  shell: string;
  pty: boolean;
  provider: string;
  cols: number;
  rows: number;
  startedAt: number;
  exitedAt?: number;
  exitCode?: number | null;
}

const MONO = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace';

/** A colour the app uses, as something a canvas can paint with. A token
 * may be written in any form CSS accepts, so it is put on a real element
 * and read back rather than parsed here. */
function resolve(name: string, fallback: string): string {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  if (!raw) return fallback;
  if (/^#|^rgb/.test(raw)) return raw;
  const probe = document.createElement("span");
  probe.style.cssText = "position:absolute;left:-9999px;visibility:hidden";
  probe.style.color = raw;
  document.body.appendChild(probe);
  const out = getComputedStyle(probe).color;
  probe.remove();
  return out || fallback;
}

function fade(color: string, alpha: number): string {
  const parts = color.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/);
  if (!parts) return color;
  return `rgba(${parts[1]}, ${parts[2]}, ${parts[3]}, ${alpha})`;
}

/**
 * The terminal wears the app's own colours rather than a stock palette,
 * so a red in here is the same red as everywhere else.
 */
function themeFor(dark: boolean): ITheme {
  const foreground = resolve("--foreground", dark ? "#ededf0" : "#18181b");
  const background = resolve("--card", dark ? "#17171a" : "#ffffff");
  const muted = resolve("--muted-foreground", dark ? "#8f8f99" : "#6f6f78");
  const red = resolve("--destructive", "#e5484d");
  const green = resolve("--success", "#2f9e68");
  const yellow = resolve("--warning", "#c47b0e");
  const blue = resolve("--ring", "#5b6cff");
  return {
    background,
    foreground,
    cursor: foreground,
    cursorAccent: background,
    selectionBackground: fade(resolve("--ring", "#5b6cff"), dark ? 0.32 : 0.2),
    selectionForeground: foreground,
    scrollbarSliderBackground: fade(resolve("--foreground", "#888"), 0.14),
    scrollbarSliderHoverBackground: fade(resolve("--foreground", "#888"), 0.24),
    scrollbarSliderActiveBackground: fade(resolve("--foreground", "#888"), 0.3),
    black: muted,
    brightBlack: muted,
    red,
    brightRed: red,
    green,
    brightGreen: green,
    yellow,
    brightYellow: yellow,
    blue,
    brightBlue: blue,
    magenta: blue,
    brightMagenta: blue,
    cyan: green,
    brightCyan: green,
    white: foreground,
    brightWhite: foreground,
  };
}

/** The last two parts of a path under a home tilde. A workspace folder is
 * named after an id nobody can read, so the whole thing in a header is
 * noise where the end of it is the answer. */
function shorten(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const parts = trimmed.split("/").filter(Boolean);
  if (parts.length <= 2) return trimmed || path;
  return `…/${parts.slice(-2).join("/")}`;
}

/** base64 off the wire to the bytes xterm decodes. */
function decode(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function TerminalPanel({ bot, onClose }: { bot: Bot; onClose: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<Xterm | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const stream = useRef<EventSource | null>(null);
  const [info, setInfo] = useState<TerminalInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [restarting, setRestarting] = useState(false);
  const { resolvedTheme } = useTheme();

  useEffect(() => {
    if (!host.current) return;
    let live = true;
    let pending = "";
    let flushing: number | null = null;

    const xterm = new Xterm({
      allowTransparency: false,
      cursorBlink: true,
      cursorStyle: "bar",
      fontFamily: MONO,
      fontSize: 13,
      lineHeight: 1.3,
      letterSpacing: 0,
      scrollback: 10_000,
      // the panel draws its own frame, so the terminal gets none
      theme: themeFor(document.documentElement.classList.contains("dark")),
    });
    const fitAddon = new FitAddon();
    xterm.loadAddon(fitAddon);
    xterm.loadAddon(new WebLinksAddon());
    xterm.open(host.current);
    term.current = xterm;
    fit.current = fitAddon;

    /**
     * Fit, but only against a box that has been laid out.
     *
     * The drawer is inserted and this effect runs before the browser has
     * given it a size, so fitting here measures nothing and the terminal
     * comes up two columns wide, which is not a subtle failure: every
     * line wraps to rubble. Nothing is fitted until the element has a
     * width, and the session is not opened until it has been.
     */
    const fitNow = (): boolean => {
      const box = host.current?.getBoundingClientRect();
      if (!box || box.width < 40 || box.height < 20) return false;
      try {
        fitAddon.fit();
      } catch {
        return false;
      }
      return true;
    };

    /** Keystrokes go out on the next tick: holding a key down should not
     * be one request per repeat. */
    const flush = () => {
      const data = pending;
      pending = "";
      flushing = null;
      if (!data) return;
      void api(`/api/bots/${bot.id}/terminal/input`, {
        method: "POST",
        body: JSON.stringify({ data }),
      }).catch(() => {});
    };
    xterm.onData((data) => {
      pending += data;
      if (flushing === null) flushing = window.setTimeout(flush, 8);
    });

    const listen = () => {
      stream.current?.close();
      const source = new EventSource(`/api/bots/${bot.id}/terminal/stream`);
      source.onmessage = (event) => {
        const frame = JSON.parse(event.data);
        if (frame.hello || frame.bye) {
          setInfo(frame.hello ?? frame.bye);
          return;
        }
        if (typeof frame.b64 === "string") xterm.write(decode(frame.b64));
      };
      source.onerror = () => {
        if (live) setError("The connection to the shell dropped.");
      };
      stream.current = source;
    };

    const open = async () => {
      // Fit if the drawer already has a size, and do not wait around if
      // it does not: eighty by twenty four is a sane terminal, and the
      // observer below corrects it the moment there is a box to measure.
      // Waiting on a frame would mean waiting forever in a window that is
      // not on screen, because animation frames stop there.
      fitNow();
      try {
        const { terminal } = await api(`/api/bots/${bot.id}/terminal`, {
          method: "POST",
          body: JSON.stringify({ cols: xterm.cols, rows: xterm.rows }),
        });
        if (!live) return;
        setInfo(terminal);
        setError(null);
        listen();
        xterm.focus();
        // The drawer has certainly been laid out by now even if it had
        // not when this started, so this is where the pty is told the
        // size the panel actually is.
        window.setTimeout(() => {
          if (!live || !fitNow()) return;
          void api(`/api/bots/${bot.id}/terminal/input`, {
            method: "POST",
            body: JSON.stringify({ cols: xterm.cols, rows: xterm.rows }),
          }).catch(() => {});
        }, 120);
      } catch (e) {
        if (live) setError((e as Error).message);
      }
    };
    void open();

    // Resize follows the panel, debounced: the pty's size is a line typed
    // into the shell, not something to send on every frame of a drag.
    let settle: number | null = null;
    const observer = new ResizeObserver(() => {
      if (settle) window.clearTimeout(settle);
      settle = window.setTimeout(() => {
        if (!fitNow()) return;
        void api(`/api/bots/${bot.id}/terminal/input`, {
          method: "POST",
          body: JSON.stringify({ cols: xterm.cols, rows: xterm.rows }),
        }).catch(() => {});
      }, 180);
    });
    observer.observe(host.current);

    return () => {
      live = false;
      if (flushing !== null) window.clearTimeout(flushing);
      if (settle) window.clearTimeout(settle);
      observer.disconnect();
      stream.current?.close();
      stream.current = null;
      xterm.dispose();
      term.current = null;
      fit.current = null;
    };
    // one shell per agent: a different agent is a different terminal
  }, [bot.id]);

  // The app's theme can change while this is open, and a terminal left in
  // the old one is the most obvious thing on the screen.
  useEffect(() => {
    if (term.current) term.current.options.theme = themeFor(resolvedTheme === "dark");
  }, [resolvedTheme]);

  /** Ends the shell and opens a new one. The way out of a wedged program
   * without having to know which key it wants. */
  const restart = async () => {
    setRestarting(true);
    try {
      await api(`/api/bots/${bot.id}/terminal`, { method: "DELETE" }).catch(() => {});
      term.current?.reset();
      const { terminal } = await api(`/api/bots/${bot.id}/terminal`, {
        method: "POST",
        body: JSON.stringify({ cols: term.current?.cols ?? 80, rows: term.current?.rows ?? 24 }),
      });
      setInfo(terminal);
      setError(null);
      stream.current?.close();
      const source = new EventSource(`/api/bots/${bot.id}/terminal/stream`);
      source.onmessage = (event) => {
        const frame = JSON.parse(event.data);
        if (frame.hello || frame.bye) {
          setInfo(frame.hello ?? frame.bye);
          return;
        }
        if (typeof frame.b64 === "string") term.current?.write(decode(frame.b64));
      };
      stream.current = source;
      term.current?.focus();
    } finally {
      setRestarting(false);
    }
  };

  const alive = Boolean(info && !info.exitedAt) && !error;

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-card">
      <div className="flex h-[34px] shrink-0 items-center gap-2 px-2.5">
        <span
          aria-hidden
          className={cn(
            "size-1.5 shrink-0 rounded-full transition-colors duration-300",
            alive ? "bg-success" : "bg-muted-foreground/40",
          )}
        />
        <span className="shrink-0 text-[12px] font-medium text-foreground">Terminal</span>
        <span
          title={info?.cwd}
          className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground"
        >
          {info ? shorten(info.cwd) : ""}
        </span>
        {info?.exitedAt ? (
          <button
            onClick={restart}
            className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10.5px] text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground"
          >
            {info.exitCode ? `exited ${info.exitCode}` : "exited"} · start a new one
          </button>
        ) : (
          info &&
          !info.pty && (
            <span
              title="Nothing on this system can open a pseudo-terminal, so full screen programs will not work here."
              className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
            >
              limited
            </span>
          )
        )}
        <button
          onClick={restart}
          disabled={restarting}
          title="End this shell and start a new one"
          className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground"
        >
          {restarting ? <Loader2 size={12} className="animate-spin" /> : <RotateCw size={12} />}
        </button>
        <button
          onClick={onClose}
          title="Close the panel. The shell keeps running."
          className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground"
        >
          <X size={13} />
        </button>
      </div>

      {error && (
        <div className="flex items-center justify-between gap-3 border-t bg-destructive/10 px-3 py-1.5 text-[11.5px] text-destructive">
          <span className="min-w-0 truncate">{error}</span>
          <button onClick={restart} className="shrink-0 font-medium underline underline-offset-2">
            Start a new one
          </button>
        </div>
      )}

      {/* The host is what xterm measures to decide how many columns fit,
          so it carries no padding of its own: see .term-host in
          styles.css, where the room goes inside the terminal instead.
          Clicking anywhere in here means you want to type. */}
      <div
        className="term-host min-h-0 flex-1 overflow-hidden pb-1.5"
        onMouseDown={() => term.current?.focus()}
      >
        <div ref={host} className="h-full min-h-0 w-full overflow-hidden" />
      </div>
    </div>
  );
}
