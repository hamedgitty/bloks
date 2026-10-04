// A watcher that speaks in a conversation the agent names (GitHub 138).
//
// Work started in the background ends after its turn does; the watcher
// that notices has to land where that work's context is, not in a fresh
// "Watching" lane. A named conversation is made if missing without moving
// the person off theirs, and a busy one queues the turn as it would a
// person's message.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cleanWatcher } from "../server/watchers.ts";
import { startHarness } from "./helpers/server.ts";

const waitFor = async <T,>(check: () => Promise<T | null | undefined> | T | null | undefined, ms = 20_000): Promise<T | null> => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const value = await check();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
};

test("thread is a lane title: one short line, optional", () => {
  const clean = (thread: unknown) => cleanWatcher({ kind: "page", botId: "b", target: "https://x.example", instruction: "Act.", thread }, () => true);
  const named = clean("  General  ");
  assert.ok(named.ok && named.value.thread === "General");
  const none = clean("   ");
  assert.ok(none.ok && none.value.thread === undefined);
  const long = clean("x".repeat(80));
  assert.ok(long.ok && long.value.thread!.length === 40);
});

test("a watcher's turn goes to the named conversation, made if missing, queued if busy", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "bloks-watch-thread-"));
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
  const h = await startHarness({ HOME: home });
  t.after(() => h.stop());
  await h.json("/api/providers/grok/connect", {
    method: "POST",
    body: JSON.stringify({ key: "test-key", url: `http://127.0.0.1:${(provider.address() as { port: number }).port}` }),
  });
  const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Builder" }) });
  await h.fetch(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "grok", model: "grok-4" } }) });
  const me = async () => (await h.json("/api/bots?messages=0")).bots.find((b: any) => b.id === bot.id);
  const general = (await me()).activeTaskId;

  // a folder the background work writes its result into
  const dir = mkdtempSync(join(home, "results-"));
  const watch = async (thread: string, name: string) => {
    const { watcher } = await h.json("/api/watchers", {
      method: "POST",
      body: JSON.stringify({ botId: bot.id, kind: "folder", target: dir, instruction: `Pick up the ${name} result.`, thread, name }),
    });
    assert.equal(watcher.thread, thread);
    await waitFor(async () => ((await h.json("/api/watchers")).watchers.find((w: any) => w.id === watcher.id)?.lastCheck ? true : null));
    return watcher.id as string;
  };

  // a conversation that does not exist yet is made, and the person stays where they are
  const buildsId = await watch("Builds", "build");
  writeFileSync(join(dir, "build-1.txt"), "ok");
  const fired = await h.json(`/api/watchers/${buildsId}/check`, { method: "POST" });
  assert.equal(fired.fired, true, fired.note);
  const after = await me();
  const builds = after.tasks.find((task: any) => task.title === "Builds");
  assert.ok(builds, "the named conversation was not made");
  assert.equal(after.activeTaskId, general, "firing moved the person off their conversation");
  assert.ok(!after.tasks.some((task: any) => /^Watching/.test(task.title)), "it still made a Watching lane");
  await waitFor(() => (calls.some((c) => c.includes("Pick up the build result")) ? true : null));
  await waitFor(async () => ((await me()).tasks.every((task: any) => task.state !== "working") ? true : null));
  await h.fetch(`/api/watchers/${buildsId}`, { method: "DELETE" });

  // the person's own conversation, busy: the watcher waits its turn there.
  // A check, because a folder watcher does not look while its agent works
  // (its own edits are not news) and would simply fire after the turn.
  const result = join(dir, "tests-1.txt");
  const { watcher: check } = await h.json("/api/watchers", {
    method: "POST",
    body: JSON.stringify({
      botId: bot.id,
      kind: "check",
      // full paths: the test server runs with an empty PATH
      target: `test -f "${result}" && /bin/cat "${result}"`,
      instruction: "Pick up the test run result.",
      thread: "General",
      name: "test run",
    }),
  });
  const generalId = check.id as string;
  await waitFor(async () => ((await h.json("/api/watchers")).watchers.find((w: any) => w.id === generalId)?.lastCheck ? true : null));
  hold = true;
  await h.fetch(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: "start the long job" }) });
  await waitFor(() => (calls.some((c) => c.includes("start the long job")) ? true : null));
  writeFileSync(result, "passed");
  const queued = await h.json(`/api/watchers/${generalId}/check`, { method: "POST" });
  assert.equal(queued.fired, true, queued.note);
  const { messages } = await h.json(`/api/bots/${bot.id}/messages?thread=${general}&limit=50`);
  const waiting = messages.find((m: any) => m.via === "watcher" && /test run/.test(m.text));
  assert.ok(waiting, "the watcher's message is not in General");
  assert.equal(waiting.queued, true, "it should wait behind the running turn");
  assert.ok(!calls.some((c) => c.includes("Pick up the test run result")), "it started a turn on top of a busy conversation");

  hold = false;
  held.splice(0).forEach((f) => f());
  assert.ok(await waitFor(() => (calls.some((c) => c.includes("Pick up the test run result")) ? true : null)), "the queued watcher turn never ran");
});
