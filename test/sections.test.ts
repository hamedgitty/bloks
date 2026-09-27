// Sections exist exactly as long as something stands under them.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { inSection, sectionNames, shownInSection } from "../src/lib/sections.ts";

describe("sectionNames", () => {
  test("names come from both lists, once each, alphabetically", () => {
    const bots = [{ section: "Clients" }, { section: "Ops" }, { section: null }, {}];
    const rooms = [{ section: "Clients" }, { section: "Admin" }];
    assert.deepEqual(sectionNames(bots, rooms), ["Admin", "Clients", "Ops"]);
  });

  test("nothing filed means no sections", () => {
    assert.deepEqual(sectionNames([{}, { section: null }], []), []);
  });
});

describe("inSection", () => {
  const rows = [
    { id: "a", section: "Clients" },
    { id: "b" },
    { id: "c", section: null },
    { id: "d", section: "Clients" },
  ];

  test("a section's slice keeps the list's own order", () => {
    assert.deepEqual(
      inSection(rows, "Clients").map((r) => r.id),
      ["a", "d"],
    );
  });

  test("null selects the unfiled, absent or explicit", () => {
    assert.deepEqual(
      inSection(rows, null).map((r) => r.id),
      ["b", "c"],
    );
  });
});

describe("shownInSection", () => {
  const rows = [{ id: "a" }, { id: "b" }, { id: "c" }];

  test("an open section shows every row", () => {
    assert.deepEqual(shownInSection(rows, false, null, false), rows);
  });

  test("a folded section keeps only the open thread", () => {
    assert.deepEqual(shownInSection(rows, true, "b", false), [{ id: "b" }]);
    assert.deepEqual(shownInSection(rows, true, "elsewhere", false), []);
  });

  test("a search unfolds it", () => {
    assert.deepEqual(shownInSection(rows, true, null, true), rows);
  });
});
