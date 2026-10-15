import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { agentTurnLimit, chainName, chainExcerpt, chainLimitText, pastAgentLimit } from "../server/agent-chain.ts";
import { heldMention, hopsNotice } from "../server/room-hops.ts";
import { noticeFor } from "../src/lib/notify.ts";
import { controlledChain } from "./helpers/agent-chain.ts";
import { chainRelay } from "./helpers/chain-relay.ts";
import { waitFor } from "./helpers/turns.ts";
import { startHarness } from "./helpers/server.ts";

const garbage = ["abc", 0, -1, 1.5, true, [], {}, Number.MAX_SAFE_INTEGER + 1];
const explanation = (text: string) => {
  assert.match(text, /Nothing is held for delivery/);
  assert.match(text, /Each turn uses your plan/);
  assert.match(text, /keeping each other going.*usage limit is spent/);
  assert.match(text, /A message from the person.*starts the count over.*routine, watcher or webhook/);
  assert.match(text, /Raise or switch off.*Settings > General > Working with agents/);
};

test("only null disables the workspace limit, including hand-edited config", async () => {
  for (const value of [undefined, ...garbage]) {
    assert.equal(agentTurnLimit(value), 12);
    assert.equal(pastAgentLimit(13, agentTurnLimit(value)), true);
  }
  assert.equal(agentTurnLimit(null), null);
  assert.equal(pastAgentLimit(100, agentTurnLimit(null)), false);
  for (const value of garbage) {
    const home = mkdtempSync(join(tmpdir(), "bloks-stored-limit-"));
    mkdirSync(join(home, ".bloks"));
    writeFileSync(join(home, ".bloks/config.json"), JSON.stringify({ agents: { turnLimit: value } }));
    let h: Awaited<ReturnType<typeof startHarness>> | undefined;
    try { h = await startHarness({ HOME: home }); assert.equal((await h.json("/api/config")).agents.turnLimit, 12); }
    finally { await h?.stop(); rmSync(home, { recursive: true, force: true }); }
  }
});

test("config is validated before any section writes, persists null and denies agents", async (t) => {
  const f = await controlledChain(t);
  assert.equal((await f.h.json("/api/config")).agents.turnLimit, 12);
  await f.limit(24);
  await f.restart();
  assert.equal((await f.h.json("/api/config")).agents.turnLimit, 24);
  await f.limit(null);
  await f.restart();
  assert.equal((await f.h.json("/api/config")).agents.turnLimit, null);
  assert.equal(JSON.parse(readFileSync(join(f.home, ".bloks/config.json"), "utf8")).agents.turnLimit, null);
  for (const agents of [...garbage.map((turnLimit) => ({ turnLimit })), null, [], {}, true]) {
    const before = readFileSync(join(f.home, ".bloks/config.json"), "utf8");
    const res = await f.h.fetch("/api/config", { method: "PUT", body: JSON.stringify({ agents, recall: { beforeTurn: false } }) });
    assert.equal(res.status, 400, JSON.stringify(agents));
    assert.equal(readFileSync(join(f.home, ".bloks/config.json"), "utf8"), before);
    assert.equal((await f.h.json("/api/config")).recall.beforeTurn, true);
  }
  const a = await f.hire("Alpha"), turn = await f.begin(a);
  assert.equal((await f.agent(turn, "/api/config", undefined, "GET")).status, 403);
  assert.equal((await f.agent(turn, "/api/config", { agents: { turnLimit: 1 } }, "PUT")).status, 403);
});

