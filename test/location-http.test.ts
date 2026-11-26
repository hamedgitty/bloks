// Location against the real server: a paired iPhone says where it is, the
// owner's own turn hears it, an agent reads it and asks for a fresh one,
// and a place watcher acts once on arriving. Nobody else gets to say it,
// read it or forget it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startHarness, type Harness } from "./helpers/server.ts";

const OWNER_TOKEN = "fixture-owner-phone-token-0123456789";
const MEMBER_TOKEN = "fixture-member-phone-token-0123456789";
const digest = (token: string) => createHash("sha256").update(token).digest("hex");
const MIN = 60_000;

/** A Claude Code stand-in. It writes down every message it is given, one
 * per line, and for one that says CALLS <base64>, makes those requests with
 * its turn's own credential and writes down what came back. */
function standIn(home: string) {
  const heard = join(home, "heard.jsonl");
  const out = join(home, "answers.json");
  const cli = join(home, "fake-claude.mjs");
  writeFileSync(
    cli,
    `#!${process.execPath}
import { appendFileSync, renameSync, writeFileSync } from "node:fs";
const [first] = process.argv.slice(2);
if (first === "--version") { console.log("2.1.299 (Claude Code)"); process.exit(0); }
if (first === "auth") { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
let input = "";
((go) => { let line = ""; const take = (c) => { line += c; while (line.includes(String.fromCharCode(10))) { const at = line.indexOf(String.fromCharCode(10)); const next = line.slice(0, at); line = line.slice(at + 1); if (!next.trim() || JSON.parse(next).type !== "user") continue; input = next; process.stdin.off("data", take); go(); return; } }; process.stdin.on("data", take); })(async () => {
  appendFileSync(${JSON.stringify(heard)}, JSON.stringify(input) + String.fromCharCode(10));
  const asked = input.match(/CALLS ([A-Za-z0-9+\\/=]+)/);
  if (asked) {
    const calls = JSON.parse(Buffer.from(asked[1], "base64").toString("utf8"));
    const answers = [];
    for (const [method, path, body] of calls) {
      const res = await fetch(process.env.BLOKS_URL + path, {
        method,
        headers: { authorization: "Bearer " + process.env.BLOKS_TOKEN, "content-type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      answers.push({ status: res.status, body: await res.json().catch(() => null) });
    }
    writeFileSync(${JSON.stringify(out)} + ".tmp", JSON.stringify(answers)); renameSync(${JSON.stringify(out)} + ".tmp", ${JSON.stringify(out)});
  }
  console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Done." }));
});
`,
    { mode: 0o755 },
  );
  return { cli, heard, out };
}

/** Everything the stand-in was told, oldest first. */
function heardSoFar(file: string): string[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string);
}

async function waitFor<T>(check: () => Promise<T | null | undefined> | T | null | undefined, ms = 15_000): Promise<T | null> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const value = await check();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}

/** An owner event stream on this computer, keeping every frame. */
async function ownerStream(h: Harness) {
  const stop = new AbortController();
  const res = await fetch(`${h.url}/api/events`, { signal: stop.signal });
  assert.equal(res.status, 200);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const frames: any[] = [];
  let text = "";
  void (async () => {
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) return;
        text += decoder.decode(next.value);
        const parts = text.split("\n\n");
        text = parts.pop()!;
        for (const part of parts) if (part.startsWith("data: ")) frames.push(JSON.parse(part.slice(6)));
      }
    } catch {
      /* stopped */
    }
  })();
  return { frames, stop: () => stop.abort() };
}

