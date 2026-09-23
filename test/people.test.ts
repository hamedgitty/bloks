// Invites, the check phrase, and who is in a room.
//
// people.ts keeps its file under the data folder, so this points HOME at
// a scratch folder before loading it.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "bloks-people-"));
let people: typeof import("../server/people.ts");
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

before(async () => {
  process.env.HOME = home;
  const { mkdirSync } = await import("node:fs");
  mkdirSync(join(home, ".bloks"), { recursive: true });
  people = await import("../server/people.ts");
});
after(() => rmSync(home, { recursive: true, force: true }));

test("an invite keeps only the digest of its secret", () => {
  const { invite, secret } = people.createInvite({ roomId: "r1", role: "collaborator", invitedBy: "owner" });
  assert.equal(invite.secretHash, sha(secret));
  assert.ok(!JSON.stringify(people.invite(invite.id)).includes(secret));
  // and the file is the owner's alone
  assert.equal(statSync(join(home, ".bloks", "people.json")).mode & 0o777, 0o600);
});

test("the first device to claim an invite holds it; a second is refused", () => {
  const { invite } = people.createInvite({ roomId: "r1", role: "collaborator", invitedBy: "owner" });
  const first = people.claimInvite(invite.id, { name: "Sam", token: "a".repeat(43) });
  assert.equal(first.ok, true);
  // the same device retrying is fine
  assert.equal(people.claimInvite(invite.id, { name: "Sam", token: "a".repeat(43) }).ok, true);
  const second = people.claimInvite(invite.id, { name: "Mallory", token: "b".repeat(43) });
  assert.equal(second.ok, false);
});

test("both ends compute the same check phrase, and another device gets different words", () => {
  const secret = "s".repeat(43);
  const token = "t".repeat(43);
  const phrase = people.checkPhrase(sha(secret), sha(token));
  assert.equal(phrase.split(" ").length, 4);
  assert.equal(phrase, people.checkPhrase(sha(secret), sha(token)));
  assert.notEqual(phrase, people.checkPhrase(sha(secret), sha("u".repeat(43))));
  for (const word of phrase.split(" ")) assert.ok(people.CHECK_WORDS.includes(word));
});

test("approval makes a person and a membership; leaving the last room forgets them", () => {
  const { invite } = people.createInvite({ roomId: "r9", role: "viewer", invitedBy: "owner" });
  people.claimInvite(invite.id, { name: "  Ada‮  Lovelace\u0007 ", token: "c".repeat(43) });
  const approved = people.approveInvite(invite.id)!;
  assert.equal(approved.person.name, "Ada Lovelace");
  assert.equal(people.roleIn(approved.person.id, "r9"), "viewer");
  assert.equal(people.approveInvite(invite.id), null, "an invite is used once");

  const { roomless } = people.removeFromRoom(approved.person.id, "r9");
  assert.equal(roomless, true);
  assert.equal(people.person(approved.person.id), null);
  assert.equal(people.roleIn(approved.person.id, "r9"), null);
});

test("a cancelled or expired invite cannot be claimed", () => {
  const { invite } = people.createInvite({ roomId: "r1", role: "collaborator", invitedBy: "owner" });
  people.closeInvite(invite.id, "cancelled");
  assert.equal(people.claimInvite(invite.id, { name: "Sam", token: "d".repeat(43) }).ok, false);

  const late = people.createInvite({ roomId: "r1", role: "collaborator", invitedBy: "owner" });
  people.invite(late.invite.id)!.expiresAt = Date.now() - 1;
  assert.equal(people.claimInvite(late.invite.id, { name: "Sam", token: "e".repeat(43) }).ok, false);
});

test("names cannot be empty or carry control characters", () => {
  assert.equal(people.cleanName("   "), null);
  assert.equal(people.cleanName(42), null);
  assert.equal(people.cleanName("Bob‮evil"), "Bobevil");
  assert.equal(people.cleanName("x".repeat(100))!.length, 40);
});
