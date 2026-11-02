// What an engine's plan has left (GitHub 224): read from the engine's
// own side-channel, kept per engine in memory, and shown only to the
// person at this Mac. Never to a phone, a remote window or an agent, and
// never said in a prompt.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudePlanUsage, codexPlanUsage, planNotices } from "../server/plan-usage.ts";
import type { PlanWindow } from "../server/contracts.ts";
import { startHarness, type Harness } from "./helpers/server.ts";
import { waitFor } from "./helpers/turns.ts";

const NOW = 1_800_000_000_000;
const FIVE_HOURS = 1_800_003_600;
const WEEK = 1_800_400_000;

const unified = (fiveHour: number, sevenDay: number, extra: Record<string, unknown> = {}) => ({
  status: "allowed",
  resetsAt: FIVE_HOURS,
  rateLimitType: "five_hour",
  unifiedWindows: {
    five_hour: { utilization: fiveHour, resetsAt: FIVE_HOURS },
    seven_day: { utilization: sevenDay, resetsAt: WEEK },
  },
  ...extra,
});

test("Claude Code's unified windows become shares and resets in milliseconds", () => {
  const plan = claudePlanUsage(unified(0.42, 0.13), null, NOW);
  assert.deepEqual(plan, {
    windows: [
      { id: "five_hour", minutes: 300, used: 0.42, resetsAt: FIVE_HOURS * 1000 },
      { id: "seven_day", minutes: 10_080, used: 0.13, resetsAt: WEEK * 1000 },
    ],
    plan: null,
    at: NOW,
  });
  // a reset already in milliseconds is not multiplied again
  const ms = claudePlanUsage({ unifiedWindows: { five_hour: { utilization: 0.5, resetsAt: FIVE_HOURS * 1000 } } }, null, NOW);
  assert.equal(ms?.windows[0].resetsAt, FIVE_HOURS * 1000);
  // usage past a cap is the engine's word too, and kept
  assert.equal(claudePlanUsage(unified(1.04, 0.2), null, NOW)?.windows[0].used, 1.04);
});

test("the engine's warning belongs to the window it names, and an allowed clears it", () => {
  const warned = claudePlanUsage(unified(0.4, 0.81, { status: "allowed_warning", rateLimitType: "seven_day", surpassedThreshold: 0.75 }), null, NOW)!;
  assert.equal(warned.windows.find((w) => w.id === "seven_day")?.status, "warning");
  assert.equal(warned.windows.find((w) => w.id === "five_hour")?.status, undefined);
  const out = claudePlanUsage(unified(1, 0.81, { status: "rejected", rateLimitType: "five_hour" }), warned, NOW)!;
  assert.equal(out.windows.find((w) => w.id === "five_hour")?.status, "rejected");
  assert.equal(out.windows.find((w) => w.id === "seven_day")?.status, undefined, "every window is said again, warning or not");
});

test("an older Claude Code's one window at a time is folded into what was known", () => {
  const first = claudePlanUsage({ status: "allowed", rateLimitType: "five_hour", utilization: 0.3, resetsAt: FIVE_HOURS }, null, NOW)!;
  const both = claudePlanUsage({ status: "allowed_warning", rateLimitType: "seven_day_opus", utilization: 0.9, resetsAt: WEEK }, first, NOW + 1)!;
  assert.deepEqual(both.windows.map((w) => [w.id, w.used, w.status]), [
    ["seven_day_opus", 0.9, "warning"],
    ["five_hour", 0.3, undefined],
  ]);
  assert.equal(first.windows.length, 1, "what was known is not changed in place");
  // A frame with no share in it measures nothing, so alone it is no
  // plan. Its status still speaks for the window it names.
  const bare = { status: "allowed", resetsAt: FIVE_HOURS, rateLimitType: "five_hour", overageStatus: "rejected", isUsingOverage: false };
  assert.equal(claudePlanUsage(bare, null, NOW), null);
  assert.deepEqual(claudePlanUsage(bare, both, NOW + 2)?.windows, both.windows);
  const stopped = claudePlanUsage({ ...bare, status: "rejected" }, both, NOW + 3)!;
  assert.deepEqual(stopped.windows.map((w) => [w.id, w.used, w.status]), [
    ["seven_day_opus", 0.9, "warning"],
    ["five_hour", 0.3, "rejected"],
  ]);
  for (const nonsense of [null, undefined, "five_hour", 42, { unifiedWindows: { five_hour: { utilization: "0.4" } } }, { unifiedWindows: { five_hour: { utilization: -1 } } }]) {
    assert.equal(claudePlanUsage(nonsense, both, NOW), both, JSON.stringify(nonsense));
  }
});

