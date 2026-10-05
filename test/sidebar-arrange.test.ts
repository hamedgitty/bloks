// Where things stand in the sidebar, kept with the workspace (GitHub 156):
// pins and their places on the agents and rooms, the order of the
// headings beside them, all of it through a restart, and a workspace from
// before any of this brought up to it without changing how it looks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startHarness, type Harness } from "./helpers/server.ts";

const patch = (h: Harness, path: string, body: unknown) =>
  h.fetch(path, { method: "PATCH", body: JSON.stringify(body) });

test("pins, their places and the order of the headings outlast a restart", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "bloks-arrange-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const first = await startHarness({ HOME: home });
  // stopped below as well; a failure on the way must not leave it running
  t.after(() => first.stop());

  const hire = async (name: string) => (await first.json("/api/bots", { method: "POST", body: JSON.stringify({ name }) })).bot;
  const ada = await hire("Ada");
  const bo = await hire("Bo");
  const cy = await hire("Cy");
  const { blok: room } = await first.json("/api/bloks", {
    method: "POST",
    body: JSON.stringify({ name: "Standup", memberIds: [ada.id, bo.id] }),
  });
  assert.equal(room.pinned, true, "a new room is not pinned");
  assert.equal(room.pinOrder, null, "a new room should stand after the pins that have places");

  // Bo above the room, Cy filed and held first in Travel, Ada filed in Admin
  assert.equal((await patch(first, `/api/bots/${bo.id}`, { pinned: true, position: 1 })).status, 200);
  assert.equal((await patch(first, `/api/bots/${cy.id}`, { section: "Travel", position: 1 })).status, 200);
  assert.equal((await patch(first, `/api/bots/${ada.id}`, { section: "Admin" })).status, 200);
  const put = await first.fetch("/api/sidebar/sections", { method: "PUT", body: JSON.stringify({ order: ["Travel", "Admin"] }) });
  assert.equal(put.status, 200);

  // a place is a number among the pins, and nothing else will do
  assert.equal((await patch(first, `/api/bots/${ada.id}`, { position: 0 })).status, 400);
  assert.equal((await patch(first, `/api/bots/${ada.id}`, { pinned: "yes" })).status, 400);
  assert.equal((await patch(first, `/api/bots/${ada.id}`, { pinned: false, position: 2 })).status, 400);
  assert.equal((await first.fetch("/api/sidebar/sections", { method: "PUT", body: JSON.stringify({ order: "Travel" }) })).status, 400);

  const before = await first.json("/api/sidebar");
  assert.deepEqual(before.sectionOrder, ["Travel", "Admin"]);
  assert.deepEqual(
    before.sections.map((s: any) => [s.name, s.pinned.map((p: any) => [p.name, p.position]), s.others.map((o: any) => o.name)]),
    [
      // Nova is the agent every workspace starts with
      [null, [["Bo", 1], ["Standup", 2]], ["Nova"]],
      ["Travel", [["Cy", 1]], []],
      ["Admin", [], ["Ada"]],
    ],
  );
  await first.stop();

  const second = await startHarness({ HOME: home });
  t.after(() => second.stop());
  const after = await second.json("/api/sidebar");
  assert.deepEqual(after.sections, before.sections, "the arrangement did not survive a restart");
  assert.deepEqual(after.sectionOrder, ["Travel", "Admin"]);
  assert.equal(after.sectionOrderSaved, true);

  // the places travel on the records, which is what other devices read
  const { bots } = await second.json("/api/bots?messages=0");
  const byName = (name: string) => bots.find((b: any) => b.name === name);
  assert.deepEqual([byName("Bo").pinned, byName("Bo").pinOrder], [true, 1]);
  assert.deepEqual([byName("Cy").section, byName("Cy").pinned, byName("Cy").pinOrder], ["Travel", true, 1]);
  const { bloks } = await second.json("/api/bloks");
  assert.deepEqual([bloks[0].pinned, bloks[0].pinOrder], [true, 2]);

  // unpinning lets go of the place: pinned again, it joins the end
  assert.equal((await patch(second, `/api/bots/${bo.id}`, { pinned: false })).status, 200);
  const loose = (await second.json("/api/bots?messages=0")).bots.find((b: any) => b.id === bo.id);
  assert.deepEqual([loose.pinned, loose.pinOrder], [false, null]);
  assert.equal((await patch(second, `/api/bots/${bo.id}`, { pinned: true })).status, 200);
  const again = await second.json("/api/sidebar");
  assert.deepEqual(again.sections[0].pinned.map((p: any) => p.name), ["Standup", "Bo"]);

  // a room is unpinned the same way, and that choice is not undone on the next start
  assert.equal((await patch(second, `/api/bloks/${room.id}`, { pinned: false })).status, 200);
  await second.stop();
  const third = await startHarness({ HOME: home });
  t.after(() => third.stop());
  const { bloks: kept } = await third.json("/api/bloks");
  assert.equal(kept[0].pinned, false, "an unpinned room was pinned again on restart");
});

