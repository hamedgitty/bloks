// The Usage page in words (src/lib/usagePage.ts): how a figure is
// written, what the line under the headline admits to, how the span
// before is compared, and what the page remembers between visits.
//
// And where an engine on a plan gave no price (Codex on its ChatGPT
// sign-in, GitHub 360): its tokens here, and its plan's windows apart
// from them, or a plain line when there is no reading.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import type { PlanUsage } from "../src/lib/contextCard.ts";
import {
  DEFAULT_VIEW,
  accountWide,
  axisMoney,
  deltaLine,
  estimatedMoney,
  figure,
  figureOf,
  headlineNotes,
  isEstimate,
  money,
  noPlanReading,
  onPlan,
  perMillionText,
  pricesNote,
  niceTicks,
  planEngines,
  planTitle,
  planUses,
  planWithoutPrice,
  readView,
  saveView,
  seePlanTitle,
  shareText,
  sortRows,
  topsUpLine,
  valueOf,
  type UsageRow,
  type UsageTotals,
} from "../src/lib/usagePage.ts";

const totals = (over: Partial<UsageTotals> = {}): UsageTotals => ({ turns: 0, input: 0, output: 0, cost: 0, unmeasured: 0, ...over });
const row = (id: string, over: Partial<UsageRow> = {}): UsageRow => ({ id, priced: false, ...totals(over), ...over });

test("dollars are written as a bill writes them, and a sliver is never $0.00", () => {
  assert.equal(money(0), "$0.00");
  assert.equal(money(0.004), "under $0.01");
  assert.equal(money(12.4), "$12.40");
  assert.equal(money(1204.183), "$1,204.18");
  assert.equal(axisMoney(0), "$0");
  assert.equal(axisMoney(0.25), "$0.25");
  assert.equal(axisMoney(2.5), "$2.5");
  assert.equal(axisMoney(40), "$40");
  assert.equal(figure(1_250_000, "tokens"), "1.3M");
  assert.equal(figure(1234, "turns"), "1,234");
});

test("an estimate is written as one, and never as a bill", () => {
  assert.equal(estimatedMoney(4.2), "~$4.20");
  assert.equal(estimatedMoney(0.004), "under ~$0.01");
  assert.equal(figure(4.2, "cost", true), "~$4.20");
  assert.equal(figure(4.2, "cost"), "$4.20");
  assert.equal(figure(1_250_000, "tokens", true), "1.3M", "only a cost is estimated");
  assert.equal(figureOf(totals({ cost: 3, estimated: 1 }), "cost"), "~$3.00", "any estimate in it makes the whole an estimate");
  assert.equal(figureOf(totals({ cost: 3 }), "cost"), "$3.00");
  assert.equal(figureOf(undefined, "cost"), "$0.00");
  assert.equal(isEstimate(totals({ estimated: 0 })), false);
  assert.equal(isEstimate(null), false);
  assert.equal(perMillionText(3), "$3");
  assert.equal(perMillionText(0.15), "$0.15");
  assert.equal(perMillionText(1.25), "$1.25");
  assert.doesNotMatch(pricesNote(), /[\u2013\u2014]/);
});

test("each metric reads its own number from a tally", () => {
  const t = totals({ turns: 3, input: 100, output: 20, cost: 0.5 });
  assert.deepEqual([valueOf(t, "cost"), valueOf(t, "tokens"), valueOf(t, "turns")], [0.5, 120, 3]);
});

test("the line under the headline says what the figure leaves out", () => {
  const report = { total: totals({ turns: 40, unmeasured: 2 }), unpricedTurns: 12, bloksAiTurns: 5, priced: true };
  assert.deepEqual(headlineNotes(report, "cost"), [
    "40 turns",
    "estimate from what engines report",
    "USD",
    "12 turns with no price reported",
    "5 turns on Bloks AI, never priced",
    "2 turns unmeasured",
  ]);
  assert.equal(
    headlineNotes({ ...report, total: totals({ turns: 40, cost: 2, estimated: 1 }) }, "cost")[1],
    "estimate from what engines report, and from tokens where they report no price",
  );
  // tokens and turns are counted for everyone, Bloks AI included
  assert.deepEqual(headlineNotes(report, "tokens"), ["40 turns", "2 turns unmeasured"]);
  assert.deepEqual(headlineNotes({ ...report, total: totals({ turns: 1 }) }, "turns"), ["1 turn"]);
});

