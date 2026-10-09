// Finishing what is running before a planned restart (server/drain.ts;
// GitHub 161).
//
// The rules: nothing new starts and nothing is turned away; what was
// running finishes, or at the deadline is left for the restart to pick
// up; what arrived meanwhile waits on disk and goes in its own lane when
// Bloks is back; and a card nobody answered is still unanswered after.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Drain, DRAIN_DEFAULT_MS, DRAIN_GRACE_MS, DRAIN_MAX_MS, drainWindow } from "../server/drain.ts";
import { drainWait } from "../electron/drain-wait.mjs";
import { RoomTagQueues } from "../server/room-tags.ts";
import { startHarness } from "./helpers/server.ts";
import { agentOn, fakeProvider, idle, inFlight, messagesOf, PICKUP, waitFor } from "./helpers/turns.ts";

test("a drain waits twenty minutes unless asked, and never more than an hour", () => {
  assert.equal(drainWindow(undefined), DRAIN_DEFAULT_MS);
  assert.equal(DRAIN_DEFAULT_MS, 20 * 60_000);
  assert.equal(drainWindow(90), 90_000);
  assert.equal(drainWindow("90"), 90_000);
  assert.equal(drainWindow(0), DRAIN_DEFAULT_MS, "nothing asked is the default, not no wait at all");
  assert.equal(drainWindow(-5), DRAIN_DEFAULT_MS);
  assert.equal(drainWindow("soon"), DRAIN_DEFAULT_MS);
  // a routine held back still has to be inside its two-hour grace after
  assert.equal(drainWindow(24 * 60 * 60), DRAIN_MAX_MS);
  assert.ok(DRAIN_MAX_MS < 2 * 60 * 60_000);
});

test("a drain is done when nothing runs, or when its time is up", () => {
  const d = new Drain();
  const turn = { laneId: "l", botId: "b", startedAt: 0 };
  assert.deepEqual(d.status([], false, 0), { draining: false, running: [], idle: true, done: false }, "not draining is never done");
  d.start(60_000, 1_000);
  assert.equal(d.status([turn], false, 2_000).done, false);
  assert.equal(d.status([], true, 2_000).done, false, "a lane busy with something off the list is not idle");
  assert.equal(d.status([], false, 2_000).done, true);
  assert.equal(d.status([turn], false, 61_000).done, true, "out of time");
  assert.equal(d.status([turn], false, 61_000).idle, false);
  // asked again, the deadline moves and the start stays
  d.start(60_000, 30_000);
  assert.deepEqual([d.status([], false, 30_000).since, d.status([], false, 30_000).deadline], [1_000, 90_000]);
  assert.equal(d.stop(), true);
  assert.equal(d.on, false);
  assert.equal(d.stop(), false);
});

test("a drain whose restart never comes ends itself a while after its deadline, and a later start moves that too", () => {
  assert.equal(DRAIN_GRACE_MS, 10 * 60_000);
  // a routine held back by the longest drain still fires inside its grace
  assert.ok(DRAIN_MAX_MS + DRAIN_GRACE_MS < 2 * 60 * 60_000);
  const d = new Drain(5_000);
  assert.equal(d.lapsesAt(), null, "nothing to end");
  d.start(60_000, 1_000);
  assert.equal(d.lapsesAt(), 66_000);
  d.start(60_000, 30_000);
  assert.equal(d.lapsesAt(), 95_000);
  d.stop();
  assert.equal(d.lapsesAt(), null);
  const plain = new Drain();
  plain.start(1_000, 0);
  assert.equal(plain.lapsesAt(), 1_000 + DRAIN_GRACE_MS);
});

/** A harness for the updater's wait: answers from a script of statuses,
 * the last one repeated, and writes down what it was asked. */
function scripted(...statuses: Array<{ running: number; done: boolean }>) {
  const asked: string[] = [];
  const ask = async (method: "POST" | "GET" | "DELETE") => {
    asked.push(method);
    if (method === "DELETE") return { draining: false, running: [], done: false };
    const next = statuses.length > 1 ? statuses.shift()! : statuses[0];
    return { draining: true, deadline: 1_000, running: Array(next.running).fill({}), done: next.done };
  };
  return { asked, ask };
}

