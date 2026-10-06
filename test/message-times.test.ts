// When each message in a chat was said, and when a queued one went to
// the agent (GitHub 149).
//
// The words are the reader's locale's, so these pin one locale and fixed
// dates rather than whatever machine runs them. What they hold shut: a
// bare clock time on a message from another day, a line that says
// "Today" about last week, "yesterday" counted as 24 hours, and a queued
// message that forgets, here or after a restart, when it stopped waiting.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dayLine, queuedLine, stamp, timeSaidBelow } from "../src/lib/when.ts";
import { startHarness } from "./helpers/server.ts";

// Newer ICU puts a narrow no-break space before AM and PM. Which space
// it is says nothing about whether the words are right.
const plain = (s: string) => s.replace(/\s/g, " ");
const at = (month: number, day: number, hour: number, minute: number, year = 2026) =>
  new Date(year, month - 1, day, hour, minute).getTime();
const now = at(10, 5, 9, 50); // a Monday morning

test("a message from today shows its time, and one from another day its date as well", () => {
  assert.equal(plain(stamp(at(10, 5, 9, 41), now, "en-US")), "9:41 AM");
  assert.equal(plain(stamp(at(10, 4, 18, 3), now, "en-US")), "Oct 4, 6:03 PM");
  assert.equal(plain(stamp(at(10, 5, 14, 15, 2025), now, "en-US")), "Oct 5, 2025, 2:15 PM");
  // the shape is the locale's, not one written here
  assert.equal(plain(stamp(at(10, 5, 14, 15), at(10, 5, 23, 0), "en-GB")), "14:15");
});

test("a run of bubbles from one side in the same minute says its time once, under the last", () => {
  const said = (role: string, minute: number, extra: Record<string, unknown> = {}) => ({
    role, kind: "text", at: at(10, 5, 9, minute) + 5_000, ...extra,
  });
  assert.equal(timeSaidBelow(said("bot", 41), said("bot", 41), now), true);
  assert.equal(timeSaidBelow(said("bot", 41), undefined, now), false, "the last of a run keeps it");
  assert.equal(timeSaidBelow(said("bot", 41), said("bot", 42), now), false, "a new minute is a new fact");
  assert.equal(timeSaidBelow(said("user", 41), said("bot", 41), now), false, "the other side says its own");
  assert.equal(timeSaidBelow(said("user", 41, { deliveredAt: now }), said("user", 41), now), false, "a queued line stays");
  assert.equal(timeSaidBelow(said("bot", 41), said("bot", 41, { kind: "activity" }), now), false);
  assert.equal(timeSaidBelow(said("bot", 41), said("bot", 41, { deleted: true }), now), false);
});

test("the line above a conversation names the day it started", () => {
  assert.equal(plain(dayLine(at(10, 5, 9, 41), now, "en-US")), "Today 9:41 AM");
  assert.equal(plain(dayLine(at(10, 4, 18, 3), now, "en-US")), "Yesterday 6:03 PM");
  assert.equal(plain(dayLine(at(10, 3, 14, 15), now, "en-US")), "Sat, Oct 3, 2:15 PM");
  assert.equal(plain(dayLine(at(12, 30, 11, 0, 2025), now, "en-US")), "Tue, Dec 30, 2025, 11:00 AM");
});

test("yesterday is the calendar day before, not the last 24 hours", () => {
  const justAfterMidnight = at(10, 5, 0, 10);
  // twenty minutes ago, and still yesterday
  assert.equal(plain(dayLine(at(10, 4, 23, 50), justAfterMidnight, "en-US")), "Yesterday 11:50 PM");
  assert.equal(plain(dayLine(at(10, 4, 0, 20), justAfterMidnight, "en-US")), "Yesterday 12:20 AM");
  // a day and a few minutes ago is a date
  assert.equal(plain(dayLine(at(10, 3, 23, 59), justAfterMidnight, "en-US")), "Sat, Oct 3, 11:59 PM");
  // late at night, this morning is still today
  assert.equal(plain(dayLine(at(10, 5, 0, 10), at(10, 5, 23, 50), "en-US")), "Today 12:10 AM");
  // across the end of a month and of a year
  assert.equal(plain(dayLine(at(10, 31, 20, 0), at(11, 1, 8, 0), "en-US")), "Yesterday 8:00 PM");
  assert.equal(plain(dayLine(at(12, 31, 20, 0, 2025), at(1, 1, 8, 0), "en-US")), "Yesterday 8:00 PM");
});

