// What happens to the person's words sent while the agent works, end to
// end (server/delivery.ts): Automatic reads them, a correction goes into
// the running turn, anything else waits for it, a stop stops it, and
// one tap goes the other way, before sending or after.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { startHarness, type Harness } from "./helpers/server.ts";

const waitFor = async <T,>(check: () => Promise<T | null | undefined> | T | null | undefined, ms = 20_000): Promise<T | null> => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const value = await check();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
};

/** A stand-in Claude Code that reads stdin a line at a time and keeps
 * what each process heard in heard-<n>. Each turn says "Working on it"
 * and then takes any words it is handed until the test writes `finish`,
 * so a turn is running for exactly as long as the test needs it to. */
function workspace(config: Record<string, unknown> = {}) {
  const home = mkdtempSync(join(tmpdir(), "bloks-delivery-"));
  mkdirSync(join(home, ".bloks"), { recursive: true });
  writeFileSync(
    join(home, ".bloks", "config.json"),
    JSON.stringify({ instances: { claude: { driver: "claudeAgent", config: { cli: join(home, "fake-claude.mjs") } } }, ...config }),
  );
  const cli = `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("2.1.299 (Claude Code)"); process.exit(0); }
if (args[0] === "auth") { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
const home = ${JSON.stringify(home)};
const n = (existsSync(home + "/spawns") ? Number(readFileSync(home + "/spawns", "utf8")) : 0) + 1;
writeFileSync(home + "/spawns", String(n));
const out = (frame) => console.log(JSON.stringify(frame));
const lines = [];
let wake = null;
let buf = "";
process.stdin.on("data", (c) => {
  buf += c;
  for (let i = buf.indexOf("\\n"); i >= 0; i = buf.indexOf("\\n")) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const frame = JSON.parse(line);
    if (frame.type !== "user") continue;
    const words = String(frame.message?.content ?? "");
    appendFileSync(home + "/heard-" + n, words + "\\n");
    lines.push(words);
  }
  wake?.();
});
const next = async (ms) => {
  const until = Date.now() + ms;
  while (!lines.length && Date.now() < until) await new Promise((r) => { wake = r; setTimeout(r, 50); });
  return lines.shift() ?? null;
};
await next(10000);
out({ type: "system", subtype: "init", session_id: "sess-delivery", model: "claude-sonnet-5" });
out({ type: "assistant", message: { content: [{ type: "text", text: "Working on it" + (n > 1 ? " " + n : "") }] } });
for (let i = 0; i < 200 && !existsSync(home + "/finish-" + n); i++) await next(100);
out({ type: "result", subtype: "success", is_error: false, num_turns: 1, duration_api_ms: 1, total_cost_usd: 0, session_id: "sess-delivery", result: "Done" });
`;
  writeFileSync(join(home, "fake-claude.mjs"), cli, { mode: 0o755 });
  return home;
}

const messages = async (h: Harness, bot: { id: string }) => (await h.json(`/api/bots/${bot.id}/messages?limit=100`)).messages as any[];
const busy = async (h: Harness, bot: { id: string }) => Boolean((await h.json("/api/bots?messages=0")).bots.find((b: any) => b.id === bot.id)?.busy);
const heard = (home: string, n: number) => (existsSync(join(home, `heard-${n}`)) ? readFileSync(join(home, `heard-${n}`), "utf8") : "");
const spawns = (home: string) => (existsSync(join(home, "spawns")) ? Number(readFileSync(join(home, "spawns"), "utf8")) : 0);
const finish = (home: string, n: number) => writeFileSync(join(home, `finish-${n}`), "1");

async function boot(t: TestContext, config?: Record<string, unknown>) {
  const home = workspace(config);
  const h = await startHarness({ HOME: home });
  t.after(async () => {
    await h.stop();
    rmSync(home, { recursive: true, force: true });
  });
  const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Research Analyst" }) });
  await h.fetch(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } }) });
  return { home, h, bot: bot as { id: string } };
}

