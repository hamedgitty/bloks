// A member's app, without a window: which app a window is, where it
// opens, what the sidebar lists, what making a solo agent allows, what the
// composer says about a limit (src/lib/memberRules.ts); how a joined
// workspace is listed and reached (electron/workspaces.mjs,
// electron/remote.mjs); and a workspace joined on the owner's own network
// opening through the stand-in on loopback, against the real server.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  agentGroups,
  cardState,
  defaultLane,
  firstPlace,
  foldRuntime,
  memberPages,
  modeFrom,
  roomAccessBody,
  roomAudienceLine,
  shouldAskMemberMode,
  soloRoom,
  speaker,
  usageNotice,
  type MemberAgent,
  type MemberUsage,
} from "../src/lib/memberRules.ts";
import { parseRegistry, settle, snapshot, updateWorkspace } from "../electron/workspaces.mjs";
import { reachOf, startLanProxy } from "../electron/remote.mjs";
import { startHarness } from "./helpers/server.ts";
import { teamPlan } from "./helpers/team-plan.ts";
import { JoinClient } from "../server/join-client.ts";
import { parseInviteInput } from "../server/invites.ts";

const agent = (over: Partial<MemberAgent>): MemberAgent => ({
  id: "a1",
  name: "Chief",
  title: "",
  color: "blue",
  shape: null,
  solo: false,
  mine: false,
  team: { threadId: "t1" },
  private: { threadId: null },
  busy: false,
  ...over,
});

const workspaceBody = {
  workspace: { id: "w", name: "Rahimi Enterprises", kind: "Team", mark: { color: "#149E8E", pattern: "110101011" } },
  you: { personId: "p_sam", name: "Sam", role: "member" },
  owner: { name: "Hamed" },
  privacy: { privateReadable: false, line: "yours" },
  members: [],
  solo: { count: 0, max: 3 },
  engines: [{ id: "claude", name: "Claude Code" }],
};

test("a window is the owner's unless the member routes answer for its credential", () => {
  // a workspace this app runs is never asked
  assert.equal(shouldAskMemberMode("personal"), false);
  assert.equal(shouldAskMemberMode("business"), false);
  assert.equal(shouldAskMemberMode("joined"), true);
  assert.equal(shouldAskMemberMode(undefined), true);
  assert.deepEqual(modeFrom(null, null), { mode: "owner" });
  assert.deepEqual(modeFrom({ status: 404, body: { error: "no such route" } }, null), { mode: "owner" });
  const member = modeFrom({ status: 200, body: workspaceBody }, null);
  assert.equal(member.mode, "member");
  assert.equal(member.mode === "member" && member.workspace.you.role, "member");
  // an admin is a member with more
  const admin = modeFrom({ status: 200, body: { ...workspaceBody, you: { ...workspaceBody.you, role: "admin" } } }, null);
  assert.equal(admin.mode === "member" && admin.workspace.you.role, "admin");
  // a guest of some rooms: the workspace refuses them, "me" lists rooms
  const guest = modeFrom({ status: 403, body: {} }, { status: 200, body: { person: { id: "p", name: "Leila" }, host: "Hamed", rooms: [{ id: "r1", name: "Launch", role: "collaborator", joinedAt: 1 }] } });
  assert.equal(guest.mode, "guest");
  // an owner's own paired device is refused member routes the other way
  assert.deepEqual(modeFrom({ status: 403, body: {} }, { status: 404, body: {} }), { mode: "owner" });
});

test("where a member's app opens, what its sidebar and rail list", () => {
  const chief = agent({ id: "chief", name: "Chief" });
  const scout = agent({ id: "scout", name: "Scout", team: null, private: { threadId: null } });
  const ivy = agent({ id: "ivy", name: "Ivy", solo: true, mine: true, team: null });
  assert.equal(defaultLane(chief), "team");
  assert.equal(defaultLane(scout), "private", "met only in a room: privately");
  assert.equal(defaultLane(ivy), "private");
  assert.deepEqual(agentGroups([ivy, scout, chief]), { team: [chief, scout], mine: [ivy] });
  assert.deepEqual(firstPlace([ivy, chief], [], null), { kind: "agent", id: "chief", lane: "team" });
  assert.deepEqual(firstPlace([], [{ id: "r1", name: "Launch", role: "viewer", joinedAt: 0 }], null), { kind: "room", id: "r1" });
  assert.deepEqual(firstPlace([], [], null), { kind: "page", page: "usage" });
  // the place last open, while it still exists, and its lane while that is theirs
  assert.deepEqual(firstPlace([chief, scout], [], { kind: "agent", id: "scout", lane: "team" }), { kind: "agent", id: "scout", lane: "private" });
  assert.deepEqual(firstPlace([chief], [], { kind: "agent", id: "gone", lane: "team" }), { kind: "agent", id: "chief", lane: "team" });
  assert.deepEqual(memberPages("member").map((p) => p.page), ["usage", "about", "connections", "settings"]);
  assert.deepEqual(memberPages("admin").map((p) => p.page), ["usage", "about", "connections", "members", "settings"]);
});

