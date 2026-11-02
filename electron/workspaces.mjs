// The workspaces on this computer, and what the app remembers about each.
//
// A workspace is a whole Bloks of its own: its own data folder, agents,
// memory, keys, rooms, routines and settings. The app keeps a short list
// of them in its user data folder (workspaces.json), and this file is
// the list's rules: what an entry looks like, how one is made, renamed,
// muted and removed, and which of them may interrupt you right now.
//
// The first launch with workspaces finds no list and writes one, with
// the data folder that was always there (~/.bloks) as Personal, exactly
// where it is. Nothing is moved or rewritten to get there.
//
// Plain Node with no Electron in it, so the rules can be tested without
// starting the app (test/workspaces.test.ts). main.mjs does the rest:
// the server processes, the window and the banners.
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { defaultMark, fixedMark, generateMark, isChoosableMark, sameMark } from "./workspace-marks.mjs";

export const REGISTRY_VERSION = 1;
export const PERSONAL_ID = "personal";

export const KINDS = Object.freeze(["personal", "business", "custom", "joined", "hosted", "remote"]);

/** Kinds whose server is on another machine, reached through the remote
 * proxy (electron/remote.mjs) rather than started here: a workspace
 * somebody else owns and let you into, your own hosted one, and your own
 * on a server you run (bloks-server), as many of those as you pair. */
export const REMOTE_KINDS = Object.freeze(["joined", "hosted", "remote"]);
export const isRemoteKind = (kind) => REMOTE_KINDS.includes(kind);
export const NOTIFY_LEVELS = Object.freeze(["all", "needs-me", "nothing"]);

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** The mute menu's choices, in the order it lists them. */
export const MUTE_CHOICES = Object.freeze([
  { id: "15m", label: "For 15 minutes", ms: 15 * MINUTE },
  { id: "1h", label: "For 1 hour", ms: HOUR },
  { id: "3h", label: "For 3 hours", ms: 3 * HOUR },
  { id: "8h", label: "For 8 hours", ms: 8 * HOUR },
  { id: "24h", label: "For 24 hours", ms: 24 * HOUR },
  { id: "forever", label: "Until I turn it back on", ms: null },
]);

export const NAME_MAX = 40;

/** A name as it will be kept: one line, no runs of spaces, not too long.
 * Empty when there is nothing left of it. */
export function cleanName(name) {
  return String(name ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, NAME_MAX)
    .trim();
}

/** A person's name as the app keeps it: as a workspace's is, and without
 * the direction overrides that could restyle the line it is printed on,
 * which is the rule every server keeps for names too (server/people.ts). */
export function cleanPersonName(name) {
  return cleanName(String(name ?? "").replace(/[\u202a-\u202e\u2066-\u2069]/g, ""));
}

const kindName = (kind) => (kind === "personal" ? "Personal" : kind === "business" ? "Business" : "");

/** A new id: short, lowercase, safe as a folder name. */
export function newId(random = randomBytes) {
  return `ws_${random(6).toString("hex")}`;
}

/** An entry with every field present and sensible, whatever the file
 * said: a hand-edited or half-written registry should cost a default,
 * never the app. Null when it cannot be an entry at all. */