test("refusals redact the attempted words, keep four parts and dedupe reworded retries", async (t) => {
  const secret = "example-stored-credential-abcdefgh";
  const key = "sk-example1234567890abcdefghijkl";
  const f = await controlledChain(t, { secrets: { example: secret } });
  const previews = await chainRelay(t, f.h);
  const a = await f.hire("Alpha"), b = await f.hire("Bravo");
  const { bot, other, turn } = await f.depth(a, b, 12);
  for (const text of [`First\n  ${secret} ${key}`, `Different ${secret} ${key}`]) {
    const res = await f.agent(turn, `/api/bots/${other.id}/messages`, { text });
    assert.equal(res.status, 429);
    const error = (await res.json()).error as string;
    explanation(error);
    assert.match(error, /from Alpha to Bravo was not delivered/);
    assert.match(error, /12 turns in a row.*limit of 12/);
    assert.match(error, /Excerpt:.*\[redacted\].*\[redacted\]/);
    assert.ok(!error.includes(secret) && !error.includes(key));
    assert.ok(!error.includes("\n"));
  }
  let held = (await f.messages(other)).filter((m) => m.chainHeld);
  assert.equal(held.length, 1, "a reworded retry woke the recipient twice");
  explanation(held[0].text);
  const laneWake = await waitFor(() => previews.find((p) => p.title === "Agents stopped at the limit" && p.threadId === other.threadId));
  assert.ok(laneWake, "the direct refusal had no chain wake");
  assert.match(laneWake.body, /Alpha to Bravo/);
  assert.ok(laneWake.body.length <= 178);
  assert.ok(!held[0].text.includes(secret) && !held[0].text.includes(key));
  assert.ok(!(await f.messages(other)).some((m) => m.role === "user" && /First|Different/.test(m.text ?? "")));
  await f.begin(other, "A person's new message");
  assert.equal((await f.agent(turn, `/api/bots/${other.id}/messages`, { text: "Another attempt" })).status, 429);
  held = (await f.messages(other)).filter((m) => m.chainHeld);
  assert.equal(held.length, 2, "the person's intervening words did not allow a new notice");
  // Stop's reason goes through the same chain guard after the stop itself.
  await f.h.json(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ seniority: 10 }) });
  const { blok } = await f.h.json("/api/bloks", { method: "POST", body: JSON.stringify({ name: "Example room", memberIds: [bot.id, other.id] }) });
  const mention = await f.agent(turn, `/api/bloks/${blok.id}/messages`, { text: "@Bravo A refused mention" });
  assert.ok(mention.ok);
  const roomWake = await waitFor(() => previews.find((p) => p.title === "Agents stopped at the limit" && p.threadId === blok.id));
  assert.ok(roomWake, "the room refusal had no chain wake");
  assert.match(roomWake.body, /Alpha to Bravo/);
  assert.ok(roomWake.body.length <= 178);
  const stop = await f.agent(turn, `/api/bots/${other.id}/interrupt`, { text: "A stop reason beyond the limit" });
  assert.equal(stop.status, 200);
  assert.equal((await stop.json()).said, undefined);
  assert.ok(!(await f.messages(other)).some((m) => m.role === "user" && m.text === "A stop reason beyond the limit"));
});

test("Off then On preserves a running count, but queued turns starting Off begin at zero", async (t) => {
  const f = await controlledChain(t);
  const a = await f.hire("Alpha"), b = await f.hire("Bravo");
  let at = await f.depth(a, b, 12);
  await f.limit(null); await f.limit(12);
  assert.equal((await f.agent(at.turn, `/api/bots/${at.other.id}/messages`, { text: "Still the same running turn" })).status, 429);
  await f.limit(24);
  let n = f.turns().length;
  assert.ok((await f.agent(at.turn, `/api/bots/${at.other.id}/messages`, { text: "The higher live value allows this" })).ok);
  const next = await f.turnAfter(n);
  await f.finish(at.turn, at.bot);
  await f.limit(1);
  const lower = await f.agent(next, `/api/bots/${at.bot.id}/messages`, { text: "Lowered below a live depth" });
  assert.equal(lower.status, 429);
  assert.match((await lower.json()).error, /workspace limit of 1/);
  await f.finish(next, at.other);
  await f.limit(12);
  at = await f.depth(a, b, 11);
  const queued = await f.agent(at.turn, `/api/bots/${at.bot.id}/messages`, { text: "Queued at twelve while On" });
  assert.equal((await queued.json()).queued, true);
  n = f.turns().length;
  await f.limit(null);
  writeFileSync(join(f.home, `finish-${at.turn.pid}`), "");
  const resumed = await f.turnAfter(n);
  await f.limit(1);
  const accepted = await f.agent(resumed, `/api/bots/${at.other.id}/messages`, { text: "The queued turn started at zero" });
  assert.ok(accepted.ok, "the queued On count survived its Off start");
});

