// A household against the real server (GitHub 386, 431). Hamed owns the
// workspace; Sam and Ana joined it; Chef is a team agent everybody talks
// to, and Recipes is a room shared with everyone. Each boundary is walked
// with a real turn, so what is proved is what an engine was actually
// handed, not what a function says it would be:
//
//   another member   Ana's turns never get Sam's apps, keys, memory or
//                    words, and Sam's never get Ana's;
//   the owner        Hamed's turns, recall and search never get them
//                    either, and his own apps and keys stay his;
//   a shared room    a turn there gets nobody's own apps or keys and
//                    looks back only at the room;
//   an agent token   the credential an owner's turn holds reaches none
//                    of a member's own routes;
//   a guest          a guest of a room reaches none of them either.
//
// The rules themselves are test/household-rules.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startHarness, type Harness } from "./helpers/server.ts";
import { teamPlan } from "./helpers/team-plan.ts";
import { waitFor } from "./helpers/turns.ts";
import { JoinClient } from "../server/join-client.ts";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
// Keys and values are made here, never written out in a shape a scanner
// would take for a real one (test/no-secrets.test.ts).
const ck = (who: string) => ["ck", who, "k".repeat(16)].join("_");
const OWNER_KEY = ck("hamed");
const SAM_KEY = ck("sam");
const ANA_KEY = ck("ana");
const whose = (key: string | undefined) => (key === OWNER_KEY ? "hamed" : key === SAM_KEY ? "sam" : key === ANA_KEY ? "ana" : "nobody");

/** A stand-in for Composio's Connect MCP endpoint: one mail tool whose
 * answer says whose inbox it read, the connections tool the member page
 * uses, and a record of which key every call came with. */
async function fakeComposio() {
  const calls: Array<{ who: string; method: string; name?: string }> = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      const who = whose(req.headers["x-consumer-api-key"] as string | undefined);
      calls.push({ who, method: body.method, name: body.params?.name });
      res.setHeader("content-type", "application/json");
      const reply = (result: unknown) => res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id ?? 1, result }));
      if (body.method === "tools/list") {
        return reply({ tools: [{ name: "GMAIL_FETCH_EMAILS", description: "Fetch the newest mail", inputSchema: { type: "object", properties: {} } }] });
      }
      if (body.params?.name === "GMAIL_FETCH_EMAILS") return reply({ content: [{ type: "text", text: `the inbox of ${who}` }] });
      if (body.params?.name === "COMPOSIO_MANAGE_CONNECTIONS") {
        const action = body.params.arguments?.toolkits?.[0]?.action;
        const text = action === "add"
          ? JSON.stringify({ data: { redirect_url: "https://connect.composio.dev/link/fixture" } })
          : JSON.stringify({ data: { results: { gmail: { status: who === "sam" ? "ACTIVE" : "INITIATED", accounts: [] } } } });
        return reply({ content: [{ type: "text", text }] });
      }
      reply({ content: [{ type: "text", text: "{}" }] });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { calls, url: `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`, server };
}

/** An API engine that does what the words of the newest message say:
 * MAIL calls the mail tool if it has one, SEARCH:<words> looks back,
 * REMEMBER:<words> writes its memory, KEY asks for a key. It keeps
 * every request, so a test reads exactly what a turn was told. */
