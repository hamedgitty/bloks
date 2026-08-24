// A catalog of skills, and what it says about the ones you already have.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  MAX_ENTRY_BODY,
  hashBody,
  listing,
  markFor,
  parseCatalog,
  standing,
  updateCount,
  type RegistryEntry,
} from "../server/skill-registry.ts";

const entryOf = (over: Partial<RegistryEntry> = {}): RegistryEntry => {
  const body = over.body ?? "Do the thing, then the other thing.";
  return {
    id: "meeting-notes",
    name: "Meeting notes",
    description: "Notes somebody will read",
    version: "1",
    tags: ["writing"],
    body,
    sha256: hashBody(body),
    ...over,
    ...(over.body ? { sha256: hashBody(over.body) } : {}),
  };
};

describe("reading a catalog somebody else served", () => {
  test("the ordinary case", () => {
    const parsed = parseCatalog({
      skills: [
        { id: "a-skill", name: "A skill", description: "does a thing", version: "2", tags: ["x"], body: "Do it." },
      ],
    });
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].id, "a-skill");
    assert.equal(parsed[0].version, "2");
    assert.equal(parsed[0].sha256, hashBody("Do it."));
  });

  test("a bare array works too, because half of them will send one", () => {
    assert.equal(parseCatalog([{ id: "x", body: "Do it." }]).length, 1);
  });

  test("one bad entry costs that entry, not the catalog", () => {
    const parsed = parseCatalog({
      skills: [
        { id: "good", body: "Do it." },
        null,
        { id: "NO SPACES ALLOWED", body: "Do it." },
        { id: "no-body" },
        { id: "good", body: "a duplicate" },
        { id: "../../escape", body: "Do it." },
        { id: "also-good", body: "Do it too." },
      ],
    });
    assert.deepEqual(parsed.map((e) => e.id), ["good", "also-good"]);
  });

  test("an entry too big to be instructions is dropped", () => {
    const parsed = parseCatalog([{ id: "huge", body: "x".repeat(MAX_ENTRY_BODY + 1) }]);
    assert.deepEqual(parsed, []);
  });

  test("a hash the catalog states is not the hash we use", () => {
    // a stated hash that disagrees with the bytes is not a hash, and
    // trusting it would mean a catalog could claim an install is current
    // when it is serving something else
    const parsed = parseCatalog([{ id: "x", body: "Do it.", sha256: "0".repeat(64) }]);
    assert.equal(parsed[0].sha256, hashBody("Do it."));
  });

  test("nonsense is an empty catalog, not an exception", () => {
    for (const bad of [null, 7, "skills", {}, { skills: "many" }]) {
      assert.deepEqual(parseCatalog(bad), []);
    }
  });
});

describe("what the catalog says about a skill you have", () => {
  const entry = entryOf();

  test("not here yet", () => {
    const s = standing(entry, null, null);
    assert.equal(s.state, "available");
    assert.equal(s.action, "Install");
    assert.equal(s.destructive, false);
  });

  test("here, and the same", () => {
    const s = standing(entry, { body: entry.body }, markFor(entry));
    assert.equal(s.state, "current");
    assert.equal(s.action, null, "nothing to do is not a button");
  });

  test("here, older, untouched", () => {
    const next = entryOf({ body: "Do the thing, better.", version: "2" });
    const s = standing(next, { body: entry.body }, markFor(entry));
    assert.equal(s.state, "outdated");
    assert.equal(s.action, "Update");
    assert.equal(s.destructive, false);
    assert.match(s.says, /Version 2/);
  });

  test("here, and you changed it", () => {
    // the case the whole feature exists for: an update here would throw
    // away somebody's work, so it is not called an update
    const s = standing(entry, { body: "My own version of it." }, markFor(entry));
    assert.equal(s.state, "edited");
    assert.equal(s.destructive, true);
    assert.match(s.says, /You have changed this/);
    assert.equal(s.action, "Restore");
    // the button says the verb; which copy and what it costs is the
    // sentence beside it, so the label cannot squeeze the skill name off
    // its own row on a narrow window
    assert.match(s.says, /catalog/);
  });

  test("you changed it and the catalog moved on", () => {
    const next = entryOf({ body: "Do the thing, better.", version: "3" });
    const s = standing(next, { body: "My own version." }, markFor(entry));
    assert.equal(s.state, "edited-and-outdated");
    assert.equal(s.destructive, true);
    assert.match(s.says, /changed this, and version 3/);
  });

  test("a skill you wrote that happens to share the name is yours", () => {
    // no mark means it never came from here, whatever it is called, and
    // taking it over silently would be a tool overwriting somebody's work
    const s = standing(entry, { body: "Mine, entirely.", source: "user" }, null);
    assert.equal(s.state, "yours");
    assert.equal(s.destructive, true);
    assert.match(s.says, /you wrote yourself/);
  });

  test("one Bloks ships with is not one you wrote", () => {
    // installing the catalog's writes a copy that shadows the bundled
    // one, and deleting that copy brings it back, so nothing is lost and
    // calling it destructive would be scaring somebody for no reason
    const s = standing(entry, { body: "The bundled instructions.", source: "builtin" }, null);
    assert.equal(s.state, "bundled");
    assert.equal(s.destructive, false);
    assert.match(s.says, /Bloks ships a skill with this name/);
    assert.match(s.says, /brings the bundled one back/);
  });

  test("a mark with no hash is treated as no mark at all", () => {
    const s = standing(entry, { body: entry.body, source: "user" }, { registry: "meeting-notes", version: "1" });
    assert.equal(s.state, "yours", "half a record is not a record");
  });

  test("whitespace at the ends is not an edit", () => {
    const s = standing(entry, { body: `\n${entry.body}\n  ` }, markFor(entry));
    assert.equal(s.state, "current");
  });
});

describe("the catalog as a list", () => {
  test("each entry carries its own standing, and updates are counted", () => {
    const one = entryOf({ id: "one", body: "One." });
    const two = entryOf({ id: "two", body: "Two, revised.", version: "2" });
    const three = entryOf({ id: "three", body: "Three." });

    const installed = new Map([
      ["one", { body: "One.", ...markFor(one) }],
      // installed at the old body, so the catalog's new one is an update
      ["two", { body: "Two.", ...markFor(entryOf({ id: "two", body: "Two." })) }],
    ]);

    const rows = listing([one, two, three], installed);
    assert.deepEqual(rows.map((r) => r.standing.state), ["current", "outdated", "available"]);
    assert.equal(updateCount(rows), 1);
    // an edited skill is not counted as an update: telling somebody there
    // are two updates when one would discard their work is a lie
    const edited = listing([one], new Map([["one", { body: "Changed.", ...markFor(one) }]]));
    assert.equal(updateCount(edited), 0);
  });
});