test("the updater goes straight on when nothing is running, and says nothing about waiting", async () => {
  const { asked, ask } = scripted({ running: 0, done: true });
  const seen: number[] = [];
  const wait = drainWait(ask, { every: 1, onProgress: (s) => seen.push(s.running.length) });
  assert.equal(await wait.finished, "done");
  assert.deepEqual(asked, ["POST"]);
  assert.deepEqual(seen, [], "no progress, so the card goes straight to relaunching");
});

test("while the updater waits it passes on what is running, until the drain is done", async () => {
  const { asked, ask } = scripted({ running: 2, done: false }, { running: 1, done: false }, { running: 0, done: true });
  const seen: number[] = [];
  const wait = drainWait(ask, { every: 1, onProgress: (s) => seen.push(s.running.length) });
  assert.equal(await wait.finished, "done");
  assert.deepEqual(asked, ["POST", "GET", "GET"]);
  assert.deepEqual(seen, [2, 1]);
});

test("restart now stops the wait without calling the drain off, and cancel calls it off", async () => {
  const now = scripted({ running: 1, done: false });
  const waitNow = drainWait(now.ask, { every: 60_000 });
  setTimeout(() => waitNow.stop("now"), 10);
  assert.equal(await waitNow.finished, "now", "and without sitting out the poll");
  assert.deepEqual(now.asked, ["POST"], "the restart ends the drain, and what runs is picked up after");

  const later = scripted({ running: 1, done: false });
  const waitLater = drainWait(later.ask, { every: 60_000, onProgress: () => waitLater.stop("cancel") });
  assert.equal(await waitLater.finished, "cancel");
  assert.deepEqual(later.asked, ["POST", "DELETE"], "called off, so what waited goes at once");
});

test("a harness that does not answer has nothing to wait for", async () => {
  const wait = drainWait(async () => null, { every: 1 });
  assert.equal(await wait.finished, "done");
});

