// Checks: a watcher that runs a cheap command before waking its agent
// (GitHub 131).
//
// What this holds shut: a check an agent filed running before the person
// approved its command (unless the agent already runs commands unasked,
// and only while it still does); the same finding waking the agent over
// and over; a stuck or chatty check piling up or flooding the turn; and a
// broken check reading as "nothing to do".
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CHECK_MAX_BYTES,
  CHECK_SHOWN_CHARS,
  checkAllowed,
  checkOutcome,
  cleanWatcher,
  runCheck,
  watcherTurn,
  type CheckResult,
} from "../server/watchers.ts";
import { startHarness } from "./helpers/server.ts";

const ran = (code: number | null, output = "", errors = "", timedOut = false): CheckResult => ({ code, output, errors, timedOut });

describe("running a check", () => {
  const dir = tmpdir();
  test("exit status and what it printed", async () => {
    assert.deepEqual(await runCheck("echo 'supplier replied'; exit 0", dir, process.env), ran(0, "supplier replied\n"));
    assert.equal((await runCheck("exit 1", dir, process.env)).code, 1);
    const broken = await runCheck("echo nope >&2; exit 3", dir, process.env);
    assert.equal(broken.code, 3);
    assert.match(broken.errors, /nope/);
  });

  test("it runs where it is told to", async () => {
    const here = mkdtempSync(join(tmpdir(), "bloks-check-cwd-"));
    try {
      const { output } = await runCheck("pwd", here, process.env);
      assert.match(output.trim(), new RegExp(`${here.split("/").pop()}$`));
    } finally {
      rmSync(here, { recursive: true, force: true });
    }
  });

  test("a stuck check is stopped, and a chatty one is cut off", async () => {
    const started = Date.now();
    const stuck = await runCheck("sleep 20", dir, process.env, 300);
    assert.equal(stuck.timedOut, true);
    assert.equal(stuck.code, null);
    assert.ok(Date.now() - started < 10_000, "the timeout did not stop it");
    const chatty = await runCheck(`${process.execPath} -e "process.stdout.write('x'.repeat(500000))"`, dir, process.env);
    assert.equal(chatty.code, 0);
    assert.ok(chatty.output.length <= CHECK_MAX_BYTES);
  });
});

describe("what a check's result means", () => {
  test("the first look is a baseline, then only a new finding wakes the agent", () => {
    let seen: string | undefined;
    const step = (r: CheckResult) => {
      const o = checkOutcome(r, seen);
      seen = o.seen;
      return o;
    };
    assert.equal(step(ran(0, "already true")).what, null, "the baseline fired");
    assert.equal(step(ran(0, "already true")).what, null, "the same finding fired again");
    assert.equal(step(ran(1)).what, null);
    assert.equal(step(ran(0, "Acme replied")).what, "Acme replied");
    assert.equal(step(ran(0, "Acme replied")).what, null);
    assert.equal(step(ran(0, "Acme and Bolt replied")).what, "Acme and Bolt replied");
    assert.equal(step(ran(1)).what, null);
    assert.equal(step(ran(0, "")).what, "The check passed and printed nothing.");
  });

  test("a broken check is an error, not a quiet no, and does not move the baseline", () => {
    const before = checkOutcome(ran(1), undefined).seen;
    const failed = checkOutcome(ran(127, "", "sh: supplier.py: command not found\nmore"), before);
    assert.match(failed.error!, /exit 127.*command not found/);
    assert.equal(failed.what, null);
    assert.equal(failed.seen, before);
    const slow = checkOutcome(ran(null, "", "", true), before);
    assert.match(slow.error!, /longer than 30 seconds/);
    assert.equal(slow.seen, before);
  });

  test("the agent is shown a bounded amount of it", () => {
    const base = checkOutcome(ran(1), undefined).seen;
    const long = checkOutcome(ran(0, "y".repeat(CHECK_SHOWN_CHARS * 3)), base);
    assert.ok(long.what!.length < CHECK_SHOWN_CHARS + 100);
    assert.match(long.what!, /cut off/);
  });

  test("the turn says which check ran, what it printed, and what to do", () => {
    const turn = watcherTurn({ kind: "check", name: "Supplier", target: "python3 supplier.py", instruction: "Read it and decide." }, "Acme replied");
    assert.match(turn, /python3 supplier\.py/);
    assert.match(turn, /Acme replied/);
    assert.match(turn, /Read it and decide\./);
  });
});

