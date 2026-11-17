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
