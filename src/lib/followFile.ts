// An open file viewer following its file as it changes on disk.
//
// The server already names each version of a shared file: a tag made
// from the open file's device, inode, size and times, the one it sends
// as the file's ETag (server/artifacts.ts, openArtifact). The viewer asks
// for that tag alone (GET the file's route with ?version) every few
// seconds while it is open and the window can be seen, and reads the
// file again only when the tag moves. No watcher: the folder may be on a
// server reached through Bloks Cloud, and a watcher there would be one
// more thing to keep alive for a dialog that is open for a minute. The
// end of a turn is no signal either, since the agent is not the only
// thing that writes files.
//
// This file is the deciding, over the answers. No "@/" imports, so the
// tests can load it as it is.

/** How often an open viewer asks: often on this computer or the network,
 * less through Bloks Cloud, where every ask is a sealed round trip. */
export const FOLLOW_MS = { near: 2_000, throughCloud: 6_000 } as const;

/** What the viewer last knew of the file: the version it shows (null
 * before the first answer), and whether the file was there at all. */
export interface Seen {
  tag: string | null;
  removed: boolean;
}

/** What one ask came back with. */
export interface VersionAnswer {
  status: number;
  tag?: unknown;
}

/** What the viewer does about it: nothing, read the file again, or say
 * it is gone. A file that comes back is read again. */
export type Follow = "none" | "reload" | "removed";

export const UNSEEN: Seen = { tag: null, removed: false };

/** The tag a version is said with as an ETag, quotes and weakness taken
 * off, or null for a header that is not one. */
export function tagOfEtag(header: string | null | undefined): string | null {
  const match = /^\s*(?:W\/)?"([^"]{1,200})"\s*$/.exec(header ?? "");
  return match ? match[1] : null;
}

/**
 * The next thing known, from an answer. A 404 is the file gone; any other
 * failure (a server restarting, the network dropping) is no news, never
 * a change, so a hiccup does not reload or blank anything. The first tag
 * is only where the viewer starts from: it was read a moment ago.
 */
export function followAnswer(seen: Seen, answer: VersionAnswer): { seen: Seen; follow: Follow } {
  if (answer.status === 404) {
    return seen.removed ? { seen, follow: "none" } : { seen: { tag: seen.tag, removed: true }, follow: "removed" };
  }
  if (answer.status !== 200 || typeof answer.tag !== "string" || !answer.tag) return { seen, follow: "none" };
  const tag = answer.tag;
  if (seen.removed) return { seen: { tag, removed: false }, follow: "reload" };
  if (seen.tag === null) return { seen: { tag, removed: false }, follow: "none" };
  if (seen.tag === tag) return { seen, follow: "none" };
  return { seen: { tag, removed: false }, follow: "reload" };
}