test("Codex's primary and secondary windows are percents, read as shares", () => {
  const plan = codexPlanUsage(
    {
      limitId: "codex",
      primary: { usedPercent: 37, windowDurationMins: 300, resetsAt: FIVE_HOURS },
      secondary: { usedPercent: 8.5, windowDurationMins: 10_080, resetsAt: WEEK },
      planType: "pro",
    },
    NOW,
  );
  assert.deepEqual(plan, {
    windows: [
      { id: "primary", minutes: 300, used: 0.37, resetsAt: FIVE_HOURS * 1000 },
      { id: "secondary", minutes: 10_080, used: 0.085, resetsAt: WEEK * 1000 },
    ],
    plan: "pro",
    at: NOW,
  });
  // a plan with one window, and one that says when it resets but not how long it is
  assert.deepEqual(codexPlanUsage({ primary: { usedPercent: 0, windowDurationMins: null, resetsAt: null }, secondary: null }, NOW), {
    windows: [{ id: "primary", minutes: null, used: 0, resetsAt: null }],
    plan: null,
    at: NOW,
  });
  for (const nonsense of [null, {}, { primary: { usedPercent: "37" } }, { primary: null, secondary: { usedPercent: -3 } }]) {
    assert.equal(codexPlanUsage(nonsense, NOW), null, JSON.stringify(nonsense));
  }
});

// ── the notice above the composer ──────────────────────────────────────

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const planOf = (...windows: PlanWindow[]) => ({ windows, plan: null, at: NOW });
/** A window of this many minutes with `elapsed` of it gone by now. */
const windowAt = (id: string, minutes: number, used: number, elapsed: number, extra: Partial<PlanWindow> = {}): PlanWindow => ({
  id,
  minutes,
  used,
  resetsAt: NOW + Math.round((1 - elapsed) * minutes * 60_000),
  ...extra,
});

test("a window at its limit stops and near it warns, in the few words Bloks AI uses", () => {
  const out = windowAt("five_hour", 300, 1, 0.5);
  assert.deepEqual(planNotices("claude", planOf(out), NOW), [
    { id: `claude:five_hour:stop:${out.resetsAt}`, source: "claude", level: "stop", title: "5-hour limit: Limit reached", usedPercent: 100, resetsAt: out.resetsAt, planWindow: { id: "five_hour", minutes: 300 } },
  ]);
  // the engine's own word counts as much as the share, either way
  const rejected = planNotices("claude", planOf(windowAt("seven_day", 10_080, 0.6, 0.9, { status: "rejected" })), NOW);
  assert.deepEqual([rejected[0].level, rejected[0].title, rejected[0].usedPercent], ["stop", "Weekly limit: Limit reached", 60]);
  const warned = planNotices("claude", planOf(windowAt("seven_day", 10_080, 0.7, 0.9, { status: "warning" })), NOW);
  assert.deepEqual([warned[0].level, warned[0].title], ["warn", "Weekly limit: Approaching limit"]);
  const near = planNotices("codex", planOf(windowAt("primary", 300, 0.8, 0.95)), NOW);
  assert.deepEqual([near[0].source, near[0].level, near[0].title, near[0].usedPercent], ["codex", "warn", "5-hour limit (primary): Approaching limit", 80]);
  // over the cap is said as all of it
  assert.equal(planNotices("claude", planOf(windowAt("five_hour", 300, 1.04, 0.5)), NOW)[0].usedPercent, 100);
  // a window of no known length or reset still says it is used up
  assert.deepEqual(planNotices("codex", planOf({ id: "primary", minutes: null, used: 1, resetsAt: null }), NOW).map((n) => [n.title, n.resetsAt]), [["Limit (primary): Limit reached", null]]);
});