async function setUp(t: { after: (fn: () => Promise<void>) => void }) {
  const home = mkdtempSync(join(tmpdir(), "bloks-location-"));
  const fake = standIn(home);
  mkdirSync(join(home, ".bloks"), { recursive: true });
  writeFileSync(
    join(home, ".bloks", "config.json"),
    JSON.stringify({
      profile: { name: "Sam" },
      brief: { enabled: false },
      backups: { auto: false },
      instances: { claude: { driver: "claudeAgent", config: { cli: fake.cli } } },
      remote: {
        enabled: true,
        devices: [{ id: "sams-iphone", name: "Sam's iPhone", hash: digest(OWNER_TOKEN), pairedAt: 1 }],
        memberDevices: [{ id: "ayas-iphone", name: "Aya's iPhone", hash: digest(MEMBER_TOKEN), pairedAt: 1, personId: "p_aya" }],
      },
    }),
  );
  writeFileSync(
    join(home, ".bloks", "people.json"),
    JSON.stringify({ version: 3, people: [{ id: "p_aya", name: "Aya", createdAt: 1, role: "member", joinedAt: 1, invitedBy: "owner" }], memberships: [], invites: [], knocks: [] }),
  );
  const h = await startHarness({ HOME: home, BLOKS_LOCATION_WAIT_MS: "1500" });
  t.after(async () => {
    await h.stop();
    rmSync(home, { recursive: true, force: true });
  });
  const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Concierge" }) });
  await h.fetch(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } }) });
  /** The phone saying something, over the network, as itself. */
  const phone = (body: unknown, token = OWNER_TOKEN) => h.fetchRemote("/api/location", { method: "POST", token, body: JSON.stringify(body) });
  const idle = () =>
    waitFor(async () => {
      const { bots } = await h.json("/api/bots?messages=0");
      return bots.find((b: any) => b.id === bot.id && !b.busy);
    });
  /** One turn, with its CALLS, and what they answered. */
  const turn = async (text: string, calls?: unknown[]) => {
    rmSync(fake.out, { force: true });
    const before = heardSoFar(fake.heard).length;
    const said = calls ? `${text} CALLS ${Buffer.from(JSON.stringify(calls)).toString("base64")}` : text;
    await h.fetch(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: said }) });
    const heard = await waitFor(() => heardSoFar(fake.heard)[before]);
    assert.ok(heard, "the turn never ran");
    const answers = calls ? await waitFor(() => (existsSync(fake.out) ? (JSON.parse(readFileSync(fake.out, "utf8")) as Array<{ status: number; body: any }>) : null)) : null;
    await idle();
    return { heard: heard!, answers: answers ?? [] };
  };
  return { h, bot, phone, turn, idle, heard: () => heardSoFar(fake.heard) };
}

const at = (ago: number, place: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  sharing: "on",
  background: true,
  location: { observedAt: Date.now() - ago, place, trigger: "moved", ...extra },
});
const TORONTO = { locality: "Toronto", region: "Ontario", country: "Canada", timeZone: "America/Toronto" };
const MONTREAL = { locality: "Montreal", region: "Quebec", country: "Canada", timeZone: "America/Toronto" };

test("only the owner's paired phone says where they are, and only the owner reads it here", { timeout: 120_000 }, async (t) => {
  const { h, phone } = await setUp(t);
  assert.deepEqual((await h.json("/api/location")).location, null);

  const said = await phone(at(5 * MIN, TORONTO));
  assert.equal(said.status, 200, JSON.stringify(said.body));
  assert.equal(said.body.sharing, "on");
  const kept = await h.json("/api/location");
  assert.equal(kept.sharing, "on");
  assert.equal(kept.location.place, "Toronto, Canada");
  assert.equal(kept.location.device, "Sam's iPhone");
  assert.equal(kept.location.precision, "city");
  assert.equal(kept.location.latitude, undefined);

  // this computer's own window has no phone to speak for
  const local = await h.fetch("/api/location", { method: "POST", body: JSON.stringify(at(1, MONTREAL)) });
  assert.equal(local.status, 403);
  // nobody on the network who is not paired, and no member's phone
  assert.equal((await phone(at(1, MONTREAL), "")).status, 401);
  assert.equal((await phone(at(1, MONTREAL), "not-a-token")).status, 401);
  const member = await phone(at(1, MONTREAL), MEMBER_TOKEN);
  assert.ok(member.status >= 400, `a member's phone was taken at its word: ${member.status}`);
  const memberRead = await h.fetchRemote("/api/location", { token: MEMBER_TOKEN });
  assert.ok(memberRead.status >= 400 && !JSON.stringify(memberRead.body).includes("Toronto"), "a member read where the owner is");
  assert.equal((await h.json("/api/location")).location.locality, "Toronto", "something other than the owner's phone moved them");
  // the owner's phone may read it back
  assert.equal((await h.fetchRemote("/api/location", { token: OWNER_TOKEN })).body.location.locality, "Toronto");

  // a reading that does not read right is refused whole
  assert.equal((await phone({ sharing: "on", location: { observedAt: Date.now() + 60 * MIN, place: TORONTO } })).status, 400);

  // Forget clears what is kept here, and the phone's choice stays
  const forgot = await h.json("/api/location", { method: "DELETE" });
  assert.equal(forgot.location, null);
  assert.equal(forgot.sharing, "on");

  // pairing taken away takes the place with it
  await phone(at(1 * MIN, TORONTO));
  assert.equal((await h.fetch("/api/pair/devices/sams-iphone", { method: "DELETE" })).status, 200);
  const gone = await h.json("/api/location");
  assert.equal(gone.location, null);
  assert.equal(gone.sharing, "off");
});

