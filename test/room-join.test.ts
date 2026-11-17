// Joining one shared room from the desktop app, from its invite's link.
//
// "Open in Bloks" on a room's invite page hands the app bloks://join#
// with the invite itself after the # (server/index.ts inviteLink): a long
// base64url pass, not a workspace's 8-character code. The app's link
// reader turned anything longer than a code away, so the app came forward
// and nothing else happened. Here the link is read, and this computer's
// joining client asks the room's computer to be let in the way the
// browser and the phone do, sealed with the invite's own key.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { joinLink } from "../electron/links.mjs";
import { joinsFrom, parseRegistry } from "../electron/workspaces.mjs";
import { inviteKey, open, peek, seal } from "../server/relay-crypto.ts";

const home = mkdtempSync(join(tmpdir(), "bloks-room-join-"));
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

let people: typeof import("../server/people.ts");
let JoinClient: typeof import("../server/join-client.ts").JoinClient;
let relay: Server;
let relayUrl = "";
/** Every request the room's computer was asked, as it opened them. */
const asked: Array<{ method: string; path: string; body?: Record<string, unknown> }> = [];

/** The invite link exactly as the room's computer writes it. */
function roomLink(input: { inviteId: string; secret: string; relayToken: string }, scheme = "https://bloks.dev/join") {
  const payload = { v: 1, r: relayUrl, t: input.relayToken, i: input.inviteId, s: input.secret, room: "Launch planning", host: "Hamed Rahimi" };
  return `${scheme}#${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
}

before(async () => {
  process.env.HOME = home;
  process.env.BLOKS_DATA_DIR = join(home, ".bloks");
  mkdirSync(join(home, ".bloks"), { recursive: true });
  people = await import("../server/people.ts");
  ({ JoinClient } = await import("../server/join-client.ts"));
  // Bloks Cloud and the room's computer in one: the relay hands the
  // sealed ask over, and the computer answers it as serveInviteRequest
  // does, from the same invite records.
  relay = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const reply = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (req.method !== "POST" || req.url !== "/space/client/ask") return reply(404, { error: "no such route" });
      const envelope = peek(String(JSON.parse(Buffer.concat(chunks).toString("utf8")).payload ?? ""));
      const inv = envelope ? people.invite(envelope.d) : null;
      if (!envelope || !inv || req.headers.authorization !== `Bearer relay-pass-for-${inv.id}`) return reply(401, { error: "unknown client" });
      const request = open(inviteKey(inv.secretHash, "phone-to-mac"), envelope) as { method: string; path: string; body?: Record<string, unknown> } | null;
      if (!request) return reply(200, { status: 400, payload: "" });
      asked.push(request);
      const answer = (status: number, body: unknown) => reply(200, { status, payload: seal(inviteKey(inv.secretHash, "mac-to-phone"), inv.id, { status, body }) });
      const about = { room: { id: inv.roomId, name: "Launch planning" }, host: "Hamed Rahimi" };
      if (request.method === "POST" && request.path === "/api/member/claim") {
        const claimed = people.claimInvite(inv.id, { name: request.body?.name, token: request.body?.token });
        if (!claimed.ok) return answer(409, { error: claimed.reason, ...about });
        return answer(200, { status: claimed.invite.status, phrase: people.checkPhrase(inv.secretHash, claimed.invite.claim!.tokenHash), ...about });
      }
      if (request.method === "GET" && request.path === "/api/member/claim") {
        const now = people.invite(inv.id)!;
        const current = now.status === "approved" || now.expiresAt > Date.now();
        return answer(200, {
          status: current ? now.status : "expired",
          ...(now.claim ? { phrase: people.checkPhrase(now.secretHash, now.claim.tokenHash) } : {}),
          ...(now.status === "approved" ? { personId: now.personId, deviceId: now.deviceId } : {}),
          ...about,
        });
      }
      answer(404, { error: "no such route" });
    });
  });
  await new Promise<void>((r) => relay.listen(0, "127.0.0.1", () => r()));
  relayUrl = `http://127.0.0.1:${(relay.address() as { port: number }).port}`;
});

after(() => {
  relay.closeAllConnections();
  relay.close();
  rmSync(home, { recursive: true, force: true });
});

function mint() {
  const made = people.createInvite({ roomId: "room_1", role: "collaborator", invitedBy: "owner" });
  return { inviteId: made.invite.id, secret: made.secret, relayToken: `relay-pass-for-${made.invite.id}` };
}

test("a room's invite link, as Open in Bloks hands it over, is passed on to the app", () => {
  const invite = mint();
  const link = roomLink(invite, "bloks://join");
  const fragment = link.slice(link.indexOf("#") + 1);
  assert.ok(link.length > 200, "a room's pass is far longer than a workspace's code");
  assert.deepEqual(joinLink(link), { kind: "join", fragment });
  // Windows writes the link with a slash before the #
  assert.deepEqual(joinLink(link.replace("bloks://join#", "bloks://join/#")), { kind: "join", fragment });
  // a workspace's code still reads as it did
  assert.deepEqual(joinLink("bloks://join#K7QF-M2XR"), { kind: "join", fragment: "K7QF-M2XR" });
  // and nothing that is neither
  assert.equal(joinLink("bloks://join#<script>"), null);
  assert.equal(joinLink(`bloks://join#${"A".repeat(5000)}`), null);
  // a pass that names no invite is not one
  assert.equal(joinLink(`bloks://join#${Buffer.from(JSON.stringify({ v: 1, i: "nope", s: "s", t: "t", room: "x".repeat(120) })).toString("base64url")}`), null);
});

