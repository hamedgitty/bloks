import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "../server/store.ts";
import { takeBackWaiting, type WaitingQueue } from "../server/take-back.ts";
import { redoCounts } from "../server/redo.ts";
import { foldTurns } from "../src/lib/turnFold.ts";

// Store's data paths are fixed at import time. Never use the test runner's
// real home, including when this suite is run from an agent's own turn.
const home = mkdtempSync(join(tmpdir(), "bloks-take-back-store-"));
process.env.HOME = home;
const { Store } = await import("../server/store.ts");
after(() => rmSync(home, { recursive: true, force: true }));

function fixture() {
  const store = new Store(() => ({ instanceId: "claude", model: "claude-sonnet-5" }));
  const caller = store.createBot({ name: "Agent A" });
  const recipient = store.createBot({ name: "Agent B" });
  const other = store.createBot({ name: "Agent C" });
  const lane1 = recipient.threadId;
  const lane2 = store.createTask(recipient.id, "Second")!;
  const queues = new Map<string, WaitingQueue>();
  const events: string[] = [];
  const waiting = (laneId = lane1, text = "same words", extra: Partial<Message> = {}) => {
    const message = store.appendMessage(laneId, {
      role: "user", kind: "text", text, queued: true, queuedAt: Date.now(),
      agent: { dir: "in", peerId: caller.id, peerName: caller.name }, ...extra,
    });
    const queue = queues.get(laneId) ?? { botId: recipient.id, items: [] };
    queue.items.push({ messageId: message.id });
    queues.set(laneId, queue);
    return message;
  };
  const args = {
    store, queues, caller, callerLaneId: caller.threadId, recipient,
    patched: (laneId: string, message: Message) => { events.push(`patch:${laneId}:${message.id}`); },
    editClosed: (laneId: string, id: string) => { events.push(`close:${laneId}:${id}`); },
  };
  return { ...args, args, other, lane1, lane2, waiting, events, run: () => takeBackWaiting(args) };
}

test("old and new waiting words in every lane are tombstoned in queue order, with the old send row unchanged", () => {
  const f = fixture();
  const caller2 = f.store.createTask(f.caller.id, "Second sender")!;
  const original = f.store.appendMessage(caller2.id, {
    role: "bot", kind: "activity", text: "same words",
    agent: { dir: "out", peerId: f.recipient.id, peerName: f.recipient.name, status: "queued" },
  });
  const oldBytes = JSON.stringify(original);
  const first = f.waiting(); // The existing 2.8.2 shape, with no link or migration.
  const second = f.waiting();
  const third = f.waiting(f.lane2.id);
  f.queues.get(f.lane1)!.items.reverse();
  const result = f.run();
  assert.deepEqual(result.takenBack, [second, first, third].map((m) => ({
    id: m.id, laneId: m.id === third.id ? f.lane2.id : f.lane1, text: "same words",
  })));
  assert.equal(result.ok, true);
  assert.equal(result.notTakenBack, 0);
  assert.equal(result.recorded, true);
  assert.equal(JSON.stringify(f.store.messagesFor(caller2.id).find((m) => m.id === original.id)), oldBytes);
  const reloaded = new Store(() => f.caller.modelSelection);
  for (const lane of f.recipient.tasks) {
    for (const m of reloaded.messagesFor(lane.id).filter((m) => [first.id, second.id, third.id].includes(m.id))) {
      assert.equal(m.deleted, true);
      assert.equal(m.text, "");
      for (const field of ["card", "artifact", "png", "component"] as const) assert.equal(m[field], undefined);
    }
  }
  const row = f.store.messagesFor(f.callerLaneId).find((m) => m.takeBack)!;
  assert.deepEqual(row.takeBack?.messages, result.takenBack);
  assert.equal(row.takeBack?.peerId, f.recipient.id);
  assert.equal(row.agent, undefined, "taking back is not another send");
  assert.equal(row.text, "same words\n\nsame words\n\nsame words");
});

test("the answer follows live queue order even when lanes were created in a different order", () => {
  const f = fixture();
  const secondLane = f.waiting(f.lane2.id, "queued first");
  const firstLane = f.waiting(f.lane1, "queued second");
  assert.deepEqual(f.run().takenBack.map((m) => m.id), [secondLane.id, firstLane.id]);
});

