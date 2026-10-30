// The person's compaction budget is what fills, while the model window
// stays visible. HTTP checks use the real server and a synthetic Codex.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeTurnLine, compactBeforeTurn, laneFill, type Reading } from "../server/context.ts";
import { activityContext, contextCard, contextTitle, ringLabel } from "../src/lib/contextCard.ts";
import { codexCommands, waitFor } from "./helpers/codex-commands.ts";

const selection = { instanceId: "codex", model: "gpt-6.1-sol" };
const reading: Reading = { used: 174_000, window: 1_000_000, ...selection, at: 1 };

test("174k measures against the actual 400k before-turn line, with the window preserved", () => {
  const settings = { ceiling: 400_000, at: 0.6 };
  const fill = laneFill(reading, selection, settings);
  assert.equal(fill.limit, beforeTurnLine({ window: reading.window, ...settings }));
  assert.equal(fill.used, 174_000);
  assert.equal(fill.modelLimit, 1_000_000);
  assert.equal(fill.fraction, 0.435);
  assert.equal(fill.window, "engine");
  const lane = { ...fill, summarised: false };
  assert.deepEqual(contextCard(lane), {
    share: "44% full", tokens: "174k of 400k tokens", summarised: null,
    compaction: "Summarises at 400k. Model max 1M.",
  });
  assert.equal(ringLabel(lane), "Context 44% full");
  assert.equal(contextTitle(lane), "Context: 44% full (174k of 400k tokens)");
  assert.equal(activityContext(fill), null, "Activity keeps its half-full threshold");
});

test("off keeps the window, and a larger ceiling still follows the saved share", () => {
  const off = laneFill(reading, selection, { ceiling: 0 });
  assert.equal(off.limit, 1_000_000);
  assert.equal(off.fraction, 0.174);
  assert.equal(off.modelLimit, undefined);
  assert.equal(contextCard({ ...off, summarised: false }).compaction, null);
  const above = laneFill(reading, selection, { ceiling: 2_000_000, at: 0.8 });
  assert.equal(above.limit, 800_000, "the share, not a ceiling above the window, is the actual line");
  assert.equal(above.fraction, 174_000 / 800_000);
  assert.equal(above.modelLimit, 1_000_000);
  assert.equal(laneFill(reading, selection, { ceiling: 2_000_000 }).limit, 600_000);
  assert.equal(laneFill(reading, selection, { ceiling: 800_000, at: 0.8 }).limit, 800_000);
  assert.equal(laneFill(reading, selection, { ceiling: 400_000, at: 0.2 }).limit, 200_000);
  assert.equal(laneFill(reading, selection, { ceiling: 2_000_000, at: 1 }).limit, 600_000);
});

test("past the line the card, chips and Activity keep the real share", () => {
  const fill = laneFill({ ...reading, used: 450_000 }, selection, { ceiling: 400_000 });
  assert.equal(fill.fraction, 1, "the wire share must stay capped for other clients");
  const lane = { ...fill, summarised: true };
  assert.equal(contextCard(lane).share, "113% full");
  assert.equal(contextCard(lane).tokens, "450k of 400k tokens");
  assert.equal(contextCard(lane).compaction, "Summarises at 400k. Model max 1M.");
  assert.equal(contextTitle(lane), "Context: 113% full (450k of 400k tokens), earlier messages summarised");
  assert.equal(ringLabel(lane), "Context 113% full");
  assert.equal(activityContext(fill), "context 113% full");
  assert.equal(laneFill({ ...reading, used: 1_100_000 }, selection, { ceiling: 0 }).fraction, 1, "off keeps the wire share capped too");
});

