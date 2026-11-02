// The phone stays quiet while the person is at a computer (GitHub 443):
// the rule on its own, Live Activities held back and ended, then the real
// server with a stand-in relay and a paired synthetic phone.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { test, type TestContext } from "node:test";
import { LiveActivities, type ActivityPush, type ActivityTurn } from "../server/live-activities.ts";
import { Presence, PRESENCE_FRESH_MS, PRESENCE_IDLE_MS, presenceReport, quietWake } from "../server/presence.ts";
import { inUse } from "../src/lib/presence.ts";
import { startHarness, type Harness } from "./helpers/server.ts";
import { agentOn, fakeProvider, idle, waitFor } from "./helpers/turns.ts";

// ── the word ───────────────────────────────────────────────────────────

test("a window's word is read strictly", () => {
  assert.deepEqual(presenceReport({ window: "p-desktop", active: true, seq: 1 }), { window: "p-desktop", active: true, seq: 1 });
  assert.ok("error" in presenceReport({ window: "x", active: true, seq: 1 }), "a window id is six characters or more");
  assert.ok("error" in presenceReport({ window: "p-desktop", active: "yes", seq: 1 }));
  assert.ok("error" in presenceReport({ window: "p-desktop", active: true, seq: -1 }));
  assert.ok("error" in presenceReport({ window: "p-desktop", active: true }));
  assert.ok("error" in presenceReport(null));
});

test("in use is a shown, focused window on a computer, touched in the last two minutes", () => {
  const now = 1_000_000;
  const page = { visible: true, focused: true, finePointer: true, lastInput: now - 1000, now };
  assert.equal(inUse(page), true);
  assert.equal(inUse({ ...page, visible: false }), false, "a hidden window is not in use");
  assert.equal(inUse({ ...page, focused: false }), false, "a window in the background is not in use");
  assert.equal(inUse({ ...page, finePointer: false }), false, "a phone's browser is a phone, not a desk");
  assert.equal(inUse({ ...page, lastInput: now - PRESENCE_IDLE_MS }), false, "an idle computer is not in use");
  assert.equal(inUse({ ...page, lastInput: now - PRESENCE_IDLE_MS + 1 }), true);
});

test("presence holds while it is said, and goes when it stops being said", () => {
  let now = 1_000_000;
  const heard: boolean[] = [];
  const p = new Presence((present) => heard.push(present), () => now);
  assert.equal(p.present(), false, "nobody said anything");
  p.say("here:p-desk", true, 1);
  assert.equal(p.present(), true);
  assert.deepEqual(heard, [true]);
  // a second window saying the same changes nothing
  p.say("dev1:p-laptop", true, 1);
  assert.deepEqual(heard, [true]);
  // one window going idle leaves the other
  p.say("here:p-desk", false, 2);
  assert.equal(p.present(), true, "another window of the owner's is still in use");
  p.say("dev1:p-laptop", false, 2);
  assert.equal(p.present(), false);
  assert.deepEqual(heard, [true, false]);
  // a late word from before does not undo a newer one
  assert.equal(p.say("here:p-desk", true, 1), false);
  assert.equal(p.present(), false);
  // a computer that went to sleep without a word stops counting
  p.say("here:p-desk", true, 3);
  now += PRESENCE_FRESH_MS;
  assert.equal(p.present(), true);
  now += 1;
  p.check();
  assert.equal(p.present(), false, "a stale word kept the phone quiet");
  assert.deepEqual(heard, [true, false, true, false]);
  p.stop();
});

test("an unpaired device says nothing more", () => {
  const p = new Presence(() => {});
  p.say("dev1:p-laptop", true, 1);
  p.forget("dev1:");
  assert.equal(p.present(), false);
  p.stop();
});

test("only the owner's own phones are quieted, and a wake for nobody else is none", () => {
  const owner = "owner-digest";
  assert.equal(quietWake({ reason: "reply", clients: [owner], preview: true }, owner, true), undefined);
  assert.deepEqual(quietWake({ reason: "needs-you", clients: [owner, "member"], preview: true }, owner, true), { reason: "needs-you", clients: ["member"], preview: true });
  // somebody else's mention is theirs
  assert.deepEqual(quietWake({ reason: "mention", clients: ["member"] }, owner, true), { reason: "mention", clients: ["member"] });
  // away from the computer, nothing changes
  assert.deepEqual(quietWake({ reason: "reply", clients: [owner] }, owner, false), { reason: "reply", clients: [owner] });
  // a wake that names nobody cannot be told apart, and is left alone
  assert.equal(quietWake("join-request", owner, true), "join-request");
  assert.equal(quietWake(undefined, owner, true), undefined);
});

// ── Live Activities ────────────────────────────────────────────────────

const START = "ab".repeat(40);
const ACTIVITY = "cd".repeat(40);

function activities(quiet: () => boolean) {
  const sent: ActivityPush[] = [];
  const busy = new Set<string>(["lane-1"]);
  const turn = (laneId: string): ActivityTurn => ({ agentId: "bot-1", startedAt: 1, where: laneId, words: { name: "Mira", color: "blue", shape: "star", task: "General" } });
  const live = new LiveActivities({
    file: null,
    devices: () => [{ id: "phone" }],
    running: (laneId) => busy.has(laneId),
    laneOf: () => "lane-1",
    turn,
    seal: () => "sealed",
    send: async (push) => {
      sent.push(push);
      return "ok";
    },
    quiet,
    startDelayMs: 0,
    endDelayMs: 0,
  });
  return { live, sent, busy };
}

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

