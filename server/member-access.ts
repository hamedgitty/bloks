// What a member of the workspace may reach, and what they are shown.
//
// An owner's paired device gets the whole remote surface. A member's gets
// this file, and nothing in this file is inherited: every route a member
// can call is named below, and anything unnamed is refused. A new route
// added anywhere else in the server is therefore closed to members until
// someone decides here that it should not be.
//
// A member reaches what server/access.ts says they may: team
// conversations they are on the list for, rooms they are in with every
// agent there, their own private conversation with any agent they can
// reach, and the solo agents they made, and what is theirs alone: the
// apps and keys their private turns use and what each agent remembers of
// them (server/personal.ts), each route about the person whose device it
// is and never naming anybody else. This file names the routes and
// shapes what crosses them; access.ts holds the rules. An admin also reaches the people routes: invites,
// requests to join, roles, limits, who is in which room and agent, and
// the agents members made for themselves (to delete, never to read). The
// join password and the approval switch stay the owner's. Who opens and
// changes an agent's settings is access.ts's (mayChangeSettings): an
// admin every agent's but the owner's own, a member their own agents'.
//
// The same goes for the live event stream. The server broadcasts one
// stream for the owner; a member sees a frame only when it is about a
// room they are in, and only after it has been passed through
// memberFrame(), which strips what belongs to the owner: tool arguments,
// screenshots of the owner's screen, file paths, the buttons on approvals.
import type { MemberRole, WorkspaceRole } from "./people.ts";
import type { Message } from "./store.ts";

/** What a member route is about, once matched. */
export type MemberAction =
  | { kind: "health" }
  | { kind: "events" }
  | { kind: "me" }
  | { kind: "room"; roomId: string }
  | { kind: "post"; roomId: string }
  | { kind: "answer"; roomId: string; messageId: string }
  | { kind: "invite"; roomId: string }
  | { kind: "leave"; roomId: string }
  | { kind: "typing"; roomId: string }
  // how far they have read a room or a conversation, theirs to say
  | { kind: "read"; threadId: string }
  // the workspace, and the member's own conversations with its agents
  | { kind: "workspace" }
  | { kind: "agents" }
  | { kind: "newAgent" }
  | { kind: "usage" }
  | { kind: "dropAgent"; botId: string }
  // an agent's settings, for whoever server/access.ts lets change them
  | { kind: "agentSettings"; botId: string; method: "GET" | "PATCH" }
  | { kind: "leaveWorkspace" }
  | { kind: "conversation"; botId: string; lane: "team" | "private" }
  | { kind: "say"; botId: string; lane: "team" | "private" }
  | { kind: "reply"; botId: string; lane: "team" | "private"; messageId: string }
  | { kind: "notes" }
  | { kind: "note" }
  // what is the member's own: the apps and keys their private turns use,
  // what each agent remembers of them, and whether they were welcomed
  | { kind: "connections" }
  | { kind: "appsKey"; method: "PUT" | "DELETE" }
  | { kind: "apps" }
  | { kind: "app"; method: "POST" | "DELETE"; slug: string }
  | { kind: "secret"; method: "PUT" | "DELETE"; name: string }
  | { kind: "memories" }
  | { kind: "forgetMemory"; botId: string }
  | { kind: "welcomed" }
  | { kind: "noteKeep"; noteId: string }
  | { kind: "noteDrop"; noteId: string }
  // the people routes: anyone may list who is in, an admin may change it
  | { kind: "people" }
  | { kind: "admin"; method: string; path: string }
  // an admin's own app watchers (server/app-watch.ts), whose turns go to
  // a team conversation they are on; and the events an app offers
  | { kind: "appWatchers"; method: string; watcherId?: string }
  | { kind: "appTriggers"; toolkit: string };

const ID = "([A-Za-z0-9_-]{1,64})";

/** The whole member surface. Order does not matter; each pattern is
 * anchored and exact. */
