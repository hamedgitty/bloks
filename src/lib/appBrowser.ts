// The Bloks browser, as the page sees it.
//
// It is in one of three places, and this page is told which (`home`):
//
//   "own": the desktop app, on a workspace this computer runs. The
//   browser is the app's (electron/app-browser.mjs): this page draws its
//   panel, tells the app where the panel is, and hears from the app what
//   each tab shows and who drives it.
//
//   "server": a workspace whose server has no app behind it
//   (bloks-server, the Docker image), from wherever the person is: the
//   app, the web door, a phone. The server keeps the browser
//   (server/server-browser.ts); this page shows it as pictures and sends
//   the person's clicks and keys back.
//
//   "elsewhere": a workspace the desktop app runs on another computer,
//   seen from anywhere but that app. Only news of the browser there.
//
// Either way the workspace's server says what the browser is doing
// (GET /api/browser and its "browser.app" frames), and the app says it
// first-hand to its own page. One small store for all three, so a
// component asks one question: what is the browser doing, and can I
// drive it from here.
import { useEffect, useSyncExternalStore } from "react";
import { formatNumber, t } from "./i18n.ts";

export type TabBy = { kind: "person" } | { kind: "agent"; botId: string; name: string };

export type BrowserControl =
  | { by: "idle" }
  | { by: "agent"; botId: string; name: string; since: number }
  | { by: "person"; since: number; from?: { botId: string; name: string }; waiting?: { botId: string; name: string } };

/** A dialog a tab's page has open, waiting on an answer
 * (server/browser-core.mjs dialogOpened). Its words are the page's. */
export interface BrowserDialog {
  id: string;
  type: "alert" | "confirm" | "prompt" | "beforeunload";
  message: string;
  defaultPrompt?: string;
  /** A yes only lets the next try to leave the page through. */
  again?: true;
}

/** The person's answer to one, from the panel's bar. */
export interface DialogAnswer {
  id: string;
  accept: boolean;
  text?: string;
}

export interface BrowserTab {
  id: string;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  by: TabBy;
  dialog?: BrowserDialog;
}

export interface BrowserDownload {
  id: string;
  name: string;
  path: string;
  bytes: number;
  total: number;
  state: "progressing" | "completed" | "cancelled" | "interrupted";
  at: number;
  by?: string;
}

export interface AppBrowserState {
  tabs: BrowserTab[];
  activeTabId: string | null;
  control: BrowserControl;
  downloads: BrowserDownload[];
}

/** Where the browser this page shows lives; null until it is known. */
export type BrowserHome = "own" | "server" | "elsewhere";

/** Why a server has no browser of its own: no Chrome, turned off, or
 * BLOKS_BROWSER naming a file that is not there (server/server-browser.ts). */
export type BrowserMissing = "none" | "off" | "path";

/** One picture of the server's browser, in the page's own pixels. */
export interface ScreenFrame {
  seq: number;
  jpeg: string;
  width: number;
  height: number;
  tab: string;
  at: number;
}

/** What the panel asks the app to do (electron/main.mjs browser:do), or
 * the server, for a browser of its own (POST /api/browser/do). */
export type BrowserDo =
  | "navigate" | "newTab" | "closeTab" | "selectTab" | "back" | "forward" | "reload" | "stop"
  | "takeOver" | "giveBack" | "openExternal" | "openDownload" | "revealDownload" | "openDownloads"
  | "clearDownloads" | "forgetSites" | "answerDialog";

// ── pure ───────────────────────────────────────────────────────────────

/** The address as the bar shows it while nobody is typing: the page's
 * own, nothing for a blank tab. */
export function shownAddress(url: string | undefined): string {
  if (!url || url === "about:blank") return "";
  return url;
}

/** A host to name a page by, without www. */
export function hostLabel(url: string | undefined): string {
  try {
    const parsed = new URL(url ?? "");
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.hostname.replace(/^www\./, "") : "";
  } catch {
    return "";
  }
}

/** A tab's name on its chip: its title, else its host, else New tab. */
export function tabLabel(tab: Pick<BrowserTab, "title" | "url">): string {
  const title = tab.title?.trim();
  if (title && title !== tab.url && title !== "about:blank") return title;
  return hostLabel(tab.url) || t("appBrowser.newTab");
}

/** Whether the page arrived over a connection nobody else could read. */
export function isSecure(url: string | undefined): boolean {
  return /^https:\/\//i.test(url ?? "");
}

/** The line over the page saying who has the browser, and the one thing
 * to do about it, or null when nobody is doing anything worth a line. */
