// The line above the composer about a limit (GET /api/usage-notices):
// each conversation hears only about what it runs on, Bloks AI's notice
// in the service's own words and an engine's from its plan windows,
// worst first; the person and their paired phone read them and the
// balance behind them, an agent never does. Then how the app says when
// one resets and remembers which were put away (src/lib/usageNotice.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startHarness, type Harness } from "./helpers/server.ts";
import { waitFor } from "./helpers/turns.ts";
import { startFakeCredits, type FakeCredits } from "./helpers/fake-credits.ts";
import { noticeCountsDown, noticeLine, noticeSource, noticeTitle, noticeToShow, planResetLine, readDismissed, readNotices, resetLine, saveDismissed, withDismissed, type UsageNotice } from "../src/lib/usageNotice.ts";
import { setLanguage } from "../src/lib/i18n.ts";
import { planNotices } from "../server/plan-usage.ts";

const LICENCE = `blok_live_${"e".repeat(32)}`;

async function tokenFrom(fake: FakeCredits): Promise<string> {
  const res = await fetch(`${fake.base}/token`, { method: "POST", headers: { authorization: `Bearer ${LICENCE}` } });
  return ((await res.json()) as { token: string }).token;
}

async function agentOn(h: Harness, name: string, instanceId: string, model: string) {
  const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name }) });
  const ok = await h.fetch(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId, model } }) });
  assert.equal(ok.status, 200);
  return bot as { id: string; threadId: string };
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

