// Standard Webhooks signatures on a webhook: the check itself, on the
// bytes and the three headers, and the real receiver around it, where a
// refused request reaches nobody and the secret never comes back out.
// Every secret here is made at runtime; none is written in this file.
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { allows } from "../server/agent-cli.ts";
import { SECRET_PATHS, stripSecrets } from "../server/backup.ts";
import {
  REPLAY_WINDOW_MS,
  SeenDeliveries,
  checkSignature,
  cleanSigningSecret,
  generateSigningSecret,
  signingKeys,
} from "../server/webhooks.ts";
import { secretLabel } from "../server/workspace-move.ts";
import { JoinClient } from "../server/join-client.ts";
import { startHarness } from "./helpers/server.ts";
import { teamPlan } from "./helpers/team-plan.ts";
import { agentOn, fakeProvider, waitFor } from "./helpers/turns.ts";

const PREFIX = ["wh", "sec_"].join("");
const whsec = () => `${PREFIX}${randomBytes(32).toString("base64")}`;
const raw = () => `raw-${randomBytes(18).toString("hex")}`;
const now = () => Math.floor(Date.now() / 1000);

/** A signature the way a Standard Webhooks sender makes one. */
function sign(secret: string, id: string, ts: number, body: string): string {
  const key = secret.startsWith(PREFIX) ? Buffer.from(secret.slice(PREFIX.length), "base64") : Buffer.from(secret, "utf8");
  return `v1,${createHmac("sha256", key).update(`${id}.${ts}.${body}`).digest("base64")}`;
}

function signed(secret: string, body: string, opts: { id?: string; ts?: number; family?: "webhook" | "svix"; signature?: string } = {}) {
  const id = opts.id ?? `msg_${randomBytes(8).toString("hex")}`;
  const ts = opts.ts ?? now();
  const family = opts.family ?? "webhook";
  return {
    [`${family}-id`]: id,
    [`${family}-timestamp`]: String(ts),
    [`${family}-signature`]: opts.signature ?? sign(secret, id, ts, body),
  };
}

// ── the check ───────────────────────────────────────────────────────────

test("a valid signature passes under either header family, for whsec_ and raw secrets", () => {
  const body = Buffer.from('{"type":"user.created","data":{"id":"u_1"}}');
  for (const secret of [whsec(), raw()]) {
    for (const family of ["webhook", "svix"] as const) {
      const headers = signed(secret, body.toString(), { family, id: `msg_${family}` });
      assert.deepEqual(checkSignature(secret, headers, body), { ok: true, id: `msg_${family}` }, `${family} ${secret.slice(0, 4)}`);
    }
  }
});

test("every v1 entry is tried, other versions are passed over, and a wrong one fails", () => {
  const secret = whsec();
  const body = Buffer.from("payload");
  const id = "msg_rolling";
  const ts = now();
  const good = sign(secret, id, ts, "payload");
  const old = sign(whsec(), id, ts, "payload");
  const headers = (signature: string) => ({ "webhook-id": id, "webhook-timestamp": String(ts), "webhook-signature": signature });
  assert.equal(checkSignature(secret, headers(`${old} ${good}`), body).ok, true, "the second of two keys");
  assert.equal(checkSignature(secret, headers(`v1a,${good.slice(3)} ${good}`), body).ok, true, "past an asymmetric entry");
  assert.deepEqual(checkSignature(secret, headers(`v1a,${good.slice(3)}`), body), { ok: false, refused: "signature" }, "v1a is not v1");
  assert.deepEqual(checkSignature(secret, headers(old), body), { ok: false, refused: "signature" });
  assert.deepEqual(checkSignature(secret, headers(`v1,${"A".repeat(43)}=`), body), { ok: false, refused: "signature" });
  // the bytes as they came: a body reformatted on the way is another body
  assert.equal(checkSignature(secret, headers(sign(secret, id, ts, '{"a":1}')), Buffer.from('{ "a": 1 }')).ok, false);
});