export function controlLine(control: BrowserControl | undefined): { tone: "agent" | "person"; text: string; action: "takeOver" | "giveBack" } | null {
  if (!control || control.by === "idle") return null;
  if (control.by === "agent") {
    return {
      tone: "agent",
      text: control.name ? t("appBrowser.control.agentBrowsing", { name: control.name }) : t("appBrowser.control.someAgentBrowsing"),
      action: "takeOver",
    };
  }
  const who = control.waiting?.name ?? control.from?.name;
  return {
    tone: "person",
    text: control.waiting
      ? t("appBrowser.control.waitingForIt", { name: who ?? "" })
      : who
        ? t("appBrowser.control.tookOverFrom", { name: who })
        : t("appBrowser.control.youHaveIt"),
    action: "giveBack",
  };
}

/**
 * The bar over the page while it waits on a dialog: who is asking (the
 * page's host, the way a browser names one), the page's words, and the
 * answers. Only the person who has the wheel answers from here: while an
 * agent drives, the dialog is the agent's to answer, and the bar says it
 * waits on it, with Take over on the line above.
 */
export function dialogBar(dialog: BrowserDialog, url: string | undefined, control: BrowserControl | undefined) {
  const leave = dialog.type === "beforeunload";
  const host = hostLabel(url);
  return {
    title: leave ? t("browserPanel.dialog.leaveTitle") : host ? t("browserPanel.dialog.hostSays", { host }) : t("browserPanel.dialog.pageSays"),
    body: leave ? t("browserPanel.dialog.leaveBody") : dialog.message,
    accept: leave ? t("browserPanel.dialog.leave") : t("browserPanel.dialog.ok"),
    /** An alert has only OK. */
    dismiss: dialog.type === "alert" ? null : leave ? t("browserPanel.dialog.stay") : t("common.cancel"),
    field: dialog.type === "prompt",
    waiting:
      control?.by === "agent"
        ? control.name
          ? t("browserPanel.dialog.waitingFor", { name: control.name })
          : t("browserPanel.dialog.waitingForAgent")
        : null,
  };
}

/** Whether the browser is busy for this agent: driving, or waiting on the
 * person who took it over. What the phone's strip shows. */
export function browsingFor(state: AppBrowserState | null | undefined, botId: string): "driving" | "waiting" | null {
  const control = state?.control;
  if (!control) return null;
  if (control.by === "agent" && control.botId === botId) return "driving";
  if (control.by === "person" && (control.waiting?.botId === botId || control.from?.botId === botId)) return "waiting";
  return null;
}

/** The size of a download, said plainly. */
export function downloadSize(d: Pick<BrowserDownload, "bytes" | "total" | "state">): string {
  const size = (n: number) =>
    n >= 1024 * 1024
      ? t("appBrowser.size.megabytes", { size: formatNumber(n / 1024 / 1024, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) })
      : n >= 1024
        ? t("appBrowser.size.kilobytes", { size: Math.round(n / 1024) })
        : t("appBrowser.size.bytes", { size: n });
  if (d.state === "progressing") return d.total > 0 ? t("appBrowser.size.progress", { done: size(d.bytes), total: size(d.total) }) : size(d.bytes);
  if (d.state === "cancelled") return t("appBrowser.cancelled");
  if (d.state === "interrupted") return t("appBrowser.didNotFinish");
  return size(d.total || d.bytes);
}

/** The panel's width, kept usable on both sides of its edge. */
export const BROWSER_SIZE = { min: 360, chat: 380, fallback: 560 } as const;

export function clampBrowserWidth(width: number, room: number): number {
  const max = Math.max(BROWSER_SIZE.min, room - BROWSER_SIZE.chat);
  return Math.round(Math.min(max, Math.max(BROWSER_SIZE.min, Number.isFinite(width) ? width : BROWSER_SIZE.fallback)));
}

/** Below this the chat and the browser cannot share the window, and the
 * browser covers the chat until it is closed. */
export const BROWSER_SIDE_BY_SIDE = BROWSER_SIZE.min + BROWSER_SIZE.chat;

// ── the store ──────────────────────────────────────────────────────────

let current: AppBrowserState | null = null;
let where: { home: BrowserHome | null; missing: BrowserMissing | null } = { home: null, missing: null };
const listeners = new Set<() => void>();
const tell = () => {
  for (const listener of listeners) listener();
};

const MISSING = new Set<BrowserMissing>(["none", "off", "path"]);

/** What the workspace's server said of its browser (GET /api/browser):
 * where it is, why not when it cannot run, and what it is doing. The
 * app's own page goes by the app instead, once it knows it has one. */