/** Starts a turn and waits until it is running. */
async function working(h: Harness, bot: { id: string }, n = 1) {
  await h.fetch(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: `TASK ${n}` }) });
  const said = n > 1 ? `Working on it ${n}` : "Working on it";
  assert.ok(await waitFor(async () => (await messages(h, bot)).some((m) => m.text === said)), "the turn never started");
}

const send = (h: Harness, bot: { id: string }, text: string, extra: Record<string, unknown> = {}) =>
  h.json(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text, ...extra }) });

test("Automatic: a correction goes into the running turn, anything else waits for it", async (t) => {
  const { home, h, bot } = await boot(t);
  await working(h, bot);

  // before sending, the composer is told which way it will go
  const preview = await h.json(`/api/bots/${bot.id}/delivery`, { method: "POST", body: JSON.stringify({ text: "also draft a summary" }) });
  assert.deepEqual([preview.busy, preview.mode, preview.route, preview.line], [true, "auto", "queue", "Will wait until Research Analyst finishes"]);

  const later = await send(h, bot, "also draft a summary");
  assert.equal(later.queued, true);
  assert.deepEqual(later.delivery, { route: "queued", why: "other", line: "Queued until Research Analyst finishes" });

  const correction = await send(h, bot, "no, use the 2024 numbers");
  assert.equal(correction.steered, true, "a correction waited behind the work it corrects");
  assert.equal(correction.delivery.line, "Interrupted to take your correction");
  assert.ok(await waitFor(() => heard(home, 1).includes("no, use the 2024 numbers")), "the turn never heard the correction");
  assert.ok(!heard(home, 1).includes("also draft a summary"), "the turn was handed work meant for after it");

  const list = await messages(h, bot);
  const waiting = list.find((m) => m.text === "also draft a summary");
  assert.equal(waiting.queued, true);
  assert.equal(waiting.delivery.line, "Queued until Research Analyst finishes");
  const joined = list.find((m) => m.text === "no, use the 2024 numbers");
  assert.equal(joined.midTurn, true);
  assert.equal(joined.delivery.route, "steered");

  // the turn ends, and what waited starts the next one
  finish(home, 1);
  assert.ok(await waitFor(() => heard(home, 2).includes("also draft a summary")), "what waited never got its turn");
  finish(home, 2);
  assert.ok(await waitFor(async () => !(await busy(h, bot))));
  assert.equal(spawns(home), 2);
});

test("a stop stops the turn, and one tap sends the other way", async (t) => {
  const { home, h, bot } = await boot(t);
  await working(h, bot);

  // the tap before sending: a correction held back, ordinary words sent in
  const held = await send(h, bot, "actually make it blue", { delivery: "wait" });
  assert.equal(held.queued, true);
  assert.equal(held.delivery.why, "you");
  const pushed = await send(h, bot, "add a chart too", { delivery: "now" });
  assert.equal(pushed.steered, true);
  assert.equal(pushed.delivery.line, "Sent now, as you asked");
  assert.ok(await waitFor(() => heard(home, 1).includes("add a chart too")));

  // the tap after: what waits goes into the turn now, as itself
  const now = await h.json(`/api/bots/${bot.id}/queued/now`, { method: "POST", body: "{}" });
  assert.equal(now.outcome, "steered");
  assert.ok(await waitFor(() => heard(home, 1).includes("actually make it blue")), "send now did not reach the running turn");
  const blue = (await messages(h, bot)).filter((m) => m.text === "actually make it blue");
  assert.equal(blue.length, 1, "it went in as a second copy rather than as itself");
  assert.equal(blue[0].queued, false);
  assert.equal(blue[0].midTurn, true);
  assert.equal(blue[0].delivery.line, "Sent now, as you asked");

  // a stop stops, and is what the next turn hears
  const stop = await send(h, bot, "stop");
  assert.equal(stop.queued, true);
  assert.equal(stop.delivery.line, "Stopped Research Analyst");
  assert.ok(await waitFor(() => heard(home, 2).includes("stop")), "the stop did not start the next turn");
  assert.ok(!existsSync(join(home, "finish-1")), "the first turn ended on its own rather than being stopped");
  finish(home, 2);
  assert.ok(await waitFor(async () => !(await busy(h, bot))));
});

