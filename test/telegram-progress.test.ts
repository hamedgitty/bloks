import assert from "node:assert/strict";
import { test } from "node:test";
import type { Message } from "../server/store.ts";
import { Progress, send } from "../server/telegram.ts";
import { TurnProgress } from "../server/telegram-progress.ts";
import { telegramReply } from "../server/telegram-reply.ts";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (done: () => boolean) => {
  for (let i = 0; i < 400 && !done(); i++) await wait(5);
  assert.ok(done(), "the expected progress call arrived");
};
const row = (id: string, role: "user" | "bot", extra: Partial<Message> = {}): Message => ({
  id, at: Date.now(), role, kind: "text", text: id, ...extra,
});
const tool = (id = "call"): Message => row(id, "bot", { kind: "activity", tool: { name: "read synthetic.ts" } });
function fixture(rows: Message[], requestId = "request", startedAt = Date.now(), after = 30) {
  const calls: Array<{ method: string; text?: string; at: number }> = [];
  const progress = new Progress({
    post: async (text) => { calls.push({ method: "post", text, at: Date.now() }); return 7; },
    remove: async () => { calls.push({ method: "remove", at: Date.now() }); },
  }, () => false, after, 30);
  const turn = new TurnProgress(progress, () => rows, () => requestId, () => startedAt);
  return { calls, turn, answer: () => telegramReply(turn.answerSpan(), (text) => text).text };
}

test("waiting behind another turn produces no note, and delivery starts the delay", async () => {
  const request = row("request", "user", { queued: true });
  const rows = [row("earlier", "user"), row("Someone else's note.", "bot"), request];
  const f = fixture(rows);
  f.turn.observe(); f.turn.ended();
  await wait(60);
  assert.equal(f.calls.length, 0);
  assert.equal(f.answer(), "(the agent finished without saying anything)");
  request.queued = false; request.deliveredAt = Date.now();
  rows.push(row("Our first note.", "bot"), tool());
  f.turn.observe();
  await until(() => f.calls.length === 1);
  assert.equal(f.calls[0].text, "Our first note.");
  assert.ok(f.calls[0].at - request.deliveredAt >= 28);
  await f.turn.stop();
});

test("steering uses the consuming turn's elapsed time but only text after the words", async () => {
  const rows = [row("start", "user"), row("Earlier note.", "bot"), row("request", "user", { midTurn: true })];
  const f = fixture(rows, "request", Date.now() - 100);
  f.turn.observe();
  assert.equal(f.answer(), "(the agent finished without saying anything)");
  rows.push(row("After the words.", "bot"), tool());
  f.turn.observe();
  await until(() => f.calls.length === 1);
  assert.equal(f.calls[0].text, "After the words.");
  assert.equal(f.answer(), "After the words.");
  await f.turn.stop();
});

test("a request first in a burst observes after the rest of the head", async () => {
  const rows = [row("request", "user"), row("peer", "user", { agent: { dir: "in", peerId: "helper", peerName: "Helper" } }), row("Visible note.", "bot"), tool()];
  const f = fixture(rows, "request", Date.now() - 100);
  f.turn.observe();
  await until(() => f.calls.length === 1);
  assert.equal(f.calls[0].text, "Visible note.");
  await f.turn.stop();
});

for (const queued of [false, true]) test((queued ? "queued" : "normal") + " completion freezes the answer before a later turn", async () => {
  const request = row("request", "user", { ...(queued ? { deliveredAt: Date.now() - 100 } : {}) });
  const rows = [request, row("Our note.", "bot"), row("Our final.", "bot")];
  const f = fixture(rows, "request", Date.now() - 100);
  f.turn.observe();
  await until(() => f.calls.length === 1);
  f.turn.ended();
  rows.push(row("later", "user"), row("Later note.", "bot"), row("Later answer.", "bot"));
  f.turn.observe();
  await f.turn.stop();
  assert.equal(f.answer(), "Our final.");
  assert.deepEqual(f.calls.map((c) => c.method), ["post", "remove"]);
  assert.equal(f.calls[0].text, "Our note.");
});

test("completion cancels pending posts and ignores even a late text with no next head", async () => {
  const rows = [row("request", "user"), row("Our note.", "bot"), tool()];
  const f = fixture(rows, "request", Date.now(), 40);
  f.turn.observe(); f.turn.ended();
  rows.push(row("Late text.", "bot"), tool("late-call")); f.turn.observe();
  await wait(80);
  assert.equal(f.calls.length, 0);
  assert.equal(f.answer(), "Our note.");
  await f.turn.stop();
});