export function normalizeEntry(raw, index = 0) {
  if (!raw || typeof raw !== "object") return null;
  const id = typeof raw.id === "string" && /^[a-z0-9_-]{1,40}$/.test(raw.id) ? raw.id : null;
  if (!id) return null;
  const kind = KINDS.includes(raw.kind) ? raw.kind : "custom";
  const name = cleanName(raw.name) || kindName(kind) || "Workspace";
  const fixed = fixedMark(kind);
  const said = raw.mark && typeof raw.mark.color === "string" && typeof raw.mark.pattern === "string"
    ? { color: raw.mark.color, pattern: raw.mark.pattern }
    : null;
  // Personal and Business wear the mark somebody chose for them, and their
  // default until somebody does; a chosen one is held to the picker's
  // rules, so a hand-edited list cannot dress Personal in anything at all
  const mark = fixed ? (isChoosableMark(said) ? said : fixed) : said;
  const dataDir = typeof raw.dataDir === "string" && raw.dataDir ? raw.dataDir : null;
  if (!isRemoteKind(kind) && !dataDir) return null;
  const mute =
    raw.mute === "forever" ? "forever" : Number.isFinite(raw.mute) && raw.mute > 0 ? Number(raw.mute) : null;
  const entry = {
    id,
    kind,
    name,
    team: raw.team === true,
    mark,
    logo: typeof raw.logo === "string" && raw.logo ? raw.logo : null,
    dataDir,
    mute,
    notify: NOTIFY_LEVELS.includes(raw.notify) ? raw.notify : "all",
    order: Number.isFinite(raw.order) ? Number(raw.order) : index,
    port: Number.isInteger(raw.port) && raw.port > 0 && raw.port < 65536 ? raw.port : null,
    accent: typeof raw.accent === "string" && /^[A-Za-z]{1,20}$/.test(raw.accent) ? raw.accent : null,
    members: Number.isInteger(raw.members) && raw.members >= 0 ? raw.members : null,
    createdAt: Number.isFinite(raw.createdAt) ? Number(raw.createdAt) : 0,
    // a copy whose work moved to another workspace of yours (the hosted
    // one, say), kept here until you remove it: electron/hosting-move.mjs
    moved: raw.moved && typeof raw.moved.to === "string" && /^[a-z0-9_-]{1,40}$/.test(raw.moved.to)
      ? { to: raw.moved.to, at: Number.isFinite(raw.moved.at) ? Number(raw.moved.at) : 0 }
      : null,
  };
  // A workspace joined on someone else's computer opens through the
  // remote proxy (electron/remote.mjs). Its member credentials live in
  // the keychain beside remote.bin, never here; this only names them.
  if (kind === "joined") {
    const host = raw.host && typeof raw.host === "object" ? raw.host : {};
    entry.host = {
      name: typeof host.name === "string" ? host.name.slice(0, 60) : "",
      relayUrl: typeof host.relayUrl === "string" ? host.relayUrl : "",
      // where it answers on the owner's own network, for a join that never
      // touched Bloks Cloud: then that network is the only way in
      lan: typeof host.lan === "string" && /^[0-9a-zA-Z.:[\]-]{3,80}$/.test(host.lan) ? host.lan : "",
    };
    // what you are there, as its server last said: Member or Admin
    entry.role = raw.role === "admin" ? "admin" : "member";
    // The mark you chose for it, over the one its owner chose. Kept here
    // and nowhere else: its owner and the other members never see it, and
    // `mark` stays what the owner's server says, for going back to.
    entry.ownMark = isChoosableMark(raw.ownMark) ? { color: raw.ownMark.color, pattern: raw.ownMark.pattern } : null;
  }
  // Your own workspace on a machine run for you, or on a server you run,
  // reached through Bloks Cloud with a device of yours paired there.
  // Yours, so named and marked like any of your own; its credentials live
  // in the keychain like a joined one's.
  if (kind === "hosted" || kind === "remote") {
    const host = raw.host && typeof raw.host === "object" ? raw.host : {};
    entry.host = {
      name: typeof host.name === "string" ? host.name.slice(0, 60) : "",
      relayUrl: typeof host.relayUrl === "string" ? host.relayUrl : "",
      lan: "",
    };
  }
  return entry;
}

/** The registry as read from disk, or a fresh one when there is none or
 * it cannot be read. */
export function parseRegistry(text) {
  let raw = null;
  try {
    raw = text ? JSON.parse(text) : null;
  } catch {
    raw = null;
  }
  const list = Array.isArray(raw?.workspaces) ? raw.workspaces : [];
  const seen = new Set();
  const workspaces = [];
  list.forEach((item, index) => {
    const entry = normalizeEntry(item, index);
    if (!entry || seen.has(entry.id)) return;
    // one Personal and one Business: their marks are fixed, so a second
    // would wear the first one's face
    if ((entry.kind === "personal" || entry.kind === "business") && workspaces.some((w) => w.kind === entry.kind)) {
      entry.kind = "custom";
      entry.mark = null;
    }
    seen.add(entry.id);
    workspaces.push(entry);
  });
  const theme = raw?.prefs?.theme;
  const accent = raw?.prefs?.accent;
  return {
    version: REGISTRY_VERSION,
    current: typeof raw?.current === "string" ? raw.current : PERSONAL_ID,
    prefs: {
      theme: theme === "light" || theme === "dark" || theme === "system" ? theme : null,
      // "Same accent in every workspace": off unless chosen, and the one
      // accent it keeps while on
      sameAccent: raw?.prefs?.sameAccent === true,
      accent: typeof accent === "string" && ACCENT_ID.test(accent) ? accent : null,
      // "Show working agents in the notch": on unless turned off
      notch: raw?.prefs?.notch !== false,
      // "Close to the tray" (Windows): off unless turned on
      tray: raw?.prefs?.tray === true,
      // what the person is called in every workspace of their own
      ownerName: cleanPersonName(raw?.prefs?.ownerName) || null,
      // the language the interface and the menu bar are read in; none
      // is "System", whatever the OS speaks
      language: LANGUAGE_CODES.includes(raw?.prefs?.language) ? raw.prefs.language : null,
      // "Run workspaces on this computer": on unless turned off, which
      // leaves this app a window onto servers elsewhere (GitHub 428)
      local: raw?.prefs?.local !== false,
    },
    workspaces: sorted(workspaces),
  };
}

