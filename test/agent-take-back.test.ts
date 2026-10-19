import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startHarness } from "./helpers/server.ts";
import { fakeProvider } from "./helpers/turns.ts";
import { AgentTokens, allows, TURN_BUDGET } from "../server/agent-cli.ts";

const CLI = fileURLToPath(new URL("../bin/bloks.mjs", import.meta.url));
async function waitFor<T>(check: () => T | false | undefined | Promise<T | false | undefined>, ms = 20_000): Promise<T> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const result = await check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error("fixture condition did not become true");
}
async function command(url: string, token: string, args: string[], home: string) {
  const child = spawn(process.execPath, [CLI, ...args], { env: { HOME: home, BLOKS_URL: url, BLOKS_TOKEN: token } });
  let out = "", err = "";
  child.stdout.on("data", (c) => out += c);
  child.stderr.on("data", (c) => err += c);
  const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
  const exit = await new Promise<number | null>((resolve) => child.once("close", resolve));
  clearTimeout(timer);
  return { exit, out, err, body: out.trim() ? JSON.parse(out) : null };
}

async function fixture(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), "bloks-agent-take-back-"));
  const cli = join(home, "engine.mjs");
  const heardFile = join(home, "heard.jsonl");
  mkdirSync(join(home, ".bloks"));
  writeFileSync(cli, `#!${process.execPath}
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("2.1.299 (Claude Code)"); process.exit(0); }
if (args[0] === "auth") { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
const out = (frame) => console.log(JSON.stringify(frame));
let first = true, who;
const input = createInterface({ input: process.stdin });
input.on("line", async (line) => {
  const frame = JSON.parse(line);
  if (frame.type !== "user") return;
  const text = String(frame.message.content);
  if (first) {
    first = false;
    out({ type: "system", subtype: "init", session_id: "fixture-" + Math.random(), model: "claude-sonnet-5" });
    const res = await fetch(process.env.BLOKS_URL + "/api/agent/whoami", { headers: { authorization: "Bearer " + process.env.BLOKS_TOKEN } });
    who = await res.json();
  }
  appendFileSync(${JSON.stringify(heardFile)}, JSON.stringify({ text, who, token: process.env.BLOKS_TOKEN }) + "\\n");
  const done = () => {
    out({ type: "assistant", message: { content: [{ type: "text", text: "Done." }] } });
    out({ type: "result", subtype: "success", is_error: false, num_turns: 1, duration_api_ms: 1, result: "Done." });
    setTimeout(() => process.exit(0), 30);
  };
  const held = text.match(/HOLD ([A-Za-z0-9]+)/);
  if (held) {
    // Closing this turn's input makes an ordinary say queue, so it cannot
    // accidentally be accepted by the mid-turn steering path.
    out({ type: "result", subtype: "success", is_error: false, num_turns: 0, duration_api_ms: 0, result: "" });
    writeFileSync(${JSON.stringify(home)} + "/ready-" + held[1], "");
    const timer = setInterval(() => {
      if (!existsSync(${JSON.stringify(home)} + "/release-" + held[1])) return;
      clearInterval(timer); done();
    }, 20);
  } else if (text.includes("OPEN ")) {
    out({ type: "assistant", message: { content: [{ type: "text", text: "Working." }] } });
  } else done();
});
`, { mode: 0o755 });
  writeFileSync(join(home, ".bloks", "config.json"), JSON.stringify({
    instances: { claude: { driver: "claudeAgent", config: { cli, permissionMode: "bypassPermissions" } } },
  }));
  const h = await startHarness({ HOME: home });
  t.after(async () => { await h.stop(); rmSync(home, { recursive: true, force: true }); });
  const heard = (): any[] => existsSync(heardFile) ? readFileSync(heardFile, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  const make = async (name: string) => {
    const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name }) });
    await h.json(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } }) });
    return bot;
  };
  const messages = async (id: string, lane: string): Promise<any[]> => (await h.json(`/api/bots/${id}/messages?thread=${lane}&limit=500`)).messages;
  const busy = async (id: string, lane: string) => (await h.json("/api/bots?messages=0")).bots.find((b: any) => b.id === id)?.tasks.find((task: any) => task.id === lane)?.busy;
  const hold = async (bot: any, marker: string, lane = bot.threadId) => {
    await h.json(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ taskId: lane, text: `HOLD ${marker}` }) });
    await waitFor(() => existsSync(join(home, "ready-" + marker)));
    return (await waitFor(() => heard().find((m) => m.text.includes(`HOLD ${marker}`)))).token as string;
  };
  const as = async (token: string, path: string, body?: unknown) => {
    const res = await h.fetch(path, { method: "POST", headers: { authorization: "Bearer " + token }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, body: await res.json() };
  };
  return { h, home, heard, make, messages, busy, hold, as, release: (marker: string) => writeFileSync(join(home, "release-" + marker), "") };
}

