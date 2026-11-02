// Workspace invites: the code, the link, the password, and every way a
// request to join is turned away (server/invites.ts).
//
// invites.ts keeps its file under the data folder, so this points HOME at
// a scratch folder before loading it.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "bloks-invites-"));
let inv: typeof import("../server/invites.ts");
let people: typeof import("../server/people.ts");
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const token = (c: string) => sha(c.repeat(43));

before(async () => {
  process.env.HOME = home;
  mkdirSync(join(home, ".bloks"), { recursive: true });
  inv = await import("../server/invites.ts");
  people = await import("../server/people.ts");
});
after(() => rmSync(home, { recursive: true, force: true }));
beforeEach(() => {
  rmSync(join(home, ".bloks", "joining.json"), { force: true });
  inv.resetJoiningCache();
});

const ctx = (over: Partial<{ hostKey: string; isMember: (t: string) => boolean; full: () => boolean }> = {}) => ({
  hostKey: "k".repeat(43),
  isMember: () => false,
  full: () => false,
  ...over,
});

function made(role: "member" | "admin" = "member", name?: string) {
  const out = inv.createInvite({ role, name, invitedBy: "owner" });
  assert.ok(!("error" in out));
  return out as import("../server/invites.ts").WorkspaceInvite;
}

test("a code is eight characters from the readable alphabet, and reads out as two fours", () => {
  for (let i = 0; i < 200; i++) {
    const code = inv.newCode();
    assert.match(code, /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$/);
  }
  assert.equal(inv.CODE_ALPHABET.length, 31);
  for (const banned of "01OIL") assert.ok(!inv.CODE_ALPHABET.includes(banned));
  assert.equal(inv.formatCode("K7QFM2XR"), "K7QF-M2XR");
  assert.match(inv.newPublicId(), /^[a-z0-9]{6}$/);
});

test("a code is accepted in any case, with any spaces or dashes, and nothing else", () => {
  for (const typed of ["K7QF-M2XR", "k7qf m2xr", " k7QF\u2013M2xr ", "K7.QF_M2-XR", "k7qfm2xr"]) {
    assert.equal(inv.normalizeCode(typed), "K7QFM2XR", typed);
  }
  for (const wrong of ["K7QF-M2X", "K7QF-M2XRR", "K0QF-M2XR", "K7QF-M1XR", "", 42, null]) {
    assert.equal(inv.normalizeCode(wrong), null, String(wrong));
  }
  assert.equal(inv.codeHash("K7QFM2XR"), sha("K7QFM2XR"));
});

test("a link, a bloks:// link, a bare code and a link with a network address all parse", () => {
  assert.deepEqual(inv.parseInviteInput("https://bloks.dev/j/w8f2ka#K7QFM2XR"), { code: "K7QFM2XR", publicId: "w8f2ka" });
  assert.deepEqual(inv.parseInviteInput("bloks.dev/j/w8f2ka#k7qf-m2xr"), { code: "K7QFM2XR", publicId: "w8f2ka" });
  assert.deepEqual(inv.parseInviteInput("bloks://join#K7QF-M2XR"), { code: "K7QFM2XR" });
  assert.deepEqual(inv.parseInviteInput("K7QF M2XR"), { code: "K7QFM2XR" });
  assert.deepEqual(inv.parseInviteInput("https://bloks.dev/j/w8f2ka#K7QFM2XR~192.168.1.20:8800"), {
    code: "K7QFM2XR",
    publicId: "w8f2ka",
    lan: "192.168.1.20:8800",
  });
  // a room invite's fragment is base64 JSON, never mistaken for a code
  assert.equal(inv.parseInviteInput("https://bloks.dev/join#eyJ2IjoxLCJyIjoiaHR0cHM6Ly9yZWxheSJ9"), null);
  assert.equal(inv.parseInviteInput("hello"), null);
  assert.equal(inv.inviteLink("w8f2ka", "K7QFM2XR"), "https://bloks.dev/j/w8f2ka#K7QFM2XR");
});

test("an invite keeps the code's digest, lasts a day, and its file is the owner's alone", () => {
  const before = Date.now();
  const i = made("admin", "  Sam\u0007 ");
  assert.equal(i.codeHash, sha(i.code));
  assert.equal(i.name, "Sam");
  assert.equal(i.role, "admin");
  assert.ok(i.expiresAt - before >= inv.INVITE_TTL_MS - 1000 && i.expiresAt - before <= inv.INVITE_TTL_MS + 1000);
  assert.equal(statSync(join(home, ".bloks", "joining.json")).mode & 0o777, 0o600);
  assert.equal(inv.inviteByCode(i.code)?.id, i.id);
  assert.equal(inv.inviteByPublicId(i.publicId)?.id, i.id);
});

