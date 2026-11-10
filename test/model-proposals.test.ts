// Other agents' models, changed on the owner's Apply (GitHub 497).
//
// An agent's credential still cannot write another agent's model. What it
// can do is put a list in front of the owner: each agent, the engine and
// model it is on and the one proposed, on one card. Held here: a proposal
// is read against the agents and engines there are, and an unknown one is
// refused with its reason and no card; nothing changes until Apply; Apply
// changes every agent on the card or none, and none when one of them has
// moved since the card was made; Keep changes nothing; and the agent that
// proposed it cannot press Apply for the owner.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { allows, NEVER } from "../server/agent-cli.ts";
import { blockers, MAX_TARGETS, readModelProposal, type ModelWorld } from "../server/model-proposals.ts";
import { controlledChain, type ChainTurn } from "./helpers/agent-chain.ts";
import { waitFor } from "./helpers/turns.ts";

const CLI = fileURLToPath(new URL("../bin/bloks.mjs", import.meta.url));

async function bloks(url: string, turn: ChainTurn, home: string, args: string[]) {
  const child = spawn(process.execPath, [CLI, ...args], { env: { HOME: home, BLOKS_URL: url, BLOKS_TOKEN: turn.token } });
  let out = "";
  child.stdout.on("data", (c) => (out += c));
  const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
  const exit = await new Promise<number | null>((resolve) => child.once("close", resolve));
  clearTimeout(timer);
  return { exit, body: out.trim() ? JSON.parse(out) : null };
}

const WORLD: ModelWorld = {
  agents: [
    { id: "a1", name: "Ada", selection: { instanceId: "claude", model: "claude-sonnet-5" } },
    { id: "b1", name: "Ben", selection: { instanceId: "claude", model: "" } },
    { id: "c1", name: "Cy", selection: { instanceId: "off", model: "m-1" } },
    { id: "d1", name: "Dup", selection: null },
    { id: "d2", name: "dup", selection: null },
  ],
  engines: [
    { id: "claude", name: "Claude Code", enabled: true, default: "claude-sonnet-5", options: [{ id: "claude-opus-5", label: "Claude Opus 5" }, { id: "claude-sonnet-5", label: "Claude Sonnet 5" }] },
    { id: "codex", name: "Codex", enabled: true, default: "gpt-5", options: [{ id: "gpt-5", label: "GPT-5" }] },
    { id: "off", name: "Switched Off", enabled: false, default: "m-1", options: [{ id: "m-1" }, { id: "m-2" }] },
  ],
};

