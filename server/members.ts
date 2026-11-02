// The people of the workspace: who is in, who is asking, and the door.
//
// people.ts keeps who is in and invites.ts keeps the invites; this file is
// what the owner, the admins and somebody holding a code can do with
// them, over HTTP. It is handed what it needs from the server (the relay
// line, the plan, the agents, a way to broadcast) rather than reaching
// for it, so the rules here read in one place and the server only wires
// them up.
//
// Three callers, three surfaces:
//
//   The owner, and an admin through member-access.ts: the Members page.
//   /api/workspace/...
//
//   Somebody holding an invite and nothing else, through Bloks Cloud or on
//   this network: a sealed conversation about one thing, joining (joinAsk
//   and the /api/join/ routes). Sealed for this workspace's join key, so
//   the relay that carried it cannot read the password in it. Or from a
//   browser that signed in at this server's web door (webJoin), where the
//   connection itself is this server's and nothing needs sealing.
//
// The joiner's own side, when this Mac is the one joining somewhere else,
// is server/join-client.ts.
import { randomUUID, createHash } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";

import { DATA_DIR } from "./config.ts";
import { isRecord, readSaved, writeFileAtomic } from "./atomic-write.ts";
import * as people from "./people.ts";
import * as invites from "./invites.ts";
import { addMemberDevice, memberDevices, revokePerson, seenAt } from "./pairing.ts";
import { open, seal, type Envelope, type RelayRequest } from "./relay-crypto.ts";
import { SeenNonces, type RelayLink } from "./relay-link.ts";
import { MemberLimits, monthOf } from "./member-limits.ts";
import { ProfileNotes } from "./profile-notes.ts";
import { inTeamConversation, privacyLine, type AgentAccess, type Who } from "./access.ts";
import { audienceOf, type BlokRecord } from "./bloks.ts";
import type { BotRecord } from "./store.ts";
import { membersActive, pausedWords, teamRequiredWords, workspaceMemberLimit, type Plan } from "./plan-limits.ts";
import { nameRefusal } from "./owner-name.ts";

// ── the workspace this server is ───────────────────────────────────────

export interface WorkspaceIdentity {
  id: string;
  name: string;
  kind: string;
  mark: { color: string; pattern: string };
}

/** Personal's own mark: the workspace every Bloks starts as. */
const PERSONAL = { color: "#E9A83A", pattern: "010111101" };

const identityFile = () => join(DATA_DIR, "workspace.json");
const COLOR = /^#[0-9A-Fa-f]{6}$/;
const PATTERN = /^[01]{9}$/;

/**
 * Which workspace this server is. One server runs per workspace, and the
 * app's list names them (electron/workspaces.mjs): the app says the name
 * and mark when it starts the server (BLOKS_WORKSPACE_*), and the owner's
 * window says them again whenever it opens Members (setIdentity), so a
 * rename reaches invites and the welcome without a restart. A server
 * started on its own is Personal.
 */
export function workspaceIdentity(env: NodeJS.ProcessEnv = process.env): WorkspaceIdentity {
  const saved = readSaved<Partial<WorkspaceIdentity>>(identityFile(), {}, isRecord);
  const savedMark = (saved.mark ?? {}) as Partial<WorkspaceIdentity["mark"]>;
  const color = COLOR.test(savedMark.color ?? "") ? savedMark.color! : COLOR.test(env.BLOKS_WORKSPACE_COLOR ?? "") ? env.BLOKS_WORKSPACE_COLOR! : PERSONAL.color;
  const pattern = PATTERN.test(savedMark.pattern ?? "") ? savedMark.pattern! : PATTERN.test(env.BLOKS_WORKSPACE_PATTERN ?? "") ? env.BLOKS_WORKSPACE_PATTERN! : PERSONAL.pattern;
  const name = people.cleanName(saved.name) ?? people.cleanName(env.BLOKS_WORKSPACE_NAME) ?? "Personal";
  return {
    id: /^[\w-]{1,64}$/.test(env.BLOKS_WORKSPACE_ID ?? "") ? env.BLOKS_WORKSPACE_ID! : "personal",
    name,
    kind: people.cleanName(saved.kind) ?? people.cleanName(env.BLOKS_WORKSPACE_KIND) ?? (name === "Personal" ? "Personal" : "Team"),
    mark: { color, pattern },
  };
}

/** The owner's window telling this server its name and mark. */
export function setIdentity(input: Record<string, unknown>): WorkspaceIdentity | null {
  const name = people.cleanName(input.name);
  const mark = (input.mark ?? null) as { color?: unknown; pattern?: unknown } | null;
  if (!name || !mark || typeof mark.color !== "string" || !COLOR.test(mark.color) || typeof mark.pattern !== "string" || !PATTERN.test(mark.pattern)) return null;
  const kind = people.cleanName(input.kind);
  // the default the mark would go back to is the app's word, kept as it is
  const markDefault = savedMarkDefault();
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  writeFileAtomic(
    identityFile(),
    JSON.stringify({ name, mark: { color: mark.color, pattern: mark.pattern }, ...(kind ? { kind } : {}), ...(markDefault !== undefined ? { markDefault } : {}) }, null, 2),
    0o600,
  );
  return workspaceIdentity();
}

type MarkValue = WorkspaceIdentity["mark"];
const isMarkValue = (m: unknown): m is MarkValue =>
  isRecord(m) && typeof m.color === "string" && COLOR.test(m.color) && typeof m.pattern === "string" && PATTERN.test(m.pattern);

/** The mark "Back to the default" goes back to, as the app last said:
 * a mark, null for a workspace whose mark was drawn for it, or undefined
 * when the app never said (a server on its own). */
export function savedMarkDefault(): MarkValue | null | undefined {
  const saved = readSaved<Record<string, unknown>>(identityFile(), {}, isRecord);
  if (!("markDefault" in saved)) return undefined;
  return isMarkValue(saved.markDefault) ? { color: saved.markDefault.color, pattern: saved.markDefault.pattern } : null;
}

/**
 * The workspace's mark alone, from the app or from the owner's phone,
 * kept with the name and kind already here, so the phone, the invites
 * and the welcome show it at once. `markDefault` is kept when given.
 */
