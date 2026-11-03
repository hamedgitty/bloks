// The rules a household workspace leans on (GitHub 386, 431), as plain
// functions: where an agent may look back from each of its conversations,
// whose memory a conversation keeps, whose own apps and keys a turn uses,
// the member routes that reach a person's own things, and the store that
// keeps them. The same rules against the real server are
// test/household-privacy.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as access from "../server/access.ts";
import { memberCan } from "../server/member-access.ts";
import { appsKey, Personal, secretName, secretNameRefusal } from "../server/personal.ts";

const sam: access.Who = { kind: "member", personId: "sam", role: "member" };
const ana: access.Who = { kind: "member", personId: "ana", role: "member" };
const owner: access.Who = { kind: "owner" };
const chef: access.AgentShape = { id: "chef" };
const narrow: access.AgentShape = { id: "narrow", access: { mode: "only", people: ["ana"] } };
const samsOwn: access.AgentShape = { id: "helper", solo: { by: "sam" } };

const general: access.LaneShape = { id: "general" };
const team: access.LaneShape = { id: "team", team: true };
const samLane: access.LaneShape = { id: "sam-private", personId: "sam" };
const anaLane: access.LaneShape = { id: "ana-private", personId: "ana" };
const lanes = [general, team, samLane, anaLane];
const reach = (agent: access.AgentShape, from: access.RecallFrom) => lanes.filter((lane) => access.mayRecall(agent, from, lane)).map((lane) => lane.id);

test("from a member's private conversation, an agent looks back only where that member could read", () => {
  assert.deepEqual(reach(chef, { lane: samLane, who: sam }), ["team", "sam-private"]);
  assert.ok(!access.mayRecall(chef, { lane: samLane, who: sam }, { room: true }), "an owner's room");
  // not on the team conversation's list, so not that either
  assert.deepEqual(reach(narrow, { lane: samLane, who: sam }), ["sam-private"]);
});

test("from the team conversation, the team conversation alone", () => {
  assert.deepEqual(reach(chef, { lane: team, who: owner }), ["team"]);
  assert.deepEqual(reach(chef, { lane: team, who: ana }), ["team"]);
  assert.ok(!access.mayRecall(chef, { lane: team, who: owner }, { room: true }));
});

test("from the owner's own conversations, never a member's private one, whatever the reading setting", () => {
  assert.deepEqual(reach(chef, { lane: general, who: owner }), ["general", "team"]);
  assert.ok(access.mayRecall(chef, { lane: general, who: owner }, { room: true }));
});

test("the owner reading from a device sees members' private conversations only while reading them is on, and a member's solo agent never", () => {
  assert.deepEqual(reach(chef, { reader: "owner", privateReadable: false }), ["general", "team"]);
  assert.deepEqual(reach(chef, { reader: "owner", privateReadable: true }), ["general", "team", "sam-private", "ana-private"]);
  assert.deepEqual(reach(samsOwn, { reader: "owner", privateReadable: true }), []);
  // and the member's own solo agent looks back across all of its own
  assert.deepEqual(reach(samsOwn, { lane: general, who: sam }), ["general", "team", "sam-private", "ana-private"]);
});

test("a member's private conversation keeps their own memory; everything else keeps the agent's", () => {
  assert.deepEqual(access.memoryOf(chef, samLane), { kind: "person", personId: "sam" });
  assert.deepEqual(access.memoryOf(chef, team), { kind: "agent" });
  assert.deepEqual(access.memoryOf(chef, general), { kind: "agent" });
  // a solo agent's memory is its maker's already
  assert.deepEqual(access.memoryOf(samsOwn, { id: "x", personId: "sam" }), { kind: "agent" });
});

test("a member's own apps and keys: their private conversation or their solo agent, on a turn they asked for, and nowhere else", () => {
  const none = { room: false };
  assert.equal(access.personalAccountsFor(chef, samLane, "sam", none), "sam");
  assert.equal(access.personalAccountsFor(samsOwn, general, "sam", none), "sam");
  // another member, the owner, the team conversation, a room
  assert.equal(access.personalAccountsFor(chef, samLane, "ana", none), null, "another member in Sam's lane");
  assert.equal(access.personalAccountsFor(chef, samLane, "owner", none), null, "the owner");
  assert.equal(access.personalAccountsFor(chef, team, "sam", none), null, "the team conversation");
  assert.equal(access.personalAccountsFor(chef, samLane, "sam", { room: true }), null, "a room");
  assert.equal(access.personalAccountsFor(samsOwn, general, "sam", { room: true }), null, "Sam's own agent in a room");
  assert.equal(access.personalAccountsFor(samsOwn, general, "ana", none), null, "somebody else on Sam's agent");
  assert.equal(access.personalAccountsFor(chef, general, "owner", none), null, "the owner's own, which are not personal ones");
});

