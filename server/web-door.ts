// The web door: a server of your own, opened in a browser at an address
// of your own, signed in with the identity provider you already run.
//
// bloks-server listens on loopback and is reached through Bloks Cloud.
// Somebody who runs it for a household or a small team behind their own
// reverse proxy wants the other thing self-hosted apps do: a page at
// https://bloks.example.com that everybody signs in to with the account
// they already have. That is this door. It is off unless BLOKS_WEB_URL
// is set, and it is a listener of its own (BLOKS_WEB_LISTEN), apart from
// the loopback port, so nothing about the loopback port changes:
//
//   Nothing that comes through this door is ever the person at the
//   keyboard. A proxy on the same machine connects from loopback, and
//   http-guard.ts refuses to count any connection here as local, so an
//   agent's credential, the owner's loopback routes and pairing are all
//   out of reach whatever the proxy sends.
//
//   A session cookie is the only credential. An Authorization header is
//   dropped, so a paired device's token means nothing here and a session
//   means nothing anywhere else. The cookie is HttpOnly, SameSite=Strict
//   and, on https, Secure with the __Host- prefix; a request that changes
//   anything must come from this door's own origin.
//
//   Who a session is comes from the provider (server/oidc.ts): the owner
//   when the identity is BLOKS_OIDC_OWNER, a member when it is linked to
//   one (server/web-sign-in.ts), and checked again on every request, so a
//   member removed is signed out at once. An identity becomes a member by
//   using an invite after signing in (the owner still lets them in, as
//   with any invite), or on its first sign in when BLOKS_OIDC_AUTO_CREATE
//   is on and the allow lists say it may.
//
// Behind the door a signed in owner gets what one of the owner's paired
// devices gets, and a member what member-access.ts allows, by the same
// routes and the same checks: the door only says who is asking.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

import { markWebDoor } from "./http-guard.ts";
import { OidcProvider, allowed, identityOf, isOwner, oidcConfigFrom, randomToken, roleFromGroups, safeUrl, sameSecret, type Identity, type OidcConfig } from "./oidc.ts";
import * as signIns from "./web-sign-in.ts";
import * as people from "./people.ts";
import * as invites from "./invites.ts";
import type { Members } from "./members.ts";
import type { PairedDevice } from "./pairing.ts";

// ── settings ───────────────────────────────────────────────────────────

export interface WebDoorSettings {
  /** Where browsers open it, origin only. */
  url: URL;
  host: string;
  port: number;
  oidc: OidcConfig;
}

export const DEFAULT_WEB_LISTEN = "127.0.0.1:8790";

/** "host:port", "[v6]:port" or a bare port, or null when it is none. */
export function parseListen(raw: string): { host: string; port: number } | null {
  const text = raw.trim();
  const m = text.match(/^(?:\[([0-9a-fA-F:.]+)\]|([\w.-]+)):(\d{1,5})$/) ?? text.match(/^()()(\d{1,5})$/);
  if (!m) return null;
  const port = Number(m[3]);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
  return { host: m[1] || m[2] || "127.0.0.1", port };
}

/** The door's settings from the environment, why they are wrong, or null
 * when it is not wanted at all. */
