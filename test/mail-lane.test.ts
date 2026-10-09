// An agent's Email lane, past the happy path in agent-mail.test.ts: who
// is emailed when a turn for a mail goes wrong, and what a mail from
// anyone may do on the owner's machine.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { startHarness } from "./helpers/server.ts";
import { waitFor } from "./helpers/turns.ts";

const MAIL_ID = "fedcba9876543210fedc";

/** Bloks Cloud as the relay line sees it: asks go down the stream, and
 * every email Bloks sends is kept. */
function stubRelay() {
  let send: ((frame: unknown) => void) | null = null;
  const results = new Map<string, number>();
  const sent: Array<Record<string, any>> = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? "").split("?")[0];
    if (path === "/space/agent/stream") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      send = (frame) => res.write(`data: ${JSON.stringify(frame)}\n\n`);
      send({ kind: "hello", spaceId: "space-test" });
      return;
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = body ? JSON.parse(body) : {};
      res.writeHead(200, { "content-type": "application/json" });
      if (path === "/space/agent/result") results.set(String(parsed.id), Number(parsed.status));
      if (path === "/space/agent/hook" && parsed.platform === "email") return res.end(JSON.stringify({ id: MAIL_ID, domain: "agents.bloks.dev" }));
      if (path === "/space/agent/email") sent.push(parsed);
      res.end("{}");
    });
  });
  return { server, ask: (id: string, payload: string) => send?.({ kind: "ask", id, payload }), results, sent, connected: () => send !== null };
}

/** An engine that answers every turn at once with the same words. Asked
 * to summarise a conversation (a fold), it answers the same way, or fails
 * at once, or holds the call in `folds` until the test lets it fail. */
async function engine(t: TestContext) {
  const state = { calls: [] as string[], folding: "answer" as "answer" | "fail" | "hold", folds: [] as Array<() => void> };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.url?.endsWith("/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ data: [{ id: "m-1" }] }));
      }
      if (state.folding !== "answer" && /Summarise this part of a conversation|Here is a summary of a conversation so far/.test(body)) {
        const fail = () => {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: "not now" } }));
        };
        if (state.folding === "hold") state.folds.push(fail);
        else fail();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      state.calls.push(body);
      // asked to look something up, it does, once, before it answers
      const messages = (JSON.parse(body || "{}").messages ?? []) as Array<{ role: string; content?: unknown }>;
      if (body.includes("LOOK-IT-UP") && !messages.some((m) => m.role === "tool")) {
        const call = { id: "call-recall", type: "function", function: { name: "search_history", arguments: JSON.stringify({ query: "PRIVATE-NOTE" }) } };
        return res.end(JSON.stringify({ choices: [{ message: { role: "assistant", tool_calls: [call] } }] }));
      }
      // asked for nothing but a card, it answers with one and no words
      const content = body.includes("ONLY-A-CARD") ? '```bloks\n{"kind":"quote","text":"hi"}\n```' : "Here is my answer.";
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  t.after(() => {
    state.folds.forEach((fail) => fail());
    server.closeAllConnections();
    server.close();
  });
  return { state, port: (server.address() as { port: number }).port };
}

