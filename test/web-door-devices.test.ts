// A self-hosted server used from a browser at its web door, the way a
// household on Docker uses it: the owner pairs the desktop app from
// Settings with the link `bloks-server pair` prints, no terminal on the
// server needed, and that link pairs at the server's own address; an
// admin opens and changes an agent a member made, and the member their
// own; nobody but the owner makes a pairing code.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startHarness } from "./helpers/server.ts";
import { teamPlan } from "./helpers/team-plan.ts";
import { fakeOidc, type FakeUser } from "./helpers/fake-oidc.ts";
import { claimDirectLink } from "../electron/remote.mjs";

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

/** A browser at the door: its cookies, and the door's own Origin. */
class Browser {
  jar = new Map<string, string>();
  door: string;
  constructor(door: string) {
    this.door = door;
  }
  async json(path: string, init: { method?: string; body?: unknown; origin?: string | null } = {}) {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (init.origin !== null) headers.origin = init.origin ?? this.door;
    if (this.jar.size) headers.cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
    const res = await fetch(`${this.door}${path}`, {
      method: init.method ?? "GET",
      redirect: "manual",
      headers,
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
    for (const line of res.headers.getSetCookie()) {
      const pair = line.split(";")[0];
      const name = pair.slice(0, pair.indexOf("="));
      const value = pair.slice(pair.indexOf("=") + 1);
      if (!value || /max-age=0/i.test(line)) this.jar.delete(name);
      else this.jar.set(name, value);
    }
    return { status: res.status, headers: res.headers, body: await res.json().catch(() => null) };
  }
  async signIn() {
    const start = await this.json("/auth/login", { method: "POST", body: { next: "/" } });
    assert.equal(start.status, 200, JSON.stringify(start.body));
    const auth = await fetch(start.body.url, { redirect: "manual" });
    const callback = new URL(auth.headers.get("location")!);
    const back = await this.json(`${callback.pathname}${callback.search}`, { origin: null });
    assert.equal(back.headers.get("location"), "/");
  }
}

test("from the browser: the owner pairs the desktop app; agent settings by role", { timeout: 240_000 }, async (t) => {
  const idp = await fakeOidc();
  t.after(() => idp.close());
  const licence = await teamPlan();
  t.after(() => licence.close());
  const home = mkdtempSync(join(tmpdir(), "bloks-web-devices-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, ".bloks"), { recursive: true });
  writeFileSync(join(home, ".bloks", "config.json"), JSON.stringify({ profile: { name: "Hamed" }, ...licence.config }));
  const doorPort = await freePort();
  const door = `http://127.0.0.1:${doorPort}`;
  // the harness's own port is the one a desktop app dials
  const h = await startHarness({
    HOME: home,
    ...licence.env,
    BLOKS_WEB_URL: door,
    BLOKS_WEB_LISTEN: `127.0.0.1:${doorPort}`,
    BLOKS_OIDC_ISSUER: idp.issuer,
    BLOKS_OIDC_CLIENT_ID: idp.clientId,
    BLOKS_OIDC_CLIENT_SECRET: idp.clientSecret,
    BLOKS_OIDC_OWNER: "owner-sub",
    BLOKS_OIDC_ALLOWED_GROUPS: "family",
    BLOKS_OIDC_ADMIN_GROUP: "bloks-admins",
    BLOKS_OIDC_AUTO_CREATE: "1",
  });
  t.after(() => h.stop());
  for (let i = 0; i < 100; i++) {
    if (await fetch(`${door}/auth/session`).then((r) => r.ok, () => false)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const as = async (user: FakeUser) => {
    idp.state.user = user;
    idp.state.mode = "good";
    const b = new Browser(door);
    await b.signIn();
    return b;
  };
  const owner = await as({ sub: "owner-sub", name: "Hamed", email: "hamed@example.com", groups: [] });
  const mina = await as({ sub: "mina-sub", name: "Mina", email: "mina@example.com", groups: ["family", "bloks-admins"] });
  const sam = await as({ sub: "sam-sub", name: "Sam", email: "sam@example.com", groups: ["family"] });
  assert.equal((await mina.json("/auth/session")).body.as.role, "admin");
  assert.equal((await sam.json("/auth/session")).body.as.role, "member");

  await t.test("the owner makes a pairing code from Settings, and only the owner", async () => {
    assert.equal((await h.fetch("/api/pair", { method: "PUT", body: JSON.stringify({ enabled: true }) })).status, 200);
    const started = await owner.json("/api/pair/start", { method: "POST" });
    assert.equal(started.status, 200, JSON.stringify(started.body));
    assert.match(started.body.code, /^\d{6}$/);
    assert.match(started.body.token, /^bloks_pair_/);
    for (const who of [mina, sam]) {
      assert.equal((await who.json("/api/pair/start", { method: "POST" })).status, 403);
      assert.equal((await who.json("/api/pair")).status, 403);
    }
    // the link the panel shows pairs the desktop app at the server's own address
    const port = new URL(h.url).port;
    const link = `bloks://pair?address=${encodeURIComponent(`127.0.0.1:${port}`)}&token=${started.body.token}&code=${started.body.code}`;
    const profile = await claimDirectLink(link, "Mac mini");
    assert.equal(profile.url, h.url);
    // and the desktop app, paired, is one of the owner's devices
    const bots = await h.fetchRemote("/api/bots?messages=0", { token: profile.deviceToken });
    assert.equal(bots.status, 200);
    assert.ok((await owner.json("/api/pair")).body.devices.some((d: any) => d.name === "Mac mini"));
  });

  await t.test("an admin changes a member's agent; the member changes their own, short of what is held", async () => {
    const made = await sam.json("/api/member/agents", { method: "POST", body: { name: "Homework" } });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const id = made.body.agent.id;
    const rows = (await mina.json("/api/workspace/member-agents")).body.agents;
    assert.ok(rows.some((r: any) => r.id === id));
    const byAdmin = await mina.json(`/api/member/agents/${id}/settings`, { method: "PATCH", body: { approvals: "auto", description: "Helps with homework." } });
    assert.equal(byAdmin.status, 200, JSON.stringify(byAdmin.body));
    assert.equal(byAdmin.body.agent.madeBy.name, "Sam");
    const own = await sam.json(`/api/member/agents/${id}/settings`);
    assert.equal(own.status, 200);
    assert.deepEqual(own.body.held, { approvals: "edits", computer: true });
    assert.equal(own.body.settings.approvals, "auto");
    assert.equal((await sam.json(`/api/member/agents/${id}/settings`, { method: "PATCH", body: { name: "Tutor" } })).status, 200);
    const widened = await sam.json(`/api/member/agents/${id}/settings`, { method: "PATCH", body: { approvals: "full" } });
    assert.equal(widened.status, 403);
    assert.equal(widened.body.code, "held");
    // and the owner, from the browser, through the owner's own route
    const byOwner = await owner.json(`/api/workspace/agents/${id}/settings`, { method: "PATCH", body: { approvals: "full" } });
    assert.equal(byOwner.status, 200, JSON.stringify(byOwner.body));
    assert.equal(byOwner.body.agent.name, "Tutor");
    // which is the owner's alone at the door too
    assert.equal((await mina.json(`/api/workspace/agents/${id}/settings`)).status, 403);
  });
});
