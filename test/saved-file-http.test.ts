// Real startup and request paths, with faults only in a throwaway home.
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { generateKeyPairSync, createPublicKey } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startHarness } from "./helpers/server.ts";
import { fakeProvider, waitFor, idle } from "./helpers/turns.ts";

const ENTRY = fileURLToPath(new URL("../server/index.ts", import.meta.url));
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function fixture(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), "bloks-read-http-"));
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }));
  const data = join(home, ".bloks");
  mkdirSync(data, { recursive: true });
  const fault = join(home, "fault.json");
  const hook = join(home, "read-fault.mjs");
  writeFileSync(fault, "{}");
  writeFileSync(hook, `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const real = fs.readFileSync;
let previous = "", reads = 0;
fs.readFileSync = function(file, ...args) {
  const text = real(${JSON.stringify(fault)}, "utf8");
  if (text !== previous) { reads = 0; previous = text; }
  const fault = JSON.parse(text);
  if (String(file) === fault.file && ++reads >= (fault.nth ?? 1)) {
    throw Object.assign(new Error("planted-secret must not appear"), { code: fault.code ?? "EACCES" });
  }
  return real(file, ...args);
};
syncBuiltinESMExports();
`);
  const write = (name: string, text: string) => {
    const path = join(data, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text, { mode: 0o600 });
    return path;
  };
  const bots = ["first", "second"].map((id) => ({
    id, name: id, threadId: `lane_${id}`, activeTaskId: `lane_${id}`, createdAt: 1,
    modelSelection: { instanceId: "codex", model: "default" },
    tasks: [{ id: `lane_${id}`, title: "General", resumeCursors: {}, createdAt: 1 }],
  }));
  write("bots.json", JSON.stringify(bots));
  write("config.json", '{"providers":{},"profile":{"name":"Fixture"}}');
  const messages = [{ id: "one", at: 1, role: "user", kind: "text", text: "first saved row" }, { id: "two", at: 2, role: "bot", kind: "text", text: "second saved row" }];
  write("messages-lane_first.json", JSON.stringify(messages));
  const fail = (file: string, code = "EACCES", nth = 1) => writeFileSync(fault, JSON.stringify({ file, code, nth }));
  const restore = () => writeFileSync(fault, "{}");
  const env = { HOME: home, USERPROFILE: home, NODE_OPTIONS: `--import=${hook}` };
  return { home, data, write, fail, restore, env, bots, messages, hook };
}

