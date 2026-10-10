// The desktop shell.
//
// Three jobs, in this order: bring up the harness server, open a window
// pointed at it, and own the macOS permissions the web layer cannot ask
// for on its own.
//
// The permissions part is the reason this file is more than a window
// factory. Screen Recording and Microphone are granted by macOS to an
// *application*, identified by its signature, so anything that triggers
// those prompts has to run inside the app's own processes. A helper the
// server spawned would prompt as some anonymous binary, or not appear in
// System Settings at all.
import {
  app,
  BrowserWindow,
  clipboard,
  desktopCapturer,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  Notification,
  powerMonitor,
  powerSaveBlocker,
  safeStorage,
  screen,
  session,
  shell,
  systemPreferences,
  utilityProcess,
} from "electron";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { normalizeBadgeCount, resolveWindowState } from "./window-state.mjs";
import { appMenuTemplate } from "./app-menu.mjs";
import { drainWait } from "./drain-wait.mjs";
import { mayLookAgain, newestBeforeInstall, updateFrame } from "./update-check.mjs";
import { claimPairLink, startRemoteProxy } from "./remote.mjs";
import { sameAppOrigin } from "./navigation.mjs";
import { linkInArgv, teamLink } from "./links.mjs";
import os from "node:os";

// vendored by scripts/bundle-updater.mjs: the packaged app has no
// node_modules, so the updater travels inside electron/ pre-bundled
import electronUpdater from "./vendor/electron-updater.cjs";

import { startCua, stopCua, registerCuaIpc } from "./cua.mjs";
import { nativeHelper } from "./native-helper.mjs";
import { USUAL_PORTS, anyFreePort, failurePage, parseLsof, portFree, portOrder } from "./ports.mjs";
import { keepServerUp, stopServer } from "./server-life.mjs";
import { startMeeting, startSpeech, stopMeeting, stopSpeech } from "./speech.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ICON = path.join(HERE, "resources/app-icon.png");

// Spelled as an IPv4 literal, not "localhost": Vite binds v4, and the name
// can resolve to ::1 first, which paints an empty window.
const DEV_URL = process.env.ELECTRON_START_URL ?? "http://127.0.0.1:5199";

/** The usual ports; see electron/ports.mjs for the order they are tried
 * in and what happens when none of them is free. */
const CANDIDATE_PORTS = USUAL_PORTS;

const DARK_BACKDROP = "#0e0e10";
const LIGHT_BACKDROP = "#ffffff";

/**
 * The PATH a Finder launch gets has never heard of npm, brew or nvm, so
 * every CLI engine would probe as "not installed" in the packaged app.
 * Ask the user's own login shell what PATH it actually uses, once, and
 * merge that into this process before anything is forked. The harness
 * inherits it, and so does everything the harness spawns.
 *
 * The interactive flag matters: plenty of people export PATH in .zshrc,
 * which only an interactive shell reads. Banners and rc noise are why
 * only the last line of output is trusted.
 */
async function adoptLoginShellPath() {
  // Windows has no login-shell PATH problem: GUI apps inherit the user
  // environment, and %SHELL% does not exist to ask.
  if (process.platform === "win32") return;
  const shell = process.env.SHELL || "/bin/zsh";
  const reported = await new Promise((resolve) => {
    execFile(shell, ["-ilc", 'echo "$PATH"'], { timeout: 4000 }, (error, stdout) => {
      resolve(error ? null : stdout.trim().split("\n").at(-1));
    });
  });
  if (!reported) return; // the backstop in server/path.ts still applies

  const merged = [...new Set([...reported.split(":"), ...(process.env.PATH ?? "").split(":")])]
    .filter(Boolean)
    .join(":");
  process.env.PATH = merged;
}

let serverProcess = null;
let serverPort = CANDIDATE_PORTS[0];
let serverStarted = true;
/** What the running server has said on stderr lately, for the page shown
 * if it dies and will not come back. */
let serverLastWords = () => "";
/** Set once Bloks starts quitting: the server going away is expected from
 * then on, and is not brought back. */
let quitting = false;

// One Bloks per user. A second launch would fork a second harness onto a
// fallback port and quietly split the workspace in two, so the loser
// exits before it has started anything, and the winner brings its own
// window forward when that happens.
if (!app.requestSingleInstanceLock()) {
  app.exit(0);
}

// bloks:// links from the website ("Add to Bloks" on a team in the
// gallery). Only a gallery team by name is understood: a link cannot
// point the app at an arbitrary address, and what it opens is the same
// review a person sees when importing by hand, so nothing is created
// until they choose the seats. macOS hands links over with open-url, the
// others as an argument, to a second launch or to the one the link
// started (electron/links.mjs).
app.setAsDefaultProtocolClient("bloks");
let pendingLink = null;
function deliverLink(raw) {
  const link = teamLink(raw);
  if (!link) return;
  const main = BrowserWindow.getAllWindows().find((w) => w !== quickWin && !w.isDestroyed());
  if (!main || main.webContents.isLoading()) {
    pendingLink = link;
    return;
  }
  if (main.isMinimized()) main.restore();
  main.show();
  main.focus();
  main.webContents.send("link:open", link);
}
app.on("open-url", (event, url) => {
  event.preventDefault();
  deliverLink(url);
});
handle("link:pending", () => {
  const link = pendingLink;
  pendingLink = null;
  return link;
});

// A choice from the macOS menu bar (electron/app-menu.mjs) that the
// workspace window carries out, such as Settings. macOS keeps the app
// running with every window closed, and the menu still works then, so a
// window is opened for it and asks for the choice once it is listening,
// the same way a link waits above.
let pendingMenuCommand = null;
function menuCommand(command) {
  const main = BrowserWindow.getAllWindows().find((w) => w !== quickWin && !w.isDestroyed());
  if (!main || main.webContents.isLoading()) {
    pendingMenuCommand = command;
    if (!main) createWindow();
    return;
  }
  if (main.isMinimized()) main.restore();
  main.show();
  main.focus();
  main.webContents.send("menu:command", command);
}
handle("menu:pending", () => {
  const command = pendingMenuCommand;
  pendingMenuCommand = null;
  return command;
});

