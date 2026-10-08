// The return address of a Telegram message held while Bloks drains.
// It belongs to that queued request, never to later turns in the lane.
import type { Message, Store } from "./store.ts";
import { send, TelegramError, type TelegramState } from "./telegram.ts";

export interface TelegramReply {
  chatId: number;
  state: "queued" | "bound" | "sending" | "sent" | "failed" | "uncertain";
  /** Last message at the consuming turn's start. A carryOn notice is
   * stable even when its queued inputs are moved after dispatch. */
  after?: string;
  parts?: number;
}

export const queuedTelegramReply = (chatId: number): TelegramReply => ({ chatId, state: "queued" });

export class TelegramReturns {
  private store: Store;
  private state: () => TelegramState;
  private changed: (laneId: string, message: Message) => void;
  private notice: (laneId: string, text: string) => void;
  private sends = new Set<Promise<void>>();

  constructor(
    store: Store,
    state: () => TelegramState,
    changed: (laneId: string, message: Message) => void,
    notice: (laneId: string, text: string) => void,
  ) {
    this.store = store;
    this.state = state;
    this.changed = changed;
    this.notice = notice;
  }

  get busy() { return this.sends.size > 0; }

  private requests(laneId: string) {
    return this.store.messagesFor(laneId).filter((m) =>
      m.role === "user" && m.kind === "text" && !m.deleted && !m.unsent && m.telegramReply,
    );
  }

  private patch(laneId: string, requests: Message[], patch: Partial<TelegramReply>) {
    const changed = this.store.patchMessages(laneId, requests.map((m) => m.id), (message) => ({
      telegramReply: { ...message.telegramReply!, ...patch },
    }));
    for (const message of changed) this.changed(laneId, message);
  }

  /** Before recovering queues or cut-off turns. No startup replay of a
   * send that may have reached Telegram, or an answer with no owning turn. */
  recover(willContinue: (laneId: string) => boolean) {
    for (const bot of this.store.bots) for (const lane of bot.tasks) {
      for (const message of this.requests(lane.id)) {
        const reply = message.telegramReply!;
        if (reply.state === "sending") {
          this.patch(lane.id, [message], { state: "uncertain" });
          this.notice(lane.id, "Bloks stopped while sending this answer to Telegram. It may have been partly delivered; it has not been sent again.");
        } else if (reply.state === "bound" && !willContinue(lane.id)) {
          this.patch(lane.id, [message], { state: "failed" });
          this.notice(lane.id, "This saved Telegram request has no turn to continue automatically, so its answer was not sent to Telegram.");
        }
      }
    }
  }

  /** Called at turn start, before the engine can speak. Only these
   * queued inputs, or the same request's continuation, gain a return. */
  bind(laneId: string, messageIds: string[] = [], continuing = false) {
    const ids = new Set(messageIds);
    const after = this.store.messagesFor(laneId).at(-1)?.id;
    const requests = this.requests(laneId).filter((message) => {
      const state = message.telegramReply!.state;
      return (state === "queued" && ids.has(message.id)) || (state === "bound" && continuing);
    });
    this.patch(laneId, requests, { state: "bound", after, parts: 0 });
  }

  /** A same-chat follow-up can join this turn without starting a second
   * wait that would send an overlapping copy of the answer. */
  answering(laneId: string, chatId: number) {
    return this.requests(laneId).some((m) => m.telegramReply!.state === "bound" && m.telegramReply!.chatId === chatId);
  }

  finish(laneId: string, failure?: string, messageIds: string[] = []) {
    const ids = new Set(messageIds);
    const requests = this.requests(laneId).filter((m) =>
      m.telegramReply!.state === "bound" || (m.telegramReply!.state === "queued" && ids.has(m.id)),
    );
    const chats = new Set(requests.map((m) => m.telegramReply!.chatId));
    const transcript = this.store.messagesFor(laneId);
    for (const chatId of chats) {
      const group = requests.filter((m) => m.telegramReply!.chatId === chatId);
      const after = group[0].telegramReply!.after;
      const boundary = after ? transcript.findIndex((m) => m.id === after) : -1;
      const text = failure ?? (transcript.slice(boundary + 1)
        .filter((m) => m.role === "bot" && m.kind === "text" && m.text && !m.deleted)
        .map((m) => m.text).join("\n\n").trim() || "(the agent finished without saying anything)");
      // The text is captured before another turn can move the transcript.
      const run = this.say(laneId, group, chatId, text);
      this.sends.add(run);
      void run.finally(() => this.sends.delete(run)).catch((error) => {
        console.error("[bloks] Telegram return could not be recorded:", error);
      });
    }
  }

  private async say(laneId: string, requests: Message[], chatId: number, text: string) {
    const change = (patch: Partial<TelegramReply>) => {
      this.patch(laneId, requests, patch);
    };
    const state = this.state();
    if (!state.enabled || !state.token || !Number.isSafeInteger(chatId) || !state.chatIds?.includes(chatId)) {
      change({ state: "failed" });
      this.notice(laneId, "The answer was not sent to Telegram: Telegram is not configured for the chat that asked. The answer is in the app.");
      return;
    }
    // Synchronous atomic message writes, before any network I/O.
    change({ state: "sending", parts: 0 });
    let parts = 0;
    try {
      await send(state.token, chatId, text, true, () => change({ parts: ++parts }));
      change({ state: "sent", parts });
    } catch (error) {
      const uncertain = !(error instanceof TelegramError);
      change({ state: uncertain ? "uncertain" : "failed", parts });
      const partly = parts > 0 ? " It was partly delivered." : uncertain ? " It may have been delivered." : "";
      this.notice(laneId, `The answer ${uncertain ? "may not have reached" : "was not fully sent to"} Telegram.${partly} It has not been sent again. The answer is in the app.`);
    }
  }
}
