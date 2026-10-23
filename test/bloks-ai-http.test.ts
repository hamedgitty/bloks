// Bloks AI through the real server, against a fake service that names
// the models it really ran and what they cost: every call carries the
// work it is, a shared room member's turn carries a hash for that member
// and the owner's carries none, the Settings and phone view is shares and
// names with the owner's member caps reaching the service, a hosted team
// on personal sign-ins is warned, and nothing the service ran underneath
// or what it was worth reaches a screen, a record or a log.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { memberTag } from "../server/bloks-ai.ts";
import { startHarness, type Harness } from "./helpers/server.ts";
import { messagesOf, waitFor } from "./helpers/turns.ts";
import { startFakeCredits, UPSTREAM_MODEL, type FakeCredits, type FakeMember } from "./helpers/fake-credits.ts";

const LICENCE = `blok_live_${"f".repeat(32)}`;
const ROOM = "room-team";
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

async function tokenFrom(fake: FakeCredits): Promise<string> {
  const res = await fetch(`${fake.base}/token`, { method: "POST", headers: { authorization: `Bearer ${LICENCE}` } });
  return ((await res.json()) as { token: string }).token;
}

/** A workspace with a shared room and one member in it, Aya, whose phone
 * is paired as a member's. */
function teamHome(extraConfig: Record<string, unknown> = {}) {
  const home = mkdtempSync(join(tmpdir(), "bloks-ai-"));
  const folder = join(home, ".bloks");
  mkdirSync(folder, { recursive: true });
  const aya = { id: "aya-device", name: "Aya", token: "example-aya-token", personId: "p_aya", hash: digest("example-aya-token"), pairedAt: 1 };
  writeFileSync(
    join(folder, "config.json"),
    JSON.stringify({ profile: { name: "Host" }, brief: { enabled: false }, remote: { enabled: true, devices: [], memberDevices: [aya] }, ...extraConfig }),
  );
  writeFileSync(
    join(folder, "people.json"),
    JSON.stringify({
      people: [{ id: "p_aya", name: "Aya", createdAt: 1, relayTokenHash: aya.hash }],
      memberships: [{ personId: "p_aya", roomId: ROOM, role: "collaborator", joinedAt: 1, invitedBy: "owner" }],
      invites: [],
      knocks: [],
    }),
  );
  writeFileSync(
    join(folder, "bloks.json"),
    JSON.stringify([
      {
        id: ROOM,
        name: "Team room",
        memberIds: [],
        createdAt: 1,
        sharing: { since: 1, history: "all", collaboratorsInvite: false, activityDetail: true, tools: "conversation", collaboratorsApprove: true, spendCap: 0 },
      },
    ]),
  );
  return { home, aya };
}

/** Every file under a folder, as text, for looking for a leak. */
function everything(dir: string): string {
  let all = "";
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const st = statSync(path);
    if (st.isDirectory()) all += everything(path);
    else if (st.size < 5_000_000 && !/\.gz$/.test(name)) all += readFileSync(path, "utf8");
  }
  return all;
}

async function hire(h: Harness, body: Record<string, unknown>) {
  const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify(body) });
  const ok = await h.fetch(`/api/bots/${bot.id}`, {
    method: "PATCH",
    body: JSON.stringify({ modelSelection: { instanceId: "bloks", model: "bloks-auto" } }),
  });
  assert.equal(ok.status, 200);
  return bot as { id: string; threadId: string };
}

const idle = (h: Harness, id: string) => waitFor(async () => !(await h.json("/api/bots")).bots.find((b: any) => b.id === id)?.busy);

async function setUp(t: { after: (fn: () => unknown) => void }, fakeOpts: Parameters<typeof startFakeCredits>[0] = {}, env: Record<string, string> = {}, config: Record<string, unknown> = {}) {
  const fake = await startFakeCredits(fakeOpts);
  const token = await tokenFrom(fake);
  const { home, aya } = teamHome(config);
  const h = await startHarness({ HOME: home, USERPROFILE: home, BLOKS_CREDITS_URL: fake.base, BLOKS_CREDITS_TOKEN: token, ...env });
  t.after(async () => {
    await h.stop();
    await fake.close();
    rmSync(home, { recursive: true, force: true });
  });
  await waitFor(async () => (await h.json("/api/instances")).instances.find((i: any) => i.instanceId === "bloks" && i.snapshot?.state === "available"));
  return { fake, h, home, aya, token };
}

