// What a member of a shared room can reach and see.
//
// This file is the guard on the whole feature: a member's device is
// default deny, so the tests below walk the owner's surface and check that
// every piece of it is refused, then walk the member's surface and check
// the role rules, then check what each kind of broadcast frame turns into.
import { test } from "node:test";
import assert from "node:assert/strict";
import { memberCan, memberFrame, memberMessage, toolKind, type MemberView } from "../server/member-access.ts";
import type { Message } from "../server/store.ts";

const ROOM = "room_1";
const OTHER = "room_2";
const collaborator = (roomId: string) => (roomId === ROOM ? "collaborator" : null);
const viewer = (roomId: string) => (roomId === ROOM ? "viewer" : null);
const noInvites = () => false;
const invites = () => true;

test("every owner route is closed to members", () => {
  const owner: Array<[string, string]> = [
    ["GET", "/api/bots"],
    ["POST", "/api/bots"],
    ["GET", "/api/bots/b1"],
    ["POST", "/api/bots/b1/messages"],
    ["POST", "/api/bots/b1/respond"],
    ["GET", "/api/config"],
    ["PATCH", "/api/config"],
    ["GET", "/api/bloks"],
    ["POST", `/api/bloks/${ROOM}/messages`],
    ["GET", `/api/bloks/${ROOM}/people`],
    ["POST", `/api/bloks/${ROOM}/invites`],
    ["POST", `/api/bloks/${ROOM}/share`],
    ["DELETE", `/api/bloks/${ROOM}/people/p1`],
    ["POST", "/api/invites/inv_x/approve"],
    ["GET", "/api/relay/join"],
    ["POST", "/api/relay/activate"],
    ["GET", "/api/pair"],
    ["POST", "/api/pair/claim"],
    ["GET", "/api/artifacts/b1/report.pdf"],
    ["GET", "/api/instances"],
    ["POST", "/api/member/claim"],
    // near misses on the member routes themselves
    ["GET", `/api/member/rooms/${ROOM}/messages`],
    ["DELETE", `/api/member/rooms/${ROOM}`],
    ["GET", `/api/member/rooms/${ROOM}/../../bots`],
    ["POST", "/api/member/me"],
    ["GET", "/api/member/me/"],
  ];
  for (const [method, path] of owner) {
    const verdict = memberCan(method, path, collaborator, invites);
    assert.equal(verdict.ok, false, `${method} ${path} should be refused`);
  }
});

test("a member reaches only rooms they are in, and cannot tell other rooms exist", () => {
  const mine = memberCan("GET", `/api/member/rooms/${ROOM}`, collaborator, noInvites);
  assert.equal(mine.ok, true);
  const theirs = memberCan("GET", `/api/member/rooms/${OTHER}`, collaborator, noInvites);
  assert.equal(theirs.ok, false);
  assert.equal(!theirs.ok && theirs.status, 404);
  const nowhere = memberCan("GET", "/api/member/rooms/made_up", collaborator, noInvites);
  assert.equal(!nowhere.ok && nowhere.status, 404);
});

test("viewers read and leave, and do nothing else", () => {
  assert.equal(memberCan("GET", `/api/member/rooms/${ROOM}`, viewer, invites).ok, true);
  assert.equal(memberCan("POST", `/api/member/rooms/${ROOM}/leave`, viewer, invites).ok, true);
  for (const path of ["messages", "cards/m1", "invites", "typing"]) {
    assert.equal(memberCan("POST", `/api/member/rooms/${ROOM}/${path}`, viewer, invites).ok, false, path);
  }
});

test("collaborators write, and invite only where the room allows it", () => {
  assert.equal(memberCan("POST", `/api/member/rooms/${ROOM}/messages`, collaborator, noInvites).ok, true);
  assert.equal(memberCan("POST", `/api/member/rooms/${ROOM}/cards/m1`, collaborator, noInvites).ok, true);
  assert.equal(memberCan("POST", `/api/member/rooms/${ROOM}/invites`, collaborator, noInvites).ok, false);
  assert.equal(memberCan("POST", `/api/member/rooms/${ROOM}/invites`, collaborator, invites).ok, true);
});

const view = (over: Partial<MemberView> = {}): MemberView => ({
  joinedAt: 1_000,
  history: "join",
  activityDetail: false,
  ...over,
});
const msg = (over: Partial<Message>): Message => ({ id: "m", at: 2_000, role: "bot", kind: "text", text: "hi", ...over }) as Message;

test("history before joining is hidden unless the room shows everything", () => {
  const old = msg({ at: 500 });
  assert.equal(memberMessage(old, view()), null);
  assert.ok(memberMessage(old, view({ history: "all" })));
  assert.ok(memberMessage(msg({ at: 1_000 }), view()));
});

test("tool activity shows its kind, never its arguments", () => {
  const shell = msg({ kind: "activity", tool: { name: '/bin/zsh -lc "cat ~/.ssh/id_rsa"', ok: true } });
  const shown = memberMessage(shell, view())!;
  assert.equal(shown.tool!.name, "Ran a command");
  assert.ok(!JSON.stringify(shown).includes("ssh"));
  assert.equal(memberMessage(shell, view({ activityDetail: true }))!.tool!.name, shell.tool!.name);
  assert.equal(toolKind("mcp__composio__GMAIL_SEND"), "Used a connected app");
});

test("approvals reach members without their buttons; questions keep theirs", () => {
  const approval = msg({
    kind: "options",
    card: { title: "Approval needed", subtitle: "Send email", options: ["Allow", "Deny"], requestId: "r1", tool: "gmail_send" },
  });
  const shown = memberMessage(approval, view())!;
  assert.deepEqual(shown.card!.options, []);
  assert.equal(shown.card!.ownerOnly, true);
  assert.equal(shown.card!.tool, undefined);

  const question = msg({
    kind: "options",
    card: { title: "Your agent has a question", subtitle: "Which colour?", options: ["Red", "Blue"], requestId: "r2" },
  });
  assert.deepEqual(memberMessage(question, view())!.card!.options, ["Red", "Blue"]);
});

test("the owner's screen, sign-ins and secrets never reach a member", () => {
  assert.equal(memberMessage(msg({ kind: "screen", png: "AAAA" }), view()), null);
  assert.equal(memberMessage(msg({ kind: "connector" }), view()), null);
  const secret = memberMessage(
    msg({ kind: "secret", secret: { envName: "STRIPE_KEY", label: "Stripe key", status: "needs-value" } }),
    view(),
  )!;
  assert.ok(!JSON.stringify(secret).includes("STRIPE_KEY"));
});

test("frames reach a member only for their own rooms", () => {
  const viewOf = (roomId: string) => (roomId === ROOM ? view() : null);
  assert.ok(memberFrame({ kind: "message", threadId: ROOM, message: msg({}) }, viewOf));
  assert.equal(memberFrame({ kind: "message", threadId: OTHER, message: msg({}) }, viewOf), null);
  // a solo chat's lane id is just another thread they are not in
  assert.equal(memberFrame({ kind: "message", threadId: "lane_1", message: msg({}) }, viewOf), null);
  assert.ok(memberFrame({ kind: "room.typing", roomId: ROOM, name: "Sam" }, viewOf));
  assert.equal(memberFrame({ kind: "room.typing", roomId: OTHER, name: "Sam" }, viewOf), null);
  for (const kind of ["bot", "runtime", "config", "relay", "screen", "blok", "instances", "room.joinRequest", "computer"]) {
    assert.equal(memberFrame({ kind, roomId: ROOM, threadId: ROOM }, viewOf), null, kind);
  }
});