test("the shipped CLI takes back only its sender's waiting words across lanes, and survivors alone are heard", async (t) => {
  const f = await fixture(t);
  const a = await f.make("Agent A"), b = await f.make("Agent B"), c = await f.make("Agent C");
  const aMain = a.threadId, bMain = b.threadId;
  const { bot: aSecond } = await f.h.json(`/api/bots/${a.id}/tasks`, { method: "POST", body: JSON.stringify({ title: "Second" }) });
  const { bot: bSecond } = await f.h.json(`/api/bots/${b.id}/tasks`, { method: "POST", body: JSON.stringify({ title: "Second" }) });
  const tokenA = await f.hold(a, "A1", aMain);
  const tokenA2 = await f.hold(a, "A2", aSecond.threadId);
  const tokenC = await f.hold(c, "C1");
  await f.hold(b, "B1", bMain);
  await f.hold(b, "B2", bSecond.threadId);
  const wrong = "WORDS TO TAKE BACK";
  for (const [token, lane] of [[tokenA, bMain], [tokenA, bMain], [tokenA2, bSecond.threadId]]) {
    const sent = await f.as(token, `/api/bots/${b.id}/messages`, { text: wrong, taskId: lane });
    assert.equal(sent.body.queued, true);
    assert.match(sent.body.note, new RegExp(`bloks take-back ${b.id}`));
  }
  const fromC = await f.as(tokenC, `/api/bots/${b.id}/messages`, { text: "OTHER AGENT SURVIVES", taskId: bMain });
  assert.equal(fromC.body.queued, true);
  const fromPerson = await f.h.json(`/api/bots/${b.id}/messages`, { method: "POST", body: JSON.stringify({ text: "PERSON SURVIVES", taskId: bMain }) });
  assert.equal(fromPerson.queued, true);
  assert.doesNotMatch(fromPerson.note, /bloks take-back/);
  const oldRows = [...await f.messages(a.id, aMain), ...await f.messages(a.id, aSecond.threadId)].filter((m) => m.agent?.dir === "out");
  const prior = JSON.stringify(oldRows);
  const result = await command(f.h.url, tokenA2, ["take-back", b.id], f.home);
  assert.equal(result.exit, 0, result.err);
  assert.equal(result.body.ok, true);
  assert.equal(result.body.takenBack.length, 3);
  assert.deepEqual(result.body.takenBack.map((m: any) => m.laneId), [bMain, bMain, bSecond.threadId]);
  assert.ok(result.body.takenBack.every((m: any) => m.text === wrong && typeof m.id === "string"));
  assert.equal(JSON.stringify([...await f.messages(a.id, aMain), ...await f.messages(a.id, aSecond.threadId)].filter((m) => m.agent?.dir === "out")), prior);
  const rows = (await f.messages(a.id, aSecond.threadId)).filter((m) => m.takeBack);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].agent, undefined);
  const exchange = await f.h.json(`/api/bots/${a.id}/exchange/${b.id}`);
  assert.equal(exchange.messages.filter((m: any) => m.dir === "take-back").length, 1);
  assert.equal(exchange.messages.find((m: any) => m.dir === "take-back").id, rows[0].id);
  assert.equal(exchange.messages.find((m: any) => m.dir === "take-back").text, [wrong, wrong, wrong].join("\n\n"));
  assert.ok(!exchange.messages.some((m: any) => m.dir === "in" && m.text === wrong));
  const duplicate = await command(f.h.url, tokenA2, ["take-back", b.id], f.home);
  assert.equal(duplicate.exit, 1);
  assert.match(duplicate.body.error, /turn may already have.*Send a correction/);
  f.release("B1"); f.release("B2");
  await waitFor(() => f.heard().find((m) => m.text.includes("OTHER AGENT SURVIVES") && m.text.includes("PERSON SURVIVES")));
  await waitFor(async () => !(await f.busy(b.id, bMain)) && !(await f.busy(b.id, bSecond.threadId)));
  const bTurns = f.heard().filter((m) => (m.who.botId ?? m.who.id) === b.id);
  assert.equal(bTurns.length, 3, "two held turns and only one survivor turn, no empty withdrawn burst");
  assert.ok(bTurns.some((m) => m.text.includes("OTHER AGENT SURVIVES") && m.text.includes("PERSON SURVIVES")));
  assert.ok(!bTurns.some((m) => m.text.includes(wrong)), "the recipient heard withdrawn words");
  for (const lane of [bMain, bSecond.threadId]) {
    const disk = JSON.parse(readFileSync(join(f.home, ".bloks", `messages-${lane}.json`), "utf8"));
    for (const gone of result.body.takenBack.filter((m: any) => m.laneId === lane)) {
      assert.equal(disk.find((m: any) => m.id === gone.id).deleted, true);
      assert.equal(disk.find((m: any) => m.id === gone.id).text, "");
    }
  }
});

