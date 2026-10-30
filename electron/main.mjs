// The desktop shell.
//
// Three jobs, in this order: bring up the harness servers, one for each
// workspace on this computer, open a window pointed at the one you are
// in, and own the macOS permissions the web layer cannot ask for on its
// own.
//
// The permissions part is the reason this file is more than a window
// factory. Screen Recording and Microphone are granted by macOS to an
// *application*, identified by its signature, so anything that triggers
// those prompts has to run inside the app's own processes. A helper the
// server spawned would prompt as some anonymous binary, or not appear in
// System Settings at all.
import {
  app,
  autoUpdater as nativeUpdater,
  BrowserWindow,
  clipboard,
  crashReporter,
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
  ShareMenu,
  systemPreferences,
  Tray,
  utilityProcess,
  WebContentsView,
} from "electron";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { overlayChoice, renderBadge } from "./taskbar-badge.mjs";
import { normalizeBadgeCount, resolveWindowState } from "./window-state.mjs";
import { appMenuTemplate, TAB_COMMANDS } from "./app-menu.mjs";
import { menuLanguage, menuWords } from "./menu-words.mjs";
import { drainWait } from "./drain-wait.mjs";
import { mayLookAgain, newestBeforeInstall, updateFrame } from "./update-check.mjs";
import { markInstall, restartIntoUpdate, takeInstallMark, within } from "./update-restart.mjs";
import { claimPairLink, reachOf, startLanProxy, startRemoteProxy } from "./remote.mjs";
import { nativeSettingsObservation } from "./settings-observation.mjs";
import { sameAppOrigin } from "./navigation.mjs";
import { installLink, joinLink, linkInArgv, planLink, teamLink } from "./links.mjs";
import { licencePrint, withLicence } from "./plan-link.mjs";
import { keepPlan, planFromReport, readKeptPlan } from "./account-plan.mjs";
import {
  AUTO_DELAY_MS,
  autoMoveFrom,
  doneWords,
  hostingRunning,
  keepMoveState,
  newMove,
  readMoveState,
  runMove,
  startingWords,
} from "./hosting-move.mjs";
import { HOSTED_TARGET, OWN_LOCAL_KINDS, ServerAsks, othersFor, pairRefusal } from "./server-line.mjs";
import { terminalQuery } from "./terminal-window.mjs";
import { conversationTarget, createNotch, notchPlatform } from "./notch.mjs";
import { closeHides, trayOn } from "./tray.mjs";
import { AppBrowser, allowedForAgent, downloadName, partitionFor, refusedNavigation } from "./app-browser.mjs";
import os from "node:os";

// vendored by scripts/bundle-updater.mjs: the packaged app has no
// node_modules, so the updater travels inside electron/ pre-bundled
import electronUpdater from "./vendor/electron-updater.cjs";

import { startCua, stopCua, registerCuaIpc } from "./cua.mjs";
import { nativeHelper } from "./native-helper.mjs";
import { anyFreePort, failurePage, parseLsof, portFree, portOrder } from "./ports.mjs";
import { keepServerUp, stopServer } from "./server-life.mjs";
import { createAppLog, lineBudget } from "./app-log.mjs";
import { stoppedPage, watchRenderer } from "./renderer-watch.mjs";
import {
  PERSONAL_ID,
  accentOf,
  addWorkspace,
  chooseAccent,
  allowsNotice,
  badgeTotal,
  configuredPort,
  keepOwnerName,
  markDefault,
  mergeDrains,
  muteFor,
  NOTIFY_LEVELS,
  nextMuteEnd,
  oneAtATime,
  readRegistry,
  addHosted,
  markMoved,
  isRemoteKind,
  removeWorkspace,
  reorder,
  rerollMark,
  setCurrent,
  setSameAccent,
  setLanguage,
  setNotch,
  setTray,
  settle,
  shownMark,
  snapshot,
  updateWorkspace,
  writeRegistry,
} from "./workspaces.mjs";
import { startMeeting, startSpeech, stopMeeting, stopSpeech } from "./speech.mjs";
import { createAttentionSayer } from "./attention-said.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ICON = path.join(HERE, process.platform === "darwin"
  ? "resources/app-icon-mac.png" : "resources/app-icon.png");

// Spelled as an IPv4 literal, not "localhost": Vite binds v4, and the name
// can resolve to ::1 first, which paints an empty window.
const DEV_URL = process.env.ELECTRON_START_URL ?? "http://127.0.0.1:5199";

/** Whether this run starts servers of its own: the installed app always
 * does; a development run only when asked (BLOKS_DEV_WORKSPACES=1, after
 * `pnpm build`), since `pnpm dev` already has its server and its Vite. */
const HOSTS_SERVERS = app.isPackaged || process.env.BLOKS_DEV_WORKSPACES === "1";

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

/** Set once Bloks starts quitting: the servers going away is expected
 * from then on, and none is brought back. */
let quitting = false;

// A native crash in any of Bloks' processes leaves a minidump in this
// computer's crash folder (app.getPath("crashDumps")), and nothing else:
// no upload, no server to send one to. macOS still writes its own report.
crashReporter.start({ uploadToServer: false });

/** The app's own log, in its logs folder (electron/app-log.mjs). Made on
 * first use, once the logs folder has been settled. */
let appLogFile = null;
const appLog = (text) => (appLogFile ??= createAppLog(app.getPath("logs"))).write(text);

// A helper process that went away (the GPU process, a workspace's
// server, the network service) says so in the log, with why.
app.on("child-process-gone", (_event, details) => {
  if (quitting && details.reason === "clean-exit") return;
  appLog(`process gone: ${details.type}${details.name ? ` (${details.name})` : ""}, ${details.reason}, exit code ${details.exitCode}`);
});

// One Bloks per user. A second launch would fork a second harness onto a
// fallback port and quietly split the workspace in two, so the loser
// exits before it has started anything, and the winner brings its own
// window forward when that happens.
if (!app.requestSingleInstanceLock()) {
  app.exit(0);
}

// bloks:// links from the website ("Add to Bloks" on a team in the
// gallery), and bloks://install?url= for a team or a skill anywhere on
// https. What either opens is the same review a person sees when
// importing by hand, so nothing is created until they confirm it. macOS hands links over with open-url, the
// others as an argument, to a second launch or to the one the link
// started (electron/links.mjs).
// A development run that starts its own servers is a throwaway, often on
// a throwaway user data folder, and must not take bloks:// links away
// from the installed app.
if (app.isPackaged || !HOSTS_SERVERS) app.setAsDefaultProtocolClient("bloks");
let pendingLink = null;
function deliverLink(raw) {
  const link = teamLink(raw) ?? joinLink(raw) ?? planLink(raw) ?? installLink(raw);
  if (!link) return;
  const main = BrowserWindow.getAllWindows().find((w) => isWorkspaceWindow(w));
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
  // The conversation tabs' items (⌘T, ⌘W, ⌘⇧[ and ⌘⇧]) are about the
  // window in front, and with none in front there is nothing for them to
  // do: they never open a window or wait for one, and never reach a
  // workspace window behind a terminal's. A window with no conversations
  // in it takes ⌘W as the Close it always was. The page plays the rest
  // as the keys they are (src/lib/conversationKeys.ts).
  if (TAB_COMMANDS.includes(command)) {
    const front = BrowserWindow.getFocusedWindow();
    if (!front || front.isDestroyed()) return;
    if (command === "closeConversation" && !isWorkspaceWindow(front)) front.close();
    else front.webContents.send("menu:command", command);
    return;
  }
  const main = BrowserWindow.getAllWindows().find((w) => isWorkspaceWindow(w));
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
  const main = BrowserWindow.getAllWindows().find((w) => isWorkspaceWindow(w));
  if (!main) return;
  if (main.isMinimized()) main.restore();
  main.show();
  main.focus();
  app.focus?.({ steal: true });
});

// ── the harness servers ────────────────────────────────────────────────
// One per workspace (electron/workspaces.mjs), each on its own data
// folder and its own port, and all of them kept running whichever one
// the window shows: a routine or a watcher in a workspace you are not
// looking at still has to run on time.

/** Where the server and the page it serves come from: the installed
 * app's Resources, or this checkout (built with `pnpm build`). */
function serverSource() {
  if (app.isPackaged) {
    return { entry: path.join(process.resourcesPath, "server", "index.js"), ui: path.join(process.resourcesPath, "ui"), execArgv: [] };
  }
  return { entry: path.join(HERE, "..", "server", "index.ts"), ui: path.join(HERE, "..", "dist"), execArgv: ["--experimental-strip-types", "--no-warnings"] };
}

/**
 * Start a workspace's server on one port and wait for it to prove it is
 * ours.
 *
 * A health check that only looks for HTTP 200 is not enough. A developer
 * running `pnpm dev:server` has the identical API on the identical port,
 * and attaching to it would give the packaged app someone else's
 * workspace. So the probe requires the pid we just forked and that the
 * responder is serving static files, which a dev server does not.
 */
