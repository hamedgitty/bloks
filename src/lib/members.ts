// The workspace's people, as the window sees them (server/members.ts).
//
// Shapes for the Members page and the join dialog, the calls they make,
// and one small bus for the server's "workspace." frames: the store hands
// them over as they arrive (src/state/store.tsx) and whatever is listening
// (the Members page, the switcher's badge) hears them. The bus also does
// the two things that must happen whether or not the page is open: a
// notification when somebody asks to join, and the waiting count the
// switcher shows.
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { api } from "@/state/store";
import { namer } from "./names";
import { ownerOrNull } from "./yourName";
import { openWorkspaceDialog } from "@/lib/workspaces";
import { formatDate, t, type MessageKey } from "./i18n.ts";
import { thisComputer } from "./thisComputer.ts";
import type { DeviceKind } from "../../server/this-machine.ts";

export type WorkspaceRole = "admin" | "member";
export type Role = WorkspaceRole | "owner";

export interface WorkspaceMark {
  color: string;
  pattern: string;
}

export interface Workspace {
  id: string;
  name: string;
  kind: string;
  mark: WorkspaceMark;
}

export interface MemberLimit {
  monthlyUsd: number | null;
  aiPercent: number | null;
  maxSolo: number;
  engines: string[] | null;
}

export interface Member {
  id: string;
  name: string;
  role: WorkspaceRole;
  joinedAt: number;
  invitedBy: string;
  device: DeviceKind | null;
  devices: number;
  lastActive: number | null;
  soloAgents: number;
  spend?: { month: string; usd: number; aiPercent: number | null };
  limits?: MemberLimit;
}

export interface Invite {
  id: string;
  publicId: string;
  code: string;
  link: string;
  name: string | null;
  role: WorkspaceRole;
  createdAt: number;
  expiresAt: number;
  invitedBy: string;
  status: string;
  online: boolean;
}

export interface JoinRequest {
  inviteId: string;
  name: string;
  forName: string | null;
  role: WorkspaceRole;
  device: DeviceKind;
  at: number;
  password: "correct" | "none";
  phrase: string | null;
  via: "relay" | "lan";
  expiresAt: number;
}

export interface MembersData {
  workspace: Workspace;
  you: { role: Role; personId: string | null };
  owner: { name: string };
  members: Member[];
  invites?: Invite[];
  requests?: JoinRequest[];
  joining?: { password: { setAt: number } | null; approveEach: boolean; privateReadable: boolean };
  engines?: Array<{ id: string; name: string }>;
  privacy: { privateReadable: boolean; line: string };
  plan: "cloud" | "team" | null;
  limit: number | null;
  /** Members are Bloks Team's: whether the owner is on it now. */
  team?: boolean;
  /** People are in, and the owner is not on Team: they are paused. */
  paused?: boolean;
  online: { available: boolean; why?: string };
}

export interface AgentAccessRow {
  id: string;
  name: string;
  color: string;
  shape: string | null;
  solo: boolean;
  access: { mode: "everyone" | "only" | "except"; people: string[]; admins: boolean } | null;
}

// Keys, so a role reads in the language it is drawn in.
const ROLE_NAME: Record<Role, MessageKey> = { owner: "members.role.owner", admin: "members.role.admin", member: "members.role.member" };

/** "Owner", "Admin", "Member". */
export function roleName(role: Role): string {
  return t(ROLE_NAME[role]);
}