describe("who lets a check run", () => {
  test("the person, or an agent that runs commands unasked for as long as it does", () => {
    assert.equal(checkAllowed({ kind: "check", approvedBy: undefined }, "full"), false);
    assert.equal(checkAllowed({ kind: "check", approvedBy: "person" }, "ask"), true);
    assert.equal(checkAllowed({ kind: "check", approvedBy: "mode" }, "auto"), true);
    assert.equal(checkAllowed({ kind: "check", approvedBy: "mode" }, "full"), true);
    assert.equal(checkAllowed({ kind: "check", approvedBy: "mode" }, "ask"), false, "approval by mode outlived the mode");
    assert.equal(checkAllowed({ kind: "check", approvedBy: "mode" }, undefined), false);
    assert.equal(checkAllowed({ kind: "page" }, undefined), true);
  });

  test("a check is one short line", () => {
    const ok = (target: string) => cleanWatcher({ kind: "check", botId: "b", target, instruction: "Act." }, () => true);
    const good = ok("python3 scripts/supplier_reply.py --since 1h");
    assert.ok(good.ok);
    assert.equal(good.ok && good.value.name, "python3 scripts/supplier_reply.py --since");
    assert.equal(ok("").ok, false);
    assert.equal(ok("echo a\nrm -rf ~").ok, false);
    assert.equal(ok("x".repeat(501)).ok, false);
  });
});

