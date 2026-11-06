// The Bloks browser beside the chat, wherever it lives.
//
// In the desktop app, on a workspace this computer runs, the page itself
// is not drawn here. Each tab is a view the app lays over the window
// (electron/app-browser.mjs), so this panel draws everything around it,
// the tabs, the address bar, who has the wheel, the downloads, and keeps
// one empty box where the page goes, telling the app where that box is
// whenever it moves. A native view sits above the page, so while a
// dialog or a menu is open the box is said to be off screen, and the tab
// hides until it closes.
//
// On a workspace whose server keeps the browser itself (bloks-server, the
// Docker image), the same panel draws the page too, as the pictures the
// server sends (server/server-browser.ts), in the app, at the web door
// and on a phone alike. The person's clicks, scrolls and keys on the
// picture go back to the page; the box tells the server its size, which
// the page lays out at.
//
// Elsewhere (a phone, the web app, on a workspace the desktop app runs)
// there is no browser, only news of the Mac's: a strip in the agent's
// conversation, with a small live picture when the Mac can send one.
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { api, useStore } from "@/state/store";
import { cn } from "@/lib/cn";
import {
  ArrowLeft,
  ArrowRight,
  Download,
  ExternalLink,
  File as FileIcon,
  FolderOpen,
  Globe,
  Hand,
  Keyboard,
  Loader2,
  Lock,
  MessageSquare,
  Plus,
  RotateCw,
  X,
} from "@/components/icons";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { AgentAvatar } from "@/components/Avatar";
import { HeaderButton } from "@/components/terminal/TerminalMenus";
import { platformOf } from "@/lib/shortcuts";
import {
  BROWSER_SIDE_BY_SIDE,
  browserHome,
  browsingFor,
  clampBrowserWidth,
  closeKey,
  closesPanel,
  controlLine,
  dialogBar,
  downloadSize,
  hostLabel,
  isSecure,
  refreshBrowser,
  setBrowserPanel,
  shownAddress,
  tabLabel,
  useAppBrowser,
  useBrowserHome,
  useBrowserPanel,
  type AppBrowserState,
  type BrowserControl,
  type BrowserDialog,
  type BrowserDo,
  type DialogAnswer,
  type BrowserMissing,
  type BrowserTab,
  type ScreenFrame,
} from "@/lib/appBrowser";
import { t } from "@/lib/i18n";
import { sameAddress } from "@/lib/mentions";
import { screenInput, type InputSender } from "./screenInput";

/** The server's word on the browser, for a page that does not have the
 * app's own; its "browser.app" frames keep it fresh after this. */
const loadFromServer = () => api("/api/browser");

/** The browser's state, wherever this page is. */
export function useBrowserState(): AppBrowserState | null {
  return useAppBrowser(loadFromServer);
}

/** Where the browser is: the app's own, the server's, or elsewhere. */
export function useBrowserWhere() {
  return useBrowserHome(loadFromServer);
}

const said = (answer: { ok?: boolean; error?: string; url?: string } | null) => {
  if (answer?.error) toast.error(answer.error);
  return answer;
};

const failed = (error: unknown) => {
  toast.error(error instanceof Error ? error.message : String(error));
  return null;
};

/** What the person does in the panel: asked of the app for its own
 * browser, of the server for one it keeps. */
const act = (action: BrowserDo, arg?: string | DialogAnswer) =>
  browserHome() === "server"
    ? api("/api/browser/do", { method: "POST", body: JSON.stringify({ action, ...(arg === undefined ? {} : { arg }) }) }).then(said, failed)
    : (window.bloks?.browserDo?.(action, arg) ?? Promise.resolve(null)).then(said, failed);

/** A page of the server's browser in the person's own browser: only an
 * address crosses, never a sign-in. */