async function scriptedEngine() {
  const requests: any[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url?.endsWith("/models")) return res.end(JSON.stringify({ data: [{ id: "grok-4" }] }));
      const body = JSON.parse(raw);
      requests.push(body);
      const messages: any[] = body.messages ?? [];
      const last = messages[messages.length - 1];
      const answer = (content: string) => res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }));
      const call = (name: string, args: object) =>
        res.end(JSON.stringify({ choices: [{ message: { role: "assistant", tool_calls: [{ id: `c${requests.length}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] } }] }));
      if (!last || last.role === "tool") return answer("Done.");
      // summaries and other one-shots carry no tools and are answered plainly
      if (!Array.isArray(body.tools)) return answer("A summary.");
      const said = [...messages].reverse().find((m) => m.role === "user");
      const text = typeof said?.content === "string" ? said.content : JSON.stringify(said?.content ?? "");
      const tools = new Set(body.tools.map((t: any) => t.function?.name));
      const search = text.match(/SEARCH:([a-z ]+)/);
      const remember = text.match(/REMEMBER:([^"\n]+)/);
      if (/\bMAIL\b/.test(text) && tools.has("GMAIL_FETCH_EMAILS")) return call("GMAIL_FETCH_EMAILS", {});
      if (search) return call("search_history", { query: search[1].trim() });
      if (remember) return call("memory_write", { file: "MEMORY.md", text: `# Memory\n\n- ${remember[1].trim()}\n` });
      if (/\bKEY\b/.test(text)) return call("request_secret", { name: "Transistor API key" });
      answer("Done.");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { requests, port: (server.address() as { port: number }).port, server };
}

const close = (server: Server) => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); });
const toolNames = (body: any) => (body.tools ?? []).map((t: any) => t.function?.name);
const toolResults = (body: any) => (body.messages ?? []).filter((m: any) => m.role === "tool").map((m: any) => String(m.content));
const systemOf = (body: any) => String((body.messages ?? []).find((m: any) => m.role === "system")?.content ?? "");

async function household(t: { after: (fn: () => unknown) => void }, prefix: string, extra: object = {}) {
  const home = mkdtempSync(join(tmpdir(), prefix));
  const dir = join(home, ".bloks");
  mkdirSync(dir, { recursive: true });
  const licence = await teamPlan();
  t.after(() => licence.close());
  const composio = await fakeComposio();
  t.after(() => close(composio.server));
  // a guest of the Recipes room alone, let in through the room's own invite
  const guestToken = randomBytes(32).toString("base64url");
  writeFileSync(
    join(dir, "config.json"),
    JSON.stringify({
      remote: { enabled: true, memberDevices: [{ id: "d_guest", name: "Leila", hash: sha(guestToken), pairedAt: 1, personId: "p_guest" }] },
      profile: { name: "Hamed" },
      composio: { key: OWNER_KEY, url: composio.url },
      secrets: { OWNER_ONLY: "the owners own value" },
      ...licence.config,
      ...extra,
    }),
  );
  writeFileSync(
    join(dir, "people.json"),
    JSON.stringify({
      version: 3,
      people: [{ id: "p_guest", name: "Leila", createdAt: 1 }],
      memberships: [{ personId: "p_guest", roomId: "r_recipes", role: "collaborator", joinedAt: 1, invitedBy: "owner" }],
      invites: [],
      knocks: [],
    }),
  );
  const ctx = { h: await startHarness({ HOME: home, ...licence.env }) };
  t.after(async () => {
    await ctx.h.stop();
    rmSync(home, { recursive: true, force: true });
  });
  const h = ctx.h;
  const lan = new URL(h.url).host;
  async function joinAs(name: string) {
    const made = await h.json("/api/workspace/invites", { method: "POST", body: JSON.stringify({ role: "member", name }) });
    const client = new JoinClient(() => "http://127.0.0.1:9");
    const found = (await client.lookup(`${made.invite.link}~${lan}`)) as any;
    assert.ok(found.ok, JSON.stringify(found));
    assert.equal(((await client.claim(found.session, { name })) as any).status, "waiting");
    assert.equal((await h.fetch(`/api/workspace/requests/${made.invite.id}/approve`, { method: "POST" })).status, 200);
    const done = (await client.status(found.session)) as any;
    assert.equal(done.status, "approved");
    return done.credentials as { deviceToken: string; personId: string };
  }
  const sam = await joinAs("Sam");
  const ana = await joinAs("Ana");
  const as = (who: { deviceToken: string } | string, path: string, init: { method?: string; body?: unknown } = {}) =>
    ctx.h.fetchRemote(path, {
      method: init.method ?? "GET",
      token: typeof who === "string" ? who : who.deviceToken,
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
  // Stopped, its files changed, and started again on the same home: how a
  // test shares a room, which on a real workspace takes Bloks Cloud.
  const restart = async (edit: () => void) => {
    await ctx.h.stop();
    edit();
    ctx.h = await startHarness({ HOME: home, ...licence.env });
    return ctx.h;
  };
  return { home, dir, h, composio, sam, ana, guestToken, as, restart };
}

/** Says something in a member's conversation and waits for the answer. */
async function memberSays(as: any, who: any, botId: string, lane: "private" | "team", text: string, h: Harness) {
  const said = await as(who, `/api/member/agents/${botId}/${lane}/messages`, { method: "POST", body: { text } });
  assert.equal(said.status, 202, JSON.stringify(said.body));
  const done = await waitFor(async () => {
    const conversation = (await as(who, `/api/member/agents/${botId}/${lane}/messages`)).body;
    const at = conversation.messages.findIndex((m: any) => m.text === text);
    return at >= 0 && !conversation.busy && conversation.messages.slice(at + 1).some((m: any) => m.role === "bot" && m.kind === "text") ? conversation : null;
  }, 30_000);
  assert.ok(done, `"${text}" was never answered\n${h.logs().slice(-3000)}`);
  return done;
}

async function ownerSays(h: Harness, botId: string, text: string) {
  await h.fetch(`/api/bots/${botId}/messages`, { method: "POST", body: JSON.stringify({ text }) });
  const done = await waitFor(async () => {
    const { bots } = await h.json("/api/bots");
    const bot = bots.find((b: any) => b.id === botId);
    const messages = (await h.json(`/api/bots/${botId}/messages?thread=${bot.threadId}&limit=500`)).messages as any[];
    const at = messages.findIndex((m) => m.text === text);
    return at >= 0 && !bot.busy && messages.slice(at + 1).some((m) => m.role === "bot" && m.kind === "text") ? true : null;
  }, 30_000);
  assert.ok(done, `"${text}" was never answered\n${h.logs().slice(-3000)}`);
}

test("on an API engine: each person's own apps, memory and words reach their own turns and nobody else's", { timeout: 240_000 }, async (t) => {
  const engine = await scriptedEngine();
  t.after(() => close(engine.server));
  const { dir, h, composio, sam, ana, guestToken, as, restart } = await household(t, "bloks-household-api-");
  await h.json("/api/providers/grok/connect", { method: "POST", body: JSON.stringify({ key: "test-key", url: `http://127.0.0.1:${engine.port}` }) });
  const { bot: chef } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Chef" }) });
  await h.fetch(`/api/bots/${chef.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "grok", model: "grok-4" } }) });
  const { bot: baker } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Baker" }) });
  await h.fetch(`/api/bots/${baker.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "grok", model: "grok-4" } }) });
  // the Recipes room, with Chef and Baker in it, open to everyone
  const made = await h.json("/api/bloks", { method: "POST", body: JSON.stringify({ name: "Recipes", memberIds: [chef.id, baker.id] }) });
  const roomId = made.blok.id as string;

  // ── each member's own apps key, through their own device ──
  assert.equal((await as(sam, "/api/member/connections/apps", { method: "PUT", body: { key: SAM_KEY } })).status, 200);
  assert.equal((await as(ana, "/api/member/connections/apps", { method: "PUT", body: { key: ANA_KEY } })).status, 200);
  const samsView = await as(sam, "/api/member/connections");
  assert.equal(samsView.body.apps.connected, true);
  assert.equal(samsView.body.apps.ending, SAM_KEY.slice(-4));
  assert.ok(!JSON.stringify(samsView.body).includes(SAM_KEY), "a key was shown back");
  // the member page asks Composio under the member's key alone
  composio.calls.length = 0;
  const apps = await as(sam, "/api/member/connections/apps/services");
  assert.equal(apps.status, 200, JSON.stringify(apps.body));
  assert.equal(apps.body.services.gmail.connected, true);
  assert.deepEqual([...new Set(composio.calls.map((c) => c.who))], ["sam"]);
  const link = await as(ana, "/api/member/connections/apps/gmail", { method: "POST" });
  assert.equal(link.status, 200, JSON.stringify(link.body));
  assert.match(link.body.url, /^https:\/\/connect\.composio\.dev\//);

  // ── "pull my emails": each private turn uses its own person's account ──
  const mail = async (_whose: string, run: () => Promise<unknown>) => {
    composio.calls.length = 0;
    engine.requests.length = 0;
    await run();
    const results = engine.requests.flatMap(toolResults).join("\n");
    return { who: [...new Set(composio.calls.map((c) => c.who))], results, tools: engine.requests.flatMap(toolNames) };
  };
  const samMail = await mail("sam", () => memberSays(as, sam, chef.id, "private", "MAIL for me please", h));
  assert.deepEqual(samMail.who, ["sam"], "Sam's private turn reached Composio as somebody else");
  assert.match(samMail.results, /the inbox of sam/);
  const anaMail = await mail("ana", () => memberSays(as, ana, chef.id, "private", "MAIL for me please", h));
  assert.deepEqual(anaMail.who, ["ana"]);
  assert.match(anaMail.results, /the inbox of ana/);
  assert.doesNotMatch(anaMail.results, /inbox of (sam|hamed)/);
  const ownerMail = await mail("hamed", () => ownerSays(h, chef.id, "MAIL for me please"));
  assert.deepEqual(ownerMail.who, ["hamed"], "the owner's own turn uses the owner's own apps");
  // the team conversation, read by several people, uses nobody's
  const teamMail = await mail("none", () => memberSays(as, sam, chef.id, "team", "MAIL for me please", h));
  assert.deepEqual(teamMail.who, [], "a team conversation turn reached somebody's apps");
  assert.ok(!teamMail.tools.includes("GMAIL_FETCH_EMAILS"));

  // ── memory and words said privately stay with their person ──
  await memberSays(as, sam, chef.id, "private", "REMEMBER:the zebra code is plum", h);
  const samDesk = join(dir, "people", sam.personId, "agents", chef.id);
  assert.match(readFileSync(join(samDesk, "MEMORY.md"), "utf8"), /zebra code is plum/, "Sam's memory was not kept at his desk");
  const agentMemory = join(dir, "workspaces", chef.id, "MEMORY.md");
  assert.ok(!existsSync(agentMemory) || !readFileSync(agentMemory, "utf8").includes("plum"), "Sam's words reached the agent's own memory");

  engine.requests.length = 0;
  await memberSays(as, ana, chef.id, "private", "SEARCH:zebra code", h);
  const anaSaw = engine.requests.map((r) => systemOf(r) + toolResults(r).join("\n")).join("\n");
  assert.doesNotMatch(anaSaw, /plum/, "Ana's turn found Sam's private words or memory");

  engine.requests.length = 0;
  await ownerSays(h, chef.id, "SEARCH:zebra code");
  assert.doesNotMatch(engine.requests.map((r) => JSON.stringify(r.messages)).join("\n"), /plum/, "the owner's turn found Sam's private words");
  // nor the owner's own look back, search or recall-ahead
  const recalled = await h.json(`/api/bots/${chef.id}/recall?q=${encodeURIComponent("zebra code plum")}`);
  assert.ok(!JSON.stringify(recalled).includes("plum"), "the owner's recall reached Sam's private conversation");
  const searched = await h.json(`/api/search?q=${encodeURIComponent("zebra code plum")}`);
  assert.ok(!JSON.stringify(searched).includes("plum"), "the owner's search reached Sam's private conversation");
  // unless the owner reads members' private conversations, which members are told
  await h.fetch("/api/workspace/joining", { method: "PATCH", body: JSON.stringify({ privateReadable: true }) });
  assert.ok(JSON.stringify(await h.json(`/api/search?q=${encodeURIComponent("zebra code plum")}`)).includes("plum"));
  await h.fetch("/api/workspace/joining", { method: "PATCH", body: JSON.stringify({ privateReadable: false }) });

  // Sam's own next turn has it, from his memory and his own words
  engine.requests.length = 0;
  await memberSays(as, sam, chef.id, "private", "SEARCH:zebra code", h);
  assert.match(systemOf(engine.requests[0]), /zebra code is plum/, "Sam's own memory did not come back to him");
  assert.match(engine.requests.flatMap(toolResults).join("\n"), /plum/);
  // and he can read it and forget it
  const memories = await as(sam, "/api/member/memory");
  assert.equal(memories.body.memories[0]?.agent, "Chef");
  assert.equal((await as(ana, "/api/member/memory")).body.memories.length, 0, "Ana reads nothing of Sam's memory");
  assert.equal((await as(sam, `/api/member/memory/${chef.id}`, { method: "DELETE" })).status, 200);
  assert.doesNotMatch(readFileSync(join(samDesk, "MEMORY.md"), "utf8"), /plum/);

  // ── a key asked for in a private conversation is the member's to add ──
  const secretsBefore = await h.json("/api/secrets");
  const asked = await memberSays(as, sam, chef.id, "private", "KEY needed", h);
  assert.ok(asked.messages.some((m: any) => m.kind === "notice" && /Your connections/.test(m.text)), "Sam was not told where to add it");
  assert.ok(!asked.messages.some((m: any) => m.kind === "secret"), "a card the owner could answer was planted");
  assert.deepEqual(await h.json("/api/secrets"), secretsBefore, "the owner's keys changed");
  // and in the team conversation it is nobody's to add: no card there
  // either, which the owner would have answered into his own keys
  engine.requests.length = 0;
  const inTeam = await memberSays(as, sam, chef.id, "team", "KEY needed here", h);
  const teamLane = (await h.json(`/api/bots/${chef.id}/messages?thread=${inTeam.threadId}&limit=500`)).messages as any[];
  assert.ok(!teamLane.some((m) => m.kind === "secret" || m.kind === "connector"), "a card the owner could answer was planted in the team conversation");
  assert.match(engine.requests.flatMap(toolResults).join("\n"), /each person's own/, "the agent was not told why");
  assert.deepEqual(await h.json("/api/secrets"), secretsBefore);

  // ── nobody else reaches a member's own routes ──
  const guest = (path: string, method = "GET") => as(guestToken, path, { method });
  for (const [path, method] of [["/api/member/connections", "GET"], ["/api/member/connections/apps/services", "GET"], ["/api/member/memory", "GET"], ["/api/member/welcomed", "POST"]] as const) {
    assert.equal((await guest(path, method)).status, 403, `a guest reached ${method} ${path}`);
  }
  // the owner's own device has no such route: these are a member's alone
  assert.notEqual((await h.fetch("/api/member/connections")).status, 200);
  // and Ana's device answers about Ana alone
  const anasView = (await as(ana, "/api/member/connections")).body;
  assert.equal(anasView.apps.ending, ANA_KEY.slice(-4));
  assert.ok(!JSON.stringify(anasView).includes(SAM_KEY.slice(-8)));

  // ── a shared room: nobody's own apps, and looking back reaches the room alone ──
  await memberSays(as, sam, chef.id, "private", "the quince word is marmalade", h);
  const shared = await restart(() => {
    const file = join(dir, "bloks.json");
    const rooms = JSON.parse(readFileSync(file, "utf8"));
    const list = Array.isArray(rooms) ? rooms : rooms.bloks;
    const recipes = list.find((r: any) => r.id === roomId);
    recipes.sharing = { since: Date.now(), history: "all", collaboratorsInvite: false, activityDetail: false, tools: "conversation" };
    recipes.audience = "everyone";
    writeFileSync(file, JSON.stringify(rooms));
  });
  composio.calls.length = 0;
  engine.requests.length = 0;
  const posted = await as(sam, `/api/member/rooms/${roomId}/messages`, { method: "POST", body: { text: "@Chef MAIL for me please, and SEARCH:quince word" } });
  assert.ok(posted.status < 300, JSON.stringify(posted.body));
  const answered = await waitFor(async () => {
    const seen = (await as(sam, `/api/member/rooms/${roomId}`)).body;
    return seen.messages?.some((m: any) => m.role === "bot" && m.kind === "text" && m.text === "Done.") ? true : null;
  }, 30_000);
  assert.ok(answered, shared.logs().slice(-3000));
  assert.ok(engine.requests.length > 0, "the room turn never reached the engine");
  assert.deepEqual([...new Set(composio.calls.map((c) => c.who))], [], "a shared room reached somebody's apps");
  assert.ok(!engine.requests.flatMap(toolNames).includes("GMAIL_FETCH_EMAILS"));
  assert.doesNotMatch(engine.requests.map((r) => JSON.stringify(r.messages)).join("\n"), /marmalade/, "the room found Sam's private words");
});

test("on an engine with a shell: a member's keys, folder and apps in their own turns alone, and none of it for an agent's token", { timeout: 240_000 }, async (t) => {
  const scratch = mkdtempSync(join(tmpdir(), "bloks-household-cli-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const runs = join(scratch, "runs.jsonl");
  const cli = join(scratch, "fake-claude.mjs");
  writeFileSync(runs, "");
  // A Claude Code that writes down what it was started with: the folder,
  // the keys in its environment, the rules it was handed and the apps in
  // its tool servers. Told PROBE, it tries a member's own routes with the
  // turn's own credential, as an agent could.
  writeFileSync(
    cli,
    `#!${process.execPath}
import { appendFileSync, readFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("2.1.299 (Claude Code)"); process.exit(0); }
if (args[0] === "auth") { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
const out = (f) => console.log(JSON.stringify(f));
const at = args.indexOf("--mcp-config");
let composio = null;
try { composio = at >= 0 ? JSON.parse(readFileSync(args[at + 1], "utf8")).mcpServers?.composio?.headers?.["x-consumer-api-key"] ?? null : null; } catch {}
let input = "";
process.stdin.on("data", async function take(c) {
  input += c;
  const frame = input.split("\\n").slice(0, -1).filter(Boolean).map(JSON.parse).find((f) => f.type === "user");
  if (!frame) return;
  process.stdin.off("data", take);
  const said = typeof frame.message.content === "string" ? frame.message.content : JSON.stringify(frame.message.content);
  const run = {
    said: said.slice(-80),
    cwd: process.cwd(),
    transistor: process.env.TRANSISTOR_API_KEY ?? null,
    ownerOnly: process.env.OWNER_ONLY ?? null,
    token: Boolean(process.env.BLOKS_TOKEN),
    denied: args.filter((a, i) => args[i - 1] === "--disallowedTools"),
    added: args.filter((a, i) => args[i - 1] === "--add-dir"),
    composio,
  };
  if (said.includes("PROBE") && process.env.BLOKS_TOKEN) {
    const auth = { authorization: "Bearer " + process.env.BLOKS_TOKEN };
    run.probe = {};
    for (const path of ["/api/member/connections", "/api/member/memory", "/api/member/connections/secrets/TRANSISTOR_API_KEY"]) {
      run.probe[path] = (await fetch(process.env.BLOKS_URL + path, { headers: auth })).status;
    }
  }
  appendFileSync(${JSON.stringify(runs)}, JSON.stringify(run) + "\\n");
  out({ type: "system", subtype: "init", session_id: "s-" + Date.now(), model: "claude-sonnet-5" });
  out({ type: "assistant", message: { content: [{ type: "text", text: "Done" }] } });
  out({ type: "result", subtype: "success", is_error: false, num_turns: 1, duration_api_ms: 1, session_id: "s", result: "Done", total_cost_usd: 0 });
});
`,
    { mode: 0o755 },
  );
  const { dir, h, sam, ana, as } = await household(t, "bloks-household-cli-home-", {
    instances: { claude: { driver: "claudeAgent", config: { cli } } },
  });
  const { bot: chef } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Chef" }) });
  await h.fetch(`/api/bots/${chef.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } }) });
  const samValue = ["sams", "own", "value"].join("-");
  assert.equal((await as(sam, "/api/member/connections/secrets/TRANSISTOR_API_KEY", { method: "PUT", body: { value: samValue } })).status, 200);
  assert.equal((await as(sam, "/api/member/connections/secrets/PATH", { method: "PUT", body: { value: "x" } })).status, 400, "a reserved name");
  assert.equal((await as(sam, "/api/member/connections/apps", { method: "PUT", body: { key: SAM_KEY } })).status, 200);

  const runOf = async (said: string) => {
    const found = await waitFor(() =>
      readFileSync(runs, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).reverse().find((run) => run.said.includes(said)),
    30_000);
    assert.ok(found, `no run for ${said}\n${h.logs().slice(-3000)}`);
    return found;
  };

  await memberSays(as, sam, chef.id, "private", "SAMS-TURN", h);
  const samRun = await runOf("SAMS-TURN");
  const samDesk = join(dir, "people", sam.personId, "agents", chef.id);
  assert.equal(samRun.transistor, samValue, "Sam's own key was not in his turn");
  assert.equal(samRun.ownerOnly, null, "the owner's key reached a member's turn");
  assert.equal(samRun.token, false, "a member's turn got the agent's credential");
  assert.equal(samRun.composio, SAM_KEY, "Sam's turn did not use his own apps");
  assert.ok(samRun.cwd.endsWith(join("people", sam.personId, "agents", chef.id)), `Sam's turn ran in ${samRun.cwd}`);
  assert.ok(samRun.added.some((d: string) => d.endsWith(join("agents", chef.id))), "his desk is not an editable folder");
  assert.ok(!samRun.added.some((d: string) => d.includes(join("workspaces", chef.id))), "the agent's own folder was handed to his turn");
  const deniedText = samRun.denied.join(" ");
  assert.match(deniedText, /workspaces\/\*\*/, "the agents' own folders were not closed to his turn");
  assert.ok(deniedText.includes(join("people", ana.personId)), "Ana's folder was not closed to his turn");
  assert.ok(!deniedText.includes(join("people", sam.personId)), "his own folder was closed to him");
  assert.ok(existsSync(samDesk));

  await memberSays(as, ana, chef.id, "private", "ANAS-TURN", h);
  const anaRun = await runOf("ANAS-TURN");
  assert.equal(anaRun.transistor, null, "Sam's key reached Ana's turn");
  assert.equal(anaRun.composio, null, "Ana has no apps, and got somebody else's");
  assert.equal(anaRun.ownerOnly, null);

  await memberSays(as, sam, chef.id, "team", "SAMS-TEAM-TURN", h);
  const teamRun = await runOf("SAMS-TEAM-TURN");
  assert.equal(teamRun.transistor, null, "a member's key reached the team conversation");
  assert.equal(teamRun.composio, null, "somebody's apps reached the team conversation");

  await ownerSays(h, chef.id, "OWNERS-TURN PROBE");
  const ownerRun = await runOf("OWNERS-TURN");
  assert.equal(ownerRun.ownerOnly, "the owners own value", "the owner's own key is the owner's");
  assert.equal(ownerRun.transistor, null, "Sam's key reached the owner's turn");
  assert.equal(ownerRun.composio, OWNER_KEY);
  // the agent's token reaches none of a member's own routes
  assert.ok(ownerRun.probe, "the owner's turn had no credential to probe with");
  for (const [path, status] of Object.entries(ownerRun.probe)) assert.ok((status as number) >= 400, `an agent's token reached ${path}: ${status}`);

  // gone from the workspace, gone from this computer
  assert.equal((await h.fetch(`/api/workspace/members/${sam.personId}`, { method: "DELETE" })).status, 200);
  assert.ok(!existsSync(join(dir, "people", sam.personId)), "Sam's keys and desk outlived him");
});

test("on Claude Code: nothing of the owner's own engine setup, profile or memory reaches a member's turn or a member's own agent", { timeout: 240_000 }, async (t) => {
  const scratch = mkdtempSync(join(tmpdir(), "bloks-household-own-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const runs = join(scratch, "runs.jsonl");
  const cli = join(scratch, "fake-claude.mjs");
  writeFileSync(runs, "");
  // A Claude Code that writes down what would have come from the owner's
  // own setup: the connectors his Claude account brings (claude.ai's
  // Gmail and the rest), the MCP servers in his own settings, his
  // CLAUDE.md and Claude's memory of him, and what it was told.
  writeFileSync(
    cli,
    `#!${process.execPath}
import { appendFileSync, readFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("2.1.299 (Claude Code)"); process.exit(0); }
if (args[0] === "auth") { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
const out = (f) => console.log(JSON.stringify(f));
const after = (flag) => { const at = args.indexOf(flag); return at >= 0 ? args[at + 1] : null; };
let servers = {};
try { servers = JSON.parse(readFileSync(after("--mcp-config"), "utf8")).mcpServers ?? {}; } catch {}
let system = "";
try { system = readFileSync(after("--append-system-prompt-file"), "utf8"); } catch {}
let input = "";
process.stdin.on("data", function take(c) {
  input += c;
  const frame = input.split("\\n").slice(0, -1).filter(Boolean).map(JSON.parse).find((f) => f.type === "user");
  if (!frame) return;
  process.stdin.off("data", take);
  const said = typeof frame.message.content === "string" ? frame.message.content : JSON.stringify(frame.message.content);
  appendFileSync(${JSON.stringify(runs)}, JSON.stringify({
    said: said.slice(-200),
    claudeAi: process.env.ENABLE_CLAUDEAI_MCP_SERVERS ?? null,
    claudeMds: process.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS ?? null,
    autoMemory: process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY ?? null,
    strict: args.includes("--strict-mcp-config"),
    composio: servers.composio?.headers?.["x-consumer-api-key"] ?? null,
    token: Boolean(process.env.BLOKS_TOKEN),
    ownerOnly: process.env.OWNER_ONLY ?? null,
    system,
  }) + "\\n");
  // told to, it hands the room to Sam's agent, as an agent of the owner's
  // can in a room they share
  const reply = said.includes("PASS-TO-HELPER") && !said.includes("HELPER-IN-ROOM") ? "@Helper HELPER-IN-ROOM over to you" : "Done";
  out({ type: "system", subtype: "init", session_id: "s-" + Date.now(), model: "claude-sonnet-5" });
  out({ type: "assistant", message: { content: [{ type: "text", text: reply }] } });
  out({ type: "result", subtype: "success", is_error: false, num_turns: 1, duration_api_ms: 1, session_id: "s", result: reply, total_cost_usd: 0 });
});
`,
    { mode: 0o755 },
  );
  const { dir, h: first, sam, as, restart } = await household(t, "bloks-household-own-home-", {
    instances: { claude: { driver: "claudeAgent", config: { cli } } },
    profile: { name: "Hamed", about: "Hamed grows quinces and banks with the Medlar bank." },
  });
  let h = first;
  // what the owner keeps for his own agents, written before anybody joined
  mkdirSync(join(dir, "shared"), { recursive: true });
  writeFileSync(join(dir, "shared", "MEMORY.md"), "# Shared\n\n- The family safe code is 4417.\n");
  const { bot: chef } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Chef" }) });
  await h.fetch(`/api/bots/${chef.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } }) });
  assert.equal((await as(sam, "/api/member/connections/apps", { method: "PUT", body: { key: SAM_KEY } })).status, 200);
  // Sam makes an agent of his own
  const made = await as(sam, "/api/member/agents", { method: "POST", body: { name: "Helper", engine: { instanceId: "claude", model: "claude-sonnet-5" } } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const helper = made.body.agent.id as string;

  const runOf = async (said: string) => {
    const found = await waitFor(() =>
      readFileSync(runs, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).reverse().find((run) => run.said.includes(said)),
    30_000);
    assert.ok(found, `no run for ${said}\n${h.logs().slice(-3000)}`);
    return found;
  };
  const apart = (run: any, where: string) => {
    assert.equal(run.claudeAi, "false", `${where}: the owner's claude.ai connectors (his Gmail among them) were on`);
    assert.equal(run.strict, true, `${where}: the MCP servers in the owner's own Claude settings were loaded`);
    assert.equal(run.claudeMds, "1", `${where}: the owner's CLAUDE.md was read`);
    assert.equal(run.autoMemory, "1", `${where}: Claude's memory of the owner was read`);
    assert.doesNotMatch(run.system, /quinces|Medlar/, `${where}: the owner's profile was in the prompt`);
    assert.doesNotMatch(run.system, /4417/, `${where}: the owner's shared memory was in the prompt`);
  };

  await memberSays(as, sam, helper, "private", "SAMS-OWN-AGENT", h);
  const own = await runOf("SAMS-OWN-AGENT");
  apart(own, "Sam's own agent");
  assert.equal(own.composio, SAM_KEY, "Sam's own agent did not use his own apps");
  assert.match(own.system, /Sam's own agent/);
  assert.match(own.system, /are Sam's own/);

  await memberSays(as, sam, chef.id, "private", "SAMS-PRIVATE", h);
  const mine = await runOf("SAMS-PRIVATE");
  apart(mine, "Sam's private conversation");
  assert.equal(mine.composio, SAM_KEY);

  await memberSays(as, sam, chef.id, "team", "SAMS-TEAM", h);
  const team = await runOf("SAMS-TEAM");
  apart(team, "the team conversation");
  assert.equal(team.composio, null, "somebody's apps reached the team conversation");
  assert.doesNotMatch(team.system, /request_connection/, "a member's team turn was told to connect apps under the owner's account");
  assert.match(team.system, /no connected apps/i, "the agent was not told it has nobody's apps here");

  // the owner's own turn is as it always was
  await ownerSays(h, chef.id, "OWNERS-OWN");
  const owner = await runOf("OWNERS-OWN");
  assert.equal(owner.claudeAi, null, "the owner's own connectors were switched off for him");
  assert.equal(owner.strict, false, "the owner's own MCP servers were switched off for him");
  assert.equal(owner.claudeMds, null);
  assert.equal(owner.autoMemory, null);
  assert.equal(owner.composio, OWNER_KEY);
  assert.equal(owner.ownerOnly, "the owners own value");
  assert.match(owner.system, /quinces/);
  assert.match(owner.system, /4417/);

  // ── a room where Sam's agent and the owner's meet ──
  // Sam put his agent in the owner's room (written straight to the rooms
  // file, as a test shares a room). The owner asks Chef, and Chef hands
  // the room to Helper: a turn the owner set going, on Sam's agent, which
  // still works for Sam and never with anything of the owner's.
  const { bot: baker } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Baker" }) });
  await h.fetch(`/api/bots/${baker.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } }) });
  const room = (await h.json("/api/bloks", { method: "POST", body: JSON.stringify({ name: "Kitchen", memberIds: [chef.id, baker.id] }) })).blok.id as string;
  h = await restart(() => {
    const file = join(dir, "bloks.json");
    const rooms = JSON.parse(readFileSync(file, "utf8"));
    const list = Array.isArray(rooms) ? rooms : rooms.bloks;
    list.find((r: any) => r.id === room).memberIds.push(helper);
    writeFileSync(file, JSON.stringify(rooms));
  });
  await h.fetch(`/api/bloks/${room}/messages`, { method: "POST", body: JSON.stringify({ text: "@Chef PASS-TO-HELPER" }) });
  const handed = await runOf("HELPER-IN-ROOM");
  apart(handed, "Sam's agent in a room, set going by the owner");
  assert.equal(handed.composio, null, "Sam's agent in a room used somebody's apps");
  assert.equal(handed.token, false, "Sam's agent got the owner's credential");
  assert.equal(handed.ownerOnly, null, "the owner's keys reached Sam's agent");
  assert.match(handed.system, /Helper/);
  assert.match(handed.system, /Sam's own agent/);
  assert.doesNotMatch(handed.system, /About the person you work for/);
});
