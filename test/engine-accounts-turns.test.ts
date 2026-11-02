// Another account of the same engine, through the real server and the real
// Claude Code and Codex drivers (GitHub 465). The CLIs are local fixtures:
// each tells its accounts apart by the config folder it was pointed at,
// and none holds or reaches a real sign-in.
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { startHarness, type Harness } from "./helpers/server.ts";

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

// One script for both engines. The account is the basename of the folder
// in CLAUDE_CONFIG_DIR or CODEX_HOME, "main" without one. Each account
// answers from its own list of outcomes, and every call is written down
// with the account, the model and the session it ran in.
const CLI = String.raw`#!__NODE__
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { createInterface } from "node:readline";
const kind = "__KIND__", dir = "__DIR__", id = "__ID__";
const args = process.argv.slice(2);
const home = process.env[kind === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR"] || "";
const account = home ? basename(home) : "main";
const signedIn = !home || existsSync(home + "/signed-in");
const read = (name, otherwise) => existsSync(dir + "/" + name) ? JSON.parse(readFileSync(dir + "/" + name, "utf8")) : otherwise;
const write = (name, value) => { writeFileSync(dir + "/" + name + "." + process.pid + ".part", JSON.stringify(value)); renameSync(dir + "/" + name + "." + process.pid + ".part", dir + "/" + name); };
if (args[0] === "--version") { console.log(kind === "codex" ? "codex-cli 9.9.9" : "2.1.299 (Claude Code)"); process.exit(); }
if (args[0] === "auth" && args[1] === "status") { console.log(JSON.stringify({ loggedIn: signedIn, ...(signedIn && home ? { email: account + "@example.test" } : {}) })); process.exit(signedIn ? 0 : 1); }
if ((args[0] === "auth" && args[1] === "logout") || args[0] === "logout") { writeFileSync(dir + "/logout-" + account, "yes"); process.exit(); }
if (args[0] === "login" && args[1] === "status") { if (signedIn) { console.log("Logged in using ChatGPT"); process.exit(); } console.error("Not logged in"); process.exit(1); }
const out = (m) => console.log(JSON.stringify(m));
const epoch = read("reset.json", Math.floor(Date.now() / 1000) + 3600);
const take = (text, session, model) => {
  const plan = read("plan-" + id + "-" + account + ".json", []), outcome = plan.shift() ?? "ok";
  write("plan-" + id + "-" + account + ".json", plan);
  const calls = read("calls-" + id + ".json", []);
  calls.push({ account, home, text, session, model, outcome, at: Date.now() }); write("calls-" + id + ".json", calls);
  return outcome;
};
const failing = (outcome) => outcome === "limit";
// an agent asking about the accounts with its own turn's credential
const probe = async (outcome) => {
  if (outcome !== "probe") return;
  const res = await fetch(process.env.BLOKS_URL + "/api/engine-accounts", { method: "PUT", headers: { authorization: "Bearer " + process.env.BLOKS_TOKEN, "content-type": "application/json" }, body: JSON.stringify({ instanceId: id, accountId: "main" }) });
  const list = await fetch(process.env.BLOKS_URL + "/api/engine-accounts", { headers: { authorization: "Bearer " + process.env.BLOKS_TOKEN } });
  write("probe.json", { change: res.status, list: list.status });
};
const said = (outcome) => failing(outcome) ? "usage limit reached|" + epoch : "Answered on " + account;
if (kind === "claudeAgent") {
  const model = args.includes("--model") ? args[args.indexOf("--model") + 1] : null;
  createInterface({ input: process.stdin }).on("line", async (line) => {
    const frame = JSON.parse(line); if (frame.type !== "user") return;
    const text = typeof frame.message.content === "string" ? frame.message.content : JSON.stringify(frame.message.content);
    const flag = args.includes("--resume") ? "--resume" : "--session-id", session = args[args.indexOf(flag) + 1];
    const outcome = take(text, session, model), failed = failing(outcome);
    await probe(outcome);
    out({ type: "system", subtype: "init", session_id: session, model: "claude-sonnet-5" });
    if (failed) out({ type: "rate_limit_event", session_id: session, rate_limit_info: { status: "rejected", resetsAt: epoch, rateLimitType: "five_hour" } });
    // an answer that leaves the plan spent: the engine says so on the side
    if (outcome === "full") out({ type: "rate_limit_event", session_id: session, rate_limit_info: { status: "allowed_warning", rateLimitType: "five_hour", unifiedWindows: { five_hour: { utilization: 1, resetsAt: epoch } } } });
    out({ type: "assistant", ...(failed ? { error: "rate_limit" } : {}), session_id: session, message: { id: "m1", model: failed ? "<synthetic>" : "claude-sonnet-5", role: "assistant", content: [{ type: "text", text: said(outcome) }], usage: { input_tokens: failed ? 0 : 7, output_tokens: failed ? 0 : 3 } } });
    out({ type: "result", subtype: "success", is_error: failed, num_turns: 1, duration_api_ms: 1, total_cost_usd: 0, session_id: session, result: said(outcome) });
  });
} else {
  let thread = "thread-" + account + "-" + process.pid, opened = "start", model = null, count = 0;
  createInterface({ input: process.stdin }).on("line", async (line) => {
    const m = JSON.parse(line); if (!m.method) return;
    if (m.method === "model/list") return out({ id: m.id, result: { data: [{ id: "gpt-6.1-sol", model: "gpt-6.1-sol", displayName: "GPT-6.1-Sol", isDefault: true }] } });
    if (m.method === "thread/start" || m.method === "thread/resume") { opened = m.method; model = m.params.model ?? model; thread = m.params.threadId ?? thread; return out({ id: m.id, result: { thread: { id: thread }, model: "gpt-6.1-sol" } }); }
    if (m.method === "turn/start") {
      const text = (m.params.input ?? []).map(x => x.text ?? "").join("\n"), outcome = take(text, opened + ":" + thread, m.params.model ?? model), turn = "turn-" + ++count, failed = failing(outcome);
      out({ id: m.id, result: { turn: { id: turn, status: "inProgress" } } });
      out({ method: "turn/started", params: { threadId: thread, turn: { id: turn, status: "inProgress" } } });
      await probe(outcome);
      if (outcome === "full") out({ method: "account/rateLimits/updated", params: { rateLimits: { primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: epoch } } } });
      if (failed) out({ method: "error", params: { threadId: thread, error: { message: said(outcome) }, willRetry: false } });
      else out({ method: "item/completed", params: { threadId: thread, item: { id: "a", type: "agentMessage", text: said(outcome) } } });
      return out({ method: "turn/completed", params: { threadId: thread, turn: { id: turn, status: failed ? "failed" : "completed", ...(failed ? { error: { message: said(outcome) } } : {}) } } });
    }
    if (m.id !== undefined) out({ id: m.id, result: {} });
  });
}
`;