test("making a solo agent says plainly when it cannot", () => {
  assert.deepEqual(soloRoom({ count: 1, max: 3 }, 1, "Hamed"), { ok: true });
  const full = soloRoom({ count: 3, max: 3 }, 1, "Hamed");
  assert.equal(full.ok, false);
  assert.match(!full.ok ? full.why : "", /3 solo agents, as many as you may make here/);
  assert.match((soloRoom({ count: 0, max: 0 }, 1, "Hamed") as { why: string }).why, /not on for you/);
  assert.match((soloRoom({ count: 0, max: 3 }, 0, "Hamed") as { why: string }).why, /No engine/);
});

test("the composer speaks of a member's own limit only when it is near or reached", () => {
  const usage = (over: Partial<MemberUsage>): MemberUsage => ({
    month: "2026-10",
    spentUsd: 1,
    aiPercent: null,
    limits: { monthlyUsd: 10, aiPercent: null, maxSolo: 3, engines: null },
    soloAgents: 0,
    stopped: null,
    ...over,
  });
  assert.equal(usageNotice(null), null);
  assert.equal(usageNotice(usage({})), null);
  assert.equal(usageNotice(usage({ spentUsd: 8.5 }))?.level, "warn");
  assert.deepEqual(usageNotice(usage({ stopped: "You have reached your monthly limit." })), { level: "stop", text: "You have reached your monthly limit." });
  assert.equal(usageNotice(usage({ aiPercent: 9, limits: { monthlyUsd: null, aiPercent: 10, maxSolo: 3, engines: null } }))?.level, "warn");
});

test("lines say who wrote them, and cards whether they are this person's to answer", () => {
  assert.equal(speaker({ role: "user", author: "p_sam" }, "p_sam", {}, "Hamed"), "You");
  assert.equal(speaker({ role: "user", author: "p_ana" }, "p_sam", { p_ana: "Ana" }, "Hamed"), "Ana");
  assert.equal(speaker({ role: "user" }, "p_sam", {}, "Hamed"), "Hamed");
  assert.equal(speaker({ role: "user", author: "p_gone" }, "p_sam", {}, "Hamed"), "A former member");
  assert.equal(cardState({ title: "Approval needed", subtitle: "", options: ["Allow", "Deny"] }), "open");
  assert.equal(cardState({ title: "Approval needed", subtitle: "", options: [], ownerOnly: true }), "waiting-on-others");
  assert.equal(cardState({ title: "Approval needed", subtitle: "", options: ["Allow"], answered: "Allow" }), "done");
});

test("the room picker sends everyone or the people ticked, and says who is in", () => {
  assert.deepEqual(roomAccessBody("everyone", ["p_b"]), { audience: "everyone" });
  assert.deepEqual(roomAccessBody("some", ["p_b", "p_a", "p_b"]), { audience: "some", members: ["p_a", "p_b"] });
  assert.deepEqual(roomAccessBody("some", []), { audience: "some", members: [] });
  assert.match(roomAudienceLine("everyone", 0, 3, 0), /Everyone in the workspace is in this room, 3 members and you/);
  assert.match(roomAudienceLine("some", 0, 3, 0), /^Only you, for now/);
  assert.match(roomAudienceLine("some", 2, 3, 1), /2 of 3 members and you\. Plus 1 guest/);
});

test("a reply streams until its message lands", () => {
  let s: Record<string, string> = {};
  s = foldRuntime(s, { kind: "runtime", event: { type: "turn.started", threadId: "t" } });
  s = foldRuntime(s, { kind: "runtime", event: { type: "content.delta", threadId: "t", delta: "Hel" } });
  s = foldRuntime(s, { kind: "runtime", event: { type: "content.delta", threadId: "t", delta: "lo" } });
  assert.equal(s.t, "Hello");
  // a progress line is not the reply
  assert.equal(foldRuntime(s, { kind: "runtime", event: { type: "content.delta", threadId: "t", delta: "x", codexText: {} } }, () => true).t, "Hello");
  s = foldRuntime(s, { kind: "message", threadId: "t", message: { id: "m", at: 1, role: "bot", kind: "text", text: "Hello" } });
  assert.equal(s.t, undefined);
});

