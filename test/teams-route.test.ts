// GitHub 525: teams from the Agents page, in the request path. A team is
// a room. New team makes one with its lead and members, and may put the
// members under the lead in the reporting lines; an agent moves between
// teams, and a team gets a new lead. The reporting lines follow only
// where they matched the team, a team is never left with one agent, and
// every change is said in the rooms it touched.
import { test } from "node:test";
import assert from "node:assert/strict";

import { startHarness } from "./helpers/server.ts";

test("the owner makes teams, moves agents between them and changes their leads", async (t) => {
  const h = await startHarness();
  t.after(() => h.stop());

  const make = async (name: string) => {
    const made = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name }) });
    assert.ok(made.bot?.id, JSON.stringify(made));
    return made.bot.id as string;
  };
  const post = async (path: string, body: unknown) => {
    const res = await h.fetch(path, { method: "POST", body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const leadOf = async (id: string) => (await h.json("/api/registry")).agents.find((a: any) => a.id === id)?.lead ?? null;
  const room = async (id: string) => (await h.json("/api/bloks?messages=0")).bloks.find((b: any) => b.id === id);
  const notices = async (id: string) => ((await h.json(`/api/bloks/${id}/messages`)).messages ?? []).filter((m: any) => m.kind === "notice").map((m: any) => m.text);

  const marlow = await make("Marlow");
  const ada = await make("Ada");
  const atlas = await make("Atlas");
  const juno = await make("Juno");
  const quill = await make("Quill");

  // what a team must be, refused before anything is made
  assert.equal((await post("/api/registry/teams", { name: "Lonely", memberIds: [marlow] })).status, 400);
  assert.equal((await post("/api/registry/teams", { name: "", memberIds: [marlow, ada] })).status, 400);
  assert.equal((await post("/api/registry/teams", { name: "Odd", memberIds: [marlow, ada], answers: "loudest" })).status, 400);
  assert.equal((await post("/api/registry/teams", { name: "Crowned", memberIds: [marlow, ada], leadId: juno })).status, 400);
  assert.equal((await h.json("/api/bloks?messages=0")).bloks.length, 0, "a refused team left a room behind");

  // a team with its lead, answering through it, its members under it
  const core = await post("/api/registry/teams", { name: "Core", memberIds: [marlow, ada, atlas], leadId: marlow, answers: "lead", reportToLead: true });
  assert.equal(core.status, 201, JSON.stringify(core.body));
  const coreId = core.body.blok.id;
  assert.equal(core.body.blok.leadId, marlow);
  assert.equal(core.body.blok.answers, "lead");
  assert.equal(await leadOf(ada), marlow);
  assert.equal(await leadOf(atlas), marlow);
  assert.deepEqual(core.body.org.teams.find((team: any) => team.id === coreId).members.sort(), [marlow, ada, atlas].sort());

  // one without the reporting lines: the room has a lead, the chart is untouched
  const growth = await post("/api/registry/teams", { name: "Growth", memberIds: [juno, quill], leadId: juno });
  assert.equal(growth.status, 201, JSON.stringify(growth.body));
  const growthId = growth.body.blok.id;
  assert.equal(await leadOf(quill), null);

  // a team whose lead is under one of its members cannot be drawn
  const loop = await post("/api/registry/teams", { name: "Upside down", memberIds: [ada, marlow], leadId: ada, reportToLead: true });
  assert.equal(loop.status, 400);
  assert.match(loop.body.error, /already under/);

  // Atlas reported to Core's lead, so moving to Growth puts it under Juno
  const moved = await post(`/api/registry/agents/${atlas}/team`, { from: coreId, to: growthId });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.equal(moved.body.followed, true);
  assert.equal(await leadOf(atlas), juno);
  assert.equal((await room(coreId)).memberIds.includes(atlas), false);
  assert.equal((await room(growthId)).memberIds.includes(atlas), true);
  assert.ok((await notices(coreId)).some((text: string) => text.includes("moved Atlas to Growth")));
  assert.ok((await notices(growthId)).some((text: string) => text.includes("moved Atlas here from Core")));

  // Quill had no line to carry: out of Growth, its chart stays as it was
  const out = await post(`/api/registry/agents/${quill}/team`, { from: growthId, to: null });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.equal(out.body.followed, false);
  assert.equal(await leadOf(quill), null);

  // never a team of one, never the same team twice, never a stranger's seat
  const shrink = await post(`/api/registry/agents/${marlow}/team`, { from: coreId, to: growthId });
  assert.equal(shrink.status, 400);
  assert.match(shrink.body.error, /left with one agent/);
  assert.equal((await post(`/api/registry/agents/${juno}/team`, { from: growthId, to: growthId })).status, 400);
  assert.equal((await post(`/api/registry/agents/${quill}/team`, { from: coreId, to: growthId })).status, 400);
  assert.equal((await post(`/api/registry/agents/${quill}/team`, { from: null, to: null })).status, 400);
  assert.equal((await post(`/api/registry/agents/${quill}/team`, { to: "no-such-room" })).status, 404);

  // a new lead for Core: Ada takes Marlow's place, and Marlow reports to her
  const crowned = await post(`/api/registry/teams/${coreId}/lead`, { agentId: ada });
  assert.equal(crowned.status, 200, JSON.stringify(crowned.body));
  assert.equal(crowned.body.followed, true);
  assert.equal((await room(coreId)).leadId, ada);
  assert.equal(await leadOf(marlow), ada);
  assert.equal(await leadOf(ada), null);
  assert.ok((await notices(coreId)).some((text: string) => text.includes("made Ada the lead")));

  // Atlas has reported to Juno since its move, so Growth's lines follow too
  const growthLead = await post(`/api/registry/teams/${growthId}/lead`, { agentId: atlas });
  assert.equal(growthLead.status, 200, JSON.stringify(growthLead.body));
  assert.equal(growthLead.body.followed, true);
  assert.equal((await room(growthId)).leadId, atlas);
  assert.equal(await leadOf(atlas), null);
  assert.equal(await leadOf(juno), atlas);
  assert.equal((await post(`/api/registry/teams/${growthId}/lead`, { agentId: quill })).status, 400, "Quill is not in Growth any more");

  // a team the chart never mirrored: only the crown moves
  const ops = await post("/api/registry/teams", { name: "Ops", memberIds: [quill, marlow], leadId: marlow });
  assert.equal(ops.status, 201, JSON.stringify(ops.body));
  const opsLead = await post(`/api/registry/teams/${ops.body.blok.id}/lead`, { agentId: quill });
  assert.equal(opsLead.status, 200, JSON.stringify(opsLead.body));
  assert.equal(opsLead.body.followed, false);
  assert.equal(await leadOf(quill), null);
  assert.equal(await leadOf(marlow), ada);
});
