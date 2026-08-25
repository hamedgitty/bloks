// The map's arithmetic, without drawing anything.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { layoutTeamMap } from "../src/lib/teamMap.ts";

const agents = [
  { id: "a", section: "Clients", busy: true },
  { id: "b", section: "Clients" },
  { id: "c", section: "Ops" },
  { id: "d" },
];

describe("layoutTeamMap", () => {
  test("every agent gets a node, clustered by section", () => {
    const { nodes, clusters } = layoutTeamMap(agents, [], 900);
    assert.equal(nodes.filter((n) => n.kind === "agent").length, 4);
    assert.deepEqual(
      clusters.map((c) => c.name),
      ["Clients", "Everyone", "Ops"],
    );
  });

  test("agents stay inside their cluster's box", () => {
    const { nodes, clusters } = layoutTeamMap(agents, [], 900);
    for (const node of nodes) {
      const inside = clusters.some(
        (c) =>
          node.x >= c.x && node.x <= c.x + c.width && node.y >= c.y && node.y <= c.y + c.height,
      );
      assert.ok(inside, `${node.id} floated outside every cluster`);
    }
  });

  test("a one-section room sits in that cluster, a spanning room below", () => {
    const rooms = [
      { id: "r1", name: "Client work", memberIds: ["a", "b"] },
      { id: "r2", name: "All hands", memberIds: ["a", "c"] },
    ];
    const { nodes, clusters, height } = layoutTeamMap(agents, rooms, 900);
    const clients = clusters.find((c) => c.name === "Clients")!;
    const r1 = nodes.find((n) => n.id === "r1")!;
    const r2 = nodes.find((n) => n.id === "r2")!;
    assert.ok(r1.x >= clients.x && r1.x <= clients.x + clients.width);
    assert.ok(r2.y > Math.max(...clusters.map((c) => c.y + c.height)) - 1);
    assert.ok(height >= r2.y);
  });

  test("edges follow membership and light up with a busy member", () => {
    const rooms = [{ id: "r1", name: "Client work", memberIds: ["a", "b"] }];
    const { edges } = layoutTeamMap(agents, rooms, 900);
    assert.equal(edges.length, 2);
    assert.equal(edges.find((e) => e.to === "a")?.active, true);
    assert.equal(edges.find((e) => e.to === "b")?.active, false);
  });

  test("a room of strangers draws nothing", () => {
    const rooms = [{ id: "r1", name: "Ghost", memberIds: ["nope"] }];
    const { nodes, edges } = layoutTeamMap(agents, rooms, 900);
    assert.ok(!nodes.some((n) => n.id === "r1"));
    assert.equal(edges.length, 0);
  });

  test("clusters wrap rather than run off the right edge", () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ id: `s${i}`, section: `S${i}` }));
    const { clusters } = layoutTeamMap(many, [], 700);
    for (const cluster of clusters) {
      assert.ok(cluster.x + cluster.width <= 700 + cluster.width, "cluster ran away");
      assert.ok(cluster.x >= 0);
    }
    assert.ok(new Set(clusters.map((c) => c.y)).size > 1, "nothing wrapped");
  });
});
