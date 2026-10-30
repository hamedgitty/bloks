// Two conversations of one agent, seen from the Mac app on a workspace
// elsewhere, through Bloks Cloud: General finishes while the other one
// starts, and the agent list the app asked for before that arrives after
// it. Each tab must still say its own conversation's state (GitHub 398).
//
// The app orders the stream against that list by where the server made
// each. Through Bloks Cloud the desktop's stand-in server counted the
// frames itself, so on a workspace up longer than the app every frame
// read as older than the list: the late list put General back to working
// and the other conversation back to idle, the two tabs the wrong way
// round.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startRemoteProxy } from "../electron/remote.mjs";
import { initialState, reducer, type Action, type AppState } from "../src/state/reducer.ts";
import { serverSeq, snapshotOrder } from "../src/state/snapshotOrder.ts";
import { sealedRelay } from "./helpers/sealed-relay.ts";
import { startHarness } from "./helpers/server.ts";
import { agentOn, fakeProvider, waitFor } from "./helpers/turns.ts";

const stateOf = (s: AppState, botId: string, laneId: string) => s.bots.find((b) => b.id === botId)?.tasks?.find((t) => t.id === laneId)?.state;

test("through Bloks Cloud, a late agent list leaves each tab on its own conversation's state", { timeout: 120_000 }, async (t) => {
  const provider = await fakeProvider(t);
  const relay = await sealedRelay();
  const h = await startHarness();
  const files = mkdtempSync(join(tmpdir(), "bloks-tab-state-remote-"));
  writeFileSync(join(files, "index.html"), "<!doctype html><title>Fixture</title>");
  const abort = new AbortController();
  t.after(async () => {
    abort.abort();
    await h.stop();
    await relay.stop();
    rmSync(files, { recursive: true, force: true });
  });

  // the Mac app, paired, and the workspace on Bloks Cloud
  await h.json("/api/pair", { method: "PUT", body: JSON.stringify({ enabled: true }) });
  const started = await h.json("/api/pair/start", { method: "POST" });
  const claimed = await h.json("/api/pair/claim", { method: "POST", body: JSON.stringify({ code: started.code, device: "Fixture Mac" }) });
  await h.json("/api/relay", {
    method: "PUT",
    body: JSON.stringify({ url: relay.url, agentToken: "fixture-agent", clientToken: claimed.token, enabled: true }),
  });
  await relay.connection;

  // One agent, General and a second conversation, both idle, on a
  // workspace that has been up a while: its stream is well past where an
  // app opened now starts counting.
  const bot = await agentOn(h, provider.port, "Hal");
  const { bot: both } = await h.json(`/api/bots/${bot.id}/tasks`, { method: "POST", body: JSON.stringify({ title: "Another session" }) });
  const [general, other] = both.tasks.map((task: { id: string }) => task.id);
  for (let i = 0; i < 40; i++) {
    await h.json(`/api/bots/${bot.id}/tasks/${other}`, { method: "PATCH", body: JSON.stringify({ title: `Another session ${i}` }) });
  }

  const app = await startRemoteProxy(
    { relayUrl: relay.url, relayToken: "fixture-relay-client", deviceId: claimed.device.id, deviceToken: claimed.token },
    { staticDir: files, client: "macOS 3.0" },
  );
  t.after(() => app.stop());
  const through = (path: string) => fetch(`http://127.0.0.1:${app.port}${path}`, { signal: abort.signal });

  // the window's state, folded from its event stream the way the store
  // folds it: each frame applied as it comes, and noted for a list still out
  let state: AppState = { ...initialState };
  const order = snapshotOrder<Action>();
  const fold = (frame: any) => {
    let action: Action | null = null;
    if (frame.kind === "bot") action = { type: "botPatched", bot: frame.bot };
    else if (frame.kind === "runtime" && frame.event?.type === "turn.started") action = { type: "turnStarted", threadId: frame.event.threadId, turnId: frame.event.turnId };
    else if (frame.kind === "runtime" && frame.event?.type === "turn.completed") action = { type: "turnSettled", threadId: frame.event.threadId, turnId: frame.event.turnId };
    if (!action) return;
    state = reducer(state, action);
    order.note(serverSeq(frame), action);
  };
  const events = await through("/api/events");
  assert.equal(events.status, 200);
  void (async () => {
    const reader = events.body!.getReader();
    const dec = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += dec.decode(value, { stream: true });
        let cut;
        while ((cut = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          if (block.startsWith("data: ")) fold(JSON.parse(block.slice(6)));
        }
      }
    } catch {
      // the stream ends with the test
    }
  })();

  // what the window has from its first list
  state = reducer(state, { type: "hydrate", bots: (await (await through("/api/bots")).json()).bots });

  // General is asked something and works on it
  await h.json(`/api/bots/${bot.id}/tasks/${general}/activate`, { method: "POST" });
  assert.equal((await h.fetch(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: "first" }) })).status, 202);
  assert.ok(await waitFor(() => (provider.state.held.length === 1 && stateOf(state, bot.id, general) === "working" ? true : null)), "General never started");

  // The window asks for the agent list (a reconnect does), and the list is
  // made now, with General working and the other conversation idle. Its
  // answer is slow.
  const load = order.begin();
  const listed = await (await through("/api/bots")).json();
  const madeThen = listed.bots.find((b: { id: string }) => b.id === bot.id);
  assert.equal(madeThen.tasks.find((task: { id: string }) => task.id === general).state, "working");
  assert.equal(madeThen.tasks.find((task: { id: string }) => task.id === other).state, "idle");

  // Before it lands, the other conversation starts and General finishes,
  // and the window hears both.
  await h.json(`/api/bots/${bot.id}/tasks/${other}/activate`, { method: "POST" });
  assert.equal((await h.fetch(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: "second" }) })).status, 202);
  assert.ok(await waitFor(() => (provider.state.held.length === 2 ? true : null)), "the other conversation never asked its engine");
  provider.state.held.shift()!();
  assert.ok(
    await waitFor(() => (stateOf(state, bot.id, general) === "idle" && stateOf(state, bot.id, other) === "working" ? true : null)),
    "the window never heard General finish and the other conversation start",
  );

  // the list lands, with what the stream said after it was made applied over it
  state = reducer(state, { type: "hydrate", bots: listed.bots, after: load.settle(listed.seq) });
  assert.deepEqual(
    { general: stateOf(state, bot.id, general), other: stateOf(state, bot.id, other) },
    { general: "idle", other: "working" },
    "the late list put the finished conversation back to working and the running one back to idle",
  );
});
