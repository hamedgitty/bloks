// When a hosted workspace next has work of its own (server/next-due.ts),
// which Bloks Cloud uses to wake a machine that sleeps while idle. Too
// late, and a routine or a watcher is missed on a machine nobody wakes;
// too early or for nothing, and a machine that could sleep never does.
import { test } from "node:test";
import assert from "node:assert/strict";

import { nextDueAt } from "../server/next-due.ts";
import type { Routine } from "../server/routines.ts";
import type { Watcher } from "../server/watchers.ts";

/** Ten in the morning, local time, on a Wednesday. */
const NOW = new Date(2026, 9, 21, 10, 0, 0).getTime();
const MIN = 60_000;

const routine = (over: Partial<Routine>): Routine =>
  ({ id: "r", targetId: "a", targetKind: "agent", prompt: "p", time: "11:30", days: [], enabled: true, createdAt: 0, ...over }) as Routine;
const watcher = (over: Partial<Watcher>): Watcher =>
  ({ id: "w", botId: "a", name: "w", kind: "page", target: "https://example.com", instruction: "i", mode: "act", every: 30, enabled: true, createdAt: 0, fires: [], ...over }) as Watcher;
const none = () => false;

test("nothing scheduled is nothing due", () => {
  assert.equal(nextDueAt({ routines: [], watchers: [], suspended: none, now: NOW }), null);
});

test("the next routine, the earliest of several", () => {
  const due = nextDueAt({ routines: [routine({ time: "11:30" }), routine({ id: "r2", time: "10:15" })], watchers: [], suspended: none, now: NOW });
  assert.equal(due, new Date(2026, 9, 21, 10, 15).getTime());
});

test("a routine that already ran today is due tomorrow", () => {
  const due = nextDueAt({ routines: [routine({ time: "09:00" })], watchers: [], suspended: none, now: NOW });
  assert.equal(due, new Date(2026, 9, 22, 9, 0).getTime());
});

test("a watcher's next look, and one overdue is due now", () => {
  assert.equal(nextDueAt({ routines: [], watchers: [watcher({ lastCheck: NOW - 10 * MIN })], suspended: none, now: NOW }), NOW + 20 * MIN);
  assert.equal(nextDueAt({ routines: [], watchers: [watcher({ lastCheck: NOW - 90 * MIN })], suspended: none, now: NOW }), NOW);
  assert.equal(nextDueAt({ routines: [], watchers: [watcher({})], suspended: none, now: NOW }), NOW, "never looked: now");
});

test("what will not run wakes nothing: off, stopped for failing, an archived agent's, or a folder", () => {
  const off = { routines: [routine({ enabled: false }), routine({ id: "f", failing: { at: 0, error: "x" } })], watchers: [], suspended: none, now: NOW };
  assert.equal(nextDueAt(off), null);
  const archived = { routines: [routine({ targetId: "gone" })], watchers: [watcher({ botId: "gone" })], suspended: (id: string) => id === "gone", now: NOW };
  assert.equal(nextDueAt(archived), null);
  const folder = { routines: [], watchers: [watcher({ kind: "folder", target: "/tmp" }), watcher({ id: "x", enabled: false })], suspended: none, now: NOW };
  assert.equal(nextDueAt(folder), null, "a folder on a sleeping machine does not change");
});

test("a room's routine wakes it whatever its agents are doing", () => {
  const due = nextDueAt({ routines: [routine({ targetKind: "room", targetId: "room-1" })], watchers: [], suspended: () => true, now: NOW });
  assert.equal(due, new Date(2026, 9, 21, 11, 30).getTime());
});

test("a finding held back by the hourly cap is due when the cap allows, a folder's included (GitHub 496)", () => {
  // six turns, the oldest fifty minutes ago: room again in ten minutes
  const fires = Array.from({ length: 6 }, (_, i) => ({ at: NOW - (50 - i * 5) * MIN, summary: "s" }));
  const held = watcher({ kind: "folder", target: "/tmp", held: NOW - 5 * MIN, fires, lastCheck: NOW - 5 * MIN });
  assert.equal(nextDueAt({ routines: [], watchers: [held], suspended: none, now: NOW }), NOW + 10 * MIN);
  const page = watcher({ held: NOW - 5 * MIN, fires, lastCheck: NOW - 5 * MIN, every: 60 });
  assert.equal(nextDueAt({ routines: [], watchers: [page], suspended: none, now: NOW }), NOW + 10 * MIN, "the next look an hour away was taken instead");
  assert.equal(nextDueAt({ routines: [], watchers: [{ ...held, enabled: false }], suspended: none, now: NOW }), null);
});