/**
 * The person's name, kept once for every workspace they own, the way the
 * theme is: one person, called the same everywhere. A workspace they
 * joined has an owner of its own, whose name it keeps in `host`.
 *
 * A seed is a name a workspace already had when its server started. It
 * is taken only while the app has none, so a workspace that was given a
 * name long ago never undoes a newer choice made in another. An empty
 * name that is not a seed is the person clearing theirs.
 */
export function keepOwnerName(registry, name, { seed = false } = {}) {
  const clean = cleanPersonName(name) || null;
  const was = registry.prefs.ownerName ?? null;
  if (seed && (was || !clean)) return { registry, changed: false };
  if (clean === was) return { registry, changed: false };
  return { registry: { ...registry, prefs: { ...registry.prefs, ownerName: clean } }, changed: true };
}

const ACCENT_ID = /^[A-Za-z]{1,20}$/;

/**
 * The accent a workspace's window draws in. Each workspace keeps its own,
 * so it can look like itself; with "Same accent in every workspace" on,
 * the one shared accent wins everywhere, and each workspace's own waits
 * underneath for the day it is turned off. Null for the page's default.
 */
export function accentOf(registry, id) {
  const own = registry.workspaces.find((w) => w.id === id)?.accent ?? null;
  return registry.prefs.sameAccent ? (registry.prefs.accent ?? own) : own;
}

/** A workspace's window chose an accent: everywhere's while the setting
 * is on, else that workspace's alone. */
export function chooseAccent(registry, id, accent) {
  if (typeof accent !== "string" || !ACCENT_ID.test(accent)) return registry;
  if (registry.prefs.sameAccent) return { ...registry, prefs: { ...registry.prefs, accent } };
  if (!registry.workspaces.some((w) => w.id === id)) return registry;
  return updateWorkspace(registry, id, { accent });
}

/**
 * Turns "Same accent in every workspace" on or off, from one workspace's
 * window, which is showing `showing`. On: what that window shows becomes
 * everyone's. Off: every workspace goes back to its own, and one that
 * never had its own keeps the shared one it was wearing. Returns the
 * registry and the accent that window should draw in now.
 */
export function setSameAccent(registry, id, on, showing) {
  const shown = typeof showing === "string" && ACCENT_ID.test(showing) ? showing : accentOf(registry, id);
  if (on) {
    const next = { ...registry, prefs: { ...registry.prefs, sameAccent: true, accent: shown ?? registry.prefs.accent } };
    return { registry: next, accent: accentOf(next, id) };
  }
  const shared = registry.prefs.accent ?? shown;
  let next = { ...registry, prefs: { ...registry.prefs, sameAccent: false } };
  if (shared) {
    next = {
      ...next,
      workspaces: next.workspaces.map((w) => (w.accent ? w : { ...w, accent: shared })),
    };
  }
  return { registry: next, accent: accentOf(next, id) };
}

/** The languages a person may choose (src/lib/i18n.ts LANGUAGES). */
export const LANGUAGE_CODES = Object.freeze(["en", "es", "fr", "de", "pt-BR", "ja", "zh-CN"]);

/** Settings, General, Language: a language's code, or "system" for none.
 * Anything else leaves the choice as it was. */
export function setLanguage(registry, language) {
  const next = language === "system" ? null : LANGUAGE_CODES.includes(language) ? language : undefined;
  if (next === undefined || (registry.prefs.language ?? null) === next) return registry;
  return { ...registry, prefs: { ...registry.prefs, language: next } };
}

// ── workspaces on servers you run ──────────────────────────────────────
// The desktop app as a client of your own servers elsewhere (GitHub 428):
// any number of them, each paired as a device of yours, named and
// switched between like the workspaces here. With "Run workspaces on this
// computer" off, the ones here are kept, folders and all, but neither
// listed nor started, so the app runs no agents of its own.

/** Whether a workspace's server is started on this computer. */
export const isLocalKind = (kind) => !isRemoteKind(kind);

/** Whether the app shows and starts workspaces on this computer. */
export const runsLocal = (registry) => registry.prefs.local !== false;

/** The workspaces the app shows and may open: all of them, or only those
 * elsewhere while nothing runs here. */