test("each conversation hears about what it runs on, the person and their phone read it, and an agent never does", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "bloks-usage-notices-"));
  mkdirSync(join(dir, ".bloks"));
  const runs = join(dir, "runs.jsonl");
  const cli = join(dir, "fake-claude.mjs");
  writeFileSync(runs, "");
  // The 5-hour window is 42% used with four fifths of it gone, which is
  // no news; the week is past the engine's own warning, three days out.
  const now = Math.floor(Date.now() / 1000);
  const fiveHour = now + 60 * 60;
  const week = now + 3 * 24 * 60 * 60;
  const plan = {
    status: "allowed_warning",
    rateLimitType: "seven_day",
    resetsAt: week,
    unifiedWindows: { five_hour: { utilization: 0.42, resetsAt: fiveHour }, seven_day: { utilization: 0.81, resetsAt: week } },
  };
  // A turn told ASK asks for the notices with its own credential, as an
  // agent would, and writes down what it was answered.
  writeFileSync(
    cli,
    `#!${process.execPath}
import { appendFileSync } from "node:fs";
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
  let asked = null;
  if (said.includes("ASK")) {
    const res = await fetch(process.env.BLOKS_URL + "/api/usage-notices", { headers: { authorization: "Bearer " + process.env.BLOKS_TOKEN } });
    asked = res.status;
  }
  appendFileSync(${JSON.stringify(runs)}, JSON.stringify({ asked }) + "\\n");
  out({ type: "system", subtype: "init", session_id: "notice-session", model: "claude-sonnet-5" });
  out({ type: "rate_limit_event", rate_limit_info: ${JSON.stringify(plan)}, session_id: "notice-session" });
  out({ type: "assistant", message: { content: [{ type: "text", text: "Done" }], usage: { input_tokens: 1000, output_tokens: 7 } } });
  out({ type: "result", subtype: "success", is_error: false, num_turns: 1, duration_api_ms: 1, session_id: "notice-session", result: "Done", total_cost_usd: 0 });
});
`,
    { mode: 0o755 },
  );
  writeFileSync(join(dir, ".bloks", "config.json"), JSON.stringify({ instances: { claude: { driver: "claudeAgent", config: { cli } } } }));

  const fake = await startFakeCredits();
  const daily = Date.now() + 5 * 60 * 60_000;
  fake.notice({ id: "day-2026-10-20:stop", level: "stop", title: "Daily limit reached", usedPercent: 100, resetsAt: daily });
  const h = await startHarness({ HOME: dir, BLOKS_CREDITS_URL: fake.base, BLOKS_CREDITS_TOKEN: await tokenFrom(fake) });
  t.after(async () => {
    await h.stop();
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const notices = async (query = "") => (await h.json(`/api/usage-notices${query}`)).notices;

  const engine = await waitFor(async () => {
    const { instances } = await h.json("/api/instances");
    return instances.find((i: any) => i.instanceId === "bloks")?.snapshot?.state === "available" ? true : null;
  });
  assert.ok(engine, "the Bloks engine is in the picker");
  const claude = await agentOn(h, "Planner", "claude", "claude-sonnet-5");
  const penny = await agentOn(h, "Penny", "bloks", "bloks-ai");
  assert.deepEqual(await notices(`?thread=${claude.threadId}`), [], "nothing is known before the engine says");
  await say(h, claude.id, "First");

  const weekMs = week * 1000;
  const claudeNotice = {
    id: `claude:seven_day:warn:${weekMs}`,
    source: "claude",
    level: "warn",
    title: "Weekly limit: Approaching limit",
    usedPercent: 81,
    resetsAt: weekMs,
    planWindow: { id: "seven_day", minutes: 10_080 },
  };
  const bloksNotice = {
    id: "day-2026-10-20:stop",
    source: "bloks-ai",
    level: "stop",
    title: "Daily limit reached",
    usedPercent: 100,
    resetsAt: daily,
  };
  // a conversation on Claude Code hears about its plan and nothing about Bloks AI
  assert.deepEqual(await notices(`?thread=${claude.threadId}`), [claudeNotice]);
  // one on Bloks AI hears the service's word and nothing about anybody's sign-in
  assert.deepEqual(await notices(`?thread=${penny.threadId}`), [bloksNotice]);
  // without a thread, all of them, worst first
  assert.deepEqual(await notices(), [bloksNotice, claudeNotice]);
  // another lane of the same agent is on the same engine, and the main
  // thread, which a phone asks with, still reads as the agent's own
  const { bot: withLane } = await h.json(`/api/bots/${claude.id}/tasks`, { method: "POST", body: JSON.stringify({ title: "Elsewhere" }) });
  const lane = withLane.tasks.find((task: any) => task.id !== claude.threadId).id;
  assert.deepEqual(await notices(`?thread=${lane}`), [claudeNotice]);
  assert.deepEqual(await notices(`?thread=${claude.threadId}`), [claudeNotice]);
  // a room is nobody's lane: an empty list, never an error
  const { blok: room } = await h.json("/api/bloks", { method: "POST", body: JSON.stringify({ name: "Room", memberIds: [claude.id, penny.id] }) });
  for (const id of new Set([room.id, room.threadId].filter(Boolean))) {
    const res = await h.fetch(`/api/usage-notices?thread=${encodeURIComponent(id)}`);
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).notices, []);
  }
  // a thread nobody has is an empty list, not an error
  const unknown = await h.fetch("/api/usage-notices?thread=no-such-thread");
  assert.equal(unknown.status, 200);
  assert.deepEqual((await unknown.json()).notices, []);
  assert.deepEqual(await notices("?thread="), []);

  // the service has nothing to say any more, and the next read of the balance hears it
  fake.notice(null);
  await h.json("/api/credits?fresh=1");
  assert.deepEqual(await notices(`?thread=${penny.threadId}`), []);

  // an agent asking with its own credential is turned away
  await say(h, claude.id, "ASK about limits");
  const turns = readFileSync(runs, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(turns.at(-1).asked, 403, "an agent read the person's notices");

  // the person's own paired phone reads them, as it would here
  await h.fetch("/api/pair", { method: "PUT", body: JSON.stringify({ enabled: true }) });
  const started = await h.json("/api/pair/start", { method: "POST" });
  const paired = await h.fetchRemote("/api/pair/claim", { method: "POST", body: JSON.stringify({ code: started.code, device: "Test iPhone" }) });
  assert.ok(paired.body?.token, "the fixture phone did not pair");
  const onPhone = await h.fetchRemote(`/api/usage-notices?thread=${claude.threadId}`, { token: paired.body.token });
  assert.equal(onPhone.status, 200);
  assert.deepEqual(onPhone.body.notices, [claudeNotice]);
  assert.equal((await h.fetchRemote("/api/usage-notices", { token: "not-a-token" })).status, 401);
  // and the Bloks AI balance behind "View usage", as shares only
  const credits = await h.fetchRemote("/api/credits", { token: paired.body.token });
  assert.equal(credits.status, 200);
  assert.deepEqual(
    [credits.body.leftPercent, credits.body.usedTodayPercent, credits.body.dailyLimitPercent, credits.body.dailyResetsAt],
    [62, 4, 150, Date.UTC(2026, 10, 19)],
  );
  assert.doesNotMatch(JSON.stringify(credits.body), /41\.17|balanceUsd|cred_/, "an amount or a token reached the phone");
  assert.ok((await h.json("/api/health")).features.includes("usage-notices"), "a phone cannot tell this server has them");
});

