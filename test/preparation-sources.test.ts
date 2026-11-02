import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const home = mkdtempSync(join(tmpdir(), "bloks-preparation-index-"));
process.env.BLOKS_DATA_DIR = home;
const { Store } = await import("../server/store.ts");
process.on("exit", () => rmSync(home, { recursive: true, force: true }));

test("preparation source lookup stays isolated by lane, requester and physical source", () => {
  const store = new Store(() => ({ instanceId: "fake", model: "fake" }));
  const source = { generation: "g", chatId: 10, senderId: 20, messageId: 30 };
  store.appendMessage("lane-one", { role: "user", kind: "text", text: "owner", preparation: { attempt: "a", state: "pending", source } });
  store.appendMessage("lane-one", { role: "user", kind: "text", text: "delegate", telegramDelegate: { requester: "delegate-a" } as any, preparation: { attempt: "b", state: "pending", source } });
  assert.equal(store.hasPreparationSource("lane-one", source, "owner"), true);
  assert.equal(store.hasPreparationSource("lane-one", source, "delegate:delegate-a"), true);
  assert.equal(store.hasPreparationSource("lane-one", source, "delegate:delegate-b"), false);
  assert.equal(store.hasPreparationSource("lane-one", { ...source, senderId: 21 }, "owner"), false);
  assert.equal(store.hasPreparationSource("lane-two", source, "owner"), false);
  const next = { ...source, messageId: 31 };
  store.appendMessage("lane-one", { role: "user", kind: "text", text: "next", preparation: { attempt: "c", state: "pending", source: next } });
  const original = store.messagesFor.bind(store);
  store.messagesFor = () => { throw new Error("indexed lookup must not rescan the transcript"); };
  assert.equal(store.hasPreparationSource("lane-one", next, "owner"), true);
  assert.equal(store.hasPreparationSource("lane-one", source, "owner"), true);
  store.messagesFor = original;
});
