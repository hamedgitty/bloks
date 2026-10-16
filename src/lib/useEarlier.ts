// History pages belong to one visit to one conversation. A late answer
// from an earlier visit must not change its replacement's rows or latch.
import { useEffect, useRef, useState } from "react";
import { api, useStore, type Message } from "@/state/store";
import { earlierPrefix } from "./transcript";

export function useEarlier(
  kind: "bot" | "room",
  target: { id: string; threadId: string; messages: Message[]; olderMessages?: number },
) {
  const { dispatch } = useStore();
  const key = `${kind}:${target.id}:${target.threadId}`;
  const visit = useRef({ key, active: true, generation: 0, request: null as AbortController | null });
  if (visit.current.key !== key) visit.current = { key, active: true, generation: 0, request: null };
  const life = visit.current;
  const latest = useRef(target);
  latest.current = target;
  const [, setLoading] = useState<typeof life | null>(null);
  useEffect(() => {
    life.active = true;
    if (!life.request) setLoading(null);
    return () => {
      life.active = false;
      life.generation++;
      life.request?.abort();
      life.request = null;
    };
  }, [life]);

  const cancel = () => {
    if (visit.current !== life || !life.request) return;
    life.generation++;
    life.request.abort();
    life.request = null;
    setLoading(null);
  };

  const load = async (beforePrepend?: (firstId: string) => void): Promise<boolean> => {
    if (!life.active || visit.current !== life || life.request) return false;
    const request = new AbortController();
    const generation = life.generation;
    const current = () => visit.current === life && life.active && life.generation === generation && life.request === request;
    life.request = request;
    setLoading(life);
    const query = new URLSearchParams();
    const first = target.messages[0];
    if (first) query.set("before", first.id);
    if (kind === "bot") query.set("thread", target.threadId);
    try {
      const page = await api(`/api/${kind === "bot" ? "bots" : "bloks"}/${target.id}/messages?${query}`, { signal: request.signal });
      if (!current()) return false;
      const messages: Message[] = Array.isArray(page.messages) ? page.messages : [];
      const fresh = earlierPrefix(messages, latest.current.messages, first?.id);
      if (fresh.length) beforePrepend?.(fresh[0].id);
      dispatch({
        type: "earlierLoaded",
        id: target.id,
        threadId: target.threadId,
        messages: fresh,
        olderMessages: typeof page.olderMessages === "number" ? page.olderMessages : 0,
      });
      return fresh.length > 0;
    } catch (e) {
      if (current() && !request.signal.aborted) {
        dispatch({ type: "error", message: e instanceof Error ? e.message : String(e) });
      }
      return false;
    } finally {
      if (current()) {
        life.request = null;
        setLoading(null);
      }
    }
  };
  return { remaining: target.olderMessages ?? 0, loading: Boolean(life.request), load, cancel };
}