export const membersApi = {
  list: (): Promise<MembersData> => api("/api/workspace/members"),
  invite: (body: { name?: string; role: WorkspaceRole }): Promise<{ invite: Invite; online: MembersData["online"] }> =>
    api("/api/workspace/invites", { method: "POST", body: JSON.stringify(body) }),
  cancel: (id: string) => api(`/api/workspace/invites/${id}`, { method: "DELETE" }),
  updateInvite: (id: string, patch: { name?: string; role?: WorkspaceRole }): Promise<{ invite: Invite }> =>
    api(`/api/workspace/invites/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  approve: (id: string): Promise<{ person: Member }> => api(`/api/workspace/requests/${id}/approve`, { method: "POST" }),
  decline: (id: string) => api(`/api/workspace/requests/${id}/decline`, { method: "POST" }),
  setRole: (id: string, role: WorkspaceRole) => api(`/api/workspace/members/${id}`, { method: "PATCH", body: JSON.stringify({ role }) }),
  setLimits: (id: string, limits: Partial<MemberLimit>): Promise<{ person: Member }> =>
    api(`/api/workspace/members/${id}`, { method: "PATCH", body: JSON.stringify({ limits }) }),
  remove: (id: string) => api(`/api/workspace/members/${id}`, { method: "DELETE" }),
  setPassword: (password: string) => api("/api/workspace/joining/password", { method: "PUT", body: JSON.stringify({ password }) }),
  clearPassword: () => api("/api/workspace/joining/password", { method: "DELETE" }),
  setJoining: (patch: { approveEach?: boolean; privateReadable?: boolean }) =>
    api("/api/workspace/joining", { method: "PATCH", body: JSON.stringify(patch) }),
  setIdentity: (body: { id: string; name: string; kind: string; mark: WorkspaceMark }) =>
    api("/api/workspace/identity", { method: "PUT", body: JSON.stringify(body) }),
  access: (): Promise<{ agents: AgentAccessRow[]; rooms: Array<{ id: string; name: string; audience: "everyone" | "some"; members: string[] }> }> =>
    api("/api/workspace/access"),
  setAgentAccess: (botId: string, body: { mode: "everyone" | "only" | "except"; people?: string[]; admins?: boolean }) =>
    api(`/api/workspace/agents/${botId}/access`, { method: "PATCH", body: JSON.stringify(body) }),
};

// ── the join dialog's calls (server/join-client.ts) ───────────────────

export interface FoundInvite {
  publicId: string;
  workspace: string;
  mark: WorkspaceMark;
  inviter: string;
  role: WorkspaceRole;
  expiresAt: number | null;
  password: boolean | null;
}

export interface JoinFailure {
  ok: false;
  status: number;
  code: string;
  error: string;
  triesLeft?: number;
  retryAfter?: number;
  host?: string;
  workspace?: string;
}

export interface Welcome {
  workspace: Workspace;
  inviter: string;
  approvedBy: string;
  role: WorkspaceRole;
  agents: Array<{ id: string; name: string; title: string; color: string; shape: string | null }>;
  agentCount: number;
}

/** What a joined workspace is reached with: the same profile the remote
 * proxy takes (electron/remote.mjs), plus who and where. */
export interface JoinCredentials {
  relayUrl: string | null;
  relayToken: string | null;
  deviceId: string;
  deviceToken: string;
  personId: string;
  role: WorkspaceRole;
  hostKey: string;
  lan: string | null;
  workspace: Workspace | null;
}

export type JoinAnswer =
  | { ok: true; status: "waiting"; phrase: string }
  | { ok: true; status: "approved"; phrase: string; welcome: Welcome; credentials: JoinCredentials }
  | JoinFailure;

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const parsed = await res.json().catch(() => ({ ok: false, code: "offline", error: t("members.macDidNotAnswer", { computer: thisComputer() }) }));
  return parsed as T;
}

export const joinApi = {
  lookup: (input: string) => post<{ ok: true; session: string; invite: FoundInvite; via: "relay" | "lan" } | JoinFailure>("/api/joining/lookup", { input }),
  claim: (session: string, name: string, password?: string) => post<JoinAnswer>("/api/joining/claim", { session, name, password }),
  status: (session: string) => post<JoinAnswer>("/api/joining/status", { session }),
  cancel: (session: string) => post<{ ok: boolean }>("/api/joining/cancel", { session }),
};

// ── codes, as typed ────────────────────────────────────────────────────

const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

/** The eight characters of a code in whatever was typed, or null. The
 * server reads input the same way (server/invites.ts normalizeCode). */
/** The id a workspace's own server goes by. A hosted machine's is always
 * "hosted", whatever this Mac calls it in its list. */
export function serverIdOf(workspace: { id: string; kind: string }): string {
  return workspace.kind === "hosted" ? "hosted" : workspace.id;
}

export function codeIn(raw: string): string | null {
  const text = raw.includes("#") ? (raw.split("#")[1] ?? "").split("~")[0] : raw;
  const code = text.toUpperCase().replace(/[\s\-_.\u2010-\u2015\u2212]/g, "");
  if (code.length !== 8 || [...code].some((c) => !ALPHABET.includes(c))) return null;
  return code;
}

/** Whether some text is a Bloks workspace invite: a code, or a link to
 * one. A room invite's link (bloks.dev/join#...) is not. */
export function looksLikeInvite(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length > 300) return false;
  if (/^(https?:\/\/)?bloks\.dev\/j\/[a-z0-9]{6}#/i.test(trimmed) || /^bloks:\/\/join#/i.test(trimmed)) return codeIn(trimmed) !== null;
  return !trimmed.includes("/") && codeIn(trimmed) !== null;
}

export function formatCode(code: string): string {
  return code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
}

// ── the frame bus ──────────────────────────────────────────────────────

type Frame = { kind: string; [key: string]: unknown };
const listeners = new Set<(frame: Frame) => void>();
let waiting = 0;
const waitingListeners = new Set<() => void>();

function setWaiting(n: number) {
  if (n === waiting) return;
  waiting = n;
  waitingListeners.forEach((l) => l());
}

/** Called by the store for every "workspace." frame. `news` is false for
 * frames replayed after a reconnect, which must not notify twice. */
export function workspaceFrame(frame: Frame, news: boolean) {
  if (frame.kind === "workspace.waiting" && typeof frame.count === "number") setWaiting(frame.count);
  if (news && frame.kind === "workspace.request") {
    const request = frame.request as JoinRequest;
    const first = request.name.split(" ")[0] || request.name;
    void window.bloks?.notifyShow({
      title: frame.workspace ? t("members.notify.wantsToJoin", { name: first, workspace: String(frame.workspace) }) : t("members.notify.wantsToJoinYours", { name: first }),
      body: t("members.notify.checkFourWords", { name: first }),
      target: "workspace:members",
      urgent: true,
    });
  }
  if (news && frame.kind === "workspace.locked") {
    const invite = frame.invite as { name: string | null };
    void window.bloks?.notifyShow({
      title: t("members.notify.inviteClosed"),
      body: invite.name ? t("members.notify.wrongPasswordFor", { name: invite.name }) : t("members.notify.wrongPassword"),
      target: "workspace:members",
      urgent: false,
    });
  }
  if (news && frame.kind === "workspace.left") {
    const person = frame.person as { name?: string } | undefined;
    void window.bloks?.notifyShow({
      title: frame.workspace
        ? t("members.notify.left", { name: person?.name ?? t("members.notify.someone"), workspace: String(frame.workspace) })
        : t("members.notify.leftYours", { name: person?.name ?? t("members.notify.someone") }),
      body: t("members.notify.leftBody"),
      target: "workspace:members",
      urgent: false,
    });
  }
  listeners.forEach((l) => l(frame));
}

/** Hears every "workspace." frame while mounted. */
export function useWorkspaceFrames(handler: (frame: Frame) => void) {
  useEffect(() => {
    listeners.add(handler);
    return () => {
      listeners.delete(handler);
    };
  }, [handler]);
}

/** How many people are waiting to be let in, for the switcher's badge and
 * the Members row's "1 waiting". Asked once, then kept by frames. */
export function useWaitingCount(): number {
  useEffect(() => {
    api("/api/workspace/waiting")
      .then((r: { count?: number }) => setWaiting(r.count ?? 0))
      .catch(() => {});
  }, []);
  return useSyncExternalStore(
    (l) => {
      waitingListeners.add(l);
      return () => waitingListeners.delete(l);
    },
    () => waiting,
    () => waiting,
  );
}

// ── words ──────────────────────────────────────────────────────────────

const DAY = 24 * 60 * 60_000;

/** "Oct 2", or "Oct 2, 2025" when not this year. */
export function shortDate(at: number, now = Date.now()): string {
  const d = new Date(at);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return formatDate(d, { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) });
}

/** "active today", "active yesterday", "active Oct 2". */
export function activeWords(at: number | null, now = Date.now()): string | null {
  if (!at) return null;
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  if (at >= start.getTime()) return t("members.active.today");
  if (at >= start.getTime() - DAY) return t("members.active.yesterday");
  return t("members.active.on", { date: shortDate(at, now) });
}

/** "expires in 23 h", "expires in 12 min". */
export function expiresIn(at: number, now = Date.now()): string {
  const left = at - now;
  if (left <= 0) return t("members.expires.expired");
  const minutes = Math.round(left / 60_000);
  if (minutes < 60) return t("members.expires.minutes", { minutes: Math.max(1, minutes) });
  return t("members.expires.hours", { hours: Math.round(minutes / 60) });
}

/** "tomorrow at 9:41 PM", "today at 11:02 AM". */
export function whenWords(at: number, now = Date.now()): string {
  const d = new Date(at);
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const time = formatDate(d, { hour: "numeric", minute: "2-digit" });
  const day = Math.floor((d.getTime() - today.getTime()) / DAY);
  if (day === 0) return t("members.when.today", { time });
  if (day === 1) return t("members.when.tomorrow", { time });
  return t("members.when.on", { date: shortDate(at, now), time });
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  return ((parts[0][0] ?? "") + (parts.length > 1 ? (parts[parts.length - 1][0] ?? "") : "")).toUpperCase();
}

/** A person's avatar tint, steady per id: a handful of quiet hues that
 * read on both themes. Never an agent's colour, so a person is never
 * mistaken for an agent. */
const TINTS = ["#2a3d66", "#4a2f5e", "#5e3a22", "#26364f", "#1f4a44", "#4f3326", "#3a3f66", "#523046"];
export function tintOf(id: string): string {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return TINTS[h % TINTS.length];
}

// ── opening the join dialog from anywhere ─────────────────────────────

let joinInput = "";

/** Opens the join dialog (the switcher's, src/lib/workspaces.ts), filled
 * in with a link or code when there is one: a bloks://join link from
 * bloks.dev or a scanned QR. */
export function openJoinDialog(input = "") {
  joinInput = input;
  openWorkspaceDialog("join");
}

/** The link or code the dialog was opened with, given once. */
export function takeJoinInput(): string {
  const input = joinInput;
  joinInput = "";
  return input;
}

// ── names of the people in the workspace ─────────────────────────────

let names: Record<string, string> = {};
/** The same people with their roles, for who is in a team agent's
 * conversation (src/lib/participants.ts teamHumans), and the owner's. */
let roster: { owner: string | null; members: Array<{ id: string; name: string; role: WorkspaceRole }> } = { owner: null, members: [] };
let namesAsked = false;
const nameListeners = new Set<() => void>();

function loadNames() {
  api("/api/workspace/members")
    .then((data: MembersData) => {
      names = Object.fromEntries(data.members.map((m) => [m.id, m.name]));
      roster = { owner: data.owner?.name ?? null, members: data.members.map((m) => ({ id: m.id, name: m.name, role: m.role })) };
      nameListeners.forEach((l) => l());
    })
    .catch(() => {});
}
listeners.add((frame) => {
  // the owner renamed themselves (server/index.ts setOwnerName)
  if (frame.kind === "workspace.owner" && typeof frame.name === "string") {
    roster = { ...roster, owner: frame.name };
    nameListeners.forEach((l) => l());
  }
  if (frame.kind === "workspace.people" && Array.isArray(frame.members)) {
    const list = frame.members as Array<{ id: string; name: string; role?: WorkspaceRole }>;
    names = Object.fromEntries(list.map((m) => [m.id, m.name]));
    roster = { ...roster, members: list.map((m) => ({ id: m.id, name: m.name, role: m.role === "admin" ? "admin" : "member" })) };
    nameListeners.forEach((l) => l());
  }
});

/** A person's name by id, for a message they wrote in a team
 * conversation; "A former member" for somebody no longer here. */
export function usePersonName(): (id: string) => string {
  useEffect(() => {
    if (!namesAsked) {
      namesAsked = true;
      loadNames();
    }
  }, []);
  const current = useSyncExternalStore(
    (l) => {
      nameListeners.add(l);
      return () => nameListeners.delete(l);
    },
    () => names,
    () => names,
  );
  return (id: string) => current[id] ?? t("members.formerMember");
}

/** The workspace's people with their roles, and the owner's name, as the
 * window knows them; asked once, then kept by frames. */
export function useWorkspaceRoster(): typeof roster {
  useEffect(() => {
    if (!namesAsked) {
      namesAsked = true;
      loadNames();
    }
  }, []);
  return useSyncExternalStore(
    (l) => {
      nameListeners.add(l);
      return () => nameListeners.delete(l);
    },
    () => roster,
    () => roster,
  );
}

/**
 * Everybody's name as a conversation shows it, told apart
 * (src/lib/names.ts): the owner and the workspace's people, plus `also`,
 * a room's own guests. Anybody else is the fallback ("A former member").
 */
export function useNamer(also: ReadonlyArray<{ id: string; name: string }> = []): (id: string, fallback?: string) => string {
  const r = useWorkspaceRoster();
  const owner = ownerOrNull(r.owner);
  return useMemo(
    () => namer([...(owner ? [{ id: "owner", name: owner }] : []), ...r.members, ...also]),
    // the room's list arrives as a new array on every render
    [owner, r.members, also.map((p) => `${p.id}:${p.name}`).join("\n")], // eslint-disable-line react-hooks/exhaustive-deps
  );
}