test("a stale or future timestamp, missing headers and a mix of families are refused", () => {
  const secret = raw();
  const body = Buffer.from("x");
  assert.deepEqual(checkSignature(secret, signed(secret, "x", { ts: now() - 6 * 60 }), body), { ok: false, refused: "timestamp" });
  assert.deepEqual(checkSignature(secret, signed(secret, "x", { ts: now() + 6 * 60 }), body), { ok: false, refused: "timestamp" });
  assert.equal(checkSignature(secret, signed(secret, "x", { ts: now() - 4 * 60 }), body).ok, true, "inside five minutes");
  assert.deepEqual(checkSignature(secret, {}, body), { ok: false, refused: "headers" });
  const full = signed(secret, "x");
  assert.deepEqual(checkSignature(secret, { ...full, "webhook-timestamp": "soon" }, body), { ok: false, refused: "headers" });
  const mixed = { "webhook-id": full["webhook-id"], "webhook-timestamp": full["webhook-timestamp"], "svix-signature": full["webhook-signature"] };
  assert.deepEqual(checkSignature(secret, mixed, body), { ok: false, refused: "headers" });
});

test("secrets: generated ones are whsec_ and 32 bytes, pasted ones are checked, a bare base64 key is tried both ways", () => {
  const made = generateSigningSecret();
  assert.ok(made.startsWith(PREFIX));
  assert.equal(Buffer.from(made.slice(PREFIX.length), "base64").length, 32);
  assert.notEqual(generateSigningSecret(), made);
  assert.equal(cleanSigningSecret(` ${made} `).ok, true, "trimmed");
  assert.equal(cleanSigningSecret(`${PREFIX}not base64!`).ok, false);
  assert.equal(cleanSigningSecret(`${PREFIX}c2hvcnQ=`).ok, false, "too short a key");
  assert.equal(cleanSigningSecret("short").ok, false);
  assert.equal(cleanSigningSecret("has a space in it somewhere").ok, false);
  assert.equal(cleanSigningSecret(42).ok, false);
  assert.equal(cleanSigningSecret(raw()).ok, true);
  // a Standard Webhooks key shown without its prefix
  const bare = randomBytes(24).toString("base64");
  assert.equal(signingKeys(bare).length, 2);
  assert.equal(checkSignature(bare, signed(`${PREFIX}${bare}`, "y"), Buffer.from("y")).ok, true);
});

test("seen deliveries expire after the replay window and stay within their cap", () => {
  const seen = new SeenDeliveries(3);
  const t0 = 1_000_000;
  seen.note("hook", "a", t0);
  assert.equal(seen.has("hook", "a", t0 + 1), true);
  assert.equal(seen.has("other", "a", t0 + 1), false, "per hook");
  assert.equal(seen.has("hook", "a", t0 + REPLAY_WINDOW_MS + 1), false);
  for (const id of ["b", "c", "d", "e"]) seen.note("hook", id, t0 + 10);
  assert.equal(seen.has("hook", "b", t0 + 20), false, "the oldest went first");
  assert.equal(seen.has("hook", "e", t0 + 20), true);
});

test("a signing secret is a saved key: out of an unsealed backup, named in a move", () => {
  assert.ok(SECRET_PATHS.includes("webhookSecrets.*" as (typeof SECRET_PATHS)[number]));
  const config = { webhookSecrets: { h1: whsec() }, profile: { name: "Sam" } };
  assert.deepEqual(stripSecrets(config), ["webhookSecrets.h1"]);
  assert.deepEqual(config, { webhookSecrets: {}, profile: { name: "Sam" } });
  assert.equal(secretLabel("webhookSecrets.h1", {}), "A webhook's signing secret");
});

test("an agent can neither set, remove nor read a webhook or its secret", () => {
  for (const [method, path] of [
    ["GET", "/api/webhooks"],
    ["POST", "/api/webhooks/h1/signing"],
    ["DELETE", "/api/webhooks/h1/signing"],
    ["PATCH", "/api/webhooks/h1"],
  ]) {
    assert.equal(allows("agent", method, path).ok, false, `${method} ${path}`);
  }
});

// ── the receiver ────────────────────────────────────────────────────────

