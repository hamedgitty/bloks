// Who may see what in a workspace with people in it (server/access.ts),
// walked through the owner's own example: a business workspace with
// eight members, a Chief whose team conversation only three of them are
// in, a room with all eight and Chief, Scout and Atlas, and an assistant
// of the owner's own that nobody else sees.
import { test } from "node:test";
import assert from "node:assert/strict";

import * as access from "../server/access.ts";
import { mayApprove, memberMessage, type MemberView } from "../server/member-access.ts";
import type { Message } from "../server/store.ts";

const ids = ["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8"];
const member = (id: string, role: "member" | "admin" = "member"): access.Who => ({ kind: "member", personId: id, role });
const owner: access.Who = { kind: "owner" };

const chief: access.AgentShape = { id: "chief", access: { mode: "only", people: ["p1", "p2", "p3"] } };
const scout: access.AgentShape = { id: "scout" };
const atlas: access.AgentShape = { id: "atlas", access: { mode: "except", people: ["p8"] } };
const assistant: access.AgentShape = { id: "assistant", solo: { by: "owner" } };
const samsOwn: access.AgentShape = { id: "sams", solo: { by: "p4" } };
const hq: access.RoomShape = { id: "hq", agentIds: ["chief", "scout", "atlas"], audience: "some", peopleIds: ids };
const world = (over: Partial<access.World> = {}): access.World => ({ rooms: [hq], privateReadable: false, ...over });

test("Chief's own conversation is the owner's and the three chosen; the room is everyone's", () => {
  assert.ok(access.inTeamConversation(chief, owner));
  for (const id of ["p1", "p2", "p3"]) assert.ok(access.inTeamConversation(chief, member(id)), id);
  for (const id of ["p4", "p5", "p8"]) assert.ok(!access.inTeamConversation(chief, member(id)), id);
  // p5 is not in Chief's conversation but meets Chief in the room
  assert.ok(access.inRoom(hq, member("p5")));
  assert.ok(access.canReach(chief, member("p5"), world()));
  // so Chief is in p5's list (to talk one to one), its team lane is not
  assert.ok(access.listed(chief, member("p5"), world()));
  assert.equal(access.laneAccess(chief, { id: "t", team: true }, member("p5"), world()), null);
  assert.equal(access.laneAccess(chief, { id: "t", team: true }, member("p2"), world()), "write");
});

test("admins are in every team conversation unless the owner says otherwise", () => {
  assert.ok(access.inTeamConversation(chief, member("p6", "admin")));
  const strict: access.AgentShape = { id: "chief", access: { mode: "only", people: ["p1"], admins: false } };
  assert.ok(!access.inTeamConversation(strict, member("p6", "admin")));
  assert.ok(access.inTeamConversation(strict, owner), "the owner always is");
});

test("everyone except: the one left out has no team conversation, nor the agent at all without a room", () => {
  assert.ok(!access.inTeamConversation(atlas, member("p8")));
  assert.ok(access.inTeamConversation(atlas, member("p7")));
  const noRooms = world({ rooms: [] });
  assert.ok(!access.canReach(atlas, member("p8"), noRooms));
  assert.ok(!access.listed(atlas, member("p8"), noRooms));
  // a team agent with no list is everyone's
  assert.ok(access.inTeamConversation(scout, member("p8")));
});

test("a room of some: only those chosen are in it", () => {
  const small: access.RoomShape = { id: "r", agentIds: ["chief"], audience: "some", peopleIds: ["p1"] };
  assert.ok(access.inRoom(small, member("p1")));
  assert.ok(!access.inRoom(small, member("p2")));
  assert.ok(access.inRoom(small, owner));
  const open: access.RoomShape = { ...small, audience: "everyone" };
  assert.ok(access.inRoom(open, member("p2")));
});