test("through the server: approval, firing on a new finding, and the agent hearing it", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "bloks-check-"));
  const answers = join(home, "answers.json");
  const heard = join(home, "heard.log");
  const cli = join(home, "fake-claude.mjs");
  // Told CALLS <base64 json>, makes each request with its turn credential;
  // every turn's input is written down so the test can see what it was told.
  writeFileSync(
    cli,
    `#!${process.execPath}
import { appendFileSync, renameSync, writeFileSync } from "node:fs";
const [first] = process.argv.slice(2);
if (first === "--version") { console.log("9.9.9 (Claude Code)"); process.exit(0); }
if (first === "auth") { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
let input = "";
process.stdin.on("data", (c) => (input += c));
((go) => { let line = ""; const take = (c) => { line += c; if (!line.includes(String.fromCharCode(10))) return; process.stdin.off("data", take); go(); }; process.stdin.on("data", take); })(async () => {
  appendFileSync(${JSON.stringify(heard)}, input + "\\n----\\n");
  const asked = input.match(/CALLS ([A-Za-z0-9+\\/=]+)/);
  if (asked) {
    const calls = JSON.parse(Buffer.from(asked[1], "base64").toString("utf8"));
    const out = [];
    for (const [method, path, body] of calls) {
      const res = await fetch(process.env.BLOKS_URL + path, {
        method,
        headers: { authorization: "Bearer " + process.env.BLOKS_TOKEN, "content-type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      out.push({ status: res.status, body: await res.json().catch(() => null) });
    }
    writeFileSync(${JSON.stringify(answers)} + ".tmp", JSON.stringify(out)); renameSync(${JSON.stringify(answers)} + ".tmp", ${JSON.stringify(answers)});
  }
  console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "On it." }));
});
`,
    { mode: 0o755 },
  );
  mkdirSync(join(home, ".bloks"), { recursive: true });
  writeFileSync(join(home, ".bloks", "config.json"), JSON.stringify({ instances: { claude: { driver: "claudeAgent", config: { cli } } } }));
  const h = await startHarness({ HOME: home });
  t.after(async () => {
    await h.stop();
    rmSync(home, { recursive: true, force: true });
  });

  const waitFor = async <T,>(check: () => Promise<T | null | undefined> | T | null | undefined, ms = 20_000): Promise<T | null> => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      const value = await check();
      if (value) return value;
      await new Promise((r) => setTimeout(r, 100));
    }
    return null;
  };
  const watcher = async (id: string) => (await h.json("/api/watchers")).watchers.find((w: any) => w.id === id);
  const idle = async (botId: string) =>
    waitFor(async () => {
      const { bots } = await h.json("/api/bots");
      return bots.find((b: any) => b.id === botId)?.busy ? null : true;
    });
  const asAgent = async (botId: string, calls: unknown[]) => {
    rmSync(answers, { force: true });
    await h.fetch(`/api/bots/${botId}/messages`, { method: "POST", body: JSON.stringify({ text: `CALLS ${Buffer.from(JSON.stringify(calls)).toString("base64")}` }) });
    assert.ok(await waitFor(() => existsSync(answers)), "the turn never ran");
    await idle(botId);
    return JSON.parse(readFileSync(answers, "utf8")) as Array<{ status: number; body: any }>;
  };
  const agent = async (name: string, approvals?: string) => {
    const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name }) });
    await h.fetch(`/api/bots/${bot.id}`, {
      method: "PATCH",
      body: JSON.stringify({ modelSelection: { instanceId: "claude", model: "claude-sonnet-5" }, ...(approvals ? { approvals } : {}) }),
    });
    return bot;
  };

  // ── the person files one: approved by writing it, and it fires on news
  // (full paths, because the test server runs with an empty PATH)
  const flag = join(home, "supplier.txt");
  const watcherBot = await agent("Buyer");
  const made = await h.json("/api/watchers", {
    method: "POST",
    body: JSON.stringify({ botId: watcherBot.id, kind: "check", target: `test -f "${flag}" && /bin/cat "${flag}"`, instruction: "Read the reply and decide the next step." }),
  });
  assert.equal(made.watcher.approvedBy, "person");
  assert.ok(await waitFor(async () => (await watcher(made.watcher.id))?.lastCheck), "the baseline look never ran");
  assert.equal((await h.json(`/api/watchers/${made.watcher.id}/check`, { method: "POST" })).fired, false);
  writeFileSync(flag, "Acme replied: the parts ship Friday.");
  const fired = await h.json(`/api/watchers/${made.watcher.id}/check`, { method: "POST" });
  assert.equal(fired.fired, true, fired.note);
  assert.ok(
    await waitFor(() => existsSync(heard) && /ran its check[\s\S]*Acme replied: the parts ship Friday\.[\s\S]*Read the reply and decide/.test(readFileSync(heard, "utf8"))),
    "the agent was not told what the check found",
  );
  await idle(watcherBot.id);
  assert.equal((await h.json(`/api/watchers/${made.watcher.id}/check`, { method: "POST" })).fired, false, "the same finding woke the agent twice");

  // ── an agent that asks before commands files one: it waits for approval
  const marker = join(home, "ran-unapproved");
  const careful = await agent("Careful");
  const [filed] = await asAgent(careful.id, [
    ["POST", "/api/watchers", { kind: "check", target: `/usr/bin/touch "${marker}"; exit 1`, instruction: "Act on it." }],
  ]);
  assert.equal(filed.status, 201, JSON.stringify(filed.body));
  assert.equal(filed.body.watcher.approvedBy, undefined);
  assert.match(filed.body.note, /does not run until/);
  const held = await h.json(`/api/watchers/${filed.body.watcher.id}/check`, { method: "POST" });
  assert.equal(held.fired, false);
  assert.match(held.note, /Waiting for approval/);
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(existsSync(marker), false, "an unapproved check ran its command");

  // the person approves it, and the baseline runs straight away
  const approved = await h.json(`/api/watchers/${filed.body.watcher.id}`, { method: "PATCH", body: JSON.stringify({ approved: true }) });
  assert.equal(approved.watcher.approvedBy, "person");
  assert.ok(await waitFor(() => existsSync(marker)), "approving it did not run it");

  // ── an agent on auto runs its own, for as long as it is on auto
  const markerAuto = join(home, "ran-auto");
  const quick = await agent("Quick", "auto");
  const [own] = await asAgent(quick.id, [["POST", "/api/watchers", { kind: "check", target: `/usr/bin/touch "${markerAuto}"; exit 1`, instruction: "Act on it." }]]);
  assert.equal(own.status, 201, JSON.stringify(own.body));
  assert.equal(own.body.watcher.approvedBy, "mode");
  assert.ok(await waitFor(() => existsSync(markerAuto)), "a check from an agent on auto did not run");
  await h.fetch(`/api/bots/${quick.id}`, { method: "PATCH", body: JSON.stringify({ approvals: "ask" }) });
  rmSync(markerAuto);
  const gated = await h.json(`/api/watchers/${own.body.watcher.id}/check`, { method: "POST" });
  assert.match(gated.note, /Waiting for approval/);
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(existsSync(markerAuto), false, "approval by mode outlived the mode");
});