const ROUTES: Array<{ method: string; pattern: RegExp; action: (m: RegExpMatchArray) => MemberAction }> = [
  { method: "GET", pattern: /^\/api\/health$/, action: () => ({ kind: "health" }) },
  { method: "GET", pattern: /^\/api\/events$/, action: () => ({ kind: "events" }) },
  { method: "GET", pattern: /^\/api\/member\/me$/, action: () => ({ kind: "me" }) },
  { method: "GET", pattern: new RegExp(`^/api/member/rooms/${ID}$`), action: (m) => ({ kind: "room", roomId: m[1] }) },
  {
    method: "POST",
    pattern: new RegExp(`^/api/member/rooms/${ID}/messages$`),
    action: (m) => ({ kind: "post", roomId: m[1] }),
  },
  {
    method: "POST",
    pattern: new RegExp(`^/api/member/rooms/${ID}/cards/${ID}$`),
    action: (m) => ({ kind: "answer", roomId: m[1], messageId: m[2] }),
  },
  {
    method: "POST",
    pattern: new RegExp(`^/api/member/rooms/${ID}/invites$`),
    action: (m) => ({ kind: "invite", roomId: m[1] }),
  },
  {
    method: "POST",
    pattern: new RegExp(`^/api/member/rooms/${ID}/leave$`),
    action: (m) => ({ kind: "leave", roomId: m[1] }),
  },
  {
    method: "POST",
    pattern: new RegExp(`^/api/member/rooms/${ID}/typing$`),
    action: (m) => ({ kind: "typing", roomId: m[1] }),
  },
  {
    method: "POST",
    pattern: new RegExp(`^/api/member/threads/${ID}/read$`),
    action: (m) => ({ kind: "read", threadId: m[1] }),
  },
  { method: "GET", pattern: /^\/api\/member\/workspace$/, action: () => ({ kind: "workspace" }) },
  { method: "GET", pattern: /^\/api\/member\/agents$/, action: () => ({ kind: "agents" }) },
  { method: "POST", pattern: /^\/api\/member\/agents$/, action: () => ({ kind: "newAgent" }) },
  { method: "GET", pattern: /^\/api\/member\/usage$/, action: () => ({ kind: "usage" }) },
  { method: "DELETE", pattern: new RegExp(`^/api/member/agents/${ID}$`), action: (m) => ({ kind: "dropAgent", botId: m[1] }) },
  ...(["GET", "PATCH"] as const).map((method) => ({
    method,
    pattern: new RegExp(`^/api/member/agents/${ID}/settings$`),
    action: (m: RegExpMatchArray) => ({ kind: "agentSettings" as const, botId: m[1], method }),
  })),
  { method: "POST", pattern: /^\/api\/member\/leave$/, action: () => ({ kind: "leaveWorkspace" }) },
  {
    method: "GET",
    pattern: new RegExp(`^/api/member/agents/${ID}/(team|private)/messages$`),
    action: (m) => ({ kind: "conversation", botId: m[1], lane: m[2] as "team" | "private" }),
  },
  {
    method: "POST",
    pattern: new RegExp(`^/api/member/agents/${ID}/(team|private)/messages$`),
    action: (m) => ({ kind: "say", botId: m[1], lane: m[2] as "team" | "private" }),
  },
  {
    method: "POST",
    pattern: new RegExp(`^/api/member/agents/${ID}/(team|private)/cards/${ID}$`),
    action: (m) => ({ kind: "reply", botId: m[1], lane: m[2] as "team" | "private", messageId: m[3] }),
  },
  { method: "GET", pattern: /^\/api\/member\/notes$/, action: () => ({ kind: "notes" }) },
  { method: "POST", pattern: /^\/api\/member\/notes$/, action: () => ({ kind: "note" }) },
  {
    method: "POST",
    pattern: new RegExp(`^/api/member/notes/${ID}/keep$`),
    action: (m) => ({ kind: "noteKeep", noteId: m[1] }),
  },
  {
    method: "DELETE",
    pattern: new RegExp(`^/api/member/notes/${ID}$`),
    action: (m) => ({ kind: "noteDrop", noteId: m[1] }),
  },
  { method: "GET", pattern: /^\/api\/member\/connections$/, action: () => ({ kind: "connections" }) },
  ...(["PUT", "DELETE"] as const).map((method) => ({
    method,
    pattern: /^\/api\/member\/connections\/apps$/,
    action: () => ({ kind: "appsKey" as const, method }),
  })),
  { method: "GET", pattern: /^\/api\/member\/connections\/apps\/services$/, action: () => ({ kind: "apps" }) },
  ...(["POST", "DELETE"] as const).map((method) => ({
    method,
    pattern: /^\/api\/member\/connections\/apps\/([a-z0-9_-]{1,64})$/,
    action: (m: RegExpMatchArray) => ({ kind: "app" as const, method, slug: m[1] }),
  })),
  ...(["PUT", "DELETE"] as const).map((method) => ({
    method,
    pattern: /^\/api\/member\/connections\/secrets\/([A-Z][A-Z0-9_]{0,59})$/,
    action: (m: RegExpMatchArray) => ({ kind: "secret" as const, method, name: m[1] }),
  })),
  { method: "GET", pattern: /^\/api\/member\/memory$/, action: () => ({ kind: "memories" }) },
  { method: "DELETE", pattern: new RegExp(`^/api/member/memory/${ID}$`), action: (m) => ({ kind: "forgetMemory", botId: m[1] }) },
  { method: "POST", pattern: /^\/api\/member\/welcomed$/, action: () => ({ kind: "welcomed" }) },
  { method: "GET", pattern: /^\/api\/workspace\/members$/, action: () => ({ kind: "people" }) },
  // how many are waiting to be let in: an admin's badge, nought for anyone else
  { method: "GET", pattern: /^\/api\/workspace\/waiting$/, action: () => ({ kind: "people" }) },
  ...(
    [
      ["POST", /^\/api\/workspace\/invites$/],
      ["DELETE", new RegExp(`^/api/workspace/invites/${ID}$`)],
      ["PATCH", new RegExp(`^/api/workspace/invites/${ID}$`)],
      ["POST", new RegExp(`^/api/workspace/requests/${ID}/(approve|decline)$`)],
      ["PATCH", new RegExp(`^/api/workspace/members/${ID}$`)],
      ["DELETE", new RegExp(`^/api/workspace/members/${ID}$`)],
      ["GET", /^\/api\/workspace\/access$/],
      ["PATCH", new RegExp(`^/api/workspace/agents/${ID}/access$`)],
      ["PATCH", new RegExp(`^/api/workspace/rooms/${ID}/access$`)],
      // the agents members made for themselves, which an admin sees by
      // name and maker and may delete, never read
      ["GET", /^\/api\/workspace\/member-agents$/],
      ["DELETE", new RegExp(`^/api/workspace/member-agents/${ID}$`)],
    ] as const
  ).map(([method, pattern]) => ({ method, pattern, action: (m: RegExpMatchArray) => ({ kind: "admin" as const, method, path: m[0] }) })),
  { method: "GET", pattern: /^\/api\/member\/app-watchers$/, action: () => ({ kind: "appWatchers", method: "GET" }) },
  { method: "POST", pattern: /^\/api\/member\/app-watchers$/, action: () => ({ kind: "appWatchers", method: "POST" }) },
  ...(["PATCH", "DELETE"] as const).map((method) => ({
    method,
    pattern: new RegExp(`^/api/member/app-watchers/${ID}$`),
    action: (m: RegExpMatchArray) => ({ kind: "appWatchers" as const, method, watcherId: m[1] }),
  })),
  { method: "GET", pattern: new RegExp(`^/api/member/app-triggers/${ID}$`), action: (m) => ({ kind: "appTriggers", toolkit: m[1] }) },
];