test("the full route refuses people, rooms and self, ignores body selection, and leaves other senders untouched", async (t) => {
  const f = await fixture(t);
  const a = await f.make("Agent A"), b = await f.make("Agent B"), c = await f.make("Agent C");
  const token = await f.hold(a, "Caller");
  await f.hold(b, "Recipient");
  await f.as(token, `/api/bots/${b.id}/messages`, { text: "OWN WAITING" });
  await f.h.json(`/api/bots/${b.id}/messages`, { method: "POST", body: JSON.stringify({ text: "PERSON WAITING" }) });
  const before = JSON.stringify(await f.messages(b.id, b.threadId));
  const person = await f.h.fetch(`/api/bots/${b.id}/take-back`, { method: "POST", body: JSON.stringify({ botId: a.id }) });
  assert.equal(person.status, 403);
  assert.equal(JSON.stringify(await f.messages(b.id, b.threadId)), before);
  assert.equal((await f.as(token, `/api/bots/${a.id}/take-back`)).status, 403);
  assert.equal((await f.as(token, "/api/bots/missing/take-back")).status, 404);
  const { blok: room } = await f.h.json("/api/bloks", { method: "POST", body: JSON.stringify({ name: "Plans", memberIds: [a.id, b.id] }) });
  const roomBefore = JSON.stringify(await f.h.json(`/api/bloks/${room.id}/messages`));
  const roomResult = await command(f.h.url, token, ["take-back", room.id], f.home);
  assert.equal(roomResult.exit, 1);
  assert.match(roomResult.body.error, /no such agent/);
  assert.equal(JSON.stringify(await f.h.json(`/api/bloks/${room.id}/messages`)), roomBefore);
  const invalidVerb = await f.as(token, `/api/bloks/${room.id}/take-back`);
  assert.equal(invalidVerb.status, 403);
  const guarded = await f.h.fetch(`/api/threads/${b.threadId}/messages/anything`, { method: "DELETE", headers: { authorization: "Bearer " + token } });
  assert.equal(guarded.status, 403, "generic deletion must not become an agent permission");
  const result = await f.as(token, `/api/bots/${b.id}/take-back`, { peerId: c.id, messageIds: ["forged"], laneId: "forged" });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.takenBack.map((m: any) => m.text), ["OWN WAITING"]);
  assert.ok((await f.messages(b.id, b.threadId)).find((m) => m.text === "PERSON WAITING" && !m.deleted));
  const stale = await f.as("expired-fixture-token", `/api/bots/${b.id}/take-back`);
  assert.ok([401, 403].includes(stale.status));
  let budget;
  for (let i = 0; i < TURN_BUDGET; i++) {
    budget = await f.as(token, `/api/bots/${b.id}/take-back`);
    if (budget.status === 429) break;
    assert.equal(budget.status, 409);
  }
  assert.equal(budget?.status, 429, "take-back must spend the ordinary mutation budget");
});

