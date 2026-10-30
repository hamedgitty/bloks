// The note a workspace keeps once its work has moved to another machine.
//
// A move copies a workspace whole and leaves the copy it came from where
// it was, never deleted. Two copies of one workspace that both ran their
// routines, watchers, workflows and chat bots would do everything twice,
// and a bot token polled from two places loses half its messages to the
// other. So the copy that is no longer the live one keeps this note, in
// its own data folder, and everything that would run on its own reads it
// first and sits out. The person can still open the copy and read it;
// the note says where the work went, so the page can say so too.
//
// The note never travels: a move leaves it out (server/workspace-move.ts),
// and a workspace moved back into this folder replaces the folder whole,
// note and all, which is what brings it back to life.
//
// `pending` is the moment in between: the other machine is putting the
// move in place, this copy has already stopped, and the note is taken
// away again if the move does not finish, so a failed move leaves this
// copy exactly as it was.
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

import { isRecord, readSaved, writeFileAtomic } from "./atomic-write.ts";
import { thisMachine } from "./this-machine.ts";

export const MOVED_FILE = "moved.json";

export interface MovedMark {
  /** Where the work runs now: the person's hosted machine, or their Mac. */
  to: "hosted" | "mac";
  /** That workspace's name, as the app lists it. */
  name: string;
  /** The app's id for it, so the page can open it; null when unknown. */
  workspaceId: string | null;
  at: number;
  /** Stopped here while the other machine puts the move in place. */
  pending: boolean;
}

const ID = /^[a-z0-9_-]{1,40}$/;

/** A note as a file or a request said it, or null for anything that is
 * not one. Names lose control characters and are bounded: they end up
 * on a banner. */
export function cleanMovedMark(raw: unknown, now = Date.now()): MovedMark | null {
  if (!isRecord(raw)) return null;
  const to = raw.to === "hosted" || raw.to === "mac" ? raw.to : null;
  if (!to) return null;
  const name = typeof raw.name === "string" ? raw.name.replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60) : "";
  return {
    to,
    name: name || (to === "hosted" ? "Hosted" : "your computer"),
    workspaceId: typeof raw.workspaceId === "string" && ID.test(raw.workspaceId) ? raw.workspaceId : null,
    at: typeof raw.at === "number" && Number.isFinite(raw.at) ? raw.at : now,
    pending: raw.pending === true,
  };
}

export function readMovedMark(dataDir: string): MovedMark | null {
  const file = join(dataDir, MOVED_FILE);
  if (!existsSync(file)) return null;
  return cleanMovedMark(readSaved<unknown>(file, null, isRecord));
}

export function writeMovedMark(dataDir: string, mark: MovedMark): void {
  writeFileAtomic(join(dataDir, MOVED_FILE), `${JSON.stringify(mark, null, 2)}\n`, 0o600);
}

export function clearMovedMark(dataDir: string): void {
  rmSync(join(dataDir, MOVED_FILE), { force: true });
}

/** The banner's sentence for a copy whose work moved. A copy moved to
 * "mac" sits on the hosted machine, which cannot tell what the person's
 * own computer is, so that side stays neutral; a copy moved to "hosted"
 * sits on this machine. */
export function movedWords(mark: MovedMark): string {
  const where = mark.to === "hosted" ? "your hosted machine" : "your computer";
  if (mark.pending) return `This workspace is moving to ${where}. Its routines, watchers, workflows and chat bots have stopped here while it does.`;
  return mark.to === "hosted"
    ? `This workspace moved to your hosted machine. Its routines, watchers, workflows and chat bots run there now, not on ${thisMachine()}.`
    : "This workspace moved to your computer. Its routines, watchers, workflows and chat bots run there now, not here.";
}