test("an empty completion is not confused with an adjacent later turn", async () => {
  const rows = [row("request", "user")];
  const f = fixture(rows);
  assert.equal(f.turn.completed, false);
  f.turn.ended();
  assert.equal(f.turn.completed, true, "an empty span still proves completion");
  rows.push(row("later", "user"), row("Later reply.", "bot"));
  f.turn.observe();
  assert.equal(f.answer(), "(the agent finished without saying anything)");
  await f.turn.stop();
});

test("a taken-back or still-queued request does not observe another turn", async () => {
  for (const state of [{ queued: true }, { unsent: true }, { deleted: true }]) {
    const rows = [row("other", "user"), row("request", "user", state), row("Other note.", "bot")];
    const f = fixture(rows, "request", Date.now() - 100);
    f.turn.observe(); f.turn.ended();
    await wait(45);
    assert.equal(f.calls.length, 0);
    assert.equal(f.answer(), "(the agent finished without saying anything)");
    await f.turn.stop();
  }
});

test("visible completed text feeds notes once; non-text, quiet and peer rows do not", async () => {
  const rows = [row("request", "user"), row("thinking", "bot", { kind: "activity" }),
    row("quiet", "bot", { quiet: true }), row("deleted", "bot", { deleted: true }),
    row("peer text", "bot", { agent: { dir: "out", peerId: "helper", peerName: "Helper" } }),
    row("Visible.", "bot"), tool()];
  const f = fixture(rows, "request", Date.now() - 100);
  f.turn.observe(); f.turn.observe();
  await until(() => f.calls.length === 1);
  assert.equal(f.calls[0].text, "Visible.");
  assert.equal(f.answer(), "Visible.");
  await f.turn.stop();
});

test("a shortened single note leaves the full stored text untouched", async () => {
  const full = "a".repeat(3_998) + "😀tail";
  const note = row("long", "bot", { text: full });
  const rows = [row("request", "user"), note, tool()];
  const f = fixture(rows, "request", Date.now() - 100);
  f.turn.observe();
  await until(() => f.calls.length === 1);
  assert.equal(f.calls[0].text, "a".repeat(3_998) + "…");
  assert.equal(note.text, full);
  await f.turn.stop();
});

test("notes are deleted before a plain error notice when no eligible reply remains", async (t) => {
  const note = row("A visible note.", "bot");
  const rows = [row("request", "user"), note, tool()];
  const f = fixture(rows, "request", Date.now() - 100);
  f.turn.observe(); await until(() => f.calls.length === 1);
  note.deleted = true;
  rows.push(row("notice", "bot", { kind: "notice", text: "The provider refused *this* request." }));
  f.turn.ended(); await f.turn.stop();
  const bodies: any[] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    f.calls.push({ method: "answer", at: Date.now() });
    return Response.json({ ok: true, result: { message_id: 8 } });
  });
  const answer = telegramReply(f.turn.answerSpan(), (text) => text);
  await send("TEST", 10101, answer.text, answer.markdown);
  assert.deepEqual(f.calls.map((c) => c.method), ["post", "remove", "answer"]);
  assert.equal(bodies[0].text, "The provider refused *this* request.");
  assert.equal("parse_mode" in bodies[0], false);
});


test("a lone final text is not a note during a delayed turn-end event", async () => {
  const rows = [row("request", "user"), tool("before"), row("Only the reply.", "bot")];
  const f = fixture(rows, "request", Date.now() - 100);
  f.turn.observe();
  await wait(80);
  assert.equal(f.calls.length, 0);
  f.turn.ended();
  assert.equal(f.answer(), "Only the reply.");
  await f.turn.stop();
});

test("a following stored tool confirms the last text, without showing its name", async () => {
  const rows = [row("request", "user"), row("Checking.", "bot")];
  const f = fixture(rows, "request", Date.now() - 100);
  f.turn.observe(); await wait(45);
  assert.equal(f.calls.length, 0);
  rows.push(tool()); f.turn.observe();
  await until(() => f.calls.length === 1);
  assert.equal(f.calls[0].text, "Checking.");
  await f.turn.stop();
});
