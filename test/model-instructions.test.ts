// Agents' models changed by one instruction of the owner's in chat
// (GitHub 544).
//
// The agent names the owner's message; the server reads it. Held here:
// only the owner's own words count, from the owner's own surfaces, in the
// agent's own conversation, recent, newest, unedited, once; the words are
// read by rules that never carry out a question, a negation, a condition,
// a quote or reported speech, and never widen an exception to everyone;
// only the primary model changes, on the engine each agent is on, both
// models ones that engine takes; "the new version" is only what Bloks'
// catalog says; a change set that no longer matches writes nothing; and
// the answer is what was saved, read back. Proposals stay as they were.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { allows, NEVER } from "../server/agent-cli.ts";
import { catalogFromModelList } from "../server/drivers/codex.ts";
import {
  INSTRUCTION_MAX_AGE_MS,
  instructionMessage,
  MAX_INSTRUCTION_CHARS,
  modelNamed,
  newestOf,
  notOwners,
  parseInstruction,
  planInstruction,
  type Instruction,
} from "../server/model-instructions.ts";
import { blockers, type EngineView, type ModelWorld } from "../server/model-proposals.ts";
import type { Message } from "../server/store.ts";
import { controlledChain, type ChainTurn } from "./helpers/agent-chain.ts";
import { startHarness } from "./helpers/server.ts";
import { agentOn, idle, waitFor } from "./helpers/turns.ts";

const CLI = fileURLToPath(new URL("../bin/bloks.mjs", import.meta.url));

async function bloks(url: string, turn: ChainTurn, home: string, args: string[]) {
  const child = spawn(process.execPath, [CLI, ...args], { env: { HOME: home, BLOKS_URL: url, BLOKS_TOKEN: turn.token } });
  let out = "";
  let err = "";
  child.stdout.on("data", (c) => (out += c));
  child.stderr.on("data", (c) => (err += c));
  const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
  const exit = await new Promise<number | null>((resolve) => child.once("close", resolve));
  clearTimeout(timer);
  return { exit, body: out.trim() ? JSON.parse(out) : null, err };
}