export function webDoorFrom(env: NodeJS.ProcessEnv): { settings: WebDoorSettings } | { error: string } | null {
  const raw = env.BLOKS_WEB_URL?.trim();
  if (!raw) {
    return env.BLOKS_OIDC_ISSUER?.trim() ? { error: "BLOKS_OIDC_ISSUER is set but BLOKS_WEB_URL is not: sign-in is for the address browsers open this server at." } : null;
  }
  const url = safeUrl(raw);
  if (!url || (url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) {
    return { error: "BLOKS_WEB_URL has to be an https address with nothing after the host, like https://bloks.example.com." };
  }
  const listen = parseListen(env.BLOKS_WEB_LISTEN?.trim() || DEFAULT_WEB_LISTEN);
  if (!listen) return { error: "BLOKS_WEB_LISTEN is a port, or an address and a port, like 0.0.0.0:8790." };
  const oidc = oidcConfigFrom(env, url);
  if (!oidc) return { error: "BLOKS_WEB_URL needs an identity provider to sign people in: set BLOKS_OIDC_ISSUER, BLOKS_OIDC_CLIENT_ID and BLOKS_OIDC_CLIENT_SECRET." };
  if ("error" in oidc) return { error: oidc.error };
  return { settings: { url: new URL(url.origin), ...listen, oidc: oidc.config } };
}

// ── who is asking ──────────────────────────────────────────────────────

export type WebCaller =
  | { kind: "owner"; session: signIns.WebSession }
  | { kind: "member"; personId: string; session: signIns.WebSession };

const callers = new WeakMap<IncomingMessage, WebCaller>();

/** Who a request through the web door is, for the server's own checks;
 * null for every request that did not come through it signed in. */
export function webCallerFor(req: IncomingMessage): WebCaller | null {
  return callers.get(req) ?? null;
}

/** The caller as the server's device checks take one: a browser, the
 * owner's or a member's. Its id names the session, never its token. */
export function webDevice(caller: WebCaller): PairedDevice {
  return {
    id: `web-${signIns.sessionId(caller.session)}`,
    name: "Browser",
    hash: caller.session.hash,
    pairedAt: caller.session.createdAt,
    ...(caller.kind === "member" ? { personId: caller.personId } : {}),
  };
}

// ── the door ───────────────────────────────────────────────────────────

export interface WebDoorDeps {
  /** The server's own request handling, which reads webCallerFor. */
  handle(req: IncomingMessage, res: ServerResponse): void;
  /** The built interface, when this server has one; false when it does not. */
  serveStatic(req: IncomingMessage, res: ServerResponse, path: string): boolean;
  members: Members;
  hostName(): string;
  closeStreams(personId: string): void;
  log(line: string): void;
}

/** How long a sign in may take, from the button to the callback. */
const FLOW_TTL_MS = 10 * 60_000;
const MAX_FLOWS = 1_000;

interface Flow {
  state: string;
  nonce: string;
  verifier: string;
  next: string;
  at: number;
  /** Signing in to use an invite: its code, and the join password when
   * the workspace asks for one. Kept in memory only, for ten minutes. */
  join?: { code: string; password?: string };
}

/** The reasons a sign in can end on the sign-in page, as the page reads
 * them (src/lib/webDoor.ts). Never anything from the provider verbatim. */
type Refusal = "expired" | "denied" | "failed" | "not_allowed" | "not_invited" | "team_required" | "full";

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string | string[]> = {}) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}

function redirect(res: ServerResponse, to: string, headers: Record<string, string | string[]> = {}) {
  res.writeHead(303, { location: to, "cache-control": "no-store", "referrer-policy": "no-referrer", ...headers });
  res.end();
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 16_000) req.destroy();
    });
    req.on("end", () => {
      try {
        const parsed = data ? JSON.parse(data) : {};
        resolve(parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {});
      } catch {
        resolve({});
      }
    });
    req.on("error", () => resolve({}));
  });
}

function cookies(req: IncomingMessage): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0) out.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
  }
  return out;
}

/** Where the browser goes after signing in: a page of this door, never
 * another site and never the door's own sign-in routes. */