app.on("second-instance", (_event, argv = []) => {
  const link = linkInArgv(argv);
  if (link) deliverLink(link);
  const main = BrowserWindow.getAllWindows().find((w) => w !== quickWin && !w.isDestroyed());
  if (!main) return;
  if (main.isMinimized()) main.restore();
  main.show();
  main.focus();
  app.focus?.({ steal: true });
});

// ── the harness server ─────────────────────────────────────────────────

/**
 * Start the server on one port and wait for it to prove it is ours.
 *
 * A health check that only looks for HTTP 200 is not enough. A developer
 * running `pnpm dev:server` has the identical API on the identical port,
 * and attaching to it would give the packaged app someone else's
 * workspace. So the probe requires the pid we just forked and that the
 * responder is serving static files, which a dev server does not.
 */
async function startServerOn(port) {
  const entry = path.join(process.resourcesPath, "server", "index.js");
  const child = utilityProcess.fork(entry, [], {
    env: {
      ...process.env,
      BLOKS_STATIC_DIR: path.join(process.resourcesPath, "ui"),
      BLOKS_PORT: String(port),
    },
    // stderr is read as well as passed on, so a server that dies while
    // starting can say why on the page instead of "ports".
    //
    // stdout is piped too, never "inherit" next to a "pipe": on Windows,
    // Electron fills an inherited slot with GetStdHandle(), which is NULL
    // for an app opened from a shortcut (no console), and Chromium's
    // LaunchProcess then dies on PCHECK(SetHandleInformation(NULL, ...))
    // before the window exists. Two pipes are always valid handles.
    stdio: ["ignore", "pipe", "pipe"],
  });
  // Pass the server's output on when there is somewhere to pass it; a
  // Windows app opened from a shortcut has no console, and a write that
  // fails there must not take the main process with it.
  const passOn = (target, chunk) => {
    try {
      target.write(chunk);
    } catch {
      /* no console to write to */
    }
  };
  child.stdout?.on("data", (chunk) => passOn(process.stdout, chunk));
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    passOn(process.stderr, chunk);
    stderr = (stderr + chunk.toString()).slice(-4000);
  });

  let exited = false;
  child.once("exit", () => {
    exited = true;
  });

  // First run on a fresh machine writes its data directories before it
  // listens, so this waits rather than assuming a fast start.
  let why = "slow";
  for (let attempt = 0; attempt < 40; attempt++) {
    if (exited) {
      // lost a race for the port after the check said it was free
      return { child: null, why: /EADDRINUSE/.test(stderr) ? "busy" : "exited", stderr };
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) {
        const body = await response.json().catch(() => null);
        if (body?.app === "bloks" && body.pid === child.pid && body.static) return { child, lastWords: () => stderr };
        why = "other-server";
        break; // someone else answers here; try the next port
      }
    } catch {
      /* not listening yet */
    }
    await pause(500);
  }

  try {
    child.kill();
  } catch {
    /* already gone */
  }
  return { child: null, why, stderr };
}

/** Who is listening on a port, when the system will say. */
function portHolder(port) {
  if (process.platform === "win32") return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fcp"], { timeout: 3000 }, (_error, stdout) =>
      resolve(parseLsof(stdout)),
    );
  });
}

const LAST_PORT_FILE = () => path.join(app.getPath("userData"), "server-port.json");

function readLastPort() {
  try {
    return JSON.parse(fs.readFileSync(LAST_PORT_FILE(), "utf8")).port ?? null;
  } catch {
    return null;
  }
}

/** A port chosen in ~/.bloks/config.json, the one place a Finder-opened
 * app can be told one. */
function readConfiguredPort() {
  try {
    return JSON.parse(fs.readFileSync(path.join(os.homedir(), ".bloks", "config.json"), "utf8")).port ?? null;
  } catch {
    return null;
  }
}

/** The server that holds ~/.bloks, when ours refused to start beside it. */
function dataFolderHolder(stderr) {
  const found = /DATA_FOLDER_IN_USE pid=(\d+) port=(\d+)/.exec(stderr ?? "");
  return found ? { pid: Number(found[1]), port: Number(found[2]) } : null;
}

/** What the window shows when no server came up. Set by startServer. */
let startupFailure = null;

/** Starts the server, trying each port in turn. `prefer` goes first, and
 * `rounds` is how many sweeps of the ports it gets. */