test("twenty invites may wait at once; the twenty first is refused until one is cancelled", () => {
  const list = Array.from({ length: inv.MAX_OUTSTANDING }, () => made());
  const refused = inv.createInvite({ role: "member", invitedBy: "owner" });
  assert.ok("error" in refused && refused.code === "too_many");
  assert.ok(inv.cancelInvite(list[0].id));
  assert.ok(!("error" in inv.createInvite({ role: "member", invitedBy: "owner" })));
});

test("the join password is hashed with scrypt and its own salt, and never kept as typed", () => {
  assert.equal(inv.setPassword("abc").ok, false, "too short");
  assert.equal(inv.setPassword("harborlight").ok, true);
  const first = JSON.parse(readFileSync(join(home, ".bloks", "joining.json"), "utf8")).password;
  assert.ok(!JSON.stringify(first).includes("harborlight"));
  assert.equal(inv.checkPassword("harborlight"), true);
  assert.equal(inv.checkPassword("harborlite"), false);
  // the same password again is stored another way
  inv.setPassword("harborlight");
  const second = JSON.parse(readFileSync(join(home, ".bloks", "joining.json"), "utf8")).password;
  assert.notEqual(first.salt, second.salt);
  assert.notEqual(first.hash, second.hash);
  assert.ok(inv.joiningSettings().password?.setAt);
  assert.equal(inv.clearPassword(), true);
  assert.equal(inv.joiningSettings().password, null);
  assert.equal(inv.checkPassword("harborlight"), false);
});

test("a right claim waits for the owner, with the same four words on both sides", () => {
  const i = made();
  const t = token("a");
  const out = inv.claim(i, { name: "Sam", tokenHash: t, device: "iphone" }, ctx());
  assert.ok(out.ok);
  assert.equal(out.invite.status, "waiting");
  const phrase = inv.phraseOf(out.invite)!;
  assert.equal(phrase.split(" ").length, 4);
  assert.equal(phrase, people.joinPhrase(sha(i.code), t, "k".repeat(43)));
  // a swapped join key shows different words on the joiner's screen
  assert.notEqual(phrase, people.joinPhrase(sha(i.code), t, "x".repeat(43)));
  // the same device asking again is a retry; another device is too late
  assert.ok(inv.claim(i, { name: "Sam", tokenHash: t }, ctx()).ok);
  const late = inv.claim(i, { name: "Mallory", tokenHash: token("b") }, ctx());
  assert.ok(!late.ok && late.error === "used");
});

test("the host keeps the kind a desktop joiner said: Mac, PC or computer", () => {
  // a new joiner's words, and the word every older desktop still sends
  for (const device of ["pc", "computer", "mac"]) {
    const out = inv.claim(made(), { name: "Sam", tokenHash: token(device[0]), device }, ctx());
    assert.ok(out.ok);
    assert.equal(out.invite.claim?.device, device);
  }
});

test("every way a claim is refused has its own code", () => {
  const t = token("c");
  assert.equal((inv.claim(null, { name: "Sam", tokenHash: t }, ctx()) as { error: string }).error, "wrong_code");
  assert.equal((inv.claim(made(), { name: "Sam", tokenHash: "nope" }, ctx()) as { error: string }).error, "invalid");
  assert.equal((inv.claim(made(), { name: "  ", tokenHash: t }, ctx()) as { error: string }).error, "invalid");

  const cancelled = made();
  inv.cancelInvite(cancelled.id);
  assert.equal((inv.claim(cancelled, { name: "Sam", tokenHash: t }, ctx()) as { error: string }).error, "cancelled");

  const old = made();
  old.expiresAt = Date.now() - 1;
  assert.equal((inv.claim(old, { name: "Sam", tokenHash: t }, ctx()) as { error: string }).error, "expired");
  assert.equal(inv.shownStatus(old), "expired");

  const member = made();
  assert.equal((inv.claim(member, { name: "Sam", tokenHash: t }, ctx({ isMember: () => true })) as { error: string }).error, "already_member");
  assert.equal(member.status, "open", "an invite tried by someone already in stays unused");

  const full = made();
  assert.equal((inv.claim(full, { name: "Sam", tokenHash: t }, ctx({ full: () => true })) as { error: string }).error, "full");

  const declined = made();
  inv.claim(declined, { name: "Sam", tokenHash: t }, ctx());
  inv.decline(declined.id);
  assert.equal((inv.claim(declined, { name: "Sam", tokenHash: t }, ctx()) as { error: string }).error, "declined");
  assert.equal((inv.claim(declined, { name: "Eve", tokenHash: token("e") }, ctx()) as { error: string }).error, "used");

  const used = made();
  inv.claim(used, { name: "Sam", tokenHash: t }, ctx());
  inv.markApproved(used.id, { personId: "p_x", deviceId: "d1" });
  assert.ok(inv.claim(used, { name: "Sam", tokenHash: t }, ctx()).ok, "the joiner's own retry hears that they are in");
  assert.equal((inv.claim(used, { name: "Eve", tokenHash: token("f") }, ctx()) as { error: string }).error, "used");
});

