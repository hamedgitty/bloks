// How many turns an hour one watcher may start, set per watcher: at most
// N turns an hour, 1 to 30, six unless said. The same field through the
// API, the watcher's page and `bloks watch`, kept within its bounds the
// way `every` is, and a finding held back under the old limit given its
// turn as soon as a new one allows it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { agentPerHourCeiling, cleanWatcher, FIRES_PER_HOUR, heldBackWords, MAX_PER_HOUR, mayFire, nextAllowedAt, perHourOf } from "../server/watchers.ts";
import { startHarness, type Harness } from "./helpers/server.ts";
import { waitFor } from "./helpers/turns.ts";

const MIN = 60_000;
const clean = (more: Record<string, unknown>) => cleanWatcher({ kind: "page", botId: "b", target: "https://fixture.invalid/", instruction: "Act.", ...more }, () => true);

test("the limit is six unless said, kept between 1 and 30, and only a non-number is refused", () => {
  const plain = clean({});
  assert.ok(plain.ok);
  assert.equal(plain.value.perHour, FIRES_PER_HOUR);
  const said = (perHour: unknown) => {
    const made = clean({ perHour });
    assert.ok(made.ok, `perHour ${String(perHour)} was refused`);
    return made.value.perHour;
  };
  assert.equal(said(3), 3);
  assert.equal(said("12"), 12);
  assert.equal(said(2.6), 3);
  assert.equal(said(0), 1);
  assert.equal(said(-4), 1);
  assert.equal(said(500), MAX_PER_HOUR);
  assert.equal(said(""), FIRES_PER_HOUR);
  assert.equal(said(null), FIRES_PER_HOUR);
  const refused = clean({ perHour: "lots" });
  assert.ok(!refused.ok && /perHour is a number of turns an hour, 1 to 30/.test(refused.error));
  // an app watcher keeps its own, among its app fields
  const app = cleanWatcher(
    { kind: "app", botId: "b", toolkit: "github", trigger: "GITHUB_ISSUE_ADDED_EVENT", instruction: "Act.", perHour: 3 },
    () => true,
  );
  assert.ok(app.ok);
  assert.equal(app.value.perHour, undefined);
  assert.equal(app.value.app?.perHour, 3);
});

test("mayFire counts against the watcher's own limit, and a watcher from before it has six", () => {
  const now = Date.UTC(2026, 10, 5, 12, 0);
  const fires = (n: number) => Array.from({ length: n }, (_, i) => ({ at: now - (i + 1) * 5 * MIN, summary: "s" }));
  assert.equal(perHourOf({}), 6);
  assert.equal(mayFire({ fires: fires(5) }, now), true);
  assert.equal(mayFire({ fires: fires(6) }, now), false);
  assert.equal(mayFire({ fires: fires(2), perHour: 2 }, now), false);
  assert.equal(mayFire({ fires: fires(11), perHour: 12 }, now), true, "the old ten kept turns capped a larger limit");
  assert.equal(mayFire({ fires: fires(30), perHour: 30 }, now + 6 * MIN), true);
  // lowered below what the hour already started: it says so, and waits
  // for enough of them to age out
  const many = { fires: fires(8), perHour: 3 };
  assert.equal(nextAllowedAt(many, now), now - 15 * MIN + 60 * MIN);
  assert.equal(heldBackWords(many, now), "Held back: it already started 8 turns in the last hour, and its limit is now 3. What it found waits for the next turn allowed, in 45 minutes.");
  assert.match(heldBackWords({ fires: fires(1), perHour: 1 }, now), /^Held back: it already started 1 turn in the last hour\. .* in 55 minutes\.$/);
});

const cli = fileURLToPath(new URL("../bin/bloks.mjs", import.meta.url));
const runCli = (args: string[], home: string, url: string) =>
  new Promise<{ status: number; body: any }>((resolve, reject) => {
    execFile(process.execPath, [cli, ...args], { env: { HOME: home, USERPROFILE: home, PATH: "/nonexistent", BLOKS_URL: url, BLOKS_TOKEN: "blk_fixture" }, timeout: 10_000 }, (error, stdout) => {
      if (error && typeof error.code !== "number") return reject(error);
      try {
        resolve({ status: (error?.code as number) ?? 0, body: JSON.parse(stdout) });
      } catch (parseError) {
        reject(parseError);
      }
    });
  });