export type Verdict = { ok: true; action: MemberAction } | { ok: false; status: number; error: string };

/**
 * May this member make this request?
 *
 * `roleIn` answers from the membership list; `canInvite` from the room's
 * sharing settings. Both are passed in so this stays a pure function a
 * test can walk exhaustively.
 */
export function memberCan(
  method: string,
  path: string,
  roleIn: (roomId: string) => MemberRole | null,
  canInvite: (roomId: string) => boolean,
  workspaceRole: WorkspaceRole | null = null,
): Verdict {
  const route = ROUTES.find((r) => r.method === method && r.pattern.test(path));
  if (!route) return { ok: false, status: 403, error: "not available to room members" };
  const action = route.action(path.match(route.pattern)!);
  // A guest from a chat channel is in rooms, not in the workspace: the
  // workspace's agents and people are not theirs to reach.
  const workspaceWide = [
    "workspace", "agents", "newAgent", "usage", "dropAgent", "agentSettings", "leaveWorkspace", "conversation", "say", "reply",
    "notes", "note", "noteKeep", "noteDrop", "people", "admin", "appWatchers", "appTriggers",
    "connections", "appsKey", "apps", "app", "secret", "memories", "forgetMemory", "welcomed",
  ];
  if (workspaceWide.includes(action.kind) && !workspaceRole) return { ok: false, status: 403, error: "not available to room guests" };
  if (action.kind === "admin" && workspaceRole !== "admin") {
    return { ok: false, status: 403, error: "only the owner and admins can manage people" };
  }
  // A member's agents act when they are asked; an app that starts them
  // on its own is the owner's or an admin's to set up, as the owner's
  // own watchers are the owner's.
  if ((action.kind === "appWatchers" || action.kind === "appTriggers") && workspaceRole !== "admin") {
    return { ok: false, status: 403, error: "only the owner and admins can set agents to act on events in apps" };
  }
  if (!("roomId" in action)) return { ok: true, action };

  const role = roleIn(action.roomId);
  // Not in the room reads the same as the room not existing: a member
  // should not be able to probe which rooms the owner has.
  if (!role) return { ok: false, status: 404, error: "no such room" };
  if (action.kind === "room" || action.kind === "leave") return { ok: true, action };
  if (role === "viewer") return { ok: false, status: 403, error: "viewers can read this room but not write in it" };
  if (action.kind === "invite" && !canInvite(action.roomId)) {
    return { ok: false, status: 403, error: "only the owner can invite people to this room" };
  }
  return { ok: true, action };
}