const openOutside = (url: string | undefined) => {
  if (url && /^https?:\/\//i.test(url)) window.open(url, "_blank", "noopener,noreferrer");
};

/**
 * A page the person asked to see from a chip in the chat: the tab that
 * still shows it, or a new tab at its address once it has closed, with
 * the panel open on it. Where this page has no browser it can drive (a
 * phone looking at the Mac's workspace), the address opens outside.
 */
export async function showPage(url: string, tabs: readonly BrowserTab[] | undefined): Promise<void> {
  const home = browserHome();
  if (home !== "own" && home !== "server") return openOutside(url);
  setBrowserPanel({ open: true });
  const tab = tabs?.find((t) => sameAddress(t.url, url));
  if (tab) {
    await act("selectTab", tab.id);
    return;
  }
  const made = await act("newTab");
  if (made?.ok) await act("navigate", url);
}

/** The app asking for the panel because an agent started browsing: the
 * person watches it happen rather than finding out after. */
export function useBrowserReveal() {
  useEffect(() => {
    if (!window.bloks?.onBrowserReveal) return;
    return window.bloks.onBrowserReveal(() => setBrowserPanel({ open: true }));
  }, []);
}

/** Something drawn over the page (a dialog, a menu, the palette), which a
 * native view would otherwise cover. */
const OVER_THE_PAGE = '[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"],[data-radix-popper-content-wrapper]';

function useSomethingOver(panel: HTMLElement | null, watching: boolean): boolean {
  const [over, setOver] = useState(false);
  useEffect(() => {
    if (!watching) return setOver(false);
    let frame = 0;
    const check = () => {
      frame = 0;
      const found = [...document.querySelectorAll(OVER_THE_PAGE)].some((el) => !panel?.contains(el));
      setOver((was) => (was === found ? was : found));
    };
    check();
    // at most once a frame: a streaming reply changes the page constantly
    const soon = () => {
      if (!frame) frame = requestAnimationFrame(check);
    };
    const watch = new MutationObserver(soon);
    watch.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["role", "data-state"] });
    return () => {
      watch.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [panel, watching]);
  return over;
}

/**
 * The panel, docked on the chat's right, or over the chat when the window
 * is too narrow for both. Drawn where this page can show the browser:
 * the desktop app's own, or the one the server keeps.
 */
export function BrowserDock({ botNames }: { botNames?: Record<string, string> }) {
  const { open, width } = useBrowserPanel();
  const { home } = useBrowserWhere();
  const [room, setRoom] = useState(0);
  const [dragging, setDragging] = useState<number | null>(null);
  const [holder, setHolder] = useState<HTMLDivElement | null>(null);

  // the room the chat and the panel share, measured on the row they share
  useLayoutEffect(() => {
    const row = holder?.parentElement;
    if (!row) return;
    const measure = () => setRoom(row.getBoundingClientRect().width);
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(row);
    return () => watch.disconnect();
  }, [holder]);

  // a server's browser may have come to be since the page loaded
  useEffect(() => {
    if (open) refreshBrowser(loadFromServer);
  }, [open]);

  if (!open || (home !== "own" && home !== "server")) return null;
  const narrow = room > 0 && room < BROWSER_SIDE_BY_SIDE;
  const shown = narrow ? room : clampBrowserWidth(dragging ?? width, room || window.innerWidth);
  return (
    <>
      {!narrow && (
        <Edge
          width={shown}
          room={room}
          onDrag={setDragging}
          onDone={(next) => {
            setDragging(null);
            setBrowserPanel({ width: next });
          }}
        />
      )}
      <div
        ref={setHolder}
        className={cn("flex min-h-0 min-w-0 shrink-0 flex-col border-l bg-card", narrow && "absolute inset-0 z-30 border-l-0")}
        style={narrow ? undefined : { width: shown }}
      >
        <BrowserPanel resizing={dragging !== null} botNames={botNames} onServer={home === "server"} />
      </div>
    </>
  );
}

/** The edge between the chat and the panel: drag it, or focus it and use
 * the arrow keys (Shift for bigger steps). */
function Edge({ width, room, onDrag, onDone }: { width: number; room: number; onDrag: (w: number) => void; onDone: (w: number) => void }) {
  const clamp = (w: number) => clampBrowserWidth(w, room || window.innerWidth);
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={t("browserPanel.resizeTheBrowser")}
      aria-valuenow={Math.round(width)}
      tabIndex={0}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        e.preventDefault();
        const start = e.clientX;
        let last = width;
        const move = (event: PointerEvent) => {
          last = clamp(width + (start - event.clientX));
          onDrag(last);
        };
        const up = () => {
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", up);
          window.removeEventListener("pointercancel", up);
          onDone(last);
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
        window.addEventListener("pointercancel", up);
      }}
      onKeyDown={(e) => {
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
        e.preventDefault();
        const step = (e.shiftKey ? 64 : 16) * (e.key === "ArrowLeft" ? 1 : -1);
        onDone(clamp(width + step));
      }}
      className="w-1.5 shrink-0 cursor-ew-resize bg-transparent outline-none transition-colors duration-150 hover:bg-accent focus-visible:bg-accent"
    />
  );
}

