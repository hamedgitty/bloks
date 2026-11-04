// ⌘Q on a Mac, held or pressed twice.
//
// Bloks on a Mac is where the agents and the routines run, and one stray
// ⌘Q, reaching for ⌘W or ⌘A, stopped all of them. So in a Bloks window
// the first press only says how to quit, in a small hint over the
// window, and Bloks quits on a hold of about a second or a second press
// soon after. Every other way out (Quit in the menu with the mouse, the
// Dock, an update, the system logging out or shutting down) quits at
// once, as it always has, and so does ⌘Q with the setting off
// ("Hold ⌘Q to quit", kept with the theme in electron/workspaces.mjs).
//
// The keys are heard in every page's before-input-event, where they can
// be kept from the menu, and the menu's own Quit hears an accelerator
// that got past them anyway (electron/app-menu.mjs). One physical press
// can reach both, so a press the guard is already holding is not
// counted twice.
//
// A Mac often keeps a key's release from the page while ⌘ is down, so a
// release is whichever comes first: Q up, ⌘ up, the window losing focus,
// or another key. And Bloks goes only once the keys are up, or the
// repeats of a held ⌘Q would land on whichever app comes forward next
// and quit that too.
//
// No Electron in the state machine, the page or the placing, so a test
// can drive them with a clock of its own.

/** How long ⌘Q is held before it quits. */
export const HOLD_MS = 1000;
/** How soon after a release a second press still counts. */
export const AGAIN_MS = 600;
/** How long the hint stays after a release, so it can be read. */
export const LINGER_MS = 1600;
/** The longest Bloks waits for the keys to come up before it goes. */
export const LEAVE_MAX_MS = 3000;
/** The hint's fade, which the window outlives before it hides. */
export const FADE_MS = 180;
/** The hint's window: room for the longest translation on one line. */
export const HINT_SIZE = Object.freeze({ width: 560, height: 96 });

/**
 * Whether a key is ⌘Q and nothing else. The letter decides, as it does
 * for the menu, so ⌘Q on an AZERTY keyboard is the key marked Q. On a
 * layout with no Latin letters a Mac still takes ⌘ with the key in Q's
 * place as ⌘Q, and so does this.
 */
export function isQuitKey(input) {
  if (!input || !input.meta || input.control || input.alt || input.shift) return false;
  const key = typeof input.key === "string" ? input.key.toLowerCase() : "";
  if (key === "q") return true;
  return input.code === "KeyQ" && !/^[a-z]$/.test(key);
}

/** Whether a key coming up ends a ⌘Q being held: the Q, or the ⌘. */
export function endsQuitKey(input) {
  if (!input) return false;
  const key = typeof input.key === "string" ? input.key.toLowerCase() : "";
  if (key === "meta" || key === "q") return true;
  return input.code === "KeyQ" && !/^[a-z]$/.test(key);
}

/**
 * The guard. `quit()` is the real quit; `hint(phase)` shows the hint at
 * "holding" (a press is down), "armed" (released, a second press would
 * quit) or "leaving" (quitting once the keys are up), and takes it down
 * at null. `later` and `cancel` are the clock.
 */