test("Send now for one waiting message leaves the rest waiting, in their order", async (t) => {
  const { home, h, bot } = await boot(t);
  await working(h, bot);
  const first = await send(h, bot, "also draft a summary");
  const second = await send(h, bot, "then email it to the team");
  const third = await send(h, bot, "and book the room for Friday");
  assert.deepEqual([first.queued, second.queued, third.queued], [true, true, true]);
  const id = (text: string) => async () => (await messages(h, bot)).find((m) => m.text === text)?.id;

  // the one picked goes into the turn as itself, the others stay put
  const picked = await id("then email it to the team")();
  const now = await h.json(`/api/bots/${bot.id}/queued/now`, { method: "POST", body: JSON.stringify({ messageId: picked }) });
  assert.equal(now.outcome, "steered");
  assert.ok(await waitFor(() => heard(home, 1).includes("then email it to the team")), "the picked message did not reach the turn");
  assert.ok(!heard(home, 1).includes("also draft a summary"), "an older message went with it");
  assert.ok(!heard(home, 1).includes("and book the room"), "a newer message went with it");
  const list = await messages(h, bot);
  const sent = list.filter((m) => m.text === "then email it to the team");
  assert.equal(sent.length, 1, "it went in as a second copy rather than as itself");
  assert.equal(sent[0].midTurn, true);
  assert.equal(sent[0].delivery.line, "Sent now, as you asked");
  assert.equal(list.find((m) => m.text === "also draft a summary").queued, true);
  assert.equal(list.find((m) => m.text === "and book the room for Friday").queued, true);

  // asked again, it has gone already: nothing is sent twice
  const again = await h.json(`/api/bots/${bot.id}/queued/now`, { method: "POST", body: JSON.stringify({ messageId: picked }) });
  assert.equal(again.outcome, "nothing");
  assert.equal((await messages(h, bot)).filter((m) => m.text === "then email it to the team").length, 1);

  // the turn ends, and the rest start the next one in the order they were said
  finish(home, 1);
  assert.ok(await waitFor(() => heard(home, 2).includes("and book the room for Friday")), "what still waited never got its turn");
  const next = heard(home, 2);
  assert.ok(next.indexOf("also draft a summary") < next.indexOf("and book the room for Friday"), "the waiting messages lost their order");
  assert.ok(!next.includes("then email it to the team"), "the message sent now was sent again");
  finish(home, 2);
  assert.ok(await waitFor(async () => !(await busy(h, bot))));
});

test("Queue and Interrupt, for one agent or for the workspace", async (t) => {
  const { home, h, bot } = await boot(t, { delivery: { mode: "interrupt" } });
  assert.equal((await h.json("/api/config")).delivery.mode, "interrupt");
  await working(h, bot);

  // the workspace says Interrupt: ordinary words go in now
  const inNow = await send(h, bot, "also draft a summary");
  assert.equal(inNow.steered, true);
  assert.equal(inNow.delivery.why, "setting");

  // the agent's own Queue outranks it, corrections included
  assert.equal((await h.fetch(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ delivery: "queue" }) })).status, 200);
  const waits = await send(h, bot, "no, the other folder");
  assert.equal(waits.queued, true);
  assert.equal(waits.delivery.why, "setting");
  assert.ok(!heard(home, 1).includes("the other folder"));

  // back to the workspace's
  assert.equal((await h.fetch(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ delivery: null }) })).status, 200);
  assert.equal((await h.json("/api/bots?messages=0")).bots.find((b: any) => b.id === bot.id).delivery, undefined);
  assert.equal((await h.fetch(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ delivery: "sometimes" }) })).status, 400);
  assert.equal((await h.fetch("/api/config", { method: "PUT", body: JSON.stringify({ delivery: { mode: "loud" } }) })).status, 400);
  assert.equal((await h.fetch("/api/config", { method: "PUT", body: JSON.stringify({ delivery: { mode: "queue" } }) })).status, 200);
  assert.equal((await h.json("/api/config")).delivery.mode, "queue");
  finish(home, 1);
  finish(home, 2);
  assert.ok(await waitFor(async () => !(await busy(h, bot))));
});