test("ownership, queue owner and live queue membership all constrain selection", () => {
  const f = fixture();
  const owned = f.waiting();
  const protectedMessages = [
    f.waiting(undefined, "other agent", { agent: { dir: "in", peerId: f.other.id, peerName: f.other.name } }),
    f.waiting(undefined, "person", { agent: undefined }),
    f.waiting(undefined, "watcher", { agent: undefined, via: "watcher" }),
    f.waiting(undefined, "webhook", { agent: undefined, via: "webhook" }),
    f.waiting(undefined, "system", { role: "bot" }),
    f.waiting(undefined, "out", { agent: { dir: "out", peerId: f.caller.id, peerName: f.caller.name } }),
    f.waiting(undefined, "delivered", { queued: false }),
    f.waiting(undefined, "unsent", { unsent: true }),
    f.waiting(undefined, "deleted", { deleted: true }),
    f.waiting(undefined, "", {}),
    f.waiting(f.other.threadId, "other recipient"),
    f.waiting(f.lane2.id, "wrong queue owner"),
  ];
  f.queues.get(f.lane2.id)!.botId = f.other.id;
  const before = protectedMessages.map((m) => JSON.stringify(m));
  const result = f.run();
  assert.deepEqual(result.takenBack.map((m) => m.id), [owned.id]);
  assert.equal(result.ok, false, "the queued message outside the recipient's live queue was not taken back");
  assert.equal(result.notTakenBack, 1);
  assert.deepEqual(protectedMessages.map((m) => {
    const lane = m.id === protectedMessages[10].id ? f.other.threadId : m.id === protectedMessages[11].id ? f.lane2.id : f.lane1;
    return JSON.stringify(f.store.messagesFor(lane).find((row) => row.id === m.id));
  }), before);
});

test("the carryOn interval is past the boundary, and a mixed result names the messages not taken back", () => {
  const f = fixture();
  const claimed = f.waiting();
  f.queues.delete(f.lane1); // carryOn's synchronous claim, before its delayed read.
  const before = JSON.stringify(f.store.messagesFor(f.lane1));
  const refused = f.run();
  assert.equal(refused.ok, false);
  assert.deepEqual(refused.takenBack, []);
  assert.equal(refused.notTakenBack, 1);
  assert.match(refused.note, /turn may already have.*Send a correction/);
  assert.equal(JSON.stringify(f.store.messagesFor(f.lane1)), before);
  assert.equal(f.store.messagesFor(f.callerLaneId).some((m) => m.takeBack), false);
  const waiting = f.waiting(f.lane2.id);
  const mixed = f.run();
  assert.equal(mixed.ok, false);
  assert.deepEqual(mixed.takenBack.map((m) => m.id), [waiting.id]);
  assert.equal(mixed.notTakenBack, 1);
  assert.match(mixed.note, /1 message was not taken back/);
  assert.equal(f.store.messagesFor(f.lane1).find((m) => m.id === claimed.id)?.deleted, undefined);
});

test("all tombstones precede editor release and the sender row, with no asynchronous claim window", () => {
  const f = fixture();
  const first = f.waiting();
  const second = f.waiting(f.lane2.id);
  const patches: string[] = [];
  const realPatch = f.store.patchMessages.bind(f.store);
  f.store.patchMessages = (lane, ids, patch) => { patches.push(lane); return realPatch(lane, ids, patch); };
  f.args.editClosed = (lane, id) => {
    assert.deepEqual(patches, [f.lane1, f.lane2.id], "an editor released before every lane's write");
    assert.ok(f.store.messagesFor(f.lane1).find((m) => m.id === first.id)?.deleted);
    assert.ok(f.store.messagesFor(f.lane2.id).find((m) => m.id === second.id)?.deleted);
    assert.equal(f.store.messagesFor(f.callerLaneId).some((m) => m.takeBack), false);
    f.events.push(`close:${lane}:${id}`);
  };
  const result = f.run();
  assert.equal(result instanceof Promise, false, "tombstones must complete before yielding to a drain");
  assert.equal(result.takenBack.length, 2);
  assert.equal(f.events.at(-1)?.startsWith(`patch:${f.callerLaneId}:`), true);
  assert.equal(patches.length, 2, "one atomic patch per lane");
});

