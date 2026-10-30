// The rules a move between this Mac and the hosted machine keeps, apart
// from the servers: what is counted and how a difference is said, which
// keys are asked for again and on which page, the note a moved copy
// keeps, the checksums on each part, what the app keeps on disk, and when
// a move starts without being asked (test/hosting-move.test.ts carries a
// whole move between real servers).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { autoMoveFrom, countsDiffer as appCountsDiffer, hostingRunning, keepMoveState, newMove, readMoveState } from "../electron/hosting-move.mjs";
import { markMoved, normalizeEntry } from "../electron/workspaces.mjs";
import { HOSTED_TARGET, othersFor } from "../electron/server-line.mjs";
import { MOVE_STEPS, countsWords, headline, keyGroups, sendingWords, stepLabel, stepState } from "../src/lib/hostingMove.ts";
import { thisComputer } from "../src/lib/thisComputer.ts";
import { stripSecrets } from "../server/backup.ts";
import { MoveUploads, PART_BYTES, UploadError, readPart, sha256 } from "../server/move-upload.ts";
import { cleanMovedMark, clearMovedMark, movedWords, readMovedMark, writeMovedMark } from "../server/moved-mark.ts";
import {
  countsDiffer,
  emptyEnoughForMove,
  heldKeyPaths,
  keyPage,
  keysLeftBehind,
  moveLeftOut,
  readCounts,
  readKeys,
  stillToEnter,
} from "../server/workspace-move.ts";

const counts = { agents: 3, conversations: 5, rooms: 1, routines: 2, watchers: 1, workflows: 1, memoryFiles: 4 };

test("counts: a whole set or nothing, and what differs said in words", () => {
  assert.deepEqual(readCounts(counts), counts);
  assert.equal(readCounts({ ...counts, rooms: -1 }), null);
  assert.equal(readCounts({ agents: 1 }), null);
  assert.deepEqual(countsDiffer(counts, counts), []);
  assert.deepEqual(countsDiffer(counts, { ...counts, agents: 2, memoryFiles: 3 }), ["2 of 3 agents", "3 of 4 memory files"]);
  assert.deepEqual(countsDiffer({ ...counts, rooms: 1 }, { ...counts, rooms: 0 }), ["0 of 1 room"]);
  // the app says it the same way
  assert.deepEqual(appCountsDiffer(counts, { ...counts, agents: 2, memoryFiles: 3 }), ["2 of 3 agents", "3 of 4 memory files"]);
  assert.deepEqual(appCountsDiffer(counts, null).length, 7, "nothing counted there is nothing arrived");
});

test("a workflow is standing work: a workspace with one takes no move in", () => {
  const none = { mine: 0, rooms: 0, routines: 0, watchers: 0, intents: 0, workflows: 0 };
  assert.equal(emptyEnoughForMove(none), true);
  assert.equal(emptyEnoughForMove({ ...none, workflows: 1 }), false);
});

test("keys left behind are named once each, with the page they are entered on, and never their values", () => {
  const original = {
    providers: { openrouter: { key: "sk-or-1" } },
    secrets: { WEATHER: "w", MAPS: "m" },
    composio: { key: "ak_1" },
    chat: { slack: { botToken: "xoxb-1", appToken: "xapp-1" }, discord: { token: "d" } },
    telegram: { bots: { a1: { token: "1:x" } } },
    speech: { elevenlabsKey: "e" },
    relay: { agentToken: "r" },
    credits: { licence: "blok_live_x" },
  };
  const leftOut = stripSecrets(structuredClone(original));
  const keys = keysLeftBehind(leftOut, original);
  const pages = Object.fromEntries(keys.map((k) => [k.label, k.page]));
  assert.equal(pages["OpenRouter key"], "engines");
  assert.equal(pages["Saved secret WEATHER"], "apps");
  assert.equal(pages["Saved secret MAPS"], "apps");
  assert.equal(pages["Composio key"], "apps");
  assert.equal(pages["Slack bot token"], "chat");
  assert.equal(pages["Discord token"], "chat");
  assert.equal(pages["A Telegram bot token"], "chat");
  assert.equal(pages["ElevenLabs key"], "voices");
  assert.equal(pages["Bloks Cloud key, for Bloks AI"], "plan");
  assert.ok(!keys.some((k) => k.path.startsWith("relay.")), "the relay's own tokens are not anybody's to enter");
  const words = JSON.stringify(keys);
  for (const value of ["sk-or-1", "ak_1", "xoxb-1", "xapp-1", "1:x", "blok_live_x"]) assert.ok(!words.includes(value), value);
  assert.equal(keyPage("mcpServers[m1].headers"), "plugins");
  assert.equal(keyPage("box.token"), "computers");
  assert.deepEqual(readKeys([{ label: "X", path: "composio.key", page: "anything" }, { label: 1 }]), [{ label: "X", page: "apps", path: "composio.key" }]);
});