async function startServer({ prefer = null, rounds = 2 } = {}) {
  const attempts = [];
  let crash = "";
  // Another Bloks server already using ~/.bloks, as the server reports it
  // (server/data-lock.ts). Another port would not help: it is the data
  // folder that is taken, and two servers on it undo each other's work.
  let inUse = null;
  // Quit-and-reopen can race the previous instance's teardown, so the
  // whole sweep is tried twice before giving up; a folder still held is
  // given a few more rounds, since that is most often the last instance
  // on its way out.
  for (let round = 0; round < (inUse ? 5 : rounds); round++) {
    inUse = null;
    const ports = portOrder({ prefer, env: process.env.BLOKS_PORT, configured: readConfiguredPort(), last: readLastPort() });
    // every usual port busy is not the end: any free port will do
    const spare = await anyFreePort();
    if (spare) ports.push(spare);
    for (const port of ports) {
      if (!(await portFree(port))) {
        if (round === rounds - 1) attempts.push({ port, why: "busy", holder: await portHolder(port) });
        continue;
      }
      const started = await startServerOn(port);
      if (started.child) {
        serverProcess = started.child;
        serverPort = port;
        serverLastWords = started.lastWords;
        try {
          fs.writeFileSync(LAST_PORT_FILE(), JSON.stringify({ port }));
        } catch {
          /* next launch simply starts from the usual ports */
        }
        return true;
      }
      if (started.why === "exited" && started.stderr) crash = started.stderr;
      inUse = dataFolderHolder(started.stderr);
      if (inUse) break;
      if (round === rounds - 1) attempts.push({ port, why: started.why, holder: null });
    }
    await pause(2500);
  }
  startupFailure = failurePage({
    attempts,
    crash,
    inUse,
    backdrop: DARK_BACKDROP,
    machine: process.platform === "darwin" ? "Mac" : "computer",
  });
  return false;
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A server that dies after it started is brought back, on the port it
// had when that is free; see electron/server-life.mjs. Each try is one
// sweep of the ports, and a server that keeps dying ends on the failure
// page instead of a window calling a port nobody answers on.
const keeper = keepServerUp({
  quitting: () => quitting,
  start: async () => {
    startupFailure = null;
    return (await startServer({ prefer: serverPort, rounds: 1 })) ? serverProcess : null;
  },
  onBack: () => pointWindows(),
  onGaveUp: () => {
    // the last try that failed to start already says why; otherwise the
    // last one started and died like the rest
    startupFailure ??= failurePage({
      attempts: [],
      crash: serverLastWords(),
      stopped: true,
      backdrop: DARK_BACKDROP,
      machine: process.platform === "darwin" ? "Mac" : "computer",
    });
    serverStarted = false;
    pointWindows();
  },
});

// ── the window ─────────────────────────────────────────────────────────

const isHttpUrl = (url) => {
  try {
    const { protocol } = new URL(url);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
};

// The app's own page is its exact origin, port included. Any page on
// localhost used to count, and agents run dev servers, notebooks and
// desktops on localhost: one of those loaded into the app window would
// have had the preload's bridge (pairing a remote, Touch ID, the screen).
const isOurOwnPage = (url) => sameAppOrigin(url, appUrl());

/** Only the app's own page may use the bridge: the top frame of one of
 * its windows, judged by the frame's real origin. A frame inside the page
 * (an artifact, an app, an agent's desktop) has its own origin, and a
 * sandboxed one says "null", so neither passes. */
const fromOurPage = (event) => {
  const frame = event?.senderFrame;
  if (!frame || frame !== event.sender?.mainFrame) return false;
  return isOurOwnPage(frame.origin ?? "");
};

/** ipcMain.handle, answering only the app's own page (fromOurPage). Every
 * bridge goes through this, so a new one cannot forget the check. */
function handle(channel, fn) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!fromOurPage(event)) throw new Error("not from the app");
    return fn(event, ...args);
  });
}

/** The same rules for every window that loads the app: links go to the
 * real browser, and the window itself never leaves the app's origin. */
