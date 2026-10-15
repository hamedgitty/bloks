import type { Message } from "../state/reducer.js";

type Api = (path: string, init?: RequestInit) => Promise<any>;

export interface MessageSend {
  botId: string;
  text: string;
  replyTo?: Message["replyTo"];
  taskId?: string;
  stopFirst?: boolean;
}

/** Modifier-Enter stops before submitting, and never joins the dying turn.
 * Stop acknowledges the request, not necessarily the engine's exit, so the
 * follow-up waits in the normal queue until that turn has actually ended.
 * Capture its lane and words before waiting: the person may change either
 * on screen meanwhile. Errors go to the caller's normal draft recovery. */
export async function sendMessage(api: Api, ref: MessageSend): Promise<any> {
  const { botId, taskId, stopFirst } = ref;
  const lane = taskId ? { taskId } : {};
  const body = JSON.stringify({
    text: ref.text,
    replyTo: ref.replyTo,
    ...lane,
    ...(stopFirst ? { steer: false } : {}),
  });
  if (stopFirst) {
    await api(`/api/bots/${botId}/interrupt`, { method: "POST", body: JSON.stringify(lane) });
  }
  return api(`/api/bots/${botId}/messages`, { method: "POST", body });
}