// ── how the app says one ───────────────────────────────────────────────

const NOTICE: UsageNotice = { id: "a", source: "claude", level: "info", title: "Approaching limit", usedPercent: 60, resetsAt: null };
const NOW = Date.UTC(2026, 9, 20, 12, 0);

test("plan reset counts down from the reported instant across midnight and at each boundary", () => {
  const midnight = Date.UTC(2026, 9, 20, 23, 45);
  assert.equal(planResetLine(midnight + 2 * 3_600_000 + 14 * 60_000, midnight), "Resets in 2 h 14 min");
  assert.equal(planResetLine(midnight + 2 * 3_600_000 + 14 * 60_000, midnight + 60_000), "Resets in 2 h 13 min");
  assert.equal(planResetLine(NOW + 60_000, NOW), "Resets in 1 min");
  assert.equal(planResetLine(NOW + 59_999, NOW), "Resets in less than 1 min");
  assert.equal(planResetLine(NOW + 1, NOW), "Resets in less than 1 min");
  assert.equal(planResetLine(NOW, NOW), "Reset time passed; status unknown");
  assert.equal(planResetLine(NOW - 1, NOW), "Reset time passed; status unknown");
  assert.equal(planResetLine(NOW + 2 * 24 * 3_600_000 + 3 * 3_600_000, NOW), "Resets in about 2 d 3 h");
  for (const invalid of [null, NaN, Infinity, 1e100]) assert.equal(planResetLine(invalid, NOW), null);
  assert.equal(planResetLine(NOW + 60_000, NaN), null);
  assert.equal(planResetLine(NOW + 60_001, NOW), "Resets in 2 min");
  assert.equal(planResetLine(NOW + 3_600_000 - 1, NOW), "Resets in 1 h");
  assert.equal(planResetLine(NOW + 3_600_000, NOW), "Resets in 1 h");
  assert.equal(planResetLine(NOW + 3_600_001, NOW), "Resets in 1 h 1 min");
  assert.equal(planResetLine(NOW + 86_400_000 - 1, NOW), "Resets in 24 h");
  assert.equal(planResetLine(NOW + 86_400_000, NOW), "Resets in about 1 d 0 h");
  // longer waits round up too, so they never read as sooner than they are
  assert.equal(planResetLine(NOW + 86_400_001, NOW), "Resets in about 1 d 1 h");
  assert.equal(planResetLine(NOW + (2 * 24 + 2) * 3_600_000 + 50 * 60_000, NOW), "Resets in about 2 d 3 h");
  assert.equal(planResetLine(NOW + 7 * 86_400_000 - 1, NOW), "Resets in about 7 d 0 h");
  // In Berlin this interval crosses the spring DST change: two elapsed hours,
  // although the wall clock advances three hours.
  const beforeDst = Date.parse("2026-03-29T01:30:00+01:00");
  const afterDst = Date.parse("2026-03-29T04:30:00+02:00");
  assert.equal(planResetLine(afterDst, beforeDst), "Resets in 2 h");
  assert.equal(planResetLine(NOW + 60_000, 1e100), null);
});

