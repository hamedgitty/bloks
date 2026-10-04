// Earlier messages that never came down.
//
// Through Bloks Cloud a transcript arrives as its newest part, because the
// relay carries only so much in one answer. What stayed on the computer is
// counted in `olderMessages` and fetched a page at a time from here, when
// somebody actually scrolls up for it.
import { useRef, useState } from "react";
import { api, useStore, type Message } from "@/state/store";

export function useEarlier(
  kind: "bot" | "room",
  target: { id: string; threadId: string; messages: Message[]; olderMessages?: number },
) {
  const { dispatch } = useStore();
  const [loading, setLoading] = useState(false);
  // state alone lags a render behind, and scrolling fires many times in
  // one; this is what keeps it to one page at a time
  const inFlight = useRef(false);
  const load = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    const query = new URLSearchParams();
    const first = target.messages[0];
    if (first) query.set("before", first.id);
    if (kind === "bot") query.set("thread", target.threadId);
    try {
      const page = await api(`/api/${kind === "bot" ? "bots" : "bloks"}/${target.id}/messages?${query}`);
      dispatch({
        type: "earlierLoaded",
        id: target.id,
        threadId: target.threadId,
        messages: Array.isArray(page.messages) ? page.messages : [],
        olderMessages: typeof page.olderMessages === "number" ? page.olderMessages : 0,
      });
    } catch (e) {
      dispatch({ type: "error", message: e instanceof Error ? e.message : String(e) });
      setTimeout(() => dispatch({ type: "error", message: null }), 6000);
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  };
  return { remaining: target.olderMessages ?? 0, loading, load };
}