test("each turn says what work it is: an engineer's is coding, anyone else's general, a routine's automation", async (t) => {
  const { fake, h } = await setUp(t);
  const engineer = await hire(h, { name: "Bo", title: "Backend engineer" });
  const helper = await hire(h, { name: "Cy", title: "Travel planner" });

  await h.fetch(`/api/bots/${engineer.id}/messages`, { method: "POST", body: JSON.stringify({ text: "fix the build" }) });
  assert.ok(await waitFor(() => fake.tags.length >= 1));
  await h.fetch(`/api/bots/${helper.id}/messages`, { method: "POST", body: JSON.stringify({ text: "plan a trip" }) });
  assert.ok(await waitFor(() => fake.tags.length >= 2));
  await idle(h, engineer.id);
  const { routine } = await h.json("/api/routines", {
    method: "POST",
    body: JSON.stringify({ targetId: engineer.id, targetKind: "agent", name: "Nightly", prompt: "Check the build.", time: "03:00", days: [] }),
  });
  assert.ok((await h.fetch(`/api/routines/${routine.id}/run`, { method: "POST", body: "{}" })).status < 300);
  assert.ok(await waitFor(() => fake.tags.length >= 3));

  assert.deepEqual(fake.tags.slice(0, 3), [
    { work: "coding", member: null },
    { work: "general", member: null },
    { work: "automation", member: null },
  ]);
  assert.ok(fake.completions.every((c) => c.model === "bloks-ai"), "every call asks for Bloks AI, whatever was saved");
});

test("a shared room member's turn carries their hash and never their name; the owner's carries none", async (t) => {
  const { fake, h, aya } = await setUp(t);
  const bot = await hire(h, { name: "Dee" });
  // a room holds two agents at least; with only the lead answering, Dee
  // (first of two equals) takes every turn, one per message
  const quiet = await hire(h, { name: "Eli" });
  assert.equal(
    (await h.fetch(`/api/bloks/${ROOM}`, { method: "PATCH", body: JSON.stringify({ memberIds: [bot.id, quiet.id], leadOnly: true }) })).status,
    200,
  );

  await h.fetch(`/api/bloks/${ROOM}/messages`, { method: "POST", body: JSON.stringify({ text: "owner here, what is next?" }) });
  assert.ok(await waitFor(() => fake.tags.length >= 1, 20_000), "the owner's turn reached the service");
  await idle(h, bot.id);

  const posted = await h.fetchRemote(`/api/member/rooms/${ROOM}/messages`, { method: "POST", token: aya.token, body: JSON.stringify({ text: "Aya here, any news?" }) });
  assert.ok(posted.status < 300, JSON.stringify(posted.body));
  assert.ok(await waitFor(() => fake.tags.length >= 2, 20_000), "the member's turn reached the service");

  assert.equal(fake.tags[0].member, null, "the owner's own turn names nobody");
  assert.equal(fake.tags[1].member, memberTag("p_aya"));
  assert.ok(!/aya/i.test(String(fake.tags[1].member)), "a hash, not a name");
  assert.ok(fake.tags.every((tag) => tag.work === "general"));
});

