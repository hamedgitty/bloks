// Reading a message sent while the agent is mid-turn (server/delivery.ts):
// the rules, the modes, the person's one tap, the small model's answer
// and the lines that say what happened.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  classify,
  deliveryLine,
  deliveryMode,
  endsOnQuestion,
  modelPrompt,
  plan,
  previewLine,
  readModelAnswer,
  resolveMode,
} from "../server/delivery.ts";

const route = (text: string, asked = false) => {
  const read = classify(text, { asked });
  return `${read.route}:${read.why}`;
};

describe("reading the words", () => {
  test("a short stop stops", () => {
    for (const text of ["stop", "STOP!", "ok stop", "please stop now", "cancel that", "never mind", "nvm", "forget it", "Abort."]) {
      assert.equal(route(text), "stop:stop", text);
    }
  });

  test("a stop that is not one", () => {
    // a person telling it to carry on: words for the turn, not a brake
    assert.equal(route("don't stop"), "now:correction");
    assert.equal(route("no need to cancel"), "queue:other");
    // long, and an instruction: a change of course rather than a brake
    assert.equal(route("cancel the dinner booking and book the 8pm one instead"), "now:correction");
  });

  test("wait and hold on go in now", () => {
    for (const text of ["wait", "Wait, that's the wrong folder", "hold on a sec", "hang on", "one sec", "whoa"]) {
      assert.equal(route(text), "now:wait", text);
    }
  });

  test("corrections go in now", () => {
    for (const text of [
      "no, the other folder",
      "Nope, use pnpm",
      "actually make it blue",
      "Instead, write it in Go",
      "use the staging database instead",
      "I meant the 2024 report",
      "scratch that",
      "don't touch the tests",
      "that's not what I asked for",
      "‘actually’ use the other one",
    ]) {
      assert.equal(route(text), "now:correction", text);
    }
  });

  test("a no that is only politeness is not a correction", () => {
    assert.equal(route("no worries, also check the logs"), "queue:other");
    assert.equal(route("No rush, but can you add a README too"), "queue:later");
  });

  test("words that say after the work wait, even beside a correction word", () => {
    for (const text of [
      "when you're done, book the table",
      "Also, once you're finished can you update the docs",
      "actually, after that, send me a summary",
      "by the way the meeting moved",
      "btw add tests",
    ]) {
      assert.equal(route(text), "queue:later", text);
    }
  });

  test("urgent words go in now", () => {
    for (const text of ["this is urgent: the site is down", "need this ASAP", "do it right now", "check prod immediately", "the build is broken!!"]) {
      assert.equal(route(text), "now:urgent", text);
    }
  });

  test("a short reply to a question the agent just asked is its answer", () => {
    assert.equal(route("the second one", true), "now:answer");
    assert.equal(route("yes", true), "now:answer");
    // not when nothing was asked, and not a question back
    assert.equal(route("the second one", false), "queue:other");
    assert.equal(route("which one is faster?", true), "queue:other");
    assert.equal(route("x".repeat(400), true), "queue:other");
  });

  test("everything else waits, and says the rules were not sure", () => {
    const read = classify("also write a blog post about it");
    assert.deepEqual(read, { route: "queue", why: "other", sure: false });
    assert.deepEqual(classify("   "), { route: "queue", why: "other", sure: false });
  });

  test("what counts as the agent asking", () => {
    assert.equal(endsOnQuestion("I found two configs.\nWhich one should I use?"), true);
    assert.equal(endsOnQuestion("Should I go ahead? **"), true);
    assert.equal(endsOnQuestion("Done. Tests pass."), false);
    assert.equal(endsOnQuestion("Is it? I checked, it is."), false);
    assert.equal(endsOnQuestion(undefined), false);
  });
});