test("against the span before: more, less, about the same, and nothing from nothing", () => {
  assert.deepEqual(deltaLine(12, 10, 30), { text: "20% more than the 30 days before", direction: "up" });
  assert.deepEqual(deltaLine(5, 10, 7), { text: "50% less than the 7 days before", direction: "down" });
  assert.deepEqual(deltaLine(10.02, 10, 7), { text: "About the same as the 7 days before", direction: "flat" });
  assert.deepEqual(deltaLine(250, 10, 1), { text: "25 times the 1 day before", direction: "up" });
  assert.equal(deltaLine(10, 0, 7), null, "growth from nothing is no percent");
});

test("shares, ticks and the tops-up date", () => {
  assert.equal(shareText(1, 3), "33%");
  assert.equal(shareText(1, 500), "under 1%");
  assert.equal(shareText(0, 0), "0%");
  assert.deepEqual(niceTicks(0), [0]);
  assert.deepEqual(niceTicks(7.3), [0, 2.5, 5, 7.5]);
  assert.deepEqual(niceTicks(1_200_000), [0, 500_000, 1_000_000, 1_500_000]);
  assert.equal(topsUpLine(new Date(2026, 10, 1).getTime(), "en-US"), "Tops up Nov 1");
});

test("rows sort by the header asked for, busiest first on a tie", () => {
  const rows = [
    { ...totals({ cost: 1, input: 10 }), name: "b" },
    { ...totals({ cost: 3, input: 5 }), name: "A" },
    { ...totals({ cost: 1, input: 50 }), name: "c" },
  ];
  assert.deepEqual(sortRows(rows, "value", true, "cost", (r) => r.name).map((r) => r.name), ["A", "c", "b"]);
  assert.deepEqual(sortRows(rows, "name", false, "cost", (r) => r.name).map((r) => r.name), ["A", "b", "c"]);
  assert.deepEqual(sortRows(rows, "tokens", true, "cost", (r) => r.name).map((r) => r.name), ["c", "b", "A"]);
});

test("the page's choices are kept on this device, and a damaged one falls back", () => {
  const kept = new Map<string, string>();
  const storage = { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v) };
  assert.deepEqual(readView(storage), DEFAULT_VIEW);
  saveView({ range: "month", metric: "tokens", bot: "ada", engine: null, tab: "engine" }, storage);
  assert.deepEqual(readView(storage), { range: "month", metric: "tokens", bot: "ada", engine: null, tab: "engine" });
  kept.set("bloks-usage-view", JSON.stringify({ range: "year", metric: 4, bot: "", tab: "week" }));
  assert.deepEqual(readView(storage), DEFAULT_VIEW);
  kept.set("bloks-usage-view", "{not json");
  assert.deepEqual(readView(storage), DEFAULT_VIEW);
  assert.deepEqual(readView(null), DEFAULT_VIEW, "no storage at all is the default");
});

// ── an engine on a plan that gave no price ─────────────────────────────

const HOUR = 60 * 60_000;
const NOW = Date.UTC(2026, 9, 23, 12);
const KINDS: Record<string, string> = { codex: "codex", claude: "claudeAgent", "claude-2": "claudeAgent", gemini: "gemini", bloks: "bloks" };
const kindOf = (id: string) => KINDS[id] ?? id;
const reading = (windows: PlanUsage["windows"], plan: string | null = "pro"): PlanUsage => ({ windows, plan, at: NOW - HOUR });

test("only an engine on a plan that priced none of its turns gets its plan shown", () => {
  const report = {
    byEngine: [
      row("codex", { turns: 5, input: 1_494_462, output: 6_318 }),
      // Claude Code gives a price, so it has a cost to show
      row("claude", { turns: 9, input: 400, output: 90, cost: 1.2, priced: true }),
      // and a Claude Code turn with none failed before it said, which is
      // no reason to say its plan gives no dollar figure
      row("claude-2", { turns: 2 }),
      // on a key of the person's own, with nothing to price it: not a plan
      row("gemini", { turns: 2, input: 100, output: 10 }),
      row("bloks", { turns: 3, input: 50, output: 5 }),
    ],
  };
  const uses = planUses(report, kindOf, {}, NOW);
  assert.deepEqual(uses.map((u) => u.id), ["codex"]);
  assert.equal(uses[0].tokens, 1_500_780, "the tokens are this workspace's, input and output");
  assert.equal(uses[0].turns, 5);
  assert.equal(onPlan("codex"), true);
  assert.equal(onPlan("claudeAgent"), true);
  assert.equal(onPlan("gemini"), false);
  assert.equal(onPlan(undefined), false);
  assert.equal(planWithoutPrice("codex"), true);
  assert.equal(planWithoutPrice("claudeAgent"), false, "Claude Code prices its turns on a plan too");
  assert.deepEqual(planUses({ byEngine: [row("codex")] }, kindOf, {}, NOW), [], "an engine with no turns in view has nothing to say");
});