function guardNavigation(target) {
  target.webContents.setWindowOpenHandler(({ url }) => {
    if (isHttpUrl(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  target.webContents.on("will-navigate", (event, url) => {
    if (isOurOwnPage(url)) return; // the app reloading itself
    event.preventDefault();
    if (isHttpUrl(url)) shell.openExternal(url);
  });
  // A compromised renderer must not be able to grow itself new surfaces.
  target.webContents.on("will-attach-webview", (event) => event.preventDefault());
}

/**
 * Right-click, the way native apps mean it.
 *
 * Electron ships no context menu at all, so without this a right-click
 * in the composer does nothing: no Paste, no spelling fixes. The menu
 * is built from what was actually clicked, and when nothing there is
 * actionable, no menu appears rather than a column of grey items.
 */
function installContextMenu(win) {
  win.webContents.on("context-menu", (_event, params) => {
    if (!params.isEditable && !params.selectionText && !params.linkURL && !params.misspelledWord)
      return;
    const items = [];
    if (params.misspelledWord) {
      for (const suggestion of params.dictionarySuggestions.slice(0, 5)) {
        items.push({
          label: suggestion,
          click: () => win.webContents.replaceMisspelling(suggestion),
        });
      }
      if (items.length) items.push({ type: "separator" });
    }
    if (params.linkURL) {
      items.push(
        { label: "Copy Link", click: () => clipboard.writeText(params.linkURL) },
        { type: "separator" },
      );
    }
    if (params.isEditable) {
      items.push(
        { role: "undo", enabled: params.editFlags.canUndo },
        { role: "redo", enabled: params.editFlags.canRedo },
        { type: "separator" },
        { role: "cut", enabled: params.editFlags.canCut },
        { role: "copy", enabled: params.editFlags.canCopy },
        { role: "paste", enabled: params.editFlags.canPaste },
        { role: "pasteAndMatchStyle", enabled: params.editFlags.canPaste },
        { type: "separator" },
        { role: "selectAll", enabled: params.editFlags.canSelectAll },
      );
    } else {
      items.push({ role: "copy", enabled: params.editFlags.canCopy });
    }
    Menu.buildFromTemplate(items).popup({ window: win, frame: params.frame });
  });
}

// ── where the window was ───────────────────────────────────────────────

const windowStateFile = () => path.join(app.getPath("userData"), "window-state.json");

function readWindowState() {
  try {
    return fs.readFileSync(windowStateFile(), "utf8");
  } catch {
    return null; // first run, or the file was cleaned away
  }
}

/** Written whole and renamed into place, so a crash mid-save leaves the
 * previous state rather than half a JSON object. */
function writeWindowState(win) {
  if (!win || win.isDestroyed()) return;
  const file = windowStateFile();
  const staging = `${file}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      staging,
      JSON.stringify({ bounds: win.getNormalBounds(), maximized: win.isMaximized() }),
    );
    fs.renameSync(staging, file);
  } catch {
    fs.rmSync(staging, { force: true });
  }
}

/** Every resize and move schedules a save; the debounce means a drag is
 * one write, not hundreds. Close flushes so the last position wins. */
function persistWindowState(win) {
  let timer = null;
  const flush = () => {
    clearTimeout(timer);
    timer = null;
    writeWindowState(win);
  };
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(flush, 300);
  };
  for (const event of ["resize", "move", "maximize", "unmaximize"]) win.on(event, schedule);
  win.on("close", flush);
}

/**
 * Where the three window buttons sit.
 *
 * The cluster is 52px wide (three 12px buttons, 20px apart). At x:22 it
 * ends at 74, which leaves exactly 22px to the 96px rail's edge: the
 * group sits centred, with even margins on both sides. macOS
 * forgets this position on its own: leaving full screen, changing
 * display scale and some resizes all reset it, which is how the green
 * button ends up back over the divider after a while. So it is applied
 * again on each of those, rather than only at creation.
 */
const BUTTONS = { x: 22, y: 16 };

function keepButtonsInPlace(win) {
  if (process.platform !== "darwin") return;
  const apply = () => {
    if (win.isDestroyed() || win.isFullScreen()) return;
    try {
      win.setWindowButtonPosition(BUTTONS);
    } catch {
      /* older macOS, or a window without a hidden titlebar */
    }
  };
  for (const event of ["leave-full-screen", "enter-full-screen", "resize", "focus", "show"]) {
    win.on(event, () => setTimeout(apply, 120));
  }
  apply();
}

// ── the quick ask ─────────────────────────────────────────────────────
// A one-line window that appears over whatever you are doing, sends a
// message to an agent, and gets out of the way. It is the difference
// between an app you open and one you use: the thought arrives while you
// are in another window, and going to find Bloks first is where most of
// them die.

let quickWin = null;
let quickAccelerator = null;

function appUrl(query = "") {
  const base = app.isPackaged
    ? serverStarted
      ? `http://127.0.0.1:${serverPort}`
      : startupFailure
    : DEV_URL;
  return query ? `${base}${base.includes("?") ? "&" : "?"}${query}` : base;
}

/** Every window at the app again, after the server came back (perhaps on
 * another port), or at the failure page once it will not. The app keeps
 * nothing in its address, so loading it afresh loses nothing a reload
 * would keep. */
function pointWindows() {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    // a server that died again at once fails the load, and the next try
    // or the failure page points the window again
    win.loadURL(win === quickWin && serverStarted ? appUrl("quick=1") : appUrl()).catch(() => {});
  }
}

function quickWindow() {
  if (quickWin && !quickWin.isDestroyed()) return quickWin;
  quickWin = new BrowserWindow({
    width: 620,
    height: 190,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    // Over full-screen apps too, and never in the app switcher: this is a
    // panel, not a second window of the app.
    alwaysOnTop: true,
    skipTaskbar: true,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(HERE, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  quickWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // it loads the same page, with the same bridge, so the same guards
  guardNavigation(quickWin);
  installContextMenu(quickWin);
  quickWin.loadURL(appUrl("quick=1"));
  // Clicking away is a dismissal. Anything else would leave a floating
  // box on somebody's screen with no obvious way to close it.
  quickWin.on("blur", () => quickWin?.hide());
  quickWin.on("closed", () => {
    quickWin = null;
  });
  return quickWin;
}

function toggleQuickAsk() {
  const win = quickWindow();
  if (win.isVisible()) return win.hide();
  // Near the top of whichever display the pointer is on, the way every
  // launcher does it, rather than the middle of the primary screen.
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const { x, y, width } = display.workArea;
  win.setPosition(Math.round(x + width / 2 - 310), Math.round(y + 140));
  win.showInactive();
  win.focus();
  win.webContents.send("quick:opened");
}

/** Registers the hotkey, or clears it. Returns what actually took. */
function applyQuickShortcut(accelerator) {
  if (quickAccelerator) {
    try {
      globalShortcut.unregister(quickAccelerator);
    } catch {}
    quickAccelerator = null;
  }
  if (!accelerator) return null;
  try {
    // register returns false when another app already owns the keys,
    // which the settings screen reports rather than silently ignoring
    const ok = globalShortcut.register(accelerator, toggleQuickAsk);
    quickAccelerator = ok ? accelerator : null;
    return quickAccelerator;
  } catch {
    return null;
  }
}

function createWindow() {
  // Open where the window was last time, resolved against the displays
  // that exist right now; a saved position on an unplugged monitor
  // re-centres instead of restoring off-screen. First run falls back to
  // fitting the primary display, never exceeding it: a window taller
  // than the screen puts the composer below the bottom edge, which
  // reads as "the app has no way to type" rather than "too big".
  const primary = screen.getPrimaryDisplay();
  const others = screen.getAllDisplays().filter((d) => d.id !== primary.id);
  const restored = resolveWindowState(
    readWindowState(),
    [primary, ...others].map((d) => d.workArea),
  );
  const { width: screenW, height: screenH } = primary.workAreaSize;

  const win = new BrowserWindow({
    ...restored.bounds,
    // never larger than the screen, whatever the minimum would prefer
    minWidth: Math.min(900, screenW),
    minHeight: Math.min(600, screenH),
    icon: APP_ICON,
    // Painted before the renderer has anything, so it should match where
    // the app is about to land. The in-app theme follows the system by
    // default, which makes this right nearly always.
    backgroundColor: nativeTheme.shouldUseDarkColors ? DARK_BACKDROP : LIGHT_BACKDROP,
    titleBarStyle: "hiddenInset",
    // macOS draws its three buttons as a 52px cluster. The collapsed
    // sidebar has to be wider than that plus both insets, or the green
    // one sits on the divider; see BUTTONS below for the arithmetic.
    trafficLightPosition: BUTTONS,
    webPreferences: {
      // Written out rather than inherited: these are the settings that
      // decide whether a page an agent produced can reach the machine, and
      // a default that changes between Electron versions should not be
      // able to change that quietly.
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webviewTag: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      preload: path.join(HERE, "preload.cjs"),
    },
  });
  keepButtonsInPlace(win);
  installContextMenu(win);
  if (process.platform !== "darwin") {
    // Zoom and devtools without the stock menu bar, which used to own
    // their accelerators. macOS keeps its menu and its roles instead.
    win.webContents.on("before-input-event", (_event, input) => {
      if (input.type !== "keyDown") return;
      const isZoomIn = input.control && (input.key === "=" || input.key === "+");
      if (isZoomIn) {
        win.webContents.setZoomLevel(Math.min(win.webContents.getZoomLevel() + 0.5, 5));
        return;
      }
      const isZoomOut = input.control && input.key === "-";
      if (isZoomOut) {
        win.webContents.setZoomLevel(Math.max(win.webContents.getZoomLevel() - 0.5, -4));
        return;
      }
      const isZoomReset = input.control && input.key === "0";
      if (isZoomReset) {
        win.webContents.setZoomLevel(0);
        return;
      }
      const isDevtools =
        input.control && input.shift && input.key.toLowerCase() === "i";
      // devtools without a menu bar: the stock View menu was the only
      // way in, and packaged builds have no use for it
      if (isDevtools && !app.isPackaged) win.webContents.toggleDevTools();
    });
  }
  persistWindowState(win);
  if (restored.maximized) win.maximize();

  // Links in this app come from models and from web pages the agent read,
  // so every URL is treated as hostile until proven to be plain http(s):
  // those open in the real browser, and everything else is dropped. The
  // app frame itself never navigates anywhere but its own origin.
  guardNavigation(win);

  if (app.isPackaged) {
    win.loadURL(serverStarted ? `http://127.0.0.1:${serverPort}` : startupFailure);
  } else {
    win.loadURL(DEV_URL);
  }
}

// ── permissions the web layer cannot ask for ───────────────────────────

handle("screen:frame", async (event) => {
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: { width: 1280, height: 800 },
  });
  return sources[0]?.thumbnail.toDataURL() ?? null;
});

handle("perm:status", () => ({
  mic: systemPreferences.getMediaAccessStatus?.("microphone") ?? "unknown",
  screen: systemPreferences.getMediaAccessStatus?.("screen") ?? "unknown",
}));

handle("perm:request-mic", async () => {
  try {
    return await systemPreferences.askForMediaAccess("microphone");
  } catch {
    return false;
  }
});

/**
 * Screen Recording has no request API, and an app does not even appear in
 * the System Settings pane until macOS has seen it attempt a capture.
 * Electron's thumbnail call does not reliably register one on current
 * macOS, so a tiny signed helper calls CGRequestScreenCaptureAccess
 * directly. Being a child of this app, it inherits the app's identity, so
 * the prompt and the pane entry both say Bloks.
 */
handle("perm:request-screen", async () => {
  try {
    const helper = nativeHelper("perm-helper");
    await new Promise((resolve) => {
      execFile(helper, ["request"], { timeout: 15_000 }, () => resolve());
    });
  } catch {
    // No helper and no toolchain to build one. Report whatever macOS
    // already believes instead of failing the call.
  }
  return systemPreferences.getMediaAccessStatus?.("screen") ?? "unknown";
});

/** Once denied, macOS will not ask again. Deep-link to the exact pane. */
handle("perm:open-settings", (_event, pane) => {
  const panes = {
    mic: "Privacy_Microphone",
    screen: "Privacy_ScreenCapture",
    accessibility: "Privacy_Accessibility",
    speech: "Privacy_SpeechRecognition",
  };
  return shell.openExternal(
    `x-apple.systempreferences:com.apple.preference.security?${panes[pane] ?? "Privacy"}`,
  );
});

/**
 * A banner, and a way back to what it is about.
 *
 * The renderer decides whether anything is worth showing (see
 * src/lib/notify.ts); this only shows it, because Notification belongs
 * to the main process and the click has to raise a window the renderer
 * cannot raise itself.
 */
/** The banner each conversation currently has up, so a chatty agent
 * replaces its own banner rather than papering the corner of the screen
 * with copies. Keyed by target: one banner per conversation. */
const standingBanners = new Map();

/** The agent's face for the banner, fetched from the harness. Answers
 * null quickly and quietly whenever it cannot: an iconless banner is
 * fine, a banner that arrives late is not. */
async function bannerIcon(avatar) {
  if (typeof avatar !== "string" || !avatar.startsWith("/api/")) return null;
  try {
    const response = await fetch(`http://127.0.0.1:${serverPort}${avatar}`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) return null;
    const image = nativeImage.createFromBuffer(Buffer.from(await response.arrayBuffer()));
    return image.isEmpty() ? null : image;
  } catch {
    return null;
  }
}

handle("notify:show", async (event, notice) => {
  if (!Notification.isSupported()) return;
  const target = String(notice?.target ?? "");
  const icon = await bannerIcon(notice?.avatar);
  const shown = new Notification({
    title: String(notice?.title ?? "Bloks").slice(0, 120),
    body: String(notice?.body ?? "").slice(0, 400),
    silent: !notice?.urgent,
    ...(icon ? { icon } : {}),
  });
  // the previous banner from this conversation is old news now
  if (target) {
    standingBanners.get(target)?.close();
    standingBanners.set(target, shown);
    shown.on("close", () => {
      if (standingBanners.get(target) === shown) standingBanners.delete(target);
    });
  }
  shown.on("click", () => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    app.focus?.({ steal: true });
    win.webContents.send("notify:activate", { target: notice?.target ?? "" });
  });
  shown.show();
});

/**
 * The real folder picker, for every place the app asks for a folder.
 * Typing a path stays possible; this is for everyone who should not
 * have to know what an absolute path is. Answers null on cancel.
 */
handle("dialog:pick-folder", async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) return null;
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    properties: ["openDirectory", "createDirectory"],
  });
  return canceled ? null : (filePaths[0] ?? null);
});

