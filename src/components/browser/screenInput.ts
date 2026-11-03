// The person's hands on a server's browser, on their way there.
//
// Every click, scroll and key on the picture becomes an input event the
// server plays into the page (server/server-browser.ts, readInput). They
// go in order, a batch at a time, one request in flight: a key never
// overtakes the click before it, and over a slow line the next batch is
// whatever piled up meanwhile rather than a queue of requests. A pointer
// moving, or a wheel turning, is said once per batch, as where it is now
// and how far it turned in all.

export type MouseInput = {
  type: "down" | "up" | "move";
  x: number;
  y: number;
  button: "left" | "middle" | "right" | "none";
  buttons: number;
  clicks: number;
  mods: number;
};
export type WheelInput = { x: number; y: number; dx: number; dy: number; mods: number };
export type KeyInput = { type: "down" | "up"; key: string; code: string; keyCode: number; text?: string; mods: number; repeat: boolean };

export type ScreenEvent = ({ t: "mouse" } & MouseInput) | ({ t: "wheel" } & WheelInput) | ({ t: "key" } & KeyInput) | { t: "text"; text: string };

export interface InputSender {
  mouse(input: MouseInput): void;
  wheel(input: WheelInput): void;
  key(input: KeyInput): void;
  text(text: string): void;
  stop(): void;
}

/** What one request carries at most, and the longest text in one event:
 * the server's own limits. */
export const BATCH = 64;
export const TEXT_LIMIT = 5000;

/** `post` sends one batch; `gapMs` is how long a move or a turn of the
 * wheel waits for the next one to join it. */
export function screenInput(post: (events: ScreenEvent[]) => Promise<unknown>, { gapMs = 40 }: { gapMs?: number } = {}): InputSender {
  const queue: ScreenEvent[] = [];
  let busy = false;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const schedule = (ms: number) => {
    if (timer !== undefined || stopped) return;
    timer = setTimeout(() => {
      timer = undefined;
      void flush();
    }, ms);
  };
  const flush = async () => {
    if (busy || stopped || queue.length === 0) return;
    busy = true;
    const batch = queue.splice(0, BATCH);
    try {
      await post(batch);
    } catch {
      // A batch the line dropped is gone, as a click lost on any remote
      // screen is; the next one goes on from where things are.
    }
    busy = false;
    if (queue.length) schedule(0);
  };
  const push = (event: ScreenEvent, ms: number) => {
    if (stopped) return;
    queue.push(event);
    schedule(ms);
  };

  return {
    mouse(input) {
      const last = queue[queue.length - 1];
      if (input.type === "move" && last?.t === "mouse" && last.type === "move") {
        queue[queue.length - 1] = { t: "mouse", ...input };
        return schedule(gapMs);
      }
      push({ t: "mouse", ...input }, input.type === "move" ? gapMs : 0);
    },
    wheel(input) {
      const last = queue[queue.length - 1];
      if (last?.t === "wheel") {
        queue[queue.length - 1] = { ...last, x: input.x, y: input.y, dx: last.dx + input.dx, dy: last.dy + input.dy, mods: input.mods };
        return schedule(gapMs);
      }
      push({ t: "wheel", ...input }, gapMs);
    },
    key(input) {
      push({ t: "key", ...input }, 0);
    },
    text(text) {
      for (let at = 0; at < text.length; at += TEXT_LIMIT) push({ t: "text", text: text.slice(at, at + TEXT_LIMIT) }, 0);
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
      queue.length = 0;
    },
  };
}
