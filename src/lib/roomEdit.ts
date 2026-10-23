// Changing a room after it opened: its name, who is in it, and a fresh
// start with the same team (GitHub 370). The rules live here, apart from
// the dialogs, so the New room dialog and the room's own Agents dialog
// pick members the same way and a test can read them without a screen.
import type { Blok, Bot, NewRoomPreset } from "@/state/reducer";
import { roomLead } from "./roomLead.ts";

/** A room holds a working group, not a crowd (MAX_MEMBERS in
 * server/bloks.ts, which refuses a ninth). */
export const MAX_MEMBERS = 8;
/** One agent alone is a chat, not a room; the server says so too. */
export const MIN_MEMBERS = 2;
/** What a name in a list may run to (MAX_NAME_CHARS in server/limits.ts). */
export const MAX_ROOM_NAME = 80;

/** Whether an agent may be offered for a room: what the server's
 * roomMayHold takes, less the hidden ones. A member's solo agent goes
 * into a room only by its maker's hand, so the owner is never offered it. */
export function mayJoinRoom(bot: Pick<Bot, "hidden" | "solo">): boolean {
  return !bot.hidden && (!bot.solo || bot.solo.by === "owner");
}

/** The agents a picker lists. For a room that exists, its members come
 * first and in its order, whatever they are now (an archived one keeps
 * its seat until someone takes it away); everyone else only if they may
 * join. */
export function roomCandidates<T extends Pick<Bot, "id" | "hidden" | "solo">>(
  bots: readonly T[],
  memberIds: readonly string[] = [],
): T[] {
  const members = memberIds.flatMap((id) => bots.filter((b) => b.id === id));
  return [...members, ...bots.filter((b) => !memberIds.includes(b.id) && mayJoinRoom(b))];
}

/** A tap on a member: in or out, and nobody past the limit. */
export function togglePicked(picked: readonly string[], id: string): string[] {
  if (picked.includes(id)) return picked.filter((p) => p !== id);
  return picked.length >= MAX_MEMBERS ? [...picked] : [...picked, id];
}

/** The name a rename keeps, or null to keep the old one: blank, the same,
 * or Escape all mean nothing changed. Runs of spaces fold to one, as a
 * conversation's title does. */
export function nextRoomName(value: string, current: string): string | null {
  const next = value.replace(/\s+/g, " ").trim().slice(0, MAX_ROOM_NAME);
  return next && next !== current ? next : null;
}

/** The one change the Agents dialog saves, or null when it would change
 * nothing. The crown goes only when one was tapped on someone still in:
 * a crowned lead taken out leaves the room on seniority, which the server
 * does by itself, so nothing is sent for it. */
export function rosterPatch(
  room: Pick<Blok, "memberIds" | "leadId">,
  picked: readonly string[],
  leadId: string | null,
): { memberIds: string[]; leadId?: string } | null {
  const crown = leadId && picked.includes(leadId) && leadId !== (room.leadId ?? null) ? leadId : undefined;
  const same = picked.length === room.memberIds.length && picked.every((id, i) => id === room.memberIds[i]);
  if (same && !crown) return null;
  return { memberIds: [...picked], ...(crown ? { leadId: crown } : {}) };
}

/** Who leads once the roster is saved, said when the lead the dialog
 * opened with was taken out and nobody else was crowned: the preview
 * moves the crown by seniority (src/lib/roomLead.ts, as the server
 * decides it), and this says why it moved. Null when nothing needs
 * saying, a crown tapped by hand included. */
export function leadNote<T extends { id: string; name: string; seniority?: number }>(
  before: T | null,
  answering: readonly T[],
  leadId: string | null,
): string | null {
  if (!before || answering.some((m) => m.id === before.id)) return null;
  if (leadId && answering.some((m) => m.id === leadId)) return null;
  const after = roomLead(answering, null);
  if (!after || answering.length < MIN_MEMBERS) return null;
  return `${before.name} is out, so ${after.name} leads now, as the most senior.`;
}

/** What "New room with these agents" opens the New room dialog with: the
 * same name, the members who can still answer, the crown while its
 * wearer is among them, who answers, and the folder the room works in.
 * The old room and its transcript are left exactly as they are. */
export function freshStartPreset(room: Blok, bots: readonly Bot[]): NewRoomPreset {
  const memberIds = room.memberIds
    .filter((id) => bots.some((b) => b.id === id && mayJoinRoom(b)))
    .slice(0, MAX_MEMBERS);
  const folder = room.pinnedCwd !== undefined ? room.pinnedCwd : room.cwd;
  return {
    name: room.name,
    memberIds,
    leadId: room.leadId && memberIds.includes(room.leadId) ? room.leadId : null,
    leadOnly: Boolean(room.leadOnly),
    ...(folder ? { cwd: folder } : {}),
    from: room.name,
  };
}