test("a machine that holds a key already is not asked for it again, saved secrets by name", () => {
  const keys = keysLeftBehind(["providers.openrouter.key", "secrets", "composio.key"], { secrets: { WEATHER: "w", MAPS: "m" } });
  const here = { providers: { openrouter: { key: "theirs" } }, secrets: { MAPS: "m2", OTHER: "o" } };
  const held = heldKeyPaths(here, stripSecrets);
  assert.ok(held.includes("providers.openrouter.key") && held.includes("secrets.MAPS") && !held.includes("secrets"));
  assert.deepEqual(stillToEnter(keys, held).map((k) => k.label), ["Saved secret WEATHER", "Composio key"]);
  assert.equal(here.providers.openrouter.key, "theirs", "looked at, never changed");
});

test("the note a moved copy keeps never travels, and is cleaned like a name", () => {
  assert.ok(moveLeftOut("moved.json", false));
  const mark = cleanMovedMark({ to: "hosted", name: "Hos‮ted\u0007 machine", workspaceId: "ws_abc", pending: true }, 5);
  assert.deepEqual(mark, { to: "hosted", name: "Hos ted machine", workspaceId: "ws_abc", at: 5, pending: true });
  assert.equal(cleanMovedMark({ to: "elsewhere" }), null);
  assert.equal(cleanMovedMark({ to: "mac", workspaceId: "../x" })?.workspaceId, null);
  assert.match(movedWords({ ...mark!, pending: false }), /^This workspace moved to your hosted machine\./);
  assert.match(movedWords(mark!), /is moving to your hosted machine/);
  const dir = mkdtempSync(join(tmpdir(), "bloks-moved-mark-"));
  try {
    assert.equal(readMovedMark(dir), null);
    writeMovedMark(dir, mark!);
    assert.deepEqual(readMovedMark(dir), mark);
    clearMovedMark(dir);
    assert.equal(readMovedMark(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("each part is checked against its SHA-256 as it lands, and the whole file before it is taken in", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bloks-move-digests-"));
  try {
    const uploads = new MoveUploads({ dir: () => dir, maxBytes: 10 * PART_BYTES });
    const file = Buffer.alloc(PART_BYTES + 100, 7);
    file[5] = 1;
    const parts = [file.subarray(0, PART_BYTES), file.subarray(PART_BYTES)];
    assert.throws(() => uploads.start(file.length, "not-a-digest"), (e) => e instanceof UploadError && e.status === 400);
    const { id } = uploads.start(file.length, sha256(file));
    assert.equal(uploads.status(id)?.sha256, sha256(file));
    // changed on the way: refused before it is written, and asked for again
    assert.throws(() => uploads.put(id, 0, Buffer.from(parts[0]).fill(9), sha256(parts[0])), (e) => e instanceof UploadError && e.status === 422);
    assert.deepEqual(uploads.status(id)?.missing, [0, 1]);
    uploads.put(id, 0, parts[0], sha256(parts[0]));
    // a part that says nothing of its digest is taken as it is, as an
    // older app sends it; the whole file then is what is held to account
    uploads.put(id, 1, Buffer.from(parts[1]).fill(3));
    await assert.rejects(uploads.checkWhole(id), (e) => e instanceof UploadError && e.status === 422);
    assert.deepEqual(uploads.status(id)?.missing, [0, 1], "every part is asked for again");
    uploads.put(id, 0, parts[0], sha256(parts[0]));
    uploads.put(id, 1, parts[1], sha256(parts[1]));
    await uploads.checkWhole(id);
    const whole = join(dir, "whole.bin");
    uploads.finish(id, whole);
    assert.equal(readPart(whole, 1)?.sha256, sha256(parts[1]));
    assert.equal(readPart(whole, 2), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the app keeps a move on disk under the licence's fingerprint", () => {
  const dir = mkdtempSync(join(tmpdir(), "bloks-move-state-"));
  const file = join(dir, "hosting-move.json");
  try {
    assert.deepEqual(readMoveState(file, "print-a"), { version: 1, print: "print-a", boughtFrom: null, moved: null, move: null });
    const move = newMove({ direction: "to-hosted", from: { id: "personal", name: "Personal" }, to: { name: "Hosted" }, auto: true, now: 1000 });
    assert.equal(move.phase, "waiting");
    assert.equal(move.startsAt, 7000);
    keepMoveState(file, { version: 1, print: "print-a", boughtFrom: { id: "ws_1", at: 5 }, moved: { at: 9, from: "personal", to: "ws_h" }, move });
    const back = readMoveState(file, "print-a");
    assert.deepEqual(back.boughtFrom, { id: "ws_1", at: 5 });
    assert.equal(back.moved?.to, "ws_h");
    assert.equal(back.move?.id, move.id);
    // another licence: what this one bought and moved is not that one's,
    // but a move under way still belongs to the workspaces
    const other = readMoveState(file, "print-b");
    assert.equal(other.boughtFrom, null);
    assert.equal(other.moved, null);
    assert.equal(other.move?.id, move.id);
    writeFileSync(file, "{ not json");
    assert.equal(readMoveState(file, "print-a").move, null);
    assert.ok(readFileSync(file, "utf8").length > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buying Hosting starts the first move on its own, from the workspace that went to checkout, else Personal, and once", () => {
  const registry = {
    workspaces: [
      { id: "personal", kind: "personal", name: "Personal" },
      { id: "ws_shop", kind: "custom", name: "Shop" },
      { id: "ws_join", kind: "joined", name: "Theirs" },
      { id: "ws_h", kind: "hosted", name: "Hosted" },
    ],
  };
  const running = { shared: true, accountStatus: "active", hosting: { tier: "standard", state: "active" }, bloksAi: true };
  const blank = { version: 1 as const, print: "p", boughtFrom: null, moved: null, move: null };
  assert.equal(hostingRunning(running), true);
  for (const state of ["provisioning", "grace", "stopped", ""]) assert.equal(hostingRunning({ ...running, hosting: { state } }), false, state);
  assert.equal(hostingRunning({ ...running, shared: false }), false, "a workspace's own key speaks for itself only");
  assert.equal(hostingRunning({ ...running, accountStatus: "past_due" }), false);
  assert.deepEqual(autoMoveFrom({ account: running, state: blank, registry }), { id: "personal", name: "Personal" });
  assert.deepEqual(autoMoveFrom({ account: running, state: { ...blank, boughtFrom: { id: "ws_shop", at: 1 } }, registry }), { id: "ws_shop", name: "Shop" });
  // a workspace that is not here any more, or not one of this Mac's own
  assert.deepEqual(autoMoveFrom({ account: running, state: { ...blank, boughtFrom: { id: "ws_gone", at: 1 } }, registry }), { id: "personal", name: "Personal" });
  assert.deepEqual(autoMoveFrom({ account: running, state: { ...blank, boughtFrom: { id: "ws_join", at: 1 } }, registry }), { id: "personal", name: "Personal" });
  // once: not after this licence moved, nor while a move is under way or was put off
  assert.equal(autoMoveFrom({ account: running, state: { ...blank, moved: { at: 1, from: "personal", to: "ws_h" } }, registry }), null);
  const later = { ...newMove({ direction: "to-hosted", from: { id: "personal", name: "Personal" }, to: { name: "Hosted" } }), phase: "later" as const };
  assert.equal(autoMoveFrom({ account: running, state: { ...blank, move: later }, registry }), null);
  assert.equal(autoMoveFrom({ account: { ...running, hosting: { state: "provisioning" } }, state: blank, registry }), null);
});

test("a phone paired with a moved copy is told where its work went, and what to ask a pairing for", () => {
  const registry = {
    version: 1,
    current: "personal",
    prefs: { theme: null, sameAccent: false, accent: null },
    workspaces: [
      normalizeEntry({ id: "personal", kind: "personal", name: "Personal", dataDir: "/x", moved: { to: "ws_h", at: 1 } })!,
      normalizeEntry({ id: "ws_shop", kind: "custom", name: "Shop", dataDir: "/y" })!,
      normalizeEntry({ id: "ws_h", kind: "hosted", name: "Hosted" })!,
    ],
  };
  const listed = othersFor(registry, "ws_shop");
  assert.deepEqual(listed.find((w) => w.id === "personal")?.movedTo, { kind: "hosted", name: "Hosted", pair: HOSTED_TARGET });
  assert.equal(listed.find((w) => w.id === "ws_shop")?.movedTo, undefined);
  assert.ok(!listed.some((w) => w.id === "ws_h"), "the hosted one is not listed as one of this Mac's own");
});

test("the card says each step in a word or two, and how much is across while it sends", () => {
  const move = { direction: "to-hosted" as const, from: { id: "personal", name: "Personal" }, to: { id: "ws_h", name: "Hosted" }, phase: "running" as const, step: "sending" as const, sent: 12_400_000, size: 340_000_000 };
  assert.deepEqual(MOVE_STEPS.map((s) => stepState(move, s.step)), ["done", "done", "now", "next", "next", "next"]);
  assert.equal(stepLabel(move, "sending"), "Sending 12 of 340 MB");
  assert.equal(stepLabel({ ...move, step: "packing" }, "sending"), "Sending");
  assert.equal(sendingWords(3_100_000, 5_000_000), "Sending 3.1 of 5.0 MB");
  assert.equal(sendingWords(1_200_000_000, 3_400_000_000), "Sending 1.2 of 3.4 GB");
  assert.equal(headline(move), "Moving Personal to your hosted machine");
  assert.equal(headline({ ...move, phase: "done" }), "Personal is on your hosted machine");
  // the machine a move home lands on is named as this one is, Mac, PC or computer
  assert.equal(headline({ ...move, direction: "to-mac", from: { id: "ws_h", name: "Hosted" }, to: { id: "ws_n", name: "Hosted" } }), `Moving Hosted to Hosted on ${thisComputer()}`);
  assert.equal(countsWords({ agents: 3, conversations: 1, rooms: 0, routines: 2, watchers: 0, workflows: 0, memoryFiles: 0 }), "3 agents, 1 conversation and 2 routines");
  const groups = keyGroups(
    [
      { label: "OpenRouter key", page: "engines", path: "providers.openrouter.key" },
      { label: "Slack bot token", page: "chat", path: "chat.slack.botToken" },
      { label: "Slack app token", page: "chat", path: "chat.slack.appToken" },
      { label: "Bloks Cloud key, for Bloks AI", page: "plan", path: "credits.licence" },
    ],
    true,
  );
  assert.deepEqual(groups, [
    { page: "engines", label: "Engines and keys", items: ["OpenRouter key"] },
    { page: "chat", label: "Chat and email", items: ["Slack bot token", "Slack app token"] },
  ]);
  assert.equal(keyGroups([{ label: "Bloks Cloud key, for Bloks AI", page: "plan", path: "credits.licence" }], false)[0].label, "Plan");
});

test("a copy whose work moved is marked in the list until it is removed", () => {
  const entry = normalizeEntry({ id: "personal", kind: "personal", name: "Personal", dataDir: "/x", moved: { to: "ws_h", at: 3 } });
  assert.deepEqual(entry?.moved, { to: "ws_h", at: 3 });
  assert.equal(normalizeEntry({ id: "ws_1", kind: "custom", name: "One", dataDir: "/y", moved: { to: "../etc" } })?.moved, null);
  const registry = { version: 1, current: "personal", prefs: { theme: null, sameAccent: false, accent: null }, workspaces: [entry!] };
  assert.deepEqual(markMoved(registry, "personal", "ws_h", 7).workspaces[0].moved, { to: "ws_h", at: 7 });
  assert.equal(markMoved(registry, "personal", null).workspaces[0].moved, null);
});