function BrowserPanel({ resizing, botNames, onServer }: { resizing: boolean; botNames?: Record<string, string>; onServer: boolean }) {
  const state = useBrowserState();
  const { missing } = useBrowserWhere();
  const { state: store } = useStore();
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const page = useRef<HTMLDivElement>(null);
  const over = useSomethingOver(root, !onServer);
  const [shelf, setShelf] = useState(false);
  const active = state?.tabs.find((t) => t.id === state.activeTabId) ?? null;
  const line = controlLine(state?.control);
  const absent = onServer && missing !== null;

  // Where the page goes, said to the app whenever it moves, and "nowhere"
  // while something is drawn over it, while the edge is dragged (the view
  // would lag the drag a frame behind) and once the panel is gone. A
  // server's browser draws its page here instead, and needs none of it.
  const report = useCallback(() => {
    if (onServer) return;
    const box = page.current?.getBoundingClientRect();
    const hidden = !box || over || resizing || document.visibilityState === "hidden";
    void window.bloks?.browserBounds?.(hidden ? null : { x: box.left, y: box.top, width: box.width, height: box.height });
  }, [over, resizing, onServer]);
  useLayoutEffect(() => {
    if (onServer) return;
    let frame = 0;
    const soon = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(report);
    };
    soon();
    const watch = new ResizeObserver(soon);
    if (page.current) watch.observe(page.current);
    window.addEventListener("resize", soon);
    document.addEventListener("visibilitychange", soon);
    return () => {
      cancelAnimationFrame(frame);
      watch.disconnect();
      window.removeEventListener("resize", soon);
      document.removeEventListener("visibilitychange", soon);
    };
  }, [report, state?.activeTabId, shelf, line?.text, active?.dialog?.id, onServer]);
  useEffect(() => () => void (onServer ? undefined : window.bloks?.browserBounds?.(null)), [onServer]);

  // a download starting opens the shelf, so it is seen arriving
  const newest = state?.downloads[0]?.id;
  const seenNewest = useRef(newest);
  useEffect(() => {
    if (newest && newest !== seenNewest.current) setShelf(true);
    seenNewest.current = newest;
  }, [newest]);

  const close = () => setBrowserPanel({ open: false });
  // The person's own last tab closed, here or on another screen of theirs:
  // the panel goes with it. An agent's closing it stays open on the empty
  // page (closesPanel). The close it opened already knowing of changes
  // nothing.
  const seenClose = useRef<string | null>(null);
  useEffect(() => {
    if (!state) return;
    const was = seenClose.current;
    seenClose.current = closeKey(state.closed);
    if (was !== null && closesPanel(state.closed, was)) close();
  }, [state?.closed]); // eslint-disable-line react-hooks/exhaustive-deps
  const tabs = state?.tabs ?? [];
  const nameOf = (botId: string, fallback: string) => botNames?.[botId] ?? fallback;

  return (
    <div ref={setRoot} role="region" aria-label={t("browserPanel.bloksBrowser")} className="flex h-full min-h-0 w-full min-w-0 flex-col bg-card">
      <div className="flex h-[38px] shrink-0 items-center gap-1 px-1.5">
        <Tabs tabs={tabs} activeId={state?.activeTabId ?? null} faces={store.bots} nameOf={nameOf} />
        <HeaderButton label={t("browserPanel.newTab")} disabled={absent} onClick={() => void act("newTab")}>
          <Plus size={16} />
        </HeaderButton>
        <div className="min-w-2 flex-1 self-stretch" />
        <HeaderButton label={t("browserPanel.hideTheBrowserItsTabs")} onClick={close}>
          <X size={16} />
        </HeaderButton>
      </div>

      <div className="flex shrink-0 items-center gap-1 border-t px-1.5 py-1.5">
        <HeaderButton label={t("common.back")} disabled={!active?.canGoBack} onClick={() => void act("back")}>
          <ArrowLeft size={15} />
        </HeaderButton>
        <HeaderButton label={t("browserPanel.forward")} disabled={!active?.canGoForward} onClick={() => void act("forward")}>
          <ArrowRight size={15} />
        </HeaderButton>
        <HeaderButton label={active?.loading ? t("browserPanel.stopLoading") : t("browserPanel.reload")} disabled={!active} onClick={() => void act(active?.loading ? "stop" : "reload")}>
          {active?.loading ? <X size={15} /> : <RotateCw size={15} />}
        </HeaderButton>
        <AddressBar key={active?.id ?? "none"} tab={active} disabled={absent} />
        <HeaderButton
          label={t("browserPanel.openThisPageInYour")}
          disabled={!hostLabel(active?.url)}
          onClick={() => (onServer ? openOutside(active?.url) : void act("openExternal"))}
        >
          <ExternalLink size={15} />
        </HeaderButton>
        <HeaderButton label={t("browserPanel.downloads")} pressed={shelf} onClick={() => setShelf((s) => !s)} className="relative">
          <Download size={15} />
          {state?.downloads.some((d) => d.state === "progressing") && (
            <span aria-hidden className="absolute right-1 top-1 size-1.5 animate-pulse rounded-full bg-brand" />
          )}
        </HeaderButton>
      </div>

      {line && (
        <div
          role="status"
          className={cn(
            "flex shrink-0 items-center gap-2 border-t px-3 py-1.5 text-small",
            line.tone === "agent" ? "bg-brand-soft text-foreground" : "bg-muted text-foreground",
          )}
        >
          {line.tone === "agent" ? (
            <span aria-hidden className="relative flex size-2 shrink-0">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-brand opacity-60" />
              <span className="relative inline-flex size-2 rounded-full bg-brand" />
            </span>
          ) : (
            <Hand size={13} className="shrink-0 text-muted-foreground" aria-hidden />
          )}
          <span className="min-w-0 flex-1 truncate">{line.text}</span>
          <Button size="sm" variant={line.action === "takeOver" ? "secondary" : "brand"} className="h-6 shrink-0 px-2.5 text-small" onClick={() => void act(line.action)}>
            {line.action === "takeOver" ? t("browserPanel.takeOver") : t("browserPanel.giveBack")}
          </Button>
        </div>
      )}

      {active?.dialog && <DialogBar key={active.dialog.id} dialog={active.dialog} url={active.url} control={state?.control} />}

      {/* where the page goes: the app's view over it, or the server's
          pictures in it; what shows here otherwise is only ever seen when
          there is no page, or something is drawn over it */}
      <div ref={page} className="relative min-h-0 flex-1 overflow-hidden border-t bg-background">
        {absent ? (
          <NoBrowserHere missing={missing!} />
        ) : !active ? (
          <div className="flex h-full flex-col items-center justify-center gap-1.5 px-6 text-center">
            <div className="mb-1 flex size-9 items-center justify-center rounded-xl bg-muted text-muted-foreground">
              <Globe size={18} />
            </div>
            <p className="text-ui font-medium text-foreground">{t("browserPanel.nothingOpenYet")}</p>
            <p className="max-w-[40ch] text-pretty text-body text-muted-foreground">
              {t("browserPanel.typeAnAddressAboveOr")}
            </p>
          </div>
        ) : onServer ? (
          <Screen tab={active} control={state?.control} />
        ) : over ? (
          <div className="flex h-full items-center justify-center px-6 text-center text-small text-muted-foreground">
            {t("browserPanel.thePageIsHiddenWhile")}
          </div>
        ) : null}
        {/* a server's browser is sized to this box even before a page is
            open, so the first one lays out at the panel's width */}
        {onServer && !absent && <SizeReporter />}
      </div>

      {shelf && <Shelf downloads={state?.downloads ?? []} onServer={onServer} onClose={() => setShelf(false)} />}
    </div>
  );
}

