// The Bloks browser on a server with no app behind it.
//
// In the desktop app the browser is the app's own: a view per tab in the
// window, asked over the line the app gives its servers. A server that
// runs on its own (bloks-server under systemd, the Docker image, a
// machine the app or a phone pairs with) has no app to ask, and the
// person may be anywhere: in the app on a Mac across the world, at the
// web door, on a phone. So this server keeps the browser itself: a
// headless Chrome in a profile of the workspace's own, beside its data,
// that keeps its tabs and sign-ins whether or not anybody is looking and
// whether or not the Mac is open.
//
// Nothing about the rules changes. A tab here sits behind the same
// makeTab seam the app's WebContentsView does, so the bookkeeping, who
// has the wheel and every command an agent sends are the very same code
// (browser-core.mjs), and the workspace's rules around them, which agent,
// which site, which field, are server/app-browser.ts as they always were.
//
// What is new is the person's side. The page is seen as pictures, the
// way Chrome's own remote screens work (Page.startScreencast): sized to
// the panel, a few a second at most, and only while somebody is looking.
// The person's clicks, scrolls and keys come back as input events. A
// click or a key while an agent drives takes the browser over, exactly
// as reaching into the app's view does; a pointer resting on the picture
// does not, because over a network that is somebody watching, not
// somebody acting.
//
// One browser socket carries every tab, each a page session on it
// (Target.setAutoAttach with flatten). Every page starts paused until its
// guard is on (waitForDebuggerOnStart), so a popup an agent's page opens
// is held to the rules from its first request.
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { basename, join } from "node:path";

import { AppBrowser, allowedForAgent, downloadName, refusedNavigation, type BrowserState, type Command, type TabAnswer, type TabBy, type TabHandle } from "./browser-core.mjs";
import { browserSocket, chromePath, launch, Session, type CdpEvent } from "./cdp.ts";

// ── which Chrome ───────────────────────────────────────────────────────

/** Why this server has no browser: none was found, the person turned it
 * off, or BLOKS_BROWSER names a file that is not there. */
export type BrowserMissing = "none" | "off" | "path";

/**
 * The Chrome this server's browser runs on, from BLOKS_BROWSER when it is
 * set (a path, or "off"), else the first Chrome, Chromium, Brave or Edge
 * found where they install.
 */
export function chromeFor(env: NodeJS.ProcessEnv = process.env, found: () => string | null = chromePath): { binary: string } | { missing: BrowserMissing } {
  const said = env.BLOKS_BROWSER?.trim() ?? "";
  if (/^(off|none|false|0)$/i.test(said)) return { missing: "off" };
  if (said) return existsSync(said) ? { binary: said } : { missing: "path" };
  const binary = found();
  return binary ? { binary } : { missing: "none" };
}

/** What an agent is told when there is no browser here, in its words. */
export function missingForAgent(missing: BrowserMissing): string {
  if (missing === "off") return "The Bloks browser is turned off on this server. Use a browser tool of your own, or ask the person.";
  return "The Bloks browser runs on Chrome on this server, and there is no Chrome here. Ask the person to install Google Chrome or Chromium on the server, or use a browser tool of your own.";
}

// ── the protocol line ──────────────────────────────────────────────────

/** The browser's one socket, as this file uses it. cdp.ts Session is one;
 * the tests hand in a fake. */
export interface CdpLine {
  send(method: string, params?: Record<string, unknown>, timeoutMs?: number, sessionId?: string): Promise<any>;
  onEvent(listener: CdpEvent): () => void;
  onClose(closed: () => void): () => void;
  close(): void;
}

/** Chrome started headless in `profileDir`, or the one already running
 * there, and its browser socket open. */
async function connectChrome(profileDir: string, binary: string): Promise<CdpLine> {
  const port = await launch(profileDir, binary, { headless: true });
  const socket = await browserSocket(port);
  if (!socket) throw new Error("the browser did not answer on its debugging port");
  const line = new Session(socket);
  await line.open();
  return line;
}

// ── what the person sends ──────────────────────────────────────────────

/** Bits of the protocol's `modifiers`: Alt, Ctrl, Meta, Shift. */
const MODS = 15;
/** The most input events one request carries, and the longest paste. */
export const INPUT_BATCH = 64;
export const PASTE_LIMIT = 5000;

export type PersonInput =
  | { t: "mouse"; type: "down" | "up" | "move"; x: number; y: number; button: "left" | "middle" | "right" | "none"; buttons: number; clicks: number; mods: number }
  | { t: "wheel"; x: number; y: number; dx: number; dy: number; mods: number }
  | { t: "key"; type: "down" | "up"; key: string; code: string; keyCode: number; text?: string; mods: number; repeat: boolean }
  | { t: "text"; text: string };

