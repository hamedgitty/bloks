// Skills the workspace writes for itself, and never installs on its own.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ENOUGH_REPLIES,
  MAX_PROPOSALS,
  ProposalStore,
  fingerprintOf,
  parseProposal,
  reviewPrompt,
  worthReviewing,
} from "../server/proposals.ts";
import type { Turn } from "../server/context.ts";

const user = (text: string): Turn => ({ role: "user", text });
const bot = (text: string): Turn => ({ role: "assistant", text });

/** A session long enough and varied enough to clear the gate. */
const taught = (): Turn[] => [
  user("when you write a release note, always lead with what broke"),
  bot("Understood. ".repeat(40)),
  user("and put the version at the top, never at the bottom"),
  bot("Noted, I will lead with the breakage and open with the version. ".repeat(20)),
  user("do the one for 0.1.4"),
  bot("Here is the note, leading with the regression and the version. ".repeat(20)),
  user("good, that shape from now on"),
  bot("I will keep that shape. ".repeat(30)),
];

describe("deciding whether to spend a call at all", () => {
  test("an ordinary exchange is not worth reading back", () => {
    // every yes here costs the person a model call on work they did not
    // ask for, so the answer for a short chat has to be no
    const verdict = worthReviewing([user("hi"), bot("hello")], null);
    assert.equal(verdict.worth, false);
    assert.match(verdict.because, /too short/);
  });

  test("one long question and one long answer is still not a procedure", () => {
    const verdict = worthReviewing(
      [user("x".repeat(4_000)), bot("y".repeat(4_000)), bot("z".repeat(400)), bot("w".repeat(400)), bot("v".repeat(400))],
      null,
    );
    assert.equal(verdict.worth, false);
    assert.match(verdict.because, /one question/);
  });

  test("many short replies are not enough said", () => {
    const short = [user("a"), user("b"), ...Array.from({ length: 6 }, () => bot("ok"))];
    const verdict = worthReviewing(short, null);
    assert.equal(verdict.worth, false);
    assert.match(verdict.because, /too little/);
  });

  test("a session that went back and forth about how to do something is", () => {
    const verdict = worthReviewing(taught(), null);
    assert.equal(verdict.worth, true);
  });

  test("the same session is not read twice", () => {
    const turns = taught();
    const verdict = worthReviewing(turns, fingerprintOf(turns));
    assert.equal(verdict.worth, false);
    assert.match(verdict.because, /read last time/);
  });

  test("but the same session with more said in it is", () => {
    const turns = taught();
    const before = fingerprintOf(turns);
    const verdict = worthReviewing([...turns, user("also always sign it off")], before);
    assert.equal(verdict.worth, true);
  });

  test("the thresholds are knobs, so a test can be about the shape", () => {
    const two = [user("a"), user("b"), bot("x".repeat(2_000)), bot("y".repeat(2_000))];
    assert.equal(worthReviewing(two, null).worth, false);
    assert.equal(worthReviewing(two, null, { replies: 2 }).worth, true);
  });

  test("the default is four replies, and that is deliberate", () => {
    assert.equal(ENOUGH_REPLIES, 4);
  });
});

describe("the mark on what was read", () => {
  test("the same conversation marks the same", () => {
    assert.equal(fingerprintOf(taught()), fingerprintOf(taught()));
  });

  test("one more word marks differently", () => {
    assert.notEqual(fingerprintOf(taught()), fingerprintOf([...taught(), user("also this")]));
  });

  test("who said it is part of the mark", () => {
    assert.notEqual(fingerprintOf([user("same words")]), fingerprintOf([bot("same words")]));
  });

  test("nothing has a mark too, rather than throwing", () => {
    assert.equal(typeof fingerprintOf([]), "string");
  });
});

describe("what the review is asked", () => {
  test("it is told that nothing is the usual answer", () => {
    const prompt = reviewPrompt(taught(), []);
    assert.match(prompt, /Most conversations teach nothing/);
    assert.match(prompt, /NOTHING/);
  });

  test("it is shown what already exists, so it can improve rather than duplicate", () => {
    const prompt = reviewPrompt(taught(), [{ id: "release-notes", name: "Release notes" }]);
    assert.match(prompt, /release-notes/);
    assert.match(prompt, /PATCH/);
  });

  test("with nothing in the library it is not asked to patch anything", () => {
    const prompt = reviewPrompt(taught(), []);
    assert.doesNotMatch(prompt, /Skills that already exist/);
  });

  test("a very long session is cut rather than sent whole", () => {
    const huge = Array.from({ length: 400 }, () => bot("z".repeat(400)));
    assert.ok(reviewPrompt(huge, []).length < 35_000);
  });
});