test("a failed second lane is reported not taken back even though Store already changed its memory", () => {
  const f = fixture();
  const first = f.waiting();
  const second = f.waiting(f.lane2.id);
  const file = join(home, ".bloks", `messages-${f.lane2.id}.json`);
  const saved = readFileSync(file, "utf8");
  renameSync(file, file + ".saved");
  mkdirSync(file); // The real atomic write fails at its final rename.
  try {
    const result = f.run();
    assert.equal(result.ok, false);
    assert.deepEqual(result.takenBack.map((m) => m.id), [first.id]);
    assert.equal(result.notTakenBack, 1);
    assert.match(result.note, /file write failed.*may return on restart.*Send a correction/);
    assert.ok(f.store.messagesFor(f.lane2.id).find((m) => m.id === second.id)?.deleted, "Store mutates memory before its write");
    assert.equal(readFileSync(file + ".saved", "utf8"), saved);
    assert.equal(f.events.some((e) => e.startsWith(`close:${f.lane2.id}:`)), false);
  } finally {
    rmSync(file, { recursive: true });
    renameSync(file + ".saved", file);
  }
  const reloaded = new Store(() => f.caller.modelSelection);
  assert.equal(reloaded.messagesFor(f.lane2.id).find((m) => m.id === second.id)?.deleted, undefined);
  assert.equal(reloaded.messagesFor(f.lane2.id).find((m) => m.id === second.id)?.queued, true);
});

test("a failed sender row does not undo a completed take-back", () => {
  const f = fixture();
  const waiting = f.waiting();
  const file = join(home, ".bloks", `messages-${f.callerLaneId}.json`);
  renameSync(file, file + ".saved");
  mkdirSync(file);
  try {
    const result = f.run();
    assert.equal(result.ok, true);
    assert.equal(result.recorded, false);
    assert.deepEqual(result.takenBack.map((m) => m.id), [waiting.id]);
    assert.match(result.note, /take-back is done.*row.*could not be saved/);
    assert.ok(f.store.messagesFor(f.lane1).find((m) => m.id === waiting.id)?.deleted);
  } finally {
    rmSync(file, { recursive: true });
    renameSync(file + ".saved", file);
  }
});

test("a waiting stop reason needs no sender out row, and a duplicate take-back changes nothing", () => {
  const f = fixture();
  const stop = f.waiting(undefined, "Stop this work because the request changed.");
  const result = f.run();
  assert.deepEqual(result.takenBack.map((m) => m.id), [stop.id]);
  assert.equal(f.store.messagesFor(f.callerLaneId).some((m) => m.agent?.dir === "out"), false);
  const before = JSON.stringify([f.store.messagesFor(f.callerLaneId), f.store.messagesFor(f.lane1)]);
  assert.equal(f.run().ok, false);
  assert.equal(JSON.stringify([f.store.messagesFor(f.callerLaneId), f.store.messagesFor(f.lane1)]), before);
});

test("already delivered and mid-turn messages are refused without changes", () => {
  const f = fixture();
  f.waiting(undefined, "delivered", { queued: false, deliveredAt: Date.now() });
  f.waiting(undefined, "joined with now", { queued: false, midTurn: true });
  const before = JSON.stringify(f.store.messagesFor(f.lane1));
  const result = f.run();
  assert.equal(result.ok, false);
  assert.deepEqual(result.takenBack, []);
  assert.match(result.note, /Send a correction/);
  assert.equal(JSON.stringify(f.store.messagesFor(f.lane1)), before);
});

test("the take-back row does not count as a send in redo or fold", () => {
  const f = fixture();
  f.waiting();
  f.run();
  const row = f.store.messagesFor(f.callerLaneId).find((m) => m.takeBack)!;
  assert.equal(redoCounts([row]).sent, false);
  const at = row.at;
  const folded = foldTurns([
    { id: "ask", at: at - 2, role: "user", kind: "text", text: "Correct the queued message." },
    { ...row, at: at - 1 },
    { id: "answer", at, role: "bot", kind: "text", text: "Done." },
  ], false);
  const folds = folded.rows.filter((row) => row.kind === "fold");
  assert.equal(folds.length, 1);
  for (const { fold } of folds) {
    assert.deepEqual(fold.messaged, []);
    assert.equal(fold.replied, false);
  }
});
