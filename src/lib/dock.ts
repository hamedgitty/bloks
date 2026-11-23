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
// The panels a conversation has open are tabs along the dock's top, in
// the order they were opened, and a + beside them lists every kind this
// conversation offers. Closing a tab brings its neighbour forward;
// closing the last one hides the dock. A panel with nothing to show is
// never a tab until something asks for it, so the strip stays short.
//
// Panels a conversation cannot have (a browser on a phone looking at the
// Mac, a terminal in a room) are not this file's business: the dock is
// told which it offers and shows only those. Nothing here opens the dock
// by itself; something the person did asks for it, an agent starting to
// use its browser or its computer in a chat does (mayReveal below), or
// an agent asks for a panel on purpose with `bloks dock show` (mayShow),
// and a room never opens it on its own. The terminal is opened for an
// agent only that way, on one of the agent's own tabs: the person's
// shells are theirs, and an agent's ordinary commands do not run in them.
//
// No React and no page in the part the tests read; the store and the hook
// are at the end.
import { useSyncExternalStore } from "react";

// "docs" is the Files panel: the agent's shared files as a tree, and the
// ones opened beside it. Its id is older than its name, and stays so
// what a conversation remembered still opens.
export type DockPanel = "docs" | "changes" | "browser" | "terminal" | "tasks" | "computer" | "trace" | "topic" | "extensions";

/** The order the + menu lists panels in, whichever are offered. */
// "extensions" holds every running workspace extension's panels, as tabs
// of its own (src/components/extensions/ExtensionDock.tsx, GitHub 507).
// "tasks" is Background tasks: the agent's own terminal tabs and the jobs
// it took (src/components/dock/TasksPanel.tsx).
export const DOCK_PANELS: readonly DockPanel[] = ["topic", "docs", "changes", "browser", "terminal", "tasks", "computer", "trace", "extensions"];

/** A file open in the dock: an agent's shared file, by its name. */
export interface DockDoc {
  /** botId and name, which is what makes two the same file. */
  id: string;
  botId: string;
  name: string;
  mime: string;
  size: number;
}

/** Where a pane sits around the conversation. The right one is the dock
 * as it always was; a tab can move to any of the four. */
export type DockSide = "right" | "left" | "bottom" | "top";
export const DOCK_SIDES: readonly DockSide[] = ["right", "left", "bottom", "top"];
export type OtherSide = Exclude<DockSide, "right">;

/** One pane besides the right: open or not, and on which panel. */
export interface DockPane {
  open: boolean;
  panel: DockPanel | null;
}

export interface DockPlace {
  /** The right pane: open or not, and the panel shown there, or last shown
   * before it was closed. */
  open: boolean;
  panel: DockPanel | null;
  /** The panels open as tabs, in the order they were opened, whichever
   * pane each is in. */
  tabs: DockPanel[];
  /** The panes on the other sides, and which side each panel moved to
   * (a panel not named here is on the right). */
  panes?: Partial<Record<OtherSide, DockPane>>;
  sides?: Partial<Record<DockPanel, OtherSide>>;
  docs: DockDoc[];
  /** The document in front, among `docs`. */
  doc: string | null;
  /** When it was last touched, so the oldest are forgotten first. */
  at: number;
}

export interface DockState {
  places: Record<string, DockPlace>;
  /** The right pane's width. */
  width: number;
  /** The other panes' width (left) and height (top, bottom). */
  sizes?: Partial<Record<OtherSide, number>>;
}

/** A pane across the top or bottom: how tall it may be. */
export const ACROSS_SIZE = { min: 160, chat: 220, fallback: 300 } as const;

export function clampPaneHeight(height: number, room: number): number {
  const max = Math.max(ACROSS_SIZE.min, room - ACROSS_SIZE.chat);
  return Math.round(Math.min(max, Math.max(ACROSS_SIZE.min, Number.isFinite(height) ? height : ACROSS_SIZE.fallback)));
}

/** Which side a panel sits on in this conversation. */
export function sideOf(place: DockPlace, panel: DockPanel): DockSide {
  return place.sides?.[panel] ?? "right";
}

/** A side's pane: open or not, on which panel. */
export function paneOf(place: DockPlace, side: DockSide): DockPane {
  if (side === "right") return { open: place.open, panel: place.panel };
  return place.panes?.[side] ?? { open: false, panel: null };
}

function withPane(place: DockPlace, side: DockSide, pane: DockPane): DockPlace {
  if (side === "right") return { ...place, open: pane.open, panel: pane.panel };
  return { ...place, panes: { ...place.panes, [side]: pane } };
}

