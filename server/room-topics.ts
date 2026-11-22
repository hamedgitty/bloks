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
   * agents with each message; not yet held to by the file tools. */
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
