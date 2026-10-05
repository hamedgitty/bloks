// The server's half of the sidebar's order (server/sidebar.ts): numbering
// pins when one moves, bringing an older workspace up to pins with places,
// and what an agent reads before it files or pins anything.
//
// The order itself is the client's (compareRows in src/lib/sections.ts).
// The server keeps its own copy of the pinned half, because it numbers the
// pins, and two rules for one order is how the Mac and the phone end up
// disagreeing about which pin is second. So the first thing here holds the
// two copies together.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { compareRows, placeRow, sidebarOrder } from "../src/lib/sections.ts";
import {
  byPin,
  cleanSectionOrder,
  orderedSections,
  pinsIn,
  placeAt,
  sidebarView,
  upgradePlaces,
  type Placed,
} from "../server/sidebar.ts";

/** A small deterministic generator, so a failure here names a seed
 * rather than a flake. */
function rows(seed: number, count: number): Placed[] {
  let s = seed;
  const next = () => {
    s = (s * 1_103_515_245 + 12_345) % 2_147_483_648;
    return s / 2_147_483_648;
  };
  return Array.from({ length: count }, (_, i) => ({
    id: `r${Math.floor(next() * 1000)}-${i}`,
    kind: next() < 0.3 ? "room" : "agent",
    name: `Row ${i}`,
    section: next() < 0.5 ? null : next() < 0.5 ? "Travel" : "Ops",
    pinned: next() < 0.6,
    // places that repeat and places left empty, the shapes a workspace
    // really has between renumberings
    pinOrder: next() < 0.2 ? null : Math.floor(next() * 4),
    createdAt: Math.floor(next() * 5),
  }));
}

describe("one order, said in two places", () => {
  test("the server's pin order is the client's, for every pin", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const pins = rows(seed, 12).filter((r) => r.pinned);
      assert.deepEqual(
        [...pins].sort(byPin).map((r) => r.id),
        sidebarOrder(pins).map((r) => r.id),
        `seed ${seed}`,
      );
    }
  });

  test("a place among the pins comes out the same on both sides", () => {
    // the sidebar shows a drop at once and the server's answer must not
    // move anything it shows
    for (let seed = 1; seed <= 40; seed++) {
      const all = rows(seed, 10);
      const moved = all[seed % all.length];
      for (const section of [null, "Travel"]) {
        for (const position of [1, 2, 5, 99]) {
          const standing = all.map((r) => (r.id === moved.id ? { ...r, section, pinned: true } : r));
          const server = new Map(placeAt(standing, moved.id, section, position).map((p) => [p.id, p.pinOrder]));
          const client = new Map(
            placeRow(all, moved.id, { section, pinned: true, position })
              .filter((p) => p.patch.pinOrder !== undefined)
              .map((p) => [p.id, p.patch.pinOrder]),
          );
          assert.deepEqual(client, server, `seed ${seed}, ${section ?? "unfiled"}, at ${position}`);
        }
      }
    }
  });

  test("the order of the headings is the client's too", () => {
    const placed: Placed[] = ["Ops", "Admin", "Travel", "Clients"].map((section, i) => ({
      id: `a${i}`,
      kind: "agent",
      name: section,
      section,
    }));
    assert.deepEqual(orderedSections(placed, ["Travel", "Gone", "Ops"]), ["Travel", "Ops", "Admin", "Clients"]);
    assert.deepEqual(orderedSections(placed, []), ["Admin", "Clients", "Ops", "Travel"]);
  });
});

describe("numbering the pins when one moves", () => {
  const section: Placed[] = [
    { id: "a", kind: "agent", name: "A", pinned: true, pinOrder: 1 },
    { id: "standup", kind: "room", name: "Standup", pinned: true, pinOrder: 2 },
    { id: "c", kind: "agent", name: "C", pinned: true, pinOrder: 3 },
    { id: "loose", kind: "agent", name: "Loose" },
    { id: "elsewhere", kind: "agent", name: "E", section: "Travel", pinned: true, pinOrder: 1 },
  ];

  test("a row taking a place pushes the ones below it down, rooms and agents alike", () => {
    const placed = placeAt(
      section.map((r) => (r.id === "loose" ? { ...r, pinned: true } : r)),
      "loose",
      null,
      2,
    );
    assert.deepEqual(placed, [
      { id: "loose", kind: "agent", pinOrder: 2 },
      { id: "standup", kind: "room", pinOrder: 3 },
      { id: "c", kind: "agent", pinOrder: 4 },
    ]);
  });

  test("moving up within the pins closes the gap it leaves", () => {
    assert.deepEqual(placeAt(section, "c", null, 1), [
      { id: "c", kind: "agent", pinOrder: 1 },
      { id: "a", kind: "agent", pinOrder: 2 },
      { id: "standup", kind: "room", pinOrder: 3 },
    ]);
  });

  test("a place past the end is the end, and nothing else in the workspace moves", () => {
    const placed = placeAt(section, "a", null, 40);
    assert.deepEqual(placed.map((p) => [p.id, p.pinOrder]), [
      ["standup", 1],
      ["c", 2],
      ["a", 3],
    ]);
    assert.ok(!placed.some((p) => p.id === "elsewhere"), "another section's pins were renumbered");
  });

  test("the pins of a section, in order", () => {
    assert.deepEqual(
      pinsIn(section, null).map((r) => r.id),
      ["a", "standup", "c"],
    );
  });
});

