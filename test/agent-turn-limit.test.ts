import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { agentTurnLimit, chainAgentRefusal, chainName, chainExcerpt, chainLimitText, pastAgentLimit, validTurnLimit } from "../server/agent-chain.ts";
import { heldMention, hopsNotice } from "../server/room-hops.ts";
import { noticeFor } from "../src/lib/notify.ts";
import { controlledChain } from "./helpers/agent-chain.ts";
import { chainRelay } from "./helpers/chain-relay.ts";
import { waitFor } from "./helpers/turns.ts";
import { startHarness } from "./helpers/server.ts";

const garbage = ["abc", 0, -1, 1.5, true, [], {}, null, Number.MAX_SAFE_INTEGER + 1];
/** Refused by the API; stored by hand, each reads as the bound. */
const tooHigh = [51, 1000, Number.MAX_SAFE_INTEGER];
const explanation = (text: string) => {
  assert.match(text, /: agents reached the limit of \d+ consecutive turns?\./);
  assert.match(text, /This limit helps prevent repeated messages from using up your plan\./);
  assert.match(text, /Change it in Settings > General > Working with agents\./);
  assert.doesNotMatch(text, /switch off|\bOff\b|starts the count|person.*carr|queued|redeliver|by hand|manual run/i);
};
/** What the agent is told: wrap up, and nothing about lifting the limit. */
const toldToWrapUp = (text: string) => {
  assert.match(text, /Finish this turn and report any unfinished work\./);
  assert.doesNotMatch(text, /Settings|raise|switch off|plan|person.*carr/i);
};

for (const completed of [true, false]) test(completed
  ? "a refused cleanup confirmation does not turn completed work into a request"
  : "a refused assignment identifies only the message that was not delivered", async (t) => {
  const f = await controlledChain(t, { agents: { turnLimit: 1 } });
  const pushes: Array<{ frames: any[]; wake: unknown }> = [];
  await chainRelay(t, f.h, pushes);
  const a = await f.hire("Alpha"), b = await f.hire("Bravo");
  const at = await f.depth(a, b, 1);
  const item = join(f.home, "example-cleanup-file");
  writeFileSync(item, "Example work");
  if (completed) rmSync(item);
  const text = completed ? "Cleanup complete. The temporary file was removed." : "Please remove the temporary file.";
  const before = f.turns().length;
  const res = await f.agent(at.turn, `/api/bots/${at.other.id}/messages`, { text });
  assert.equal(res.status, 429);
  toldToWrapUp((await res.json()).error);
  const messages = await f.messages(at.other);
  const notice = messages.find((m) => m.chainHeld);
  assert.ok(notice);
  assert.match(notice.text, /^A message from Bravo to Alpha was not delivered: agents reached the limit of 1 consecutive turn\./);
  explanation(notice.text);
  assert.ok(notice.text.includes(`Excerpt: "${text}"`));
  assert.doesNotMatch(notice.text, /task failed|work failed|reply to continue|must continue|carries it on|Nothing is held|starts the count/i);
  assert.equal(messages.some((m) => m.role === "user" && m.text === text), false, "the refused item must not be delivered as an assignment");
  assert.equal(f.turns().length, before, "the refusal started another turn");
  assert.equal(existsSync(item), !completed, "a refused message changed the completed or unfinished work");
  const pushed = await waitFor(() => pushes.find((p) => p.frames.some((frame) => frame.message?.id === notice.id)));
  assert.ok(pushed, "the in-chat explanation was not delivered to the synthetic phone");
  assert.equal(pushed.wake, undefined, "the stop alone woke the phone");
  assert.equal(noticeFor(notice, { focused: false, selectedId: "elsewhere", threadId: at.other.threadId, bot: at.other }), null, "the stop alone raised a desktop banner");
});

test("stored values never switch the limit off: malformed is twelve, past fifty is fifty", async () => {
  for (const value of [undefined, ...garbage]) {
    assert.equal(agentTurnLimit(value), 12, JSON.stringify(value));
    assert.equal(pastAgentLimit(13, agentTurnLimit(value)), true);
    assert.equal(validTurnLimit(value), false);
  }
  for (const value of tooHigh) {
    assert.equal(agentTurnLimit(value), 50);
    assert.equal(validTurnLimit(value), false);
  }
  for (const value of [1, 12, 50]) { assert.equal(agentTurnLimit(value), value); assert.equal(validTurnLimit(value), true); }
  for (const [value, read] of [...garbage.map((v) => [v, 12] as const), ...tooHigh.map((v) => [v, 50] as const)]) {
    const home = mkdtempSync(join(tmpdir(), "bloks-stored-limit-"));
    mkdirSync(join(home, ".bloks"));
    writeFileSync(join(home, ".bloks/config.json"), JSON.stringify({ agents: { turnLimit: value } }));
    let h: Awaited<ReturnType<typeof startHarness>> | undefined;
    try { h = await startHarness({ HOME: home }); assert.equal((await h.json("/api/config")).agents.turnLimit, read, JSON.stringify(value)); }
    finally { await h?.stop(); rmSync(home, { recursive: true, force: true }); }
  }
});

