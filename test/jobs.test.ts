// Work posted to nobody in particular, and who ends up doing it.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  PASS_MARKER,
  nextFor,
  offerText,
  rankAgents,
  readClaim,
  scoreAgent,
  words,
  type Candidate,
  type Job,
} from "../server/jobs.ts";

const crew: Candidate[] = [
  {
    id: "analyst",
    name: "Ivy",
    title: "Research analyst",
    description: "Reads primary sources and writes tight briefs.",
    skills: ["Sourcing", "Summarising", "Fact checking"],
    seniority: 3,
  },
  {
    id: "marketer",
    name: "Rae",
    title: "Growth marketer",
    description: "Runs campaigns and writes landing copy.",
    skills: ["Campaigns", "Copywriting", "Experiments"],
    seniority: 3,
  },
  {
    id: "inbox",
    name: "Nel",
    title: "Inbox manager",
    description: "Triages mail and drafts routine replies.",
    skills: ["Email triage", "Drafting"],
    seniority: 2,
  },
];

const jobOf = (title: string, brief = ""): Job => ({
  id: "job-1",
  title,
  brief,
  postedAt: 1,
  state: "open",
  offers: [],
});

describe("reading a job for what it is about", () => {
  test("the words that carry meaning, and none of the ones that do not", () => {
    assert.deepEqual(words("Please help me with the quarterly campaign report"), [
      "quarterly",
      "campaign",
      "report",
    ]);
    assert.deepEqual(words(""), []);
    assert.deepEqual(words("a of to"), []);
  });
});

describe("who a job looks like it is for", () => {
  test("the role it names beats the prose it does not", () => {
    const research = jobOf("Research the market for pixel art tools");
    const ranked = rankAgents(research, crew);
    assert.equal(ranked[0].agent.id, "analyst", ranked.map((r) => `${r.agent.id}:${r.score.toFixed(2)}`).join(" "));

    const campaign = jobOf("Plan a campaign for the launch");
    assert.equal(rankAgents(campaign, crew)[0].agent.id, "marketer");

    const mail = jobOf("Triage the inbox and draft replies");
    assert.equal(rankAgents(mail, crew)[0].agent.id, "inbox");
  });

  test("a plural is the same subject as a singular", () => {
    // "campaigns" in a skill should answer a job about a "campaign"
    assert.ok(scoreAgent(jobOf("Run one campaign"), crew[1]) > 0);
    assert.ok(scoreAgent(jobOf("Write several reports"), { ...crew[0], skills: ["Report"] }) > 0);
  });

  test("everybody is still a candidate, however badly they match", () => {
    // the offer is a question, so the cost of asking the wrong agent is
    // that they say no, and excluding them costs the job entirely
    const ranked = rankAgents(jobOf("Refactor the payment module"), crew);
    assert.equal(ranked.length, 3);
    assert.ok(ranked.every((r) => r.score >= 0));
  });

  test("hidden agents and anyone who already passed are not asked", () => {
    const withHidden = [...crew, { id: "ghost", name: "Ghost", hidden: true }];
    const ranked = rankAgents(jobOf("Anything"), withHidden, ["analyst"]);
    assert.deepEqual(ranked.map((r) => r.agent.id).sort(), ["inbox", "marketer"]);
  });

  test("seniority only breaks a tie", () => {
    const a: Candidate = { id: "a", name: "A", title: "Research analyst", seniority: 1 };
    const b: Candidate = { id: "b", name: "B", title: "Research analyst", seniority: 5 };
    const job = jobOf("Research something");
    assert.ok(scoreAgent(job, b) > scoreAgent(job, a), "the senior one edges it");
    // but not enough to beat somebody who actually matches
    const junior: Candidate = { id: "c", name: "C", title: "Campaign specialist", seniority: 1 };
    assert.ok(scoreAgent(jobOf("Plan a campaign"), junior) > scoreAgent(jobOf("Plan a campaign"), b));
  });

  test("the next one to ask is the best of whoever is left", () => {
    const job = jobOf("Research the market");
    job.offers = [{ botId: "analyst", name: "Ivy", at: 1, passed: "busy" }];
    const next = nextFor(job, crew);
    assert.ok(next && next.id !== "analyst");
    job.offers.push({ botId: next!.id, name: next!.name, at: 2 });
    const third = nextFor(job, crew);
    assert.ok(third && !["analyst", next!.id].includes(third.id));
    job.offers.push({ botId: third!.id, name: third!.name, at: 3 });
    assert.equal(nextFor(job, crew), null, "when everyone has been asked, nobody is left");
  });
});

describe("what the agent is asked, and what it answers", () => {
  test("the offer says it was posted to nobody, and how to decline", () => {
    const text = offerText(jobOf("Write the launch note", "Two paragraphs, plain."));
    assert.match(text, /job board/);
    assert.match(text, /Nobody has been named/);
    assert.match(text, /Write the launch note/);
    assert.match(text, /Two paragraphs, plain\./);
    assert.match(text, new RegExp(`one line starting with ${PASS_MARKER}`));
  });

  test("a refusal is a marker at the start, and nowhere else", () => {
    assert.deepEqual(readClaim("PASS I do not write copy"), {
      taken: false,
      because: "I do not write copy",
    });
    assert.deepEqual(readClaim("PASS: not mine"), { taken: false, because: "not mine" });
    assert.deepEqual(readClaim("PASS"), { taken: false, because: "no reason given" });

    // an agent talking about passing is an agent that did the work
    const did = readClaim("I wrote the note. I nearly passed on the second draft.");
    assert.equal(did.taken, true);
    assert.match(did.taken ? did.result : "", /wrote the note/);
    assert.equal(readClaim("PASSED the file to the printer").taken, true);
  });

  test("an empty reply is still a claim, not a refusal", () => {
    // silence means the turn produced nothing, which is a job that went
    // wrong rather than an agent declining it
    assert.deepEqual(readClaim(""), { taken: true, result: "" });
  });
});
