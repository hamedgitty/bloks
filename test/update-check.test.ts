// An update that downloaded days ago is not the last word (GitHub 247):
// the app looks past it every few hours and once more on restart, and
// those looks never take the restart off the card.
import { test } from "node:test";
import assert from "node:assert/strict";

import { mayLookAgain, newestBeforeInstall, updateFrame, type UpdateState } from "../electron/update-check.mjs";

const waiting: UpdateState = { state: "ready", version: "2.5.35" };

test("a look past a waiting update keeps the restart on the card until it finds a newer release", () => {
  assert.equal(updateFrame(waiting, "checking"), null);
  assert.equal(updateFrame(waiting, "available", { version: "2.5.35" }), null, "the same release from the cache is not news");
  assert.equal(updateFrame(waiting, "not-available"), null);
  assert.equal(updateFrame(waiting, "error", { reason: "offline" }), null, "an offline look took away an update that is ready");
  assert.deepEqual(updateFrame(waiting, "available", { version: "2.6.0" }), { state: "downloading", version: "2.6.0" });
  assert.deepEqual(updateFrame({ state: "downloading", version: "2.6.0" }, "progress", { percent: 40 }), {
    state: "downloading",
    version: "2.6.0",
    percent: 40,
  });
  assert.deepEqual(updateFrame({ state: "downloading", version: "2.6.0" }, "downloaded", { version: "2.6.0" }), {
    state: "ready",
    version: "2.6.0",
  });
});

test("with nothing waiting, every event says what it always said", () => {
  const idle: UpdateState = { state: "current" };
  assert.deepEqual(updateFrame(idle, "checking"), { state: "checking" });
  assert.deepEqual(updateFrame(idle, "not-available"), { state: "current" });
  assert.deepEqual(updateFrame(idle, "error", { reason: "offline" }), { state: "error", reason: "offline" });
});

test("the look every few hours goes past a waiting update, never over a running one", () => {
  assert.equal(mayLookAgain(waiting), true);
  assert.equal(mayLookAgain({ state: "current" }), true);
  assert.equal(mayLookAgain({ state: "error" }), true);
  assert.equal(mayLookAgain({ state: "checking" }), false);
  assert.equal(mayLookAgain({ state: "downloading" }), false);
});

test("a restart waits for a newer release to download first", async () => {
  let downloaded = false;
  const updater = {
    checkForUpdates: async () => ({
      downloadPromise: new Promise<void>((resolve) => setTimeout(() => {
        downloaded = true;
        resolve();
      }, 20)),
    }),
  };
  await newestBeforeInstall(updater);
  assert.ok(downloaded, "the restart went ahead before the newer release had downloaded");
});

test("a restart is not held by a look that fails or never answers", async () => {
  await newestBeforeInstall({ checkForUpdates: () => Promise.reject(new Error("offline")) });
  await newestBeforeInstall({
    checkForUpdates: async () => ({ downloadPromise: Promise.reject(new Error("download failed")) }),
  });
  await newestBeforeInstall({ checkForUpdates: async () => null });
  const started = Date.now();
  await newestBeforeInstall({ checkForUpdates: () => new Promise(() => {}) }, { within: 50 });
  assert.ok(Date.now() - started < 2_000, "a look that never answered held the restart");
});