async function mailbox(t: TestContext, env: Record<string, string> = {}) {
  const model = await engine(t);
  const h = await startHarness(env);
  const relay = stubRelay();
  t.after(async () => {
    relay.server.closeAllConnections();
    relay.server.close();
    await h.stop();
  });
  await h.fetch("/api/providers/grok/connect", {
    method: "POST",
    body: JSON.stringify({ key: "xai-test-0000000000", url: `http://127.0.0.1:${model.port}` }),
  });
  await new Promise<void>((r) => relay.server.listen(0, "127.0.0.1", () => r()));
  await h.fetch("/api/pair", { method: "PUT", body: JSON.stringify({ enabled: true }) });
  await h.fetch("/api/relay", {
    method: "PUT",
    body: JSON.stringify({ url: `http://127.0.0.1:${(relay.server.address() as any).port}`, agentToken: "agent-token", enabled: true }),
  });
  for (let i = 0; i < 100 && !relay.connected(); i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(relay.connected(), "the relay line never opened");
  await h.json("/api/chat/email", { method: "PATCH", body: JSON.stringify({ enabled: true }) });
  let asks = 0;
  return {
    h,
    relay,
    model,
    async agent(name: string) {
      const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name }) });
      await h.fetch(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "grok", model: "m-1" } }) });
      return bot as { id: string; threadId: string };
    },
    async deliver(to: string, from: string, text: string) {
      const id = `ask-${++asks}`;
      const mail = { to: `${to}.${MAIL_ID}@agents.bloks.dev`, from, fromName: "", subject: "A question", text, messageId: `<${id}@example.com>` };
      relay.ask(id, `hook:${JSON.stringify({ platform: "email", body: JSON.stringify(mail), signature: null })}`);
      for (let i = 0; i < 100 && !relay.results.has(id); i++) await new Promise((r) => setTimeout(r, 50));
      return relay.results.get(id);
    },
    /** Mail from a sender nobody listed is answered in a lane of its own. */
    async lane(botId: string, title = "Unlisted email") {
      const bot = (await h.json("/api/bots?messages=0")).bots.find((b: any) => b.id === botId);
      return bot?.tasks.find((task: any) => task.title === title) as { id: string; state: string } | undefined;
    },
    idle: (botId: string) =>
      waitFor(async () => {
        const bot = (await h.json("/api/bots?messages=0")).bots.find((b: any) => b.id === botId);
        return bot && !bot.busy ? bot : null;
      }),
  };
}

test("a mail whose turn fails getting ready leaves no sender to email the lane's next answer to", async (t) => {
  // a runtime that is not there, so a turn on the Local VM fails before
  // it reaches any engine
  const box = await mailbox(t, { BLOKS_VM_RUNTIME: "/nonexistent/bloks-test-container-runtime" });
  const dee = await box.agent("Dee");
  await box.h.fetch(`/api/bots/${dee.id}`, { method: "PATCH", body: JSON.stringify({ computer: "sandbox" }) });
  // a listed sender's turn has the agent's computer; anyone else's has none
  await box.h.json("/api/chat/email", { method: "PATCH", body: JSON.stringify({ allowFrom: ["@example.com"] }) });

  assert.equal(await box.deliver("dee", "first@example.com", "Can you check the invoices?"), 202);
  const lane = await waitFor(() => box.lane(dee.id, "Email"));
  assert.ok(lane, "the mail never reached an Email lane");
  const failed = await waitFor(async () =>
    (await box.h.json(`/api/bots/${dee.id}/messages?thread=${lane.id}&limit=50`)).messages.find((m: any) => m.tool?.ok === false),
  );
  assert.ok(failed, "the turn did not fail the way this test needs");
  assert.ok(await box.idle(dee.id));

  // The person then uses the lane themselves. Its answer is theirs: the
  // sender of the mail that never ran was still wired to the lane, and
  // was emailed it.
  await box.h.fetch(`/api/bots/${dee.id}`, { method: "PATCH", body: JSON.stringify({ computer: "off" }) });
  await box.h.fetch(`/api/bots/${dee.id}/messages`, { method: "POST", body: JSON.stringify({ text: "Draft a note to myself", taskId: lane.id }) });
  assert.ok(await waitFor(() => box.model.state.calls.length >= 1), "the person's own turn never ran");
  assert.ok(await box.idle(dee.id));
  await new Promise((r) => setTimeout(r, 500));
  assert.deepEqual(box.relay.sent.map((mail) => mail.to), [], "somebody was emailed an answer that was not to them");
});

