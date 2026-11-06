// A watcher at its hourly cap delays a finding; it never drops it
// (GitHub 496).
//
// A look held back by the cap used to save what it saw as seen, so the
// next look found nothing new and the agent was never woken for it. Every
// kind that remembers what it saw (a check, a page, a feed, a folder, a
// place) is held here with a real finding, looked at again while still
// held, and then let go: the first look the hour allows has to act on it.
// A look skipped because the agent is busy leaves what was seen alone too.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

import { heldBackWords, mayFire, nextAllowedAt } from "../server/watchers.ts";
import { startHarness, type Harness } from "./helpers/server.ts";

const PHONE_TOKEN = ["fixture", "held", "back", "phone", "0123456789"].join("-");
const digest = (token: string) => createHash("sha256").update(token).digest("hex");
const MIN = 60_000;

/** A Claude Code stand-in that writes down every message it is given. One
 * that says HOLD <path> stays busy until that file exists. */
function standIn(home: string) {
  const heard = join(home, "heard.jsonl");
  const cli = join(home, "fake-claude.mjs");
  writeFileSync(
    cli,
    `#!${process.execPath}
import { appendFileSync, existsSync } from "node:fs";
const [first] = process.argv.slice(2);
if (first === "--version") { console.log("2.1.299 (Claude Code)"); process.exit(0); }
if (first === "auth") { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
let input = "";
((go) => { let line = ""; const take = (c) => { line += c; while (line.includes(String.fromCharCode(10))) { const at = line.indexOf(String.fromCharCode(10)); const next = line.slice(0, at); line = line.slice(at + 1); if (!next.trim() || JSON.parse(next).type !== "user") continue; input = next; process.stdin.off("data", take); go(); return; } }; process.stdin.on("data", take); })(async () => {
  appendFileSync(${JSON.stringify(heard)}, JSON.stringify(input) + String.fromCharCode(10));
  const hold = input.match(/HOLD (\\S+?)(?:\\\\|")/);
  if (hold) while (!existsSync(hold[1])) await new Promise((r) => setTimeout(r, 50));
  console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "On it." }));
});
`,
    { mode: 0o755 },
  );
  return { cli, heard };
}

async function waitFor<T>(check: () => Promise<T | null | undefined> | T | null | undefined, ms = 20_000): Promise<T | null> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const value = await check();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

