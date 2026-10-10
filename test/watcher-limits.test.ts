import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { cleanWatcher, type WatchKind } from "../server/watchers.ts";
import { startHarness } from "./helpers/server.ts";

const targetFor = (kind: WatchKind) => kind === "folder" ? "/fixture" : kind === "check" ? "true" : "https://fixture.invalid/";
const raw = (kind: WatchKind) => ({ botId: "b", kind, target: targetFor(kind), instruction: "Do the whole task", enabled: false });
const clean = (value: Record<string, unknown>) => cleanWatcher(value, () => true);

for (const kind of ["folder", "page", "feed", "check"] as const) {
  test(`${kind} instruction accepts the complete boundary and refuses longer text`, () => {
    const instruction = "x".repeat(1_000);
    const exact = clean({ ...raw(kind), instruction });
    assert.ok(exact.ok);
    assert.equal(exact.value.instruction, instruction);
    const trimmed = clean({ ...raw(kind), instruction: `  ${instruction}\n` });
    assert.ok(trimmed.ok);
    assert.equal(trimmed.value.instruction, instruction);
    const long = clean({ ...raw(kind), instruction: instruction + "!" });
    assert.equal(long.ok, false, "over-limit instruction was silently cut");
    assert.ok(!long.ok && /instruction.*1,000/.test(long.error));
  });
}

for (const kind of ["folder", "page", "feed"] as const) {
  test(`${kind} target accepts the complete boundary and refuses longer text`, () => {
    const prefix = targetFor(kind);
    const target = prefix + "x".repeat(1_000 - prefix.length);
    const exact = clean({ ...raw(kind), target });
    assert.ok(exact.ok);
    assert.equal(exact.value.target, target);
    const long = clean({ ...raw(kind), target: target + "!" });
    assert.equal(long.ok, false, "over-limit target was silently cut");
    assert.ok(!long.ok && /target.*1,000/.test(long.error));
  });
}

test("instruction limits do not split a surrogate pair", () => {
  const instruction = "x".repeat(998) + "😀";
  assert.equal(instruction.length, 1_000);
  const exact = clean({ ...raw("folder"), instruction });
  assert.ok(exact.ok);
  assert.equal(exact.value.instruction, instruction);
  assert.equal(clean({ ...raw("folder"), instruction: "x" + instruction }).ok, false, "instruction lost half an emoji");
});

test("target limits do not split a surrogate pair", () => {
  const target = "/" + "x".repeat(997) + "😀";
  assert.equal(target.length, 1_000);
  const exact = clean({ ...raw("folder"), target });
  assert.ok(exact.ok);
  assert.equal(exact.value.target, target);
  assert.equal(clean({ ...raw("folder"), target: "/" + target }).ok, false, "target lost half an emoji");
});

test("checks keep their existing 500-unit command limit", () => {
  const target = "x".repeat(500);
  const exact = clean({ ...raw("check"), target });
  assert.ok(exact.ok);
  assert.equal(exact.value.target, target);
  const long = clean({ ...raw("check"), target: target + "x" });
  assert.ok(!long.ok && /500/.test(long.error));
});

test("name, mentions and thread retain their existing clipping", () => {
  const made = clean({ ...raw("page"), name: "n".repeat(61), mentions: "m".repeat(121), thread: "t".repeat(41) });
  assert.ok(made.ok);
  assert.equal(made.value.name.length, 60);
  assert.equal(made.value.mentions!.length, 120);
  assert.equal(made.value.thread!.length, 40);
});

const request = (method: string, body: unknown) => ({ method, body: JSON.stringify(body) });
const savedBytes = (home: string) => {
  const path = join(home, ".bloks", "watchers.json");
  return existsSync(path) ? readFileSync(path, "utf8") : null;
};

test("HTTP create refuses over-limit fields before saving, and keeps exact boundaries", async (t) => {
  const h = await startHarness();
  t.after(() => h.stop());
  const { bot } = await h.json("/api/bots", request("POST", { name: "Watcher limits" }));
  assert.ok(bot, h.logs());
  const before = savedBytes(h.home);
  for (const field of ["instruction", "target"] as const) {
    const body = { ...raw("folder"), botId: bot.id, [field]: field === "instruction" ? "x".repeat(1_001) : "/" + "x".repeat(1_000) };
    const rejected = await h.fetch("/api/watchers", request("POST", body));
    assert.equal(rejected.status, 400, `${field} create was accepted with truncated text`);
    assert.match((await rejected.json()).error, new RegExp(`${field}.*1,000`));
    assert.equal(savedBytes(h.home), before, "a refused create changed the saved watchers");
    assert.deepEqual((await h.json("/api/watchers")).watchers, []);
  }
  const instruction = "x".repeat(998) + "😀";
  const target = "/" + "x".repeat(997) + "😀";
  const accepted = await h.fetch("/api/watchers", request("POST", { ...raw("folder"), botId: bot.id, instruction, target }));
  assert.equal(accepted.status, 201);
  const { watcher } = await accepted.json();
  assert.equal(watcher.instruction, instruction);
  assert.equal(watcher.target, target);
  const saved = JSON.parse(savedBytes(h.home)!);
  assert.equal(saved[0].instruction, instruction);
  assert.equal(saved[0].target, target);
});

test("HTTP PATCH refuses the whole edit before saving, then accepts complete boundary text", async (t) => {
  const h = await startHarness();
  t.after(() => h.stop());
  const { bot } = await h.json("/api/bots", request("POST", { name: "Watcher edits" }));
  assert.ok(bot, h.logs());
  const { watcher } = await h.json("/api/watchers", request("POST", { ...raw("folder"), botId: bot.id, name: "Original" }));
  const before = savedBytes(h.home);
  for (const field of ["instruction", "target"] as const) {
    const value = field === "instruction" ? "x".repeat(1_001) : "/" + "x".repeat(1_000);
    const rejected = await h.fetch(`/api/watchers/${watcher.id}`, request("PATCH", { [field]: value, name: "Must not be saved", every: 77 }));
    assert.equal(rejected.status, 400, `${field} PATCH was accepted with truncated text`);
    assert.match((await rejected.json()).error, new RegExp(`${field}.*1,000`));
    assert.equal(savedBytes(h.home), before, "a refused PATCH changed another field or saved text");
    assert.deepEqual((await h.json("/api/watchers")).watchers, [watcher]);
  }
  const instruction = "x".repeat(998) + "😀";
  const target = "/" + "x".repeat(997) + "😀";
  const accepted = await h.fetch(`/api/watchers/${watcher.id}`, request("PATCH", { instruction, target }));
  assert.equal(accepted.status, 200);
  const updated = (await accepted.json()).watcher;
  assert.equal(updated.id, watcher.id);
  assert.equal(updated.instruction, instruction);
  assert.equal(updated.target, target);
  const saved = JSON.parse(savedBytes(h.home)!);
  assert.equal(saved[0].instruction, instruction);
  assert.equal(saved[0].target, target);
});

test("the actual CLI help states instruction, target and check-command limits", (t) => {
  const home = mkdtempSync(join(tmpdir(), "bloks-watcher-help-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const cli = fileURLToPath(new URL("../bin/bloks.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [cli, "help"], {
    env: { HOME: home, USERPROFILE: home, PATH: "/nonexistent" },
    encoding: "utf8", timeout: 5_000,
  });
  assert.equal(result.status, 0, result.stderr);
  const about = JSON.parse(result.stdout).commands.find((command: any) => command.name === "watch").about;
  assert.match(about, /instruction.*target.*1,000/);
  assert.match(about, /check command.*500/);
  assert.match(about, /refused, not cut/);
});