test("joining a room from its link: found, asked with a name, the same four words, let in, and the pass kept", async () => {
  const invite = mint();
  const client = new JoinClient(() => "https://relay.unused.test");
  for (const link of [roomLink(invite), roomLink(invite, "bloks://join")]) {
    const found = await client.lookup(link);
    assert.equal(found.ok, true, JSON.stringify(found));
    if (!found.ok) return;
    assert.equal(found.invite.workspace, "Launch planning");
    assert.equal(found.invite.inviter, "Hamed Rahimi");
    assert.equal(found.invite.password, false, "a room asks for no password");
    assert.equal(found.invite.room, true);
  }
  const found = await client.lookup(roomLink(invite));
  if (!found.ok) return assert.fail("not found");

  const claimed = await client.claim(found.session, { name: "Theo" });
  assert.equal(claimed.ok, true, JSON.stringify(claimed));
  if (!claimed.ok) return;
  assert.equal(claimed.status, "waiting");
  const seen = people.invite(invite.inviteId)!;
  assert.equal(seen.claim?.name, "Theo");
  // the words are worked out on this side, from the invite and this
  // device, and are the ones the room's owner sees
  assert.equal(claimed.phrase, people.checkPhrase(seen.secretHash, seen.claim!.tokenHash));

  const waiting = await client.status(found.session);
  assert.equal(waiting.ok && waiting.status, "waiting");

  people.approveInvite(invite.inviteId);
  people.noteInviteDevice(invite.inviteId, "dev_room_1");
  const approved = await client.status(found.session);
  assert.equal(approved.ok && approved.status, "approved", JSON.stringify(approved));
  if (!approved.ok || approved.status !== "approved") return;
  const credentials = approved.credentials as Record<string, unknown>;
  assert.equal(credentials.relayUrl, relayUrl);
  assert.equal(credentials.relayToken, invite.relayToken);
  assert.equal(credentials.deviceId, "dev_room_1");
  assert.equal(sha(String(credentials.deviceToken)), seen.claim!.tokenHash, "the device token kept is the one the owner let in");
  const welcome = approved.welcome as { workspace: { name: string }; inviter: string; room?: boolean };
  assert.equal(welcome.workspace.name, "Launch planning");
  assert.equal(welcome.inviter, "Hamed Rahimi");
  assert.equal(welcome.room, true);
  // only the two invite routes were ever asked, and the claim was fresh
  assert.deepEqual([...new Set(asked.map((a) => `${a.method} ${a.path}`))].sort(), ["GET /api/member/claim", "POST /api/member/claim"]);
});

test("a room's invite that has ended, or was taken by someone else, says so", async () => {
  const client = new JoinClient(() => "https://relay.unused.test");
  const used = mint();
  people.claimInvite(used.inviteId, { name: "Someone else", token: "x".repeat(43) });
  const taken = await client.lookup(roomLink(used));
  assert.equal(!taken.ok && taken.code, "used");
  // and one taken between looking it up and asking
  const raced = mint();
  const found = await client.lookup(roomLink(raced));
  if (!found.ok) return assert.fail(JSON.stringify(found));
  people.claimInvite(raced.inviteId, { name: "Someone quicker", token: "y".repeat(43) });
  const late = await client.claim(found.session, { name: "Theo" });
  assert.equal(!late.ok && late.code, "used");

  const cancelled = mint();
  people.closeInvite(cancelled.inviteId, "cancelled");
  const gone = await client.lookup(roomLink(cancelled));
  assert.equal(!gone.ok && gone.code, "cancelled");

  // a pass Bloks Cloud no longer takes is an invite that has ended
  const revoked = mint();
  const link = roomLink({ ...revoked, relayToken: "a-pass-nobody-knows" });
  const refused = await client.lookup(link);
  assert.equal(!refused.ok && refused.code, "expired");
});

// Joining runs on a server of this computer's own. A link that came in
// while a joined room or workspace was on screen went to a page that
// cannot join, and was dropped there.
test("an invite opened while a joined workspace is on screen is joined from one of this computer's own", () => {
  const base = parseRegistry(null);
  const registry = {
    ...base,
    workspaces: [
      { ...base.workspaces[0], id: "ws_biz", kind: "business" as const, name: "Work" },
      { ...base.workspaces[0], id: "personal", kind: "personal" as const, name: "Personal" },
      { ...base.workspaces[0], id: "ws_room", kind: "joined" as const, name: "Launch planning" },
      { ...base.workspaces[0], id: "ws_server", kind: "remote" as const, name: "Home lab" },
    ],
  };
  assert.equal(joinsFrom(registry, "ws_room"), "personal");
  assert.equal(joinsFrom(registry, "ws_server"), "personal");
  // already on one of its own: joined right there
  assert.equal(joinsFrom(registry, "ws_biz"), null);
  assert.equal(joinsFrom(registry, "personal"), null);
  // nothing runs here: there is nowhere else to join from
  assert.equal(joinsFrom({ ...registry, prefs: { ...registry.prefs, local: false } }, "ws_room"), null);
  assert.equal(joinsFrom(null, "ws_room"), null);
});
