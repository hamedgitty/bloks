import assert from "node:assert/strict";
import { test } from "node:test";
import { codexItemText, codexTextFor, itemProgress, progressIds } from "../server/codex-text.ts";
import { foldTurns, foldRoom, type Folded } from "../src/lib/turnFold.ts";
import { noticeFor } from "../src/lib/notify.ts";
import type { Message } from "../src/state/reducer.ts";

const text = (id: string, phase = "commentary", turnId = "turn-a", extra: Partial<Message> = {}): Message => ({ id, at: 1, role: "bot", kind: "text", text: id, codexText: codexTextFor({ phase, questions: "none" }, turnId, id, "agent"), ...extra });
const ask: Message = { id: "ask", at: 0, role: "user", kind: "text", text: "Check the sample", agent: { dir: "in", peerId: "peer", peerName: "Peer" } };
const page = (f: Folded) => f.rows.flatMap((r) => r.kind === "fold" ? ["work(" + r.fold.messages.map((m) => m.id).join(",") + ")"] : r.items.map((m) => m.message.id));

test("live progress is expandable work, the last progress is never the result", () => {
  const history = [ask, text("first"), text("last")];
  assert.deepEqual(page(foldTurns(history, true)), ["ask", "work(first,last)"]);
  assert.deepEqual(page(foldTurns(history, false)), ["work(ask,first)", "last"]);
  assert.equal(itemProgress(history[2]), true, "terminal presentation did not change item-time attention");
});

test("an async final followed by commentary keeps the final result and trailing progress quiet", () => {
  const history = [ask, text("answer", "final_answer"), text("after")];
  assert.deepEqual(page(foldTurns(history, false)), ["work(ask,after)", "answer"]);
  assert.deepEqual([...progressIds(history, () => false)], ["after"]);
});

test("accepted person join reveals the entire running turn, queued and agent inputs do not", () => {
  const join: Message = { id: "join", at: 2, role: "user", kind: "text", text: "Use the second option", midTurn: true, joinedTurnId: "turn-a" };
  const history = [ask, text("before"), join, text("after")];
  assert.deepEqual(page(foldTurns(history, true)), ["ask", "before", "join", "after"]);
  assert.deepEqual([...progressIds(history.map((m) => m.id === "join" ? { ...m, queued: true } : m), () => true)], ["before", "after"]);
  assert.deepEqual([...progressIds(history.map((m) => m.id === "join" ? { ...m, agent: ask.agent } : m), () => true)], ["before", "after"]);
  assert.deepEqual([...progressIds(history.map((m) => m.id === "join" ? { ...m, joinedTurnId: "another-turn" } : m), () => true)], ["before", "after"]);
});

test("final, partial, unknown and explicit questions use existing live and GitHub257 visibility", () => {
  for (const phase of ["final_answer", "partial_answer", "future_phase"]) assert.equal(itemProgress(text("x", phase)), false);
  const q = text("question", "commentary", "turn-a", { text: "Which option should I use?", codexText: codexTextFor({ phase: "commentary", questions: "present" }, "turn-a", "question", "agent") });
  const history = [ask, q, text("later")];
  assert.deepEqual(page(foldTurns(history, true)), ["ask", "question", "work(later)"]);
  assert.deepEqual(page(foldTurns([...history, text("final", "final_answer")], false)), ["work(ask,question,later)", "final"], "existing completed-turn fold retained");
});

test("legacy QA067 reply and person-started text keep existing visibility", () => {
  const legacy = text("question", "commentary", "turn-a", { codexText: undefined, agent: { dir: "reply", peerId: "peer", peerName: "Peer" } });
  assert.deepEqual(page(foldTurns([ask, legacy], false)), ["work(ask)", "question"]);
  const person: Message = { ...ask, agent: undefined };
  const first = text("first", "commentary", "turn-a", { codexText: codexTextFor({ phase: "commentary", questions: "none" }, "turn-a", "first", "person") });
  assert.deepEqual(page(foldTurns([person, first, { ...legacy, id: "last" }], true)), ["ask", "first", "last"]);
  assert.deepEqual(page(foldTurns([person, first, { ...legacy, id: "last" }], false)), ["ask", "work(first)", "last"]);
});

test("restart/interruption and later attempts derive fallback, without mutating history", () => {
  const history = [ask, text("old"), text("new", "commentary", "turn-b")];
  const before = JSON.stringify(history);
  assert.deepEqual([...progressIds(history, () => true)], ["new"]);
  assert.deepEqual([...progressIds(history, () => false)], []);
  assert.deepEqual([...progressIds(history, () => true, false)], [], "partial tail is conservatively full");
  assert.equal(JSON.stringify(history), before);
  const emptyFinal = text("empty", "final_answer", "turn-a", { text: "  " });
  assert.deepEqual([...progressIds([text("last"), emptyFinal], () => false)], []);
});

test("room speakers stay isolated and progress uses work while the room is active", () => {
  const a = text("a", "commentary", "a", { from: "one" });
  const b = text("b", "commentary", "b", { from: "two" });
  assert.deepEqual(page(foldRoom([a, b], new Map([["one", 0], ["two", 0]]))), ["work(a)", "work(b)"]);
  assert.deepEqual([...progressIds([a, b], (m) => m.from === "one")], ["a"]);
});

test("progress causes no banner, including a mention; cards and full text retain policy", () => {
  const ctx = { focused: false, selectedId: "elsewhere", threadId: "lane", bot: { id: "bot", name: "Helper", notifications: true } };
  assert.equal(noticeFor(text("@you progress"), ctx), null);
  assert.ok(noticeFor(text("answer", "final_answer"), ctx));
  assert.ok(noticeFor({ ...text("card"), kind: "options", card: { requestId: "question" } }, ctx));
});

test("missing/malformed/new-version metadata and every other origin stay conservative", () => {
  for (const item of [{ phase: "commentary" }, { phase: "x".repeat(65), questions: null }, { phase: "commentary", questions: {} }]) assert.equal(codexTextFor(codexItemText(item), "turn", "item", "agent")?.display, "full");
  for (const origin of ["person", "other", "unknown"] as const) assert.equal(codexTextFor(codexItemText({ phase: "commentary", questions: null }), "t", "i", origin)?.display, "full");
  assert.equal(codexTextFor(codexItemText({ phase: "commentary", questions: null }), "", "i", "agent"), undefined);
  const invalid = text("invalid"); invalid.codexText = { ...invalid.codexText!, v: 2 } as never; assert.equal(itemProgress(invalid), false);
});


test("a new accepted input with no assistant item cannot re-hide the previous terminal fallback", () => {
  const next: Message = { id: "next", at: 3, role: "user", kind: "text", text: "Another request" };
  assert.deepEqual(page(foldTurns([ask, text("old-last"), next], true)), ["work(ask)", "old-last", "next"]);
});
