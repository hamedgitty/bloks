// A routine's turn the person stops is not the routine failing (#553): the
// run says it was stopped, it is not counted toward the routine stopping
// itself, and no incident asks the person to act on work they halted. The
// real server and a turn that stays open until the test stops it.
import assert from "node:assert/strict";
import { test } from "node:test";

import { controlledChain } from "./helpers/agent-chain.ts";
import { waitFor } from "./helpers/turns.ts";

test("a routine turn the person stops is recorded as stopped, with no incident", async (t) => {
  const chain = await controlledChain(t);
  const h = chain.h;
  await h.fetch("/api/config", { method: "PUT", body: JSON.stringify({ incidents: { enabled: true, lead: "person" } }) });
  const rex = await chain.hire("Rex");
  const { routine } = await h.json("/api/routines", {
    method: "POST",
    body: JSON.stringify({ targetId: rex.id, targetKind: "agent", name: "Morning sweep", prompt: "Sweep the inbox", time: "06:00" }),
  });

  const before = chain.turns().length;
  assert.equal((await h.fetch(`/api/routines/${routine.id}/run`, { method: "POST" })).status, 202);
  await chain.turnAfter(before);
  const stop = await h.fetch(`/api/bots/${rex.id}/interrupt`, { method: "POST" });
  assert.ok(stop.ok, `interrupt answered ${stop.status}`);

  const run = await waitFor(async () => {
    const found = (await h.json("/api/routines")).routines.find((r: any) => r.id === routine.id);
    return found?.runs?.find((r: any) => r.state !== "running") ?? null;
  }, 15_000);
  assert.ok(run, "the run never ended");
  assert.equal(run.state, "failed", "it did not finish, which older clients still read");
  assert.equal(run.stopped, true, "and it says the person stopped it");
  assert.equal(run.error, undefined, "it is not written down as an error");

  const after = (await h.json("/api/routines")).routines.find((r: any) => r.id === routine.id);
  assert.equal(after.failures, undefined, "not counted toward stopping the routine");
  const incidents = (await h.json("/api/incidents")).incidents as any[];
  assert.deepEqual(incidents.filter((i) => i.subject === `routine:${routine.id}`), [], "no incident for a turn the person stopped");
});
