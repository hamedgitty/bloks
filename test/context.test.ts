// How full a conversation is, and what happens when it fills.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  COMPACT_AT,
  DEFAULT_LIMIT,
  absorbPrompt,
  assembleTranscript,
  carriedVerbatim,
  compactionNotice,
  contextLimitFor,
  defragPrompt,
  estimateTokens,
  isContextError,
  needsDefrag,
  planCompaction,
  planMicro,
  pressure,
  shouldCompact,
  summaryPrompt,
  summaryTurn,
  transcriptTokens,
  type Turn,
} from "../server/context.ts";

const say = (role: Turn["role"], text: string): Turn => ({ role, text });

describe("how much a model will take", () => {
  test("the families we actually run", () => {
    assert.equal(contextLimitFor("claude-sonnet-5"), 200_000);
    assert.equal(contextLimitFor("gemini-2.5-pro"), 1_000_000);
    assert.equal(contextLimitFor("grok-4"), 131_072);
    assert.equal(contextLimitFor("gpt-4o-mini"), 128_000);
    assert.equal(contextLimitFor("deepseek-chat"), 65_536);
  });

  test("an unknown model gets a small, safe number", () => {
    // being low costs a summary sooner than needed; being high costs a
    // recoverable error. Low is the right way to be wrong.
    for (const unknown of ["something-new-1", "", null, undefined]) {
      assert.equal(contextLimitFor(unknown), DEFAULT_LIMIT);
    }
    assert.ok(DEFAULT_LIMIT < 128_000);
  });
});

describe("measuring", () => {
  test("four characters to a token, near enough to decide with", () => {
    assert.equal(estimateTokens("12345678"), 2);
    assert.equal(estimateTokens(""), 0);
    assert.equal(estimateTokens("x"), 1);
  });

  test("a transcript costs its messages plus their wrapping", () => {
    const turns = [say("user", "12345678"), say("assistant", "12345678")];
    assert.equal(transcriptTokens(turns), 2 + 4 + 2 + 4);
    assert.equal(transcriptTokens([]), 0);
  });

  test("pressure is a fraction, and never more than one", () => {
    assert.deepEqual(pressure(50, 100), { used: 50, limit: 100, fraction: 0.5 });
    assert.equal(pressure(300, 100).fraction, 1, "over full is full, not three");
    assert.equal(pressure(-5, 100).fraction, 0);
    assert.equal(pressure(10, 0).limit, DEFAULT_LIMIT, "a missing limit is not a divide by zero");
  });

  test("compaction starts late enough to be rare and early enough to fit a reply", () => {
    assert.equal(shouldCompact(79, 100), false);
    assert.equal(shouldCompact(81, 100), true);
    assert.equal(COMPACT_AT, 0.8);
    // nonsense never triggers it
    assert.equal(shouldCompact(0, 100), false);
    assert.equal(shouldCompact(50, 0), false);
    assert.equal(shouldCompact(99, 100, 0), false);
    assert.equal(shouldCompact(99, 100, 1), false);
  });
});

describe("deciding what to keep", () => {
  const conversation = (n: number): Turn[] =>
    Array.from({ length: n }, (_, i) =>
      say(i % 2 === 0 ? "user" : "assistant", `message ${i} ${"x".repeat(400)}`),
    );

  test("a short conversation folds nothing", () => {
    const turns = conversation(4);
    assert.deepEqual(planCompaction(turns, 100), { fold: [], keep: turns });
  });

  test("the end is kept, the beginning folds", () => {
    const turns = conversation(30);
    const plan = planCompaction(turns, 1_000);
    assert.ok(plan.fold.length > 0, "something should fold");
    assert.equal(plan.fold.length + plan.keep.length, turns.length, "nothing is lost");
    // what is kept is the end, in order
    assert.deepEqual(plan.keep, turns.slice(turns.length - plan.keep.length));
    assert.deepEqual(plan.fold, turns.slice(0, plan.fold.length));
  });

  test("a budget too small to keep anything still keeps the last exchange", () => {
    // a conversation that is nothing but a summary has no thread to pull
    const turns = conversation(30);
    const plan = planCompaction(turns, 1, 6);
    assert.equal(plan.keep.length, 6);
    assert.deepEqual(plan.keep, turns.slice(-6));
  });

  test("a generous budget keeps everything", () => {
    const turns = conversation(30);
    const plan = planCompaction(turns, 1_000_000);
    assert.deepEqual(plan.fold, []);
    assert.equal(plan.keep.length, 30);
  });
});

