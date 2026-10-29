// Real transcript writes with no server or engine. A throwaway HOME is
// installed before config/Store load, including an inherited data-dir override.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { boundServiceMessages, wakeRecord, wakeStatus, wakeTextHash } from "../server/service-wakes.ts";
import type { Message } from "../server/store.ts";

const fixtureHome = mkdtempSync(join(tmpdir(), "bloks-service-store-"));
const dataDir = join(fixtureHome, ".bloks");
const savedEnv = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, BLOKS_DATA_DIR: process.env.BLOKS_DATA_DIR };
process.env.HOME = fixtureHome;
process.env.USERPROFILE = fixtureHome;
process.env.BLOKS_DATA_DIR = dataDir;
const { Store } = await import("../server/store.ts");
after(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(fixtureHome, { recursive: true, force: true });
});
const by = { instanceId: "test-service", model: "synthetic" };
const wakeId = "a0000000-0000-4000-8000-000000000003";
const fileFor = (laneId: string) => join(dataDir, `messages-${laneId}.json`);
function fixture() {
  const store = new Store(() => by);
  const bot = store.createBot({ name: "Audit" });
  const lane = store.createTask(bot.id, "Private wake")!;
  const input: Omit<Message, "id" | "at"> = { role: "user", kind: "text", text: "check receipts", via: "service", queued: true, queuedAt: Date.now(),
    serviceWake: { botId: bot.id, taskId: lane.id, wakeId, textHash: wakeTextHash("check receipts") } };
  return { store, bot, lane, input };
}
function blockWrite(laneId: string) {
  // Fails open of the atomic-write temporary path, independent of UID or
  // permission modes. The existing transcript remains a regular file.
  const temp = `${fileFor(laneId)}.${process.pid}.tmp`;
  mkdirSync(temp);
  return () => rmSync(temp, { recursive: true });
}

test("a failed durable append publishes no admission and leaves neither cached nor disk dedup evidence", () => {
  const { store, bot, lane, input } = fixture();
  const prior = [...store.messagesFor(lane.id)];
  const diskBefore = existsSync(fileFor(lane.id)) ? readFileSync(fileFor(lane.id), "utf8") : undefined;
  let announced = 0;
  store.onAppend = () => { announced++; };
  const unblock = blockWrite(lane.id);
  try {
    assert.throws(() => store.appendMessage(lane.id, input, { durable: true }));
    assert.deepEqual(store.messagesFor(lane.id), prior);
    assert.equal(announced, 0);
    assert.equal(wakeRecord(store.messagesFor(lane.id), bot.id, lane.id, wakeId), undefined);
    assert.equal(existsSync(fileFor(lane.id)) ? readFileSync(fileFor(lane.id), "utf8") : undefined, diskBefore);
  } finally { unblock(); }
  const restarted = new Store(() => by);
  assert.equal(wakeRecord(restarted.messagesFor(lane.id), bot.id, lane.id, wakeId), undefined);
  const admitted = store.appendMessage(lane.id, input, { durable: true });
  assert.equal(announced, 1);
  assert.equal(wakeStatus(wakeRecord(new Store(() => by).messagesFor(lane.id), bot.id, lane.id, wakeId)), "queued");
  assert.equal(store.messagesFor(lane.id).filter((m) => m.id === admitted.id).length, 1);
});

test("a failed dispatch-marker write preserves a queued row; a persisted marker survives a crash before the queue move", () => {
  const { store, bot, lane, input } = fixture();
  const row = store.appendMessage(lane.id, input, { durable: true });
  const before = readFileSync(fileFor(lane.id), "utf8");
  let announced = 0;
  store.onRewrite = () => { announced++; };
  const patch = { serviceWake: { ...row.serviceWake!, dispatchedAt: Date.now() } };
  const unblock = blockWrite(lane.id);
  try {
    assert.throws(() => store.patchMessage(lane.id, row.id, patch, { durable: true }));
    assert.equal(announced, 0);
    assert.equal(wakeStatus(store.messagesFor(lane.id).find((m) => m.id === row.id)), "queued");
    assert.equal(readFileSync(fileFor(lane.id), "utf8"), before);
  } finally { unblock(); }
  store.patchMessage(lane.id, row.id, patch, { durable: true });
  assert.equal(announced, 1);
  // Intentionally do not move the row or mark it delivered. This is the
  // persisted state of a crash immediately after possible dispatch.
  const recovered = new Store(() => by).messagesFor(lane.id).find((m) => m.id === row.id)!;
  assert.equal(recovered.queued, true);
  assert.equal(recovered.deliveredAt, undefined);
  assert.equal(wakeStatus(recovered), "dispatched");
  assert.equal(boundServiceMessages([recovered], bot.id, lane.id, [row.id]), true);
});

test("a callback failure after the durable write cannot turn known admission back into permission to append", () => {
  const { store, bot, lane, input } = fixture();
  store.onAppend = () => { throw new Error("synthetic broadcast failure"); };
  assert.throws(() => store.appendMessage(lane.id, input, { durable: true }), /synthetic broadcast failure/);
  const record = wakeRecord(new Store(() => by).messagesFor(lane.id), bot.id, lane.id, wakeId);
  assert.ok(record);
  assert.equal(wakeStatus(record), "queued");
  assert.equal(store.messagesFor(lane.id).filter((m) => m.serviceWake?.wakeId === wakeId).length, 1);
});

for (const dispatched of [false, true]) {
  test(`clear/delete remove exact evidence after ${dispatched ? "possible dispatch" : "queued admission"}; a store restart cannot infer unsent`, () => {
    for (const operation of ["clearTask", "deleteTask"] as const) {
      const { store, bot, lane, input } = fixture();
      const row = store.appendMessage(lane.id, input, { durable: true });
      if (dispatched) store.patchMessage(lane.id, row.id, { serviceWake: { ...row.serviceWake!, dispatchedAt: Date.now() } }, { durable: true });
      assert.equal(store[operation](bot.id, lane.id), "ok");
      assert.equal(existsSync(fileFor(lane.id)), false);
      const restarted = new Store(() => by);
      const record = wakeRecord(restarted.messagesFor(lane.id), bot.id, lane.id, wakeId);
      assert.equal(record, undefined);
      assert.equal(wakeStatus(record), "unconfirmed");
      assert.equal(boundServiceMessages(restarted.messagesFor(lane.id), bot.id, lane.id, [row.id]), false);
      assert.equal(restarted.bot(bot.id)!.tasks.some((task) => task.id === lane.id), operation === "clearTask");
    }
  });
}

test("the actual import sink drops local-service admission provenance even from a forged Message", () => {
  const { store, bot, input } = fixture();
  const lane = store.importLane(bot.id, { title: "Imported text", imported: { engine: "claude", sessionId: "synthetic", from: "synthetic", at: 10, resumes: false },
    messages: [{ ...input, at: 10, imported: "claude" }] })!;
  assert.ok(lane);
  const rows = new Store(() => by).messagesFor(lane.id);
  assert.equal(rows[0].text, input.text);
  assert.equal(rows[0].imported, "claude");
  assert.equal(rows[0].via, undefined);
  assert.equal(rows[0].serviceWake, undefined);
  assert.equal(rows[0].queued, undefined);
  assert.equal(rows[0].queuedAt, undefined);
  assert.equal(boundServiceMessages(rows, bot.id, lane.id, [rows[0].id]), false);
});
