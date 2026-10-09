// What the composer's ring and its card say (GitHub 224), and what the
// chips, the sidebar and Activity say from the same numbers.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  activityContext,
  composerContext,
  contextCard,
  contextTitle,
  measuredContext,
  percent,
  planName,
  planRows,
  planWindowLabel,
  resetPhrase,
  ringLabel,
  shortTokens,
  type LaneContext,
  type PlanUsage,
} from "../src/lib/contextCard.ts";

const codex: LaneContext = { used: 141_000, limit: 258_400, fraction: 141_000 / 258_400, measured: true, window: "engine", summarised: false };

test("the card says how full, in tokens and as a share", () => {
  assert.deepEqual(contextCard(codex), { share: "55% full", tokens: "141k of 258k tokens", summarised: null });
  assert.equal(ringLabel(codex), "Context window 55% full");
});

test("a window that is the table's guess is said to be about that", () => {
  const guessed = { ...codex, window: "table" as const, limit: 272_000, fraction: 141_000 / 272_000 };
  assert.deepEqual(contextCard(guessed), { share: "About 52% full", tokens: "141k of about 272k tokens", summarised: null });
  assert.equal(ringLabel(guessed), "Context window about 52% full");
  assert.equal(contextTitle(guessed), "About 52% of what this model will take");
});

test("a line says so when Bloks summarised the earlier part", () => {
  assert.equal(contextCard({ ...codex, summarised: true }).summarised, "Bloks summarised the earlier part of this conversation.");
});

test("no ring rather than a guess", () => {
  // nothing measured on the engine and model the conversation is on now
  assert.equal(composerContext({ used: 0, limit: 0, fraction: 0, measured: false, window: "table", summarised: true }), null);
  // a server that does not say whether it measured is not vouching for it
  assert.equal(composerContext({ used: 958_776, limit: 1_000_000, fraction: 0.96, summarised: false }), null);
  // a measurement that has nothing in it yet, or no window
  assert.equal(composerContext({ ...codex, used: 0, fraction: 0 }), null);
  assert.equal(composerContext({ ...codex, limit: 0 }), null);
  assert.equal(composerContext({ ...codex, fraction: NaN }), null);
  assert.equal(composerContext(undefined), null);
  // and a real one, at any level: the ring shows from the first answer
  const first = { ...codex, used: 9_600, fraction: 9_600 / 258_400 };
  assert.equal(composerContext(first), first);
  assert.equal(contextCard(first).tokens, "9.6k of 258k tokens");
});

test("chips, rows and Activity read the same numbers, with their own thresholds", () => {
  assert.equal(measuredContext(codex), true);
  assert.equal(measuredContext({ ...codex, measured: false }), false);
  // an older server's fill stands on the chips, as it always did
  assert.equal(measuredContext({ used: 50_000, limit: 200_000, fraction: 0.25 }), true);
  assert.equal(contextTitle({ ...codex, summarised: true }), "55% of what this model will take, and the earlier part has been summarised");
  assert.equal(contextTitle({ used: 0, limit: 0, fraction: 0, measured: false, summarised: true }), "The earlier part has been summarised");
  assert.equal(activityContext(codex), "55% of the window");
  assert.equal(activityContext({ ...codex, window: "table" }), "about 55% of the window");
  assert.equal(activityContext({ ...codex, fraction: 0.49 }), null);
  assert.equal(activityContext({ ...codex, measured: false }), null);
});

test("token counts and shares read the short way", () => {
  assert.deepEqual([842, 9_600, 9_960, 141_000, 258_400, 999_499, 999_500, 1_000_000, 1_250_000].map(shortTokens), [
    "842", "9.6k", "10k", "141k", "258k", "999k", "1M", "1M", "1.3M",
  ]);
  assert.deepEqual([0, 0.001, 0.005, 0.546, 1].map(percent), ["0%", "under 1%", "1%", "55%", "100%"]);
});

