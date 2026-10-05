// The phone comes from the App Store and the Mac updates itself, so each
// can be ahead of the other. These are the three facts that let them cope:
// the Mac says what it is and what it can do, the phone says which build
// it is, and a route the Mac does not have yet answers in a way a phone
// can recognise and explain.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { FEATURES } from "../server/features.ts";
import { startHarness, type Harness } from "./helpers/server.ts";

const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

async function pairADevice(h: Harness, name = "Test iPhone") {
  await h.fetch("/api/pair", { method: "PUT", body: JSON.stringify({ enabled: true }) });
  const started = await h.json("/api/pair/start", { method: "POST" });
  const claimed = await h.fetchRemote("/api/pair/claim", {
    method: "POST",
    body: JSON.stringify({ code: started.code, device: name }),
  });
  return claimed.body as { token: string; device: { id: string } };
}

test("health says which version this is and what it can do for a phone", async (t) => {
  const h = await startHarness();
  t.after(() => h.stop());

  const health = await h.json("/api/health");
  assert.equal(health.app, "bloks");
  assert.equal(health.version, VERSION);
  assert.deepEqual(health.features, [...FEATURES]);
  // the phone gates on these by name; losing one strands a shipped phone
  for (const name of ["sections", "earlier", "exchange", "calls", "watchers", "briefs", "routines", "webhooks", "notes"]) {
    assert.ok(health.features.includes(name), `${name} went missing from the feature list`);
  }
  assert.equal(new Set(FEATURES).size, FEATURES.length, "a feature is listed twice");
});

test("a paired phone's build shows on the device list, and nonsense is not stored", async (t) => {
  const h = await startHarness();
  t.after(() => h.stop());
  const { token, device } = await pairADevice(h);

  await h.fetchRemote("/api/bots", { token, headers: { "x-bloks-client": "iOS 2.1.6 (15)" } });
  let status = await h.json("/api/pair");
  assert.equal(status.devices.find((d: { id: string }) => d.id === device.id)?.client, "iOS 2.1.6 (15)");

  // markup and overlong labels are dropped, and the last good one stays
  await h.fetchRemote("/api/bots", { token, headers: { "x-bloks-client": "<script>alert(1)</script>" } });
  await h.fetchRemote("/api/bots", { token, headers: { "x-bloks-client": "x".repeat(200) } });
  status = await h.json("/api/pair");
  assert.equal(status.devices.find((d: { id: string }) => d.id === device.id)?.client, "iOS 2.1.6 (15)");

  // an unpaired caller's label is never recorded against anybody
  await h.fetchRemote("/api/bots", { headers: { "x-bloks-client": "iOS 9.9.9 (99)" } });
  status = await h.json("/api/pair");
  assert.ok(!status.devices.some((d: { client?: string }) => d.client === "iOS 9.9.9 (99)"));
});

test("a route this Mac does not have answers with a code a phone can explain", async (t) => {
  const h = await startHarness();
  t.after(() => h.stop());
  const { token } = await pairADevice(h);

  const res = await h.fetchRemote("/api/some-feature-from-the-future", { token });
  assert.equal(res.status, 404);
  assert.equal(res.body.code, "unknown_route");
  // the words are what an older phone, which does not know the code, reads
  assert.match(res.body.error, /^no route: /);
});