export function setIdentityMark(mark: MarkValue, markDefault?: MarkValue | null): WorkspaceIdentity {
  // only the mark: a name this file never held stays the app's to say as
  // the server starts, so a rename is not frozen here by a change of mark
  const saved = readSaved<Record<string, unknown>>(identityFile(), {}, isRecord);
  const next: Record<string, unknown> = { ...saved, mark: { color: mark.color, pattern: mark.pattern } };
  if (markDefault !== undefined) next.markDefault = markDefault ? { color: markDefault.color, pattern: markDefault.pattern } : null;
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  writeFileAtomic(identityFile(), JSON.stringify(next, null, 2), 0o600);
  return workspaceIdentity();
}

// ── what the server hands over ─────────────────────────────────────────

export interface MembersDeps {
  hostName(): string;
  /** Whether the owner has said what to call them: an invite says who it
   * is from, and every screen after it says whose workspace it is. */
  ownerNamed(): boolean;
  relay: RelayLink;
  /** Bloks Cloud is on and this workspace has a space. */
  relayReady(): boolean;
  relayUrl(): string | null;
  /** The owner's plan, for who may be let in (server/owner-plan.ts).
   * `fresh` asks again rather than taking the last answer. */
  plan(fresh?: boolean): Promise<Plan | null>;
  bots(): BotRecord[];
  rooms(): BlokRecord[];
  engines(): Array<{ id: string; name: string }>;
  /** To every surface, each member's through member-access.ts. */
  broadcast(frame: object): void;
  /** Hangs up on a person's open streams, so their next request is read
   * with whatever just changed. */
  closeStreams(personId: string): void;
  /** Where this computer answers on its own network ("192.168.1.20:8799"),
   * when pairing listens there; null otherwise. */
  lanAddress(): string | null;
  /** A member's Bloks AI share this month, as the service last said. */
  aiUsedPercent(personId: string): number | null;
  /** Their solo agents go when they do. */
  dropAgentsOf(personId: string): void;
  /** Sets who shares a team agent's conversation; undefined is everyone. */
  setAccess(botId: string, access: BotRecord["access"]): void;
  setAudience(roomId: string, audience: "everyone" | "some"): void;
  /** Deletes a member's own agent for good, as the owner or an admin,
   * and says so in the record (server/ledger.ts). */
  deleteMemberAgent(bot: BotRecord, by: { actor: string; maker: string }): Promise<void>;
  /** Where a browser opens this server (BLOKS_WEB_URL), when its web
   * door is on: invites then carry a link to it. */
  webUrl(): string | null;
  /** Signing in from a browser (server/web-sign-in.ts): when the person
   * last did anything there, how many browsers they are signed in on and
   * the identity they sign in with; and forgetting it all when they go. */
  signIns(personId: string): { lastSeen: number | null; sessions: number; label: string | null };
  forgetSignIns(personId: string): void;
}

export type Actor = { kind: "owner" } | { kind: "member"; personId: string; role: people.WorkspaceRole };

/** A member as server/access.ts takes them. */
export function asWho(p: Pick<people.Person, "id" | "role">): Who {
  return { kind: "member", personId: p.id, role: p.role ?? "member" };
}

/** The most people besides the owner a plan lets in: Bloks Team's ten,
 * and nobody without it (server/plan-limits.ts). */
export function memberLimitFor(plan: Plan | null): number {
  return workspaceMemberLimit(plan);
}

const ROLE_WORD: Record<people.WorkspaceRole, string> = { member: "Member", admin: "Admin" };

/** The words for every way a request to join is turned away, said as the
 * joiner's screen says them (design: Edge-States). */
