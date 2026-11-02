// Dropping a lane's saved summary before a message it read changes
// (Store.dropTaskContext). Saved, it is gone from memory and disk. Not
// saved, it throws, and memory has the summary again only when the file
// still has it as it was: a save whose rename is refused as busy is
// written in place (server/atomic-write.ts), and that can fail with the
// file already changed.
import assert from "node:assert/strict";
import fs, { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test, type TestContext } from "node:test";

// Store's data paths are fixed at import time. Never use the test runner's
// real home, including when this suite is run from an agent's own turn.
const home = mkdtempSync(join(tmpdir(), "bloks-context-drop-"));
process.env.HOME = home;
process.env.BLOKS_DATA_DIR = "";
const { Store } = await import("../server/store.ts");
after(() => rmSync(home, { recursive: true, force: true }));

const BOTS = join(home, ".bloks", "bots.json");
const context = { summary: "Notes: what the lane said.", through: 3, at: 1234 };
const savedContext = (threadId: string) =>
  (JSON.parse(readFileSync(BOTS, "utf8")) as any[]).flatMap((b) => b.tasks).find((l) => l.id === threadId)?.context;

function lane() {
  const store = new Store(() => ({ instanceId: "claude", model: "claude-sonnet-5" }));
  const bot = store.createBot({ name: "Summarised" });
  store.setTaskContext(bot.threadId, context);
  const held = store.taskByThread(bot.threadId)!.task.context;
  assert.deepEqual(savedContext(bot.threadId), context);
  return { store, threadId: bot.threadId, held };
}

/** Every rename onto bots.json refused as busy, so the save falls back to
 * writing in place, and that write done by `inPlace`. */
function busyRename(t: TestContext, inPlace: (write: typeof fs.writeFileSync, data: string) => void) {
  const rename = fs.renameSync, write = fs.writeFileSync;
  t.mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
    if (String(to) === BOTS) throw Object.assign(new Error("busy"), { code: "EBUSY" });
    return rename(from, to);
  });
  t.mock.method(fs, "writeFileSync", (file: any, data: any, options?: any) => {
    if (String(file) === BOTS) return inPlace(write, String(data));
    return write(file, data, options);
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
}

test("saved: gone from memory and from disk", () => {
  const { store, threadId } = lane();
  assert.equal(store.dropTaskContext(threadId), true);
  assert.equal(store.taskByThread(threadId)!.task.context, undefined);
  assert.equal(savedContext(threadId), undefined);
  // and nothing more to drop
  assert.equal(store.dropTaskContext(threadId), false);
});

test("not saved, the file as it was: it throws, and memory has the same summary again", (t) => {
  const { store, threadId, held } = lane();
  const blocked = `${BOTS}.${process.pid}.tmp`;
  mkdirSync(blocked);
  t.after(() => rmSync(blocked, { recursive: true, force: true }));
  assert.throws(() => store.dropTaskContext(threadId));
  assert.equal(store.taskByThread(threadId)!.task.context, held);
  assert.deepEqual(savedContext(threadId), context);
});

test("written in place after a busy rename: saved, so gone", (t) => {
  const { store, threadId } = lane();
  busyRename(t, (write, data) => write(BOTS, data));
  assert.equal(store.dropTaskContext(threadId), true);
  t.mock.restoreAll();
  syncBuiltinESMExports();
  assert.equal(store.taskByThread(threadId)!.task.context, undefined);
  assert.equal(savedContext(threadId), undefined);
});

test("the in-place write refused before it changed the file: it throws, and memory has the summary again", (t) => {
  const { store, threadId, held } = lane();
  busyRename(t, () => {
    throw Object.assign(new Error("refused"), { code: "EACCES" });
  });
  assert.throws(() => store.dropTaskContext(threadId), /refused/);
  t.mock.restoreAll();
  syncBuiltinESMExports();
  assert.equal(store.taskByThread(threadId)!.task.context, held);
  assert.deepEqual(savedContext(threadId), context);
});

test("the in-place write failing with the file cut short: it throws, and the summary stays gone from memory", (t) => {
  const { store, threadId } = lane();
  busyRename(t, (write, data) => {
    write(BOTS, data.slice(0, Math.floor(data.length / 2)));
    throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
  });
  assert.throws(() => store.dropTaskContext(threadId), /disk full/);
  t.mock.restoreAll();
  syncBuiltinESMExports();
  // the file no longer says the summary is there, so memory does not either
  assert.throws(() => JSON.parse(readFileSync(BOTS, "utf8")));
  assert.equal(store.taskByThread(threadId)!.task.context, undefined);
});