/** Why a server has no browser to show, and what would give it one. */
function NoBrowserHere({ missing }: { missing: BrowserMissing }) {
  return (
    <div role="status" className="flex h-full flex-col items-center justify-center gap-1.5 px-6 text-center">
      <div className="mb-1 flex size-9 items-center justify-center rounded-xl bg-muted text-muted-foreground">
        <Globe size={18} />
      </div>
      <p className="text-ui font-medium text-foreground">{missing === "off" ? t("browserPanel.turnedOffOnServer") : t("browserPanel.noChromeOnServer")}</p>
      <p className="max-w-[44ch] text-pretty text-body text-muted-foreground">
        {missing === "off" ? t("browserPanel.turnedOffBody") : missing === "path" ? t("browserPanel.wrongChromeBody") : t("browserPanel.noChromeBody")}
      </p>
    </div>
  );
}

/**
 * A page's alert, confirm, prompt or "leave this page?", over the page
 * rather than on it: in the app the page is a view nothing can be drawn
 * over, and a server's headless Chrome draws no dialog at all. Answered
 * here while the person has the wheel; while an agent drives, it is the
 * agent's to answer, and the bar says it waits. Never takes the focus:
 * it may come up while the person is typing in the chat.
 */
function DialogBar({ dialog, url, control }: { dialog: BrowserDialog; url: string; control: BrowserControl | undefined }) {
  const bar = dialogBar(dialog, url, control);
  const [text, setText] = useState(dialog.defaultPrompt ?? "");
  const [busy, setBusy] = useState(false);
  const id = useId();
  const answer = async (accept: boolean) => {
    if (busy) return;
    setBusy(true);
    const said = await act("answerDialog", { id: dialog.id, accept, ...(bar.field && accept ? { text } : {}) });
    setBusy(false);
    // the app had to stay on the page before anybody was asked: the yes
    // lets the next try through, and the person makes it
    if (accept && dialog.again && said && !said.error) toast(t("browserPanel.dialog.again"));
  };
  return (
    <section
      role="alertdialog"
      aria-modal="false"
      aria-labelledby={`${id}-title`}
      aria-describedby={bar.body ? `${id}-body` : undefined}
      className="shrink-0 border-t bg-muted px-3 py-2"
    >
      <div className="flex items-start gap-2">
        <MessageSquare size={13} className="mt-[3px] shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1">
          <p id={`${id}-title`} className="truncate text-small font-medium text-foreground">
            {bar.title}
          </p>
          {bar.body && (
            <p id={`${id}-body`} className="mt-0.5 max-h-24 overflow-y-auto whitespace-pre-wrap break-words text-body text-foreground">
              {bar.body}
            </p>
          )}
          {bar.waiting && <p className="mt-1 text-small text-muted-foreground">{bar.waiting}</p>}
        </div>
      </div>
      {!bar.waiting && (
        <form
          className="mt-2 flex flex-wrap items-center justify-end gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            void answer(true);
          }}
        >
          {bar.field && (
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  void answer(false);
                }
              }}
              maxLength={2000}
              spellCheck={false}
              autoComplete="off"
              aria-label={t("browserPanel.dialog.answer")}
              className="h-7 min-w-0 flex-1 basis-40 rounded-md border border-input bg-background px-2 text-body text-foreground outline-none transition-[border-color] duration-150 placeholder:text-muted-foreground focus-visible:border-ring/60"
            />
          )}
          {bar.dismiss && (
            <Button type="button" size="sm" variant="ghost" className="h-6 px-2.5 text-small" disabled={busy} onClick={() => void answer(false)}>
              {bar.dismiss}
            </Button>
          )}
          <Button type="submit" size="sm" variant="brand" className="h-6 px-2.5 text-small" disabled={busy}>
            {bar.accept}
          </Button>
        </form>
      )}
    </section>
  );
}

