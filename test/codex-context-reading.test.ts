import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import fs, { mkdtempSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { after, test, type TestContext } from "node:test";
import type { RuntimeEvent } from "../server/contracts.ts";

// Both driver journals and the real Store stay inside this test's home.
const home = mkdtempSync(join(tmpdir(), "bloks-codex-reading-"));
const previousHome = process.env.HOME;
process.env.HOME = home;
const { CodexDriver } = await import("../server/drivers/codex.ts");
const { Store } = await import("../server/store.ts");
after(() => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

const by = { instanceId: "codex", model: "test-model" };
const reading = (threadId: unknown, used: unknown, window: unknown = 1_000, total?: number) => ({
  method: "thread/tokenUsage/updated", params: { threadId, tokenUsage: {
    last: { inputTokens: used, outputTokens: 1 }, modelContextWindow: window,
    ...(total === undefined ? {} : { total: { inputTokens: total, outputTokens: total / 10 } }),
  } },
});
const compact = (threadId: string, completed: boolean, id = "compact-item") => ({
  method: completed ? "item/completed" : "item/started",
  params: { threadId, turnId: "work", item: { type: "contextCompaction", id } },
});
type Script = {
  opening?: (thread: string, method: string) => unknown[];
  work?: (thread: string) => unknown[];
  resumeFails?: boolean;
  compactFails?: boolean;
  pending?: string;
};

async function setup(t: TestContext, script: Script = {}) {
  const store = new Store(() => by);
  const bot = store.createBot({ name: "Context fixture" });
  const lane = bot.tasks[0];
  let oldMarker: string | undefined;
  if (script.pending) {
    store.setResumeCursor(lane.id, by.instanceId, script.pending);
    store.noteReading(lane.id, by, { used: 900, window: 1_000 });
    oldMarker = store.appendMessage(lane.id, { role: "bot", kind: "notice", text: "Compacted", compaction: { before: 900, after: null } }).id;
    store.beginCompaction(lane.id, by, lane.id, oldMarker);
  }
  const frames: any[] = [], events: RuntimeEvent[] = [];
  let send = (_frames: unknown[]) => {};
  t.mock.method(childProcess, "spawn", () => {
    const stdout = new PassThrough();
    // One chunk deliberately exercises reply/notification coalescing.
    send = (messages) => { stdout.write(messages.map(m => JSON.stringify(m) + "\n").join("")); };
    const out = send;
    return Object.assign(new EventEmitter(), {
      stdout, stderr: new PassThrough(), kill() {},
      stdin: new Writable({ write(chunk, _encoding, done) {
        const frame = JSON.parse(String(chunk)); frames.push(frame);
        if (frame.id !== undefined && frame.method) queueMicrotask(() => {
          const reply = (result: unknown = {}) => ({ id: frame.id, result });
          if (frame.method === "thread/resume" && script.resumeFails) return out([{ id: frame.id, error: { code: -1, message: "not found" } }]);
          if (frame.method === "thread/fork") return out([reply({ thread: { id: "fork-parent" } }), ...(script.opening?.("fork-parent", frame.method) ?? [])]);
          if (frame.method === "thread/start" || frame.method === "thread/resume") {
            const thread = frame.params.threadId ?? "fresh-parent";
            return out([reply({ thread: { id: thread }, model: by.model }), ...(script.opening?.(thread, frame.method) ?? [])]);
          }
          if (frame.method === "thread/compact/start") {
            if (script.compactFails) return out([{ id: frame.id, error: { code: -1, message: "compact refused" } }]);
            return out([reply(), { method: "turn/started", params: { threadId: frame.params.threadId, turn: { id: "manual" } } },
              reading("child", 5), reading(frame.params.threadId, 850),
              { method: "turn/completed", params: { threadId: frame.params.threadId, turn: { id: "manual", status: "completed" } } }]);
          }
          if (frame.method === "turn/start") return out([reply({ turn: { id: "work" } }), ...(script.work?.(frame.params.threadId) ?? [])]);
          out([reply()]);
        });
        done();
      } }),
    });
  });
  // The journal is not part of this fixture; Store writes remain real.
  t.mock.method(fs, "appendFileSync", () => {});
  syncBuiltinESMExports();
  const instance = await CodexDriver.create({ instanceId: by.instanceId, displayName: "Codex", enabled: true, environment: {}, config: { cli: "fake-codex", fullAuto: false } });
  await instance.catalogReady;
  instance.adapter.onEvent(event => {
    events.push(event);
    if (event.type === "session.started" && event.sessionId) store.setResumeCursor(lane.id, by.instanceId, event.sessionId);
    if (event.type === "context.reading") {
      store.noteReading(lane.id, by, event);
      store.resolveCompaction(lane.id, by, event.used);
    }
    if (event.type === "context.compacted") {
      const before = lane.reading?.used || null;
      const marker = store.appendMessage(lane.id, { role: "bot", kind: "notice", text: "Compacted", compaction: { before, after: null } });
      store.beginCompaction(lane.id, by, lane.id, marker.id);
    }
  });
  t.after(async () => { await instance.dispose(); t.mock.restoreAll(); syncBuiltinESMExports(); });
  const spin = async () => { for (let i = 0; i < 80; i++) await setImmediate(); };
  return { events, store, lane, frames, oldMarker, send: (frames: unknown[]) => send(frames), spin,
    async turn(extra = {}) { await instance.adapter.sendTurn({ threadId: lane.id, text: "Check the document", model: by.model, ...extra }); await spin(); },
    readings: () => events.filter((e): e is Extract<RuntimeEvent, { type: "context.reading" }> => e.type === "context.reading"),
  };
}

for (const resume of [false, true]) test(`only parent readings frame automatic compaction (resume=${resume}), accounting still receives child updates`, async t => {
  const h = await setup(t, { work: parent => [
    reading(parent, 600, 1_000, 1_000), reading("child", 30, 200, 1_100),
    compact(parent, false), compact("child", false), reading("child", 40, 300, 1_200),
    compact("child", true), compact(parent, true), reading("child", 50, 400, 1_300),
    reading(parent, 200, 1_000, 1_500), reading("child", 60, 500, 1_600),
  ] });
  await h.turn(resume ? { resumeCursor: "saved-parent" } : {});
  assert.deepEqual(h.readings().map(e => [e.used, e.window]), [[600, 1_000], [200, 1_000]]);
  const boundaries = h.events.filter(e => e.type === "context.compacted");
  assert.equal(boundaries.length, 1);
  assert.equal(boundaries[0].before, 600, "child contaminated the driver's lastUsed");
  assert.deepEqual(h.store.messagesFor(h.lane.id).find(m => m.compaction)?.compaction, { before: 600, after: 200 });
  assert.equal(h.lane.reading?.used, 200);
  assert.equal(h.lane.reading?.window, 1_000);
  // Pin the existing accounting stream, including child events. This
  // change does not reinterpret or redesign its native cumulative totals.
  assert.deepEqual(h.events.filter(e => e.type === "thread.token-usage.updated").map(e => [e.input, e.output]),
    [[600, 1], [700, 11], [800, 21], [900, 31], [1_100, 51], [1_200, 61]]);
});

for (const resume of [false, true]) for (const parentFirst of [false, true]) test(`coalesced partial parent readings preserve first-after and merged final fill (resume=${resume}, parentFirst=${parentFirst})`, async t => {
  const h = await setup(t, { pending: resume ? "saved-parent" : "fresh-parent", opening: parent => {
    const own = [reading(parent, null, 1_000), reading(parent, 120, 1_000), reading(parent, 180, 2_000), reading(parent, 220, null), reading(parent, 0, null)];
    return parentFirst ? [...own, reading("child", 9, 90)] : [reading("child", 9, 90), ...own];
  } });
  await h.turn(resume ? { resumeCursor: "saved-parent" } : {});
  assert.equal(h.store.messagesFor(h.lane.id).find(m => m.id === h.oldMarker)?.compaction?.after, 120);
  assert.deepEqual(h.readings().map(e => [e.used, e.window]), [[120, 1_000], [220, 2_000]]);
  assert.equal(h.lane.reading?.used, 220); assert.equal(h.lane.reading?.window, 2_000);
  h.send([compact(resume ? "saved-parent" : "fresh-parent", false), compact(resume ? "saved-parent" : "fresh-parent", true)]); await h.spin();
  assert.equal(h.events.find(e => e.type === "context.compacted")?.before, 220);
  assert.ok(h.events.findIndex(e => e.type === "session.started") < h.events.findIndex(e => e.type === "context.reading"));
});

test("window-only frames after the first used value retain that value for markers and lastUsed", async t => {
  const h = await setup(t, { pending: "saved-parent", opening: parent => [reading(parent, null, 1_000), reading(parent, 120, 1_000), reading(parent, null, 2_000)] });
  await h.turn({ resumeCursor: "saved-parent" });
  assert.equal(h.store.messagesFor(h.lane.id).find(m => m.id === h.oldMarker)?.compaction?.after, 120);
  assert.deepEqual(h.readings().map(e => [e.used, e.window]), [[120, 1_000], [120, 2_000]]);
  h.send([compact("saved-parent", true)]); await h.spin();
  assert.equal(h.events.find(e => e.type === "context.compacted")?.before, 120);
});

for (const mode of ["fresh", "failed-resume", "fork", "failed-compact"] as const) test(`coalesced ${mode} binds its new session before readings can resolve the old marker`, async t => {
  const h = await setup(t, { pending: "old-parent", resumeFails: mode === "failed-resume", compactFails: mode === "failed-compact", opening: parent => mode === "failed-compact" && parent === "old-parent" ? [] : [reading(parent, 120), reading("child", 10), reading(parent, 220, 2_000)] });
  await h.turn(mode === "fresh" ? {} : mode === "fork" ? { resumeCursor: "old-parent", forkFrom: "old-parent" } : { resumeCursor: "old-parent", ...(mode === "failed-compact" ? { compactFirst: true } : {}) });
  assert.equal(h.store.messagesFor(h.lane.id).find(m => m.id === h.oldMarker)?.compaction?.after, null);
  assert.equal(h.lane.resumeCursors.codex, mode === "fork" ? "fork-parent" : "fresh-parent");
  assert.equal(h.lane.reading?.used, 220); assert.equal(h.lane.reading?.window, 2_000);
  const contexts = h.events.filter(e => e.type === "context.reading" || e.type === "session.started");
  let session = "old-parent";
  for (const event of contexts) { if (event.type === "session.started") session = event.sessionId!; else assert.notEqual(session, "old-parent", "replacement reading emitted before binding"); }
});

for (const admitted of [true, false]) test(`64-ID opening bound retains an admitted parent and drops an excess unknown parent (admitted=${admitted})`, async t => {
  const h = await setup(t, { opening: parent => [
    ...(admitted ? [reading(parent, 120)] : []),
    ...Array.from({ length: 64 }, (_, i) => reading(`child-${i}`, i + 1)),
    reading(parent, 220, 2_000),
  ] });
  await h.turn();
  assert.deepEqual(h.readings().map(e => e.used), admitted ? [120, 220] : []);
  h.send([reading("fresh-parent", 300, 3_000)]); await h.spin();
  assert.equal(h.lane.reading?.used, 300); assert.equal(h.lane.reading?.window, 3_000);
});

test("unknown identities are not context, and a selected parent keeps existing zero/missing parsing", async t => {
  const malformed = [undefined, null, 4, "", "x".repeat(257), "bad\nthread"];
  const h = await setup(t, { opening: () => malformed.map(id => reading(id, 9, 90)), work: parent => [
    ...malformed.map(id => reading(id, 9, 90)), reading("child", 9, 90),
    reading(parent, null, 1_000), reading(parent, 120, null), reading(parent, 0, null), reading(parent, -1, 2_000), reading(parent, "invalid", null),
  ] });
  await h.turn();
  assert.deepEqual(h.readings().map(e => [e.used, e.window]), [[null, 1_000], [120, null], [null, 2_000]]);
  assert.equal(h.lane.reading?.used, 120); assert.equal(h.lane.reading?.window, 2_000);
});

test("pre-compaction before uses buffered parent data; manual work suppresses context until it ends", async t => {
  const h = await setup(t, { opening: parent => [reading(parent, 600), reading("child", 30)], work: parent => [reading("child", 40), reading(parent, 200)] });
  await h.turn({ resumeCursor: "saved-parent", compactFirst: true });
  assert.deepEqual(h.readings().map(e => e.used), [600, 200], "manual compaction's own request must stay suppressed");
  const markers = h.events.filter(e => e.type === "context.compacted");
  assert.equal(markers.length, 1); assert.equal(markers[0].before, 600);
  assert.deepEqual(h.store.messagesFor(h.lane.id).find(m => m.compaction)?.compaction, { before: 600, after: 200 });
});


test("replacement drops the driver's earlier lastUsed even before a new reading exists", async t => {
  const h = await setup(t, { compactFails: true, opening: parent => parent === "old-parent" ? [reading(parent, 600)] : [] });
  await h.turn({ resumeCursor: "old-parent", compactFirst: true });
  h.send([compact("fresh-parent", true)]); await h.spin();
  assert.equal(h.events.find(e => e.type === "context.compacted")?.before, null);
});