/**
 * The Dock badge: how many conversations are waiting.
 *
 * The renderer owns the arithmetic, because only it knows what counts
 * as unread; this end only knows how each platform draws a number on an
 * icon. Windows has no badge, so it gets a small overlay on the taskbar
 * icon instead.
 */
let badgeOverlay = null;
handle("badge:set", (event, value) => {
  const count = normalizeBadgeCount(value);
  if (process.platform === "win32") {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return;
    badgeOverlay ??= nativeImage.createFromPath(APP_ICON).resize({ width: 16, height: 16 });
    win.setOverlayIcon(
      count > 0 && !badgeOverlay.isEmpty() ? badgeOverlay : null,
      count > 0 ? `${count} unread` : "",
    );
    return;
  }
  app.setBadgeCount(count);
});

// ── the About card's three questions ───────────────────────────────────
// What version am I, is there a newer one, and how do I get it. The
// updater itself runs on its own (see the whenReady block); these exist
// so a person can ask instead of waiting.

/**
 * Which kind of trouble an updater error is, so the About card can say
 * something true. A download or install that fails after the check went
 * through is not "didn't reach the server", and saying so sends people
 * looking at their wifi.
 */
function updateTrouble(message) {
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|net::ERR_|socket hang up|getaddrinfo/i.test(message)) {
    return "offline";
  }
  if (/latest-mac\.yml|ERR_UPDATER_(LATEST_VERSION_NOT_FOUND|CHANNEL_FILE_NOT_FOUND|NO_PUBLISHED_VERSIONS)|\b(403|429)\b|rate limit/i.test(message)) {
    return "server";
  }
  return "install";
}

