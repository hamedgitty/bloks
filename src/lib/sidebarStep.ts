// ⌥↑ and ⌥↓: a step through the sidebar, in the order it shows.
//
// The order is read off the page rather than worked out again from the
// state. The sidebar decides it (sections, pins, whatever comes next),
// and a second copy of that decision here would be a second answer the
// day the first one changes. So each agent and room row carries its id
// and whether it wants you, and this only decides where a step lands.

export interface SidebarRow {
  id: string;
  /** Unread, or stopped on a question for you: what ⌥⇧ stops at. */
  waiting: boolean;
  /** Inside a folded section. Folding a section is asking not to see
   * its rows, so a step goes past them; the open row in one is still
   * where a step starts from. */
  folded: boolean;
}

/**
 * The row a step lands on: up (-1) or down (1) from the open one,
 * stopping only at rows that want you when `waiting` is set. At either
 * end there is nowhere to go and the answer is null, rather than a jump
 * round to the far end, which would read as the list having moved. With
 * nothing open in the list (a project lens hid it, or a search), the
 * first step down lands on the top row and the first step up on the
 * bottom one.
 */
export function stepRow(
  rows: readonly SidebarRow[],
  current: string | null,
  direction: 1 | -1,
  waiting = false,
): string | null {
  const stops = (row: SidebarRow) => !row.folded && (!waiting || row.waiting);
  const at = current === null ? -1 : rows.findIndex((row) => row.id === current);
  if (at === -1) {
    const open = rows.filter(stops);
    return (direction === 1 ? open[0] : open[open.length - 1])?.id ?? null;
  }
  for (let i = at + direction; i >= 0 && i < rows.length; i += direction) {
    if (stops(rows[i])) return rows[i].id;
  }
  return null;
}
