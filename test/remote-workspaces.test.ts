// The desktop app as a client of several servers of your own (GitHub 428),
// as the list keeps them (electron/workspaces.mjs).
//
// What this holds: each server you pair is a workspace of its own, named,
// beside the others; pairing the same server again keeps its place and
// name, and pairing another never replaces it; with "Run workspaces on
// this computer" off, the ones here are kept but neither listed nor
// opened, the app opens a server instead, and it never ends up with
// nothing to open; and the choice and the list survive a restart.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  addRemote,
  fallbackWorkspace,
  freeName,
  isRemoteKind,
  parseRegistry,
  readRegistry,
  removeWorkspace,
  runsLocal,
  setCurrent,
  setLocal,
  settle,
  shownWorkspaces,
  snapshot,
  updateWorkspace,
  writeRegistry,
} from "../electron/workspaces.mjs";

const fresh = () => settle(parseRegistry(null), { personalDataDir: "/home/fixture/.bloks", now: 1, random: () => 0.5 });
let n = 0;
const nextId = () => `ws_test${++n}`;

test("each server paired is a workspace of its own, named, and pairing the same one again keeps it", () => {
  let reg = fresh();
  const one = addRemote(reg, { name: "Lab box", host: "Owner", relayUrl: "https://relay.example" }, { id: nextId() });
  reg = one.registry;
  assert.equal(one.replaced, false);
  assert.equal(one.entry.kind, "remote");
  assert.equal(isRemoteKind("remote"), true);
  assert.equal(one.entry.name, "Lab box");
  assert.equal(one.entry.dataDir, null, "nothing of it is on this computer");

  const two = addRemote(reg, { name: "", host: "Owner", relayUrl: "https://relay.example" }, { id: nextId() });
  reg = two.registry;
  assert.equal(two.replaced, false, "a second server is added beside the first");
  assert.equal(two.entry.name, "Server");
  assert.notEqual(two.entry.id, one.entry.id);
  assert.equal(reg.workspaces.filter((w) => w.kind === "remote").length, 2);
  assert.ok(two.entry.mark && one.entry.mark && JSON.stringify(two.entry.mark) !== JSON.stringify(one.entry.mark), "each wears a mark of its own");

  // the first server paired again: same place, same name, new host details
  reg = updateWorkspace(reg, one.entry.id, { name: "Lab" });
  const again = addRemote(reg, { host: "Owner renamed", relayUrl: "https://relay.example", same: one.entry.id }, { id: nextId() });
  assert.equal(again.replaced, true);
  assert.equal(again.entry.id, one.entry.id);
  assert.equal(again.entry.name, "Lab", "pairing again keeps the name it was given");
  assert.equal(again.entry.host?.name, "Owner renamed");
  assert.equal(again.registry.workspaces.length, reg.workspaces.length, "and adds nothing");
  assert.deepEqual(again.registry.workspaces.find((w) => w.id === two.entry.id), reg.workspaces.find((w) => w.id === two.entry.id), "the other is untouched");
});

test("names are kept apart, and a hosted pairing never stands in for a server's", () => {
  let reg = fresh();
  reg = addRemote(reg, { name: "Server" }, { id: nextId() }).registry;
  assert.equal(freeName(reg, "Server"), "Server 2");
  assert.equal(freeName(reg, "personal"), "personal 2", "names are compared without case");
  assert.equal(freeName(reg, "  "), "Server 2");
  const same = addRemote(reg, { name: "x", same: "personal" }, { id: nextId() });
  assert.equal(same.replaced, false, "only another server entry is paired again");
});

test("with workspaces here turned off, only servers are listed and opened, and the ones here are kept", () => {
  let reg = fresh();
  assert.equal(runsLocal(reg), true);
  assert.throws(() => setLocal(reg, false), /Add a server first/, "never with nothing elsewhere to open");

  const server = addRemote(reg, { name: "Lab" }, { id: nextId() });
  reg = server.registry;
  assert.equal(reg.current, "personal");
  reg = setLocal(reg, false);
  assert.equal(runsLocal(reg), false);
  assert.equal(reg.current, server.entry.id, "the window moves to a server");
  assert.ok(reg.workspaces.some((w) => w.kind === "personal"), "Personal is kept, folder and all");
  assert.deepEqual(shownWorkspaces(reg).map((w) => w.id), [server.entry.id]);
  const shown = snapshot(reg);
  assert.equal(shown.local, false);
  assert.deepEqual(shown.workspaces.map((w) => w.id), [server.entry.id], "the switcher lists only the server");
  assert.equal(shown.workspaces[0].remote, true);
  assert.throws(() => setCurrent(reg, "personal"), /turned off/, "a workspace here is not opened");
  assert.equal(fallbackWorkspace(reg)?.id, server.entry.id);

  // the last server can't go while nothing runs here
  assert.throws(() => removeWorkspace(reg, server.entry.id), /only workspace this app opens/);
  const second = addRemote(reg, { name: "Home" }, { id: nextId() });
  reg = second.registry;
  const removed = removeWorkspace(reg, server.entry.id).registry;
  assert.equal(removed.current, second.entry.id, "removing the one on screen moves to another server, never to Personal");

  // on again: everything is back, and the window stays where it is
  const back = setLocal(removed, true);
  assert.equal(back.current, second.entry.id);
  assert.deepEqual(shownWorkspaces(back).map((w) => w.kind).sort(), ["personal", "remote"]);
});

test("the list, the servers and the choice survive a restart, and a list with no server left runs here again", () => {
  const dir = mkdtempSync(join(tmpdir(), "bloks-remote-list-"));
  try {
    const file = join(dir, "workspaces.json");
    let reg = fresh();
    const a = addRemote(reg, { name: "Lab", host: "Owner", relayUrl: "https://relay.example" }, { id: nextId() });
    reg = addRemote(a.registry, { name: "Home" }, { id: nextId() }).registry;
    reg = setLocal(reg, false);
    reg = setCurrent(reg, reg.workspaces.find((w) => w.name === "Home")!.id);
    writeRegistry(file, reg);

    const read = settle(readRegistry(file), { personalDataDir: "/home/fixture/.bloks" });
    assert.equal(runsLocal(read), false);
    assert.equal(read.workspaces.find((w) => w.id === read.current)?.name, "Home");
    const lab = read.workspaces.find((w) => w.name === "Lab")!;
    assert.equal(lab.kind, "remote");
    assert.equal(lab.host?.relayUrl, "https://relay.example");
    assert.equal(JSON.stringify(read).includes("deviceToken"), false, "no credential is kept in the list");

    // a hand-edited list with every server gone does not leave the app
    // with nothing to open: it runs here again
    const emptied = settle({ ...read, workspaces: read.workspaces.filter((w) => w.kind !== "remote") }, { personalDataDir: "/home/fixture/.bloks" });
    assert.equal(runsLocal(emptied), true);
    assert.equal(emptied.current, "personal");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an app from before keeps running workspaces here", () => {
  const reg = settle(parseRegistry(JSON.stringify({ workspaces: [], prefs: {} })), { personalDataDir: "/x" });
  assert.equal(runsLocal(reg), true);
  assert.equal(snapshot(reg).local, true);
});
