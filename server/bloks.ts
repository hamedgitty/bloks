// Bloks: rooms where more than one agent works.
//
// A solo chat is still just an agent's own thread, so nothing here
// touches the one-to-one case, a room's id doubles as its transcript
// key, exactly like a bot's threadId does, which means solo and group
// transcripts share one storage path.
//
// The important property: an agent's provider session is keyed to the
// agent, not to the room. One agent in three rooms is one continuous
// conversation, so what it heard in a group is still in its memory when
// you message it alone. Rooms decide what enters that conversation; they
// do not fragment it.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { DATA_DIR } from "./config.ts";
import { newId } from "./contracts.ts";

export interface BlokRecord {
  id: string;
  name: string;
  /** Agents in the room. The user is always present implicitly. */
  memberIds: string[];
  /** When set, a message that names nobody wakes only the most senior
   * member instead of the whole room. The lead can still delegate with
   * @name, so the work happens either way; what changes is that six
   * agents stop burning six turns on "thanks everyone". */
  leadOnly?: boolean;
  /** Out of the way, not gone. Archiving a room keeps its transcript and
   * its members so it can come back; only an explicit second decision
   * removes anything. */
  archived?: boolean;
  /** The room's shared desk. Every member's room turn runs here instead
   * of in its own folder. Three states matter: undefined = never
   * dispatched, null = each member keeps its own, a path = the desk. */
  cwd?: string;
  /** What turns actually use, fixed at the room's first dispatch:
   * engines key their sessions to the folder a thread starts in. */
  pinnedCwd?: string | null;
  createdAt: number;
}

const BLOKS_FILE = join(DATA_DIR, "bloks.json");

/** A room can hold a working group, not a crowd; every member sees every
 * message, so cost and noise both scale with membership. */
export const MAX_MEMBERS = 8;

export class BlokStore {
  bloks: BlokRecord[] = [];

  constructor() {
    mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    try {
      this.bloks = JSON.parse(readFileSync(BLOKS_FILE, "utf8"));
    } catch {
      this.bloks = [];
    }
  }

  private save() {
    writeFileSync(BLOKS_FILE, JSON.stringify(this.bloks, null, 2), { mode: 0o600 });
  }

  get(id: string): BlokRecord | null {
    return this.bloks.find((b) => b.id === id) ?? null;
  }

  /** The room's first turn fixes the desk forever; later folder edits
   * are refused upstream. Returns what turns should use. */
  pinCwd(id: string): string | null {
    const blok = this.get(id);
    if (!blok) return null;
    if (blok.pinnedCwd === undefined) {
      blok.pinnedCwd = blok.cwd ?? null;
      this.save();
    }
    return blok.pinnedCwd;
  }

  create(name: string, memberIds: string[]): BlokRecord {
    const blok: BlokRecord = {
      id: newId(),
      name: name.trim() || "New room",
      memberIds: [...new Set(memberIds)].slice(0, MAX_MEMBERS),
      createdAt: Date.now(),
    };
    this.bloks.unshift(blok);
    this.save();
    return blok;
  }

  patch(
    id: string,
    patch: Partial<Pick<BlokRecord, "name" | "memberIds" | "leadOnly" | "cwd" | "archived">>,
  ): BlokRecord | null {
    const blok = this.get(id);
    if (!blok) return null;
    if (typeof patch.name === "string" && patch.name.trim()) blok.name = patch.name.trim();
    if (Array.isArray(patch.memberIds)) {
      blok.memberIds = [...new Set(patch.memberIds)].slice(0, MAX_MEMBERS);
    }
    if (typeof patch.leadOnly === "boolean") blok.leadOnly = patch.leadOnly;
    if (typeof patch.archived === "boolean") blok.archived = patch.archived || undefined;
    if ("cwd" in patch) blok.cwd = patch.cwd ?? undefined;
    this.save();
    return blok;
  }

  remove(id: string): boolean {
    const before = this.bloks.length;
    this.bloks = this.bloks.filter((b) => b.id !== id);
    if (this.bloks.length === before) return false;
    this.save();
    return true;
  }

  /** Drop an agent from every room it belonged to (agent deleted). */
  removeMember(botId: string) {
    let touched = false;
    for (const blok of this.bloks) {
      if (!blok.memberIds.includes(botId)) continue;
      blok.memberIds = blok.memberIds.filter((id) => id !== botId);
      touched = true;
    }
    if (touched) this.save();
  }

  /** Rooms an agent belongs to, for its own awareness of where it works. */
  roomsFor(botId: string): BlokRecord[] {
    return this.bloks.filter((b) => b.memberIds.includes(botId));
  }
}

/**
 * Who a message is addressed to. A bare message goes to the whole room;
 * "@Name" narrows it. Matching is case-insensitive on the agent's name,
 * longest name first so "@Chief of Staff" never resolves as "@Chief".
 */
export function addressees(
  text: string,
  members: Array<{ id: string; name: string }>,
): { ids: string[]; mentioned: boolean } {
  // Longest first, and each match is consumed. Sorting alone is not
  // enough: "@Bobby Tables" still contains "@Bo", so without blanking the
  // span an agent called Bo would be woken by a message aimed at someone
  // else, and would spend a turn saying so.
  let remaining = text.toLowerCase();
  const byLength = [...members].sort((a, b) => b.name.length - a.name.length);
  const hit: string[] = [];
  for (const member of byLength) {
    const needle = `@${member.name.toLowerCase()}`;
    if (!needle.slice(1) || !remaining.includes(needle)) continue;
    hit.push(member.id);
    remaining = remaining.split(needle).join(" ");
  }
  if (hit.length) {
    // report in room order, so the caller's sequencing is not at the
    // mercy of how long people's names happen to be
    const order = new Set(hit);
    return { ids: members.filter((m) => order.has(m.id)).map((m) => m.id), mentioned: true };
  }
  return { ids: members.map((m) => m.id), mentioned: false };
}
