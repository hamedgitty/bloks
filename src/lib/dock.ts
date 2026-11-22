// The side dock: one column on the conversation's right that holds every
// panel the app keeps beside a chat (GitHub 509, 522, 523).
//
// Before it, each panel took the right side for itself: the browser one
// column, a terminal moved to the right another, the computer a third at
// the window's edge and a turn's timeline a fourth, each with its own edge
// to drag, and two of them open at once left the chat a sliver. Now there
// is one column, one edge and one width, and a small ribbon of icons at
// its top says which panel it shows.
//
// What is remembered, and where:
//
//   per conversation   whether the dock is open, which panel it shows, and
//                      the documents open in it, so going back to a chat
//                      finds its references where they were. A room is
//                      one conversation for this.
//   per device         the dock's width, as the sidebar's is: how much of
//                      the window it should take depends on the screen.
//
// Panels a conversation cannot have (a browser on a phone looking at the
// Mac, a terminal in a room) are not this file's business: the dock is
// told which it offers and shows only those. Nothing here opens the dock
// by itself; something the person did asks for it, or an agent starting
// to use its browser or its computer in a chat does, by one rule
// (mayReveal below), and a room never opens it on its own. The terminal
// is never opened for an agent: its shells are the person's, and an
// agent's commands do not run in them.
//
// No React and no page in the part the tests read; the store and the hook
// are at the end.
import { useSyncExternalStore } from "react";

export type DockPanel = "docs" | "browser" | "terminal" | "computer" | "trace" | "topic" | "extensions";

/** The order the ribbon lists panels in, whichever are offered. */
// "extensions" holds every running workspace extension's panels, as tabs
// of its own (src/components/extensions/ExtensionDock.tsx, GitHub 507).
export const DOCK_PANELS: readonly DockPanel[] = ["topic", "docs", "browser", "terminal", "computer", "trace", "extensions"];

/** A file open in the dock: an agent's shared file, by its name. */
export interface DockDoc {
  /** botId and name, which is what makes two the same file. */
  id: string;
  botId: string;
  name: string;
  mime: string;
  size: number;
}

export interface DockPlace {
  open: boolean;
  /** The panel shown, or last shown before the dock was closed. */
  panel: DockPanel | null;
  docs: DockDoc[];
  /** The document in front, among `docs`. */
  doc: string | null;
  /** When it was last touched, so the oldest are forgotten first. */
  at: number;
}

export interface DockState {
  places: Record<string, DockPlace>;
  width: number;
}

/** Most documents one conversation keeps open; the oldest behind the one
 * in front go first. */
export const MAX_DOCS = 8;
/** Most conversations remembered; the least recently touched go first. */
export const MAX_PLACES = 60;

/** The dock's width, kept usable on both sides of its edge: the browser
 * and the computer need about this much, and the chat keeps the rest. */
export const DOCK_SIZE = { min: 360, chat: 380, fallback: 480 } as const;
/** Below this the chat and the dock cannot share the row, and the dock
 * covers the chat until it is closed. */
export const DOCK_SIDE_BY_SIDE = DOCK_SIZE.min + DOCK_SIZE.chat;

export function clampDockWidth(width: number, room: number): number {
  const max = Math.max(DOCK_SIZE.min, room - DOCK_SIZE.chat);
  return Math.round(Math.min(max, Math.max(DOCK_SIZE.min, Number.isFinite(width) ? width : DOCK_SIZE.fallback)));
}

export const EMPTY_PLACE: DockPlace = { open: false, panel: null, docs: [], doc: null, at: 0 };

export const docId = (botId: string, name: string) => `${botId}/${name}`;

/** The key a conversation is remembered by. */
export const chatKey = (botId: string, laneId: string) => `chat:${botId}:${laneId}`;
export const roomKey = (roomId: string) => `room:${roomId}`;
export const isRoomKey = (key: string) => key.startsWith("room:");

export function placeIn(state: DockState, key: string): DockPlace {
  return state.places[key] ?? EMPTY_PLACE;
}

