// Topics in a room: named workstreams, each with a thread of its own
// (GitHub 523).
//
// A room is one stream, and that is right until it holds three pieces of
// work at once. A topic gives one of them its own thread: what is said in
// it carries the topic's id, the room's agents answer inside it, and the
// main stream stays for everything else. A topic can name which of the
// room's agents work in it (the rest are not woken there), the folder its
// work belongs in and the branch, which the agents are told with every
// message in it.
//
// Topics are governed, unlike the reply threads the Topics lens reads off
// the transcript (src/lib/threads.ts). Who may do what, in the room's own
// terms (server/people.ts):
//
//   open, close, reopen   the owner, a workspace admin, and the room's lead
//                         agent, which routes work into topics
//   change what it says   the owner and an admin (title, category, the
//                         agents in it, its folder and branch)
//   write in it           anyone who may write in the room, while it is
//                         open: a collaborator, a guest let in, an agent
//   read it               anyone who may read the room, viewers too
//
// A closed topic keeps its thread and takes nothing new until it is
// opened again, so finished work stops waking anybody.
//
// No HTTP, no store and no imports in here, so the tests read it as it
// is and the app shares the same rules (src/lib/roomTopics.ts); the
// routes in server/index.ts hold the requests to them.

export type TopicStatus = "open" | "closed";

export interface RoomTopic {
  id: string;
  title: string;
  /** A heading topics are grouped under ("Research", "Backend"). */
  category?: string;
  status: TopicStatus;
  createdAt: number;
  /** "owner", a person's id, or "agent:<id>" for the lead. */
  createdBy: string;
  closedAt?: number;
  closedBy?: string;
  /** The room's agents who work in it; absent or empty is all of them. */
  agents?: string[];
  /** Where its work belongs, relative to the room's folder. Told to the
   * agents with each message, and held to where Bloks can hold an
   * engine's file writes (folderHold below). */
  folder?: string;
  /** The git branch its changes go on, told to the agents the same way. */
  branch?: string;
}

/** Who is asking, as the room knows them. */
export type TopicActor =
  | { kind: "owner" }
  | { kind: "admin"; personId: string }
  | { kind: "collaborator"; personId: string }
  | { kind: "viewer"; personId: string }
  | { kind: "agent"; botId: string; lead: boolean };

export const TOPIC_LIMITS = { title: 80, category: 40, folder: 200, branch: 100, perRoom: 200 } as const;

export interface TopicPowers {
  /** Open a new topic. */
  open: boolean;
  /** Close or reopen any topic. */
  close: boolean;
  /** Change a topic's title, category, agents, folder or branch. */
  edit: boolean;
  /** Say something in an open topic. */
  write: boolean;
}

export function topicPowers(actor: TopicActor): TopicPowers {
  switch (actor.kind) {
    case "owner":
    case "admin":
      return { open: true, close: true, edit: true, write: true };
    case "agent":
      return { open: actor.lead, close: actor.lead, edit: false, write: true };
    case "collaborator":
      return { open: false, close: false, edit: false, write: true };
    case "viewer":
      return { open: false, close: false, edit: false, write: false };
  }
}

/** The words for a refusal, said the same way by every route. */
export const TOPIC_REFUSALS = {
  open: "only the owner, an admin or the room's lead can open a topic",
  close: "only the owner, an admin or the room's lead can close or reopen a topic",
  edit: "only the owner or an admin can change a topic",
  write: "viewers can read this room but not write in it",
  closed: "this topic is closed. Reopen it to write in it",
  missing: "no such topic in this room",
  full: `a room holds at most ${TOPIC_LIMITS.perRoom} topics`,
} as const;

export interface TopicDraft {
  title?: string;
  category?: string | null;
  agents?: string[];
  folder?: string | null;
  branch?: string | null;
}

const text = (value: unknown, max: number): string | null => {
  if (typeof value !== "string") return null;
  const said = value.replace(/\s+/g, " ").trim();
  return said ? said.slice(0, max) : null;
};