test("mixed versions and conflicting optional metadata retain the original notice", () => {
  const reset = NOW + 90 * 60_000;
  const old = { ...NOTICE, title: "Limit reached", level: "stop" as const, resetsAt: reset };
  assert.equal(noticeTitle(old, NOW), "Limit reached", "new client and old server");
  assert.equal(noticeLine(old, NOW, { timeZone: "UTC" }), "60% used · Resets today");
  const wire: UsageNotice = { ...old, title: "Weekly limit: Limit reached", planWindow: { id: "seven_day", minutes: 10_080 } };
  assert.equal(wire.title, "Weekly limit: Limit reached", "old client and new server can show identity and severity");
  assert.equal(noticeTitle(wire, NOW), wire.title, "new client does not double the fallback label");
  const model = { ...wire, title: "Weekly limit, Opus: Limit reached", planWindow: { id: "seven_day_opus", minutes: 10_080 } };
  assert.equal(noticeTitle(model, NOW), "Weekly limit, Opus: Limit reached");
  const unknown = { ...wire, title: "Limit (toString): Limit reached", planWindow: { id: "toString", minutes: null } };
  assert.equal(noticeTitle(unknown, NOW), "Limit (toString): Limit reached", "unknown names are not model scope");
  const changedName = { ...wire, title: "Limit (seven_day_opus): Limit reached", planWindow: { id: "\u0000seven_day_opus", minutes: null } };
  assert.equal(noticeTitle(changedName, NOW), changedName.title);
  const invalid: unknown[] = [
    {}, { id: "", minutes: null }, { id: "five_hour", minutes: 0 },
    { id: "five_hour", minutes: -2 }, { id: "five_hour", minutes: 1.5 },
    { id: "five_hour", minutes: NaN }, { id: "five_hour", minutes: Infinity },
    { id: "five_hour", minutes: 10_080 }, { id: "seven_day_opus", minutes: 300 },
    { id: 4, minutes: 300 }, { id: "five_hour" },
  ];
  for (const planWindow of invalid) {
    const notice = { ...wire, title: "Limit reached", planWindow } as UsageNotice;
    assert.deepEqual(readNotices({ notices: [notice] }), [notice], "valid envelope survives bad optional metadata");
    assert.equal(noticeTitle(notice, NOW), notice.title);
    assert.equal(noticeToShow([notice], []), notice);
    assert.equal(noticeToShow([notice], [notice.id]), null);
  }
  const bloks = { ...wire, source: "bloks-ai" };
  const bloksWithout = { ...bloks, planWindow: undefined };
  assert.equal(noticeTitle(bloks, NOW), noticeTitle(bloksWithout, NOW));
  assert.equal(noticeLine(bloks, NOW, { timeZone: "UTC" }), noticeLine(bloksWithout, NOW, { timeZone: "UTC" }));
  const spend = { ...wire, kind: "spend" as const };
  const spendWithout = { ...spend, planWindow: undefined };
  assert.equal(noticeTitle(spend, NOW), noticeTitle(spendWithout, NOW));
  assert.equal(noticeLine(spend, NOW, { timeZone: "UTC" }), noticeLine(spendWithout, NOW, { timeZone: "UTC" }));
  // only a plan countdown changes every minute; every other notice keeps
  // its whole status live, as before
  assert.equal(noticeCountsDown(wire), true);
  assert.equal(noticeCountsDown({ ...wire, resetsAt: NOW - 1 }), true, "the title stays live for its last-reported change");
  assert.equal(noticeCountsDown({ ...wire, resetsAt: null }), false);
  assert.equal(noticeCountsDown({ ...wire, resetsAt: 1e100 }), false);
  assert.equal(noticeCountsDown(old), false, "new client and old server");
  assert.equal(noticeCountsDown(bloks), false);
  assert.equal(noticeCountsDown(spend), false);
  for (const planWindow of invalid) assert.equal(noticeCountsDown({ ...wire, planWindow } as UsageNotice), false);
});

