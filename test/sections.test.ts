// Sections exist exactly as long as something stands under them.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  acceptsRow,
  compareRows,
  inSection,
  landingOver,
  layoutRows,
  moveSection,
  movesRow,
  orderSections,
  pinPosition,
  placeOfRow,
  placeRow,
  ROW_TYPE,
  SECTION_TYPE,
  sectionNames,
  shownInSection,
  sidebarLayout,
  sidebarOrder,
  type Listed,
  type Ordered,
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

// The order inside a list (GitHub 156): pins first in the person's order,
// then everything else by recent activity with the person.
describe("the order inside a list", () => {
  const row = (id: string, over: Partial<Ordered> = {}): Ordered => ({ id, createdAt: 0, ...over });
  const ids = (rows: Ordered[]) => rows.map((r) => r.id);

  test("pins come first, in the order the person put them, however quiet", () => {
    const rows = [
      row("busy", { activeWithYouAt: 9_000 }),
      row("second", { pinned: true, pinOrder: 2, activeWithYouAt: 10 }),
      row("first", { pinned: true, pinOrder: 1 }),
    ];
    assert.deepEqual(ids(sidebarOrder(rows)), ["first", "second", "busy"]);
  });

  test("the rest go by recent activity with the person, most recent first", () => {
    const rows = [row("old", { activeWithYouAt: 100 }), row("now", { activeWithYouAt: 300 }), row("then", { activeWithYouAt: 200 })];
    assert.deepEqual(ids(sidebarOrder(rows)), ["now", "then", "old"]);
  });

  test("a pin given no place yet stands after the placed ones, the older first", () => {
    // pinning from the menu, a new room: each joins the end, in turn
    const rows = [
      row("later", { pinned: true, pinOrder: null, createdAt: 20 }),
      row("placed", { pinned: true, pinOrder: 5 }),
      row("earlier", { pinned: true, createdAt: 10 }),
    ];
    assert.deepEqual(ids(sidebarOrder(rows)), ["placed", "earlier", "later"]);
  });

  test("rows nobody has spoken with yet keep the old order, newest first", () => {
    // what the list did before any of this, so a fresh hire is still easy to find
    const rows = [row("a", { createdAt: 1 }), row("c", { createdAt: 3, activeWithYouAt: 0 }), row("b", { createdAt: 2 })];
    assert.deepEqual(ids(sidebarOrder(rows)), ["c", "b", "a"]);
  });

  test("a pinned room keeps its place however busy the agents around it get", () => {
    const rows = [
      row("agent", { activeWithYouAt: 50_000 }),
      row("standup", { pinned: true, pinOrder: 1, activeWithYouAt: 1 }),
      row("pinned agent", { pinned: true, pinOrder: 2 }),
    ];
    assert.deepEqual(ids(sidebarOrder(rows)), ["standup", "pinned agent", "agent"]);
  });

  test("ties settle the same way whatever order they arrive in", () => {
    // two devices, or the phone and the keyboard, must never disagree
    const rows = [row("b", { activeWithYouAt: 7 }), row("a", { activeWithYouAt: 7 }), row("c", { activeWithYouAt: 7 })];
    assert.deepEqual(ids(sidebarOrder(rows)), ["a", "b", "c"]);
    assert.deepEqual(ids(sidebarOrder([...rows].reverse())), ["a", "b", "c"]);
    assert.equal(compareRows(rows[0], rows[0]), 0);
  });

  test("ordering leaves the list it was given alone", () => {
    const rows = [row("z", { activeWithYouAt: 1 }), row("y", { activeWithYouAt: 2 })];
    sidebarOrder(rows);
    assert.deepEqual(ids(rows), ["z", "y"]);
  });
});

describe("the whole sidebar, top to bottom", () => {
  const room = (id: string, over: Partial<Listed> = {}): Listed => ({ id, kind: "room", createdAt: 0, ...over });
  const agent = (id: string, over: Partial<Listed> = {}): Listed => ({ id, kind: "agent", createdAt: 0, ...over });
  const rows = [
    agent("nova", { activeWithYouAt: 50 }),
    room("standup", { pinned: true, pinOrder: 1 }),
    agent("ada", { pinned: true, pinOrder: 2 }),
    agent("quiet"),
    agent("lisbon", { section: "Travel", activeWithYouAt: 90 }),
    room("trip", { section: "Travel", activeWithYouAt: 10 }),
    agent("porto", { section: "Travel", pinned: true, pinOrder: 1 }),
    agent("books", { section: "Admin", activeWithYouAt: 5 }),
  ];
  const layout = sidebarLayout(rows, ["Travel"]);

  test("the unfiled list keeps its Rooms and its Agents, each in the one order", () => {
    assert.deepEqual(layout.unfiled.rooms.map((r) => r.id), ["standup"]);
    assert.deepEqual(layout.unfiled.agents.map((r) => r.id), ["ada", "nova", "quiet"]);
  });

  test("a section is one list, rooms and agents together, in the person's order of sections", () => {
    assert.deepEqual(
      layout.sections.map((s) => [s.name, s.rows.map((r) => r.id)]),
      [
        ["Travel", ["porto", "lisbon", "trip"]],
        ["Admin", ["books"]],
      ],
    );
  });

  test("the rail and the phone run through it in the same order", () => {
    assert.deepEqual(
      layoutRows(layout).map((r) => r.id),
      ["standup", "ada", "nova", "quiet", "porto", "lisbon", "trip", "books"],
    );
  });
});