export function shownWorkspaces(registry) {
  return runsLocal(registry) ? registry.workspaces : registry.workspaces.filter((w) => isRemoteKind(w.kind));
}

/** The workspace to show when the one asked for is not shown: the first
 * one that is, Personal first while the ones here run. Null for none. */
export function fallbackWorkspace(registry, except = null) {
  const shown = shownWorkspaces(registry).filter((w) => w.id !== except);
  return (runsLocal(registry) && shown.find((w) => w.kind === "personal")) || shown[0] || null;
}

/** A name for a server not yet named: the one given, else its own, kept
 * apart from every other name here with a number. */
export function freeName(registry, wanted, self = null) {
  const base = cleanName(wanted) || "Server";
  const taken = (name) => registry.workspaces.some((w) => w.id !== self && w.name.toLowerCase() === name.toLowerCase());
  if (!taken(base)) return base;
  for (let n = 2; n < 100; n++) {
    const name = cleanName(`${base.slice(0, NAME_MAX - 4)} ${n}`);
    if (!taken(name)) return name;
  }
  return cleanName(`${base.slice(0, NAME_MAX - 7)} ${Date.now() % 1000}`);
}

/**
 * Lists a workspace on a server of yours, or points the one already
 * listed for that server at a fresh pairing. A server is known by the
 * Bloks Cloud space its pairing goes through (`relayToken`, never kept
 * here): pairing the same server again keeps its place, name and mark,
 * and pairing another adds one beside it, so neither replaces the other.
 * `same` is the id of the entry already paired with that server, which
 * the caller finds from the credentials it keeps.
 */
export function addRemote(registry, { name = "", host = "", relayUrl = "", same = null } = {}, { now = Date.now(), random = Math.random, id = newId() } = {}) {
  const hostInfo = { name: typeof host === "string" ? host.slice(0, 60) : "", relayUrl: typeof relayUrl === "string" ? relayUrl : "", lan: "" };
  const was = same ? registry.workspaces.find((w) => w.id === same && w.kind === "remote") : null;
  if (was) {
    const entry = { ...was, host: hostInfo, ...(cleanName(name) ? { name: freeName(registry, name, was.id) } : {}) };
    return { registry: { ...registry, workspaces: registry.workspaces.map((w) => (w.id === was.id ? entry : w)) }, entry, replaced: true };
  }
  const entry = normalizeEntry({
    id,
    kind: "remote",
    name: freeName(registry, name || "Server"),
    mark: generateMark(marksInUse(registry), { random }),
    notify: "all",
    order: registry.workspaces.length,
    createdAt: now,
    host: hostInfo,
  });
  return { registry: { ...registry, workspaces: [...registry.workspaces, entry] }, entry, replaced: false };
}

/** Why "Run workspaces on this computer" can't be turned off now, or null:
 * the app has to have somewhere to open. */
export function localOffRefusal(registry) {
  if (!registry.workspaces.some((w) => isRemoteKind(w.kind))) {
    return "Add a server first: with nothing running on this computer, the app opens your workspaces elsewhere.";
  }
  return null;
}

/** Turns "Run workspaces on this computer" on or off. Off moves the one
 * on screen to a workspace elsewhere; the ones here are kept as they are. */
export function setLocal(registry, on) {
  if (typeof on !== "boolean" || runsLocal(registry) === on) return registry;
  if (!on) {
    const why = localOffRefusal(registry);
    if (why) throw new Error(why);
  }
  const next = { ...registry, prefs: { ...registry.prefs, local: on } };
  const current = shownWorkspaces(next).some((w) => w.id === next.current) ? next.current : (fallbackWorkspace(next)?.id ?? next.current);
  return { ...next, current };
}

/** "Show working agents in the notch" (electron/notch.mjs), on or off.
 * Anything but a yes or a no leaves it as it was. */
export function setNotch(registry, on) {
  if (typeof on !== "boolean" || registry.prefs.notch === on) return registry;
  return { ...registry, prefs: { ...registry.prefs, notch: on } };
}

/** "Close to the tray" (electron/tray.mjs), on or off. Anything but a
 * yes or a no leaves it as it was. */
export function setTray(registry, on) {
  if (typeof on !== "boolean" || registry.prefs.tray === on) return registry;
  return { ...registry, prefs: { ...registry.prefs, tray: on } };
}

const sorted = (list) => [...list].sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);

/**
 * Makes sure the registry has its Personal workspace, and that every
 * named one wears a mark it may and that nobody else on this computer
 * wears. The first run's Personal is the folder that was always there.
 */