test("bloks watch and edit-watch send --per-hour, and say when it was kept within bounds", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "bloks-cap-cli-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const calls: Array<{ method?: string; body: any }> = [];
  const server = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const body = JSON.parse(text);
    calls.push({ method: req.method, body });
    res.setHeader("content-type", "application/json");
    // as the workspace answers an agent: at most six, and why when it kept less
    const asked = body.perHour === undefined ? 6 : Math.round(body.perHour);
    const perHour = Math.max(1, Math.min(6, asked));
    res.end(JSON.stringify({ watcher: { kind: body.kind ?? "page", every: 30, perHour }, ...(asked > 6 ? { note: "An agent may set at most 6 turns an hour." } : {}) }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  const filed = await runCli(["watch", "--page", "https://fixture.invalid/", "--do", "Act.", "--per-hour", "3"], home, url);
  assert.equal(filed.status, 0);
  assert.equal(calls.at(-1)?.body.perHour, 3);
  assert.equal(filed.body.note, undefined);
  const plain = await runCli(["watch", "--page", "https://fixture.invalid/", "--do", "Act."], home, url);
  assert.equal(plain.status, 0);
  assert.equal(Object.hasOwn(calls.at(-1)!.body, "perHour"), false, "a watch with no --per-hour sent one");
  const most = await runCli(["watch", "--folder", "/fixture", "--do", "Act.", "--per-hour", "100"], home, url);
  // the workspace says why it kept less, and the CLI does not say it again
  assert.equal(most.body.note, "An agent may set at most 6 turns an hour.");
  const edited = await runCli(["edit-watch", "own-id", "--per-hour", "0"], home, url);
  assert.equal(calls.at(-1)?.method, "PATCH");
  assert.deepEqual(calls.at(-1)?.body, { perHour: 0 });
  assert.equal(edited.body.note, "Starts at most 1 turn an hour (the minimum; you asked for 0).");
  for (const args of [["watch", "--page", "https://fixture.invalid/", "--do", "Act.", "--per-hour", "many"], ["edit-watch", "own-id", "--per-hour", "many"]]) {
    const before = calls.length;
    const refused = await runCli(args, home, url);
    assert.equal(refused.status, 1);
    assert.match(refused.body.error, /--per-hour needs a number of turns/);
    assert.equal(calls.length, before, "a non-number reached the server");
  }
  const help = (await runCli(["help"], home, url)).body.commands;
  assert.match(help.find((c: any) => c.name === "watch").use, /--per-hour <turns>/);
  assert.match(help.find((c: any) => c.name === "watch").about, /--per-hour lowers the most turns it starts in an hour, 1 to 6 \(6 unless said; you can lower a watcher's limit but never raise it, and only the person can allow more, up to 30\)/);
  assert.match(help.find((c: any) => c.name === "edit-watch").use, /--per-hour <turns>/);
});

/** A Claude Code stand-in that writes down every message it is given. */
function standIn(home: string) {
  const heard = join(home, "heard.jsonl");
  const answers = join(home, "answers.json");
  const cli = join(home, "fake-claude.mjs");
  writeFileSync(
    cli,
    `#!${process.execPath}
import { appendFileSync, renameSync, writeFileSync } from "node:fs";
const [first] = process.argv.slice(2);
if (first === "--version") { console.log("2.1.299 (Claude Code)"); process.exit(0); }
if (first === "auth") { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
((go) => { let line = ""; const take = (c) => { line += c; while (line.includes(String.fromCharCode(10))) { const at = line.indexOf(String.fromCharCode(10)); const next = line.slice(0, at); line = line.slice(at + 1); if (!next.trim() || JSON.parse(next).type !== "user") continue; process.stdin.off("data", take); go(next); return; } }; process.stdin.on("data", take); })(async (input) => {
  appendFileSync(${JSON.stringify(heard)}, JSON.stringify(input) + String.fromCharCode(10));
  // told CALLS <base64 json>, makes those requests with its turn's own credential
  const asked = input.match(/CALLS ([A-Za-z0-9+\\/=]+)/);
  if (asked) {
    const out = [];
    for (const [method, path, body] of JSON.parse(Buffer.from(asked[1], "base64").toString("utf8"))) {
      const res = await fetch(process.env.BLOKS_URL + path, { method, headers: { authorization: "Bearer " + process.env.BLOKS_TOKEN, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
      out.push({ status: res.status, body: await res.json().catch(() => null) });
    }
    writeFileSync(${JSON.stringify(answers)} + ".tmp", JSON.stringify(out)); renameSync(${JSON.stringify(answers)} + ".tmp", ${JSON.stringify(answers)});
  }
  console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "On it." }));
});
`,
    { mode: 0o755 },
  );
  return { cli, heard, answers };
}

test("through the server: set, changed and shown, and a raised limit gives a held finding its turn now", { timeout: 180_000 }, async (t) => {
  const home = mkdtempSync(join(tmpdir(), "bloks-cap-"));
  const fake = standIn(home);
  const flag = join(home, "supplier.txt");
  mkdirSync(join(home, ".bloks"), { recursive: true });
  writeFileSync(join(home, ".bloks", "config.json"), JSON.stringify({ brief: { enabled: false }, backups: { auto: false }, instances: { claude: { driver: "claudeAgent", config: { cli: fake.cli } } } }));
  let h: Harness = await startHarness({ HOME: home });
  t.after(async () => {
    await h.stop();
    rmSync(home, { recursive: true, force: true });
  });
  const saved = (): any[] => JSON.parse(readFileSync(join(home, ".bloks", "watchers.json"), "utf8"));
  const view = async (id: string) => (await h.json("/api/watchers")).watchers.find((w: any) => w.id === id);
  const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Buyer" }) });
  await h.fetch(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } }) });

  // set when it is filed, and changed later, through the same field
  const page = { botId: bot.id, kind: "page", target: "http://127.0.0.1:9/menu", instruction: "Act.", enabled: false };
  const three = await h.json("/api/watchers", { method: "POST", body: JSON.stringify({ ...page, perHour: 3 }) });
  assert.equal(three.watcher.perHour, 3);
  const most = await h.json("/api/watchers", { method: "POST", body: JSON.stringify({ ...page, perHour: 99 }) });
  assert.equal(most.watcher.perHour, 30);
  const refused = await h.fetch("/api/watchers", { method: "POST", body: JSON.stringify({ ...page, perHour: "many" }) });
  assert.equal(refused.status, 400);
  const changed = await h.json(`/api/watchers/${three.watcher.id}`, { method: "PATCH", body: JSON.stringify({ perHour: 12 }) });
  assert.equal(changed.watcher.perHour, 12);
  const renamed = await h.json(`/api/watchers/${three.watcher.id}`, { method: "PATCH", body: JSON.stringify({ name: "Menu" }) });
  assert.equal(renamed.watcher.perHour, 12, "an edit of something else reset the limit");

  // a check that finds something past its limit of six
  const check = await h.json("/api/watchers", {
    method: "POST",
    body: JSON.stringify({ botId: bot.id, kind: "check", name: "Supplier", target: `test -f "${flag}" && /bin/cat "${flag}"`, instruction: "Read it." }),
  });
  assert.ok(await waitFor(() => saved().find((w) => w.id === check.watcher.id)?.seen), "the check never took its baseline");
  await h.stop();
  const list = saved();
  for (const w of list) {
    if (w.id === check.watcher.id) {
      w.fires = Array.from({ length: 6 }, (_, i) => ({ at: Date.now() - (50 - i * 5) * MIN, summary: "Earlier" }));
      // a watcher from before the limit could be set has none saved
      delete w.perHour;
    }
  }
  writeFileSync(join(home, ".bloks", "watchers.json"), JSON.stringify(list));
  h = await startHarness({ HOME: home });
  assert.equal((await view(check.watcher.id)).perHour, 6, "a watcher from before the limit could be set did not show six");
  writeFileSync(flag, "Acme replied.");
  const held = await h.json(`/api/watchers/${check.watcher.id}/check`, { method: "POST" });
  assert.equal(held.fired, false);
  assert.match(held.note, /^Held back: it already started 6 turns in the last hour\. .* in 1\d minutes\.$/);

  // lowered, it says how long the finding waits now
  const lowered = await h.json(`/api/watchers/${check.watcher.id}`, { method: "PATCH", body: JSON.stringify({ perHour: 4 }) });
  assert.match(lowered.watcher.lastError, /started 6 turns in the last hour, and its limit is now 4\. .* in 2\d minutes\./);
  assert.equal(existsSync(fake.heard) && /Acme replied/.test(readFileSync(fake.heard, "utf8")), false);

  // raised past what the hour started, the finding gets its turn now
  const raised = await h.json(`/api/watchers/${check.watcher.id}`, { method: "PATCH", body: JSON.stringify({ perHour: 7 }) });
  assert.equal(raised.watcher.perHour, 7);
  assert.ok(await waitFor(() => existsSync(fake.heard) && /ran its check[\s\S]*Acme replied/.test(readFileSync(fake.heard, "utf8"))), "raising the limit left the held finding waiting");
  const after = await waitFor(async () => {
    const w = await view(check.watcher.id);
    return w.fires.length === 7 ? w : null;
  });
  assert.ok(after, "the turn was not counted");
  assert.equal(after.held, undefined);
  assert.equal(after.lastError, undefined);
});