describe("one drag files a row and places it", () => {
  const r = (id: string, over: Partial<Listed> = {}): Listed => ({ id, kind: "agent", createdAt: 0, ...over });
  // a list as drawn: two pins, then two by activity
  const list = [
    r("p1", { pinned: true, pinOrder: 1 }),
    r("p2", { pinned: true, pinOrder: 2 }),
    r("u1", { activeWithYouAt: 20 }),
    r("u2", { activeWithYouAt: 10 }),
  ];

  test("over a pin, it takes that place: above from the top half, below from the bottom", () => {
    assert.deepEqual(landingOver(list, "x", "p2", "top"), { pinned: true, line: { id: "p2", edge: "top" } });
    assert.deepEqual(landingOver(list, "x", "p2", "bottom"), { pinned: true, line: { id: "p2", edge: "bottom" } });
  });

  test("the top of the first unpinned row is the end of the pins", () => {
    assert.deepEqual(landingOver(list, "x", "u1", "top"), { pinned: true, line: { id: "u1", edge: "top" } });
  });

  test("anywhere further down it lands unpinned, and sorts by activity", () => {
    assert.deepEqual(landingOver(list, "x", "u1", "bottom"), { pinned: false });
    assert.deepEqual(landingOver(list, "x", "u2", "top"), { pinned: false });
  });

  test("a list with no pins gets its first from the top of its first row", () => {
    const loose = [r("a", { activeWithYouAt: 2 }), r("b", { activeWithYouAt: 1 })];
    assert.deepEqual(landingOver(loose, "x", "a", "top"), { pinned: true, line: { id: "a", edge: "top" } });
    assert.deepEqual(landingOver(loose, "x", "b", "top"), { pinned: false });
  });

  test("the row in hand is not a place of its own", () => {
    // over itself it chooses nothing, and keeps whatever pin it has
    assert.deepEqual(landingOver(list, "p1", "p1", "top"), { pinned: true });
    // and the rows it leaves behind close up: the first unpinned row is
    // still the end of the pins when the dragged pin is taken out
    assert.deepEqual(landingOver(list, "p2", "u1", "top"), { pinned: true, line: { id: "u1", edge: "top" } });
  });

  test("a line becomes a place among the section's pins, 1 at the top", () => {
    const pins = list.slice(0, 2);
    assert.equal(pinPosition(pins, { id: "p1", edge: "top" }), 1);
    assert.equal(pinPosition(pins, { id: "p1", edge: "bottom" }), 2);
    assert.equal(pinPosition(pins, { id: "p2", edge: "bottom" }), 3);
    // against an unpinned row, or a pin a search is hiding: the end
    assert.equal(pinPosition(pins, { id: "u1", edge: "top" }), 3);
    assert.equal(pinPosition(pins, undefined), 3);
  });

  test("letting go where it already stands changes nothing", () => {
    const rows = [...list, r("t", { section: "Travel", pinned: true, pinOrder: 1 })];
    const p2 = placeOfRow(rows, "p2")!;
    assert.deepEqual(p2, { section: null, pinned: true, position: 2 });
    assert.equal(movesRow(p2, { section: null, pinned: true, position: 2 }), false);
    assert.equal(movesRow(p2, { section: null, pinned: true }), false, "a pin without a place keeps its own");
    assert.equal(movesRow(placeOfRow(rows, "u1")!, { section: null, pinned: false }), false);
  });

  test("another place, another pin, or another section is a move", () => {
    const p2 = placeOfRow(list, "p2")!;
    assert.equal(movesRow(p2, { section: null, pinned: true, position: 1 }), true);
    assert.equal(movesRow(p2, { section: null, pinned: false }), true);
    assert.equal(movesRow(p2, { section: "Travel", pinned: true }), true);
  });

  test("a place renumbers the pins around it, the way the server stores them", () => {
    const rows = [...list, r("t1", { section: "Travel", pinned: true, pinOrder: 1 })];
    const placed = placeRow(rows, "u2", { section: null, pinned: true, position: 1 });
    assert.deepEqual(placed, [
      { kind: "agent", id: "u2", patch: { section: null, pinned: true, pinOrder: 1 } },
      { kind: "agent", id: "p1", patch: { pinOrder: 2 } },
      { kind: "agent", id: "p2", patch: { pinOrder: 3 } },
    ]);
  });

  test("filed elsewhere without a place, a pin goes after the pins there; unpinned, it lets go of its place", () => {
    const rows = [...list, r("t1", { section: "Travel", pinned: true, pinOrder: 1 })];
    assert.deepEqual(placeRow(rows, "p1", { section: "Travel", pinned: true }), [
      { kind: "agent", id: "p1", patch: { section: "Travel", pinned: true, pinOrder: null } },
    ]);
    assert.deepEqual(placeRow(rows, "p1", { section: null, pinned: false }), [
      { kind: "agent", id: "p1", patch: { section: null, pinned: false, pinOrder: null } },
    ]);
    // pinned again in place, from the menu: it keeps the place it has
    assert.deepEqual(placeRow(rows, "p2", { section: null, pinned: true }), [
      { kind: "agent", id: "p2", patch: { section: null, pinned: true } },
    ]);
  });
});