function withPlace(state: DockState, key: string, change: (place: DockPlace) => DockPlace, now: number): DockState {
  const next = { ...change(placeIn(state, key)), at: now };
  return { ...state, places: forgetOldest({ ...state.places, [key]: next }) };
}

/** The places past the cap, least recently touched first, forgotten. */
function forgetOldest(places: Record<string, DockPlace>): Record<string, DockPlace> {
  const keys = Object.keys(places);
  if (keys.length <= MAX_PLACES) return places;
  const kept = keys.sort((a, b) => places[b].at - places[a].at).slice(0, MAX_PLACES);
  return Object.fromEntries(kept.map((k) => [k, places[k]]));
}

/** Open on a panel. Asking again for the one shown keeps it shown: the
 * ribbon picks a panel, it does not close the dock (the X does). */
export function showPanel(state: DockState, key: string, panel: DockPanel, now = Date.now()): DockState {
  return withPlace(state, key, (p) => ({ ...p, open: true, panel }), now);
}

/** Closed, with everything in it kept for when it opens again. */
export function hideDock(state: DockState, key: string, now = Date.now()): DockState {
  if (!placeIn(state, key).open) return state;
  return withPlace(state, key, (p) => ({ ...p, open: false }), now);
}

/** The header's toggle: closed opens on the panel last shown (or the
 * first offered), open closes. */
export function toggleDock(state: DockState, key: string, offered: readonly DockPanel[], now = Date.now()): DockState {
  const place = placeIn(state, key);
  if (place.open) return hideDock(state, key, now);
  const panel = place.panel && offered.includes(place.panel) ? place.panel : pickPanel(place, offered);
  return panel ? showPanel(state, key, panel, now) : state;
}

/** What to show when nothing says: open documents first, then the first
 * panel offered. */
export function pickPanel(place: DockPlace, offered: readonly DockPanel[]): DockPanel | null {
  if (place.docs.length && offered.includes("docs")) return "docs";
  return DOCK_PANELS.find((p) => p !== "docs" && offered.includes(p)) ?? (offered.includes("docs") ? "docs" : null);
}

/** A panel that went away (a terminal moved out of the dock): if it was
 * the one shown, the dock closes rather than showing something else the
 * person did not ask for. */
export function dropPanel(state: DockState, key: string, panel: DockPanel, now = Date.now()): DockState {
  const place = placeIn(state, key);
  if (place.panel !== panel) return state;
  return withPlace(state, key, (p) => ({ ...p, open: false, panel: null }), now);
}

// ── opened by an agent's work ──────────────────────────────────────────

/** Room enough for the chat, the dock and the sidebar beside them: below
 * it the dock would cover the chat, so an agent's work never opens it. */
export const REVEAL_WIDTH = DOCK_SIDE_BY_SIDE + 240;

/**
 * Whether an agent starting to use a panel (its browser or its computer)
 * opens the dock on it, by itself. One rule for both:
 *
 *   - only in a chat: in a room several agents at once would pull it back
 *     and forth;
 *   - only where the chat keeps its room beside the dock;
 *   - never while the person is typing into what the dock already shows
 *     (the address bar, a shell): the panel would go from under the keys;
 *   - never again in a conversation where the person put away a panel an
 *     agent's work had opened, until they open it there themselves: one
 *     no is enough.
 *
 * Opening never moves the keyboard either: neither panel takes focus when
 * it is shown.
 */
export function mayReveal(
  key: string | null,
  place: DockPlace,
  panel: DockPanel,
  room: { width: number; typingInDock: boolean; declined?: boolean },
): boolean {
  if (!key || isRoomKey(key)) return false;
  if (room.width < REVEAL_WIDTH || room.declined) return false;
  if (place.open && place.panel === panel) return false;
  return !(place.open && room.typingInDock);
}

/** A file opened in the dock: in front if it is open already, else added
 * and put in front, the oldest behind it dropped past the cap. */