const num = (value: unknown, min: number, max: number, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

/**
 * The person's input as the panel sent it, checked and bounded, or what
 * was wrong with it. Positions are the page's own pixels, inside the
 * panel's size; a key is a name, never a script.
 */
export function readInput(body: unknown): { events: PersonInput[] } | { error: string } {
  const list = (body as { events?: unknown } | null)?.events;
  if (!Array.isArray(list) || list.length === 0) return { error: "events is a list of input" };
  if (list.length > INPUT_BATCH) return { error: `at most ${INPUT_BATCH} events at a time` };
  const events: PersonInput[] = [];
  for (const raw of list) {
    const said = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const mods = num(said.mods, 0, MODS) & MODS;
    if (said.t === "mouse") {
      const type = said.type === "down" || said.type === "up" || said.type === "move" ? said.type : null;
      if (!type) return { error: "a mouse event is down, up or move" };
      const button = said.button === "middle" || said.button === "right" || said.button === "none" ? said.button : "left";
      events.push({ t: "mouse", type, x: num(said.x, 0, 10_000), y: num(said.y, 0, 10_000), button, buttons: num(said.buttons, 0, 7) & 7, clicks: num(said.clicks, 1, 3, 1), mods });
    } else if (said.t === "wheel") {
      events.push({ t: "wheel", x: num(said.x, 0, 10_000), y: num(said.y, 0, 10_000), dx: num(said.dx, -5000, 5000), dy: num(said.dy, -5000, 5000), mods });
    } else if (said.t === "key") {
      const type = said.type === "down" || said.type === "up" ? said.type : null;
      const key = typeof said.key === "string" && said.key.length > 0 && said.key.length <= 32 ? said.key : null;
      const code = typeof said.code === "string" && said.code.length <= 32 ? said.code : "";
      if (!type || !key) return { error: "a key event is down or up, with the key's name" };
      const text = typeof said.text === "string" && said.text.length > 0 && said.text.length <= 2 ? said.text : undefined;
      events.push({ t: "key", type, key, code, keyCode: num(said.keyCode, 0, 255), ...(text ? { text } : {}), mods, repeat: said.repeat === true });
    } else if (said.t === "text") {
      if (typeof said.text !== "string" || !said.text) return { error: "text needs something to type" };
      if (said.text.length > PASTE_LIMIT) return { error: `at most ${PASTE_LIMIT} characters at a time` };
      events.push({ t: "text", text: said.text });
    } else return { error: "an event is mouse, wheel, key or text" };
  }
  return { events };
}

/** The editing commands a shortcut means, said to the page outright: a
 * Mac's Command-A means nothing to a Chrome on Linux, and a key event
 * alone never runs a shortcut on a Mac's. Paste is the person's own
 * clipboard, which arrives as text instead. */
function shortcut(input: Extract<PersonInput, { t: "key" }>): string[] | undefined {
  if (input.type !== "down" || !(input.mods & (2 | 4))) return undefined;
  const key = input.key.toLowerCase();
  if (key === "a") return ["selectAll"];
  if (key === "c") return ["copy"];
  if (key === "x") return ["cut"];
  if (key === "z") return [input.mods & 8 ? "redo" : "undo"];
  if (key === "y") return ["redo"];
  return undefined;
}

// ── the viewport ───────────────────────────────────────────────────────

export interface Viewport {
  width: number;
  height: number;
  /** Device pixels to a page pixel: 2 on a Mac's screen at home, 1
   * through Bloks Cloud, where every pixel crosses twice. */
  scale: number;
}

const DEFAULT_VIEWPORT: Viewport = { width: 1280, height: 800, scale: 1 };

/** The panel's size as a page lays out at it, within reason. */
export function readViewport(body: unknown, { relay = false }: { relay?: boolean } = {}): Viewport | null {
  const said = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const width = Math.round(Number(said.width));
  const height = Math.round(Number(said.height));
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 200 || height < 150) return null;
  return {
    width: Math.min(2560, width),
    height: Math.min(1600, height),
    scale: relay ? 1 : Math.round(num(said.scale, 1, 2, 1) * 4) / 4,
  };
}

// ── a tab ──────────────────────────────────────────────────────────────

interface Attached {
  targetId: string;
  sessionId: string;
  info: { url?: string; title?: string; openerId?: string; type?: string };
  waiting: boolean;
}

/** One tab: a page of the server's Chrome, behind the same seam the app's
 * view is. Ready once its page is attached and guarded; a command asked
 * of it before then waits for that. */
class PageTab implements TabHandle {
  id: string;
  by?: TabBy;
  refs = new Map<string, number>();
  policy: TabHandle["policy"] = null;
  blocked: string | null = null;
  acting = false;
  targetId: string | null = null;
  sessionId: string | null = null;
  closed = false;
  ready: Promise<void> = Promise.resolve();
  href = "about:blank";
  name = "";
  busy = false;
  back = false;
  forward = false;
  lookedAt = 0;
  private readonly owner: ServerBrowser;

  constructor(owner: ServerBrowser, id: string) {
    this.owner = owner;
    this.id = id;
  }

  async cdp(method: string, params: Record<string, unknown> = {}): Promise<any> {
    await this.ready;
    return this.owner.send(this, method, params);
  }

  url() {
    return this.href;
  }

  title() {
    return this.name;
  }

  load(url: string) {
    void this.cdp("Page.navigate", { url }).catch(() => {});
  }

  loading() {
    return this.busy;
  }

  canGoBack() {
    return this.back;
  }

  canGoForward() {
    return this.forward;
  }

  close() {
    this.owner.closeTab(this);
  }
}

/** Every document a tab loads, and anything at all it asks of this
 * machine's own addresses, waits on the guard. */
const GUARDED = [
  { urlPattern: "*", resourceType: "Document", requestStage: "Request" },
  ...["127.0.0.1", "localhost", "*.localhost", "[::1]", "0.0.0.0"].map((host) => ({ urlPattern: `*://${host}*`, requestStage: "Request" })),
];