describe("the summary itself", () => {
  test("the prompt asks for what carries forward and says to drop the rest", () => {
    const prompt = summaryPrompt(null, [say("user", "ship on Friday"), say("assistant", "noted")]);
    assert.match(prompt, /ship on Friday/);
    assert.match(prompt, /Them: ship on Friday/);
    assert.match(prompt, /You: noted/);
    assert.match(prompt, /decisions made/);
    assert.match(prompt, /Drop: pleasantries/);
  });

  test("summarising again folds the previous summary in rather than beside it", () => {
    // otherwise a long conversation ends up with a stack of summaries,
    // each one a little further from what happened
    const prompt = summaryPrompt("They want it on Friday.", [say("user", "make it Monday")]);
    assert.match(prompt, /Summary so far:/);
    assert.match(prompt, /They want it on Friday\./);
    assert.match(prompt, /one summary covering both/);
  });

  test("a summary goes into the transcript marked as one", () => {
    const turn = summaryTurn("They want it on Friday.");
    assert.equal(turn.role, "assistant");
    assert.match(turn.text, /^\[Earlier in this conversation, summarised\]/);
    assert.match(turn.text, /Friday/);
  });

  test("what people are told is a statement, not an apology", () => {
    assert.match(compactionNotice(1), /the earliest message was summarised/);
    assert.match(compactionNotice(12), /the earliest 12 messages were summarised/);
    assert.match(compactionNotice(12), /Everything since is intact/);
    assert.equal(/sorry|unfortunately|error/i.test(compactionNotice(3)), false);
  });
});

describe("recognising the failure this exists to prevent", () => {
  test("the ways providers say a conversation is too big", () => {
    for (const message of [
      "This model's maximum context length is 128000 tokens, however you requested 131000",
      "context_length_exceeded",
      "Input is too long for requested model. Prompt is too long: 210000 tokens > 200000",
      "the request exceeds the model's context window",
      "too many tokens in the request",
      "Please reduce the length of the messages",
      "input length and `max_tokens` exceed context limit",
    ]) {
      assert.equal(isContextError(message), true, message);
    }
  });

  test("ordinary failures are not mistaken for it", () => {
    for (const message of [
      "401 Unauthorized",
      "connection refused",
      "the model is overloaded, try again",
      "rate limit exceeded",
      "",
      null,
      undefined,
    ]) {
      assert.equal(isContextError(message), false, String(message));
    }
  });
});

