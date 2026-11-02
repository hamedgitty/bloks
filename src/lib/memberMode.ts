// The app as a member of somebody else's workspace sees it: the calls,
// deciding which app this window is, and the live stream. The rules they
// follow are src/lib/memberRules.ts.
import { useEffect, useSyncExternalStore } from "react";
import type { WorkspaceKind } from "@/types/bridge";
import { isProgressText } from "@/lib/codexProgress";
import { takeReadFrame } from "@/lib/readReceipts";
import { noteSignedOut } from "@/lib/webDoor";
import {
  foldRuntime,
  modeFrom,
  shouldAskMemberMode,
  type AppMode,
  type Conversation,
  type Frame,
  type MemberAgent,
  type MemberConnections,
  type MemberMemory,
  type MemberMessage,
  type MemberNote,
  type MemberRoom,
  type MemberRoomRow,
  type MemberUsage,
  type MemberWorkspace,
} from "./memberRules";

export * from "./memberRules";

async function probe(path: string): Promise<{ status: number; body: unknown } | null> {
  try {
    const res = await fetch(path, { headers: { "content-type": "application/json" } });
    return { status: res.status, body: await res.json().catch(() => null) };
  } catch {
    return null;
  }
}

/** Asks, once, which app this window is. */
export async function detectMode(kind: WorkspaceKind | undefined | null): Promise<AppMode> {
  if (!shouldAskMemberMode(kind)) return { mode: "owner" };
  const workspace = await probe("/api/member/workspace");
  if (workspace?.status === 200) return modeFrom(workspace, null);
  if (workspace?.status !== 403) return { mode: "owner" };
  return modeFrom(workspace, await probe("/api/member/me"));
}


// ── the calls ──────────────────────────────────────────────────────────

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { headers: { "content-type": "application/json" }, ...init });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) noteSignedOut(res.status, (body as { code?: string }).code);
  if (!res.ok) throw Object.assign(new Error((body as { error?: string }).error ?? `${res.status} ${res.statusText}`), { status: res.status, code: (body as { code?: string }).code });
  return body as T;
}

export const memberApi = {
  workspace: () => call<MemberWorkspace>("/api/member/workspace"),
  agents: () => call<{ agents: MemberAgent[] }>("/api/member/agents"),
  me: () => call<{ rooms: MemberRoomRow[] }>("/api/member/me"),
  newAgent: (body: { name: string; title?: string; description?: string; engine?: { instanceId: string } }) =>
    call<{ agent: MemberAgent }>("/api/member/agents", { method: "POST", body: JSON.stringify(body) }),
  dropAgent: (id: string) => call<{ ok: true }>(`/api/member/agents/${id}`, { method: "DELETE" }),
  conversation: (id: string, lane: "team" | "private") => call<Conversation>(`/api/member/agents/${id}/${lane}/messages`),
  say: (id: string, lane: "team" | "private", text: string) =>
    call<{ message: MemberMessage; queued: boolean }>(`/api/member/agents/${id}/${lane}/messages`, { method: "POST", body: JSON.stringify({ text }) }),
  answer: (id: string, lane: "team" | "private", messageId: string, answer: string) =>
    call<{ ok: true }>(`/api/member/agents/${id}/${lane}/cards/${messageId}`, { method: "POST", body: JSON.stringify({ answer }) }),
  room: (id: string) => call<MemberRoom>(`/api/member/rooms/${id}`),
  post: (id: string, text: string) => call<{ message: MemberMessage }>(`/api/member/rooms/${id}/messages`, { method: "POST", body: JSON.stringify({ text }) }),
  answerRoom: (id: string, messageId: string, answer: string) =>
    call<{ ok: true }>(`/api/member/rooms/${id}/cards/${messageId}`, { method: "POST", body: JSON.stringify({ answer }) }),
  usage: () => call<MemberUsage>("/api/member/usage"),
  notes: () => call<{ notes: MemberNote[] }>("/api/member/notes"),
  addNote: (text: string) => call<{ note: MemberNote }>("/api/member/notes", { method: "POST", body: JSON.stringify({ text }) }),
  keepNote: (id: string, text?: string) => call<{ note: MemberNote }>(`/api/member/notes/${id}/keep`, { method: "POST", body: JSON.stringify(text === undefined ? {} : { text }) }),
  dropNote: (id: string) => call<{ ok: true }>(`/api/member/notes/${id}`, { method: "DELETE" }),
  connections: () => call<MemberConnections>("/api/member/connections"),
  setAppsKey: (key: string) => call<MemberConnections>("/api/member/connections/apps", { method: "PUT", body: JSON.stringify({ key }) }),
  dropAppsKey: () => call<MemberConnections>("/api/member/connections/apps", { method: "DELETE" }),
  apps: () => call<{ connected: boolean; services: Record<string, { connected: boolean; status: string }> }>("/api/member/connections/apps/services"),
  connectApp: (slug: string) => call<{ url: string }>(`/api/member/connections/apps/${slug}`, { method: "POST" }),
  disconnectApp: (slug: string) => call<{ removed: number }>(`/api/member/connections/apps/${slug}`, { method: "DELETE" }),
  saveSecret: (name: string, value: string) => call<MemberConnections>(`/api/member/connections/secrets/${name}`, { method: "PUT", body: JSON.stringify({ value }) }),
  forgetSecret: (name: string) => call<MemberConnections>(`/api/member/connections/secrets/${name}`, { method: "DELETE" }),
  memories: () => call<{ memories: MemberMemory[] }>("/api/member/memory"),
  forgetMemory: (botId: string) => call<{ ok: true }>(`/api/member/memory/${botId}`, { method: "DELETE" }),
  welcomed: () => call<{ ok: true }>("/api/member/welcomed", { method: "POST" }),
  read: (threadId: string, messageId: string) =>
    call<{ read: unknown }>(`/api/member/threads/${threadId}/read`, { method: "POST", body: JSON.stringify({ messageId }) }),
};

