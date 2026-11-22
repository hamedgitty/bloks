// The terminal: a place to type, in the folder the agent works in.
//
// The shells live on the server and outlive this component. Opening the
// panel attaches to whatever is already running and replays what each
// shell printed while you were away; closing it detaches and leaves them
// alone. That is the point of them being there rather than a spawn per
// open: a build you started is still going when you come back.
//
// An agent can have several shells, drawn as tabs. Every tab keeps its own
// xterm alive while another is showing, laid out at full size and only
// made invisible, so switching tabs is instant, nothing reflows, and a
// hidden tab's screen is current the moment it is shown again.
//
// Output arrives as base64 on one event stream for all of an agent's
// shells (useTerminalStream), because the stream is bytes and a multi-byte
// character or an escape sequence split across two frames would arrive
// broken. Input goes back as a POST per keystroke burst, which is more
// requests than a socket would take and exactly as many round trips, over
// loopback to this same machine.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AnimatePresence, motion } from "motion/react";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal as Xterm, type ITheme } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { ArrowDown, Bot, Minimize2, Plus, X } from "@/components/icons";
import { confirm } from "@/components/ui/confirm";
import { toast } from "@/components/ui/toast";
import { HeaderButton, LayoutMenu, MoreMenu } from "@/components/terminal/TerminalMenus";
import { useTheme } from "@/lib/theme";
import { cn } from "@/lib/cn";
import { chordLabel, platformOf } from "@/lib/shortcuts";
import { arrangeTerminal } from "@/lib/terminalLayout";
import { activeAfterClose, stepTab, terminalChord } from "@/lib/terminalTabs";
import { keysOwner, keysWhere } from "@/lib/conversationKeys";
import { useTerminalLayout, useTerminalPrefs } from "@/lib/useTerminalSettings";
import { terminalApi, useTerminalStream, type TerminalInfo, type TerminalScreen } from "@/lib/useTerminalStream";
import { t } from "@/lib/i18n";

const MONO = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace';
/** As many as the server allows one agent (MAX_PER_AGENT). */
const MAX_TABS = 8;

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

/** What the panel can ask of one tab's screen. */
interface ViewHandle {
  focus(): void;
  clear(): void;
  size(): { cols: number; rows: number };
}

/**
 * One shell's screen. `info` is null for the moment before the first
 * shell exists: the screen is drawn anyway, so it can be measured, and the
 * shell is opened at exactly the size it will be shown at rather than at
 * a guess that has to be corrected by typing a resize into it.
 */