const CLAUDE: EngineView = {
  id: "claude",
  name: "Claude Code",
  enabled: true,
  default: "claude-sonnet-5",
  acceptsAnyId: true,
  options: [
    { id: "claude-fable-5-2", label: "Claude Fable 5.2" },
    { id: "claude-fable-5-1", label: "Claude Fable 5.1", successor: "claude-fable-5-2" },
    { id: "claude-opus-5-5", label: "Claude Opus 5.5" },
    { id: "claude-fable-5", label: "Claude Fable 5", successor: "claude-fable-5-1" },
    { id: "claude-opus-5", label: "Claude Opus 5", successor: "claude-opus-5-5" },
    { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
    { id: "opus", label: "Latest Opus" },
  ],
};
const CODEX: EngineView = { id: "codex", name: "Codex", enabled: true, default: "gpt-5", options: [{ id: "gpt-5", label: "GPT-5", successor: "gpt-5.1" }, { id: "gpt-5.1", label: "GPT-5.1" }] };
const LOCAL: EngineView = { id: "local", name: "Local", enabled: true, default: "m-1", options: [{ id: "m-1" }, { id: "m-2" }] };

const WORLD: ModelWorld = {
  agents: [
    { id: "a1", name: "Ada", selection: { instanceId: "claude", model: "claude-opus-5" } },
    { id: "b1", name: "Ben", selection: { instanceId: "claude", model: "claude-opus-5" } },
    { id: "c1", name: "Cy", selection: { instanceId: "codex", model: "gpt-5" } },
    { id: "d1", name: "Dee", selection: { instanceId: "claude", model: "" } },
    { id: "u1", name: "Ада", selection: { instanceId: "claude", model: "claude-fable-5" } },
    { id: "l1", name: "Lo", selection: { instanceId: "local", model: "m-1" } },
    { id: "n1", name: "Nil", selection: null },
  ],
  engines: [CLAUDE, CODEX, LOCAL],
};

const read = (text: string): Instruction => {
  const parsed = parseInstruction(text);
  assert.ok(parsed.ok, `${text}: ${JSON.stringify(parsed)}`);
  return parsed.instruction;
};
const refused = (text: string, reason: RegExp) => {
  const parsed = parseInstruction(text);
  assert.ok(!parsed.ok, `${text} was read as ${JSON.stringify(parsed)}`);
  assert.match(parsed.reason, reason, text);
};
const plan = (text: string) => planInstruction(read(text), WORLD);
const moves = (text: string) => {
  const p = plan(text);
  assert.ok(p.ok, `${text}: ${JSON.stringify(p)}`);
  return p.changes.map((c) => `${c.name}: ${c.from.label} -> ${c.to.label}`);
};

describe("reading the owner's words", () => {
  test("a plain instruction, in English, typed or dictated", () => {
    assert.deepEqual(read("Switch all agents from Opus 5 to Opus 5.5"), { kind: "change", scope: { kind: "all", except: [] }, from: "opus 5", to: "opus 5.5" });
    assert.deepEqual(read("change every primary on example-v1 to example-v2"), { kind: "change", scope: { kind: "all", except: [] }, from: "example-v1", to: "example-v2" });
    assert.deepEqual(read("switch all opus 5 agents to opus 5.5"), { kind: "change", scope: { kind: "all", except: [] }, from: "opus 5", to: "opus 5.5" });
    assert.deepEqual(read("Switch Ada and Ben to claude-opus-5-5"), { kind: "change", scope: { kind: "named", names: ["ada", "ben"] }, to: "claude-opus-5-5" });
    assert.deepEqual(read("switch to opus 5.5 for all agents"), { kind: "change", scope: { kind: "all", except: [] }, to: "opus 5.5" });
    assert.deepEqual(read("Update all models to the new version"), { kind: "upgrade", scope: { kind: "all", except: [] } });
    assert.deepEqual(read("upgrade everyone to the latest"), { kind: "upgrade", scope: { kind: "all", except: [] } });
    assert.deepEqual(read("upgrade all agents"), { kind: "upgrade", scope: { kind: "all", except: [] } });
    // the courtesy around it, and asking to be told, change nothing
    assert.deepEqual(
      read("Hey Ada. OK so please switch all my agents' models from sonnet 5 to opus 5.5 and tell me what changed. Thanks!"),
      { kind: "change", scope: { kind: "all", except: [] }, from: "sonnet 5", to: "opus 5.5" },
    );
    // a quoted model name is only a name
    assert.deepEqual(read("switch all agents from “opus 5” to `opus 5.5`"), { kind: "change", scope: { kind: "all", except: [] }, from: "opus 5", to: "opus 5.5" });
  });

  test("and in Ukrainian", () => {
    assert.deepEqual(read("Онови всі моделі до нової версії"), { kind: "upgrade", scope: { kind: "all", except: [] } });
    assert.deepEqual(read("Переведи всіх агентів з opus 5 на opus 5.5"), { kind: "change", scope: { kind: "all", except: [] }, from: "opus 5", to: "opus 5.5" });
    assert.deepEqual(read("Я хочу, щоб ти змінив моделі всім агентам на opus 5.5"), { kind: "change", scope: { kind: "all", except: [] }, to: "opus 5.5" });
    assert.deepEqual(read("Переключи Аду та Бена на opus 5.5"), { kind: "change", scope: { kind: "named", names: ["аду", "бена"] }, to: "opus 5.5" });
    assert.deepEqual(
      read("Будь ласка, зміни моделі всіх агентів, крім Ади, з opus 5 на opus 5.5"),
      { kind: "change", scope: { kind: "all", except: ["ади"] }, from: "opus 5", to: "opus 5.5" },
    );
  });

  test("an exception stays an exception wherever it is said", () => {
    assert.deepEqual(read("move everyone but Ada and Ben from opus 5 to opus 5.5").scope, { kind: "all", except: ["ada", "ben"] });
    assert.deepEqual(read("switch all agents to opus 5.5 except ada").scope, { kind: "all", except: ["ada"] });
    assert.deepEqual(read("switch everyone except for Ben, Cy and Dee to opus 5.5").scope, { kind: "all", except: ["ben", "cy", "dee"] });
    // an exception that names nobody, or one to a list of names, is not read at all
    refused("switch all except to opus 5.5", /does not say plainly/);
    refused("switch Ada except Ben to opus 5.5", /does not say plainly/);
    refused("switch all agents except all of them to opus 5.5", /does not say plainly/);
  });

  test("a question, a negation, a condition, a quote or reported speech is never an instruction", () => {
    refused("Can you switch all agents to opus 5.5?", /question/);
    refused("can you switch all agents to opus 5.5", /question/);
    refused("should we upgrade all agents", /question/);
    refused("I wonder whether to switch all agents to opus 5.5", /question/);
    refused("Можеш оновити всі моделі до нової версії?", /question/);
    refused("Чи варто перевести всіх агентів на opus 5.5", /question/);
    refused("don't switch all agents to opus 5.5", /not to/);
    refused("Do not upgrade all agents", /not to|question/);
    refused("never switch everyone to opus 5.5", /not to/);
    refused("Не змінюй моделі всіх агентів на opus 5.5", /not to/);
    refused("If it is cheaper, switch all agents to opus 5.5", /depends/);
    refused("switch all agents to opus 5.5 once the bill is in", /depends/);
    refused("Якщо можна, онови всі моделі до останньої версії", /depends/);
    refused("Ben said switch all agents to opus 5.5", /reports/);
    refused("Бен сказав перевести всіх агентів на opus 5.5", /reports/);
    refused("\"switch all agents to opus 5.5\"", /quoted/);
    refused("He wrote “switch all agents to opus 5.5”", /quoted|reports/);
    refused("«переведи всіх агентів на opus 5.5»", /quoted/);
    refused("'upgrade all agents'", /quoted/);
    refused("switch all agents to \"opus 5.5", /quoted/);
  });

  test("anything that is not plainly one instruction is not carried out", () => {
    refused("switch the model to opus 5.5", /does not say plainly/);
    refused("switch to opus 5.5", /does not say plainly/);
    refused("update all models", /does not say plainly/);
    refused("switch all agents to opus 5.5. Upgrade Ben.", /more than one/);
    refused("switch all agents to opus 5.5. Also Ben.", /does not say plainly/);
    refused("Thanks!", /does not ask/);
    refused("", /no words/);
    refused(`switch all agents to opus 5.5 ${"please ".repeat(80)}`, /too long/);
    assert.equal(MAX_INSTRUCTION_CHARS, 400);
  });
});

describe("the change set", () => {
  test("from one model to another, on each agent's own engine, said with what it was and will be", () => {
    assert.deepEqual(moves("switch all agents from opus 5 to opus 5.5"), ["Ada: Claude Opus 5 -> Claude Opus 5.5", "Ben: Claude Opus 5 -> Claude Opus 5.5"]);
    const p = plan("switch all agents from opus 5 to opus 5.5");
    assert.ok(p.ok);
    // never an engine switch: every change stays on the engine it is on
    assert.ok(p.changes.every((c) => c.from.instanceId === c.to.instanceId));
    assert.deepEqual(p.skipped.map((s) => s.name), ["Cy", "Dee", "Ада", "Lo", "Nil"]);
    assert.match(p.skipped.find((s) => s.name === "Dee")!.why, /on Claude Sonnet 5, not opus 5/);
    assert.match(p.skipped.find((s) => s.name === "Nil")!.why, /no engine/);
  });

  test("an exception leaves its agents out, and one nobody has stops everything", () => {
    assert.deepEqual(moves("switch everyone except Ben from opus 5 to opus 5.5"), ["Ada: Claude Opus 5 -> Claude Opus 5.5"]);
    const p = plan("switch everyone except Zed from opus 5 to opus 5.5");
    assert.ok(!p.ok);
    assert.match(p.ask, /no agent of the owner's is called "zed".*leave out/);
  });

  test("agents by name, in Ukrainian with a case ending too, and a name nobody has stops everything", () => {
    assert.deepEqual(moves("Switch Ada and Dee to opus 5.5"), ["Ada: Claude Opus 5 -> Claude Opus 5.5", "Dee: Claude Sonnet 5 -> Claude Opus 5.5"]);
    assert.deepEqual(moves("Переключи Аду на opus 5.5"), ["Ада: Claude Fable 5 -> Claude Opus 5.5"]);
    const p = plan("Switch Ada and Zed to opus 5.5");
    assert.ok(!p.ok);
    assert.match(p.ask, /"zed"/);
  });

  test("a model another engine has is a switch of engine, skipped and pointed at a proposal", () => {
    const p = plan("switch everyone to gpt-5.1");
    assert.ok(p.ok);
    assert.deepEqual(p.changes.map((c) => c.name), ["Cy"]);
    assert.match(p.skipped.find((s) => s.name === "Ada")!.why, /Claude Code has no model "gpt-5\.1"; moving it to another engine is a proposal/);
  });

  test("a model that could be two, or one nowhere, is asked about and nothing is planned", () => {
    const vague = plan("switch everyone to fable");
    assert.ok(!vague.ok);
    assert.match(vague.ask, /"fable" could be more than one model on Claude Code/);
    const nowhere = plan("switch all from opus 7 to opus 5.5");
    assert.ok(!nowhere.ok);
    assert.match(nowhere.ask, /no engine of the owner's agents has a model "opus 7"/);
    const absent = plan("switch Lo to m-9");
    assert.ok(!absent.ok);
    assert.match(absent.ask, /model "m-9"/);
  });

  test("a typed model id goes where the engine runs any id, as the picker takes it", () => {
    assert.deepEqual(moves("switch Ada to claude-opus-6"), ["Ada: Claude Opus 5 -> claude-opus-6"]);
    const p = plan("switch Ada to claude-opus-6");
    assert.ok(p.ok);
    assert.equal(p.changes[0]!.to.unlisted, true);
    assert.equal(modelNamed(CLAUDE, "claude opus 6"), null, "spaces are no model id");
    assert.equal(modelNamed(LOCAL, "m-9"), null, "an engine that only runs its list takes nothing else");
    assert.deepEqual(modelNamed(CLAUDE, "Opus 5.5"), { id: "claude-opus-5-5", label: "Claude Opus 5.5" });
    assert.deepEqual(modelNamed(CLAUDE, "claude-sonnet-5"), { id: "claude-sonnet-5", label: "Claude Sonnet 5" });
  });

  test("already there is skipped, and nothing to do is nothing matched", () => {
    const p = plan("switch Dee to sonnet 5");
    assert.ok(p.ok);
    assert.equal(p.changes.length, 0);
    assert.match(p.skipped[0]!.why, /on Claude Sonnet 5 already/);
  });

  test("the new version is only what the catalog says, followed to its newest", () => {
    assert.deepEqual(moves("upgrade all agents"), ["Ada: Claude Opus 5 -> Claude Opus 5.5", "Ben: Claude Opus 5 -> Claude Opus 5.5", "Cy: GPT-5 -> GPT-5.1", "Ада: Claude Fable 5 -> Claude Fable 5.2"]);
    const p = plan("upgrade all agents");
    assert.ok(p.ok);
    assert.match(p.skipped.find((s) => s.name === "Dee")!.why, /does not know which model replaces Claude Sonnet 5/);
    assert.equal(newestOf(CLAUDE, "claude-opus-5-5"), "newest");
    assert.equal(newestOf(CLAUDE, "opus"), null, "an alias is no lineage");
    // nothing known for any of them: ask, change nothing
    const none = planInstruction(read("upgrade Lo and Dee"), WORLD);
    assert.ok(!none.ok);
    assert.match(none.ask, /no newer version/);
    // a loop in a catalog ends
    const loop: EngineView = { ...LOCAL, options: [{ id: "m-1", successor: "m-2" }, { id: "m-2", successor: "m-1" }] };
    assert.deepEqual(newestOf(loop, "m-1"), { id: "m-2", successor: "m-1" });
  });

  test("Codex's own upgrade field is a successor only when it names a model the list shows", () => {
    const catalog = catalogFromModelList([{ data: [
      { model: "gpt-5", displayName: "gpt-5", upgrade: "gpt-5.1" },
      { model: "gpt-5.1", displayName: "gpt-5.1", upgrade: { id: "gpt-hidden" } },
      { model: "gpt-hidden", hidden: true },
      { model: "gpt-4", upgrade: { model: "gpt-5" } },
    ] }]);
    assert.ok(catalog);
    assert.deepEqual(catalog.options.map((o) => [o.id, o.successor]), [["gpt-5", "gpt-5.1"], ["gpt-5.1", undefined], ["gpt-4", "gpt-5"]]);
  });

  test("a change set checked again against what is saved refuses all of it when one agent moved", () => {
    const p = plan("switch all agents from opus 5 to opus 5.5");
    assert.ok(p.ok);
    const moved: ModelWorld = { ...WORLD, agents: WORLD.agents.map((a) => (a.id === "b1" ? { ...a, selection: { instanceId: "claude", model: "claude-sonnet-5" } } : a)) };
    assert.deepEqual(blockers({ targets: p.changes }, WORLD), []);
    assert.match(blockers({ targets: p.changes }, moved).join(), /Ben is on Claude Code, Claude Sonnet 5 now/);
  });
});

const msg = (over: Partial<Message> & { id: string }, at = 1_000_000): Message => ({ role: "user", kind: "text", text: "upgrade all agents", at, ...over });

describe("whose words, where and when", () => {
  test("the owner's own words from the app, a paired device or their private Telegram chat", () => {
    assert.equal(notOwners(msg({ id: "app" })), null);
    assert.equal(notOwners(msg({ id: "tg", fromTelegram: true, telegramBinding: { botId: "b", generation: "g" } })), null);
    assert.equal(notOwners(msg({ id: "owner", author: "owner" })), null);
  });

  test("never a member, a guest, an agent, a routine, a webhook, a bridge, a Telegram contact or group, or Signal", () => {
    const sender = { botId: "b", bindingGeneration: "g", personId: "p", userId: 1, name: "Sam", grant: "x", requester: "p", chatId: 1 } as any;
    const cases: Array<[Partial<Message>, RegExp]> = [
      [{ role: "bot" }, /agent's message/],
      [{ author: "person-1" }, /member or a guest/],
      [{ agent: { dir: "in", peerId: "x", peerName: "X" } }, /another agent/],
      [{ from: "x" }, /another agent/],
      [{ selfSent: true }, /an agent wrote it/],
      [{ routine: { manual: false } }, /routine/],
      [{ via: "webhook" }, /webhook/],
      [{ via: "email" }, /email/],
      [{ via: "slack" }, /slack/],
      [{ telegramGroup: { ...sender, owner: true, group: { title: "G" } } }, /group/],
      [{ telegramPerson: sender }, /other than the owner/],
      [{ telegramDelegate: sender }, /other than the owner/],
      [{ fromSignal: { botId: "b", generation: "g" } }, /Signal/],
      [{ onBehalf: { by: "owner", name: "Hamed" } }, /behalf/],
      [{ queued: true }, /not reached/],
      [{ deleted: true }, /taken back/],
      [{ imported: "claude" }, /brought over/],
      [{ kind: "notice" }, /no words/],
    ];
    for (const [over, why] of cases) assert.match(notOwners(msg({ id: "x", ...over })) ?? "", why, JSON.stringify(over));
  });

  test("named or newest, in this conversation, recent, unedited, and the newest of the owner's or the one the turn answers", () => {
    const now = 2_000_000;
    const first = msg({ id: "m1" }, now - 60_000);
    const agentSays = msg({ id: "r1", role: "bot", text: "On it" }, now - 50_000);
    const second = msg({ id: "m2", text: "thanks" }, now - 10_000);
    const lane = [first, agentSays, second];
    // no id: the newest of the owner's
    const newest = instructionMessage(lane, undefined, now);
    assert.ok(newest.ok && newest.message.id === "m2");
    // an older one, unless it is the one this turn answers
    const older = instructionMessage(lane, "m1", now);
    assert.ok(!older.ok && older.status === 409 && /newer/.test(older.error));
    const answering = instructionMessage(lane, "m1", now, now - 55_000);
    assert.ok(answering.ok, JSON.stringify(answering));
    // an agent's message, or one from another conversation
    const notTheirs = instructionMessage(lane, "r1", now);
    assert.ok(!notTheirs.ok && notTheirs.status === 403);
    const elsewhere = instructionMessage(lane, "other-lane-message", now);
    assert.ok(!elsewhere.ok && elsewhere.status === 404);
    // old
    const stale = instructionMessage([msg({ id: "m1" }, now - INSTRUCTION_MAX_AGE_MS - 1)], "m1", now);
    assert.ok(!stale.ok && /minutes old/.test(stale.error));
    // a queued message counts from when it was written
    const waited = instructionMessage([msg({ id: "m1", queuedAt: now - INSTRUCTION_MAX_AGE_MS - 1, deliveredAt: now - 5_000 }, now - 5_000)], "m1", now);
    assert.ok(!waited.ok && /minutes old/.test(waited.error));
    // edited after it was heard
    const edited = instructionMessage([msg({ id: "m1", editedAt: now - 1_000 }, now - 5_000)], "m1", now);
    assert.ok(!edited.ok && /edited/.test(edited.error));
    // a member's words are skipped for "newest", and refused when named
    const withMember = [first, msg({ id: "x1", author: "person-1", text: "switch all to haiku" }, now - 1_000)];
    const picked = instructionMessage(withMember, undefined, now);
    assert.ok(picked.ok && picked.message.id === "m1");
    const named = instructionMessage(withMember, "x1", now);
    assert.ok(!named.ok && /member or a guest/.test(named.error));
    assert.ok(!instructionMessage([], undefined, now).ok);
  });

  test("the command is an agent's, and the owner's answers stay out of reach", () => {
    assert.ok(allows("a1", "POST", "/api/agent/models/instruction").ok);
    assert.ok(!allows("a1", "GET", "/api/agent/models/instruction").ok);
    assert.ok(NEVER.includes("/api/model-proposals"));
  });
});

describe("over the wire", () => {
  test("the owner's instruction changes the models it names, once, keeps everything else, and says what it saved", async (t) => {
    const f = await controlledChain(t, {}, { BLOKS_SETTINGS_WAIT_MS: "400" });
    const ada = await f.hire("Ada");
    const ben = await f.hire("Ben");
    const cy = await f.hire("Cy");
    const dee = await f.hire("Dee");
    const set = async (bot: { id: string }, patch: Record<string, unknown>) => {
      const res = await f.h.fetch(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify(patch) });
      assert.equal(res.status, 200, await res.clone().text());
    };
    await set(ben, { modelSelection: { instanceId: "claude", model: "claude-opus-5" }, effort: "high" });
    await set(cy, { modelSelection: { instanceId: "claude", model: "claude-opus-5" } });
    await set(dee, { modelSelection: { instanceId: "claude", model: "claude-opus-5" } });
    const saved = async (bot: { id: string }) => {
      const found = (await f.h.json("/api/bots?messages=0")).bots.find((b: any) => b.id === bot.id);
      return { instanceId: found.modelSelection.instanceId, model: found.modelSelection.model, effort: found.effort };
    };

    const turn = await f.begin(ada, "Hey Ada. Please switch everyone except Dee from Opus 5 to Opus 5.5, thanks");
    const ownerMessage = (await f.messages(ada)).find((m) => m.role === "user" && /except Dee/.test(m.text));
    assert.ok(ownerMessage);
    const done = await bloks(f.h.url, turn, f.home, ["models", "apply-instruction"]);
    assert.equal(done.exit, 0, JSON.stringify(done.body) + done.err);
    assert.equal(done.body.ok, true);
    assert.equal(done.body.message, ownerMessage.id);
    assert.deepEqual(done.body.changed.map((c: any) => [c.agent, c.from, c.to]).sort(), [["Ben", "Claude Opus 5", "Claude Opus 5.5"], ["Cy", "Claude Opus 5", "Claude Opus 5.5"]]);
    const skippedNames = done.body.skipped.map((s: any) => s.agent);
    assert.ok(skippedNames.includes("Ada"), JSON.stringify(done.body.skipped));
    assert.ok(!skippedNames.includes("Dee"), "Dee is left out, not skipped");
    assert.match(done.body.note, /Tell the owner/);
    // the primary model only, on the same engine; effort and the rest stay
    assert.deepEqual(await saved(ben), { instanceId: "claude", model: "claude-opus-5-5", effort: "high" });
    assert.equal((await saved(cy)).model, "claude-opus-5-5");
    assert.equal((await saved(dee)).model, "claude-opus-5", "the exception is not touched");
    assert.equal((await saved(ada)).model, "claude-sonnet-5");
    const ledger = await waitFor(async () => {
      const entries = (await f.h.json("/api/ledger")).entries.filter((e: any) => e.kind === "settings.changed" && /as you told Ada in chat/.test(e.summary));
      return entries.length === 2 ? entries : null;
    });
    assert.ok(ledger.every((e: any) => e.actor === "you"));
    // kept on the message, server side
    const kept = (await f.messages(ada)).find((m) => m.id === ownerMessage.id);
    assert.equal(kept.modelInstruction.botId, ada.id);

    // once: a retry, even after the owner changed Ben by hand, writes nothing
    await set(ben, { modelSelection: { instanceId: "claude", model: "claude-haiku-4-5" } });
    const again = await bloks(f.h.url, turn, f.home, ["models", "apply-instruction", "--message", ownerMessage.id, "Dee", "--everyone"]);
    assert.equal(again.exit, 0, JSON.stringify(again.body));
    assert.equal(again.body.again, true);
    assert.match(again.body.note, /carried out already/);
    assert.deepEqual(again.body.ignored, ["also"], "what the agent added is not read");
    assert.equal((await saved(ben)).model, "claude-haiku-4-5", "the owner's later edit stands");
    assert.equal((await saved(dee)).model, "claude-opus-5", "nothing the agent added widened it");

    // a message of another conversation, or no message at all, is refused
    const elsewhere = await bloks(f.h.url, turn, f.home, ["models", "apply-instruction", "--message", "not-a-message-here"]);
    assert.equal(elsewhere.exit, 1);
    assert.match(elsewhere.body.error, /no message with that id in this conversation/);
    const odd = await f.agent(turn, "/api/agent/models/instruction", { message: "../../x" });
    assert.equal(odd.status, 400);

    // the agent still cannot write another agent's model itself
    const direct = await f.agent(turn, `/api/bots/${ben.id}`, { modelSelection: { instanceId: "claude", model: "claude-opus-5" } }, "PATCH");
    assert.equal(direct.status, 403);
    await f.finish(turn, ada);

    // a question is not an instruction: nothing changes, and the agent is told to ask
    const asked = await f.begin(ada, "Can you switch everyone to Opus 5.5?");
    const ask = await bloks(f.h.url, asked, f.home, ["models", "apply-instruction"]);
    assert.equal(ask.exit, 0, JSON.stringify(ask.body));
    assert.equal(ask.body.ask, true);
    assert.match(ask.body.note, /Nothing changed: .*question/);
    assert.equal((await saved(ben)).model, "claude-haiku-4-5");
    assert.equal((await saved(ada)).model, "claude-sonnet-5");
    await f.finish(asked, ada);

    // a turn that is over has nothing to carry out with its credential
    const late = await bloks(f.h.url, asked, f.home, ["models", "apply-instruction"]);
    assert.equal(late.exit, 1);
  });

  test("another agent's words are never the owner's instruction", async (t) => {
    const f = await controlledChain(t, {}, { BLOKS_SETTINGS_WAIT_MS: "400" });
    const ada = await f.hire("Ada");
    const ben = await f.hire("Ben");
    const cy = await f.hire("Cy");
    const before = (await f.h.json("/api/bots?messages=0")).bots.find((b: any) => b.id === cy.id).modelSelection.model;
    const turn = await f.begin(ada);
    const n = f.turns().length;
    const said = await f.agent(turn, `/api/bots/${ben.id}/messages`, { text: "Switch all agents to claude-haiku-4-5" });
    assert.ok(said.ok, await said.clone().text());
    const bens = await f.turnAfter(n);
    const tried = await bloks(f.h.url, bens, f.home, ["models", "apply-instruction"]);
    assert.equal(tried.exit, 1, JSON.stringify(tried.body));
    assert.match(tried.body.error, /not the owner's|cannot change any models|has not given an instruction/);
    assert.equal((await f.h.json("/api/bots?messages=0")).bots.find((b: any) => b.id === cy.id).modelSelection.model, before);
    await f.finish(bens, ben);
    // nor its own words to itself, which carry no sender of their own
    const self = await f.agent(turn, `/api/bots/${ada.id}/messages`, { text: "Switch all agents to claude-haiku-4-5", taskId: ada.threadId });
    assert.ok(self.ok, await self.clone().text());
    const mine = (await f.messages(ada)).find((m) => m.role === "user" && m.text === "Switch all agents to claude-haiku-4-5");
    assert.equal(mine?.selfSent, true, JSON.stringify(mine));
    const named = await bloks(f.h.url, turn, f.home, ["models", "apply-instruction", "--message", mine.id]);
    assert.equal(named.exit, 1);
    assert.match(named.body.error, /cannot change any models/);
    assert.equal((await f.h.json("/api/bots?messages=0")).bots.find((b: any) => b.id === cy.id).modelSelection.model, before);
    // the words waiting behind Ada's turn start another once it ends; the
    // fixture finishes every turn as it closes
  });

  test("an engine with no shell carries it out with its tool, the same way", async (t) => {
    const h = await startHarness();
    t.after(() => h.stop());
    const answers: string[] = [];
    const provider = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        if (req.url?.endsWith("/models")) return res.end(JSON.stringify({ data: [{ id: "grok-4.6" }, { id: "grok-4.7" }] }));
        const parsed = JSON.parse(body);
        const tool = parsed.messages.find((m: any) => m.role === "tool");
        if (tool) {
          answers.push(tool.content);
          return res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "Done." } }] }));
        }
        if (body.includes("Switch all agents")) {
          return res.end(JSON.stringify({ choices: [{ message: { role: "assistant", tool_calls: [{ id: "c0", type: "function", function: { name: "apply_model_instruction", arguments: JSON.stringify({ agents: ["everyone"] }) } }] } }] }));
        }
        res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "Hello." } }] }));
      });
    });
    await new Promise<void>((r) => provider.listen(0, "127.0.0.1", () => r()));
    t.after(() => {
      provider.closeAllConnections();
      provider.close();
    });
    const port = (provider.address() as { port: number }).port;
    const keeper = await agentOn(h, port, "Keeper");
    const other = await agentOn(h, port, "Other");
    for (const bot of [keeper, other]) {
      await h.fetch(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "grok", model: "grok-4.6" } }) });
    }
    await h.fetch(`/api/bots/${keeper.id}/messages`, { method: "POST", body: JSON.stringify({ text: "Switch all agents from grok 4.6 to grok 4.7 please" }) });
    assert.ok(await waitFor(() => answers.length >= 1), "the tool was never answered");
    await idle(h, keeper);
    const answer = JSON.parse(answers[0]!);
    assert.equal(answer.ok, true, answers[0]);
    assert.deepEqual(answer.changed.map((c: any) => [c.agent, c.to]).sort(), [["Keeper", "Grok 4.7"], ["Other", "Grok 4.7"]].map(([a]) => [a, answer.changed[0].to]));
    assert.deepEqual(answer.ignored, ["agents"]);
    const bots = (await h.json("/api/bots?messages=0")).bots;
    for (const bot of [keeper, other]) {
      const found = bots.find((b: any) => b.id === bot.id).modelSelection;
      assert.deepEqual({ instanceId: found.instanceId, model: found.model }, { instanceId: "grok", model: "grok-4.7" });
    }
  });
});