test("a missing password costs nothing; five wrong ones close the invite", () => {
  inv.setPassword("harborlight");
  const i = made();
  const t = token("g");
  const none = inv.claim(i, { name: "Sam", tokenHash: t }, ctx());
  assert.ok(!none.ok && none.error === "password_required");
  assert.equal(i.wrongPasswords, 0);
  for (let left = 4; left >= 1; left--) {
    const wrong = inv.claim(i, { name: "Sam", tokenHash: t, password: "harborlite" }, ctx());
    assert.ok(!wrong.ok && wrong.error === "wrong_password");
    assert.equal(wrong.triesLeft, left);
  }
  const fifth = inv.claim(i, { name: "Sam", tokenHash: t, password: "nope" }, ctx());
  assert.ok(!fifth.ok && fifth.error === "closed" && fifth.locked);
  assert.equal(i.status, "locked");
  // closed for good, the right password included
  const after = inv.claim(i, { name: "Sam", tokenHash: t, password: "harborlight" }, ctx());
  assert.ok(!after.ok && after.error === "closed");
  // and a fresh invite with the right password goes through
  const fresh = inv.claim(made(), { name: "Sam", tokenHash: t, password: "harborlight" }, ctx());
  assert.ok(fresh.ok && fresh.invite.claim?.password === "correct");
});

test("a joiner can take a request back, and the invite is open again", () => {
  const i = made();
  const t = token("h");
  inv.claim(i, { name: "Sam", tokenHash: t }, ctx());
  assert.equal(inv.withdraw(i, token("z")), false, "only the device that asked");
  assert.equal(inv.withdraw(i, t), true);
  assert.equal(i.status, "open");
  assert.equal(i.claim, undefined);
});

test("expired invites are swept once, for their relay tokens to go", () => {
  const i = made();
  i.expiresAt = Date.now() - 1;
  assert.deepEqual(inv.sweepExpired().map((x) => x.id), [i.id]);
  assert.deepEqual(inv.sweepExpired(), []);
});

test("a join key agrees the same secret from both ends, and only those two", () => {
  const host = inv.hostKey();
  const joiner = inv.newJoinKeyPair();
  const a = inv.agree(host.privateKey, joiner.publicRaw)!;
  const b = inv.agree(joiner.privateKey, host.publicRaw)!;
  assert.deepEqual(a, b);
  const other = inv.newJoinKeyPair();
  assert.notDeepEqual(inv.agree(other.privateKey, host.publicRaw), a);
  assert.equal(inv.agree(host.privateKey, "short"), null);
  // the same key across a restart
  inv.resetJoiningCache();
  assert.equal(inv.hostKey().publicRaw, host.publicRaw);
  assert.notDeepEqual(inv.joinKey(a, "joiner-to-host"), inv.joinKey(a, "host-to-joiner"));
});

test("guesses on the same network are held to ten in ten minutes from one address", () => {
  const limiter = new inv.JoinLimiter(10, 60_000);
  for (let i = 0; i < 10; i++) assert.ok(limiter.allow("10.0.0.2", 1_000));
  assert.equal(limiter.allow("10.0.0.2", 1_000), false);
  assert.ok(limiter.allow("10.0.0.3", 1_000), "another address has its own count");
  assert.ok(limiter.allow("10.0.0.2", 62_000), "and the window moves on");
});