export function openDoc(state: DockState, key: string, doc: Omit<DockDoc, "id">, now = Date.now()): DockState {
  const id = docId(doc.botId, doc.name);
  return withPlace(
    state,
    key,
    (p) => {
      const known = p.docs.find((d) => d.id === id);
      const docs = known ? p.docs.map((d) => (d.id === id ? { ...d, ...doc, id } : d)) : [...p.docs, { ...doc, id }];
      return { ...p, open: true, panel: "docs", docs: docs.length > MAX_DOCS ? docs.slice(docs.length - MAX_DOCS) : docs, doc: id };
    },
    now,
  );
}

export function selectDoc(state: DockState, key: string, id: string, now = Date.now()): DockState {
  if (!placeIn(state, key).docs.some((d) => d.id === id)) return state;
  return withPlace(state, key, (p) => ({ ...p, doc: id }), now);
}

/** A file closed: the one beside it comes to the front, and closing the
 * last one closes the dock if documents were what it showed. */
export function closeDoc(state: DockState, key: string, id: string, now = Date.now()): DockState {
  const place = placeIn(state, key);
  const at = place.docs.findIndex((d) => d.id === id);
  if (at < 0) return state;
  const docs = place.docs.filter((d) => d.id !== id);
  const doc = place.doc === id ? (docs[Math.min(at, docs.length - 1)]?.id ?? null) : place.doc;
  const empty = docs.length === 0 && place.panel === "docs";
  return withPlace(state, key, (p) => ({ ...p, docs, doc, ...(empty ? { open: false, panel: null } : {}) }), now);
}

// ── kept on this device ────────────────────────────────────────────────

export const DOCK_KEY = "bloks-dock";
export const DOCK_WIDTH_KEY = "bloks-dock-width";
/** The browser's own width, from before the dock: the dock opens at it
 * the first time, so a browser someone had sized stays that size. */
export const LEGACY_BROWSER_WIDTH_KEY = "bloks-browser-width";

type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;

const PANEL_SET = new Set<string>(DOCK_PANELS);

function cleanDoc(raw: unknown): DockDoc | null {
  if (!raw || typeof raw !== "object") return null;
  const d = raw as Record<string, unknown>;
  if (typeof d.botId !== "string" || typeof d.name !== "string" || !d.botId || !d.name) return null;
  return {
    id: docId(d.botId, d.name),
    botId: d.botId,
    name: d.name,
    mime: typeof d.mime === "string" ? d.mime : "",
    size: typeof d.size === "number" && Number.isFinite(d.size) ? d.size : 0,
  };
}

/** What was stored, or nothing for anything in it that is not a place. */
export function parseDock(raw: string | null, width: string | null, legacyWidth: string | null = null): DockState {
  let saved: Record<string, unknown> = {};
  try {
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) saved = parsed;
  } catch {
    /* unreadable: nothing remembered */
  }
  const places: Record<string, DockPlace> = {};
  for (const [key, value] of Object.entries(saved)) {
    if (!value || typeof value !== "object") continue;
    const v = value as Record<string, unknown>;
    const docs = (Array.isArray(v.docs) ? v.docs : []).map(cleanDoc).filter((d): d is DockDoc => d !== null).slice(-MAX_DOCS);
    const panel = typeof v.panel === "string" && PANEL_SET.has(v.panel) ? (v.panel as DockPanel) : null;
    const doc = typeof v.doc === "string" && docs.some((d) => d.id === v.doc) ? v.doc : (docs[docs.length - 1]?.id ?? null);
    places[key] = { open: v.open === true && panel !== null, panel, docs, doc, at: typeof v.at === "number" ? v.at : 0 };
  }
  const n = Number(width ?? legacyWidth);
  return { places: forgetOldest(places), width: Number.isFinite(n) && n > 0 ? n : DOCK_SIZE.fallback };
}

export function saveDock(storage: Storage | undefined, state: DockState): void {
  try {
    storage?.setItem(DOCK_KEY, JSON.stringify(state.places));
    storage?.setItem(DOCK_WIDTH_KEY, String(Math.round(state.width)));
  } catch {
    /* storage refused: the dock still works for this window */
  }
}

// ── the store ──────────────────────────────────────────────────────────

const local = (): Storage | undefined => (typeof localStorage === "undefined" ? undefined : localStorage);

