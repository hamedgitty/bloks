// Filing the sidebar.
//
// A section is nothing but a name that agents and rooms agree to stand
// under; there is no sections table anywhere, so a section exists
// exactly as long as something is filed under it and vanishes when the
// last member leaves. That keeps the feature weightless: nothing to
// create first, nothing to clean up after.
//
// Inside a section, and in the unfiled list at the top, one rule decides
// the order (GitHub 156): pinned rows first, in the order the person put
// them, then everything else by recent activity with the person. Every
// field the rule reads comes from the server, so the Mac, the phone and
// anything else that draws the list draws the same one.

interface Filed {
  section?: string | null;
}

/**
 * What a row's place is decided by. Agents and rooms both carry these,
 * stored with the record on the server (server/store.ts, server/bloks.ts).
 */
export interface Ordered {
  id: string;
  /** Held in place by the person, or by an agent filing for them. */
  pinned?: boolean;
  /** Where a pinned row stands among the pins of its section, lowest
   * first. Null on a pin that was given no place, which stands after
   * those that were, oldest first. */
  pinOrder?: number | null;
  /** When this row last had something to do with the person: their own
   * message, a reply to one, or something waiting on them. 0 or absent
   * is never. */
  activeWithYouAt?: number;
  createdAt?: number;
}

const placeOf = (n: number | null | undefined) => (typeof n === "number" && Number.isFinite(n) ? n : Infinity);
const ascending = (a: number, b: number) => (a < b ? -1 : a > b ? 1 : 0);
// Plain code-unit order rather than localeCompare, so a client in another
// language, or another locale, breaks a tie exactly the same way.
const byId = (a: Ordered, b: Ordered) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * The sort rule, as a comparator. Pinned rows come first, by pinOrder; a
 * pin with no place stands after the placed ones, and of two such the
 * older comes first, the way a new pin joins the end. Then the rest by
 * activeWithYouAt, most recent first; rows nobody has spoken with yet go
 * newest first, the order the list kept before there was any of this.
 * The id settles anything left, so two clients can never disagree.
 */
export function compareRows(a: Ordered, b: Ordered): number {
  const pinned = Boolean(a.pinned);
  if (pinned !== Boolean(b.pinned)) return pinned ? -1 : 1;
  if (pinned) {
    return (
      ascending(placeOf(a.pinOrder), placeOf(b.pinOrder)) ||
      ascending(a.createdAt ?? 0, b.createdAt ?? 0) ||
      byId(a, b)
    );
  }
  return (
    ascending(b.activeWithYouAt ?? 0, a.activeWithYouAt ?? 0) ||
    ascending(b.createdAt ?? 0, a.createdAt ?? 0) ||
    byId(a, b)
  );
}

/** One list in the sidebar's order. A new array; the input is left as it was. */
export function sidebarOrder<T extends Ordered>(rows: readonly T[]): T[] {
  return [...rows].sort(compareRows);
}

/** A row of the sidebar, agent or room, carrying what its place needs. */
export interface Listed extends Ordered, Filed {
  kind: "agent" | "room";
}

export interface SidebarLayout<T extends Listed> {
  /** The unfiled list at the top. It keeps its two headings, Rooms then
   * Agents, so it is drawn as two lists; each is its share of the one
   * order, which is the same thing as ordering each on its own. */
  unfiled: { rooms: T[]; agents: T[] };
  /** Each named section in the person's order, rooms and agents in one
   * list under its heading. */
  sections: Array<{ name: string; rows: T[] }>;
}

/**
 * The whole sidebar, top to bottom: the order every surface follows, so
 * the keyboard, the rail and a phone go through the rows exactly as they
 * are drawn. Folding is left to the caller, since that is per device.
 */
export function sidebarLayout<T extends Listed>(rows: readonly T[], sectionOrder: readonly string[]): SidebarLayout<T> {
  const unfiled = sidebarOrder(inSection([...rows], null));
  return {
    unfiled: {
      rooms: unfiled.filter((row) => row.kind === "room"),
      agents: unfiled.filter((row) => row.kind === "agent"),
    },
    sections: orderSections(sectionNames([...rows]), sectionOrder).map((name) => ({
      name,
      rows: sidebarOrder(inSection([...rows], name)),
    })),
  };
}