test("a plan's windows are named by their length", () => {
  assert.equal(planWindowLabel({ id: "five_hour", minutes: 300 }), "5-hour limit");
  assert.equal(planWindowLabel({ id: "seven_day", minutes: 10_080 }), "Weekly limit");
  assert.equal(planWindowLabel({ id: "seven_day_opus", minutes: 10_080 }), "Weekly limit, Opus");
  assert.equal(planWindowLabel({ id: "seven_day_overage_included", minutes: 10_080 }), "Weekly limit, with extra usage");
  assert.equal(planWindowLabel({ id: "primary", minutes: 300 }), "5-hour limit");
  assert.equal(planWindowLabel({ id: "secondary", minutes: 1_440 }), "Daily limit");
  assert.equal(planWindowLabel({ id: "secondary", minutes: 43_200 }), "30-day limit");
  assert.equal(planWindowLabel({ id: "primary", minutes: null }), "Limit");
});

const NOW = Date.UTC(2026, 9, 9, 12, 0); // a Friday, at noon

test("a reset is said in minutes and hours while it is near, by day and time after", () => {
  assert.equal(resetPhrase(NOW + 12 * 60_000, NOW), "Resets in 12 min");
  assert.equal(resetPhrase(NOW + 30_000, NOW), "Resets in 1 min");
  assert.equal(resetPhrase(NOW + (2 * 60 + 14) * 60_000, NOW), "Resets in 2 h 14 min");
  assert.equal(resetPhrase(NOW + 3 * 60 * 60_000, NOW), "Resets in 3 h");
  const utc = { locale: "en-US", timeZone: "UTC" };
  assert.equal(resetPhrase(NOW + 4 * 24 * 60 * 60_000 + 3 * 60 * 60_000, NOW, utc), "Resets Tue 3:00 PM");
  assert.equal(resetPhrase(NOW + 6.5 * 24 * 60 * 60_000, NOW, utc), "Resets Fri, Oct 16, 12:00 AM");
  assert.equal(resetPhrase(NOW - 1, NOW), null);
  assert.equal(resetPhrase(null, NOW), null);
});

test("the card lists each current window, shortest first, with the engine's warning", () => {
  const plan: PlanUsage = {
    windows: [
      { id: "seven_day", minutes: 10_080, used: 0.81, resetsAt: NOW + 3 * 24 * 60 * 60_000, status: "warning" },
      { id: "five_hour", minutes: 300, used: 0.42, resetsAt: NOW + 134 * 60_000 },
      // reset since the engine last said, so its number is old news
      { id: "seven_day_opus", minutes: 10_080, used: 0.99, resetsAt: NOW - 60_000 },
    ],
    plan: null,
    at: NOW - 60_000,
  };
  const rows = planRows(plan, NOW, { locale: "en-US", timeZone: "UTC" });
  assert.deepEqual(rows, [
    { id: "five_hour", label: "5-hour limit", used: "42% used", fill: 0.42, reset: "Resets in 2 h 14 min", note: null, near: false },
    { id: "seven_day", label: "Weekly limit", used: "81% used", fill: 0.81, reset: "Resets Mon 12:00 PM", note: "Near the limit", near: true },
  ]);
  const out = planRows({ windows: [{ id: "primary", minutes: 300, used: 1.04, resetsAt: null }], plan: "pro", at: NOW }, NOW);
  assert.deepEqual(out.map((r) => [r.used, r.fill, r.note, r.reset]), [["104% used", 1, "Limit reached", null]]);
  assert.equal(planRows({ windows: [{ id: "five_hour", minutes: 300, used: 0.1, resetsAt: null, status: "rejected" }], plan: null, at: NOW }, NOW)[0].note, "Limit reached");
  assert.deepEqual(planRows(null, NOW), []);
  assert.equal(planName("pro"), "Pro");
  assert.equal(planName(" "), null);
});
