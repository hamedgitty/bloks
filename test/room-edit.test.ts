// Changing a room after it opened, through PATCH /api/bloks/:id (GitHub
// 370). The route took any name, a blank one included, as a rename that
// then did nothing; cut a ninth agent off without a word; and left a room
// with one agent in it, which POST has always refused. The roster and the
// name are held to the same rules a new room is.
import { test } from "node:test";
import assert from "node:assert/strict";

import { roomLead } from "../src/lib/roomLead.ts";
import { startHarness, type Harness } from "./helpers/server.ts";

const patch = (h: Harness, id: string, body: Record<string, unknown>) =>
  h.fetch(`/api/bloks/${id}`, { method: "PATCH", body: JSON.stringify(body) });

const hire = async (h: Harness, name: string, seniority?: number) =>
  (await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name, ...(seniority ? { seniority } : {}) }) })).bot
    .id as string;

const open = async (h: Harness, name: string, memberIds: string[], leadId?: string) =>
  (await h.json("/api/bloks", { method: "POST", body: JSON.stringify({ name, memberIds, ...(leadId ? { leadId } : {}) }) }))
    .blok as { id: string; name: string; memberIds: string[]; leadId: string | null };

const listed = async (h: Harness, id: string) => (await h.json("/api/bloks")).bloks.find((b: any) => b.id === id);

/** Reads the event stream for a moment, from a sequence number on. */
async function framesSince(h: Harness, seq: number, ms = 1_000): Promise<any[]> {
  const res = await h.fetch(`/api/events?since=${seq}`);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let seen = "";
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const race = await Promise.race([
      reader.read(),
      new Promise<null>((r) => setTimeout(() => r(null), deadline - Date.now())),
    ]);
    if (!race || race.done) break;
    seen += decoder.decode(race.value, { stream: true });
  }
  await reader.cancel().catch(() => {});
  return seen
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)));
}

test("a rename is kept trimmed and clamped, and a blank one is refused rather than ignored", async (t) => {
  const h = await startHarness();
  t.after(() => h.stop());
  const room = await open(h, "Launch", [await hire(h, "Ada"), await hire(h, "Bo")]);

  const renamed = await patch(h, room.id, { name: "  Launch week  " });
  assert.equal(renamed.status, 200);
  assert.equal((await renamed.json()).blok.name, "Launch week");

  // as long as a name in a list may be, and no longer
  const long = await (await patch(h, room.id, { name: "n".repeat(200) })).json();
  assert.equal(long.blok.name, "n".repeat(80));

  for (const name of ["", "   ", null, 7]) {
    const refused = await patch(h, room.id, { name });
    assert.equal(refused.status, 400, `a name of ${JSON.stringify(name)} was taken`);
    assert.equal((await refused.json()).error, "a room needs a name");
  }
  assert.equal((await listed(h, room.id)).name, "n".repeat(80), "a refused rename changed the name");

  // a change that says nothing of the name leaves it alone
  assert.equal((await (await patch(h, room.id, { leadOnly: true })).json()).blok.name, "n".repeat(80));
});

test("a roster of one is refused in the words a new room is, counting each agent once", async (t) => {
  const h = await startHarness();
  t.after(() => h.stop());
  const ada = await hire(h, "Ada");
  const bo = await hire(h, "Bo");
  const room = await open(h, "Pair", [ada, bo]);

  for (const memberIds of [[ada], [ada, ada], [ada, "nobody"], []]) {
    const refused = await patch(h, room.id, { memberIds });
    assert.equal(refused.status, 400, `${JSON.stringify(memberIds)} was taken`);
    assert.equal((await refused.json()).error, "a room needs at least two agents");
  }
  assert.deepEqual((await listed(h, room.id)).memberIds, [ada, bo], "a refused roster changed the room");
});

test("a new room counts each agent once too, so one named twice is not a pair", async (t) => {
  const h = await startHarness();
  t.after(() => h.stop());
  const ada = await hire(h, "Ada");
  const bo = await hire(h, "Bo");
  const refused = await h.fetch("/api/bloks", { method: "POST", body: JSON.stringify({ name: "Echo", memberIds: [ada, ada] }) });
  assert.equal(refused.status, 400);
  assert.equal((await refused.json()).error, "a room needs at least two agents");
  const room = await open(h, "Pair", [ada, bo, ada]);
  assert.deepEqual(room.memberIds, [ada, bo]);
});