// ── the live stream ────────────────────────────────────────────────────
// One EventSource for the whole member app. Frames go to whoever is
// listening (the open conversation, the sidebar); the replies being
// written are kept here per conversation, so a conversation opened in the
// middle of one still shows it.

const frameListeners = new Set<(frame: Frame) => void>();
let streaming: Record<string, string> = {};
const streamListeners = new Set<() => void>();
let connected = false;
const connectedListeners = new Set<() => void>();
let source: EventSource | null = null;

function setStreaming(next: Record<string, string>) {
  streaming = next;
  streamListeners.forEach((l) => l());
}

function setConnected(value: boolean) {
  if (connected === value) return;
  connected = value;
  connectedListeners.forEach((l) => l());
}

export function startMemberStream() {
  if (source) return;
  let retry: ReturnType<typeof setTimeout> | null = null;
  const connect = () => {
    source = new EventSource("/api/events");
    source.onopen = () => setConnected(true);
    source.onerror = () => {
      setConnected(false);
      source?.close();
      if (retry) clearTimeout(retry);
      retry = setTimeout(connect, 2000);
    };
    source.onmessage = (raw) => {
      let frame: Frame;
      try {
        frame = JSON.parse(raw.data);
      } catch {
        return;
      }
      if (typeof frame?.kind !== "string") return;
      takeReadFrame(frame);
      const next = foldRuntime(streaming, frame, (c) => isProgressText(c as Parameters<typeof isProgressText>[0]));
      if (next !== streaming) setStreaming(next);
      frameListeners.forEach((l) => l(frame));
    };
  };
  connect();
}

/** Hears every frame while mounted. */
export function useMemberFrames(handler: (frame: Frame) => void) {
  useEffect(() => {
    frameListeners.add(handler);
    return () => {
      frameListeners.delete(handler);
    };
  }, [handler]);
}

/** The reply being written in a conversation, or "". */
export function useStreaming(threadId: string | null): string {
  const all = useSyncExternalStore(
    (l) => {
      streamListeners.add(l);
      return () => streamListeners.delete(l);
    },
    () => streaming,
    () => streaming,
  );
  return threadId ? (all[threadId] ?? "") : "";
}

export function useMemberConnected(): boolean {
  return useSyncExternalStore(
    (l) => {
      connectedListeners.add(l);
      return () => connectedListeners.delete(l);
    },
    () => connected,
    () => connected,
  );
}