/** Updater lines to ~/Library/Logs/Bloks/updater.log, trimmed at 1 MB. */
function updaterLogger() {
  const file = path.join(app.getPath("logs"), "updater.log");
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.statSync(file, { throwIfNoEntry: false })?.size > 1_000_000) fs.rmSync(file);
  } catch {
    // no log is better than no updater
  }
  const write = (level) => (...parts) => {
    try {
      fs.appendFileSync(file, `${new Date().toISOString()} ${level} ${parts.map(String).join(" ")}\n`);
    } catch {
      // same
    }
  };
  return { info: write("info"), warn: write("warn"), error: write("error"), debug: write("debug") };
}

/** How often a running app looks for a newer release. */
const RECHECK_UPDATES_MS = 4 * 60 * 60 * 1000;

/** The last thing the updater said, replayed to windows that ask. */
let updaterState = { state: "idle" };
/** The wait for a drain before an update installs, while there is one. */
let drainWaiting = null;

function showUpdate(next) {
  updaterState = next;
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send("update:state", updaterState);
  }
}

handle("app:version", () => app.getVersion());
handle("update:state", () => updaterState);
handle("update:check", async () => {
  if (!app.isPackaged) return { state: "dev" };
  try {
    await electronUpdater.autoUpdater.checkForUpdates();
  } catch {
    // the error event has already told the windows
  }
  return updaterState;
});
/** Before an update restarts Bloks, the harness finishes what is running
 * and starts nothing new, and this waits until it has or until its
 * deadline passes (server/drain.ts). Anything still running then is
 * picked up after the restart, and anything that arrived meanwhile waits
 * on disk. A harness that does not answer has nothing to wait for.
 * While it waits, the update card says what for, and can restart now or
 * call it off (electron/drain-wait.mjs). Answers how the wait ended. */
async function drainBeforeRestart() {
  // agents on another computer are that computer's to finish
  if (remoteProfile || !serverStarted) return "done";
  const ask = async (method) => {
    try {
      const response = await fetch(`http://127.0.0.1:${serverPort}/api/maintenance/drain`, {
        method,
        headers: { "content-type": "application/json" },
        body: method === "POST" ? "{}" : undefined,
        signal: AbortSignal.timeout(2000),
      });
      return response.ok ? await response.json() : null;
    } catch {
      return null;
    }
  };
  drainWaiting = drainWait(ask, {
    onProgress: (state) =>
      showUpdate({ ...updaterState, draining: { running: state.running.length, deadline: state.deadline } }),
  });
  const outcome = await drainWaiting.finished;
  drainWaiting = null;
  const { draining: _, ...rest } = updaterState;
  showUpdate(rest);
  return outcome;
}

/** A restart asked for and on its way, through its last look and the
 * drain, so a second press does not start another. */
let installing = false;

handle("update:install", async () => {
  if (!app.isPackaged || drainWaiting || installing) return;
  installing = true;
  try {
    // a newer release than the one downloaded is the one to restart into
    // (electron/update-check.mjs)
    await newestBeforeInstall(electronUpdater.autoUpdater);
    if ((await drainBeforeRestart()) === "cancel") return;
    // same teardown as a normal quit, then the installer takes over
    electronUpdater.autoUpdater.quitAndInstall();
  } finally {
    installing = false;
  }
});
handle("update:restart-now", () => drainWaiting?.stop("now"));
handle("update:later", () => drainWaiting?.stop("cancel"));

// Some settings only take effect at start, pairing above all: widening
// what the server listens on is deliberately not a live change. This is
// how the renderer offers to do the restart instead of asking somebody to
// find Quit and then find the app again. relaunch() schedules the new
// process; quit() then runs the normal teardown, daemon and all.
handle("app:relaunch", () => {
  app.relaunch();
  app.quit();
});

handle("shortcut:apply", (_event, accelerator) =>
  applyQuickShortcut(typeof accelerator === "string" && accelerator ? accelerator : null),
);
handle("quick:hide", () => quickWin?.hide());
handle("quick:open-main", () => {
  quickWin?.hide();
  const [main] = BrowserWindow.getAllWindows().filter((w) => w !== quickWin);
  if (!main || main.isDestroyed()) return;
  if (main.isMinimized()) main.restore();
  main.show();
  main.focus();
  app.focus?.({ steal: true });
});

/**
 * Touch ID, for the few things that deserve it.
 *
 * A signed helper rather than a node module: LocalAuthentication needs
 * to be asked by the app itself for the prompt to carry the app's name,
 * which is the same reason the screen and dictation helpers exist. The
 * answer is one word, and "unavailable" is a normal answer rather than
 * an error: plenty of Macs have no sensor, and the caller decides what
 * that means rather than being handed an exception.
 */
function askHelper(args) {
  return new Promise((resolve) => {
    let helper;
    try {
      helper = nativeHelper("auth-helper");
    } catch {
      resolve("unavailable");
      return;
    }
    execFile(helper, args, { timeout: 130_000 }, (error, stdout) => {
      resolve(error ? "unavailable" : stdout.trim() || "unavailable");
    });
  });
}