test("the owner's solo assistant is nobody else's, an admin's included", () => {
  assert.ok(access.listed(assistant, owner, world()));
  for (const who of [member("p1"), member("p6", "admin")]) {
    assert.ok(!access.listed(assistant, who, world()));
    assert.ok(!access.canReach(assistant, who, world()));
    assert.equal(access.laneAccess(assistant, { id: "a" }, who, world({ privateReadable: true })), null);
  }
});

test("a member's solo agent is theirs alone, the owner included", () => {
  assert.ok(access.listed(samsOwn, member("p4"), world()));
  assert.ok(!access.listed(samsOwn, owner, world()));
  assert.equal(access.laneAccess(samsOwn, { id: "s" }, owner, world({ privateReadable: true })), null);
  assert.equal(access.laneAccess(samsOwn, { id: "s" }, member("p4"), world()), "write");
});

test("a private conversation is its member's; the owner and admins read it only when the workspace says so", () => {
  const lane = { id: "priv", personId: "p5" };
  assert.equal(access.laneAccess(chief, lane, member("p5"), world()), "write");
  assert.equal(access.laneAccess(chief, lane, member("p1"), world()), null);
  assert.equal(access.laneAccess(chief, lane, owner, world()), null);
  assert.equal(access.laneAccess(chief, lane, member("p6", "admin"), world()), null);
  assert.equal(access.laneAccess(chief, lane, owner, world({ privateReadable: true })), "read");
  assert.equal(access.laneAccess(chief, lane, member("p6", "admin"), world({ privateReadable: true })), "read");
  assert.equal(access.laneAccess(chief, lane, member("p1"), world({ privateReadable: true })), null);
  // and members are told which way it is
  assert.match(access.privacyLine(false, "Hamed"), /nobody else reads them, Hamed included/);
  assert.match(access.privacyLine(true, "Hamed"), /Hamed and the admins can read/);
});

test("the owner's own conversations are the owner's", () => {
  assert.equal(access.laneAccess(scout, { id: "general" }, owner, world()), "write");
  assert.equal(access.laneAccess(scout, { id: "general" }, member("p1", "admin"), world({ privateReadable: true })), null);
});

test("approvals: the asker, the owner and admins in the team and rooms; the person alone in private", () => {
  const team = { agent: scout, lane: { id: "t", team: true } };
  assert.ok(access.mayAnswer(team, { askedFor: "p2" }, member("p2"), world()));
  assert.ok(!access.mayAnswer(team, { askedFor: "p2" }, member("p3"), world()));
  assert.ok(access.mayAnswer(team, { askedFor: "p2" }, owner, world()));
  assert.ok(access.mayAnswer(team, { askedFor: "p2" }, member("p6", "admin"), world()));
  assert.ok(access.mayAnswer({ room: hq }, { askedFor: "p7" }, member("p7"), world()));
  assert.ok(!access.mayAnswer({ room: hq }, { askedFor: "p7" }, member("p1"), world()));
  const priv = { agent: scout, lane: { id: "p", personId: "p3" } };
  assert.ok(access.mayAnswer(priv, {}, member("p3"), world()));
  assert.ok(!access.mayAnswer(priv, {}, owner, world({ privateReadable: true })), "reading is not deciding");
  assert.ok(access.mayAnswer({ agent: samsOwn, lane: { id: "s" } }, {}, member("p4"), world()));
  assert.ok(!access.mayAnswer({ agent: samsOwn, lane: { id: "s" } }, {}, owner, world()));
});

test("a member's view of a card follows the same rules", () => {
  const view = (over: Partial<MemberView>): MemberView => ({ joinedAt: 0, history: "all", activityDetail: false, personId: "p2", role: "collaborator", ...over });
  const card = (askedFor?: string): Message =>
    ({ id: "m", at: 1, role: "bot", kind: "options", card: { title: "Approval needed", subtitle: "x", options: ["Allow", "Deny"], requestId: "r", tool: "Bash", ...(askedFor ? { askedFor } : {}) } }) as Message;
  assert.ok(mayApprove({ askedFor: "p2" }, view({ thread: "team" })));
  assert.ok(!mayApprove({ askedFor: "p9" }, view({ thread: "team" })));
  assert.ok(mayApprove({ askedFor: "p9" }, view({ thread: "team", admin: true })));
  assert.ok(mayApprove({}, view({ thread: "private" })));
  assert.ok(mayApprove({}, view({ thread: "solo" })));
  assert.deepEqual(memberMessage(card("p2"), view({ thread: "team" }))!.card!.options, ["Allow", "Deny"]);
  assert.equal(memberMessage(card("p9"), view({ thread: "team" }))!.card!.ownerOnly, true);
});