test("pace is a share used ahead of the share of the window gone by", () => {
  // 60% of the week used with half of it gone: on pace to run out early
  const week = windowAt("seven_day", 10_080, 0.6, 0.5);
  assert.deepEqual(planNotices("claude", planOf(week), NOW), [
    { id: `claude:seven_day:info:${week.resetsAt}`, source: "claude", level: "info", title: "Weekly limit: Approaching limit", usedPercent: 60, resetsAt: week.resetsAt, planWindow: { id: "seven_day", minutes: 10_080 } },
  ]);
  assert.equal(planNotices("codex", planOf(windowAt("primary", 300, 0.3, 0.2)), NOW)[0]?.level, "info");
  // and these are not
  const quiet: Array<[string, PlanWindow]> = [
    ["used in step with the time gone", windowAt("seven_day", 10_080, 0.5, 0.5)],
    ["behind the time gone", windowAt("seven_day", 10_080, 0.3, 0.6)],
    ["too little used to matter, however fast", windowAt("seven_day", 10_080, 0.2, 0.1)],
    ["too early in the window to say", windowAt("five_hour", 300, 0.3, 0.05)],
    ["no length to measure against", { id: "primary", minutes: null, used: 0.7, resetsAt: NOW + HOUR }],
    ["no reset to measure from", { id: "primary", minutes: 300, used: 0.7, resetsAt: null }],
    ["a reset further off than the window is long", { id: "primary", minutes: 300, used: 0.7, resetsAt: NOW + DAY }],
    ["nothing used", windowAt("seven_day", 10_080, 0, 0.9)],
  ];
  for (const [why, window] of quiet) assert.deepEqual(planNotices("claude", planOf(window), NOW), [], why);
});

test("simultaneous plan limits retain their reported window and model in the wire and fallback titles", () => {
  const windows = [
    windowAt("five_hour", 300, 1, 0.5),
    windowAt("seven_day", 10_080, 1, 0.5),
    windowAt("seven_day_opus", 10_080, 1, 0.5),
    windowAt("seven_day_sonnet", 10_080, 1, 0.5),
    windowAt("primary", 90, 1, 0.5),
    windowAt("secondary", 90, 1, 0.5),
    { id: "model_new", minutes: null, used: 1, resetsAt: null },
  ];
  const notices = planNotices("example", planOf(...windows), NOW);
  assert.deepEqual(notices.map((n) => n.planWindow), windows.map(({ id, minutes }) => ({ id, minutes })));
  assert.deepEqual(notices.map((n) => n.title), [
    "5-hour limit: Limit reached", "Weekly limit: Limit reached", "Weekly limit, Opus: Limit reached",
    "Weekly limit, Sonnet: Limit reached", "90-minute limit (primary): Limit reached",
    "90-minute limit (secondary): Limit reached", "Limit (model_new): Limit reached",
  ]);
  assert.equal(new Set(notices.map((n) => n.id)).size, windows.length);
});