function TerminalView({
  botId,
  info,
  visible,
  register,
  onHandle,
  onSized,
  onRestart,
}: {
  botId: string;
  info: TerminalInfo | null;
  visible: boolean;
  register: (id: string, screen: TerminalScreen) => () => void;
  onHandle?: (handle: ViewHandle | null) => void;
  onSized?: (cols: number, rows: number) => void;
  onRestart?: () => void;
}) {
  const id = info?.id ?? null;
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<Xterm | null>(null);
  const refit = useRef<() => void>(() => {});
  const [prefs] = useTerminalPrefs();
  const prefsNow = useRef(prefs);
  prefsNow.current = prefs;
  const callbacks = useRef({ onHandle, onSized });
  callbacks.current = { onHandle, onSized };
  const [away, setAway] = useState(false);
  const { resolvedTheme } = useTheme();

  useEffect(() => {
    if (!host.current) return;
    let live = true;
    let pending = "";
    let flushing: number | null = null;
    // what the shell was last told its size is, so the same size is never
    // typed into it twice
    let told = info ? { cols: info.cols, rows: info.rows } : null;
    const platform = platformOf();
    // One request at a time, in order. Two in flight can arrive the other
    // way round, and keystrokes out of order are a different command.
    let sending: Promise<unknown> = Promise.resolve();
    const send = (body: { data?: string; cols?: number; rows?: number }) => {
      if (!id) return;
      sending = sending.then(() => terminalApi.input(botId, id, body).catch(() => {}));
    };

    const xterm = new Xterm({
      allowTransparency: false,
      cursorBlink: prefsNow.current.cursorBlink,
      cursorStyle: prefsNow.current.cursorStyle,
      fontFamily: MONO,
      fontSize: prefsNow.current.fontSize,
      lineHeight: 1.3,
      letterSpacing: 0,
      scrollback: prefsNow.current.scrollback,
      // the panel draws its own frame, so the terminal gets none
      theme: themeFor(document.documentElement.classList.contains("dark")),
    });
    const fitAddon = new FitAddon();
    xterm.loadAddon(fitAddon);
    xterm.loadAddon(new WebLinksAddon());
    xterm.open(host.current);
    term.current = xterm;

    // The app's own terminal keys (new tab, next tab and the rest) pass
    // through to the panel instead of being typed into the shell. Every
    // other key is the shell's.
    xterm.attachCustomKeyEventHandler((event) => terminalChord(event, platform) === null);

    const measureAway = () => {
      const buffer = xterm.buffer.active;
      setAway(buffer.viewportY < buffer.baseY);
    };
    xterm.onScroll(measureAway);
    xterm.onWriteParsed(measureAway);

    // Copy on select, when asked for: the selection is the clipboard, the
    // way it is in a Linux terminal.
    xterm.onSelectionChange(() => {
      if (!prefsNow.current.copyOnSelect || !xterm.hasSelection()) return;
      void navigator.clipboard?.writeText(xterm.getSelection()).catch(() => {});
    });

    const unregister = id
      ? register(id, {
          write: (bytes) => xterm.write(bytes),
          reset: () => xterm.reset(),
        })
      : () => {};

    /**
     * Fit, but only against a box that has been laid out.
     *
     * The panel is inserted and this effect runs before the browser has
     * given it a size, so fitting here can measure nothing and the
     * terminal would come up two columns wide, which is not a subtle
     * failure: every line wraps to rubble. Nothing is fitted until the
     * element has a width.
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
    /** Fit, and tell the shell if that changed its size. */
    const tell = () => {
      if (!live || !fitNow()) return;
      const size = { cols: xterm.cols, rows: xterm.rows };
      callbacks.current.onSized?.(size.cols, size.rows);
      if (!id || (told && told.cols === size.cols && told.rows === size.rows)) return;
      told = size;
      send(size);
    };
    refit.current = tell;

    /** Keystrokes go out on the next tick: holding a key down should not
     * be one request per repeat. */
    const flush = () => {
      const data = pending;
      pending = "";
      flushing = null;
      if (data) send({ data });
    };
    xterm.onData((data) => {
      pending += data;
      if (flushing === null) flushing = window.setTimeout(flush, 8);
    });

    // Fit if the panel already has a size, and again once it certainly
    // has. Waiting on an animation frame instead would wait forever in a
    // window that is not on screen, because frames stop there.
    tell();
    const settled = window.setTimeout(tell, 120);

    // Resize follows the panel, debounced: the pty's size is a line typed
    // into the shell, not something to send on every frame of a drag.
    let settle: number | null = null;
    const observer = new ResizeObserver(() => {
      if (settle) window.clearTimeout(settle);
      settle = window.setTimeout(tell, 180);
    });
    observer.observe(host.current);

    callbacks.current.onHandle?.({
      focus: () => xterm.focus(),
      clear: () => xterm.clear(),
      size: () => ({ cols: xterm.cols, rows: xterm.rows }),
    });

    return () => {
      live = false;
      if (flushing !== null) window.clearTimeout(flushing);
      if (settle) window.clearTimeout(settle);
      window.clearTimeout(settled);
      observer.disconnect();
      unregister();
      callbacks.current.onHandle?.(null);
      refit.current = () => {};
      xterm.dispose();
      term.current = null;
    };
    // one xterm per shell; a restarted shell keeps its id and its screen
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [botId, id, register]);

  // Preferences change for every tab at once, live.
  useEffect(() => {
    const xterm = term.current;
    if (!xterm) return;
    xterm.options.cursorStyle = prefs.cursorStyle;
    xterm.options.cursorBlink = prefs.cursorBlink;
    xterm.options.scrollback = prefs.scrollback;
    if (xterm.options.fontSize !== prefs.fontSize) {
      xterm.options.fontSize = prefs.fontSize;
      // a new cell size is a new number of columns
      refit.current();
    }
  }, [prefs]);

  // The app's theme can change while this is open, and a terminal left in
  // the old one is the most obvious thing on the screen.
  useEffect(() => {
    if (term.current) term.current.options.theme = themeFor(resolvedTheme === "dark");
  }, [resolvedTheme]);

  // Shown again: the box may have changed size while it was hidden.
  useEffect(() => {
    if (visible) refit.current();
  }, [visible]);

  const exited = info?.exitedAt;
  return (
    <div
      role="tabpanel"
      id={id ? `terminal-panel-${id}` : undefined}
      aria-labelledby={id ? `terminal-tab-${id}` : undefined}
      // invisible rather than unmounted or display:none, so a hidden tab
      // keeps its size and its screen, and showing it moves nothing
      className={cn("absolute inset-0 flex flex-col", !visible && "invisible")}
    >
      {/* an agent's own tab says so above its screen, and what it runs:
          the agent reads back what is printed here, typing included */}
      {info?.agent && (
        <div className="flex shrink-0 items-center gap-1.5 border-b bg-brand-soft/60 px-3 py-1 text-caption text-muted-foreground">
          <Bot size={12} className="shrink-0 text-brand-ink" aria-hidden />
          <span className="min-w-0 truncate" title={info.agent.command}>
            {t("terminal.agentTab", { name: info.agent.name, command: info.agent.command })}
          </span>
        </div>
      )}
      {/* The host is what xterm measures to decide how many columns fit,
          so it carries no padding of its own: see .term-host in
          styles.css, where the room goes inside the terminal instead.
          Clicking anywhere in here means you want to type. */}
      <div className="term-host relative min-h-0 flex-1 overflow-hidden pb-1.5" onMouseDown={() => term.current?.focus()}>
        <div ref={host} className="h-full min-h-0 w-full overflow-hidden" />
        <ScrollToBottom
          show={visible && away}
          onClick={() => {
            term.current?.scrollToBottom();
            term.current?.focus();
          }}
        />
      </div>
      {exited && (
        <div className="flex shrink-0 items-center justify-between gap-3 border-t bg-muted/60 px-3 py-1.5 text-small text-muted-foreground">
          <span className="min-w-0 truncate">
            {info?.exitCode ? t("terminal.exitedWith", { code: String(info.exitCode) }) : t("terminal.shellExited")}
          </span>
          <button
            type="button"
            onClick={onRestart}
            className="shrink-0 font-medium text-foreground underline underline-offset-2"
          >
            {t("terminal.startANewOne")}
          </button>
        </div>
      )}
    </div>
  );
}

/** The way back to the end of a terminal you scrolled up in. The same
 * pill the conversation has (chat/JumpToLatest.tsx), in the corner so it
 * never sits on the line being typed. */
function ScrollToBottom({ show, onClick }: { show: boolean; onClick: () => void }) {
  return (
    <div className="pointer-events-none absolute bottom-3 right-4 z-10">
      <AnimatePresence initial={false}>
        {show && (
          <motion.div
            key="bottom"
            initial={{ opacity: 0, y: 8, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 6, scale: 0.98, transition: { duration: 0.12, ease: "easeOut" } }}
            transition={{ duration: 0.2, ease: [0.23, 1, 0.32, 1] }}
            className="pointer-events-auto rounded-full shadow-[0_6px_20px_-6px_var(--shadow-color)]"
          >
            <button
              type="button"
              onClick={onClick}
              // keep the terminal's focus: a click here is not leaving it
              onMouseDown={(e) => e.preventDefault()}
              aria-label={t("terminal.scrollToTheBottom")}
              title={t("terminal.scrollToTheBottom")}
              className="flex size-8 items-center justify-center rounded-full border border-foreground/10 bg-background text-foreground transition-[background-color,scale] duration-150 ease-out hover:bg-accent active:scale-[0.96]"
            >
              <ArrowDown size={14} strokeWidth={2.25} />
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** Stands for whichever tab is open, in a request for the keyboard. */
const OPEN_TAB = "*";

/** The tab you had open for each agent, for as long as the app is. */
const lastActive = new Map<string, string>();
/** Panels to tell when a tab is asked for from outside them. */
const tabAsks = new Set<(botId: string, id: string) => void>();

// What an open panel's tabs are, for the side dock to draw each as a tab
// of its own (dock/SideDock.tsx, flat), and how it closes and adds one.
interface PanelTabs {
  tabs: readonly TerminalInfo[];
  current: string | null;
  close: (id: string) => void;
  add: () => void;
}
const panelTabs = new Map<string, PanelTabs>();
const tabListeners = new Set<() => void>();
const noTabs: PanelTabs | null = null;
function publishTabs(botId: string, tabs: PanelTabs | null) {
  if (tabs) panelTabs.set(botId, tabs);
  else panelTabs.delete(botId);
  for (const l of tabListeners) l();
}

/** One agent's terminal tabs as its open panel has them, or null while
 * no panel is drawn. */
export function useTerminalTabs(botId: string): PanelTabs | null {
  return useSyncExternalStore(
    (l) => {
      tabListeners.add(l);
      return () => void tabListeners.delete(l);
    },
    () => panelTabs.get(botId) ?? noTabs,
    () => noTabs,
  );
}

/** One of an agent's tabs brought to the front, by an agent's `bloks dock
 * show terminal <tab>`: the open panel switches to it, and a panel opened
 * later starts on it. Never takes the keyboard. */
export function showTerminalTab(botId: string, id: string) {
  lastActive.set(botId, id);
  for (const ask of tabAsks) ask(botId, id);
}

export type TerminalMode = "docked" | "fill" | "window";

/**
 * The panel: a strip of tabs, the menus, and the open tab's screen.
 *
 * Used in three places, which differ only in the header: docked beside
 * the chat, covering the whole window, and alone in a window of its own,
 * where there is nowhere to move it and the window's close is the close.
 */
export function TerminalPanel({
  botId,
  botName,
  mode,
  onClose,
  onPopOut,
  askNew = 0,
  focusNonce = 0,
  flat = false,
}: {
  botId: string;
  botName: string;
  mode: TerminalMode;
  /** Hide the panel. The shells keep running. */
  onClose: () => void;
  onPopOut?: () => void;
  /** Bumped to ask for a new tab (⌃⇧` while the panel was closed). */
  askNew?: number;
  /** Bumped to put the keyboard in the open tab, after the panel moved. */
  focusNonce?: number;
  /** In the side dock, whose strip draws each shell as a tab of its own:
   * no strip here, only the menu, floating over the screen. */
  flat?: boolean;
}) {
  const { list, lost, register } = useTerminalStream(botId);
  const [layout, setLayout] = useTerminalLayout();
  const [prefs, setPrefs] = useTerminalPrefs();
  const [active, setActiveState] = useState<string | null>(() => lastActive.get(botId) ?? null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const handles = useRef(new Map<string, ViewHandle>());
  const size = useRef<{ cols: number; rows: number } | null>(null);
  // the tab the keyboard should land in once its screen exists
  const wantsFocus = useRef<string | null>(null);
  const opening = useRef(false);
  const closingLast = useRef(false);
  const platform = platformOf();

  const tabs = list ?? [];
  const current = tabs.find((tab) => tab.id === active) ?? tabs[0] ?? null;
  const ids = tabs.map((tab) => tab.id);

  const setActive = useCallback(
    (id: string | null) => {
      if (id) lastActive.set(botId, id);
      setActiveState(id);
    },
    [botId],
  );

  // Focus is asked for here and given after the render that shows the
  // tab: a hidden tab's screen cannot take the keyboard, and the tab being
  // switched to is still hidden at the moment it is chosen.
  const [focusTick, setFocusTick] = useState(0);
  // No id means whichever tab is open, once there is one: the panel can
  // be asked for the keyboard before the server has said what its tabs are.
  const focusTab = useCallback((id: string | null) => {
    wantsFocus.current = id ?? OPEN_TAB;
    setFocusTick((n) => n + 1);
  }, []);
  useEffect(() => {
    const id = wantsFocus.current === OPEN_TAB ? (current?.id ?? null) : wantsFocus.current;
    const handle = id ? handles.current.get(id) : undefined;
    if (!handle || id !== current?.id) return;
    wantsFocus.current = null;
    handle.focus();
  }, [focusTick, current?.id]);

  // a tab asked for from outside (showTerminalTab)
  useEffect(() => {
    const ask = (forBot: string, id: string) => forBot === botId && setActiveState(id);
    tabAsks.add(ask);
    return () => void tabAsks.delete(ask);
  }, [botId]);

  // A different agent is a different set of tabs.
  useEffect(() => {
    setActiveState(lastActive.get(botId) ?? null);
    size.current = null;
    opening.current = false;
    closingLast.current = false;
  }, [botId]);

  /** The first shell, opened at the size the pending screen measured. */
  const ensure = useCallback(
    (cols: number, rows: number) => {
      size.current = { cols, rows };
      if (opening.current || closingLast.current) return;
      opening.current = true;
      terminalApi
        .ensure(botId, cols, rows)
        .then(({ terminal }) => {
          setActive(terminal.id);
          focusTab(terminal.id);
        })
        .catch((e: Error) => toast.error(e.message))
        .finally(() => {
          opening.current = false;
        });
    },
    [botId, setActive, focusTab],
  );

  const newTab = useCallback(async () => {
    if (tabs.length >= MAX_TABS) {
      toast(t("terminal.tooMany", { count: MAX_TABS }));
      return;
    }
    const { cols, rows } = size.current ?? { cols: 80, rows: 24 };
    try {
      const { terminal } = await terminalApi.create(botId, cols, rows);
      setActive(terminal.id);
      focusTab(terminal.id);
    } catch (e) {
      toast.error((e as Error).message);
    }
  }, [botId, tabs.length, setActive, focusTab]);

  const closeTab = useCallback(
    async (id: string) => {
      const tab = tabs.find((tab) => tab.id === id);
      if (!tab) return;
      const busy = await terminalApi.busy(botId, id).catch(() => ({ running: false, command: undefined }));
      if (busy.running) {
        const yes = await confirm({
          title: t("terminal.closeQuestion", { title: tab.title }),
          body: busy.command ? t("terminal.commandStillRunning", { command: busy.command }) : t("terminal.somethingStillRunning"),
          confirmLabel: t("common.close"),
          destructive: true,
        });
        if (!yes) return focusTab(current?.id ?? null);
      }
      const last = tabs.length === 1;
      if (last) closingLast.current = true;
      const next = activeAfterClose(ids, id, current?.id ?? null);
      setActive(next);
      try {
        await terminalApi.close(botId, id);
      } catch (e) {
        closingLast.current = false;
        toast.error((e as Error).message);
        return;
      }
      if (last) onClose();
      else focusTab(next);
    },
    [botId, tabs, ids, current, setActive, focusTab, onClose],
  );

  const rename = useCallback(
    (id: string, title: string) => {
      setRenaming(null);
      const before = tabs.find((tab) => tab.id === id)?.title;
      if (!title.trim() || title.trim() === before) return focusTab(id);
      terminalApi.rename(botId, id, title).catch((e: Error) => toast.error(e.message));
      focusTab(id);
    },
    [botId, tabs, focusTab],
  );

  const restart = useCallback(
    async (id: string) => {
      const { cols, rows } = handles.current.get(id)?.size() ?? size.current ?? { cols: 80, rows: 24 };
      try {
        await terminalApi.restart(botId, id, cols, rows);
        focusTab(id);
      } catch (e) {
        toast.error((e as Error).message);
      }
    },
    [botId, focusTab],
  );

  const clear = useCallback(
    (id: string) => {
      handles.current.get(id)?.clear();
      // and on the server, or the next time this is opened it all comes back
      void terminalApi.clear(botId, id).catch(() => {});
    },
    [botId],
  );

  const select = (id: string) => {
    setActive(id);
    focusTab(id);
  };

  // The keys, while the panel is open. ⌃` itself belongs to the
  // conversation, which is what shows and hides this.
  const keys = useRef({ newTab, closeTab, select, ids, current, mode, setLayout });
  keys.current = { newTab, closeTab, select, ids, current, mode, setLayout };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const chord = terminalChord(e, platform);
      if (!chord || chord === "toggle") return;
      const k = keys.current;
      const inside = Boolean(root.current?.contains(document.activeElement));
      // closing is the one that ends something, so it is only heard from
      // inside the terminal
      if (chord === "close" && !inside) return;
      // ⌘⇧[ and ⌘⇧] step the conversation's tabs too: the terminal's
      // while it has the keyboard or the window, theirs otherwise
      // (conversationKeys.ts)
      const step = chord === "next" || chord === "previous";
      const where = { inTerminal: inside, terminalCovers: k.mode !== "docked", inDialog: keysWhere().inDialog };
      if (step && keysOwner(where) !== "terminal") return;
      if (chord === "fill" && k.mode === "window") return;
      e.preventDefault();
      if (chord === "new") void k.newTab();
      else if (chord === "close" && k.current) void k.closeTab(k.current.id);
      else if (chord === "next" || chord === "previous") {
        const next = stepTab(k.ids, k.current?.id ?? null, chord === "next" ? 1 : -1);
        if (next) k.select(next);
      } else if (chord === "fill") k.setLayout((l) => arrangeTerminal(l, "fill"));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [platform]);

  // ⌃⇧` while the panel was closed opened it; once the tabs are known, a
  // new one is added unless the panel is about to open the first anyway.
  const askedNew = useRef(0);
  const loaded = list !== null;
  // what the dock's strip draws, while this panel is drawn
  useEffect(() => {
    publishTabs(botId, { tabs, current: current?.id ?? null, close: (id) => void closeTab(id), add: () => void newTab() });
  }, [botId, tabs, current?.id, closeTab, newTab]);
  useEffect(() => () => publishTabs(botId, null), [botId]);
  useEffect(() => {
    if (!loaded || askNew === askedNew.current) return;
    askedNew.current = askNew;
    if (tabs.length > 0) void newTab();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [askNew, loaded]);

  useEffect(() => {
    if (focusNonce) focusTab(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusNonce]);

  // the title of a window that is only this terminal
  useEffect(() => {
    if (mode !== "window") return;
    document.title = current ? `${current.title} · ${botName}` : t("terminal.windowTitle", { name: botName });
  }, [mode, current, botName]);

  const fill = mode === "fill";
  const mac = platform === "mac";
  // Covering the whole window, the header is the window's handle, and in
  // the Mac app it starts after the traffic lights (BUTTONS in
  // electron/main.mjs) rather than under them.
  const underLights = fill && mac && navigator.userAgent.includes("Electron");
  const stepKeys = `${chordLabel(["Mod", "Shift", "["], platform)} ${chordLabel(["Mod", "Shift", "]"], platform)}`;

  return (
    <div
      ref={root}
      role="region"
      aria-label={t("terminal.regionLabel", { name: botName })}
      // where the conversation looks to tell whose ⌘⇧] it is
      data-terminal-panel={mode}
      className={cn("flex h-full min-h-0 w-full min-w-0 flex-col bg-card", flat && "relative")}
    >
      <div
        className={cn(
          "flex h-[38px] shrink-0 items-center gap-1 px-1.5",
          fill && "titlebar-drag",
          underLights && "pl-[84px]",
          // in the dock its tabs are the dock's; only the menu stays, in
          // the screen's corner
          flat && "absolute right-1.5 top-1 z-10 h-8 rounded-lg bg-card/90 px-0.5 opacity-70 shadow-sm transition-opacity duration-150 hover:opacity-100 focus-within:opacity-100",
        )}
      >
        <div
          role="tablist"
          hidden={flat}
          aria-label={t("terminal.terminalTabs")}
          aria-orientation="horizontal"
          className="flex min-w-0 items-center gap-0.5 overflow-x-auto [scrollbar-width:none]"
          onKeyDown={(e) => {
            // the arrows move between tabs, as in any tab strip
            if (!current || renaming) return;
            const by = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
            if (by) {
              e.preventDefault();
              const next = stepTab(ids, current.id, by as 1 | -1);
              if (next) {
                setActive(next);
                document.getElementById(`terminal-tab-${next}`)?.focus();
              }
            } else if (e.key === "Home" || e.key === "End") {
              e.preventDefault();
              const next = e.key === "Home" ? ids[0] : ids[ids.length - 1];
              setActive(next);
              document.getElementById(`terminal-tab-${next}`)?.focus();
            } else if (e.key === "F2") {
              e.preventDefault();
              setRenaming(current.id);
            }
          }}
        >
          {tabs.map((tab) => {
            const open = tab.id === current?.id;
            if (renaming === tab.id) {
              return <RenameField key={tab.id} title={tab.title} onDone={(title) => rename(tab.id, title)} />;
            }
            return (
              <div key={tab.id} className="group relative flex shrink-0 items-center">
                <button
                  type="button"
                  role="tab"
                  id={`terminal-tab-${tab.id}`}
                  aria-selected={open}
                  aria-controls={`terminal-panel-${tab.id}`}
                  tabIndex={open ? 0 : -1}
                  onClick={() => select(tab.id)}
                  onDoubleClick={() => setRenaming(tab.id)}
                  title={`${tab.title}\n${tab.agent ? `${t("terminal.agentTab", { name: tab.agent.name, command: tab.agent.command })}\n` : ""}${tab.cwd}\n${t("terminal.tabHint", { keys: stepKeys })}`}
                  className={cn(
                    "flex h-7 max-w-[176px] items-center gap-1.5 rounded-md pl-2.5 pr-7 text-body outline-none transition-colors duration-150",
                    open ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                  )}
                >
                  {tab.exitedAt && (
                    <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-muted-foreground/50" />
                  )}
                  {/* an agent's own tab wears its badge: it started it and
                      reads it back, where the person's tabs are theirs */}
                  {tab.agent && (
                    <Bot size={12} className="shrink-0 text-brand-ink" aria-label={t("terminal.agentBadge", { name: tab.agent.name })} />
                  )}
                  <span className="truncate">{tab.title}</span>
                  {tab.exitedAt && <span className="sr-only">{t("terminal.exited")}</span>}
                </button>
                <button
                  type="button"
                  // the keyboard closes a tab with ⌃⇧W or from the menu,
                  // so these stay out of the tab order
                  tabIndex={-1}
                  aria-label={t("terminal.closeNamed", { title: tab.title })}
                  title={t("terminal.closeNamed", { title: tab.title })}
                  onClick={() => void closeTab(tab.id)}
                  className={cn(
                    "absolute right-1 flex size-5 items-center justify-center rounded text-muted-foreground transition-[opacity,background-color,color] duration-150 hover:bg-foreground/10 hover:text-foreground",
                    open ? "opacity-100" : "opacity-0 group-hover:opacity-100",
                  )}
                >
                  <X size={12} />
                </button>
              </div>
            );
          })}
        </div>
        {!flat && (
          <HeaderButton label={t("terminal.newTerminalTab")} onClick={() => void newTab()} disabled={!loaded || tabs.length >= MAX_TABS}>
            <Plus size={16} />
          </HeaderButton>
        )}
        {!flat && <div className="min-w-2 flex-1 self-stretch" />}
        {current && !current.pty && (
          <span
            title={t("terminal.fullScreenProgramsWontWork")}
            className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-micro text-muted-foreground"
          >
            {t("terminal.limited")}
          </span>
        )}
        <MoreMenu
          prefs={prefs}
          onPrefs={setPrefs}
          hasTab={Boolean(current)}
          onClear={() => current && clear(current.id)}
          onRestart={() => current && void restart(current.id)}
          onRename={() => current && setRenaming(current.id)}
          onCloseTab={() => current && void closeTab(current.id)}
          onClosed={() => !renaming && focusTab(current?.id ?? null)}
        />
        {mode !== "window" && !flat && (
          <LayoutMenu
            layout={layout}
            onLayout={setLayout}
            onPopOut={onPopOut}
            onClosed={() => focusTab(current?.id ?? null)}
          />
        )}
        {fill && (
          <HeaderButton label={t("terminal.leaveTheFullWindow")} onClick={() => setLayout((l) => arrangeTerminal(l, "fill"))}>
            <Minimize2 size={15} />
          </HeaderButton>
        )}
        {mode !== "window" && !flat && (
          <HeaderButton label={t("terminal.hideTheTerminalItsShells")} onClick={onClose}>
            <X size={16} />
          </HeaderButton>
        )}
      </div>

      {lost && (
        <div role="status" className="shrink-0 border-t bg-destructive/10 px-3 py-1.5 text-small text-destructive">
          {t("terminal.lostTheConnectionToThe")}
        </div>
      )}

      <div className="relative min-h-0 flex-1">
        {loaded && tabs.length === 0 && (
          // Nothing open yet: a screen to measure, and the first shell is
          // opened at its size (see TerminalView).
          <TerminalView key="first" botId={botId} info={null} visible register={register} onSized={ensure} />
        )}
        {tabs.map((tab) => (
          <TerminalView
            key={tab.id}
            botId={botId}
            info={tab}
            visible={tab.id === current?.id}
            register={register}
            onSized={(cols, rows) => {
              if (tab.id === current?.id) size.current = { cols, rows };
            }}
            onHandle={(handle) => {
              if (handle) {
                handles.current.set(tab.id, handle);
                if (wantsFocus.current === tab.id || wantsFocus.current === OPEN_TAB) setFocusTick((n) => n + 1);
              } else handles.current.delete(tab.id);
            }}
            onRestart={() => void restart(tab.id)}
          />
        ))}
      </div>
    </div>
  );
}

/** A tab being renamed: Enter or leaving keeps the name, Escape does not. */
function RenameField({ title, onDone }: { title: string; onDone: (title: string) => void }) {
  const done = useRef(false);
  const finish = (value: string) => {
    if (done.current) return;
    done.current = true;
    onDone(value);
  };
  return (
    <input
      autoFocus
      defaultValue={title}
      aria-label={t("terminal.tabName")}
      maxLength={40}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={(e) => finish(e.currentTarget.value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          finish(e.currentTarget.value);
        } else if (e.key === "Escape") {
          // handled here, so it neither closes the panel nor the window
          e.preventDefault();
          finish(title);
        }
      }}
      className="h-7 w-[150px] shrink-0 rounded-md border bg-background px-2 text-body text-foreground outline-none"
    />
  );
}
