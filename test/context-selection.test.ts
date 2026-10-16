// A reading belongs to the model that answered this lane, even on backup.
import assert from "node:assert/strict";
import { test } from "node:test";
import { laneFill, selectionForContext, type Reading } from "../server/context.ts";

const own = { instanceId: "claude", model: "claude-opus-5-5" };
const backup = { instanceId: "codex", model: "gpt-6.1-sol" };
const defaults = { modelSelection: own, backupSelection: backup, lastInstanceId: backup.instanceId, running: null, command: false };
const select = (change: Partial<Parameters<typeof selectionForContext>[0]> = {}) => selectionForContext({ ...defaults, ...change });
const reading: Reading = { ...backup, used: 90_000, window: 150_000, at: 1 };

test("idle selection follows the last dispatched instance in either direction", () => {
  assert.deepEqual(select(), backup);
  assert.deepEqual(select({ lastInstanceId: own.instanceId }), own);
  assert.deepEqual(select({ modelSelection: backup, backupSelection: own, lastInstanceId: own.instanceId }), own);
});

test("a running model overrides the persisted instance before its first reading", () => {
  assert.deepEqual(select({ running: own }), own);
  assert.equal(laneFill(reading, select({ running: own })!).measured, false);
  assert.equal(laneFill({ ...reading, ...own }, select({ running: own })!).measured, true);
});

test("commands preserve the last model dispatch instead of selecting their own engine", () => {
  assert.deepEqual(select({ running: own, command: true }), backup);
  assert.deepEqual(select({ running: backup, command: true, lastInstanceId: own.instanceId }), own);
  assert.deepEqual(select({ command: true }), backup);
});

test("undefined and empty dispatch identities keep the strict primary path", () => {
  for (const lastInstanceId of [undefined, ""]) {
    assert.deepEqual(select({ lastInstanceId }), own);
    assert.equal(laneFill(reading, select({ lastInstanceId })!).measured, false);
    assert.equal(laneFill({ ...reading, ...own }, select({ lastInstanceId })!).measured, true);
  }
});

test("removed or replaced backups and unknown last engines have no selection", () => {
  assert.equal(select({ backupSelection: null }), null);
  assert.equal(select({ backupSelection: undefined }), null);
  assert.equal(select({ backupSelection: { ...backup, instanceId: "replacement" } }), null);
  assert.equal(select({ lastInstanceId: "retired" }), null);
});

test("model edits do not make an old reading eligible", () => {
  const changed = select({ backupSelection: { ...backup, model: "gpt-6-astra" } })!;
  assert.equal(laneFill(reading, changed).measured, false);
  const primary = select({ lastInstanceId: own.instanceId, modelSelection: { ...own, model: "claude-sonnet-5" } })!;
  assert.equal(laneFill({ ...reading, ...own }, primary).measured, false);
});

test("identical selections on one instance are not ambiguous", () => {
  assert.deepEqual(select({ modelSelection: backup, backupSelection: { ...backup } }), backup);
  assert.equal(laneFill(reading, select({ modelSelection: backup })!).measured, true);
});

test("two models on one instance are ambiguous only while idle or running a command", () => {
  const different = { ...backup, model: "gpt-6-astra" };
  assert.equal(select({ modelSelection: different }), null);
  assert.equal(select({ modelSelection: different, running: backup, command: true }), null);
  for (const running of [backup, different]) {
    const chosen = select({ modelSelection: different, running })!;
    assert.deepEqual(chosen, running);
    assert.equal(laneFill({ ...reading, ...running }, chosen).measured, true);
    const other = running === backup ? different : backup;
    assert.equal(laneFill({ ...reading, ...other }, chosen).measured, false);
  }
  // The reading cannot break the tie, whichever model last reported it.
  for (const by of [backup, different]) {
    const chosen = select({ modelSelection: different });
    assert.equal(chosen, null);
    assert.equal(laneFill(chosen ? { ...reading, ...by } : undefined, chosen ?? { instanceId: "" }).measured, false);
  }
});

test("an instance shared by both selections does not make another last engine ambiguous", () => {
  assert.equal(select({ modelSelection: backup, backupSelection: { ...backup, model: "gpt-6-astra" }, lastInstanceId: "retired" }), null);
  assert.deepEqual(select({ modelSelection: backup, backupSelection: { ...backup, model: "gpt-6-astra" }, lastInstanceId: "" }), backup);
});
