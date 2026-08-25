// Sections exist exactly as long as something stands under them.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { inSection, sectionNames } from "../src/lib/sections.ts";

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