test("the owner's own accounts and self: his own turns on his own agents, and never a member's turn or a member's agent", () => {
  assert.equal(access.agentOwner(chef), "owner");
  assert.equal(access.agentOwner({ id: "mine", solo: { by: "owner" } }), "owner", "the owner's own solo agent");
  assert.equal(access.agentOwner(samsOwn), "sam");
  assert.ok(access.runsAsOwner(chef, "owner"), "the owner's own turn");
  assert.ok(access.runsAsOwner({ id: "mine", solo: { by: "owner" } }, "owner"));
  // a member asking, anywhere, the admins included
  assert.ok(!access.runsAsOwner(chef, "sam"), "a member's turn on a team agent");
  assert.ok(!access.runsAsOwner(narrow, "ana"));
  // a member's own agent, whoever speaks to it: in a room the owner can
  assert.ok(!access.runsAsOwner(samsOwn, "owner"), "the owner speaking to Sam's agent in a room");
  assert.ok(!access.runsAsOwner(samsOwn, "sam"), "Sam's own turn on his agent uses his, never the owner's");
  assert.ok(!access.runsAsOwner(samsOwn, "ana"));
  // and a stranger's mail or a Telegram person, as before
  assert.ok(!access.runsAsOwner(chef, "mail:anyone"));
  assert.ok(!access.runsAsOwner(chef, "telegram:1"));
});

test("a person's own things are member routes for a member or an admin, never a guest's, and name nobody else", () => {
  const room = () => null;
  const no = () => false;
  for (const [method, path] of [
    ["GET", "/api/member/connections"],
    ["PUT", "/api/member/connections/apps"],
    ["DELETE", "/api/member/connections/apps"],
    ["GET", "/api/member/connections/apps/services"],
    ["POST", "/api/member/connections/apps/gmail"],
    ["DELETE", "/api/member/connections/apps/gmail"],
    ["PUT", "/api/member/connections/secrets/TRANSISTOR_API_KEY"],
    ["DELETE", "/api/member/connections/secrets/TRANSISTOR_API_KEY"],
    ["GET", "/api/member/memory"],
    ["DELETE", "/api/member/memory/chef"],
    ["POST", "/api/member/welcomed"],
  ] as const) {
    assert.equal(memberCan(method, path, room, no, "member").ok, true, `${method} ${path} for a member`);
    assert.equal(memberCan(method, path, room, no, "admin").ok, true, `${method} ${path} for an admin`);
    const guest = memberCan(method, path, room, no, null);
    assert.equal(guest.ok, false, `${method} ${path} for a guest`);
  }
  // nothing that would name another person's, and no traversal through a name
  assert.equal(memberCan("GET", "/api/member/connections/ana", room, no, "admin").ok, false);
  assert.equal(memberCan("PUT", "/api/member/connections/secrets/lower_case", room, no, "member").ok, false);
  assert.equal(memberCan("PUT", "/api/member/connections/secrets/..%2F", room, no, "member").ok, false);
  assert.equal(memberCan("GET", "/api/member/connections/secrets/TRANSISTOR_API_KEY", room, no, "member").ok, false, "no value is ever read back");
});

test("secret names are environment names, and the reserved ones are refused", () => {
  assert.equal(secretName("Transistor API key"), "TRANSISTOR_API_KEY");
  assert.equal(secretNameRefusal("TRANSISTOR_API_KEY"), null);
  assert.match(secretNameRefusal("PATH") ?? "", /system and the engines read/);
  assert.match(secretNameRefusal("BLOKS_TOKEN") ?? "", /system and the engines read/);
  assert.match(secretNameRefusal("") ?? "", /name/);
  assert.equal(appsKey("ck_" + "x".repeat(20)), "ck_" + "x".repeat(20));
  assert.equal(appsKey("ak_" + "x".repeat(20)), null, "a project key is not a Connect key");
  assert.equal(appsKey("ck_short"), null);
});

test("each person's own things are kept apart, private to this account, and never shown back", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "bloks-personal-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new Personal(dir);
  // built here, never a literal shaped like a key
  const samKey = ["ck", "sam".repeat(6)].join("_");
  const samValue = ["value", "for", "sam"].join("-");
  store.setAppsKey("sam", samKey, 1);
  assert.deepEqual(store.saveSecret("sam", "Transistor API key", samValue, 2), { name: "TRANSISTOR_API_KEY" });
  assert.ok("error" in store.saveSecret("sam", "PATH", "x"));
  assert.ok("error" in store.saveSecret("sam", "EMPTY", "   "));

  assert.equal(store.appsKeyOf("sam"), samKey);
  assert.deepEqual(store.secretsOf("sam"), { TRANSISTOR_API_KEY: samValue });
  assert.equal(store.appsKeyOf("ana"), null, "Ana has none, and gets nobody else's");
  assert.deepEqual(store.secretsOf("ana"), {});

  const view = JSON.stringify(store.view("sam"));
  assert.ok(!view.includes(samKey) && !view.includes(samValue), "a value was shown back");
  assert.equal(store.view("sam").apps.ending, samKey.slice(-4));

  const file = join(dir, "people", "sam", "own.json");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  // read again from disk, as after a restart
  const again = new Personal(dir);
  assert.equal(again.appsKeyOf("sam"), samKey);
  assert.deepEqual(again.values(["sam", "ana"]).sort(), [samKey, samValue].sort());
  assert.ok(again.forgetSecret("sam", "TRANSISTOR_API_KEY"));
  assert.deepEqual(again.secretsOf("sam"), {});
  again.setAppsKey("sam", null);
  assert.equal(again.appsKeyOf("sam"), null);
  assert.ok(!readFileSync(file, "utf8").includes(samValue));

  // the welcome, once
  assert.equal(again.welcomed("sam"), false);
  again.welcome("sam", 5);
  assert.equal(new Personal(dir).welcomed("sam"), true);
  // and a path is never made of anything but an id
  assert.equal(again.appsKeyOf("../ana"), null);
});