test("room lines waiting for an agent are kept on disk, and stale ones are not read back", () => {
  const dir = mkdtempSync(join(tmpdir(), "bloks-room-lines-"));
  const file = join(dir, "room-lines.json");
  try {
    const now = 100 * 60 * 60_000;
    const q = new RoomTagQueues(file, now);
    q.add("bot_a", "room_1", "@A first", "p_sam", 1, now);
    q.add("bot_a", "room_1", "@A second", "p_sam", 0, now + 1);
    q.add("bot_b", "room_2", "@B hello", undefined, 0, now);
    const again = new RoomTagQueues(file, now + 60_000);
    assert.deepEqual(again.agents(), ["bot_a", "bot_b"]);
    // who asked survives, so the turn still runs under their approvals
    assert.deepEqual(again.of("bot_a"), [{ roomId: "room_1", requester: "p_sam", texts: ["@A first", "@A second"], hops: 1 }]);
    again.take("bot_b", again.of("bot_b")[0]);
    assert.deepEqual(new RoomTagQueues(file, now).agents(), ["bot_a"], "a line taken is gone from the disk too");
    // a restart half a day later: written for a moment that has passed
    assert.deepEqual(new RoomTagQueues(file, now + 13 * 60 * 60_000).agents(), []);
    writeFileSync(file, JSON.stringify([{ botId: "x", roomId: "r", requester: "owner", texts: [42], at: now }, "junk"]));
    assert.deepEqual(new RoomTagQueues(file, now).agents(), [], "nothing worth delivering");
    writeFileSync(file, "{");
    assert.deepEqual(new RoomTagQueues(file, now).agents(), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const drainState = async (h: { json(path: string, init?: RequestInit): Promise<any> }) => h.json("/api/maintenance/drain");

test("during a drain the running turn finishes, and what arrives waits until it is called off", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "bloks-drain-"));
  const fake = await fakeProvider(t);
  const h = await startHarness({ HOME: home });
  t.after(() => h.stop());
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }));
  const ivy = await agentOn(h, fake.port, "Ivy");
  const jo = await agentOn(h, fake.port, "Jo");

  await h.fetch(`/api/bots/${ivy.id}/messages`, { method: "POST", body: JSON.stringify({ text: "FINISH-THIS" }) });
  await waitFor(() => fake.sent("FINISH-THIS") >= 1);
  // only from this computer: a paired phone cannot stop the workspace
  assert.equal((await h.fetchRemote("/api/maintenance/drain", { method: "POST" })).status, 403);
  const started = await h.json("/api/maintenance/drain", { method: "POST", body: JSON.stringify({ seconds: 600 }) });
  assert.equal(started.draining, true);
  assert.equal(started.done, false);
  assert.deepEqual(started.running.map((r: any) => r.laneId), [ivy.threadId]);
  assert.ok(Math.abs(started.deadline - Date.now() - 600_000) < 5_000);

  // Jo is idle, and still nothing starts: the words wait in Jo's lane
  const said = await h.json(`/api/bots/${jo.id}/messages`, { method: "POST", body: JSON.stringify({ text: "HELD-WORDS" }) });
  assert.equal(said.queued, true);
  assert.match(said.note, /finishing what is running/);
  await new Promise((r) => setTimeout(r, 800));
  assert.equal(fake.sent("HELD-WORDS"), 0, "a turn started during a drain");
  assert.equal((await messagesOf(h, jo)).find((m) => m.text === "HELD-WORDS").queued, true);

  // the turn that was running finishes as it would have
  fake.state.held.shift()!();
  await idle(h, ivy);
  assert.ok((await messagesOf(h, ivy)).some((m) => m.role === "bot" && m.text === "Done."));
  const settled = await drainState(h);
  assert.equal(settled.idle, true);
  assert.equal(settled.done, true);
  assert.deepEqual(settled.running, []);
  await new Promise((r) => setTimeout(r, 800));
  assert.equal(fake.sent("HELD-WORDS"), 0, "the end of a turn let the queue go during a drain");

  // called off, what waited goes, in its own lane
  fake.state.answerAtOnce = true;
  const ended = await h.json("/api/maintenance/drain", { method: "DELETE" });
  assert.equal(ended.draining, false);
  assert.ok(await waitFor(() => fake.sent("HELD-WORDS") >= 1), "what waited never went");
  await idle(h, jo);
  const held = (await messagesOf(h, jo)).find((m) => m.text === "HELD-WORDS");
  assert.equal(held.queued, false);
  assert.equal(fake.sent("HELD-WORDS"), 1);
});