export function settle(registry, { personalDataDir, now = Date.now(), random = Math.random } = {}) {
  let workspaces = [...registry.workspaces];
  if (!workspaces.some((w) => w.kind === "personal")) {
    workspaces.unshift(
      normalizeEntry({ id: PERSONAL_ID, kind: "personal", name: "Personal", dataDir: personalDataDir, order: -1, createdAt: now }),
    );
  }
  const worn = [];
  workspaces = workspaces.map((w) => {
    if (w.kind === "personal" || w.kind === "business" || w.kind === "joined") {
      if (shownMark(w)) worn.push(shownMark(w));
      return w;
    }
    // a drawn mark or a chosen one, as long as nobody before it wears it
    if (isChoosableMark(w.mark) && !worn.some((m) => sameMark(m, w.mark))) {
      worn.push(w.mark);
      return w;
    }
    const mark = generateMark(worn, { random });
    worn.push(mark);
    return { ...w, mark };
  });
  workspaces = sorted(workspaces).map((w, i) => ({ ...w, order: i }));
  let next = { ...registry, workspaces };
  // nothing elsewhere to open is no way to run with nothing here
  if (!runsLocal(next) && !workspaces.some((w) => isRemoteKind(w.kind))) next = { ...next, prefs: { ...next.prefs, local: true } };
  const current = shownWorkspaces(next).some((w) => w.id === registry.current) ? registry.current : (fallbackWorkspace(next) ?? workspaces[0]).id;
  return { ...next, current };
}

/** The mark a workspace is drawn with on this computer: for one you
 * joined, the one you chose for it when you did, else its owner's. */
export function shownMark(w) {
  return (w?.kind === "joined" && w.ownMark) || w?.mark || null;
}

/** What "Back to the default" goes back to: Personal's and Business's
 * own, or a joined workspace's owner's mark; null for a named workspace,
 * whose mark was drawn for it and has no other to go back to. */
export function markDefault(w) {
  if (w?.kind === "joined") return w.mark ?? null;
  return defaultMark(w?.kind);
}

/** Every mark worn on this computer, but `except`'s. */
export function marksInUse(registry, except = null) {
  return registry.workspaces.filter((w) => w.id !== except && shownMark(w)).map((w) => shownMark(w));
}

/** A kind's default mark when nobody else here wears it, else a drawn
 * one: Personal may have chosen Business's ring, and a new Business must
 * not wear it too. */
function freshMarkFor(kind, worn, random) {
  const fixed = fixedMark(kind);
  if (fixed && !worn.some((m) => sameMark(m, fixed))) return fixed;
  return generateMark(worn, { random });
}

/** Why a new or renamed workspace cannot have this kind and name, or
 * null when it can. */
export function refusal(registry, { kind, name }, self = null) {
  if (kind !== "business" && kind !== "custom") return "A workspace is Business or has a name of its own.";
  if (kind === "business" && registry.workspaces.some((w) => w.kind === "business" && w.id !== self)) {
    return "There is a Business workspace already.";
  }
  const clean = cleanName(name);
  if (!clean) return "Give it a name.";
  const taken = registry.workspaces.some((w) => w.id !== self && w.name.toLowerCase() === clean.toLowerCase());
  if (taken) return `There is a workspace called ${clean} already.`;
  return null;
}

/**
 * A new local workspace, added to the end of the list. Its data folder
 * is under the app's own folder, by id, so a rename never moves it. The
 * mark offered (the one the dialog showed, drawn or chosen) is kept when
 * it is still free; otherwise Business wears its own and a named one has
 * one drawn for it.
 */
export function addWorkspace(registry, input, { workspacesDir, now = Date.now(), random = Math.random, id = newId() } = {}) {
  const why = refusal(registry, input);
  if (why) throw new Error(why);
  const kind = input.kind;
  const worn = marksInUse(registry);
  const offered =
    input.mark && isChoosableMark(input.mark) && !worn.some((m) => sameMark(m, input.mark))
      ? { color: input.mark.color, pattern: input.mark.pattern }
      : null;
  const mark = offered ?? freshMarkFor(kind, worn, random);
  const entry = normalizeEntry({
    id,
    kind,
    name: cleanName(input.name) || kindName(kind),
    team: input.team === true,
    mark,
    dataDir: path.join(workspacesDir, id),
    notify: "all",
    order: registry.workspaces.length,
    createdAt: now,
  });
  return { registry: { ...registry, workspaces: [...registry.workspaces, entry] }, entry };
}

/**
 * Lists your hosted workspace, or points the one listed at a fresh pairing:
 * there is one per licence, so opening it again (a new Mac, a pairing that
 * was revoked there) keeps its place, name and mark rather than adding a
 * second. Its credentials are the caller's to keep, in the keychain.
 */