function joinWords(error: invites.JoinError, ctx: { host: string; owner: string; workspace: string; triesLeft?: number }): string {
  switch (error) {
    case "wrong_code":
      return `That code does not match an invite. Check each letter with ${ctx.host} and try again.`;
    case "expired":
      return `This invite has expired. Invites last 24 hours: ask ${ctx.host} for a new one.`;
    case "cancelled":
      return `${ctx.host} cancelled this invite. Ask them for a new one.`;
    case "used":
      return `This invite was already used. Ask ${ctx.host} for a new one.`;
    case "declined":
      return `${ctx.host} did not let this request in.`;
    case "closed":
      return `This invite is closed after too many wrong passwords, and ${ctx.host} has been told. Ask them for a new one.`;
    case "password_required":
      return `${ctx.workspace} asks for a join password. ${ctx.host} can tell you what it is.`;
    case "wrong_password":
      return `That is not the password. ${ctx.triesLeft ?? 0} ${ctx.triesLeft === 1 ? "try" : "tries"} left on this invite.`;
    case "already_member":
      return `You are already in ${ctx.workspace}.`;
    case "full":
      return `${ctx.workspace} has as many members as its plan allows. Ask ${ctx.host} to make room.`;
    case "team_required":
      return pausedWords(ctx.owner);
    case "invalid":
      return "A name is needed to ask.";
  }
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 64_000) {
        req.destroy();
        reject(Object.assign(new Error("body too large"), { status: 413 }));
      }
    });
    req.on("end", () => {
      try {
        const parsed = data ? JSON.parse(data) : {};
        resolve(parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {});
      } catch {
        reject(Object.assign(new Error("invalid JSON body"), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

/** How long a joiner's sealed request may be in flight, as for any phone. */
const REPLAY_WINDOW_MS = 120_000;
/** The routes a sealed join conversation may name. */
const JOIN_PATHS = new Set(["/api/join/lookup", "/api/join/claim", "/api/join/status", "/api/join/cancel"]);

export function createMembers(deps: MembersDeps) {
  const limits = new MemberLimits();
  const notes = new Map<string, ProfileNotes>();
  const nonces = new SeenNonces();
  // wrong codes, by where they came from: an address on this network, or
  // "relay" for everything Bloks Cloud carried (which limits its own too)
  const guesses = new invites.JoinLimiter(10, 10 * 60_000);
  const relayGuesses = new invites.JoinLimiter(30, 10 * 60_000);

  const identity = () => workspaceIdentity();
  const inviterName = (invitedBy: string) => (invitedBy === "owner" ? deps.hostName() : (people.person(invitedBy)?.name ?? deps.hostName()));
  const soloCount = (personId: string) => deps.bots().filter((b) => b.solo?.by === personId && !b.archivedAt).length;

  async function full(): Promise<boolean> {
    return people.workspaceMembers().length >= memberLimitFor(await deps.plan());
  }

  async function fullWords(): Promise<string> {
    const limit = memberLimitFor(await deps.plan());
    return `${identity().name} has ${limit} members, as many as a workspace holds.`;
  }

  /** Why nobody can be let in right now, when the owner is not on Bloks
   * Team; null when they are. Said to whoever tried. */
  async function teamRefusal(fresh = false): Promise<{ status: 402; body: { code: "team_required"; error: string } } | null> {
    const plan = await deps.plan(fresh);
    if (membersActive(plan)) return null;
    return { status: 402, body: { code: "team_required", error: teamRequiredWords(identity().name) } };
  }

  function isMemberDevice(tokenHash: string): boolean {
    return memberDevices().some((d) => d.hash === tokenHash && Boolean(d.personId && people.workspaceRole(d.personId)));
  }

  function online(): { available: boolean; why?: string } {
    if (!deps.relayReady()) return { available: false, why: "This workspace is not reachable online, so invites work on this network only." };
    if (!deps.relay.state.connected) return { available: false, why: "Bloks Cloud is not connected right now, so new invites work on this network only." };
    return { available: true };
  }

  // ── shapes ─────────────────────────────────────────────────────────

  function inviteView(inv: invites.WorkspaceInvite) {
    const lan = inv.relay === "registered" ? undefined : (deps.lanAddress() ?? undefined);
    const web = deps.webUrl();
    return {
      id: inv.id,
      publicId: inv.publicId,
      code: invites.formatCode(inv.code),
      link: invites.inviteLink(inv.publicId, inv.code, lan),
      // the same invite opened in a browser, at this server's own address;
      // the code after the # is never sent to it
      ...(web ? { webLink: `${web}/join#${inv.code}` } : {}),
      name: inv.name ?? null,
      role: inv.role,
      createdAt: inv.createdAt,
      expiresAt: inv.expiresAt,
      invitedBy: inviterName(inv.invitedBy),
      status: invites.shownStatus(inv),
      online: inv.relay === "registered",
    };
  }

  function requestView(inv: invites.WorkspaceInvite) {
    const c = inv.claim!;
    return {
      inviteId: inv.id,
      name: c.name,
      forName: inv.name ?? null,
      role: inv.role,
      device: c.device,
      at: c.at,
      password: c.password,
      phrase: invites.phraseOf(inv),
      via: c.via,
      expiresAt: inv.expiresAt,
    };
  }

  function memberView(p: people.Person, seeLimits: boolean) {
    const devices = memberDevices().filter((d) => d.personId === p.id);
    const web = deps.signIns(p.id);
    const seen = Math.max(devices.map((d) => seenAt(d.id) ?? 0).reduce((a, b) => Math.max(a, b), 0), web.lastSeen ?? 0);
    return {
      id: p.id,
      name: p.name,
      role: p.role!,
      joinedAt: p.joinedAt ?? p.createdAt,
      invitedBy: inviterName(p.invitedBy ?? "owner"),
      device: p.device ?? null,
      devices: devices.length + web.sessions,
      lastActive: seen || null,
      // the identity they sign in with from a browser, as the provider
      // calls them, when they have one
      signIn: web.label,
      soloAgents: soloCount(p.id),
      ...(seeLimits
        ? {
            spend: { month: monthOf(), usd: limits.spentThisMonth(p.id), aiPercent: deps.aiUsedPercent(p.id) },
            limits: limits.limitOf(p.id),
          }
        : {}),
    };
  }

  function peopleFrame() {
    deps.broadcast({
      kind: "workspace.people",
      members: people.workspaceMembers().map((p) => ({ id: p.id, name: p.name, role: p.role })),
    });
  }

  function waitingFrame() {
    deps.broadcast({ kind: "workspace.waiting", count: waitingCount() });
  }

  function waitingCount(): number {
    return invites.outstanding().filter((i) => i.status === "waiting").length;
  }

  /** Revokes what an invite holds open at the relay, once it is done. */
  async function retire(inv: invites.WorkspaceInvite, keepToken = false) {
    if (inv.relay === "registered") await deps.relay.cancelInvite(inv.publicId);
    if (inv.relayTokenHash && !keepToken) await deps.relay.revokeClient(inv.relayTokenHash);
  }

  /** Invites that ran out: their relay tokens go, and the owner's list
   * and the switcher's count catch up. Run on a timer and on every read. */
  async function sweep() {
    const gone = invites.sweepExpired();
    for (const inv of gone) await retire(inv).catch(() => {});
    if (gone.length) {
      waitingFrame();
      peopleFrame();
    }
  }

  // ── letting somebody in ────────────────────────────────────────────

  /** The welcome a joiner's app shows, and their credentials. */
  function admittedView(inv: invites.WorkspaceInvite, handover?: string) {
    const ws = identity();
    const visible = deps.bots().filter((b) => !b.archivedAt && !b.solo && (!inv.personId || inTeamConversation(b, { kind: "member", personId: inv.personId, role: inv.role })));
    return {
      status: "approved" as const,
      personId: inv.personId,
      deviceId: inv.deviceId,
      role: inv.role,
      relay: deps.relayReady() && deps.relayUrl() ? { url: deps.relayUrl(), ...(handover ? { clientToken: handover } : {}) } : null,
      lan: deps.lanAddress(),
      welcome: {
        workspace: ws,
        inviter: inviterName(inv.invitedBy),
        approvedBy: inviterName(inv.invitedBy),
        role: inv.role,
        agents: visible.slice(0, 6).map((b) => ({ id: b.id, name: b.name, title: b.title, color: b.color, shape: b.shape ?? null })),
        agentCount: visible.length,
      },
    };
  }

  /**
   * Lets a waiting request in: one person for the whole workspace, their
   * device, a relay token, the invite closed. The device is registered
   * before the person is written, so a refused settings read leaves the
   * request as it was, to try again.
   */
  async function admit(inv: invites.WorkspaceInvite): Promise<{ ok: true; person: people.Person } | { ok: false; status: number; code: string; error: string }> {
    if (inv.status !== "waiting" || !inv.claim) return { ok: false, status: 409, code: "gone", error: "Nobody is waiting on that invite any more." };
    const locked = await teamRefusal();
    if (locked) return { ok: false, ...locked.body, status: locked.status };
    if (await full()) return { ok: false, status: 402, code: "full", error: await fullWords() };
    if (isMemberDevice(inv.claim.tokenHash)) return { ok: false, status: 409, code: "already_member", error: "That device is already in the workspace." };
    // Whoever came through the invite's own relay token keeps it, as a
    // room member always did. Anyone else (the same network, or a relay
    // that carried them some other way) gets one of their own, handed
    // over with the answer to their next poll.
    const keeps = inv.claim.via === "relay" && Boolean(inv.relayTokenHash) && (!inv.claim.relayClient || inv.claim.relayClient === inv.relayTokenHash);
    // Somebody who signed in from a browser here has no device to pair and
    // no relay to go through: their session is their way in, and it is
    // web-door.ts that links it to them once they are in.
    const web = inv.claim.via === "web";
    let handover: string | undefined;
    if (!keeps && !web && deps.relayReady()) handover = (await deps.relay.mintClient()) ?? undefined;
    const relayTokenHash = keeps ? inv.relayTokenHash : handover ? sha256(handover) : undefined;
    let deviceId = "";
    const claim = inv.claim;
    const person = people.admitToWorkspace(
      { name: claim.name, role: inv.role, invitedBy: inv.invitedBy, device: claim.device, ...(relayTokenHash ? { relayTokenHash } : {}) },
      (p) => {
        if (!web) deviceId = addMemberDevice(p.id, p.name, claim.tokenHash).id;
      },
    );
    invites.markApproved(inv.id, { personId: person.id, deviceId, ...(handover ? { handover } : {}) });
    // the invite is used: out of Bloks Cloud's index, and its token gone
    // unless the person now holds it
    await retire(inv, keeps).catch(() => {});
    peopleFrame();
    waitingFrame();
    deps.broadcast({
      kind: "workspace.joined",
      person: { id: person.id, name: person.name, role: person.role },
      inviteId: inv.id,
      workspace: identity().name,
    });
    return { ok: true, person };
  }

  async function declineRequest(id: string): Promise<boolean> {
    const inv = invites.decline(id);
    if (!inv) return false;
    await retire(inv).catch(() => {});
    waitingFrame();
    peopleFrame();
    return true;
  }

  /** Out of the workspace: their devices, their relay token, their open
   * streams, their solo agents and notes and limits, at once. */
  async function removeMember(personId: string): Promise<boolean> {
    const gone = people.removeFromWorkspace(personId, (p) => {
      revokePerson(p.id);
    });
    if (!gone) return false;
    deps.closeStreams(personId);
    deps.forgetSignIns(personId);
    if (gone.relayTokenHash) await deps.relay.revokeClient(gone.relayTokenHash).catch(() => false);
    deps.dropAgentsOf(personId);
    limits.forget(personId);
    notes.delete(personId);
    try {
      rmSync(join(DATA_DIR, "people", personId), { recursive: true, force: true });
    } catch {
      /* a folder left behind holds notes nobody can reach */
    }
    // and off every agent's list, so the lists stay tidy
    for (const bot of deps.bots()) {
      if (bot.access?.people.includes(personId)) deps.setAccess(bot.id, { ...bot.access, people: bot.access.people.filter((id) => id !== personId) });
    }
    peopleFrame();
    return true;
  }

  // ── the Members page ───────────────────────────────────────────────

  async function listFor(actor: Actor) {
    await sweep();
    const manage = actor.kind === "owner" || actor.role === "admin";
    // asked fresh: this is where somebody looks right after upgrading
    const plan = await deps.plan(true);
    const team = membersActive(plan);
    const settings = invites.joiningSettings();
    const me = actor.kind === "owner" ? null : actor.personId;
    return {
      workspace: identity(),
      you: { role: actor.kind === "owner" ? "owner" : actor.role, personId: me },
      owner: { name: deps.hostName() },
      members: people.workspaceMembers().map((p) => memberView(p, manage || p.id === me)),
      ...(manage
        ? {
            invites: invites.outstanding().filter((i) => i.status === "open").map(inviteView),
            requests: invites.outstanding().filter((i) => i.status === "waiting").map(requestView),
            joining: { password: settings.password, approveEach: settings.approveEach, privateReadable: settings.privateReadable },
            engines: deps.engines(),
          }
        : {}),
      privacy: { privateReadable: settings.privateReadable, line: privacyLine(settings.privateReadable, deps.hostName()) },
      plan,
      limit: memberLimitFor(plan),
      // Members are Bloks Team's. Without it nobody new comes in, and
      // whoever is in already is paused, not removed: it all comes back
      // with the plan.
      team,
      paused: !team && people.workspaceMembers().length > 0,
      online: online(),
      // where a browser opens this server, when its web door is on: an
      // invite then works there whether or not the workspace is online
      web: deps.webUrl(),
    };
  }

  /** Tells Bloks Cloud about an invite, when this workspace is online. */
  async function registerAtRelay(made: invites.WorkspaceInvite) {
    if (!deps.relayReady()) return;
    // A member client token of its own for this invite: the relay hands
    // it to whoever looks the code up, so they can ask through it, and
    // whoever is let in keeps it. No token, no registration: the relay
    // will not index an invite it could not route.
    const ws = identity();
    const token = await deps.relay.mintClient();
    const ok = token
      ? await deps.relay.registerInvite({
          codeHash: made.codeHash,
          publicId: made.publicId,
          preview: { workspace: ws.name, mark: ws.mark, inviter: inviterName(made.invitedBy), role: made.role },
          expiresAt: made.expiresAt,
          host: { token, key: invites.hostKey().publicRaw },
        })
      : false;
    if (!ok && token) await deps.relay.revokeClient(sha256(token)).catch(() => false);
    invites.noteRelay(made.id, ok ? "registered" : "unavailable", ok && token ? sha256(token) : undefined);
  }

  async function makeInvite(actor: Actor, body: Record<string, unknown>) {
    const role: people.WorkspaceRole = body.role === "admin" ? "admin" : "member";
    const locked = await teamRefusal(true);
    if (locked) return locked;
    if (await full()) return { status: 402, body: { code: "full", error: await fullWords() } };
    if (!deps.ownerNamed()) return { status: 409, body: nameRefusal(actor.kind === "owner" ? "owner" : "someone else") };
    const made = invites.createInvite({ role, name: body.name, invitedBy: actor.kind === "owner" ? "owner" : actor.personId });
    if ("error" in made) return { status: 409, body: made };
    await registerAtRelay(made);
    peopleFrame();
    const inv = invites.invite(made.id)!;
    return { status: 201, body: { invite: inviteView(inv), online: online() } };
  }

  /** The members' own agents, newest first: name, maker, when made and
   * how many conversations. Never a word of what was said to them. */
  function memberAgentRows() {
    return deps
      .bots()
      .filter((b) => !b.archivedAt && b.solo && b.solo.by !== "owner" && people.workspaceRole(b.solo.by))
      .map((b) => ({
        id: b.id,
        name: b.name,
        color: b.color,
        shape: b.shape ?? null,
        madeBy: { id: b.solo!.by, name: people.person(b.solo!.by)?.name ?? "A member" },
        createdAt: b.createdAt,
        conversations: b.tasks.length,
      }))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  function accessView(actor: Actor) {
    const members = people.workspaceMembers();
    return {
      agents: deps
        .bots()
        .filter((b) => !b.archivedAt && (actor.kind === "owner" ? !b.solo || b.solo.by === "owner" : !b.solo))
        .map((b) => ({
          id: b.id,
          name: b.name,
          color: b.color,
          shape: b.shape ?? null,
          solo: Boolean(b.solo),
          access: b.solo ? null : { mode: b.access?.mode ?? "everyone", people: b.access?.people ?? [], admins: b.access?.admins !== false },
        })),
      rooms: deps
        .rooms()
        .filter((r) => !r.archived)
        .map((r) => ({
          id: r.id,
          name: r.name,
          audience: audienceOf(r),
          members: members.filter((p) => people.membershipsOf(p.id).some((m) => m.roomId === r.id)).map((p) => p.id),
          // people let into this room alone, by its own invite: in it
          // whatever the audience, and never chosen from here
          guests: people.guestsOf(r.id).map((m) => ({ id: m.personId, name: m.person.name })),
        })),
    };
  }

  /**
   * The Members page's routes, for the owner and for an admin (whom
   * member-access.ts has already let this far). True when it answered.
   */
  async function ownerRoute(req: IncomingMessage, res: ServerResponse, method: string, path: string, actor: Actor): Promise<boolean> {
    // only this file's routes: others live under /api/workspace/ too (a
    // workspace moving computers, server/workspace-move.ts)
    if (!/^\/api\/workspace\/(members|waiting|identity|invites|requests|access|agents|rooms|joining|member-agents)(\/|$)/.test(path)) return false;
    const owner = actor.kind === "owner";
    const manage = owner || actor.role === "admin";
    let m: RegExpMatchArray | null;

    if (method === "GET" && path === "/api/workspace/members") {
      json(res, 200, await listFor(actor));
      return true;
    }
    if (method === "PUT" && path === "/api/workspace/identity") {
      if (!owner) {
        json(res, 403, { error: "only the owner names the workspace" });
        return true;
      }
      const body = await readBody(req);
      // A window switching workspaces can still be talking to the one it is
      // leaving, so a name meant for another workspace is turned away here
      // rather than written over this one's.
      if (typeof body.id === "string" && body.id !== workspaceIdentity().id) {
        json(res, 409, { error: "that name is for another workspace" });
        return true;
      }
      const set = setIdentity(body);
      json(res, set ? 200 : 400, set ? { workspace: set } : { error: "name and mark { color, pattern } are needed" });
      return true;
    }
    if (method === "GET" && path === "/api/workspace/waiting") {
      json(res, 200, { count: manage ? waitingCount() : 0 });
      return true;
    }
    if (!manage) {
      json(res, 403, { error: "only the owner and admins can manage people" });
      return true;
    }

    if (method === "POST" && path === "/api/workspace/invites") {
      const made = await makeInvite(actor, await readBody(req));
      json(res, made.status, made.body);
      return true;
    }
    if ((m = path.match(/^\/api\/workspace\/invites\/([\w-]+)$/)) && method === "PATCH") {
      const body = await readBody(req);
      if (body.role !== undefined && body.role !== "member" && body.role !== "admin") {
        json(res, 400, { error: "role is member or admin" });
        return true;
      }
      const before = invites.invite(m[1]);
      const roleBefore = before?.role;
      const inv = invites.updateInvite(m[1], body);
      if (!inv) {
        json(res, 409, { error: "that invite can no longer change" });
        return true;
      }
      // The link page says the role, so a changed role is registered again
      // (a fresh token with it): the old entry and its token go first.
      if (inv.role !== roleBefore && inv.relay === "registered") {
        await retire(inv).catch(() => {});
        await registerAtRelay(inv);
      }
      peopleFrame();
      json(res, 200, { invite: inviteView(inv) });
      return true;
    }
    if ((m = path.match(/^\/api\/workspace\/invites\/([\w-]+)$/)) && method === "DELETE") {
      const inv = invites.cancelInvite(m[1]);
      if (!inv) {
        json(res, 404, { error: "no such open invite" });
        return true;
      }
      await retire(inv).catch(() => {});
      peopleFrame();
      waitingFrame();
      json(res, 200, { ok: true });
      return true;
    }
    if ((m = path.match(/^\/api\/workspace\/requests\/([\w-]+)\/(approve|decline)$/)) && method === "POST") {
      const inv = invites.invite(m[1]);
      if (!inv || inv.status !== "waiting" || invites.expired(inv)) {
        json(res, 404, { error: "nobody is waiting on that invite" });
        return true;
      }
      if (m[2] === "decline") {
        await declineRequest(inv.id);
        json(res, 200, { ok: true });
        return true;
      }
      const admitted = await admit(inv);
      if (!admitted.ok) {
        json(res, admitted.status, { code: admitted.code, error: admitted.error });
        return true;
      }
      json(res, 200, { person: memberView(admitted.person, true) });
      return true;
    }
    if ((m = path.match(/^\/api\/workspace\/members\/([\w-]+)$/))) {
      const target = people.person(m[1]);
      if (!target?.role) {
        json(res, 404, { error: "no such member" });
        return true;
      }
      if (method === "DELETE") {
        await removeMember(target.id);
        json(res, 200, { ok: true });
        return true;
      }
      if (method === "PATCH") {
        const body = await readBody(req);
        if (body.role !== undefined) {
          if (body.role !== "admin" && body.role !== "member") {
            json(res, 400, { error: "role is admin or member" });
            return true;
          }
          if (body.role !== target.role) {
            people.setWorkspaceRole(target.id, body.role);
            // whatever they had open was granted as the old role
            deps.closeStreams(target.id);
          }
        }
        if (body.limits !== undefined) {
          if (!body.limits || typeof body.limits !== "object" || Array.isArray(body.limits)) {
            json(res, 400, { error: "limits is { monthlyUsd, aiPercent, maxSolo, engines }" });
            return true;
          }
          const set = limits.setLimit(target.id, body.limits as Record<string, unknown>, deps.engines().map((e) => e.id));
          if ("error" in set) {
            json(res, 400, set);
            return true;
          }
        }
        peopleFrame();
        json(res, 200, { person: memberView(people.person(target.id)!, true) });
        return true;
      }
    }
    if (method === "GET" && path === "/api/workspace/access") {
      json(res, 200, accessView(actor));
      return true;
    }
    // The agents members made for themselves: who made which, for the
    // owner and the admins to see and, when one should go, to delete. What
    // was said to them is never shown here or anywhere else; deleting the
    // agent deletes its conversations with it.
    if (method === "GET" && path === "/api/workspace/member-agents") {
      json(res, 200, { agents: memberAgentRows() });
      return true;
    }
    if ((m = path.match(/^\/api\/workspace\/member-agents\/([\w-]+)$/)) && method === "DELETE") {
      const bot = deps.bots().find((b) => b.id === m![1]);
      const maker = bot?.solo && bot.solo.by !== "owner" ? people.person(bot.solo.by) : null;
      if (!bot || bot.archivedAt || !maker?.role) {
        json(res, 404, { error: "no such member's agent" });
        return true;
      }
      const by = owner ? deps.hostName() : (people.person(actor.personId)?.name ?? "An admin");
      await deps.deleteMemberAgent(bot, { actor: owner ? by : `${by} (admin)`, maker: maker.name });
      json(res, 200, { ok: true });
      return true;
    }
    if ((m = path.match(/^\/api\/workspace\/agents\/([\w-]+)\/access$/)) && method === "PATCH") {
      const bot = deps.bots().find((b) => b.id === m![1]);
      if (!bot || bot.solo) {
        json(res, 404, { error: "no such team agent" });
        return true;
      }
      const body = await readBody(req);
      const mode = body.mode;
      if (mode !== "everyone" && mode !== "only" && mode !== "except") {
        json(res, 400, { error: "mode is everyone, only or except" });
        return true;
      }
      if (body.people !== undefined && (!Array.isArray(body.people) || !body.people.every((id) => typeof id === "string"))) {
        json(res, 400, { error: "people is a list of member ids" });
        return true;
      }
      // whether admins are always in is the owner's to say, not an admin's
      if (body.admins !== undefined && (typeof body.admins !== "boolean" || !owner)) {
        json(res, owner ? 400 : 403, { error: owner ? "admins is true or false" : "only the owner decides whether admins are always in" });
        return true;
      }
      const known = new Set(people.workspaceMembers().map((p) => p.id));
      const listed = [...new Set((body.people as string[] | undefined) ?? bot.access?.people ?? [])].filter((id) => known.has(id));
      const admins = typeof body.admins === "boolean" ? body.admins : bot.access?.admins !== false;
      const before = new Set(people.workspaceMembers().filter((p) => inTeamConversation(bot, asWho(p))).map((p) => p.id));
      const next: AgentAccess | undefined = mode === "everyone" && admins ? undefined : { mode, people: mode === "everyone" ? [] : listed, ...(admins ? {} : { admins: false }) };
      // The owner keeping admins out of an agent's conversation is the
      // owner's to undo, by any road: an admin cannot let everyone in, or
      // put an admin on the list, any more than flip the switch itself.
      if (!owner && bot.access?.admins === false) {
        const after = { ...bot, access: next };
        if (people.workspaceMembers().some((p) => p.role === "admin" && !before.has(p.id) && inTeamConversation(after, asWho(p)))) {
          json(res, 403, { error: "only the owner lets admins into this agent's conversation" });
          return true;
        }
      }
      deps.setAccess(bot.id, next);
      deps.broadcast({ kind: "workspace.access", botId: bot.id });
      // whoever just lost the conversation loses it mid-stream, not at
      // their next start
      for (const p of people.workspaceMembers()) if (before.has(p.id) && !inTeamConversation(bot, asWho(p))) deps.closeStreams(p.id);
      json(res, 200, { agent: accessView(actor).agents.find((a) => a.id === bot.id) });
      return true;
    }
    if ((m = path.match(/^\/api\/workspace\/rooms\/([\w-]+)\/access$/)) && method === "PATCH") {
      const room = deps.rooms().find((r) => r.id === m![1]);
      if (!room) {
        json(res, 404, { error: "no such room" });
        return true;
      }
      const body = await readBody(req);
      if (body.audience !== "everyone" && body.audience !== "some") {
        json(res, 400, { error: "audience is everyone or some" });
        return true;
      }
      deps.setAudience(room.id, body.audience);
      let removed: string[] = [];
      if (body.audience === "some") {
        const list = Array.isArray(body.members) ? (body.members as unknown[]).filter((x): x is string => typeof x === "string") : [];
        removed = people.setRoomPeople(room.id, list, owner ? "owner" : actor.personId).removed;
      }
      for (const id of removed) deps.closeStreams(id);
      deps.broadcast({ kind: "workspace.access", roomId: room.id });
      json(res, 200, { room: accessView(actor).rooms.find((r) => r.id === room.id) });
      return true;
    }

    // the join password and the approval switch are the owner's alone
    if (path.startsWith("/api/workspace/joining")) {
      if (!owner) {
        json(res, 403, { error: "only the owner sets how people join" });
        return true;
      }
      if (path === "/api/workspace/joining/password" && method === "PUT") {
        const set = invites.setPassword((await readBody(req)).password);
        if (!set.ok) {
          json(res, 400, { error: set.error });
          return true;
        }
        json(res, 200, { password: invites.joiningSettings().password });
        return true;
      }
      if (path === "/api/workspace/joining/password" && method === "DELETE") {
        invites.clearPassword();
        json(res, 200, { password: null });
        return true;
      }
      if (path === "/api/workspace/joining" && method === "PATCH") {
        const body = await readBody(req);
        const approve = body.approveEach;
        const readable = body.privateReadable;
        if ((approve !== undefined && typeof approve !== "boolean") || (readable !== undefined && typeof readable !== "boolean") || (approve === undefined && readable === undefined)) {
          json(res, 400, { error: "approveEach, privateReadable or both, each true or false" });
          return true;
        }
        if (typeof approve === "boolean") invites.setApproveEach(approve);
        if (typeof readable === "boolean" && readable !== invites.joiningSettings().privateReadable) {
          invites.setPrivateReadable(readable);
          // every member is told which way it now is, and what they had
          // open was read under the old rule
          deps.broadcast({ kind: "workspace.privacy", privateReadable: readable });
          for (const p of people.workspaceMembers()) deps.closeStreams(p.id);
        }
        const now = invites.joiningSettings();
        json(res, 200, { approveEach: now.approveEach, privateReadable: now.privateReadable });
        return true;
      }
    }
    json(res, 404, { error: "no such route" });
    return true;
  }

  // ── the door: somebody holding a code ──────────────────────────────

  /** One request about joining, already opened, from the relay or this
   * network. `source` is what a wrong code is counted against. */
  async function answerJoin(path: string, body: Record<string, unknown>, ctx: { source: string; via: "relay" | "lan" | "web"; publicId?: string }): Promise<{ status: number; body: unknown }> {
    await sweep();
    const ws = identity();
    const code = invites.normalizeCode(body.code);
    let inv = code ? invites.inviteByCode(code) : null;
    if (inv && ctx.publicId && inv.publicId !== ctx.publicId) inv = null;
    const host = inv ? inviterName(inv.invitedBy) : deps.hostName();
    const refuse = (error: invites.JoinError, extra: Record<string, unknown> = {}) => ({
      status: invites.JOIN_STATUS[error],
      body: { code: error, error: joinWords(error, { host, owner: deps.hostName(), workspace: ws.name, triesLeft: extra.triesLeft as number | undefined }), workspace: ws.name, host, ...extra },
    });
    if (!inv) {
      const limiter = ctx.via === "relay" ? relayGuesses : guesses;
      if (!limiter.allow(ctx.source)) return { status: 429, body: { code: "rate_limited", error: "Too many tries. Wait a minute, then try again." } };
      return refuse("wrong_code");
    }
    const about = {
      workspace: ws.name,
      mark: ws.mark,
      inviter: host,
      role: inv.role,
      roleName: ROLE_WORD[inv.role],
      expiresAt: inv.expiresAt,
      password: Boolean(invites.joiningSettings().password),
    };

    if (path === "/api/join/lookup") {
      const status = invites.shownStatus(inv);
      if (status === "open" || status === "waiting") return { status: 200, body: { publicId: inv.publicId, preview: about, hostKey: invites.hostKey().publicRaw } };
      return refuse(status === "approved" ? "used" : status === "locked" ? "closed" : (status as invites.JoinError));
    }

    if (path === "/api/join/claim") {
      // Members are Bloks Team's: without it nobody is let in, or even
      // put in front of the owner to be let in
      if (await teamRefusal()) return refuse("team_required");
      const isFull = await full();
      const result = invites.claim(inv, body as unknown as invites.ClaimInput, {
        hostKey: invites.hostKey().publicRaw,
        via: ctx.via,
        isMember: isMemberDevice,
        full: () => isFull,
      });
      if (!result.ok) {
        if (result.locked) {
          await retire(inv).catch(() => {});
          deps.broadcast({ kind: "workspace.locked", invite: { id: inv.id, name: inv.name ?? null }, workspace: ws.name });
          peopleFrame();
        }
        return refuse(result.error, result.triesLeft !== undefined ? { triesLeft: result.triesLeft } : {});
      }
      if (result.invite.status === "approved") return { status: 200, body: { ...admittedView(result.invite, invites.takeHandover(result.invite)), phrase: invites.phraseOf(result.invite) } };
      if (result.fresh) {
        if (!invites.joiningSettings().approveEach) {
          const admitted = await admit(result.invite);
          if (admitted.ok) {
            const done = invites.invite(result.invite.id)!;
            return { status: 200, body: { ...admittedView(done, invites.takeHandover(done)), phrase: invites.phraseOf(done), about } };
          }
          // it could not be let in at once (the plan is full, say): it
          // waits for the owner like any request, rather than vanishing
        }
        deps.broadcast({ kind: "workspace.request", request: requestView(result.invite), workspace: ws.name });
        waitingFrame();
      }
      return { status: 200, body: { status: "waiting", phrase: invites.phraseOf(result.invite), about } };
    }

    const tokenHash = typeof body.tokenHash === "string" ? body.tokenHash.toLowerCase() : "";
    // Asking after a request needs the device that made it. Anyone else
    // holding the code learns no more than a lookup tells them.
    if (!inv.claim || inv.claim.tokenHash !== tokenHash) {
      if (path === "/api/join/status") {
        const status = invites.shownStatus(inv);
        if (status === "cancelled" || status === "expired" || status === "locked") return refuse(status === "locked" ? "closed" : status);
      }
      return { status: 404, body: { code: "no_request", error: "There is no request from this device on that invite." } };
    }

    if (path === "/api/join/cancel") {
      const withdrawn = invites.withdraw(inv, tokenHash);
      if (withdrawn) {
        waitingFrame();
        deps.broadcast({ kind: "workspace.withdrawn", inviteId: inv.id });
      }
      return { status: 200, body: { ok: withdrawn } };
    }

    // status
    const status = invites.shownStatus(inv);
    if (status === "approved") return { status: 200, body: { ...admittedView(inv, invites.takeHandover(inv)), phrase: invites.phraseOf(inv) } };
    if (status === "waiting") return { status: 200, body: { status: "waiting", phrase: invites.phraseOf(inv), about } };
    if (status === "declined") return refuse("declined");
    if (status === "locked") return refuse("closed");
    return refuse(status as invites.JoinError);
  }

  /**
   * A sealed join conversation, from the relay or from this network. The
   * envelope names `wjn_<publicId or "lan">.<joiner's key>`; the joiner
   * sealed for this workspace's join key, so only this computer opens it,
   * and the answer goes back sealed the same way. Null when it does not
   * open, which the relay hears as nothing at all.
   */
  async function joinAsk(envelope: Envelope, source: string): Promise<{ status: number; payload: string } | null> {
    const m = envelope.d.match(/^wjn_([a-z0-9]{6}|lan)\.([A-Za-z0-9_-]{43})$/);
    if (!m) return null;
    const { privateKey } = invites.hostKey();
    const shared = invites.agree(privateKey, m[2]);
    if (!shared) return null;
    const request = open(invites.joinKey(shared, "joiner-to-host"), envelope) as RelayRequest | null;
    if (!request || typeof request.method !== "string" || typeof request.path !== "string") return null;
    const replyKey = invites.joinKey(shared, "host-to-joiner");
    const reply = (status: number, body: unknown) => ({ status, payload: seal(replyKey, envelope.d, { status, body }) });
    if (request.method !== "POST" || !JOIN_PATHS.has(request.path)) return reply(404, { error: "no such route" });
    // the same freshness as any phone's request: a captured "claim" cannot
    // be sent again to burn a password try or a request
    const fresh =
      typeof request.ts === "number" &&
      Math.abs(Date.now() - request.ts) <= REPLAY_WINDOW_MS &&
      typeof request.nonce === "string" &&
      request.nonce.length > 0 &&
      !nonces.has(request.nonce);
    if (!fresh) return reply(409, { error: "stale or replayed request" });
    nonces.remember(request.nonce!, request.ts!);
    const body = request.body && typeof request.body === "object" ? (request.body as Record<string, unknown>) : {};
    const answered = await answerJoin(request.path, body, {
      source,
      via: source === "relay" ? "relay" : "lan",
      ...(m[1] !== "lan" ? { publicId: m[1] } : {}),
    });
    return reply(answered.status, answered.body);
  }

  /**
   * The door on this network, before anybody holds a token: this
   * workspace's public join key, and a sealed request. Server-to-server
   * on the joiner's side (join-client.ts), so no page ever calls it.
   */
  async function lanRoute(req: IncomingMessage, res: ServerResponse, method: string, path: string, ip: string): Promise<boolean> {
    if (method === "GET" && path === "/api/join/key") {
      json(res, 200, { hostKey: invites.hostKey().publicRaw, workspace: identity().name });
      return true;
    }
    if (method === "POST" && path === "/api/join/ask") {
      const body = await readBody(req).catch(() => ({}) as Record<string, unknown>);
      const { peek } = await import("./relay-crypto.ts");
      const envelope = typeof body.payload === "string" ? peek(body.payload) : null;
      const answered = envelope ? await joinAsk(envelope, `lan:${ip}`) : null;
      if (!answered) {
        json(res, 401, { error: "that request does not open" });
        return true;
      }
      json(res, 200, answered);
      return true;
    }
    return false;
  }

  // ── the web door: a browser that signed in here ─────────────────────

  /**
   * One step of joining from a browser at this server's web door
   * (server/web-door.ts): the same lookup, claim, status and cancel the
   * sealed door answers, with the same limits on guessing, counted
   * against the address that asked.
   */
  function webJoin(path: "/api/join/lookup" | "/api/join/claim" | "/api/join/status" | "/api/join/cancel", body: Record<string, unknown>, ip: string) {
    return answerJoin(path, body, { source: `web:${ip}`, via: "web" });
  }

  /** Somebody the provider vouches for, made a member on their first sign
   * in (BLOKS_OIDC_AUTO_CREATE), on the same terms as anybody let in by
   * an invite: Bloks Team, and room for one more. */
  async function admitFromSignIn(input: { name: string; role: people.WorkspaceRole }): Promise<{ ok: true; person: people.Person } | { ok: false; code: "team_required" | "full"; error: string }> {
    const locked = await teamRefusal(true);
    if (locked) return { ok: false, code: "team_required", error: locked.body.error };
    if (await full()) return { ok: false, code: "full", error: await fullWords() };
    const person = people.admitToWorkspace({ name: input.name, role: input.role, invitedBy: "owner", device: "browser" });
    peopleFrame();
    deps.broadcast({ kind: "workspace.joined", person: { id: person.id, name: person.name, role: person.role }, workspace: identity().name });
    return { ok: true, person };
  }

  /** The admin group said what somebody is, as they signed in. */
  function syncRole(personId: string, role: people.WorkspaceRole) {
    const p = people.person(personId);
    if (!p?.role || p.role === role) return;
    people.setWorkspaceRole(personId, role);
    deps.closeStreams(personId);
    peopleFrame();
  }

  // ── a member's own things ──────────────────────────────────────────

  function notesOf(personId: string): ProfileNotes {
    let found = notes.get(personId);
    if (!found) {
      found = new ProfileNotes(join(DATA_DIR, "people", personId, "profile-notes.json"));
      notes.set(personId, found);
    }
    return found;
  }

  /** Why this person cannot start anything more right now, or null. */
  function limitRefusal(personId: string): string | null {
    return limits.refusal(personId, { workspace: identity().name, owner: deps.hostName(), aiUsedPercent: deps.aiUsedPercent(personId) });
  }

  function usageOf(personId: string) {
    return {
      month: monthOf(),
      spentUsd: limits.spentThisMonth(personId),
      aiPercent: deps.aiUsedPercent(personId),
      limits: limits.limitOf(personId),
      soloAgents: soloCount(personId),
      stopped: limitRefusal(personId),
    };
  }

  return {
    identity,
    limits,
    ownerRoute,
    joinAsk,
    lanRoute,
    sweep,
    waitingCount,
    notesOf,
    limitRefusal,
    usageOf,
    soloCount,
    removeMember,
    peopleFrame,
    webJoin,
    admitFromSignIn,
    syncRole,
    /** For tests and the joiner: a sealed request's nonce is fresh. */
    newNonce: () => randomUUID(),
  };
}

export type Members = ReturnType<typeof createMembers>;