async function startServerOn(port, ws) {
  const source = serverSource();
  const child = utilityProcess.fork(source.entry, [], {
    env: {
      ...process.env,
      BLOKS_STATIC_DIR: source.ui,
      BLOKS_PORT: String(port),
      // the workspace's own folder; Personal's is the ~/.bloks it always had
      BLOKS_DATA_DIR: ws.dataDir,
      // which workspace it is, for its relay space, and where all of them
      // live, so its agents are kept out of the others' folders too
      BLOKS_WORKSPACE_ID: ws.id,
      BLOKS_WORKSPACES_DIR: workspacesDir(),
      // what its invites and its welcome call it (server/members.ts); the
      // window says it again when the name or mark changes
      BLOKS_WORKSPACE_NAME: ws.name ?? "",
      BLOKS_WORKSPACE_KIND: ws.kind ?? "",
      BLOKS_WORKSPACE_COLOR: ws.mark?.color ?? "",
      BLOKS_WORKSPACE_PATTERN: ws.mark?.pattern ?? "",
    },
    execArgv: source.execArgv,
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
  // what the server says to the app: banners and waiting counts
  // (server/desktop-notice.ts), heard for as long as this one runs
  child.on("message", (said) => heardFromServer(ws.id, child, said));

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

/** The server that holds a data folder, when ours refused to start beside it. */
function dataFolderHolder(stderr) {
  const found = /DATA_FOLDER_IN_USE pid=(\d+) port=(\d+)/.exec(stderr ?? "");
  return found ? { pid: Number(found[1]), port: Number(found[2]) } : null;
}

/** The ports to try for a workspace. Personal keeps the order it always
 * had (BLOKS_PORT, its config.json, the last port, then the usual three),
 * because a phone paired on this network remembers that port. The others
 * go to the port each had last, or one of its config.json, or any free
 * one, and leave the usual three to Personal. */
function portsFor(ws, prefer) {
  if (ws.kind === "personal") {
    return portOrder({ prefer, env: process.env.BLOKS_PORT, configured: configuredPort(ws.dataDir), last: readLastPort() ?? ws.port });
  }
  return portOrder({ prefer, configured: configuredPort(ws.dataDir), last: ws.port, usual: [] });
}

/** The folder a person would recognise, for the failure page. */
const shownFolder = (dir) => {
  const home = os.homedir();
  return dir && dir.startsWith(home + path.sep) ? `~${dir.slice(home.length)}` : (dir ?? "");
};

/** Starts a workspace's server, trying each port in turn. `prefer` goes
 * first, and `rounds` is how many sweeps of the ports it gets. Answers
 * whether it came up; `run` holds the server, or why there is none. */
async function startServer(run, { prefer = null, rounds = 2 } = {}) {
  const attempts = [];
  let crash = "";
  // Another Bloks server already using this data folder, as the server
  // reports it (server/data-lock.ts). Another port would not help: it is
  // the folder that is taken, and two servers on it undo each other's work.
  let inUse = null;
  // Quit-and-reopen can race the previous instance's teardown, so the
  // whole sweep is tried twice before giving up; a folder still held is
  // given a few more rounds, since that is most often the last instance
  // on its way out.
  for (let round = 0; round < (inUse ? 5 : rounds); round++) {
    const ws = entryOf(run.id);
    if (!ws || run.stopped) return false;
    inUse = null;
    const ports = portsFor(ws, prefer);
    // every usual port busy is not the end: any free port will do
    const spare = await anyFreePort();
    if (spare) ports.push(spare);
    for (const port of ports) {
      if (!(await portFree(port))) {
        if (round === rounds - 1) attempts.push({ port, why: "busy", holder: await portHolder(port) });
        continue;
      }
      const started = await startServerOn(port, ws);
      if (started.child) {
        run.child = started.child;
        run.port = port;
        run.lastWords = started.lastWords;
        run.failure = null;
        run.problem = null;
        run.child.once("exit", () => {
          // on its way back (keepServerUp), unless this is the end
          if (run.child === started.child && !quitting && !run.stopped) setStatus(run, "starting");
        });
        rememberPort(ws, port);
        return true;
      }
      if (started.why === "exited" && started.stderr) crash = started.stderr;
      inUse = dataFolderHolder(started.stderr);
      if (inUse) break;
      if (round === rounds - 1) attempts.push({ port, why: started.why, holder: null });
    }
    await pause(2500);
  }
  const ws = entryOf(run.id);
  run.failure = failurePage({
    attempts,
    crash,
    inUse,
    folder: shownFolder(ws?.dataDir),
    backdrop: DARK_BACKDROP,
    machine: process.platform === "darwin" ? "Mac" : "computer",
  });
  run.problem = inUse
    ? "Another Bloks server is using its folder."
    : crash
      ? "Its server stopped while starting."
      : "No free port to start it on.";
  return false;
}

/** The port a workspace came up on, kept so its window's storage (which
 * belongs to the origin, port included) and a phone on this network find
 * it in the same place next time. */
function rememberPort(ws, port) {
  if (ws.kind === "personal") {
    try {
      fs.writeFileSync(LAST_PORT_FILE(), JSON.stringify({ port }));
    } catch {
      /* next launch simply starts from the usual ports */
    }
  }
  if (ws.port !== port) {
    registry = updateWorkspace(registry, ws.id, { port });
    saveRegistry();
  }
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Each workspace's server as this app knows it: its process and port,
 * whether it is up, and why not when it is not. */
const servers = new Map();

function runFor(id) {
  let run = servers.get(id);
  if (run) return run;
  run = { id, child: null, port: null, status: "stopped", problem: null, failure: null, lastWords: () => "", stopped: false, ready: null, keeper: null };
  // A server that dies after it started is brought back, on the port it
  // had when that is free; see electron/server-life.mjs. Each try is one
  // sweep of the ports, and a server that keeps dying is marked as
  // failed in the switcher, and on the page when it is the one shown,
  // instead of a window calling a port nobody answers on.
  run.keeper = keepServerUp({
    quitting: () => quitting || run.stopped,
    start: async () => ((await startServer(run, { prefer: run.port, rounds: 1 })) ? run.child : null),
    onBack: () => {
      handLicence(run);
      handName(run);
      handMark(run);
      handAttention(run);
      handBrowser(run);
      setStatus(run, "running");
      pointWindows(run.id);
    },
    onGaveUp: () => {
      // the last try that failed to start already says why; otherwise the
      // last one started and died like the rest
      run.failure ??= failurePage({
        attempts: [],
        crash: run.lastWords(),
        stopped: true,
        backdrop: DARK_BACKDROP,
        machine: process.platform === "darwin" ? "Mac" : "computer",
      });
      run.problem ??= "Its server kept stopping.";
      setStatus(run, "failed");
      pointWindows(run.id);
    },
  });
  servers.set(id, run);
  return run;
}

function setStatus(run, status) {
  if (run.status === status) return;
  run.status = status;
  tellWorkspaces();
}

/** Brings a workspace's server up, or answers the start already under
 * way. Resolves true once it answers, false when it would not start. */
function launch(id) {
  const run = runFor(id);
  if (run.status === "running") return Promise.resolve(true);
  if (run.status === "starting" && run.ready) return run.ready;
  run.stopped = false;
  run.problem = null;
  setStatus(run, "starting");
  const ws = entryOf(id);
  run.ready = (isRemoteKind(ws?.kind) ? openJoined(run, ws) : startServer(run)).then((up) => {
    if (up && run.child && !isRemoteKind(ws?.kind)) run.keeper.watch(run.child);
    if (up) handLicence(run);
    if (up) handName(run);
    if (up) handMark(run);
    if (up) handAttention(run);
    if (up) handBrowser(run);
    setStatus(run, up ? "running" : "failed");
    return up;
  });
  return run.ready;
}

// ── one Bloks Cloud licence for every workspace ─────────────────────────
// A licence is the person's, not a workspace's: typed once (in any
// workspace, or Personal's from before), it is kept here in the keychain
// and handed to every workspace's server as it starts, so putting another
// one online needs no key. It travels only over the line this app has to
// its own servers, never in their environment, where an agent's shell
// would read it.

const LICENCE = /^blok_live_[0-9a-f]{32}$/;
const licenceFile = () => path.join(app.getPath("userData"), "licence.bin");
let licence = null;

function readLicence() {
  if (licence) return licence;
  try {
    if (!safeStorage.isEncryptionAvailable()) return null;
    const said = safeStorage.decryptString(fs.readFileSync(licenceFile()));
    licence = LICENCE.test(said) ? said : null;
  } catch {
    licence = null;
  }
  return licence;
}

/** The licence's plan: "team", "cloud", or null for no licence, kept
 * here for every workspace (electron/account-plan.mjs) and on disk under
 * the licence's fingerprint, so a workspace made today is on the plan
 * from its first frame rather than on whatever its own empty folder
 * says. Undefined until anyone has said. */
const planFile = () => path.join(app.getPath("userData"), "account-plan.json");
const licencePrintNow = () => {
  const key = readLicence();
  return key ? licencePrint(key) : null;
};
let licencePlan = undefined;
let planRead = false;
function accountPlan() {
  if (!planRead) {
    planRead = true;
    licencePlan ??= readKeptPlan(planFile(), licencePrintNow());
  }
  return licencePlan;
}

/** A server's word on the plan: taken only when it was about the app's
 * own licence, then kept, and handed to every other server so their
 * gates and their Plan pages say the same. */
function notePlan(report) {
  const next = planFromReport(report, { hasLicence: Boolean(readLicence()) });
  if (next === undefined || next === accountPlan()) return;
  licencePlan = next;
  keepPlan(planFile(), licencePrintNow(), next);
  for (const run of servers.values()) handPlan(run);
  tellWorkspaces();
}

/** Hands the licence to one workspace's server, when there is one, with
 * the plan it is on as far as the app knows. */
function handLicence(run) {
  const key = readLicence();
  if (!key || !run?.child) return;
  const plan = accountPlan();
  try {
    run.child.postMessage({ kind: "licence", key, ...(plan !== undefined ? { plan } : {}) });
  } catch {
    /* a server on its way out hears it again when it is back */
  }
}

/** The plan alone, to a server that already holds the licence. */
function handPlan(run) {
  const plan = accountPlan();
  if (plan === undefined || !run?.child || run.proxy) return;
  try {
    run.child.postMessage({ kind: "plan", plan });
  } catch {
    /* it hears the plan with the licence when it is back */
  }
}

/** A licence a workspace was given: kept once, and handed to the rest. */
function keepLicence(key, typed = true) {
  if (typeof key !== "string" || !LICENCE.test(key) || key === readLicence()) return;
  // a key removed from the Plan page stays removed: a workspace that
  // still held its own copy offers it back as it starts, and only a key
  // somebody typed again brings it back
  const forgotten = forgottenPrints();
  if (forgotten.includes(licencePrint(key))) {
    if (!typed) return;
    try {
      fs.writeFileSync(forgottenFile(), JSON.stringify(forgotten.filter((p) => p !== licencePrint(key))), { mode: 0o600 });
    } catch {
      /* typed again, and kept: the old mark only matters at the next start */
    }
  }
  licence = key;
  try {
    if (safeStorage.isEncryptionAvailable()) fs.writeFileSync(licenceFile(), safeStorage.encryptString(key), { mode: 0o600 });
  } catch (error) {
    console.error("[licence] could not keep it:", error?.message ?? error);
  }
  // another licence is another plan, until a server has asked about it
  licencePlan = readKeptPlan(planFile(), licencePrint(key));
  // a move's record is kept per licence, so it is read again for this one
  moveState = null;
  planRead = true;
  for (const run of servers.values()) handLicence(run);
  tellWorkspaces();
}

const forgottenFile = () => path.join(app.getPath("userData"), "licence-forgotten.json");
function forgottenPrints() {
  try {
    const list = JSON.parse(fs.readFileSync(forgottenFile(), "utf8"));
    return Array.isArray(list) ? list.filter((p) => typeof p === "string") : [];
  } catch {
    return [];
  }
}

/** The key was removed from the Plan page: gone from the keychain file,
 * and every workspace's server told, so none of them puts it back. */
function forgetLicence() {
  const was = readLicence();
  licence = null;
  // no licence is no plan, said at once rather than when a server asks
  licencePlan = null;
  planRead = true;
  keepPlan(planFile(), null, null);
  moveState = null;
  tellWorkspaces();
  try {
    fs.rmSync(licenceFile(), { force: true });
    if (was) fs.writeFileSync(forgottenFile(), JSON.stringify([...forgottenPrints(), licencePrint(was)].slice(-8)), { mode: 0o600 });
  } catch (error) {
    console.error("[licence] could not forget it:", error?.message ?? error);
  }
  for (const run of servers.values()) {
    try {
      run.child?.postMessage({ kind: "licence.forget" });
    } catch {
      /* a server on its way out never hears it, and holds no copy after */
    }
  }
}

// ── the person's name ──────────────────────────────────────────────────
// One person owns every workspace here but a joined one, so they are
// called the same in all of them, the way the theme follows them. Each
// server keeps the name in its own config (it works without the app);
// the app keeps the one the person chose last and hands it to each of
// its servers as it starts, and to all of them when it changes.

/** Hands the person's name to one workspace's server, when there is one. */
function handName(run) {
  const name = registry?.prefs.ownerName;
  if (!name || !run?.child) return;
  const ws = entryOf(run.id);
  if (!ws || isRemoteKind(ws.kind)) return;
  try {
    run.child.postMessage({ kind: "name", name });
  } catch {
    /* a server on its way out hears it again when it is back */
  }
}

/** Hands a workspace's mute and notification level to its server, which
 * holds a phone's "your answer is ready" to them as this end holds a
 * banner (server/answer-ready.ts), and keeps them (server/attention.ts).
 * The mute's end is a time the server reads itself, so only a change has
 * to be said. A server on another machine, your hosted one or one you
 * joined as its owner, is told through its stand-in instead
 * (electron/attention-said.mjs). */
function handAttention(run) {
  const ws = run ? entryOf(run.id) : null;
  if (!ws) return;
  if (isRemoteKind(ws.kind)) {
    if (run.status === "running" && run.port) void attentionThere().say(ws.id, { kind: ws.kind, base: `http://127.0.0.1:${run.port}` }, ws);
    return;
  }
  if (!run.child) return;
  try {
    run.child.postMessage({ kind: "attention", mute: ws.mute ?? null, notify: ws.notify ?? "all" });
  } catch {
    /* a server on its way out hears it again when it is back */
  }
}

/** What each workspace on another machine last took, kept beside the list. */
let attentionSayer = null;
const attentionThere = () =>
  (attentionSayer ??= createAttentionSayer({ file: path.join(app.getPath("userData"), "attention-said.json") }));

/** A mute or level the owner chose on a device of theirs, put to the list
 * by the server it was said to: kept, and handed back to that server, the
 * way a change in the switcher is. */
function attentionFromServer(id, said) {
  const ws = entryOf(id);
  if (!ws || isRemoteKind(ws.kind)) throw Object.assign(new Error("There is no such workspace here."), { status: 404 });
  if (!NOTIFY_LEVELS.includes(said?.notify)) throw Object.assign(new Error("That is not a notification level."), { status: 400 });
  const mute = said.mute === "forever" ? "forever" : Number.isSafeInteger(said.mute) && said.mute > 0 ? said.mute : null;
  registry = updateWorkspace(registry, id, { mute, notify: said.notify });
  saveRegistry();
  tellWorkspaces();
  applyBadge();
  const now = entryOf(id);
  return { ok: true, mute: now.mute ?? null, notify: now.notify ?? "all" };
}

/** A name a workspace's server said: kept, and handed to the rest. */
function keepName(name, { seed = false } = {}) {
  if (!registry || typeof name !== "string") return;
  const kept = keepOwnerName(registry, name, { seed });
  if (!kept.changed) return;
  registry = kept.registry;
  saveRegistry();
  tellWorkspaces();
  for (const run of servers.values()) handName(run);
}

// ── the mark ───────────────────────────────────────────────────────────
// The list here is where a workspace's mark lives, and the switcher is
// drawn from it; the workspace's own server keeps a copy for the owner's
// phone, its invites and its welcome. Chosen at the Mac, the mark is
// handed to the server; chosen on the phone, the server asks here first
// (answerServer, "mark"), because only the list knows what the other
// workspaces wear. A joined workspace's mark is yours alone and goes
// nowhere: its owner's server never hears it.

/** Hands a workspace's mark, and what it would go back to, to its server. */
function handMark(run) {
  const ws = run ? entryOf(run.id) : null;
  if (!ws || isRemoteKind(ws.kind) || !ws.mark || !run.child) return;
  try {
    run.child.postMessage({ kind: "mark", mark: ws.mark, markDefault: markDefault(ws) });
  } catch {
    /* a server on its way out hears it again when it is back */
  }
}

/** A mark the owner chose on their phone, put to the list: kept when no
 * other workspace here wears it, and handed back to that server. */
function markFromServer(id, mark) {
  const ws = entryOf(id);
  if (!ws || isRemoteKind(ws.kind)) throw Object.assign(new Error("There is no such workspace here."), { status: 404 });
  registry = updateWorkspace(registry, id, { mark: mark ?? null });
  saveRegistry();
  tellWorkspaces();
  handMark(servers.get(id));
  const now = entryOf(id);
  return { ok: true, mark: now.mark, markDefault: markDefault(now) };
}

/**
 * A question a workspace's server put to the app (server/desktop-line.ts),
 * answered on the same line. Each one is about the workspace that asked:
 * a server never speaks for another.
 */
async function answerServer(id, child, said) {
  let reply;
  try {
    if (said.what === "mark") reply = markFromServer(id, said.mark);
    else if (said.what === "attention") reply = attentionFromServer(id, said);
    else if (said.what === "workspaces") reply = await othersForPhone(id);
    else if (said.what === "pair") reply = await pairForPhone(id, said.target, said.device);
    else if (said.what === "browser") reply = await browserCommand(id, said);
    else if (said.what === "browser.thumbnail") reply = await browserThumbnail(id);
    else reply = { error: "The app does not answer that.", status: 404 };
  } catch (error) {
    reply = { error: String(error?.message ?? error), status: error?.status ?? 409 };
  }
  try {
    child.postMessage({ ...reply, kind: "answer", ask: said.ask });
  } catch {
    /* the server is going; its question goes with it */
  }
}

// ── the other workspaces, for the owner's phone ───────────────────────
// A phone paired with one workspace here asks it about the others
// (server/other-workspaces.ts has why this is safe), and the question
// comes here, since only the list knows them. A pairing for one of them
// is asked of that workspace's own server, which makes it single use and
// short, and the Mac is told each time one is made.

const serverAsks = new ServerAsks();

/** The person's own workspaces here, for the phone paired with `id`,
 * each with whether a pairing can be made for it now. */
async function othersForPhone(id) {
  const checks = {};
  await Promise.all(
    registry.workspaces.map(async (ws) => {
      const run = servers.get(ws.id);
      if (ws.id === id || !OWN_LOCAL_KINDS.includes(ws.kind) || run?.status !== "running") return;
      checks[ws.id] = await serverAsks.ask(run.child, "pair.check", {}, 2_000);
    }),
  );
  return { ok: true, workspaces: othersFor(registry, id, checks) };
}

/** A single-use pairing for `target`, asked by the phone paired with
 * `id`: the target's server makes it, starting first when it has to. */
async function pairForPhone(id, target, device) {
  // the hosted workspace a copy here moved to: its link comes from
  // bloks.dev, as Open's does, and the phone claims it like any other
  const hosted = hostedEntry();
  if (target === HOSTED_TARGET && hosted && OWN_LOCAL_KINDS.includes(entryOf(id)?.kind)) {
    const link = await hostedLinkFrom(id);
    tellPairingMade(hosted, entryOf(id), typeof device === "string" ? device.slice(0, 60) : "");
    return { ok: true, via: "relay", link, expiresAt: Date.now() + 15 * 60_000, host: hosted.name, workspace: { id: hosted.id, name: hosted.name, kind: "hosted", mark: hosted.mark } };
  }
  const refused = pairRefusal(registry, id, String(target));
  if (refused) return { ok: false, ...refused };
  const ws = entryOf(String(target));
  if (!(await launch(ws.id))) return { ok: false, status: 503, error: `${ws.name} would not start on the Mac.` };
  const made = await serverAsks.ask(servers.get(ws.id)?.child, "pair.mint", {}, 15_000);
  if (made.ok === false || made.error) return { ok: false, status: made.status ?? 409, error: made.error ?? "No pairing could be made." };
  tellPairingMade(ws, entryOf(id), typeof device === "string" ? device.slice(0, 60) : "");
  return { ...made, ok: true, workspace: { id: ws.id, name: ws.name, kind: ws.kind, mark: ws.mark } };
}

/** Told at the Mac whatever its notification settings say: a pairing is
 * a new way into a workspace, and the person at the Mac should know one
 * was made, and from where, the moment it was. */
function tellPairingMade(ws, from, device) {
  if (!Notification.isSupported()) return;
  const who = device || "Your phone";
  const shown = new Notification({
    title: `Pairing with ${ws.name}`,
    body: `${who} asked from ${from?.name ?? "another workspace"}. If that was not you, remove it in ${ws.name}'s Phone and devices.`,
  });
  shown.on("click", () => void switchWorkspace(ws.id, { target: "settings:devices" }).catch(() => {}));
  shown.show();
}

/** Stops one workspace's server for good (it is being deleted). */
async function halt(id) {
  const run = servers.get(id);
  if (!run) return;
  run.stopped = true;
  if (run.proxy) run.proxy.stop();
  await stopServer(run.child);
  servers.delete(id);
}

/** Every server this app runs, stopped together: quitting, an update, or
 * handing over to a computer elsewhere. */
function stopAllServers() {
  return Promise.allSettled([...servers.values()].map((run) => (run.proxy ? run.proxy.stop() : stopServer(run.child))));
}

/** The servers that are up, for things every workspace has to hear. */
const runningServers = () => [...servers.values()].filter((run) => run.status === "running" && run.port && !run.proxy);


// ── workspaces ─────────────────────────────────────────────────────────
// The list of them lives in the app's own folder (electron/workspaces.mjs
// has its rules). The window shows one at a time; switching points it at
// another workspace's server, which is already running, so a switch is a
// page load on loopback and nothing more.

/** The list, once read. Null in a run that starts no servers of its own
 * (`pnpm dev`, or a Bloks on another computer), which has no workspaces. */
let registry = null;
/** The workspace the window shows. Usually the one last chosen; another
 * one when that one would not start, so the app still opens. */
let shownId = PERSONAL_ID;
/** Added to the next window's address: a workspace just made opens on
 * its first-run welcome rather than on the film (App.tsx). */
let welcomeQuery = "";

const REGISTRY_FILE = () => path.join(app.getPath("userData"), "workspaces.json");
/** Where the workspaces made in the app keep their data, one folder each. */
const workspacesDir = () => path.join(app.getPath("userData"), "workspaces");
const LOGOS_DIR = () => path.join(app.getPath("userData"), "workspace-logos");

/** Personal's folder: the one Bloks always used, which BLOKS_DATA_DIR
 * can move (server/config.ts dataDirFrom says the same). */
function personalDataDir() {
  const said = process.env.BLOKS_DATA_DIR?.trim();
  if (!said) return path.join(os.homedir(), ".bloks");
  if (said === "~") return os.homedir();
  return said.startsWith("~/") ? path.join(os.homedir(), said.slice(2)) : path.resolve(said);
}

const entryOf = (id) => registry?.workspaces.find((w) => w.id === id) ?? null;

function saveRegistry() {
  try {
    writeRegistry(REGISTRY_FILE(), registry);
  } catch (error) {
    // the list in memory is still right for this run; the next change
    // tries the disk again
    console.error("[workspaces] could not save the list:", error?.message ?? error);
  }
}

/** The main window, when there is one. */
const mainWindow = () => BrowserWindow.getAllWindows().find((w) => isWorkspaceWindow(w)) ?? null;

/** Reads the list (writing Personal into it on the first run), and
 * brings up the workspace last chosen. One that will not start is not
 * the end of the app: the next one that does is shown instead, and the
 * switcher says what happened to the first. */
async function openWorkspaces() {
  registry = settle(readRegistry(REGISTRY_FILE()), { personalDataDir: personalDataDir() });
  saveRegistry();
  shownId = registry.current;
  if (await launch(shownId)) return;
  for (const ws of registry.workspaces) {
    if (ws.id === shownId || isRemoteKind(ws.kind)) continue;
    if (await launch(ws.id)) {
      shownId = ws.id;
      return;
    }
  }
}

/** The rest of the workspaces, a few at a time: one after another made
 * the last of five wait half a minute for its routines, and all at once
 * would make the first minute of a launch a crowd. */
async function launchTheRest() {
  const waiting = registry.workspaces.filter((ws) => !isRemoteKind(ws.kind) && !servers.has(ws.id)).map((ws) => ws.id);
  const lane = async () => {
    while (waiting.length && !quitting) await launch(waiting.shift());
  };
  await Promise.all([lane(), lane(), lane()]);
}

/** A logo as the window can draw it: the window's page is on a loopback
 * origin and cannot read a file path, so it gets the picture itself. */
const logoCache = new Map();
function logoData(ws) {
  if (!ws.logo) return null;
  const cached = logoCache.get(ws.id);
  if (cached?.file === ws.logo) return cached.data;
  try {
    const data = `data:image/png;base64,${fs.readFileSync(ws.logo).toString("base64")}`;
    logoCache.set(ws.id, { file: ws.logo, data });
    return data;
  } catch {
    return null;
  }
}

function workspacesState() {
  if (!registry || remoteProfile) return { available: false };
  const live = {};
  for (const ws of registry.workspaces) {
    const run = servers.get(ws.id);
    live[ws.id] = {
      status: run?.status ?? "stopped",
      problem: run?.problem ?? null,
      waiting: waitingCounts.get(ws.id) ?? 0,
      logo: logoData(ws),
    };
  }
  return {
    ...snapshot(registry, live),
    current: shownId,
    // the licence's plan, as the workspaces' servers last said it, for a
    // new workspace's Team choice; and the one accent, when shared
    plan: accountPlan(),
    sameAccent: registry.prefs.sameAccent,
    // the notch's switch, only where there is a notch to show it in
    ...(notchPlatform() ? { notch: notchOn() } : {}),
    // "Close to the tray", only on Windows (electron/tray.mjs)
    ...(process.platform === "win32" ? { tray: registry.prefs.tray === true } : {}),
  };
}

/** Every window hears the list again; anything the switcher draws may
 * have changed. A timed mute running out is a change too, so the next
 * one to end is waited for. */
let muteTimer = null;
function tellWorkspaces() {
  if (!registry) return;
  const state = workspacesState();
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send("workspaces:state", state);
  }
  for (const run of servers.values()) handAttention(run);
  clearTimeout(muteTimer);
  const end = nextMuteEnd(registry.workspaces);
  if (end) {
    muteTimer = setTimeout(() => {
      tellWorkspaces();
      applyBadge();
    }, Math.min(end - Date.now() + 250, 2 ** 31 - 1));
    muteTimer.unref?.();
  }
}

/**
 * Shows another workspace in the window. Its server is already running
 * in the background, or is started now. The choice is remembered for the
 * next launch. `target` is a conversation to open once it has loaded,
 * from a banner's click; `welcome` is a workspace just made.
 */
async function switchWorkspace(id, { target = null, welcome = false, query = "" } = {}) {
  const ws = entryOf(id);
  if (!ws) throw new Error("There is no such workspace.");
  if (!(await launch(id))) throw new Error(`${ws.name} would not start. ${servers.get(id)?.problem ?? ""}`.trim());
  const moved = shownId !== id;
  shownId = id;
  registry = setCurrent(registry, id);
  saveRegistry();
  pendingNotifyTarget = target;
  const win = mainWindow();
  if (!win) {
    welcomeQuery = welcome ? "welcome=workspace" : "";
    createWindow();
  } else {
    raise(win);
    if (moved || welcome) void showIn(win, id, welcome ? "welcome=workspace" : query);
    else if (target) {
      pendingNotifyTarget = null;
      win.webContents.send("notify:activate", { target });
    }
  }
  // the quick ask goes to the workspace you are in; the next one opens there
  if (moved && quickWin && !quickWin.isDestroyed()) quickWin.destroy();
  // the notch shows the agents of the workspace you are in
  if (moved) pointNotch(id);
  tellWorkspaces();
  applyBadge();
}

/**
 * A workspace just made, on screen at once. Its first server takes a few
 * seconds to write its folders and answer, and Create used to wait all
 * of that with the dialog open, long enough for the list to arrive with
 * the new workspace in it and the dialog to call its own name taken. So
 * the window goes now, to the page that says it is opening, and on to
 * its welcome once the server answers, or to why it would not start.
 * Somebody who moved on to another workspace meanwhile is left there.
 */
function openMade(id) {
  shownId = id;
  registry = setCurrent(registry, id);
  saveRegistry();
  // starting from here, so the window's address is the opening page
  const up = launch(id);
  const win = mainWindow();
  if (!win) {
    welcomeQuery = "welcome=workspace";
    createWindow();
  } else {
    raise(win);
    void showIn(win, id);
  }
  if (quickWin && !quickWin.isDestroyed()) quickWin.destroy();
  pointNotch(id);
  tellWorkspaces();
  applyBadge();
  void up.then((started) => {
    const shown = mainWindow();
    if (!shown || shownId !== id || (windowWorkspace.get(shown) ?? shownId) !== id) return;
    void showIn(shown, id, started ? "welcome=workspace" : "");
  });
}

function noteMembers(id, count) {
  if (!entryOf(id)) return;
  registry = updateWorkspace(registry, id, { members: count });
  saveRegistry();
  tellWorkspaces();
}

/** Inside the app's workspaces folder, and only there: the one check
 * between a delete and a folder that is not ours to delete. */
function insideWorkspacesDir(dir) {
  if (!dir) return false;
  const rel = path.relative(workspacesDir(), dir);
  return Boolean(rel) && !rel.startsWith("..") && !path.isAbsolute(rel) && !rel.includes(path.sep);
}

// ── a workspace joined on someone else's computer ─────────────────────
// The joining itself (an invite's code, the claim, the owner's approval)
// is the members work's. What lands here is its result: the member's
// credentials, kept in the keychain like remote.bin, and an entry of kind
// "joined" in the list. Opening one starts the remote proxy
// (electron/remote.mjs) with those credentials, so the window loads it
// like any other workspace.

/** The credentials of a workspace reached through the remote proxy: one
 * you joined, or your own hosted one. Encrypted by the keychain. */
const joinedFile = (id) => path.join(app.getPath("userData"), `joined-${id}.bin`);

function readJoinedProfile(id) {
  try {
    if (!safeStorage.isEncryptionAvailable()) return null;
    const profile = JSON.parse(safeStorage.decryptString(fs.readFileSync(joinedFile(id))));
    return profile?.deviceId && profile.deviceToken && reachOf(profile) ? profile : null;
  } catch {
    return null;
  }
}

/** Adds a joined workspace to the list, keeping its credentials in the
 * keychain. For the members work to call once an invite is approved;
 * answers the new entry. */
export function addJoinedWorkspace(profile, { name, mark = null, team = true, role = "member" } = {}) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error("This computer cannot keep the membership safely, so it was not saved.");
  const id = `ws_${Date.now().toString(36)}`;
  fs.writeFileSync(joinedFile(id), safeStorage.encryptString(JSON.stringify(profile)), { mode: 0o600 });
  const host = { name: profile.host ?? "", relayUrl: profile.relayUrl ?? "", lan: profile.lan ?? "" };
  registry = { ...registry, workspaces: [...registry.workspaces, { id, kind: "joined", name, team, mark, logo: null, dataDir: null, mute: null, notify: "all", order: registry.workspaces.length, port: null, accent: null, members: null, createdAt: Date.now(), host, role: role === "admin" ? "admin" : "member" }] };
  registry = settle(registry, { personalDataDir: personalDataDir() });
  saveRegistry();
  tellWorkspaces();
  return entryOf(id);
}

// A join the window finished (src/components/members/JoinWorkspaceDialog):
// the credentials it was handed, kept here, and the workspace switched to
// when the person pressed Open. The profile is checked for its shape: it
// becomes a keychain entry and a proxy's credentials.
handle("workspaces:joined", (_event, input) =>
  answer(async () => {
    needsList();
    const p = input?.profile ?? {};
    // Through Bloks Cloud when the membership has a way through it, which
    // works from anywhere; otherwise on the owner's own network, when the
    // join never touched the relay at all.
    const relay =
      typeof p.relayUrl === "string" && /^https:\/\/|^http:\/\/127\.0\.0\.1/.test(p.relayUrl) && typeof p.relayToken === "string" && p.relayToken
        ? { relayUrl: p.relayUrl.replace(/\/+$/, ""), relayToken: p.relayToken }
        : null;
    const lan = typeof p.lan === "string" && /^[0-9a-zA-Z.:[\]-]{3,80}$/.test(p.lan) ? p.lan : null;
    const ok = typeof p.deviceId === "string" && typeof p.deviceToken === "string" && (relay || lan);
    if (!ok) throw new Error("This membership did not say how to reach that computer, so it was not added. Ask for a new invite.");
    const mark = input?.mark && typeof input.mark.color === "string" && typeof input.mark.pattern === "string" ? { color: input.mark.color, pattern: input.mark.pattern } : null;
    const name = typeof input?.name === "string" && input.name.trim() ? input.name.trim().slice(0, 60) : "A workspace";
    const entry = addJoinedWorkspace(
      { ...(relay ?? {}), ...(lan ? { lan } : {}), deviceId: p.deviceId, deviceToken: p.deviceToken, host: typeof input?.host === "string" ? input.host.slice(0, 60) : "" },
      { name, mark, role: input?.role === "admin" ? "admin" : "member" },
    );
    if (input?.open) await switchWorkspace(entry.id);
    return { ok: true, id: entry.id };
  }),
);

// Your own hosted workspace, opened from the Plan page. The pairing link
// it was asked for there (server/plan-account.ts, hostedLink, sealed for
// that one request) is spent here, as a device of yours, and the workspace
// is listed, or the one listed is pointed at the new pairing: there is one
// per licence. From then on it opens like a joined one, through the
// remote proxy, except that the device is the owner's, so the window is
// the owner's app.
handle("workspaces:hosted", (_event, input) =>
  answer(async () => {
    needsList();
    const id = await pairHosted(String(input?.link ?? ""), { open: input?.open !== false });
    return { ok: true, id };
  }),
);

/** The pairing behind Open, also what a move to Hosting does on its own:
 * the link spent as a device of yours, and the hosted workspace listed,
 * or the one listed pointed at the new pairing. Answers its id. */
async function pairHosted(link, { open = true } = {}) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error("This computer cannot keep the pairing safely, so it was not saved.");
  const profile = await claimPairLink(link, `${os.hostname().replace(/\.local$/, "")} (desktop)`);
  const added = addHosted(registry, { host: profile.host, relayUrl: profile.relayUrl });
  const shown = shownId === added.entry.id;
  if (added.replaced) {
    // out of it while its proxy is swapped for one with the new pairing
    if (shown) await switchWorkspace(PERSONAL_ID);
    await halt(added.entry.id);
  }
  fs.writeFileSync(joinedFile(added.entry.id), safeStorage.encryptString(JSON.stringify(profile)), { mode: 0o600 });
  // a new pairing may be a new machine, which has heard nothing yet
  attentionThere().forget(added.entry.id);
  registry = settle(added.registry, { personalDataDir: personalDataDir() });
  saveRegistry();
  tellWorkspaces();
  if (open || shown) await switchWorkspace(added.entry.id);
  return added.entry.id;
}

// ── moving a workspace to the hosted machine, and back ─────────────────
// The pipeline is electron/hosting-move.mjs; this is where it meets the
// app. The move's state is kept beside the licence and the plan, under
// the licence's fingerprint, so a move carries on after a restart. Buying
// Hosting is the consent for the first move: once the account says the
// machine is running and this licence has not moved, the workspace whose
// Plan page sent the person to checkout goes (Personal when that is not
// known), after a few seconds' toast that offers to change it. Moving
// back to this Mac is only ever asked for.

const moveFile = () => path.join(app.getPath("userData"), "hosting-move.json");
let moveState = null;
/** The move being carried right now, and how to stop it. */
let moveRun = null;
let moveTimer = null;
/** The account as a workspace's server last said it (desktop.account). */
let lastAccount = null;

function moveStateNow() {
  moveState ??= readMoveState(moveFile(), licencePrintNow());
  return moveState;
}

function keepMove(patch) {
  moveState = { ...moveStateNow(), ...patch };
  keepMoveState(moveFile(), moveState);
  tellMove();
}

const baseOf = (id) => {
  const run = servers.get(id);
  return run?.status === "running" && run.port ? `http://127.0.0.1:${run.port}` : null;
};
const hostedEntry = () => registry?.workspaces.find((w) => w.kind === "hosted") ?? null;

/** What the window is told: enough to draw the steps, the keys to enter
 * and the cards, and nothing it has no use for (never the parts or the
 * digests). */
function moveSnapshot() {
  const state = moveStateNow();
  const m = state.move;
  return {
    available: Boolean(registry),
    hostingActive: hostingRunning(lastAccount),
    bloksAi: Boolean(lastAccount?.bloksAi),
    licenceMoved: Boolean(state.moved),
    move: m
      ? {
          id: m.id,
          direction: m.direction,
          auto: m.auto,
          from: m.from,
          to: m.to,
          replace: m.replace,
          phase: m.phase,
          step: m.step,
          startsAt: m.startsAt,
          sent: m.sent,
          size: m.size,
          error: m.error,
          code: m.code,
          keys: m.keys ?? m.file?.keys ?? null,
          doneAt: m.doneAt,
          announced: m.announced === true,
          // the toast before one started on its own, and the sentence after
          starting: startingWords(m),
          done: m.phase === "done" ? doneWords(m) : null,
          // past the finish it is being put in place, which nothing stops
          stoppable: m.phase === "running" && !m.finishing,
        }
      : null,
    hosted: (registry?.workspaces ?? []).filter((w) => w.kind === "hosted").map((w) => ({ id: w.id, name: w.name })),
    copies: (registry?.workspaces ?? []).filter((w) => w.moved).map((w) => ({ id: w.id, name: w.name, kind: w.kind, to: w.moved.to })),
  };
}

function tellMove() {
  const said = moveSnapshot();
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send("hosting:move", said);
  }
}

