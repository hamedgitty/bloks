// The Usage page's numbers (GET /api/usage/report, server/usage.ts).
//
// As with the summary, the assertions that matter are about honesty: a
// cost is only ever an engine's own price, Bloks AI is never in a dollar
// total, an engine that prices nothing says so instead of reading as
// free, and a filter narrows the numbers without emptying the menus it
// was picked from.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { rangeDays, usageReport, UsageStore, type UsageBucket } from "../server/usage.ts";

const bucket = (over: Partial<UsageBucket> = {}): UsageBucket => ({
  date: "2026-10-20",
  botId: "ada",
  provider: "claude",
  turns: 1,
  input: 100,
  output: 10,
  cost: 0,
  costKnown: false,
  ...over,
});

const TODAY = new Date(2026, 9, 20, 15, 0);

test("a span is the days it says, today included, and This month starts on the first", () => {
  assert.equal(rangeDays("7d", TODAY), 7);
  assert.equal(rangeDays("90d", TODAY), 90);
  assert.equal(rangeDays("month", TODAY), 20);
  const week = usageReport([], "7d", {}, TODAY);
  assert.deepEqual([week.from, week.to, week.daily.length], ["2026-10-14", "2026-10-20", 7]);
  const month = usageReport([], "month", {}, TODAY);
  assert.deepEqual([month.from, month.to, month.daily.length], ["2026-10-01", "2026-10-20", 20]);
  assert.ok(week.daily.every((d) => d.turns === 0), "a quiet day is still a day");
});

test("only an engine's own price is a cost, and Bloks AI is never one", () => {
  const r = usageReport(
    [
      bucket({ provider: "claude", cost: 1.5, costKnown: true, turns: 3 }),
      bucket({ provider: "codex", input: 900, turns: 4 }),
      // a Bloks AI bucket that somehow carried a price still adds none
      bucket({ provider: "bloks", cost: 9, costKnown: true, turns: 2, input: 50 }),
    ],
    "7d",
    {},
    TODAY,
  );
  assert.equal(r.total.cost, 1.5);
  assert.equal(r.total.turns, 9, "every turn counts, priced or not");
  assert.equal(r.total.input, 1050);
  assert.equal(r.priced, true);
  assert.equal(r.unpricedTurns, 4, "Codex's turns say they had no price");
  assert.equal(r.bloksAiTurns, 2, "Bloks AI's turns are counted apart");
  const byEngine = Object.fromEntries(r.byEngine.map((e) => [e.id, e]));
  assert.equal(byEngine.codex.priced, false);
  assert.equal(byEngine.bloks.priced, false);
  assert.equal(byEngine.bloks.cost, 0);
  assert.equal(byEngine.claude.priced, true);
  assert.equal(r.byEngine[0].id, "claude", "the priced engine first, by what it cost");
  assert.equal(r.daily.at(-1)!.byEngine.claude.cost, 1.5, "each day splits by engine for the chart");
});

test("nothing priced says so, rather than a cost of nothing", () => {
  const r = usageReport([bucket({ provider: "codex" }), bucket({ provider: "pi", input: 0, output: 0, unmeasured: 1 })], "30d", {}, TODAY);
  assert.equal(r.priced, false);
  assert.equal(r.total.cost, 0);
  assert.equal(r.total.unmeasured, 1, "a turn that said nothing is counted as unmeasured");
});

test("a filter narrows the numbers but not the menus, and the span before is compared like for like", () => {
  const buckets = [
    bucket({ botId: "ada", provider: "claude", cost: 2, costKnown: true }),
    bucket({ botId: "bo", provider: "grok", cost: 1, costKnown: true, date: "2026-10-18" }),
    // the week before, for the comparison
    bucket({ botId: "ada", provider: "claude", cost: 4, costKnown: true, date: "2026-10-10" }),
    bucket({ botId: "bo", provider: "grok", cost: 8, costKnown: true, date: "2026-10-07" }),
    // older than either span
    bucket({ botId: "ada", provider: "claude", cost: 100, costKnown: true, date: "2026-10-01" }),
  ];
  const all = usageReport(buckets, "7d", {}, TODAY);
  assert.equal(all.total.cost, 3);
  assert.equal(all.previous.cost, 12);
  const ada = usageReport(buckets, "7d", { bot: "ada" }, TODAY);
  assert.equal(ada.total.cost, 2);
  assert.equal(ada.previous.cost, 4, "the span before is narrowed the same way");
  assert.deepEqual(ada.byAgent.map((a) => a.id), ["ada"]);
  assert.deepEqual(ada.agents.sort(), ["ada", "bo"], "the menu still offers everyone with usage");
  assert.deepEqual(ada.engines.sort(), ["claude", "grok"]);
  const grok = usageReport(buckets, "7d", { engine: "grok" }, TODAY);
  assert.deepEqual([grok.total.cost, grok.previous.cost], [1, 8]);
  assert.deepEqual(grok.byEngine.map((e) => e.id), ["grok"]);
});

