// An agent's own past, and what agents know about the person.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import { allows } from "../server/agent-cli.ts";
import { cleanNote, MAX_SUGGESTED, noteBriefing, ProfileNotes } from "../server/profile-notes.ts";
import { recall, recallText, termsOf, type RecallSource, type Speaker } from "../server/recall.ts";
import { startHarness, type Harness } from "./helpers/server.ts";

const source = (threadId: string, where: string, lines: Array<[string, string, boolean?]>) => ({
  threadId,
  where,
  messages: lines.map(([role, text, deleted], i) => ({
    id: `${threadId}-${i}`,
    at: 1_000 + i,
    role: role as "user" | "bot",
    kind: "text",
    text,
    ...(deleted ? { deleted: true } : {}),
  })),
});
const name = (m: { role: string }): Speaker =>
  m.role === "user" ? { who: "Hamed", by: "person" } : { who: "Scout", by: "self", agentId: "b1" };

describe("recall", () => {
  const past = [
    source("dm", "your conversation \"General\"", [
      ["user", "Which printer vendor did we pick for the stickers?"],
      ["bot", "We went with Sticker Mule, the second quote, because of the Friday delivery."],
      ["user", "Great, and keep the budget under 400."],
      ["bot", "Old plan: Moo for business cards.", true],
    ]),
    source("room", "room Launch", [["bot", "The launch moved to Friday after the vendor slipped."]]),
  ];

  test("words in any order, with what was said just before", () => {
    const hits = recall("vendor stickers", past, name);
    assert.equal(hits[0].messageId, "dm-0");
    const decided = recall("sticker mule delivery", past, name)[0];
    assert.match(decided.text, /Sticker Mule/);
    assert.equal(decided.before?.who, "Hamed");
    assert.match(decided.before!.text, /printer vendor/);
  });

  test("rewound and taken back messages are not remembered", () => {
    assert.equal(recall("moo business cards", past, name).length, 0);
  });

  test("filler words do not count, and nothing matching says so", () => {
    assert.deepEqual(termsOf("what did we decide about the budget?"), ["decid", "budget"]);
    assert.match(recallText([], "unicorns"), /Nothing in your past conversations matches "unicorns"/);
    assert.match(recallText(recall("budget", past, name), "budget"), /Hamed: Great, and keep the budget under 400/);
  });

  test("another agent's words are never the person's (GitHub 136)", () => {
    const sources: RecallSource[] = [
      {
        threadId: "lane",
        where: 'your conversation "General"',
        messages: [
          { id: "m1", at: 1, role: "user", kind: "text", text: "Zebra report: the client agreed to the new price.", agent: { dir: "in", peerId: "alpha-1", peerName: "Alpha" } },
          { id: "m2", at: 2, role: "user", kind: "text", text: "Yes, go with the zebra price." },
          { id: "m3", at: 3, role: "user", kind: "text", text: "Zebra looks fine to me too.", author: "member-1" },
        ],
      },
    ];
    const speakerOf = (m: RecallSource["messages"][number]): Speaker =>
      m.agent ? { who: m.agent.peerName, by: "agent", agentId: m.agent.peerId } : m.author ? { who: "Dana", by: "member" } : { who: "Hamed", by: "person" };
    const hits = recall("zebra", sources, speakerOf);
    const byId = Object.fromEntries(hits.map((h) => [h.messageId, h]));
    assert.deepEqual([byId.m1.by, byId.m1.agentId, byId.m1.who], ["agent", "alpha-1", "Alpha"]);
    assert.equal(byId.m2.by, "person");
    assert.equal(byId.m3.by, "member");
    assert.equal(byId.m2.before?.by, "agent", "context lines are labelled too");
    const text = recallText(hits, "zebra");
    assert.match(text, /Alpha \(another agent, alpha-1\): Zebra report/);
    assert.match(text, /Dana \(a member of the room\): Zebra looks fine/);
    assert.match(text, /, Hamed: Yes, go with the zebra price/);
  });
});

