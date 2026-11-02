// A snapshot asked for over HTTP and the event stream are two separate
// lines, and either can arrive first. The agent list on load or reconnect
// replaces every agent, so one built before frames the stream has already
// delivered put the older state back over them: a finished turn's tab
// read working again, or a running one idle (GitHub 398).
//
// So while a load is out, the frames that touch the agents are noted, and
// its answer is applied as the list and then every frame the list did not
// yet hold. The server says the sequence its list was built at; a frame
// past that is newer than the list. A server too old to say gets every
// frame since the request went out, which can repeat what the list already
// holds, but each of them is whole or keyed by id, so the result is still
// what the stream said last.
//
// A frame says where it stands in `_seq`. Through Bloks Cloud that is the
// desktop's stand-in server's own count, kept for freshness, and the
// server's comes as `_serverSeq` (electron/remote.mjs). Ordered by the
// stand-in's count, every frame read as older than a list from a server
// that had been up longer, and the list put the old states back.

/** Where a frame stands in the server's count, as an agent list or an
 * answer says it; undefined when the server did not say. */
export function serverSeq(frame: { _seq?: unknown; _serverSeq?: unknown }): number | undefined {
  const seq = "_serverSeq" in frame ? frame._serverSeq : frame._seq;
  return typeof seq === "number" ? seq : undefined;
}

export interface SnapshotLoad<A> {
  /** The frames this load's list does not hold, oldest first, and the
   * load is over. `seq` is the sequence the list was built at. */
  settle(seq?: number): A[];
  /** Let go without an answer: a newer load took over. */
  drop(): void;
}

export function snapshotOrder<A>() {
  const open = new Set<Array<{ seq: number; action: A }>>();
  return {
    begin(): SnapshotLoad<A> {
      const seen: Array<{ seq: number; action: A }> = [];
      open.add(seen);
      return {
        settle(seq) {
          open.delete(seen);
          return seen.filter((f) => typeof seq !== "number" || f.seq > seq).map((f) => f.action);
        },
        drop() {
          open.delete(seen);
        },
      };
    },
    /** A frame just applied. One without a sequence cannot be placed, so it
     * counts as newer than any list. */
    note(seq: number | undefined, action: A) {
      for (const seen of open) seen.push({ seq: typeof seq === "number" ? seq : Infinity, action });
    },
  };
}