async function workspace(t: TestContext) {
  const p = await fakeProvider(t);
  p.state.answerAtOnce = true;
  const h = await startHarness();
  t.after(() => h.stop());
  const bot = await agentOn(h, p.port, "Receiver");
  const { webhook } = await h.json("/api/webhooks", { method: "POST", body: JSON.stringify({ name: "Clerk events", botId: bot.id }) });
  const fire = (body: string, headers: Record<string, string> = {}) =>
    h.fetch(`/hook/${webhook.token}`, { method: "POST", body, headers });
  const saved = async () => (await h.json("/api/webhooks")).webhooks.find((hook: any) => hook.id === webhook.id);
  const idle = () =>
    waitFor(async () => (await h.json("/api/bots")).bots.find((b: any) => b.id === bot.id)?.tasks.every((lane: any) => lane.state === "idle"));
  return { p, h, bot, webhook, fire, saved, idle };
}

test("a signed hook takes only signed, fresh, first-time requests, and refuses the rest before the agent", async (t) => {
  const { p, h, webhook, fire, saved, idle } = await workspace(t);

  // Generate: the secret comes back this once
  const made = await h.fetch(`/api/webhooks/${webhook.id}/signing`, { method: "POST", body: JSON.stringify({ generate: true }) });
  assert.equal(made.status, 200);
  assert.equal(made.headers.get("cache-control"), "no-store");
  const { secret, webhook: after } = (await made.json()) as any;
  assert.ok(secret.startsWith(PREFIX));
  assert.equal(after.signed, true);

  // kept with the other keys, never beside the hook, and never read back
  const config = JSON.parse(readFileSync(join(h.home, ".bloks", "config.json"), "utf8"));
  assert.equal(config.webhookSecrets[webhook.id], secret);
  assert.ok(!readFileSync(join(h.home, ".bloks", "webhooks.json"), "utf8").includes(secret));
  const listed = await h.fetch("/api/webhooks");
  const listedText = await listed.text();
  assert.ok(!listedText.includes(secret), "GET /api/webhooks carries the secret");
  assert.equal(JSON.parse(listedText).webhooks[0].signed, true);
  for (const res of [
    await h.fetch(`/api/webhooks/${webhook.id}`, { method: "PATCH", body: JSON.stringify({ name: "Clerk" }) }),
    await h.fetch(`/api/agent/settings?category=automations`),
  ]) assert.ok(!(await res.text()).includes(secret));

  // unsigned, as before: refused, and the activity says why
  const plain = await fire(JSON.stringify({ event: "UNSIGNED-EVENT" }));
  assert.equal(plain.status, 401);
  assert.match((await plain.json()).error, /webhook-signature/);
  assert.equal((await saved()).deliveries[0].refused, "headers");

  // signed properly: in, and to the agent
  const body = JSON.stringify({ event: "SIGNED-EVENT" });
  const good = signed(secret, body);
  assert.equal((await fire(body, good)).status, 202);
  assert.ok(await waitFor(() => p.sent("SIGNED-EVENT") > 0), h.logs());
  await idle();

  // the same delivery again is a replay, whatever its signature says
  const again = await fire(body, good);
  assert.equal(again.status, 401);
  assert.match((await again.json()).error, /already received/);

  // a stale timestamp, a wrong secret, a changed body
  const stale = await fire(JSON.stringify({ event: "STALE-EVENT" }), signed(secret, JSON.stringify({ event: "STALE-EVENT" }), { ts: now() - 600 }));
  assert.equal(stale.status, 401);
  const wrong = JSON.stringify({ event: "FORGED-EVENT" });
  assert.equal((await fire(wrong, signed(whsec(), wrong))).status, 401);
  assert.equal((await fire(wrong, signed(whsec(), wrong))).status, 401);
  const tampered = signed(secret, JSON.stringify({ event: "ORIGINAL" }));
  assert.equal((await fire(JSON.stringify({ event: "TAMPERED-EVENT" }), tampered)).status, 401);
  const rows = (await saved()).deliveries;
  assert.equal(rows[0].refused, "signature");
  assert.equal(rows[0].times, 3, "the same refusal again is one row, counted");
  assert.equal(rows[1].refused, "timestamp");
  assert.equal(rows[2].refused, "replay");
  for (const marker of ["UNSIGNED-EVENT", "STALE-EVENT", "FORGED-EVENT", "TAMPERED-EVENT"]) {
    assert.equal(p.sent(marker), 0, `${marker} reached the agent`);
  }
  const fired = await saved();
  assert.equal(fired.firedCount, 1, "only the signed delivery counts as fired");
  assert.ok(!rows.some((row: any) => row.refused && row.excerpt), "nothing of a refused body is kept");

  // Svix's header names are the same check
  const svixBody = JSON.stringify({ event: "SVIX-EVENT" });
  assert.equal((await fire(svixBody, signed(secret, svixBody, { family: "svix" }))).status, 202);
  assert.ok(await waitFor(() => p.sent("SVIX-EVENT") > 0), h.logs());
  await idle();

  // the sender's own raw secret, pasted: not shown back
  const senders = raw();
  const pasted = await h.fetch(`/api/webhooks/${webhook.id}/signing`, { method: "POST", body: JSON.stringify({ secret: senders }) });
  assert.equal(pasted.status, 200);
  assert.ok(!(await pasted.text()).includes(senders));
  const rawBody = JSON.stringify({ event: "RAW-SECRET-EVENT" });
  assert.equal((await fire(rawBody, signed(secret, rawBody))).status, 401, "the old secret stopped working");
  assert.equal((await fire(rawBody, signed(senders, rawBody))).status, 202);
  assert.ok(await waitFor(() => p.sent("RAW-SECRET-EVENT") > 0), h.logs());
  await idle();
  const bad = await h.fetch(`/api/webhooks/${webhook.id}/signing`, { method: "POST", body: JSON.stringify({ secret: "too short" }) });
  assert.equal(bad.status, 400);

  // removed: the URL alone is enough again, and the key is gone
  const off = await h.fetch(`/api/webhooks/${webhook.id}/signing`, { method: "DELETE" });
  assert.equal(off.status, 200);
  assert.equal(((await off.json()) as any).webhook.signed, false);
  assert.equal(JSON.parse(readFileSync(join(h.home, ".bloks", "config.json"), "utf8")).webhookSecrets[webhook.id], undefined);
  assert.equal((await fire(JSON.stringify({ event: "UNSIGNED-AGAIN" }))).status, 202);
  assert.ok(await waitFor(() => p.sent("UNSIGNED-AGAIN") > 0), h.logs());

  // never in the logs, never in what the model was sent
  for (const value of [secret, senders]) {
    assert.ok(!h.logs().includes(value), "a secret reached the logs");
    assert.ok(!p.state.calls.some((call) => call.includes(value)), "a secret reached the model");
  }
});