test("messages on someone's behalf: the owner or an admin, from the team or a room, to someone who can reach the agent", () => {
  const w = world();
  assert.ok(access.mayMessageOnBehalf(chief, { asker: owner, where: "team" }, member("p5"), w), "p5 reaches Chief in the room");
  assert.ok(access.mayMessageOnBehalf(chief, { asker: member("p6", "admin"), where: "room" }, member("p1"), w));
  assert.ok(!access.mayMessageOnBehalf(chief, { asker: member("p1"), where: "team" }, member("p2"), w), "members do not message members");
  assert.ok(!access.mayMessageOnBehalf(chief, { asker: owner, where: "private" }, member("p2"), w), "never out of a private conversation");
  assert.ok(!access.mayMessageOnBehalf(atlas, { asker: owner, where: "team" }, member("p8"), world({ rooms: [] })), "nor to someone who cannot reach it");
  assert.ok(!access.mayMessageOnBehalf(samsOwn, { asker: owner, where: "team" }, member("p4"), w), "nor through a solo agent");
});

test("settings: the owner any agent, an admin every agent but the owner's own, a member the agents they made", () => {
  const admin = member("p6", "admin");
  for (const agent of [chief, scout, atlas, assistant, samsOwn]) assert.ok(access.mayChangeSettings(agent, owner), agent.id);
  // an admin: the team agents and what members made, never the owner's own
  for (const agent of [chief, scout, atlas, samsOwn]) assert.ok(access.mayChangeSettings(agent, admin), agent.id);
  assert.ok(!access.mayChangeSettings(assistant, admin));
  // a member: their own solo agent, and nothing else, however they reach it
  assert.ok(access.mayChangeSettings(samsOwn, member("p4")));
  for (const agent of [chief, scout, atlas, assistant]) assert.ok(!access.mayChangeSettings(agent, member("p4")), agent.id);
  assert.ok(!access.mayChangeSettings(samsOwn, member("p5")), "nor another member's");
  // an admin's own solo agent is theirs as a maker too
  assert.ok(access.mayChangeSettings({ id: "minas", solo: { by: "p6" } }, admin));
});

test("settings: a member widens their own agent only so far; the owner and admins as far as they like", () => {
  const admin = member("p6", "admin");
  for (const level of access.APPROVAL_LEVELS) {
    assert.equal(access.settingHeld(owner, "approvals", level), null);
    assert.equal(access.settingHeld(admin, "approvals", level), null);
  }
  assert.equal(access.settingHeld(member("p4"), "approvals", "ask"), null);
  assert.equal(access.settingHeld(member("p4"), "approvals", "edits"), null);
  assert.equal(access.settingHeld(member("p4"), "approvals", "auto"), "approvals");
  assert.equal(access.settingHeld(member("p4"), "approvals", "full"), "approvals");
  // a computer: taken away or left automatic, never given
  assert.equal(access.settingHeld(member("p4"), "computer", "off"), null);
  assert.equal(access.settingHeld(member("p4"), "computer", null), null);
  for (const where of ["local", "sandbox", "cloud"]) {
    assert.equal(access.settingHeld(member("p4"), "computer", where), "computer", where);
    assert.equal(access.settingHeld(admin, "computer", where), null, where);
  }
  // the rest is theirs
  for (const field of ["name", "title", "description", "browser", "modelSelection", "effort"]) assert.equal(access.settingHeld(member("p4"), field, true), null, field);
});