test("a queued message says when it came in and when it went, without saying a date twice", () => {
  assert.equal(plain(queuedLine(at(10, 5, 9, 41), at(10, 5, 9, 44), now, "en-US")), "Queued at 9:41 AM, sent at 9:44 AM");
  assert.equal(
    plain(queuedLine(at(10, 3, 9, 41), at(10, 3, 9, 44), now, "en-US")),
    "Queued at Oct 3, 9:41 AM, sent at 9:44 AM",
  );
  // waited past midnight: the second time needs its own day
  assert.equal(
    plain(queuedLine(at(10, 3, 23, 58), at(10, 4, 0, 3), now, "en-US")),
    "Queued at Oct 3, 11:58 PM, sent at Oct 4, 12:03 AM",
  );
  assert.equal(
    plain(queuedLine(at(10, 4, 23, 58), at(10, 5, 0, 3), now, "en-US")),
    "Queued at Oct 4, 11:58 PM, sent at 12:03 AM",
  );
});

const waitFor = async <T,>(check: () => Promise<T | null | undefined> | T | null | undefined, ms = 15_000): Promise<T | null> => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const value = await check();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
};

test("a queued message keeps when it went to the agent, through a restart", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "bloks-times-"));
  const calls: string[] = [];
  const held: Array<() => void> = [];
  let answerAtOnce = false;
  const provider = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url?.endsWith("/models")) return res.end(JSON.stringify({ data: [{ id: "grok-4" }] }));
      calls.push(body);
      const finish = () => res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "Done." } }] }));
      if (answerAtOnce) finish();
      else held.push(finish);
    });
  });
  await new Promise<void>((r) => provider.listen(0, "127.0.0.1", () => r()));
  t.after(async () => {
    held.forEach((f) => f());
    provider.closeAllConnections();
    provider.close();
    rmSync(home, { recursive: true, force: true });
  });
  const port = (provider.address() as { port: number }).port;

  const first = await startHarness({ HOME: home });
  // stopped below as well, before the restart; this is for a test that
  // fails first, which would otherwise leave the server running
  t.after(() => first.stop());
  await first.json("/api/providers/grok/connect", { method: "POST", body: JSON.stringify({ key: "test-key", url: `http://127.0.0.1:${port}` }) });
  const { bot } = await first.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Timekeeper" }) });
  await first.fetch(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "grok", model: "grok-4" } }) });
  const read = async (h: typeof first) => {
    const { messages } = await h.json(`/api/bots/${bot.id}/messages?thread=${bot.threadId}&limit=500`);
    return (text: string) => messages.find((m: any) => m.text === text);
  };

  // a turn in flight, and a message that has to wait behind it
  await first.fetch(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: "STRAIGHT-IN" }) });
  await waitFor(() => calls.length >= 1);
  const queued = await first.json(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: "HAD-TO-WAIT" }) });
  assert.equal(queued.queued, true);
  const waiting = (await read(first))("HAD-TO-WAIT");
  assert.equal(typeof waiting.queuedAt, "number");
  assert.equal(waiting.deliveredAt, undefined, "still waiting, so it has not gone to the agent");

  const released = Date.now();
  answerAtOnce = true;
  held.splice(0).forEach((f) => f());
  const went = await waitFor(async () => {
    const m = (await read(first))("HAD-TO-WAIT");
    return m && !m.queued && m.deliveredAt ? m : null;
  });
  assert.ok(went, "the queued message never went to the agent");
  assert.ok(await waitFor(() => calls.some((c) => c.includes("HAD-TO-WAIT"))), "the turn it went to never ran");
  // the moment it stopped waiting, not the moment it was queued
  assert.ok(went.deliveredAt >= released, "the time it went is the time it was queued");
  assert.equal(went.queuedAt, waiting.queuedAt);
  // it joined the conversation when it went, so that is its place in it
  // (GitHub 170); when it was written is still there in queuedAt
  assert.equal(went.at, went.deliveredAt);
  assert.equal((await read(first))("STRAIGHT-IN").deliveredAt, undefined, "a message that never waited has no time for it");
  await first.stop();

  const disk = JSON.parse(readFileSync(join(home, ".bloks", `messages-${bot.threadId}.json`), "utf8"));
  assert.equal(disk.find((m: any) => m.text === "HAD-TO-WAIT").deliveredAt, went.deliveredAt, "it is written down");

  const second = await startHarness({ HOME: home });
  t.after(() => second.stop());
  const after = await waitFor(async () => (await read(second))("HAD-TO-WAIT"));
  assert.equal(after.deliveredAt, went.deliveredAt, "a restart lost when it went");
  assert.equal(after.queued, false);
});