test("Settings and the phone read shares and names, the owner caps a member, and nothing is an amount or a model", async (t) => {
  const members: FakeMember[] = [{ member: memberTag("p_aya"), usedPercent: 12, dailyCapPercent: null }];
  const { fake, h, home } = await setUp(t, { team: true, members });
  const bot = await hire(h, { name: "Eve" });
  await h.fetch(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: "hello" }) });
  assert.ok(await waitFor(async () => (await messagesOf(h, bot)).find((m) => m.role === "bot" && /bloks ai says/.test(m.text ?? ""))));
  await idle(h, bot.id);

  const status = await h.json("/api/credits?fresh=1");
  assert.equal(status.leftPercent, 62);
  assert.equal(status.monthlyLeftPercent, 62);
  assert.equal(status.topUps, 1);
  assert.equal(status.renewsAt, Date.parse("2026-11-19T00:00:00Z"));
  assert.equal(status.team, true);
  assert.deepEqual(status.members, [{ member: memberTag("p_aya"), usedPercent: 12, dailyCapPercent: null, name: "Aya" }]);
  for (const gone of ["balance", "currency", "lowAt", "autoReload"]) assert.ok(!(gone in status), gone);
  assert.equal((await h.json("/api/config")).credits.team, true, "the composer and the engine choice can read it");

  // a cap is a share, keyed by the member's tag; anything else is refused
  const bad = await h.fetch("/api/credits", { method: "PATCH", body: JSON.stringify({ memberCaps: { [memberTag("p_aya")]: 150 } }) });
  assert.equal(bad.status, 400);
  const byName = await h.fetch("/api/credits", { method: "PATCH", body: JSON.stringify({ memberCaps: { Aya: 10 } }) });
  assert.equal(byName.status, 400);
  const capped = await h.json("/api/credits", { method: "PATCH", body: JSON.stringify({ memberCaps: { [memberTag("p_aya")]: 10 } }) });
  assert.deepEqual(fake.settings, [{ memberCaps: { [memberTag("p_aya")]: 10 } }]);
  assert.equal(capped.members[0].dailyCapPercent, 10);
  await h.json("/api/credits", { method: "PATCH", body: JSON.stringify({ memberCaps: { [memberTag("p_aya")]: null } }) });
  assert.deepEqual(fake.settings[1], { memberCaps: { [memberTag("p_aya")]: null } }, "null takes a cap off");

  // nowhere does an amount, a price or what ran underneath show
  const views = [
    JSON.stringify(status),
    JSON.stringify(await h.json("/api/usage?days=7")),
    JSON.stringify(await h.json("/api/engines/report")),
    JSON.stringify(await h.json("/api/activity")),
    JSON.stringify(await h.json("/api/instances")),
    JSON.stringify(await h.json("/api/bots")),
    await (await h.fetch("/api/diagnostics")).text(),
  ];
  for (const view of views) {
    assert.ok(!view.includes(UPSTREAM_MODEL), "no upstream model");
    assert.ok(!view.includes("41.17") && !view.includes("0.0123"), "no amount");
  }
  assert.ok(!views[0].includes("$"), "the balance view is shares");
  const usage = await h.json("/api/usage?days=7");
  const rows = JSON.stringify(usage);
  assert.ok(rows.includes("bloks"), "Bloks AI is counted under its own name");
  assert.ok(!everything(join(home, ".bloks")).includes(UPSTREAM_MODEL), "not in any log or record on disk");
  assert.ok(!h.logs().includes(UPSTREAM_MODEL));
  // the agent saved on the old alias shows the one model there is
  const agent = (await h.json("/api/bots")).bots.find((b: any) => b.id === bot.id);
  assert.deepEqual(agent.modelSelection, { instanceId: "bloks", model: "bloks-ai" });
});

test("a hosted team with an agent on a personal sign-in is warned, and nothing is blocked", async (t) => {
  const { h } = await setUp(
    t,
    { team: true },
    { BLOKS_HOSTED: "1" },
    { instances: { claude: { driver: "claudeAgent", config: { cli: "/nonexistent/claude" } } } },
  );
  const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Fay" }) });
  const moved = await h.fetch(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } }) });
  assert.equal(moved.status, 200, "choosing a personal sign-in is still allowed");
  const status = await h.json("/api/credits?fresh=1");
  assert.equal(status.team, true);
  assert.equal(status.teamSignInWarning, "A personal Claude or ChatGPT sign-in is for one person. For a team, use an API key or Bloks AI.");

  // on Bloks AI's own engine instead, there is nothing to say
  await h.fetch(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "bloks", model: "bloks-ai" } }) });
  assert.equal((await h.json("/api/credits")).teamSignInWarning, null);
});

test("a workspace that is not a team, or not hosted, says nothing about sign-ins", async (t) => {
  const { h } = await setUp(t, { team: false }, { BLOKS_HOSTED: "1" }, { instances: { claude: { driver: "claudeAgent", config: { cli: "/nonexistent/claude" } } } });
  const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Gus" }) });
  await h.fetch(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } }) });
  const status = await h.json("/api/credits?fresh=1");
  assert.equal(status.team, false);
  assert.equal(status.members, null);
  assert.equal(status.teamSignInWarning, null);
});