async function startup(f: ReturnType<typeof fixture>) {
  const child = spawn(process.execPath, ["--import", f.hook, ENTRY], {
    env: { HOME: f.home, USERPROFILE: f.home, TMPDIR: tmpdir(), PATH: "/nonexistent", BLOKS_PORT: "0", BLOKS_LOOPBACK_ONLY: "1", TZ: "UTC" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "", err = "", exited = false, code: number | null = null;
  child.stdout!.on("data", (c) => { out += c; });
  child.stderr!.on("data", (c) => { err += c; });
  const done = new Promise<void>((resolve) => child.once("close", (n) => { code = n; exited = true; resolve(); }));
  const until = Date.now() + 60_000;
  try {
    while (!exited && !out.includes("bloks server on") && Date.now() < until) await pause(20);
    assert.ok(exited || out.includes("bloks server on"), `startup did not settle: ${err}`);
    return { out, err, code };
  } finally {
    if (!exited) child.kill("SIGKILL");
    await done;
  }
}

test("startup refuses unreadable stores with one useful private-content-free error and can retry", async (t) => {
  for (const [name, text] of [
    ["bots.json", null],
    ["messages-lane_first.json", null],
    ["briefs.json", "[]"],
    ["meetings.json", "[]"],
    ["watchers.json", "[]"],
    ["people.json", "{}"],
    ["claude-session-costs.json", "{}"],
  ] as const) {
    await t.test(name, async (t) => {
      const f = fixture(t);
      const file = text === null ? join(f.data, name) : f.write(name, text);
      const original = readFileSync(file, "utf8");
      f.fail(file, "EMFILE");
      const result = await startup(f);
      assert.equal(result.out.includes("bloks server on"), false, "the server offered replacement empty state");
      assert.notEqual(result.code, null);
      assert.notEqual(result.code, 0);
      const diagnostic = result.err.split("\n").filter((line) => line.startsWith("Error: [bloks]"));
      assert.equal(diagnostic.length, 1, result.err);
      assert.ok(diagnostic[0].includes(name));
      assert.match(diagnostic[0], /EMFILE.*Restore file access and retry/);
      assert.doesNotMatch(result.err, /planted-secret/);
      assert.equal(readFileSync(file, "utf8"), original);
      f.restore();
      const h = await startHarness(f.env);
      try {
        const { bots } = await h.json("/api/bots");
        const first = bots.find((b: any) => b.id === "first");
        assert.ok(first);
        assert.deepEqual(first.messages.map((m: any) => m.text), f.messages.map((m) => m.text));
      } finally { await h.stop(); }
    });
  }
});

function pemFixture() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const pem = privateKey.export({ format: "pem", type: "pkcs8" }) as string;
  const der = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  return { pem, fingerprint: der.subarray(der.length - 32).toString("hex") };
}

test("one unreadable identity leaves listing and person-message delivery available without replacing or caching the key", async (t) => {
  const f = fixture(t);
  const first = pemFixture(), second = pemFixture();
  const file = f.write("identities/first.pem", first.pem);
  f.write("identities/second.pem", second.pem);
  f.fail(file);
  const h = await startHarness(f.env);
  try {
    const listing = await h.fetch("/api/bots");
    assert.equal(listing.status, 200);
    const { bots } = await listing.json();
    assert.equal(Object.hasOwn(bots.find((b: any) => b.id === "first"), "fingerprint"), false);
    assert.equal(bots.find((b: any) => b.id === "second").fingerprint, second.fingerprint);
    assert.equal(readFileSync(file, "utf8"), first.pem);
    const reply = await h.fetch("/api/bots/first/messages", { method: "POST", body: JSON.stringify({ text: "only once" }) });
    assert.equal(reply.status, 202, await reply.text());
    const onDisk = JSON.parse(readFileSync(join(f.data, "messages-lane_first.json"), "utf8"));
    assert.equal(onDisk.filter((m: any) => m.role === "user" && m.text === "only once").length, 1);
    assert.equal(readFileSync(file, "utf8"), first.pem);
    f.restore();
    const restored = await h.json("/api/bots");
    assert.equal(restored.bots.find((b: any) => b.id === "first").fingerprint, first.fingerprint);
    assert.doesNotMatch(h.logs(), /planted-secret/);
  } finally { await h.stop(); }
});

test("a corrupt PEM is preserved byte for byte before regeneration and listing stays available", async (t) => {
  const f = fixture(t);
  const original = "not a key: planted-secret";
  f.write("identities/first.pem", original);
  const h = await startHarness(f.env);
  try {
    const response = await h.fetch("/api/bots");
    assert.equal(response.status, 200);
    const { bots } = await response.json();
    const fingerprint = bots.find((b: any) => b.id === "first").fingerprint;
    assert.match(fingerprint, /^[0-9a-f]{64}$/);
    const folder = join(f.data, "identities");
    const aside = readdirSync(folder).filter((name) => name.startsWith("first.pem.corrupt-"));
    assert.equal(aside.length, 1);
    assert.equal(readFileSync(join(folder, aside[0]), "utf8"), original);
    assert.doesNotMatch(h.logs(), /planted-secret/);
    assert.ok(createPublicKey(readFileSync(join(folder, "first.pem"), "utf8")));
  } finally { await h.stop(); }
});

test("memory edits and deletion refuse a failed history read before changing the memory file", async (t) => {
  const f = fixture(t);
  const file = f.write("memory-journal/first.json", '[{"id":"saved","file":"MEMORY.md","before":null,"after":"old","at":1,"by":"you"}]');
  const main = f.write("workspaces/first/MEMORY.md", "old");
  const topic = f.write("workspaces/first/memory/topic.md", "old topic");
  const original = readFileSync(file, "utf8");
  const h = await startHarness(f.env);
  try {
    f.fail(file, "EIO");
    for (const [route, method, body] of [
      ["memory", "PUT", { text: "new" }],
      ["memory/topics/topic.md", "PUT", { text: "new topic" }],
      ["memory/topics/topic.md", "DELETE", undefined],
    ] as const) {
      const reply = await h.fetch(`/api/bots/first/${route}`, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
      assert.equal(reply.status, 500);
      assert.match((await reply.json()).error, /EIO.*Restore file access and retry/);
      assert.equal(readFileSync(main, "utf8"), "old");
      assert.equal(readFileSync(topic, "utf8"), "old topic");
      assert.equal(readFileSync(file, "utf8"), original);
    }
    f.restore();
    const reply = await h.fetch("/api/bots/first/memory", { method: "PUT", body: JSON.stringify({ text: "new" }) });
    assert.equal(reply.status, 200);
    assert.equal(readFileSync(main, "utf8"), "new");
    assert.equal(JSON.parse(readFileSync(file, "utf8")).length, 2);
  } finally { await h.stop(); }
});

test("a config save refreshes live settings without another failing disk read", async (t) => {
  const f = fixture(t);
  const h = await startHarness(f.env);
  try {
    f.fail(join(f.data, "config.json"), "EMFILE", 2);
    const reply = await h.fetch("/api/config", { method: "PATCH", body: JSON.stringify({ profile: { about: "Updated fixture" } }) });
    assert.equal(reply.status, 200, await reply.text());
    assert.equal(JSON.parse(readFileSync(join(f.data, "config.json"), "utf8")).profile.about, "Updated fixture");
    f.restore();
    assert.equal((await h.json("/api/config")).profile.about, "Updated fixture");
  } finally { await h.stop(); }
});

test("pairing changes answer from the saved settings without a post-write read", async (t) => {
  const f = fixture(t);
  const h = await startHarness(f.env);
  const file = join(f.data, "config.json");
  try {
    f.fail(file, "EMFILE", 3);
    const enabled = await h.fetch("/api/pair", { method: "PUT", body: JSON.stringify({ enabled: true }) });
    assert.equal(enabled.status, 200, await enabled.text());
    assert.equal(JSON.parse(readFileSync(file, "utf8")).remote.enabled, true);
    f.restore();
    const made = await h.json("/api/pair/start", { method: "POST" });
    f.fail(file, "EMFILE", 4);
    const claimed = await h.fetch("/api/pair/claim", { method: "POST", body: JSON.stringify({ code: made.code, device: "Fixture" }) });
    assert.equal(claimed.status, 200);
    const answer = await claimed.json();
    assert.equal(JSON.parse(readFileSync(file, "utf8")).remote.devices.length, 1);
    f.restore();
    f.fail(file, "EIO", 4);
    const gone = await h.fetch(`/api/pair/devices/${answer.device.id}`, { method: "DELETE" });
    assert.equal(gone.status, 200, await gone.text());
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).remote.devices, []);
  } finally { await h.stop(); }
});

test("an unreadable device list cannot turn an already saved message into a failed HTTP response", async (t) => {
  const f = fixture(t);
  const relay = createServer((req, res) => {
    if (req.url === "/space/agent/stream") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"kind":"hello","spaceId":"fixture"}\n\n');
      return;
    }
    req.resume();
    req.on("end", () => { res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); });
  });
  t.after(() => { if (relay.listening) { relay.closeAllConnections(); relay.close(); } });
  await new Promise<void>((resolve) => relay.listen(0, "127.0.0.1", resolve));
  const port = (relay.address() as { port: number }).port;
  const original = JSON.stringify({ remote: { enabled: true }, relay: { url: `http://127.0.0.1:${port}`, agentToken: "fixture-token", enabled: true } });
  const file = f.write("config.json", original);
  const h = await startHarness(f.env);
  try {
    const until = Date.now() + 10_000;
    while (!(await h.json("/api/relay")).connected && Date.now() < until) await pause(20);
    assert.equal((await h.json("/api/relay")).connected, true);
    f.fail(file, "EIO");
    const reply = await h.fetch("/api/bots/first/messages", { method: "POST", body: JSON.stringify({ text: "saved once with relay" }) });
    assert.equal(reply.status, 202, await reply.text());
    const rows = JSON.parse(readFileSync(join(f.data, "messages-lane_first.json"), "utf8"));
    assert.equal(rows.filter((m: any) => m.role === "user" && m.text === "saved once with relay").length, 1);
    assert.equal(readFileSync(file, "utf8"), original);
    assert.match(h.logs(), /config\.json \(EIO\).*Restore file access and retry/);
    assert.doesNotMatch(h.logs(), /planted-secret/);
  } finally {
    f.restore();
    await h.stop();
    relay.closeAllConnections();
    await new Promise<void>((resolve) => relay.close(() => resolve()));
  }
});

