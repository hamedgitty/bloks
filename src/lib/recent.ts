// Ctrl+Tab: the conversations this window has shown, newest first.
//
// The same order browsers and editors keep for their tabs, so the keys
// already in people's fingers mean the same thing here: one press goes
// back to where you just were, and holding Ctrl while pressing Tab again
// walks further back. Kept by each window for itself and never saved: it
// is a record of what this window has been looking at, not of the
// workspace.

/** A conversation as the switcher remembers it: an agent's or a room's
 * id, and for an agent which of its conversations was open. */
export interface Viewed {
  id: string;
  lane?: string;
}

/** Enough to go back a long way, few enough to fit on screen at once. */
export const RECENT_LIMIT = 12;

const same = (a: Viewed, b: Viewed) => a.id === b.id && (a.lane ?? null) === (b.lane ?? null);

/** The list after looking at `seen`: it goes to the front, and an older
 * visit to the same conversation leaves, so nothing is listed twice. */
export function visit(list: readonly Viewed[], seen: Viewed, limit = RECENT_LIMIT): Viewed[] {
  return [seen, ...list.filter((v) => !same(v, seen))].slice(0, limit);
}

/** The list without what has gone since: an archived agent, a deleted
 * room, a closed conversation. Going back to one of those would open
 * something that is not there. */
export function prune(list: readonly Viewed[], alive: (v: Viewed) => boolean): Viewed[] {
  return list.filter(alive);
}

/**
 * Where the highlight goes next while Ctrl is held, as an index into the
 * list as it stood when Ctrl+Tab was first pressed (`at` is null for that
 * first press). The list starts with what is on screen, so the first
 * press goes to the one before it, or with Shift to the oldest; each
 * press after moves one further, round and back to the start, the way an
 * app switcher does.
 *
 * When the newest one is not on screen (Settings is covering it), it is
 * where you just were, and the first press goes back to it. Null when
 * there is nothing to switch to.
 */
export function cycle(at: number | null, length: number, back: boolean, onScreen = true): number | null {
  if (at === null) {
    if (length < (onScreen ? 2 : 1)) return null;
    return back ? length - 1 : onScreen ? 1 : 0;
  }
  if (length < 1) return null;
  return (at + (back ? -1 : 1) + length) % length;
}

/** Whether two visits are to the same conversation. */
export function sameView(a: Viewed | null | undefined, b: Viewed | null | undefined): boolean {
  return Boolean(a && b && same(a, b));
}
