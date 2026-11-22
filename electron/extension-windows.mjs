// A Chrome extension's own pages, the owner's alone (GitHub 510).
//
// Its toolbar popup and its options page open from the extensions button
// in the Bloks browser, so a password manager can be unlocked and set up.
// Each is a window of its own in the workspace's browser session, where
// the extension runs, and never a tab: no agent's tab list names it, no
// picture of a tab shows it, no debugger is on it and no command reaches
// it. The screen's own capture is kept from it too (content protection),
// so an agent working the computer itself cannot read a vault off the
// screen. It goes only to the extension's own pages; a link out of them
// is handed back (`out`), for main.mjs to open as the person's tab in
// the Bloks browser, under that browser's rules.
//
// Electron is handed in rather than imported, so the helpers that decide
// something are tested without it (test/browser-extensions.test.ts) and
// a scratch window can run this very code.
import { isPageOf } from "./browser-extensions.mjs";

/** Chrome's own bounds for a popup, which sizes itself to its page. */
export const POPUP_MIN = 25;
export const POPUP_MAX = { width: 800, height: 600 };
/** A popup closing as its window loses the focus waits this long after
 * it is shown, for the menu it was chosen in to let the focus go. */
export const BLUR_GRACE_MS = 400;

/** A rectangle in the app's page, its own pixels, or null. */
export function anchorFrom(rect) {
  if (!rect || typeof rect !== "object") return null;
  const n = (v) => (Number.isFinite(v) ? Math.max(-20_000, Math.min(20_000, Number(v))) : NaN);
  const out = { x: n(rect.x), y: n(rect.y), width: n(rect.width), height: n(rect.height) };
  return Object.values(out).some(Number.isNaN) ? null : out;
}

/** The size a popup's page asked for, within Chrome's bounds. */
export function popupSize(size) {
  const clamp = (value, max) => Math.max(POPUP_MIN, Math.min(max, Math.ceil(Number(value) || 0)));
  return { width: clamp(size?.width, POPUP_MAX.width), height: clamp(size?.height, POPUP_MAX.height) };
}

/**
 * Where a popup goes on screen: under the button it came from, its right
 * edge at the button's, as Chrome's sits under its toolbar icon, and
 * kept on the screen. `anchor` is in the page's pixels, `zoom` the
 * page's zoom, `content` the window's content on screen, `size` the
 * popup's, `area` the screen's usable part.
 */
export function popupPosition({ anchor, zoom = 1, content, size, area }) {
  const right = content.x + Math.round((anchor.x + anchor.width) * zoom);
  const top = content.y + Math.round((anchor.y + anchor.height) * zoom) + 4;
  return {
    x: Math.max(area.x, Math.min(right - size.width, area.x + area.width - size.width)),
    y: Math.max(area.y, Math.min(top, area.y + area.height - size.height)),
  };
}

/** The window for one of an extension's pages: in the workspace's
 * browser session, sandboxed, with no preload of ours at all. */
export function windowOptions({ page, partition, title, parent }) {
  const popup = page === "popup";
  return {
    ...(popup
      ? {
          width: 360,
          height: 480,
          frame: false,
          resizable: false,
          minimizable: false,
          maximizable: false,
          fullscreenable: false,
          skipTaskbar: true,
          // over the window it was opened from, and moving with it
          ...(parent ? { parent } : {}),
        }
      : { width: 900, height: 680, minWidth: 420, minHeight: 320, title }),
    show: false,
    backgroundColor: "#ffffff",
    webPreferences: {
      partition,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      sandbox: true,
      webviewTag: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      // a popup is as big as its page wants, within Chrome's bounds
      ...(popup ? { enablePreferredSizeMode: true } : {}),
    },
  };
}

/** Where an extension's window may go: its own pages, and nowhere else.
 * Anything else it tries to open or go to is handed to `out`. */
export function guardExtensionWindow(wc, extensionId, out = () => {}) {
  wc.on("will-navigate", (event) => {
    if (isPageOf(event.url, extensionId)) return;
    event.preventDefault();
    out(event.url);
  });
  wc.on("will-redirect", (event) => {
    if (event.isMainFrame && !isPageOf(event.url, extensionId)) event.preventDefault();
  });
  wc.setWindowOpenHandler(({ url }) => {
    if (!isPageOf(url, extensionId)) out(url);
    return { action: "deny" };
  });
  wc.on("will-attach-webview", (event) => event.preventDefault());
}

/**
 * Opens one of an extension's pages in a window of its own and answers
 * the window once its page has loaded. `BrowserWindow` and `screen` are
 * Electron's; `parent` the window it was opened from; `url` the page,
 * already checked to be the extension's own (pageUrl); `made` hears of
 * the window as soon as it is there, before its page loads.
 */
export async function openExtensionWindow({ BrowserWindow, screen, parent, page, partition, title, url, extensionId, anchor, out, made = () => {}, now = Date.now }) {
  const popup = page === "popup";
  const owner = parent && !parent.isDestroyed() ? parent : null;
  const win = new BrowserWindow(windowOptions({ page, partition, title, parent: owner }));
  win.setContentProtection(true);
  guardExtensionWindow(win.webContents, extensionId, out);
  made(win);
  if (popup) {
    const at = anchorFrom(anchor);
    const place = () => {
      if (win.isDestroyed() || !owner || owner.isDestroyed() || !at) return;
      const [width, height] = win.getSize();
      const content = owner.getContentBounds();
      const guess = { x: content.x + Math.round(at.x), y: content.y + Math.round(at.y), width, height };
      const area = screen.getDisplayMatching(guess).workArea;
      const { x, y } = popupPosition({ anchor: at, zoom: owner.webContents.getZoomFactor?.() ?? 1, content, size: { width, height }, area });
      win.setPosition(x, y);
    };
    place();
    win.webContents.on("preferred-size-changed", (_event, size) => {
      if (win.isDestroyed()) return;
      const fit = popupSize(size);
      win.setContentSize(fit.width, fit.height);
      place();
    });
    // and gone once the person is elsewhere, as Chrome's popup is; not in
    // the moment it takes the focus from the menu it was chosen in
    let shownAt = Infinity;
    win.once("show", () => (shownAt = now()));
    win.on("blur", () => {
      if (now() - shownAt > BLUR_GRACE_MS && !win.isDestroyed()) win.close();
    });
  }
  win.once("ready-to-show", () => {
    if (win.isDestroyed()) return;
    win.show();
    win.focus();
  });
  try {
    await win.loadURL(url);
  } catch (error) {
    if (!win.isDestroyed()) win.close();
    throw new Error(`${title}'s ${popup ? "popup" : "options page"} did not open: ${error?.message ?? error}`);
  }
  return win;
}
