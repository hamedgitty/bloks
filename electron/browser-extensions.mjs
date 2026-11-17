// Chrome extensions in the Bloks browser, and only there (GitHub 510).
//
// Electron runs a part of what Chrome offers extensions: content scripts,
// a background page or service worker, and some of the chrome.* APIs. An
// unpacked extension is loaded into one session, and each workspace's
// browser has a session of its own (partitionFor in app-browser.mjs), so
// an extension loaded there is in that workspace's browser and nowhere
// else: never the session the app's own window runs in, never another
// workspace's browser. Electron does not remember a loaded extension, so
// the list is kept beside the workspace (browser-extensions.json) and
// loaded again each time that browser is made.
//
// What is installed is a copy, taken when the owner adds it from a folder
// they picked in the system's own folder window, so a later change to
// the folder (by an agent, say) changes nothing that runs. A folder with
// a link in it is refused, as a workspace extension's is.
//
// The owner is shown what an extension is and asks for before it is
// added, and what of it will and will not work here, read from its
// manifest against what Electron supports. That list is honest rather
// than hopeful: a password manager's popup, its link to its desktop app
// (native messaging) and its toolbar button are not things this browser
// has.
//
// Plain Node and an injected session, so it can be tested outside
// Electron (test/browser-extensions.test.ts); main.mjs does the wiring.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const LIST_FILE = "browser-extensions.json";
export const COPIES_DIR = "browser-extensions";
/** At most this many in one workspace's browser. */
export const MAX_EXTENSIONS = 20;
/** A whole extension, every file together. Password managers are large. */
export const MAX_BYTES = 100 * 1024 * 1024;
export const MAX_FILES = 5_000;

/** Permissions Electron's extension support honours, as far as it goes. */
const SUPPORTED = new Set(["storage", "unlimitedStorage", "scripting", "tabs", "webRequest", "webRequestBlocking", "management"]);

/** Permissions it does not, said the way the owner would miss them. */
const UNSUPPORTED = {
  nativeMessaging: "Talking to an app on this computer (native messaging), which password managers use to unlock with their desktop app",
  activeTab: "Access granted by clicking its toolbar button, which the Bloks browser does not have",
  contextMenus: "Items in the right-click menu",
  notifications: "System notifications",
  identity: "Signing in with chrome.identity",
  cookies: "Reading and changing cookies with chrome.cookies",
  alarms: "Timers with chrome.alarms",
  declarativeNetRequest: "Blocking or changing requests with declarativeNetRequest rules",
  declarativeNetRequestWithHostAccess: "Blocking or changing requests with declarativeNetRequest rules",
  downloads: "Managing downloads",
  history: "Reading browsing history",
  bookmarks: "Bookmarks",
  sidePanel: "A side panel",
  offscreen: "Offscreen documents",
  clipboardRead: "Reading the clipboard",
  clipboardWrite: "Writing to the clipboard",
  idle: "Knowing when the computer is idle",
  privacy: "Privacy settings",
  proxy: "Proxy settings",
  webNavigation: "Following navigations with chrome.webNavigation",
  windows: "Opening and arranging windows",
  tabGroups: "Tab groups",
  sessions: "Recently closed tabs",
  debugger: "The debugger",
};

const HIDDEN = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g;
const words = (value, max) => (typeof value === "string" ? value.replace(HIDDEN, "").trim().slice(0, max) : "");

/** A __MSG_name__ in a manifest, read from its default locale. */
function localized(dir, manifest, value) {
  const m = typeof value === "string" ? /^__MSG_(\w+)__$/.exec(value) : null;
  if (!m) return value;
  const locale = typeof manifest.default_locale === "string" && /^[\w-]{2,10}$/.test(manifest.default_locale) ? manifest.default_locale : "en";
  try {
    const messages = JSON.parse(fs.readFileSync(path.join(dir, "_locales", locale, "messages.json"), "utf8"));
    const hit = Object.entries(messages).find(([key]) => key.toLowerCase() === m[1].toLowerCase());
    return typeof hit?.[1]?.message === "string" ? hit[1].message : value;
  } catch {
    return value;
  }
}

/**
 * What an unpacked extension's folder says it is: its manifest, read and
 * cut to what the owner is shown. Throws with words for a folder that is
 * not one.
 */