// ── what a member is shown ─────────────────────────────────────────────

/** How one member sees one room. */
export interface MemberView {
  joinedAt: number;
  history: "join" | "all";
  activityDetail: boolean;
  /** Who is looking, and as what. Optional so a view built before either
   * existed still reads as the narrowest one. */
  personId?: string;
  role?: MemberRole;
  /** Whether the owner lets collaborators answer approvals here. */
  approvals?: boolean;
  /** What is being looked at: a room, a team agent's one shared
   * conversation, or the member's own solo agent. Absent reads as a room,
   * which is all a view was before agents could be shared. */
  thread?: "room" | "team" | "private" | "solo";
  /** The member is an admin, who answers approvals as the owner would. */
  admin?: boolean;
}

/** Whether this member may answer this approval. In the workspace's own
 * terms: a solo agent's maker; in a team agent or a room, an admin or the
 * person whose message started the work. A room view from before
 * workspaces (no `thread`) keeps the older rule: the owner has handed
 * approvals to collaborators, they are one, and it is not their own
 * request. */
export function mayApprove(card: { askedFor?: string }, view: MemberView): boolean {
  if (!view.personId) return false;
  // A solo agent's cards are its maker's, a private conversation's its
  // person's: nobody else is in either.
  if (view.thread === "solo" || view.thread === "private") return true;
  // In a team agent or a room the say is the owner's and the admins', and
  // the person whose message started the work.
  if (view.admin) return true;
  if (view.thread === "team") return card.askedFor === view.personId;
  if (card.askedFor === view.personId && view.thread === "room") return true;
  return Boolean(
    view.approvals && view.role === "collaborator" && view.personId && card.askedFor !== view.personId,
  );
}

/** A tool's kind, never its arguments. A shell command a member cannot
 * read is still a shell command; the words are where the owner's paths,
 * queries and account names would be. */
export function toolKind(name: string): string {
  const n = name.toLowerCase();
  if (/browser|navigate|click|screenshot|page/.test(n)) return "Used the browser";
  if (/web_?search|search_web|websearch/.test(n)) return "Searched the web";
  if (/fetch|http|curl|webfetch/.test(n)) return "Opened a web page";
  if (/computer|mouse|keyboard|type_text|cua/.test(n)) return "Used the computer";
  // a shell first: a command line can contain any of the words below
  if (/^\/bin\/|bash|zsh|\bsh -c|shell|exec|command|\brun\b/.test(n)) return "Ran a command";
  if (/edit|write|patch|str_replace|create_file|save/.test(n)) return "Changed a file";
  if (/read|cat |view|glob|grep|ls\b|find/.test(n)) return "Read files";
  if (/mcp__|composio|gmail|slack|github|notion|linear|calendar/.test(n)) return "Used a connected app";
  return "Used a tool";
}