/** The layout as one run of rows, for the places with no room for
 * headings: the collapsed rail and the phone-width strip. */
export function layoutRows<T extends Listed>(layout: SidebarLayout<T>): T[] {
  return [...layout.unfiled.rooms, ...layout.unfiled.agents, ...layout.sections.flatMap((s) => s.rows)];
}

/** Where a row stands, or is going. `position` is its place among the
 * pins of its section, 1 first, when it is pinned and has one. */
export interface Place {
  section: string | null;
  pinned: boolean;
  position?: number;
}

/** Where a row stands now: its section, whether it is pinned, and which
 * pin of that section it is. `rows` is everything that could share the
 * section, in any order. */
export function placeOfRow(rows: readonly Listed[], id: string): Place | null {
  const row = rows.find((r) => r.id === id);
  if (!row) return null;
  const section = row.section ?? null;
  if (!row.pinned) return { section, pinned: false };
  const pins = sidebarOrder(rows.filter((r) => r.pinned && (r.section ?? null) === section));
  return { section, pinned: true, position: pins.findIndex((r) => r.id === id) + 1 };
}

/** Whether going to `to` would change anything about a row at `from`.
 * A place among the pins only counts when one was asked for; without one
 * a pin keeps the place it has. */
export function movesRow(from: Place, to: Place): boolean {
  if (from.section !== to.section || from.pinned !== to.pinned) return true;
  return to.pinned && to.position !== undefined && to.position !== from.position;
}

/** What a drop lands as: held among the pins or not, and the row the
 * drop line is drawn against. No line means the pointer is not choosing
 * a place: among the unpinned rows that is because activity decides, and
 * over a heading it is because the row keeps whatever pin it has. */
export interface Landing {
  pinned: boolean;
  line?: { id: string; edge: "top" | "bottom" };
}

/**
 * What letting a row go over `overId` means, in `list` as it is drawn.
 * Over a pinned row it takes that row's place, above it from the top
 * half and below it from the bottom half. The top half of the first
 * unpinned row is the end of the pins, which is also how a list with no
 * pins gets its first one. Anywhere further down it lands unpinned.
 */
export function landingOver(
  list: readonly Ordered[],
  draggedId: string,
  overId: string,
  half: "top" | "bottom",
): Landing {
  const dragged = list.find((row) => row.id === draggedId);
  const rows = list.filter((row) => row.id !== draggedId);
  const at = rows.findIndex((row) => row.id === overId);
  if (at < 0) return { pinned: Boolean(dragged?.pinned) };
  if (rows[at].pinned) return { pinned: true, line: { id: overId, edge: half } };
  const firstLoose = rows.findIndex((row) => !row.pinned);
  if (at === firstLoose && half === "top") return { pinned: true, line: { id: overId, edge: "top" } };
  return { pinned: false };
}

/** The place a line asks for among `pins`, the section's pins in order
 * without the row being moved: 1 first. A line against a row that is not
 * one of them (the first unpinned row, or a pin a search is hiding)
 * means the end. */
export function pinPosition(pins: readonly Ordered[], line: Landing["line"]): number {
  const at = line ? pins.findIndex((pin) => pin.id === line.id) : -1;
  if (!line || at < 0) return pins.length + 1;
  return line.edge === "top" ? at + 1 : at + 2;
}

/** One row's share of a placement: what changes about it. */
export interface Placement {
  kind: Listed["kind"];
  id: string;
  patch: { section?: string | null; pinned?: boolean; pinOrder?: number | null };
}

/**
 * What putting one row at `to` does, row by row: its own section, pin and
 * place, and the places of the pins around it. The same steps the server
 * takes (arrange, in server/index.ts), so a drop shows the moment it
 * happens and the server's answer, when it comes, moves nothing. Without
 * a position a pin keeps its place, unless it is new to these pins, and
 * then it goes after them; unpinning lets go of the place.
 */
