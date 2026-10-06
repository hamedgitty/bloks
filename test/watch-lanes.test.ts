// A watcher's own conversation, and what happens to it (GitHub 166).
//
// Removing a watcher used to leave its "Watching" lane open, and enough of
// those filled the agent's limit with lanes it was not allowed to close.
// Now the lane goes with the watcher (after its turn, if one is running)
// and ones already left behind are closed on start, unless the person
// talked in them; a full agent is told what is open and how to do without, and
// `bloks watch` says when it did not get the interval it asked for.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { laneLimitError, orphanWatcherLanes } from "../server/watchers.ts";
import { startHarness } from "./helpers/server.ts";

const BLOKS = fileURLToPath(new URL("../bin/bloks.mjs", import.meta.url));

const waitFor = async <T,>(check: () => Promise<T | null | undefined> | T | null | undefined, ms = 20_000): Promise<T | null> => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const value = await check();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
};

test("a full agent is told what is open and about --thread, in a watcher's last error", () => {
  const titles = ["General", ...Array.from({ length: 19 }, (_, i) => `Watching: something long number ${i}`)];
  const said = laneLimitError("Builder", titles);
  assert.ok(said.length <= 200, said);
  assert.match(said, /^Builder has 20 conversations open/);
  assert.match(said, /General, Watching: something long number 0/);
  assert.match(said, /and \d+ more/);
  assert.match(said, /--thread/);
  // nothing fits: still the count and the way out
  assert.match(laneLimitError("x".repeat(150), titles), /20 conversations open.*--thread/);
});

test("only an idle, unclaimed Watching lane nobody else spoke in is left behind", () => {
  const tasks = [
    { id: "general", title: "Watching: General renamed" },
    { id: "gone", title: "Watching: build" },
    { id: "kept", title: "Watching: deploy" },
    { id: "busy", title: "Watching: tests", busy: true },
    { id: "talked", title: "Watching: inbox" },
    { id: "named", title: "Watching: by name" },
    { id: "other", title: "Builds" },
  ];
  const watchers = [{ laneId: "kept" }, { thread: "Watching: by name" }];
  assert.deepEqual(
    orphanWatcherLanes(tasks, watchers, (id) => id === "talked"),
    ["gone"],
  );
});

test("bloks watch says when the interval was not the one asked for", async (t) => {
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}");
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ watcher: { id: "w1", ...body, every: Math.min(1440, Math.max(5, body.every ?? 30)) } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const watch = (...args: string[]) =>
    new Promise<any>((resolve) => {
      execFile(process.execPath, [BLOKS, "watch", "--do", "Act.", ...args], { env: { ...process.env, BLOKS_URL: url, BLOKS_TOKEN: "turn-token" } }, (_e, stdout) =>
        resolve(JSON.parse(stdout)),
      );
    });
  assert.equal((await watch("--page", "https://x.example", "--every", "2")).note, "Checks every 5 minutes (the minimum; you asked for 2).");
  assert.equal((await watch("--check", "true", "--every", "5000")).note, "Checks every 1440 minutes (the maximum; you asked for 5000).");
  assert.equal((await watch("--page", "https://x.example", "--every", "15")).note, undefined);
  assert.equal((await watch("--page", "https://x.example")).note, undefined);
  // a folder is watched as it changes; its interval is only a fallback
  assert.equal((await watch("--folder", "/tmp", "--every", "2")).note, undefined);
});

