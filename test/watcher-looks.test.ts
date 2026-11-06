// What a watcher's last looks found (GitHub 496): kept per watcher,
// bounded, cheap to write, and gone with the watcher. Looks alike in a
// row are one entry, so a quiet afternoon or a long turn does not push
// the one held-back look out of the fifty.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { allows } from "../server/agent-cli.ts";
import { addLook, lookHistory, LookLog, MAX_DETAIL, MAX_LOOKS, type Look } from "../server/watcher-looks.ts";
import { startHarness } from "./helpers/server.ts";
import { waitFor } from "./helpers/turns.ts";

const T = Date.UTC(2026, 10, 5, 12, 0);
const MIN = 60_000;
const fold = (looks: Look[]) => looks.reduce<Look[]>((list, look) => addLook(list, look), []);

test("looks alike in a row are one entry with a count and a span; a turn and a failure stand alone", () => {
  const list = fold([
    { at: T, outcome: "quiet", detail: "Took its first look as the baseline." },
    { at: T + 5 * MIN, outcome: "quiet" },
    { at: T + 10 * MIN, outcome: "quiet" },
    { at: T + 15 * MIN, outcome: "fired", detail: "+ Now $8" },
    { at: T + 16 * MIN, outcome: "busy", detail: "Ada was working." },
    { at: T + 17 * MIN, outcome: "busy", detail: "Ada was working." },
    { at: T + 18 * MIN, outcome: "busy", detail: "Ada was being held." },
    { at: T + 20 * MIN, outcome: "held", detail: "+ Now $7", nextAt: T + 40 * MIN },
    { at: T + 25 * MIN, outcome: "held", detail: "+ Now $7", nextAt: T + 41 * MIN },
    { at: T + 30 * MIN, outcome: "failed", detail: "The page answered 500." },
    { at: T + 35 * MIN, outcome: "failed", detail: "The page answered 500." },
    { at: T + 40 * MIN, outcome: "fired", detail: "+ Now $7" },
    { at: T + 45 * MIN, outcome: "fired", detail: "+ Now $7" },
  ]);
  assert.deepEqual(list, [
    { at: T + 45 * MIN, outcome: "fired", detail: "+ Now $7" },
    { at: T + 40 * MIN, outcome: "fired", detail: "+ Now $7" },
    { at: T + 35 * MIN, outcome: "failed", detail: "The page answered 500." },
    { at: T + 30 * MIN, outcome: "failed", detail: "The page answered 500." },
    { at: T + 25 * MIN, outcome: "held", detail: "+ Now $7", nextAt: T + 41 * MIN, count: 2, from: T + 20 * MIN },
    { at: T + 18 * MIN, outcome: "busy", detail: "Ada was being held." },
    { at: T + 17 * MIN, outcome: "busy", detail: "Ada was working.", count: 2, from: T + 16 * MIN },
    { at: T + 15 * MIN, outcome: "fired", detail: "+ Now $8" },
    { at: T + 10 * MIN, outcome: "quiet", count: 2, from: T + 5 * MIN },
    { at: T, outcome: "quiet", detail: "Took its first look as the baseline." },
  ]);
});

test("at most fifty entries, each one line of at most two hundred characters", () => {
  const many = fold(Array.from({ length: 80 }, (_, i): Look => ({ at: T + i * MIN, outcome: "fired", detail: `Finding ${i}` })));
  assert.equal(many.length, MAX_LOOKS);
  assert.equal(many[0].detail, "Finding 79");
  assert.equal(many.at(-1)!.detail, "Finding 30");
  const [long] = addLook([], { at: T, outcome: "failed", detail: `\n  ${"x".repeat(500)}\nsecond line` });
  assert.equal(long.detail, "x".repeat(MAX_DETAIL));
});

test("turns started before the oldest look are shown after the looks, a look's own turn once", () => {
  const looks: Look[] = [
    { at: T + 30 * MIN, outcome: "quiet", count: 3, from: T + 20 * MIN },
    { at: T + 10 * MIN, outcome: "fired", detail: "+ Now $8" },
  ];
  const fires = [
    { at: T + 10 * MIN, summary: "+ Now $8" },
    { at: T - 60 * MIN, summary: "+ Now $9" },
    { at: T - 120 * MIN, summary: "" },
  ];
  assert.deepEqual(lookHistory(looks, fires), [
    ...looks,
    { at: T - 60 * MIN, outcome: "fired", detail: "+ Now $9" },
    { at: T - 120 * MIN, outcome: "fired" },
  ]);
  // a watcher from before looks were kept still shows when it acted
  assert.deepEqual(lookHistory([], [{ at: T, summary: "New: invoice.pdf" }]), [{ at: T, outcome: "fired", detail: "New: invoice.pdf" }]);
});

