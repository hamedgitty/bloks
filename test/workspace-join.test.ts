// Joining a workspace end to end: the owner's Members routes, the door on
// this network, and this computer's own joining client talking to it, sealed
// (server/members.ts, server/join-client.ts).
//
// The members module is handed fakes for everything the server owns (the
// relay line, the plan, the agents), so each rule can be pushed on alone.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { machineKind } from "../server/this-machine.ts";

const home = mkdtempSync(join(tmpdir(), "bloks-join-"));
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

let membersMod: typeof import("../server/members.ts");
let invites: typeof import("../server/invites.ts");
let people: typeof import("../server/people.ts");
let pairing: typeof import("../server/pairing.ts");
let JoinClient: typeof import("../server/join-client.ts").JoinClient;

const frames: Array<Record<string, any>> = [];
const closed: string[] = [];
const relayCalls: Array<[string, unknown]> = [];
// members are Bloks Team's: the tests below run on it unless they say
let plan: "cloud" | "team" | null = "team";
let relayOn = false;
const bots: any[] = [
  { id: "b1", name: "Chief of Staff", title: "Chief", color: "blue", shape: "rounded", tasks: [] },
  { id: "b2", name: "Research", title: "Research", color: "teal", tasks: [] },
  { id: "b3", name: "Mine", title: "", color: "pink", tasks: [], solo: { by: "owner" } },
];

let server: Server;
let base = "";
let lan = "";
let members: ReturnType<typeof import("../server/members.ts").createMembers>;