test("fallback titles keep severity and avoid misleading or unbounded window metadata", () => {
  const exhausted = { id: "seven_day", minutes: 10_080, used: 1, resetsAt: null };
  const warn = { ...exhausted, id: "seven_day_opus", used: 0.81 };
  const info = windowAt("five_hour", 300, 0.6, 0.5);
  const result = planNotices("claude", planOf(exhausted, warn, info), NOW);
  assert.deepEqual(result.map((n) => [n.level, n.title]), [
    ["stop", "Weekly limit: Limit reached"],
    ["warn", "Weekly limit, Opus: Approaching limit"],
    ["info", "5-hour limit: Approaching limit"],
  ]);
  // details that cannot be used keep the old title, with no label at all
  for (const minutes of [0, -1, NaN, Infinity, 1.5, 300]) {
    const invalid = { ...exhausted, minutes };
    const notice = planNotices("claude", planOf(invalid), NOW)[0];
    assert.equal(notice.title, "Limit reached");
    assert.equal(notice.id, "claude:seven_day:stop:null");
    assert.equal(notice.level, "stop");
  }
  assert.equal(planNotices("claude", planOf({ ...warn, minutes: 300 }), NOW)[0].title, "Approaching limit");
  const unknown = { ...exhausted, id: "<unknown>" + "x".repeat(200), minutes: null };
  const title = planNotices("claude", planOf(unknown), NOW)[0].title;
  assert.equal(title, `Limit (${unknown.id.slice(0, 80)}): Limit reached`);
  // the bound counts characters, so it never splits one in two
  const wide = { ...exhausted, id: "x".repeat(79) + "\u{1F600}tail", minutes: null };
  assert.equal(planNotices("claude", planOf(wide), NOW)[0].title, `Limit (${"x".repeat(79)}\u{1F600}): Limit reached`);
  const control = planNotices("claude", planOf({ ...exhausted, id: "\u0000seven_day_opus", minutes: null }), NOW)[0];
  assert.equal(control.title, "Limit (seven_day_opus): Limit reached", "a sanitized unknown ID must not acquire model scope");
});

test("one line per window, the worst first, and nothing from a window already reset", () => {
  const notices = planNotices(
    "claude",
    planOf(
      windowAt("five_hour", 300, 0.45, 0.3),
      windowAt("seven_day", 10_080, 0.82, 0.6),
      windowAt("seven_day_opus", 10_080, 1, 0.7),
      { id: "seven_day_sonnet", minutes: 10_080, used: 1, resetsAt: NOW - 1, status: "rejected" },
    ),
    NOW,
  );
  assert.deepEqual(
    notices.map((n) => [n.id.split(":")[1], n.level]),
    [
      ["seven_day_opus", "stop"],
      ["seven_day", "warn"],
      ["five_hour", "info"],
    ],
  );
  // the id moves with the level and the window, so a dismissal holds only as long as the news does
  const warn = planNotices("claude", planOf(windowAt("seven_day", 10_080, 0.82, 0.6)), NOW)[0].id;
  const worse = planNotices("claude", planOf(windowAt("seven_day", 10_080, 1, 0.6)), NOW)[0].id;
  const next = planNotices("claude", planOf(windowAt("seven_day", 10_080, 0.82, 0.0001)), NOW)[0]?.id;
  assert.notEqual(warn, worse);
  assert.notEqual(warn, next);
  for (const nothing of [null, undefined, { windows: "x" }, planOf()]) {
    assert.deepEqual(planNotices("claude", nothing as any, NOW), []);
  }
  assert.deepEqual(planNotices("claude", planOf({ id: "five_hour", minutes: 300, used: Number.NaN, resetsAt: null }), NOW), []);
});

// ── through the server, with engines that are fixtures ─────────────────

function home(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(dir, ".bloks"));
  return dir;
}

async function agentOn(h: Harness, instanceId: string, model: string) {
  const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Planner" }) });
  await h.fetch(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId, model } }) });
  return bot;
}

