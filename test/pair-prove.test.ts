// A paired phone finding its Bloks again after it moved: the workspace is
// recognised by its tag on the network, and the Bloks at the new address
// proves it holds the phone's pairing before the phone's token goes there.
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { proveDevice } from "../server/pairing.ts";
import { startHarness } from "./helpers/server.ts";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

test("the Bloks a phone paired with can prove it, and nothing else can be asked", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "bloks-prove-"));
  mkdirSync(join(home, ".bloks"), { recursive: true });
  let h = await startHarness({ HOME: home });
  t.after(async () => {
    await h.stop();
    rmSync(home, { recursive: true, force: true });
  });

  await h.fetch("/api/pair", { method: "PUT", body: JSON.stringify({ enabled: true }) });
  const started = await h.json("/api/pair/start", { method: "POST" });
  const claimed = await h.fetchRemote("/api/pair/claim", {
    method: "POST",
    body: JSON.stringify({ code: started.code, device: "Test iPhone" }),
  });
  const digest = sha256(claimed.body.token);
  const hint = sha256(digest).slice(0, 16);
  const nonce = "n0nce-for-this-one-check";

  // without a token, from the network, as a phone at the new address asks
  const proved = await h.fetchRemote("/api/pair/prove", { method: "POST", body: JSON.stringify({ hint, nonce }) });
  assert.equal(proved.status, 200);
  const { proof } = proved.body;
  assert.equal(proof, createHmac("sha256", digest).update(`bloks-prove:${nonce}`).digest("hex"));

  // another phone's hint, and asks of the wrong shape, get nothing
  const otherHint = `${hint[0] === "0" ? "1" : "0"}${hint.slice(1)}`;
  for (const body of [
    { hint: otherHint, nonce },
    { hint, nonce: "short" },
    { hint, nonce: 42 },
  ]) {
    const res = await h.fetchRemote("/api/pair/prove", { method: "POST", body: JSON.stringify(body) });
    assert.equal(res.status, 404, JSON.stringify(body));
  }

  // the workspace's tag is said on health, and is the same after a restart
  const tag = (await h.json("/api/health")).tag;
  assert.match(tag, /^[0-9a-f]{16}$/);
  await h.stop();
  h = await startHarness({ HOME: home });
  assert.equal((await h.json("/api/health")).tag, tag);
});

// A hint is lowercase hex, so a phone's hint in capitals is the wrong shape
// and gets nothing. A paired phone's hint is random and can be only digits,
// which are the same in capitals, so this takes two made-up phones whose
// hints are known: one with letters, one of only digits.
test("a hint in capitals gets nothing, and a hint of only digits has no capitals", () => {
  // token digests: phone 1's hint has letters, phone 327's is only digits
  const lettered = sha256("phone 1");
  const numeric = sha256("phone 327");
  const config = {
    remote: { devices: [lettered, numeric].map((hash, i) => ({ id: `phone-${i}`, name: "Test iPhone", hash, pairedAt: 0 })) },
  };
  const nonce = "n0nce-for-this-one-check";
  const hintOf = (digest: string) => sha256(digest).slice(0, 16);
  const proofOf = (digest: string) => createHmac("sha256", digest).update(`bloks-prove:${nonce}`).digest("hex");

  assert.notEqual(hintOf(lettered).toUpperCase(), hintOf(lettered));
  assert.equal(proveDevice(hintOf(lettered), nonce, config), proofOf(lettered));
  assert.equal(proveDevice(hintOf(lettered).toUpperCase(), nonce, config), null);

  assert.equal(hintOf(numeric).toUpperCase(), hintOf(numeric));
  assert.equal(proveDevice(hintOf(numeric).toUpperCase(), nonce, config), proofOf(numeric));
});
