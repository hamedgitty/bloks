// The app as a member of somebody else's workspace sees it: the rules.
//
// A workspace you joined opens through the remote proxy with your member
// credentials (electron/remote.mjs), and every owner route answers no.
// So the app decides once, as it loads, which app it is: the owner's, or
// a member's, drawn from the member routes alone (server/member-access.ts
// names every one of them). The decisions are plain functions here, with
// nothing to load, so a test can walk them; the calls and the live stream
// are in src/lib/memberMode.ts.

// ── the shapes the member routes answer with ──────────────────────────

export type MemberRole = "member" | "admin";

export interface MemberWorkspace {
  /** Set while the owner is not on Bloks Team: members are paused, and
   * this is the line that says so. Nothing of theirs is gone. */
  paused?: string;
  workspace: { id: string; name: string; kind: string; mark: { color: string; pattern: string } };
  you: { personId: string; name: string; role: MemberRole };
  owner: { name: string };
  privacy: { privateReadable: boolean; line: string };
  members: Array<{ id: string; name: string; role: MemberRole }>;
  solo: { count: number; max: number };
  engines: Array<{ id: string; name: string }>;
}

export interface MemberAgent {
  id: string;
  name: string;
  title: string;
  color: string;
  shape: string | null;
  solo: boolean;
  mine: boolean;
  team: { threadId: string | null } | null;
  private: { threadId: string | null } | null;
  busy: boolean;
}

export interface MemberRoomRow {
  id: string;
  name: string;
  role: "collaborator" | "viewer";
  joinedAt: number;
}

export interface MemberCard {
  title: string;
  subtitle: string;
  options: string[];
  answered?: string;
  answeredBy?: string;
  dismissed?: boolean;
  closed?: string;
  cutOff?: boolean;
  requestId?: string;
  ownerOnly?: boolean;
  askedFor?: string;
}

export interface MemberMessage {
  id: string;
  at: number;
  role: "user" | "bot";
  kind: string;
  text?: string;
  author?: string;
  from?: string;
  queued?: boolean;
  deleted?: boolean;
  quiet?: boolean;
  event?: boolean;
  tool?: { name: string; ok?: boolean };
  card?: MemberCard;
  onBehalf?: { by: string; name: string };
  secret?: { label: string; status?: string };
  artifact?: { name: string };
}

export interface Conversation {
  agent: MemberAgent;
  threadId: string;
  kind: "team" | "private" | "solo";
  busy: boolean;
  people: Record<string, string>;
  owner: { name: string };
  privacy?: string;
  messages: MemberMessage[];
  /** How far each person has read, as far as this member may see. */
  reads?: Array<{ personId: string; messageId: string; at: number }>;
}

export interface MemberUsage {
  month: string;
  spentUsd: number;
  aiPercent: number | null;
  limits: { monthlyUsd: number | null; aiPercent: number | null; maxSolo: number; engines: string[] | null };
  soloAgents: number;
  stopped: string | null;
}

export interface MemberNote {
  id: string;
  text: string;
  state: "suggested" | "kept";
  by: { id: string; name: string };
  at: number;
}

export interface MemberRoom {
  room: {
    id: string;
    name: string;
    role: "collaborator" | "viewer";
    owner: { name: string };
    agents: Array<{ id: string; name: string; title: string; color: string; shape: string | null; archived: boolean; busy: boolean }>;
    people: Array<{ id: string; name: string; role: string; joinedAt: number; guest?: boolean }>;
  };
  messages: MemberMessage[];
  reads?: Array<{ personId: string; messageId: string; at: number }>;
}

// ── deciding, once ─────────────────────────────────────────────────────

/** Which app this window is. "guest" is somebody in some rooms of a
 * workspace and nothing else of it. */
export type AppMode =
  | { mode: "owner" }
  | { mode: "member"; workspace: MemberWorkspace }
  | { mode: "guest"; rooms: MemberRoomRow[]; host: string; name: string };

/** Whether to ask at all. A workspace this app runs itself is the owner's
 * by definition, so it costs nothing; a joined one, a Bloks on another
 * computer, or a page with no desktop around it may be a member's. */
export function shouldAskMemberMode(kind: string | undefined | null): boolean {
  return !kind || kind === "joined";
}