describe("reading a proposal", () => {
  test("each change is an agent, an engine and a model that are there, said the way the card says them", () => {
    const read = readModelProposal({ changes: [{ agent: "ada", engine: "Codex", model: "GPT-5" }, { agent: "b1", engine: "claude", model: "claude-opus-5" }] }, WORLD);
    assert.ok(read.ok, JSON.stringify(read));
    assert.deepEqual(read.targets[0], {
      botId: "a1",
      name: "Ada",
      from: { instanceId: "claude", model: "claude-sonnet-5", engine: "Claude Code", label: "Claude Sonnet 5" },
      to: { instanceId: "codex", model: "gpt-5", engine: "Codex", label: "GPT-5" },
    });
    // a saved model of "" is the engine's default, and the card says which
    assert.equal(read.targets[1]!.from.label, "Claude Sonnet 5");
    assert.equal(read.targets[1]!.from.model, "");
  });

  test("an unknown model, engine or agent is refused with its reason, every one at once", () => {
    const read = readModelProposal({
      changes: [
        { agent: "Ada", engine: "claude", model: "claude-imaginary-9" },
        { agent: "Nobody", engine: "claude", model: "claude-opus-5" },
        { agent: "Ben", engine: "gemini", model: "x" },
      ],
    }, WORLD);
    assert.ok(!read.ok);
    assert.equal(read.errors.length, 3);
    assert.match(read.errors[0]!, /Ada: Claude Code has no model "claude-imaginary-9"\. It offers: claude-sonnet-5, claude-opus-5/);
    assert.match(read.errors[1]!, /there is no agent "Nobody" here/);
    assert.match(read.errors[2]!, /Ben: there is no engine "gemini" here\. The engines are: claude \(Claude Code\), codex \(Codex\), off \(Switched Off\)/);
  });

  test("nothing to change, the same agent twice, a name two agents share and an engine switched off are refused", () => {
    const same = readModelProposal({ changes: [{ agent: "Ada", engine: "claude", model: "claude-sonnet-5" }] }, WORLD);
    assert.ok(!same.ok && /Ada is on Claude Code, Claude Sonnet 5 already/.test(same.errors[0]!));
    const twice = readModelProposal({ changes: [{ agent: "Ada", engine: "codex", model: "gpt-5" }, { agent: "a1", engine: "claude", model: "claude-opus-5" }] }, WORLD);
    assert.ok(!twice.ok && /Ada is named twice/.test(twice.errors[0]!));
    const shared = readModelProposal({ changes: [{ agent: "dup", engine: "codex", model: "gpt-5" }] }, WORLD);
    assert.ok(!shared.ok && /more than one agent is called "dup"/.test(shared.errors[0]!));
    const off = readModelProposal({ changes: [{ agent: "Ada", engine: "off", model: "m-1" }] }, WORLD);
    assert.ok(!off.ok && /Switched Off is switched off/.test(off.errors[0]!));
    // an agent on an engine switched off may still change model on it
    assert.ok(readModelProposal({ changes: [{ agent: "Cy", engine: "off", model: "m-2" }] }, WORLD).ok);
    assert.ok(!readModelProposal({ changes: [] }, WORLD).ok);
    const many = Array.from({ length: MAX_TARGETS + 1 }, () => ({ agent: "Ada", engine: "codex", model: "gpt-5" }));
    assert.ok(!readModelProposal({ changes: many }, WORLD).ok);
  });

  test("a card is out of date once any agent on it has moved, and then applies to nobody", () => {
    const read = readModelProposal({ changes: [{ agent: "Ada", engine: "codex", model: "gpt-5" }, { agent: "Ben", engine: "claude", model: "claude-opus-5" }] }, WORLD);
    assert.ok(read.ok);
    assert.deepEqual(blockers(read, WORLD), []);
    const moved: ModelWorld = { ...WORLD, agents: WORLD.agents.map((a) => (a.id === "b1" ? { ...a, selection: { instanceId: "claude", model: "claude-opus-5" } } : a)) };
    assert.deepEqual(blockers(read, moved), ["Ben is on Claude Code, Claude Opus 5 now, not Claude Code, Claude Sonnet 5 as the card says"]);
    const gone: ModelWorld = { ...WORLD, agents: WORLD.agents.filter((a) => a.id !== "a1") };
    assert.deepEqual(blockers(read, gone), ["Ada is no longer here"]);
  });
});

describe("who may do what", () => {
  test("proposing and waiting are an agent's; Apply is never on its credential", () => {
    assert.equal(allows("bot-1", "GET", "/api/agent/models").ok, true);
    assert.equal(allows("bot-1", "POST", "/api/agent/models/proposals").ok, true);
    assert.equal(allows("bot-1", "GET", "/api/agent/models/proposals/abc-123").ok, true);
    assert.ok(NEVER.includes("/api/model-proposals"));
    assert.equal(allows("bot-1", "POST", "/api/model-proposals/lane-1/msg-1/apply").ok, false);
    assert.equal(allows("bot-1", "POST", "/api/model-proposals/lane-1/msg-1/keep").ok, false);
  });
});