test("plan notice titles identify reported windows without assigning scope to other notices", () => {
  const base: UsageNotice = { ...NOTICE, level: "stop", usedPercent: 100, resetsAt: NOW + 90 * 60_000, planWindow: { id: "five_hour", minutes: 300 } };
  assert.equal(noticeTitle(base, NOW), "5-hour limit: Limit reached");
  assert.equal(noticeTitle({ ...base, planWindow: { id: "five_hour", minutes: null } }, NOW), "5-hour limit: Limit reached");
  assert.equal(noticeLine(base, NOW), "100% used · Resets in 1 h 30 min");
  const weekly = { ...base, id: "b", planWindow: { id: "seven_day_opus", minutes: 10_080 } };
  assert.equal(noticeTitle(weekly, NOW), "Weekly limit, Opus: Limit reached");
  assert.equal(noticeTitle({ ...base, planWindow: { id: "primary", minutes: 90 } }, NOW), "90-minute limit (primary): Limit reached");
  assert.equal(noticeTitle({ ...base, planWindow: { id: "secondary", minutes: 90 } }, NOW), "90-minute limit (secondary): Limit reached");
  assert.equal(noticeTitle({ ...base, planWindow: { id: "model_new", minutes: null } }, NOW), "Limit (model_new): Limit reached");
  const past = { ...base, resetsAt: NOW - 1 };
  assert.equal(noticeTitle(past, NOW), "Last reported: 5-hour limit: Limit reached");
  assert.equal(noticeLine(past, NOW), "100% used · Reset time passed; status unknown");
  assert.equal(noticeLine({ ...base, resetsAt: null }, NOW), "100% used · Reset time unknown");
  assert.equal(noticeTitle({ ...base, planWindow: { id: "", minutes: null } }, NOW), base.title);
  assert.equal(noticeTitle({ ...base, planWindow: { id: "primary", minutes: -2 } }, NOW), base.title);
  assert.equal(noticeTitle(NOTICE, NOW), NOTICE.title, "legacy and non-plan titles remain untouched");
  assert.equal(noticeTitle({ ...base, kind: "spend" }, NOW), base.title, "spending notices keep the provider's title");
  assert.equal(noticeToShow([base, weekly], []), base);
  assert.equal(noticeToShow([base, weekly], [base.id]), weekly);
  // in English the server's title for older clients and this one's agree,
  // label and severity alike, so neither reads a window differently
  const reported = [
    { id: "five_hour", minutes: 300 }, { id: "seven_day", minutes: 10_080 },
    { id: "seven_day_opus", minutes: 10_080 }, { id: "seven_day_sonnet", minutes: 10_080 },
    { id: "seven_day_overage_included", minutes: 10_080 }, { id: "primary", minutes: 90 },
    { id: "secondary", minutes: 1_440 }, { id: "model_new", minutes: 2_880 },
    { id: "other_new", minutes: null }, { id: "\u202eseven_day", minutes: 300 },
    { id: "zero_minutes", minutes: 0 },
  ].map((w, i) => ({ ...w, used: i % 2 ? 0.85 : 1, resetsAt: NOW + (i + 1) * 3_600_000 }));
  const fromServer = planNotices("claude", { windows: reported, plan: null, at: NOW }, NOW);
  assert.equal(fromServer.length, reported.length);
  for (const n of fromServer) assert.equal(noticeTitle(n, NOW), n.title, n.id);
  const conflicting = planNotices("claude", { windows: [{ id: "five_hour", minutes: 10_080, used: 1, resetsAt: NOW + 3_600_000 }], plan: null, at: NOW }, NOW);
  assert.deepEqual(conflicting.map((n) => [n.title, noticeTitle(n, NOW)]), [["Limit reached", "Limit reached"]]);
});