/** What the answers to the two member routes make of this window. Any
 * failure is the owner's app, which is what it always was: the member
 * routes only answer a member's credential. */
export function modeFrom(
  workspace: { status: number; body: unknown } | null,
  me: { status: number; body: unknown } | null,
): AppMode {
  const ws = workspace?.status === 200 ? (workspace.body as Partial<MemberWorkspace>) : null;
  if (ws?.you && (ws.you.role === "member" || ws.you.role === "admin") && ws.workspace) {
    return {
      mode: "member",
      workspace: {
        workspace: ws.workspace,
        you: ws.you,
        owner: ws.owner ?? { name: "The owner" },
        privacy: ws.privacy ?? { privateReadable: false, line: "" },
        members: ws.members ?? [],
        solo: ws.solo ?? { count: 0, max: 0 },
        engines: ws.engines ?? [],
        ...(typeof ws.paused === "string" ? { paused: ws.paused } : {}),
      },
    };
  }
  // a guest of some rooms: the workspace route refuses them, "me" answers
  const said = me?.status === 200 ? (me.body as { person?: { name?: string; role?: string }; host?: string; rooms?: MemberRoomRow[] }) : null;
  if (workspace?.status === 403 && said?.person && !said.person.role && Array.isArray(said.rooms)) {
    return { mode: "guest", rooms: said.rooms, host: said.host ?? "The owner", name: said.person.name ?? "" };
  }
  return { mode: "owner" };
}

// ── the places in a member's app ───────────────────────────────────────

export type MemberPlace =
  | { kind: "agent"; id: string; lane: "team" | "private" }
  | { kind: "room"; id: string }
  | { kind: "page"; page: "usage" | "about" | "members" | "settings" };

/** The pages a member's app has, in the rail's order. Members (managing
 * people) is an admin's; everything of the owner's is left out entirely,
 * so there is nothing to refuse. */
export function memberPages(role: MemberRole | null): Array<{ page: Extract<MemberPlace, { kind: "page" }>["page"]; label: string }> {
  return [
    { page: "usage", label: "Your usage" },
    { page: "about", label: "About you" },
    ...(role === "admin" ? [{ page: "members" as const, label: "Members" }] : []),
    { page: "settings", label: "Workspace" },
  ];
}

/** The conversation an agent opens on: its team conversation when this
 * person is in it, else their private one with it. A solo agent has only
 * the one, which the routes call private. */
export function defaultLane(agent: Pick<MemberAgent, "team" | "solo">): "team" | "private" {
  return !agent.solo && agent.team ? "team" : "private";
}

/** Where the app opens: the place it was last, while it still exists,
 * else the first agent, else the first room, else the usage page. */
export function firstPlace(agents: MemberAgent[], rooms: MemberRoomRow[], last: MemberPlace | null): MemberPlace {
  if (last?.kind === "agent") {
    const agent = agents.find((a) => a.id === last.id);
    if (agent) return { kind: "agent", id: agent.id, lane: last.lane === "team" && agent.team && !agent.solo ? "team" : defaultLane(agent) };
  }
  if (last?.kind === "room" && rooms.some((r) => r.id === last.id)) return last;
  if (last?.kind === "page") return last;
  const agent = agents.find((a) => !a.solo) ?? agents[0];
  if (agent) return { kind: "agent", id: agent.id, lane: defaultLane(agent) };
  if (rooms[0]) return { kind: "room", id: rooms[0].id };
  return { kind: "page", page: "usage" };
}

/** The sidebar's two lists of agents: the team's, then this person's own,
 * each by name. */
export function agentGroups(agents: MemberAgent[]): { team: MemberAgent[]; mine: MemberAgent[] } {
  const byName = (a: MemberAgent, b: MemberAgent) => a.name.localeCompare(b.name);
  return {
    team: agents.filter((a) => !a.solo).sort(byName),
    mine: agents.filter((a) => a.solo && a.mine).sort(byName),
  };
}

/** Whether another solo agent may be made, and if not, the plain reason. */
export function soloRoom(solo: { count: number; max: number }, engines: number, owner: string): { ok: true } | { ok: false; why: string } {
  if (solo.max === 0) return { ok: false, why: `Solo agents are not on for you here. ${owner} or an admin can turn them on.` };
  if (solo.count >= solo.max) {
    return { ok: false, why: `You have ${solo.count} solo ${solo.count === 1 ? "agent" : "agents"}, as many as you may make here. Delete one, or ask ${owner} or an admin for more.` };
  }
  if (engines === 0) return { ok: false, why: `No engine is open to your solo agents yet. Ask ${owner} or an admin to allow one.` };
  return { ok: true };
}