type Call = { account: string; home: string; text: string; session: string; model: string | null; outcome: string; at: number };

for (const kind of ["claudeAgent", "codex"] as const) {
  describe(`${kind}: another account of the same engine`, () => {
    let home: string, h: Harness;
    const own = `${kind}-own`;
    const spare = `${kind}-spare`;
    const ownModel = kind === "codex" ? "gpt-6.1-sol" : "claude-sonnet-5";
    const spareModel = kind === "codex" ? "claude-sonnet-5" : "gpt-6.1-sol";

    const plan = (instance: string, account: string, outcomes: string[]) =>
      writeFileSync(join(home, `plan-${instance}-${account}.json`), JSON.stringify(outcomes));
    const calls = (instance = own): Call[] => {
      const f = join(home, `calls-${instance}.json`);
      return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : [];
    };
    const me = async (bot: string) => (await h.json("/api/bots")).bots.find((b: any) => b.id === bot);
    const notices = async (bot: string, pattern: RegExp) => (await me(bot)).messages.filter((m: any) => m.kind === "notice" && pattern.test(m.text));
    const until = async (check: () => Promise<boolean> | boolean, why: string) => {
      const end = Date.now() + 15_000;
      while (Date.now() < end) {
        if (await check()) return;
        await pause(30);
      }
      assert.fail(`${why}\n${h.logs().slice(-2000)}`);
    };
    const bot = async (backup: boolean) => {
      const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: `${kind} accounts` }) });
      const r = await h.fetch(`/api/bots/${bot.id}`, {
        method: "PATCH",
        body: JSON.stringify({ modelSelection: { instanceId: own, model: ownModel }, backupSelection: backup ? { instanceId: spare, model: spareModel } : null }),
      });
      assert.equal(r.status, 200, await r.text());
      return bot.id as string;
    };
    /** Sends, and waits for the turn and anything that goes on from it
     * to settle, with at least `expect` new calls across both engines. */
    const send = async (b: string, words: string, expect = 1) => {
      const before = calls(own).length + calls(spare).length;
      const r = await h.fetch(`/api/bots/${b}/messages`, { method: "POST", body: JSON.stringify({ text: words }) });
      assert.ok(r.ok, await r.text());
      await until(async () => calls(own).length + calls(spare).length >= before + expect && !(await me(b)).busy, `"${words}" never settled`);
      // settled for a moment, not between a failure and its next try
      await pause(250);
      await until(async () => !(await me(b)).busy, `"${words}" went on and never settled`);
    };
    const addAccount = async (label: string, signedIn = true) => {
      const r = await h.fetch("/api/engine-accounts", { method: "POST", body: JSON.stringify({ instanceId: own, label }) });
      const body = await r.text();
      assert.equal(r.status, 201, body);
      const { account } = JSON.parse(body);
      if (signedIn) writeFileSync(join(home, ".bloks", "engine-accounts", account.id, "signed-in"), "yes");
      return account.id as string;
    };
    const resetIn = (seconds: number) => writeFileSync(join(home, "reset.json"), JSON.stringify(Math.floor(Date.now() / 1000) + seconds));

    beforeEach(async () => {
      home = mkdtempSync(join(tmpdir(), "bloks-accounts-"));
      mkdirSync(join(home, ".bloks"));
      const instances: Record<string, unknown> = {};
      for (const [instance, driver] of [[own, kind], [spare, kind === "codex" ? "claudeAgent" : "codex"]] as const) {
        const cli = join(home, `${instance}.mjs`);
        writeFileSync(cli, CLI.replaceAll("__NODE__", process.execPath).replaceAll("__DIR__", home).replaceAll("__ID__", instance).replaceAll("__KIND__", driver), { mode: 0o755 });
        instances[instance] = { driver, config: { cli, permissionMode: "bypassPermissions" } };
      }
      // the person's own setup in the main sign-in's folder, to be shared
      mkdirSync(join(home, ".claude"));
      writeFileSync(join(home, ".claude", "settings.json"), "{}");
      writeFileSync(join(home, ".claude", ".credentials.json"), "{}");
      mkdirSync(join(home, ".codex"));
      writeFileSync(join(home, ".codex", "config.toml"), "");
      writeFileSync(join(home, ".codex", "auth.json"), "{}");
      resetIn(3600);
      writeFileSync(join(home, ".bloks", "config.json"), JSON.stringify({ instances }));
      h = await startHarness({ HOME: home, BLOKS_RETRY_WAIT_MS: "1200", BLOKS_RETRY_INTERVAL_MS: "1800", BLOKS_BACKUP_STAY_MS: "6000" });
    });
    afterEach(async () => {
      await h?.stop();
      rmSync(home, { recursive: true, force: true });
    });

    test("a limit on one account goes on in another with the same model, and stays there after the first resets", async () => {
      const work = await addAccount("Work");
      const b = await bot(true);
      plan(own, "main", ["ok", "limit"]);
      plan(own, work, ["ok", "ok"]);
      await send(b, "remember heron");
      assert.equal(calls().at(-1)!.account, "main");
      const mainSession = calls().at(-1)!.session;

      resetIn(3);
      await send(b, "quota now", 2);
      const [failed, next] = calls().slice(-2);
      assert.equal(failed.account, "main");
      assert.equal(failed.outcome, "limit");
      assert.equal(next.account, work, "the next account took it");
      assert.equal(next.model, failed.model, "with the same model");
      assert.equal(next.model, ownModel);
      assert.equal(calls(spare).length, 0, "the backup engine, another model, never ran");
      // a new session there, told the conversation so far, and said so
      assert.notEqual(next.session, mainSession);
      if (kind === "codex") assert.match(next.session, /^thread\/start:/);
      assert.match(next.text, /new session, on another account of the same engine and the same model/);
      assert.match(next.text, /remember heron/);
      assert.match(next.text, /quota now/);
      assert.match(next.text, /asked again on the account "Work", another account of the same engine/);
      assert.equal(next.home, join(home, ".bloks", "engine-accounts", work));
      // the person's setup is there; the main sign-in's credential is not
      const shared = kind === "codex" ? "config.toml" : "settings.json";
      assert.ok(lstatSync(join(next.home, shared)).isSymbolicLink());
      assert.equal(existsSync(join(next.home, kind === "codex" ? "auth.json" : ".credentials.json")), false);
      assert.equal((await notices(b, /usage limit on the main sign-in .*Asking again on the account "Work", with the same model/)).length, 1);
      assert.equal((await notices(b, /goes on with|runs on the account/)).length, 0, "the move is said once");

      // the main sign-in is back; the conversation stays where it is
      await pause(3_500);
      await send(b, "after the reset");
      const after = calls().at(-1)!;
      assert.equal(after.account, work);
      assert.equal(after.session.replace(/^thread\/(start|resume):/, ""), next.session.replace(/^thread\/(start|resume):/, ""), "the same session on the same account");
      assert.doesNotMatch(after.text, /remember heron/);

      const view = await h.json("/api/engine-accounts");
      const engine = view.engines.find((e: any) => e.instanceId === own);
      assert.deepEqual(engine.accounts.map((a: any) => [a.label, a.inUse]), [[null, false], ["Work", true]]);
      // names and states; never a folder or anything in one
      assert.ok(!JSON.stringify(view).includes(home), "a folder reached the page");

      const report = await h.json("/api/usage/report?range=7d");
      const rows = Object.fromEntries(report.byAccount.map((r: any) => [r.id, r.turns]));
      assert.deepEqual(rows, { [`${own}/main`]: 2, [`${own}/${work}`]: 2 });
      assert.equal(report.accountLabels[`${own}/${work}`], "Work");
    });

    test("a plan the engine said is spent is left before the next turn, which says so", async () => {
      const work = await addAccount("Work");
      const b = await bot(false);
      plan(own, "main", ["full", "ok"]);
      plan(own, work, ["ok"]);
      await send(b, "remember heron");
      await send(b, "and then");
      assert.equal(calls().length, 2, "no turn was spent on the account at its limit");
      assert.equal(calls().at(-1)!.account, work);
      assert.equal(calls().at(-1)!.model, ownModel);
      assert.match(calls().at(-1)!.text, /remember heron/);
      assert.equal((await notices(b, /goes on with the account "Work" from here: the main sign-in is at its usage limit .*Same model; it starts a new session there/)).length, 1);
    });

    test("with every account out, only the backup the person chose takes it, and the notice says why", async () => {
      const work = await addAccount("Work");
      const b = await bot(true);
      plan(own, "main", ["limit"]);
      plan(own, work, ["limit"]);
      await send(b, "busy day", 3);
      assert.deepEqual(calls().map((c) => c.account), ["main", work]);
      assert.equal(calls(spare).length, 1);
      assert.equal(calls(spare)[0].model, spareModel);
      assert.equal((await notices(b, /Asking again on the account "Work"/)).length, 1);
      assert.equal((await notices(b, /is out of usage on all of its accounts .*is picking this up/)).length, 1);
    });

    test("with every account out and no backup, the agent stops and says so, and no other model runs", async () => {
      const work = await addAccount("Work");
      const b = await bot(false);
      plan(own, "main", ["limit"]);
      plan(own, work, ["limit"]);
      await send(b, "busy day", 2);
      assert.deepEqual(calls().map((c) => c.account), ["main", work]);
      assert.equal(calls(spare).length, 0);
      assert.equal((await notices(b, /is out of usage on all of its accounts .*has stopped here/)).length, 1);
    });

    test("an account that is not signed in is passed over, and Settings says so", async () => {
      await addAccount("Later", false);
      const b = await bot(false);
      plan(own, "main", ["ok"]);
      const view = await h.json("/api/engine-accounts?fresh=1");
      const later = view.engines.find((e: any) => e.instanceId === own).accounts[1];
      assert.equal(later.signedIn, false);
      assert.equal(later.blocked.why, "signedOut");
      await send(b, "hello");
      assert.equal(calls().at(-1)!.account, "main");
    });

    test("the person adds, names, chooses and removes accounts; the network and agents cannot", async () => {
      const work = await addAccount("Work");
      // the one in use is the person's choice too, and the lane follows it
      const b = await bot(false);
      plan(own, "main", ["probe"]);
      plan(own, work, ["ok"]);
      await send(b, "remember heron");
      assert.deepEqual(JSON.parse(readFileSync(join(home, "probe.json"), "utf8")), { change: 403, list: 403 }, "an agent reached the accounts");
      let r = await h.fetch("/api/engine-accounts/current", { method: "PUT", body: JSON.stringify({ instanceId: own, accountId: work }) });
      assert.equal(r.status, 200, await r.text());
      await send(b, "on the other one");
      assert.equal(calls().at(-1)!.account, work);
      assert.equal((await notices(b, /runs on the account "Work" now, the account in use for this engine/)).length, 1);

      r = await h.fetch(`/api/engine-accounts/${work}`, { method: "PATCH", body: JSON.stringify({ label: "  Client work " }) });
      assert.equal(r.status, 200);
      assert.equal((await r.json()).account.label, "Client work");
      r = await h.fetch(`/api/engine-accounts/${work}`, { method: "PATCH", body: JSON.stringify({ label: "" }) });
      assert.equal(r.status, 400);
      r = await h.fetch("/api/engine-accounts", { method: "POST", body: JSON.stringify({ instanceId: "nope", label: "X" }) });
      assert.equal(r.status, 404);

      // from the network, without a paired device: nothing
      const remote = await h.fetchRemote("/api/engine-accounts", { method: "POST", body: JSON.stringify({ instanceId: own, label: "Sneaky" }) });
      assert.ok(remote.status === 401 || remote.status === 403, `remote add answered ${remote.status}`);
      const remoteList = await h.fetchRemote("/api/engine-accounts");
      assert.ok(remoteList.status === 401 || remoteList.status === 403);

      const folder = join(home, ".bloks", "engine-accounts", work);
      r = await h.fetch(`/api/engine-accounts/${work}`, { method: "DELETE" });
      const removed = await r.text();
      assert.equal(r.status, 200, removed);
      assert.ok(existsSync(join(home, `logout-${basename(folder)}`)), "the engine's own sign-out ran for that account");
      assert.equal(existsSync(folder), false, "its folder went with it");
      const engine = JSON.parse(removed).engines.find((e: any) => e.instanceId === own);
      assert.deepEqual(engine.accounts.map((a: any) => a.id), ["main"]);
      // back on the main sign-in, in a new session told the story
      await send(b, "and now");
      assert.equal(calls().at(-1)!.account, "main");
      assert.match(calls().at(-1)!.text, /another account of the same engine/);
    });
  });
}