describe("the modes and the one tap", () => {
  test("automatic reads the words", () => {
    assert.equal(plan("auto", "no, the other one").route, "now");
    assert.equal(plan("auto", "also add a chart").route, "queue");
    assert.equal(plan("auto", "stop").route, "stop");
  });

  test("interrupt sends everything in now, and a stop still stops", () => {
    assert.deepEqual(plan("interrupt", "also add a chart"), { route: "now", why: "setting", sure: true });
    assert.deepEqual(plan("interrupt", "no, the other one"), { route: "now", why: "correction", sure: true });
    assert.equal(plan("interrupt", "stop").route, "stop");
  });

  test("queue waits, whatever the words", () => {
    assert.deepEqual(plan("queue", "no, stop, the other one"), { route: "queue", why: "setting", sure: true });
    assert.equal(plan("queue", "stop").route, "queue");
  });

  test("the person's tap outranks the mode and the words", () => {
    assert.deepEqual(plan("queue", "also add a chart", {}, "now"), { route: "now", why: "you", sure: true });
    assert.deepEqual(plan("interrupt", "no, the other one", {}, "wait"), { route: "queue", why: "you", sure: true });
    assert.deepEqual(plan("auto", "stop", {}, "wait"), { route: "queue", why: "you", sure: true });
  });

  test("a mode is read safely, the agent's before the workspace's", () => {
    assert.equal(resolveMode(undefined, undefined), "auto");
    assert.equal(resolveMode("queue", "interrupt"), "queue");
    assert.equal(resolveMode(undefined, "interrupt"), "interrupt");
    assert.equal(resolveMode("sometimes", "nonsense"), "auto");
    assert.equal(deliveryMode("queue"), "queue");
    assert.equal(deliveryMode(null), undefined);
  });
});

describe("the small model", () => {
  test("its answer is one word, and anything else is no answer", () => {
    assert.equal(readModelAnswer("NOW"), "now");
    assert.equal(readModelAnswer(" wait.\n"), "wait");
    assert.equal(readModelAnswer("Now, because it changes the task"), "now");
    assert.equal(readModelAnswer("I think it should wait"), null);
    assert.equal(readModelAnswer(""), null);
  });

  test("the question carries the message and only the end of what the agent said", () => {
    const prompt = modelPrompt("swap to postgres", "a".repeat(2000) + "Should I use sqlite?");
    assert.match(prompt, /NOW or WAIT/);
    assert.match(prompt, /swap to postgres/);
    assert.match(prompt, /Should I use sqlite\?/);
    assert.ok(prompt.length < 2200);
  });
});

describe("what the person is told", () => {
  test("after", () => {
    assert.equal(deliveryLine("queued", "other", "Research Analyst"), "Queued until Research Analyst finishes");
    assert.equal(deliveryLine("steered", "correction", "Ivy"), "Taken as your correction, read after the current step");
    assert.equal(deliveryLine("steered", "answer", "Ivy"), "Taken as your answer, read after the current step");
    assert.equal(deliveryLine("steered", "urgent", "Ivy"), "Sounded urgent, read after the current step");
    assert.equal(deliveryLine("steered", "you", "Ivy"), "Sent now, read after the current step");
    assert.equal(deliveryLine("stopped", "stop", "Ivy"), "Stopped Ivy");
    assert.equal(deliveryLine("stopped", "correction", "Ivy"), "Stopped Ivy to take your correction");
  });

  test("before, saying how the engine will take it", () => {
    assert.equal(previewLine("queue", "other", "Ivy", true), "Will wait until Ivy finishes");
    assert.equal(previewLine("now", "correction", "Ivy", true), "Will take your correction after the current step");
    assert.equal(previewLine("now", "correction", "Ivy", false), "Will stop Ivy to take your correction");
    assert.equal(previewLine("stop", "stop", "Ivy", true), "Will stop Ivy");
    assert.equal(previewLine("now", "you", "Ivy", true), "Goes into Ivy's turn after the current step");
    assert.equal(previewLine("now", "urgent", "Ivy", true), "Will take this after the current step, as urgent");
  });

  test("no dashes in anything said", () => {
    const said = [
      deliveryLine("queued", "other", "A"), deliveryLine("steered", "wait", "A"), deliveryLine("stopped", "you", "A"),
      previewLine("now", "urgent", "A", true), previewLine("queue", "you", "A", false), modelPrompt("x", "y"),
    ].join(" ");
    assert.doesNotMatch(said, /[\u2013\u2014]/);
  });
});
