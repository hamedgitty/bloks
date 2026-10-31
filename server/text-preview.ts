// Presentation only: a quiet word cannot flash before its settled item.
// Everything that cannot be that word streams at its first distinguishing delta.
import type { RuntimeEvent } from "./contracts.ts";
import { isQuietReply } from "./routines.ts";

const PREFIX = 64;
const anonymous = "";
type Item = { held: string; flow: boolean };
// closed: the turn was finished quietly (`bloks quiet`), so nothing more
// of its text is previewed unless that is cancelled (reopen).
type Attempt = { turnId?: string; items: Map<string, Item>; settled: boolean; closed?: boolean };
// Prefixes of the exact isQuietReply grammar, including its surrounding trim.
const possibleQuiet = /^\s*(?:q(?:u(?:i(?:e(?:t[.!…]*\s*)?)?)?)?)?$/i;

export class TextPreview {
  private lanes = new Map<string, Attempt>();

  start(event: RuntimeEvent): void {
    this.lanes.set(event.threadId, { turnId: event.turnId, items: new Map(), settled: false });
  }

  private attempt(event: RuntimeEvent): Attempt | undefined {
    const a = this.lanes.get(event.threadId);
    return a?.turnId === event.turnId ? a : undefined;
  }

  delta(event: Extract<RuntimeEvent, { type: "content.delta" }>, silent: boolean): RuntimeEvent | null {
    if (event.streamKind !== "assistant_text") return event;
    const a = this.attempt(event);
    // A missing start or ambiguous attribution may wait for the saved item.
    if (!a) return silent ? null : event;
    if (a.closed) return null;
    // These are whole messages, not fragments of one shared item. A prior
    // progress message cannot admit a later marker, or prefix a new message.
    if (event.provider === "boxAgent") return silent && isQuietReply(event.delta) ? null : event;
    const key = event.itemId ?? anonymous;
    const item = a.items.get(key);
    if (!silent) {
      // An accepted person steer can change unaskedTurn. Keep a prefix that
      // belongs to this same item, in order and once; check-ins stay silent.
      if (item?.held) {
        const delta = item.held + event.delta;
        item.held = "";
        item.flow = true;
        return { ...event, delta };
      }
      return event;
    }
    if (a.settled) return null;
    if (key.length > 256 || (!item && a.items.size)) {
      // Clients have one preview per lane. Interleaving falls back to saved
      // items for this attempt, never eviction followed by an escaping tail.
      a.settled = true;
      a.items.clear();
      return null;
    }
    const current = item ?? { held: "", flow: false };
    if (!item) a.items.set(key, current);
    if (current.flow) return event;
    const sample = current.held + event.delta.slice(0, PREFIX + 1 - current.held.length);
    if (possibleQuiet.test(sample)) {
      if (sample.length >= PREFIX) {
        a.settled = true;
        a.items.clear();
      } else current.held = sample;
      return null;
    }
    const delta = current.held + event.delta;
    current.held = "";
    current.flow = true;
    return { ...event, delta };
  }

  complete(event: RuntimeEvent): void {
    const a = this.attempt(event);
    if (!a) return;
    a.items.delete(event.itemId ?? anonymous);
    // Anonymous API fragments can gain a native id only at completion.
    a.items.delete(anonymous);
  }

  /** The runtime turn a lane's preview is following, if any. */
  turnOf(laneId: string): string | undefined {
    return this.lanes.get(laneId)?.turnId;
  }

  /** A quiet finish: drop what is held, and show nothing more of this
   * attempt. Only for the attempt it names. */
  close(laneId: string, turnId: string): void {
    const a = this.lanes.get(laneId);
    if (a?.turnId !== turnId) return;
    a.closed = true;
    a.items.clear();
  }

  /** The quiet finish was cancelled: later text previews as usual. What
   * was dropped at the close stays dropped; its items are saved whole. */
  reopen(laneId: string, turnId: string): void {
    const a = this.lanes.get(laneId);
    if (a?.turnId === turnId) a.closed = false;
  }

  forget(laneId: string): void {
    this.lanes.delete(laneId);
  }

  end(event: RuntimeEvent): void {
    if ((event.type === "session.exited" && !event.turnId) || this.attempt(event)) this.lanes.delete(event.threadId);
  }
}