test("the owner's own turn hears where they are, an agent reads it, and asks for a fresh one", { timeout: 120_000 }, async (t) => {
  const { h, phone, turn } = await setUp(t);

  // nothing shared: nothing said, and an agent is told so
  const quiet = await turn("Where am I?", [["GET", "/api/agent/location"]]);
  assert.doesNotMatch(quiet.heard, /is in /);
  assert.equal(quiet.answers[0].body.sharing, "off");
  assert.equal(quiet.answers[0].body.location, null);

  await phone(at(10 * MIN, TORONTO));
  const told = await turn("Order me some dinner", [
    ["GET", "/api/agent/location"],
    ["POST", "/api/location", at(1, MONTREAL)],
    ["GET", "/api/location"],
    ["DELETE", "/api/location"],
  ]);
  assert.match(told.heard, /\(Sam is in Toronto, Canada, approximately, as of 10 minutes ago, from their phone\./);
  const [read, report, ownerRead, forget] = told.answers;
  assert.equal(read.status, 200);
  assert.equal(read.body.location.place, "Toronto, Canada");
  assert.equal(read.body.location.freshness, "current");
  assert.equal(read.body.location.timeZone, "America/Toronto");
  assert.match(read.body.note, /not for directions or a pickup point/);
  // an agent never says where the person is, reads the owner's copy, or forgets it
  for (const refused of [report, ownerRead, forget]) assert.equal(refused.status, 403, JSON.stringify(refused.body));
  assert.equal((await h.json("/api/location")).location.locality, "Toronto");

  // A fresh reading: the ask reaches the owner's own stream, the phone
  // answers it with a reading taken after the ask, and the agent gets that.
  const stream = await ownerStream(h);
  t.after(stream.stop);
  const asking = turn("Get me a ride home", [["GET", "/api/agent/location?fresh=1"]]);
  const ask = await waitFor(() => stream.frames.find((f) => f.kind === "location-request"));
  assert.ok(ask, "the phone was never asked");
  assert.match(ask.request, /^[A-Za-z0-9_-]{16,64}$/);
  const exact = {
    ...at(0, { area: "Queen West", ...TORONTO }, { coordinate: { latitude: 43.64471, longitude: -79.40926, accuracy: 12 }, trigger: "asked" }),
    request: ask.request,
  };
  const answered = await phone(exact);
  assert.equal(answered.body.answered, true);
  const fresh = (await asking).answers[0].body;
  assert.equal(fresh.refresh.answered, true);
  assert.equal(fresh.location.precision, "exact");
  assert.equal(fresh.location.area, "Queen West");
  assert.equal(fresh.location.accuracyMeters, 12);

  // Nobody answers: the agent is told no reading came, and the last one
  // is said with its age, never relabelled as new.
  const unanswered = await turn("And again", [["GET", "/api/agent/location?fresh=1"]]);
  const none = unanswered.answers[0].body;
  assert.equal(none.refresh.answered, false);
  assert.match(none.refresh.note, /No new reading came/);
  assert.equal(none.location.area, "Queen West");

  // paused: no line, and nothing of where for an agent
  await phone({ sharing: "paused", background: true });
  const paused = await turn("What is the weather?", [["GET", "/api/agent/location"]]);
  assert.doesNotMatch(paused.heard, /is in Queen West/);
  assert.equal(paused.answers[0].body.location, null);
  assert.match(paused.answers[0].body.note, /paused/);
  // and asking for a fresh one asks nothing of a paused phone
  const before = stream.frames.filter((f) => f.kind === "location-request").length;
  await turn("Fresh?", [["GET", "/api/agent/location?fresh=1"]]);
  assert.equal(stream.frames.filter((f) => f.kind === "location-request").length, before);
});

test("a place watcher acts once on arriving, not on a wobble, again on the next visit, and a once watcher is done", { timeout: 180_000 }, async (t) => {
  const { h, bot, phone, idle, heard } = await setUp(t);
  const arrivals = () => heard().filter((said) => said.includes("has arrived in Toronto"));
  const watcher = async (id: string) => (await h.json("/api/watchers")).watchers.find((w: any) => w.id === id);

  // Montreal, twenty-five minutes ago, is the first side the watcher sees
  await phone(at(25 * MIN, MONTREAL));
  const filed = await h.json("/api/watchers", {
    method: "POST",
    body: JSON.stringify({ kind: "place", target: "Toronto", botId: bot.id, instruction: "Send me the hotel address." }),
  });
  assert.equal(filed.watcher.kind, "place");
  assert.equal(filed.watcher.when, "arrive");
  assert.match(filed.note, /moving a fair way/);
  // nothing fires for where they already were
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(arrivals().length, 0);

  await phone(at(20 * MIN, TORONTO));
  assert.ok(await waitFor(() => arrivals().length === 1), "arriving never reached the agent");
  assert.match(arrivals()[0], /Sam has arrived in Toronto\. Their phone placed them in Toronto, Canada 20 minutes ago/);
  assert.match(arrivals()[0], /Send me the hotel address\./);
  await idle();

  // the fix wobbles out and back within a minute: not a second arrival
  await phone(at(19 * MIN, MONTREAL));
  await phone(at(18 * MIN, TORONTO));
  await new Promise((r) => setTimeout(r, 800));
  await idle();
  assert.equal(arrivals().length, 1, "a wobble on the line was taken as a second arrival");
  assert.equal((await watcher(filed.watcher.id)).fires.length, 1);

  // away for a quarter of an hour and back: the next visit counts
  await phone(at(15 * MIN, MONTREAL));
  await phone(at(1 * MIN, TORONTO));
  assert.ok(await waitFor(() => arrivals().length === 2), "the next visit was not acted on");
  await idle();

  // A once watcher, for leaving: done after it acts, and switched off.
  const once = await h.json("/api/watchers", {
    method: "POST",
    body: JSON.stringify({ kind: "place", target: "Toronto", when: "leave", once: true, botId: bot.id, instruction: "Remind me to check out." }),
  });
  await phone(at(0, MONTREAL));
  assert.ok(await waitFor(() => heard().some((said) => said.includes("has left Toronto"))), "leaving never reached the agent");
  assert.match(heard().find((said) => said.includes("has left Toronto"))!, /act once, so it is done after this turn/);
  const done = await waitFor(async () => {
    const w = await watcher(once.watcher.id);
    return w.done ? w : null;
  });
  assert.equal(done?.enabled, false);
  assert.equal(done?.done.why, "once");
  await idle();

  // Sharing off: watchers start over, so the next reading is a first
  // side again and not a move from wherever the last one was.
  await phone({ sharing: "off" });
  await phone(at(0, TORONTO));
  await new Promise((r) => setTimeout(r, 800));
  await idle();
  assert.equal(arrivals().length, 2, "a reading after sharing came back was taken as an arrival");

  // a place given by coordinates says so while the readings carry none
  const point = await h.json("/api/watchers", {
    method: "POST",
    body: JSON.stringify({ kind: "place", target: "43.6777,-79.6248", radius: 2000, botId: bot.id, instruction: "Send my boarding pass." }),
  });
  assert.equal(point.watcher.radius, 2000);
  assert.match(point.note, /approximately/);
  await phone(at(0, MONTREAL));
  const told = await waitFor(async () => (await watcher(point.watcher.id)).lastError);
  assert.match(String(told), /Exact position/);
});