test("nine agents are refused, not cut to eight without a word", async (t) => {
  const h = await startHarness();
  t.after(() => h.stop());
  const ids: string[] = [];
  for (let i = 1; i <= 9; i++) ids.push(await hire(h, `Agent ${i}`));
  const room = await open(h, "Crowd", ids.slice(0, 2));

  const refused = await patch(h, room.id, { memberIds: ids });
  assert.equal(refused.status, 400);
  assert.equal((await refused.json()).error, "a room holds at most 8 agents");
  assert.deepEqual((await listed(h, room.id)).memberIds, ids.slice(0, 2));

  // eight is a room
  const eight = await patch(h, room.id, { memberIds: ids.slice(0, 8) });
  assert.equal(eight.status, 200);
  assert.deepEqual((await eight.json()).blok.memberIds, ids.slice(0, 8));
});

test("taking the lead out puts the room on seniority, as a room made without a crown is", async (t) => {
  const h = await startHarness();
  t.after(() => h.stop());
  const senior = await hire(h, "Senior", 5);
  const junior = await hire(h, "Junior");
  const third = await hire(h, "Third", 3);
  const fourth = await hire(h, "Fourth", 3);
  const leadNow = async (id: string) => {
    const room = await listed(h, id);
    const { bots } = await h.json("/api/bots");
    const members: Array<{ id: string; name: string; seniority?: number }> = room.memberIds.map((m: string) =>
      bots.find((b: any) => b.id === m),
    );
    return { leadId: room.leadId, lead: roomLead(members, room.leadId)?.name };
  };

  // a crowned junior taken out: the crown goes, and the most senior leads
  const crowned = await open(h, "Crowned", [senior, junior, third], junior);
  assert.equal((await patch(h, crowned.id, { memberIds: [senior, third] })).status, 200);
  assert.deepEqual(await leadNow(crowned.id), { leadId: null, lead: "Senior" });

  // a room on seniority losing its most senior: the next in line, ties
  // to whoever is listed first
  const ranked = await open(h, "Ranked", [senior, fourth, third]);
  assert.equal((await leadNow(ranked.id)).lead, "Senior");
  assert.equal((await patch(h, ranked.id, { memberIds: [fourth, third, junior] })).status, 200);
  assert.deepEqual(await leadNow(ranked.id), { leadId: null, lead: "Fourth" });

  // a crown sent with the roster is the one kept
  const handed = await open(h, "Handed", [senior, junior, third], junior);
  const res = await patch(h, handed.id, { memberIds: [senior, third], leadId: third });
  assert.equal(res.status, 200);
  assert.deepEqual(await leadNow(handed.id), { leadId: third, lead: "Third" });
});

test("an added and a removed agent are kept, and every open window is told", async (t) => {
  const h = await startHarness();
  t.after(() => h.stop());
  const ada = await hire(h, "Ada");
  const bo = await hire(h, "Bo");
  const cy = await hire(h, "Cy");
  const room = await open(h, "Team", [ada, bo]);
  const [hello] = await framesSince(h, 0, 400);
  const seq = Number(hello?._seq ?? 0);

  const added = await patch(h, room.id, { memberIds: [ada, bo, cy] });
  assert.equal(added.status, 200);
  assert.deepEqual((await added.json()).blok.memberIds, [ada, bo, cy]);
  assert.deepEqual((await listed(h, room.id)).memberIds, [ada, bo, cy]);

  const removed = await patch(h, room.id, { memberIds: [bo, cy] });
  assert.equal(removed.status, 200);
  assert.deepEqual((await listed(h, room.id)).memberIds, [bo, cy]);

  // the app's header and sidebar follow these frames (blokPatched)
  const rosters = (await framesSince(h, seq))
    .filter((f) => f.kind === "blok" && f.blok?.id === room.id)
    .map((f) => f.blok.memberIds);
  assert.deepEqual(rosters, [[ada, bo, cy], [bo, cy]]);

  // and a rename is told the same way
  const at = Number((await framesSince(h, 0, 400))[0]?._seq ?? 0);
  assert.equal((await patch(h, room.id, { name: "Renamed" })).status, 200);
  const names = (await framesSince(h, at)).filter((f) => f.kind === "blok" && f.blok?.id === room.id).map((f) => f.blok.name);
  assert.deepEqual(names, ["Renamed"]);
});