// Paying the same bill in instalments: one message absorbed per turn into
// the same running summary, instead of one large fold at a threshold.
describe("micro-compaction", () => {
  const user = (text: string): Turn => ({ role: "user", text });
  const bot = (text: string): Turn => ({ role: "assistant", text });

  /** Long enough that the tail rule is not what is being tested. */
  const conversation = (n: number): Turn[] =>
    Array.from({ length: n }, (_, i) => (i % 2 === 0 ? user(`ask ${i}`) : bot(`answer ${i}`)));

  test("the tail is never absorbed, so the end is always whole", () => {
    const turns = conversation(8);
    assert.deepEqual(planMicro(turns, 0, 8), { absorb: null, through: 0, verbatim: false });
  });

  test("one message at a time, never a batch", () => {
    // absorbing a batch would be the threshold fold again under another
    // name, and the point is that a pass does not grow with the thread
    const turns = conversation(40);
    const plan = planMicro(turns, 1, 8);
    assert.equal(plan.absorb?.text, "answer 1");
    assert.equal(plan.through, 2);
  });

  test("what the person said is stepped over, not summarised", () => {
    const turns = conversation(40);
    const plan = planMicro(turns, 0, 8);
    assert.equal(plan.absorb, null, "a user message was absorbed");
    assert.equal(plan.verbatim, true);
    assert.equal(plan.through, 1, "the cursor has to move past it to reach what follows");
  });

  test("an empty message costs nothing to step over", () => {
    const turns = [bot(""), ...conversation(40)];
    const plan = planMicro(turns, 0, 8);
    assert.equal(plan.absorb, null);
    assert.equal(plan.through, 1);
  });

  test("a cursor past the end, or before the start, settles", () => {
    const turns = conversation(40);
    assert.equal(planMicro(turns, 999, 8).through, 40);
    assert.equal(planMicro(turns, -5, 8).absorb, null);
    assert.deepEqual(planMicro([], 0, 8), { absorb: null, through: 0, verbatim: false });
  });

  test("walking the whole thread absorbs every reply and no question", () => {
    const turns = conversation(30);
    let through = 0;
    const absorbed: string[] = [];
    for (let i = 0; i < 100; i++) {
      const plan = planMicro(turns, through, 8);
      if (plan.through === through) break;
      if (plan.absorb) absorbed.push(plan.absorb.text);
      through = plan.through;
    }
    assert.equal(through, 22, "it should stop exactly at the protected tail");
    assert.ok(
      absorbed.every((t) => t.startsWith("answer")),
      "something the person said was absorbed",
    );
    assert.equal(absorbed.length, 11);
  });

  test("what is still sent whole from the absorbed part", () => {
    const turns = conversation(30);
    const carried = carriedVerbatim(turns, 0, 22);
    assert.equal(carried.length, 11);
    assert.ok(carried.every((t) => t.role === "user"));
    // order is untouched, so the summary plus these plus the rest is the
    // conversation with the agent's older replies lifted out
    assert.deepEqual(
      carried.map((t) => t.text),
      turns.slice(0, 22).filter((t) => t.role === "user").map((t) => t.text),
    );
  });

  test("only from where micro-compaction took over", () => {
    // a lane that folded the old way first has that part fully in the
    // summary already; sending those messages again would duplicate them
    const turns = conversation(30);
    const carried = carriedVerbatim(turns, 10, 22);
    assert.equal(carried.length, 6);
    assert.equal(carried[0].text, "ask 10");
  });

  test("nothing carried from a cursor at the start, or from a bad range", () => {
    assert.deepEqual(carriedVerbatim(conversation(10), 0, 0), []);
    assert.deepEqual(carriedVerbatim(conversation(10), 8, 2), []);
    assert.deepEqual(carriedVerbatim(conversation(10), -5, 0), []);
  });
});

describe("keeping the summary from becoming the problem", () => {
  test("a short summary is left alone", () => {
    assert.equal(needsDefrag("a few notes"), false);
  });

  test("a baggy one is re-summarised", () => {
    assert.equal(needsDefrag("x".repeat(9_000)), true);
  });

  test("the threshold is a knob", () => {
    assert.equal(needsDefrag("x".repeat(100), 10), true);
    assert.equal(needsDefrag("x".repeat(100), 1_000), false);
  });

  test("the defrag ask says to keep the facts and drop the scaffolding", () => {
    const prompt = defragPrompt("some notes");
    assert.match(prompt, /some notes/);
    assert.match(prompt, /dropping the repetition/);
    assert.doesNotMatch(prompt, /Newly said/);
  });
});

describe("absorbing one message", () => {
  test("the first one starts the summary rather than folding into nothing", () => {
    const prompt = absorbPrompt(null, { role: "assistant", text: "I fixed the build" });
    assert.match(prompt, /beginning of a running summary/);
    assert.doesNotMatch(prompt, /Summary so far/);
    assert.match(prompt, /I fixed the build/);
  });

  test("later ones fold into what is already there", () => {
    const prompt = absorbPrompt("They want the build fixed.", { role: "assistant", text: "Done" });
    assert.match(prompt, /Summary so far/);
    assert.match(prompt, /They want the build fixed\./);
    assert.match(prompt, /Done/);
  });

  test("a very long message is cut rather than sent whole", () => {
    const prompt = absorbPrompt(null, { role: "assistant", text: "y".repeat(60_000) });
    assert.ok(prompt.length < 25_000, "an absorb pass should stay small whatever it is absorbing");
  });
});