test("a finished turn settles even when its memory history cannot be read", async (t) => {
  const f = fixture(t);
  const provider = await fakeProvider(t);
  const original = '[{"id":"saved","file":"MEMORY.md","before":null,"after":"old","at":1,"by":"you"}]';
  const journal = f.write("memory-journal/first.json", original);
  const memoryFile = f.write("workspaces/first/MEMORY.md", "old");
  const h = await startHarness(f.env);
  try {
    await h.json("/api/providers/grok/connect", { method: "POST", body: JSON.stringify({ key: "fixture-key", url: `http://127.0.0.1:${provider.port}` }) });
    await h.json("/api/bots/first", { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "grok", model: "grok-4" } }) });
    const sent = await h.fetch("/api/bots/first/messages", { method: "POST", body: JSON.stringify({ text: "finish with a memory change" }) });
    assert.equal(sent.status, 202);
    assert.ok(await waitFor(() => provider.state.held.length > 0));
    writeFileSync(memoryFile, "changed during the turn");
    f.fail(journal, "EIO");
    provider.state.held.shift()!();
    assert.ok(await idle(h, { id: "first" }), "the completed turn left its lane busy");
    assert.equal(readFileSync(journal, "utf8"), original);
    assert.equal(readFileSync(memoryFile, "utf8"), "changed during the turn");
    assert.match(h.logs(), /first\.json \(EIO\).*Restore file access and retry/);
    f.restore();
    provider.state.answerAtOnce = true;
    const again = await h.fetch("/api/bots/first/messages", { method: "POST", body: JSON.stringify({ text: "ordinary next turn" }) });
    assert.equal(again.status, 202);
    assert.ok(await waitFor(() => provider.state.calls.some((text) => text.includes("ordinary next turn"))));
    assert.ok(await idle(h, { id: "first" }));
    assert.equal(readFileSync(journal, "utf8"), original);
    assert.doesNotMatch(h.logs(), /planted-secret/);
  } finally { f.restore(); await h.stop(); }
});