describe("a workspace from before pins had places", () => {
  // as the files list them: rooms newest first, agents newest first
  const rooms: Placed[] = [
    { id: "newest-room", kind: "room", name: "N", createdAt: 30 },
    { id: "travel-room", kind: "room", name: "T", section: "Travel", createdAt: 20 },
    { id: "oldest-room", kind: "room", name: "O", createdAt: 10 },
    { id: "unpinned-room", kind: "room", name: "U", pinned: false, createdAt: 5 },
  ];
  const agents: Placed[] = [
    { id: "pinned-new", kind: "agent", name: "P1", pinned: true, createdAt: 9 },
    { id: "loose", kind: "agent", name: "L", createdAt: 8 },
    { id: "pinned-old", kind: "agent", name: "P2", pinned: true, createdAt: 7 },
    { id: "pinned-travel", kind: "agent", name: "P3", section: "Travel", pinned: true, createdAt: 6 },
  ];

  test("rooms are pinned in the order they were listed, and pinned agents follow in theirs", () => {
    const { rooms: roomPlaces, agents: agentPlaces } = upgradePlaces(rooms, agents);
    assert.deepEqual(roomPlaces, [
      { id: "newest-room", kind: "room", pinOrder: 1 },
      { id: "travel-room", kind: "room", pinOrder: 1 },
      { id: "oldest-room", kind: "room", pinOrder: 2 },
    ]);
    assert.deepEqual(agentPlaces, [
      { id: "pinned-new", kind: "agent", pinOrder: 3 },
      { id: "pinned-old", kind: "agent", pinOrder: 4 },
      { id: "pinned-travel", kind: "agent", pinOrder: 2 },
    ]);
  });

  test("so the list looks as it did: rooms in their old order, then the pinned agents", () => {
    const { rooms: roomPlaces, agents: agentPlaces } = upgradePlaces(rooms, agents);
    const places = new Map([...roomPlaces, ...agentPlaces].map((p) => [p.id, p.pinOrder]));
    const after = [...rooms, ...agents].map((r) =>
      places.has(r.id) ? { ...r, pinned: true, pinOrder: places.get(r.id) } : r,
    );
    assert.deepEqual(
      sidebarOrder(after.filter((r) => !r.section)).map((r) => r.id),
      ["newest-room", "oldest-room", "pinned-new", "pinned-old", "loose", "unpinned-room"],
    );
  });

  test("a room somebody unpinned stays unpinned, and a second start finds nothing to do", () => {
    const first = upgradePlaces(rooms, agents);
    assert.ok(!first.rooms.some((p) => p.id === "unpinned-room"));
    const places = new Map([...first.rooms, ...first.agents].map((p) => [p.id, p.pinOrder]));
    const settle = (list: Placed[]) => list.map((r) => (places.has(r.id) ? { ...r, pinned: true, pinOrder: places.get(r.id) } : r));
    assert.deepEqual(upgradePlaces(settle(rooms), settle(agents)), { rooms: [], agents: [] });
  });

  test("pins that already have places keep them, and new ones go after", () => {
    const placed: Placed[] = [{ id: "kept", kind: "agent", name: "K", pinned: true, pinOrder: 7 }];
    assert.deepEqual(upgradePlaces([{ id: "room", kind: "room", name: "R" }], placed).rooms, [
      { id: "room", kind: "room", pinOrder: 8 },
    ]);
  });
});

describe("what an agent reads", () => {
  test("every section, unfiled first, with what is pinned where and the rest by name", () => {
    const view = sidebarView(
      [
        { id: "z", kind: "agent", name: "Zed" },
        { id: "a", kind: "agent", name: "Ada" },
        { id: "p2", kind: "room", name: "Standup", pinned: true, pinOrder: 2 },
        { id: "p1", kind: "agent", name: "Nova", pinned: true, pinOrder: 1 },
        { id: "t", kind: "agent", name: "Porto", section: "Travel", pinned: true, pinOrder: 4 },
      ],
      [],
    );
    assert.deepEqual(view, [
      {
        name: null,
        pinned: [
          { id: "p1", kind: "agent", name: "Nova", position: 1 },
          { id: "p2", kind: "room", name: "Standup", position: 2 },
        ],
        others: [
          { id: "a", kind: "agent", name: "Ada" },
          { id: "z", kind: "agent", name: "Zed" },
        ],
      },
      // a position is a place, whatever number is stored behind it
      { name: "Travel", pinned: [{ id: "t", kind: "agent", name: "Porto", position: 1 }], others: [] },
    ]);
  });

  test("a section order is names, each once, the shape a section name has", () => {
    assert.deepEqual(cleanSectionOrder(["Travel", "  Ops  team ", 4, "Travel", "", "x".repeat(61)]), ["Travel", "Ops team"]);
    assert.equal(cleanSectionOrder("Travel"), null);
  });

  test("the pinned half of the rule agrees with the whole of it", () => {
    // a pinned row always comes before an unpinned one, whatever its activity
    assert.ok(compareRows({ id: "p", pinned: true, pinOrder: 9 }, { id: "u", activeWithYouAt: Date.now() }) < 0);
  });
});
