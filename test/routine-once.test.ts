// One-time routines from the agent's command line (GitHub 130), and
// agents keeping to their own routines.
//
// An agent that needs to come back to something on Thursday should not
// have to file a weekly routine and remember to delete it. `bloks routine
// --date` files one that runs once; a date that has passed, or never
// existed, is refused there and then rather than becoming a routine that
// quietly never fires.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { startHarness } from "./helpers/server.ts";

const BLOKS = fileURLToPath(new URL("../bin/bloks.mjs", import.meta.url));

/** A stand-in workspace that writes down every request it is sent. */
async function workspace() {
  const seen: Array<{ method: string; path: string; body: any }> = [];
  const server = createServer((req: IncomingMessage, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : null;
      seen.push({ method: req.method!, path: req.url!, body });
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/agent/whoami") return res.end(JSON.stringify({ botId: "bot-1", taskId: "task-1" }));
      if (req.url === "/api/routines" && req.method === "GET") {
        return res.end(
          JSON.stringify({
            routines: [
              { id: "r1", targetId: "bot-1", targetKind: "agent", prompt: "Morning brief", time: "09:00", days: [1, 2, 3, 4, 5], enabled: true, summary: "Weekdays at 09:00", nextRunAt: new Date(2030, 0, 7, 9, 0).getTime(), runs: [{ id: "x" }] },
              { id: "r2", targetId: "bot-1", targetKind: "agent", name: "Supplier", prompt: "Check the supplier", time: "09:00", days: [], repeat: "once", date: "2030-01-08", enabled: true, summary: "Once on Jan 8 at 09:00", nextRunAt: new Date(2030, 0, 8, 9, 0).getTime() },
            ],
          }),
        );
      }
      res.end(JSON.stringify({ ok: true, routine: body }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const run = (...args: string[]) =>
    new Promise<{ code: number; out: any }>((resolve) => {
      execFile(process.execPath, [BLOKS, ...args], { env: { ...process.env, BLOKS_URL: url, BLOKS_TOKEN: "turn-token" } }, (error, stdout) => {
        resolve({ code: error ? Number((error as { code?: number }).code ?? 1) : 0, out: JSON.parse(stdout) });
      });
    });
  return { seen, run, close: () => server.close() };
}

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

test("--date files a routine that runs once, on that day", async (t) => {
  const w = await workspace();
  t.after(w.close);
  const thursday = new Date(Date.now() + 3 * 24 * 60 * 60_000);
  const { code, out } = await w.run("routine", "--prompt", "Check whether the supplier answered; if not, chase once", "--date", ymd(thursday), "--time", "09:00");
  assert.equal(code, 0, JSON.stringify(out));
  const filed = w.seen.find((r) => r.method === "POST" && r.path === "/api/routines")!;
  assert.deepEqual(
    { repeat: filed.body.repeat, date: filed.body.date, days: filed.body.days, time: filed.body.time, targetId: filed.body.targetId },
    { repeat: "once", date: ymd(thursday), days: [], time: "09:00", targetId: "bot-1" },
  );
});

test("without --date a routine stays weekly", async (t) => {
  const w = await workspace();
  t.after(w.close);
  const { code } = await w.run("routine", "--prompt", "Morning brief", "--time", "09:00", "--days", "1,2,3,4,5");
  assert.equal(code, 0);
  const filed = w.seen.find((r) => r.method === "POST" && r.path === "/api/routines")!;
  assert.equal(filed.body.repeat, undefined);
  assert.deepEqual(filed.body.days, [1, 2, 3, 4, 5]);
});

// GitHub 171: with --days left out, the empty list read as day 0 and the
// routine ran on Sundays only. Days the CLI could not read were dropped
// or guessed at, so "mon" filed a daily routine and "7" went through as is.
test("without --days, or with it empty, a routine runs every day", async (t) => {
  const w = await workspace();
  t.after(w.close);
  for (const days of [[], ["--days="], ["--days", ""], ["--days", "  "]]) {
    const { code, out } = await w.run("routine", "--prompt", "Morning brief", "--time", "09:00", ...days);
    assert.equal(code, 0, JSON.stringify({ days, out }));
    const filed = w.seen.filter((r) => r.method === "POST" && r.path === "/api/routines").at(-1)!;
    assert.deepEqual(filed.body.days, [], JSON.stringify(days));
  }
});

test("--days files the days given, and nothing it cannot read", async (t) => {
  const w = await workspace();
  t.after(w.close);
  for (const [days, filed] of [
    ["0", [0]],
    ["1,2,3", [1, 2, 3]],
    [" 1, 6 ", [1, 6]],
  ] as const) {
    const { code, out } = await w.run("routine", "--prompt", "x", "--time", "09:00", "--days", days);
    assert.equal(code, 0, JSON.stringify({ days, out }));
    assert.deepEqual(w.seen.filter((r) => r.method === "POST").at(-1)!.body.days, filed);
  }
  const before = w.seen.length;
  for (const days of [["--days", "mon"], ["--days", "1.5"], ["--days", "7"], ["--days", "-1"], ["--days", "1,,x"], ["--days", "1,"], ["--days"]]) {
    const { code, out } = await w.run("routine", "--prompt", "x", "--time", "09:00", ...days);
    assert.equal(code, 1, JSON.stringify(days));
    assert.match(out.error, /--days/);
  }
  // refused before even asking who it is, never mind filing anything
  assert.equal(w.seen.length, before);
});

test("--date alone runs once, and with --days, even empty ones, is refused", async (t) => {
  const w = await workspace();
  t.after(w.close);
  const later = ymd(new Date(Date.now() + 3 * 24 * 60 * 60_000));
  const { code } = await w.run("routine", "--prompt", "x", "--date", later, "--time", "09:00");
  assert.equal(code, 0);
  assert.deepEqual(w.seen.find((r) => r.method === "POST")!.body.days, []);
  for (const days of [["--days", "1"], ["--days="], ["--days", ""]]) {
    const { code, out } = await w.run("routine", "--prompt", "x", "--date", later, "--time", "09:00", ...days);
    assert.equal(code, 1, JSON.stringify(days));
    assert.match(out.error, /not both/);
  }
  assert.equal(w.seen.filter((r) => r.method === "POST").length, 1);
});

test("a date that has passed, does not exist, or comes with --days is refused before anything is filed", async (t) => {
  const w = await workspace();
  t.after(w.close);
  const yesterday = ymd(new Date(Date.now() - 24 * 60 * 60_000));
  for (const [args, said] of [
    [["--date", yesterday, "--time", "09:00"], /already passed/],
    [["--date", "2031-02-30", "--time", "09:00"], /no 2031-02-30/],
    [["--date", "next thursday", "--time", "09:00"], /a day like/],
    [["--date", "2031-03-03", "--time", "09:00", "--days", "1"], /not both/],
    [["--date", "2031-03-03", "--time", "25:00"], /time of day/],
  ] as const) {
    const { code, out } = await w.run("routine", "--prompt", "x", ...args);
    assert.equal(code, 1, JSON.stringify(args));
    assert.match(out.error, said);
  }
  assert.ok(!w.seen.some((r) => r.method === "POST"), "a refused routine was filed anyway");
});

test("routines lists what is scheduled, one-time ones with their date, without every past run", async (t) => {
  const w = await workspace();
  t.after(w.close);
  const { code, out } = await w.run("routines");
  assert.equal(code, 0);
  assert.deepEqual(out, [
    { id: "r1", name: "Morning brief", for: "bot-1", when: "Weekdays at 09:00", next: "2030-01-07 09:00", enabled: true },
    { id: "r2", name: "Supplier", for: "bot-1", when: "Once on Jan 8 at 09:00", once: "2030-01-08", next: "2030-01-08 09:00", enabled: true },
  ]);
});

test("unroutine drops one by id", async (t) => {
  const w = await workspace();
  t.after(w.close);
  const { code } = await w.run("unroutine", "r2");
  assert.equal(code, 0);
  assert.ok(w.seen.some((r) => r.method === "DELETE" && r.path === "/api/routines/r2"));
  assert.equal((await w.run("unroutine")).code, 1);
});

test("an agent changes and drops its own routines, and nobody else's", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "bloks-routine-own-"));
  const out = join(home, "answers.json");
  const cli = join(home, "fake-claude.mjs");
  // Told CALLS <base64 json>, makes each request with its turn credential
  // and writes down what came back.
  writeFileSync(
    cli,
    `#!${process.execPath}
import { writeFileSync } from "node:fs";
const [first] = process.argv.slice(2);
if (first === "--version") { console.log("9.9.9 (Claude Code)"); process.exit(0); }
if (first === "auth") { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", async () => {
  const asked = input.match(/CALLS ([A-Za-z0-9+\\/=]+)/);
  if (asked) {
    const calls = JSON.parse(Buffer.from(asked[1], "base64").toString("utf8"));
    const answers = [];
    for (const [method, path, body] of calls) {
      const res = await fetch(process.env.BLOKS_URL + path, {
        method,
        headers: { authorization: "Bearer " + process.env.BLOKS_TOKEN, "content-type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      answers.push({ status: res.status, body: await res.json().catch(() => null) });
    }
    writeFileSync(${JSON.stringify(out)}, JSON.stringify(answers));
  }
  console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "done" }));
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

  const { bot: me } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Planner" }) });
  await h.fetch(`/api/bots/${me.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } }) });
  const { bot: other } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Someone else" }) });
  const later = ymd(new Date(Date.now() + 2 * 24 * 60 * 60_000));
  const { routine: theirs } = await h.json("/api/routines", {
    method: "POST",
    body: JSON.stringify({ targetId: other.id, targetKind: "agent", prompt: "Their morning", time: "08:00", days: [] }),
  });
  const { routine: mine } = await h.json("/api/routines", {
    method: "POST",
    body: JSON.stringify({ targetId: me.id, targetKind: "agent", prompt: "Mine, once", time: "09:00", repeat: "once", date: later }),
  });
  assert.equal(mine.repeat, "once");

  rmSync(out, { force: true });
  const calls = [
    ["PATCH", `/api/routines/${theirs.id}`, { prompt: "rewritten" }],
    ["DELETE", `/api/routines/${theirs.id}`],
    ["PATCH", `/api/routines/${mine.id}`, { time: "10:00" }],
    ["DELETE", `/api/routines/${mine.id}`],
  ];
  await h.fetch(`/api/bots/${me.id}/messages`, { method: "POST", body: JSON.stringify({ text: `CALLS ${Buffer.from(JSON.stringify(calls)).toString("base64")}` }) });
  for (let i = 0; i < 400 && !existsSync(out); i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(existsSync(out), "the turn never ran");
  const [patchTheirs, dropTheirs, patchMine, dropMine] = JSON.parse(readFileSync(out, "utf8"));
  assert.equal(patchTheirs.status, 404);
  assert.equal(dropTheirs.status, 404);
  assert.equal(patchMine.status, 200, JSON.stringify(patchMine.body));
  assert.equal(patchMine.body.routine.time, "10:00");
  assert.equal(dropMine.status, 200);

  const { routines } = await h.json("/api/routines");
  const left = routines.find((r: any) => r.id === theirs.id);
  assert.ok(left, "another agent's routine was dropped");
  assert.equal(left.prompt, "Their morning");
  assert.ok(!routines.some((r: any) => r.id === mine.id));
});