test("plan identity and reset are localized together", async () => {
  const notice: UsageNotice = { ...NOTICE, level: "stop", usedPercent: 100, resetsAt: NOW + 90 * 60_000, planWindow: { id: "five_hour", minutes: 300 } };
  await setLanguage("es");
  try {
    assert.equal(noticeTitle(notice, NOW), "Límite de 5 horas: Límite alcanzado");
    assert.equal(noticeLine(notice, NOW), "100 % usado · Se restablece en 1 h 30 min");
    assert.equal(planResetLine(NOW + 30_000, NOW), "Se restablece en menos de 1 min");
  } finally {
    await setLanguage("en");
  }
});

test("the second line says the day it resets, in the person's own time zone", () => {
  const utc = { locale: "en-US", timeZone: "UTC" };
  assert.equal(resetLine(null, NOW, utc), null, "nothing said, no line");
  assert.equal(resetLine(NOW - 1, NOW, utc), null, "a reset gone by says nothing");
  assert.equal(resetLine(Date.UTC(2026, 9, 20, 23, 0), NOW, utc), "Resets today");
  assert.equal(resetLine(Date.UTC(2026, 9, 21, 3, 0), NOW, utc), "Resets tomorrow");
  // more than a day off is a date, even when that date is tomorrow
  assert.equal(resetLine(Date.UTC(2026, 9, 21, 13, 0), NOW, utc), "Resets Oct 21");
  assert.equal(resetLine(Date.UTC(2026, 10, 1, 0, 0), NOW, utc), "Resets Nov 1");
  // the same instant is another day somewhere else
  const la = { locale: "en-US", timeZone: "America/Los_Angeles" };
  assert.equal(resetLine(Date.UTC(2026, 10, 1, 0, 0), NOW, la), "Resets Oct 31");
  assert.equal(resetLine(Date.UTC(2026, 9, 21, 3, 0), NOW, la), "Resets today", "8 PM the same evening there");
  const tokyo = { locale: "en-US", timeZone: "Asia/Tokyo" };
  assert.equal(resetLine(Date.UTC(2026, 9, 20, 23, 0), NOW, tokyo), "Resets tomorrow", "8 AM the next morning there");
});

test("the status reports usage and reset or top-up timing without inventing unknown values", () => {
  const utc = { locale: "en-US", timeZone: "UTC" };
  const nov = Date.UTC(2026, 10, 1, 0, 0);
  assert.equal(noticeLine({ kind: "spend", usedPercent: 84, resetsAt: nov }, NOW, utc), "84% used · Tops up Nov 1");
  assert.equal(noticeLine({ kind: "spend", usedPercent: 100, resetsAt: null }, NOW, utc), "100% used · Top-up time unknown");
  assert.equal(noticeLine({ usedPercent: 84, resetsAt: nov }, NOW, utc), "84% used · Resets Nov 1");
  assert.equal(noticeLine({ usedPercent: 84, resetsAt: null }, NOW, utc), "84% used · Reset time unknown");
  // a kind this app has never heard of reads as any other notice
  assert.equal(readNotices({ notices: [{ ...NOTICE, kind: "spend" }] })[0].kind, "spend");
});