export function createQuitGuard({
  quit,
  hint = () => {},
  later = (fn, ms) => setTimeout(fn, ms),
  cancel = (timer) => clearTimeout(timer),
  holdMs = HOLD_MS,
  againMs = AGAIN_MS,
  lingerMs = LINGER_MS,
  leaveMaxMs = LEAVE_MAX_MS,
}) {
  /** "idle", "holding", "armed", "leaving", or "gone" once quit. */
  let state = "idle";
  let timer = null;
  let fading = null;

  const stop = () => {
    if (timer !== null) cancel(timer);
    timer = null;
  };
  const say = (phase) => {
    if (fading !== null) cancel(fading);
    fading = null;
    hint(phase);
  };
  const go = () => {
    if (state === "gone") return;
    stop();
    state = "gone";
    say(null);
    quit();
  };
  // a press that counts: Bloks goes as soon as its keys are up
  const leave = (keyDown) => {
    stop();
    state = "leaving";
    if (!keyDown) return go();
    say("leaving");
    timer = later(go, leaveMaxMs);
  };
  // released in time: a second press quits, and the hint stays to be read
  const arm = () => {
    stop();
    state = "armed";
    say("armed");
    fading = later(() => {
      fading = null;
      hint(null);
    }, lingerMs);
    timer = later(() => {
      timer = null;
      if (state === "armed") state = "idle";
    }, againMs);
  };

  return {
    get state() {
      return state;
    },
    /**
     * ⌘Q went down in a Bloks window. True when the guard took it, and
     * the page and the menu should not hear it.
     */
    press({ repeat = false } = {}) {
      if (state === "gone") return true;
      // A repeat is a key already held. With nothing under way it was
      // held before this window had the keyboard: an app in front quit
      // on it and Bloks came forward. It is that app's ⌘Q, not a press.
      if (repeat) return true;
      if (state === "idle") {
        state = "holding";
        say("holding");
        timer = later(() => leave(true), holdMs);
        return true;
      }
      // the second press, whether or not the first one's release was heard
      if (state === "holding" || state === "armed") leave(true);
      return true;
    },
    /** A key came up. */
    release(input) {
      if (!endsQuitKey(input)) return;
      if (state === "holding") arm();
      else if (state === "leaving") go();
    },
    /** Any other key went down: whoever was holding ⌘Q has moved on. */
    other(input) {
      if (state !== "holding") return;
      const key = typeof input?.key === "string" ? input.key : "";
      // ⌘ itself, or another modifier, says nothing about the Q
      if (["Meta", "Shift", "Alt", "Control", "CapsLock", "Fn"].includes(key)) return;
      arm();
    },
    /** The window lost the keyboard, and with it every release to come. */
    blur() {
      if (state === "holding") arm();
      else if (state === "leaving") go();
    },
    /**
     * The menu's Quit, from its key, in a Bloks window. Heard when a
     * page did not keep the keys from the menu; a press already under
     * way is the same press.
     */
    menu() {
      if (state === "gone" || state === "holding" || state === "leaving") return;
      if (state === "armed") return leave(false);
      // No release will be heard for this one, so it cannot be held:
      // a second press is the way.
      arm();
    },
    /** The setting went off, or the window went: nothing under way. */
    reset() {
      if (state === "gone") return;
      stop();
      state = "idle";
      say(null);
    },
  };
}

/** Where the hint's window goes: the middle of the window it is over. */
export function hintBounds(over, size = HINT_SIZE) {
  return {
    x: Math.round(over.x + (over.width - size.width) / 2),
    y: Math.round(over.y + (over.height - size.height) / 2),
    width: size.width,
    height: size.height,
  };
}

const escape = (text) =>
  String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/**
 * The hint's page. Its colours are the app's popover in either theme
 * (src/styles.css), written out because this page is not the app's: it
 * shows over any window, the opening page and a terminal's included,
 * and over a workspace whose page comes from another version of Bloks.
 * The line under the words fills while ⌘Q is held. `phase(p)` moves it
 * between the guard's phases.
 */
