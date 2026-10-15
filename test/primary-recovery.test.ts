// Restored quota is judged by an ordinary message, through the real native
// drivers and server. These CLIs are local fixtures, with no credentials.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Cooldowns, failureOf, RETRY_INTERVAL_MS, withFailureNote } from "../server/failover.ts";
import { engineReadiness } from "../server/engine-readiness.ts";
import { primaryRecovery } from "./helpers/primary-recovery.ts";

const MINUTE = 60_000;
const NOW = Date.UTC(2026, 0, 1, 12);

describe("bounded usage reservations", () => {
  const resting = () => { const c = new Cooldowns(); c.rest("own", "limit", "usage limit reached", NOW); return c; };
  test("fifteen minutes from the rest, then from each accepted reservation", () => {
    assert.equal(RETRY_INTERVAL_MS, 15 * MINUTE);
    const c = resting();
    assert.equal(c.reserve("own", RETRY_INTERVAL_MS, NOW + RETRY_INTERVAL_MS - 1), undefined);
    const a = c.reserve("own", RETRY_INTERVAL_MS, NOW + RETRY_INTERVAL_MS)!;
    assert.ok(a);
    a.accepted(); a.finished();
    assert.equal(c.reserve("own", RETRY_INTERVAL_MS, NOW + 2 * RETRY_INTERVAL_MS - 1), undefined);
    // A fresh provider rejection keeps the reservation's clock.
    c.rest("own", "limit", "usage limit reached", NOW + RETRY_INTERVAL_MS);
    assert.ok(c.reserve("own", RETRY_INTERVAL_MS, NOW + 2 * RETRY_INTERVAL_MS));
  });
  test("only one in flight across lanes, even after the next interval", () => {
    const c = resting();
    const a = c.reserve("own", 100, NOW + 100)!;
    a.accepted(); a.cancel();
    assert.equal(c.reserve("own", 100, NOW + 200), undefined);
    a.finished();
    assert.ok(c.reserve("own", 100, NOW + 200));
  });
  for (const why of ["Stop", "rejected send", "preparation failure"]) test(`${why} returns both token and interval before acceptance`, () => {
    const c = resting();
    const a = c.reserve("own", 100, NOW + 100)!;
    assert.ok(a); a.cancel();
    assert.ok(c.reserve("own", 100, NOW + 101));
  });
  test("provider completion before acceptance still counts and releases exactly once", () => {
    const c = resting(); const a = c.reserve("own", 100, NOW + 100)!;
    a.finished();
    assert.equal(c.reserve("own", 100, NOW + 200), undefined);
    a.accepted();
    const b = c.reserve("own", 100, NOW + 200)!;
    assert.ok(b); a.cancel(); a.finished();
    assert.equal(c.reserve("own", 100, NOW + 300), undefined);
  });
  test("a cancelled reservation cannot release the next reservation on the same rest", () => {
    const c = resting(), a = c.reserve("own", 100, NOW + 100)!;
    a.cancel();
    const b = c.reserve("own", 100, NOW + 101)!; assert.ok(b);
    a.cancel(); a.finished();
    assert.equal(c.reserve("own", 100, NOW + 300), undefined, "late cancellation released a newer try");
    b.cancel(); assert.ok(c.reserve("own", 100, NOW + 300));
  });
  test("success clearing the entry cannot be undone by a late callback", () => {
    const c = resting(); const a = c.reserve("own", 100, NOW + 100)!;
    c.clear("own"); c.rest("own", "limit", "usage limit reached", NOW + 200);
    const b = c.reserve("own", 100, NOW + 300)!;
    a.cancel(); a.accepted(); a.finished();
    assert.equal(c.reserve("own", 100, NOW + 400), undefined);
    b.cancel(); assert.ok(c.reserve("own", 100, NOW + 400));
  });
  test("other reasons, missing and expired rests never reserve; unrelated rests remain", () => {
    const c = resting();
    for (const reason of ["credit", "signedOut", "overloaded"] as const) {
      c.rest(reason, reason, "", NOW);
      assert.equal(c.reserve(reason, 1, NOW + 100), undefined);
    }
    assert.equal(c.reserve("missing", 1, NOW + 100), undefined);
    assert.equal(c.reserve("own", 1, NOW + 31 * MINUTE), undefined);
    assert.deepEqual(Object.keys(c.all(NOW + 100)).sort(), ["credit", "overloaded", "signedOut"]);
  });
  test("an expiring rest cannot lose an in-flight reservation", () => {
    const c = resting(); const a = c.reserve("own", 1, NOW + 100)!;
    assert.equal(c.of("own", NOW + 31 * MINUTE), undefined);
    c.rest("own", "limit", "usage limit reached", NOW + 31 * MINUTE);
    assert.equal(c.reserve("own", 1, NOW + 32 * MINUTE), undefined);
    a.accepted(); a.finished();
    assert.ok(c.reserve("own", 1, NOW + 32 * MINUTE));
  });
  test("epoch and clock resets within sixty seconds retain one notice key", () => {
    const c = new Cooldowns();
    const epoch = Math.floor((NOW + 40 * MINUTE) / 1000);
    const first = c.rest("claude", "limit", `usage limit reached|${epoch}`, NOW);
    assert.equal(c.rest("claude", "limit", `usage limit reached|${epoch + 60}`, NOW + MINUTE).until, first.until);
    assert.notEqual(c.rest("claude", "limit", `usage limit reached|${epoch + 61}`, NOW + 2 * MINUTE).until, first.until);
    const clock = c.rest("codex", "limit", "You've hit your usage limit. resets 1:00 PM (UTC)", NOW);
    assert.equal(c.rest("codex", "limit", "You've hit your usage limit. resets 1:00 PM (UTC)", NOW + 15 * MINUTE).until, clock.until);
  });
  test("relative resets beyond sixty seconds intentionally update the notice key", () => {
    const c = new Cooldowns(); const first = c.rest("own", "limit", "usage limit, try again in 20m", NOW);
    assert.equal(c.rest("own", "limit", "usage limit, try again in 20m", NOW + 15 * MINUTE).until, first.until + 15 * MINUTE);
  });
  test("readiness follows the cleared instance; a new process starts with no retry history", () => {
    const c = resting(); c.rest("other", "credit", "", NOW);
    const facts = () => engineReadiness({ present: true, rest: c.of("own", NOW + 100) });
    assert.equal(facts().state, "out"); c.clear("own"); assert.equal(facts().state, "ready");
    assert.equal(c.of("other", NOW + 100)?.reason, "credit");
    assert.deepEqual(new Cooldowns().all(NOW), {});
  });
  test("both engines' limit texts are out, never a refusal or a session-drop reason", () => {
    for (const said of ["usage limit reached|1790000000", "You've hit your usage limit. resets 11:00 PM (UTC)"]) assert.equal(failureOf(said), "out");
  });
});

describe("pending failure at the accepted dispatch boundary", () => {
  test("a rejected send retains the exact long line; acceptance consumes it once", async () => {
    const line = '(A note from Bloks: an earlier attempt failed, saying: "Connection reset by peer". It was stopped.)';
    const notes = new Map([["lane", { text: line }]]);
    await assert.rejects(withFailureNote(notes, "lane", async (heard) => { assert.equal(heard, line); throw new Error("rejected"); }), /rejected/);
    assert.equal(notes.get("lane")?.text, line);
    await withFailureNote(notes, "lane", async (heard) => assert.equal(heard, line));
    await withFailureNote(notes, "lane", async (heard) => assert.equal(heard, undefined));
  });
  for (const newer of ["newer words", "identical words"]) test(`an older accepted send cannot consume ${newer}`, async () => {
    const original = "identical words";
    const notes = new Map([["lane", { text: original }]]);
    const next = { text: newer };
    await withFailureNote(notes, "lane", async (heard) => { assert.equal(heard, original); notes.set("lane", next); });
    assert.equal(notes.get("lane"), next);
    await withFailureNote(notes, "lane", async (heard) => assert.equal(heard, newer));
    assert.equal(notes.has("lane"), false);
  });
});

primaryRecovery("claudeAgent");
