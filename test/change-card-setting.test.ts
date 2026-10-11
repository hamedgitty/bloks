import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { startHarness } from "./helpers/server.ts";

test("shared-file cards default on, save, survive a restart and turn back on", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "bloks-card-setting-"));
  let h = await startHarness({ HOME: home });
  t.after(async () => { await h.stop(); rmSync(home, { recursive: true, force: true }); });
  assert.deepEqual((await h.json("/api/config")).changes, { showShared: true });
  const saved = await h.fetch("/api/config", {
    method: "PUT", body: JSON.stringify({ changes: { showShared: false, unrelated: "ignored" }, profile: { about: "Keep this context" } }),
  });
  assert.equal(saved.status, 200);
  assert.deepEqual((await saved.json()).changes, { showShared: false });
  const disk = JSON.parse(readFileSync(join(home, ".bloks", "config.json"), "utf8"));
  assert.deepEqual(disk.changes, { showShared: false });
  assert.equal(disk.profile.about, "Keep this context");
  await h.stop();
  h = await startHarness({ HOME: home });
  assert.deepEqual((await h.json("/api/config")).changes, { showShared: false });
  const enabled = await h.fetch("/api/config", { method: "PATCH", body: JSON.stringify({ changes: { showShared: true } }) });
  assert.equal(enabled.status, 200);
  const status = await enabled.json();
  assert.deepEqual(status.changes, { showShared: true });
  assert.equal(status.profile.about, "Keep this context");
  assert.deepEqual(JSON.parse(readFileSync(join(home, ".bloks", "config.json"), "utf8")).changes, { showShared: true });
});

test("a malformed shared-file preference is refused before other config writes", async (t) => {
  const h = await startHarness();
  t.after(() => h.stop());
  const before = await h.json("/api/config");
  for (const changes of [null, false, [], "off", {}, { showShared: null }, { showShared: 0 }, { showShared: "false" }]) {
    const response = await h.fetch("/api/config", { method: "PUT", body: JSON.stringify({ changes, profile: { about: "must not be saved" } }) });
    assert.equal(response.status, 400, JSON.stringify(changes));
    const after = await h.json("/api/config");
    assert.deepEqual(after.profile, before.profile);
    assert.deepEqual(after.changes, before.changes);
  }
});