describe("over the wire", () => {
  test("an agent proposes models for named agents; the owner applies them all, keeps them, or finds the card out of date", async (t) => {
    const f = await controlledChain(t, {}, { BLOKS_SETTINGS_WAIT_MS: "400" });
    // a second engine, and one switched off, beside the controlled one
    await f.restart(() => {
      const file = join(f.home, ".bloks/config.json");
      const config = JSON.parse(readFileSync(file, "utf8"));
      const cli = config.instances.claude.config.cli;
      config.instances.work = { driver: "claudeAgent", displayName: "Claude Work", config: { cli } };
      config.instances.spare = { driver: "claudeAgent", displayName: "Claude Spare", enabled: false, config: { cli } };
      writeFileSync(file, JSON.stringify(config));
    });
    const ada = await f.hire("Ada");
    const ben = await f.hire("Ben");
    const cy = await f.hire("Cy");
    // set by the owner, and not the card's to touch
    const effort = await f.h.fetch(`/api/bots/${ben.id}`, { method: "PATCH", body: JSON.stringify({ effort: "high" }) });
    assert.equal(effort.status, 200, await effort.clone().text());
    const selection = async (bot: { id: string }) => {
      const { bots } = await f.h.json("/api/bots?messages=0");
      const found = bots.find((b: any) => b.id === bot.id);
      return { ...found.modelSelection, effort: found.effort };
    };
    const turn = await f.begin(ada);

    // still: an agent cannot write another agent's model itself
    const direct = await f.agent(turn, `/api/bots/${ben.id}`, { modelSelection: { instanceId: "claude", model: "claude-opus-5" } }, "PATCH");
    assert.equal(direct.status, 403);

    const listed = await bloks(f.h.url, turn, f.home, ["models"]);
    assert.equal(listed.exit, 0, JSON.stringify(listed.body));
    const on = (id: string) => listed.body.engines.find((e: any) => e.id === id)?.on;
    assert.deepEqual([on("claude"), on("work"), on("spare")], [true, true, false]);
    assert.ok(listed.body.engines.find((e: any) => e.id === "work").models.some((m: any) => m.id === "claude-haiku-4-5"));
    assert.equal(listed.body.agents.find((a: any) => a.id === ben.id)?.model, "claude-sonnet-5");

    // an unknown model and an agent that is not there: refused, no card
    const unknown = await bloks(f.h.url, turn, f.home, ["models", "propose", "Ben", "claude", "claude-imaginary-9"]);
    assert.equal(unknown.exit, 1);
    assert.match(unknown.body.error, /Nothing was proposed: Ben: Claude has no model "claude-imaginary-9"\. It offers: /);
    const nobody = await bloks(f.h.url, turn, f.home, ["models", "propose", "Nobody", "claude", "claude-opus-5"]);
    assert.equal(nobody.exit, 1);
    assert.match(nobody.body.error, /there is no agent "Nobody" here/);
    const off = await bloks(f.h.url, turn, f.home, ["models", "propose", "Ben", "spare", "claude-opus-5"]);
    assert.equal(off.exit, 1);
    assert.match(off.body.error, /Claude Spare is switched off/);
    const odd = await bloks(f.h.url, turn, f.home, ["models", "propose", "Ben", "claude"]);
    assert.equal(odd.exit, 1);
    assert.match(odd.body.error, /three words/);
    assert.equal((await f.messages(ada)).filter((m) => m.card?.modelProposal).length, 0, "a refusal puts no card up");

    // proposed: a card, and nothing changes yet
    const proposed = await bloks(f.h.url, turn, f.home, [
      "models", "propose", "Ben", "claude", "Claude Opus 5", cy.id, "Claude Work", "claude-haiku-4-5", "--why", "Restoring the 3 Nov snapshot.",
    ]);
    assert.equal(proposed.exit, 0, JSON.stringify(proposed.body));
    assert.equal(proposed.body.pending, true);
    const id = proposed.body.proposal as string;
    assert.equal((await selection(ben)).model, "claude-sonnet-5");
    assert.equal((await selection(cy)).instanceId, "claude");
    const card = (await f.messages(ada)).find((m) => m.card?.modelProposal?.id === id);
    assert.ok(card, "the card is in the conversation");
    const plan = card.card.modelProposal;
    assert.deepEqual(plan.targets.map((x: any) => [x.name, `${x.from.engine}, ${x.from.label}`, `${x.to.engine}, ${x.to.label}`]), [
      ["Ben", "Claude, Claude Sonnet 5", "Claude, Claude Opus 5"],
      ["Cy", "Claude, Claude Sonnet 5", "Claude Work, Claude Haiku 4.5"],
    ]);
    assert.equal(plan.why, "Restoring the 3 Nov snapshot.");
    const again = await bloks(f.h.url, turn, f.home, ["models", "propose", "Ben", "claude", "opus"]);
    assert.equal(again.exit, 1);
    assert.match(again.body.error, /waiting on the person/);

    // the agent cannot press Apply for the owner
    const pressed = await f.agent(turn, `/api/model-proposals/${plan.laneId}/${card.id}/apply`, {});
    assert.equal(pressed.status, 403);
    assert.equal((await selection(ben)).model, "claude-sonnet-5");

    // the owner can: every change at once, read back, recorded as theirs
    const waiting = bloks(f.h.url, turn, f.home, ["models", "proposal", id]);
    const apply = await f.h.fetch(`/api/model-proposals/${plan.laneId}/${card.id}/apply`, { method: "POST", body: "{}" });
    assert.equal(apply.status, 200, await apply.clone().text());
    assert.deepEqual(await selection(ben), { instanceId: "claude", model: "claude-opus-5", effort: "high" });
    assert.equal((await selection(cy)).instanceId, "work");
    assert.equal((await selection(cy)).model, "claude-haiku-4-5");
    const heard = await waiting;
    assert.equal(heard.exit, 0, JSON.stringify(heard.body));
    assert.equal(heard.body.ok, true);
    assert.deepEqual(heard.body.changed.map((c: any) => [c.agent, c.result]), [["Ben", "changed"], ["Cy", "changed"]]);
    const ledger = await waitFor(async () => {
      const entries = (await f.h.json("/api/ledger")).entries.filter((e: any) => e.kind === "settings.changed" && /as Ada proposed/.test(e.summary));
      return entries.length === 2 ? entries : null;
    });
    assert.ok(ledger.every((e: any) => e.actor === "you"));
    const twice = await f.h.fetch(`/api/model-proposals/${plan.laneId}/${card.id}/apply`, { method: "POST", body: "{}" });
    assert.equal(twice.status, 409, "answered once only");

    // kept: nothing changes, and the agent hears it at its next turn, once
    const second = await bloks(f.h.url, turn, f.home, ["models", "propose", "Ben", "claude", "claude-sonnet-5"]);
    assert.equal(second.body.pending, true, JSON.stringify(second.body));
    const kept = (await f.messages(ada)).find((m) => m.card?.modelProposal?.id === second.body.proposal);
    const keep = await f.h.fetch(`/api/model-proposals/${kept.card.modelProposal.laneId}/${kept.id}/keep`, { method: "POST", body: "{}" });
    assert.equal(keep.status, 200);
    assert.equal((await selection(ben)).model, "claude-opus-5");

    // out of date: Ben moved after the card was made, so Cy does not move either
    const third = await bloks(f.h.url, turn, f.home, ["models", "propose", "Ben", "claude", "claude-sonnet-5", "Cy", "claude", "claude-sonnet-5"]);
    assert.equal(third.body.pending, true, JSON.stringify(third.body));
    const stale = (await f.messages(ada)).find((m) => m.card?.modelProposal?.id === third.body.proposal);
    const moved = await f.h.fetch(`/api/bots/${ben.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "claude", model: "claude-haiku-4-5" } }) });
    assert.equal(moved.status, 200);
    const late = await f.h.fetch(`/api/model-proposals/${stale.card.modelProposal.laneId}/${stale.id}/apply`, { method: "POST", body: "{}" });
    assert.equal(late.status, 409);
    assert.match((await late.json()).error, /Nothing changed: Ben is on Claude, Claude Haiku 4\.5 now, not Claude, Claude Opus 5 as the card says/);
    assert.equal((await selection(ben)).model, "claude-haiku-4-5");
    assert.equal((await selection(cy)).instanceId, "work", "none of the card applied");
    const failed = (await f.messages(ada)).find((m) => m.id === stale.id);
    assert.equal(failed.card.modelProposal.outcome, "failed");

    await f.finish(turn, ada);
    const next = await f.begin(ada, "Carry on");
    assert.match(next.text, /the person kept the models you proposed changing as they are/);
    assert.match(next.text, /the person pressed Apply on the model changes you proposed, but nothing changed \(Ben is on Claude, Claude Haiku 4\.5 now/);
    assert.doesNotMatch(next.text, /applied the model changes you proposed/, "the change it already heard is not told twice");
  });
});