function safeNext(raw: unknown): string {
  if (typeof raw !== "string" || !raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\") || raw.startsWith("/auth/") || raw.length > 300) return "/";
  return raw;
}

export function startWebDoor(settings: WebDoorSettings, deps: WebDoorDeps): { server: Server; provider: OidcProvider; close(): Promise<void> } {
  const provider = new OidcProvider(settings.oidc);
  const origin = settings.url.origin;
  const secure = settings.url.protocol === "https:";
  // __Host-: Secure, path /, no Domain, so no other host can set or read it
  const SESSION = secure ? "__Host-bloks_session" : "bloks_session";
  const FLOW = secure ? "__Host-bloks_flow" : "bloks_flow";
  const flows = new Map<string, Flow>();
  const starts = new invites.JoinLimiter(30, 10 * 60_000);

  const cookie = (name: string, value: string, maxAgeS: number, sameSite: "Strict" | "Lax") =>
    `${name}=${value}; Path=/; HttpOnly; SameSite=${sameSite}; Max-Age=${maxAgeS}${secure ? "; Secure" : ""}`;
  const sessionCookie = (token: string) => cookie(SESSION, token, Math.floor(signIns.SESSION_TTL_MS / 1000), "Strict");
  const clearSession = cookie(SESSION, "", 0, "Strict");
  // Lax, not Strict: the provider sends the browser back to the callback
  // from its own site, and a Strict cookie would not come with it
  const clearFlow = cookie(FLOW, "", 0, "Lax");

  /** The address that asked: the peer, or for a proxy on this machine or
   * its network, the address that proxy says it was asked by. */
  function addressOf(req: IncomingMessage): string {
    const peer = (req.socket.remoteAddress ?? "unknown").replace(/^::ffff:/, "");
    const forwarded = req.headers["x-forwarded-for"];
    const proxied = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|f[cd])/i.test(peer);
    if (proxied && typeof forwarded === "string") {
      const last = forwarded.split(",").map((s) => s.trim()).filter(Boolean).pop();
      if (last && last.length <= 64) return last;
    }
    return peer;
  }

  /** Whether a request may change anything: sent by a page of this door
   * itself, which every browser says in Origin on a POST. */
  function sameOrigin(req: IncomingMessage, unsafe: boolean): boolean {
    const site = req.headers["sec-fetch-site"];
    if (site === "cross-site" || site === "same-site") return false;
    const from = req.headers.origin;
    if (from === undefined) return !unsafe;
    return from === origin;
  }

  function sessionOf(req: IncomingMessage): signIns.WebSession | null {
    return signIns.sessionFor(cookies(req).get(SESSION) ?? null);
  }

  const sameIssuer = (a: string, b: string) => a.replace(/\/+$/, "") === b.replace(/\/+$/, "");

  /** Who a session is now, or null when it no longer stands for anybody:
   * the owner while the identity is still BLOKS_OIDC_OWNER, a member while
   * they are in the workspace and the identity is still theirs. */
  function callerOf(session: signIns.WebSession): WebCaller | null {
    if (session.waiting || !session.personId) return null;
    if (!sameIssuer(session.issuer, settings.oidc.issuer)) return null;
    if (session.personId === "owner") {
      const owner = settings.oidc.owner;
      if (!owner) return null;
      const same = owner.includes("@") ? owner.toLowerCase() === session.subject.toLowerCase() : owner === session.subject;
      return same ? { kind: "owner", session } : null;
    }
    const person = people.person(session.personId);
    if (!person?.role) return null;
    const linked = signIns.linkOf(session.issuer, session.subject);
    if (linked?.personId !== session.personId) return null;
    return { kind: "member", personId: session.personId, session };
  }

  function describe(caller: WebCaller | null) {
    if (!caller) return null;
    if (caller.kind === "owner") return { role: "owner" as const, name: deps.hostName(), signIn: caller.session.label ?? caller.session.subject };
    const p = people.person(caller.personId)!;
    return { role: p.role ?? ("member" as const), name: p.name, signIn: signIns.linkFor(p.id)?.label ?? null };
  }

  // ── the sign in itself ─────────────────────────────────────────────

  function rememberFlow(flow: Flow): string {
    const now = Date.now();
    for (const [id, f] of flows) if (now - f.at > FLOW_TTL_MS) flows.delete(id);
    while (flows.size >= MAX_FLOWS) flows.delete(flows.keys().next().value!);
    const id = randomToken();
    flows.set(id, flow);
    return id;
  }

  /** Takes the flow a callback belongs to, once: the cookie names it, and
   * the state the provider brought back must be its own. A second use of
   * the same state finds nothing. */
  function takeFlow(req: IncomingMessage, state: string | null): Flow | null {
    const id = cookies(req).get(FLOW);
    if (!id) return null;
    const flow = flows.get(id);
    flows.delete(id);
    if (!flow || !state || Date.now() - flow.at > FLOW_TTL_MS) return null;
    return sameSecret(flow.state, state) ? flow : null;
  }

  const refuse = (res: ServerResponse, why: Refusal, join = false) => redirect(res, `${join ? "/join" : "/"}?signin=${why}`, { "set-cookie": clearFlow });

  /** The identity is somebody: a session for them, and the browser back
   * where it was going. */
  function signedIn(res: ServerResponse, personId: string, identity: Identity, issuer: string, next: string) {
    const { token } = signIns.startSession({ personId, issuer, subject: identity.subject, label: identity.email ?? identity.subject });
    redirect(res, next, { "set-cookie": [clearFlow, sessionCookie(token)] });
  }

  async function callback(req: IncomingMessage, res: ServerResponse, url: URL) {
    const flow = takeFlow(req, url.searchParams.get("state"));
    if (!flow) return refuse(res, "expired");
    const joining = Boolean(flow.join);
    if (url.searchParams.get("error")) return refuse(res, "denied", joining);
    const code = url.searchParams.get("code");
    if (!code) return refuse(res, "failed", joining);
    let identity: Identity | null;
    let issuer: string;
    try {
      const tokens = await provider.exchange(code, flow.verifier);
      const claims = await provider.fillIn(await provider.verify(tokens.idToken, flow.nonce), tokens.accessToken);
      identity = identityOf(claims, settings.oidc);
      issuer = (await provider.discovery()).issuer;
      if (!identity) throw new Error(`the ID token has no ${settings.oidc.personClaim} claim`);
    } catch (e) {
      deps.log(`[bloks] web sign-in failed: ${e instanceof Error ? e.message : String(e)}`);
      return refuse(res, "failed", joining);
    }

    // An address the provider says it has not verified is not who it
    // names when the address is who somebody is: anybody can type one in
    // where the provider lets people sign themselves up. Said only when
    // the provider says so; one that never sends the claim is taken at
    // its word, as isOwner does.
    if (settings.oidc.personClaim === "email" && !identity.emailVerified) {
      deps.log(`[bloks] web sign-in refused: the provider has not verified ${identity.subject}`);
      return refuse(res, "not_allowed", joining);
    }
    // the owner stays the owner, whatever the allow lists say
    if (isOwner(identity, settings.oidc)) return signedIn(res, "owner", identity, issuer, flow.next);
    if (!allowed(identity, settings.oidc)) {
      deps.log(`[bloks] web sign-in refused: ${identity.email ?? identity.subject} is not in the allowed groups or addresses`);
      return refuse(res, "not_allowed", joining);
    }
    const role = roleFromGroups(identity, settings.oidc);
    const label = identity.email ?? identity.subject;
    const known = signIns.linkOf(issuer, identity.subject);
    if (known && people.person(known.personId)?.role) {
      signIns.noteSignedIn(known, label);
      if (role) deps.members.syncRole(known.personId, role);
      return signedIn(res, known.personId, identity, issuer, joining ? "/" : flow.next);
    }
    // linked to somebody who has since gone: that link means nothing now
    if (known) signIns.forgetPerson(known.personId);

    if (flow.join) return useInvite(req, res, flow.join, identity, issuer, role, label);

    if (settings.oidc.autoCreate) {
      const made = await deps.members.admitFromSignIn({ name: identity.name, role: role ?? "member" });
      if (!made.ok) return refuse(res, made.code);
      signIns.link(issuer, identity.subject, made.person.id, label);
      deps.log(`[bloks] web sign-in: ${label} (${settings.oidc.personClaim} ${identity.subject}) is now a member`);
      return signedIn(res, made.person.id, identity, issuer, flow.next);
    }
    // the identity's own value, for an owner who has yet to set
    // BLOKS_OIDC_OWNER and needs to know what theirs is
    deps.log(`[bloks] web sign-in refused: ${label} (${settings.oidc.personClaim} ${identity.subject}) is not in the workspace and has no invite`);
    return refuse(res, "not_invited");
  }

  /**
   * Somebody signed in to use an invite: their request is made now, from
   * a session that waits for the owner's answer and reaches nothing else.
   * Its token's digest is the request's device token, so the four words
   * the owner sees are bound to this browser.
   */
  async function useInvite(req: IncomingMessage, res: ServerResponse, join: NonNullable<Flow["join"]>, identity: Identity, issuer: string, role: "admin" | "member" | null, label: string) {
    const inv = invites.inviteByCode(join.code);
    if (!inv) return refuse(res, "expired", true);
    const { token, session } = signIns.startSession({
      personId: "",
      issuer,
      subject: identity.subject,
      waiting: { inviteId: inv.id, name: identity.name, label },
      ttlMs: Math.max(60_000, inv.expiresAt + 60 * 60_000 - Date.now()),
    });
    const asked = await deps.members.webJoin(
      "/api/join/claim",
      { code: join.code, name: identity.name, tokenHash: session.hash, device: "browser", ...(join.password ? { password: join.password } : {}) },
      addressOf(req),
    );
    const body = asked.body as { status?: string; personId?: string; code?: string };
    if (asked.status === 200 && body.status === "approved" && body.personId) {
      admitted(session, body.personId, role, label);
      return redirect(res, "/", { "set-cookie": [clearFlow, sessionCookie(token)] });
    }
    if (asked.status === 200 && body.status === "waiting") {
      return redirect(res, "/join", { "set-cookie": [clearFlow, sessionCookie(token)] });
    }
    signIns.endSession(session.hash);
    // a password to type again keeps the code in the page's own fragment,
    // which no server is sent, so the invite is not looked for twice
    const retype = body.code === "wrong_password" || body.code === "password_required" ? `#${join.code}` : "";
    return redirect(res, `/join?error=${encodeURIComponent(body.code ?? "failed")}${retype}`, { "set-cookie": clearFlow });
  }

  /** A waiting session let in: the identity is theirs from now on. */
  function admitted(session: signIns.WebSession, personId: string, role: "admin" | "member" | null, label: string) {
    signIns.link(session.issuer, session.subject, personId, label);
    signIns.admitSession(session.hash, personId);
    if (role) deps.members.syncRole(personId, role);
  }

  /** Where a waiting session's request stands, asked of the same door the
   * invite was made at. */
  async function waitingStatus(req: IncomingMessage, session: signIns.WebSession): Promise<{ status: number; body: Record<string, unknown>; ended: boolean }> {
    const inv = invites.invite(session.waiting!.inviteId);
    if (!inv) return { status: 410, body: { code: "expired", error: "This invite has expired." }, ended: true };
    const asked = await deps.members.webJoin("/api/join/status", { code: inv.code, tokenHash: session.hash }, addressOf(req));
    const body = (asked.body ?? {}) as Record<string, unknown>;
    if (asked.status === 200 && body.status === "approved" && typeof body.personId === "string") {
      admitted(session, body.personId, null, session.waiting!.label);
      return { status: 200, body: { status: "approved" }, ended: false };
    }
    if (asked.status === 200 && body.status === "waiting") {
      return { status: 200, body: { status: "waiting", phrase: body.phrase, about: body.about }, ended: false };
    }
    return { status: asked.status, body: { code: body.code, error: body.error }, ended: true };
  }

  // ── routes ─────────────────────────────────────────────────────────

  async function authRoute(req: IncomingMessage, res: ServerResponse, method: string, url: URL) {
    const path = url.pathname;
    const ws = deps.members.identity();

    if (method === "GET" && path === "/auth/session") {
      const session = sessionOf(req);
      let waiting: Record<string, unknown> | null = null;
      if (session?.waiting) {
        const said = await waitingStatus(req, session);
        if (said.ended) signIns.endSession(session.hash);
        // let in while away: the session is the member's now, and the page
        // the browser opens next is the member's app
        else if (said.body.status !== "approved") waiting = said.body;
      }
      const caller = session ? callerOf(session) : null;
      return json(res, 200, {
        door: "web",
        provider: settings.oidc.name,
        workspace: { name: ws.name, mark: ws.mark },
        owner: deps.hostName(),
        signedIn: Boolean(caller),
        as: describe(caller),
        ...(waiting ? { waiting: { ...waiting, name: session!.waiting!.name } } : {}),
      }, session && !caller && !waiting ? { "set-cookie": clearSession } : {});
    }

    if (method === "GET" && path === "/auth/callback") return callback(req, res, url);

    if (!sameOrigin(req, true)) return json(res, 403, { error: "cross-origin requests are not allowed" });

    if (method === "POST" && path === "/auth/login") {
      if (!starts.allow(addressOf(req))) return json(res, 429, { code: "rate_limited", error: "Too many tries. Wait a minute, then try again." });
      const body = await readBody(req);
      let join: Flow["join"];
      if (body.join && typeof body.join === "object") {
        const asked = body.join as { code?: unknown; password?: unknown };
        const code = invites.normalizeCode(asked.code);
        if (!code) return json(res, 400, { code: "wrong_code", error: "That is not an invite code." });
        // said before the provider's page, not after it: an invite that has
        // ended is worth knowing about without signing in first
        const found = await deps.members.webJoin("/api/join/lookup", { code }, addressOf(req));
        if (found.status !== 200) return json(res, found.status, found.body);
        join = { code, ...(typeof asked.password === "string" && asked.password ? { password: asked.password.slice(0, invites.MAX_PASSWORD) } : {}) };
      }
      const flow: Flow = { state: randomToken(), nonce: randomToken(), verifier: randomToken(), next: safeNext(body.next), at: Date.now(), ...(join ? { join } : {}) };
      let to: string;
      try {
        to = await provider.authorizeUrl(flow);
      } catch (e) {
        deps.log(`[bloks] web sign-in: the provider could not be reached: ${e instanceof Error ? e.message : String(e)}`);
        return json(res, 502, { code: "provider", error: "The sign-in provider did not answer. Try again in a moment." });
      }
      const id = rememberFlow(flow);
      return json(res, 200, { url: to }, { "set-cookie": cookie(FLOW, id, Math.floor(FLOW_TTL_MS / 1000), "Lax") });
    }

    if (method === "POST" && path === "/auth/logout") {
      const session = sessionOf(req);
      if (session) {
        // a browser still waiting withdraws its request as it goes, as
        // Cancel would: nobody is let in to a browser that left
        if (session.waiting) {
          const inv = invites.invite(session.waiting.inviteId);
          if (inv) await deps.members.webJoin("/api/join/cancel", { code: inv.code, tokenHash: session.hash }, addressOf(req)).catch(() => {});
        }
        signIns.endSession(session.hash);
        if (session.personId && session.personId !== "owner") deps.closeStreams(session.personId);
      }
      const away = await provider.endSessionUrl(`${origin}/`);
      return json(res, 200, { ok: true, redirect: away ?? "/" }, { "set-cookie": clearSession });
    }

    if (method === "POST" && path === "/auth/join/lookup") {
      const body = await readBody(req);
      const code = invites.normalizeCode(body.code);
      if (!code) return json(res, 400, { code: "wrong_code", error: "That is not an invite code." });
      const found = await deps.members.webJoin("/api/join/lookup", { code }, addressOf(req));
      const { hostKey: _key, ...shown } = (found.body ?? {}) as Record<string, unknown>;
      return json(res, found.status, shown);
    }

    if (path === "/auth/join/status" || path === "/auth/join/cancel") {
      const session = sessionOf(req);
      // let in from the Members page while this browser waited: in already
      if (path === "/auth/join/status" && method === "POST" && session && !session.waiting && session.personId && session.personId !== "owner") {
        return json(res, 200, { status: "approved" });
      }
      if (!session?.waiting) return json(res, 404, { code: "no_request", error: "There is no request from this browser." });
      if (path === "/auth/join/cancel" && method === "POST") {
        const inv = invites.invite(session.waiting.inviteId);
        if (inv) await deps.members.webJoin("/api/join/cancel", { code: inv.code, tokenHash: session.hash }, addressOf(req));
        signIns.endSession(session.hash);
        return json(res, 200, { ok: true }, { "set-cookie": clearSession });
      }
      if (method !== "POST") return json(res, 405, { error: "POST" });
      const said = await waitingStatus(req, session);
      if (said.ended) signIns.endSession(session.hash);
      return json(res, said.status, said.body, said.ended ? { "set-cookie": clearSession } : {});
    }
    return json(res, 404, { error: "no such route" });
  }

  function apiRoute(req: IncomingMessage, res: ServerResponse, method: string, path: string) {
    const unsafe = method !== "GET" && method !== "HEAD";
    if (!sameOrigin(req, unsafe)) return json(res, 403, { error: "cross-origin requests are not allowed" });
    // a session cookie is the only credential here (see the top of the file)
    delete req.headers.authorization;
    const session = sessionOf(req);
    const caller = session ? callerOf(session) : null;
    if (!caller) {
      if (method === "GET" && path === "/api/health") return json(res, 200, { app: "bloks", door: "web", signedIn: false });
      return json(res, 401, { code: "signin", error: "Sign in first." });
    }
    callers.set(req, caller);
    deps.handle(req, res);
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", origin);
    const method = req.method ?? "GET";
    try {
      if (url.pathname.startsWith("/auth/")) return await authRoute(req, res, method, url);
      if (url.pathname.startsWith("/api/")) return apiRoute(req, res, method, url.pathname);
      // the interface itself is public, as any site's sign-in page is; what
      // it shows comes from the routes above
      if ((method === "GET" || method === "HEAD") && deps.serveStatic(req, res, url.pathname)) return;
      return json(res, 404, { error: "not found" });
    } catch (e) {
      deps.log(`[bloks] web door: ${e instanceof Error ? e.message : String(e)}`);
      if (!res.headersSent) json(res, 500, { error: "Something went wrong. Try again." });
      else res.end();
    }
  }

  const server = createServer((req, res) => void handle(req, res));
  server.on("connection", (socket) => markWebDoor(socket));
  // no sockets of any kind through this door: a terminal or a desktop is
  // for the owner's paired devices
  server.on("upgrade", (_req: IncomingMessage, socket: Duplex) => socket.destroy());
  server.on("error", (error: NodeJS.ErrnoException) => {
    deps.log(
      error.code === "EADDRINUSE"
        ? `[bloks] the web door could not listen on ${settings.host}:${settings.port}: something else holds that port. Set BLOKS_WEB_LISTEN to another.`
        : `[bloks] the web door stopped: ${error.message}`,
    );
  });
  server.listen(settings.port, settings.host, () => {
    deps.log(`[bloks] web door on ${settings.host}:${settings.port}, for ${origin}`);
  });
  // ask the provider once now, so a wrong issuer is said at start, not at
  // the first person's sign in
  void provider.discovery().catch((e) => deps.log(`[bloks] web sign-in: ${settings.oidc.issuer} did not answer as an OpenID provider: ${e instanceof Error ? e.message : String(e)}`));
  return { server, provider, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}
