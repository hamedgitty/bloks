// A server opened in a browser at its own address, through its web door
// (server/web-door.ts): whether this page is one, who is signed in, and
// the calls that sign in, join from an invite and sign out.
//
// Only a browser asks. The desktop app has its own way to every workspace
// and never a web door, so it starts drawing at once. A page that is not
// a web door (bloks.dev/web, a server on the network, the dev UI) hears
// nothing back from /auth/session that says "web", and carries on as
// before.
import { useSyncExternalStore } from "react";
import { t } from "./i18n.ts";
import type { WorkspaceMark } from "./members.ts";

export interface WebDoorSession {
  door: "web";
  /** What the provider is called on its button. */
  provider: string;
  workspace: { name: string; mark: WorkspaceMark };
  owner: string;
  signedIn: boolean;
  as: { role: "owner" | "admin" | "member"; name: string; signIn: string | null } | null;
  /** Signed in to use an invite, and waiting to be let in. */
  waiting?: { status: "waiting"; phrase: string; name: string; about?: { inviter: string; role: "admin" | "member"; workspace: string; mark: WorkspaceMark } };
}

let current: WebDoorSession | null = null;
const listeners = new Set<() => void>();

/** Asks, once, whether this page came through a web door. Null when it
 * did not, or when it could not tell. */
export async function probeWebDoor(): Promise<WebDoorSession | null> {
  if (typeof window === "undefined" || window.bloks) return null;
  try {
    const res = await fetch("/auth/session", { headers: { accept: "application/json" } });
    const body = res.ok ? ((await res.json().catch(() => null)) as WebDoorSession | null) : null;
    current = body?.door === "web" ? body : null;
  } catch {
    current = null;
  }
  listeners.forEach((l) => l());
  return current;
}

/** The web door's session as last heard, for the Sign out rows. */
export function useWebDoor(): WebDoorSession | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
    () => current,
  );
}

/**
 * A request the web door turned away because the session ended (signed
 * out elsewhere, removed from the workspace, two weeks up): the page
 * starts again at the sign-in, rather than showing errors in an app that
 * can no longer reach anything. Nothing outside a web door.
 */
export function noteSignedOut(status: number, code: unknown): void {
  if (!current?.signedIn || status !== 401 || code !== "signin") return;
  current = null;
  window.location.reload();
}

async function post<T>(path: string, body: unknown = {}): Promise<{ status: number; body: T }> {
  try {
    const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as T };
  } catch {
    return { status: 0, body: { code: "offline" } as T };
  }
}

export interface DoorProblem {
  code?: string;
  error?: string;
  triesLeft?: number;
}

/** Off to the provider. Resolves with what went wrong only when the
 * browser did not leave. */
export async function signIn(input: { next?: string; join?: { code: string; password?: string } } = {}): Promise<DoorProblem | null> {
  const said = await post<{ url?: string } & DoorProblem>("/auth/login", input);
  if (said.status === 200 && said.body.url) {
    window.location.assign(said.body.url);
    return null;
  }
  return said.body;
}

/** Signs this browser out, and out of the provider too when it offers. */
export async function signOut(): Promise<void> {
  const said = await post<{ redirect?: string }>("/auth/logout");
  current = null;
  listeners.forEach((l) => l());
  window.location.assign(said.body.redirect ?? "/");
}

export interface DoorInvite {
  workspace: string;
  mark: WorkspaceMark;
  inviter: string;
  role: "admin" | "member";
  expiresAt: number | null;
  password: boolean;
}

export const webJoinApi = {
  lookup: (code: string) => post<{ preview?: DoorInvite } & DoorProblem & { host?: string; workspace?: string }>("/auth/join/lookup", { code }),
  status: () => post<{ status?: "waiting" | "approved"; phrase?: string } & DoorProblem>("/auth/join/status"),
  cancel: () => post<{ ok?: boolean }>("/auth/join/cancel"),
};

/** The reason a sign in came back to the page (?signin=), in words. */
export function signInProblem(code: string | null, s: Pick<WebDoorSession, "provider" | "owner" | "workspace">): string | null {
  const words = { provider: s.provider, owner: s.owner, workspace: s.workspace.name };
  switch (code) {
    case null:
    case "":
      return null;
    case "expired":
      return t("webDoor.problem.expired");
    case "denied":
      return t("webDoor.problem.denied", words);
    case "not_allowed":
      return t("webDoor.problem.notAllowed", words);
    case "not_invited":
      return t("webDoor.problem.notInvited", words);
    case "team_required":
      return t("webDoor.problem.teamRequired", words);
    case "full":
      return t("webDoor.problem.full", words);
    case "rate_limited":
      return t("webDoor.problem.rateLimited");
    case "provider":
    case "offline":
      return t("webDoor.problem.provider", words);
    default:
      return t("webDoor.problem.failed", words);
  }
}
