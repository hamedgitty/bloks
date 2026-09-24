// Shared rooms, the second half: approvals a collaborator may answer, and
// what a room is allowed to spend.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mayApprove, memberMessage, type MemberView } from "../server/member-access.ts";
import { currentSpend, DEFAULT_SHARING, spendMonth, type RoomSharing } from "../server/bloks.ts";
import type { Message } from "../server/store.ts";

const view = (over: Partial<MemberView> = {}): MemberView => ({
  joinedAt: 0,
  history: "all",
  activityDetail: false,
  personId: "p_sam",
  role: "collaborator",
  approvals: true,
  ...over,
});

const approval = (askedFor?: string): Message =>
  ({
    id: "m1",
    at: 10,
    role: "bot",
    kind: "options",
    card: {
      title: "Approval needed",
      subtitle: "Send an email",
      options: ["Allow", "Deny"],
      requestId: "r1",
      tool: "mcp__composio__GMAIL_SEND",
      ...(askedFor ? { askedFor } : {}),
    },
  }) as Message;

test("a trusted collaborator may approve what someone else asked for", () => {
  assert.equal(mayApprove({ askedFor: "p_ana" }, view()), true);
  assert.equal(mayApprove({}, view()), true);
  const shown = memberMessage(approval("p_ana"), view())!;
  assert.deepEqual(shown.card!.options, ["Allow", "Deny"]);
  assert.equal(shown.card!.ownerOnly, undefined);
  // the tool's name is still the owner's business
  assert.equal(shown.card!.tool, undefined);
});

test("nobody approves their own request", () => {
  assert.equal(mayApprove({ askedFor: "p_sam" }, view()), false);
  const shown = memberMessage(approval("p_sam"), view())!;
  assert.deepEqual(shown.card!.options, []);
  assert.equal(shown.card!.ownerOnly, true);
});

test("approvals stay the owner's unless the room hands them over", () => {
  assert.equal(mayApprove({ askedFor: "p_ana" }, view({ approvals: false })), false);
  assert.equal(mayApprove({ askedFor: "p_ana" }, view({ role: "viewer" })), false);
  // a view from before any of this existed is the narrowest one
  const old: MemberView = { joinedAt: 0, history: "all", activityDetail: false };
  assert.equal(mayApprove({}, old), false);
  assert.equal(memberMessage(approval("p_ana"), old)!.card!.ownerOnly, true);
});

test("a room starts with a modest cap and a month starts from nothing", () => {
  const sharing = DEFAULT_SHARING();
  assert.equal(sharing.spendCap, 10);
  const now = new Date(2026, 8, 23);
  const spent: RoomSharing = {
    ...sharing,
    spend: { month: spendMonth(now), total: 7.5, byPerson: { owner: 2.5, p_sam: 5 } },
  };
  assert.equal(currentSpend(spent, now).total, 7.5);
  assert.equal(currentSpend(spent, new Date(2026, 9, 1)).total, 0);
  assert.equal(spendMonth(now), "2026-09");
});

test("an approval's details reach only whoever decides it", () => {
  const card = approval("p_sam");
  card.card!.subtitle = '{"to":"team@example.com"} (asked for by Sam)';
  // Sam asked, so Sam cannot decide, so Sam sees only what kind of thing
  const sam = memberMessage(card, view())!;
  assert.equal(sam.card!.subtitle, "Used a connected app (asked for by Sam)");
  // Ana decides, so Ana sees what she is saying yes to
  const ana = memberMessage(card, view({ personId: "p_ana" }))!;
  assert.match(ana.card!.subtitle, /team@example\.com/);
  // and the owner can show details to everyone
  assert.match(memberMessage(card, view({ activityDetail: true }))!.card!.subtitle, /team@example\.com/);
});