/** A page and a feed on this machine, whose words the test changes. */
async function source() {
  const state = {
    page: "Prices\nThe basic plan is $10 a month.",
    items: [{ id: "post-1", title: "First post" }],
  };
  const server: Server = createServer((req, res) => {
    if (req.url === "/feed") {
      res.setHeader("content-type", "application/rss+xml");
      const items = state.items.map((i) => `<item><title>${i.title}</title><guid>${i.id}</guid></item>`).join("");
      res.end(`<?xml version="1.0"?><rss><channel><title>Notes</title>${items}</channel></rss>`);
      return;
    }
    res.setHeader("content-type", "text/html");
    res.end(`<html><body>${state.page.split("\n").map((line) => `<p>${line}</p>`).join("")}</body></html>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { state, url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

const TORONTO = { locality: "Toronto", region: "Ontario", country: "Canada", timeZone: "America/Toronto" };
const MONTREAL = { locality: "Montreal", region: "Quebec", country: "Canada", timeZone: "America/Toronto" };
const reading = (ago: number, place: Record<string, unknown>) => ({
  sharing: "on",
  background: true,
  location: { observedAt: Date.now() - ago, place, trigger: "moved" },
});

test("a look held back by the hourly cap keeps the finding as news, for every kind, and a busy look keeps it too", { timeout: 240_000 }, async (t) => {
  const home = mkdtempSync(join(tmpdir(), "bloks-held-back-"));
  const fake = standIn(home);
  const web = await source();
  const folder = join(home, "drops");
  mkdirSync(folder);
  const flag = join(home, "supplier.txt");
  const release = join(home, "release");
  mkdirSync(join(home, ".bloks"), { recursive: true });
  writeFileSync(
    join(home, ".bloks", "config.json"),
    JSON.stringify({
      profile: { name: "Sam" },
      brief: { enabled: false },
      backups: { auto: false },
      instances: { claude: { driver: "claudeAgent", config: { cli: fake.cli } } },
      remote: { enabled: true, devices: [{ id: "sams-iphone", name: "Sam's iPhone", hash: digest(PHONE_TOKEN), pairedAt: 1 }] },
    }),
  );
  let h: Harness = await startHarness({ HOME: home });
  t.after(async () => {
    await h.stop();
    await web.close();
    rmSync(home, { recursive: true, force: true });
  });
  const heard = () => (existsSync(fake.heard) ? readFileSync(fake.heard, "utf8") : "");
  const phone = (body: unknown) => h.fetchRemote("/api/location", { method: "POST", token: PHONE_TOKEN, body: JSON.stringify(body) });
  const saved = (): any[] => JSON.parse(readFileSync(join(home, ".bloks", "watchers.json"), "utf8"));
  const remembered = (id: string) => {
    const w = saved().find((x) => x.id === id);
    return { seen: w.seen, seenItems: w.seenItems };
  };
  const look = (id: string) => h.json(`/api/watchers/${id}/check`, { method: "POST" });

  const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Keeper" }) });
  await h.fetch(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } }) });
  const me = async () => (await h.json("/api/bots?messages=0")).bots.find((b: any) => b.id === bot.id);
  const idle = () => waitFor(async () => ((await me())?.busy ? null : true));

  // ── five watchers, each with its baseline taken
  // Montreal, hours ago, is the side the place watcher starts from
  await phone(reading(3 * 60 * MIN, MONTREAL));
  const file = async (body: Record<string, unknown>) => {
    const made = await h.json("/api/watchers", { method: "POST", body: JSON.stringify({ botId: bot.id, instruction: "Tell me about it.", ...body }) });
    assert.ok(made.watcher, JSON.stringify(made));
    return made.watcher.id as string;
  };
  const ids = {
    check: await file({ kind: "check", name: "Supplier", target: `test -f "${flag}" && /bin/cat "${flag}"` }),
    page: await file({ kind: "page", name: "Prices", target: `${web.url}/page` }),
    feed: await file({ kind: "feed", name: "Notes", target: `${web.url}/feed` }),
    folder: await file({ kind: "folder", name: "Drops", target: folder }),
    place: await file({ kind: "place", name: "Toronto", target: "Toronto" }),
  };
  for (const [kind, id] of Object.entries(ids)) {
    assert.ok(
      await waitFor(() => {
        const w = saved().find((x) => x.id === id);
        return w?.lastCheck && (w.seen !== undefined || w.seenItems) ? true : null;
      }),
      `the ${kind} watcher never took its baseline`,
    );
  }

  // ── each has started its six turns in the last hour, while Bloks was closed
  await h.stop();
  const general = (await (async () => {
    h = await startHarness({ HOME: home });
    return (await me()).tasks[0];
  })()) as { id: string; title: string };
  await h.stop();
  const recent = Array.from({ length: 6 }, (_, i) => ({ at: Date.now() - (50 - i * 5) * MIN, summary: `Earlier finding ${i + 1}` }));
  const rewrite = (change: (w: any) => void) => {
    const list = saved();
    for (const w of list) change(w);
    writeFileSync(join(home, ".bloks", "watchers.json"), JSON.stringify(list));
  };
  rewrite((w) => {
    w.fires = recent;
    // the page speaks in General by its id, so a busy General holds its look
    if (w.id === ids.page) Object.assign(w, { laneId: general.id, thread: general.title });
  });
  h = await startHarness({ HOME: home });
  const before = Object.fromEntries(Object.entries(ids).map(([kind, id]) => [kind, remembered(id)]));

  // ── something new for each, while every one of them is at its cap
  writeFileSync(flag, "Acme replied: the parts ship Friday.");
  web.state.page += "\nThe basic plan is now $8 a month.";
  web.state.items.unshift({ id: "post-2", title: "Second post" });
  writeFileSync(join(folder, "invoice-0042.pdf"), "an invoice");
  for (const kind of ["check", "page", "feed", "folder"] as const) {
    for (const attempt of ["first", "second"]) {
      const held = await look(ids[kind]);
      assert.equal(held.fired, false, `the ${kind} watcher fired past its cap`);
      assert.match(held.note, /Held back/, `the ${attempt} look of the ${kind} watcher did not see the finding as news any more`);
    }
    assert.deepEqual(remembered(ids[kind]), before[kind], `a held-back look saved what the ${kind} watcher saw as seen`);
  }
  // Arriving, heard just inside the half hour a crossing stays fresh: by
  // the time the hour allows a turn, the reading is older than that, and
  // the wait was the cap's, not the phone's.
  const arrivedAt = Date.now();
  await phone(reading(29.5 * MIN, TORONTO));
  const placeHeld = await waitFor(async () => {
    const w = (await h.json("/api/watchers")).watchers.find((x: any) => x.id === ids.place);
    return /Held back/.test(w?.lastError ?? "") ? w : null;
  });
  assert.ok(placeHeld, "arriving at Toronto past the cap was not held back");
  assert.deepEqual(remembered(ids.place), before.place, "a held-back look saved the place watcher's side as seen");
  assert.doesNotMatch(heard(), /Acme replied|now \$8|Second post|invoice-0042|arrived in Toronto/, "a held-back finding reached the agent");

  // ── the hour passes while Bloks is closed, longer than a crossing stays fresh
  await h.stop();
  rewrite((w) => {
    w.fires = recent.map((f) => ({ ...f, at: f.at - 2 * 60 * MIN }));
  });
  h = await startHarness({ HOME: home });

  // the first look the hour allows acts on what was held, one at a time
  const told: Record<string, RegExp> = {
    check: /ran its check[\s\S]*Acme replied: the parts ship Friday/,
    page: /noticed a change in the page[\s\S]*now \$8 a month/,
    feed: /noticed a change in the feed[\s\S]*Second post/,
    folder: /noticed a change in the folder[\s\S]*invoice-0042\.pdf/,
  };
  for (const kind of ["check", "page", "feed", "folder"] as const) {
    const fired = await look(ids[kind]);
    assert.equal(fired.fired, true, `the ${kind} watcher dropped its held-back finding: ${fired.note}`);
    assert.ok(await waitFor(() => told[kind].test(heard())), `the agent never heard the ${kind} watcher's finding`);
    await idle();
  }
  await new Promise((r) => setTimeout(r, Math.max(0, arrivedAt + 35_000 - Date.now())));
  const arrived = await look(ids.place);
  assert.equal(arrived.fired, true, `the place watcher dropped its held-back arrival as late: ${arrived.note}`);
  assert.ok(await waitFor(() => /has arrived in Toronto/.test(heard())), "the agent never heard of the arrival");
  await idle();

  // ── a look skipped while the agent works leaves what was seen alone
  await h.fetch(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: `HOLD ${release}` }) });
  assert.ok(await waitFor(async () => ((await me())?.busy ? true : null)), "the agent never got busy");
  web.state.page += "\nThe team plan is $30 a month.";
  writeFileSync(join(folder, "invoice-0043.pdf"), "another invoice");
  for (const kind of ["page", "folder"] as const) {
    const was = remembered(ids[kind]);
    const skipped = await look(ids[kind]);
    assert.equal(skipped.fired, false);
    assert.match(skipped.note, /working/, `the ${kind} watcher looked while its agent was busy`);
    assert.deepEqual(remembered(ids[kind]), was, `a look skipped while busy saved what the ${kind} watcher saw`);
  }
  writeFileSync(release, "");
  await idle();
  for (const kind of ["page", "folder"] as const) {
    const fired = await look(ids[kind]);
    assert.equal(fired.fired, true, `the ${kind} watcher lost what changed while its agent was busy: ${fired.note}`);
    await idle();
  }
  assert.match(heard(), /team plan is \$30/);
  assert.match(heard(), /invoice-0043\.pdf/);
});

test("when a held finding gets its turn, in words that need no time zone", () => {
  const now = Date.UTC(2026, 10, 5, 12, 0);
  const at = (minutesAgo: number) => ({ at: now - minutesAgo * MIN, summary: "s" });
  // room already: now
  assert.equal(nextAllowedAt({ fires: [at(10), at(70)] }, now), now);
  // six in the hour, the oldest fifty minutes ago: ten minutes from now
  const six = { fires: [at(5), at(15), at(20), at(30), at(40), at(50), at(90)] };
  assert.equal(nextAllowedAt(six, now), now + 10 * MIN);
  assert.equal(mayFire(six, now), false);
  assert.equal(mayFire(six, now + 10 * MIN), true);
  assert.equal(heldBackWords(six, now), "Held back: it already started 6 turns in the last hour. What it found waits for the next turn allowed, in 10 minutes.");
  assert.match(heldBackWords({ fires: [at(5), at(15), at(20), at(30), at(40), at(59.9)] }, now), /in 1 minute\.$/);
});