/** Whether a member should see this message at all. */
export function visibleTo(message: Pick<Message, "at">, view: MemberView): boolean {
  return view.history === "all" || message.at >= view.joinedAt;
}

/**
 * A message as a member may see it, or null when they may not.
 *
 * Kinds that are the owner's alone (a screenshot of the owner's screen, a
 * connector sign in, a secret prompt's field) are withheld or reduced to a
 * line saying something happened.
 */
export function memberMessage(message: Message, view: MemberView): Message | null {
  if (!visibleTo(message, view)) return null;
  switch (message.kind) {
    case "text": {
      // what the owner's words linked with @ held is the owner's: a page
      // of their browser, a conversation of theirs (server/mentions.ts)
      const { mentionContext: _mentionContext, ...words } = message;
      return words;
    }
    case "component":
      return message;
    case "notice": {
      // picking up a cut-off turn is the owner's to press
      const { carryOn: _carryOn, ...notice } = message;
      return notice;
    }
    case "activity": {
      if (!message.tool) return null;
      // A command's words are the owner's alone, whatever the room shares:
      // redaction catches the shapes it knows, and a member's device is
      // not the place to find out which it missed.
      const { command: _command, ...tool } = message.tool;
      if (view.activityDetail) return { ...message, tool };
      return { ...message, tool: { ...tool, name: toolKind(message.tool.name) } };
    }
    case "options": {
      if (!message.card) return null;
      // An approval is the owner's to give; a member sees that it is
      // waiting and on whom, not the buttons. A question is answerable by
      // collaborators, so its options stay. So are an approval's, for a
      // collaborator the owner has trusted with them, unless they asked.
      const approval = Boolean(message.card.tool) || message.card.title === "Approval needed";
      const { tool: _tool, team: _team, ...card } = message.card;
      if (!approval) return { ...message, card };
      if (mayApprove(message.card, view)) return { ...message, card: { ...card, options: ["Allow", "Deny"] } };
      // What the action would do (an address, a query, a path) is only
      // shown to someone deciding it, or when the owner shows tool
      // details to the room. Everyone else sees its kind and who asked.
      const subtitle = view.activityDetail
        ? card.subtitle
        : [toolKind(message.card.tool ?? ""), card.subtitle.match(/\(asked for by [^)]+\)$/)?.[0]].filter(Boolean).join(" ");
      return { ...message, card: { ...card, subtitle, options: [], ownerOnly: true } };
    }
    case "secret":
      // what was asked for, never a way to answer it: secrets are saved on
      // the owner's computer, by the owner
      return message.secret
        ? ({ ...message, secret: { label: message.secret.label, status: message.secret.status } } as unknown as Message)
        : null;
    case "artifact":
      // the file lives in the owner's folders; its name is all that travels
      return message.artifact
        ? ({ ...message, artifact: { name: (message.artifact as { name?: string }).name ?? "a file" } } as unknown as Message)
        : null;
    case "screen":
    case "connector":
    default:
      return null;
  }
}

/** The frame kinds a member can ever receive, besides messages. Each is
 * emitted by the server specifically for rooms and carries a roomId. */
const ROOM_FRAMES = new Set(["room.people", "room.sharing", "room.typing", "room.activity", "room.offline"]);
/** Frames about one member's own conversation, keyed by its lane. */
const LANE_FRAMES = new Set(["member.lane"]);
/** The workspace's own news every member hears: who is in it, which way
 * the privacy setting is, that an agent's or a room's list changed (ids
 * only, so the app asks again what it may now see), that an agent's
 * settings changed (its id, for the same reason), what the owner is
 * called now, and the mark the owner chose for it (a member's own choice
 * of mark stays on their side, over this one). */
const WORKSPACE_FRAMES = new Set(["workspace.people", "workspace.privacy", "workspace.access", "workspace.agent", "workspace.owner", "workspace.mark"]);
/** What only the people who let others in hear: somebody asking, how
 * many are waiting, who came in, an invite closed or taken back. */