export function readBrowserExtension(dir) {
  let raw;
  try {
    const text = fs.readFileSync(path.join(dir, "manifest.json"), "utf8");
    if (text.length > 1024 * 1024) throw new Error("big");
    raw = JSON.parse(text.replace(/^﻿/, ""));
  } catch {
    throw new Error("That folder has no manifest.json Bloks can read. Pick the folder of an unpacked Chrome extension.");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Its manifest.json is not an object.");
  const list = (value) => (Array.isArray(value) ? value.filter((x) => typeof x === "string").map((x) => x.slice(0, 200)).slice(0, 200) : []);
  const permissions = list(raw.permissions);
  // in version 2 hosts are listed among the permissions
  const hosts = [...list(raw.host_permissions), ...permissions.filter((p) => p.includes("://") || p === "<all_urls>")];
  const contentMatches = Array.isArray(raw.content_scripts) ? raw.content_scripts.flatMap((c) => list(c?.matches)) : [];
  const background = raw.background?.service_worker ? "service worker" : raw.background?.page || raw.background?.scripts ? "page" : null;
  return {
    name: words(localized(dir, raw, raw.name), 80) || "An extension",
    version: words(raw.version, 40) || "0",
    description: words(localized(dir, raw, raw.description), 300),
    manifestVersion: raw.manifest_version === 3 ? 3 : raw.manifest_version === 2 ? 2 : null,
    permissions: permissions.filter((p) => !p.includes("://") && p !== "<all_urls>"),
    optionalPermissions: list(raw.optional_permissions),
    hosts: [...new Set([...hosts, ...contentMatches])].slice(0, 100),
    contentScripts: Array.isArray(raw.content_scripts) ? raw.content_scripts.length : 0,
    background,
    popup: Boolean(raw.action?.default_popup || raw.browser_action?.default_popup || raw.page_action?.default_popup),
    options: Boolean(raw.options_page || raw.options_ui?.page),
    devtools: Boolean(raw.devtools_page),
    commands: Boolean(raw.commands && typeof raw.commands === "object" && Object.keys(raw.commands).length),
    overrides: Boolean(raw.chrome_url_overrides),
    sidePanel: Boolean(raw.side_panel),
    externallyConnectable: Boolean(raw.externally_connectable),
  };
}

/**
 * What of it will work in the Bloks browser, and what will not, each as
 * a line the owner reads before adding it. The verdict is "works" when
 * nothing it relies on is missing, "partly" when some of it is, and
 * "unlikely" when what is missing is how it is used at all.
 */
export function compatibility(info) {
  const works = [];
  const missing = [];
  if (info.manifestVersion === null) missing.push("A manifest_version Bloks knows (2 or 3)");
  if (info.contentScripts) works.push("Its scripts on the pages it lists");
  if (info.background) works.push(info.background === "service worker" ? "Its background service worker" : "Its background page");
  for (const p of info.permissions) {
    if (SUPPORTED.has(p)) works.push(`chrome.${p === "unlimitedStorage" ? "storage" : p === "webRequestBlocking" ? "webRequest" : p}`);
    else missing.push(UNSUPPORTED[p] ?? `The ${p} permission, which Electron does not list as supported`);
  }
  if (info.popup) missing.push("Its toolbar button and popup: the Bloks browser has no toolbar for extensions");
  if (info.options) missing.push("Its options page");
  if (info.devtools) missing.push("Its developer tools panel");
  if (info.commands) missing.push("Its keyboard shortcuts");
  if (info.overrides) missing.push("Replacing the new tab or other browser pages");
  if (info.sidePanel) missing.push("Its side panel");
  if (info.externallyConnectable) missing.push("Websites talking to it directly (externally_connectable)");
  const unique = (xs) => [...new Set(xs)];
  const lost = unique(missing);
  // a popup or native messaging is how a password manager is unlocked:
  // without them it is unlikely to be of use, whatever else loads
  const popupOnly = info.popup && !info.contentScripts;
  const vital = popupOnly || (info.popup && info.permissions.includes("nativeMessaging"));
  return {
    verdict: lost.length === 0 ? "works" : vital ? "unlikely" : "partly",
    works: unique(works),
    missing: lost,
  };
}

/** The workspace's list, as saved. */
export function readList(dataDir) {
  try {
    const saved = JSON.parse(fs.readFileSync(path.join(dataDir, LIST_FILE), "utf8"));
    return Array.isArray(saved?.extensions) ? saved.extensions.filter((e) => e && typeof e.slug === "string" && typeof e.dir === "string") : [];
  } catch {
    return [];
  }
}

export function writeList(dataDir, list) {
  const file = path.join(dataDir, LIST_FILE);
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify({ extensions: list }, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
}

/** Every file in a folder, refusing links, and the folder's size. */
function walk(root) {
  let bytes = 0;
  let files = 0;
  const visit = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const st = fs.lstatSync(full);
      if (st.isSymbolicLink()) throw new Error(`${path.relative(root, full)} is a link. An extension's folder may not contain links.`);
      if (st.isDirectory()) visit(full);
      else if (st.isFile()) {
        files += 1;
        bytes += st.size;
        if (files > MAX_FILES) throw new Error(`More than ${MAX_FILES} files.`);
        if (bytes > MAX_BYTES) throw new Error("The folder is larger than 100 MB.");
      } else throw new Error(`${path.relative(root, full)} is not a plain file.`);
    }
  };
  const top = fs.lstatSync(root);
  if (top.isSymbolicLink() || !top.isDirectory()) throw new Error("That is not a folder.");
  visit(root);
  return { bytes, files };
}

/** A folder's look, for the owner, before anything is added. */
export function inspectFolder(dir) {
  const size = walk(dir);
  const info = readBrowserExtension(dir);
  return { path: dir, ...size, info, compatibility: compatibility(info) };
}