/** A pairing link to the hosted workspace, asked of a workspace's server
 * the way Open asks it; a machine waking up is asked again for a while. */
async function hostedLinkFrom(id) {
  const until = Date.now() + 3 * 60_000;
  for (;;) {
    if (!(await launch(id))) throw new Error(`${entryOf(id)?.name ?? "That workspace"} would not start, so there is nothing to ask for the link.`);
    const said = await serverAsks.ask(servers.get(id)?.child, "plan.hostedLink", {}, 45_000);
    if (said.ok && typeof said.link === "string") return said.link;
    if (said.waking && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 5_000));
      continue;
    }
    throw new Error(said.error ?? "No pairing link came from your hosted machine.");
  }
}

/** The pairing step: the hosted workspace listed and up (paired on its
 * own, the same path as Open, when it is not listed yet), and for a move
 * home, the workspace here made or started. Answers a patch for the move. */
async function pairForMove(move) {
  if (move.direction === "to-hosted") {
    let hosted = hostedEntry();
    if (!hosted || !readJoinedProfile(hosted.id)) {
      const link = await hostedLinkFrom(move.from.id);
      await pairHosted(link, { open: false });
      hosted = hostedEntry();
    }
    if (!hosted || !(await launch(hosted.id))) throw new Error("Your hosted machine could not be reached. Retry in a moment.");
    if (!(await launch(move.from.id))) throw new Error(`${move.from.name} would not start.`);
    return { to: { id: hosted.id, name: hosted.name } };
  }
  const hosted = entryOf(move.from.id);
  if (!hosted || !(await launch(hosted.id))) throw new Error("Your hosted machine could not be reached. Retry in a moment.");
  if (move.to.id && entryOf(move.to.id)) {
    if (!(await launch(move.to.id))) throw new Error(`${entryOf(move.to.id).name} would not start.`);
    return null;
  }
  // a new workspace here, named after the hosted one
  const taken = (name) => registry.workspaces.some((w) => w.name.toLowerCase() === name.toLowerCase());
  const name = [move.to.name, hosted.name, `${hosted.name} on this Mac`].find((n) => n && !taken(n)) ?? `${hosted.name} ${Date.now().toString(36)}`;
  const made = addWorkspace(registry, { kind: "custom", name }, { workspacesDir: workspacesDir() });
  fs.mkdirSync(made.entry.dataDir, { recursive: true, mode: 0o700 });
  registry = made.registry;
  saveRegistry();
  tellWorkspaces();
  if (!(await launch(made.entry.id))) throw new Error(`${name} would not start on this Mac.`);
  return { to: { id: made.entry.id, name } };
}

