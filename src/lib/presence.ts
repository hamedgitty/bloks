// Whether the person is using Bloks in this window, said to its server.
//
// While they are, their phone stays quiet: no notifications, and no new
// Live Activities (server/presence.ts). In use is strict: this window is
// shown and focused, on a computer with a fine pointer (a phone's browser
// is a phone, not a desk), and the person has typed, clicked, scrolled or
// moved the pointer here within the last two minutes. Said again every
// thirty seconds while that holds, and said to be over the moment it does
// not: hidden, blurred, idle, the window gone. A computer that sleeps
// stops saying it, and the server stops believing it soon after. Nothing
// about what the person was doing leaves the window, only yes or no.
import { useEffect, useRef } from "react";

/** The server's own numbers (PRESENCE_EVERY_MS, PRESENCE_IDLE_MS). */
export const PRESENCE_EVERY_MS = 30_000;
export const PRESENCE_IDLE_MS = 120_000;

/** Input that counts as the person being here. Pointer moves are many, so
 * they are heard at most once a second. */
const INPUT_EVENTS = ["keydown", "pointerdown", "wheel", "touchstart"] as const;

/** Whether this window is in use right now, by the rule at the top. */
export function inUse(page: { visible: boolean; focused: boolean; finePointer: boolean; lastInput: number; now: number }): boolean {
  return page.visible && page.focused && page.finePointer && page.now - page.lastInput < PRESENCE_IDLE_MS;
}

function newWindowId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return `p-${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Says whether this window is in use. `post` sends one word; a server too
 * old to hear it (404), or one this window is not the owner's screen on
 * (403), is not asked again until the page reloads.
 */
export function usePresenceReport(post: (body: { window: string; active: boolean; seq: number }) => Promise<unknown>) {
  const postRef = useRef(post);
  postRef.current = post;

  useEffect(() => {
    const id = newWindowId();
    let seq = 0;
    let deaf = false;
    let last: boolean | null = null;
    // the page opening is the person's doing
    let lastInput = Date.now();
    let lastMove = 0;
    const fine = typeof matchMedia === "function" ? matchMedia("(any-pointer: fine)") : null;
    const now = () =>
      inUse({
        visible: document.visibilityState === "visible",
        focused: document.hasFocus(),
        finePointer: fine ? fine.matches : true,
        lastInput,
        now: Date.now(),
      });
    const say = (beat = false) => {
      if (deaf) return;
      const active = now();
      // a word that changes nothing goes only as the heartbeat of a
      // window still in use
      if (active === last && !(beat && active)) return;
      if (!active && last === null) {
        last = false;
        return;
      }
      last = active;
      seq += 1;
      void postRef.current({ window: id, active, seq }).catch((error: unknown) => {
        const status = (error as { status?: unknown })?.status;
        if (status === 404 || status === 403) deaf = true;
      });
    };
    const input = () => {
      const was = Date.now() - lastInput >= PRESENCE_IDLE_MS;
      lastInput = Date.now();
      // back from idle: said now, not at the next beat
      if (was || last !== true) say();
    };
    const moved = () => {
      const at = Date.now();
      if (at - lastMove < 1000) return;
      lastMove = at;
      input();
    };
    const changed = () => say();
    say();
    // the beat, and the one place idleness is noticed
    const beat = setInterval(() => say(true), PRESENCE_EVERY_MS);
    const idle = setInterval(() => say(), 10_000);
    for (const kind of INPUT_EVENTS) window.addEventListener(kind, input, { passive: true, capture: true });
    window.addEventListener("pointermove", moved, { passive: true, capture: true });
    window.addEventListener("focus", changed);
    window.addEventListener("blur", changed);
    document.addEventListener("visibilitychange", changed);
    return () => {
      clearInterval(beat);
      clearInterval(idle);
      for (const kind of INPUT_EVENTS) window.removeEventListener(kind, input, { capture: true });
      window.removeEventListener("pointermove", moved, { capture: true });
      window.removeEventListener("focus", changed);
      window.removeEventListener("blur", changed);
      document.removeEventListener("visibilitychange", changed);
      // the window going away, or this workspace leaving it
      if (last && !deaf) {
        seq += 1;
        void postRef.current({ window: id, active: false, seq }).catch(() => {});
      }
    };
  }, []);
}