export function quitHintPage({ text, dark = false, holdMs = HOLD_MS, fadeMs = FADE_MS }) {
  const fill = dark ? "#1a1a1e" : "#ffffff";
  const ink = dark ? "#ededf0" : "#18181b";
  const edge = dark ? "rgba(255,255,255,0.09)" : "rgba(18,18,21,0.09)";
  const track = dark ? "rgba(255,255,255,0.12)" : "rgba(18,18,21,0.1)";
  const shadow = dark ? "rgba(0,0,0,0.5)" : "rgba(0,0,0,0.18)";
  const page =
    `<!doctype html><html><head><meta charset="utf-8"><style>` +
    `html,body{margin:0;height:100%;background:transparent;overflow:hidden;-webkit-user-select:none;cursor:default}` +
    `body{display:flex;align-items:center;justify-content:center;font:500 14px/1.35 "Inter Variable","Inter",-apple-system,BlinkMacSystemFont,system-ui,sans-serif;-webkit-font-smoothing:antialiased}` +
    `.hint{position:relative;max-width:520px;padding:11px 18px 13px;border-radius:14px;background:${fill};color:${ink};` +
    `box-shadow:0 0 0 1px ${edge},0 12px 32px -8px ${shadow};opacity:0;transform:scale(.97);transition:opacity ${fadeMs}ms ease-out,transform ${fadeMs}ms ease-out;overflow:hidden;text-align:center}` +
    `body:not([data-phase=""]) .hint{opacity:1;transform:none}` +
    `.bar{position:absolute;left:18px;right:18px;bottom:6px;height:2px;border-radius:2px;background:${track};overflow:hidden}` +
    `.bar i{display:block;height:100%;width:100%;background:${ink};transform:scaleX(0);transform-origin:left;transition:transform 120ms ease-out}` +
    `body[data-phase=holding] .bar i{transform:scaleX(1);transition:transform ${holdMs}ms linear}` +
    `body[data-phase=leaving] .bar i{transform:scaleX(1);transition:none}` +
    `@media (prefers-reduced-motion:reduce){.hint,.bar i{transition:none!important}}` +
    `</style></head><body data-phase=""><div class="hint" role="status">${escape(text)}<span class="bar" aria-hidden="true"><i></i></span></div>` +
    // a phase set twice in a row restarts the fill, as a fresh press should
    `<script>window.phase=function(p){var b=document.body;if(p==="holding"&&b.dataset.phase==="holding"){b.dataset.phase="armed";void b.offsetWidth}b.dataset.phase=p||""}</script>` +
    `</body></html>`;
  return "data:text/html;charset=utf-8," + encodeURIComponent(page);
}

/**
 * The hint's window, made the first time it is wanted and kept for the
 * next. A panel that never takes the keyboard or the mouse, so the
 * window under it keeps hearing the keys the guard waits for. `over()`
 * is the window in front, `words()` the hint in the person's language,
 * `dark()` whether to draw it dark.
 */
export function createQuitHint({ BrowserWindow, over, words, dark, holdMs = HOLD_MS, later = (fn, ms) => setTimeout(fn, ms), cancel = (t) => clearTimeout(t) }) {
  let win = null;
  let loaded = "";
  let hiding = null;
  let ready = Promise.resolve();

  const make = () => {
    win = new BrowserWindow({
      ...HINT_SIZE,
      type: "panel",
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      focusable: false,
      skipTaskbar: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        nodeIntegrationInSubFrames: false,
        sandbox: true,
        webviewTag: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        experimentalFeatures: false,
        backgroundThrottling: false,
      },
    });
    // over a full-screen window too, and never in the way of a click
    win.setAlwaysOnTop(true, "floating");
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    win.setIgnoreMouseEvents(true);
    win.on("closed", () => {
      win = null;
      loaded = "";
    });
  };

  const phase = (p) => {
    if (!win || win.isDestroyed()) return;
    void ready.then(() => win && !win.isDestroyed() && win.webContents.executeJavaScript(`window.phase(${JSON.stringify(p)})`).catch(() => {}));
  };

  return {
    show(p) {
      const front = over();
      if (hiding !== null) cancel(hiding);
      hiding = null;
      if (!p) {
        phase("");
        // the fade, then out of the way
        hiding = later(() => {
          hiding = null;
          if (win && !win.isDestroyed()) win.hide();
        }, FADE_MS + 40);
        return;
      }
      if (!front) return;
      if (!win || win.isDestroyed()) make();
      // the page again when the language or the theme changed
      const url = quitHintPage({ text: words(), dark: dark(), holdMs });
      if (url !== loaded) {
        loaded = url;
        ready = win.loadURL(url).catch(() => {});
      }
      win.setBounds(hintBounds(front.getBounds()));
      if (!win.isVisible()) win.showInactive();
      phase(p);
    },
    /** For the tests and for quitting: the window, while there is one. */
    window: () => (win && !win.isDestroyed() ? win : null),
  };
}
