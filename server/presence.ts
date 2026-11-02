// Whether the person is at a computer right now (GitHub 443).
//
// A phone that buzzes with every answer is useful in a pocket and noise on
// a desk where Bloks is already open in front of the person. So while the
// owner is actively using Bloks on a computer, their phone stays quiet:
// no ordinary notifications, and no new Live Activities, anywhere in the
// workspace. Everything still arrives in Bloks itself; only the
// interruption is held back, and never replayed.
//
// Active is a strict word, said by the window itself (src/lib/presence.ts):
// a desktop or browser window that is shown and focused, on a computer
// with a fine pointer, where the person has typed, clicked, scrolled or
// moved the pointer within the last two minutes. It is said again every
// thirty seconds while it holds, and said to be over the moment it stops:
// hidden, blurred, idle. A connection is not presence; a background
// window, an idle or sleeping computer and a dropped line all stop saying
// it, and a word older than PRESENCE_FRESH_MS no longer counts. So the
// phone is never kept quiet for longer than that after the person leaves.
//
// Only the owner's own screens may say it (the route refuses agents and
// members), each keyed by whoever asked so one cannot speak for another,
// and it is never written down: a yes and a time, held in memory, and
// gone with a restart. Nothing about what the person was doing is sent.

/** How often a window that is in use says so again. */
export const PRESENCE_EVERY_MS = 30_000;
/** How long one word holds: two of PRESENCE_EVERY_MS and some, so one
 * late word does not end it, and a window that went quiet without saying
 * so stops counting soon after. */
export const PRESENCE_FRESH_MS = 75_000;
/** How long without the person's input a window stays active. Said by the
 * window, which is the only one that can see input; here for the docs and
 * the tests. */
export const PRESENCE_IDLE_MS = 120_000;
/** More windows than anybody has open; the oldest word goes first. */
const MAX_WINDOWS = 64;

const WINDOW = /^[\w-]{6,64}$/;

/** One window's word, as the route reads it, or why not. */
export function presenceReport(body: unknown): { window: string; active: boolean; seq: number } | { error: string } {
  const b = (body ?? {}) as { window?: unknown; active?: unknown; seq?: unknown };
  if (typeof b.window !== "string" || !WINDOW.test(b.window)) return { error: "window is this window's own id" };
  if (typeof b.active !== "boolean") return { error: "active is true or false" };
  if (typeof b.seq !== "number" || !Number.isSafeInteger(b.seq) || b.seq < 0) return { error: "seq counts this window's words" };
  return { window: b.window, active: b.active, seq: b.seq };
}

export class Presence {
  private said = new Map<string, { active: boolean; seq: number; at: number }>();
  private was = false;
  private readonly now: () => number;
  private readonly onChange: (present: boolean) => void;
  private timer: ReturnType<typeof setTimeout> | null = null;

  /** `onChange` hears the person arrive at a computer and leave it, once
   * each way, including leaving by going quiet. */
  constructor(onChange: (present: boolean) => void = () => {}, now: () => number = Date.now) {
    this.onChange = onChange;
    this.now = now;
  }

  /**
   * `window` is keyed by whoever asked (this machine, or a paired device)
   * and the window's own id. A word older than the last one from the same
   * window changes nothing, since words can cross on the way.
   */
  say(window: string, active: boolean, seq: number): boolean {
    const before = this.said.get(window);
    if (before && seq <= before.seq) return false;
    this.said.delete(window);
    this.said.set(window, { active, seq, at: this.now() });
    while (this.said.size > MAX_WINDOWS) this.said.delete(this.said.keys().next().value!);
    this.check();
    return true;
  }

  /** Whether some window of the owner's is in active use right now. */
  present(): boolean {
    const now = this.now();
    let found = false;
    for (const [window, word] of this.said) {
      if (now - word.at > PRESENCE_FRESH_MS) this.said.delete(window);
      else if (word.active) found = true;
    }
    return found;
  }

  /** A device that was unpaired says nothing more. */
  forget(prefix: string) {
    for (const window of [...this.said.keys()]) if (window.startsWith(prefix)) this.said.delete(window);
    this.check();
  }

  /** Looks again, for a word that went stale with nobody saying more. */
  check() {
    const now = this.present();
    if (now !== this.was) {
      this.was = now;
      this.onChange(now);
    }
    this.arm();
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Wakes when the freshest active word would go stale, so leaving by
   * going quiet is heard then and not at the next word. */
  private arm() {
    this.stop();
    if (!this.was) return;
    let last = 0;
    for (const word of this.said.values()) if (word.active) last = Math.max(last, word.at);
    if (!last) return;
    const wait = Math.max(0, last + PRESENCE_FRESH_MS - this.now()) + 50;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.check();
    }, wait);
    this.timer.unref?.();
  }
}

/**
 * Who a wake still reaches while the owner is at a computer: everyone but
 * the owner's own phones. A wake for nobody else is no wake at all. One
 * that names nobody (no owner known to the relay) is left alone, since it
 * cannot be told apart from somebody else's.
 */
export type QuietableWake = string | { reason: string; clients?: string[]; preview?: boolean };

export function quietWake(wake: QuietableWake | undefined, owner: string | null, present: boolean): QuietableWake | undefined {
  if (!wake || !present || !owner || typeof wake === "string" || !wake.clients) return wake;
  const left = wake.clients.filter((client) => client !== owner);
  if (left.length === wake.clients.length) return wake;
  return left.length ? { ...wake, clients: left } : undefined;
}