export function addHosted(registry, { host = "", relayUrl = "" } = {}, { now = Date.now(), random = Math.random, id = newId() } = {}) {
  const hostInfo = { name: typeof host === "string" ? host.slice(0, 60) : "", relayUrl: typeof relayUrl === "string" ? relayUrl : "", lan: "" };
  const was = registry.workspaces.find((w) => w.kind === "hosted");
  if (was) {
    const entry = { ...was, host: hostInfo };
    return { registry: { ...registry, workspaces: registry.workspaces.map((w) => (w.id === was.id ? entry : w)) }, entry, replaced: true };
  }
  const entry = normalizeEntry({
    id,
    kind: "hosted",
    name: "Hosted",
    mark: generateMark(marksInUse(registry), { random }),
    notify: "all",
    order: registry.workspaces.length,
    createdAt: now,
    host: hostInfo,
  });
  return { registry: { ...registry, workspaces: [...registry.workspaces, entry] }, entry, replaced: false };
}

/** Changes what may change about a workspace. Personal stays Personal;
 * becoming Business takes Business's mark, and leaving Business draws a
 * named one. A mark may be chosen for any of them, and `mark: null` goes
 * back to the default, where there is one. For a workspace you joined,
 * the mark chosen is yours alone (`ownMark`), and its owner's stays. */
export function updateWorkspace(registry, id, patch, { random = Math.random } = {}) {
  const at = registry.workspaces.findIndex((w) => w.id === id);
  if (at === -1) throw new Error("There is no such workspace.");
  const was = registry.workspaces[at];
  const next = { ...was };

  if (patch.name !== undefined || patch.kind !== undefined) {
    const kind = was.kind === "personal" || isRemoteKind(was.kind) ? was.kind : (patch.kind ?? was.kind);
    const name = patch.name !== undefined ? patch.name : was.name;
    if (kind === "business" || kind === "custom") {
      const why = refusal(registry, { kind, name }, id);
      if (why) throw new Error(why);
    } else if (!cleanName(name)) {
      throw new Error("Give it a name.");
    }
    next.name = cleanName(name);
    if (kind !== was.kind) {
      next.kind = kind;
      next.mark = freshMarkFor(kind, marksInUse(registry, id), random);
    }
  }
  if (patch.team !== undefined) {
    // Personal is the person's own: a team gets a Business workspace or one
    // with its own name. One made a team before this rule can still go back.
    if (patch.team === true && was.kind === "personal" && !was.team) {
      throw new Error("Personal is yours alone. For a team, make a Business workspace or one with a name of its own.");
    }
    next.team = patch.team === true;
  }
  if (patch.notify !== undefined) {
    if (!NOTIFY_LEVELS.includes(patch.notify)) throw new Error("That is not a notification level.");
    next.notify = patch.notify;
  }
  if (patch.mute !== undefined) next.mute = patch.mute;
  if (patch.mark !== undefined) {
    const others = marksInUse(registry, id);
    if (patch.mark === null) {
      // back to the default: the kind's own, or the owner's for a joined one
      if (next.kind === "joined") next.ownMark = null;
      else {
        const back = defaultMark(next.kind);
        if (!back) throw new Error(`${next.name}'s mark was drawn for it. Choose another, or shuffle.`);
        if (others.some((m) => sameMark(m, back))) throw new Error("Another workspace has that mark.");
        next.mark = back;
      }
    } else {
      if (!isChoosableMark(patch.mark)) throw new Error("That is not a mark a workspace can have.");
      if (others.some((m) => sameMark(m, patch.mark))) throw new Error("Another workspace has that mark.");
      const chosen = { color: patch.mark.color, pattern: patch.mark.pattern };
      if (next.kind === "joined") next.ownMark = sameMark(chosen, next.mark) ? null : chosen;
      else next.mark = chosen;
    }
  }
  if (patch.logo !== undefined) next.logo = patch.logo || null;
  if (patch.port !== undefined) next.port = patch.port;
  if (patch.accent !== undefined) next.accent = patch.accent;
  if (patch.members !== undefined) next.members = Number.isInteger(patch.members) && patch.members >= 0 ? patch.members : null;
  if (patch.role !== undefined && was.kind === "joined") next.role = patch.role === "admin" ? "admin" : "member";
  // a joined workspace's owner renamed themselves, as its server says
  if (patch.hostName !== undefined && was.kind === "joined" && cleanPersonName(patch.hostName)) {
    next.host = { relayUrl: "", ...was.host, name: cleanPersonName(patch.hostName) };
  }

  const workspaces = [...registry.workspaces];
  workspaces[at] = next;
  return { ...registry, workspaces };
}

