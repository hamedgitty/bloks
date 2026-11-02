import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { cleanWatcher, MAX_WATCHERS, roomForWatcher, type Watcher, type WatchKind } from "../server/watchers.ts";
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

// ── the fifty-watcher limit (GitHub 464) ───────────────────────────────

const stored = (i: number, more: Partial<Watcher> = {}): Watcher => ({
  id: `w${i}`, botId: "b", name: `Watcher ${i}`, kind: "folder", target: "/fixture", instruction: "Do the whole task",
  mode: "act", every: 5, enabled: true, createdAt: i, fires: [], ...more,
});
const fifty = (finished: Record<number, Partial<Watcher>> = {}) =>
  Array.from({ length: MAX_WATCHERS }, (_, i) => stored(i, finished[i]));
const idle = () => false;

test("a full list of watchers still at work or paused has no room, and is left as it was", () => {
  const list = fifty({ 3: { enabled: false }, 7: { enabled: false, failing: { at: 1, error: "gone" } } });
  assert.equal(roomForWatcher(list, idle), null);
  assert.equal(list.length, MAX_WATCHERS);
  assert.ok(roomForWatcher(list.slice(1), idle), "a list under the limit had no room");
  assert.equal(roomForWatcher(list.slice(1), idle)!.length, MAX_WATCHERS - 1, "room was made where none was needed");
});

test("the watcher that finished longest ago makes room, whatever finished it", () => {
  const list = fifty({
    4: { enabled: false, done: { at: 300, why: "once" } },
    9: { enabled: false, done: { at: 100, why: "until" } },
    12: { enabled: false, done: { at: 200, why: "once" } },
    20: { enabled: false },
  });
  const kept = roomForWatcher(list, idle)!;
  assert.equal(kept.length, MAX_WATCHERS - 1);
  assert.ok(!kept.some((w) => w.id === "w9"), "the oldest finished watcher was kept");
  for (const id of ["w4", "w12", "w20"]) assert.ok(kept.some((w) => w.id === id), `${id} went though it was not the oldest finished`);
  // and the history goes oldest first as more are filed
  const next = roomForWatcher([...kept, stored(50)], idle)!;
  assert.ok(!next.some((w) => w.id === "w12"));
  assert.ok(next.some((w) => w.id === "w4"));
});

test("a list of nothing but finished watchers keeps a full history and still takes new ones", () => {
  const list = Array.from({ length: MAX_WATCHERS }, (_, i) => stored(i, { enabled: false, done: { at: 1_000 - i, why: "once" } }));
  const kept = roomForWatcher(list, idle)!;
  assert.equal(kept.length, MAX_WATCHERS - 1);
  assert.ok(!kept.some((w) => w.id === "w49"));
  // more than the limit, from an older build or a hand edit, is brought back under it
  const over = roomForWatcher([...list, stored(50, { enabled: false, done: { at: 1, why: "until" } }), stored(51)], idle)!;
  assert.equal(over.length, MAX_WATCHERS - 1);
  assert.ok(!over.some((w) => w.id === "w50" || w.id === "w49" || w.id === "w48"));
});

test("a finished watcher still at work, switched back on, or holding an app trigger is not taken", () => {
  const app = (triggerId?: string) => ({
    toolkit: "github", trigger: "GITHUB_ISSUE_ADDED_EVENT", config: {}, accountId: "acct", perHour: 1, perDay: 1,
    toolkitName: "GitHub", runs: [], turnsAt: [], seen: [], ...(triggerId ? { triggerId } : {}),
  }) as unknown as Watcher["app"];
  const list = fifty({
    1: { enabled: false, done: { at: 10, why: "once" } },
    2: { enabled: true, done: { at: 20, why: "once" } },
    3: { kind: "app", enabled: false, done: { at: 30, why: "once" }, app: app("trigger-fixture") },
    4: { kind: "app", enabled: false, done: { at: 40, why: "until" }, app: app() },
  });
  const kept = roomForWatcher(list, (w) => w.id === "w1")!;
  assert.ok(kept, "an app watcher with no trigger left could not make room");
  assert.ok(!kept.some((w) => w.id === "w4"));
  for (const id of ["w1", "w2", "w3"]) assert.ok(kept.some((w) => w.id === id), `${id} was taken`);
  assert.equal(roomForWatcher(list.filter((w) => w.id !== "w4").concat(stored(60)), (w) => w.id === "w1"), null);
});

test("HTTP create lets the oldest finished watcher go at the limit, and keeps paused and unfinished ones", { timeout: 120_000 }, async (t) => {
  const home = mkdtempSync(join(tmpdir(), "bloks-watcher-room-"));
  const folder = join(home, "drops");
  mkdirSync(folder);
  t.after(() => rmSync(home, { recursive: true, force: true }));
  let h = await startHarness({ HOME: home });
  t.after(() => h.stop());
  const { bot } = await h.json("/api/bots", request("POST", { name: "Watcher room" }));
  assert.ok(bot, h.logs());
  const file = (name: string) => ({ ...raw("folder"), botId: bot.id, target: folder, name });
  for (let i = 0; i < MAX_WATCHERS; i++) {
    const made = await h.fetch("/api/watchers", request("POST", file(`Watcher ${i}`)));
    assert.equal(made.status, 201, await made.text());
  }
  // fifty that are paused or could still run: nothing is taken
  const ids = async () => ((await h.json("/api/watchers")).watchers as Watcher[]).map((w) => w.id);
  const before = await ids();
  const refused = await h.fetch("/api/watchers", request("POST", file("One too many")));
  assert.equal(refused.status, 409);
  assert.match((await refused.json()).error, /fifty watchers is the limit, and none of them has finished/);
  assert.deepEqual(await ids(), before, "a refused create changed the watchers");

  // three finish (two acted once, one ran out of time) while the app is closed
  await h.stop();
  const saved: Watcher[] = JSON.parse(savedBytes(home)!);
  const finished = { 5: { at: 3_000, why: "once" }, 17: { at: 1_000, why: "until" }, 30: { at: 2_000, why: "once" } } as const;
  for (const [i, done] of Object.entries(finished)) Object.assign(saved[Number(i)], { enabled: false, done });
  writeFileSync(join(home, ".bloks", "watchers.json"), JSON.stringify(saved));
  h = await startHarness({ HOME: home });

  const made = await h.fetch("/api/watchers", request("POST", file("Filed at the limit")));
  assert.equal(made.status, 201, await made.clone().text());
  const after: Watcher[] = (await h.json("/api/watchers")).watchers;
  assert.equal(after.length, MAX_WATCHERS);
  assert.ok(!after.some((w) => w.id === saved[17].id), "the watcher that finished longest ago was kept");
  for (const i of [5, 30]) assert.ok(after.some((w) => w.id === saved[i].id && w.done), "a newer finished watcher went");
  assert.equal(after.filter((w) => !w.done).length, MAX_WATCHERS - 2, "a paused or unfinished watcher went");
  assert.ok(after.some((w) => w.name === "Filed at the limit"));
  assert.equal(JSON.parse(savedBytes(home)!).length, MAX_WATCHERS, "the room made was not saved");

  // the next two take the rest of the history, oldest first, then it is full again
  for (const name of ["Second", "Third"]) assert.equal((await h.fetch("/api/watchers", request("POST", file(name)))).status, 201);
  const last: Watcher[] = (await h.json("/api/watchers")).watchers;
  assert.ok(!last.some((w) => w.done), "finished watchers were left while new ones were refused");
  assert.equal((await h.fetch("/api/watchers", request("POST", file("Fourth")))).status, 409);
});
