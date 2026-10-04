// `bloks recall` through the server: a message another agent sent is
// reported as that agent's, with its id, never as the person's
// (GitHub 136). An agent looking for the person's consent has to be able
// to tell the two apart.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startHarness } from "./helpers/server.ts";

test("a hit from another agent names it and gives its id; the person's own words stay the person's", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "bloks-recall-agent-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const first = await startHarness({ HOME: home });
  const { bot: alpha } = await first.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Alpha" }) });
  const { bot: bravo } = await first.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Bravo" }) });
  await first.stop();

  // the shape sendUserMessage writes for a message from another agent
  const file = join(home, ".bloks", `messages-${bravo.threadId}.json`);
  const list = (() => {
    try {
      return JSON.parse(readFileSync(file, "utf8"));
    } catch {
      return [];
    }
  })();
  list.push(
    { id: "from-alpha", at: Date.now() - 2000, role: "user", kind: "text", text: "zebra report: the client said yes", agent: { dir: "in", peerId: alpha.id, peerName: "Alpha" } },
    { id: "from-person", at: Date.now() - 1000, role: "user", kind: "text", text: "the zebra plan is approved" },
  );
  writeFileSync(file, JSON.stringify(list));

  const h = await startHarness({ HOME: home });
  t.after(() => h.stop());
  const { hits } = await h.json(`/api/bots/${bravo.id}/recall?q=zebra`);
  const fromAlpha = hits.find((hit: any) => hit.messageId === "from-alpha");
  const fromPerson = hits.find((hit: any) => hit.messageId === "from-person");
  assert.deepEqual({ who: fromAlpha.who, by: fromAlpha.by, agentId: fromAlpha.agentId }, { who: "Alpha", by: "agent", agentId: alpha.id });
  assert.equal(fromPerson.by, "person");
  assert.equal(fromPerson.agentId, undefined);
});