test("a real now join has passed the boundary, and a delivered message cannot be taken back", async (t) => {
  const f = await fixture(t);
  const a = await f.make("Agent A"), b = await f.make("Agent B");
  const token = await f.hold(a, "Sender");
  const first = await command(f.h.url, token, ["say", b.id, "OPEN boundary"], f.home);
  assert.equal(first.exit, 0, first.err);
  await waitFor(() => f.heard().find((m) => m.text.includes("OPEN boundary")));
  const joined = await command(f.h.url, token, ["say", b.id, "--now", "JOINED WORDS"], f.home);
  assert.equal(joined.exit, 0, joined.err);
  assert.equal(joined.body.steered, true);
  const before = (await f.messages(b.id, b.threadId)).filter((m) => m.text === "JOINED WORDS" || m.text === "OPEN boundary");
  const refused = await command(f.h.url, token, ["take-back", b.id], f.home);
  assert.equal(refused.exit, 1);
  assert.match(refused.body.error, /Send a correction/);
  assert.deepEqual((await f.messages(b.id, b.threadId)).filter((m) => m.text === "JOINED WORDS" || m.text === "OPEN boundary"), before);
  assert.equal(before.find((m) => m.text === "JOINED WORDS")?.midTurn, true);
});

test("when the drain wins, the queued words are delivered once and take-back refuses unchanged", async (t) => {
  const f = await fixture(t);
  const a = await f.make("Agent A"), b = await f.make("Agent B");
  const token = await f.hold(a, "DrainCaller");
  await f.hold(b, "DrainRecipient");
  await f.as(token, `/api/bots/${b.id}/messages`, { text: "DRAIN TOOK THESE WORDS" });
  f.release("DrainRecipient");
  await waitFor(() => f.heard().find((m) => m.text.includes("DRAIN TOOK THESE WORDS")));
  const before = (await f.messages(b.id, b.threadId)).find((m) => m.text === "DRAIN TOOK THESE WORDS");
  assert.equal(before.queued, false);
  assert.ok(before.deliveredAt);
  const refused = await f.as(token, `/api/bots/${b.id}/take-back`);
  assert.equal(refused.status, 409);
  assert.deepEqual((await f.messages(b.id, b.threadId)).find((m) => m.id === before.id), before);
  assert.equal(f.heard().filter((m) => m.text.includes("DRAIN TOOK THESE WORDS")).length, 1);
});

test("held editors release only after the entire batch is tombstoned, with no turn for withdrawn command-looking words", async (t) => {
  const f = await fixture(t);
  const a = await f.make("Agent A"), b = await f.make("Agent B");
  const main = b.threadId;
  const { bot: second } = await f.h.json(`/api/bots/${b.id}/tasks`, { method: "POST", body: JSON.stringify({ title: "Second" }) });
  const token = await f.hold(a, "EditorCaller");
  await f.hold(b, "EditorOne", main);
  await f.hold(b, "EditorTwo", second.threadId);
  const waiting: Array<{ lane: string; id: string }> = [];
  for (const lane of [main, second.threadId]) {
    await f.as(token, `/api/bots/${b.id}/messages`, { text: "/goal withdrawn words", taskId: lane });
    const message = (await f.messages(b.id, lane)).find((m) => m.text === "/goal withdrawn words");
    waiting.push({ lane, id: message.id });
    const open = await f.h.fetch(`/api/threads/${lane}/messages/${message.id}/editing`, { method: "POST", body: JSON.stringify({ editing: true }) });
    assert.equal(open.status, 200);
  }
  f.release("EditorOne"); f.release("EditorTwo");
  await waitFor(async () => !(await f.busy(b.id, main)) && !(await f.busy(b.id, second.threadId)));
  const result = await f.as(token, `/api/bots/${b.id}/take-back`);
  assert.equal(result.status, 200);
  assert.equal(result.body.takenBack.length, 2);
  for (const { lane, id } of waiting) {
    assert.equal((await f.messages(b.id, lane)).find((m) => m.id === id).deleted, true);
    const closed = await f.h.fetch(`/api/threads/${lane}/messages/${id}/editing`, { method: "POST", body: JSON.stringify({ editing: false }) });
    assert.equal(closed.status, 200);
  }
  assert.equal(f.heard().filter((m) => m.who.botId === b.id).length, 2);
  assert.equal(f.heard().some((m) => m.text.includes("/goal withdrawn words")), false);
  assert.equal((await f.as(token, `/api/bots/${b.id}/take-back`)).status, 409);
});