test("two passes over the mail line never answer one mail twice, or drop another", async (t) => {
  const box = await mailbox(t);
  const bea = await box.agent("Bea");
  const cy = await box.agent("Cy");
  const sentTo = (address: string) => box.relay.sent.filter((mail) => mail.to === address).length;
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

  // Bea's Email lane, long enough that its next turn folds before it
  // starts. A model the table does not know gets a small window, so one
  // long message does it; folds fail until the race, so it stays long.
  // Listed senders: mail from anyone is told alone, so it never folds.
  box.model.state.folding = "fail";
  await box.h.json("/api/chat/email", { method: "PATCH", body: JSON.stringify({ allowFrom: ["@example.com"] }) });
  assert.equal(await box.deliver("bea", "seed@example.com", "Hello"), 202);
  assert.ok(await waitFor(() => sentTo("seed@example.com") === 1), "the first mail was not answered");
  const lane = (await box.lane(bea.id, "Email"))!;
  for (const text of ["x".repeat(99_000), "two", "three"]) {
    await box.h.fetch(`/api/bots/${bea.id}/messages`, { method: "POST", body: JSON.stringify({ text, taskId: lane.id }) });
    assert.ok(await box.idle(bea.id));
    await pause(1_000);
  }

  // A for Bea and B for Cy wait in the line through a drain, so the pass
  // that calling it off starts has both. A's turn then waits on its fold.
  box.model.state.folding = "hold";
  await box.h.json("/api/maintenance/drain", { method: "POST", body: JSON.stringify({ seconds: 60 }) });
  assert.equal(await box.deliver("bea", "a@example.com", "Mail A"), 202);
  assert.equal(await box.deliver("cy", "b@example.com", "Mail B"), 202);
  await box.h.json("/api/maintenance/drain", { method: "DELETE" });
  assert.ok(await waitFor(() => box.model.state.folds.length >= 1), "A's turn did not fold first, so this proves nothing");

  // Meanwhile another pass answers B, then C after it, and D waits for
  // Bea's lane, last in the line.
  assert.equal(await box.deliver("cy", "c@example.com", "Mail C"), 202);
  assert.ok(await waitFor(() => sentTo("b@example.com") === 1 && sentTo("c@example.com") === 1), "B and C were not answered");
  assert.equal(await box.deliver("bea", "d@example.com", "Mail D"), 202);
  await pause(500);

  // The first pass carries on past A, to the B the other pass already
  // answered. It used to splice it out at -1, taking D with it, and
  // answer B a second time.
  box.model.state.folding = "fail";
  box.model.state.folds.splice(0).forEach((fail) => fail());
  assert.ok(await waitFor(() => sentTo("a@example.com") === 1 && sentTo("d@example.com") === 1, 20_000), "A or D was never answered");
  await pause(1_000);
  assert.ok(await box.idle(cy.id));
  assert.equal(sentTo("b@example.com"), 1, "B was answered twice");
  assert.equal(sentTo("d@example.com"), 1);
});

// ── mail from anyone ──
//
// With nobody listed under who may write, anyone with the address can
// start a turn. It ran under the agent's own approvals, so an agent in
// full access ran a stranger's mail with every guard off and every saved
// secret in its environment. Now that turn runs as one the owner did not
// ask for, and a listed sender's mail runs as before.

const SECRET = "widget-secret-value";

/** A home whose engines are stand-ins that keep, per mail (MARK-<tag> in
 * the words), what they were started with: a Pi over ACP that asks to
 * edit a file and keeps the answer, a Claude Code that keeps its
 * arguments, and one that is always out of usage. A secret is saved for
 * agents, and Composio is connected so Claude Code has a connector to
 * pre-allow. */
