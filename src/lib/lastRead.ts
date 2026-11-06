// Where the person left off in the conversation on screen, and the "New"
// line above what came after (server/last-read.ts).
//
// The place is the server's, per person per conversation, so every screen
// of theirs agrees. This window asks for it once as a conversation opens:
// the answer is where the line goes, and the line then stays put until
// they send or leave, however much arrives while they read. From then on
// it says how far they have read, while the window is in front and
// focused, so a conversation left open on a screen nobody is looking at
// is not read for them.
//
// Shared by the owner's chat and a member's app, which post to different
// routes; both hand their call in here.
import { useCallback, useEffect, useReducer, useRef } from "react";

/** How long the end of a conversation has to hold still before it is
 * said: a burst of tool calls is one word, not twenty. */
const SETTLE_MS = 400;

const looking = () => document.visibilityState === "visible" && document.hasFocus();

/** One stay in a conversation, from opening it to leaving it. Kept out of
 * the component: the chat is drawn again from scratch now and then (a
 * phone's drawer closing, a window crossing a width), and asking again
 * then would find the place already read on and lose the line. Leaving
 * is opening another conversation or another place in the panel
 * (leftConversation), so one visit is all there is. */
type Visit = { key: string; opened: boolean; said?: string; held: boolean; from: string | null };
let visit: Visit | null = null;

const visitFor = (key: string): Visit => {
  if (visit?.key !== key) visit = { key, opened: false, held: false, from: null };
  return visit;
};

/** The chat gave the panel to something else (a room, Settings, a page):
 * that is leaving too, so coming back is a new visit that asks for the
 * place again, rather than the old one that already read on past it. */
export function leftConversation(): void {
  visit = null;
}

export function useLastRead({
  key,
  threadId,
  lastId,
  ready,
  post,
}: {
  /** Changes when another conversation opens: the line is per visit. */
  key: string;
  threadId: string | null;
  /** The newest message in the conversation as this window has it. */
  lastId: string | undefined;
  /** The conversation's messages are in hand, so the opening is real. */
  ready: boolean;
  /** Says the place, read on to `through` when given, and answers where
   * the line goes from the place as it was. */
  post: (threadId: string, through?: string) => Promise<{ from?: string | null } | null | undefined>;
}) {
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const here = visitFor(key);
  const postRef = useRef(post);
  postRef.current = post;
  const lastRef = useRef(lastId);
  lastRef.current = lastId;

  // Reading on, while the window is in front: the newest message, once it
  // has held still a moment. Never while the person keeps it unread.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const readOn = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const now = visitFor(key);
      const through = lastRef.current;
      if (!threadId || !now.opened || now.held || !through || now.said === through || !looking()) return;
      now.said = through;
      void postRef.current(threadId, through).catch(() => {
        if (now.said === through) now.said = undefined;
      });
    }, SETTLE_MS);
  }, [key, threadId]);

  // Opening: where they left off, asked before anything moves it.
  useEffect(() => {
    const now = visitFor(key);
    if (!ready || !threadId || now.opened) return;
    now.opened = true;
    const through = looking() ? lastRef.current : undefined;
    if (through) now.said = through;
    void postRef
      .current(threadId, through)
      .then((answer) => {
        // a mark made while the question was out is the person's word
        if (visit !== now || now.held) return;
        now.from = typeof answer?.from === "string" ? answer.from : null;
        redraw();
        // what arrived while the question was out is read once it is in
        readOn();
      })
      .catch(() => {
        // no line rather than a wrong one; reading on still says where
      });
  }, [key, threadId, ready]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    readOn();
  }, [lastId, readOn]);
  useEffect(() => {
    window.addEventListener("focus", readOn);
    document.addEventListener("visibilitychange", readOn);
    return () => {
      if (timer.current) clearTimeout(timer.current);
      window.removeEventListener("focus", readOn);
      document.removeEventListener("visibilitychange", readOn);
    };
  }, [readOn]);

  /** Marked unread from a message: the line goes above it at once, and
   * nothing more is read for them until they send or leave. */
  const markFrom = useCallback(
    (messageId: string) => {
      const now = visitFor(key);
      now.held = true;
      now.from = messageId;
      redraw();
    },
    [key],
  );
  /** They said something: whatever was new is read. */
  const clear = useCallback(() => {
    const now = visitFor(key);
    now.held = false;
    if (now.from === null) return;
    now.from = null;
    redraw();
  }, [key]);

  return { from: here.from, markFrom, clear };
}