function load(): DockState {
  const storage = local();
  try {
    return parseDock(storage?.getItem(DOCK_KEY) ?? null, storage?.getItem(DOCK_WIDTH_KEY) ?? null, storage?.getItem(LEGACY_BROWSER_WIDTH_KEY) ?? null);
  } catch {
    return { places: {}, width: DOCK_SIZE.fallback };
  }
}

let state: DockState | null = null;
/** The conversation on screen, which a panel asked for from outside a
 * conversation (the browser, from a link) opens in. */
let current: string | null = null;
const listeners = new Set<() => void>();

const read = (): DockState => (state ??= load());

function commit(next: DockState) {
  if (next === state) return;
  state = next;
  saveDock(local(), next);
  for (const listener of listeners) listener();
}

/** The keyboard is in a field of the dock (marked data-side-dock), or in a
 * terminal's screen there, which xterm reads through a textarea. */
function typingInDock(): boolean {
  if (typeof document === "undefined") return false;
  const el = document.activeElement as HTMLElement | null;
  if (!el?.closest?.("[data-side-dock]")) return false;
  return el.isContentEditable || el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT";
}

// What an agent's work opened and is still on screen, and what the person
// put away after it did, by conversation. For this window only: a new
// day, or a restart, asks again.
const revealed = new Map<string, DockPanel>();
const declined = new Map<string, Set<DockPanel>>();

/** The person did something to the dock of this conversation: if what an
 * agent's work opened is going out of sight, that is a no to it. */
function byHand(key: string, next: { open: boolean; panel: DockPanel | null }) {
  const opened = revealed.get(key);
  if (next.open && next.panel) declined.get(key)?.delete(next.panel);
  if (!opened) return;
  if (!next.open || next.panel !== opened) {
    revealed.delete(key);
    declined.set(key, (declined.get(key) ?? new Set()).add(opened));
  }
}

export const dock = {
  get: read,
  current: () => current,
  /** An agent started using a panel in the conversation on screen: shown
   * there if mayReveal says so. Says whether it was. */
  reveal(panel: DockPanel, width = typeof window === "undefined" ? 0 : window.innerWidth): boolean {
    const key = current;
    if (!key) return false;
    const room = { width, typingInDock: typingInDock(), declined: Boolean(declined.get(key)?.has(panel)) };
    if (!mayReveal(key, placeIn(read(), key), panel, room)) return false;
    commit(showPanel(read(), key, panel));
    revealed.set(key, panel);
    return true;
  },
  /** Said by the conversation on screen as it draws. */
  setCurrent(key: string) {
    if (current === key) return;
    current = key;
    for (const listener of listeners) listener();
  },
  show: (key: string, panel: DockPanel) => {
    byHand(key, { open: true, panel });
    commit(showPanel(read(), key, panel));
  },
  hide: (key: string) => {
    byHand(key, { open: false, panel: null });
    commit(hideDock(read(), key));
  },
  toggle: (key: string, offered: readonly DockPanel[]) => {
    const next = placeIn(toggleDock(read(), key, offered), key);
    byHand(key, { open: next.open, panel: next.panel });
    commit(toggleDock(read(), key, offered));
  },
  drop: (key: string, panel: DockPanel) => {
    if (placeIn(read(), key).panel === panel) byHand(key, { open: false, panel: null });
    commit(dropPanel(read(), key, panel));
  },
  openDoc: (key: string, doc: Omit<DockDoc, "id">) => {
    byHand(key, { open: true, panel: "docs" });
    commit(openDoc(read(), key, doc));
  },
  selectDoc: (key: string, id: string) => commit(selectDoc(read(), key, id)),
  closeDoc: (key: string, id: string) => commit(closeDoc(read(), key, id)),
  setWidth: (width: number) => commit({ ...read(), width }),
};

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The whole dock state, for the dock itself. */
export function useDockState(): DockState {
  return useSyncExternalStore(subscribe, read, read);
}

/** The conversation on screen's key, or null before one has drawn. */
export function useDockCurrent(): string | null {
  return useSyncExternalStore(subscribe, () => current, () => current);
}