/** Marks a workspace as a copy whose work moved to workspace `to`, or,
 * with `to` null, as the live one again. */
export function markMoved(registry, id, to, now = Date.now()) {
  if (!registry.workspaces.some((w) => w.id === id)) return registry;
  return {
    ...registry,
    workspaces: registry.workspaces.map((w) => (w.id === id ? { ...w, moved: to ? { to, at: now } : null } : w)),
  };
}

/** A new drawn mark for a workspace, different from the one it shows and
 * from every other one here; for one you joined, yours alone. */
export function rerollMark(registry, id, { random = Math.random } = {}) {
  const was = registry.workspaces.find((w) => w.id === id);
  if (!was) throw new Error("There is no such workspace.");
  const mark = generateMark(marksInUse(registry, id), { random, avoid: shownMark(was) });
  return updateWorkspace(registry, id, { mark }, { random });
}

/** The list without one workspace. Never Personal: it is the folder the
 * app has always had, and the place every other one is made from. */
export function removeWorkspace(registry, id) {
  const was = registry.workspaces.find((w) => w.id === id);
  if (!was) throw new Error("There is no such workspace.");
  if (was.kind === "personal") throw new Error("Personal cannot be deleted.");
  const workspaces = registry.workspaces.filter((w) => w.id !== id).map((w, i) => ({ ...w, order: i }));
  const next = { ...registry, workspaces };
  // the last one elsewhere, while nothing runs here, would leave the app
  // nothing to open; it says so rather than quietly start one here
  if (!runsLocal(next) && !workspaces.some((w) => isRemoteKind(w.kind))) {
    throw new Error(`${was.name} is the only workspace this app opens. Turn on Run workspaces on this computer, or add another server, first.`);
  }
  const current = registry.current === id ? (fallbackWorkspace(next) ?? workspaces[0]).id : registry.current;
  return { registry: { ...next, current }, removed: was };
}

/**
 * `work` run once at a time: a call while one is under way gets that
 * one's answer rather than starting another. For making a workspace,
 * where a second press of Create used to make the first one's name look
 * taken.
 */
export function oneAtATime(work) {
  let running = null;
  return (...args) => {
    if (running) return running;
    running = Promise.resolve()
      .then(() => work(...args))
      .finally(() => {
        running = null;
      });
    return running;
  };
}

/** The list in a new order: the ids given first, in that order, then any
 * the caller did not mention, as they were. */
export function reorder(registry, ids) {
  const byId = new Map(registry.workspaces.map((w) => [w.id, w]));
  const first = ids.map((id) => byId.get(id)).filter(Boolean);
  const rest = registry.workspaces.filter((w) => !ids.includes(w.id));
  return { ...registry, workspaces: [...first, ...rest].map((w, i) => ({ ...w, order: i })) };
}

export function setCurrent(registry, id) {
  if (!registry.workspaces.some((w) => w.id === id)) throw new Error("There is no such workspace.");
  if (!shownWorkspaces(registry).some((w) => w.id === id)) {
    throw new Error("Workspaces on this computer are turned off. Turn on Run workspaces on this computer to open it.");
  }
  return { ...registry, current: id };
}

// ── mute and notifications ─────────────────────────────────────────────

/** What `mute` becomes for one of MUTE_CHOICES, or "off". */
export function muteFor(choice, now = Date.now()) {
  if (choice === "off" || choice === null) return null;
  const found = MUTE_CHOICES.find((c) => c.id === choice);
  if (!found) throw new Error("That is not a way to mute.");
  return found.ms === null ? "forever" : now + found.ms;
}

/** Whether the workspace is muted at `now`. A mute that has run out is
 * simply over: nothing has to come along and switch it off. */
export function isMuted(entry, now = Date.now()) {
  if (!entry?.mute) return false;
  return entry.mute === "forever" || entry.mute > now;
}

/** The mute as the window shows it: off, until a time, or until turned
 * back on. */
export function muteState(entry, now = Date.now()) {
  if (!isMuted(entry, now)) return { muted: false, until: null };
  return { muted: true, until: entry.mute === "forever" ? "forever" : entry.mute };
}

/** When the soonest timed mute among these runs out, so the window can be
 * told it did; null when none is timed. */
export function nextMuteEnd(entries, now = Date.now()) {
  const ends = entries.map((e) => e.mute).filter((m) => typeof m === "number" && m > now);
  return ends.length ? Math.min(...ends) : null;
}