export function noteServerBrowser(said: unknown) {
  if (where.home === "own") return;
  const body = said && typeof said === "object" ? (said as { where?: unknown; missing?: unknown; state?: unknown }) : {};
  const missing = MISSING.has(body.missing as BrowserMissing) ? (body.missing as BrowserMissing) : null;
  where = { home: body.where === "server" ? "server" : "elsewhere", missing };
  noteBrowserState(body.state ?? null);
}

/** Where the browser is, as last known, for code outside React. */
export function browserHome(): BrowserHome | null {
  return where.home;
}

/** What the app or the server last said. */
export function noteBrowserState(state: unknown) {
  current = state && typeof state === "object" && Array.isArray((state as AppBrowserState).tabs) ? (state as AppBrowserState) : null;
  tell();
}

let started = false;
/** Finds out where the browser is, once for the whole page. The desktop
 * app has a browser of its own for every workspace it runs here, and
 * none for one on another computer, whose server is asked instead; its
 * frames then reach noteBrowserState through the store's stream. */
function start(load: () => Promise<unknown>) {
  if (started) return;
  started = true;
  const ask = () => void load().then(noteServerBrowser).catch(() => {});
  const bridge = typeof window !== "undefined" ? window.bloks : undefined;
  if (!bridge?.browserState || !bridge.onBrowserState) return ask();
  const onState = bridge.onBrowserState;
  void bridge
    .browserState()
    .then((state) => {
      if (!state) return ask();
      where = { home: "own", missing: null };
      onState((next) => noteBrowserState(next));
      noteBrowserState(state);
    })
    .catch(ask);
}

/** Asks the server again: a Chrome installed since, say, shows when the
 * panel next opens. Nothing to ask where the browser is the app's. */
export function refreshBrowser(load: () => Promise<unknown>) {
  if (where.home === "own" || !started) return;
  void load().then(noteServerBrowser).catch(() => {});
}

/** Whether this page has the desktop app's own browser for the workspace
 * it shows, said by the app itself: never for one on another computer. */
export async function browserIsHere(): Promise<boolean> {
  const bridge = typeof window !== "undefined" ? window.bloks : undefined;
  if (!bridge?.browserState) return false;
  return (await bridge.browserState().catch(() => null)) !== null;
}

/** An agent started browsing while nobody looked. The desktop app opens
 * its own panel (useBrowserReveal); a server's browser opens it here,
 * where the chat and the panel fit side by side, never over the chat on
 * a phone. */
export function revealBrowser() {
  if (where.home !== "server" || where.missing) return;
  if (typeof window === "undefined" || window.innerWidth < BROWSER_SIDE_BY_SIDE + 240) return;
  setBrowserPanel({ open: true });
}

export function useAppBrowser(load: () => Promise<unknown>): AppBrowserState | null {
  useEffect(() => start(load), [load]);
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
  );
}

/** Where the browser is, and why there is none when there is none. */
export function useBrowserHome(load: () => Promise<unknown>): { home: BrowserHome | null; missing: BrowserMissing | null } {
  useEffect(() => start(load), [load]);
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => where,
  );
}

// ── the panel, open or not ─────────────────────────────────────────────

const OPEN_KEY = "bloks-browser-open";
const WIDTH_KEY = "bloks-browser-width";

function readNumber(key: string, fallback: number): number {
  try {
    const n = Number(localStorage.getItem(key));
    return Number.isFinite(n) && n > 0 ? n : fallback;
  } catch {
    return fallback;
  }
}

let panel = {
  open: (() => {
    try {
      return localStorage.getItem(OPEN_KEY) === "1";
    } catch {
      return false;
    }
  })(),
  width: readNumber(WIDTH_KEY, BROWSER_SIZE.fallback),
};
const panelListeners = new Set<() => void>();

export function setBrowserPanel(next: Partial<typeof panel>) {
  panel = { ...panel, ...next };
  try {
    localStorage.setItem(OPEN_KEY, panel.open ? "1" : "0");
    localStorage.setItem(WIDTH_KEY, String(Math.round(panel.width)));
  } catch {
    /* storage refused; the panel still works for this window */
  }
  for (const listener of panelListeners) listener();
}

/** Whether the panel is open, and how wide: one for every conversation,
 * so moving between agents keeps it where it was. */
export function useBrowserPanel(): typeof panel {
  return useSyncExternalStore(
    (listener) => {
      panelListeners.add(listener);
      return () => panelListeners.delete(listener);
    },
    () => panel,
  );
}
