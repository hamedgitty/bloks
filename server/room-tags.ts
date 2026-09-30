/**
 * Room lines addressed to an agent while it was mid-turn. Skipping a busy
 * agent used to drop the line: it was in the transcript, nobody woke for
 * it, and the room read as the agent choosing not to answer. Kept in
 * memory like a busy lane's queued messages, and delivered when the agent
 * is free.
 *
 * Lines wait per agent, room and requester. Lines from one requester in
 * one room join into one turn; lines from different requesters never do,
 * because who asked decides whose approvals a turn runs under and whose
 * spend it is booked to (a member's line must not ride on the owner's).
 */
export interface WaitingLines {
  roomId: string;
  /** "owner" or a person id, as startTurn reads it. */
  requester: string;
  texts: string[];
  /** Where the chain stood when the agent was named, for the hop limit. */
  hops: number;
}

export class RoomTagQueues {
  private byAgent = new Map<string, Map<string, WaitingLines>>();

  add(botId: string, roomId: string, text: string, requester: string | undefined, hops: number) {
    const who = requester ?? "owner";
    const lines = this.byAgent.get(botId) ?? new Map<string, WaitingLines>();
    const key = JSON.stringify([roomId, who]);
    const entry = lines.get(key) ?? { roomId, requester: who, texts: [], hops: 0 };
    if (!entry.texts.includes(text)) entry.texts.push(text);
    entry.hops = Math.max(entry.hops, hops);
    lines.set(key, entry);
    this.byAgent.set(botId, lines);
  }

  /** An agent's waiting lines, oldest first. */
  of(botId: string): WaitingLines[] {
    return [...(this.byAgent.get(botId)?.values() ?? [])];
  }

  /** Claim one entry, before any async work, so two settles fire it once. */
  take(botId: string, entry: WaitingLines) {
    const lines = this.byAgent.get(botId);
    if (!lines) return;
    lines.delete(JSON.stringify([entry.roomId, entry.requester]));
    if (!lines.size) this.byAgent.delete(botId);
  }
}
