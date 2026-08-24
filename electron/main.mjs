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
  desktopCapturer,
  globalShortcut,
  ipcMain,
  nativeTheme,
  Notification,
  screen,
  session,
  shell,
  systemPreferences,
  utilityProcess,
} from "electron";
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

// vendored by scripts/bundle-updater.mjs: the packaged app has no
// node_modules, so the updater travels inside electron/ pre-bundled
import electronUpdater from "./vendor/electron-updater.cjs";

import { startCua, stopCua, registerCuaIpc } from "./cua.mjs";
import { nativeHelper } from "./native-helper.mjs";
import { startSpeech, stopSpeech } from "./speech.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ICON = path.join(HERE, "resources/app-icon.png");

// Spelled as an IPv4 literal, not "localhost": Vite binds v4, and the name
// can resolve to ::1 first, which paints an empty window.
const DEV_URL = process.env.ELECTRON_START_URL ?? "http://127.0.0.1:5199";

/** Ports to try, in order. A stray process on the usual one should cost a
 * few seconds, not the whole app. */
const CANDIDATE_PORTS = [8799, 18799, 28799];

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
    stdio: "inherit",
  });

  let exited = false;
  child.once("exit", () => {
    exited = true;
  });

  // First run on a fresh machine writes its data directories before it
  // listens, so this waits rather than assuming a fast start.
  for (let attempt = 0; attempt < 40; attempt++) {
    if (exited) return null;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) {
        const body = await response.json().catch(() => null);
        if (body?.app === "bloks" && body.pid === child.pid && body.static) return child;
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
  return null;
}

async function startServer() {
  // Quit-and-reopen can race the previous instance's teardown, so the
  // whole sweep is tried twice before giving up.
  for (let round = 0; round < 2; round++) {
    for (const port of CANDIDATE_PORTS) {
      const child = await startServerOn(port);
      if (child) {
        serverProcess = child;
        serverPort = port;
        return true;
      }
    }
    await pause(2500);
  }
  return false;
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Shown when every port was taken. Inline rather than a file, because a
 * failure this early should not depend on anything else having loaded. */
const STARTUP_FAILURE_PAGE =
  "data:text/html;charset=utf-8," +
  encodeURIComponent(
    `<body style="margin:0;display:flex;align-items:center;justify-content:center;height:100vh;background:${DARK_BACKDROP};color:#ededf0;font:15px -apple-system,system-ui">` +
      `<div style="text-align:center;max-width:380px">` +
      `<div style="font-size:42px;color:#7c8aff">▦</div>` +
      `<h2 style="font-weight:600;margin:12px 0 6px">Couldn't start the Bloks server</h2>` +
      `<p style="color:#8f8f99;line-height:1.5">Something else is using its ports. Quit and reopen Bloks. If it keeps happening, restart your Mac.</p>` +
      `</div></body>`,
  );

// ── the window ─────────────────────────────────────────────────────────

const isHttpUrl = (url) => {
  try {
    const { protocol } = new URL(url);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
};

const isOurOwnPage = (url) => {
  try {
    const { hostname } = new URL(url);
    return hostname === "127.0.0.1" || hostname === "localhost";
  } catch {
    return false;
  }
};

/**
 * Where the three window buttons sit.
 *
 * The cluster is 52px wide (three 12px buttons, 20px apart). At x:16 it
 * ends at 68, which leaves exactly 16px to the 84px rail's edge: the
 * group sits centred, with even margins on both sides. macOS
 * forgets this position on its own: leaving full screen, changing
 * display scale and some resizes all reset it, which is how the green
 * button ends up back over the divider after a while. So it is applied
 * again on each of those, rather than only at creation.
 */
const BUTTONS = { x: 16, y: 16 };

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
      : STARTUP_FAILURE_PAGE
    : DEV_URL;
  return query ? `${base}${base.includes("?") ? "&" : "?"}${query}` : base;
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
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  quickWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
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
  // Fit the display, never exceed it. A window taller than the screen
  // puts the composer below the bottom edge, which reads as "the app has
  // no way to type" rather than "the window is too big". workArea already
  // excludes the menu bar and the Dock, so this is the space we may use.
  const { width: screenW, height: screenH } = screen.getPrimaryDisplay().workAreaSize;
  const width = Math.min(1440, screenW);
  const height = Math.min(920, screenH);

  const win = new BrowserWindow({
    width,
    height,
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

  // Links in this app come from models and from web pages the agent read,
  // so every URL is treated as hostile until proven to be plain http(s):
  // those open in the real browser, and everything else is dropped. The
  // app frame itself never navigates anywhere but its own origin.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isHttpUrl(url)) shell.openExternal(url);
    return { action: "deny" };
  });

  win.webContents.on("will-navigate", (event, url) => {
    if (isOurOwnPage(url)) return; // the app reloading itself
    event.preventDefault();
    if (isHttpUrl(url)) shell.openExternal(url);
  });

  // A compromised renderer must not be able to grow itself new surfaces.
  win.webContents.on("will-attach-webview", (event) => event.preventDefault());

  if (app.isPackaged) {
    win.loadURL(serverStarted ? `http://127.0.0.1:${serverPort}` : STARTUP_FAILURE_PAGE);
  } else {
    win.loadURL(DEV_URL);
  }
}

// ── permissions the web layer cannot ask for ───────────────────────────

ipcMain.handle("screen:frame", async () => {
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: { width: 1280, height: 800 },
  });
  return sources[0]?.thumbnail.toDataURL() ?? null;
});

