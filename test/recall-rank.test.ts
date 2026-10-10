// How recall ranks: rare words over common ones, a word said again
// counting for less each time, long messages not winning by length, a
// little for being recent, more for words side by side, and folded words
// finding each other. Then the index itself: grown in place, dropped on
// an edit, held to a budget, and fast on a long history.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { recall, indexMemory, memoryPieces, type RecallSource, type Speaker } from "../server/recall.ts";
import { closeness, excerpt, IndexCache, queryTerms, rank, stem, TermIndex } from "../server/recall-index.ts";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 10);
const speaker = (m: { role: string }): Speaker => (m.role === "user" ? { who: "Hamed", by: "person" } : { who: "Scout", by: "self", agentId: "b1" });

/** One conversation, oldest first; each line is [text, days ago]. */
const lane = (threadId: string, lines: Array<[string, number]>): RecallSource => ({
  threadId,
  where: `your conversation "${threadId}"`,
  messages: lines.map(([text, ago], i) => ({ id: `${threadId}-${i}`, at: NOW - ago * DAY, role: i % 2 ? "bot" : "user", kind: "text", text })),
});

/** Messages nobody is looking for, so the words that matter are rare. */
const filler = (n: number): Array<[string, number]> =>
  Array.from({ length: n }, (_, i) => [`Daily standup ${i}: launch prep is on track and the printer works.`, 40 + i]);

describe("ranking", () => {
  test("plurals and -ing and -ed forms find each other", () => {
    assert.equal(stem("vendors"), stem("vendor"));
    assert.equal(stem("planning"), stem("planned"));
    assert.equal(stem("planned"), stem("plan"));
    assert.equal(stem("making"), stem("make"));
    assert.equal(stem("companies"), stem("company"));
    assert.equal(stem("boxes"), stem("box"));
    assert.equal(stem("agreed"), stem("agree"));
    // and words that only look like it keep their own
    assert.equal(stem("need"), "need");
    assert.equal(stem("status"), "status");
    assert.equal(stem("thing"), "thing");
    assert.equal(stem("added"), stem("add"));

    const past = [lane("dm", [["We planned the vendor shortlist on Monday.", 3]])];
    const hits = recall("planning vendors", past, speaker);
    assert.equal(hits[0]?.messageId, "dm-0", "the old matcher wanted the exact letters");
  });

  test("small words are not matched on, and file names keep their parts", () => {
    assert.deepEqual(queryTerms("what did we decide about the budget?"), [stem("decide"), "budget"]);
    const terms = queryTerms("the follow-up on server/index.ts");
    assert.ok(terms.includes("follow-up") && terms.includes("follow"));
    assert.ok(terms.includes("server/index.ts") && terms.includes("index"));
  });

  test("a rare word counts for more than a common one", () => {
    const past = [
      lane("dm", [
        ...filler(30),
        ["Zanzibar is where the launch party goes.", 20],
        // newer, so a count of words found would have put it first
        ["The printer for the launch is booked.", 1],
      ]),
    ];
    const hits = recall("printer launch zanzibar", past, speaker, 3);
    assert.equal(hits[0].text, "Zanzibar is where the launch party goes.");
  });

  test("saying a word again counts for less each time, and length does not win", () => {
    const ramble = `Vendor vendor vendor. ${"We kept talking about the vendor and the stickers and many other things at length. ".repeat(6)}`;
    const past = [
      lane("dm", [
        ...filler(20),
        ["Sticker vendor: Mule, net 30.", 10],
        [ramble, 1],
      ]),
    ];
    const hits = recall("sticker vendor", past, speaker, 2);
    assert.equal(hits[0].text, "Sticker vendor: Mule, net 30.");
  });

  test("words side by side beat the same words far apart", () => {
    const apart = "Quarterly numbers first. Then a long digression about offices, chairs, desks and lamps, before the report on budget.";
    const together = "Quarterly budget report first. Then a long digression about offices, chairs, desks and lamps, before numbers.";
    const past = [lane("dm", [...filler(10), [together, 9], [apart, 2]])];
    const hits = recall("budget report", past, speaker, 2);
    assert.equal(hits[0].text, together);
    assert.ok(closeness(together, ["budget", "report"]).phrase);
    assert.equal(closeness(apart, ["budget", "report"]).phrase, false);
  });

  test("newer wins among equals, and a strong old match still beats a weak new one", () => {
    const index = new TermIndex();
    index.add("old", NOW - 300 * DAY, "Invoice from Acme for the kiosk build");
    index.add("new", NOW - DAY, "Invoice from Acme for the kiosk build");
    for (let i = 0; i < 20; i++) index.add(`f${i}`, NOW - 50 * DAY, `Invoice ${i} paid on time.`);
    let hits = rank("acme kiosk", [index], { now: NOW });
    assert.deepEqual(hits.map((h) => h.doc.id).slice(0, 2), ["new", "old"]);

    hits = rank("invoice kiosk", [index], { now: NOW, limit: 3 });
    assert.ok(["new", "old"].includes(hits[0].doc.id), "a message with the rare word, however old, comes first");
  });

  test("a hit is cut around the words, not from its start", () => {
    const text = `${"Background that nobody asked about. ".repeat(40)}The answer: Sticker Mule, delivered Friday.`;
    const past = [lane("dm", [...filler(5), [text, 2]])];
    const [hit] = recall("sticker mule friday", past, speaker);
    assert.match(hit.text, /Sticker Mule, delivered Friday/);
    assert.ok(hit.text.startsWith("…"));
    assert.ok(hit.text.length <= 600);
    assert.equal(hit.clipped, true);
    assert.ok(excerpt(text, text.indexOf("Sticker"), 120).length <= 120);
  });

  test("strength is the share of the query's weight a hit holds", () => {
    const index = new TermIndex();
    index.add("both", NOW, "Tahoe cabin booked for the ski trip");
    index.add("one", NOW, "The trip report is late");
    for (let i = 0; i < 20; i++) index.add(`f${i}`, NOW, `Note ${i}`);
    const [best] = rank("tahoe trip", [index], { now: NOW });
    assert.equal(best.doc.id, "both");
    assert.ok(Math.abs(best.strength - 1) < 1e-9);
    const weak = rank("tahoe trip", [index], { now: NOW, minStrength: 0.9 });
    assert.deepEqual(weak.map((h) => h.doc.id), ["both"]);
  });
});

