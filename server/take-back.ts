import type { BotRecord, Message, Store } from "./store.ts";

export interface WaitingQueue {
  botId: string;
  items: Array<{ messageId?: string; text?: string; source?: "webhook"; chain?: number }>;
}

export interface TakenBackMessage {
  id: string;
  laneId: string;
  text: string;
}

/** Only words still owned by the queue can be taken back. A continuation
 * that has already claimed its segment is past this boundary, even while
 * its transcript still says queued. Selection and all tombstones are one
 * synchronous operation, before closing an editor can drain another lane. */
export function takeBackWaiting({ store, queues, caller, callerLaneId, recipient, patched, editClosed }: {
  store: Pick<Store, "messagesFor" | "patchMessages" | "appendMessage">;
  queues: ReadonlyMap<string, WaitingQueue>;
  caller: BotRecord;
  callerLaneId: string;
  recipient: BotRecord;
  patched: (laneId: string, message: Message) => void;
  editClosed: (laneId: string, messageId: string) => void;
}) {
  const ours = (m: Message) => m.role === "user" && m.agent?.dir === "in" &&
    m.agent.peerId === caller.id && m.queued && !m.deleted && !m.unsent && Boolean(m.text);
  const waiting = new Map(recipient.tasks.map((lane) => [lane.id, store.messagesFor(lane.id).filter(ours)]));
  const selected = new Map<string, TakenBackMessage[]>();
  let notTakenBack = 0;
  for (const laneId of new Set([...queues.keys(), ...waiting.keys()])) {
    const messages = waiting.get(laneId);
    if (!messages) continue;
    const entry = queues.get(laneId);
    const ids = new Set<string>();
    const words: TakenBackMessage[] = [];
    if (entry?.botId === recipient.id) {
      for (const item of entry.items) {
        const message = messages.find((m) => m.id === item.messageId);
        if (!message || ids.has(message.id)) continue;
        ids.add(message.id);
        words.push({ id: message.id, laneId, text: message.text! });
      }
    }
    notTakenBack += messages.filter((m) => !ids.has(m.id)).length;
    if (words.length) selected.set(laneId, words);
  }

  const takenBack: TakenBackMessage[] = [];
  let failed = 0;
  for (const [laneId, words] of selected) {
    let changes: Message[];
    try {
      // The same tombstone as the person's DELETE, once per lane. If the
      // write throws, memory may already be changed but disk can restore
      // the words on restart, so that lane must never be called taken back.
      changes = store.patchMessages(laneId, words.map((m) => m.id), () => ({
        deleted: true, text: "", card: undefined, artifact: undefined, png: undefined, component: undefined,
      }));
    } catch {
      failed += words.length;
      notTakenBack += words.length;
      continue;
    }
    takenBack.push(...words);
    for (const message of changes) patched(laneId, message);
  }
  // editClosed may drain, so every lane's tombstone must precede it.
  for (const message of takenBack) editClosed(message.laneId, message.id);

  let recorded = false;
  if (takenBack.length && caller.tasks.some((lane) => lane.id === callerLaneId)) {
    try {
      const row = store.appendMessage(callerLaneId, {
        role: "bot", kind: "activity",
        text: takenBack.map((m) => m.text).join("\n\n"),
        takeBack: { peerId: recipient.id, peerName: recipient.name, messages: takenBack },
      });
      recorded = true;
      patched(callerLaneId, row);
    } catch {
      // The words were already removed; a missing record cannot undo that.
    }
  }

  let note = takenBack.length
    ? `Took back ${takenBack.length} waiting message${takenBack.length === 1 ? "" : "s"} to ${recipient.name}. Send again anything that still stands.`
    : "Nothing was taken back. The recipient's turn may already have these messages. Send a correction instead.";
  if (notTakenBack) note += ` ${notTakenBack} message${notTakenBack === 1 ? " was" : "s were"} not taken back.`;
  if (failed) note += " A file write failed; those messages may return on restart. Send a correction instead.";
  else if (notTakenBack && takenBack.length) note += " The recipient's turn may already have them. Send a correction instead.";
  if (takenBack.length && !recorded) note += " The take-back is done, but its row in your conversation could not be saved.";
  return { ok: takenBack.length > 0 && notTakenBack === 0, takenBack, notTakenBack, recorded, note };
}