test("Off allows a thirteenth say without a notice and files no inherited chain", async (t) => {
  const f = await controlledChain(t, { agents: { turnLimit: null } });
  const previews = await chainRelay(t, f.h);
  const a = await f.hire("Alpha"), b = await f.hire("Bravo");
  const at = await f.depth(a, b, 13);
  assert.equal((await f.messages(a)).filter((m) => m.chainHeld).length, 0);
  assert.equal((await f.messages(b)).filter((m) => m.chainHeld).length, 0);
  const dir = join(f.home, "drops"); mkdirSync(dir);
  const watch = await f.agent(at.turn, "/api/watchers", { kind: "folder", target: dir, instruction: "Example", name: "Example" });
  assert.equal(watch.status, 201);
  const w = (await watch.json()).watcher;
  assert.equal(w.chain, undefined);
  const edit = await f.agent(at.turn, `/api/watchers/${w.id}`, { name: "Edited" }, "PATCH");
  assert.equal(edit.status, 200); assert.equal((await edit.json()).watcher.chain, undefined);
  const routine = await f.agent(at.turn, "/api/routines", { targetId: at.bot.id, targetKind: "agent", prompt: "Example", time: "23:59", days: [] });
  assert.equal(routine.status, 201);
  const r = (await routine.json()).routine; assert.equal(r.chain, undefined);
  const edited = await f.agent(at.turn, `/api/routines/${r.id}`, { name: "Edited" }, "PATCH");
  assert.equal(edited.status, 200); assert.equal((await edited.json()).routine.chain, undefined);
  const { blok } = await f.h.json("/api/bloks", { method: "POST", body: JSON.stringify({ name: "Example room", memberIds: [a.id, b.id] }) });
  const n = f.turns().length;
  const room = await f.agent(at.turn, `/api/bloks/${blok.id}/messages`, { text: `@${at.other.id === a.id ? "Alpha" : "Bravo"} Example mention` });
  assert.ok(room.ok);
  assert.match((await f.turnAfter(n)).text, /Example mention/);
  const roomRows = (await f.h.json(`/api/bloks/${blok.id}/messages?limit=200`)).messages;
  assert.equal(roomRows.filter((m: any) => m.chainHeld).length, 0);
  assert.ok(!previews.some((p) => p.title === "Agents stopped at the limit"), "Off woke a chain-limit alert");
  const job = await f.agent(at.turn, "/api/jobs", { title: "Example work", brief: "Example" });
  assert.equal(job.status, 201); assert.equal((await job.json()).job.chain, undefined);
});

test("room Off skips only the chain bound, and chain titles beat engine errors", () => {
  assert.equal(heldMention("Alpha", ["Bravo"], { hops: 1, chain: 13 }, null), null);
  assert.equal(heldMention("Alpha", ["Bravo"], { hops: 4, chain: 13 }, null), hopsNotice("Alpha", ["Bravo"]));
  const text = chainLimitText("A message from Alpha to Bravo was not delivered.", 13, 12);
  explanation(text);
  assert.match(text, /usage limit/);
  const ctx = { focused: false, selectedId: "elsewhere", threadId: "lane", bot: { id: "bot", name: "Bravo" } };
  assert.equal(noticeFor({ role: "bot", kind: "notice", chainHeld: true, text }, ctx)?.title, "Agents stopped at the limit");
  assert.equal(noticeFor({ role: "bot", kind: "notice", chainHeld: true, goal: "blocked", text }, ctx)?.title, "Agents stopped at the limit");
  assert.equal(noticeFor({ role: "bot", kind: "notice", chainHeld: true, text }, { ...ctx, focused: true, selectedId: "bot" }), null);
  assert.equal(noticeFor({ role: "bot", kind: "notice", text: "usage limit reached" }, ctx)?.title, "Bravo could not answer");
  assert.equal(chainExcerpt("a\n" + "x".repeat(300), (s) => s).length, 160);
  const boundaryKey = "sk-" + "q".repeat(40);
  assert.equal(chainExcerpt("x".repeat(150) + boundaryKey, (words) => words.replace(boundaryKey, "[redacted]")), "x".repeat(150) + "[redacted]");
  assert.ok(text.slice(0, 178).includes("Alpha to Bravo"));
  const from = chainName("A".repeat(80)), to = chainName("B".repeat(80));
  assert.equal(from.length, 50); assert.equal(to.length, 50);
  const clipped = chainLimitText(`A message from ${from} to ${to} was not delivered.`, 13, 12).slice(0, 178);
  assert.ok(clipped.includes(from) && clipped.includes(to));
});
