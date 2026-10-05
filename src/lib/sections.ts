// Filing the sidebar.
//
// A section is nothing but a name that agents and rooms agree to stand
// under; there is no sections table anywhere, so a section exists
// exactly as long as something is filed under it and vanishes when the
// last member leaves. That keeps the feature weightless: nothing to
// create first, nothing to clean up after.

interface Filed {
  section?: string | null;
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
 * is null, is one that section should take. It has to be a row (not a
 * heading, not a file from the Finder), and it has to be going somewhere
 * new: letting a row go over the section it already stands in is not a
 * move, so the section does not light up for it. */
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