const ADMIN_FRAMES = new Set(["workspace.request", "workspace.waiting", "workspace.joined", "workspace.locked", "workspace.withdrawn", "workspace.left"]);

/** Where somebody stands: a guest of some rooms, or in the workspace. */
export type Standing = "guest" | "member" | "admin";

/**
 * A broadcast frame as one member may see it, or null. `viewOf` answers
 * how this member sees a room, or null when they are not in it.
 * `standing` is "guest" for somebody in some rooms only, who hears about
 * those rooms and nothing of the workspace around them; an admin also
 * hears who is asking to join.
 */
export function memberFrame(payload: unknown, viewOf: (roomId: string) => MemberView | null, standing: Standing = "member"): unknown | null {
  const frame = payload as { kind?: string; threadId?: string; roomId?: string; message?: Message; moved?: boolean; botId?: string; turnId?: string } | null;
  if (!frame || typeof frame.kind !== "string") return null;
  if (frame.kind === "ping") return frame;
  if (frame.kind === "message" || frame.kind === "message.patch" || frame.kind === "reply.settled") {
    const view = frame.threadId ? viewOf(frame.threadId) : null;
    if (!view || !frame.message) return null;
    const shown = memberMessage(frame.message, view);
    if (frame.kind === "reply.settled") {
      return shown && shown.kind === "text" && !shown.deleted
        ? { kind: frame.kind, threadId: frame.threadId, botId: frame.botId, turnId: frame.turnId, message: shown }
        : null;
    }
    // a queued message that went moves to the end on a member's screen too
    return shown ? { kind: frame.kind, threadId: frame.threadId, message: shown, ...(frame.moved ? { moved: true } : {}) } : null;
  }
  if (ROOM_FRAMES.has(frame.kind)) {
    return frame.roomId && viewOf(frame.roomId) ? frame : null;
  }
  if (LANE_FRAMES.has(frame.kind)) {
    return frame.threadId && viewOf(frame.threadId) ? frame : null;
  }
  // Somebody read a conversation this member is in. In a private one, or
  // a solo agent's, only their own position ever comes back to them: who
  // else reads there is not theirs to learn (server/access.ts readsShown).
  if (frame.kind === "read") {
    const view = frame.threadId ? viewOf(frame.threadId) : null;
    if (!view) return null;
    const reader = (frame as { personId?: unknown }).personId;
    if ((view.thread === "private" || view.thread === "solo") && reader !== view.personId) return null;
    return frame;
  }
  // A reply as it is written, in a conversation this member may read: the
  // words and nothing else of what the engine said (no tools, no items,
  // no costs), so the stream reads the way the owner's does.
  if (frame.kind === "runtime") return memberRuntime(payload, viewOf);
  // A guest is not in the workspace, and hears nothing of it.
  if (standing === "guest") return null;
  if (WORKSPACE_FRAMES.has(frame.kind)) return frame;
  if (ADMIN_FRAMES.has(frame.kind)) return standing === "admin" ? frame : null;
  return null;
}

/** An engine's live event as a member may see it: the text of a reply
 * being written, and when a turn starts and ends, in a conversation they
 * may read. Null for everything else. */
function memberRuntime(payload: unknown, viewOf: (roomId: string) => MemberView | null): unknown | null {
  const event = (payload as { event?: Record<string, unknown> }).event;
  const threadId = event?.threadId;
  if (!event || typeof threadId !== "string" || !viewOf(threadId)) return null;
  if (event.type === "content.delta" && event.streamKind === "assistant_text" && typeof event.delta === "string") {
    return {
      kind: "runtime",
      event: {
        type: "content.delta",
        threadId,
        streamKind: "assistant_text",
        delta: event.delta,
        // the engine's own label for progress lines, which the app keeps
        // out of the reply (src/lib/codexProgress.ts)
        ...(event.codexText && typeof event.codexText === "object" ? { codexText: event.codexText } : {}),
      },
    };
  }
  if (event.type === "turn.started" || event.type === "turn.completed") return { kind: "runtime", event: { type: event.type, threadId } };
  return null;
}
