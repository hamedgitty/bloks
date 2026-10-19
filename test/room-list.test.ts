// Room transcript tails through the real person, agent and sealed relay routes.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { deviceKey, open, peek, seal } from "../server/relay-crypto.ts";
import { startHarness, type Harness } from "./helpers/server.ts";

const metadata = ({ messages: _messages, olderMessages: _older, ...fields }: any) => fields;
const waitFor = async <T,>(check: () => T | undefined, ms = 10_000): Promise<T> => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const value = check();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error("room-list fixture did not become ready");
};

test("room tails keep metadata, access and every omitted history message", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "bloks-room-list-"));
  const tokenFile = join(home, "turn-token");
  const cli = join(home, "fake-claude.mjs");
  let h: Harness | undefined;
  let relay: ReturnType<typeof createServer> | undefined;
  t.after(async () => {
    await h?.stop();
    relay?.closeAllConnections();
    if (relay) await new Promise<void>((resolve) => relay!.close(() => resolve()));
    rmSync(home, { recursive: true, force: true });
  });
  // A real, bounded turn supplies its agent credential. No external engine.
  writeFileSync(cli, `#!${process.execPath}
import { writeFileSync } from "node:fs";
if (process.argv[2] === "--version") { console.log("2.1.299 (Claude Code)"); process.exit(0); }
if (process.argv[2] === "auth") { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
process.on("SIGTERM", () => process.exit(0));
let input = "";
process.stdin.on("data", function take(chunk) {
  input += chunk;
  if (!input.includes(String.fromCharCode(10))) return;
  console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "room-list-session", model: "claude-sonnet-5" }));
  writeFileSync(${JSON.stringify(tokenFile)}, process.env.BLOKS_TOKEN);
  process.stdin.off("data", take);
  setTimeout(() => process.exit(0), 60_000);
});
`, { mode: 0o755 });
  mkdirSync(join(home, ".bloks"));
  writeFileSync(join(home, ".bloks", "config.json"), JSON.stringify({
    instances: { claude: { driver: "claudeAgent", config: { cli } } },
  }));
  h = await startHarness({ HOME: home });
  const makeBot = async (name: string) => (await h!.json("/api/bots", {
    method: "POST", body: JSON.stringify({ name }),
  })).bot;
  const reader = await makeBot("Reader");
  const peer = await makeBot("Peer");
  const outsider = await makeBot("Outsider");
  await h.json(`/api/bots/${reader.id}`, {
    method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } }),
  });
  const makeRoom = async (name: string, memberIds: string[]) => (await h!.json("/api/bloks", {
    method: "POST", body: JSON.stringify({ name, memberIds }),
  })).blok;
  const own = await makeRoom("Shared", [reader.id, peer.id]);
  const other = await makeRoom("Elsewhere", [peer.id, outsider.id]);
  const empty = await makeRoom("Empty", [reader.id, outsider.id]);
  const archived = await makeRoom("Archived", [reader.id, peer.id]);
  await h.json(`/api/bloks/${archived.id}`, { method: "PATCH", body: JSON.stringify({ archived: true }) });
  await h.stop();

  const messages = Array.from({ length: 12 }, (_, index) => ({
    id: randomUUID(), at: Date.now() - 20_000 + index,
    role: index % 2 ? "bot" : "user", kind: "text", text: `Line ${index}: ` + "x".repeat(48_000),
  }));
  const foreign = messages.map((message) => ({ ...message, id: randomUUID(), text: "PRIVATE_ROOM_LINE " + message.text }));
  const archivedMessages = [{ ...messages[0], text: "Archived words" }];
  for (const [id, list] of [[own.id, messages], [other.id, foreign], [empty.id, []], [archived.id, archivedMessages]]) {
    writeFileSync(join(home, ".bloks", `messages-${id}.json`), JSON.stringify(list));
  }
  h = await startHarness({ HOME: home });
  const all = (await h.json("/api/bloks")).bloks;
  const expected = new Map(all.map((room: any) => [room.id, room.messages]));
  const sameMetadata = (rooms: any[]) => assert.deepEqual(rooms.map(metadata), all.map(metadata));

  await t.test("the person's zero list has no transcripts and all metadata", async () => {
    const zero = (await h!.json("/api/bloks?messages=0")).bloks;
    for (const room of zero) assert.deepEqual(room.messages, []);
    sameMetadata(zero);
    assert.ok(JSON.stringify({ bloks: zero }).length < 10_000, "metadata still carries the long transcripts");
  });
  await t.test("fractional zero and negative zero have no messages", async () => {
    for (const count of ["0.5", "-0"]) {
      const rooms: any[] = (await h!.json("/api/bloks?messages=" + count)).bloks;
      for (const room of rooms) assert.deepEqual(room.messages, []);
      sameMetadata(rooms);
    }
  });
  await t.test("one, three and a fractional positive count keep the newest words", async () => {
    for (const [count, length] of [["1", 1], ["3", 3], ["2.5", 2]] as const) {
      const rooms: any[] = (await h!.json("/api/bloks?messages=" + count)).bloks;
      for (const room of rooms) assert.deepEqual(room.messages, (expected.get(room.id) as any[]).slice(-length));
      sameMetadata(rooms);
    }
  });
  await t.test("missing, empty, invalid, negative and nonfinite values keep full local history", async () => {
    for (const suffix of ["", "?messages=", "?messages=-1", "?messages=NaN", "?messages=Infinity", "?messages=abc"]) {
      assert.deepEqual((await h!.json("/api/bloks" + suffix)).bloks, all, suffix);
    }
    assert.deepEqual(all.find((room: any) => room.id === empty.id).messages, []);
    assert.equal(all.find((room: any) => room.id === archived.id).archived, true);
  });

  await h.json(`/api/bots/${reader.id}/messages`, { method: "POST", body: JSON.stringify({ text: "Hold for the room-list checks" }) });
  await waitFor(() => existsSync(tokenFile) ? true : undefined);
  const token = readFileSync(tokenFile, "utf8");
  const asAgent = async (suffix: string) => h!.json("/api/bloks" + suffix, { headers: { authorization: "Bearer " + token } });
  const agentAll = (await asAgent("")).bloks;
  await t.test("an agent's zero list keeps room metadata without its transcripts", async () => {
    const zero = (await asAgent("?messages=0")).bloks;
    for (const room of zero) assert.deepEqual(room.messages, []);
    assert.deepEqual(zero.map(metadata), agentAll.map(metadata));
  });
  await t.test("an agent's positive tail is its latest member-room message", async () => {
    const tail = (await asAgent("?messages=1")).bloks;
    assert.deepEqual(tail.find((room: any) => room.id === own.id).messages, messages.slice(-1));
    assert.deepEqual(tail.map(metadata), agentAll.map(metadata));
  });
  await t.test("another room remains roster-only at every requested count", async () => {
    for (const suffix of ["", "?messages=0", "?messages=1", "?messages=0.5", "?messages=abc"]) {
      const found = (await asAgent(suffix)).bloks.find((room: any) => room.id === other.id);
      assert.deepEqual(found, agentAll.find((room: any) => room.id === other.id));
      assert.deepEqual(found.messages, []);
      assert.equal(found.olderMessages, undefined);
      assert.doesNotMatch(JSON.stringify(found), /PRIVATE_ROOM_LINE/);
    }
    const denied = await h!.fetch(`/api/bloks/${other.id}/messages`, { headers: { authorization: "Bearer " + token } });
    assert.ok(denied.status === 403 || denied.status === 404);
  });
  await t.test("the separate history endpoint still retrieves and pages omitted words", async () => {
    const tail = await h!.json(`/api/bloks/${own.id}/messages?limit=2`);
    assert.deepEqual(tail.messages, messages.slice(-2));
    const older = await h!.json(`/api/bloks/${own.id}/messages?limit=2&before=${tail.messages[0].id}`);
    assert.deepEqual(older.messages, messages.slice(-4, -2));
    assert.equal(older.olderMessages, 8);
  });

  const results = new Map<string, any>();
  let send: ((frame: unknown) => void) | undefined;
  relay = createServer((req, res) => {
    if (req.url === "/space/agent/stream") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      send = (frame) => res.write(`data: ${JSON.stringify(frame)}\n\n`);
      send({ kind: "hello", spaceId: "room-list-space" });
      return;
    }
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const data = body ? JSON.parse(body) : {};
      if (req.url === "/space/agent/result") results.set(data.id, data);
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => relay!.listen(0, "127.0.0.1", resolve));
  await h.json("/api/pair", { method: "PUT", body: JSON.stringify({ enabled: true }) });
  const code = await h.json("/api/pair/start", { method: "POST" });
  const paired = await h.json("/api/pair/claim", { method: "POST", body: JSON.stringify({ code: code.code, device: "Fixture phone" }) });
  const digest = createHash("sha256").update(paired.token).digest("hex");
  const toServer = deviceKey(digest, "phone-to-mac");
  const toClient = deviceKey(digest, "mac-to-phone");
  await h.json("/api/relay", { method: "PUT", body: JSON.stringify({
    url: `http://127.0.0.1:${(relay.address() as any).port}`, agentToken: "fixture-agent", enabled: true,
  }) });
  await waitFor(() => send);
  const ask = async (suffix: string) => {
    const id = randomUUID();
    send!({ kind: "ask", id, payload: seal(toServer, paired.device.id, { method: "GET", path: "/api/bloks" + suffix }) });
    const answer = await waitFor(() => results.get(id));
    assert.equal(answer.status, 200);
    assert.ok(JSON.stringify(answer).length < 2_000_000);
    const opened = open(toClient, peek(answer.payload)!) as any;
    assert.equal(opened.status, 200);
    return opened.body.bloks;
  };
  await t.test("relay zero and fractional zero count the whole omitted history", async () => {
    for (const suffix of ["?messages=0", "?messages=0.5"]) {
      const rooms = await ask(suffix);
      for (const room of rooms) {
        assert.deepEqual(room.messages, []);
        assert.equal(room.olderMessages, (expected.get(room.id) as any[]).length);
      }
      sameMetadata(rooms);
    }
  });
  await t.test("relay positive tails preserve all omitted counts", async () => {
    for (const count of [1, 3]) {
      const rooms = await ask("?messages=" + count);
      for (const room of rooms) {
        const full = expected.get(room.id) as any[];
        assert.deepEqual(room.messages, full.slice(-count));
        assert.equal(room.olderMessages, Math.max(0, full.length - count));
      }
      sameMetadata(rooms);
    }
  });
  await t.test("relay defaults and invalid tails retain the byte budget and newest words", async () => {
    const ordinary = await ask("");
    for (const room of ordinary) {
      const full = expected.get(room.id) as any[];
      assert.equal(room.messages.length + room.olderMessages, full.length);
      assert.deepEqual(room.messages, full.slice(full.length - room.messages.length));
    }
    assert.ok(ordinary.find((room: any) => room.id === own.id).olderMessages > 0);
    for (const suffix of ["?messages=", "?messages=-1", "?messages=abc", "?messages=Infinity"]) {
      assert.deepEqual(await ask(suffix), ordinary);
    }
  });
});