// A guard against the class of bug that cost a test run: a section that is
// not on the config allowlist is a section that silently will not save.
test("every config section the server writes is one saveConfig will keep", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const source = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");

  const config = source("../server/config.ts");
  const allowed = new Set(
    [...(config.match(/for \(const key of \[([\s\S]*?)\] as const\)/)?.[1] ?? "").matchAll(/"(\w+)"/g)].map(
      (m) => m[1],
    ),
  );
  assert.ok(allowed.size >= 8, "the allowlist is not where this test expects it");

  const written = [...source("../server/index.ts").matchAll(/saveConfig\(\{\s*(\w+):/g)].map((m) => m[1]);
  assert.ok(written.length > 0, "no saveConfig calls found, so this proves nothing");
  const missing = [...new Set(written)].filter(
    (key) => !allowed.has(key) && !["mcpServers", "setupDoneAt"].includes(key),
  );
  assert.deepEqual(missing, [], `these would be written and then dropped: ${missing.join(", ")}`);
});

// The conversation as the model will be given it. This is where the two
// compaction paths meet, so it is worth testing directly rather than
// through a turn.
describe("assembling what the model sees", () => {
  const user = (text: string): Turn => ({ role: "user", text });
  const bot = (text: string): Turn => ({ role: "assistant", text });
  const thread = (n: number): Turn[] =>
    Array.from({ length: n }, (_, i) => (i % 2 === 0 ? user(`ask ${i}`) : bot(`answer ${i}`)));

  test("a fresh lane is just the conversation, minus what is being answered", () => {
    const all = thread(6);
    const out = assembleTranscript(all, null, 100_000);
    assert.equal(out.turns.length, 5, "the last message is given to the driver separately");
    assert.equal(out.turns[0].text, "ask 0");
    assert.equal(out.dropped, 0);
  });

  test("a lane folded the old way opens with its summary and nothing older", () => {
    const all = thread(20);
    const out = assembleTranscript(all, { summary: "what happened before", through: 12 }, 100_000);
    assert.match(out.turns[0].text, /summarised/);
    assert.match(out.turns[0].text, /what happened before/);
    // nothing from before the cursor comes back, because the summary has it
    assert.ok(!out.turns.slice(1).some((t) => /ask [0-9]$|ask 1[01]/.test(t.text)));
  });

  test("a lane compacted as it went sends back what the person said", () => {
    const all = thread(20);
    const out = assembleTranscript(
      all,
      { summary: "notes", through: 12, microFrom: 0 },
      100_000,
    );
    const texts = out.turns.map((t) => t.text);
    assert.match(texts[0], /notes/);
    // every question from the absorbed part is here, and no answer from it
    for (const i of [0, 2, 4, 6, 8, 10]) assert.ok(texts.includes(`ask ${i}`), `lost "ask ${i}"`);
    for (const i of [1, 3, 5, 7, 9, 11]) {
      assert.ok(!texts.includes(`answer ${i}`), `"answer ${i}" should be in the summary`);
    }
  });

  test("the order is the conversation with the older replies lifted out", () => {
    const all = thread(20);
    const out = assembleTranscript(all, { summary: "notes", through: 12, microFrom: 0 }, 100_000);
    const withoutSummary = out.turns.slice(1).map((t) => t.text);
    const expected = all
      .slice(0, -1)
      .filter((t, i) => (i < 12 ? t.role === "user" : true))
      .map((t) => t.text);
    assert.deepEqual(withoutSummary, expected);
  });

  test("a lane that folded first and then compacted as it went keeps both straight", () => {
    // before microFrom the summary has everything; after it, only the
    // replies. Sending the earlier questions again would duplicate them.
    const all = thread(20);
    const out = assembleTranscript(
      all,
      { summary: "notes", through: 12, microFrom: 6 },
      100_000,
    );
    const texts = out.turns.map((t) => t.text);
    for (const i of [0, 2, 4]) assert.ok(!texts.includes(`ask ${i}`), `"ask ${i}" was sent twice`);
    for (const i of [6, 8, 10]) assert.ok(texts.includes(`ask ${i}`), `lost "ask ${i}"`);
  });

  test("what will not fit is reported rather than dropped quietly", () => {
    const all = Array.from({ length: 40 }, (_, i) =>
      i % 2 === 0 ? user("x".repeat(4_000)) : bot("y".repeat(4_000)),
    );
    const out = assembleTranscript(all, null, 2_000);
    assert.ok(out.dropped > 0, "nothing was reported as dropped, so nothing would fold");
  });

  test("an empty lane assembles to nothing rather than throwing", () => {
    assert.deepEqual(assembleTranscript([], null, 1_000), { turns: [], dropped: 0 });
    assert.deepEqual(assembleTranscript([user("only")], null, 1_000), { turns: [], dropped: 0 });
  });
});
