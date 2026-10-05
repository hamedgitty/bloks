// Sections exist exactly as long as something stands under them.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  acceptsRow,
  inSection,
  moveSection,
  orderSections,
  ROW_TYPE,
  SECTION_TYPE,
  sectionNames,
  shownInSection,
} from "../src/lib/sections.ts";

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

describe("ordering sections", () => {
  const names = ["Admin", "Clients", "Ops", "Travel"];

  test("with nothing dragged, the order stays alphabetical", () => {
    assert.deepEqual(orderSections(names, []), names);
  });

  test("dragged ones come first in their order, new ones follow alphabetically", () => {
    assert.deepEqual(orderSections([...names, "Brand"], ["Travel", "Clients", "Admin", "Ops"]), [
      "Travel",
      "Clients",
      "Admin",
      "Ops",
      "Brand",
    ]);
  });

  test("a remembered name that no longer exists is skipped", () => {
    assert.deepEqual(orderSections(["Ops", "Travel"], ["Gone", "Travel"]), ["Travel", "Ops"]);
  });

  test("a section moves before or after another, and the whole order is kept", () => {
    assert.deepEqual(moveSection(names, "Travel", "Admin", "before"), ["Travel", "Admin", "Clients", "Ops"]);
    assert.deepEqual(moveSection(names, "Admin", "Ops", "after"), ["Clients", "Ops", "Admin", "Travel"]);
    assert.deepEqual(moveSection(names, "Ops", "Ops", "before"), names, "dropping on itself changes nothing");
  });
});

describe("filing a row by dragging it", () => {
  const row = [ROW_TYPE];

  test("a row is taken by another section, or by the unfiled list", () => {
    assert.equal(acceptsRow(row, "Clients", "Ops"), true);
    assert.equal(acceptsRow(row, null, "Ops"), true, "an unfiled row goes into a section");
    assert.equal(acceptsRow(row, "Clients", null), true, "a filed row comes out of its section");
  });

  test("letting it go where it already is changes nothing", () => {
    assert.equal(acceptsRow(row, "Clients", "Clients"), false);
    assert.equal(acceptsRow(row, null, null), false);
  });

  test("a heading being reordered is never taken for a row", () => {
    assert.notEqual(ROW_TYPE, SECTION_TYPE);
    assert.equal(acceptsRow([SECTION_TYPE], "Clients", "Ops"), false);
  });

  test("neither is anything dragged in from outside", () => {
    assert.equal(acceptsRow(["Files"], "Clients", "Ops"), false);
    assert.equal(acceptsRow([], null, "Ops"), false);
  });
});