test("a month's buckets are the month's and nothing else", () => {
  const store = new UsageStore(join(mkdtempSync(join(tmpdir(), "bloks-usage-month-")), "usage.json"));
  store.recordTurn("ada", "grok", 0.5, new Date(2026, 9, 3, 9));
  store.recordTurn("ada", "grok", 0.25, new Date(2026, 9, 31, 23));
  store.recordTurn("ada", "grok", 7, new Date(2026, 8, 30, 23));
  store.recordTurn("ada", "grok", 7, new Date(2026, 10, 1, 0, 5));
  const october = store.inMonth("2026-10");
  assert.equal(october.length, 2);
  assert.equal(october.reduce((sum, b) => sum + b.cost, 0), 0.75);
});

test("an estimate from tokens is a cost, kept apart so it is always shown as one", () => {
  const store = new UsageStore(join(mkdtempSync(join(tmpdir(), "bloks-usage-estimate-")), "usage.json"));
  const day = new Date(2026, 9, 20, 9);
  store.recordTurn("ada", "gemini", 0.4, day, true, true);
  store.recordTurn("ada", "gemini", 0.1, day, true, true);
  store.recordTurn("ada", "openrouter", 1, day, true);
  const [gemini] = store.inMonth("2026-10").filter((b) => b.provider === "gemini");
  assert.deepEqual([gemini.cost, gemini.estimated, gemini.costKnown], [0.5, 0.5, true]);

  const r = usageReport(store.inMonth("2026-10"), "7d", {}, TODAY);
  assert.equal(r.total.cost, 1.5);
  assert.equal(r.total.estimated, 0.5, "only the estimated part");
  assert.equal(r.priced, true);
  assert.equal(r.unpricedTurns, 0, "an estimated turn is not an unpriced one");
  const byEngine = Object.fromEntries(r.byEngine.map((e) => [e.id, e]));
  assert.deepEqual([byEngine.gemini.estimated, byEngine.openrouter.estimated], [0.5, 0]);
  assert.equal(r.daily.at(-1)!.byEngine.gemini.estimated, 0.5, "each day says which of it was estimated");
});

test("each row counts its Bloks AI turns, so an agent only ever on it can say so", () => {
  const r = usageReport(
    [
      bucket({ botId: "ada", provider: "bloks", turns: 3 }),
      bucket({ botId: "bo", provider: "bloks", turns: 1 }),
      bucket({ botId: "bo", provider: "codex", turns: 2 }),
    ],
    "7d",
    {},
    TODAY,
  );
  const byAgent = Object.fromEntries(r.byAgent.map((a) => [a.id, a]));
  assert.deepEqual([byAgent.ada.turns, byAgent.ada.bloksAiTurns, byAgent.ada.priced], [3, 3, false]);
  assert.deepEqual([byAgent.bo.turns, byAgent.bo.bloksAiTurns], [3, 1], "partly on Bloks AI is not only on it");
});

test("an engine with only turns it never ran is not in the report, its menus or its plans", () => {
  // as the issue's workspace had it: OpenCode answers, and one turn on a
  // Codex that is not installed was refused at once (GitHub 459)
  const report = usageReport(
    [
      bucket({ provider: "opencode", input: 2_000, output: 300, turns: 4 }),
      bucket({ botId: "imported", provider: "codex", input: 0, output: 0, turns: 1 }),
    ],
    "30d",
    {},
    TODAY,
  );
  assert.deepEqual(report.engines, ["opencode"]);
  assert.deepEqual(report.agents, ["ada"]);
  assert.deepEqual(report.byEngine.map((e) => e.id), ["opencode"]);
  assert.equal(report.total.turns, 4);
  assert.equal(report.unpricedTurns, 4);
  assert.equal(report.daily.at(-1)?.byEngine.codex, undefined);
});