test("an agent may lower its watcher's limit, never raise it, and the person sets 1 to 30", { timeout: 180_000 }, async (t) => {
  assert.equal(agentPerHourCeiling(), 6);
  assert.equal(agentPerHourCeiling({}), 6, "a watcher from before the limit could be set");
  assert.equal(agentPerHourCeiling({ perHour: 20 }), 20);
  assert.equal(agentPerHourCeiling({ perHour: 2 }), 2);

  const home = mkdtempSync(join(tmpdir(), "bloks-cap-agent-"));
  const fake = standIn(home);
  mkdirSync(join(home, ".bloks"), { recursive: true });
  writeFileSync(join(home, ".bloks", "config.json"), JSON.stringify({ brief: { enabled: false }, backups: { auto: false }, instances: { claude: { driver: "claudeAgent", config: { cli: fake.cli } } } }));
  const h = await startHarness({ HOME: home });
  t.after(async () => {
    await h.stop();
    rmSync(home, { recursive: true, force: true });
  });
  const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Keeper" }) });
  await h.fetch(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } }) });
  const idle = () => waitFor(async () => ((await h.json("/api/bots?messages=0")).bots.find((b: any) => b.id === bot.id)?.busy ? null : true));
  const asAgent = async (calls: unknown[]) => {
    rmSync(fake.answers, { force: true });
    await h.fetch(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: `CALLS ${Buffer.from(JSON.stringify(calls)).toString("base64")}` }) });
    assert.ok(await waitFor(() => existsSync(fake.answers)), "the turn never ran");
    await idle();
    return JSON.parse(readFileSync(fake.answers, "utf8")) as Array<{ status: number; body: any }>;
  };
  const page = { kind: "page", target: "http://127.0.0.1:9/menu", instruction: "Act.", enabled: false };

  // filed by the agent: kept to six, and told why
  const [filed] = await asAgent([["POST", "/api/watchers", { ...page, perHour: 20 }]]);
  assert.equal(filed.status, 201, JSON.stringify(filed.body));
  assert.equal(filed.body.watcher.perHour, 6);
  assert.match(filed.body.note, /An agent may set at most 6 turns an hour, so it starts at most 6; only .* can allow more, in Watchers\./);
  const id = filed.body.watcher.id;

  // raised by the agent: kept where it is; lowered: as asked, with no note
  const [raised, lowered] = await asAgent([
    ["PATCH", `/api/watchers/${id}`, { perHour: 10 }],
    ["PATCH", `/api/watchers/${id}`, { perHour: 2 }],
  ]);
  assert.equal(raised.status, 200);
  assert.equal(raised.body.watcher.perHour, 6);
  assert.match(raised.body.note, /An agent may lower a watcher's limit but not raise it, so it stays at most 6 turns an hour/);
  assert.equal(lowered.body.watcher.perHour, 2);
  assert.equal(lowered.body.note, undefined);
  const [back] = await asAgent([["PATCH", `/api/watchers/${id}`, { perHour: 6 }]]);
  assert.equal(back.body.watcher.perHour, 2, "an agent raised a limit back up after lowering it");

  // the person sets 20; the agent asking for 25 leaves it at 20, and may lower it
  assert.equal((await h.json(`/api/watchers/${id}`, { method: "PATCH", body: JSON.stringify({ perHour: 20 }) })).watcher.perHour, 20);
  const [above, under, renamed] = await asAgent([
    ["PATCH", `/api/watchers/${id}`, { perHour: 25 }],
    ["PATCH", `/api/watchers/${id}`, { perHour: 15 }],
    ["PATCH", `/api/watchers/${id}`, { name: "Menu" }],
  ]);
  assert.equal(above.body.watcher.perHour, 20, "an agent raised a limit the person set");
  assert.match(above.body.note, /stays at most 20 turns an hour/);
  assert.equal(under.body.watcher.perHour, 15);
  assert.equal(renamed.body.watcher.perHour, 15, "an agent's edit of something else moved the limit");
  assert.equal(renamed.body.note, undefined);

  // the person sets anything from 1 to 30
  assert.equal((await h.json(`/api/watchers/${id}`, { method: "PATCH", body: JSON.stringify({ perHour: 30 }) })).watcher.perHour, 30);
  const mine = await h.json("/api/watchers", { method: "POST", body: JSON.stringify({ ...page, botId: bot.id, perHour: 30 }) });
  assert.equal(mine.watcher.perHour, 30);
  assert.equal(mine.note, undefined);
});