test("a joined workspace is listed with what you are there, and how it is reached", () => {
  const reg = settle(
    parseRegistry(
      JSON.stringify({
        version: 1,
        current: "personal",
        workspaces: [
          { id: "personal", kind: "personal", name: "Personal" },
          { id: "ws_a", kind: "joined", name: "Rahimi Enterprises", host: { name: "Hamed", relayUrl: "https://relay.example" }, role: "admin" },
          { id: "ws_b", kind: "joined", name: "Okafor Studio", host: { name: "Dee", relayUrl: "", lan: "192.168.1.20:8800" } },
        ],
      }),
    ),
    { personalDataDir: "/tmp/x" },
  );
  const listed = snapshot(reg).workspaces;
  const a = listed.find((w) => w.id === "ws_a")!;
  const b = listed.find((w) => w.id === "ws_b")!;
  assert.equal(a.role, "admin");
  assert.equal(a.lanOnly, false);
  assert.equal(b.role, "member");
  assert.equal(b.lanOnly, true);
  // a role the server says later sticks
  const promoted = updateWorkspace(reg, "ws_b", { role: "admin" });
  assert.equal(snapshot(promoted).workspaces.find((w) => w.id === "ws_b")!.role, "admin");
  assert.equal(reachOf({ relayUrl: "https://r", relayToken: "t", deviceId: "d", deviceToken: "x" }), "relay");
  assert.equal(reachOf({ relayUrl: null, relayToken: null, lan: "192.168.1.20:8800", deviceId: "d", deviceToken: "x" }), "lan");
  assert.equal(reachOf({ deviceId: "d", deviceToken: "x" }), null);
});

test("a workspace joined on the owner's network opens through the stand-in, with the member's own credential", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "bloks-lan-join-"));
  mkdirSync(join(home, ".bloks"), { recursive: true });
  // members are Bloks Team's (server/plan-limits.ts)
  const team = await teamPlan();
  t.after(() => team.close());
  writeFileSync(join(home, ".bloks", "config.json"), JSON.stringify({ remote: { enabled: true }, profile: { name: "Hamed" }, ...team.config }));
  const h = await startHarness({ HOME: home, ...team.env });
  t.after(() => h.stop());
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const lan = new URL(h.url).host;
  await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Chief" }) });
  const made = await h.json("/api/workspace/invites", { method: "POST", body: JSON.stringify({ role: "member", name: "Sam" }) });
  // The link may already carry this computer's own network address after
  // a "~", and the parser keeps the first one it finds, so that suffix is
  // taken off before the harness's is put on (GitHub 392). Whichever way
  // the link came, the join goes to the harness.
  const onHarness = (link: string) => `${link.split("~", 1)[0]}~${lan}`;
  const bare = made.invite.link.split("~", 1)[0];
  const elsewhere = `${bare}~192.0.2.10:8800`;
  assert.equal(parseInviteInput(`${elsewhere}~${lan}`)?.lan, "192.0.2.10:8800", "appended to a suffix, the harness is never asked");
  for (const link of [bare, elsewhere]) {
    assert.equal(parseInviteInput(onHarness(link))?.lan, lan, link);
  }
  // no Bloks Cloud anywhere: the relay address answers nothing
  const client = new JoinClient(() => "http://127.0.0.1:9");
  const found = (await client.lookup(onHarness(made.invite.link))) as any;
  assert.equal(found.via, "lan");
  await client.claim(found.session, { name: "Sam" });
  await h.fetch(`/api/workspace/requests/${made.invite.id}/approve`, { method: "POST" });
  const credentials = ((await client.status(found.session)) as any).credentials;
  assert.equal(credentials.relayUrl, null, "a join that never touched the relay");
  assert.equal(typeof credentials.lan, "string", "where the owner's computer answers on its network");
  assert.equal(reachOf(credentials), "lan");
  // The stand-in calls that address as another computer on the network
  // would. A computer with no network address of its own says loopback,
  // which the owner's server rightly takes for the owner.
  if (/^(127\.|localhost|\[::1\])/.test(credentials.lan)) return t.skip("this computer has no network address to join on");

  const ui = mkdtempSync(join(tmpdir(), "bloks-lan-ui-"));
  writeFileSync(join(ui, "index.html"), "<!doctype html><title>Bloks</title>");
  const proxy = await startLanProxy(credentials, { staticDir: ui });
  t.after(() => proxy.stop());
  t.after(() => rmSync(ui, { recursive: true, force: true }));
  const base = `http://127.0.0.1:${proxy.port}`;
  const ws = await fetch(`${base}/api/member/workspace`);
  assert.equal(ws.status, 200);
  assert.equal((await ws.json()).you.name, "Sam");
  // the owner's routes stay the owner's, through here as anywhere
  assert.equal((await fetch(`${base}/api/bots`)).status, 403);
  // and the page itself comes from this computer
  assert.match(await (await fetch(`${base}/`)).text(), /Bloks/);
  // a page elsewhere on this computer cannot use the stand-in
  assert.equal((await fetch(`${base}/api/member/workspace`, { headers: { origin: "http://evil.example" } })).status, 403);
});