test("at the deadline what is still running is left for the restart, and what waited goes in its own lane", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "bloks-drain-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const fake = await fakeProvider(t);
  fake.state.askOn = "DECIDE-SHIP";

  const first = await startHarness({ HOME: home });
  t.after(() => first.crash());
  const ivy = await agentOn(first, fake.port, "Ivy");
  const jo = await agentOn(first, fake.port, "Jo");
  const { blok } = await first.json("/api/bloks", { method: "POST", body: JSON.stringify({ name: "Ops", memberIds: [ivy.id, jo.id] }) });

  // Ivy's turn is waiting on a question nobody answers
  await first.fetch(`/api/bots/${ivy.id}/messages`, { method: "POST", body: JSON.stringify({ text: "DECIDE-SHIP" }) });
  const card = await waitFor(async () => (await messagesOf(first, ivy)).find((m) => m.kind === "options" && m.card?.requestId)?.card);
  assert.ok(card, "no question card appeared");
  const callsBefore = fake.state.calls.length;

  await first.json("/api/maintenance/drain", { method: "POST", body: JSON.stringify({ seconds: 1 }) });
  await first.json(`/api/bots/${ivy.id}/messages`, { method: "POST", body: JSON.stringify({ text: "IVY-AFTER" }) });
  await first.json(`/api/bots/${jo.id}/messages`, { method: "POST", body: JSON.stringify({ text: "JO-AFTER" }) });
  await first.json(`/api/bloks/${blok.id}/messages`, { method: "POST", body: JSON.stringify({ text: "@Jo ROOM-AFTER" }) });

  const out = await waitFor(async () => {
    const state = await drainState(first);
    return state.done ? state : null;
  });
  assert.ok(out, "the deadline never came");
  assert.equal(out.idle, false, "the question's turn is still running");
  assert.deepEqual(out.running.map((r: any) => r.laneId), [ivy.threadId]);
  // A drain answers nothing and gives nothing: the card is as it was,
  // no engine heard a word, and the turn is still on the list, not
  // marked stopped, so the restart picks it up.
  const open = (await messagesOf(first, ivy)).find((m) => m.kind === "options" && m.card?.requestId === card.requestId);
  assert.ok(!open.card.answered, "the drain answered the card");
  assert.equal(fake.state.calls.length, callsBefore, "something started during the drain");
  const left = inFlight(home);
  assert.equal(left.length, 1);
  assert.equal(left[0].laneId, ivy.threadId);
  assert.equal(left[0].stopped, undefined);
  assert.equal(JSON.parse(readFileSync(join(home, ".bloks", "room-lines.json"), "utf8")).length, 1, "the room line is not on disk");
  await first.crash();

  fake.state.answerAtOnce = true;
  const second = await startHarness({ HOME: home });
  t.after(() => second.stop());
  assert.equal((await drainState(second)).draining, false, "a restart ends a drain");
  // Ivy picks up where she was, with what was said to her meanwhile in
  // the same turn
  assert.ok(await waitFor(() => fake.sent(PICKUP) >= 1), "the cut-off turn was never picked up");
  const pickup = fake.state.calls.find((c) => c.includes(PICKUP))!;
  assert.ok(pickup.includes("IVY-AFTER"), "what waited did not join the pickup");
  // Jo's words and the room line each go where they were said
  assert.ok(await waitFor(() => fake.sent("JO-AFTER") >= 1), "Jo's words never went");
  assert.ok(await waitFor(() => fake.sent("ROOM-AFTER") >= 1), "the room line never went");
  assert.equal(fake.state.calls.find((c) => c.includes("JO-AFTER"))!.includes(PICKUP), false);
  await idle(second, ivy);
  await idle(second, jo);
  await new Promise((r) => setTimeout(r, 1_000));
  assert.equal(fake.sent(PICKUP), 1);
  assert.equal(fake.sent("JO-AFTER"), 1);
  assert.equal(fake.sent("ROOM-AFTER"), 1);
  const { bloks } = await second.json("/api/bloks");
  const room = bloks.find((b: any) => b.id === blok.id);
  assert.ok(room.messages.some((m: any) => m.from === jo.id && m.text === "Done."), "Jo's answer is not in the room");
  assert.ok((await messagesOf(second, jo)).some((m) => m.role === "bot" && m.text === "Done."), "Jo's answer is not in Jo's lane");
});

test("a drain whose restart never comes ends itself after its grace, and what it held goes", async (t) => {
  const fake = await fakeProvider(t);
  fake.state.answerAtOnce = true;
  // the grace is ten minutes; here it is two seconds
  const h = await startHarness({ BLOKS_DRAIN_GRACE_MS: "2000" });
  t.after(() => h.stop());
  const jo = await agentOn(h, fake.port, "Jo");

  await h.json("/api/maintenance/drain", { method: "POST", body: JSON.stringify({ seconds: 1 }) });
  const said = await h.json(`/api/bots/${jo.id}/messages`, { method: "POST", body: JSON.stringify({ text: "HELD-WORDS" }) });
  assert.equal(said.queued, true);
  // asked again, the deadline moves, and the end moves with it
  await new Promise((r) => setTimeout(r, 1_500));
  await h.json("/api/maintenance/drain", { method: "POST", body: JSON.stringify({ seconds: 1 }) });
  await new Promise((r) => setTimeout(r, 2_000));
  assert.equal((await drainState(h)).draining, true, "it ended on the deadline it was first given");
  assert.equal(fake.sent("HELD-WORDS"), 0);

  // No restart came and nobody called it off: it used to hold the lane,
  // and every room, routine and job, until Bloks was restarted by hand.
  assert.ok(await waitFor(async () => !(await drainState(h)).draining), "the drain never ended");
  assert.ok(await waitFor(() => fake.sent("HELD-WORDS") >= 1), "what it held never went");
  await idle(h, jo);
  assert.equal((await messagesOf(h, jo)).find((m) => m.text === "HELD-WORDS").queued, false);
});
