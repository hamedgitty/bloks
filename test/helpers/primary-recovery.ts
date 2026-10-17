import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { startHarness, type Harness } from "./server.ts";
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Each instance has its own plan and log. Claude emits a rejected quota
// event before its synthetic assistant, as failover.test.ts does. Codex
// emits an error before any item. These are fixture order claims only.
const CLI = String.raw`#!__NODE__
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
const kind = "__KIND__", dir = "__DIR__", id = "__ID__";
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log(kind === "codex" ? "codex-cli 9.9.9" : "9.9.9 (Claude Code)"); process.exit(); }
if (args[0] === "auth") { console.log(JSON.stringify({ loggedIn: true })); process.exit(); }
if (args[0] === "login") { console.log("Logged in using ChatGPT"); process.exit(); }
const read = (name, otherwise) => existsSync(dir + "/" + name) ? JSON.parse(readFileSync(dir + "/" + name, "utf8")) : otherwise;
const write = (name, value) => { writeFileSync(dir + "/" + name + "." + process.pid + ".part", JSON.stringify(value)); renameSync(dir + "/" + name + "." + process.pid + ".part", dir + "/" + name); };
const out = (m) => console.log(JSON.stringify(m));
const epoch = read("reset.json", Math.floor(Date.now() / 1000) + 3600);
const take = (text, session) => {
  const plan = read("plan-" + id + ".json", []), outcome = plan.shift() ?? "ok";
  write("plan-" + id + ".json", plan);
  const calls = read("calls-" + id + ".json", []);
  calls.push({ text, session, outcome, at: Date.now() }); write("calls-" + id + ".json", calls);
  return outcome;
};
const later = async (outcome) => {
  if (outcome === "hold") { const until = Date.now() + 10000; while (!existsSync(dir + "/release-" + id) && Date.now() < until) await new Promise(r => setTimeout(r, 20)); }
};
const saidFor = (outcome) => outcome === "fail" ? "Connection reset by peer" : outcome === "credit" ? "Insufficient credits" : outcome === "overloaded" ? "Provider overloaded" : outcome === "relative" ? "usage limit reached, try again in 20m" : outcome === "weekly" ? "Weekly limit exceeded|" + (epoch + 3600) : "usage limit reached|" + epoch;
if (kind === "claudeAgent") {
  createInterface({ input: process.stdin }).on("line", async (line) => {
    const frame = JSON.parse(line); if (frame.type !== "user") return;
    const text = typeof frame.message.content === "string" ? frame.message.content : JSON.stringify(frame.message.content);
    const flag = args.includes("--resume") ? "--resume" : "--session-id", session = args[args.indexOf(flag) + 1];
    const outcome = take(text, session); await later(outcome);
    out({ type: "system", subtype: "init", session_id: session, model: "claude-sonnet-5" });
    const failed = !["ok", "hold"].includes(outcome), said = failed ? saidFor(outcome) : "Answered " + id;
    const events = [];
    if (["limit", "relative", "weekly"].includes(outcome)) {
      events.push("rate_limit_event");
      out({ type: "rate_limit_event", session_id: session, rate_limit_info: { status: "rejected", resetsAt: outcome === "relative" ? Math.floor(Date.now() / 1000) + 1200 : outcome === "weekly" ? epoch + 3600 : epoch, rateLimitType: outcome === "weekly" ? "seven_day" : "five_hour" } });
    }
    if (!failed || ["limit", "relative", "weekly"].includes(outcome)) {
      events.push("assistant");
      out({ type: "assistant", ...(failed ? { error: "rate_limit" } : {}), session_id: session, message: { id: "m1", model: failed ? "<synthetic>" : "claude-sonnet-5", role: "assistant", content: [{ type: "text", text: said }], usage: { input_tokens: failed ? 0 : 1, output_tokens: failed ? 0 : 1 } } });
    }
    write("events-" + id + ".json", events);
    out({ type: "result", subtype: "success", is_error: failed, num_turns: 1, duration_api_ms: 1, total_cost_usd: 0, session_id: session, result: said });
  });
} else {
  let thread = "thread-" + id + "-" + process.pid, count = 0;
  createInterface({ input: process.stdin }).on("line", async (line) => {
    const m = JSON.parse(line); if (!m.method) return;
    const methods = read("methods-" + id + ".json", []); methods.push(m.method); write("methods-" + id + ".json", methods);
    if (m.method === "model/list") return out({ id: m.id, result: { data: [{ id: "gpt-6.1-sol", model: "gpt-6.1-sol", displayName: "GPT-6.1-Sol", isDefault: true }] } });
    if (m.method === "thread/start" || m.method === "thread/resume") { thread = m.params.threadId ?? thread; return out({ id: m.id, result: { thread: { id: thread }, serviceTier: m.params.serviceTier, model: "gpt-6.1-sol" } }); }
    if (m.method === "thread/compact/start") {
      await later(take("/compact", thread));
      out({ id: m.id, result: {} });
      return out({ method: "turn/completed", params: { threadId: thread, turn: { id: "compact", status: "completed" } } });
    }
    if (m.method === "turn/start") {
      const text = (m.params.input ?? []).map(x => x.text ?? "").join("\n"), outcome = take(text, thread), turn = "turn-" + ++count;
      out({ id: m.id, result: { turn: { id: turn, status: "inProgress" } } });
      out({ method: "turn/started", params: { threadId: thread, turn: { id: turn, status: "inProgress" } } });
      await later(outcome);
      const failed = !["ok", "hold"].includes(outcome), said = failed ? saidFor(outcome) : "Answered " + id;
      write("events-" + id + ".json", failed ? ["error", "turn/completed"] : ["item/completed", "turn/completed"]);
      if (failed) out({ method: "error", params: { threadId: thread, error: { message: said }, willRetry: false } });
      else out({ method: "item/completed", params: { threadId: thread, item: { id: "a", type: "agentMessage", text: said } } });
      return out({ method: "turn/completed", params: { threadId: thread, turn: { id: turn, status: failed ? "failed" : "completed", ...(failed ? { error: { message: said } } : {}) } } });
    }
    if (m.id !== undefined) out({ id: m.id, result: {} });
  });
}
`;