test("a hook without a secret is unchanged, beside one that has one", async (t) => {
  const { p, h, bot, fire, saved } = await workspace(t);
  const { webhook: other } = await h.json("/api/webhooks", { method: "POST", body: JSON.stringify({ name: "Signed", botId: bot.id }) });
  await h.fetch(`/api/webhooks/${other.id}/signing`, { method: "POST", body: JSON.stringify({ generate: true }) });
  const res = await fire(JSON.stringify({ event: "PLAIN-EVENT" }));
  assert.equal(res.status, 202);
  assert.ok(await waitFor(() => p.sent("PLAIN-EVENT") > 0), h.logs());
  const plain = await saved();
  assert.equal(plain.signed, false);
  assert.equal(plain.deliveries[0].refused, undefined);
  assert.equal(plain.firedCount, 1);
  assert.equal((await h.fetch(`/api/webhooks/nope/signing`, { method: "POST", body: JSON.stringify({ generate: true }) })).status, 404);
  // a removed hook's secret leaves the file with it
  const keys = () => JSON.parse(readFileSync(join(h.home, ".bloks", "config.json"), "utf8")).webhookSecrets ?? {};
  assert.ok(keys()[other.id]);
  assert.equal((await h.fetch(`/api/webhooks/${other.id}`, { method: "DELETE" })).status, 200);
  assert.equal(keys()[other.id], undefined);
});