/** Carries the move kept in the state from where it got to. */
function carryMove() {
  const move = moveStateNow().move;
  if (!move || moveRun || move.phase === "done") return;
  clearTimeout(moveTimer);
  const controller = new AbortController();
  // either way, the side it leaves is `from` and the side it lands on `to`;
  // read fresh each time, since either may come back on another port
  const run = runMove(move, {
    source: () => {
      const m = moveStateNow().move;
      return m ? baseOf(m.from.id) : null;
    },
    target: () => {
      const m = moveStateNow().move;
      return m?.to.id ? baseOf(m.to.id) : null;
    },
    pair: (m) => pairForMove(m),
    save: (m) => keepMove({ move: m }),
    signal: controller.signal,
    // a workspace here that stopped to put the move in place is brought
    // back by its keeper; asked to start in case it gave up
    waitBack: async (m) => {
      if (m.to.id && entryOf(m.to.id) && !baseOf(m.to.id)) await launch(m.to.id).catch(() => false);
    },
  });
  moveRun = { controller };
  tellMove();
  void run
    .then((ended) => moveEnded(ended))
    .catch((error) => keepMove({ move: { ...moveStateNow().move, phase: "failed", error: String(error?.message ?? error) } }))
    .finally(() => {
      moveRun = null;
      tellMove();
    });
}

async function moveEnded(move) {
  if (move.phase !== "done") return;
  if (move.direction === "to-hosted") {
    // the hosted server now holds the moved workspace's folder, with
    // whatever mute that one kept, so it is told the hosted entry's again
    attentionThere().forget(move.to.id);
    registry = markMoved(registry, move.from.id, move.to.id);
    keepMove({ moved: { at: Date.now(), from: move.from.id, to: move.to.id } });
  } else {
    // the copy it was moved out of is the live one again
    registry = markMoved(registry, move.to.id, null);
  }
  saveRegistry();
  tellWorkspaces();
  tellMove();
  await switchWorkspace(move.to.id).catch(() => {});
}

/** Begins a move: now, or after the few seconds' toast for one started on
 * its own. */
function beginMove({ direction, from, to, replace = false, auto = false }) {
  if (moveRun) throw new Error("A move is under way already.");
  const was = moveStateNow().move;
  if (was && was.phase !== "done" && was.phase !== "failed" && was.phase !== "stopped" && was.phase !== "later") throw new Error("A move is under way already.");
  const move = newMove({ direction, from, to, replace, auto });
  keepMove({ move });
  if (auto) {
    moveTimer = setTimeout(() => {
      if (moveStateNow().move?.id === move.id && moveStateNow().move.phase === "waiting") carryMove();
    }, AUTO_DELAY_MS);
  } else carryMove();
  return move;
}

/** Whether the account just heard says to start the first move. */
function considerAutoMove() {
  if (!registry || moveRun) return;
  const from = autoMoveFrom({ account: lastAccount, state: moveStateNow(), registry });
  if (!from) return;
  const hosted = hostedEntry();
  beginMove({ direction: "to-hosted", from, to: { id: hosted?.id ?? null, name: hosted?.name ?? "Hosted" }, auto: true });
}

function noteAccount(said) {
  if (!said || said.shared === false) return;
  lastAccount = said;
  tellMove();
  considerAutoMove();
}

/** Asks a running workspace of this Mac for the account, for the move
 * that starts once Hosting is running. Often after a checkout, rarely
 * otherwise, and not at all once this licence has moved. */
async function askAccount(fresh = false) {
  if (!registry || !readLicence() || moveStateNow().moved) return;
  const ws = registry.workspaces.find((w) => !isRemoteKind(w.kind) && servers.get(w.id)?.status === "running");
  if (!ws) return;
  const said = await serverAsks.ask(servers.get(ws.id)?.child, "plan.account", { fresh }, 15_000);
  if (said.ok) noteAccount(said);
}
let accountTimer = null;
function watchAccount() {
  clearTimeout(accountTimer);
  const bought = moveStateNow().boughtFrom;
  // after a checkout the machine comes up in minutes; otherwise now and then
  const soon = bought && Date.now() - bought.at < 2 * 60 * 60_000;
  accountTimer = setTimeout(() => {
    void askAccount(Boolean(soon)).finally(watchAccount);
  }, soon ? 60_000 : 30 * 60_000);
  accountTimer.unref?.();
}

handle("hosting:move-state", () => moveSnapshot());

// From the Plan page or the moved banner: a move asked for in so many
// words, either way. `from` and `to` are workspace ids on this computer;
// a move home with no `to` makes a workspace for it.
handle("hosting:move-start", (_event, input) =>
  answer(() => {
    needsList();
    const direction = input?.direction === "to-mac" ? "to-mac" : "to-hosted";
    const from = entryOf(String(input?.from ?? ""));
    if (!from) throw new Error("There is no such workspace to move.");
    if (direction === "to-hosted" && (isRemoteKind(from.kind) || from.moved)) throw new Error(`${from.name} is not a workspace on this Mac that can move.`);
    if (direction === "to-mac" && from.kind !== "hosted") throw new Error("Only your hosted workspace moves to this Mac.");
    const hosted = hostedEntry();
    const to = direction === "to-hosted"
      ? { id: hosted?.id ?? null, name: hosted?.name ?? "Hosted" }
      : input?.to && entryOf(String(input.to))
        ? { id: String(input.to), name: entryOf(String(input.to)).name }
        : { id: null, name: typeof input?.name === "string" && input.name.trim() ? input.name.trim().slice(0, 40) : from.name };
    const target = to.id ? entryOf(to.id) : null;
    const replace = Boolean(target?.moved) && input?.replace === true;
    beginMove({ direction, from: { id: from.id, name: from.name }, to, replace });
    return { ok: true };
  }),
);

/** The toast's Change: the move that was about to start, from another
 * workspace, now. */
handle("hosting:move-change", (_event, id) =>
  answer(() => {
    const move = moveStateNow().move;
    const from = entryOf(String(id));
    if (!move || move.phase !== "waiting" || !from || isRemoteKind(from.kind) || from.moved) throw new Error("There is no move about to start.");
    clearTimeout(moveTimer);
    keepMove({ move: { ...move, from: { id: from.id, name: from.name }, phase: "running", auto: false, startsAt: null } });
    carryMove();
  }),
);

handle("hosting:move-stop", (_event, how) =>
  answer(() => {
    const move = moveStateNow().move;
    if (!move) return;
    const later = how === "later";
    clearTimeout(moveTimer);
    if (moveRun) moveRun.controller.abort(later ? "later" : "stopped");
    // not begun yet, or already ended: only the card changes
    else if (move.phase !== "done") keepMove({ move: { ...move, phase: later ? "later" : "stopped", startsAt: null } });
  }),
);

handle("hosting:move-resume", () =>
  answer(() => {
    const move = moveStateNow().move;
    if (!move || move.phase === "done") throw new Error("There is no move to carry on.");
    carryMove();
  }),
);

/** Done with the card: a finished move's keys list, or one put off. */
handle("hosting:move-dismiss", () =>
  answer(() => {
    if (moveRun) throw new Error("A move is under way.");
    keepMove({ move: null });
  }),
);

/** The calm sentence after a move was said, once. */
handle("hosting:move-announced", () => {
  const move = moveStateNow().move;
  if (move?.phase === "done" && !move.announced) keepMove({ move: { ...move, announced: true } });
});

/** A key's button: the Settings page it is entered on, in the workspace
 * the move landed in. */
handle("hosting:move-open-settings", (_event, page) =>
  answer(async () => {
    const move = moveStateNow().move;
    const target = move?.to.id ?? hostedEntry()?.id;
    if (!target || typeof page !== "string" || !/^[a-z:-]{2,40}$/.test(page)) throw new Error("There is nothing to open.");
    await switchWorkspace(target, { target: `settings:${page}` });
  }),
);

/** The moved banner's Remove from this Mac. A named workspace goes to the
 * Trash, as Delete does; Personal cannot go, so it starts fresh instead,
 * its folder set aside whole beside it, the way Start fresh does. */