test("at a computer, no activity starts on the phone, and leaving while the turn runs gives it one", async () => {
  let present = true;
  const { live, sent, busy } = activities(() => present);
  assert.deepEqual(live.register("phone", { env: "production", start: START }), { ok: true });
  live.started("lane-1");
  await tick();
  assert.equal(sent.length, 0, "a turn started at the computer put an activity on the phone");
  present = false;
  live.away();
  await tick();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].event, "start", "the turn still running gets the phone's ordinary activity");
  // a turn that finished while the person was at the computer gets nothing
  present = true;
  live.started("lane-2");
  busy.add("lane-2");
  await tick();
  busy.delete("lane-2");
  live.settled("lane-2");
  present = false;
  live.away();
  await tick();
  assert.equal(sent.filter((p) => p.event === "start").length, 1, "an activity was made for a turn already over");
  live.stop();
});

test("sitting down at the computer ends the phone's activity in silence", async () => {
  let present = false;
  const { live, sent } = activities(() => present);
  live.register("phone", { env: "production", activities: [{ token: ACTIVITY, agentId: "bot-1", laneId: "lane-1" }] });
  present = true;
  live.present();
  await tick();
  assert.deepEqual(sent.map((p) => p.event), ["end"], "only an end, which alerts nobody");
  assert.equal(live.describe("phone").activities.length, 0);
  // and back on the phone's ordinary lifecycle once the person leaves
  live.register("phone", { env: "production", start: START });
  present = false;
  live.away();
  await tick();
  assert.deepEqual(sent.map((p) => p.event), ["end", "start"]);
  live.stop();
});

test("an activity whose token comes after the person sat down ends as it arrives", async () => {
  let present = false;
  const { live, sent } = activities(() => present);
  live.register("phone", { env: "production", start: START });
  live.started("lane-1");
  await tick();
  assert.equal(sent[0]?.event, "start");
  present = true;
  live.present();
  // the phone, woken by the start, says which token iOS gave it
  live.register("phone", { env: "production", activities: [{ token: ACTIVITY, agentId: "bot-1", laneId: "lane-1" }] });
  await tick();
  assert.deepEqual(sent.map((p) => p.event), ["start", "end"]);
  live.stop();
});

// ── the real server ────────────────────────────────────────────────────

interface Wake {
  reason: string;
  clients?: string[];
}

/** A loopback relay and one paired synthetic phone, every wake it is asked for. */
async function phoneRelay(t: TestContext, h: Harness) {
  await h.json("/api/pair", { method: "PUT", body: JSON.stringify({ enabled: true }) });
  const started = await h.json("/api/pair/start", { method: "POST" });
  const claimed = await h.json("/api/pair/claim", { method: "POST", body: JSON.stringify({ code: started.code, device: "Example phone" }) });
  const digest = createHash("sha256").update(claimed.token).digest("hex");
  const wakes: Wake[] = [];
  let connected = false;
  const server = createServer((req, res) => {
    if (req.url?.startsWith("/space/agent/stream")) {
      connected = true;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ kind: "hello", spaceId: "example-space" })}\n\n`);
      return;
    }
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const wake = JSON.parse(body || "{}").wake;
      if (wake && typeof wake === "object") wakes.push({ reason: wake.reason, clients: wake.clients });
      else if (typeof wake === "string") wakes.push({ reason: wake });
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  await h.json("/api/relay", {
    method: "PUT",
    body: JSON.stringify({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, agentToken: "example-agent-token", clientToken: claimed.token, enabled: true }),
  });
  assert.ok(await waitFor(() => (connected ? true : null)), "the isolated server did not connect to its relay");
  return { token: claimed.token as string, digest, answers: () => wakes.filter((w) => w.reason === "reply") };
}

const settle = (ms = 600) => new Promise((r) => setTimeout(r, ms));

test("an answer asked from the phone stays quiet while the person is at the computer, and wakes it once they leave", async (t) => {
  const p = await fakeProvider(t);
  p.state.answerAtOnce = true;
  const h = await startHarness();
  t.after(() => h.stop());
  const phone = await phoneRelay(t, h);
  const bot = await agentOn(h, p.port, "Mira");

  // the desktop is in use, with some other conversation open, or none
  assert.equal((await h.fetch("/api/presence", { method: "POST", body: JSON.stringify({ window: "p-desktop", active: true, seq: 1 }) })).status, 200);
  const sent = await h.fetchRemote(`/api/bots/${bot.id}/messages`, { method: "POST", token: phone.token, body: JSON.stringify({ text: "Read the example notes" }) });
  assert.equal(sent.status, 202);
  assert.ok(await idle(h, bot));
  await settle();
  assert.equal(phone.answers().length, 0, "the phone buzzed while the person was at the computer");

  // the window lost focus: the next answer reaches the phone, and only that one
  await h.fetch("/api/presence", { method: "POST", body: JSON.stringify({ window: "p-desktop", active: false, seq: 2 }) });
  assert.equal((await h.fetchRemote(`/api/bots/${bot.id}/messages`, { method: "POST", token: phone.token, body: JSON.stringify({ text: "Another example" }) })).status, 202);
  assert.ok(await idle(h, bot));
  assert.ok(await waitFor(() => phone.answers()[0]), "the phone stayed quiet after the person left the computer");
  await settle();
  assert.equal(phone.answers().length, 1, "what was held back while the person was there was replayed");
});

test("only the person's own screens say whether they are in use", async (t) => {
  const h = await startHarness();
  t.after(() => h.stop());
  assert.equal((await h.fetch("/api/presence", { method: "POST", body: JSON.stringify({ window: "x", active: true, seq: 1 }) })).status, 400);
  const health = await h.json("/api/health");
  assert.ok(health.features.includes("presence"), "a client cannot know to say it");
});