function strangerHome() {
  const home = mkdtempSync(join(tmpdir(), "bloks-mail-anyone-"));
  const pi = join(home, "fake-pi.cjs");
  writeFileSync(
    pi,
    `#!${process.execPath}
const fs = require("node:fs");
const say = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
const waiting = new Map();
let asked = 9000;
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (!msg.method) return waiting.get(msg.id)?.(msg.result);
  if (msg.id === undefined) return;
  const reply = (result) => say({ jsonrpc: "2.0", id: msg.id, result });
  if (msg.method === "initialize") return reply({ protocolVersion: 1, agentCapabilities: {} });
  if (msg.method === "session/new") return reply({ sessionId: "s1" });
  if (msg.method !== "session/prompt") return reply({});
  const text = msg.params.prompt.map((p) => p.text).join("");
  const tag = (text.match(/MARK-(\\w+)/) || [])[1] || "none";
  fs.writeFileSync(${JSON.stringify(home)} + "/pi-" + tag + ".json", JSON.stringify({ secret: process.env.WIDGET_TOKEN ?? null }));
  const id = asked++;
  waiting.set(id, (result) => {
    fs.writeFileSync(${JSON.stringify(home)} + "/answer-" + tag + ".json", JSON.stringify(result ?? null));
    reply({ stopReason: "end_turn" });
  });
  say({ jsonrpc: "2.0", id, method: "session/request_permission", params: {
    sessionId: "s1",
    toolCall: { toolCallId: "t1", title: "Edit notes.txt", kind: "edit" },
    options: [{ optionId: "allow", name: "Allow once", kind: "allow_once" }, { optionId: "reject", name: "Reject", kind: "reject_once" }],
  } });
});
`,
    { mode: 0o755 },
  );
  const claude = join(home, "fake-claude.mjs");
  writeFileSync(
    claude,
    `#!${process.execPath}
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("9.9.9 (Claude Code)"); process.exit(0); }
if (args[0] === "auth") { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
const out = (frame) => console.log(JSON.stringify(frame));
let buf = "";
let started = false;
process.stdin.on("data", (c) => {
  buf += c;
  for (let i = buf.indexOf("\\n"); i >= 0; i = buf.indexOf("\\n")) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim() || started) continue;
    const frame = JSON.parse(line);
    if (frame.type !== "user") continue;
    started = true;
    const tag = (String(frame.message?.content ?? "").match(/MARK-(\\w+)/) || [])[1] || "none";
    writeFileSync(${JSON.stringify(home)} + "/claude-" + tag + ".json", JSON.stringify({ args, secret: process.env.WIDGET_TOKEN ?? null, token: process.env.BLOKS_TOKEN ?? null }));
    out({ type: "system", subtype: "init", session_id: "sess-mail", model: "claude-sonnet-5" });
    out({ type: "assistant", message: { content: [{ type: "text", text: "Thanks for writing." }] } });
    out({ type: "result", subtype: "success", is_error: false, num_turns: 1, duration_api_ms: 100, total_cost_usd: 0, session_id: "sess-mail", result: "Thanks for writing." });
  }
});
`,
    { mode: 0o755 },
  );
  // a Claude Code that is out of usage, so its turn goes to the backup
  const out = join(home, "fake-claude-out.mjs");
  writeFileSync(
    out,
    `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("9.9.9 (Claude Code)"); process.exit(0); }
if (args[0] === "auth") { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
const out = (frame) => console.log(JSON.stringify(frame));
let started = false;
process.stdin.on("data", () => {
  if (started) return;
  started = true;
  const said = "Claude AI usage limit reached|" + (Math.floor(Date.now() / 1000) + 3 * 3600);
  out({ type: "system", subtype: "init", session_id: "sess-out", model: "claude-sonnet-5" });
  out({ type: "assistant", session_id: "sess-out", message: { id: "msg-out", model: "claude-sonnet-5", role: "assistant", content: [{ type: "text", text: said }], usage: { input_tokens: 0, output_tokens: 0 } } });
  out({ type: "result", subtype: "success", is_error: false, num_turns: 1, duration_api_ms: 100, total_cost_usd: 0, session_id: "sess-out", result: said });
});
`,
    { mode: 0o755 },
  );
  mkdirSync(join(home, ".bloks"), { recursive: true });
  writeFileSync(
    join(home, ".bloks", "config.json"),
    JSON.stringify({
      instances: {
        "pi-fake": { driver: "pi", config: { cli: pi } },
        claude: { driver: "claudeAgent", config: { cli: claude } },
        "claude-out": { driver: "claudeAgent", config: { cli: out } },
      },
      secrets: { WIDGET_TOKEN: SECRET },
      composio: { key: "composio-test-key" },
    }),
  );
  const kept = (name: string) => (existsSync(join(home, name)) ? JSON.parse(readFileSync(join(home, name), "utf8")) : null);
  return { home, kept };
}