/** A folder inside the room's: relative, no way out of it, no oddities. */
export function cleanFolder(value: unknown): string | null | undefined {
  if (value === null || value === "") return null;
  if (typeof value !== "string") return undefined;
  const path = value.trim().replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/^\.\//, "");
  if (!path || path.length > TOPIC_LIMITS.folder) return undefined;
  if (path.startsWith("/") || /^[a-z]:/i.test(path) || path.startsWith("~")) return undefined;
  if (path.split("/").some((part) => part === "..")) return undefined;
  if (/[\0-\x1f]/.test(path)) return undefined;
  return path.endsWith("/") ? path : `${path}/`;
}

/** A branch name git would take, near enough: no spaces, no "..", none
 * of the characters git refuses, not starting with a dash. */
export function cleanBranch(value: unknown): string | null | undefined {
  if (value === null || value === "") return null;
  if (typeof value !== "string") return undefined;
  const name = value.trim();
  if (!name || name.length > TOPIC_LIMITS.branch) return undefined;
  if (name.startsWith("-") || name.startsWith("/") || name.endsWith("/") || name.endsWith(".lock")) return undefined;
  if (name.includes("..") || name.includes("@{") || /[\s~^:?*[\\\0-\x1f\x7f]/.test(name)) return undefined;
  return name;
}

/**
 * What a request asks a topic to be, checked: the title it must have when
 * new, the room's own agents only, a folder and a branch that are safe to
 * say. An error names the field, for the person to fix.
 */
export function readTopicDraft(
  body: Record<string, unknown>,
  memberIds: readonly string[],
  { creating }: { creating: boolean },
): { ok: true; draft: TopicDraft } | { ok: false; error: string } {
  const draft: TopicDraft = {};
  if ("title" in body || creating) {
    const title = text(body.title, TOPIC_LIMITS.title);
    if (!title) return { ok: false, error: "a topic needs a title" };
    draft.title = title;
  }
  if ("category" in body) draft.category = body.category === null ? null : text(body.category, TOPIC_LIMITS.category);
  if ("agents" in body) {
    if (!Array.isArray(body.agents)) return { ok: false, error: "agents is a list of the room's agents" };
    const agents = [...new Set(body.agents.filter((id): id is string => typeof id === "string"))];
    if (agents.some((id) => !memberIds.includes(id))) return { ok: false, error: "a topic's agents are agents in this room" };
    draft.agents = agents;
  }
  if ("folder" in body) {
    const folder = cleanFolder(body.folder);
    if (folder === undefined) return { ok: false, error: "the folder is a path inside the room's folder" };
    draft.folder = folder;
  }
  if ("branch" in body) {
    const branch = cleanBranch(body.branch);
    if (branch === undefined) return { ok: false, error: "that is not a branch name git would take" };
    draft.branch = branch;
  }
  return { ok: true, draft };
}

/** A new topic, open, from a checked draft. */
export function newTopic(id: string, draft: TopicDraft & { title: string }, createdBy: string, now = Date.now()): RoomTopic {
  return applyDraft({ id, title: draft.title, status: "open", createdAt: now, createdBy }, draft);
}

/** A draft laid over a topic; null clears a field, absent leaves it. */
export function applyDraft(topic: RoomTopic, draft: TopicDraft): RoomTopic {
  const next: RoomTopic = { ...topic };
  if (draft.title) next.title = draft.title;
  for (const key of ["category", "folder", "branch"] as const) {
    if (!(key in draft)) continue;
    const value = draft[key];
    if (value) next[key] = value;
    else delete next[key];
  }
  if (draft.agents) {
    if (draft.agents.length) next.agents = draft.agents;
    else delete next.agents;
  }
  return next;
}

export function setStatus(topic: RoomTopic, status: TopicStatus, by: string, now = Date.now()): RoomTopic {
  if (topic.status === status) return topic;
  if (status === "open") {
    const { closedAt: _at, closedBy: _by, ...open } = topic;
    return { ...open, status };
  }
  return { ...topic, status, closedAt: now, closedBy: by };
}

/** Whether something may be said in this topic now, and why not. */
export function topicForWriting(
  topics: readonly RoomTopic[] | undefined,
  topicId: string,
): { ok: true; topic: RoomTopic } | { ok: false; status: number; error: string } {
  const topic = topics?.find((t) => t.id === topicId);
  if (!topic) return { ok: false, status: 404, error: TOPIC_REFUSALS.missing };
  if (topic.status === "closed") return { ok: false, status: 409, error: TOPIC_REFUSALS.closed };
  return { ok: true, topic };
}

/** Where something set up ahead of time (a workflow's "Post in a room"
 * step, a room's routine) posts: the main stream when it names no topic,
 * or its topic while that is open. A topic closed or gone since it was set
 * up fails the run with the reason, rather than spilling into the main
 * stream the person chose to keep it out of. */
export function scheduledTopic(
  topics: readonly RoomTopic[] | undefined,
  topicId: string | undefined,
): { ok: true; topicId?: string } | { ok: false; error: string } {
  if (!topicId) return { ok: true };
  const topic = topics?.find((t) => t.id === topicId);
  if (!topic) return { ok: false, error: "its topic is no longer in that room" };
  if (topic.status === "closed") return { ok: false, error: `its topic "${topic.title}" is closed. Reopen it, or post in the main stream` };
  return { ok: true, topicId: topic.id };
}

/** The room's agents a message in this topic may reach: those it names,
 * of the agents given, or all of them when it names none. */
export function topicAgents<T extends { id: string }>(topic: RoomTopic | null | undefined, agents: readonly T[]): T[] {
  if (!topic?.agents?.length) return [...agents];
  return agents.filter((a) => topic.agents!.includes(a.id));
}

/** What an agent is told with each message in a topic: where it is, where
 * its work belongs, and that its answer goes there too. */
export function topicBrief(topic: RoomTopic): string {
  const where = [
    topic.folder ? `keep its files in ${topic.folder}` : "",
    topic.branch ? `put its changes on the branch ${topic.branch}` : "",
  ].filter(Boolean);
  const work = where.length ? ` For this topic, ${where.join(" and ")}.` : "";
  return `(This is in the room's topic "${topic.title}". What you say now goes into that topic.${work})`;
}

// ── the lead routing work into topics ──────────────────────────────────
//
// A room's lead reads the main stream. When a person's message there is
// work that belongs in an open topic, or new work, the lead can move it:
// into that topic, or into one it opens for it. Only with the owner's
// say-so for the room (BlokRecord.leadRoutes), only a person's own words
// from the main stream, each message once, and never silently: the move
// is said in the main stream, the message carries who moved it, and the
// topic's agents are woken with it there. The owner and an admin may move
// one too; nobody else.

export const MOVE_REFUSALS = {
  notLead: "only the room's lead can move work into a topic",
  notLet: "the owner has not let this room's lead move work into topics. Answer in the main stream, or ask the owner to turn on routing for the room",
  notPersons: "only a person's own message in the main stream can be moved into a topic",
  already: "that message is already in a topic",
  which: "say which message to move: its id, from `bloks history <room>`",
  both: "move it into an open topic or into a new one, not both",
  neither: "say where it goes: an open topic's id, or a title for a new one",
  nobody: "nobody but you works in that topic, so moving it there wakes nobody. Answer it yourself, or name agents who work there",
  stranger: "only agents who work in that topic can be woken there",
} as const;

/** Whether this actor may move a message into a topic, and why not. */
export function mayMove(actor: TopicActor, leadRoutes: boolean): { ok: true } | { ok: false; error: string } {
  if (actor.kind === "owner" || actor.kind === "admin") return { ok: true };
  if (actor.kind !== "agent" || !actor.lead) return { ok: false, error: MOVE_REFUSALS.notLead };
  if (!leadRoutes) return { ok: false, error: MOVE_REFUSALS.notLet };
  return { ok: true };
}

/** The message as the move needs it. */
export interface MovableMessage {
  id: string;
  role: "user" | "bot";
  kind: string;
  from?: string;
  deleted?: boolean;
  queued?: boolean;
  topicId?: string;
}

/** Whether a message may be moved: a person's words, said and kept, in
 * the main stream, and not moved before. */
export function movable(message: MovableMessage | undefined): { ok: true } | { ok: false; status: number; error: string } {
  if (!message) return { ok: false, status: 404, error: "no such message in this room" };
  if (message.role !== "user" || message.from || message.kind !== "text" || message.deleted || message.queued) {
    return { ok: false, status: 400, error: MOVE_REFUSALS.notPersons };
  }
  if (message.topicId) return { ok: false, status: 409, error: MOVE_REFUSALS.already };
  return { ok: true };
}

/**
 * Who a moved message wakes in its topic: the agents named, each of whom
 * must work there, or every agent who works there; never the one who
 * moved it, which has read it already. An empty answer is refused before
 * anything moves, since a move that wakes nobody only hides the message.
 */
export function moveWakes(
  workers: readonly string[],
  mover: string | null,
  named: readonly string[] | undefined,
): { ok: true; ids: string[] } | { ok: false; error: string } {
  if (named?.length) {
    if (named.some((id) => !workers.includes(id))) return { ok: false, error: MOVE_REFUSALS.stranger };
    const ids = [...new Set(named)].filter((id) => id !== mover);
    return ids.length ? { ok: true, ids } : { ok: false, error: MOVE_REFUSALS.nobody };
  }
  const ids = workers.filter((id) => id !== mover);
  return ids.length ? { ok: true, ids } : { ok: false, error: MOVE_REFUSALS.nobody };
}

/** What the room's lead is told with a person's message in the main
 * stream, while it may route work: the message's id, the open topics, and
 * the command, so moving it is one step and never a guess. */
export function routingNote(roomId: string, messageId: string, topics: readonly RoomTopic[], cli: string): string {
  const open = topics.filter((t) => t.status === "open");
  const list = open.length
    ? `Open topics: ${open.map((t) => `"${t.title}" (${t.id}${t.category ? `, ${t.category}` : ""})`).join("; ")}.`
    : "The room has no open topics yet.";
  return (
    `(You lead this room and may route work into topics. This message is ${messageId}. ${list} ` +
    `When it is work that clearly belongs in an open topic, move it there with \`${cli} topic move ${roomId} ${messageId} --into <topic-id>\`; ` +
    `when it asks for new work, open a topic for it with \`${cli} topic move ${roomId} ${messageId} --new "<title>" [--category <name>]\`. ` +
    `Add --to <agent-id,...> to wake only some of the topic's agents. The move is said in the main stream for everyone. ` +
    `Answer questions, small talk and anything you are unsure of here yourself, and say in a line what you moved and why.)`
  );
}

// ── holding a topic's folder ───────────────────────────────────────────
//
// A topic may say where its work goes. Bloks tells every agent, and holds
// the writes it can: Claude Code's own file tools (Write, Edit, MultiEdit,
// NotebookEdit) are checked before they run by a hook Bloks hands the
// engine (server/topic-folder-hook.ts), and a write outside the topic's
// folder, the agent's own notes folder and the temp folder is refused
// with the reason. What Bloks cannot hold, it says: a command an agent
// runs in its shell, any other engine's own tools, an agent that works
// somewhere else, one whose engine hooks the owner switched off, a shared
// room, and Windows.

export type HoldGap = "engine" | "elsewhere" | "hooks" | "shared" | "platform";

/** Whether Bloks can hold this turn's file writes to a topic's folder, or
 * the reason it cannot. */
export function folderHold(turn: { engine: string; elsewhere: boolean; hooksOff: boolean; shared: boolean; platform: string }): { held: true } | { held: false; gap: HoldGap } {
  if (turn.engine !== "claudeAgent") return { held: false, gap: "engine" };
  if (turn.platform === "win32") return { held: false, gap: "platform" };
  if (turn.elsewhere) return { held: false, gap: "elsewhere" };
  if (turn.shared) return { held: false, gap: "shared" };
  if (turn.hooksOff) return { held: false, gap: "hooks" };
  return { held: true };
}

/** What an agent working in a topic with a folder is told about it, in
 * its brief: held, or honestly not. */
export function folderHoldBrief(folder: string, hold: { held: true } | { held: false; gap: HoldGap }): string {
  if (hold.held) {
    return `This topic's files go in ${folder}. Bloks holds your file tools to it: a Write or Edit outside it (other than your own notes and the temp folder) is refused. Commands you run in a shell are not held, so keep their writes inside it too.`;
  }
  const why = {
    engine: "your engine's own tools write files without asking Bloks",
    elsewhere: "you work on another machine",
    hooks: "the hooks of your engine are switched off for you",
    shared: "this room is shared",
    platform: "it cannot on this computer",
  }[hold.gap];
  return `This topic's files go in ${folder}. Bloks cannot hold you to it here, because ${why}, so keep every write inside it yourself.`;
}