describe("notes about the person", () => {
  const fresh = () => new ProfileNotes(join(mkdtempSync(join(tmpdir(), "bloks-notes-")), "notes.json"));
  const scout = { id: "b1", name: "Scout" };

  test("a suggestion waits for the person, and the same fact is not suggested twice", () => {
    const notes = fresh();
    const note = notes.suggest("Prefers bullet points.", scout)!;
    assert.equal(note.state, "suggested");
    assert.equal(notes.prompt(), null, "nothing reaches agents until it is kept");
    assert.equal(notes.suggest("prefers bullet-points", scout), null);
    notes.keep(note.id, "Likes short answers with bullet points");
    assert.match(notes.prompt()!, /- Likes short answers with bullet points/);
  });

  test("an agent that suggests too much is stopped", () => {
    const notes = fresh();
    for (let i = 0; i < MAX_SUGGESTED; i++) assert.ok(notes.suggest(`fact number ${i}`, scout));
    assert.equal(notes.suggest("one more", scout), null);
  });

  test("gone agents take their open suggestions, not what you kept", () => {
    const notes = fresh();
    const kept = notes.suggest("Works in Toronto time", scout)!;
    notes.keep(kept.id);
    notes.suggest("Likes tea", scout);
    notes.forgetSuggestionsBy("b1");
    assert.deepEqual(notes.list().map((n) => n.text), ["Works in Toronto time"]);
  });

  test("notes are cleaned, and agents are told how to suggest them", () => {
    assert.equal(cleanNote("  - uses   metric  "), "uses metric");
    assert.match(noteBriefing("node bloks.mjs"), /node bloks\.mjs note/);
    assert.match(noteBriefing(null), /note_about_person/);
  });

  test("an agent can suggest and recall, and cannot keep or remove", () => {
    assert.equal(allows("me", "POST", "/api/bots/me/notes").ok, true);
    assert.equal(allows("me", "GET", "/api/bots/me/recall").ok, true);
    assert.equal(allows("me", "GET", "/api/bots/other/recall").ok, false);
    assert.equal(allows("me", "POST", "/api/profile/notes/x/keep").ok, false);
    assert.equal(allows("me", "DELETE", "/api/profile/notes/x").ok, false);
  });
});

describe("through the server", () => {
  let h: Harness;
  before(async () => {
    h = await startHarness();
  });
  after(() => h.stop());

  test("notes: suggest, keep, add, remove", async () => {
    const { bots } = await h.json("/api/bots");
    const said = await h.json(`/api/bots/${bots[0].id}/notes`, { method: "POST", body: JSON.stringify({ text: "Signs off as H" }) });
    assert.match(said.result, /Suggested/);
    let { notes } = await h.json("/api/profile/notes");
    const suggestion = notes.find((n: any) => n.text === "Signs off as H");
    assert.equal(suggestion.state, "suggested");
    await h.fetch(`/api/profile/notes/${suggestion.id}/keep`, { method: "POST", body: JSON.stringify({ text: "Signs emails as H." }) });
    const added = await h.fetch("/api/profile/notes", { method: "POST", body: JSON.stringify({ text: "Timezone is Toronto" }) });
    assert.equal(added.status, 201);
    ({ notes } = await h.json("/api/profile/notes"));
    assert.deepEqual(
      notes.filter((n: any) => n.state === "kept").map((n: any) => n.text).sort(),
      ["Signs emails as H.", "Timezone is Toronto"],
    );
    const gone = await h.fetch(`/api/profile/notes/${suggestion.id}`, { method: "DELETE" });
    assert.equal(gone.status, 200);
  });

  test("recall: an agent finds what was said in its conversations", async () => {
    const { bots } = await h.json("/api/bots");
    const res = await h.json(`/api/bots/${bots[0].id}/recall?q=${encodeURIComponent("tell me what you need")}`);
    assert.ok(Array.isArray(res.hits));
    assert.ok(res.hits.some((hit: any) => /what you need/i.test(hit.text)), "the greeting is found");
  });
});

describe("Mac voices", () => {
  test("the real voices are offered, the novelty ones are not", async () => {
    const { parseSayVoices } = await import("../server/speech.ts");
    const listing = [
      "Samantha            en_US    # Hello! My name is Samantha.",
      "Bad News            en_US    # The light you see at the end of the tunnel.",
      "Eddy (English (UK)) en_GB    # Hello! My name is Eddy.",
      "Alice               it_IT    # Ciao! Mi chiamo Alice.",
    ].join("\n");
    assert.deepEqual(parseSayVoices(listing).map((v) => v.id), ["Samantha", "Eddy (English (UK))"]);
    assert.equal(parseSayVoices(listing)[0].provider, "system");
  });
});
