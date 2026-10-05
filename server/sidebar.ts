// Where things stand in the sidebar, kept here rather than on a device.
//
// The sidebar used to be arranged per device: the section order lived in
// one browser's storage, and inside a section the order was simply the
// order of the file. So the Mac and the phone drifted, and a team
// somebody wanted in a set order could not be put in one (GitHub 156).
//
// Three things are kept, all with the workspace:
//
//   The order of the sections, as the person dragged their headings.
//   It is a list of names here, because a section is only a name the
//   rows agree on (see src/lib/sections.ts); a name that stops being used
//   is simply skipped when the list is drawn.
//
//   Which rows are pinned, and where each stands among the pins of its
//   section. On the agent or room itself, beside `section`, as
//   `pinned` and `pinOrder`: one row, one write, and a row carried to
//   another device carries its place with it.
//
//   When each row last had something to do with the person
//   (`activeWithYouAt`, decided in server/activity.ts). Everything that
//   is not pinned sorts by it.
//
// The rule that turns those into an order is compareRows in
// src/lib/sections.ts, which is what the sidebar draws with. The server
// only ever needs its pinned half, to number the pins when one moves, and
// the copy of that half here is held to the client's by
// test/sidebar-order.test.ts.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { DATA_DIR } from "./config.ts";

/** A row as placing it needs it: an agent or a room in the sidebar. */
export interface Placed {
  id: string;
  kind: "agent" | "room";
  name: string;
  section?: string | null;
  pinned?: boolean;
  pinOrder?: number | null;
  createdAt?: number;
}

const placeOf = (n: number | null | undefined) => (typeof n === "number" && Number.isFinite(n) ? n : Infinity);
const ascending = (a: number, b: number) => (a < b ? -1 : a > b ? 1 : 0);

/** The order pins stand in: by pinOrder, a pin given no place after the
 * ones that have one, the older of two such first, then by id. */
