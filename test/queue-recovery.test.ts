// Messages still waiting when Bloks stops, and what happens to them when
// it starts again (server/index.ts, recoverQueued; GitHub 129).
//
// Being queued is not standing permission to act. A message queued a
// moment before a restart is sent once afterwards, and never again on a
// later restart. One queued too long ago, or by a version that did not
// record when (so nobody can say whether that version already answered
// it), is marked not sent and left for the person: on this restart and
// on every one after it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startHarness } from "./helpers/server.ts";

const waitFor = async <T,>(check: () => Promise<T | null | undefined> | T | null | undefined, ms = 15_000): Promise<T | null> => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const value = await check();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
};

test("recent queued work runs once after a restart; old and legacy queued work never runs on its own", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "bloks-recover-"));
  const calls: string[] = [];
  const held: Array<() => void> = [];
  let answerAtOnce = false;
  const provider = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url?.endsWith("/models")) return res.end(JSON.stringify({ data: [{ id: "grok-4" }] }));
      calls.push(body);
      const finish = () => res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "Done." } }] }));
      if (answerAtOnce) finish();
      else held.push(finish);
    });
  });
  await new Promise<void>((r) => provider.listen(0, "127.0.0.1", () => r()));
  t.after(async () => {
    held.forEach((f) => f());
    provider.closeAllConnections();
    provider.close();
    rmSync(home, { recursive: true, force: true });
  });
  const port = (provider.address() as { port: number }).port;
  const sent = (marker: string) => calls.filter((c) => c.includes(marker)).length;

  // a turn in flight, and one message queued behind it, when Bloks stops
  const first = await startHarness({ HOME: home });
  await first.json("/api/providers/grok/connect", { method: "POST", body: JSON.stringify({ key: "test-key", url: `http://127.0.0.1:${port}` }) });
  const { bot } = await first.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Recovering" }) });
  await first.fetch(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "grok", model: "grok-4" } }) });
  await first.fetch(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: "the first thing" }) });
  await waitFor(() => calls.length >= 1);
  const waiting = await first.json(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: "FRESH-WAITING" }) });
  assert.equal(waiting.queued, true);
  await first.stop();

  // and two the transcript says are waiting that should not be trusted:
  // one from before queued messages carried a time, one from yesterday
  const file = join(home, ".bloks", `messages-${bot.threadId}.json`);
  const list = JSON.parse(readFileSync(file, "utf8"));
  const fresh = list.find((m: any) => m.text === "FRESH-WAITING");
  assert.equal(typeof fresh?.queuedAt, "number", "a queued message records when it was queued");
  const day = 24 * 60 * 60_000;
  list.push(
    { id: "legacy-queued", at: Date.now() - 2 * day, role: "user", kind: "text", text: "LEGACY-WAITING", queued: true },
    { id: "stale-queued", at: Date.now() - day, role: "user", kind: "text", text: "STALE-WAITING", queued: true, queuedAt: Date.now() - day },
  );
  writeFileSync(file, JSON.stringify(list, null, 2));

  answerAtOnce = true;
  const second = await startHarness({ HOME: home });
  await waitFor(() => sent("FRESH-WAITING") >= 1);
  const read = async (h: typeof second) => {
    const { messages } = await h.json(`/api/bots/${bot.id}/messages?thread=${bot.threadId}&limit=500`);
    return (text: string) => messages.find((m: any) => m.text === text);
  };
  const settled = await waitFor(async () => {
    const find = await read(second);
    return find("FRESH-WAITING")?.queued === false && find("LEGACY-WAITING")?.unsent ? find : null;
  });
  assert.ok(settled, "the restart left something flagged queued");
  for (const text of ["LEGACY-WAITING", "STALE-WAITING"]) {
    const m = settled(text);
    assert.equal(m.queued, false, `${text} is no longer waiting`);
    assert.equal(m.unsent, true, `${text} is marked not sent`);
    assert.equal(m.text, text, "and kept, for the person to send again");
  }
  assert.ok(!settled("FRESH-WAITING").unsent);
  // give anything wrongly recovered time to reach the engine
  await new Promise((r) => setTimeout(r, 1_500));
  assert.equal(sent("FRESH-WAITING"), 1);
  assert.equal(sent("LEGACY-WAITING"), 0, "a message of unknown age was run unattended");
  assert.equal(sent("STALE-WAITING"), 0, "a message queued a day ago was run unattended");
  await second.stop();

  // a second restart runs none of them: the fresh one was sent, the old
  // ones were settled as not sent
  const third = await startHarness({ HOME: home });
  t.after(() => third.stop());
  await waitFor(async () => (await read(third))("FRESH-WAITING"));
  await new Promise((r) => setTimeout(r, 1_500));
  assert.equal(sent("FRESH-WAITING"), 1, "the recovered message ran again on the next restart");
  assert.equal(sent("LEGACY-WAITING"), 0);
  assert.equal(sent("STALE-WAITING"), 0);
});
