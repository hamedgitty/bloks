// The marker patch travels through the real member and relay paths.
// Native engine, linked WhatsApp channel, devices and relay are fixtures.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, request, type IncomingMessage } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { deviceKey, open, peek } from "../server/relay-crypto.ts";
import { startHarness } from "./helpers/server.ts";
import { waitFor } from "./helpers/turns.ts";

test("a shared-room compaction patch reaches the member without a wake, channel send or unread", async t => {
  const home = mkdtempSync(join(tmpdir(), "bloks-marker-room-"));
  const data = join(home, ".bloks");
  mkdirSync(data);
  const proceed = join(home, "request-now");
  const finish = join(home, "finish-now");
  const cli = join(home, "claude.mjs");
  writeFileSync(cli, `#!${process.execPath}
import { existsSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("9.9.9 (Claude Code)"); process.exit(0); }
if (args[0] === "auth") { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
const out = f => console.log(JSON.stringify(f));
const usage = (n, text = "") => out({ type: "assistant", message: { content: text ? [{ type: "text", text }] : [], usage: { input_tokens: n, output_tokens: 7 } } });
let input = "";
process.stdin.on("data", async function take(c) {
  input += c;
  const frame = input.split("\\n").slice(0, -1).filter(Boolean).map(JSON.parse).find(f => f.type === "user");
  if (!frame) return;
  process.stdin.off("data", take);
  const text = frame.message.content;
  out({ type: "system", subtype: "init", session_id: "room-session", model: "claude-sonnet-5" });
  if (text.includes("PATCH_MARKER")) {
    out({ type: "system", subtype: "compact_boundary", compact_metadata: { pre_tokens: 999999, post_tokens: 1000 } });
    while (!existsSync(${JSON.stringify(proceed)})) await new Promise(r => setTimeout(r, 20));
    usage(71542);
    while (!existsSync(${JSON.stringify(finish)})) await new Promise(r => setTimeout(r, 20));
  } else usage(274710, "Ordinary answer");
  out({ type: "result", subtype: "success", is_error: false, num_turns: 1, duration_api_ms: 1,
    session_id: "room-session", result: "Ordinary answer", total_cost_usd: 0,
    modelUsage: { "claude-sonnet-5": { contextWindow: 1000000 } } });
});
`, { mode: 0o755 });
  const batches: Array<{ frames: string[]; wake?: unknown }> = [];
  const channel: any[] = [];
  const relay = createServer((req, res) => {
    if (req.url === "/space/agent/stream") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"kind":"hello","spaceId":"fixture"}\n\n');
      return;
    }
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => {
      const parsed = JSON.parse(body || "{}");
      if (req.url === "/space/agent/events") batches.push(parsed);
      if (req.url?.endsWith("/messages")) channel.push(parsed);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ plan: "cloud", messages: [{ id: "fixture" }] }));
    });
  });
  await new Promise<void>(r => relay.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(relay.address() as any).port}`;
  const token = "fixture-member-token";
  const digest = createHash("sha256").update(token).digest("hex");
  const device = { id: "member-device", name: "Member fixture", hash: digest, pairedAt: 1, personId: "fixture-person" };
  const config = { compaction: { idle: false, beforeTurn: 0 },
    instances: { claude: { driver: "claudeAgent", config: { cli } } },
    remote: { enabled: true, memberDevices: [device] },
    chat: { whatsapp: { enabled: true, token: "fixture-only", phoneNumberId: "fixture", appSecret: "fixture-only", webhookUrl: url } },
  };
  writeFileSync(join(data, "config.json"), JSON.stringify(config));
  const env = { HOME: home, BLOKS_LOOPBACK_ONLY: "1", BLOKS_WHATSAPP_API: url,
    NODE_OPTIONS: `--import=${new URL("./helpers/telegram-fetch.mjs", import.meta.url).href}` };
  let h = await startHarness(env);
  const abort = new AbortController();
  let stream: Promise<void> | undefined;
  t.after(async () => {
    abort.abort(); await stream?.catch(() => {});
    await h.stop(); relay.closeAllConnections(); relay.close();
    rmSync(home, { recursive: true, force: true });
  });
  const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Parent" }) });
  await h.fetch(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } }) });
  const { bot: other } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Other" }) });
  const { blok } = await h.json("/api/bloks", { method: "POST", body: JSON.stringify({ name: "Shared fixture", memberIds: [bot.id, other.id] }) });
  await h.stop();
  const rooms = JSON.parse(readFileSync(join(data, "bloks.json"), "utf8"));
  rooms.find((r: any) => r.id === blok.id).sharing = { since: 0, history: "all", tools: "conversation", spendCap: 0,
    chat: { platform: "whatsapp", channelId: "fixture-group", channelName: "Fixture group" } };
  writeFileSync(join(data, "bloks.json"), JSON.stringify(rooms));
  writeFileSync(join(data, "people.json"), JSON.stringify({ people: [{ id: device.personId, name: "Fixture person", createdAt: 1 }],
    memberships: [{ personId: device.personId, roomId: blok.id, role: "collaborator", joinedAt: 1, invitedBy: "owner" }], invites: [], knocks: [] }));
  h = await startHarness(env);
  assert.ok((await h.fetch("/api/relay", { method: "PUT", body: JSON.stringify({ url, agentToken: "fixture-only", enabled: true }) })).ok);
  const frames: any[] = [];
  // The member surface requires a network Host. The socket itself is
  // still loopback, as in the existing remote-surface harness tests.
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    const req = request(h.url + "/api/events", { signal: abort.signal, headers: {
      host: `192.0.2.10:${new URL(h.url).port}`, authorization: `Bearer ${token}`,
    } }, resolve);
    req.on("error", reject); req.end();
  });
  assert.equal(response.statusCode, 200);
  stream = (async () => {
    let buf = "";
    for await (const chunk of response) {
      buf += Buffer.from(chunk).toString();
      for (let split = buf.indexOf("\n\n"); split !== -1; split = buf.indexOf("\n\n")) {
        const line = buf.slice(0, split); buf = buf.slice(split + 2);
        if (line.startsWith("data: ")) frames.push(JSON.parse(line.slice(6)));
      }
    }
  })();
  assert.ok(await waitFor(() => frames.find(f => f.kind === "hello" && f.member)));
  const agent = async () => (await h.json("/api/bots?messages=0")).bots.find((b: any) => b.id === bot.id);
  const room = async () => (await h.json("/api/bloks")).bloks.find((r: any) => r.id === blok.id);
  await h.fetch(`/api/bloks/${blok.id}/messages`, { method: "POST", body: JSON.stringify({ text: "@Parent PRIME_MARKER" }) });
  assert.ok(await waitFor(async () => (await agent()).tasks.some((l: any) => l.context.used === 274_710 && l.state === "idle")), h.logs());
  assert.ok(await waitFor(() => channel.some(c => c.text?.body?.includes("Ordinary answer"))), "the linked-channel positive control did not send");
  await h.fetch(`/api/bloks/${blok.id}/messages`, { method: "POST", body: JSON.stringify({ text: "@Parent PATCH_MARKER" }) });
  const marker = await waitFor(async () => (await room()).messages.find((m: any) => m.compaction));
  assert.ok(marker, h.logs());
  assert.deepEqual(marker.compaction, { before: 274_710, after: null });
  const sharedLaneId = (await room()).lanes[bot.id];
  await h.fetch(`/api/bots/${bot.id}/tasks/${sharedLaneId}`, { method: "PATCH", body: JSON.stringify({ unread: false }) });
  // Wait for the prior user/channel and marker batches to land, then
  // let only the parent request arrive; the result stays held.
  assert.ok(await waitFor(() => channel.some(c => c.text?.body?.includes("PATCH_MARKER"))));
  const channelBefore = channel.length;
  writeFileSync(proceed, "yes");
  const patched = await waitFor(() => frames.find(f => f.kind === "message.patch" && f.message.id === marker.id));
  assert.ok(patched, h.logs());
  const key = deviceKey(digest, "mac-to-phone");
  const containing = await waitFor(() => batches.find(b => b.frames.some(encrypted => {
    const f = open(key, peek(encrypted)!) as any;
    return f?.kind === "message.patch" && f.message.id === marker.id;
  })));
  assert.ok(containing, "the sealed relay never received the patch");
  assert.equal(containing.wake, undefined, "a patch must not create a relay wake");
  assert.equal(channel.length, channelBefore, "a request-sized patch must not send into the linked channel");
  const { _seq: _ignored, ...patch } = patched;
  assert.deepEqual(patch, { kind: "message.patch", threadId: blok.id,
    message: { ...marker, text: "Compacted · 275k → 72k", compaction: { before: 274_710, after: 71_542 } } });
  const updated = await agent();
  assert.equal(updated.tasks.find((l: any) => l.id === sharedLaneId).unread, false);
  assert.equal(updated.tasks.find((l: any) => l.id === bot.threadId).context.measured, false);
  assert.equal((await room()).messages.filter((m: any) => m.compaction).length, 1);
  writeFileSync(finish, "yes");
  assert.ok(await waitFor(async () => !(await agent()).busy));
});
