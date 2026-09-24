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
import type { ChatLink } from "./chat-bridge.ts";

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
  /** The sidebar heading this room files under. One namespace shared
   * with agents; absent or null means the plain Rooms list. */
  section?: string | null;
  /** The room's shared desk. Every member's room turn runs here instead
   * of in its own folder. Three states matter: undefined = never
   * dispatched, null = each member keeps its own, a path = the desk. */
  cwd?: string;
  /** What turns actually use, fixed at the room's first dispatch:
   * engines key their sessions to the folder a thread starts in. */
  pinnedCwd?: string | null;
  createdAt: number;
  /** Present once the owner has shared the room with other people. The
   * people themselves live in server/people.ts; this is how the room
   * behaves while they are in it. */
  sharing?: RoomSharing;
  /** The lane each agent speaks in while the room is shared, by agent id.
   * A shared room never uses an agent's ordinary lanes: those carry
   * everything the owner said in private, and a member could otherwise
   * ask the agent to repeat it. See startTurn. */
  lanes?: Record<string, string>;
}

/** What members of a shared room can see and do, set by the owner. */
export interface RoomSharing {
  since: number;
  /** "join": members see the room from when they joined. "all": from
   * the start. Flippable at any time; it applies to current members. */
  history: "join" | "all";
  /** Whether collaborators may send invites. The owner still lets every
   * joiner in; this only changes who can start one. */
  collaboratorsInvite: boolean;
  /** Whether members see what agents' tools did, beyond the tool's kind. */
  activityDetail: boolean;
  /** What agents may do in this room. "conversation": nothing but talk.
   * "desk": read and write files in the room's own desk folder. */
  tools: "conversation" | "desk";
  /** Agents whose private memory the owner has let into this room. */
  memoryFor?: string[];
  /** The owner's own tools this room's agents may reach, each switched on
   * by name. Every call a member's message leads to still waits for an
   * approval; this decides what can be asked for at all. */
  ownerTools?: OwnerTools;
  /** Whether collaborators may answer approvals in this room, except on
   * actions they asked for themselves. */
  collaboratorsApprove?: boolean;
  /** US dollars a month this room's agents may spend before they pause.
   * 0 means no cap. */
  spendCap?: number;
  /** What this room has spent this month, and on whose behalf. */
  spend?: RoomSpend;
  /** The chat channel this room is carried into, if any. */
  chat?: ChatLink;
}

export interface OwnerTools {
  /** The owner's connected apps. */
  connectors?: boolean;
  /** MCP servers from the owner's settings, by id. */
  mcp?: string[];
  /** A browser of the room's own, not the owner's profile. */
  browser?: boolean;
  /** The owner's computer, or its cloud computer. */
  computer?: boolean;
}

export interface RoomSpend {
  /** YYYY-MM, local time. A new month starts from nothing. */
  month: string;
  total: number;
  /** Person id, or "owner", to dollars. */
  byPerson: Record<string, number>;
  /** Whether the owner has been told the room is near its cap. */
  warned?: boolean;
}

/** A cap that keeps a busy room from surprising its owner. Editable, and
 * 0 turns it off. */
export const DEFAULT_SPEND_CAP = 10;