test("the line boundary agrees with compaction, and an under-done compaction keeps its retry guard", () => {
  const settings = { ceiling: 400_000, at: 0.6 };
  const at = laneFill({ ...reading, used: 400_000 }, selection, settings);
  assert.equal(at.fraction, 1);
  assert.equal(contextCard({ ...at, summarised: false }).share, "100% full");
  assert.equal(compactBeforeTurn({ used: at.used, window: reading.window, ...settings }), false);
  const past = laneFill({ ...reading, used: 400_001 }, selection, settings);
  const pastLane = { ...past, summarised: false };
  assert.equal(contextCard(pastLane).share, "over 100% full", "whole-percent rounding hid the line crossing");
  assert.equal(ringLabel(pastLane), "Context over 100% full");
  assert.equal(contextTitle(pastLane), "Context: over 100% full (400k of 400k tokens)");
  assert.equal(activityContext(past), "context over 100% full");
  assert.equal(past.fraction, 1);
  assert.equal(compactBeforeTurn({ used: past.used, window: reading.window, ...settings }), true);
  assert.equal(compactBeforeTurn({ used: 450_000, window: reading.window, ...settings, lastFrom: 450_000 }), false);
  assert.equal(compactBeforeTurn({ used: 495_001, window: reading.window, ...settings, lastFrom: 450_000 }), true);
});

test("a table window stays approximate and unknown or stale readings stay unmeasured", () => {
  const guessed = laneFill({ ...reading, window: null }, selection, { ceiling: 400_000 });
  assert.equal(guessed.limit, 163_200);
  assert.equal(guessed.modelLimit, 272_000);
  assert.equal(guessed.window, "table");
  assert.match(contextCard({ ...guessed, summarised: false }).compaction!, /at about 163k\. Model max about 272k\.$/);
  const opus = { instanceId: "claude", model: "claude-opus-5-5" };
  const exact = laneFill({ ...reading, ...opus, window: null }, opus, { ceiling: 400_000 });
  const exactLane = { ...exact, summarised: false };
  assert.equal(exact.limitApproximate, false, "a ceiling is exact even with a guessed window");
  assert.equal(contextCard(exactLane).tokens, "174k of 400k tokens");
  assert.equal(contextCard(exactLane).share, "44% full");
  assert.equal(contextCard(exactLane).compaction, "Summarises at 400k. Model max about 1M.");
  assert.equal(ringLabel(exactLane), "Context 44% full");
  assert.equal(contextTitle(exactLane), "Context: 44% full (174k of 400k tokens)");
  assert.equal(activityContext({ ...exact, used: 250_000, fraction: 0.625 }), "context 63% full");
  const sonnet = { instanceId: "claude", model: "sonnet" };
  const alias = laneFill({ ...reading, ...sonnet, window: null }, sonnet, { ceiling: 400_000 });
  assert.equal(alias.limit, 120_000);
  assert.equal(alias.limitApproximate, true);
  assert.equal(contextCard({ ...alias, summarised: false }).tokens, "174k of about 120k tokens");
  for (const own of [undefined, { ...reading, used: NaN }, { ...reading, instanceId: "other" }, { ...reading, model: "other" }]) {
    const fill = laneFill(own, selection, { ceiling: 400_000 });
    assert.equal(fill.measured, false);
    assert.equal(fill.modelLimit, undefined);
    assert.equal(fill.limit, 0);
  }
  const unknown = { ...selection, model: "something-new" };
  assert.equal(laneFill({ ...reading, ...unknown, window: null }, unknown, { ceiling: 400_000 }).measured, false);
  assert.equal(compactBeforeTurn({ used: reading.used, window: null, ceiling: 100_000 }), true, "an unknown window can still compact at the ceiling, with no ring");
  const tiny = laneFill({ ...reading, used: 1, window: 1 }, selection, { ceiling: 400_000 });
  assert.equal(tiny.limit, 1, "a zero-token rounded line must not divide by zero");
  assert.ok(Number.isFinite(tiny.fraction));
});

