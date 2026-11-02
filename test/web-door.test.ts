// The web door against the real server and an OpenID provider of the
// test's own (test/helpers/fake-oidc.ts): who gets in, as whom, and every
// way a sign in is refused. Then what the door lets people do once in:
// join from an invite link with no app, and an admin deleting an agent a
// member made, without reading it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startHarness } from "./helpers/server.ts";
import { teamPlan } from "./helpers/team-plan.ts";
import { fakeOidc, type FakeUser } from "./helpers/fake-oidc.ts";

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

/** A browser, as far as the door can tell: cookies kept per site, an
 * Origin on what a page would send one with, redirects looked at by hand. */
class Browser {
  jar = new Map<string, string>();
  readonly door: string;
  constructor(door: string) {
    this.door = door;
  }
  private take(res: Response) {
    for (const line of res.headers.getSetCookie()) {
      const pair = line.split(";")[0];
      const name = pair.slice(0, pair.indexOf("="));
      const value = pair.slice(pair.indexOf("=") + 1);
      if (!value || /max-age=0/i.test(line)) this.jar.delete(name);
      else this.jar.set(name, value);
    }
  }
  async fetch(path: string, init: { method?: string; body?: unknown; origin?: string | null; headers?: Record<string, string> } = {}) {
    const headers: Record<string, string> = { "content-type": "application/json", ...init.headers };
    if (init.origin !== null) headers.origin = init.origin ?? this.door;
    if (this.jar.size) headers.cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
    const res = await fetch(`${this.door}${path}`, {
      method: init.method ?? "GET",
      redirect: "manual",
      headers,
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
    this.take(res);
    return res;
  }
  async json(path: string, init: Parameters<Browser["fetch"]>[1] = {}) {
    const res = await this.fetch(path, init);
    return { status: res.status, body: await res.json().catch(() => null) };
  }
  /** Signs in through the provider, the way the button does, and says
   * where the door sent the browser at the end. */
  async signIn(join?: { code: string; password?: string }) {
    const start = await this.fetch("/auth/login", { method: "POST", body: { next: "/", ...(join ? { join } : {}) } });
    if (start.status !== 200) return { status: start.status, body: await start.json(), location: null as string | null, callback: "" };
    const { url } = (await start.json()) as { url: string };
    const auth = await fetch(url, { redirect: "manual" });
    const callback = new URL(auth.headers.get("location")!);
    const back = await this.fetch(`${callback.pathname}${callback.search}`, { origin: null });
    return { status: back.status, body: null, location: back.headers.get("location"), callback: `${callback.pathname}${callback.search}` };
  }
}

test("the web door: who signs in, as whom, and every way it is refused", async (t) => {
  const idp = await fakeOidc();
  t.after(() => idp.close());
  const licence = await teamPlan();
  t.after(() => licence.close());
  const home = mkdtempSync(join(tmpdir(), "bloks-web-door-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, ".bloks"), { recursive: true });
  writeFileSync(join(home, ".bloks", "config.json"), JSON.stringify({ profile: { name: "Hamed" }, ...licence.config }));
  const port = await freePort();
  const door = `http://127.0.0.1:${port}`;
  const h = await startHarness({
    HOME: home,
    ...licence.env,
    BLOKS_WEB_URL: door,
    BLOKS_WEB_LISTEN: `127.0.0.1:${port}`,
    BLOKS_OIDC_ISSUER: idp.issuer,
    BLOKS_OIDC_CLIENT_ID: idp.clientId,
    BLOKS_OIDC_CLIENT_SECRET: idp.clientSecret,
    BLOKS_OIDC_OWNER: "owner-sub",
    BLOKS_OIDC_ALLOWED_GROUPS: "family",
    BLOKS_OIDC_ADMIN_GROUP: "bloks-admins",
    BLOKS_OIDC_AUTO_CREATE: "1",
    BLOKS_OIDC_NAME: "Authentik",
  });
  t.after(() => h.stop());
  for (let i = 0; i < 100; i++) {
    const up = await fetch(`${door}/auth/session`).then((r) => r.ok, () => false);
    if (up) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const as = (user: FakeUser) => {
    idp.state.user = user;
    idp.state.mode = "good";
    return new Browser(door);
  };

  await t.test("signed out, the door says how to sign in and nothing else", async () => {
    const b = new Browser(door);
    const session = await b.json("/auth/session");
    assert.equal(session.status, 200);
    assert.equal(session.body.signedIn, false);
    assert.equal(session.body.provider, "Authentik");
    assert.equal(session.body.owner, "Hamed");
    assert.equal((await b.fetch("/api/bots")).status, 401);
    assert.equal((await b.json("/api/health")).body.door, "web");
    // a paired device's way in is not one here, nor is pairing itself
    assert.equal((await b.fetch("/api/pair/claim", { method: "POST", body: { credential: "123456" } })).status, 401);
    // and a sign in started from another site is refused
    assert.equal((await b.fetch("/auth/login", { method: "POST", body: {}, origin: "https://evil.example" })).status, 403);
  });

  let owner!: Browser;
  await t.test("the owner signs in as the owner, with PKCE, state and nonce", async () => {
    owner = as({ sub: "owner-sub", name: "Hamed", email: "hamed@example.com", groups: [] });
    const signed = await owner.signIn();
    assert.equal(signed.location, "/");
    assert.ok(owner.jar.has("bloks_session"));
    assert.ok(!owner.jar.has("bloks_flow"), "the flow cookie goes once used");
    // the verifier went to the token endpoint, never to the browser
    assert.equal(typeof idp.state.lastTokenRequest?.code_verifier, "string");
    assert.ok(!signed.callback.includes(idp.state.lastTokenRequest!.code_verifier));
    const session = await owner.json("/auth/session");
    assert.equal(session.body.as.role, "owner");
    assert.equal((await owner.fetch("/api/bots")).status, 200);
    // an Authorization header means nothing through this door: the cookie is
    // who you are, and without it nobody
    assert.equal((await owner.fetch("/api/bots", { headers: { authorization: "Bearer whatever" } })).status, 200);
    const bare = new Browser(door);
    assert.equal((await bare.fetch("/api/bots", { headers: { authorization: "Bearer whatever" } })).status, 401);
    // a change needs this door's own Origin
    assert.equal((await owner.fetch("/api/bots", { method: "POST", body: { name: "Nope" }, origin: null })).status, 403);
    assert.equal((await owner.fetch("/api/bots", { method: "POST", body: { name: "Nope" }, origin: "https://evil.example" })).status, 403);
    // what the owner makes here is the owner's, as from any device of theirs
    const ivy = await owner.json("/api/bots", { method: "POST", body: { name: "Ivy" } });
    assert.equal(ivy.status, 201, JSON.stringify(ivy.body));
    // and a terminal is never opened from a browser here
    const shell = await owner.json(`/api/bots/${ivy.body.bot.id}/terminals`, { method: "POST", body: {} });
    assert.equal(shell.status, 403);
    assert.match(shell.body.error, /not from a browser/);
  });

  await t.test("a replayed or tampered state is refused", async () => {
    const b = as({ sub: "owner-sub", name: "Hamed", groups: [] });
    const { url } = await (await b.fetch("/auth/login", { method: "POST", body: {} })).json();
    const flow = b.jar.get("bloks_flow")!;
    assert.ok(flow);
    const callback = new URL((await fetch(url, { redirect: "manual" })).headers.get("location")!);
    const path = `${callback.pathname}${callback.search}`;
    const first = await b.fetch(path, { origin: null });
    assert.equal(first.headers.get("location"), "/");
    // the same callback again, flow cookie and all: the state was used once
    const replay = new Browser(door);
    replay.jar.set("bloks_flow", flow);
    const again = await replay.fetch(path, { origin: null });
    assert.equal(again.headers.get("location"), "/?signin=expired");
    assert.ok(!replay.jar.has("bloks_session"));
    // and a callback with no flow of this browser's at all
    assert.equal((await new Browser(door).fetch(path, { origin: null })).headers.get("location"), "/?signin=expired");
    // a state that is not the one this browser was given
    const tamper = new Browser(door);
    const started = await (await tamper.fetch("/auth/login", { method: "POST", body: {} })).json();
    const back = new URL((await fetch(started.url, { redirect: "manual" })).headers.get("location")!);
    back.searchParams.set("state", "x".repeat(43));
    const wrong = await tamper.fetch(`${back.pathname}${back.search}`, { origin: null });
    assert.equal(wrong.headers.get("location"), "/?signin=expired");
    assert.ok(!tamper.jar.has("bloks_session"));
  });

  await t.test("a token that does not check out signs nobody in", async () => {
    for (const mode of ["wrong-key", "wrong-audience", "expired", "wrong-issuer", "hs256", "wrong-nonce"] as const) {
      const b = as({ sub: "owner-sub", name: "Hamed", groups: [] });
      idp.state.mode = mode;
      const signed = await b.signIn();
      assert.equal(signed.location, "/?signin=failed", mode);
      assert.ok(!b.jar.has("bloks_session"), mode);
    }
    idp.state.mode = "good";
    assert.match(h.logs(), /signature does not check out/);
    assert.match(h.logs(), /for another application/);
    assert.match(h.logs(), /has expired/);
    assert.ok(!h.logs().includes(idp.clientSecret), "the client secret is never logged");
  });

  await t.test("somebody outside the allowed groups is turned away", async () => {
    const b = as({ sub: "guest-sub", name: "Guest", email: "guest@example.com", groups: ["guests"] });
    const signed = await b.signIn();
    assert.equal(signed.location, "/?signin=not_allowed");
    assert.ok(!b.jar.has("bloks_session"));
    const members = await h.json("/api/workspace/members");
    assert.ok(!members.members.some((m: any) => m.name === "Guest"));
  });

  let sam!: Browser;
  let ana!: Browser;
  let samId = "";
  await t.test("a first sign in makes a member, and the admin group an admin", async () => {
    sam = as({ sub: "sam-sub", name: "Sam", email: "sam@example.com", groups: ["family"] });
    assert.equal((await sam.signIn()).location, "/");
    const mine = await sam.json("/api/member/workspace");
    assert.equal(mine.status, 200);
    assert.equal(mine.body.you.role, "member");
    samId = mine.body.you.personId;
    assert.equal((await sam.fetch("/api/bots")).status, 403, "a member never reaches the owner's routes");
    ana = as({ sub: "ana-sub", name: "Ana", email: "ana@example.com", groups: ["family", "bloks-admins"] });
    assert.equal((await ana.signIn()).location, "/");
    assert.equal((await ana.json("/api/member/workspace")).body.you.role, "admin");
    // the same identity again is the same person, not a second one
    const again = as({ sub: "sam-sub", name: "Sam", email: "sam@example.com", groups: ["family"] });
    assert.equal((await again.signIn()).location, "/");
    assert.equal((await again.json("/api/member/workspace")).body.you.personId, samId);
    const list = await h.json("/api/workspace/members");
    const row = list.members.find((m: any) => m.id === samId);
    assert.equal(row.signIn, "sam@example.com");
    assert.equal(list.members.filter((m: any) => m.name === "Sam").length, 1);
  });

  await t.test("an admin sees and deletes a member's own agent, never reading it", async () => {
    const made = await sam.json("/api/member/agents", { method: "POST", body: { name: "Diary" } });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const said = await sam.json(`/api/member/agents/${made.body.agent.id}/private/messages`, { method: "POST", body: { text: "my private diary entry" } });
    assert.ok(said.status === 202 || said.status === 200, JSON.stringify(said.body));
    // a member does not reach the list
    assert.equal((await sam.fetch("/api/workspace/member-agents")).status, 403);
    const seen = await ana.json("/api/workspace/member-agents");
    assert.equal(seen.status, 200);
    const row = seen.body.agents.find((a: any) => a.id === made.body.agent.id);
    assert.equal(row.name, "Diary");
    assert.equal(row.madeBy.name, "Sam");
    assert.ok(!JSON.stringify(seen.body).includes("my private diary entry"), "the list carries no words");
    // nor does deleting it read it to anybody
    const gone = await ana.json(`/api/workspace/member-agents/${made.body.agent.id}`, { method: "DELETE" });
    assert.equal(gone.status, 200);
    assert.ok(!JSON.stringify(gone.body).includes("my private diary entry"));
    assert.ok(!(await sam.json("/api/member/agents")).body.agents.some((a: any) => a.id === made.body.agent.id));
    assert.equal((await ana.fetch(`/api/workspace/member-agents/${made.body.agent.id}`, { method: "DELETE" })).status, 404);
    // in the record, with who did it and whose it was
    const ledger = await h.json("/api/ledger");
    const entry = ledger.entries.find((e: any) => e.kind === "agent.deleted" && e.detail?.agent === "Diary");
    assert.ok(entry, "recorded");
    assert.equal(entry.actor, "Ana (admin)");
    assert.equal(entry.detail.madeBy, "Sam");
    assert.ok(!JSON.stringify(entry).includes("my private diary entry"));
    // and the owner may do the same, as themselves
    const another = await sam.json("/api/member/agents", { method: "POST", body: { name: "Scratch" } });
    assert.equal((await owner.fetch(`/api/workspace/member-agents/${another.body.agent.id}`, { method: "DELETE" })).status, 200);
    const after = await h.json("/api/ledger");
    assert.equal(after.entries.find((e: any) => e.detail?.agent === "Scratch").actor, "Hamed");
  });

  await t.test("an invite link opened in a browser: sign in, wait, and be let in", async () => {
    const made = await h.json("/api/workspace/invites", { method: "POST", body: JSON.stringify({ role: "member", name: "Lee" }) });
    const link = made.invite.webLink as string;
    assert.ok(link.startsWith(`${door}/join#`), link);
    const code = link.split("#")[1];
    const lee = as({ sub: "lee-sub", name: "Lee", email: "lee@elsewhere.example", groups: ["family"] });
    const preview = await lee.json("/auth/join/lookup", { method: "POST", body: { code } });
    assert.equal(preview.status, 200);
    assert.equal(preview.body.preview.inviter, "Hamed");
    assert.equal(preview.body.hostKey, undefined);
    assert.equal((await lee.json("/auth/join/lookup", { method: "POST", body: { code: "22222222" } })).status, 404);
    const signed = await lee.signIn({ code });
    assert.equal(signed.location, "/join");
    const waiting = await lee.json("/auth/session");
    assert.equal(waiting.body.signedIn, false);
    assert.equal(waiting.body.waiting.status, "waiting");
    assert.match(waiting.body.waiting.phrase, /^\w+ \w+ \w+ \w+$/);
    assert.equal((await lee.fetch("/api/member/workspace")).status, 401, "nothing until let in");
    // the owner sees the same four words, and lets them in
    const list = await h.json("/api/workspace/members");
    const request = list.requests.find((r: any) => r.inviteId === made.invite.id);
    assert.equal(request.phrase, waiting.body.waiting.phrase);
    assert.equal(request.device, "browser");
    assert.equal((await h.fetch(`/api/workspace/requests/${made.invite.id}/approve`, { method: "POST" })).status, 200);
    const done = await lee.json("/auth/join/status", { method: "POST", body: {} });
    assert.equal(done.body.status, "approved");
    const in_ = await lee.json("/api/member/workspace");
    assert.equal(in_.status, 200);
    assert.equal(in_.body.you.name, "Lee");
    // and the invite is used
    assert.equal((await new Browser(door).json("/auth/join/lookup", { method: "POST", body: { code } })).status, 410);
  });

  await t.test("let in after closing the tab, a joiner signs in from any browser", async () => {
    const made = await h.json("/api/workspace/invites", { method: "POST", body: JSON.stringify({ role: "member", name: "Kit" }) });
    const code = (made.invite.webLink as string).split("#")[1];
    const laptop = as({ sub: "kit-sub", name: "Kit", email: "kit@elsewhere.example", groups: ["family"] });
    assert.equal((await laptop.signIn({ code })).location, "/join");
    // the tab is closed; the owner lets them in later
    assert.equal((await h.fetch(`/api/workspace/requests/${made.invite.id}/approve`, { method: "POST" })).status, 200);
    const phone = as({ sub: "kit-sub", name: "Kit", email: "kit@elsewhere.example", groups: ["family"] });
    assert.equal((await phone.signIn()).location, "/", "signed in as Kit, not refused as never invited");
    assert.equal((await phone.json("/api/member/workspace")).body.you.name, "Kit");
    // and the laptop, looking again, is in too
    assert.equal((await laptop.json("/auth/join/status", { method: "POST", body: {} })).body.status, "approved");
    assert.equal((await laptop.fetch("/api/member/workspace")).status, 200);
  });

  await t.test("a waiting browser that signs out takes its request with it", async () => {
    const made = await h.json("/api/workspace/invites", { method: "POST", body: JSON.stringify({ role: "member", name: "Ash" }) });
    const code = (made.invite.webLink as string).split("#")[1];
    const ash = as({ sub: "ash-sub", name: "Ash", email: "ash@elsewhere.example", groups: ["family"] });
    assert.equal((await ash.signIn({ code })).location, "/join");
    assert.ok((await h.json("/api/workspace/members")).requests.some((r: any) => r.inviteId === made.invite.id));
    await ash.fetch("/auth/logout", { method: "POST", body: {} });
    assert.ok(!(await h.json("/api/workspace/members")).requests.some((r: any) => r.inviteId === made.invite.id), "nobody is let in to a browser that left");
  });

  await t.test("removing a member signs their browser out at once", async () => {
    assert.equal((await sam.fetch("/api/member/workspace")).status, 200);
    assert.equal((await h.fetch(`/api/workspace/members/${samId}`, { method: "DELETE" })).status, 200);
    assert.equal((await sam.fetch("/api/member/workspace")).status, 401);
    // signing in again does not quietly bring back who they were
    const back = as({ sub: "sam-sub", name: "Sam", email: "sam@example.com", groups: ["family"] });
    assert.equal((await back.signIn()).location, "/");
    assert.notEqual((await back.json("/api/member/workspace")).body.you.personId, samId);
  });

  await t.test("signing out ends the session, and offers the provider's own sign out", async () => {
    const out = await owner.json("/auth/logout", { method: "POST", body: {} });
    assert.equal(out.status, 200);
    assert.ok(out.body.redirect.startsWith(`${idp.issuer}/logout?`));
    assert.ok(out.body.redirect.includes(`post_logout_redirect_uri=${encodeURIComponent(`${door}/`)}`));
    assert.equal((await owner.fetch("/api/bots")).status, 401);
  });
});

test("when the address is who somebody is, an address the provider has not verified signs nobody in", async (t) => {
  const idp = await fakeOidc();
  t.after(() => idp.close());
  const licence = await teamPlan();
  t.after(() => licence.close());
  const home = mkdtempSync(join(tmpdir(), "bloks-web-door-email-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, ".bloks"), { recursive: true });
  writeFileSync(join(home, ".bloks", "config.json"), JSON.stringify({ profile: { name: "Hamed" }, ...licence.config }));
  const port = await freePort();
  const door = `http://127.0.0.1:${port}`;
  const h = await startHarness({
    HOME: home,
    ...licence.env,
    BLOKS_WEB_URL: door,
    BLOKS_WEB_LISTEN: `127.0.0.1:${port}`,
    BLOKS_OIDC_ISSUER: idp.issuer,
    BLOKS_OIDC_CLIENT_ID: idp.clientId,
    BLOKS_OIDC_CLIENT_SECRET: idp.clientSecret,
    BLOKS_OIDC_PERSON_CLAIM: "email",
    BLOKS_OIDC_OWNER: "hamed@example.com",
    // a group lets people in, which never looks at the address
    BLOKS_OIDC_ALLOWED_GROUPS: "family",
    BLOKS_OIDC_AUTO_CREATE: "1",
  });
  t.after(() => h.stop());
  for (let i = 0; i < 100; i++) {
    const up = await fetch(`${door}/auth/session`).then((r) => r.ok, () => false);
    if (up) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const as = (user: FakeUser) => {
    idp.state.user = user;
    idp.state.mode = "good";
    return new Browser(door);
  };
  const partner = await as({ sub: "partner-1", name: "Partner", email: "partner@example.com", email_verified: true, groups: ["family"] }).signIn();
  assert.equal(partner.location, "/", "a verified address signs in");
  const impostor = as({ sub: "someone-else", name: "Impostor", email: "partner@example.com", email_verified: false, groups: ["family"] });
  const refused = await impostor.signIn();
  assert.equal(refused.location, "/?signin=not_allowed");
  assert.ok(!impostor.jar.has("bloks_session"));
  assert.match(h.logs(), /has not verified partner@example\.com/);
  // a provider that never says either way is taken at its word
  const silent = await as({ sub: "silent-1", name: "Quiet", email: "quiet@example.com", groups: ["family"] }).signIn();
  assert.equal(silent.location, "/");
});