test("a workspace from before: rooms pinned in their old order, pinned agents after them, activity read off the transcripts", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "bloks-upgrade-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const first = await startHarness({ HOME: home });
  t.after(() => first.stop());
  const hire = async (name: string) => (await first.json("/api/bots", { method: "POST", body: JSON.stringify({ name }) })).bot;
  const talked = await hire("Talked");
  const told = await hire("Told by an agent");
  const scheduled = await hire("Scheduled");
  const open = async (name: string) =>
    (await first.json("/api/bloks", { method: "POST", body: JSON.stringify({ name, memberIds: [talked.id, told.id] }) })).blok;
  const older = await open("Older room");
  const newer = await open("Newer room");
  await first.stop();

  // Back to the shape an earlier version wrote: no places, no activity,
  // rooms that were never pinned or unpinned, two agents pinned the old
  // way, listed newest first as they always were.
  const dir = join(home, ".bloks");
  const botsFile = join(dir, "bots.json");
  const bloksFile = join(dir, "bloks.json");
  const old = <T extends Record<string, unknown>>(record: T) => {
    const { pinned: _p, pinOrder: _o, activeWithYouAt: _a, ...rest } = record;
    return rest;
  };
  const bots = JSON.parse(readFileSync(botsFile, "utf8")).map(old);
  for (const bot of bots) if (bot.id === talked.id || bot.id === scheduled.id) bot.pinned = true;
  // a routine's lane on one of them, whose prompt reads like the person
  const scheduledRecord = bots.find((b: any) => b.id === scheduled.id);
  scheduledRecord.tasks.push({ id: "routine-lane", title: "Routines", resumeCursors: {}, createdAt: 1 });
  writeFileSync(botsFile, JSON.stringify(bots, null, 2));
  writeFileSync(bloksFile, JSON.stringify(JSON.parse(readFileSync(bloksFile, "utf8")).map(old), null, 2));

  const append = (threadId: string, messages: unknown[]) => {
    const file = join(dir, `messages-${threadId}.json`);
    const list = JSON.parse(readFileSync(file, "utf8").toString() || "[]");
    writeFileSync(file, JSON.stringify([...list, ...messages], null, 2));
  };
  const write = (threadId: string, messages: unknown[]) =>
    writeFileSync(join(dir, `messages-${threadId}.json`), JSON.stringify(messages, null, 2));
  const at = Date.now() - 60_000;
  append(talked.threadId, [
    { id: "p1", role: "user", kind: "text", text: "find me a flight", at },
    { id: "p2", role: "bot", kind: "text", text: "found three", at: at + 10 },
  ]);
  append(told.threadId, [
    { id: "a1", role: "user", kind: "text", text: "can you check", agent: { dir: "in", peerId: talked.id, peerName: "Talked" }, at: at + 20 },
    { id: "a2", role: "bot", kind: "text", text: "checked", afterAgent: { peerId: talked.id, peerName: "Talked" }, at: at + 30 },
  ]);
  write("routine-lane", [
    { id: "r1", role: "user", kind: "text", text: "the morning digest", at: at + 40 },
    { id: "r2", role: "bot", kind: "text", text: "here it is", at: at + 50 },
  ]);
  append(older.id, [{ id: "o1", role: "user", kind: "text", text: "morning all", at: at + 60 }]);

  const second = await startHarness({ HOME: home });
  t.after(() => second.stop());
  const { bots: upgraded } = await second.json("/api/bots?messages=0");
  const { bloks: rooms } = await second.json("/api/bloks");
  const agent = (id: string) => upgraded.find((b: any) => b.id === id);
  const room = (id: string) => rooms.find((b: any) => b.id === id);

  // rooms pinned, newest first as they were listed; the pinned agents
  // after them, in the order they were listed too
  assert.deepEqual([room(newer.id).pinned, room(newer.id).pinOrder], [true, 1]);
  assert.deepEqual([room(older.id).pinned, room(older.id).pinOrder], [true, 2]);
  assert.deepEqual([agent(scheduled.id).pinned, agent(scheduled.id).pinOrder], [true, 3]);
  assert.deepEqual([agent(talked.id).pinned, agent(talked.id).pinOrder], [true, 4]);
  assert.ok(!agent(told.id).pinned);
  const { sections } = await second.json("/api/sidebar");
  assert.deepEqual(
    sections[0].pinned.map((p: any) => p.name),
    ["Newer room", "Older room", "Scheduled", "Talked"],
  );

  // the last moment each had something to do with the person
  assert.equal(agent(talked.id).activeWithYouAt, at + 10, "a reply to the person is time with them");
  assert.equal(agent(told.id).activeWithYouAt, 0, "another agent's message was read as the person");
  assert.equal(agent(scheduled.id).activeWithYouAt, 0, "a routine's lane was read as the person");
  assert.equal(room(older.id).activeWithYouAt, at + 60);
  assert.equal(room(newer.id).activeWithYouAt, 0);

  // and a later start finds nothing left to do
  await second.stop();
  const third = await startHarness({ HOME: home });
  t.after(() => third.stop());
  const again = await third.json("/api/bots?messages=0");
  for (const bot of again.bots) {
    const was = agent(bot.id);
    assert.deepEqual([bot.pinned, bot.pinOrder, bot.activeWithYouAt], [was.pinned, was.pinOrder, was.activeWithYouAt], bot.name);
  }
});
