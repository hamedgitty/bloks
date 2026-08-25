// Where everyone stands, at a glance.
//
// The map is a picture of the workspace as it is right now: agents
// clustered by section, rooms drawn as hubs with a spoke to each
// member, and status carried by color rather than words. All of it is
// computed from state the app already holds, so the map costs no
// polling and is exactly as live as the sidebar.
//
// The geometry lives here, pure, so the arithmetic that keeps clusters
// from overlapping can be tested without drawing anything.

export interface MapAgent {
  id: string;
  section?: string | null;
  busy?: boolean;
  needsYou?: boolean;
}

export interface MapRoom {
  id: string;
  name: string;
  memberIds: string[];
}

export interface MapNode {
  id: string;
  kind: "agent" | "room";
  x: number;
  y: number;
}

export interface MapEdge {
  from: string;
  to: string;
  /** A live edge has a busy agent on its far end. */
  active: boolean;
}

export interface MapCluster {
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

const AGENT_RING = 86;
const CLUSTER_PAD = 70;

/** Agents on a ring, the ring sized by how many stand on it. */
function ringRadius(count: number): number {
  return count <= 1 ? 0 : Math.max(AGENT_RING, (count * 62) / (2 * Math.PI));
}

/**
 * Sections become clusters laid out in rows; inside each, agents stand
 * on a ring and every room whose members all live here sits at the
 * middle. Rooms that span sections go to a spanning row at the bottom,
 * because a hub has to stand somewhere and between is nowhere.
 */
export function layoutTeamMap(
  agents: MapAgent[],
  rooms: MapRoom[],
  width: number,
): { nodes: MapNode[]; edges: MapEdge[]; clusters: MapCluster[]; height: number } {
  const nodes: MapNode[] = [];
  const edges: MapEdge[] = [];
  const clusters: MapCluster[] = [];

  const bySection = new Map<string, MapAgent[]>();
  for (const agent of agents) {
    const name = agent.section?.trim() || "Everyone";
    bySection.set(name, [...(bySection.get(name) ?? []), agent]);
  }

  const sectionOf = new Map(agents.map((a) => [a.id, a.section?.trim() || "Everyone"]));
  const busyOf = new Map(agents.map((a) => [a.id, Boolean(a.busy)]));

  // rooms whose members share a section ride inside that cluster; the
  // rest wait for the spanning row below
  const homed = new Map<string, MapRoom[]>();
  const spanning: MapRoom[] = [];
  for (const room of rooms) {
    const members = room.memberIds.filter((id) => sectionOf.has(id));
    if (!members.length) continue;
    const homes = new Set(members.map((id) => sectionOf.get(id)));
    if (homes.size === 1) {
      const home = [...homes][0]!;
      homed.set(home, [...(homed.get(home) ?? []), room]);
    } else {
      spanning.push(room);
    }
  }

  // clusters in rows, left to right, wrapping at the panel's width
  let cursorX = 0;
  let cursorY = 0;
  let rowHeight = 0;
  for (const [name, members] of [...bySection.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const radius = ringRadius(members.length);
    const size = radius * 2 + CLUSTER_PAD * 2;
    if (cursorX + size > width && cursorX > 0) {
      cursorX = 0;
      cursorY += rowHeight;
      rowHeight = 0;
    }
    const centerX = cursorX + size / 2;
    const centerY = cursorY + size / 2;
    clusters.push({ name, x: cursorX, y: cursorY, width: size, height: size });

    members.forEach((agent, i) => {
      const angle = (2 * Math.PI * i) / members.length - Math.PI / 2;
      nodes.push({
        id: agent.id,
        kind: "agent",
        x: centerX + radius * Math.cos(angle),
        y: centerY + radius * Math.sin(angle),
      });
    });

    // this section's rooms stack at the middle of the ring
    const own = homed.get(name) ?? [];
    own.forEach((room, i) => {
      const offset = (i - (own.length - 1) / 2) * 56;
      nodes.push({ id: room.id, kind: "room", x: centerX + offset, y: centerY });
    });

    cursorX += size;
    rowHeight = Math.max(rowHeight, size);
  }

  // the spanning row: rooms whose members live in different clusters
  if (spanning.length) {
    cursorY += rowHeight;
    rowHeight = 120;
    spanning.forEach((room, i) => {
      nodes.push({
        id: room.id,
        kind: "room",
        x: (width * (i + 1)) / (spanning.length + 1),
        y: cursorY + 60,
      });
    });
  }

  const at = new Map(nodes.map((n) => [n.id, n]));
  for (const room of [...homed.values()].flat().concat(spanning)) {
    for (const memberId of room.memberIds) {
      if (!at.has(memberId) || !at.has(room.id)) continue;
      edges.push({ from: room.id, to: memberId, active: busyOf.get(memberId) === true });
    }
  }

  return { nodes, edges, clusters, height: cursorY + rowHeight };
}