test("saved settings refresh an existing busy reading and its event, without another model request", async t => {
  const f = await codexCommands(t);
  const save = async (beforeTurn: number, beforeTurnAt = 0.6) => {
    const response = await f.h.fetch("/api/config", { method: "PUT", body: JSON.stringify({ compaction: { beforeTurn, beforeTurnAt } }) });
    assert.equal(response.status, 200);
  };
  const lane = async () => (await f.current()).tasks.find((task: any) => task.id === f.bot.threadId);
  const running = async () => (await f.h.json("/api/activity")).running.find((row: any) => row.threadId === f.bot.threadId);
  await save(400_000);
  f.spec({ used: 174_000, window: 1_000_000, hold: true });
  await f.say("HOLD a long synthetic turn");
  await waitFor(async () => (await lane())?.context?.used === 174_000 && (await lane()).state === "working");
  assert.equal((await lane()).context.limit, 400_000, "bot serialization ignored the setting");
  assert.equal((await running()).context.limit, 400_000, "Activity serialization ignored the setting");
  assert.equal((await running()).context.modelLimit, 1_000_000);
  assert.equal((await running()).context.fraction, (await lane()).context.fraction);
  const saved = f.stored().tasks.find((task: any) => task.id === f.bot.threadId).reading;
  const calls = f.calls().filter(call => call.method === "turn/start" || call.method === "thread/compact/start").length;

  const controller = new AbortController();
  const stream = await f.h.fetch("/api/events", { signal: controller.signal });
  assert.equal(stream.status, 200);
  const reader = stream.body!.getReader();
  const frames: any[] = [];
  const pump = (async () => {
    let buffer = "";
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let end;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const data = block.split("\n").find(line => line.startsWith("data: "));
          if (data) frames.push(JSON.parse(data.slice(6)));
        }
      }
    } catch (error) { if (!controller.signal.aborted) throw error; }
  })();
  try {
    await save(200_000);
    assert.equal((await lane()).context.limit, 200_000);
    assert.equal((await running()).context.limit, 200_000);
    await assert.doesNotReject(() => waitFor(() => frames.some(frame => frame.kind === "bot" && frame.bot?.id === f.bot.id && frame.bot.tasks.some((task: any) => task.id === f.bot.threadId && task.context.limit === 200_000))), "settings changed but no bot event refreshed the saved reading");
    await save(0);
    assert.equal((await lane()).context.limit, 1_000_000);
    assert.equal((await lane()).context.modelLimit, undefined);
    assert.equal((await running()).context.modelLimit, undefined);
    await save(2_000_000, 0.8);
    assert.equal((await lane()).context.limit, 800_000);
    assert.equal((await running()).context.limit, 800_000);
    await assert.doesNotReject(() => waitFor(() => frames.some(frame => frame.kind === "bot" && frame.bot?.id === f.bot.id && frame.bot.tasks.some((task: any) => task.id === f.bot.threadId && task.context.limit === 800_000))));
    const beforeShareEdit = frames.length;
    assert.equal((await f.h.fetch("/api/config", { method: "PUT", body: JSON.stringify({ compaction: { beforeTurnAt: 0.2 } }) })).status, 200);
    assert.equal((await lane()).context.limit, 200_000);
    await assert.doesNotReject(() => waitFor(() => frames.slice(beforeShareEdit).some(frame => frame.kind === "bot" && frame.bot?.id === f.bot.id && frame.bot.tasks.some((task: any) => task.id === f.bot.threadId && task.context.limit === 200_000))), "a share-only setting edit did not refresh the saved reading");
    assert.equal((await running()).context.limit, 200_000);
    const beforeUnrelatedEdit = frames.length;
    // Clearing a fixture key is a real unrelated save, with no key probe
    // or external service request.
    assert.equal((await f.h.fetch("/api/config", { method: "PUT", body: JSON.stringify({ composio: { key: "" } }) })).status, 200);
    await waitFor(() => frames.slice(beforeUnrelatedEdit).some(frame => frame.kind === "config"));
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(frames.slice(beforeUnrelatedEdit).filter(frame => frame.kind === "bot").length, 0, "an unrelated settings save broadcast every bot");
    assert.deepEqual(f.stored().tasks.find((task: any) => task.id === f.bot.threadId).reading, saved, "a display setting overwrote the engine reading");
    assert.equal(f.calls().filter(call => call.method === "turn/start" || call.method === "thread/compact/start").length, calls, "a settings refresh ran an engine operation");
  } finally {
    controller.abort();
    await pump;
  }
});