// ── the browser ────────────────────────────────────────────────────────

/** How long a look at the screen keeps the pictures coming. The panel
 * asks again as soon as it has one, so this is only how long after it
 * stops that they stop. */
const WATCH_LEASE_MS = 15_000;
/** The fewest milliseconds between two pictures: ten a second at most. */
const FRAME_GAP_MS = 100;
/** A browser with no tabs left is closed after this, to give the server
 * its memory back; its sign-ins stay in the profile for next time. */
const IDLE_CLOSE_MS = 10 * 60_000;

export interface ScreenFrame {
  seq: number;
  jpeg: string;
  /** The page's own pixels the picture covers, which the panel's clicks
   * are said in. */
  width: number;
  height: number;
  tab: string;
  at: number;
}

export interface ServerBrowserOptions {
  /** The workspace's own profile, kept between starts. */
  profileDir: string;
  downloadsDir: string;
  chrome?: () => { binary: string } | { missing: BrowserMissing };
  /** Starts the browser and opens its socket; a fake one in the tests. */
  connect?: (profileDir: string, binary: string) => Promise<CdpLine>;
  /** Every port a Bloks server answers on here, never loaded in a tab. */
  ownPorts: () => number[];
  /** What the panels and the agents' waits hear, a beat after a change. */
  onChange: (state: BrowserState) => void;
  /** An agent opened a page while nobody was looking. */
  onReveal?: (by: string) => void;
  idleMs?: number;
  closeIdleMs?: number;
  stateDelayMs?: number;
  watchMs?: number;
}

export class ServerBrowser {
  readonly browser: AppBrowser;
  private readonly opts: ServerBrowserOptions;
  private line: CdpLine | null = null;
  private starting: Promise<CdpLine> | null = null;
  private readonly byTarget = new Map<string, PageTab>();
  private readonly bySession = new Map<string, PageTab>();
  private readonly claims = new Map<string, (attached: Attached) => void>();
  private readonly unclaimed = new Map<string, Attached>();
  private creating = 0;
  private adopting: Attached | null = null;
  private userAgent: string | null = null;
  private viewport: Viewport = { ...DEFAULT_VIEWPORT };
  private castTab: PageTab | null = null;
  private castSize = "";
  private frame: ScreenFrame | null = null;
  private frameSeq = 0;
  private readonly frameWaiters = new Set<() => void>();
  private watchedUntil = 0;
  private castTimer: ReturnType<typeof setInterval> | null = null;
  private stateTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly downloads = new Map<string, { name: string; by?: string; at: number }>();

  constructor(opts: ServerBrowserOptions) {
    this.opts = opts;
    this.browser = new AppBrowser({
      makeTab: (id) => this.makeTab(id),
      onChange: () => this.changed(),
      ownPorts: opts.ownPorts,
      ...(opts.idleMs ? { idleMs: opts.idleMs } : {}),
    });
  }

  /** Whether there is a Chrome here to run, and why not when not. */
  missing(): BrowserMissing | null {
    const chrome = (this.opts.chrome ?? chromeFor)();
    return "missing" in chrome ? chrome.missing : null;
  }

  get running(): boolean {
    return this.line !== null;
  }

  state(): BrowserState {
    return this.browser.state();
  }

  // ── starting, and losing, the browser ──

  private ensure(): Promise<CdpLine> {
    if (this.line) return Promise.resolve(this.line);
    this.starting ??= this.start().finally(() => (this.starting = null));
    return this.starting;
  }