/** The tabs in one side's pane, in the order they were opened. */
export function tabsOn(place: DockPlace, side: DockSide): DockPanel[] {
  return place.tabs.filter((t) => sideOf(place, t) === side);
}

/** Whether a panel is on screen, in whichever pane it is in. */
export function shownAnywhere(place: DockPlace, panel: DockPanel): boolean {
  const pane = paneOf(place, sideOf(place, panel));
  return pane.open && pane.panel === panel;
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

export const EMPTY_PLACE: DockPlace = { open: false, panel: null, tabs: [], docs: [], doc: null, at: 0 };

const withTab = (tabs: readonly DockPanel[], panel: DockPanel): DockPanel[] => (tabs.includes(panel) ? [...tabs] : [...tabs, panel]);

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
  return withPlace(state, key, (p) => withPane({ ...p, tabs: withTab(p.tabs, panel) }, sideOf(p, panel), { open: true, panel }), now);
}

/**
 * A tab moved to another side: it is shown there, in that side's pane,
 * and the pane it left brings its neighbour forward, or closes when it
 * has none. Remembered per conversation.
 */
export function moveTab(state: DockState, key: string, panel: DockPanel, side: DockSide, now = Date.now()): DockState {
  const place = placeIn(state, key);
  const from = sideOf(place, panel);
  if (from === side) return showPanel(state, key, panel, now);
  return withPlace(
    state,
    key,
    (p) => {
      let next = p;
      const left = paneOf(p, from);
      if (left.panel === panel) {
        const rest = tabsOn(p, from).filter((t) => t !== panel);
        const at = Math.max(0, tabsOn(p, from).indexOf(panel));
        const neighbour = rest[Math.min(at, rest.length - 1)] ?? null;
        next = withPane(next, from, { open: left.open && neighbour !== null, panel: neighbour });
      }
      const sides = { ...next.sides };
      if (side === "right") delete sides[panel];
      else sides[panel] = side;
      next = { ...next, sides, tabs: withTab(next.tabs, panel) };
      return withPane(next, side, { open: true, panel });
    },
    now,
  );
}

/** A tab closed: the one beside it comes forward if it was in front.
 * Closing the right pane's last tab leaves it open on its list of what it
 * can show (SideDock.tsx), as an empty pane does when it is first opened;
 * another side's pane closes with its last tab. What the panel kept
 * (documents, shells) is not this tab's to end. */
export function closeTab(state: DockState, key: string, panel: DockPanel, now = Date.now()): DockState {
  const place = placeIn(state, key);
  const side = sideOf(place, panel);
  const pane = paneOf(place, side);
  const onSide = tabsOn(place, side);
  const at = onSide.indexOf(panel);
  if (at < 0 && pane.panel !== panel) return state;
  const tabs = place.tabs.filter((p) => p !== panel);
  if (pane.panel !== panel) return withPlace(state, key, (p) => ({ ...p, tabs }), now);
  const rest = onSide.filter((p) => p !== panel);
  const next = rest[Math.min(Math.max(at, 0), rest.length - 1)] ?? null;
  return withPlace(state, key, (p) => withPane({ ...p, tabs }, side, { open: pane.open && (next !== null || side === "right"), panel: next }), now);
}

/** Closed, with everything in it kept for when it opens again. */
export function hideDock(state: DockState, key: string, now = Date.now(), side: DockSide = "right"): DockState {
  const pane = paneOf(placeIn(state, key), side);
  if (!pane.open) return state;
  return withPlace(state, key, (p) => withPane(p, side, { ...pane, open: false }), now);
}

/** The header's toggle, for the right pane: the side a panel opens on
 * unless the person moved one elsewhere, since it keeps the conversation
 * where it was read. Closed, it opens on the tab last shown there, or the
 * one opened last, if still offered; with no tab there it opens on its
 * list of what it can show, and nothing is opened for the person. Open,
 * it closes. */
export function toggleDock(state: DockState, key: string, offered: readonly DockPanel[], now = Date.now()): DockState {
  const place = placeIn(state, key);
  if (place.open) return hideDock(state, key, now);
  const onRight = tabsOn(place, "right").filter((p) => offered.includes(p));
  const panel = place.panel && onRight.includes(place.panel) ? place.panel : (onRight[onRight.length - 1] ?? null);
  return withPlace(state, key, (p) => withPane(p, "right", { open: true, panel }), now);
}

