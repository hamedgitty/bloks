// Moving a waiting message up or down the line.
//
// Words that wait for a busy agent or a busy room go in the order they
// are in here, and the person may change that order for their own. Not
// everything waiting can move, or be stepped over: words already being
// handed to a turn, words sent with stop and send now (a turn of their
// own, first), and Bloks's own notes keep their places. The rest share
// the places left between them, so moving one only ever trades places
// among those, and the fixed ones stay exactly where they were.
//
// Pure, so the server and the app's strip (src/components/WaitingStrip.tsx)
// come to the same order from the same list.

/** Where a message is going: before another one that can move, or to the
 * end (null). */
export type QueuePlace = { before: string | null };

export type QueueMove =
  | { ok: true; order: string[]; changed: boolean }
  | { ok: false; why: "fixed" | "absent" | "place" };

/**
 * The line `ids` with `id` moved before `place.before`, counted among the
 * ones that can move. `fixed` are the ids that keep their places. Refused
 * when `id` is not in the line ("absent"), is one that keeps its place
 * ("fixed"), or `before` is neither in the line nor free to move ("place").
 */
export function moveInQueue(ids: readonly string[], fixed: ReadonlySet<string>, id: string, place: QueuePlace): QueueMove {
  if (!ids.includes(id)) return { ok: false, why: "absent" };
  if (fixed.has(id)) return { ok: false, why: "fixed" };
  const before = place.before;
  // before itself is where it already is
  if (before === id) return { ok: true, order: [...ids], changed: false };
  if (before !== null && (!ids.includes(before) || fixed.has(before))) return { ok: false, why: "place" };
  const free = ids.filter((x) => !fixed.has(x));
  const rest = free.filter((x) => x !== id);
  const at = before === null ? rest.length : rest.indexOf(before);
  rest.splice(at, 0, id);
  let next = 0;
  const order = ids.map((x) => (fixed.has(x) ? x : rest[next++]!));
  return { ok: true, order, changed: order.some((x, i) => x !== ids[i]) };
}

/** Where a step up or down takes `id` among the ones that can move: the
 * place to ask for, or null when it is at that end already or cannot
 * move. The keyboard's Move up and Move down ask in these terms. */
export function stepPlace(ids: readonly string[], fixed: ReadonlySet<string>, id: string, by: -1 | 1): QueuePlace | null {
  const free = ids.filter((x) => !fixed.has(x));
  const at = free.indexOf(id);
  if (at < 0) return null;
  if (by < 0) return at === 0 ? null : { before: free[at - 1]! };
  if (at === free.length - 1) return null;
  return { before: free[at + 2] ?? null };
}

/** Where a drag that lands at `to` (counted among every row, the moving
 * one taken out) asks to go: before the first row after it that can be
 * stepped over, or the end. */
export function dropPlace(ids: readonly string[], fixed: ReadonlySet<string>, id: string, to: number): QueuePlace {
  const rest = ids.filter((x) => x !== id);
  const after = rest.slice(Math.max(0, to)).find((x) => !fixed.has(x));
  return { before: after ?? null };
}