test("the file is one line a look, read back as it was, rewritten only past its bound or when a watcher goes", () => {
  const dir = mkdtempSync(join(tmpdir(), "bloks-looks-"));
  try {
    const file = join(dir, "data", "watcher-looks.jsonl");
    const log = new LookLog(file);
    assert.deepEqual(log.list("w1"), []);
    log.record("w1", { at: T, outcome: "quiet", detail: "Took its first look as the baseline." });
    log.record("w1", { at: T + MIN, outcome: "quiet" });
    log.record("w1", { at: T + 2 * MIN, outcome: "quiet" });
    log.record("w2", { at: T + 3 * MIN, outcome: "held", detail: "Acme replied", nextAt: T + 30 * MIN });
    log.record("w1", { at: T + 4 * MIN, outcome: "fired", detail: "Acme replied" });
    // appended, one line each, and only readable by this user
    assert.equal(readFileSync(file, "utf8").trim().split("\n").length, 5);
    if (process.platform !== "win32") {
      assert.equal(statSync(file).mode & 0o777, 0o600);
    }
    const again = new LookLog(file);
    assert.deepEqual(again.list("w1"), log.list("w1"));
    assert.deepEqual(again.list("w1")[1], { at: T + 2 * MIN, outcome: "quiet", count: 2, from: T + MIN });
    assert.deepEqual(again.list("w2"), [{ at: T + 3 * MIN, outcome: "held", detail: "Acme replied", nextAt: T + 30 * MIN }]);

    // a watcher removed takes what it found off the disk with it
    again.forget("w2");
    assert.doesNotMatch(readFileSync(file, "utf8"), /"w":"w2"/);
    assert.equal(readFileSync(file, "utf8").trim().split("\n").length, 3, "the rewrite did not keep w1's entries as entries");
    assert.deepEqual(new LookLog(file).list("w1"), log.list("w1"));
    again.keepOnly([]);
    assert.equal(readFileSync(file, "utf8"), "");

    // a line cut short by a crash is skipped, not the whole history
    writeFileSync(file, `${JSON.stringify({ w: "w3", at: T, outcome: "quiet" })}\n{"w":"w3","at":`);
    assert.deepEqual(new LookLog(file).list("w3"), [{ at: T, outcome: "quiet" }]);

    // past its bound the file is written again with only what is kept
    const busy = new LookLog(join(dir, "busy.jsonl"));
    for (let i = 0; i < 10_050; i++) busy.record(`w${i % 50}`, { at: T + i, outcome: "fired", detail: `Finding ${i}` });
    const lines = readFileSync(join(dir, "busy.jsonl"), "utf8").trim().split("\n").length;
    assert.ok(lines <= 50 * MAX_LOOKS + 50, `the file kept ${lines} lines`);
    assert.deepEqual(new LookLog(join(dir, "busy.jsonl")).list("w7"), busy.list("w7"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an agent reads its own watchers' looks, and nothing else of them", () => {
  assert.equal(allows("me", "GET", "/api/watchers/own-id/looks").ok, true);
  assert.equal(allows("me", "DELETE", "/api/watchers/own-id/looks").ok, false);
  assert.equal(allows("me", "POST", "/api/watchers/own-id/looks").ok, false);
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

test("bloks watch-history prints each look in local time, in words", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "bloks-looks-cli-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const asked: string[] = [];
  const at = new Date(2026, 10, 5, 14, 5).getTime();
  const server = createServer((req, res) => {
    asked.push(`${req.method} ${req.url}`);
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        looks: [
          { at, outcome: "held", detail: "Acme replied", nextAt: at + 20 * MIN },
          { at: at - 10 * MIN, outcome: "quiet", count: 12, from: at - 70 * MIN },
          { at: at - 80 * MIN, outcome: "busy", detail: "Ada was working." },
        ],
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const printed = await runCli(["watch-history", "w 1"], home, url);
  assert.equal(printed.status, 0);
  assert.deepEqual(asked, ["GET /api/watchers/w%201/looks"]);
  assert.deepEqual(printed.body, [
    { at: "2026-11-05 14:05", outcome: "held back", detail: "Acme replied", nextTurnAllowed: "2026-11-05 14:25" },
    { at: "2026-11-05 13:55", outcome: "nothing new", looks: 12, since: "2026-11-05 12:55" },
    { at: "2026-11-05 12:45", outcome: "skipped, busy", detail: "Ada was working." },
  ]);
  const missing = await runCli(["watch-history"], home, url);
  assert.equal(missing.status, 1);
  assert.match(missing.body.error, /needs a watcher id/);
  const help = (await runCli(["help"], home, url)).body.commands.find((c: any) => c.name === "watch-history");
  assert.match(help.about, /held back by its hourly limit \(with when the next turn is allowed\)/);
});

test("through the server: a look that fails is kept, the list stays light, and removing the watcher removes its looks", async (t) => {
  const h = await startHarness();
  t.after(() => h.stop());
  const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Looker" }) });
  // port 9 answers nobody, so every look at it fails
  const { watcher } = await h.json("/api/watchers", {
    method: "POST",
    body: JSON.stringify({ botId: bot.id, kind: "page", target: "http://127.0.0.1:9/menu", instruction: "Say when the menu changes.", name: "Menu" }),
  });
  const looks = async () => (await h.json(`/api/watchers/${watcher.id}/looks`)).looks as Look[];
  assert.ok(await waitFor(async () => (await looks()).length === 1), "the first look was not kept");
  await h.json(`/api/watchers/${watcher.id}/check`, { method: "POST" });
  const kept = await looks();
  assert.equal(kept.length, 2, "two failures in a row were folded into one");
  for (const look of kept) {
    assert.equal(look.outcome, "failed");
    assert.ok(look.detail && look.detail.length > 0);
  }
  assert.ok(kept[0].at >= kept[1].at);
  // the list every look redraws does not carry them
  const listed = (await h.json("/api/watchers")).watchers.find((w: any) => w.id === watcher.id);
  assert.equal(listed.looks, undefined);
  assert.equal((await h.fetch("/api/watchers/nobody/looks")).status, 404);

  const file = join(h.home, ".bloks", "watcher-looks.jsonl");
  assert.ok(existsSync(file));
  assert.match(readFileSync(file, "utf8"), new RegExp(watcher.id));
  assert.equal((await h.fetch(`/api/watchers/${watcher.id}`, { method: "DELETE" })).status, 200);
  assert.doesNotMatch(readFileSync(file, "utf8"), new RegExp(watcher.id), "a removed watcher's looks stayed on disk");
});