test("a signed hook whose secret did not come with the workspace refuses everything", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "bloks-sign-lost-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  let h = await startHarness({ HOME: home, USERPROFILE: home });
  const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Moved" }) });
  const { webhook } = await h.json("/api/webhooks", { method: "POST", body: JSON.stringify({ name: "Moved", botId: bot.id }) });
  const { secret } = await h.json(`/api/webhooks/${webhook.id}/signing`, { method: "POST", body: JSON.stringify({ generate: true }) });
  await h.stop();
  // the keys taken out, as an unsealed backup or a move leaves them
  const file = join(home, ".bloks", "config.json");
  const config = JSON.parse(readFileSync(file, "utf8"));
  stripSecrets(config);
  writeFileSync(file, JSON.stringify(config));
  h = await startHarness({ HOME: home, USERPROFILE: home });
  t.after(() => h.stop());
  const shown = (await h.json("/api/webhooks")).webhooks[0];
  assert.equal(shown.signed, true);
  assert.equal(shown.secretLost, true);
  const body = JSON.stringify({ event: "AFTER-MOVE" });
  assert.equal((await h.fetch(`/hook/${webhook.token}`, { method: "POST", body })).status, 401, "never the URL alone again");
  assert.equal((await h.fetch(`/hook/${webhook.token}`, { method: "POST", body, headers: signed(secret, body) })).status, 401);
  assert.equal((await h.json("/api/webhooks")).webhooks[0].deliveries[0].refused, "lost");
});

test("members and admins reach no webhook route, the signing secret's included", { timeout: 120_000 }, async (t) => {
  const home = mkdtempSync(join(tmpdir(), "bloks-sign-roles-"));
  const licence = await teamPlan();
  t.after(() => licence.close());
  mkdirSync(join(home, ".bloks"), { recursive: true });
  writeFileSync(join(home, ".bloks", "config.json"), JSON.stringify({ remote: { enabled: true }, profile: { name: "Hamed" }, ...licence.config }));
  const h = await startHarness({ HOME: home, ...licence.env });
  t.after(() => h.stop());
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const lan = new URL(h.url).host;
  const joinAs = async (name: string, role: "member" | "admin") => {
    const made = await h.json("/api/workspace/invites", { method: "POST", body: JSON.stringify({ role, name }) });
    const client = new JoinClient(() => "http://127.0.0.1:9");
    const found = (await client.lookup(`${made.invite.link}~${lan}`)) as any;
    await client.claim(found.session, { name });
    assert.equal((await h.fetch(`/api/workspace/requests/${made.invite.id}/approve`, { method: "POST" })).status, 200);
    return ((await client.status(found.session)) as any).credentials as { deviceToken: string };
  };
  const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Chief" }) });
  const { webhook } = await h.json("/api/webhooks", { method: "POST", body: JSON.stringify({ name: "Events", botId: bot.id }) });
  const { secret } = await h.json(`/api/webhooks/${webhook.id}/signing`, { method: "POST", body: JSON.stringify({ generate: true }) });
  for (const who of [await joinAs("Sam", "admin"), await joinAs("Ana", "member")]) {
    for (const [method, path, body] of [
      ["GET", "/api/webhooks", undefined],
      ["POST", `/api/webhooks/${webhook.id}/signing`, { generate: true }],
      ["POST", `/api/webhooks/${webhook.id}/signing`, { secret: raw() }],
      ["DELETE", `/api/webhooks/${webhook.id}/signing`, undefined],
    ] as const) {
      const res = await h.fetchRemote(path, { method, token: who.deviceToken, ...(body ? { body: JSON.stringify(body) } : {}) });
      assert.equal(res.status, 403, `${method} ${path}`);
      assert.ok(!JSON.stringify(res.body).includes(secret));
    }
  }
  // the owner's secret is the one still in force
  const signedBody = JSON.stringify({ event: "OWNER-SECRET" });
  assert.notEqual((await h.fetch(`/hook/${webhook.token}`, { method: "POST", body: signedBody, headers: signed(secret, signedBody) })).status, 401);
});