/** A panel that went away (a terminal moved out of the dock): if it was
 * the one shown, the dock closes rather than showing something else the
 * person did not ask for. */
export function dropPanel(state: DockState, key: string, panel: DockPanel, now = Date.now()): DockState {
  const place = placeIn(state, key);
  const side = sideOf(place, panel);
  if (paneOf(place, side).panel !== panel) return place.tabs.includes(panel) ? withPlace(state, key, (p) => ({ ...p, tabs: p.tabs.filter((t) => t !== panel) }), now) : state;
  return withPlace(state, key, (p) => withPane({ ...p, tabs: p.tabs.filter((t) => t !== panel) }, side, { open: false, panel: null }), now);
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
  if (shownAnywhere(place, panel)) return false;
  return !(anyPaneOpen(place) && room.typingInDock);
}

/**
 * Whether an agent's `bloks dock show` brings a panel in front of the
 * person, in the conversation the agent is answering. The same rule as
 * an agent's work opening one, with two differences. Asking for the panel
 * already in front still goes ahead (it may name a file, a page or a tab
 * in it), unless the person is typing there. And a no is for the turn it
 * was given in: a panel the person put away stays away for the rest of
 * that turn, and an agent asking again on a later turn brings it back.
 * `declinedIn` is the turn the person put it away in, `turn` the one
 * asking now (src/lib/dockActivity.ts, currentTurn).
 */
export function mayShow(
  key: string | null,
  place: DockPlace,
  room: { width: number; typingInDock: boolean; declinedIn?: string | null; turn: string },
): boolean {
  if (!key || isRoomKey(key)) return false;
  if (room.width < REVEAL_WIDTH) return false;
  if (room.declinedIn !== undefined && room.declinedIn === room.turn) return false;
  return !(anyPaneOpen(place) && room.typingInDock);
}

/** Whether any of a conversation's panes is open. */
export function anyPaneOpen(place: DockPlace): boolean {
  return DOCK_SIDES.some((side) => paneOf(place, side).open);
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
      const kept = docs.length > MAX_DOCS ? docs.slice(docs.length - MAX_DOCS) : docs;
      return withPane({ ...p, tabs: withTab(p.tabs, "docs"), docs: kept, doc: id }, sideOf(p, "docs"), { open: true, panel: "docs" });
    },
    now,
  );
}

export function selectDoc(state: DockState, key: string, id: string, now = Date.now()): DockState {
  if (!placeIn(state, key).docs.some((d) => d.id === id)) return state;
  return withPlace(state, key, (p) => ({ ...p, doc: id }), now);
}

/** A file closed: the one beside it comes to the front. Closing the last
 * one leaves the Files panel on its tree, which is still worth showing. */
export function closeDoc(state: DockState, key: string, id: string, now = Date.now()): DockState {
  const place = placeIn(state, key);
  const at = place.docs.findIndex((d) => d.id === id);
  if (at < 0) return state;
  const docs = place.docs.filter((d) => d.id !== id);
  const doc = place.doc === id ? (docs[Math.min(at, docs.length - 1)]?.id ?? null) : place.doc;
  return withPlace(state, key, (p) => ({ ...p, docs, doc }), now);
}

// ── kept on this device ────────────────────────────────────────────────

export const DOCK_KEY = "bloks-dock";
export const DOCK_WIDTH_KEY = "bloks-dock-width";
/** The other panes' width and heights, on this device too. */
export const DOCK_SIZES_KEY = "bloks-dock-sizes";
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
const OTHER_SIDES = new Set<string>(["left", "bottom", "top"]);

/** The panes on the other sides, and which panel moved where, as stored:
 * anything that is not a side or a panel is dropped. */
function cleanSides(v: Record<string, unknown>, tabs: readonly DockPanel[]): Pick<DockPlace, "panes" | "sides"> {
  const out: Pick<DockPlace, "panes" | "sides"> = {};
  if (v.sides && typeof v.sides === "object") {
    const sides: Partial<Record<DockPanel, OtherSide>> = {};
    for (const [panel, side] of Object.entries(v.sides as Record<string, unknown>)) {
      if (PANEL_SET.has(panel) && typeof side === "string" && OTHER_SIDES.has(side)) sides[panel as DockPanel] = side as OtherSide;
    }
    if (Object.keys(sides).length) out.sides = sides;
  }
  if (v.panes && typeof v.panes === "object") {
    const panes: Partial<Record<OtherSide, DockPane>> = {};
    for (const [side, pane] of Object.entries(v.panes as Record<string, unknown>)) {
      if (!OTHER_SIDES.has(side) || !pane || typeof pane !== "object") continue;
      const p = pane as Record<string, unknown>;
      const panel = typeof p.panel === "string" && PANEL_SET.has(p.panel) && tabs.includes(p.panel as DockPanel) && out.sides?.[p.panel as DockPanel] === side ? (p.panel as DockPanel) : null;
      panes[side as OtherSide] = { open: p.open === true && panel !== null, panel };
    }
    if (Object.keys(panes).length) out.panes = panes;
  }
  return out;
}