/** What the composer says about this person's own limit, if anything:
 * stopped (their requests no longer start), close to it, or nothing. */
export function usageNotice(usage: MemberUsage | null): { level: "stop" | "warn"; text: string } | null {
  if (!usage) return null;
  if (usage.stopped) return { level: "stop", text: usage.stopped };
  const cap = usage.limits.monthlyUsd;
  if (cap !== null && cap > 0 && usage.spentUsd >= cap * 0.8) {
    return { level: "warn", text: `You have used $${usage.spentUsd.toFixed(2)} of your $${cap} this month. Past it, your requests here stop until next month.` };
  }
  const ai = usage.limits.aiPercent;
  if (ai !== null && usage.aiPercent !== null && usage.aiPercent >= ai * 0.8) {
    return { level: "warn", text: `You have used ${usage.aiPercent}% of your ${ai}% of Bloks AI this month.` };
  }
  return null;
}

/** Who a human line in a conversation is from, as its header says it:
 * "You", a member's name, or the owner's. */
export function speaker(message: Pick<MemberMessage, "author" | "role">, me: string, people: Record<string, string>, owner: string): string {
  if (!message.author) return owner;
  if (message.author === me) return "You";
  return people[message.author] ?? "A former member";
}

/** Whether a card is still waiting on somebody, and whether it is this
 * person who can answer it. */
export function cardState(card: MemberCard): "open" | "waiting-on-others" | "done" {
  if (card.answered || card.dismissed || card.closed || card.cutOff) return "done";
  if (card.ownerOnly || !card.options.length) return "waiting-on-others";
  return "open";
}

// ── the live stream, folded ───────────────────────────────────────────

export type Frame = { kind: string; [key: string]: unknown };

/** The words of a reply as they arrive, until its message lands. */
export function foldRuntime(current: Record<string, string>, frame: Frame, progress: (codexText: unknown) => boolean = () => false): Record<string, string> {
  const event = frame.event as { type?: string; threadId?: string; delta?: string; codexText?: unknown } | undefined;
  if (frame.kind === "runtime" && event?.threadId) {
    if (event.type === "content.delta" && typeof event.delta === "string" && !progress(event.codexText)) {
      return { ...current, [event.threadId]: (current[event.threadId] ?? "") + event.delta };
    }
    if (event.type === "turn.started") {
      const { [event.threadId]: _gone, ...rest } = current;
      return rest;
    }
    return current;
  }
  // the reply landed as a message: it takes the streamed words' place
  const message = frame.message as MemberMessage | undefined;
  if (frame.kind === "message" && typeof frame.threadId === "string" && message?.role === "bot" && message.kind === "text" && frame.threadId in current) {
    const { [frame.threadId]: _gone, ...rest } = current;
    return rest;
  }
  return current;
}

// ── who is in a room, chosen by the owner or an admin ─────────────────

/** What the room picker sends: everyone, or the people ticked. A room of
 * some people with nobody ticked is still that: the owner's own room,
 * which the picker says rather than refuses. */
export function roomAccessBody(audience: "everyone" | "some", chosen: Iterable<string>): { audience: "everyone" } | { audience: "some"; members: string[] } {
  return audience === "everyone" ? { audience } : { audience, members: [...new Set(chosen)].sort() };
}

/** The picker's one line about who is in a room. */
export function roomAudienceLine(audience: "everyone" | "some", chosen: number, total: number, guests: number, owner = "you"): string {
  const outside = guests ? ` Plus ${guests} ${guests === 1 ? "guest" : "guests"} let in by this room's own invite.` : "";
  if (audience === "everyone") return `Everyone in the workspace is in this room, ${total} ${total === 1 ? "member" : "members"} and ${owner}.${outside}`;
  if (!chosen) return `Only ${owner}, for now. Tick the people to bring in.${outside}`;
  return `${chosen} of ${total} ${total === 1 ? "member" : "members"} and ${owner}.${outside}`;
}
