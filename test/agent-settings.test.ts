// An agent's settings for the people in a workspace, against the real
// server (server/access.ts mayChangeSettings, agentSettingsRoute in
// server/index.ts): the owner changes the agents members made without
// reading them, an admin changes every agent but the owner's own, a member
// changes the agents they made and is told plainly what stays the owner's
// and the admins', and nobody else reaches any of it: not another member,
// not an agent's credential.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startHarness } from "./helpers/server.ts";
import { teamPlan } from "./helpers/team-plan.ts";
import { JoinClient } from "../server/join-client.ts";

const waitFor = async <T,>(check: () => T | undefined, ms = 15_000): Promise<T> => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const value = check();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error("the agent's turn never handed over its credential");
};

test("agent settings: owner, admin, the maker, another member and an agent's credential", { timeout: 240_000 }, async (t) => {
  const home = mkdtempSync(join(tmpdir(), "bloks-agent-settings-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const tokenFile = join(home, "turn-token");
  const cli = join(home, "fake-claude.mjs");
  // A real, bounded turn hands over its agent credential. No engine is reached.
  writeFileSync(cli, `#!${process.execPath}
import { writeFileSync } from "node:fs";
if (process.argv[2] === "--version") { console.log("2.1.299 (Claude Code)"); process.exit(0); }
if (process.argv[2] === "auth") { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
process.on("SIGTERM", () => process.exit(0));
let input = "";
process.stdin.on("data", function take(chunk) {
  input += chunk;
  if (!input.includes(String.fromCharCode(10))) return;
  console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "settings-session", model: "claude-sonnet-5" }));
  writeFileSync(${JSON.stringify(tokenFile)}, process.env.BLOKS_TOKEN);
  process.stdin.off("data", take);
  setTimeout(() => process.exit(0), 60_000);
});
`, { mode: 0o755 });
  mkdirSync(join(home, ".bloks"), { recursive: true });
  const licence = await teamPlan();
  t.after(() => licence.close());
  writeFileSync(join(home, ".bloks", "config.json"), JSON.stringify({
    remote: { enabled: true },
    profile: { name: "Hamed" },
    instances: { claude: { driver: "claudeAgent", config: { cli } } },
    ...licence.config,
  }));
  const h = await startHarness({ HOME: home, ...licence.env });
  t.after(() => h.stop());
  const lan = new URL(h.url).host;

  async function joinAs(name: string, role: "member" | "admin" = "member") {
    const made = await h.json("/api/workspace/invites", { method: "POST", body: JSON.stringify({ role, name }) });
    assert.ok(made.invite, JSON.stringify(made));
    const client = new JoinClient(() => "http://127.0.0.1:9");
    const found = (await client.lookup(`${made.invite.link}~${lan}`)) as any;
    await client.claim(found.session, { name });
    assert.equal((await h.fetch(`/api/workspace/requests/${made.invite.id}/approve`, { method: "POST" })).status, 200);
    return ((await client.status(found.session)) as any).credentials as { deviceToken: string; personId: string };
  }
  const as = (who: { deviceToken: string }, path: string, init: { method?: string; body?: unknown } = {}) =>
    h.fetchRemote(path, { method: init.method ?? "GET", token: who.deviceToken, ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}) });
  const settingsOf = (who: { deviceToken: string }, id: string, body?: unknown) =>
    as(who, `/api/member/agents/${id}/settings`, body === undefined ? {} : { method: "PATCH", body });
  const ownerSettings = async (id: string, body?: unknown) => {
    const res = await h.fetch(`/api/workspace/agents/${id}/settings`, body === undefined ? {} : { method: "PATCH", body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const ownerBot = async (id: string) => (await h.json("/api/bots")).bots.find((b: any) => b.id === id);

  const { bot: chief } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Chief" }) });
  const mina = await joinAs("Mina", "admin");
  const sam = await joinAs("Sam");
  const ana = await joinAs("Ana");
  const made = await as(sam, "/api/member/agents", { method: "POST", body: { name: "Helper" } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const helper = made.body.agent;
  assert.equal(helper.settings, true, "the maker is told they may open its settings");

  await t.test("the agents list says who may open which agent's settings", async () => {
    const samList = (await as(sam, "/api/member/agents")).body.agents;
    assert.equal(samList.find((a: any) => a.id === helper.id).settings, true);
    assert.equal(samList.find((a: any) => a.id === chief.id).settings, false);
    const minaList = (await as(mina, "/api/member/agents")).body.agents;
    assert.equal(minaList.find((a: any) => a.id === chief.id).settings, true);
  });

  await t.test("an admin opens and changes a team agent of the owner's, everything in it", async () => {
    const seen = await settingsOf(mina, chief.id);
    assert.equal(seen.status, 200, JSON.stringify(seen.body));
    assert.equal(seen.body.agent.name, "Chief");
    assert.deepEqual(seen.body.held, {}, "nothing is held from an admin");
    assert.ok(seen.body.engines.some((e: any) => e.id === "claude" && e.allowed));
    const changed = await settingsOf(mina, chief.id, {
      name: "Chief of staff",
      description: "Keeps the week in order.",
      approvals: "full",
      browser: true,
      computer: "off",
      modelSelection: { instanceId: "claude", model: "claude-sonnet-5" },
    });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    const bot = await ownerBot(chief.id);
    assert.equal(bot.name, "Chief of staff");
    assert.equal(bot.description, "Keeps the week in order.");
    assert.equal(bot.approvals, "full");
    assert.equal(bot.browser, true);
    assert.equal(bot.computer, "off");
    assert.deepEqual(bot.modelSelection, { instanceId: "claude", model: "claude-sonnet-5" });
  });

  await t.test("an admin opens an agent a member made, and is told whose it is", async () => {
    const seen = await settingsOf(mina, helper.id);
    assert.equal(seen.status, 200, JSON.stringify(seen.body));
    assert.deepEqual(seen.body.agent.madeBy, { id: sam.personId, name: "Sam" });
    assert.equal(seen.body.agent.mine, false);
    assert.equal(JSON.stringify(seen.body).includes("messages"), false, "no conversation comes with it");
    assert.equal((await settingsOf(mina, helper.id, { approvals: "auto" })).status, 200);
  });

  await t.test("the owner opens and changes an agent a member made, which stays off the owner's list", async () => {
    const seen = await ownerSettings(helper.id);
    assert.equal(seen.status, 200, JSON.stringify(seen.body));
    assert.equal(seen.body.settings.approvals, "auto");
    assert.deepEqual(seen.body.agent.madeBy, { id: sam.personId, name: "Sam" });
    const changed = await ownerSettings(helper.id, { title: "Researcher", computer: "sandbox" });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    assert.equal(changed.body.agent.title, "Researcher");
    assert.equal(changed.body.settings.computer, "sandbox");
    assert.equal(await ownerBot(helper.id), undefined, "a member's agent is still not in the owner's list");
  });

  await t.test("the maker changes their own agent, short of what reaches past them", async () => {
    const seen = await settingsOf(sam, helper.id);
    assert.equal(seen.status, 200, JSON.stringify(seen.body));
    assert.equal(seen.body.agent.mine, true);
    assert.equal(seen.body.agent.madeBy, undefined);
    assert.deepEqual(seen.body.held, { approvals: "edits", computer: true });
    assert.equal(seen.body.owner.name, "Hamed");

    assert.equal((await settingsOf(sam, helper.id, { name: "Scout", browser: true, description: "Finds things." })).status, 200);
    // what an admin gave it may stay when something else changes, and be said again
    assert.equal((await settingsOf(sam, helper.id, { approvals: "auto", computer: "sandbox", name: "Scout" })).status, 200);
    // and narrowed
    assert.equal((await settingsOf(sam, helper.id, { approvals: "edits" })).status, 200);
    assert.equal((await settingsOf(sam, helper.id, { computer: "off" })).status, 200);
    // never widened again by the maker, with why, and nothing of the change written
    for (const [field, value] of [["approvals", "auto"], ["approvals", "full"], ["computer", "local"], ["computer", "sandbox"], ["computer", "cloud"]] as const) {
      const refused = await settingsOf(sam, helper.id, { name: "Half done", [field]: value });
      assert.equal(refused.status, 403, `${field} ${value}`);
      assert.equal(refused.body.code, "held");
      assert.equal(refused.body.field, field);
      assert.match(refused.body.error, /^Only Hamed and the admins can /);
    }
    const after = (await settingsOf(sam, helper.id)).body;
    assert.equal(after.agent.name, "Scout", "a refused change writes nothing");
    assert.equal(after.settings.approvals, "edits");
    assert.equal(after.settings.computer, "off");
    assert.equal(after.settings.browser, true);
  });

  await t.test("the maker moves only to engines their limits allow", async () => {
    const limited = await h.fetch(`/api/workspace/members/${sam.personId}`, { method: "PATCH", body: JSON.stringify({ limits: { engines: ["claude"] } }) });
    assert.equal(limited.status, 200);
    const seen = (await settingsOf(sam, helper.id)).body;
    const other = seen.engines.find((e: any) => e.id !== "claude");
    assert.equal(other, undefined, "an engine they may not use is not offered");
    const codex = await settingsOf(sam, helper.id, { modelSelection: { instanceId: "codex", model: "gpt-5" } });
    assert.equal(codex.status, 403);
    assert.equal(codex.body.code, "held");
    assert.equal(codex.body.field, "engine");
    assert.equal((await settingsOf(sam, helper.id, { modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } })).status, 200);
    // the owner and admins are not held to a member's limits
    assert.equal((await settingsOf(mina, helper.id, { modelSelection: { instanceId: "codex", model: "gpt-5" } })).status, 200);
  });

  await t.test("bad values are refused as such", async () => {
    assert.equal((await settingsOf(sam, helper.id, { name: "  " })).status, 400);
    assert.equal((await settingsOf(sam, helper.id, { approvals: "sometimes" })).status, 400);
    assert.equal((await settingsOf(sam, helper.id, { browser: "yes" })).status, 400);
    assert.equal((await settingsOf(sam, helper.id, { computer: "the moon" })).status, 400);
    assert.equal((await settingsOf(mina, chief.id, { modelSelection: { instanceId: "nope", model: "x" } })).status, 400);
    assert.equal((await settingsOf(mina, chief.id, { modelSelection: { instanceId: "claude", model: "a b; rm" } })).status, 400);
  });

  await t.test("another member: a team agent is somebody else's to change, another member's agent is not there at all", async () => {
    const team = await settingsOf(ana, chief.id);
    assert.equal(team.status, 403);
    assert.equal(team.body.code, "not_yours");
    assert.equal(team.body.error, "Hamed and the admins change Chief of staff's settings.");
    assert.equal((await settingsOf(ana, chief.id, { name: "Mine now" })).status, 403);
    assert.equal((await settingsOf(ana, helper.id)).status, 404);
    assert.equal((await settingsOf(ana, helper.id, { name: "Mine now" })).status, 404);
    assert.equal((await settingsOf(ana, "no-such-agent")).status, 404);
    // and the owner's own route is not theirs, nor is the owner's agent route
    assert.equal((await as(ana, `/api/workspace/agents/${chief.id}/settings`)).status, 403);
    assert.equal((await as(mina, `/api/bots/${chief.id}`, { method: "PATCH", body: { name: "x" } })).status, 403);
    assert.equal((await ownerBot(chief.id)).name, "Chief of staff");
  });

  await t.test("an agent's credential reaches neither way in", async () => {
    await h.json(`/api/bots/${chief.id}/messages`, { method: "POST", body: JSON.stringify({ text: "Hold for the settings checks" }) });
    await waitFor(() => (existsSync(tokenFile) && readFileSync(tokenFile, "utf8") ? true : undefined));
    const token = readFileSync(tokenFile, "utf8");
    const asAgent = (path: string, init: RequestInit = {}) => h.fetch(path, { ...init, headers: { authorization: `Bearer ${token}` } });
    assert.equal((await asAgent(`/api/workspace/agents/${helper.id}/settings`)).status, 403);
    assert.equal((await asAgent(`/api/workspace/agents/${chief.id}/settings`, { method: "PATCH", body: JSON.stringify({ approvals: "full" }) })).status, 403);
    for (const method of ["GET", "PATCH"]) {
      const res = await asAgent(`/api/member/agents/${helper.id}/settings`, { method, ...(method === "PATCH" ? { body: JSON.stringify({ name: "x" }) } : {}) });
      assert.ok(res.status >= 400, `${method} the member route as an agent: ${res.status}`);
    }
    assert.equal((await settingsOf(sam, helper.id)).body.agent.name, "Scout");
  });
});