/** The other panes' sizes, as stored. */
export function parseSizes(raw: string | null): Partial<Record<OtherSide, number>> {
  try {
    const said = raw ? JSON.parse(raw) : null;
    const out: Partial<Record<OtherSide, number>> = {};
    for (const side of ["left", "bottom", "top"] as const) {
      const n = Number(said?.[side]);
      if (Number.isFinite(n) && n > 0) out[side] = n;
    }
    return out;
  } catch {
    return {};
  }
}

export function parseDock(raw: string | null, width: string | null, legacyWidth: string | null = null, sizes: string | null = null): DockState {
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
    // a place kept before there were tabs had one: the panel it showed
    const said = Array.isArray(v.tabs) ? v.tabs.filter((t): t is DockPanel => typeof t === "string" && PANEL_SET.has(t)) : panel ? [panel] : [];
    const tabs = [...new Set(panel ? withTab(said, panel) : said)];
    const placed = cleanSides(v, tabs);
    // the right pane shows a panel only while it is on the right
    const right = panel && !placed.sides?.[panel] ? panel : null;
    places[key] = { open: v.open === true && right !== null, panel: right, tabs, docs, doc, at: typeof v.at === "number" ? v.at : 0, ...placed };
  }
  const n = Number(width ?? legacyWidth);
  return { places: forgetOldest(places), width: Number.isFinite(n) && n > 0 ? n : DOCK_SIZE.fallback, sizes: parseSizes(sizes) };
}

export function saveDock(storage: Storage | undefined, state: DockState): void {
  try {
    storage?.setItem(DOCK_KEY, JSON.stringify(state.places));
    storage?.setItem(DOCK_WIDTH_KEY, String(Math.round(state.width)));
    storage?.setItem(DOCK_SIZES_KEY, JSON.stringify(state.sizes ?? {}));
  } catch {
    /* storage refused: the dock still works for this window */
  }
}

// ── the store ──────────────────────────────────────────────────────────

const local = (): Storage | undefined => (typeof localStorage === "undefined" ? undefined : localStorage);