before(async () => {
  process.env.HOME = home;
  process.env.BLOKS_WORKSPACE_NAME = "Rahimi Enterprises";
  process.env.BLOKS_WORKSPACE_COLOR = "#149E8E";
  process.env.BLOKS_WORKSPACE_PATTERN = "110101011";
  mkdirSync(join(home, ".bloks"), { recursive: true });
  membersMod = await import("../server/members.ts");
  invites = await import("../server/invites.ts");
  people = await import("../server/people.ts");
  pairing = await import("../server/pairing.ts");
  ({ JoinClient } = await import("../server/join-client.ts"));
  let minted = 0;
  const relay = {
    state: { connected: true },
    mintClient: async () => {
      relayCalls.push(["mint", null]);
      return `client_token_${++minted}_${"x".repeat(20)}`;
    },
    registerInvite: async (body: unknown) => {
      relayCalls.push(["register", body]);
      return true;
    },
    cancelInvite: async (publicId: string) => {
      relayCalls.push(["cancel", publicId]);
      return true;
    },
    revokeClient: async (hash: string) => {
      relayCalls.push(["revoke", hash]);
      return true;
    },
  };
  members = membersMod.createMembers({
    hostName: () => "Hamed",
    ownerNamed: () => true,
    relay: relay as any,
    relayReady: () => relayOn,
    relayUrl: () => (relayOn ? "https://relay.test" : null),
    plan: async () => plan,
    bots: () => bots,
    rooms: () => [],
    engines: () => [{ id: "claude", name: "Claude Code" }],
    broadcast: (frame) => frames.push(frame as Record<string, any>),
    closeStreams: (personId) => closed.push(personId),
    lanAddress: () => null,
    aiUsedPercent: () => null,
    dropAgentsOf: () => {},
    setAccess: (botId, value) => {
      const bot = bots.find((b) => b.id === botId);
      if (bot) bot.access = value;
    },
    setAudience: () => {},
  });
  server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://x");
    const actorHeader = String(req.headers["x-actor"] ?? "owner");
    const actor =
      actorHeader === "owner"
        ? ({ kind: "owner" } as const)
        : ({ kind: "member", personId: actorHeader.split(":")[0], role: actorHeader.split(":")[1] as "admin" | "member" } as const);
    try {
      if (url.pathname.startsWith("/api/join/")) {
        if (await members.lanRoute(req, res, req.method!, url.pathname, "127.0.0.1")) return;
      } else if (await members.ownerRoute(req, res, req.method!, url.pathname, actor)) return;
      res.writeHead(404).end();
    } catch (e) {
      res.writeHead(500).end(String(e));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  base = `http://127.0.0.1:${port}`;
  lan = `127.0.0.1:${port}`;
});
after(() => {
  server?.close();
  rmSync(home, { recursive: true, force: true });
});

async function call(path: string, init: { method?: string; body?: unknown; actor?: string } = {}) {
  const res = await fetch(`${base}${path}`, {
    method: init.method ?? "GET",
    headers: { "content-type": "application/json", "x-actor": init.actor ?? "owner" },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

async function invite(body: Record<string, unknown> = {}) {
  const made = await call("/api/workspace/invites", { method: "POST", body: { role: "member", ...body } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  return made.body.invite as { id: string; code: string; link: string; publicId: string };
}

const joiner = () => new JoinClient(() => "http://127.0.0.1:9");

test("an invite found on this network, asked for, approved with matching words, and the joiner is in", async () => {
  const inv = await invite({ name: "Sam" });
  assert.match(inv.code, /^[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$/);
  assert.equal(inv.link, `https://bloks.dev/j/${inv.publicId}#${inv.code.replace("-", "")}`);

  const client = joiner();
  const found = await client.lookup(`${inv.link}~${lan}`);
  assert.ok(found.ok, JSON.stringify(found));
  assert.equal(found.invite.workspace, "Rahimi Enterprises");
  assert.deepEqual(found.invite.mark, { color: "#149E8E", pattern: "110101011" });
  assert.equal(found.invite.inviter, "Hamed");
  assert.equal(found.invite.role, "member");
  assert.equal(found.invite.password, false);

  const asked = (await client.claim(found.session, { name: "Sam Okafor" })) as any;
  assert.equal(asked.status, "waiting");
  const request = (await call("/api/workspace/members")).body.requests[0];
  assert.equal(request.name, "Sam Okafor");
  assert.equal(request.forName, "Sam");
  assert.equal(request.device, machineKind(), "the owner hears what the joiner runs on: Mac, PC or computer");
  assert.equal(request.password, "none");
  assert.equal(request.phrase, asked.phrase, "both screens show the same four words");
  assert.ok(frames.some((f) => f.kind === "workspace.request" && f.request.inviteId === inv.id));
  assert.ok(frames.some((f) => f.kind === "workspace.waiting" && f.count === 1));
  assert.equal((await call("/api/workspace/waiting")).body.count, 1);

  const approved = await call(`/api/workspace/requests/${inv.id}/approve`, { method: "POST" });
  assert.equal(approved.status, 200);
  assert.equal(approved.body.person.role, "member");
  assert.ok(frames.some((f) => f.kind === "workspace.joined" && f.person.name === "Sam Okafor"));

  const done = (await client.status(found.session)) as any;
  assert.equal(done.status, "approved");
  assert.equal(done.credentials.personId, approved.body.person.id);
  assert.ok(done.credentials.deviceToken.length >= 40);
  // the host holds only the token's digest
  const device = pairing.memberDevices().find((d) => d.id === done.credentials.deviceId)!;
  assert.equal(device.hash, sha(done.credentials.deviceToken));
  assert.equal(device.personId, done.credentials.personId);
  assert.equal(done.welcome.workspace.name, "Rahimi Enterprises");
  assert.equal(done.welcome.role, "member");
  // the welcome shows team agents, never a solo one
  assert.deepEqual(done.welcome.agents.map((a: any) => a.name), ["Chief of Staff", "Research"]);

  // the invite is used: anybody else holding it is told so
  const other = joiner();
  const again = (await other.lookup(`${inv.link}~${lan}`)) as any;
  assert.equal(again.ok, false);
  assert.equal(again.code, "used");
  assert.equal((await call("/api/workspace/members")).body.members.length, 1);
});

test("with approval off, the right code lets the person straight in", async () => {
  assert.equal((await call("/api/workspace/joining", { method: "PATCH", body: { approveEach: false } })).status, 200);
  const inv = await invite({ role: "admin" });
  const client = joiner();
  const found = (await client.lookup(`${inv.code}`.length ? `${inv.link}~${lan}` : "")) as any;
  const answer = (await client.claim(found.session, { name: "Leila" })) as any;
  assert.equal(answer.status, "approved");
  assert.equal(answer.credentials.role, "admin");
  assert.equal(people.workspaceRole(answer.credentials.personId), "admin");
  await call("/api/workspace/joining", { method: "PATCH", body: { approveEach: true } });
});

test("the join password: asked for, wrong tries counted, five close the invite and tell the owner", async () => {
  assert.equal((await call("/api/workspace/joining/password", { method: "PUT", body: { password: "harborlight" } })).status, 200);
  const inv = await invite();
  const client = joiner();
  const found = (await client.lookup(`${inv.link}~${lan}`)) as any;
  assert.equal(found.invite.password, true, "the form knows to ask before anyone guesses");
  const none = (await client.claim(found.session, { name: "Eve" })) as any;
  assert.equal(none.code, "password_required");
  for (let left = 4; left >= 1; left--) {
    const wrong = (await client.claim(found.session, { name: "Eve", password: "harborlite" })) as any;
    assert.equal(wrong.code, "wrong_password");
    assert.equal(wrong.triesLeft, left);
    assert.match(wrong.error, new RegExp(`${left} tr`));
  }
  const closedNow = (await client.claim(found.session, { name: "Eve", password: "guess" })) as any;
  assert.equal(closedNow.code, "closed");
  assert.ok(frames.some((f) => f.kind === "workspace.locked" && f.invite.id === inv.id));
  // the right password on a fresh invite goes through, and the owner sees it was right
  const next = await invite();
  const c2 = joiner();
  const f2 = (await c2.lookup(`${next.link}~${lan}`)) as any;
  assert.equal(((await c2.claim(f2.session, { name: "Dan", password: "harborlight" })) as any).status, "waiting");
  const req = (await call("/api/workspace/members")).body.requests.find((r: any) => r.inviteId === next.id);
  assert.equal(req.password, "correct");
  await call(`/api/workspace/requests/${next.id}/decline`, { method: "POST" });
  const declined = (await c2.status(f2.session)) as any;
  assert.equal(declined.code, "declined");
  await call("/api/workspace/joining/password", { method: "DELETE" });
});

test("a cancelled invite and a wrong code each say so", async () => {
  const inv = await invite();
  assert.equal((await call(`/api/workspace/invites/${inv.id}`, { method: "DELETE" })).status, 200);
  const cancelled = (await joiner().lookup(`${inv.link}~${lan}`)) as any;
  assert.equal(cancelled.code, "cancelled");
  const wrong = (await joiner().lookup(`https://bloks.dev/j/${inv.publicId}#22222222~${lan}`)) as any;
  assert.equal(wrong.code, "wrong_code");
  const junk = (await joiner().lookup("not a code")) as any;
  assert.equal(junk.code, "not_a_code");
});

test("a joiner can take their request back", async () => {
  const inv = await invite();
  const client = joiner();
  const found = (await client.lookup(`${inv.link}~${lan}`)) as any;
  await client.claim(found.session, { name: "Kim" });
  assert.equal((await call("/api/workspace/waiting")).body.count, 1);
  await client.cancel(found.session);
  assert.equal((await call("/api/workspace/waiting")).body.count, 0);
  assert.equal(invites.invite(inv.id)?.status, "open");
  await call(`/api/workspace/invites/${inv.id}`, { method: "DELETE" });
});

test("members are Bloks Team's: on Cloud or with no licence nobody is invited, asks, or is let in, and those in are paused", async () => {
  // an invite made while on Team, and somebody asking on it
  const inv = await invite({ name: "Noor" });
  const waiting = joiner();
  const found = (await waiting.lookup(`${inv.link}~${lan}`)) as any;
  assert.equal(((await waiting.claim(found.session, { name: "Noor" })) as any).status, "waiting");
  const late = await invite({ name: "Ola" });

  for (const lapsed of ["cloud", null] as const) {
    plan = lapsed;
    // no new invite
    const refused = await call("/api/workspace/invites", { method: "POST", body: { role: "member" } });
    assert.equal(refused.status, 402);
    assert.equal(refused.body.code, "team_required");
    assert.match(refused.body.error, /needs Bloks Team/);
    // nobody let in from a request already waiting
    const approve = await call(`/api/workspace/requests/${inv.id}/approve`, { method: "POST" });
    assert.equal(approve.status, 402);
    assert.equal(approve.body.code, "team_required");
    // and an invite already out cannot be claimed
    const asking = joiner();
    const seen = (await asking.lookup(`${late.link}~${lan}`)) as any;
    assert.ok(seen.ok, "the invite itself still reads");
    const claim = (await asking.claim(seen.session, { name: "Ola" })) as any;
    assert.equal(claim.ok, false);
    assert.equal(claim.code, "team_required");
    assert.equal(claim.error, "Hamed's workspace needs Bloks Team for members right now.");
    // the owner is told the members are paused, and nobody was removed
    const list = (await call("/api/workspace/members")).body;
    assert.equal(list.team, false);
    assert.equal(list.paused, true);
    assert.equal(list.limit, 0);
    assert.equal(people.workspaceMembers().length, 2);
  }

  // back on Team: all of it comes back, nothing lost
  plan = "team";
  const list = (await call("/api/workspace/members")).body;
  assert.equal(list.team, true);
  assert.equal(list.paused, false);
  assert.equal(list.limit, 10);
  assert.equal((await call(`/api/workspace/requests/${inv.id}/approve`, { method: "POST" })).status, 200);
  assert.equal(people.workspaceMembers().length, 3);
  const noor = people.workspaceMembers().find((p) => p.name === "Noor")!;
  await call(`/api/workspace/members/${noor.id}`, { method: "DELETE" });
  await call(`/api/workspace/invites/${late.id}`, { method: "DELETE" });
});

test("the plan's member limit is counted across the workspace", async () => {
  // Sam and Leila are in; ten is Team's limit
  const extra: string[] = [];
  for (let i = 0; i < 8; i++) extra.push(people.admitToWorkspace({ name: `Extra ${i}`, role: "member", invitedBy: "owner" }).id);
  const refused = await call("/api/workspace/invites", { method: "POST", body: { role: "member" } });
  assert.equal(refused.status, 402);
  assert.equal(refused.body.code, "full");
  assert.match(refused.body.error, /10 members/);
  for (const id of extra) people.removeFromWorkspace(id);
  assert.equal((await call("/api/workspace/invites", { method: "POST", body: {} })).status, 201);
});

test("roles: admins manage people but not how people join; members only read the list", async () => {
  const all = people.workspaceMembers();
  const sam = all.find((p) => p.name === "Sam Okafor")!;
  const leila = all.find((p) => p.name === "Leila")!;
  const asMember = `${sam.id}:member`;
  const asAdmin = `${leila.id}:admin`;
  const seen = await call("/api/workspace/members", { actor: asMember });
  assert.equal(seen.status, 200);
  assert.equal(seen.body.invites, undefined, "a member does not see the invitations");
  assert.equal(seen.body.members.find((m: any) => m.id === leila.id).limits, undefined, "nor anyone else's limits");
  assert.ok(seen.body.members.find((m: any) => m.id === sam.id).limits, "but sees their own");
  assert.match(seen.body.privacy.line, /nobody else reads them, Hamed included/);
  assert.equal((await call("/api/workspace/invites", { method: "POST", body: {}, actor: asMember })).status, 403);

  assert.equal((await call("/api/workspace/invites", { method: "POST", body: {}, actor: asAdmin })).status, 201);
  assert.equal((await call("/api/workspace/joining/password", { method: "PUT", body: { password: "abcdef" }, actor: asAdmin })).status, 403);

  // changing a role ends that person's sessions at once
  closed.length = 0;
  const promoted = await call(`/api/workspace/members/${sam.id}`, { method: "PATCH", body: { role: "admin" }, actor: asAdmin });
  assert.equal(promoted.status, 200);
  assert.equal(people.workspaceRole(sam.id), "admin");
  assert.deepEqual(closed, [sam.id]);
  assert.equal((await call(`/api/workspace/members/${sam.id}`, { method: "PATCH", body: { role: "owner" } })).status, 400);

  // limits, set by an admin, read back
  const limited = await call(`/api/workspace/members/${sam.id}`, {
    method: "PATCH",
    body: { limits: { monthlyUsd: 25, maxSolo: 1, engines: ["claude"] } },
    actor: asAdmin,
  });
  assert.equal(limited.status, 200);
  assert.deepEqual(limited.body.person.limits, { monthlyUsd: 25, aiPercent: null, maxSolo: 1, engines: ["claude"] });
  assert.equal((await call(`/api/workspace/members/${sam.id}`, { method: "PATCH", body: { limits: { engines: ["ghost"] } } })).status, 400);
});

test("who is in a team agent's conversation is set per agent, and those taken off lose it at once", async () => {
  const sam = people.workspaceMembers().find((p) => p.name === "Sam Okafor")!;
  const bad = await call("/api/workspace/agents/b1/access", { method: "PATCH", body: { mode: "some" } });
  assert.equal(bad.status, 400);
  closed.length = 0;
  const only = await call("/api/workspace/agents/b1/access", { method: "PATCH", body: { mode: "only", people: ["nobody"], admins: false } });
  assert.equal(only.status, 200);
  assert.deepEqual(bots[0].access, { mode: "only", people: [], admins: false });
  assert.ok(closed.includes(sam.id), "Sam, an admin, was in it and now is not");
  const access = (await call("/api/workspace/access")).body;
  assert.deepEqual(access.agents.find((a: any) => a.id === "b1").access, { mode: "only", people: [], admins: false });
  assert.ok(access.agents.find((a: any) => a.id === "b3").solo, "the owner sees their own solo agent");
  // an admin cannot decide whether admins are always in
  const leila = people.workspaceMembers().find((p) => p.name === "Leila")!;
  assert.equal((await call("/api/workspace/agents/b1/access", { method: "PATCH", body: { mode: "everyone", admins: true }, actor: `${leila.id}:admin` })).status, 403);
  assert.ok(!(await call("/api/workspace/access", { actor: `${leila.id}:admin` })).body.agents.some((a: any) => a.id === "b3"), "nor see the owner's solo agent");
  await call("/api/workspace/agents/b1/access", { method: "PATCH", body: { mode: "everyone", admins: true } });
  assert.equal(bots[0].access, undefined);
});

test("removing someone takes their devices, their relay token and their streams", async () => {
  const leila = people.workspaceMembers().find((p) => p.name === "Leila")!;
  assert.ok(pairing.memberDevices().some((d) => d.personId === leila.id));
  closed.length = 0;
  assert.equal((await call(`/api/workspace/members/${leila.id}`, { method: "DELETE" })).status, 200);
  assert.equal(people.person(leila.id), null);
  assert.ok(!pairing.memberDevices().some((d) => d.personId === leila.id));
  assert.deepEqual(closed, [leila.id]);
  assert.ok(frames.some((f) => f.kind === "workspace.people" && !f.members.some((m: any) => m.id === leila.id)));
});

test("online, each invite is registered with the relay in its exact shape and taken back when it closes", async () => {
  relayOn = true;
  relayCalls.length = 0;
  const inv = await invite({ role: "member", name: "Ana" });
  const register = relayCalls.find(([kind]) => kind === "register")![1] as any;
  assert.deepEqual(Object.keys(register).sort(), ["codeHash", "expiresAt", "host", "preview", "publicId"]);
  assert.equal(register.codeHash, sha(inv.code.replace("-", "")));
  assert.equal(register.publicId, inv.publicId);
  assert.deepEqual(register.preview, { workspace: "Rahimi Enterprises", mark: { color: "#149E8E", pattern: "110101011" }, inviter: "Hamed", role: "member" });
  assert.match(register.host.token, /^client_token_/);
  assert.equal(register.host.key, invites.hostKey().publicRaw);
  assert.equal(invites.invite(inv.id)?.relayTokenHash, sha(register.host.token));
  relayCalls.length = 0;
  await call(`/api/workspace/invites/${inv.id}`, { method: "DELETE" });
  assert.deepEqual(relayCalls.map(([k]) => k).sort(), ["cancel", "revoke"]);
  assert.equal(relayCalls.find(([k]) => k === "revoke")![1], sha(register.host.token));
  relayOn = false;
});

test("the workspace setting for private conversations is the owner's, and members are told", async () => {
  frames.length = 0;
  const on = await call("/api/workspace/joining", { method: "PATCH", body: { privateReadable: true } });
  assert.equal(on.status, 200);
  assert.equal(on.body.privateReadable, true);
  assert.ok(frames.some((f) => f.kind === "workspace.privacy" && f.privateReadable === true));
  const sam = people.workspaceMembers().find((p) => p.name === "Sam Okafor")!;
  assert.match((await call("/api/workspace/members", { actor: `${sam.id}:admin` })).body.privacy.line, /Hamed and the admins can read/);
  assert.equal((await call("/api/workspace/joining", { method: "PATCH", body: { privateReadable: false }, actor: `${sam.id}:admin` })).status, 403);
  await call("/api/workspace/joining", { method: "PATCH", body: { privateReadable: false } });
});

test("a name meant for another workspace is turned away, so a window mid switch cannot rename this one", async () => {
  const mark = { color: "#149E8E", pattern: "110101011" };
  const before = (await call("/api/workspace/members")).body.workspace;
  assert.equal(before.id, "personal");
  const crossed = await call("/api/workspace/identity", { method: "PUT", body: { id: "w_bakery", name: "Maple Street Bakery", kind: "Team", mark } });
  assert.equal(crossed.status, 409);
  assert.equal((await call("/api/workspace/members")).body.workspace.name, before.name);
  const own = await call("/api/workspace/identity", { method: "PUT", body: { id: "personal", name: "Brightwater", kind: "Team", mark } });
  assert.equal(own.status, 200);
  assert.equal(own.body.workspace.name, "Brightwater");
  assert.equal((await call("/api/workspace/identity", { method: "PUT", body: { id: "personal", name: before.name, kind: before.kind, mark: before.mark } })).status, 200);
});