// ── the server's browser, as pictures ──────────────────────────────────

/** The box's size, said to the server whenever it settles, which every
 * tab there lays out at. Measured on a layer of its own that fills the
 * box, which is there by the time this looks, as the box's own ref is
 * not yet. */
function SizeReporter() {
  const layer = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const box = layer.current;
    if (!box) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let last = "";
    const say = () => {
      const rect = box.getBoundingClientRect();
      const width = Math.floor(rect.width);
      const height = Math.floor(rect.height);
      const scale = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
      const key = `${width}x${height}@${scale}`;
      if (width < 200 || height < 150 || key === last) return;
      last = key;
      void api("/api/browser/viewport", { method: "POST", body: JSON.stringify({ width, height, scale }) }).catch(() => {
        last = "";
      });
    };
    const soon = () => {
      clearTimeout(timer);
      timer = setTimeout(say, 200);
    };
    say();
    const watch = new ResizeObserver(soon);
    watch.observe(box);
    return () => {
      clearTimeout(timer);
      watch.disconnect();
    };
  }, []);
  return <div ref={layer} aria-hidden className="pointer-events-none absolute inset-0" />;
}

/**
 * The shown tab, as the server's latest picture of it, and the person's
 * hands on it. Pictures are asked for one after another while the panel
 * is seen, each answered as soon as the page changes, so a slow line gets
 * fewer of them rather than a queue. A click takes the keyboard too, by a
 * field nobody sees, so typing, pasting and composing all reach the page.
 * On a touch screen a tap is a click, a swipe scrolls, and the keyboard
 * comes up only when asked for, not with every tap on a link.
 */