export function spendMonth(at: Date = new Date()): string {
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}`;
}

/** This month's spend, which is nothing when the ledger is from an
 * earlier month. */
export function currentSpend(sharing: RoomSharing, at: Date = new Date()): RoomSpend {
  const month = spendMonth(at);
  return sharing.spend?.month === month ? sharing.spend : { month, total: 0, byPerson: {} };
}

export const DEFAULT_SHARING = (): RoomSharing => ({
  since: Date.now(),
  history: "join",
  collaboratorsInvite: false,
  activityDetail: false,
  tools: "conversation",
  spendCap: DEFAULT_SPEND_CAP,
});

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
    patch: Partial<Pick<BlokRecord, "name" | "memberIds" | "leadOnly" | "cwd" | "archived" | "section">>,
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
    if ("section" in patch) blok.section = patch.section ?? undefined;
    this.save();
    return blok;
  }

  /** Starts sharing a room, or updates how it is shared. */
  share(id: string, patch: Partial<Omit<RoomSharing, "since">>): BlokRecord | null {
    const blok = this.get(id);
    if (!blok) return null;
    const current = blok.sharing ?? DEFAULT_SHARING();
    const next: RoomSharing = { ...current };
    if (patch.history === "join" || patch.history === "all") next.history = patch.history;
    if (typeof patch.collaboratorsInvite === "boolean") next.collaboratorsInvite = patch.collaboratorsInvite;
    if (typeof patch.activityDetail === "boolean") next.activityDetail = patch.activityDetail;
    if (patch.tools === "conversation" || patch.tools === "desk") next.tools = patch.tools;
    if (Array.isArray(patch.memoryFor)) {
      next.memoryFor = patch.memoryFor.filter((x) => typeof x === "string" && blok.memberIds.includes(x));
    }
    if (patch.ownerTools && typeof patch.ownerTools === "object") {
      const t = patch.ownerTools;
      next.ownerTools = {
        connectors: t.connectors === true,
        browser: t.browser === true,
        computer: t.computer === true,
        mcp: Array.isArray(t.mcp) ? t.mcp.filter((x) => typeof x === "string").slice(0, 50) : [],
      };
    }
    if (typeof patch.collaboratorsApprove === "boolean") next.collaboratorsApprove = patch.collaboratorsApprove;
    if (typeof patch.spendCap === "number" && Number.isFinite(patch.spendCap)) {
      next.spendCap = Math.min(10_000, Math.max(0, Math.round(patch.spendCap * 100) / 100));
    }
    blok.sharing = next;
    this.save();
    return blok;
  }

  /** Adds what one turn cost to the room's month, against whoever asked
   * for it. Returns the month so far. */
  noteSpend(id: string, who: string, usd: number, at: Date = new Date()): RoomSpend | null {
    const blok = this.get(id);
    if (!blok?.sharing || !(usd > 0)) return null;
    const spend = { ...currentSpend(blok.sharing, at) };
    spend.byPerson = { ...spend.byPerson, [who]: (spend.byPerson[who] ?? 0) + usd };
    spend.total += usd;
    blok.sharing = { ...blok.sharing, spend };
    this.save();
    return spend;
  }

  /** Links a shared room to a chat channel, or unlinks it with null. */
  setChat(id: string, link: ChatLink | null): BlokRecord | null {
    const blok = this.get(id);
    if (!blok?.sharing) return null;
    const next = { ...blok.sharing };
    if (link) next.chat = { platform: link.platform, channelId: link.channelId, channelName: link.channelName, declined: [] };
    else delete next.chat;
    blok.sharing = next;
    this.save();
    return blok;
  }

  /** Remembers a chat account the owner turned away from this room. */
  declineChat(id: string, userId: string) {
    const blok = this.get(id);
    if (!blok?.sharing?.chat) return;
    const declined = [...new Set([...(blok.sharing.chat.declined ?? []), userId])].slice(-500);
    blok.sharing = { ...blok.sharing, chat: { ...blok.sharing.chat, declined } };
    this.save();
  }

  /** The shared room linked to a channel, if any. */
  byChannel(platform: string, channelId: string): BlokRecord | null {
    return this.bloks.find((b) => b.sharing?.chat?.platform === platform && b.sharing.chat.channelId === channelId) ?? null;
  }

  markSpendWarned(id: string) {
    const blok = this.get(id);
    if (!blok?.sharing?.spend) return;
    blok.sharing = { ...blok.sharing, spend: { ...blok.sharing.spend, warned: true } };
    this.save();
  }

  /** Stops sharing. The lanes are kept, not merged back: what was said in
   * the shared room stays out of the agents' private conversations. */
  unshare(id: string): BlokRecord | null {
    const blok = this.get(id);
    if (!blok) return null;
    delete blok.sharing;
    this.save();
    return blok;
  }

  setLane(id: string, botId: string, laneId: string) {
    const blok = this.get(id);
    if (!blok) return;
    blok.lanes = { ...(blok.lanes ?? {}), [botId]: laneId };
    this.save();
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