handle("auth:status", () =>
  process.platform === "darwin" ? askHelper(["check"]) : Promise.resolve("unavailable"),
);

handle("auth:confirm", (_event, reason) => {
  if (process.platform !== "darwin") return "unavailable";
  const said = typeof reason === "string" ? reason.slice(0, 120) : "";
  return askHelper(["ask", said]);
});

handle("speech:start", (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) startSpeech(win);
});
handle("speech:stop", () => stopSpeech());
handle("meeting:start", (event, options) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) startMeeting(win, { system: Boolean(options?.system) });
});
handle("meeting:stop", () => stopMeeting());

// ── lifecycle ──────────────────────────────────────────────────────────

/** Whatever the user saved last time, straight from the config file the
 * harness owns. Read rather than waited for: the hotkey should work
 * before anyone opens a window. */
async function restoreQuickShortcut() {
  try {
    const { readFileSync } = await import("node:fs");
    const { homedir } = await import("node:os");
    const raw = JSON.parse(
      readFileSync(path.join(homedir(), ".bloks", "config.json"), "utf8"),
    );
    applyQuickShortcut(raw?.shortcuts?.quickAsk ?? null);
  } catch {
    // no config yet, which means no shortcut yet
  }
}

app.whenReady().then(async () => {
  if (process.platform === "darwin") app.dock.setIcon(APP_ICON);

  // The stock File/Edit/View menu says nothing this app needs: it has its
  // own right-click menu for editing, and nothing else in the bar is
  // reachable from the UI. macOS keeps a menu: the hidden-inset titlebar
  // and the platform conventions expect one, and it is the stock one with
  // Settings added (electron/app-menu.mjs).
  if (process.platform === "darwin") {
    Menu.setApplicationMenu(
      Menu.buildFromTemplate(appMenuTemplate({ name: app.name, packaged: app.isPackaged, command: menuCommand })),
    );
  } else {
    Menu.setApplicationMenu(null);
  }

  // getDisplayMedia in the renderer routed through here keeps the whole
  // capture inside the app's processes, which is the path macOS reliably
  // attributes to the app.
  session.defaultSession.setDisplayMediaRequestHandler(
    (_request, callback) => {
      desktopCapturer
        .getSources({ types: ["screen"] })
        .then((sources) => callback(sources[0] ? { video: sources[0] } : {}))
        .catch(() => callback({}));
    },
    { useSystemPicker: false },
  );

  // Electron grants permission requests by default. This app needs exactly
  // two, and the renderer shows untrusted content, so everything else is
  // refused explicitly rather than left to a default.
  const GRANTED = new Set(["media", "clipboard-sanitized-write"]);
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) =>
    callback(GRANTED.has(permission)),
  );
  session.defaultSession.setPermissionCheckHandler((_contents, permission) =>
    GRANTED.has(permission),
  );

  // Must precede every fork below, or the children keep launchd's PATH.
  await adoptLoginShellPath();

  registerCuaIpc(handle);
  // Started before the window so the harness can read the connection
  // descriptor on its first turn. Failure is survivable: computer use
  // reports itself unavailable and everything else works.
  startCua().catch((error) => console.error("[cua] start failed:", error));

  if (app.isPackaged) {
    const remote = readRemoteProfile();
    serverStarted = remote ? await startRemote(remote) : await startServer();
    if (!remote && serverStarted) keeper.watch(serverProcess);
  }
  createWindow();
  // On Windows and Linux a link that opened Bloks is one of its own
  // arguments, and only a second launch's were ever read. It waits for
  // the window to ask, like any link that arrives while the page loads.
  const opening = linkInArgv(process.argv);
  if (opening) deliverLink(opening);

  // Update check, after the window exists so a prompt has somewhere to
  // land. Packaged builds only: a dev checkout updating itself from
  // GitHub releases would be chaos. Failures are logged and swallowed,
  // because "the update server was unreachable" is never worth
  // interrupting anyone over.
  if (app.isPackaged) {
    const { autoUpdater } = electronUpdater;
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    // Every updater event folds into one state frame the renderer can
    // draw: the About card shows checking, downloading, ready or quiet,
    // and never has to know the updater's own event vocabulary.
    // One waiting to be installed goes on saying so through a look past
    // it (electron/update-check.mjs).
    const tellWindows = (event, detail) => {
      const next = updateFrame(updaterState, event, detail);
      if (next) showUpdate(next);
    };
    autoUpdater.on("checking-for-update", () => tellWindows("checking"));
    autoUpdater.on("update-available", (info) => tellWindows("available", { version: info?.version }));
    autoUpdater.on("update-not-available", () => tellWindows("not-available"));
    autoUpdater.on("download-progress", (progress) =>
      tellWindows("progress", { percent: Math.round(progress?.percent ?? 0) }),
    );
    autoUpdater.on("update-downloaded", (info) => tellWindows("downloaded", { version: info?.version }));
    // A Finder launch sends stdout to /dev/null, so the updater writes its
    // own log. Without it a failed update leaves nothing to read afterwards.
    autoUpdater.logger = updaterLogger();
    autoUpdater.on("error", (error) => {
      const message = String(error?.message ?? error);
      console.error("[updater]", message);
      autoUpdater.logger.error(message);
      tellWindows("error", { reason: updateTrouble(message) });
    });
    autoUpdater.checkForUpdatesAndNotify().catch(() => {});
    // Again every few hours. Most people leave Bloks open for days, and a
    // check only at launch meant they never heard about a release until
    // they happened to quit. Not while one is already downloading. One
    // waiting to be installed is looked past: a release since it came
    // down is the one to install (GitHub 247).
    setInterval(() => {
      if (!mayLookAgain(updaterState)) return;
      autoUpdater.checkForUpdates().catch(() => {});
    }, RECHECK_UPDATES_MS).unref?.();
  }

  void restoreQuickShortcut();
  watchPower();

  app.on("activate", () => {
    // the panel is not a window worth reopening the app for
    const windows = BrowserWindow.getAllWindows().filter((w) => w !== quickWin);
    if (windows.length === 0) createWindow();
  });
});