/** Send, and wait for the agent's answer and for its lane to be free. */
async function say(h: Harness, botId: string, text: string) {
  const answers = async () =>
    (await h.json(`/api/bots/${botId}/messages?limit=200`)).messages.filter((m: any) => m.role === "bot" && m.text === "Done").length;
  const before = await answers();
  const sent = await h.fetch(`/api/bots/${botId}/messages`, { method: "POST", body: JSON.stringify({ text }) });
  assert.ok(sent.ok, `sending failed: ${sent.status}`);
  const finished = await waitFor(async () => {
    const bot = (await h.json("/api/bots?messages=0")).bots.find((b: any) => b.id === botId);
    return (await answers()) > before && !bot.busy;
  }, 20_000);
  assert.ok(finished, h.logs());
}

test("Claude Code's limits reach the person at this Mac, and nobody else", async (t) => {
  const dir = home("bloks-plan-claude-");
  const runs = join(dir, "runs.jsonl");
  const cli = join(dir, "fake-claude.mjs");
  writeFileSync(runs, "");
  // Every turn reports the plan the way Claude Code 2.1.29x does. A turn
  // told ASK asks for it with its own credential, as an agent would. The
  // words and system prompt each turn was given are written down.
  writeFileSync(
    cli,
    `#!${process.execPath}
import { appendFileSync, readFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("2.1.299 (Claude Code)"); process.exit(0); }
if (args[0] === "auth") { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
const out = (f) => console.log(JSON.stringify(f));
let input = "";
process.stdin.on("data", async function take(c) {
  input += c;
  const frame = input.split("\\n").slice(0, -1).filter(Boolean).map(JSON.parse).find((f) => f.type === "user");
  if (!frame) return;
  process.stdin.off("data", take);
  const said = typeof frame.message.content === "string" ? frame.message.content : JSON.stringify(frame.message.content);
  const at = args.indexOf("--append-system-prompt-file");
  const system = at >= 0 ? readFileSync(args[at + 1], "utf8") : "";
  let asked = null;
  if (said.includes("ASK")) {
    const res = await fetch(process.env.BLOKS_URL + "/api/plan-usage", { headers: { authorization: "Bearer " + process.env.BLOKS_TOKEN } });
    asked = res.status;
  }
  appendFileSync(${JSON.stringify(runs)}, JSON.stringify({ said, system, asked }) + "\\n");
  out({ type: "system", subtype: "init", session_id: "plan-session", model: "claude-sonnet-5" });
  out({ type: "rate_limit_event", rate_limit_info: ${JSON.stringify(unified(0.42, 0.81, { status: "allowed_warning", rateLimitType: "seven_day", surpassedThreshold: 0.75 }))}, session_id: "plan-session" });
  out({ type: "assistant", message: { content: [{ type: "text", text: "Done" }], usage: { input_tokens: 1000, output_tokens: 7 } } });
  out({ type: "result", subtype: "success", is_error: false, num_turns: 1, duration_api_ms: 1, session_id: "plan-session", result: "Done", total_cost_usd: 0 });
});
`,
    { mode: 0o755 },
  );
  writeFileSync(join(dir, ".bloks", "config.json"), JSON.stringify({ instances: { claude: { driver: "claudeAgent", config: { cli } } } }));
  const h = await startHarness({ HOME: dir });
  t.after(async () => {
    await h.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  const turns = () => readFileSync(runs, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));

  assert.deepEqual((await h.json("/api/plan-usage")).usage, {}, "nothing is known before the engine says");
  const bot = await agentOn(h, "claude", "claude-sonnet-5");
  await say(h, bot.id, "First");
  const { usage } = await h.json("/api/plan-usage");
  assert.deepEqual(
    usage.claude.windows.map((w: any) => [w.id, w.minutes, w.used, w.resetsAt, w.status]),
    [
      ["five_hour", 300, 0.42, FIVE_HOURS * 1000, undefined],
      ["seven_day", 10_080, 0.81, WEEK * 1000, "warning"],
    ],
  );

  // an agent asking with its own credential is turned away, and what it
  // was told about itself has nothing of the plan in it
  await say(h, bot.id, "ASK about the plan");
  const asked = turns()[1];
  assert.equal(asked.asked, 403, "an agent read the person's plan");
  for (const run of turns()) {
    assert.doesNotMatch(run.said + run.system, /five_hour|seven_day|\b42%|\b81%|plan usage/i, "the plan reached a prompt");
  }

  // the person's own paired phone reads it, as it would here (GitHub 259)
  await h.fetch("/api/pair", { method: "PUT", body: JSON.stringify({ enabled: true }) });
  const started = await h.json("/api/pair/start", { method: "POST" });
  const paired = await h.fetchRemote("/api/pair/claim", { method: "POST", body: JSON.stringify({ code: started.code, device: "Test iPhone" }) });
  assert.ok(paired.body?.token, "the fixture phone did not pair");
  assert.equal((await h.fetchRemote("/api/bots", { token: paired.body.token })).status, 200, "the paired phone is not paired");
  const onPhone = await h.fetchRemote("/api/plan-usage", { token: paired.body.token });
  assert.equal(onPhone.status, 200);
  assert.deepEqual(onPhone.body.usage, (await h.json("/api/plan-usage")).usage, "the paired phone read something else");
  assert.ok(onPhone.body.usage.claude, "the paired phone was told nothing");
  // a device nobody paired does not
  assert.equal((await h.fetchRemote("/api/plan-usage", { token: "not-a-token" })).status, 401);
});

test("Codex's limits, which name no thread, are kept for the engine", async (t) => {
  const dir = home("bloks-plan-codex-");
  const cli = join(dir, "fake-codex.mjs");
  writeFileSync(
    cli,
    `#!${process.execPath}
import { createInterface } from "node:readline";
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("codex-cli 9.9.9"); process.exit(0); }
if (args[0] === "login") { console.log("Logged in using ChatGPT"); process.exit(0); }
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (!m.method) return;
  if (m.method === "model/list") return send({ id: m.id, result: { data: [{ id: "gpt-6.1-sol", model: "gpt-6.1-sol", displayName: "GPT-6.1-Sol", isDefault: true, hidden: false }] } });
  if (m.method === "thread/start" || m.method === "thread/resume") return send({ id: m.id, result: { thread: { id: "thread-1" }, model: "gpt-6.1-sol" } });
  if (m.method === "turn/start") {
    send({ id: m.id, result: { turn: { id: "turn-1", status: "inProgress" } } });
    send({ method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-1", status: "inProgress" } } });
    send({ method: "account/rateLimits/updated", params: { rateLimits: {
      limitId: "codex",
      primary: { usedPercent: 37, windowDurationMins: 300, resetsAt: ${FIVE_HOURS} },
      secondary: { usedPercent: 8, windowDurationMins: 10080, resetsAt: ${WEEK} },
      planType: "pro",
    } } });
    send({ method: "item/completed", params: { threadId: "thread-1", item: { type: "agentMessage", id: "a", text: "Done" } } });
    return send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } });
  }
  if (m.id !== undefined) send({ id: m.id, result: {} });
});
`,
    { mode: 0o755 },
  );
  writeFileSync(join(dir, ".bloks", "config.json"), JSON.stringify({ instances: { codex: { driver: "codex", config: { cli } } } }));
  const h = await startHarness({ HOME: dir });
  t.after(async () => {
    await h.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  const bot = await agentOn(h, "codex", "gpt-6.1-sol");
  await say(h, bot.id, "Hello");
  const { usage } = await h.json("/api/plan-usage");
  assert.deepEqual(usage.codex, {
    windows: [
      { id: "primary", minutes: 300, used: 0.37, resetsAt: FIVE_HOURS * 1000 },
      { id: "secondary", minutes: 10_080, used: 0.08, resetsAt: WEEK * 1000 },
    ],
    plan: "pro",
    at: usage.codex.at,
  });
});
