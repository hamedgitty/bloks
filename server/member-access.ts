// What a member of a shared room may reach, and what they are shown.
//
// An owner's paired device gets the whole remote surface. A member's gets
// this file, and nothing in this file is inherited: every route a member
// can call is named below, and anything unnamed is refused. A new route
// added anywhere else in the server is therefore closed to members until
// someone decides here that it should not be.
//
// The same goes for the live event stream. The server broadcasts one
// stream for the owner; a member sees a frame only when it is about a
// room they are in, and only after it has been passed through
// memberFrame(), which strips what belongs to the owner: tool arguments,
// screenshots of the owner's screen, file paths, the buttons on approvals.
import type { MemberRole } from "./people.ts";
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
  | { kind: "typing"; roomId: string };

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
): Verdict {
  const route = ROUTES.find((r) => r.method === method && r.pattern.test(path));
  if (!route) return { ok: false, status: 403, error: "not available to room members" };
  const action = route.action(path.match(route.pattern)!);
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
    case "text":
    case "notice":
    case "component":
      return message;
    case "activity": {
      if (!message.tool) return null;
      if (view.activityDetail) return message;
      return { ...message, tool: { ...message.tool, name: toolKind(message.tool.name) } };
    }
    case "options": {
      if (!message.card) return null;
      // An approval is the owner's to give; a member sees that it is
      // waiting and on whom, not the buttons. A question is answerable by
      // collaborators, so its options stay.
      const approval = Boolean(message.card.tool) || message.card.title === "Approval needed";
      const { tool: _tool, team: _team, ...card } = message.card;
      return { ...message, card: approval ? { ...card, options: [], ownerOnly: true } : card };
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

/**
 * A broadcast frame as one member may see it, or null. `viewOf` answers
 * how this member sees a room, or null when they are not in it.
 */
export function memberFrame(payload: unknown, viewOf: (roomId: string) => MemberView | null): unknown | null {
  const frame = payload as { kind?: string; threadId?: string; roomId?: string; message?: Message } | null;
  if (!frame || typeof frame.kind !== "string") return null;
  if (frame.kind === "ping") return frame;
  if (frame.kind === "message" || frame.kind === "message.patch") {
    const view = frame.threadId ? viewOf(frame.threadId) : null;
    if (!view || !frame.message) return null;
    const shown = memberMessage(frame.message, view);
    return shown ? { kind: frame.kind, threadId: frame.threadId, message: shown } : null;
  }
  if (ROOM_FRAMES.has(frame.kind)) {
    return frame.roomId && viewOf(frame.roomId) ? frame : null;
  }
  return null;
}