/**
 * Adds an extension from a folder: copies it beside the workspace, saves
 * it in the list switched on, and answers the entry. It is loaded by
 * loadInto, into the workspace's browser session and no other.
 */
export function addFromFolder(dataDir, dir, now = Date.now()) {
  const looked = inspectFolder(dir);
  const list = readList(dataDir);
  if (list.length >= MAX_EXTENSIONS) throw new Error(`A workspace's browser keeps at most ${MAX_EXTENSIONS} extensions.`);
  const slug = `${looked.info.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || "extension"}-${crypto.randomBytes(4).toString("hex")}`;
  const copies = path.join(dataDir, COPIES_DIR);
  fs.mkdirSync(copies, { recursive: true, mode: 0o700 });
  const target = path.join(copies, slug);
  fs.cpSync(dir, target, { recursive: true, dereference: false, verbatimSymlinks: true, errorOnExist: true, force: false });
  // the copy is walked again: a link that appeared after the look is
  // refused here, before Electron reads a byte of it
  try {
    walk(target);
  } catch (error) {
    fs.rmSync(target, { recursive: true, force: true });
    throw error;
  }
  const entry = { slug, dir: target, from: dir, name: looked.info.name, version: looked.info.version, enabled: true, addedAt: now };
  writeList(dataDir, [...list, entry]);
  return entry;
}

/** The session's extension API: session.extensions in Electron 35 and
 * later, the session itself before. */
const apiOf = (ses) => (ses?.extensions && typeof ses.extensions.loadExtension === "function" ? ses.extensions : ses);

/**
 * Loads a workspace's switched-on extensions into its browser session.
 * Each one's Electron id is noted on the entry, for switching it off
 * later. A failure is said in the log and on the entry, and the others
 * load all the same.
 */
export async function loadInto(ses, dataDir, log = () => {}) {
  const api = apiOf(ses);
  const list = readList(dataDir);
  const loaded = [];
  for (const entry of list) {
    if (!entry.enabled) continue;
    try {
      const ext = await api.loadExtension(entry.dir, { allowFileAccess: false });
      entry.extensionId = ext?.id;
      entry.problem = undefined;
      loaded.push(entry.slug);
    } catch (error) {
      entry.problem = String(error?.message ?? error).slice(0, 300);
      log(`browser extensions: ${entry.name} did not load: ${entry.problem}`);
    }
  }
  writeList(dataDir, list);
  return loaded;
}

/** Switches one on or off: loaded into, or taken out of, the session. */
export async function setEnabled(ses, dataDir, slug, enabled) {
  const list = readList(dataDir);
  const entry = list.find((e) => e.slug === slug);
  if (!entry) throw new Error("No such extension.");
  entry.enabled = Boolean(enabled);
  if (ses) {
    const api = apiOf(ses);
    if (entry.enabled) {
      try {
        const ext = await api.loadExtension(entry.dir, { allowFileAccess: false });
        entry.extensionId = ext?.id;
        entry.problem = undefined;
      } catch (error) {
        entry.problem = String(error?.message ?? error).slice(0, 300);
      }
    } else if (entry.extensionId) {
      try {
        api.removeExtension(entry.extensionId);
      } catch {
        /* already gone */
      }
    }
  }
  writeList(dataDir, list);
  return entry;
}

/** Takes one out: off the session, out of the list, its copy deleted.
 * What it kept in the browser's own storage goes with the session's data
 * for that extension, which Electron keeps by its id. */
export function removeExtension(ses, dataDir, slug) {
  const list = readList(dataDir);
  const entry = list.find((e) => e.slug === slug);
  if (!entry) throw new Error("No such extension.");
  if (ses && entry.extensionId) {
    try {
      apiOf(ses).removeExtension(entry.extensionId);
    } catch {
      /* not loaded */
    }
  }
  writeList(dataDir, list.filter((e) => e.slug !== slug));
  const copies = path.resolve(dataDir, COPIES_DIR);
  const dir = path.resolve(entry.dir);
  // only ever a copy of ours, whatever the saved list says
  if (dir.startsWith(`${copies}${path.sep}`)) fs.rmSync(dir, { recursive: true, force: true });
}

/** The list as the settings page shows it: each one's look again, from
 * its copy, so what it asks for is always what is installed. */
export function listView(dataDir) {
  return readList(dataDir).map((entry) => {
    let info = null;
    try {
      info = readBrowserExtension(entry.dir);
    } catch {
      /* its copy is gone; said as a problem */
    }
    return {
      slug: entry.slug,
      name: info?.name ?? entry.name,
      version: info?.version ?? entry.version,
      enabled: Boolean(entry.enabled),
      from: entry.from,
      addedAt: entry.addedAt,
      ...(info ? { info, compatibility: compatibility(info) } : {}),
      ...(entry.problem ? { problem: entry.problem } : !info ? { problem: "Its copy in this workspace is missing." } : {}),
    };
  });
}