function load(): DockState {
  const storage = local();
  try {
    return parseDock(
      storage?.getItem(DOCK_KEY) ?? null,
      storage?.getItem(DOCK_WIDTH_KEY) ?? null,
      storage?.getItem(LEGACY_BROWSER_WIDTH_KEY) ?? null,
      storage?.getItem(DOCK_SIZES_KEY) ?? null,
    );
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
// put away after it did, by conversation, with the turn it was put away
// in. For this window only: a new day, or a restart, asks again.
const revealed = new Map<string, DockPanel>();
const declined = new Map<string, Map<DockPanel, string>>();
// The turn each conversation is on, as the conversation on screen says
// it (noteTurn): the id of the person's message that started it.
const turns = new Map<string, string>();

/** The person did something to the dock of this conversation: if what an
 * agent's work opened is going out of sight, that is a no to it. */
function byHand(key: string, next: DockPlace, picked?: DockPanel) {
  const opened = revealed.get(key);
  if (picked && shownAnywhere(next, picked)) declined.get(key)?.delete(picked);
  if (!opened) return;
  if (!shownAnywhere(next, opened)) {
    revealed.delete(key);
    declined.set(key, (declined.get(key) ?? new Map()).set(opened, turns.get(key) ?? ""));
  }
}

/** A change the person made, judged by byHand, then kept. */
function byPerson(key: string, next: DockState, picked?: DockPanel) {
  byHand(key, placeIn(next, key), picked);
  commit(next);
}

/** Something to bring forward inside a panel an agent asked for: a file
 * at a line, a page, one of its terminal tabs. */
export type DockTarget =
  | { kind: "doc"; botId: string; name: string; mime: string; size: number; line?: number }
  | { kind: "page"; url: string }
  | { kind: "terminal"; id: string }
  | { kind: "change"; path: string; line?: number };

/** `bloks dock show`, as the server sends it to every window. */
export interface DockAsk {
  botId: string;
  threadId: string;
  panel: DockPanel;
  target?: DockTarget;
}

/** The newest ask in each conversation, and what it named in its panel,
 * for that panel to act on once; `n` tells one ask from the next. */
export interface DockFocus {
  panel: DockPanel;
  target?: DockTarget;
  n: number;
}
const focus = new Map<string, DockFocus>();
let focusCount = 0;
/** Asks for a conversation that was not on screen, kept a while for when
 * it is: an agent asking from a chat the person has just left. */
const pending = new Map<string, { ask: DockAsk; at: number }>();
export const PENDING_ASK_MS = 10 * 60_000;
/** The panels a conversation can show, as the one on screen last said. */
let offeredNow: readonly DockPanel[] = DOCK_PANELS;

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
  /**
   * An agent asked for a panel on purpose (`bloks dock show`). Only the
   * conversation it is answering, and only by mayShow; one that is not on
   * screen keeps the ask for when it is. Says whether it was shown.
   */
  ask(ask: DockAsk, width = typeof window === "undefined" ? 0 : window.innerWidth): boolean {
    const key = chatKey(ask.botId, ask.threadId);
    if (key !== current) {
      pending.set(key, { ask, at: Date.now() });
      return false;
    }
    pending.delete(key);
    if (!offeredNow.includes(ask.panel)) return false;
    const turn = turns.get(key) ?? "";
    const room = { width, typingInDock: typingInDock(), declinedIn: declined.get(key)?.get(ask.panel), turn };
    if (!mayShow(key, placeIn(read(), key), room)) return false;
    declined.get(key)?.delete(ask.panel);
    focus.set(key, { panel: ask.panel, ...(ask.target ? { target: ask.target } : {}), n: ++focusCount });
    const next = ask.target?.kind === "doc"
      ? openDoc(read(), key, { botId: ask.target.botId, name: ask.target.name, mime: ask.target.mime, size: ask.target.size })
      : showPanel(read(), key, ask.panel);
    commit(next);
    revealed.set(key, ask.panel);
    return true;
  },
  /** What an agent last asked to bring forward in this conversation. */
  focus: (key: string): DockFocus | null => focus.get(key) ?? null,
  /** Said by the conversation on screen as it draws: the turn it is on
   * and the panels it offers. */
  noteTurn(key: string, turn: string, offered?: readonly DockPanel[]) {
    turns.set(key, turn);
    if (offered && key === current) offeredNow = offered;
  },
  /** Said by the conversation on screen as it draws. */
  setCurrent(key: string) {
    if (current === key) return;
    current = key;
    for (const listener of listeners) listener();
    const waiting = pending.get(key);
    if (!waiting) return;
    pending.delete(key);
    if (Date.now() - waiting.at < PENDING_ASK_MS) queueMicrotask(() => dock.ask(waiting.ask));
  },
  show: (key: string, panel: DockPanel) => byPerson(key, showPanel(read(), key, panel), panel),
  hide: (key: string, side: DockSide = "right") => byPerson(key, hideDock(read(), key, Date.now(), side)),
  toggle: (key: string, offered: readonly DockPanel[]) => byPerson(key, toggleDock(read(), key, offered), placeIn(toggleDock(read(), key, offered), key).panel ?? undefined),
  closeTab: (key: string, panel: DockPanel) => byPerson(key, closeTab(read(), key, panel)),
  /** A tab moved to another side, by the person. */
  move: (key: string, panel: DockPanel, side: DockSide) => byPerson(key, moveTab(read(), key, panel, side), panel),
  /** A side pane's width (left) or height (top, bottom), on this device. */
  setSize: (side: OtherSide, size: number) => commit({ ...read(), sizes: { ...read().sizes, [side]: size } }),
  drop: (key: string, panel: DockPanel) => byPerson(key, dropPanel(read(), key, panel)),
  openDoc: (key: string, doc: Omit<DockDoc, "id">) => byPerson(key, openDoc(read(), key, doc), "docs"),
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

/** What an agent last asked to bring forward in this conversation's
 * dock, for the panel it is in to act on (each `n` once). */
export function useDockFocus(key: string): DockFocus | null {
  return useSyncExternalStore(subscribe, () => focus.get(key) ?? null, () => focus.get(key) ?? null);
}

/** The conversation on screen's key, or null before one has drawn. */
export function useDockCurrent(): string | null {
  return useSyncExternalStore(subscribe, () => current, () => current);
}
