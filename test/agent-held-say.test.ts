// A message held at the chain limit goes with the recipient's next turn
// (GitHub 376). The hold is a record, not an alert (GitHub 302): it starts
// no turn and wakes nobody. But the words were dropped, so a finished
// handoff sat undelivered until somebody happened to read the notice. Now
// they wait on the notice, survive a restart, and the recipient's next
// turn, whatever starts it, opens with them, once.
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { heldSay, heldSaysText, MAX_HELD_SAY_CHARS, MAX_HELD_SAYS, withHeldSay } from "../server/agent-chain.ts";
import { controlledChain } from "./helpers/agent-chain.ts";
import { chainRelay } from "./helpers/chain-relay.ts";
import { waitFor } from "./helpers/turns.ts";

const HANDOFF = "Handoff complete: the example report is in the shared folder.";
const occurrences = (text: string, words: string) => text.split(words).length - 1;

test("a held message goes in with the recipient's next turn, once, and starts nothing", async (t) => {
  const f = await controlledChain(t, { agents: { turnLimit: 1 } });
  const pushes: Array<{ frames: any[]; wake: unknown }> = [];
  await chainRelay(t, f.h, pushes);
  const a = await f.hire("Alpha"), b = await f.hire("Bravo");
  // Bravo's turn, started by Alpha, is at the limit; its handoff back is held
  const at = await f.depth(a, b, 1);
  assert.equal(at.bot.id, b.id);
  const before = f.turns().length;
  const res = await f.agent(at.turn, `/api/bots/${a.id}/messages`, { text: HANDOFF });
  assert.equal(res.status, 429);
  const told = (await res.json()).error as string;
  assert.match(told, /^Alpha did not get this message: agents reached the limit of 1 consecutive turn\./);
  assert.match(told, /kept for Alpha's next turn, whenever something else starts one; it does not start one\./);
  await f.finish(at.turn, b);

  // nothing started, nothing woke, and the words wait on the notice
  await sleep(1_000);
  assert.equal(f.turns().length, before, "the held message started a turn");
  const notice = (await f.messages(a)).find((m) => m.chainHeld);
  assert.ok(notice, "no hold notice in the recipient's conversation");
  assert.equal(notice.heldSays?.length, 1);
  assert.equal(notice.heldSays[0].text, HANDOFF);
  assert.equal(notice.heldSays[0].name, "Bravo");
  assert.equal(notice.heldSays[0].delivered, undefined);
  assert.ok(!(await f.messages(a)).some((m) => m.role === "user" && m.text === HANDOFF), "the held message was delivered as a message");
  const pushed = await waitFor(() => pushes.find((p) => p.frames.some((frame) => frame.message?.id === notice.id)));
  assert.ok(pushed);
  assert.equal(pushed.wake, undefined, "the hold woke the phone");

  // kept across a restart
  await f.restart();
  assert.equal(f.turns().length, before, "a restart started a turn for the held message");

  // the person's next words to Alpha, for another reason entirely
  const next = await f.begin(a, "Please summarise the week.");
  assert.equal(occurrences(next.text, HANDOFF), 1, "the next turn did not carry the held message exactly once");
  assert.match(next.text, /held at the limit of consecutive agent turns/);
  assert.match(next.text, /did not start this turn/);
  assert.match(next.text, /From Bravo at /);
  assert.ok(next.text.indexOf(HANDOFF) < next.text.indexOf("Please summarise the week."));
  await f.finish(next, a);
  const marked = (await f.messages(a)).find((m) => m.id === notice.id);
  assert.equal(typeof marked?.heldSays?.[0].delivered, "number", "the held message was not marked delivered");
  assert.equal(marked.text, notice.text, "delivery rewrote the person's notice");

  // and never again
  const later = await f.begin(a, "Anything else today?");
  assert.equal(occurrences(later.text, HANDOFF), 0, "a later turn heard the held message again");
  await f.finish(later, a);
  const quiet = pushes.filter((p) => p.frames.some((frame) => frame.message?.id === notice.id));
  assert.ok(quiet.every((p) => p.wake === undefined), "marking the held message delivered woke the phone");
});

test("held messages are kept whole up to a bound, newest last, and said with sender and time", () => {
  const long = "x".repeat(MAX_HELD_SAY_CHARS + 25);
  const cut = heldSay({ botId: "b1", name: "Bravo" }, long, 1_000);
  assert.equal(cut.text.length, MAX_HELD_SAY_CHARS);
  assert.equal(cut.cut, 25);
  const whole = heldSay({ botId: "b1", name: "Bravo" }, HANDOFF, 2_000);
  assert.equal(whole.cut, undefined);
  let held = withHeldSay(undefined, whole);
  for (let i = 0; i < MAX_HELD_SAYS + 5; i++) held = withHeldSay(held, heldSay({ botId: "c1", name: "Charlie" }, `Note ${i}`, 3_000 + i));
  assert.equal(held.length, MAX_HELD_SAYS);
  assert.equal(held.at(-1)?.text, `Note ${MAX_HELD_SAYS + 4}`);
  const text = heldSaysText([whole, cut], (at) => `t${at}`);
  assert.match(text, /^\(2 messages to you were held/);
  assert.ok(text.includes(`From Bravo at t2000:\n${HANDOFF}`));
  assert.ok(text.includes("[25 more characters were left out]"));
  assert.match(heldSaysText([whole], String), /^\(A message to you was held/);
});