test("only whole notices are read, and the first not put away is shown", () => {
  const stop = { ...NOTICE, id: "s", level: "stop" as const };
  assert.deepEqual(readNotices({ notices: [stop, NOTICE] }), [stop, NOTICE]);
  for (const body of [null, {}, { notices: "x" }, { error: "not found" }]) assert.deepEqual(readNotices(body), []);
  assert.deepEqual(
    readNotices({ notices: [null, { ...NOTICE, level: "danger" }, { ...NOTICE, usedPercent: "60" }, { ...NOTICE, usedPercent: undefined }, { ...NOTICE, resetsAt: "soon" }, NOTICE] }),
    [NOTICE],
  );
  assert.equal(noticeToShow([stop, NOTICE], []), stop);
  assert.equal(noticeToShow([stop, NOTICE], ["s"]), NOTICE);
  assert.equal(noticeToShow([stop, NOTICE], ["s", "a"]), null);
  assert.equal(noticeToShow([], []), null);
});

test("what was put away is kept on this device, newest last, and only so many", () => {
  const kept = new Map<string, string>();
  const storage = { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v) };
  assert.deepEqual(readDismissed(storage), []);
  let list: string[] = [];
  for (let i = 0; i < 60; i++) list = withDismissed(list, `n${i}`);
  assert.equal(list.length, 50);
  assert.equal(list[0], "n10");
  // putting one away again moves it to the end rather than keeping two
  list = withDismissed(list, "n20");
  assert.equal(list.at(-1), "n20");
  assert.equal(list.filter((id) => id === "n20").length, 1);
  saveDismissed(list, storage);
  assert.deepEqual(readDismissed(storage), list);
  // a browser that keeps nothing, or keeps rubbish, is an empty list
  const broken = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } };
  assert.deepEqual(readDismissed(broken), []);
  assert.doesNotThrow(() => saveDismissed(["x"], broken));
  assert.deepEqual(readDismissed({ getItem: () => "{not json" }), []);
  assert.deepEqual(readDismissed({ getItem: () => '["a", 4, null, "b"]' }), ["a", "b"]);
  assert.deepEqual(readDismissed(null), []);
});

test("notice identity names its reported engine and allowance, including missing and literal names", () => {
  const engines = [{ instanceId: "claude", displayName: "Claude Code" }, { instanceId: "codex", displayName: "Codex" }];
  assert.equal(noticeSource(NOTICE, engines), "Claude Code plan usage");
  assert.equal(noticeSource({ source: "codex" }, engines), "Codex plan usage");
  assert.equal(noticeSource({ source: "bloks-ai" }, engines), "Bloks AI allowance");
  assert.equal(noticeSource({ source: "claude", kind: "spend" }, engines), "Claude Code spending limit");
  assert.equal(noticeSource({ source: "missing" }, engines), "Unknown engine plan usage");
  for (const source of [undefined, null, 4, { id: "claude" }]) {
    assert.equal(noticeSource({ source: source as any }, engines), "Unknown engine plan usage");
  }
  assert.equal(noticeSource(NOTICE, [{ instanceId: "claude" } as any]), "Unknown engine plan usage");
  assert.equal(noticeSource(NOTICE, [{ instanceId: "claude", displayName: "  " }]), "Unknown engine plan usage");
  assert.equal(noticeSource(NOTICE, [{ instanceId: "claude", displayName: "<script>literal</script>" }]), "<script>literal</script> plan usage");
});

test("invalid percentages and missing or unusable reset dates remain unknown", () => {
  const format = { locale: "en-US", timeZone: "UTC" };
  for (const usedPercent of [NaN, Infinity, -1, 101, undefined as any]) {
    assert.equal(noticeLine({ usedPercent, resetsAt: null }, NOW, format), "Usage unknown · Reset time unknown");
  }
  for (const resetsAt of [null, NaN, Infinity, 1e100, NOW - 1]) {
    assert.equal(noticeLine({ usedPercent: 0, resetsAt }, NOW, format), "0% used · Reset time unknown");
    assert.equal(noticeLine({ kind: "spend", usedPercent: 100, resetsAt }, NOW, format), "100% used · Top-up time unknown");
  }
});