describe("memory files", () => {
  test("a file is cut into pieces under their headings", () => {
    const text = [
      "# Memory",
      "",
      "## Vendors",
      "- Sticker Mule for stickers, net 30.",
      "- Moo for business cards.",
      "",
      "## People",
      "Dana runs finance.",
      "",
      `${"A long note about the launch. ".repeat(40)}`,
    ].join("\n");
    const pieces = memoryPieces(text);
    assert.ok(pieces.some((p) => p.startsWith("## Vendors\n- Sticker Mule")));
    assert.ok(pieces.filter((p) => p.startsWith("## People")).length >= 2, "a long section is cut, each piece under its heading");
    assert.ok(!pieces.includes("# Memory"), "a heading alone is not a piece");
    const index = indexMemory(text, NOW);
    const [hit] = rank("sticker vendor", [index], { now: NOW });
    assert.match(hit.doc.text, /Sticker Mule/);
  });
});

describe("the index", () => {
  test("growing one in place ranks as building it whole does", () => {
    const texts = ["Launch moved to Friday", "Vendor is Sticker Mule", "Budget stays under 400", "Friday launch party at noon"];
    const whole = new TermIndex();
    texts.forEach((t, i) => whole.add(`m${i}`, NOW - i, t));
    const grown = new TermIndex();
    grown.add("m0", NOW, texts[0]);
    grown.add("m1", NOW - 1, texts[1]);
    grown.add("m2", NOW - 2, texts[2]);
    grown.add("m3", NOW - 3, texts[3]);
    grown.add("m3", NOW - 3, texts[3]);
    assert.deepEqual(
      rank("friday launch", [grown], { now: NOW }).map((h) => [h.doc.id, h.score]),
      rank("friday launch", [whole], { now: NOW }).map((h) => [h.doc.id, h.score]),
    );
    assert.equal(grown.docs.length, 4, "the same message twice is one document");
  });

  test("new words are added, the same words only move, an edit asks to be rebuilt", () => {
    const index = new TermIndex();
    const text = "Vendor is Sticker Mule";
    index.add("m1", 1, text);
    assert.equal(index.update("m1", 5, text), true);
    assert.equal(index.docs[0].at, 5);
    assert.equal(index.update("m2", 6, "Launch on Friday"), true);
    assert.equal(rank("friday", [index])[0].doc.id, "m2");
    assert.equal(index.update("m1", 5, "Vendor is Moo"), false);
    assert.equal(index.update("m1", 5, null), false, "taken back");
  });

  test("the cache keeps to its budget, oldest first, never what a search is using", () => {
    const cache = new IndexCache(10);
    const build = (n: number) => () => {
      const index = new TermIndex();
      index.add("a", 1, Array.from({ length: n }, (_, i) => `word${i}`).join(" "));
      return index;
    };
    const a = cache.get("a", build(6));
    cache.get("b", build(6));
    const c = cache.get("c", build(6));
    cache.trim(new Set([a, c]));
    assert.equal(cache.has("b"), false, "the one nobody was using went");
    assert.equal(cache.has("a") && cache.has("c"), true);
    cache.trim();
    assert.equal(cache.size <= 10, true);
    // a stamp that has moved builds it again
    const first = cache.get("memory", build(2), "1:10");
    assert.equal(cache.get("memory", build(2), "1:10"), first);
    assert.notEqual(cache.get("memory", build(2), "2:12"), first);
  });

  test("tens of thousands of messages index and answer well inside a second", () => {
    const words = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango planning meeting vendor stickers budget launch report deploy server client invoice schedule design review feedback customer pricing roadmap sprint ticket release branch merge testing".split(" ");
    let seed = 7;
    const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    // a few words used everywhere and a long tail, as people talk
    const sentence = (n: number) => {
      let out = "";
      for (let i = 0; i < n; i++) out += `${words[Math.floor(random() * random() * words.length)]}${random() < 0.2 ? "s" : ""} `;
      return out;
    };
    const texts: string[] = [];
    for (let i = 0; i < 30_000; i++) texts.push(`${sentence(8 + Math.floor(random() * 40))}. Reference R${i}.`);

    // processor time, not the wall clock: the suite runs files side by
    // side, and a busy machine is not the index being slow
    const cpu = () => {
      const { user, system } = process.cpuUsage();
      return (user + system) / 1000;
    };
    let started = cpu();
    const lanes = Array.from({ length: 20 }, () => new TermIndex());
    texts.forEach((text, i) => lanes[i % 20].add(`m${i}`, NOW - i * 60_000, text));
    const indexing = cpu() - started;

    started = cpu();
    const hits = rank("vendor stickers budget R1234", lanes, { now: NOW, limit: 8 });
    rank("planning meeting with the customer about pricing and the roadmap for the next sprint release", lanes, { now: NOW, limit: 3, need: () => 2 });
    const querying = (cpu() - started) / 2;

    assert.equal(hits[0].doc.id, "m1234");
    assert.ok(indexing < 1000, `indexing 30,000 messages took ${indexing.toFixed(0)}ms`);
    assert.ok(querying < 250, `a query took ${querying.toFixed(0)}ms`);
  });
});
