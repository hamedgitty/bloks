// The other workspaces on this computer, for a phone paired with this one.
//
// Each workspace is paired on its own: its own devices, its own tokens,
// its own door. A phone that knows Personal used to learn about Okafor
// Studio only by somebody opening Okafor Studio's pairing page at the Mac
// and scanning again. This lets the phone ask the workspace it already
// trusts which others this person has here, and ask for a pairing to one
// of them, which it then claims exactly as it would claim one it scanned.
//
// What keeps that from widening the door:
//
//   Only the owner's own paired devices ask. Not this computer's window
//   (loopback carries no credential, so an agent's shell would pass for
//   it), not an agent's token, not a member's phone: a member never
//   learns what else the owner keeps here.
//
//   The app decides, not this server. Only the app knows the other
//   workspaces; it lists the person's own (Personal, Business, the named
//   ones), never a workspace they joined or a hosted one, and it asks the
//   other workspace's server for the pairing.
//
//   The other workspace has to have its phone access on already, which is
//   only ever switched on at the Mac. A pairing is single use and lives a
//   few minutes; it travels back over the channel this phone is already
//   trusted on, and the Mac is told each time one is made.
//
//   A handful per device in a while, so a lost phone cannot mint them in
//   a loop.
import type { LineAnswer } from "./desktop-line.ts";

export interface OtherWorkspace {
  id: string;
  name: string;
  kind: "personal" | "business" | "custom";
  mark: { color: string; pattern: string } | null;
  team: boolean;
  /** The workspace this phone asked. */
  here: boolean;
  /** Whether a pairing can be made for it now; null when its server did
   * not say (still starting). */
  pairable: boolean | null;
  /** Why not, in a sentence for the phone to show, when it cannot. */
  why: string | null;
  /** This copy's work moved to the person's hosted machine: its name, and
   * what to ask a pairing for (POST .../others/<pair>/pair) to add it. */
  movedTo?: { kind: "hosted"; name: string; pair: string };
}

/** How long a pairing made this way lives: long enough to tap through on
 * the phone, short enough that one nobody claimed is soon nothing. */
export const OTHER_PAIR_TTL_MS = 3 * 60_000;

/** At most this many pairings per device in this long. */
const MINTS = 5;
const MINT_WINDOW_MS = 10 * 60_000;

export class MintLimiter {
  private readonly made = new Map<string, number[]>();
  private readonly now: () => number;
  constructor(now: () => number = Date.now) {
    this.now = now;
  }
  /** Whether this device may have one more now; counts it when it may. */
  take(deviceId: string): boolean {
    const since = this.now() - MINT_WINDOW_MS;
    const recent = (this.made.get(deviceId) ?? []).filter((at) => at > since);
    if (recent.length >= MINTS) {
      this.made.set(deviceId, recent);
      return false;
    }
    recent.push(this.now());
    this.made.set(deviceId, recent);
    return true;
  }
}

export interface OthersDeps {
  /** The paired device asking, or null for anything that is not one. */
  caller: { id: string; name: string; personId?: string } | null;
  /** An agent's credential is on the request. */
  asAgent: boolean;
  /** Puts a question to the app; null without one. */
  askApp(what: string, payload: Record<string, unknown>, timeoutMs?: number): Promise<LineAnswer> | null;
  limiter: MintLimiter;
}

const ID = /^[a-z0-9_-]{1,40}$/;

function cleanList(raw: unknown): OtherWorkspace[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((w) => {
    const r = w as Partial<OtherWorkspace> | null;
    if (!r || typeof r.id !== "string" || !ID.test(r.id) || typeof r.name !== "string") return [];
    if (r.kind !== "personal" && r.kind !== "business" && r.kind !== "custom") return [];
    const mark = r.mark && typeof r.mark.color === "string" && typeof r.mark.pattern === "string" ? { color: r.mark.color, pattern: r.mark.pattern } : null;
    const went = r.movedTo && r.movedTo.kind === "hosted" && typeof r.movedTo.name === "string" && typeof r.movedTo.pair === "string" && ID.test(r.movedTo.pair) ? r.movedTo : null;
    return [
      {
        id: r.id,
        name: r.name.slice(0, 60),
        kind: r.kind,
        mark,
        team: r.team === true,
        here: r.here === true,
        pairable: typeof r.pairable === "boolean" ? r.pairable : null,
        why: typeof r.why === "string" ? r.why.slice(0, 300) : null,
        ...(went ? { movedTo: { kind: "hosted" as const, name: went.name.slice(0, 60), pair: went.pair } } : {}),
      },
    ];
  });
}