test("a request past the compaction line inside a running turn remains 113% on every surface", async t => {
  const f = await codexCommands(t);
  await f.h.json("/api/config", { method: "PUT", body: JSON.stringify({ compaction: { beforeTurn: 400_000 } }) });
  f.spec({ used: 450_000, window: 1_000_000, hold: true });
  await f.say("HOLD past the before-turn line");
  await waitFor(async () => (await f.current()).tasks.find((task: any) => task.id === f.bot.threadId)?.context?.used === 450_000);
  const lane = (await f.current()).tasks.find((task: any) => task.id === f.bot.threadId);
  assert.equal(lane.state, "working");
  assert.equal(lane.context.fraction, 1, "bot API sent an uncapped share");
  assert.equal(contextCard(lane.context).share, "113% full");
  assert.equal(lane.context.limit, 400_000);
  const row = (await f.h.json("/api/activity")).running.find((item: any) => item.threadId === f.bot.threadId);
  assert.equal(row.context.fraction, 1, "Activity API sent an uncapped share");
  assert.equal(activityContext(row.context), "context 113% full");
  assert.equal(row.context.modelLimit, 1_000_000);
  assert.equal(f.calls().some(call => call.method === "thread/compact/start"), false, "displaying a full ring compacted during the turn");
});

test("a lane without its own string cursor and the guest-mail lane keep the window", async t => {
  const f = await codexCommands(t);
  await f.h.json("/api/config", { method: "PUT", body: JSON.stringify({ compaction: { beforeTurn: 400_000 } }) });
  f.spec({ used: 174_000, window: 1_000_000 });
  await f.turn("A synthetic reading");
  assert.equal((await f.current()).tasks[0].context.limit, 400_000);
  for (const [cursors, guestMail] of [[{}, false], [{ other: "wrong-instance" }, false], [{ codex: 123 }, false], [{ codex: "owned-session" }, true]] as const) {
    await f.h.crash();
    const file = join(f.root, ".bloks", "bots.json");
    const bots = JSON.parse(readFileSync(file, "utf8"));
    const task = bots.find((bot: any) => bot.id === f.bot.id).tasks[0];
    task.resumeCursors = cursors;
    task.guestMail = guestMail;
    writeFileSync(file, JSON.stringify(bots));
    await f.reboot();
    const fill = (await f.current()).tasks[0].context;
    assert.equal(fill.limit, 1_000_000, guestMail ? "guest mail showed a line it cannot compact at" : "a lane without its own cursor showed a compaction line");
    assert.equal(fill.modelLimit, undefined);
    assert.equal(fill.fraction, 0.174);
  }
});

test("an OpenAI-compatible lane keeps its table window even with a stored cursor", async t => {
  const provider = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ data: [{ id: "deepseek-chat" }] }));
  });
  await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
  t.after(() => { provider.closeAllConnections(); provider.close(); });
  const f = await codexCommands(t);
  await f.h.crash();
  const config = join(f.root, ".bloks", "config.json");
  const cfg = JSON.parse(readFileSync(config, "utf8"));
  cfg.instances.replay = { driver: "deepseek", config: { apiKeyEnv: "LOCAL_FIXTURE_KEY", url: `http://127.0.0.1:${(provider.address() as any).port}` }, environment: { LOCAL_FIXTURE_KEY: "local-fixture" } };
  cfg.compaction = { beforeTurn: 400_000 };
  writeFileSync(config, JSON.stringify(cfg));
  const file = join(f.root, ".bloks", "bots.json");
  const bots = JSON.parse(readFileSync(file, "utf8"));
  const bot = bots.find((bot: any) => bot.id === f.bot.id);
  bot.modelSelection = { instanceId: "replay", model: "deepseek-chat" };
  bot.tasks[0].reading = { ...reading, ...bot.modelSelection, used: 20_000, window: null };
  bot.tasks[0].resumeCursors = { replay: "legacy-cursor" };
  writeFileSync(file, JSON.stringify(bots));
  await f.reboot();
  const instance = (await f.h.json("/api/instances")).instances.find((item: any) => item.instanceId === "replay");
  assert.equal(instance?.driverKind, "deepseek");
  assert.notEqual(instance.snapshot.state, "unavailable", "the replay driver must be live, not a missing-instance placeholder");
  const fill = (await f.current()).tasks[0].context;
  assert.equal(fill.limit, 65_536, "a replay engine showed a before-turn line it cannot use");
  assert.equal(fill.modelLimit, undefined);
  assert.equal(fill.window, "table");
});