// ── sleep ─────────────────────────────────────────────────────────────
// Two small things so a laptop is a better home for agents.
//
// While any agent is mid-turn, the Mac is kept from idle sleep: walking
// away from a long task should not end it. Only idle sleep. Closing the
// lid still sleeps the machine, which is macOS's call and the right one,
// and the lock is let go the moment nothing is working.
//
// And the harness is told when the machine sleeps and wakes, so a turn
// the sleep cut off is picked up again rather than left failed.
let awakeLock = null;

async function power(state) {
  try {
    const response = await fetch(`http://127.0.0.1:${serverPort}/api/power`, {
      method: state ? "POST" : "GET",
      headers: { "content-type": "application/json" },
      body: state ? JSON.stringify({ state }) : undefined,
      signal: AbortSignal.timeout(2000),
    });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

function watchPower() {
  // agents on another computer are that computer's to keep awake
  if (remoteProfile) return;
  const check = async () => {
    const status = await power();
    const working = Boolean(status?.working);
    if (working && awakeLock === null) awakeLock = powerSaveBlocker.start("prevent-app-suspension");
    if (!working && awakeLock !== null) {
      powerSaveBlocker.stop(awakeLock);
      awakeLock = null;
    }
  };
  setInterval(() => void check(), 15_000).unref?.();
  void check();
  powerMonitor.on("suspend", () => void power("suspend"));
  powerMonitor.on("resume", () => void power("resume"));
}

// ── a Bloks on another computer ───────────────────────────────────────
// When this app is paired with an always-on computer (bloks-server), it
// runs no server of its own: electron/remote.mjs stands in on loopback
// and carries every call through Bloks Cloud. Running both would mean two
// copies of the same agents answering, so it is one or the other, and
// switching restarts the app.
//
// The profile holds the device token its keys come from, so it is kept
// encrypted by the operating system's keychain, never in plain text.
let remoteProfile = null;
let remoteState = { connected: false };

function remoteFile() {
  return path.join(app.getPath("userData"), "remote.bin");
}

function readRemoteProfile() {
  try {
    if (!fs.existsSync(remoteFile()) || !safeStorage.isEncryptionAvailable()) return null;
    const profile = JSON.parse(safeStorage.decryptString(fs.readFileSync(remoteFile())));
    return profile?.deviceId && profile.deviceToken && profile.relayUrl ? profile : null;
  } catch {
    return null;
  }
}

function saveRemoteProfile(profile) {
  if (!profile) {
    fs.rmSync(remoteFile(), { force: true });
    return;
  }
  if (!safeStorage.isEncryptionAvailable()) throw new Error("This computer cannot keep the pairing safely, so it was not saved.");
  fs.writeFileSync(remoteFile(), safeStorage.encryptString(JSON.stringify(profile)), { mode: 0o600 });
}

/** The port the remote proxy had last time. The window's storage (folded
 * sections, the sidebar's width, cards you closed) belongs to its origin,
 * and the origin includes the port, so a fresh port every launch quietly
 * forgot all of it. */
const REMOTE_PORT_FILE = () => path.join(app.getPath("userData"), "remote-port.json");

function readRemotePort() {
  try {
    const port = JSON.parse(fs.readFileSync(REMOTE_PORT_FILE(), "utf8")).port;
    return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
  } catch {
    return null;
  }
}

async function startRemote(profile) {
  try {
    const system = { darwin: "macOS", win32: "Windows", linux: "Linux" }[process.platform] ?? process.platform;
    const options = {
      staticDir: path.join(process.resourcesPath, "ui"),
      client: `${system} ${app.getVersion()}`,
      onState: (state) => {
        remoteState = state;
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) win.webContents.send("remote:state", { host: profile.host, ...state });
        }
      },
    };
    const remembered = readRemotePort();
    let proxy;
    try {
      proxy = await startRemoteProxy(profile, { ...options, port: remembered ?? 0 });
    } catch (error) {
      // that port is someone else's now; any free one, remembered from here
      if (!remembered) throw error;
      proxy = await startRemoteProxy(profile, { ...options, port: 0 });
    }
    try {
      fs.writeFileSync(REMOTE_PORT_FILE(), JSON.stringify({ port: proxy.port }));
    } catch {
      /* next launch picks another, as before */
    }
    remoteProfile = profile;
    serverPort = proxy.port;
    return true;
  } catch (error) {
    console.error("[remote] could not start:", error?.message ?? error);
    return false;
  }
}

handle("remote:status", () =>
  remoteProfile ? { mode: "remote", host: remoteProfile.host, ...remoteState } : { mode: "local" },
);
handle("remote:connect", async (event, link) => {
  if (!app.isPackaged) return { error: "Connecting to another computer works in the installed app." };
  try {
    const profile = await claimPairLink(String(link ?? ""), `${os.hostname().replace(/\.local$/, "")} (desktop)`);
    saveRemoteProfile(profile);
  } catch (error) {
    return { error: error?.message ?? String(error) };
  }
  // exit skips before-quit, so the server is stopped here, or on Windows
  // it would be ended outright and leave its lock behind
  quitting = true;
  await stopServer(serverProcess);
  app.relaunch();
  app.exit(0);
  return { ok: true };
});
handle("remote:disconnect", () => {
  saveRemoteProfile(null);
  app.relaunch();
  app.exit(0);
  return { ok: true };
});

// The system keeps handing us these keys until we say otherwise.
app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  stopMeeting();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// The embedded daemon cleans up asynchronously, and none of that can run
// once the host process is gone. So the first quit is deferred until it
// finishes, then allowed through. The server is asked to stop before it
// is killed, so it ends its engines and gives up the data folder itself
// (electron/server-life.mjs).
let daemonStopped = false;
app.on("before-quit", (event) => {
  quitting = true;
  if (daemonStopped) return;
  event.preventDefault();
  Promise.allSettled([stopServer(serverProcess), stopCua()]).finally(() => {
    daemonStopped = true;
    app.quit();
  });
});
