// A no-report word must not flash on screen before its completed item is
// classified. Ordinary prose can stream; ambiguous prefixes and structured
// answers wait for the authoritative completion. No viewer owns this state.
import type { RuntimeEvent } from "./contracts.ts";

const PREFIX = 64;
// Clients have one preview per lane, so interleaving falls back to saved items.
const ITEMS = 1;
type Item = { held: string; mode: "prefix" | "flow" | "settled" };
type Attempt = { turnId?: string; items: Map<string, Item>; settled: boolean };
const anonymous = "";

export class TextPreview {
  private lanes = new Map<string, Attempt>();

  start(event: RuntimeEvent): void {
    this.lanes.set(event.threadId, { turnId: event.turnId, items: new Map(), settled: false });
  }

  private attempt(event: RuntimeEvent): Attempt | undefined {
    const a = this.lanes.get(event.threadId);
    return a?.turnId === event.turnId ? a : undefined;
  }

  delta(event: Extract<RuntimeEvent, { type: "content.delta" }>): RuntimeEvent | null {
    if (event.streamKind !== "assistant_text") return event;
    const a = this.attempt(event);
    // Missing start or uncertain attribution: the saved completion is enough.
    if (!a || a.settled) return null;
    const key = event.itemId ?? anonymous;
    if (key.length > 256 || (key && a.items.has(anonymous)) || (!key && [...a.items.keys()].some(Boolean))) {
      a.settled = true;
      a.items.clear();
      return null;
    }
    let item = a.items.get(key);
    if (!item) {
      if (a.items.size >= ITEMS) {
        // Sticky for this attempt: evicting a prefix must not let its tail out.
        a.settled = true;
        a.items.clear();
        return null;
      }
      item = { held: "", mode: "prefix" };
      a.items.set(key, item);
    }
    if (item.mode === "settled") return null;
    if (item.mode === "flow") return event;
    const sample = (item.held + event.delta.slice(0, PREFIX)).slice(0, PREFIX);
    const first = sample.trimStart();
    // Fences may be lifted into cards, leaving only the quiet word. Keep
    // structured/quoted prefixes settled-only rather than parse them twice.
    if ((first && !/^[a-z0-9]/i.test(first)) || /^quiet/i.test(first)) {
      item.mode = "settled";
      item.held = "";
      return null;
    }
    if (!first || "quiet".startsWith(first.toLowerCase())) {
      if (item.held.length + event.delta.length >= PREFIX) {
        item.mode = "settled";
        item.held = "";
      } else item.held += event.delta;
      return null;
    }
    const delta = item.held + event.delta;
    item.held = "";
    item.mode = "flow";
    return { ...event, delta };
  }

  complete(event: RuntimeEvent): void {
    const a = this.attempt(event);
    if (!a) return;
    a.items.delete(event.itemId ?? anonymous);
    // API deltas are anonymous even when their completion gains an id.
    a.items.delete(anonymous);
  }

  end(event: RuntimeEvent): void {
    if (event.type === "session.exited" || this.attempt(event)) this.lanes.delete(event.threadId);
    // An orphan prefix is not an authoritative answer to save or replay.
  }
}