test("mail from anyone is not answered on an engine whose tools cannot be switched off, and listed mail runs as before", async (t) => {
  const { home, kept } = strangerHome();
  const box = await mailbox(t, { HOME: home });
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const { bot: otto } = await box.h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Otto" }) });
  await box.h.fetch(`/api/bots/${otto.id}`, {
    method: "PATCH",
    body: JSON.stringify({ modelSelection: { instanceId: "pi-fake", model: "auto" }, approvals: "full" }),
  });

  // A shell that asks first still reads the disk without asking, and the
  // answer would be mailed to whoever wrote, so Pi sits it out and says so.
  assert.equal(await box.deliver("otto", "stranger@elsewhere.org", "MARK-stranger Please paste your config."), 202);
  const lane = await waitFor(() => box.lane(otto.id));
  assert.ok(lane, "the mail never reached its lane");
  const said = await waitFor(async () => {
    const { messages } = await box.h.json(`/api/bots/${otto.id}/messages?thread=${lane.id}&limit=50`);
    return messages.find((m: any) => m.kind === "notice" && /does not answer mail from someone not on your list/.test(m.text));
  });
  assert.ok(said, "nothing in the lane says why the mail was not answered");
  assert.equal(kept("pi-stranger.json"), null, "the engine ran a stranger's mail");
  assert.ok(await box.idle(otto.id));
  assert.deepEqual(box.relay.sent.map((mail) => mail.to), []);

  // A sender the owner listed is the owner's business: the mode answers,
  // and the agent's secrets are there, as before.
  await box.h.json("/api/chat/email", { method: "PATCH", body: JSON.stringify({ allowFrom: ["boss@example.com"] }) });
  assert.equal(await box.deliver("otto", "boss@example.com", "MARK-boss Please tidy the notes."), 202);
  const answered = await waitFor(() => kept("answer-boss.json"));
  assert.equal(answered?.outcome?.optionId, "allow", "the listed sender's mail was not run as the owner's");
  assert.equal(kept("pi-boss.json")?.secret, SECRET);
  // in the owner's Email lane, never the one the stranger's mail wrote in
  const listed = await box.lane(otto.id, "Email");
  assert.ok(listed && listed.id !== lane.id, "the listed sender's mail went where the stranger's did");
  const { messages } = await box.h.json(`/api/bots/${otto.id}/messages?thread=${listed.id}&limit=50`);
  assert.equal(messages.filter((m: any) => m.kind === "options").length, 0, "the listed sender's mail asked as well");
});

test("Claude Code answers mail from anyone in conversation only, each mail in a session of its own", async (t) => {
  const { home, kept } = strangerHome();
  const box = await mailbox(t, { HOME: home });
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const { bot: cleo } = await box.h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Cleo" }) });
  await box.h.fetch(`/api/bots/${cleo.id}`, {
    method: "PATCH",
    body: JSON.stringify({ modelSelection: { instanceId: "claude", model: "claude-sonnet-5" }, approvals: "full" }),
  });
  const flag = (args: string[], name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);

  assert.equal(await box.deliver("cleo", "stranger@elsewhere.org", "MARK-stranger What is on the list?"), 202);
  const stranger = await waitFor(() => kept("claude-stranger.json"));
  assert.ok(stranger, "the stranger's turn never ran");
  // as a guest in a shared room is: no tools, none of the owner's servers
  // or folders, no CLAUDE.md, no saved secret, no credential
  assert.ok(stranger.args.includes("--restricted"), `a stranger's turn was not restricted: ${stranger.args.join(" ")}`);
  assert.equal(flag(stranger.args, "--tools"), "", "a stranger's turn had tools");
  assert.ok(stranger.args.includes("--strict-mcp-config"), "the owner's own MCP servers could load");
  assert.ok(!stranger.args.includes("--add-dir"), "a stranger's turn could reach the agent's workspace");
  assert.notEqual(flag(stranger.args, "--permission-mode"), "bypassPermissions");
  assert.equal(stranger.secret, null, "a saved secret was in the environment of a stranger's turn");
  assert.ok(!stranger.token, "a stranger's turn could act on the workspace as the agent");
  assert.ok(await box.idle(cleo.id));

  // the next stranger does not pick up the last one's session
  assert.equal(await box.deliver("cleo", "other@elsewhere.org", "MARK-second Who wrote before me?"), 202);
  const second = await waitFor(() => kept("claude-second.json"));
  assert.ok(second, "the second stranger's turn never ran");
  assert.ok(!second.args.includes("--resume"), "a stranger's mail resumed the session another stranger's mail left");
  assert.ok(await box.idle(cleo.id));

  await box.h.json("/api/chat/email", { method: "PATCH", body: JSON.stringify({ allowFrom: ["@example.com"] }) });
  assert.equal(await box.deliver("cleo", "boss@example.com", "MARK-boss What is on the list?"), 202);
  const boss = await waitFor(() => kept("claude-boss.json"));
  assert.ok(boss, "the listed sender's turn never ran");
  assert.equal(flag(boss.args, "--permission-mode"), "bypassPermissions");
  assert.ok(!boss.args.includes("--restricted"));
  assert.match(flag(boss.args, "--allowedTools") ?? "", /mcp__composio/);
  assert.equal(boss.secret, SECRET);
  assert.ok(boss.token, "a listed sender's turn lost the agent's credential");
});

