// Favorites or All in the sidebar (src/lib/agentFilter.ts, GitHub 525):
// which agents each lists, and what is left for the Agents page.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { AGENT_FILTER_KEY, filterAgents, inFavorites, readAgentFilter, writeAgentFilter } from "../src/lib/agentFilter.ts";

const bots = [
  { id: "pinned", pinned: true },
  { id: "quiet" },
  { id: "unread", unread: true },
  { id: "asking", tasks: [{ state: "idle" }, { state: "needs-you" }] },
  { id: "laneUnread", tasks: [{ state: "idle", unread: true }] },
  { id: "busy", tasks: [{ state: "working" }] },
];

describe("Favorites", () => {
  test("lists the pinned, and others only while they have something for you", () => {
    const { shown, more } = filterAgents(bots, "favorites", null);
    assert.deepEqual(shown.map((b) => b.id), ["pinned", "unread", "asking", "laneUnread"]);
    assert.equal(more, 2);
  });

  test("keeps the agent on screen, so opening one never loses its row", () => {
    assert.equal(inFavorites({ id: "quiet" }, "quiet"), true);
    assert.deepEqual(filterAgents(bots, "favorites", "busy").shown.map((b) => b.id).includes("busy"), true);
  });
});

describe("All", () => {
  test("is the list as it always was, with nothing left over", () => {
    const { shown, more } = filterAgents(bots, "all", null);
    assert.equal(shown.length, bots.length);
    assert.equal(more, 0);
  });
});

describe("kept on this device", () => {
  test("All until Favorites is chosen, and anything else read as All", () => {
    const saved = new Map<string, string>();
    const storage = { getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, v: string) => void saved.set(k, v) };
    assert.equal(readAgentFilter(storage), "all");
    writeAgentFilter(storage, "favorites");
    assert.equal(saved.get(AGENT_FILTER_KEY), "favorites");
    assert.equal(readAgentFilter(storage), "favorites");
    saved.set(AGENT_FILTER_KEY, "nonsense");
    assert.equal(readAgentFilter(storage), "all");
    assert.equal(readAgentFilter(undefined), "all");
    const refusing = { getItem: () => { throw new Error("no"); }, setItem: () => { throw new Error("no"); } };
    assert.equal(readAgentFilter(refusing), "all");
    assert.doesNotThrow(() => writeAgentFilter(refusing, "favorites"));
  });
});
