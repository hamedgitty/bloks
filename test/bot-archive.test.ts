// Archiving or restoring an agent the server refuses is said, and the
// list is put back from the server, as it is for a room (GitHub 226).
import { test } from "node:test";
import assert from "node:assert/strict";

import { sendBotArchive } from "../src/lib/botArchive.ts";
import { initialState, reducer, type Bot } from "../src/state/reducer.ts";

const ada = {
  id: "a",
  threadId: "t-a",
  name: "Ada",
  title: "",
  description: "",
  notifications: true,
  color: "blue",
  unread: false,
  modelSelection: { instanceId: "claude", model: "m" },
  messages: [],
} as Bot;

test("a refused archive shows the error and the agent comes back to the list", async () => {
  let state = reducer(initialState, { type: "hydrate", bots: [ada] });
  // the row moves to the drawer at once, as the app does before the request
  state = reducer(state, { type: "deleteBot", botId: "a" });
  assert.equal(state.bots[0].hidden, true);

  const errors: unknown[] = [];
  const api = async (path: string, init?: RequestInit) => {
    if (init?.method === "DELETE") throw new Error("Ada is working. Stop it first.");
    assert.equal(path, "/api/bots");
    return { bots: [ada] };
  };
  await sendBotArchive(api, "a", "archive", (bots) => (state = reducer(state, { type: "hydrate", bots })), (e) =>
    errors.push(e),
  );
  assert.equal((errors[0] as Error)?.message, "Ada is working. Stop it first.");
  assert.equal(state.bots[0].hidden, undefined);
});

test("a refused restore puts the agent back in the drawer", async () => {
  const archived = { ...ada, hidden: true, archivedAt: 5 };
  let state = reducer(initialState, { type: "hydrate", bots: [archived] });
  state = reducer(state, { type: "restoreBot", botId: "a" });
  assert.equal(state.bots[0].hidden, false);
  await sendBotArchive(
    async (_path, init) => {
      if (init?.method === "POST") throw new Error("no such archived agent");
      return { bots: [archived] };
    },
    "a",
    "restore",
    (bots) => (state = reducer(state, { type: "hydrate", bots })),
    () => {},
  );
  assert.equal(state.bots[0].hidden, true);
  assert.equal(state.bots[0].archivedAt, 5);
});

test("each choice goes to its own route, and one the server takes asks for nothing more", async () => {
  const calls: string[] = [];
  const api = async (path: string, init?: RequestInit) => (calls.push(`${init?.method} ${path}`), {});
  for (const how of ["archive", "forget", "restore"] as const) {
    await sendBotArchive(api, "a", how, () => calls.push("hydrate"), () => calls.push("error"));
  }
  assert.deepEqual(calls, ["DELETE /api/bots/a", "DELETE /api/bots/a?forget=1", "POST /api/bots/a/restore"]);
});
