// The parts of `bloks quiet` that need no server (server/quiet-finish.ts,
// TextPreview.close): which writes belong to the finished turn, whose words
// are still on their way into it, and what the preview shows after it.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { RuntimeEvent } from "../server/contracts.ts";
import { belongs, SteerHolds, writer, type QuietGate } from "../server/quiet-finish.ts";
import type { Message } from "../server/store.ts";
import { TextPreview } from "../server/text-preview.ts";

const gate: QuietGate = { seq: 3, turnId: "turn-3", state: "accepted", checked: [], rows: [], hidden: [] };
const row = (fields: Partial<Message> = {}) => ({ id: "m", role: "bot", kind: "text", text: "Done.", at: 1, ...fields }) as Message;

test("a write belongs to the finished turn only by its runtime turn or its turn's credential", () => {
  assert.equal(belongs(gate, "lane", row(), { lane: "lane", turnId: "turn-3" }), true);
  assert.equal(belongs(gate, "lane", row(), { lane: "lane", seq: 3 }), true);
  assert.equal(belongs(gate, "lane", row(), { lane: "lane", turnId: "turn-2" }), false, "an earlier turn's event");
  assert.equal(belongs(gate, "lane", row(), { lane: "lane", seq: 2 }), false, "an earlier turn's credential");
  assert.equal(belongs(gate, "lane", row(), { lane: "lane" }), false, "the lane alone");
  assert.equal(belongs(gate, "lane", row(), undefined), false, "a write from nowhere in particular");
  assert.equal(belongs(gate, "lane", row(), { lane: "other", seq: 3 }), false, "another lane's turn");
  assert.equal(belongs(gate, "lane", row({ role: "user" }), { lane: "lane", seq: 3 }), false, "the person's words");
  assert.equal(belongs(gate, "lane", row({ queued: true }), { lane: "lane", seq: 3 }), false, "words waiting for a later turn");
});

test("each request or event is its own writer, and none outlives its callback", async () => {
  assert.equal(writer.getStore(), undefined);
  const seen: unknown[] = [];
  await Promise.all([
    writer.run({ lane: "a", seq: 1 }, async () => { await new Promise((r) => setTimeout(r, 20)); seen.push(writer.getStore()); }),
    writer.run({ lane: "b", turnId: "t" }, async () => { await new Promise((r) => setTimeout(r, 5)); seen.push(writer.getStore()); }),
    writer.run(undefined, async () => { await new Promise((r) => setTimeout(r, 10)); seen.push(writer.getStore()); }),
  ]);
  assert.deepEqual(seen, [{ lane: "b", turnId: "t" }, undefined, { lane: "a", seq: 1 }]);
  writer.run({ lane: "a", seq: 1 }, () => writer.run({ lane: "a", turnId: "t" }, () => assert.deepEqual(writer.getStore(), { lane: "a", turnId: "t" })));
  assert.equal(writer.getStore(), undefined, "nothing is left bound after the callbacks return");
});

test("words on their way into a turn hold its finish until they settle, and only in that turn", () => {
  const holds = new SteerHolds();
  assert.equal(holds.refusal("lane", 3), null);
  holds.hold("lane", 3);
  holds.hold("lane", 3);
  assert.equal(holds.refusal("lane", 3), "input_arriving");
  holds.release("lane", 3);
  assert.equal(holds.refusal("lane", 3), "input_arriving", "one is still on its way");
  holds.release("lane", 3);
  assert.equal(holds.refusal("lane", 3), null);
  holds.hold("lane", 3);
  holds.hold("lane", 4);
  assert.equal(holds.refusal("lane", 4), "input_arriving", "a later turn counts its own");
  holds.release("lane", 3);
  holds.taint("lane", 3);
  assert.equal(holds.refusal("lane", 4), "input_arriving", "an earlier turn's settle changes nothing of it");
  holds.taint("lane", 4);
  holds.release("lane", 4);
  assert.equal(holds.refusal("lane", 4), "input_uncertain", "a steer that threw may have arrived");
  assert.equal(holds.refusal("lane", 5), null, "the next turn starts clean");
  assert.equal(holds.refusal("other", 4), null);
});

const base = { provider: "fixture", threadId: "lane", turnId: "turn", eventId: "event", createdAt: "2026-01-01T00:00:00Z" };
const event = (fields: Record<string, unknown>) => ({ ...base, ...fields }) as RuntimeEvent;
const chunk = (p: TextPreview, text: string, fields = {}) => p.delta(event({ type: "content.delta", streamKind: "assistant_text", delta: text, ...fields }) as Extract<RuntimeEvent, { type: "content.delta" }>, true);
const words = (e: RuntimeEvent | null) => (e?.type === "content.delta" ? e.delta : "");

test("a closed preview shows nothing more of its turn until it is reopened", () => {
  const p = new TextPreview();
  p.start(event({ type: "turn.started" }));
  assert.equal(p.turnOf("lane"), "turn");
  assert.equal(chunk(p, "QUI"), null, "a possible quiet word is held");
  p.close("lane", "other-turn");
  assert.equal(words(chunk(p, "ET is a word")), "QUIET is a word", "a close for another turn changes nothing");
  p.close("lane", "turn");
  assert.equal(chunk(p, "More words."), null);
  assert.equal(chunk(p, "And more.", { itemId: "second" }), null);
  p.reopen("lane", "other-turn");
  assert.equal(chunk(p, "Still closed."), null);
  p.reopen("lane", "turn");
  assert.equal(words(chunk(p, "Shown again.", { itemId: "third" })), "Shown again.");
});
