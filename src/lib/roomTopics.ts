// A room's topics as the app reads them (the rules are server/room-topics.ts,
// shared here so the buttons offered are the ones the server takes).
//
// The main stream is everything said in no topic; a topic's thread is
// everything said in it. A topic says where it stands with one mark: an
// agent at work in it, something in it waiting for a person, or nothing,
// and closed topics are quiet whatever was last said.
import type { Message } from "../state/reducer.ts";
import type { RoomTopic } from "../../server/room-topics.ts";

export type { RoomTopic, TopicActor, TopicPowers } from "../../server/room-topics.ts";
export { topicPowers } from "../../server/room-topics.ts";

/** Whether a message belongs to this thread: a topic's, or the main
 * stream (null), which is everything said in no topic. */
export function inThread(m: Pick<Message, "topicId">, topicId: string | null): boolean {
  return topicId ? m.topicId === topicId : !m.topicId;
}

/** Open topics first, oldest first so they keep their places; closed ones
 * after, the most recently closed first. */
export function orderTopics(topics: readonly RoomTopic[] | undefined): RoomTopic[] {
  const list = [...(topics ?? [])];
  return list.sort((a, b) => {
    if (a.status !== b.status) return a.status === "open" ? -1 : 1;
    if (a.status === "open") return a.createdAt - b.createdAt;
    return (b.closedAt ?? 0) - (a.closedAt ?? 0);
  });
}

/** Topics under their category headings, in the order given, the ones
 * with no category last. */
export function byCategory(topics: readonly RoomTopic[]): Array<{ category: string | null; topics: RoomTopic[] }> {
  const groups = new Map<string | null, RoomTopic[]>();
  for (const topic of topics) {
    const key = topic.category ?? null;
    groups.set(key, [...(groups.get(key) ?? []), topic]);
  }
  return [...groups].sort(([a], [b]) => (a === null ? 1 : b === null ? -1 : 0)).map(([category, list]) => ({ category, topics: list }));
}

export type TopicState = "working" | "waiting" | "idle" | "closed";

const STATE_RANK: Record<TopicState, number> = { waiting: 3, working: 2, idle: 1, closed: 0 };

/** A category's topics in the topics bar, as one folder. */
export interface TopicFolder {
  /** null for the topics with no category, which are not a folder. */
  category: string | null;
  topics: RoomTopic[];
  /** The loudest mark among them: something waiting over work over quiet. */
  mark: TopicState;
  /** Open unless the person said otherwise: a folder with work or a
   * question in it, or the topic being read, opens by itself; a quiet one
   * stays closed once there is more than one folder to scan. */
  open: boolean;
}

/**
 * The topics bar's folders (GitHub 523): the topics under each category,
 * in the order given, the uncategorized last and never folded. `folded`
 * is what the person chose for a category, which wins over the default.
 */
export function topicFolders(
  topics: readonly RoomTopic[],
  states: ReadonlyMap<string, TopicState>,
  current: string | null,
  folded: Readonly<Record<string, boolean>> = {},
): TopicFolder[] {
  const groups = byCategory(topics);
  const folders = groups.filter((g) => g.category !== null).length;
  return groups.map(({ category, topics: list }) => {
    const mark = list.reduce<TopicState>((top, tp) => {
      const st = states.get(tp.id) ?? (tp.status === "closed" ? "closed" : "idle");
      return STATE_RANK[st] > STATE_RANK[top] ? st : top;
    }, "closed");
    const lively = mark === "waiting" || mark === "working" || list.some((tp) => tp.id === current);
    const chosen = category === null ? undefined : folded[category];
    const open = category === null || (chosen !== undefined ? !chosen : lively || folders <= 1);
    return { category, topics: list, mark, open };
  });
}

const said = (m: Message) => !m.deleted && !m.queued && m.kind !== "notice";

/**
 * Where a topic stands: closed; waiting, when a question or an approval in
 * it has no answer yet; working, while the room is at work and the last
 * thing said in the room was in this topic; idle otherwise.
 */
export function topicState(topic: RoomTopic, messages: readonly Message[], roomWorking: boolean): TopicState {
  if (topic.status === "closed") return "closed";
  if (messages.some((m) => m.topicId === topic.id && m.kind === "options" && m.card && !m.card.answered && !m.card.dismissed)) return "waiting";
  if (roomWorking) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (!said(m)) continue;
      return m.topicId === topic.id ? "working" : "idle";
    }
  }
  return "idle";
}

/** How many readable messages each topic holds, by topic id. */
export function topicCounts(messages: readonly Message[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const m of messages) if (m.topicId && said(m)) counts.set(m.topicId, (counts.get(m.topicId) ?? 0) + 1);
  return counts;
}

/** The files shared in a topic, newest first, each once. */
export function topicFiles(messages: readonly Message[], topicId: string): Array<{ botId: string; name: string; mime: string; size: number }> {
  const seen = new Set<string>();
  const files: Array<{ botId: string; name: string; mime: string; size: number }> = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.topicId !== topicId || m.deleted || m.kind !== "artifact" || !m.artifact || !m.from) continue;
    const key = `${m.from}/${m.artifact.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    files.push({ botId: m.from, ...m.artifact });
  }
  return files;
}

const LINK = /\bhttps?:\/\/[^\s<>()[\]"'`]+/gi;

/** The web addresses said in a topic, newest first, each once, at most
 * `max`: what the topic has been reading. */
export function topicLinks(messages: readonly Message[], topicId: string, max = 12): string[] {
  const seen: string[] = [];
  for (let i = messages.length - 1; i >= 0 && seen.length < max; i--) {
    const m = messages[i];
    if (m.topicId !== topicId || m.deleted || !m.text) continue;
    for (const raw of m.text.match(LINK) ?? []) {
      const url = raw.replace(/[.,;:!?]+$/, "");
      if (!seen.includes(url)) seen.push(url);
      if (seen.length >= max) break;
    }
  }
  return seen;
}