ipcMain.handle("perm:status", () => ({
  mic: systemPreferences.getMediaAccessStatus?.("microphone") ?? "unknown",
  screen: systemPreferences.getMediaAccessStatus?.("screen") ?? "unknown",
}));

ipcMain.handle("perm:request-mic", async () => {
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
ipcMain.handle("perm:request-screen", async () => {
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
ipcMain.handle("perm:open-settings", (_event, pane) => {
  const panes = {
    mic: "Privacy_Microphone",
    screen: "Privacy_ScreenCapture",
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
ipcMain.handle("notify:show", (event, notice) => {
  if (!Notification.isSupported()) return;
  const shown = new Notification({
    title: String(notice?.title ?? "Bloks").slice(0, 120),
    body: String(notice?.body ?? "").slice(0, 400),
    silent: !notice?.urgent,
  });
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

ipcMain.handle("shortcut:apply", (_event, accelerator) =>
  applyQuickShortcut(typeof accelerator === "string" && accelerator ? accelerator : null),
);
ipcMain.handle("quick:hide", () => quickWin?.hide());
ipcMain.handle("quick:open-main", () => {
  quickWin?.hide();
  const [main] = BrowserWindow.getAllWindows().filter((w) => w !== quickWin);
  if (!main || main.isDestroyed()) return;
  if (main.isMinimized()) main.restore();
  main.show();
  main.focus();
  app.focus?.({ steal: true });
});

ipcMain.handle("speech:start", (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) startSpeech(win);
});
ipcMain.handle("speech:stop", () => stopSpeech());

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

  registerCuaIpc();
  // Started before the window so the harness can read the connection
  // descriptor on its first turn. Failure is survivable: computer use
  // reports itself unavailable and everything else works.
  startCua().catch((error) => console.error("[cua] start failed:", error));

  if (app.isPackaged) serverStarted = await startServer();
  createWindow();

  // Update check, after the window exists so a prompt has somewhere to
  // land. Packaged builds only: a dev checkout updating itself from
  // GitHub releases would be chaos. Failures are logged and swallowed,
  // because "the update server was unreachable" is never worth
  // interrupting anyone over.
  if (app.isPackaged) {
    const { autoUpdater } = electronUpdater;
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on("error", (error) => console.error("[updater]", error?.message ?? error));
    autoUpdater.checkForUpdatesAndNotify().catch(() => {});
  }

  void restoreQuickShortcut();

  app.on("activate", () => {
    // the panel is not a window worth reopening the app for
    const windows = BrowserWindow.getAllWindows().filter((w) => w !== quickWin);
    if (windows.length === 0) createWindow();
  });
});

// The system keeps handing us these keys until we say otherwise.
app.on("will-quit", () => globalShortcut.unregisterAll());

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// The embedded daemon cleans up asynchronously, and none of that can run
// once the host process is gone. So the first quit is deferred until it
// finishes, then allowed through.
let daemonStopped = false;
app.on("before-quit", (event) => {
  if (daemonStopped) return;
  event.preventDefault();
  try {
    serverProcess?.kill();
  } catch {
    /* already down */
  }
  stopCua().finally(() => {
    daemonStopped = true;
    app.quit();
  });
});