test("removing a watcher closes its lane, and lanes left behind close on start", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "bloks-watch-lanes-"));
  const calls: string[] = [];
  const held: Array<() => void> = [];
  let hold = false;
  const provider = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url?.endsWith("/models")) return res.end(JSON.stringify({ data: [{ id: "grok-4" }] }));
      const messages = JSON.parse(body).messages ?? [];
      calls.push(String(messages[messages.length - 1]?.content ?? ""));
      const finish = () => res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "Noted." } }] }));
      if (hold) held.push(finish);
      else finish();
    });
  });
  await new Promise<void>((r) => provider.listen(0, "127.0.0.1", () => r()));
  t.after(async () => {
    held.forEach((f) => f());
    provider.closeAllConnections();
    provider.close();
    rmSync(home, { recursive: true, force: true });
  });
  let h = await startHarness({ HOME: home });
  t.after(() => h.stop());
  await h.json("/api/providers/grok/connect", {
    method: "POST",
    body: JSON.stringify({ key: "test-key", url: `http://127.0.0.1:${(provider.address() as { port: number }).port}` }),
  });
  const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Builder" }) });
  await h.fetch(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "grok", model: "grok-4" } }) });
  const me = async () => (await h.json("/api/bots?messages=0")).bots.find((b: any) => b.id === bot.id);
  const titles = async () => (await me()).tasks.map((task: any) => task.title as string);
  const idle = () => waitFor(async () => ((await me()).tasks.every((task: any) => !task.busy && task.state !== "working") ? true : null));

  // a watcher that has fired once, so it has a lane of its own
  const fired = async (name: string) => {
    const dir = mkdtempSync(join(home, "watched-"));
    const { watcher } = await h.json("/api/watchers", {
      method: "POST",
      body: JSON.stringify({ botId: bot.id, kind: "folder", target: dir, instruction: `Note the ${name} change.`, name }),
    });
    await waitFor(async () => ((await h.json("/api/watchers")).watchers.find((w: any) => w.id === watcher.id)?.lastCheck ? true : null));
    writeFileSync(join(dir, "new.txt"), "x");
    const look = await h.json(`/api/watchers/${watcher.id}/check`, { method: "POST" });
    assert.equal(look.fired, true, look.note);
    await waitFor(() => (calls.some((c) => c.includes(`Note the ${name} change`)) ? true : null));
    return watcher.id as string;
  };

  // idle: the lane closes with it
  const build = await fired("build");
  await idle();
  assert.ok((await titles()).includes("Watching: build"));
  await h.fetch(`/api/watchers/${build}`, { method: "DELETE" });
  assert.ok(!(await titles()).includes("Watching: build"), "the lane stayed open");

  // mid-turn: it closes once the turn is done, not under it
  hold = true;
  const deploy = await fired("deploy");
  await h.fetch(`/api/watchers/${deploy}`, { method: "DELETE" });
  assert.ok((await titles()).includes("Watching: deploy"), "it closed a lane that was working");
  hold = false;
  held.splice(0).forEach((f) => f());
  assert.ok(await waitFor(async () => (!(await titles()).includes("Watching: deploy") ? true : null)), "it never closed after the turn");

  // the person talked in it: theirs now, and it stays
  const talked = await fired("talked");
  await idle();
  const talkedLane = (await h.json("/api/watchers")).watchers.find((w: any) => w.id === talked).laneId;
  await h.fetch(`/api/bots/${bot.id}/tasks/${talkedLane}/activate`, { method: "POST" });
  await h.fetch(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: "keep an eye on this one" }) });
  await waitFor(() => (calls.some((c) => c.includes("keep an eye on this one")) ? true : null));
  await idle();
  await h.fetch(`/api/watchers/${talked}`, { method: "DELETE" });
  assert.ok((await titles()).includes("Watching: talked"), "it closed a lane the person talked in");

  // left behind by an older version, which removed the watcher only
  const left = await fired("left");
  await idle();
  await h.stop();
  const file = join(home, ".bloks", "watchers.json");
  writeFileSync(file, JSON.stringify(JSON.parse(readFileSync(file, "utf8")).filter((w: any) => w.id !== left)));
  h = await startHarness({ HOME: home });
  const after = await titles();
  assert.ok(!after.includes("Watching: left"), "the orphaned lane is still open");
  assert.ok(after.includes("Watching: talked"), "it closed a lane the person talked in");
  assert.ok(after.includes("General"));
});

test("a full agent's watcher says what is open instead of only 'close one'", async (t) => {
  const h = await startHarness();
  t.after(() => h.stop());
  const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Builder" }) });
  for (let i = 2; i <= 20; i++) await h.json(`/api/bots/${bot.id}/tasks`, { method: "POST", body: JSON.stringify({ title: `Lane ${i}` }) });
  const dir = mkdtempSync(join(tmpdir(), "bloks-watch-full-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { watcher } = await h.json("/api/watchers", {
    method: "POST",
    body: JSON.stringify({ botId: bot.id, kind: "folder", target: dir, instruction: "Note it.", name: "full" }),
  });
  await waitFor(async () => ((await h.json("/api/watchers")).watchers.find((w: any) => w.id === watcher.id)?.lastCheck ? true : null));
  writeFileSync(join(dir, "new.txt"), "x");
  const look = await h.json(`/api/watchers/${watcher.id}/check`, { method: "POST" });
  assert.equal(look.fired, false);
  assert.match(look.note, /20 conversations open.*General, Lane 2.*--thread/);
});