test("a backup engine picking up a stranger's mail goes on as the stranger's turn", async (t) => {
  // The backup starts a new turn with the same words, after the first one
  // has ended and forgotten who asked for it; it used to go on as the
  // owner's, with everything the stranger's turn was kept from.
  const { home, kept } = strangerHome();
  const box = await mailbox(t, { HOME: home });
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const { bot: dora } = await box.h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Dora" }) });
  await box.h.fetch(`/api/bots/${dora.id}`, {
    method: "PATCH",
    body: JSON.stringify({
      modelSelection: { instanceId: "claude-out", model: "claude-sonnet-5" },
      backupSelection: { instanceId: "claude", model: "claude-sonnet-5" },
      approvals: "full",
    }),
  });

  assert.equal(await box.deliver("dora", "stranger@elsewhere.org", "MARK-handed Can you look at this?"), 202);
  const picked = await waitFor(() => kept("claude-handed.json"));
  assert.ok(picked, "the backup never picked the mail up");
  assert.ok(picked.args.includes("--restricted"), `the backup ran the stranger's mail with tools: ${picked.args.join(" ")}`);
  assert.notEqual(picked.args[picked.args.indexOf("--permission-mode") + 1], "bypassPermissions");
  assert.equal(picked.secret, null, "the backup had the saved secrets");
});

test("on an API engine, mail from anyone reads none of the owner's conversations", async (t) => {
  const box = await mailbox(t);
  const ivo = await box.agent("Ivo");
  await box.h.fetch(`/api/bots/${ivo.id}/messages`, { method: "POST", body: JSON.stringify({ text: "PRIVATE-NOTE the safe code is 4417" }) });
  assert.ok(await box.idle(ivo.id));
  const looked = (from: string) =>
    waitFor(() => box.model.state.calls.find((call) => call.includes(from) && call.includes('"role":"tool"')));

  assert.equal(await box.deliver("ivo", "stranger@elsewhere.org", "LOOK-IT-UP from-stranger"), 202);
  const stranger = await looked("from-stranger");
  assert.ok(stranger, "the stranger's turn never looked anything up");
  assert.doesNotMatch(stranger, /4417/, "a stranger's mail read the owner's conversation");
  assert.match(stranger, /has not listed/);
  assert.ok(await box.idle(ivo.id));

  await box.h.json("/api/chat/email", { method: "PATCH", body: JSON.stringify({ allowFrom: ["boss@example.com"] }) });
  assert.equal(await box.deliver("ivo", "boss@example.com", "LOOK-IT-UP from-boss"), 202);
  const boss = await looked("from-boss");
  assert.match(boss ?? "", /4417/, "a listed sender's mail could not look back as before");
});