  private async start(): Promise<CdpLine> {
    const chrome = (this.opts.chrome ?? chromeFor)();
    if ("missing" in chrome) throw Object.assign(new Error(missingForAgent(chrome.missing)), { missing: chrome.missing });
    mkdirSync(this.opts.profileDir, { recursive: true, mode: 0o700 });
    mkdirSync(this.opts.downloadsDir, { recursive: true, mode: 0o700 });
    let line: CdpLine;
    try {
      line = await (this.opts.connect ?? connectChrome)(this.opts.profileDir, chrome.binary);
    } catch (error) {
      throw new Error(`Chrome on this server would not start: ${error instanceof Error ? error.message : String(error)}`);
    }
    line.onEvent((method, params, sessionId) => this.event(line, method, params, sessionId));
    line.onClose(() => this.lost(line));
    this.line = line;
    try {
      const version = await line.send("Browser.getVersion", {}, 10_000);
      // A headless Chrome names itself so in every request, and some sites
      // turn it away for that alone; it is the Chrome it says it is
      // otherwise, as the app's view is with Electron's name taken out.
      const agent = String(version?.userAgent ?? "");
      this.userAgent = agent ? agent.replace(/HeadlessChrome/g, "Chrome") : null;
      await line.send("Browser.setDownloadBehavior", { behavior: "allowAndName", downloadPath: this.opts.downloadsDir, eventsEnabled: true }, 10_000);
      await line.send("Target.setDiscoverTargets", { discover: true }, 10_000);
      await line.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, 10_000);
      // Pages already open: kept by a browser this server left running
      // when it last stopped. Each is attached, and taken back as the
      // person's tab, or let be when it is blank.
      const targets = await line.send("Target.getTargets", {}, 10_000);
      for (const info of (targets?.targetInfos ?? []) as Array<{ targetId: string; type: string; attached?: boolean }>) {
        if (info.type === "page" && !info.attached && !this.byTarget.has(info.targetId)) {
          void line.send("Target.attachToTarget", { targetId: info.targetId, flatten: true }, 10_000).catch(() => {});
        }
      }
    } catch (error) {
      this.line = null;
      line.close();
      throw new Error(`Chrome on this server would not start: ${error instanceof Error ? error.message : String(error)}`);
    }
    // started for nothing (an agent asking which tabs there are) is
    // closed again after a while, like a browser whose tabs all closed
    this.changed();
    return line;
  }

  /** The browser went: quit, crashed, or killed. Its tabs go with it, and
   * the next thing anybody does starts it again. */
  private lost(line: CdpLine) {
    if (this.line !== line) return;
    this.line = null;
    for (const tab of this.byTarget.values()) tab.closed = true;
    this.byTarget.clear();
    this.bySession.clear();
    this.unclaimed.clear();
    this.castTab = null;
    this.castSize = "";
    this.frame = null;
    this.browser.closeAll();
    this.wakeWatchers();
  }

  /** A call on a tab's page session, bounded like the app's: a page that
   * never answers fails the step instead of holding it. */
  send(tab: PageTab, method: string, params: Record<string, unknown> = {}): Promise<any> {
    const line = this.line;
    if (!line || tab.closed || !tab.sessionId) return Promise.reject(new Error("that tab is closed"));
    return line.send(method, params, 20_000, tab.sessionId);
  }

  // ── tabs ──

  private makeTab(id: string): PageTab {
    const tab = new PageTab(this, id);
    const adopting = this.adopting;
    this.adopting = null;
    tab.ready = adopting ? this.bind(tab, adopting) : this.create(tab);
    tab.ready.catch(() => {
      // a tab that could not be made is not left in the strip
      if (!tab.closed) this.browser.close(tab.id);
    });
    return tab;
  }

  private async create(tab: PageTab) {
    const line = await this.ensure();
    this.creating++;
    let attached: Attached;
    try {
      const made = await line.send("Target.createTarget", { url: "about:blank" }, 10_000);
      const targetId = String(made?.targetId ?? "");
      attached =
        this.unclaimed.get(targetId) ??
        (await new Promise<Attached>((resolve, reject) => {
          const timer = setTimeout(() => {
            this.claims.delete(targetId);
            reject(new Error("the new tab never opened"));
          }, 10_000);
          this.claims.set(targetId, (found) => {
            clearTimeout(timer);
            resolve(found);
          });
        }));
      this.unclaimed.delete(targetId);
    } finally {
      this.creating--;
    }
    if (tab.closed) {
      void line.send("Target.closeTarget", { targetId: attached.targetId }, 5_000).catch(() => {});
      return;
    }
    await this.bind(tab, attached);
  }

  /** A page attached and made a tab: its guard on, its size the panel's,
   * its name for itself the plain Chrome's, and only then let run. */
  private async bind(tab: PageTab, attached: Attached) {
    const line = this.line;
    if (!line) throw new Error("the browser is gone");
    tab.targetId = attached.targetId;
    tab.sessionId = attached.sessionId;
    this.noteInfo(tab, attached.info);
    this.byTarget.set(attached.targetId, tab);
    this.bySession.set(attached.sessionId, tab);
    const call = (method: string, params: Record<string, unknown> = {}) => line.send(method, params, 20_000, attached.sessionId);
    await Promise.all([
      call("Page.enable"),
      call("Fetch.enable", { patterns: GUARDED }),
      call("Emulation.setDeviceMetricsOverride", metrics(this.viewport)),
      ...(this.userAgent ? [call("Emulation.setUserAgentOverride", { userAgent: this.userAgent })] : []),
    ]);
    if (attached.waiting) await call("Runtime.runIfWaitingForDebugger").catch(() => {});
    void this.history(tab);
    if (this.browser.active === tab) void this.cast();
  }

  /** Called by AppBrowser.close, and by the page going on its own. */
  closeTab(tab: PageTab) {
    if (tab.closed) return;
    tab.closed = true;
    if (tab.targetId) this.byTarget.delete(tab.targetId);
    if (tab.sessionId) this.bySession.delete(tab.sessionId);
    if (this.castTab === tab) this.castTab = null;
    const line = this.line;
    if (line && tab.targetId) void line.send("Target.closeTarget", { targetId: tab.targetId }, 5_000).catch(() => {});
  }

  /** A page that went by itself (window.close, a crash): its tab goes. */
  private gone(tab: PageTab) {
    if (tab.closed) return;
    tab.closed = true;
    if (tab.targetId) this.byTarget.delete(tab.targetId);
    if (tab.sessionId) this.bySession.delete(tab.sessionId);
    this.browser.close(tab.id);
  }

  private noteInfo(tab: PageTab, info: Attached["info"]) {
    if (typeof info?.url === "string" && info.url) tab.href = info.url;
    if (typeof info?.title === "string") tab.name = info.title === tab.href ? "" : info.title;
  }

  /** Where the tab stands in its history, and what its page is called
   * now: Chrome says a title as a page arrives, not as it changes. */
  private async history(tab: PageTab) {
    try {
      const said = await this.send(tab, "Page.getNavigationHistory");
      const at = Number(said?.currentIndex ?? 0);
      const count = Array.isArray(said?.entries) ? said.entries.length : 0;
      tab.back = at > 0;
      tab.forward = at < count - 1;
      const title = said?.entries?.[at]?.title;
      if (typeof title === "string") tab.name = title === tab.href ? "" : title;
      tab.lookedAt = Date.now();
      this.browser.changed();
    } catch {
      /* closing; nothing to say */
    }
  }

  private attached(line: CdpLine, params: { sessionId?: string; targetInfo?: Attached["info"] & { targetId?: string }; waitingForDebugger?: boolean }) {
    const sessionId = String(params.sessionId ?? "");
    const info = params.targetInfo ?? {};
    const targetId = String(info.targetId ?? "");
    const letGo = () => {
      void line.send("Runtime.runIfWaitingForDebugger", {}, 5_000, sessionId).catch(() => {});
      void line.send("Target.detachFromTarget", { sessionId }, 5_000).catch(() => {});
    };
    if (!sessionId || !targetId) return;
    // a worker, a service worker: nothing a tab is
    if (info.type !== "page") return letGo();
    // attached twice (on its own and when asked): one session is enough
    if (this.byTarget.has(targetId) || this.unclaimed.has(targetId)) return letGo();
    const attached: Attached = { targetId, sessionId, info, waiting: params.waitingForDebugger === true };
    const claim = this.claims.get(targetId);
    if (claim) {
      this.claims.delete(targetId);
      return claim(attached);
    }
    const opener = info.openerId ? this.byTarget.get(info.openerId) : undefined;
    if (opener) return this.popup(line, opener, attached);
    this.unclaimed.set(targetId, attached);
    const sweep = () => {
      if (this.creating > 0) return void setTimeout(sweep, 500).unref?.();
      const held = this.unclaimed.get(targetId);
      if (!held) return;
      this.unclaimed.delete(targetId);
      if (!held.info.url || held.info.url === "about:blank") return letGo();
      this.adopt(held, { kind: "person" }, () => letGo());
    };
    setTimeout(sweep, 1_000).unref?.();
  }

  /** A page that opened a window: it gets a tab of ours instead, under
   * the same rules, driven by whoever drove the tab that opened it. */
  private popup(line: CdpLine, opener: PageTab, attached: Attached) {
    const close = () => void line.send("Target.closeTarget", { targetId: attached.targetId }, 5_000).catch(() => {});
    const url = attached.info.url ?? "";
    if (url && url !== "about:blank") {
      if (refusedNavigation(url, { ownPorts: this.opts.ownPorts() })) return close();
      if (this.browser.control.by === "agent" && !allowedForAgent(url, opener.policy)) {
        opener.blocked = url;
        return close();
      }
    }
    const tab = this.adopt(attached, opener.by ?? { kind: "person" }, close);
    if (tab) tab.policy = opener.policy;
  }

  private adopt(attached: Attached, by: TabBy, otherwise: () => void): PageTab | null {
    this.adopting = attached;
    try {
      return this.browser.newTab(by) as PageTab;
    } catch {
      // the most tabs there may be are open
      otherwise();
      return null;
    } finally {
      this.adopting = null;
    }
  }

  // ── what the browser says ──

  private event(line: CdpLine, method: string, params: any, sessionId?: string) {
    if (line !== this.line) return;
    switch (method) {
      case "Target.attachedToTarget":
        return this.attached(line, params);
      case "Target.detachedFromTarget": {
        const tab = this.bySession.get(String(params?.sessionId ?? ""));
        if (tab) this.gone(tab);
        return;
      }
      case "Target.targetDestroyed": {
        const tab = this.byTarget.get(String(params?.targetId ?? ""));
        if (tab) this.gone(tab);
        this.unclaimed.delete(String(params?.targetId ?? ""));
        return;
      }
      case "Target.targetInfoChanged": {
        const tab = this.byTarget.get(String(params?.targetInfo?.targetId ?? ""));
        if (!tab) return;
        this.noteInfo(tab, params.targetInfo);
        return this.browser.changed();
      }
      case "Browser.downloadWillBegin":
        return this.downloadBegins(params);
      case "Browser.downloadProgress":
        return this.downloadMoves(params);
    }
    const tab = sessionId ? this.bySession.get(sessionId) : undefined;
    if (!tab) return;
    switch (method) {
      case "Fetch.requestPaused":
        return void this.guard(line, tab, params);
      case "Page.frameNavigated":
        if (params?.frame?.parentId) return;
        // a new document: the last snapshot's refs name nothing on it
        tab.refs = new Map();
        if (typeof params.frame?.url === "string") tab.href = params.frame.url;
        void this.history(tab);
        return this.browser.changed();
      case "Page.navigatedWithinDocument":
        if (params?.frameId !== tab.targetId) return;
        if (typeof params.url === "string") tab.href = params.url;
        void this.history(tab);
        return this.browser.changed();
      case "Page.frameStartedLoading":
      case "Page.frameStoppedLoading":
        if (params?.frameId !== tab.targetId) return;
        tab.busy = method === "Page.frameStartedLoading";
        if (!tab.busy) void this.history(tab);
        return this.browser.changed();
      case "Page.screencastFrame":
        return this.pictured(line, tab, params);
    }
  }

  /**
   * Where a tab may go, on every document it loads and every redirect:
   * never somewhere refusedNavigation names, and, while an agent drives
   * it, nowhere its workspace's lists keep agents from. A page that is
   * stopped stays where it was ("Aborted" commits no error page), as the
   * app's view does when it prevents a navigation.
   */
  private guard(line: CdpLine, tab: PageTab, params: { requestId?: string; request?: { url?: string }; resourceType?: string; frameId?: string }) {
    const requestId = String(params.requestId ?? "");
    const url = String(params.request?.url ?? "");
    const main = params.resourceType === "Document" && params.frameId === tab.targetId;
    const send = (method: string, extra: Record<string, unknown> = {}) =>
      void line.send(method, { requestId, ...extra }, 10_000, tab.sessionId ?? undefined).catch(() => {});
    if (refusedNavigation(url, { ownPorts: this.opts.ownPorts() })) return send("Fetch.failRequest", { errorReason: main ? "Aborted" : "BlockedByClient" });
    if (main && this.browser.control.by === "agent" && tab.by?.kind === "agent" && !allowedForAgent(url, tab.policy)) {
      tab.blocked = url;
      return send("Fetch.failRequest", { errorReason: "Aborted" });
    }
    send("Fetch.continueRequest");
  }

  // ── downloads ──

  private downloadBegins(params: { guid?: string; suggestedFilename?: string }) {
    const id = String(params?.guid ?? "");
    if (!/^[\w-]{1,80}$/.test(id)) return;
    const control = this.browser.control;
    const name = basename(String(params.suggestedFilename ?? "")) || "download";
    const by = control.by === "agent" ? control.name : undefined;
    this.downloads.set(id, { name, at: Date.now(), ...(by ? { by } : {}) });
    this.browser.noteDownload({ id, name, path: join(this.opts.downloadsDir, id), bytes: 0, total: 0, state: "progressing", at: Date.now(), ...(by ? { by } : {}) });
  }

  private downloadMoves(params: { guid?: string; receivedBytes?: number; totalBytes?: number; state?: string }) {
    const id = String(params?.guid ?? "");
    const held = this.downloads.get(id);
    if (!held) return;
    const state = params.state === "completed" ? "completed" : params.state === "canceled" ? "cancelled" : "progressing";
    let path = join(this.opts.downloadsDir, id);
    let name = held.name;
    if (state === "completed") {
      // saved under its id while it came in, then named as the site
      // suggested, beside anything with that name already
      name = downloadName(held.name, (taken: string) => existsSync(join(this.opts.downloadsDir, taken)));
      try {
        renameSync(path, join(this.opts.downloadsDir, name));
        path = join(this.opts.downloadsDir, name);
      } catch {
        name = held.name;
      }
      this.downloads.delete(id);
    }
    if (state === "cancelled") this.downloads.delete(id);
    this.browser.noteDownload({
      id,
      name,
      path,
      bytes: Number(params.receivedBytes) || 0,
      total: Number(params.totalBytes) || 0,
      state,
      at: held.at,
      ...(held.by ? { by: held.by } : {}),
    });
  }

  /** A finished download, for the person to save where they are. */
  download(id: string): { path: string; name: string } | null {
    const found = this.browser.state().downloads.find((d) => d.id === id && d.state === "completed");
    if (!found || !found.path.startsWith(join(this.opts.downloadsDir, "/")) || !existsSync(found.path)) return null;
    return { path: found.path, name: found.name };
  }

  // ── what changed, said once ──

  private changed() {
    void this.cast();
    // a browser nobody uses gives the server its memory back
    if (this.browser.state().tabs.length === 0 && this.line) {
      this.idleTimer ??= setTimeout(() => {
        this.idleTimer = null;
        if (this.browser.state().tabs.length === 0) void this.shutDown();
      }, this.opts.closeIdleMs ?? IDLE_CLOSE_MS);
      this.idleTimer.unref?.();
    } else if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.stateTimer) return;
    this.stateTimer = setTimeout(() => {
      this.stateTimer = null;
      this.opts.onChange(this.browser.state());
    }, this.opts.stateDelayMs ?? 120);
    this.stateTimer.unref?.();
  }

  // ── an agent's command ──

  /** One command, as the server checked it (server/app-browser.ts). Said
   * the way the app's line says it, so the rules read one answer. */
  async command(command: Command, driver: { botId: string; name: string }): Promise<TabAnswer & { status?: number }> {
    // a turn ending says it is done; a browser that is not running is not
    // started again to hear it
    if (command.action === "done" && !this.line) {
      this.browser.release(driver.botId);
      return { text: "the browser is yours no longer; the person sees it as free" };
    }
    try {
      await this.ensure();
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error), status: 503 };
    }
    // the person sees it happen: their panel opens where they are
    if (command.action === "open" && Date.now() >= this.watchedUntil) this.opts.onReveal?.(driver.name);
    try {
      return await this.browser.command(command, driver);
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error), status: 409 };
    }
  }

  // ── the person ──

  /** What the person does from the panel: the app's browser:do, here. */
  async person(action: string, arg?: unknown): Promise<{ ok?: boolean; error?: string; url?: string }> {
    const browser = this.browser;
    // the person steering while an agent drives is the person taking over
    if (["navigate", "selectTab", "closeTab", "back", "forward", "reload", "stop"].includes(action) && browser.control.by === "agent") browser.takeOver();
    const active = browser.active as PageTab | null;
    switch (action) {
      case "navigate":
        await this.ensure();
        return browser.navigate(String(arg ?? ""));
      case "newTab":
        await this.ensure();
        try {
          browser.newTab({ kind: "person" });
        } catch (error) {
          return { error: error instanceof Error ? error.message : String(error) };
        }
        return { ok: true };
      case "closeTab":
        return { ok: browser.close(String(arg ?? "")) };
      case "selectTab":
        return { ok: browser.select(String(arg ?? "")) };
      case "back":
      case "forward": {
        if (!active) return { ok: true };
        const said = await active.cdp("Page.getNavigationHistory").catch(() => null);
        const entry = said?.entries?.[Number(said.currentIndex) + (action === "back" ? -1 : 1)];
        if (entry) {
          active.refs = new Map();
          await active.cdp("Page.navigateToHistoryEntry", { entryId: entry.id }).catch(() => {});
        }
        return { ok: true };
      }
      case "reload":
        await active?.cdp("Page.reload", {}).catch(() => {});
        return { ok: true };
      case "stop":
        await active?.cdp("Page.stopLoading", {}).catch(() => {});
        return { ok: true };
      case "takeOver":
        browser.takeOver();
        return { ok: true };
      case "giveBack":
        browser.giveBack();
        return { ok: true };
      case "clearDownloads":
        browser.clearDownloads();
        return { ok: true };
      case "forgetSites":
        await this.forget();
        return { ok: true };
      default:
        return { error: "The browser does not do that." };
    }
  }

  /** The person's clicks, scrolls and keys, on the tab shown. */
  async input(events: PersonInput[]): Promise<{ ok: boolean; tookOver: boolean; error?: string }> {
    const tab = this.browser.active as PageTab | null;
    if (!tab || tab.closed) return { ok: false, tookOver: false, error: "No page is open." };
    let tookOver = false;
    for (const input of events) {
      if (this.browser.control.by === "agent") {
        const acting = (input.t === "mouse" && input.type === "down") || (input.t === "key" && input.type === "down") || input.t === "text";
        if (!acting) continue;
        this.browser.takeOver();
        tookOver = true;
      }
      await this.dispatch(tab, input).catch(() => {});
    }
    return { ok: true, tookOver };
  }

  private dispatch(tab: PageTab, input: PersonInput): Promise<unknown> {
    switch (input.t) {
      case "mouse":
        return tab.cdp("Input.dispatchMouseEvent", {
          type: input.type === "down" ? "mousePressed" : input.type === "up" ? "mouseReleased" : "mouseMoved",
          x: input.x,
          y: input.y,
          button: input.type === "move" && !input.buttons ? "none" : input.button,
          buttons: input.buttons,
          clickCount: input.type === "move" ? 0 : input.clicks,
          modifiers: input.mods,
        });
      case "wheel":
        return tab.cdp("Input.dispatchMouseEvent", { type: "mouseWheel", x: input.x, y: input.y, deltaX: input.dx, deltaY: input.dy, modifiers: input.mods });
      case "key": {
        const commands = shortcut(input);
        // a character typed with Control or Command is a shortcut, not text
        const text = input.text && !(input.mods & (2 | 4)) ? input.text : undefined;
        return tab.cdp("Input.dispatchKeyEvent", {
          type: input.type === "up" ? "keyUp" : text ? "keyDown" : "rawKeyDown",
          key: input.key,
          code: input.code,
          windowsVirtualKeyCode: input.keyCode,
          nativeVirtualKeyCode: input.keyCode,
          modifiers: input.mods,
          autoRepeat: input.repeat,
          ...(text && input.type === "down" ? { text, unmodifiedText: text } : {}),
          ...(commands ? { commands } : {}),
        });
      }
      case "text":
        return tab.cdp("Input.insertText", { text: input.text });
    }
  }

  /** The panel's size, which every tab lays out at. The last panel to
   * say wins: one person, one panel at a time, in practice. */
  async resize(viewport: Viewport): Promise<void> {
    const same = viewport.width === this.viewport.width && viewport.height === this.viewport.height && viewport.scale === this.viewport.scale;
    this.viewport = viewport;
    if (same) return;
    await Promise.all([...this.byTarget.values()].map((tab) => this.send(tab, "Emulation.setDeviceMetricsOverride", metrics(viewport)).catch(() => {})));
    await this.cast();
  }

  /**
   * The next picture of the shown tab after `after`, waiting up to
   * `waitMs` for one. Asking is looking: the pictures run while somebody
   * asks, and stop a while after the last one did. `gapMs` spaces them
   * for a viewer whose every picture crosses Bloks Cloud.
   */
  async screen(after: number, { waitMs = 20_000, gapMs = 0 }: { waitMs?: number; gapMs?: number } = {}): Promise<{ frame: ScreenFrame | null; seq: number }> {
    // a panel from before this server restarted counts from nothing
    if (after > this.frameSeq) after = 0;
    this.watchedUntil = Date.now() + (this.opts.watchMs ?? WATCH_LEASE_MS);
    void this.cast();
    if (gapMs) await new Promise((resolve) => setTimeout(resolve, gapMs));
    const fresh = () => {
      const frame = this.frame;
      return frame && frame.seq > after && frame.tab === this.browser.active?.id ? frame : null;
    };
    if (!fresh()) {
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          this.frameWaiters.delete(done);
          resolve();
        };
        const timer = setTimeout(done, waitMs);
        this.frameWaiters.add(done);
      });
    }
    const frame = fresh();
    return { frame, seq: frame?.seq ?? after };
  }

  private wakeWatchers() {
    for (const wake of [...this.frameWaiters]) wake();
  }

  /** The pictures run on the shown tab while somebody looks, and on no
   * tab otherwise. */
  private async cast() {
    const looking = Date.now() < this.watchedUntil;
    const want = looking ? ((this.browser.active as PageTab | null) ?? null) : null;
    const size = `${this.viewport.width}x${this.viewport.height}@${this.viewport.scale}`;
    if (want === this.castTab && (!want || size === this.castSize)) return;
    const was = this.castTab;
    this.castTab = want;
    this.castSize = want ? size : "";
    if (was && was !== want && !was.closed) void was.cdp("Page.stopScreencast").catch(() => {});
    if (want) {
      // a new tab, or a new size: the picture of the old one is not this
      this.wakeWatchers();
      await want.ready.catch(() => {});
      if (this.castTab !== want || want.closed) return;
      if (was === want) await want.cdp("Page.stopScreencast").catch(() => {});
      // a tab behind another paints nothing, so pictures nothing: the
      // shown one is brought to the front, as a click on its tab would
      await want.cdp("Page.bringToFront").catch(() => {});
      const seq = this.frameSeq;
      await want
        .cdp("Page.startScreencast", {
          format: "jpeg",
          quality: 60,
          maxWidth: Math.round(this.viewport.width * this.viewport.scale),
          maxHeight: Math.round(this.viewport.height * this.viewport.scale),
          everyNthFrame: 1,
        })
        .catch(() => {});
      // A page that has finished changing sends no picture until it
      // changes again; one is taken, so the panel is never left waiting.
      setTimeout(() => {
        if (this.castTab === want && this.frameSeq === seq) void this.still(want);
      }, 1_000).unref?.();
    }
    // the pictures stop a while after the last look
    if (want && !this.castTimer) {
      this.castTimer = setInterval(() => {
        if (Date.now() < this.watchedUntil) return;
        if (this.castTimer) clearInterval(this.castTimer);
        this.castTimer = null;
        void this.cast();
      }, Math.min(2_000, this.opts.watchMs ?? 2_000));
      this.castTimer.unref?.();
    }
  }

  private pictured(line: CdpLine, tab: PageTab, params: { data?: string; sessionId?: number; metadata?: { deviceWidth?: number; deviceHeight?: number } }) {
    // Chrome sends the next picture once this one is answered, so the
    // answer is what paces them
    const ack = () => void line.send("Page.screencastFrameAck", { sessionId: params.sessionId }, 5_000, tab.sessionId ?? undefined).catch(() => {});
    if (tab !== this.castTab || typeof params.data !== "string") return ack();
    this.frame = {
      seq: ++this.frameSeq,
      jpeg: params.data,
      width: Math.round(Number(params.metadata?.deviceWidth) || this.viewport.width),
      height: Math.round(Number(params.metadata?.deviceHeight) || this.viewport.height),
      tab: tab.id,
      at: Date.now(),
    };
    this.wakeWatchers();
    setTimeout(ack, FRAME_GAP_MS).unref?.();
    // a page that changes says so in pictures, and maybe in its title
    if (Date.now() - tab.lookedAt > 2_000) void this.history(tab);
  }

  /** One picture of a tab as it stands, taken rather than sent. */
  private async still(tab: PageTab) {
    const shot = await tab.cdp("Page.captureScreenshot", { format: "jpeg", quality: 60 }).catch(() => null);
    if (typeof shot?.data !== "string" || this.castTab !== tab) return;
    this.frame = { seq: ++this.frameSeq, jpeg: shot.data, width: this.viewport.width, height: this.viewport.height, tab: tab.id, at: Date.now() };
    this.wakeWatchers();
  }

  /** A small picture of the shown tab, for a phone's strip in a chat. */
  async thumbnail(): Promise<{ jpeg: string; at: number } | null> {
    // while somebody watches, the latest picture is the page as it is
    const frame = this.frame;
    if (frame && this.castTab && frame.tab === this.castTab.id && Date.now() - frame.at < 3_000) return { jpeg: frame.jpeg, at: frame.at };
    const tab = this.browser.active as PageTab | null;
    if (!this.line || !tab || tab.closed) return null;
    const scale = Math.min(1, 480 / this.viewport.width);
    const shot = await tab
      .cdp("Page.captureScreenshot", { format: "jpeg", quality: 60, clip: { x: 0, y: 0, width: this.viewport.width, height: this.viewport.height, scale } })
      .catch(() => null);
    return typeof shot?.data === "string" ? { jpeg: shot.data, at: Date.now() } : null;
  }

  // ── signing out, and going ──

  /** Signed out everywhere: the browser closed and its profile emptied,
   * this workspace's only. */
  async forget(): Promise<void> {
    await this.shutDown();
    rmSync(this.opts.profileDir, { recursive: true, force: true });
  }

  /** The browser closed as if quit, its tabs with it; its sign-ins stay. */
  async shutDown(): Promise<void> {
    const line = this.line;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (!line) return;
    const closed = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 3_000);
      line.onClose(() => {
        clearTimeout(timer);
        resolve();
      });
    });
    await line.send("Browser.close", {}, 3_000).catch(() => {});
    await closed;
    this.lost(line);
    line.close();
  }
}

function metrics(viewport: Viewport) {
  return { width: viewport.width, height: viewport.height, deviceScaleFactor: viewport.scale, mobile: false, screenWidth: viewport.width, screenHeight: viewport.height };
}
