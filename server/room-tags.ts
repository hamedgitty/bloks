/**
 * Room lines addressed to an agent while it was mid-turn. Skipping a busy
 * agent used to drop the line: it was in the transcript, nobody woke for
 * it, and the room read as the agent choosing not to answer. Delivered
 * when the agent is free.
 *
 * Lines wait per agent, room and requester. Lines from one requester in
 * one room join into one turn; lines from different requesters never do,
 * because who asked decides whose approvals a turn runs under and whose
 * spend it is booked to (a member's line must not ride on the owner's).
 *
 * Given a file, they are kept on disk as well, the way a lane's queued
 * messages are kept in its transcript, so a restart does not lose them:
 * above all one Bloks drained for (server/drain.ts), which holds every
 * room line until it is back. Read back only within the window a queued
 * message has (MAX_QUEUED_RECOVERY_MS), for the same reason: waiting is
 * not standing permission to act.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { MAX_LINES_PER_WAIT, MAX_MESSAGE_CHARS, MAX_QUEUED_RECOVERY_MS, MAX_WAITING_ROOM_LINES } from "./limits.ts";

export interface WaitingLines {
  roomId: string;
  /** "owner" or a person id, as startTurn reads it. */
  requester: string;
  texts: string[];
  /** Where the chain stood when the agent was named, for the hop limit. */
  hops: number;
}

function clean(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value ? value.slice(0, max) : undefined;
}

export class RoomTagQueues {
  private byAgent = new Map<string, Map<string, WaitingLines>>();
  /** When each wait began, by agent and key, for the window on reading back. */
  private since = new Map<string, number>();
  private readonly file?: string;

  constructor(file?: string, now = Date.now()) {
    this.file = file;
    if (!file) return;
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      if (!Array.isArray(parsed)) return;
      for (const raw of parsed.slice(0, MAX_WAITING_ROOM_LINES)) {
        const r = (raw ?? {}) as Record<string, unknown>;
        const botId = clean(r.botId, 64);
        const roomId = clean(r.roomId, 64);
        const requester = clean(r.requester, 64);
        const at = typeof r.at === "number" ? r.at : NaN;
        if (!botId || !roomId || !requester || !(now - at <= MAX_QUEUED_RECOVERY_MS && at <= now)) continue;
        const texts = (Array.isArray(r.texts) ? r.texts : [])
          .map((text) => clean(text, MAX_MESSAGE_CHARS))
          .filter((text): text is string => Boolean(text))
          .slice(0, MAX_LINES_PER_WAIT);
        if (!texts.length) continue;
        const hops = typeof r.hops === "number" && r.hops >= 0 ? Math.floor(r.hops) : 0;
        const lines = this.byAgent.get(botId) ?? new Map<string, WaitingLines>();
        const key = JSON.stringify([roomId, requester]);
        lines.set(key, { roomId, requester, texts, hops });
        this.byAgent.set(botId, lines);
        this.since.set(JSON.stringify([botId, key]), at);
      }
    } catch {
      /* nothing was waiting */
    }
  }

  /** The whole list, rewritten through a temporary file so a crash
   * mid-write leaves the old one. */
  private save() {
    if (!this.file) return;
    const out: unknown[] = [];
    for (const [botId, lines] of this.byAgent) {
      for (const [key, entry] of lines) {
        out.push({ botId, ...entry, texts: entry.texts.slice(0, MAX_LINES_PER_WAIT), at: this.since.get(JSON.stringify([botId, key])) });
      }
    }
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      const temp = `${this.file}.tmp`;
      writeFileSync(temp, JSON.stringify(out.slice(-MAX_WAITING_ROOM_LINES)), { mode: 0o600 });
      renameSync(temp, this.file);
    } catch {
      /* losing this costs the lines a restart, as before there was a file */
    }
  }

  add(botId: string, roomId: string, text: string, requester: string | undefined, hops: number, now = Date.now()) {
    const who = requester ?? "owner";
    const lines = this.byAgent.get(botId) ?? new Map<string, WaitingLines>();
    const key = JSON.stringify([roomId, who]);
    const entry = lines.get(key) ?? { roomId, requester: who, texts: [], hops: 0 };
    if (!entry.texts.includes(text)) entry.texts.push(text);
    entry.hops = Math.max(entry.hops, hops);
    lines.set(key, entry);
    this.byAgent.set(botId, lines);
    const at = JSON.stringify([botId, key]);
    if (!this.since.has(at)) this.since.set(at, now);
    this.save();
  }

  /** An agent's waiting lines, oldest first. */
  of(botId: string): WaitingLines[] {
    return [...(this.byAgent.get(botId)?.values() ?? [])];
  }

  /** Agents with lines waiting. */
  agents(): string[] {
    return [...this.byAgent.keys()];
  }

  /** Claim one entry, before any async work, so two settles fire it once. */
  take(botId: string, entry: WaitingLines) {
    const lines = this.byAgent.get(botId);
    if (!lines) return;
    const key = JSON.stringify([entry.roomId, entry.requester]);
    lines.delete(key);
    this.since.delete(JSON.stringify([botId, key]));
    if (!lines.size) this.byAgent.delete(botId);
    this.save();
  }
}
