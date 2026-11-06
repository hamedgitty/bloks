// Where each person left off in each conversation: the last message they
// had read, per person per conversation, the owner included (as "owner").
// What the "New" line in a transcript is drawn from.
//
// Not "Seen by" (server/reads.ts). That one is shown to the others in a
// room or a team conversation and only ever moves forward. This one is
// the person's own business: nothing here is ever sent to anybody but
// the person it belongs to, and it moves back when they mark a
// conversation unread from a message, which "Seen by" must never do
// (they did see it).
//
// A place moves forward as the person reads, from any of their screens,
// and an older word arriving late takes nothing back. Only "Mark unread
// from here" moves it back. Agents never write here: the routes that do
// are a person's own.
import { isRecord, readSaved, writeFileAtomic } from "./atomic-write.ts";

/** Where somebody left off: after this message, or before the first
 * one (null) when they marked the whole conversation unread. */
export interface Place {
  after: string | null;
  at: number;
}

type Saved = { version: 1; threads: Record<string, Record<string, Place>> };

const ID = /^[\w-]{1,80}$/;

export class LastRead {
  private data: Saved;

  private readonly file: string;
  private readonly now: () => number;

  constructor(file: string, now: () => number = Date.now) {
    this.file = file;
    this.now = now;
    const raw = readSaved<Partial<Saved>>(file, {}, isRecord);
    const threads: Saved["threads"] = {};
    if (raw.threads && typeof raw.threads === "object") {
      for (const [threadId, byPerson] of Object.entries(raw.threads)) {
        if (!ID.test(threadId) || !byPerson || typeof byPerson !== "object") continue;
        for (const [personId, place] of Object.entries(byPerson)) {
          if (!ID.test(personId) || !place || typeof place.at !== "number") continue;
          if (place.after !== null && (typeof place.after !== "string" || !ID.test(place.after))) continue;
          (threads[threadId] ??= {})[personId] = { after: place.after, at: place.at };
        }
      }
    }
    this.data = { version: 1, threads };
  }

  /** Where one person left off in one conversation, or null when they
   * have not read it since this was kept. */
  of(threadId: string, personId: string): Place | null {
    return this.data.threads[threadId]?.[personId] ?? null;
  }

  /**
   * Somebody has read a conversation up to a message. `order` is the
   * conversation's message ids as they may see them, oldest first. Only
   * forward: true when the place moved, false for an unknown message or
   * one at or before where they already were.
   */
  readTo(threadId: string, personId: string, messageId: string, order: readonly string[]): boolean {
    if (!ID.test(threadId) || !ID.test(personId)) return false;
    const at = order.indexOf(messageId);
    if (at === -1) return false;
    const was = this.of(threadId, personId);
    // a place on a message that is gone says nothing about where they are
    if (was && was.after !== null && order.indexOf(was.after) >= at) return false;
    this.put(threadId, personId, messageId);
    return true;
  }

  /** Read to the end, as sending in a conversation is. */
  readToEnd(threadId: string, personId: string, order: readonly string[]): boolean {
    const last = order[order.length - 1];
    return last ? this.readTo(threadId, personId, last, order) : false;
  }

  /** "Mark unread from here": the place goes to just before a message,
   * back or forward. False for a message that is not there. */
  unreadFrom(threadId: string, personId: string, messageId: string, order: readonly string[]): boolean {
    if (!ID.test(threadId) || !ID.test(personId)) return false;
    const at = order.indexOf(messageId);
    if (at === -1) return false;
    this.put(threadId, personId, at === 0 ? null : order[at - 1]);
    return true;
  }

  /** Somebody left the workspace: where they had read to goes with them. */
  forgetPerson(personId: string) {
    let changed = false;
    for (const byPerson of Object.values(this.data.threads)) {
      if (byPerson[personId]) {
        delete byPerson[personId];
        changed = true;
      }
    }
    if (changed) this.save();
  }

  /** A conversation that is gone, or cleared, takes its places with it. */
  forgetThread(threadId: string) {
    if (!this.data.threads[threadId]) return;
    delete this.data.threads[threadId];
    this.save();
  }

  private put(threadId: string, personId: string, after: string | null) {
    (this.data.threads[threadId] ??= {})[personId] = { after, at: this.now() };
    this.save();
  }

  private save() {
    try {
      writeFileAtomic(this.file, JSON.stringify(this.data), 0o600);
    } catch {
      /* kept in memory; the next move tries again */
    }
  }
}

/** The fields of a message the line is decided from. */
export interface Said {
  id: string;
  role: "bot" | "user";
  kind: string;
  quiet?: boolean;
  deleted?: boolean;
  queued?: boolean;
  compaction?: unknown;
  sessionReset?: boolean;
  agent?: { dir: string };
  via?: string;
  author?: string;
  telegramPerson?: unknown;
  telegramDelegate?: unknown;
  telegramGroup?: unknown;
}

/** Things done to the agent rather than said by somebody: a routine's
 * prompt, a watcher's or a webhook's event, a goal, an intent, an
 * incident, a wake from the service. */
const MACHINES = new Set(["routine", "watcher", "webhook", "goal", "intent", "incident", "service"]);

/** The person's own words, by who they are: the owner's carry no author
 * and came from no chat app; a member's carry theirs. */
export function wroteIt(personId: string): (m: Said) => boolean {
  if (personId === "owner") {
    return (m) => m.role === "user" && !m.author && !m.agent && !m.via && !m.telegramPerson && !m.telegramDelegate && !m.telegramGroup;
  }
  return (m) => m.role === "user" && m.author === personId;
}

/** Part of the conversation as it is read: not a marker the engine left,
 * a quiet check-in, words taken back, or words still waiting to go. */
function inConversation(m: Said): boolean {
  return !m.deleted && !m.quiet && !m.queued && !m.compaction && !m.sessionReset;
}

/** Something worth coming back for, as the unread dot counts it: what
 * the agent said to the person, a card, a file, a notice, or another
 * person's words. Never the agent's tool calls and screens, its messages
 * to and from other agents, or a machine's prompt. */
function news(m: Said): boolean {
  if (m.role === "user") return m.kind === "text" && !m.agent && !(m.via && MACHINES.has(m.via));
  if (m.agent && m.agent.dir !== "reply") return false;
  return m.kind !== "activity" && m.kind !== "screen";
}

/**
 * Where the "New" line goes for somebody at `place`: the id of the first
 * message after it that is not their own (the line sits above that one,
 * so a turn that started while they were away is new from its start),
 * or null when nothing after it is news. Null too when there is no
 * place, or it is on a message no longer there: a line in the wrong
 * spot is worse than none.
 */
export function newFrom(messages: readonly Said[], place: Place | null, mine: (m: Said) => boolean): string | null {
  if (!place) return null;
  const start = place.after === null ? 0 : messages.findIndex((m) => m.id === place.after) + 1;
  if (start === 0 && place.after !== null) return null;
  let from: string | null = null;
  for (let i = start; i < messages.length; i++) {
    const m = messages[i];
    if (!inConversation(m) || mine(m)) continue;
    from ??= m.id;
    if (news(m)) return from;
  }
  return null;
}