type Call = { text: string; session: string; outcome: string; at: number };
const INTERVAL = 1_800, STAY = 6_000;
export function primaryRecovery(kind: "claudeAgent" | "codex") {
 describe(`${kind}: ordinary recovery`, () => {
  let home: string, h: Harness;
  const instances: Record<string, unknown> = {};

  const id = (_name: string, backup = false) => `${kind}${backup ? "-spare" : "-own"}`;
  const model = (backup = false) => (backup ? kind !== "codex" : kind === "codex") ? "gpt-6.1-sol" : "claude-sonnet-5";
  const sel = (name: string, backup = false) => ({ instanceId: id(name, backup), model: model(backup) });
  const plan = (name: string, outcomes: string[]) => writeFileSync(join(home, `plan-${id(name)}.json`), JSON.stringify(outcomes));
  const calls = (name: string, backup = false): Call[] => {
    const f = join(home, `calls-${id(name, backup)}.json`); return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : [];
  };
  const patch = async (bot: string, body: unknown) => { const r = await h.fetch(`/api/bots/${bot}`, { method: "PATCH", body: JSON.stringify(body) }); assert.equal(r.status, 200, await r.text()); };
  const bot = async (name: string, backup = true) => {
    const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: `${kind} ${name}` }) });
    await patch(bot.id, { modelSelection: sel(name), backupSelection: backup ? sel(name, true) : null }); return bot.id as string;
  };
  const me = async (bot: string) => (await h.json("/api/bots")).bots.find((b: any) => b.id === bot);
  const wait = async (check: () => Promise<boolean>, why: string) => {
    const until = Date.now() + 15_000;
    while (Date.now() < until) { if (await check()) return; await pause(30); }
    assert.fail(`${why}\n${h.logs().slice(-1500)}`);
  };
  const send = async (bot: string, words: string, name: string, backup?: boolean) => {
    const total = calls(name).length + calls(name, true).length;
    const r = await h.fetch(`/api/bots/${bot}/messages`, { method: "POST", body: JSON.stringify({ text: words }) });
    assert.ok(r.ok, await r.text());
    await wait(async () => !(await me(bot)).busy && calls(name).length + calls(name, true).length > total, "message never settled");
    if (backup !== undefined) assert.ok((backup ? calls(name, true) : calls(name)).at(-1)?.text.includes(words), "wrong engine answered the ordinary message");
  };
  const notices = async (bot: string, pattern: RegExp) => (await me(bot)).messages.filter((m: any) => m.kind === "notice" && pattern.test(m.text));
  const elapsed = async (name: string) => { const at = calls(name).at(-1)!.at; await pause(Math.max(0, at + INTERVAL + 350 - Date.now())); };
  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "bloks-primary-")); mkdirSync(join(home, ".bloks"));
    for (const name of ["test"]) for (const backup of [false, true]) {
      const instance = id(name, backup), driver = backup ? (kind === "codex" ? "claudeAgent" : "codex") : kind, cli = join(home, `${instance}.mjs`);
      writeFileSync(cli, CLI.replaceAll("__NODE__", process.execPath).replaceAll("__DIR__", home).replaceAll("__ID__", instance).replaceAll("__KIND__", driver), { mode: 0o755 });
      instances[instance] = { driver, config: { cli, permissionMode: "bypassPermissions" } };
    }
    writeFileSync(join(home, "reset.json"), JSON.stringify(Math.floor(Date.now() / 1000) + 3600));
    writeFileSync(join(home, ".bloks", "config.json"), JSON.stringify({ instances }));
    // Exercise adapter rejection and preparation Stop through the real
    // dispatch, without a production test hook or a provider request.
    const preload = join(home, "boundary.mjs");
    writeFileSync(preload, `
if (process.argv[1]?.endsWith("/server/index.ts")) {
  const { existsSync, writeFileSync, rmSync } = await import("node:fs");
  const home = ${JSON.stringify(home)};
  const timeout = globalThis.setTimeout;
  globalThis.setTimeout = function(callback, delay, ...args) {
    if (delay === 0 && existsSync(home + "/delay-next-backup")) { rmSync(home + "/delay-next-backup"); delay = ${INTERVAL + 350}; }
    return timeout(callback, delay, ...args);
  };
  const { Cooldowns } = await import(${JSON.stringify(new URL("../../server/failover.ts", import.meta.url).href)});
  const reserve = Cooldowns.prototype.reserve;
  Cooldowns.prototype.reserve = function(...args) {
    const result = reserve.apply(this, args);
    if (result) writeFileSync(home + "/reserved", "yes");
    return result;
  };
  const { Store } = await import(${JSON.stringify(new URL("../../server/store.ts", import.meta.url).href)});
  const pin = Store.prototype.pinTaskCwd;
  Store.prototype.pinTaskCwd = function(...args) {
    if (existsSync(home + "/fail-preparation")) { rmSync(home + "/fail-preparation"); throw new Error("Fixture preparation failed"); }
    return pin.apply(this, args);
  };
  const { Checkpoints } = await import(${JSON.stringify(new URL("../../server/checkpoints.ts", import.meta.url).href)});
  const begin = Checkpoints.prototype.begin;
  Checkpoints.prototype.begin = async function(...args) {
    if (existsSync(home + "/hold-preparation")) {
      rmSync(home + "/hold-preparation");
      writeFileSync(home + "/preparation-entered", "yes");
      const until = Date.now() + 10000;
      while (!existsSync(home + "/release-preparation") && Date.now() < until) await new Promise(r => setTimeout(r, 20));
    }
    return begin.apply(this, args);
  };
  for (const [url, key] of [
    [${JSON.stringify(new URL("../../server/drivers/claude.ts", import.meta.url).href)}, "ClaudeDriver"],
    [${JSON.stringify(new URL("../../server/drivers/codex.ts", import.meta.url).href)}, "CodexDriver"]
  ]) {
    const driver = (await import(url))[key], create = driver.create;
    driver.create = async function(...args) {
      const instance = await create.apply(this, args), adapter = instance.adapter, send = adapter.sendTurn;
      adapter.sendTurn = async function(turn) {
        if (existsSync(home + "/reject-send")) {
          rmSync(home + "/reject-send"); writeFileSync(home + "/rejected-text", turn.text); throw new Error("Fixture rejected dispatch");
        }
        return send.call(this, turn);
      };
      return instance;
    };
  }
}
`);
    h = await startHarness({ HOME: home, BLOKS_RETRY_INTERVAL_MS: String(INTERVAL), BLOKS_RETRY_WAIT_MS: "1200", BLOKS_BACKUP_STAY_MS: String(STAY), NODE_OPTIONS: `--import=${preload}` });
  });
  afterEach(async () => { await h?.stop(); rmSync(home, { recursive: true, force: true }); });

  test("a changed credential or restored quota answers in the own session, with one return and catch-up", async () => {
    const b = await bot("restored"); plan("restored", ["ok", "limit", "ok", "ok"]);
    await send(b, "remember heron", "restored", false);
    await send(b, "quota exhausted", "restored", true);
    const first = calls("restored")[0];
    const events = JSON.parse(readFileSync(join(home, `events-${id("restored")}.json`), "utf8"));
    assert.deepEqual(events, kind === "codex" ? ["error", "turn/completed"] : ["rate_limit_event", "assistant"]);
    assert.equal((await notices(b, /Trying again in a minute/)).length, 0);
    await send(b, "before interval", "restored", true);
    await elapsed("restored");
    await send(b, "restored now", "restored", false);
    const back = calls("restored").at(-1)!;
    assert.equal(back.session, first.session, "limit dropped the own session");
    assert.match(back.text, /before interval/);
    assert.equal((await notices(b, /is back on this conversation/)).length, 1);
    await send(b, "following turn", "restored", false);
    assert.equal((await notices(b, /is back on this conversation/)).length, 1);
    assert.equal(calls("restored", true).length, 2);
    if (kind === "codex") {
      const methods: string[] = JSON.parse(readFileSync(join(home, `methods-${id("restored")}.json`), "utf8"));
      assert.ok(!methods.includes("account/read") && !methods.includes("account/rateLimits/read"));
    }
  });
  test("backup Off success clears a standing rest, so restoring backup keeps own", async () => {
    const b = await bot("off"); plan("off", ["limit", "ok", "ok"]);
    await send(b, "exhausted", "off", true);
    await patch(b, { backupSelection: null });
    await send(b, "restored while Off", "off", false);
    await patch(b, { backupSelection: sel("off", true) });
    await send(b, "backup restored", "off", false);
  });
  test("two rejected tries keep the same reset notice, session and backup failure line", async () => {
    const b = await bot("reject"); plan("reject", ["limit", "limit", "limit"]);
    await send(b, "initial limit", "reject", true);
    const before = (await notices(b, /is out of usage/)).length;
    for (const words of ["weekly still exhausted", "exhausted account returned"]) {
      await elapsed("reject"); await send(b, words, "reject", true);
    }
    assert.equal(calls("reject").length, 3, "resting instance was never retried");
    assert.equal((await notices(b, /is out of usage/)).length, before, "unchanged reset repeated its notice");
    assert.equal((await notices(b, /is back on this conversation/)).length, 0, "a rejection announced a return");
    assert.equal(new Set(calls("reject").map(c => c.session)).size, 1);
    assert.match(calls("reject", true).at(-1)!.text, /\(A note from Bloks: an earlier attempt in this conversation failed at .+ on .+, saying:/);
    assert.match(calls("reject", true).at(-1)!.text, /usage limit reached/);
    assert.equal((await notices(b, /Trying again in a minute/)).length, 0);
  });
  test("rejected tries with a relative reset give no new notice", async () => {
    const b = await bot("creep"); plan("creep", ["relative", "relative", "relative"]);
    await send(b, "initial relative limit", "creep", true);
    const before = (await notices(b, /is out of usage/)).length;
    assert.equal(before, 1);
    for (const words of ["still limited", "limited again"]) {
      await elapsed("creep"); await send(b, words, "creep", true);
    }
    assert.equal(calls("creep").length, 3, "resting instance was never retried");
    assert.equal((await notices(b, /is out of usage/)).length, before, "a creeping relative reset repeated its notice");
    assert.equal((await notices(b, /picking this up/)).length, before, "a rejected try announced a handover again");
  });
  test("a try of a resting engine is told it is a try, not a return", async () => {
    const a = await bot("switch"), b = await bot("switch"); plan("switch", ["limit", "ok"]);
    await send(a, "rest the instance", "switch", true);
    await send(b, "moved by another lane", "switch", true);
    const moved = calls("switch", true).at(-1)!.text;
    assert.match(moved, /Bloks switched this conversation to/);
    assert.match(moved, /again now and then, at the latest on the first turn after/);
    await elapsed("switch");
    await send(b, "try the own engine", "switch", false);
    const tried = calls("switch").at(-1)!.text;
    assert.match(tried, /\(A note from Bloks: [^\n]+Bloks is trying [^\n]+ again with this message, before its expected reset/);
    assert.doesNotMatch(tried, /returns to it automatically/);
  });
  test("a restored short window cannot clear a fresh weekly rejection and its later reset", async () => {
    const b = await bot("weekly"); plan("weekly", ["limit", "weekly"]);
    await send(b, "short window exhausted", "weekly", true); await elapsed("weekly");
    await send(b, "short reset but weekly still exhausted", "weekly", true);
    assert.equal(calls("weekly").length, 2);
    assert.equal(calls("weekly").at(-1)!.outcome, "weekly");
    assert.match(calls("weekly", true).at(-1)!.text, /Weekly limit exceeded/);
    assert.equal((await notices(b, /is out of usage/)).length, 2, "fresh later reset was lost");
    await send(b, "remaining wait", "weekly", true);
    assert.equal(calls("weekly").length, 2, "weekly rejection was cleared without success");
    assert.equal((await notices(b, /is back on this conversation/)).length, 0);
  });
  test("a non-out crash keeps the rest and reservation interval, without a retry stage", async () => {
    const b = await bot("crash"); plan("crash", ["limit", "fail", "ok"]);
    await send(b, "initial", "crash", true); await elapsed("crash");
    await send(b, "crash on try", "crash", true);
    assert.equal((await notices(b, /declined this message/)).length, 0, "a crash was labelled a refusal");
    assert.equal((await notices(b, /failed: Connection reset by peer/)).length, 1);
    await send(b, "interval not elapsed", "crash", true);
    assert.equal(calls("crash").length, 2);
    assert.equal((await notices(b, /Trying again in a minute/)).length, 0);
    await elapsed("crash"); await send(b, "next eligible", "crash", false);
  });
  test("another solo lane uses backup while one try is in flight", async () => {
    const a = await bot("concurrent"), b = await bot("concurrent"); plan("concurrent", ["limit", "hold", "ok"]);
    await send(a, "initial", "concurrent", true); await elapsed("concurrent");
    await h.fetch(`/api/bots/${a}/messages`, { method: "POST", body: JSON.stringify({ text: "hold own try" }) });
    await wait(async () => calls("concurrent").length === 2, "try did not reach the provider");
    await pause(INTERVAL + 100);
    try {
      await send(b, "second lane", "concurrent", true);
      assert.equal(calls("concurrent").length, 2, "two concurrent tries reached one instance");
    } finally { writeFileSync(join(home, `release-${id("concurrent")}`), "yes"); }
    await wait(async () => !(await me(a)).busy, "held try never finished");
    await send(b, "cleared for all lanes", "concurrent", false);
  });
  test("room messages do not try, but a successful room model answer clears a rest", async () => {
    const a = await bot("room"), other = await bot("off"); plan("room", ["limit", "ok", "ok"]);
    await send(a, "initial", "room", true); await elapsed("room");
    const made = await h.json("/api/bloks", { method: "POST", body: JSON.stringify({ name: "Review", memberIds: [a, other] }) });
    const room = made.blok ?? made;
    const roomSay = async (text: string, backup: boolean) => {
      const count = calls("room", backup).length;
      const r = await h.fetch(`/api/bloks/${room.id}/messages`, { method: "POST", body: JSON.stringify({ text: `@${kind} room ${text}` }) }); assert.ok(r.ok);
      await wait(async () => calls("room", backup).length > count && !(await me(a)).busy, "room never answered");
    };
    await roomSay("resting", true); assert.equal(calls("room").length, 1);
    await patch(a, { backupSelection: null }); await roomSay("successful model", false);
    await patch(a, { backupSelection: sel("room", true) }); await send(a, "solo afterwards", "room", false);
  });
  test("a successful native command cannot clear a usage rest established while it runs", async () => {
    const b = await bot("command", false); plan("command", ["ok", "hold", "limit"]);
    await send(b, "establish session", "command", false);
    const text = kind === "codex" ? "/compact" : "/context";
    const started = await h.fetch(`/api/bots/${b}/messages`, { method: "POST", body: JSON.stringify({ text }) }); assert.ok(started.ok, await started.text());
    await wait(async () => calls("command").length === 2, "command did not start");
    const a = await bot("command", false); await send(a, "rest the shared instance", "command", false);
    writeFileSync(join(home, `release-${id("command")}`), "yes");
    await wait(async () => !(await me(b)).busy, "command never completed");
    await patch(b, { backupSelection: sel("command", true) });
    await send(b, "still resting", "command", true);
    assert.equal(calls("command").length, 3);
  });
  for (const reason of ["credit", "overloaded"]) test(`${reason} never reserves a usage try`, async () => {
    const b = await bot(reason); plan(reason, [reason, "ok"]);
    await send(b, "initial", reason, true); await elapsed(reason); await send(b, "still held", reason, true);
    assert.equal(calls(reason).length, 1);
  });
  for (const name of ["nobackup", "unusable"]) test(`${name}: plain dispatch remains unchanged`, async () => {
    const b = await bot(name, false); plan(name, ["limit", "fail", "ok"]);
    await send(b, "no spare initially", name, false);
    if (name === "unusable") await patch(b, { backupSelection: { instanceId: "absent", model: "missing" } });
    await elapsed(name); await send(b, "ordinary own dispatch", name, false);
    assert.equal(calls(name).length, 3, "no usable backup changed the ordinary retry path");
  });
  for (const mode of ["stop", "send", "prepare"]) test(`${mode} before acceptance preserves the pending line and gives back the try interval`, async () => {
    const b = await bot(mode); plan(mode, ["limit", "ok", "ok"]);
    await send(b, "initial", mode, true); await elapsed(mode);
    // Leave a real pending failure by failing without a backup. The rest
    // already belongs to this instance, so no extra request is fabricated.
    await patch(b, { backupSelection: null }); plan(mode, ["limit", "ok", "ok"]);
    await send(b, "pending failure", mode, false);
    await patch(b, { backupSelection: sel(mode, true) }); await elapsed(mode);
    writeFileSync(join(home, mode === "stop" ? "hold-preparation" : mode === "send" ? "reject-send" : "fail-preparation"), "yes");
    const count = calls(mode).length;
    const response = await h.fetch(`/api/bots/${b}/messages`, { method: "POST", body: JSON.stringify({ text: "not accepted" }) });
    assert.ok(response.ok, await response.text());
    if (mode === "stop") {
      await wait(async () => existsSync(join(home, "preparation-entered")), "preparation gate not reached");
      const stopped = await h.fetch(`/api/bots/${b}/interrupt`, { method: "POST", body: JSON.stringify({ taskId: (await me(b)).taskId }) }); assert.ok(stopped.ok);
      writeFileSync(join(home, "release-preparation"), "yes");
    }
    await wait(async () => !(await me(b)).busy, "unaccepted turn never settled");
    assert.ok(existsSync(join(home, "reserved")), "fixture failed before reserving the retry");
    assert.equal(calls(mode).length, count, "unaccepted dispatch reached the provider");
    if (mode === "prepare") assert.match(JSON.stringify((await me(b)).messages), /Fixture preparation failed/);
    if (mode === "send") assert.match(readFileSync(join(home, "rejected-text"), "utf8"), /\(A note from Bloks: an earlier attempt/);
    await send(b, "ordinary accepted", mode, false);
    assert.match(calls(mode).at(-1)!.text, /\(A note from Bloks: an earlier attempt/);
    assert.match(calls(mode).at(-1)!.text, /usage limit reached/);
    await send(b, "following ordinary", mode, false);
    assert.ok(!calls(mode).at(-1)!.text.startsWith("(A note from Bloks: an earlier attempt"), "failure line repeated");
  });
  test("Stop returns a reserved instance to another lane before preparation finishes", async () => {
    const a = await bot("stop-other"), b = await bot("stop-other"); plan("stop-other", ["limit", "ok"]);
    await send(a, "initial", "stop-other", true); await elapsed("stop-other");
    writeFileSync(join(home, "hold-preparation"), "yes");
    const started = await h.fetch(`/api/bots/${a}/messages`, { method: "POST", body: JSON.stringify({ text: "stopped before dispatch" }) }); assert.ok(started.ok);
    await wait(async () => existsSync(join(home, "preparation-entered")), "preparation did not hold");
    assert.ok(existsSync(join(home, "reserved")));
    const stopped = await h.fetch(`/api/bots/${a}/interrupt`, { method: "POST", body: JSON.stringify({ taskId: (await me(a)).taskId }) }); assert.ok(stopped.ok);
    try {
      await send(b, "other lane can try now", "stop-other", false);
      assert.equal(calls("stop-other").length, 2);
      assert.ok(!calls("stop-other").some(c => c.text.includes("stopped before dispatch")));
    } finally { writeFileSync(join(home, "release-preparation"), "yes"); }
    await wait(async () => !(await me(a)).busy, "stopped preparation never settled");
    assert.equal(calls("stop-other").length, 2);
  });
  if (kind === "claudeAgent") test("a native command hears no pending stopped-retry failure; the next model turn hears it once", async () => {
    const b = await bot("pending-command", false); plan("pending-command", ["fail", "ok", "ok", "ok"]);
    const r = await h.fetch(`/api/bots/${b}/messages`, { method: "POST", body: JSON.stringify({ text: "failed work" }) }); assert.ok(r.ok);
    await wait(async () => (await notices(b, /Trying again in a minute/)).length === 1, "retry did not wait");
    const stopped = await h.fetch(`/api/bots/${b}/interrupt`, { method: "POST", body: JSON.stringify({ taskId: (await me(b)).taskId }) }); assert.ok(stopped.ok);
    await wait(async () => !(await me(b)).busy, "retry stop did not settle");
    await send(b, "/context", "pending-command", false);
    assert.equal(calls("pending-command").at(-1)!.text, "/context");
    await send(b, "ordinary after command", "pending-command", false);
    assert.match(calls("pending-command").at(-1)!.text, /Connection reset by peer/);
    assert.match(calls("pending-command").at(-1)!.text, /was stopped/);
    await send(b, "following", "pending-command", false);
    assert.ok(!calls("pending-command").at(-1)!.text.startsWith("(A note from Bloks: an earlier attempt"));
  });
  test("an overdue fallback still dispatches to the backup without reserving own", async () => {
    const b = await bot("fallback"); plan("fallback", ["limit", "ok"]);
    writeFileSync(join(home, "delay-next-backup"), "yes");
    await send(b, "fallback is not ordinary", "fallback", true);
    assert.ok(calls("fallback", true)[0].at - calls("fallback")[0].at >= INTERVAL, "fixture did not cross the retry interval");
    assert.equal(calls("fallback").length, 1, "fallback retried own");
  });
  test("an engine-reload continuation stays on the backup after the interval", async () => {
    const b = await bot("carried"); plan("carried", ["limit", "ok"]);
    writeFileSync(join(home, `plan-${id("carried", true)}.json`), JSON.stringify(["hold", "ok"]));
    await h.fetch(`/api/bots/${b}/messages`, { method: "POST", body: JSON.stringify({ text: "cut-off backup" }) });
    await wait(async () => calls("carried", true).length === 1, "backup did not start"); await elapsed("carried");
    const config = JSON.parse(readFileSync(join(home, ".bloks/config.json"), "utf8"));
    const current = config.instances[id("carried", true)].config.cli, next = current + ".rebuilt.mjs";
    writeFileSync(next, readFileSync(current), { mode: 0o755 }); config.instances[id("carried", true)].config.cli = next;
    writeFileSync(join(home, ".bloks/config.json"), JSON.stringify(config));
    const reload = await h.fetch("/api/providers/kimi", { method: "DELETE" }); assert.ok(reload.ok);
    await wait(async () => calls("carried", true).length === 2 && !(await me(b)).busy, "continuation did not finish on backup");
    assert.equal(calls("carried").length, 1, "carried-on turn retried own");
    assert.match(calls("carried", true).at(-1)!.text, /cut off|restarted/);
  });
  for (const reason of ["credit", "overloaded"]) test(`an actual model answer clears a ${reason} rest too`, async () => {
    const b = await bot("any-rest"); plan("any-rest", [reason, "ok", "ok"]);
    await send(b, "unavailable", "any-rest", true); await patch(b, { backupSelection: null });
    await send(b, "model really answers", "any-rest", false); await patch(b, { backupSelection: sel("any-rest", true) });
    await send(b, "own still available", "any-rest", false);
  });
  test("a missing own engine uses backup without trying a missing instance", async () => {
    const b = await bot("missing"); plan("missing", ["limit"]); await send(b, "initial", "missing", true); await elapsed("missing");
    const config = JSON.parse(readFileSync(join(home, ".bloks/config.json"), "utf8")); delete config.instances[id("missing")];
    writeFileSync(join(home, ".bloks/config.json"), JSON.stringify(config));
    const reload = await h.fetch("/api/providers/kimi", { method: "DELETE" }); assert.ok(reload.ok);
    await send(b, "own missing", "missing", true); assert.equal(calls("missing").length, 1);
  });
  test("an active backup stay does not try a resting own engine; an expired stay plus own rest does", async () => {
    const b = await bot("stay"); plan("stay", ["fail", "fail", "limit", "ok"]);
    await send(b, "start a stay", "stay", true);
    await send(b, "still on stay", "stay", true); assert.equal(calls("stay").length, 2);
    const stayed = calls("stay", true).at(-1)!.at;
    // Another lane rests the same own instance while this lane has a stay.
    const a = await bot("stay", false); await send(a, "shared limit", "stay", false);
    await elapsed("stay"); await send(b, "active stay", "stay", true);
    assert.equal(calls("stay").length, 3, "a lane on a backup stay tried its resting own engine");
    await pause(Math.max(0, stayed + STAY + 500 - Date.now()));
    await send(b, "stale stay", "stay", false);
  });
});

}