/**
 * GET /api/workspaces/others and POST /api/workspaces/others/:id/pair.
 * Null for any other path.
 */
export async function othersRoute(
  method: string,
  path: string,
  readBody: () => Promise<Record<string, unknown>>,
  deps: OthersDeps,
): Promise<{ status: number; body: unknown } | null> {
  if (path !== "/api/workspaces/others" && !path.startsWith("/api/workspaces/others/")) return null;
  if (deps.asAgent) return { status: 403, body: { error: "that is the person's" } };
  if (!deps.caller || deps.caller.personId) {
    return { status: 403, body: { error: "Only a phone paired with this workspace by its owner can ask for the others." } };
  }

  if (path === "/api/workspaces/others") {
    if (method !== "GET") return { status: 405, body: { error: "GET /api/workspaces/others" } };
    const asked = deps.askApp("workspaces", {});
    if (!asked) return { status: 404, body: { error: "This workspace is not run by the Bloks app, so it has no others." } };
    const said = await asked;
    if (said.error) return { status: typeof said.status === "number" ? said.status : 502, body: { error: said.error } };
    return { status: 200, body: { workspaces: cleanList(said.workspaces) } };
  }

  const m = path.match(/^\/api\/workspaces\/others\/([a-z0-9_-]{1,40})\/pair$/);
  if (!m) return { status: 404, body: { error: "no such route" } };
  if (method !== "POST") return { status: 405, body: { error: "POST /api/workspaces/others/:id/pair" } };
  const body = await readBody().catch(() => ({}) as Record<string, unknown>);
  if (!deps.limiter.take(deps.caller.id)) {
    return { status: 429, body: { error: "That is a lot of pairings in a short while. Try again in a few minutes." } };
  }
  const device = typeof body.device === "string" && body.device.trim() ? body.device.trim().slice(0, 60) : deps.caller.name;
  // the other workspace may have to start first, so this waits longer
  const asked = deps.askApp("pair", { target: m[1], device }, 45_000);
  if (!asked) return { status: 404, body: { error: "This workspace is not run by the Bloks app, so it has no others." } };
  const said = await asked;
  if (said.error) return { status: typeof said.status === "number" ? said.status : 502, body: { error: said.error } };
  const { ok: _ok, status: _status, ...rest } = said;
  return { status: 200, body: rest };
}

export interface MintDeps {
  /** A Bloks Cloud pairing link, or null while Bloks Cloud is off. */
  relayLink(ttlMs: number): { link: string; webLink: string; expiresAt: number; host: string } | null;
  /** Where this workspace answers on its network, when phone access is
   * on there and it is listening; null otherwise. */
  lan(): { addresses: string[]; port: number; name: string } | null;
  /** A one-time pairing token for the network door. */
  lanToken(ttlMs: number): { token: string; expiresAt: number };
}

/** Whether a pairing can be made for this workspace now, and why not. */
export function pairCheck(relayOn: boolean, lanOn: boolean): LineAnswer {
  if (relayOn || lanOn) return { ok: true, pairable: true, why: null };
  return { ok: true, pairable: false, why: "Phone access is off in this workspace. Turn it on there, on the computer it runs on." };
}

/**
 * A single-use pairing for this workspace, asked by the app for a phone
 * that is paired with another workspace here: through Bloks Cloud when
 * this workspace is online, which works from anywhere, else on this
 * network when phone access listens there.
 */
export function mintPairing(deps: MintDeps): LineAnswer {
  const relay = deps.relayLink(OTHER_PAIR_TTL_MS);
  if (relay) return { ok: true, via: "relay", link: relay.link, expiresAt: relay.expiresAt, host: relay.host };
  const lan = deps.lan();
  if (lan) {
    const made = deps.lanToken(OTHER_PAIR_TTL_MS);
    return { ok: true, via: "lan", lan: { addresses: lan.addresses, port: lan.port, token: made.token }, expiresAt: made.expiresAt, host: lan.name };
  }
  return { ok: false, status: 409, error: "Phone access is off in this workspace. Turn it on there, on the computer it runs on, then try again." };
}
