import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Store paths are fixed when config loads. Isolate this test process
// before importing it; no fixture can write to the configured home.
const fixtureHome = mkdtempSync(join(tmpdir(), "bloks-marker-store-"));
const previousHome = process.env.HOME;
process.env.HOME = fixtureHome;
const { Store } = await import("../server/store.ts");
const { memberFrame } = await import("../server/member-access.ts");
const { readCompactBoundary } = await import("../server/drivers/claude.ts");
after(() => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  rmSync(fixtureHome, { recursive: true, force: true });
});
const by = { instanceId: "claude", model: "claude-sonnet-5" };

function fixture(room = false, idle = false) {
  const store = new Store(() => by);
  const bot = store.createBot({ name: "Marker" });
  const lane = bot.tasks[0];
  store.setResumeCursor(lane.id, by.instanceId, "session-one");
  store.noteReading(lane.id, by, { used: 274_710, window: 1_000_000 });
  const where = room ? "room-one" : lane.id;
  const marker = store.appendMessage(where, {
    role: "bot", kind: "notice", text: "Compacted · from 275k",
    ...(room ? { from: bot.id } : {}),
    compaction: { before: 274_710, after: null, ...(idle ? { idle: true } : {}) },
  });
  store.beginCompaction(lane.id, by, where, marker.id);
  return { store, bot, lane, where, marker };
}

test("the first positive request patches only the marker's text and after size", () => {
  const { store, bot, lane, where, marker } = fixture(true, true);
  assert.equal(lane.reading?.used, 0);
  assert.equal(lane.reading?.window, 1_000_000);
  for (const count of [null, 0, -1, NaN, Infinity]) {
    assert.equal(store.resolveCompaction(lane.id, by, count), null);
    assert.ok(lane.pendingCompaction);
  }
  const patched = store.resolveCompaction(lane.id, by, 71_542)!;
  assert.equal(patched.threadId, where);
  assert.deepEqual(JSON.parse(JSON.stringify(patched.message)), { ...marker, text: "Compacted while idle · 275k → 72k", compaction: { ...marker.compaction!, after: 71_542 } });
  assert.equal(lane.pendingCompaction, undefined);
  assert.equal(store.resolveCompaction(lane.id, by, 90_000), null);
  assert.equal(store.messagesFor(where).find(m => m.compaction)?.compaction?.after, 71_542);
  assert.equal(store.messagesFor(lane.id).some((m) => m.compaction), false);
  assert.equal(lane.unread, undefined);
  const frame = { kind: "message.patch", ...patched };
  assert.ok(memberFrame(frame, (id) => id === where ? { joinedAt: 0, history: "all", activityDetail: true } : null));
  assert.equal(memberFrame({ ...frame, threadId: "other-room" }, () => null), null);
  assert.equal(patched.message.from, bot.id);
});

test("a pending idle marker survives restart with its exact session origin", () => {
  const { lane, where, marker } = fixture(false, true);
  const restarted = new Store(() => by);
  const patched = restarted.resolveCompaction(lane.id, by, 71_542)!;
  assert.equal(patched.threadId, where);
  assert.equal(patched.message.id, marker.id);
  assert.equal(patched.message.compaction?.idle, true);
});

for (const method of ["forgetLaneSessions", "startFreshSession"] as const) {
  test(`${method} cancels both the reading and the pending marker`, () => {
    const { store, lane, where } = fixture();
    store[method](lane.id);
    assert.equal(lane.reading, undefined);
    assert.equal(lane.pendingCompaction, undefined);
    assert.equal(store.resolveCompaction(lane.id, by, 71_542), null);
    assert.equal(store.messagesFor(where).find(m => m.compaction)?.compaction?.after, null);
  });
}