function Screen({ tab, control }: { tab: BrowserTab; control: BrowserControl | undefined }) {
  const [frame, setFrame] = useState<ScreenFrame | null>(null);
  const [typing, setTyping] = useState(false);
  const surface = useRef<HTMLDivElement>(null);
  const keys = useRef<HTMLTextAreaElement>(null);
  const drives = useRef(false);
  drives.current = control?.by === "agent";
  const touch = useRef<{ id: number; x: number; y: number; lastX: number; lastY: number; moved: boolean } | null>(null);
  const coarse = typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches;

  useEffect(() => {
    let stopped = false;
    let after = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const next = async () => {
      if (stopped) return;
      if (document.visibilityState !== "visible") {
        timer = setTimeout(next, 600);
        return;
      }
      try {
        const got = (await api(`/api/browser/screen?after=${after}`)) as Partial<ScreenFrame>;
        if (stopped) return;
        if (typeof got.jpeg === "string" && typeof got.seq === "number") {
          after = got.seq;
          setFrame(got as ScreenFrame);
        }
        void next();
      } catch {
        if (!stopped) timer = setTimeout(next, 2000);
      }
    };
    void next();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, []);

  // one queue for everything the person does, sent a batch at a time
  const send = useRef<InputSender | null>(null);
  useEffect(() => {
    const sender = screenInput((events) => api("/api/browser/input", { method: "POST", body: JSON.stringify({ events }) }));
    send.current = sender;
    return () => sender.stop();
  }, []);

  // the wheel, which React only hears passively
  useEffect(() => {
    const el = surface.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      if (drives.current) return;
      const lines = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? el.clientHeight : 1;
      send.current?.wheel({ ...pointOn(el, e), dx: e.deltaX * lines, dy: e.deltaY * lines, mods: modsOf(e) });
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, []);

  const click = (at: { x: number; y: number }, mods: number) => {
    for (const type of ["down", "up"] as const) send.current?.mouse({ type, ...at, button: "left", buttons: type === "down" ? 1 : 0, clicks: 1, mods });
  };

  const shown = frame && frame.tab === tab.id ? frame : null;
  return (
    <div
      ref={surface}
      role="application"
      aria-roledescription={t("browserPanel.pageRole")}
      aria-label={tabLabel(tab)}
      className={cn("absolute inset-0 touch-none select-none overflow-hidden", typing && "shadow-[inset_0_0_0_2px_var(--ring)]")}
      onPointerDown={(e) => {
        if (e.pointerType === "mouse" && e.button > 2) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        const at = pointOn(e.currentTarget, e);
        if (e.pointerType === "touch") {
          touch.current = { id: e.pointerId, ...at, lastX: at.x, lastY: at.y, moved: false };
          return;
        }
        keys.current?.focus({ preventScroll: true });
        send.current?.mouse({ type: "down", ...at, button: buttonOf(e.button), buttons: e.buttons, clicks: Math.min(3, Math.max(1, e.detail || 1)), mods: modsOf(e) });
      }}
      onPointerMove={(e) => {
        const at = pointOn(e.currentTarget, e);
        const held = touch.current;
        if (e.pointerType === "touch") {
          if (!held || held.id !== e.pointerId) return;
          if (Math.hypot(at.x - held.x, at.y - held.y) > 8) held.moved = true;
          // a swipe moves the page the way a finger drags it
          if (held.moved && !drives.current) send.current?.wheel({ ...at, dx: held.lastX - at.x, dy: held.lastY - at.y, mods: 0 });
          held.lastX = at.x;
          held.lastY = at.y;
          return;
        }
        // a pointer resting on the page while an agent drives is somebody
        // watching, and is not sent
        if (drives.current && !e.buttons) return;
        send.current?.mouse({ type: "move", ...at, button: e.buttons ? "left" : "none", buttons: e.buttons, clicks: 0, mods: modsOf(e) });
      }}
      onPointerUp={(e) => {
        if (e.pointerType === "touch") {
          const held = touch.current;
          touch.current = null;
          if (held && held.id === e.pointerId && !held.moved) click({ x: held.x, y: held.y }, 0);
          return;
        }
        send.current?.mouse({ type: "up", ...pointOn(e.currentTarget, e), button: buttonOf(e.button), buttons: e.buttons, clicks: Math.min(3, Math.max(1, e.detail || 1)), mods: modsOf(e) });
      }}
      onPointerCancel={() => {
        touch.current = null;
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {shown ? (
        <img
          src={`data:image/jpeg;base64,${shown.jpeg}`}
          alt=""
          draggable={false}
          className="pointer-events-none absolute left-0 top-0 max-w-none"
          style={{ width: shown.width, height: shown.height }}
        />
      ) : (
        <div className="flex h-full items-center justify-center text-muted-foreground">
          <Loader2 size={18} className="animate-spin" aria-label={t("browserPanel.loadingThePage")} />
        </div>
      )}
      <textarea
        ref={keys}
        aria-label={t("browserPanel.typeIntoThePage")}
        autoCapitalize="off"
        autoCorrect="off"
        autoComplete="off"
        spellCheck={false}
        className="absolute bottom-0 left-0 size-px resize-none overflow-hidden border-0 bg-transparent p-0 text-transparent opacity-0"
        onFocus={() => setTyping(true)}
        onBlur={() => setTyping(false)}
        onKeyDown={(e) => {
          const key = keyFrom(e);
          if (!key) return;
          e.preventDefault();
          send.current?.key({ ...key, type: "down" });
        }}
        onKeyUp={(e) => {
          const key = keyFrom(e);
          if (key) send.current?.key({ ...key, type: "up" });
        }}
        onPaste={(e) => {
          e.preventDefault();
          const text = e.clipboardData.getData("text/plain");
          if (text) send.current?.text(text);
        }}
        onInput={(e) => {
          // a phone's keyboard, or a word composed in another script:
          // what it settled on, as text
          const field = e.currentTarget;
          if ((e.nativeEvent as InputEvent).isComposing) return;
          if (field.value) send.current?.text(field.value);
          field.value = "";
        }}
        onCompositionEnd={(e) => {
          const field = e.currentTarget;
          if (field.value) send.current?.text(field.value);
          field.value = "";
        }}
      />
      {coarse && (
        <div className="absolute bottom-2 right-2" onPointerDown={(e) => e.stopPropagation()}>
          <HeaderButton
            label={t("browserPanel.typeIntoThePage")}
            pressed={typing}
            onClick={() => (typing ? keys.current?.blur() : keys.current?.focus({ preventScroll: true }))}
            className="size-9 border bg-card shadow-[0_1px_3px_var(--shadow-color)]"
          >
            <Keyboard size={17} />
          </HeaderButton>
        </div>
      )}
    </div>
  );
}

/** Where on the page, in its own pixels: the picture is drawn at them. */
function pointOn(el: HTMLElement, e: { clientX: number; clientY: number }) {
  const box = el.getBoundingClientRect();
  return { x: Math.max(0, Math.round(e.clientX - box.left)), y: Math.max(0, Math.round(e.clientY - box.top)) };
}

const buttonOf = (button: number) => (button === 1 ? "middle" : button === 2 ? "right" : "left") as "left" | "middle" | "right";

/** The protocol's modifier bits: Alt 1, Control 2, Meta 4, Shift 8. */
const modsOf = (e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) =>
  (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);

/** Shortcuts that edit what is on the page, sent there; every other one
 * with Command stays the app's (a new window, the palette, quitting). */
const PAGE_SHORTCUTS = new Set(["a", "c", "x", "z", "y"]);

/** A key to send the page, or null for one the field or the app keeps:
 * a paste (which arrives as text), a key mid-composition, the app's own
 * Command shortcuts. */
function keyFrom(e: KeyboardEvent<HTMLTextAreaElement>) {
  const native = e.nativeEvent;
  if (native.isComposing || e.key === "Process" || e.key === "Unidentified" || e.keyCode === 229) return null;
  const lower = e.key.toLowerCase();
  if ((e.metaKey || e.ctrlKey) && lower === "v") return null;
  if (e.metaKey && !PAGE_SHORTCUTS.has(lower)) return null;
  const printable = e.key.length === 1 && !e.ctrlKey && !e.metaKey;
  const text = printable ? e.key : e.key === "Enter" ? "\r" : undefined;
  return { key: e.key, code: e.code, keyCode: e.keyCode, ...(text ? { text } : {}), mods: modsOf(e), repeat: e.repeat };
}

function Tabs({
  tabs,
  activeId,
  faces,
  nameOf,
}: {
  tabs: BrowserTab[];
  activeId: string | null;
  faces: ReturnType<typeof useStore>["state"]["bots"];
  nameOf: (botId: string, fallback: string) => string;
}) {
  const ids = tabs.map((t) => t.id);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const at = activeId ? ids.indexOf(activeId) : -1;
    const by = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!by || at < 0 || ids.length < 2) return;
    e.preventDefault();
    const next = ids[(at + by + ids.length) % ids.length];
    void act("selectTab", next);
    document.getElementById(`browser-tab-${next}`)?.focus();
  };
  return (
    <div role="tablist" aria-label={t("browserPanel.browserTabs")} className="flex min-w-0 items-center gap-0.5 overflow-x-auto [scrollbar-width:none]" onKeyDown={onKeyDown}>
      {tabs.map((tab) => {
        const open = tab.id === activeId;
        const label = tabLabel(tab);
        const agent = tab.by.kind === "agent" ? tab.by : null;
        const face = agent ? faces.find((b) => b.id === agent.botId) : null;
        const driver = agent ? nameOf(agent.botId, agent.name) : null;
        return (
          <div key={tab.id} className="group relative flex shrink-0 items-center">
            <button
              type="button"
              role="tab"
              id={`browser-tab-${tab.id}`}
              aria-selected={open}
              tabIndex={open ? 0 : -1}
              onClick={() => void act("selectTab", tab.id)}
              aria-label={driver ? t("browserPanel.tabDrivenBy", { tab: label, name: driver }) : undefined}
              title={[label, ...(driver ? [t("browserPanel.drivenBy", { name: driver })] : []), tab.url].join("\n")}
              className={cn(
                "flex h-7 max-w-[184px] items-center gap-1.5 rounded-md pl-2 pr-7 text-body outline-none transition-colors duration-150",
                open ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
              )}
            >
              {tab.loading ? (
                <Loader2 size={13} className="shrink-0 animate-spin" aria-hidden />
              ) : face ? (
                <AgentAvatar bot={face} size={15} className="shrink-0" />
              ) : (
                <Globe size={13} className="shrink-0" aria-hidden />
              )}
              <span className="truncate">{label}</span>
            </button>
            <button
              type="button"
              tabIndex={-1}
              aria-label={t("browserPanel.closeTab", { tab: label })}
              title={t("browserPanel.closeTab", { tab: label })}
              onClick={() => void act("closeTab", tab.id)}
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
  );
}

/** The address bar: the page's address until you type, then yours. */
function AddressBar({ tab, disabled }: { tab: BrowserTab | null; disabled?: boolean }) {
  const [typed, setTyped] = useState<string | null>(null);
  const field = useRef<HTMLInputElement>(null);
  const shown = typed ?? shownAddress(tab?.url);
  // a new, blank tab is somewhere to type
  useEffect(() => {
    if (tab && !shownAddress(tab.url)) field.current?.focus();
  }, [tab?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <form
      className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md border border-input bg-background px-2 transition-[border-color] duration-150 focus-within:border-ring/60 hover:border-foreground/25"
      onSubmit={(e) => {
        e.preventDefault();
        const text = (typed ?? "").trim();
        if (!text) return;
        void act("navigate", text).then((answer) => {
          if (answer && !answer.error) {
            setTyped(null);
            field.current?.blur();
          }
        });
      }}
    >
      {isSecure(tab?.url) && typed === null ? (
        <Lock size={12} className="shrink-0 text-muted-foreground" aria-label={t("browserPanel.secureConnection")} />
      ) : (
        <Globe size={12} className="shrink-0 text-muted-foreground" aria-hidden />
      )}
      <input
        ref={field}
        value={shown}
        disabled={disabled}
        onChange={(e) => setTyped(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            setTyped(null);
            e.currentTarget.blur();
          }
        }}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        placeholder={t("browserPanel.searchOrTypeAnAddress")}
        aria-label={t("common.address")}
        className="min-w-0 flex-1 bg-transparent text-body text-foreground outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed"
      />
    </form>
  );
}

function Shelf({ downloads, onServer, onClose }: { downloads: AppBrowserState["downloads"]; onServer: boolean; onClose: () => void }) {
  return (
    <section aria-label={t("browserPanel.downloads")} className="max-h-[40%] shrink-0 overflow-y-auto border-t bg-card px-2 pb-2 pt-1.5">
      <div className="flex items-center gap-1 px-1 pb-1.5">
        <h2 className="flex-1 text-small font-medium text-muted-foreground">{t("browserPanel.downloads")}</h2>
        {!onServer && (
          <Button size="sm" variant="ghost" className="h-6 px-2 text-small" onClick={() => void act("openDownloads")}>
            <FolderOpen size={13} /> {t("browserPanel.folder")}
          </Button>
        )}
        {downloads.some((d) => d.state !== "progressing") && (
          <Button size="sm" variant="ghost" className="h-6 px-2 text-small" onClick={() => void act("clearDownloads")}>
            {t("common.clear")}
          </Button>
        )}
        <HeaderButton label={t("browserPanel.hideDownloads")} onClick={onClose} className="size-6">
          <X size={13} />
        </HeaderButton>
      </div>
      {downloads.length === 0 ? (
        <p className="px-1 pb-1 text-small text-muted-foreground">
          {onServer ? t("browserPanel.filesLandOnServer") : t("browserPanel.filesYouOrAnAgent")}
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {downloads.map((d) => (
            <li key={d.id} className="flex items-center gap-2.5 rounded-xl border bg-background px-2.5 py-2">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                {d.state === "progressing" ? <Loader2 size={15} className="animate-spin" /> : <FileIcon size={15} />}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-body font-medium text-foreground" title={d.name}>
                  {d.name}
                </p>
                <p className={cn("truncate text-small", d.state === "interrupted" ? "text-destructive" : "text-muted-foreground")}>
                  {downloadSize(d)}
                  {d.by ? ` · ${t("browserPanel.downloadedBy", { name: d.by })}` : ""}
                </p>
              </div>
              {d.state === "completed" &&
                (onServer ? (
                  <Button asChild size="sm" variant="ghost" className="h-6 shrink-0 px-2 text-small">
                    <a href={`/api/browser/downloads/${encodeURIComponent(d.id)}`} download={d.name}>
                      {t("browserPanel.save")}
                    </a>
                  </Button>
                ) : (
                  <div className="flex shrink-0 items-center gap-0.5">
                    <Button size="sm" variant="ghost" className="h-6 px-2 text-small" onClick={() => void act("openDownload", d.id)}>
                      {t("common.open")}
                    </Button>
                    <HeaderButton label={platformOf() === "mac" ? t("browserPanel.showInFinder") : t("browserPanel.showInFolder")} onClick={() => void act("revealDownload", d.id)} className="size-6">
                      <FolderOpen size={13} />
                    </HeaderButton>
                  </div>
                ))}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ── anywhere the panel is not ──────────────────────────────────────────

/**
 * In an agent's conversation, while it browses where this page has no
 * panel open: on the Mac, seen from a phone or the web app, or on the
 * server, with the panel closed. A small picture of the page while it is
 * looked at, when one can be had; just the words when it cannot. For a
 * server's browser, a way to watch it.
 */
export function BrowsingOnMac({ botId, name }: { botId: string; name: string }) {
  const state = useBrowserState();
  const { home } = useBrowserWhere();
  const { open } = useBrowserPanel();
  const onServer = home === "server";
  const doing = home === "own" || (onServer && open) ? null : browsingFor(state, botId);
  const [frame, setFrame] = useState<string | null>(null);
  const active = state?.tabs.find((t) => t.id === state.activeTabId);

  useEffect(() => {
    if (!doing) {
      setFrame(null);
      return;
    }
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const look = () => {
      if (document.visibilityState === "visible") {
        api("/api/browser/frame")
          .then((said: { live?: boolean; jpeg?: string }) => !stopped && setFrame(said?.live && said.jpeg ? said.jpeg : null))
          .catch(() => !stopped && setFrame(null));
      }
      timer = setTimeout(look, 2000);
    };
    look();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [doing]);

  if (!doing) return null;
  const where = active ? tabLabel(active) : null;
  return (
    <div className="mx-auto w-full max-w-[var(--transcript-width,760px)] px-4 pb-2 md:px-6">
      <div role="status" className="flex animate-rise-in items-center gap-3 rounded-2xl border bg-card p-2.5 shadow-[0_1px_3px_var(--shadow-color)]">
        <Thumb jpeg={frame} onServer={onServer} />
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1.5 text-ui font-medium text-foreground">
            {doing === "driving" && (
              <span aria-hidden className="relative flex size-2 shrink-0">
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-brand opacity-60" />
                <span className="relative inline-flex size-2 rounded-full bg-brand" />
              </span>
            )}
            {onServer ? t("browserPanel.browsing") : t("browserPanel.browsingOnTheMac")}
          </p>
          <p className="truncate text-small text-muted-foreground">
            {doing === "driving"
              ? where
                ? t("browserPanel.agentIsOn", { name, page: where })
                : t("browserPanel.agentUsesBrowser", { name })
              : onServer
                ? t("browserPanel.youTookOver", { name })
                : t("browserPanel.youTookOverOnMac", { name })}
          </p>
        </div>
        {onServer && (
          <Button size="sm" variant="secondary" className="shrink-0" onClick={() => setBrowserPanel({ open: true })}>
            {t("browserPanel.watch")}
          </Button>
        )}
      </div>
    </div>
  );
}

function Thumb({ jpeg, onServer }: { jpeg: string | null; onServer: boolean }): ReactNode {
  if (!jpeg) {
    return (
      <span className="flex size-12 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
        <Globe size={18} />
      </span>
    );
  }
  return (
    <img
      src={`data:image/jpeg;base64,${jpeg}`}
      alt={onServer ? t("browserPanel.thePageInTheBrowser") : t("browserPanel.thePageOnTheMac")}
      className="h-12 w-20 shrink-0 rounded-lg border object-cover object-top"
    />
  );
}