test("a mail is answered with what was said after it, never an earlier sender's reply", async (t) => {
  const box = await mailbox(t);
  const ivo = await box.agent("Ivo");
  assert.equal(await box.deliver("ivo", "first@elsewhere.org", "Hello there"), 202);
  assert.ok(await waitFor(() => box.relay.sent.some((mail) => mail.to === "first@elsewhere.org")), "the first mail was not answered");
  assert.ok(await box.idle(ivo.id));

  // the next turn answers with a card alone, so it says nothing to email;
  // the lane's last words are still the first sender's reply
  assert.equal(await box.deliver("ivo", "second@elsewhere.org", "ONLY-A-CARD please"), 202);
  assert.ok(await waitFor(() => box.model.state.calls.some((call) => call.includes("ONLY-A-CARD"))));
  assert.ok(await box.idle(ivo.id));
  await new Promise((r) => setTimeout(r, 500));
  assert.deepEqual(box.relay.sent.filter((mail) => mail.to === "second@elsewhere.org").map((mail) => mail.text), [], "the second sender was emailed the first one's reply");
});

test("the lane strangers' mail is answered in keeps to it when renamed, and takes nothing of the owner's", async (t) => {
  const box = await mailbox(t);
  const ivo = await box.agent("Ivo");
  assert.equal(await box.deliver("ivo", "first@elsewhere.org", "from-first"), 202);
  const lane = await waitFor(() => box.lane(ivo.id));
  assert.ok(lane, "the mail never reached its lane");
  assert.ok(await box.idle(ivo.id));

  // the person gives it a name of their own
  await box.h.fetch(`/api/bots/${ivo.id}/tasks/${lane.id}`, { method: "PATCH", body: JSON.stringify({ title: "Strangers" }) });
  assert.equal(await box.deliver("ivo", "second@elsewhere.org", "from-second"), 202);
  assert.ok(await waitFor(() => box.model.state.calls.some((call) => call.includes("from-second"))));
  assert.ok(await box.idle(ivo.id));
  const titles = async () => ((await box.h.json("/api/bots?messages=0")).bots.find((b: any) => b.id === ivo.id).tasks as any[]).map((task) => task.title);
  assert.ok(!(await titles()).includes("Unlisted email"), "a second lane was made for strangers' mail under the old title");
  const { messages } = await box.h.json(`/api/bots/${ivo.id}/messages?thread=${lane.id}&limit=50`);
  assert.ok(messages.some((m: any) => m.text?.includes("from-second")), "the second mail went elsewhere");

  // Open, it is still not where the owner's work lands when it names no
  // lane, and a routine naming it by its new title gets a lane of its own.
  await box.h.fetch(`/api/bots/${ivo.id}/tasks/${lane.id}/activate`, { method: "POST" });
  await box.h.fetch(`/api/bots/${ivo.id}/messages`, { method: "POST", body: JSON.stringify({ text: "OWNER-WORDS" }) });
  assert.ok(await box.idle(ivo.id));
  const after = (await box.h.json(`/api/bots/${ivo.id}/messages?thread=${lane.id}&limit=50`)).messages;
  assert.ok(!after.some((m: any) => m.text === "OWNER-WORDS"), "the owner's words ran beside strangers' mail");
  const { routine } = await box.h.json("/api/routines", {
    method: "POST",
    body: JSON.stringify({ targetId: ivo.id, targetKind: "agent", prompt: "ROUTINE-WORDS", time: "03:00", days: [], thread: "Strangers" }),
  });
  assert.equal((await box.h.fetch(`/api/routines/${routine.id}/run`, { method: "POST" })).status, 202);
  assert.ok(await waitFor(() => box.model.state.calls.some((call) => call.includes("ROUTINE-WORDS"))));
  assert.ok(await box.idle(ivo.id));
  const ran = (await box.h.json("/api/routines")).routines.find((r: any) => r.id === routine.id);
  assert.notEqual(ran.runs?.[0]?.threadId, lane.id, "a routine ran as the owner's in the lane strangers' mail is answered in");
});