export function byPin(a: Placed, b: Placed): number {
  return (
    ascending(placeOf(a.pinOrder), placeOf(b.pinOrder)) ||
    ascending(a.createdAt ?? 0, b.createdAt ?? 0) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/** The pins of one section, in order. Rooms and agents share them: in a
 * named section they are one list, and the unfiled list only draws its
 * rooms and its agents apart. */
export function pinsIn(rows: readonly Placed[], section: string | null): Placed[] {
  return rows.filter((row) => row.pinned && (row.section ?? null) === section).sort(byPin);
}

/** A place a pin was given, as it is written back to its record. */
export interface PinPlace {
  id: string;
  kind: "agent" | "room";
  pinOrder: number;
}

/**
 * The pins of `section` once `id` takes `position` among them, 1 first
 * and anything past the end meaning the end. Every pin is numbered again
 * from 1, so the stored numbers stay small and read as the places they
 * are; only those whose number changes are returned.
 */
export function placeAt(rows: readonly Placed[], id: string, section: string | null, position: number): PinPlace[] {
  const row = rows.find((r) => r.id === id);
  if (!row) return [];
  const rest = pinsIn(rows, section).filter((pin) => pin.id !== id);
  const at = Math.max(0, Math.min(rest.length, Math.floor(position) - 1));
  return [...rest.slice(0, at), row, ...rest.slice(at)]
    .map((pin, i) => ({ id: pin.id, kind: pin.kind, pinOrder: i + 1, was: pin.pinOrder }))
    .filter((pin) => pin.was !== pin.pinOrder)
    .map(({ id: pinId, kind, pinOrder }) => ({ id: pinId, kind, pinOrder }));
}

/**
 * What a workspace from before pins had places needs, to look the same
 * afterwards. Rooms were always held in the order they were listed, so
 * every room that has never been pinned or unpinned becomes pinned, in
 * that order. Agents that were pinned float above the rest, in the order
 * they were listed, so they are numbered after the rooms of their section
 * in that order. Rows are given in the order their files list them, and
 * the places returned are only the ones that change; running it again
 * finds nothing to do.
 */
export function upgradePlaces(
  rooms: readonly Placed[],
  agents: readonly Placed[],
): { rooms: PinPlace[]; agents: PinPlace[] } {
  const next = new Map<string, number>();
  const used = (section: string | null) => {
    if (!next.has(section ?? "")) {
      const placed = [...rooms, ...agents]
        .filter((row) => row.pinned && (row.section ?? null) === section)
        .map((row) => placeOf(row.pinOrder))
        .filter((n) => Number.isFinite(n));
      next.set(section ?? "", placed.length ? Math.max(...placed) : 0);
    }
  };
  const give = (row: Placed): PinPlace => {
    const section = row.section ?? null;
    used(section);
    const n = next.get(section ?? "")! + 1;
    next.set(section ?? "", n);
    return { id: row.id, kind: row.kind, pinOrder: n };
  };
  return {
    rooms: rooms.filter((room) => room.pinned === undefined).map(give),
    agents: agents.filter((agent) => agent.pinned && placeOf(agent.pinOrder) === Infinity).map(give),
  };
}

/** The sections in the order the person dragged them into, then any not
 * placed yet alphabetically. orderSections in src/lib/sections.ts, said
 * again for the one answer that is the server's own. */
export function orderedSections(rows: readonly Placed[], order: readonly string[]): string[] {
  const names = [...new Set(rows.map((row) => row.section).filter((name): name is string => Boolean(name)))].sort((a, b) =>
    a.localeCompare(b),
  );
  const present = new Set(names);
  const placed = order.filter((name, i) => present.has(name) && order.indexOf(name) === i);
  return [...placed, ...names.filter((name) => !placed.includes(name))];
}

/** One section as an agent reads it: what is pinned where, and what else
 * is there. */
export interface SectionView {
  /** Null for the unfiled list at the top. */
  name: string | null;
  pinned: Array<{ id: string; kind: "agent" | "room"; name: string; position: number }>;
  /** Everything else in the section, by name. The sidebar shows these by
   * recent activity with the person, which is the person's own business
   * and moves on its own, so it is not something to plan around. */
  others: Array<{ id: string; kind: "agent" | "room"; name: string }>;
}

/** The sidebar as GET /api/sidebar answers it: enough to see where things
 * are before moving any of them. */
export function sidebarView(rows: readonly Placed[], sectionOrder: readonly string[]): SectionView[] {
  const view = (name: string | null): SectionView => ({
    name,
    pinned: pinsIn(rows, name).map((row, i) => ({ id: row.id, kind: row.kind, name: row.name, position: i + 1 })),
    others: rows
      .filter((row) => !row.pinned && (row.section ?? null) === name)
      .sort((a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((row) => ({ id: row.id, kind: row.kind, name: row.name })),
  });
  return [view(null), ...orderedSections(rows, sectionOrder).map(view)];
}

/** The longest list of section names kept: far more headings than a
 * sidebar can hold, so it only stops a runaway writer. */
export const MAX_SECTION_ORDER = 200;

/** A section order as the client sent it, made safe to keep: names only,
 * each once, the same shape a section name is everywhere else. */
export function cleanSectionOrder(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const name = item.trim().replace(/\s+/g, " ");
    if (!name || name.length > 60 || out.includes(name)) continue;
    out.push(name);
    if (out.length >= MAX_SECTION_ORDER) break;
  }
  return out;
}

const SIDEBAR_FILE = join(DATA_DIR, "sidebar.json");

/** The part of the arrangement that belongs to no row: the order of the
 * section headings. */
export class SidebarStore {
  sectionOrder: string[] = [];
  /** Whether anyone has ever placed a heading. A device that kept its own
   * order before this lived here hands it over once, and only while this
   * is still false; after that the workspace's order is the order. */
  saved = false;

  private file: string;

  constructor(file = SIDEBAR_FILE) {
    this.file = file;
    mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8"));
      const order = cleanSectionOrder(parsed?.sectionOrder);
      if (order) {
        this.sectionOrder = order;
        this.saved = true;
      }
    } catch {
      /* nothing placed yet */
    }
  }

  setSectionOrder(order: string[]) {
    this.sectionOrder = order;
    this.saved = true;
    writeFileSync(this.file, JSON.stringify({ sectionOrder: order }, null, 2), { mode: 0o600 });
  }
}