test("the real carryOn reload delay has claimed its queued words even before they are read", async (t) => {
  const f = await fixture(t);
  const a = await f.make("Agent A");
  const provider = await fakeProvider(t);
  const added = await f.h.json("/api/custom-endpoints", { method: "POST", body: JSON.stringify({
    name: "Fixture endpoint", url: `http://127.0.0.1:${provider.port}/v1`, key: "synthetic-first-key",
  }) });
  const endpoint = added.endpoints[0];
  const b = await f.make("Agent B");
  await f.h.json(`/api/bots/${b.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: endpoint.instanceId, model: "grok-4" } }) });
  const token = await f.hold(a, "ContinuationCaller");
  await f.h.json(`/api/bots/${b.id}/messages`, { method: "POST", body: JSON.stringify({ text: "LONG-JOB" }) });
  await waitFor(() => provider.state.calls.length === 1);
  const queued = await f.as(token, `/api/bots/${b.id}/messages`, { text: "CLAIMED BY CONTINUATION" });
  assert.equal(queued.status, 202, JSON.stringify(queued.body));
  assert.equal(queued.body.queued, true, JSON.stringify(queued.body));
  const before = (await f.messages(b.id, b.threadId)).find((m) => m.text === "CLAIMED BY CONTINUATION");
  const rotated = await f.h.json(`/api/custom-endpoints/${endpoint.id}/keys`, { method: "POST", body: JSON.stringify({ key: "synthetic-second-key" }) });
  const nextKey = rotated.endpoints[0].keys.at(-1).id;
  // Custom keys belong only to this engine. Switching one rebuilds the
  // recipient without replacing the caller's still-live CLI credential.
  await f.h.json(`/api/custom-endpoints/${endpoint.id}/keys/${nextKey}/use`, { method: "POST" });
  const stillFlagged = (await f.messages(b.id, b.threadId)).find((m) => m.id === before.id);
  assert.equal(stillFlagged.queued, true, "the probe must occur inside carryOn's claim-to-read interval");
  const refused = await f.as(token, `/api/bots/${b.id}/take-back`);
  assert.equal(refused.status, 409);
  assert.equal(refused.body.notTakenBack, 1);
  assert.equal((await f.messages(b.id, b.threadId)).find((m) => m.id === before.id).deleted, undefined);
  await waitFor(() => provider.state.calls.length === 2);
  assert.equal(provider.sent("CLAIMED BY CONTINUATION"), 1);
});

test("the CLI has one direct POST and no room fallback, including a no-such-agent answer", async (t) => {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "no such agent" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  const url = `http://127.0.0.1:${(server.address() as any).port}`;
  const result = await command(url, "fixture-token", ["take-back", "room-id"], tmpdir());
  assert.equal(result.exit, 1);
  assert.deepEqual(seen, ["POST /api/bots/room-id/take-back"]);
  const extra = await command(url, "fixture-token", ["take-back", "room-id", "message-id"], tmpdir());
  assert.equal(extra.exit, 1);
  assert.match(extra.body.error, /one agent id/);
  assert.equal(seen.length, 1);
});

test("the permission is one POST under the ordinary turn's lifetime and mutation budget", () => {
  assert.equal(allows("a", "POST", "/api/bots/b/take-back").ok, true);
  for (const method of ["GET", "DELETE", "PATCH"]) assert.equal(allows("a", method, "/api/bots/b/take-back").ok, false);
  assert.equal(allows("a", "POST", "/api/bloks/room/take-back").ok, false);
  const tokens = new AgentTokens();
  const token = tokens.mint("a", "lane", 1_000);
  for (let i = 0; i < TURN_BUDGET; i++) assert.equal(tokens.spend(token), true);
  assert.equal(tokens.spend(token), false);
  assert.equal(tokens.identify(token.token, token.expiresAt + 1), null);
});