test("config is validated before any section writes, refuses null and past fifty, and denies agents", async (t) => {
  const f = await controlledChain(t);
  assert.equal((await f.h.json("/api/config")).agents.turnLimit, 12);
  await f.limit(24);
  await f.restart();
  assert.equal((await f.h.json("/api/config")).agents.turnLimit, 24);
  await f.limit(50);
  await f.limit(1);
  await f.restart();
  assert.equal((await f.h.json("/api/config")).agents.turnLimit, 1);
  assert.equal(JSON.parse(readFileSync(join(f.home, ".bloks/config.json"), "utf8")).agents.turnLimit, 1);
  for (const agents of [...garbage.map((turnLimit) => ({ turnLimit })), ...tooHigh.map((turnLimit) => ({ turnLimit })), null, [], {}, true]) {
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

test("refusals name the undelivered message, redact its words and dedupe reworded retries", async (t) => {
  const secret = "example-stored-credential-abcdefgh";
  const key = "sk-example1234567890abcdefghijkl";
  const f = await controlledChain(t, { secrets: { example: secret } });
  const pushes: Array<{ frames: any[]; wake: unknown }> = [];
  await chainRelay(t, f.h, pushes);
  const a = await f.hire("Alpha"), b = await f.hire("Bravo");
  const { bot, other, turn } = await f.depth(a, b, 12);
  for (const text of [`First\n  ${secret} ${key}`, `Different ${secret} ${key}`]) {
    const res = await f.agent(turn, `/api/bots/${other.id}/messages`, { text });
    assert.equal(res.status, 429);
    const error = (await res.json()).error as string;
    toldToWrapUp(error);
    assert.match(error, /^Bravo did not get this message: agents reached the limit of 12 consecutive turns/);
    assert.ok(!error.includes(secret) && !error.includes(key));
  }
  let held = (await f.messages(other)).filter((m) => m.chainHeld);
  assert.equal(held.length, 1, "a reworded retry woke the recipient twice");
  explanation(held[0].text);
  assert.match(held[0].text, /from Alpha to Bravo was not delivered/);
  assert.match(held[0].text, /limit of 12 consecutive turns/);
  assert.match(held[0].text, /Excerpt:.*\[redacted\].*\[redacted\]/);
  assert.ok(!held[0].text.includes("\n"));
  const laneFrame = await waitFor(() => pushes.find((p) => p.frames.some((frame) => frame.message?.id === held[0].id)));
  assert.ok(laneFrame, "the direct hold was not delivered to the paired phone");
  assert.equal(laneFrame.wake, undefined, "a mechanical direct hold must not wake the phone");
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
  const roomFrame = await waitFor(() => pushes.find((p) => p.frames.some((frame) => frame.threadId === blok.id && frame.message?.chainHeld)));
  assert.ok(roomFrame, "the room hold was not delivered to the paired phone");
  assert.equal(roomFrame.wake, undefined, "a mechanical room hold must not wake the phone");
  const stop = await f.agent(turn, `/api/bots/${other.id}/interrupt`, { text: "A stop reason beyond the limit" });
  assert.equal(stop.status, 200);
  assert.equal((await stop.json()).said, undefined);
  assert.ok(!(await f.messages(other)).some((m) => m.role === "user" && m.text === "A stop reason beyond the limit"));
});

test("changing the live limit moves the line, never the count", async (t) => {
  const f = await controlledChain(t);
  const a = await f.hire("Alpha"), b = await f.hire("Bravo");
  const at = await f.depth(a, b, 12);
  await f.limit(50); await f.limit(12);
  assert.equal((await f.agent(at.turn, `/api/bots/${at.other.id}/messages`, { text: "Still the same running turn" })).status, 429);
  await f.limit(24);
  const n = f.turns().length;
  assert.ok((await f.agent(at.turn, `/api/bots/${at.other.id}/messages`, { text: "The higher live value allows this" })).ok);
  const next = await f.turnAfter(n);
  await f.finish(at.turn, at.bot);
  await f.limit(1);
  const lower = await f.agent(next, `/api/bots/${at.bot.id}/messages`, { text: "Lowered below a live depth" });
  assert.equal(lower.status, 429);
  toldToWrapUp((await lower.json()).error);
  const told = (await f.messages(at.bot)).filter((m) => m.chainHeld).at(-1);
  assert.match(told?.text ?? "", /limit of 1 consecutive turn\./);
});

test("routines, watchers and jobs agents file carry the chain, at any limit", async (t) => {
  const f = await controlledChain(t, { agents: { turnLimit: 50 } });
  const a = await f.hire("Alpha"), b = await f.hire("Bravo");
  const at = await f.depth(a, b, 13);
  assert.equal((await f.messages(a)).filter((m) => m.chainHeld).length, 0);
  assert.equal((await f.messages(b)).filter((m) => m.chainHeld).length, 0);
  const dir = join(f.home, "drops"); mkdirSync(dir);
  const watch = await f.agent(at.turn, "/api/watchers", { kind: "folder", target: dir, instruction: "Example", name: "Example" });
  assert.equal(watch.status, 201);
  const w = (await watch.json()).watcher;
  assert.equal(w.chain, 14);
  const edit = await f.agent(at.turn, `/api/watchers/${w.id}`, { name: "Edited" }, "PATCH");
  assert.equal(edit.status, 200); assert.equal((await edit.json()).watcher.chain, 14);
  const routine = await f.agent(at.turn, "/api/routines", { targetId: at.bot.id, targetKind: "agent", prompt: "Example", time: "23:59", days: [] });
  assert.equal(routine.status, 201);
  const r = (await routine.json()).routine; assert.equal(r.chain, 14);
  const edited = await f.agent(at.turn, `/api/routines/${r.id}`, { name: "Edited" }, "PATCH");
  assert.equal(edited.status, 200); assert.equal((await edited.json()).routine.chain, 14);
  const job = await f.agent(at.turn, "/api/jobs", { title: "Example work", brief: "Example" });
  assert.equal(job.status, 201); assert.equal((await job.json()).job.chain, 14);
  // lowered again, the same turn is past the line
  await f.limit(12);
  const refused = await f.agent(at.turn, `/api/bots/${at.other.id}/messages`, { text: "Past the lowered limit" });
  assert.equal(refused.status, 429);
});

test("a room keeps both guard bounds and records them without turning engine words into alerts", () => {
  assert.equal(heldMention("Alpha", ["Bravo"], { hops: 1, chain: 50 }, 50), null);
  assert.match(heldMention("Alpha", ["Bravo"], { hops: 1, chain: 51 }, 50) ?? "", /limit of 50 consecutive turns/);
  assert.equal(heldMention("Alpha", ["Bravo"], { hops: 4, chain: 13 }, 12), hopsNotice("Alpha", ["Bravo"]));
  toldToWrapUp(chainAgentRefusal("Bravo", 12));
  // an engine-out word in the explanation must not turn it into an engine alert
  const text = chainLimitText("A message from Alpha to Bravo was not delivered.", 12, "the usage limit reached");
  explanation(text);
  assert.match(text, /usage limit reached/);
  const ctx = { focused: false, selectedId: "elsewhere", threadId: "lane", bot: { id: "bot", name: "Bravo" } };
  assert.equal(noticeFor({ role: "bot", kind: "notice", chainHeld: true, text }, ctx), null);
  assert.equal(noticeFor({ role: "bot", kind: "notice", chainHeld: true, goal: "blocked", text }, ctx), null);
  assert.equal(noticeFor({ role: "bot", kind: "notice", chainHeld: true, text }, { ...ctx, focused: true, selectedId: "bot" }), null);
  assert.equal(noticeFor({ role: "bot", kind: "notice", text: "usage limit reached" }, ctx), null);
  assert.equal(chainExcerpt("a\n" + "x".repeat(300), (s) => s).length, 160);
  const boundaryKey = "sk-" + "q".repeat(40);
  assert.equal(chainExcerpt("x".repeat(150) + boundaryKey, (words) => words.replace(boundaryKey, "[redacted]")), "x".repeat(150) + "[redacted]");
  assert.ok(text.slice(0, 178).includes("Alpha to Bravo"));
  const from = chainName("A".repeat(80)), to = chainName("B".repeat(80));
  assert.equal(from.length, 50); assert.equal(to.length, 50);
  const clipped = chainLimitText(`A message from ${from} to ${to} was not delivered.`, 12).slice(0, 178);
  assert.ok(clipped.includes(from) && clipped.includes(to));
});