/**
 * Whether a notice may raise a banner for this workspace. `level` is what
 * the notice is: "needs-me" for an approval or a question (something is
 * stopped until the person answers), "activity" for everything else.
 * Muted says nothing at all, whatever the level.
 */
export function allowsNotice(entry, level, now = Date.now()) {
  if (!entry || isMuted(entry, now)) return false;
  if (entry.notify === "nothing") return false;
  if (entry.notify === "needs-me") return level === "needs-me";
  return level === "needs-me" || level === "activity";
}

/** Whether the workspace's waiting count belongs on the Dock badge: the
 * badge is an interruption too, so it follows the same switch. */
export function countsOnBadge(entry, now = Date.now()) {
  return Boolean(entry) && !isMuted(entry, now) && entry.notify !== "nothing";
}

/** The Dock badge: what is waiting, summed over the workspaces that may
 * still say so. `counts` maps an id to its number. */
export function badgeTotal(entries, counts, now = Date.now()) {
  let total = 0;
  for (const entry of entries) {
    const n = Number(counts[entry.id] ?? 0);
    if (countsOnBadge(entry, now) && Number.isFinite(n) && n > 0) total += Math.floor(n);
  }
  return total;
}

/** Several servers' drain answers (server/drain.ts) read as one, for the
 * wait before an update: draining while any is, done when all are, and
 * the latest deadline. Null when none answered. */
export function mergeDrains(states) {
  const answered = states.filter(Boolean);
  if (!answered.length) return null;
  const deadlines = answered.map((s) => s.deadline).filter((d) => Number.isFinite(d));
  return {
    draining: answered.some((s) => s.draining),
    done: answered.every((s) => !s.draining || s.done),
    running: answered.flatMap((s) => (Array.isArray(s.running) ? s.running : [])),
    ...(deadlines.length ? { deadline: Math.max(...deadlines) } : {}),
  };
}

// ── on disk ────────────────────────────────────────────────────────────

export function readRegistry(file) {
  try {
    return parseRegistry(fs.readFileSync(file, "utf8"));
  } catch {
    return parseRegistry(null);
  }
}

/** Written whole and renamed into place, so a crash halfway leaves the
 * list as it was rather than half of it. */
export function writeRegistry(file, registry) {
  const staging = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.writeFileSync(staging, JSON.stringify(registry, null, 2), { mode: 0o600 });
    fs.renameSync(staging, file);
  } catch (error) {
    fs.rmSync(staging, { force: true });
    throw error;
  }
}

/** The port a workspace's own config.json chose, if it chose one. */
export function configuredPort(dataDir) {
  try {
    const port = JSON.parse(fs.readFileSync(path.join(dataDir, "config.json"), "utf8")).port;
    return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
  } catch {
    return null;
  }
}

// ── for the window ─────────────────────────────────────────────────────

/**
 * What the window is told about the workspaces: enough to draw the
 * switcher and the settings, and nothing it has no use for. `live` holds
 * what the main process knows that the list does not: each server's
 * status, what is waiting, and the logo as a data URL.
 */
export function snapshot(registry, live = {}, now = Date.now()) {
  return {
    available: true,
    current: registry.current,
    // what the person is called in their own workspaces, for a window
    // that has to ask before a Team workspace is made
    ownerName: registry.prefs.ownerName ?? null,
    // "Run workspaces on this computer": off, only those elsewhere are
    // listed, and nothing here is offered that would start one
    local: runsLocal(registry),
    workspaces: shownWorkspaces(registry).map((w) => {
      const here = live[w.id] ?? {};
      return {
        id: w.id,
        kind: w.kind,
        name: w.name,
        team: w.team,
        mark: shownMark(w),
        // what "Back to the default" would wear, for the picker to offer
        markDefault: markDefault(w),
        logo: here.logo ?? null,
        members: w.members,
        status: here.status ?? "stopped",
        problem: here.problem ?? null,
        waiting: Number(here.waiting ?? 0),
        notify: w.notify,
        mute: muteState(w, now),
        dataDir: w.dataDir,
        ...(w.kind === "joined"
          ? {
              host: w.host?.name ?? "",
              role: w.role === "admin" ? "admin" : "member",
              // reached on the owner's network alone, with no Bloks Cloud
              lanOnly: !w.host?.relayUrl && Boolean(w.host?.lan),
            }
          : {}),
        // your own, on a machine run for you or a server you run
        ...(w.kind === "hosted" ? { remote: true } : {}),
        ...(w.kind === "remote" ? { remote: true, host: w.host?.name ?? "" } : {}),
        // its work moved to the workspace named, and it is kept, paused
        ...(w.moved ? { movedTo: w.moved.to } : {}),
      };
    }),
  };
}