describe("reading the answer back", () => {
  test("nothing means nothing", () => {
    assert.equal(parseProposal("NOTHING"), null);
    assert.equal(parseProposal("nothing worth keeping here"), null);
    assert.equal(parseProposal(""), null);
    assert.equal(parseProposal("   "), null);
  });

  test("a new skill", () => {
    const parsed = parseProposal(
      [
        "SKILL: Release notes",
        "WHEN: writing a release note",
        "WHY: they said twice to lead with what broke",
        "---",
        "Lead with what broke. Put the version at the top.",
      ].join("\n"),
    );
    assert.equal(parsed?.kind, "new");
    assert.equal(parsed?.name, "Release notes");
    assert.equal(parsed?.description, "writing a release note");
    assert.match(parsed!.because, /lead with what broke/);
    assert.match(parsed!.body, /Put the version at the top/);
    assert.equal(parsed?.skillId, undefined);
  });

  test("a change to one that exists", () => {
    const parsed = parseProposal(
      ["SKILL: Release notes", "PATCH: release-notes", "WHEN: writing one", "---", "New body."].join("\n"),
    );
    assert.equal(parsed?.kind, "patch");
    assert.equal(parsed?.skillId, "release-notes");
  });

  test("a malformed answer proposes nothing, which is the safe way to fail", () => {
    assert.equal(parseProposal("SKILL: No body follows this"), null);
    assert.equal(parseProposal("---\njust a body, no name"), null);
    assert.equal(parseProposal("here are some thoughts about your conversation"), null);
  });

  test("a missing reason still lands, with one of its own", () => {
    const parsed = parseProposal(["SKILL: Something", "---", "Do the thing."].join("\n"));
    assert.ok(parsed);
    assert.ok(parsed!.because.length > 0);
  });

  test("a patch id that is not an id cannot escape the library", () => {
    const parsed = parseProposal(
      ["SKILL: Sneaky", "PATCH: ../../etc/passwd", "---", "Body."].join("\n"),
    );
    assert.equal(parsed?.skillId, "etcpasswd");
  });

  test("a body longer than a skill may be is cut", () => {
    const parsed = parseProposal(["SKILL: Long", "---", "x".repeat(40_000)].join("\n"));
    assert.ok(parsed!.body.length <= 8_000);
  });

  test("extra dashes inside the body survive", () => {
    const parsed = parseProposal(
      ["SKILL: Dashes", "---", "First part.", "", "--- not a separator, just text", "", "Second part."].join("\n"),
    );
    assert.match(parsed!.body, /First part/);
    assert.match(parsed!.body, /Second part/);
  });
});

describe("staging, never installing", () => {
  const fresh = () => new ProposalStore(join(mkdtempSync(join(tmpdir(), "bloks-proposals-")), "proposals.json"));

  const one = (over: Partial<Parameters<ProposalStore["add"]>[0]> = {}) => ({
    kind: "new" as const,
    botId: "bot-1",
    botName: "Ivy",
    threadId: "thread-1",
    name: "Release notes",
    description: "writing one",
    body: "Lead with what broke.",
    because: "they said so twice",
    at: 1_000,
    fingerprint: "abc",
    ...over,
  });

  test("what is staged comes back", () => {
    const store = fresh();
    const staged = store.add(one());
    assert.ok(staged?.id);
    assert.equal(store.list().length, 1);
    assert.equal(store.get(staged!.id)?.name, "Release notes");
  });

  test("nothing without a name or a body is staged", () => {
    const store = fresh();
    assert.equal(store.add(one({ name: "  " })), null);
    assert.equal(store.add(one({ body: "" })), null);
    assert.equal(store.list().length, 0);
  });

  test("the same lesson read again replaces rather than stacks", () => {
    // a session reviewed again two messages later would otherwise fill
    // the panel with near-identical suggestions
    const store = fresh();
    store.add(one());
    store.add(one({ fingerprint: "def", body: "Lead with what broke, and say the version." }));
    assert.equal(store.list().length, 1);
    assert.match(store.list()[0].body, /say the version/);
  });

  test("a different lesson from the same lane is its own suggestion", () => {
    const store = fresh();
    store.add(one());
    store.add(one({ name: "Invoice triage", fingerprint: "def" }));
    assert.equal(store.list().length, 2);
  });

  test("the same name from a different lane stands on its own", () => {
    const store = fresh();
    store.add(one());
    store.add(one({ threadId: "thread-2", fingerprint: "def" }));
    assert.equal(store.list().length, 2);
  });

  test("newest first, because a suggestion goes stale", () => {
    const store = fresh();
    store.add(one({ at: 1_000, name: "Older", fingerprint: "a" }));
    store.add(one({ at: 5_000, name: "Newer", fingerprint: "b" }));
    assert.equal(store.list()[0].name, "Newer");
  });

  test("what the last review of a lane read", () => {
    const store = fresh();
    assert.equal(store.seenFor("thread-1"), null);
    store.add(one({ fingerprint: "xyz" }));
    assert.equal(store.seenFor("thread-1"), "xyz");
    assert.equal(store.seenFor("thread-9"), null);
  });

  test("suggestions do not pile up forever", () => {
    const store = fresh();
    for (let i = 0; i < MAX_PROPOSALS + 10; i++) {
      store.add(one({ name: `Skill ${i}`, fingerprint: `f${i}`, at: i }));
    }
    assert.equal(store.list().length, MAX_PROPOSALS);
  });

  test("discarding one leaves the rest", () => {
    const store = fresh();
    const a = store.add(one({ name: "A", fingerprint: "a" }))!;
    store.add(one({ name: "B", fingerprint: "b" }));
    assert.equal(store.remove(a.id), true);
    assert.equal(store.remove(a.id), false);
    assert.deepEqual(store.list().map((p) => p.name), ["B"]);
  });

  test("an agent that is gone takes its suggestions with it", () => {
    const store = fresh();
    store.add(one({ name: "Theirs", fingerprint: "a" }));
    store.add(one({ botId: "bot-2", name: "Somebody else's", fingerprint: "b", threadId: "t2" }));
    store.removeForBot("bot-1");
    assert.deepEqual(store.list().map((p) => p.name), ["Somebody else's"]);
  });

  test("what is staged survives being reopened", () => {
    const file = join(mkdtempSync(join(tmpdir(), "bloks-proposals-")), "proposals.json");
    const first = new ProposalStore(file);
    first.add(one());
    const second = new ProposalStore(file);
    assert.equal(second.list().length, 1);
    assert.equal(second.list()[0].name, "Release notes");
  });
});