test("Limits shows a plan for an engine installed here, read from, or that answered in view", () => {
  const engine = (instanceId: string, driverKind: string, state: "available" | "unavailable") => ({ instanceId, driverKind, snapshot: { state } });
  const instances = [
    engine("claude", "claudeAgent", "unavailable"),
    engine("codex", "codex", "unavailable"),
    engine("opencode", "acp", "available"),
  ];
  // neither CLI is here and neither has answered: no plan card at all
  assert.deepEqual(planEngines(instances, {}, ["opencode"]), []);
  assert.deepEqual(planEngines(instances, null, null), [], "nor while the page is still reading");
  // installed, it has its card, saying nothing was heard yet
  assert.deepEqual(planEngines([engine("codex", "codex", "available")], {}, []).map((e) => e.instanceId), ["codex"]);
  // gone since, its turns in view or its plan read keep the card
  assert.deepEqual(planEngines(instances, {}, ["codex"]).map((e) => e.instanceId), ["codex"]);
  const reading: PlanUsage = { windows: [{ id: "five_hour", minutes: 300, used: 0.2, resetsAt: NOW + 3_600_000 }], plan: "Max", at: NOW };
  assert.deepEqual(planEngines(instances, { claude: reading }, []).map((e) => e.instanceId), ["claude"]);
  // an engine on no plan never gets one, installed or not
  assert.deepEqual(planEngines(instances, { opencode: reading }, ["opencode"]), []);
});

test("a current reading shows each window's share used and when it resets", () => {
  const plans = {
    codex: reading([
      { id: "secondary", minutes: 7 * 24 * 60, used: 0.12, resetsAt: NOW + 3 * HOUR },
      { id: "primary", minutes: 300, used: 0.42, resetsAt: NOW + 2 * HOUR + 10 * 60_000 },
    ]),
  };
  const [use] = planUses({ byEngine: [row("codex", { turns: 5, input: 10, output: 1 })] }, kindOf, plans, NOW);
  assert.equal(use.plan, "Pro");
  assert.deepEqual(
    use.windows.map((w) => [w.label, w.used, w.reset]),
    [
      ["5-hour limit", "42% used", "Resets in 2 h 10 min"],
      ["Weekly limit", "12% used", "Resets in 3 h"],
    ],
    "shortest window first, as the Limits card has them",
  );
  assert.equal(planTitle(use.plan), "Your Pro plan");
});

test("no reading, or only windows that have reset since, is no current reading", () => {
  const used = row("codex", { turns: 5, input: 10, output: 1 });
  const none = planUses({ byEngine: [used] }, kindOf, {}, NOW)[0];
  assert.deepEqual(none.windows, [], "the server keeps readings in memory, and a restart forgets them");
  assert.equal(none.plan, null);
  assert.equal(planTitle(none.plan), "Your plan");
  assert.deepEqual(planUses({ byEngine: [used] }, kindOf, null, NOW)[0].windows, [], "an unanswered request is no reading either");
  const stale = { codex: reading([{ id: "primary", minutes: 300, used: 0.9, resetsAt: NOW - 1 }]) };
  assert.deepEqual(planUses({ byEngine: [used] }, kindOf, stale, NOW)[0].windows, [], "a window that has started again says nothing now");
});

test("the words for a plan say what is missing, and keep the account apart from the workspace", () => {
  const line = noPlanReading("Codex");
  assert.match(line, /^Codex /);
  assert.match(line, /no dollar figure/);
  assert.match(line, /no current reading/);
  assert.match(accountWide(), /outside this workspace/);
  assert.match(seePlanTitle("Codex"), /in Limits/);
  for (const words of [line, accountWide(), seePlanTitle("Codex"), planTitle("Pro"), planTitle(null)]) {
    assert.doesNotMatch(words, /[\u2013\u2014]/);
  }
});

test("the page's links to a plan land on the Plans group", () => {
  const source = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
  const limits = source("../src/components/usage/UsageLimits.tsx");
  const page = source("../src/components/UsagePage.tsx");
  assert.match(limits, /<Group id=\{PLANS_ID\} title=\{t\("usageLimits.plans"\)\}/, "the Plans group lost its anchor");
  assert.match(page, /getElementById\(PLANS_ID\)/, "the page no longer scrolls to the Plans group");
  // one reading for the page, so the headline and Limits never disagree
  assert.equal((limits.match(/"\/api\/plan-usage"/g) ?? []).length, 1);
  assert.doesNotMatch(page, /"\/api\/plan-usage"/);
});