handle("hosting:move-remove-copy", (_event, id) =>
  answer(async () => {
    const ws = entryOf(String(id));
    if (!ws?.moved) throw new Error("Only a copy whose work has moved is removed from here.");
    if (ws.kind !== "personal") return deleteWorkspace(ws.id);
    const base = baseOf(ws.id);
    if (!base) throw new Error("Personal is not running right now. Try again in a moment.");
    const res = await fetch(`${base}/api/workspace/reset`, { method: "POST", signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error("Personal could not start fresh just now.");
    registry = markMoved(registry, ws.id, null);
    saveRegistry();
    tellWorkspaces();
    tellMove();
  }),
);

/** What a move out of a workspace would carry and leave behind, for the
 * one confirm before a move home: its counts and its keys, by name. */
handle("hosting:move-preview", (_event, id) =>
  answer(async () => {
    const ws = entryOf(String(id));
    if (!ws) throw new Error("There is no such workspace.");
    if (!(await launch(ws.id))) throw new Error(`${ws.name} could not be reached just now.`);
    const res = await fetch(`${baseOf(ws.id)}/api/workspace/move`, { signal: AbortSignal.timeout(60_000) });
    const said = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(said.error ?? `${ws.name} did not say what it holds.`);
    return { ok: true, counts: said.counts ?? null, keys: Array.isArray(said.keys) ? said.keys : [] };
  }),
);

/** Which workspaces here a move home could land in: each local one, with
 * whether it is empty and whether it is a copy the work came from. */
handle("hosting:move-targets", async () => {
  if (!registry) return { targets: [] };
  const targets = await Promise.all(
    registry.workspaces
      .filter((w) => !isRemoteKind(w.kind))
      .map(async (w) => {
        const base = baseOf(w.id);
        let empty = null;
        if (base) {
          try {
            empty = (await (await fetch(`${base}/api/workspace/move`, { signal: AbortSignal.timeout(5_000) })).json()).empty === true;
          } catch {
            empty = null;
          }
        }
        return { id: w.id, name: w.name, kind: w.kind, empty, copy: Boolean(w.moved) };
      }),
  );
  return { targets };
});

async function openJoined(run, ws) {
  const profile = readJoinedProfile(ws.id);
  if (!profile) {
    run.problem = "Its membership could not be read on this computer.";
    return false;
  }
  try {
    const system = { darwin: "macOS", win32: "Windows", linux: "Linux" }[process.platform] ?? process.platform;
    // the owner's own network when the membership has no way through Bloks
    // Cloud; the same stand-in on loopback either way
    const start = reachOf(profile) === "lan" ? startLanProxy : startRemoteProxy;
    // your own hosted workspace may be asleep, and the proxy waits for it
    // to wake rather than telling the window it failed
    const options = { staticDir: serverSource().ui, client: `${system} ${app.getVersion()}`, hosted: ws.kind === "hosted" };
    run.proxy = await start(profile, { ...options, port: ws.port ?? 0 }).catch(() => start(profile, { ...options, port: 0 }));
    run.port = run.proxy.port;
    rememberPort(ws, run.port);
    return true;
  } catch (error) {
    run.problem = `Could not reach ${ws.host?.name || "its computer"}: ${error?.message ?? error}`;
    return false;
  }
}

// ── what the window asks about workspaces ─────────────────────────────

/** IPC answers are values, not throws: a thrown error reaches the page
 * wrapped in Electron's own words, and the page shows these. */
const answer = async (work) => {
  try {
    return (await work()) ?? { ok: true };
  } catch (error) {
    return { error: String(error?.message ?? error) };
  }
};

const needsList = () => {
  if (!registry) throw new Error("Workspaces work in the installed app.");
};

handle("workspaces:state", () => workspacesState());

// `open: "join"` opens the workspace on the join dialog: joining runs on a
// server of this computer's own, which a joined workspace's window has not.
handle("workspaces:switch", (_event, id, options) =>
  answer(async () => {
    needsList();
    await switchWorkspace(String(id), { query: options?.open === "join" ? "open=join" : "" });
  }),
);

// Leaving a workspace joined on someone else's computer: its owner is told
// (the member route takes the person out at once), then the credentials
// and its place in the list go. When that computer cannot be reached the
// window is told so, and may ask again with `force` to forget it here.
handle("workspaces:leave", (_event, id, options) =>
  answer(async () => {
    needsList();
    const ws = entryOf(String(id));
    if (!ws || ws.kind !== "joined") throw new Error("Only a workspace you joined can be left.");
    let told = false;
    if (await launch(ws.id).catch(() => false)) {
      const port = servers.get(ws.id)?.port;
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/member/leave`, { method: "POST", signal: AbortSignal.timeout(20_000) });
        // already out is out
        told = res.ok || res.status === 401 || res.status === 403;
      } catch {
        told = false;
      }
    }
    if (!told && options?.force !== true) return { ok: false, unreachable: true };
    if (shownId === ws.id) await switchWorkspace(PERSONAL_ID);
    await halt(ws.id);
    registry = removeWorkspace(registry, ws.id).registry;
    saveRegistry();
    waitingCounts.delete(ws.id);
    fs.rmSync(joinedFile(ws.id), { force: true });
    tellWorkspaces();
    applyBadge();
    return { ok: true, told };
  }),
);

/** What the owner of the joined workspace a window shows is called now,
 * as its server says, for the switcher and every line that names them. */
handle("workspaces:host", (event, name) => {
  const id = senderWorkspace(event);
  const ws = id ? entryOf(id) : null;
  if (!ws || ws.kind !== "joined" || typeof name !== "string" || !name.trim() || ws.host?.name === name.trim()) return;
  registry = updateWorkspace(registry, id, { hostName: name });
  saveRegistry();
  tellWorkspaces();
});

/** What you are in the joined workspace a window shows, as its server
 * says, for the switcher's Member or Admin. */
handle("workspaces:role", (event, role) => {
  const id = senderWorkspace(event);
  const ws = id ? entryOf(id) : null;
  if (!ws || ws.kind !== "joined" || (role !== "admin" && role !== "member") || ws.role === role) return;
  registry = updateWorkspace(registry, id, { role });
  saveRegistry();
  tellWorkspaces();
});

// One at a time (electron/workspaces.mjs oneAtATime): a second press of
// Create, or Enter held down, answers the making already under way
// instead of trying again and being told the name is taken by the very
// workspace it is making.
const createOnce = oneAtATime((input) =>
  answer(async () => {
    needsList();
    // A Team workspace is one other people see you in, so it starts with
    // your name: the one the window just asked for, or the one kept. Its
    // server is handed it as it starts, before anybody can be invited.
    if (typeof input?.ownerName === "string") keepName(input.ownerName);
    if (input?.team === true && !registry.prefs.ownerName) {
      return { ok: false, code: "name_required", error: "Say what people should call you first." };
    }
    const made = addWorkspace(
      registry,
      { kind: input?.kind, name: input?.name, team: input?.team === true, mark: input?.mark ?? null },
      { workspacesDir: workspacesDir() },
    );
    fs.mkdirSync(made.entry.dataDir, { recursive: true, mode: 0o700 });
    registry = made.registry;
    saveRegistry();
    openMade(made.entry.id);
    return { ok: true, id: made.entry.id };
  }),
);
handle("workspaces:create", (_event, input) => createOnce(input));

handle("workspaces:update", (_event, id, patch) =>
  answer(() => {
    needsList();
    const allowed = {};
    for (const key of ["name", "kind", "team", "notify", "mark"]) if (patch?.[key] !== undefined) allowed[key] = patch[key];
    registry = updateWorkspace(registry, String(id), allowed);
    saveRegistry();
    tellWorkspaces();
    applyBadge();
    // a new kind wears a new mark too, so either one is handed over
    if (allowed.mark !== undefined || allowed.kind !== undefined) handMark(servers.get(String(id)));
  }),
);

handle("workspaces:reroll", (_event, id) =>
  answer(() => {
    needsList();
    registry = rerollMark(registry, String(id));
    saveRegistry();
    tellWorkspaces();
    handMark(servers.get(String(id)));
  }),
);

handle("workspaces:mute", (_event, id, choice) =>
  answer(() => {
    needsList();
    registry = updateWorkspace(registry, String(id), { mute: muteFor(choice === "off" ? "off" : String(choice)) });
    saveRegistry();
    tellWorkspaces();
    applyBadge();
  }),
);

handle("workspaces:retry", (_event, id) =>
  answer(async () => {
    needsList();
    const run = servers.get(String(id));
    if (run?.status === "failed") run.status = "stopped";
    if (!(await launch(String(id)))) throw new Error(servers.get(String(id))?.problem ?? "It would not start.");
    // the window was showing why it would not start; show it now
    if (String(id) === shownId) pointWindows(shownId);
  }),
);

handle("workspaces:reorder", (_event, ids) =>
  answer(() => {
    needsList();
    registry = reorder(registry, Array.isArray(ids) ? ids.map(String) : []);
    saveRegistry();
    tellWorkspaces();
  }),
);

handle("workspaces:delete", (_event, id) => answer(() => deleteWorkspace(String(id))));

async function deleteWorkspace(id) {
  needsList();
  const ws = entryOf(id);
  if (!ws) throw new Error("There is no such workspace.");
  if (ws.kind === "personal") throw new Error("Personal cannot be deleted.");
  // out of it first, so nothing is showing a workspace on its way out
  if (shownId === ws.id) await switchWorkspace(PERSONAL_ID);
  await halt(ws.id);
  // its browser, and every sign-in it kept, go with it
  await forgetBrowser(ws.id).catch(() => {});
  registry = removeWorkspace(registry, ws.id).registry;
  saveRegistry();
  waitingCounts.delete(ws.id);
  // To the Trash rather than gone: a workspace is months of someone's
  // work, and a wrong click should cost a trip to the Trash, not that.
  // Only ever a folder the app made for it, never Personal's.
  if (insideWorkspacesDir(ws.dataDir)) {
    for (const dir of [ws.dataDir, `${ws.dataDir}-backups`]) {
      if (fs.existsSync(dir)) await shell.trashItem(dir).catch(() => fs.rmSync(dir, { recursive: true, force: true }));
    }
  }
  if (isRemoteKind(ws.kind)) fs.rmSync(joinedFile(ws.id), { force: true });
  if (ws.logo) fs.rmSync(ws.logo, { force: true });
  tellWorkspaces();
  applyBadge();
}

/** A logo instead of the mark: picked with the system's own picker, cut
 * to a square from its middle, and kept small beside the list. */
handle("workspaces:logo-pick", (event, id) =>
  answer(async () => {
    needsList();
    const ws = entryOf(String(id));
    if (!ws) throw new Error("There is no such workspace.");
    const win = BrowserWindow.fromWebContents(event.sender);
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      properties: ["openFile"],
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp", "heic", "tiff", "bmp"] }],
    });
    if (canceled || !filePaths[0]) return { ok: false };
    const image = nativeImage.createFromPath(filePaths[0]);
    if (image.isEmpty()) throw new Error("That file is not a picture Bloks can read.");
    const { width, height } = image.getSize();
    const side = Math.min(width, height);
    const square = image
      .crop({ x: Math.floor((width - side) / 2), y: Math.floor((height - side) / 2), width: side, height: side })
      .resize({ width: 256, height: 256, quality: "best" });
    fs.mkdirSync(LOGOS_DIR(), { recursive: true });
    const file = path.join(LOGOS_DIR(), `${ws.id}-${Date.now().toString(36)}.png`);
    fs.writeFileSync(file, square.toPNG());
    if (ws.logo && ws.logo !== file) fs.rmSync(ws.logo, { force: true });
    registry = updateWorkspace(registry, ws.id, { logo: file });
    saveRegistry();
    tellWorkspaces();
  }),
);

handle("workspaces:logo-clear", (_event, id) =>
  answer(() => {
    needsList();
    const ws = entryOf(String(id));
    if (!ws) throw new Error("There is no such workspace.");
    if (ws.logo) fs.rmSync(ws.logo, { force: true });
    registry = updateWorkspace(registry, ws.id, { logo: null });
    saveRegistry();
    tellWorkspaces();
  }),
);

/** How many people a team workspace has, from its Members page (or its
 * server, heardFromServer), for the switcher's count. The members work
 * calls this; nothing here counts people itself. */
handle("workspaces:members", (event, count) => {
  const id = senderWorkspace(event);
  if (id && Number.isInteger(count) && count >= 0) noteMembers(id, count);
});

// The theme is the person's, so it follows them into every workspace;
// the accent is the workspace's, so each one can look like itself
// (src/lib/accent.ts). Both are kept here as well as in the page's own
// storage: storage belongs to an origin, every workspace is an origin of
// its own, and a port that moves would forget it. The preload hands both
// back before the page draws (workspaces:boot).
handle("prefs:theme", (_event, theme) => {
  if (!registry || !["light", "dark", "system"].includes(theme)) return;
  registry = { ...registry, prefs: { ...registry.prefs, theme } };
  saveRegistry();
});
// The language is the person's as well. A choice made in one window is
// told to every other, and the menu bar is built again in it at once.
handle("prefs:language", (event, language) => {
  if (!registry) return;
  const next = setLanguage(registry, language);
  if (next === registry) return;
  registry = next;
  saveRegistry();
  installAppMenu();
  syncTray();
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && win.webContents !== event.sender) win.webContents.send("prefs:language", registry.prefs.language ?? "system");
  }
});
handle("prefs:accent", (event, accent) => {
  const id = senderWorkspace(event);
  if (!registry || !id || typeof accent !== "string") return;
  registry = chooseAccent(registry, id, accent);
  saveRegistry();
  tellWorkspaces();
});
// "Same accent in every workspace" (src/components/AccentPicker.tsx): on,
// the window's accent becomes everyone's; off, each goes back to its own.
// Answers the accent the asking window should draw in now.
// "Show working agents in the notch" (src/components/settings/GeneralPage.tsx):
// kept with the theme, since it is the person's and not a workspace's;
// off, the island's window goes altogether.
handle("prefs:notch", (_event, on) => {
  if (!registry || typeof on !== "boolean") return;
  registry = setNotch(registry, on);
  saveRegistry();
  tellWorkspaces();
  notch.sync(notchOn());
});
// "Close to the tray" (src/components/settings/GeneralPage.tsx), kept
// with the theme like the notch's switch: the icon comes and goes with it.
handle("prefs:tray", (_event, on) => {
  if (!registry || typeof on !== "boolean") return;
  registry = setTray(registry, on);
  saveRegistry();
  tellWorkspaces();
  syncTray();
});
handle("prefs:same-accent", (event, on, showing) => {
  const id = senderWorkspace(event);
  if (!registry || typeof on !== "boolean") return null;
  const done = setSameAccent(registry, id, on, showing);
  registry = done.registry;
  saveRegistry();
  tellWorkspaces();
  return done.accent;
});

/** Asked by the preload, synchronously, before the page's own scripts
 * run, so the first frame is already in the right theme and accent. */
ipcMain.on("workspaces:boot", (event) => {
  // returnValue answers the moment it is set, so it is set once
  const ws = fromOurPage(event) && registry ? entryOf(senderWorkspace(event)) : null;
  event.returnValue = ws
    ? { theme: registry.prefs.theme, language: registry.prefs.language ?? null, accent: accentOf(registry, ws.id), sameAccent: registry.prefs.sameAccent, workspace: { id: ws.id, kind: ws.kind, name: ws.name, mark: shownMark(ws) } }
    : null;
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

// The app's own page is the exact origin of a server this app started and
// proved is its own (startServerOn), port included: one per workspace.
// Any page on localhost used to count, and agents run dev servers,
// notebooks and desktops on localhost: one of those loaded into the app
// window would have had the preload's bridge (pairing a remote, Touch ID,
// the screen). A server on its way back after dying is not counted until
// it has proved itself again, since its old port is anybody's meanwhile.
function ownOrigins() {
  const own = [];
  if (remoteProfile && remotePort) own.push(`http://127.0.0.1:${remotePort}`);
  else if (!HOSTS_SERVERS) own.push(DEV_URL);
  for (const run of servers.values()) {
    if (run.status === "running" && run.port) own.push(`http://127.0.0.1:${run.port}`);
  }
  return own;
}
const isOurOwnPage = (url) => ownOrigins().some((own) => sameAppOrigin(url, own));

/** The workspace whose server served this origin, or null. */
function workspaceAt(origin) {
  for (const run of servers.values()) {
    if (run.status === "running" && run.port && sameAppOrigin(origin, `http://127.0.0.1:${run.port}`)) return run.id;
  }
  return null;
}

/** The workspace of the page that sent an IPC call. */
const senderWorkspace = (event) => workspaceAt(event?.senderFrame?.origin ?? "") ?? (HOSTS_SERVERS ? null : shownId);

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
    const w = mainWords();
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
        { label: w("menu.copyLink"), click: () => clipboard.writeText(params.linkURL) },
        { type: "separator" },
      );
    }
    if (params.isEditable) {
      items.push(
        { role: "undo", label: w("menu.undo"), enabled: params.editFlags.canUndo },
        { role: "redo", label: w("menu.redo"), enabled: params.editFlags.canRedo },
        { type: "separator" },
        { role: "cut", label: w("menu.cut"), enabled: params.editFlags.canCut },
        { role: "copy", label: w("menu.copy"), enabled: params.editFlags.canCopy },
        { role: "paste", label: w("menu.paste"), enabled: params.editFlags.canPaste },
        { role: "pasteAndMatchStyle", label: w("menu.pasteAndMatchStyle"), enabled: params.editFlags.canPaste },
        { type: "separator" },
        { role: "selectAll", label: w("menu.selectAll"), enabled: params.editFlags.canSelectAll },
      );
    } else {
      items.push({ role: "copy", label: w("menu.copy"), enabled: params.editFlags.canCopy });
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
 * The cluster is 52px wide (three 12px buttons, 20px apart). It sits in
 * the 44px title bar (TitleBar.tsx), y:16 centring the 12px buttons in
 * it, and reaches past the slim 56px main rail below (AppRail.tsx); the
 * title bar keeps 78px clear for it before its own buttons. macOS
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

/** What a window shows while its workspace's server is still starting:
 * the app's own backdrop and its name, rather than an error page. */
function openingPage(name) {
  const dark = nativeTheme.shouldUseDarkColors;
  const said = String(name ?? "Bloks").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  return (
    "data:text/html;charset=utf-8," +
    encodeURIComponent(
      `<body style="margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;background:${dark ? DARK_BACKDROP : LIGHT_BACKDROP};color:${dark ? "#8f8f99" : "#68686f"};font:13px -apple-system,system-ui">Opening ${said}…</body>`,
    )
  );
}

/** Where a window showing workspace `id` points: its server, the page
 * saying it is starting, or the page saying why it will not. */
function appUrl(query = "", id = shownId) {
  let base;
  if (remoteProfile) base = `http://127.0.0.1:${remotePort}`;
  else if (!HOSTS_SERVERS) base = DEV_URL;
  else {
    const run = servers.get(id);
    base =
      run?.status === "running" && run.port
        ? `http://127.0.0.1:${run.port}`
        : run?.status === "failed" && run.failure
          ? run.failure
          : openingPage(entryOf(id)?.name);
  }
  if (!query || !base.startsWith("http")) return base;
  return `${base}${base.includes("?") ? "&" : "?"}${query}`;
}

/** Which workspace each window shows: the main window the one you are
 * in, a terminal the one it came out of, the quick ask the one that was
 * current when it opened. */
const windowWorkspace = new WeakMap();

function showIn(win, id, query = "") {
  windowWorkspace.set(win, id);
  return win.loadURL(appUrl(query, id)).catch(() => {});
}

/** The windows of workspace `id` at the app again, after its server came
 * back (perhaps on another port), or at the failure page once it will
 * not. The app keeps nothing in its address, so loading it afresh loses
 * nothing a reload would keep. */
function pointWindows(id) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || (windowWorkspace.get(win) ?? shownId) !== id) continue;
    // a server that died again at once fails the load, and the next try
    // or the failure page points the window again
    if (win === notch.window()) {
      void showNotchIn(win, id);
      continue;
    }
    const query = win === quickWin ? "quick=1" : (terminalWins.get(win) ?? "");
    void showIn(win, id, query);
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
  void showIn(quickWin, shownId, "quick=1");
  // Clicking away is a dismissal. Anything else would leave a floating
  // box on somebody's screen with no obvious way to close it.
  quickWin.on("blur", () => quickWin?.hide());
  quickWin.on("closed", () => {
    quickWin = null;
  });
  return quickWin;
}

// ── a terminal window ─────────────────────────────────────────────────
// An agent's terminal, popped out of the conversation into a window of
// its own: the same page, loaded with ?terminal=<agent>, which draws
// nothing but that agent's terminal (App.tsx). One per agent; asking again
// brings the one already open forward. Each remembers its query so a
// server restart can point it back at the same terminal.

/** Terminal windows, and the query each one loads. */
const terminalWins = new Map();

/** The main workspace window, rather than the quick ask panel, the
 * notch or a terminal of its own: the one links, menu commands and the
 * Dock icon are for. */
function isWorkspaceWindow(win) {
  return Boolean(win) && !win.isDestroyed() && win !== quickWin && win !== notch.window() && !terminalWins.has(win);
}

// ── the notch ─────────────────────────────────────────────────────────
// The agents at work in the MacBook's notch (electron/notch.mjs): a clear
// window over the top of the screen, drawing the island from the page
// with ?notch=1. Like the quick ask it shows the workspace you are in,
// and like it, it is not a window links or the Dock are for.

const notch = createNotch({
  BrowserWindow,
  screen,
  preload: path.join(HERE, "preload.cjs"),
  guard: (win) => guardNavigation(win),
  load: (win) => void showNotchIn(win, shownId),
});

/** On unless turned off, and only on a Mac. */
function notchOn() {
  return notchPlatform() && registry?.prefs?.notch !== false;
}

// ── the tray (Windows) ────────────────────────────────────────────────
// With "Close to the tray" on (electron/tray.mjs): a click on the icon
// brings the window back, and its menu quits Bloks for real.
let tray = null;
function syncTray() {
  if (!trayOn(process.platform, registry?.prefs)) {
    tray?.destroy();
    tray = null;
    return;
  }
  if (!tray) {
    tray = new Tray(APP_ICON);
    tray.setToolTip(app.name);
    tray.on("click", () => {
      const win = mainWindow();
      if (win) raise(win);
      else createWindow();
    });
  }
  // built again on a language change, for the word
  tray.setContextMenu(Menu.buildFromTemplate([{ label: mainWords()("menu.quit", { name: app.name }), click: () => app.quit() }]));
}

/** The island's page, from workspace `id`'s server. While that server is
 * starting, or will not, a clear page: the opening and failure pages are
 * for a window someone is looking at, and this one would show them as a
 * slab over the menu bar. pointWindows brings it back once it is up. */
function showNotchIn(win, id) {
  windowWorkspace.set(win, id);
  const url = appUrl("notch=1", id);
  return win.loadURL(url.startsWith("http") ? url : "about:blank").catch(() => {});
}

/** The island over to another workspace's agents. */
function pointNotch(id) {
  const win = notch.window();
  if (win) void showNotchIn(win, id);
}

/** Only the island's own page speaks for it. */
const fromNotch = (event) => Boolean(notch.window()) && event.sender === notch.window().webContents;

handle("notch:hover", (event, over) => {
  if (fromNotch(event)) notch.hover(over === true);
});
handle("notch:geometry", (event) => (fromNotch(event) ? notch.geometry() : null));
// A row in the island: that conversation, in the window showing its
// workspace, brought forward the way a banner's click brings it, and
// through the same door (notify:activate).
handle("notch:open", (event, target) => {
  if (!fromNotch(event)) return;
  const said = conversationTarget(target);
  if (!said) return;
  const id = windowWorkspace.get(notch.window()) ?? shownId;
  const main = BrowserWindow.getAllWindows().find((w) => isWorkspaceWindow(w) && (windowWorkspace.get(w) ?? shownId) === id);
  if (main && !main.webContents.isLoading()) {
    raise(main);
    main.webContents.send("notify:activate", { target: said });
  } else {
    void switchWorkspace(id, { target: said }).catch(() => {});
  }
});

function openTerminalWindow(botId, workspace = shownId) {
  const query = terminalQuery(botId);
  if (!query) throw new Error("not an agent");
  for (const [win, has] of terminalWins) {
    if (has === query && windowWorkspace.get(win) === workspace && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      return;
    }
  }
  const parent = BrowserWindow.getAllWindows().find((w) => isWorkspaceWindow(w));
  const near = parent?.getBounds();
  const win = new BrowserWindow({
    width: 900,
    height: 560,
    // a little down and across from the window it came out of
    ...(near ? { x: near.x + 48, y: near.y + 48 } : {}),
    minWidth: 420,
    minHeight: 240,
    icon: APP_ICON,
    title: "Terminal",
    backgroundColor: nativeTheme.shouldUseDarkColors ? DARK_BACKDROP : LIGHT_BACKDROP,
    // the same settings as the main window, written out for the same
    // reason: this page draws a shell, and a shell's output is somebody
    // else's text
    webPreferences: {
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
  terminalWins.set(win, query);
  win.on("closed", () => terminalWins.delete(win));
  guardNavigation(win);
  installContextMenu(win);
  void showIn(win, workspace, query);
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
    // macOS draws its three buttons as a 52px cluster. The main rail has
    // to be wider than that plus both insets, or the green one sits on the
    // panel's edge; see BUTTONS below for the arithmetic.
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
  // "Close to the tray": the close button hides the window, unless Bloks
  // is quitting. Windows ending the session sends no before-quit, so
  // that says Bloks is quitting here, or the window would hold it up.
  win.on("close", (event) => {
    if (!closeHides(process.platform, registry?.prefs, quitting)) return;
    event.preventDefault();
    win.hide();
  });
  win.on("session-end", () => {
    quitting = true;
  });
  if (restored.maximized) win.maximize();

  // Links in this app come from models and from web pages the agent read,
  // so every URL is treated as hostile until proven to be plain http(s):
  // those open in the real browser, and everything else is dropped. The
  // app frame itself never navigates anywhere but its own origin.
  guardNavigation(win);
  // a page that died is loaded again, and one that keeps dying stops at a
  // plain page (electron/renderer-watch.mjs)
  watchRenderer(win, {
    log: appLog,
    reopen: () => void showIn(win, windowWorkspace.get(win) ?? shownId),
    stopped: () => stoppedPage({ backdrop: nativeTheme.shouldUseDarkColors ? DARK_BACKDROP : LIGHT_BACKDROP, dark: nativeTheme.shouldUseDarkColors }),
    quitting: () => quitting,
  });

  void showIn(win, shownId, welcomeQuery);
  welcomeQuery = "";
  return win;
}

// What the page itself has to say for the app log, such as an error the
// interface caught and could not draw past. Budgeted, so a page failing
// in a loop cannot fill the disk.
const pageLogBudget = lineBudget();
handle("app:log", (_event, text) => {
  if (typeof text === "string" && pageLogBudget()) appLog(`page: ${text}`);
});

// ── the Bloks browser ─────────────────────────────────────────────────
// A browser in the window, beside the chat, that agents drive and the
// person watches and takes over (electron/app-browser.mjs has the rules;
// server/app-browser.ts has the workspace's side of them).
//
// Each workspace browses in a session of its own, on disk, so its
// sign-ins are its own and never the app's: the app's page runs on the
// default session with the preload's bridge, and nothing here shares
// either. A tab is a WebContentsView with no preload at all, sandboxed,
// that the page in the window places by telling this process where its
// panel is (browser:bounds). Agents reach a tab through its debugger,
// asked by the workspace's server over the line it already has.

/** Each workspace's browser, made the first time it is wanted. */
const browsers = new Map();

/** Permissions a page in the Bloks browser may have. Everything else
 * (camera, microphone, location, notifications, devices) is refused: a
 * page an agent opened should not be able to ask the person for any. */
const BROWSER_GRANTS = new Set(["fullscreen", "clipboard-sanitized-write"]);

/** Every port a Bloks server on this computer answers on, and the app's
 * own page: none of them is ever loaded in, or fetched from, a tab. */
function ownPorts() {
  const ports = [];
  for (const run of servers.values()) if (run.port) ports.push(run.port);
  if (remotePort) ports.push(remotePort);
  try {
    ports.push(Number(new URL(DEV_URL).port));
  } catch {
    /* no development page */
  }
  return ports;
}

/** Where a workspace's downloads go, made private on first use. The
 * server names the same folder (server/index.ts APP_BROWSER_DOWNLOADS). */
function downloadsDir(ws) {
  const dir = path.join(ws.dataDir, "browser-downloads");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function browserFor(id) {
  const had = browsers.get(id);
  if (had) return had;
  const ws = id ? entryOf(id) : null;
  if (!ws || isRemoteKind(ws.kind) || !ws.dataDir) return null;
  const ses = session.fromPartition(partitionFor(id));
  const held = { id, ses, views: new Map(), bounds: null, win: null, stateTimer: null, browser: null };
  held.browser = new AppBrowser({
    makeTab: (tabId) => makeBrowserTab(held, tabId),
    onChange: () => browserChanged(held),
    ownPorts,
  });
  guardBrowserSession(held, ws);
  browsers.set(id, held);
  return held;
}

/** The rules every page in a workspace's browser lives under. */
function guardBrowserSession(held, ws) {
  const { ses } = held;
  ses.setPermissionRequestHandler((_contents, permission, callback) => callback(BROWSER_GRANTS.has(permission)));
  ses.setPermissionCheckHandler((_contents, permission) => BROWSER_GRANTS.has(permission));
  // Sites that refuse "embedded" browsers read the Electron token in the
  // user agent; without it this is the Chromium it is.
  ses.setUserAgent(ses.getUserAgent().replace(/\s(Electron|bloks|Bloks)\/\S+/g, ""));
  // A page may not reach a Bloks server even as a picture or a fetch:
  // the origin checks would refuse it, and this means it never gets
  // as far as asking.
  ses.webRequest.onBeforeRequest({ urls: ["*://127.0.0.1/*", "*://localhost/*", "*://[::1]/*"] }, (details, callback) => {
    callback({ cancel: Boolean(refusedNavigation(details.url, { ownPorts: ownPorts() })) });
  });
  ses.on("will-download", (_event, item) => {
    let dir;
    try {
      dir = downloadsDir(ws);
    } catch {
      return item.cancel();
    }
    const name = downloadName(item.getFilename(), (taken) => fs.existsSync(path.join(dir, taken)));
    const file = path.join(dir, name);
    item.setSavePath(file);
    const control = held.browser.control;
    const id = `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const note = (state) =>
      held.browser.noteDownload({
        id,
        name,
        path: file,
        bytes: item.getReceivedBytes(),
        total: item.getTotalBytes(),
        state,
        at: Date.now(),
        ...(control.by === "agent" ? { by: control.name } : {}),
      });
    note("progressing");
    item.on("updated", (_e, state) => note(state === "interrupted" ? "interrupted" : "progressing"));
    item.once("done", (_e, state) => note(state === "completed" ? "completed" : state === "cancelled" ? "cancelled" : "interrupted"));
  });
}

/** One tab: a view with no bridge of ours, and its debugger for agents. */
function makeBrowserTab(held, tabId) {
  const view = new WebContentsView({
    webPreferences: {
      partition: partitionFor(held.id),
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      sandbox: true,
      webviewTag: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      // an agent drives it with the panel closed too, and a throttled
      // page answers its debugger slowly
      backgroundThrottling: false,
    },
  });
  view.setVisible(false);
  const wc = view.webContents;
  try {
    wc.debugger.attach("1.3");
  } catch (error) {
    appLog(`browser: debugger did not attach: ${error?.message ?? error}`);
  }
  held.views.set(tabId, view);
  const tab = {
    cdp: (method, params = {}) => boundedCdp(wc, method, params),
    url: () => (wc.isDestroyed() ? "" : wc.getURL()),
    title: () => (wc.isDestroyed() ? "" : wc.getTitle()),
    load: (url) => void wc.loadURL(url).catch(() => {}),
    loading: () => !wc.isDestroyed() && wc.isLoading(),
    canGoBack: () => !wc.isDestroyed() && wc.navigationHistory.canGoBack(),
    canGoForward: () => !wc.isDestroyed() && wc.navigationHistory.canGoForward(),
    close: () => {
      held.views.delete(tabId);
      try {
        held.win?.contentView.removeChildView(view);
      } catch {
        /* the window went first */
      }
      if (!wc.isDestroyed()) wc.close();
    },
  };
  const changed = () => held.browser.changed();
  for (const name of ["did-start-loading", "did-stop-loading", "page-title-updated", "did-navigate-in-page", "render-process-gone"]) wc.on(name, changed);
  wc.on("did-navigate", () => {
    // a new document: the last snapshot's refs name nothing on it
    tab.refs = new Map();
    changed();
  });
  // Where a tab may go, on every navigation the page starts and every
  // redirect: never somewhere refusedNavigation names, and, while an
  // agent drives it, nowhere its workspace's lists keep agents from.
  const guard = (event, url) => {
    if (refusedNavigation(url, { ownPorts: ownPorts() })) return event.preventDefault();
    const control = held.browser.control;
    if (control.by === "agent" && tab.by?.kind === "agent" && !allowedForAgent(url, tab.policy)) {
      tab.blocked = url;
      event.preventDefault();
    }
  };
  wc.on("will-navigate", (event) => guard(event, event.url));
  wc.on("will-redirect", (event) => {
    if (event.isMainFrame) guard(event, event.url);
  });
  // A page that opens a window gets a tab of ours instead, under the same
  // rules, driven by whoever drove the tab that opened it.
  wc.setWindowOpenHandler(({ url }) => {
    if (refusedNavigation(url, { ownPorts: ownPorts() })) return { action: "deny" };
    const control = held.browser.control;
    if (control.by === "agent" && !allowedForAgent(url, tab.policy)) {
      tab.blocked = url;
      return { action: "deny" };
    }
    try {
      const opened = held.browser.newTab(tab.by ?? { kind: "person" });
      opened.policy = tab.policy;
      opened.load(url);
    } catch {
      /* the most tabs there may be are open */
    }
    return { action: "deny" };
  });
  // The person reaching into a tab an agent is driving takes it over:
  // the agent's next step waits for it back. Its own steps' input
  // events are not that (tab.acting, AppBrowser.command).
  wc.on("input-event", (_event, input) => {
    if (tab.acting || held.browser.control.by !== "agent") return;
    if (input.type === "mouseDown" || input.type === "keyDown" || input.type === "rawKeyDown") held.browser.takeOver();
  });
  if (held.win && !held.win.isDestroyed()) {
    try {
      held.win.contentView.addChildView(view);
    } catch {
      /* placed when the panel next says where it is */
    }
  }
  return tab;
}

/** A server that just came up hears what its browser is doing, so an
 * agent asking after a restart is not told about nothing. */
function handBrowser(run) {
  const held = browsers.get(run?.id);
  if (!held || !run.child) return;
  try {
    run.child.postMessage({ kind: "browser.state", state: held.browser.state() });
  } catch {
    /* it hears the next change */
  }
}

/** One protocol call, bounded: a page that never answers its debugger
 * fails the agent's step instead of holding it, and the turn, forever. */
function boundedCdp(wc, method, params) {
  let timer;
  return Promise.race([
    wc.debugger.sendCommand(method, params).finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`the page did not answer ${method} in time`)), 20_000);
    }),
  ]);
}

/** The windows showing workspace `id`, which hear its browser's state. */
const windowsShowing = (id) =>
  BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && isWorkspaceWindow(w) && (windowWorkspace.get(w) ?? shownId) === id);

/** Said to the window and to the workspace's server, a beat after the
 * last change, so a page loading is one message rather than twenty. */
function browserChanged(held) {
  placeTabs(held);
  clearTimeout(held.stateTimer);
  held.stateTimer = setTimeout(() => {
    const state = held.browser.state();
    for (const win of windowsShowing(held.id)) win.webContents.send("browser:state", state);
    try {
      servers.get(held.id)?.child?.postMessage({ kind: "browser.state", state });
    } catch {
      /* the server is restarting; it hears the next change */
    }
  }, 120);
}

/** The tab on screen where the panel is, and every other tab hidden. */
function placeTabs(held) {
  const win = held.win;
  if (!win || win.isDestroyed()) return;
  const zoom = win.webContents.getZoomFactor?.() ?? 1;
  for (const [tabId, view] of held.views) {
    try {
      if (!win.contentView.children.includes(view)) win.contentView.addChildView(view);
      const shown = Boolean(held.bounds) && tabId === held.browser.state().activeTabId;
      if (shown) {
        const { x, y, width, height } = held.bounds;
        view.setBounds({ x: Math.round(x * zoom), y: Math.round(y * zoom), width: Math.round(width * zoom), height: Math.round(height * zoom) });
      }
      view.setVisible(shown);
    } catch {
      /* a view on its way out */
    }
  }
}

/** A workspace's tabs out of the window they were in. */
function detachBrowser(held) {
  const win = held.win;
  held.win = null;
  held.bounds = null;
  if (!win || win.isDestroyed()) return;
  for (const view of held.views.values()) {
    try {
      win.contentView.removeChildView(view);
    } catch {
      /* already out */
    }
  }
}

/** A rectangle from the page, or null for "not on screen". */
function boundsFrom(rect) {
  if (!rect || typeof rect !== "object") return null;
  const n = (v) => (Number.isFinite(v) ? Math.max(0, Math.min(20_000, Number(v))) : NaN);
  const out = { x: n(rect.x), y: n(rect.y), width: n(rect.width), height: n(rect.height) };
  return Object.values(out).some(Number.isNaN) || out.width < 40 || out.height < 40 ? null : out;
}

/** Windows whose page is leaving: their tabs hide until the page that
 * replaces it says where its panel is. */
const watchedForBrowser = new WeakSet();
function watchWindowForBrowser(win) {
  if (watchedForBrowser.has(win)) return;
  watchedForBrowser.add(win);
  win.webContents.on("did-start-navigation", (event) => {
    if (!event.isMainFrame || event.isSameDocument) return;
    for (const held of browsers.values()) {
      if (held.win !== win) continue;
      held.bounds = null;
      placeTabs(held);
    }
  });
  win.once("closed", () => {
    for (const held of browsers.values()) if (held.win === win) held.win = null;
  });
}

handle("browser:state", (event) => browserFor(senderWorkspace(event))?.browser.state() ?? null);

handle("browser:bounds", (event, rect) => {
  const id = senderWorkspace(event);
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!id || !win || !isWorkspaceWindow(win)) return null;
  const held = browserFor(id);
  if (!held) return null;
  watchWindowForBrowser(win);
  // another workspace's tabs never sit over this one's page
  for (const other of browsers.values()) if (other !== held && other.win === win) detachBrowser(other);
  if (held.win !== win) {
    detachBrowser(held);
    held.win = win;
  }
  held.bounds = boundsFrom(rect);
  placeTabs(held);
  return held.browser.state();
});

/** What the person does in the panel that moves a page an agent may be
 * driving. */
const PERSON_STEERS = new Set(["navigate", "selectTab", "closeTab", "back", "forward", "reload", "stop"]);

/** What the person does from the panel. One channel, a fixed set of
 * actions: the page names one, never a path or a script. */
handle("browser:do", async (event, action, arg) => {
  const held = browserFor(senderWorkspace(event));
  if (!held) return { error: "This workspace has no browser here." };
  const { browser } = held;
  const active = browser.active;
  const wc = active ? held.views.get(active.id)?.webContents : null;
  const download = () => browser.state().downloads.find((d) => d.id === arg && d.state === "completed");
  // the person steering while an agent drives is the person taking over
  if (PERSON_STEERS.has(action) && browser.control.by === "agent") browser.takeOver();
  switch (action) {
    case "navigate":
      return browser.navigate(String(arg ?? ""));
    case "newTab":
      browser.newTab({ kind: "person" });
      return { ok: true };
    case "closeTab":
      return { ok: browser.close(String(arg ?? "")) };
    case "selectTab":
      return { ok: browser.select(String(arg ?? "")) };
    case "back":
      if (wc?.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
      return { ok: true };
    case "forward":
      if (wc?.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
      return { ok: true };
    case "reload":
      wc?.reload();
      return { ok: true };
    case "stop":
      wc?.stop();
      return { ok: true };
    case "takeOver":
      browser.takeOver();
      return { ok: true };
    case "giveBack":
      browser.giveBack();
      return { ok: true };
    case "openExternal": {
      const url = active?.url() ?? "";
      if (/^https?:\/\//i.test(url)) await shell.openExternal(url);
      return { ok: true };
    }
    case "openDownload": {
      const found = download();
      if (found) await shell.openPath(found.path);
      return { ok: Boolean(found) };
    }
    case "revealDownload": {
      const found = download();
      if (found) shell.showItemInFolder(found.path);
      return { ok: Boolean(found) };
    }
    case "openDownloads": {
      const ws = entryOf(held.id);
      if (ws?.dataDir) await shell.openPath(downloadsDir(ws));
      return { ok: true };
    }
    case "clearDownloads":
      browser.clearDownloads();
      return { ok: true };
    case "forgetSites":
      // signed out everywhere: cookies, storage and cache, this workspace only
      await held.ses.clearStorageData();
      await held.ses.clearCache();
      return { ok: true };
    default:
      return { error: "The browser does not do that." };
  }
});

/** A command from the workspace's server: an agent's, or another app's
 * over MCP. The server checked it and decided the site and the field;
 * this runs it and says what happened. */
async function browserCommand(id, said) {
  const held = browserFor(id);
  if (!held) return { error: "This workspace has no browser here.", status: 503 };
  const command = said?.command;
  if (!command || typeof command.action !== "string") return { error: "That is not a browser command.", status: 400 };
  const driver = { botId: String(said.driver?.botId ?? ""), name: String(said.driver?.name ?? "An agent") };
  // the person sees it happen: the panel opens where the workspace is shown
  if (command.action === "open" && !held.bounds) {
    for (const win of windowsShowing(id)) win.webContents.send("browser:reveal", { by: driver.name });
  }
  return held.browser.command(command, driver);
}

/** A small picture of the tab on screen, for a phone looking on. */
async function browserThumbnail(id) {
  const held = browsers.get(id);
  const active = held?.browser.active;
  const wc = active ? held.views.get(active.id)?.webContents : null;
  if (!wc || wc.isDestroyed()) return { jpeg: null };
  try {
    const image = await wc.capturePage();
    if (image.isEmpty()) return { jpeg: null };
    return { jpeg: image.resize({ width: 480 }).toJPEG(60).toString("base64") };
  } catch {
    return { jpeg: null };
  }
}

/** A deleted workspace's browser: its tabs closed, its session emptied. */
async function forgetBrowser(id) {
  const held = browsers.get(id);
  const ses = held?.ses ?? session.fromPartition(partitionFor(id));
  if (held) {
    held.browser.closeAll();
    detachBrowser(held);
    browsers.delete(id);
  }
  await ses.clearStorageData();
  await ses.clearCache();
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
 * The workspace on screen decides for itself whether anything is worth
 * showing (see src/lib/notify.ts), and a workspace in the background says
 * the same through its server (server/desktop-notice.ts, heard in
 * heardFromServer below). Either way this end shows it, because
 * Notification belongs to the main process and the click has to raise a
 * window the renderer cannot raise itself; and either way each
 * workspace's own mute and notification level have the last word.
 */
/** The banner each conversation currently has up, so a chatty agent
 * replaces its own banner rather than papering the corner of the screen
 * with copies. Keyed by workspace and target: one banner per
 * conversation. */
const standingBanners = new Map();

/** The agent's face for the banner, fetched from its workspace's server.
 * Answers null quickly and quietly whenever it cannot: an iconless banner
 * is fine, a banner that arrives late is not. */
async function bannerIcon(avatar, port) {
  if (typeof avatar !== "string" || !avatar.startsWith("/api/") || !port) return null;
  try {
    const response = await fetch(`http://127.0.0.1:${port}${avatar}`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) return null;
    const image = nativeImage.createFromBuffer(Buffer.from(await response.arrayBuffer()));
    return image.isEmpty() ? null : image;
  } catch {
    return null;
  }
}

/** Shows one banner for workspace `id`, if its mute and level allow a
 * notice of this weight. `open` runs on a click. */
async function showBanner(id, notice, open) {
  if (!Notification.isSupported()) return;
  const ws = id ? entryOf(id) : null;
  const level = notice?.urgent ? "needs-me" : "activity";
  // no list means a development run with one server, as before
  if (ws && !allowsNotice(ws, level)) return;
  const target = String(notice?.target ?? "");
  const run = id ? servers.get(id) : null;
  const icon = await bannerIcon(notice?.avatar, run?.port ?? null);
  const shown = new Notification({
    title: String(notice?.title ?? "Bloks").slice(0, 120),
    // which workspace, once there is more than one to tell apart
    ...(ws && registry.workspaces.length > 1 ? { subtitle: ws.name } : {}),
    body: String(notice?.body ?? "").slice(0, 400),
    silent: !notice?.urgent,
    ...(icon ? { icon } : {}),
  });
  // the previous banner from this conversation is old news now
  if (target) {
    const key = `${id ?? ""}:${target}`;
    standingBanners.get(key)?.close();
    standingBanners.set(key, shown);
    shown.on("close", () => {
      if (standingBanners.get(key) === shown) standingBanners.delete(key);
    });
  }
  shown.on("click", () => void open(target));
  shown.show();
}

/** Raises a window, the way a click on a banner or the Dock should. */
function raise(win) {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  app.focus?.({ steal: true });
}

handle("notify:show", async (event, notice) => {
  const id = senderWorkspace(event);
  await showBanner(id, notice, (target) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    // the page that asked may have moved to another workspace since
    if (win && !win.isDestroyed() && (windowWorkspace.get(win) ?? shownId) === id) {
      raise(win);
      win.webContents.send("notify:activate", { target });
    } else if (id) {
      void switchWorkspace(id, { target }).catch(() => {});
    }
  });
});

/** What a banner's click was about, for a window that loaded after the
 * click: switching workspaces loads the page afresh, and it asks for
 * this once it is listening, the way a link waits above. */
let pendingNotifyTarget = null;
handle("notify:pending", () => {
  const target = pendingNotifyTarget;
  pendingNotifyTarget = null;
  return target;
});

/**
 * What a workspace's server tells the app (server/desktop-notice.ts):
 * a banner for something it would have shown, and how many of its
 * conversations are waiting. The workspace on screen shows its own
 * banners from its page, so its server's are only used when no window
 * is showing it, with the app running in the Dock.
 */
function heardFromServer(id, child, said) {
  const run = servers.get(id);
  // a server from before a restart, still saying its last words
  if (!run || (run.child && run.child !== child)) return;
  if (said?.kind === "desktop.ask" && typeof said.ask === "string") return void answerServer(id, child, said);
  if (said?.kind === "desktop.answer") return void serverAsks.heard(said);
  if (said?.kind === "desktop.licence") return keepLicence(said.key, said.typed !== false);
  if (said?.kind === "desktop.licence.forget") return forgetLicence();
  if (said?.kind === "desktop.plan") return notePlan(said);
  if (said?.kind === "desktop.account") return noteAccount(said);
  if (said?.kind === "desktop.name") return keepName(said.name, { seed: said.seed === true });
  if (said?.kind === "desktop.screen") return void answerScreen(child, said.id);
  if (said?.kind === "desktop.unread" && Number.isInteger(said.count)) {
    waitingCounts.set(id, Math.max(0, said.count));
    applyBadge();
    tellWorkspaces();
  } else if (said?.kind === "desktop.notice" && said.notice) {
    if (id === shownId && mainWindow()) return;
    const level = said.notice.level === "needs-me";
    void showBanner(id, { ...said.notice, urgent: level }, (target) => void switchWorkspace(id, { target }).catch(() => {}));
  } else if (said?.kind === "desktop.members" && Number.isInteger(said.count)) {
    // how many people are in a team workspace, from its own server, for
    // the switcher's "3 members" (the members work fills this in)
    noteMembers(id, said.count);
  }
}

/**
 * A picture of this Mac's screen for a workspace's server, which asks only
 * while one of its agents is driving the Mac and the person's phone is
 * looking at it (server/index.ts, macFrame). It never asks macOS for the
 * permission: without Screen Recording already granted there is no
 * picture, and the phone says to watch on the Mac instead.
 */
async function answerScreen(child, id) {
  let jpeg = null;
  try {
    if (process.platform === "darwin" && systemPreferences.getMediaAccessStatus?.("screen") === "granted") {
      const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 1440, height: 900 } });
      const shot = sources[0]?.thumbnail;
      if (shot && !shot.isEmpty()) jpeg = shot.toJPEG(70).toString("base64");
    }
  } catch {
    jpeg = null;
  }
  try {
    child.postMessage({ kind: "screen.frame", id, jpeg });
  } catch {
    // the server went while the picture was being taken
  }
}

/**
 * The Dock badge: what is waiting, across every workspace.
 *
 * The workspace on screen counts its own (the renderer owns that
 * arithmetic, because only it knows what counts as unread right now);
 * the others count on their servers. Each workspace's mute and level
 * decide whether its number is added at all. Windows has no badge, so it
 * gets a red overlay on the taskbar icon instead, drawn in
 * taskbar-badge.mjs (never the app icon, which read as a stray logo).
 */
const badgeOverlays = new Map();
/** The overlay for one choice, at 100% and 200% so it stays crisp on a
 * high-DPI taskbar. Built once per look, since there are only ten. */
function overlayImage({ kind, label }) {
  const key = `${kind}:${label}`;
  let image = badgeOverlays.get(key);
  if (!image) {
    image = nativeImage.createFromBitmap(renderBadge(kind, label, 16), { width: 16, height: 16 });
    image.addRepresentation({ scaleFactor: 2, width: 32, height: 32, buffer: renderBadge(kind, label, 32) });
    badgeOverlays.set(key, image);
  }
  return image;
}
/** The count the window on screen last reported. */
let shownCount = 0;
/** What each workspace's server last said is waiting. */
const waitingCounts = new Map();

function applyBadge() {
  let count = shownCount;
  if (registry) {
    const counts = {};
    for (const ws of registry.workspaces) {
      counts[ws.id] = ws.id === shownId && mainWindow() ? shownCount : (waitingCounts.get(ws.id) ?? 0);
    }
    count = badgeTotal(registry.workspaces, counts);
  }
  count = normalizeBadgeCount(count);
  if (process.platform === "win32") {
    const win = mainWindow();
    if (!win) return;
    const choice = overlayChoice(count);
    win.setOverlayIcon(choice.kind === "none" ? null : overlayImage(choice), choice.description);
    return;
  }
  app.setBadgeCount(count);
}

handle("badge:set", (event, value) => {
  const id = senderWorkspace(event);
  // a terminal window of another workspace has no say over the one shown
  if (registry && id !== shownId) return;
  shownCount = normalizeBadgeCount(value);
  applyBadge();
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

/** The biggest HEIC photo the composer may hand over to be made a JPEG:
 * several times what a phone takes, and a bound on what the page can make
 * this process write down. */
const HEIC_MAX_BYTES = 64 * 1024 * 1024;

/**
 * A HEIC photo the composer was given, as a JPEG, since no server takes
 * HEIC as a picture and Chromium cannot read one (GitHub 333). nativeImage
 * cannot either, short of Quick Look's small square thumbnail, so macOS's
 * own sips makes it, at full size. Only from bytes the page already holds,
 * never a path it names, in a folder of this call's own that is gone
 * after. Null off macOS, and for bytes sips cannot read.
 */
handle("image:heic-as-jpeg", async (_event, bytes) => {
  if (process.platform !== "darwin" || !(bytes instanceof Uint8Array) || !bytes.length || bytes.length > HEIC_MAX_BYTES) return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bloks-heic-"));
  try {
    const from = path.join(dir, "photo.heic");
    const to = path.join(dir, "photo.jpg");
    fs.writeFileSync(from, bytes, { mode: 0o600 });
    await new Promise((resolve, reject) =>
      execFile("/usr/bin/sips", ["-s", "format", "jpeg", "-s", "formatOptions", "90", from, "--out", to], { timeout: 30_000 }, (error) =>
        error ? reject(error) : resolve(),
      ),
    );
    return new Uint8Array(fs.readFileSync(to));
  } catch {
    return null;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The system share sheet, for a workspace invite's link: Messages, Mail,
// AirDrop, whatever this Mac has. Only an https link to bloks.dev is ever
// shared from here, so a page cannot dress anything else up as an invite.
// False where there is no share sheet (Windows, Linux), and the window
// copies the link instead.
handle("share:link", (event, url) => {
  if (process.platform !== "darwin" || typeof ShareMenu !== "function") return false;
  if (typeof url !== "string" || !/^https:\/\/bloks\.dev\/j\/[a-z0-9]{6}#[0-9A-Z~.:[\]-]{8,80}$/.test(url)) return false;
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) return false;
  new ShareMenu({ urls: [url] }).popup({ window: win });
  return true;
});

// The Plan page's two needs of the licence, met here so the page never
// holds it (electron/plan-link.mjs). An offer opens in the browser with
// the key in the fragment, for bloks.dev alone; the key is copied straight
// to the clipboard, for somebody setting up another computer.
const planSite = () => (process.env.BLOKS_SITE_URL || "https://bloks.dev").trim().replace(/\/+$/, "");
handle("plan:open", (event, url) => {
  const target = withLicence(url, readLicence(), planSite());
  if (!target) return false;
  // the workspace whose Plan page this was is the one a move to Hosting
  // takes, should this be the checkout for it (electron/hosting-move.mjs)
  const from = senderWorkspace(event);
  const ws = from ? entryOf(from) : null;
  if (ws && !isRemoteKind(ws.kind) && !ws.moved && !moveStateNow().moved) {
    keepMove({ boughtFrom: { id: ws.id, at: Date.now() } });
    watchAccount();
  }
  void shell.openExternal(target);
  return true;
});
handle("licence:copy", () => {
  const key = readLicence();
  if (!key) return false;
  clipboard.writeText(key);
  return true;
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
/** The updater's log, once there is an updater. A restart into an update
 * writes its own steps there too, so one file tells the whole of it. */
let updaterLog = null;
/** Set at start when the last restart into an update came back on the
 * version it left (electron/update-restart.mjs), until the card that
 * says so is closed or the restart is tried again. */
let notInstalled = null;

/** The note of the version a restart is leaving, read at the next start. */
const INSTALL_MARK_FILE = () => path.join(app.getPath("userData"), "update-restart.json");

/** What the windows are told: the updater's state, and the update that
 * did not install while that is still to be said. */
const updateToShow = () => (notInstalled ? { ...updaterState, notInstalled } : updaterState);

function showUpdate(next) {
  updaterState = next;
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send("update:state", updateToShow());
  }
}

handle("app:version", () => app.getVersion());
handle("update:state", () => updateToShow());
handle("update:check", async () => {
  if (!app.isPackaged) return { state: "dev" };
  try {
    await electronUpdater.autoUpdater.checkForUpdates();
  } catch {
    // the error event has already told the windows
  }
  return updateToShow();
});
handle("update:not-installed-seen", () => {
  notInstalled = null;
  showUpdate(updaterState);
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
  if (remoteProfile || !runningServers().length) return "done";
  // every workspace's server drains, and the wait is for the slowest
  // (mergeDrains in electron/workspaces.mjs)
  const askOne = async (port, method) => {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/maintenance/drain`, {
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
  const ask = async (method) => mergeDrains(await Promise.all(runningServers().map((run) => askOne(run.port, method))));
  drainWaiting = drainWait(ask, {
    onProgress: (state) =>
      showUpdate({ ...updaterState, draining: { running: state.running.length, deadline: state.deadline } }),
  });
  try {
    return await drainWaiting.finished;
  } finally {
    // however it ended: a wait left standing would turn away every later
    // press of the button
    drainWaiting = null;
    const { draining: _, ...rest } = updaterState;
    showUpdate(rest);
  }
}

/** On macOS the updater hands each download to the native installer,
 * which fetches and unpacks it again before it can install it, a few
 * seconds after the card already reads ready. A quit asked for in
 * between installs nothing. So a restart waits for the installer to have
 * what it was last handed, or to have said that it failed. */
let staging = false;
let stagingOver = () => {};
const nativelyStaged = () =>
  new Promise((resolve) => {
    if (!staging) return resolve();
    stagingOver = resolve;
  });

/** A restart asked for and on its way, so a second press joins it and
 * does not start another. */
let restart = null;

/** A line of the restart's own in the updater's log. */
const restartLog = (line) => updaterLog?.info(line);

// Every step has a time limit and none can stop the next, and once the
// drain is past the process ends: by an exit, if the quit does not get
// there (electron/update-restart.mjs).
handle("update:install", () => {
  if (!app.isPackaged) return;
  if (notInstalled) {
    // trying again is the answer to it
    notInstalled = null;
    showUpdate(updaterState);
  }
  restart ??= restartIntoUpdate(
    {
      // a newer release than the one downloaded is the one to restart
      // into (electron/update-check.mjs)
      look: () => newestBeforeInstall(electronUpdater.autoUpdater, { waiting: updaterState.version }),
      drain: drainBeforeRestart,
      mark: () => markInstall(INSTALL_MARK_FILE(), { from: app.getVersion(), to: updaterState.version }),
      staged: nativelyStaged,
      // same teardown as a normal quit, then the installer takes over.
      // Quitting is said first: an updater may close the windows before
      // before-quit, and "Close to the tray" must not hide them then.
      quit: () => {
        quitting = true;
        return electronUpdater.autoUpdater.quitAndInstall();
      },
      // destroyed, not asked: asking is what did not work
      closeWindows: () => {
        const open = BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed());
        for (const win of open) win.destroy();
        return open.length;
      },
      // exit skips before-quit, so the server is stopped here, as it is
      // where pairing restarts the app
      teardown: () => {
        quitting = true;
        return stopAllServers();
      },
      // Not relaunched. The installer starts the new version when the
      // quit got as far as telling it to, and a copy of this one started
      // now would be running inside the app it is about to replace.
      exit: () => app.exit(0),
    },
    { log: restartLog, from: app.getVersion(), to: updaterState.version },
  ).finally(() => {
    restart = null;
  });
  return restart;
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
handle("terminal:window", (event, botId) => openTerminalWindow(botId, senderWorkspace(event) ?? shownId));
handle("quick:open-main", () => {
  quickWin?.hide();
  const [main] = BrowserWindow.getAllWindows().filter((w) => isWorkspaceWindow(w));
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
    // the hotkey is the person's, not a workspace's, so it is the one
    // Personal keeps, as it always was
    const raw = JSON.parse(fs.readFileSync(path.join(personalDataDir(), "config.json"), "utf8"));
    applyQuickShortcut(raw?.shortcuts?.quickAsk ?? null);
  } catch {
    // no config yet, which means no shortcut yet
  }
}

/** The catalogues the menus read (electron/menu-words.mjs): the
 * interface's own, carried into Resources by the packaged app. */
const LOCALES_DIR = () => (app.isPackaged ? path.join(process.resourcesPath, "locales") : path.join(HERE, "..", "src", "locales"));

/** The person's words for the main process: their choice, or the
 * system's languages under "System". */
function mainWords() {
  const code = menuLanguage(registry?.prefs?.language ?? null, app.getPreferredSystemLanguages?.() ?? [app.getLocale()]);
  return menuWords(LOCALES_DIR(), code);
}

function installAppMenu() {
  if (process.platform !== "darwin") {
    Menu.setApplicationMenu(null);
    return;
  }
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(appMenuTemplate({ name: app.name, packaged: app.isPackaged, command: menuCommand, words: mainWords() })),
  );
}

app.whenReady().then(async () => {
  if (process.platform === "darwin") app.dock.setIcon(APP_ICON);

  // The stock File/Edit/View menu says nothing this app needs: it has its
  // own right-click menu for editing, and nothing else in the bar is
  // reachable from the UI. macOS keeps a menu: the hidden-inset titlebar
  // and the platform conventions expect one, and it is the stock one with
  // Settings added (electron/app-menu.mjs).
  installAppMenu();

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
    if (remote) await startRemote(remote);
    else await openWorkspaces();
  } else if (HOSTS_SERVERS) {
    await openWorkspaces();
  }
  // again, now that the list says which language the person chose
  if (registry) installAppMenu();
  createWindow();
  // the island in the notch, once there is a workspace for it to show
  notch.sync(notchOn());
  syncTray();
  // the others come up behind the window, one at a time, so the one you
  // are looking at never waits on them
  if (registry && !remoteProfile) {
    void launchTheRest().then(() => {
      // a move the last run was carrying carries on; one about to start
      // on its own starts; and the account is asked, for the first move
      const move = moveStateNow().move;
      if (move?.phase === "running" || move?.phase === "waiting") carryMove();
      void askAccount();
      watchAccount();
    });
    // back from a checkout in the browser: the account may say Hosting now
    app.on("browser-window-focus", () => {
      const bought = moveStateNow().boughtFrom;
      if (bought && Date.now() - bought.at < 45 * 60_000) void askAccount(true);
    });
  }
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
    if (process.platform === "darwin") {
      // each download goes to the native installer the moment the updater
      // has it (nativelyStaged, above)
      autoUpdater.on("update-downloaded", () => {
        staging = true;
      });
      for (const event of ["update-downloaded", "update-not-available", "error"]) {
        nativeUpdater.on(event, () => {
          staging = false;
          stagingOver();
        });
      }
      // Said when the quit is asked for, and again once every window has
      // closed and the installer is told: a log with only the first is a
      // window that would not close.
      nativeUpdater.on("before-quit-for-update", () => restartLog("restart: the native updater is quitting to install"));
    }
    // A Finder launch sends stdout to /dev/null, so the updater writes its
    // own log. Without it a failed update leaves nothing to read afterwards.
    updaterLog = updaterLogger();
    autoUpdater.logger = updaterLog;
    // A restart into an update that came back on the version it left is
    // said once, on the update card, with what to do about it.
    notInstalled = takeInstallMark(INSTALL_MARK_FILE(), app.getVersion());
    if (notInstalled) {
      updaterLog.warn(
        `restart: the install did not take, still on ${notInstalled.from}${notInstalled.to ? `, not ${notInstalled.to}` : ""}`,
      );
      showUpdate(updaterState);
    }
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
      // nor under a restart into one, which has its own look
      if (!mayLookAgain(updaterState) || restart) return;
      autoUpdater.checkForUpdates().catch(() => {});
    }, RECHECK_UPDATES_MS).unref?.();
  }

  void restoreQuickShortcut();
  watchPower();

  app.on("activate", () => {
    // the panel is not a window worth reopening the app for, and nor is
    // a terminal on its own: the workspace is what the Dock icon opens
    const windows = BrowserWindow.getAllWindows().filter((w) => isWorkspaceWindow(w));
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

async function powerOn(port, state) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/power`, {
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

/** Every workspace's server hears it, and any one of them working keeps
 * the Mac awake: a routine in the background is work like any other.
 * A development run without servers of its own asks the one it uses. */
async function power(state) {
  const ports = HOSTS_SERVERS ? runningServers().map((run) => run.port) : [Number(process.env.BLOKS_PORT) || 8799];
  const said = await Promise.all(ports.map((port) => powerOn(port, state)));
  return { working: said.some((status) => status?.working) };
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
/** The loopback port the remote proxy stands in on. */
let remotePort = null;

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
    remotePort = proxy.port;
    return true;
  } catch (error) {
    console.error("[remote] could not start:", error?.message ?? error);
    return false;
  }
}

handle("settings:observation", (event) => nativeSettingsObservation({
  window: BrowserWindow.fromWebContents(event.sender),
  remote: Boolean(remoteProfile), shortcut: quickAccelerator, update: updaterState.state,
  media: (kind) => systemPreferences.getMediaAccessStatus?.(kind),
}));

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
  await stopAllServers();
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
  if (restart) restartLog("restart: exiting");
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
//
// Deferred, never dropped. The daemon's stop had no time limit, and one
// that never answers would mean the second quit never comes: the windows
// are closed by then, and an update's installer is left waiting for
// Bloks to go (GitHub 267). The daemon exits with this process anyway.
const STOP_BEFORE_QUIT_MS = 5_000;
let daemonStopped = false;
app.on("before-quit", (event) => {
  quitting = true;
  if (daemonStopped) return;
  event.preventDefault();
  if (restart) restartLog("restart: quit under way, stopping the server and the computer use helper");
  within(() => Promise.allSettled([stopAllServers(), stopCua()]), STOP_BEFORE_QUIT_MS).then((went) => {
    if (restart) restartLog(`restart: ${went.outcome === "late" ? "they had not stopped in time" : "they stopped"}, quitting`);
    daemonStopped = true;
    app.quit();
  });
});