export function placeRow(rows: readonly Listed[], id: string, to: Place): Placement[] {
  const row = rows.find((r) => r.id === id);
  if (!row) return [];
  const own: Placement["patch"] = { section: to.section, pinned: to.pinned };
  const neighbours: Placement[] = [];
  if (!to.pinned) {
    own.pinOrder = null;
  } else if (to.position !== undefined) {
    const pins = rows.filter((r) => r.id !== id && r.pinned && (r.section ?? null) === to.section);
    for (const { row: pin, pinOrder } of placeAmong(pins, { ...row, section: to.section, pinned: true }, to.position)) {
      if (pin.id === id) own.pinOrder = pinOrder;
      else neighbours.push({ kind: pin.kind, id: pin.id, patch: { pinOrder } });
    }
  } else if (to.section !== (row.section ?? null) || !row.pinned) {
    own.pinOrder = null;
  }
  return [{ kind: row.kind, id, patch: own }, ...neighbours];
}

/** The pins of a section after one row takes `position` among them,
 * numbered from 1 the way the server stores them. Only rows whose number
 * changes are returned. */
export function placeAmong<T extends Ordered>(pins: readonly T[], row: T, position: number): Array<{ row: T; pinOrder: number }> {
  const rest = sidebarOrder(pins.filter((pin) => pin.id !== row.id));
  const at = Math.max(0, Math.min(rest.length, Math.floor(position) - 1));
  const placed = [...rest.slice(0, at), row, ...rest.slice(at)];
  return placed
    .map((pin, i) => ({ row: pin, pinOrder: i + 1 }))
    .filter(({ row: pin, pinOrder }) => pin.pinOrder !== pinOrder);
}

/** Every section name in use, each once, in the order headings render.
 * Alphabetical, because the user named these and can predict it. */
export function sectionNames(...groups: Filed[][]): string[] {
  const names = new Set<string>();
  for (const rows of groups) {
    for (const row of rows) if (row.section) names.add(row.section);
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

/** The sections in the order the person dragged them into. Names they
 * have placed come first, in their order; anything not placed yet (a new
 * section, or everything for someone who never drags) follows
 * alphabetically, so nothing changes for people who do not care. A
 * placed name that no longer exists is skipped. */
export function orderSections(names: string[], order: readonly string[]): string[] {
  const present = new Set(names);
  const placed = order.filter((name, i) => present.has(name) && order.indexOf(name) === i);
  const rest = names.filter((name) => !placed.includes(name));
  return [...placed, ...rest];
}

/** The order after dropping `dragged` before or after `target`. Returns
 * every current section, so the whole order is remembered from then on
 * and a later new section lands at the end. */
export function moveSection(
  shown: readonly string[],
  dragged: string,
  target: string,
  place: "before" | "after",
): string[] {
  if (dragged === target || !shown.includes(dragged) || !shown.includes(target)) return [...shown];
  const without = shown.filter((name) => name !== dragged);
  const at = without.indexOf(target) + (place === "after" ? 1 : 0);
  return [...without.slice(0, at), dragged, ...without.slice(at)];
}

/** What a heading carries while it is dragged to reorder the sections. */
export const SECTION_TYPE = "application/x-bloks-section";

/** What an agent or room row carries while it is dragged to be filed.
 * A type of its own, so a row passing over a heading is never taken for
 * a heading being reordered, and a heading passing over rows is never
 * taken for a filing. */
export const ROW_TYPE = "application/x-bloks-row";

/** Whether a drag over a section, or over the unfiled list when `into`
 * is null, would file a row there, which is when the section lights up.
 * It has to be a row (not a heading, not a file from the Finder), and it
 * has to be going somewhere new. A row over its own section can still be
 * let go to take another place among the pins (movesRow), but that is
 * shown by the drop line alone, not by lighting up where it already is. */
export function acceptsRow(types: readonly string[], from: string | null, into: string | null): boolean {
  return types.includes(ROW_TYPE) && from !== into;
}

/** One section's slice of a list, in the list's own order. */
export function inSection<T extends Filed>(rows: T[], name: string | null): T[] {
  return rows.filter((row) => (row.section ?? null) === name);
}

/** What a folded section still shows: only the open thread, so folding
 * a section never hides where you are. A search unfolds everything,
 * because a match you cannot see reads as no match. */
export function shownInSection<T extends { id: string }>(
  rows: T[],
  collapsed: boolean,
  selectedId: string | null,
  searching: boolean,
): T[] {
  if (!collapsed || searching) return rows;
  return rows.filter((row) => row.id === selectedId);
}