for (const changed of [
  { instanceId: "codex", model: by.model },
  { instanceId: by.instanceId, model: "claude-opus-5-5" },
]) {
  test(`a different ${changed.instanceId === by.instanceId ? "model" : "instance"} cancels the pending marker`, () => {
    const { store, lane, where } = fixture();
    assert.equal(store.resolveCompaction(lane.id, changed, 71_542), null);
    assert.equal(lane.pendingCompaction, undefined);
    assert.equal(store.messagesFor(where).find(m => m.compaction)?.compaction?.after, null);
  });
}

test("a failed resume's replacement thread cannot resolve the old compaction", () => {
  const { store, lane, where } = fixture();
  store.setResumeCursor(lane.id, by.instanceId, "replacement-thread");
  assert.equal(store.resolveCompaction(lane.id, by, 71_542), null);
  assert.equal(lane.pendingCompaction, undefined);
  assert.equal(store.messagesFor(where).find(m => m.compaction)?.compaction?.after, null);
});

for (const batch of [false, true]) {
  test(`a ${batch ? "batch" : "single"} A-to-B-to-A selection change cancels the pending marker`, () => {
    const { store, bot, lane, where } = fixture();
    const patch = (model: string) => {
      const change = { modelSelection: { ...by, model } };
      if (batch) store.patchBots([{ id: bot.id, patch: change }]);
      else store.patchBot(bot.id, change);
    };
    patch("claude-opus-5-5");
    patch(by.model);
    assert.equal(lane.pendingCompaction, undefined);
    assert.equal(store.resolveCompaction(lane.id, by, 71_542), null);
    assert.equal(store.messagesFor(where).find(m => m.compaction)?.compaction?.after, null);
  });
}

test("a removed marker cancels the link and produces no patch", () => {
  const { store, lane, where, marker } = fixture();
  store.messagesFor(where).splice(0);
  assert.equal(store.resolveCompaction(lane.id, by, 71_542), null);
  assert.equal(lane.pendingCompaction, undefined);
  assert.equal(store.patchMessage(where, marker.id, { text: "missing" }), null);
});

test("a deleted marker stays deleted without a patch", () => {
  const { store, lane, where, marker } = fixture();
  store.patchMessage(where, marker.id, { deleted: true });
  assert.equal(store.resolveCompaction(lane.id, by, 71_542), null);
  assert.equal(lane.pendingCompaction, undefined);
  assert.equal(store.messagesFor(where).find(m => m.compaction)?.compaction?.after, null);
});

test("a second boundary owns the only pending reference", () => {
  const { store, lane, where, marker } = fixture();
  const second = store.appendMessage(where, { role: "bot", kind: "notice", text: "Compacted", compaction: { before: null, after: null } });
  store.beginCompaction(lane.id, by, where, second.id);
  assert.equal(lane.pendingCompaction?.messageId, second.id);
  const patched = store.resolveCompaction(lane.id, by, 71_542)!;
  assert.equal(patched.message.id, second.id);
  assert.equal(store.messagesFor(where).find((m) => m.id === marker.id)?.compaction?.after, null);
});

test("another lane's request cannot resolve a pending marker", () => {
  const { store, bot, lane, where } = fixture();
  const other = store.createTask(bot.id, "Other")!;
  store.setResumeCursor(other.id, by.instanceId, "session-one");
  assert.equal(store.resolveCompaction(other.id, by, 71_542), null);
  assert.ok(lane.pendingCompaction);
  assert.equal(store.messagesFor(where).find(m => m.compaction)?.compaction?.after, null);
});

test("a child compact boundary never becomes a parent compaction", () => {
  const parent = { type: "system", subtype: "compact_boundary", compact_metadata: { pre_tokens: 274_710, post_tokens: 10_589 } };
  assert.ok(readCompactBoundary(parent));
  assert.ok(readCompactBoundary({ ...parent, parent_tool_use_id: null }));
  for (const child of ["tool-child", "", false, 0, {}, []]) {
    assert.equal(readCompactBoundary({ ...parent, parent_tool_use_id: child }), null);
  }
});
