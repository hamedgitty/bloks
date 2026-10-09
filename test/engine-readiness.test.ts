// Whether a teammate can answer, as another agent sees it (GitHub 239).
//
// The person saw "not signed in" or "out of usage" in the app; an agent
// asking `bloks agents` saw every teammate as fine, and `bloks say` to one
// that could not answer said ok and nothing more. Now the roster says
// whether each one's engine is ready, not signed in, out until a time, or
// unavailable, and `say` adds a warning when the one written to cannot
// answer. Nothing of the engine's own (a key, a path, its error) is said.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { outReason } from "../server/failover.ts";
import { startHarness } from "./helpers/server.ts";

const BLOKS = fileURLToPath(new URL("../bin/bloks.mjs", import.meta.url));

const waitFor = async <T,>(check: () => Promise<T | null | undefined> | T | null | undefined, ms = 20_000): Promise<T | null> => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const value = await check();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
};

/** A stand-in for Claude Code. Signed in or not by its own account; told
 * HOLD, it leaves its turn's credential in `token` and keeps the turn open
 * until `release` exists. Signed out, a turn fails the way the CLI does. */
const fakeClaude = (loggedIn: boolean, token: string, release: string) => `#!${process.execPath}
import { existsSync, writeFileSync } from "node:fs";
const [first] = process.argv.slice(2);
if (first === "--version") { console.log("9.9.9 (Claude Code)"); process.exit(0); }
if (first === "auth") { console.log(JSON.stringify({ loggedIn: ${loggedIn} })); process.exit(${loggedIn ? 0 : 1}); }
let input = "";
process.stdin.resume();
((go) => { let line = ""; const take = (c) => { line += c; while (line.includes(String.fromCharCode(10))) { const at = line.indexOf(String.fromCharCode(10)); const next = line.slice(0, at); line = line.slice(at + 1); if (!next.trim() || JSON.parse(next).type !== "user") continue; input = next; process.stdin.off("data", take); go(); return; } }; process.stdin.on("data", take); })(async () => {
  if (!${loggedIn}) {
    console.log(JSON.stringify({ type: "assistant", error: "authentication_failed", message: { content: [{ type: "text", text: "Not logged in. Please run /login" }] } }));
    console.log(JSON.stringify({ type: "result", subtype: "success", is_error: true, result: "Not logged in. Please run /login" }));
    return;
  }
  if (input.includes("HOLD")) {
    writeFileSync(${JSON.stringify(token)}, process.env.BLOKS_TOKEN ?? "");
    for (let i = 0; i < 1200 && !existsSync(${JSON.stringify(release)}); i++) await new Promise((r) => setTimeout(r, 50));
  }
  console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Done." }] } }));
  console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Done." }));
});
`;

/** A chat engine on this machine, answering whatever `reply` says now. */
async function chatEngine(reply: { status: number; body: unknown }) {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url?.endsWith("/models")) return res.end(JSON.stringify({ data: [{ id: "m-1" }] }));
      res.statusCode = reply.status;
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { server, reply, url: `http://127.0.0.1:${(server.address() as { port: number }).port}` };
}

test("an engine that says authentication is required is not signed in", () => {
  assert.equal(outReason("Authentication required"), "signedOut");
  assert.equal(outReason("Grok CLI could not answer: Authentication required"), "signedOut");
});

test("another agent reads whether a teammate's engine can answer, and hears it when one cannot", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "bloks-readiness-"));
  const token = join(home, "token");
  const release = join(home, "release");
  const signedIn = join(home, "claude-in.mjs");
  const signedOut = join(home, "claude-out.mjs");
  writeFileSync(signedIn, fakeClaude(true, token, release), { mode: 0o755 });
  writeFileSync(signedOut, fakeClaude(false, token, release), { mode: 0o755 });
  mkdirSync(join(home, ".bloks"), { recursive: true });
  writeFileSync(
    join(home, ".bloks", "config.json"),
    JSON.stringify({
      instances: {
        claude: { driver: "claudeAgent", config: { cli: signedIn } },
        "claude-locked": { driver: "claudeAgent", config: { cli: signedOut } },
        "claude-missing": { driver: "claudeAgent", config: { cli: join(home, "nowhere", "claude") } },
      },
    }),
  );
  const limited = await chatEngine({ status: 429, body: { error: { message: "Rate limit reached. Please try again in 20m" } } });
  const lapsed = await chatEngine({ status: 400, body: { error: { message: "Authentication required" } } });
  const h = await startHarness({ HOME: home });
  t.after(async () => {
    writeFileSync(release, "");
    await h.stop();
    for (const engine of [limited, lapsed]) {
      engine.server.closeAllConnections();
      engine.server.close();
    }
  });
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }));
  await h.fetch("/api/providers/deepseek/connect", { method: "POST", body: JSON.stringify({ key: "sk-test-limited-0000", url: limited.url }) });
  await h.fetch("/api/providers/kimi/connect", { method: "POST", body: JSON.stringify({ key: "sk-test-lapsed-0000", url: lapsed.url }) });

  const hire = async (name: string, instanceId: string, model: string, backup?: { instanceId: string; model: string }) => {
    const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name }) });
    const set = await h.fetch(`/api/bots/${bot.id}`, {
      method: "PATCH",
      body: JSON.stringify({ modelSelection: { instanceId, model }, ...(backup ? { backupSelection: backup } : {}) }),
    });
    assert.equal(set.status, 200, `${name}: ${await set.text()}`);
    return bot.id as string;
  };
  const holder = await hire("Holder", "claude", "claude-sonnet-5");
  const ready = await hire("Ready", "claude", "claude-sonnet-5");
  const locked = await hire("Locked", "claude-locked", "claude-sonnet-5");
  const missing = await hire("Missing", "claude-missing", "claude-sonnet-5");
  const resting = await hire("Resting", "deepseek", "m-1");
  const covered = await hire("Covered", "deepseek", "m-1", { instanceId: "claude", model: "claude-sonnet-5" });
  const refused = await hire("Refused", "kimi", "m-1");

  const settled = (botId: string, done: (messages: any[]) => boolean) =>
    waitFor(async () => {
      const me = (await h.json("/api/bots")).bots.find((b: any) => b.id === botId);
      return !me.busy && done(me.messages) ? me.messages : null;
    });
  // Two engines refuse a turn the person sends: one ran out, one's login lapsed.
  for (const botId of [resting, refused]) {
    await h.fetch(`/api/bots/${botId}/messages`, { method: "POST", body: JSON.stringify({ text: "Summarise the week" }) });
    assert.ok(await settled(botId, (m) => m.some((x: any) => x.kind === "notice")), "the refused turn never ended");
  }

  // an agent with a turn, and so a credential, to ask as
  await h.fetch(`/api/bots/${holder}/messages`, { method: "POST", body: JSON.stringify({ text: "HOLD" }) });
  const credential = await waitFor(() => (existsSync(token) ? readFileSync(token, "utf8") : null));
  assert.match(credential ?? "", /^blk_/, "the stand-in engine never got a credential");
  const bloks = (...args: string[]) =>
    new Promise<any>((resolve) => {
      execFile(process.execPath, [BLOKS, ...args], { env: { ...process.env, BLOKS_URL: h.url, BLOKS_TOKEN: credential! } }, (_e, stdout) =>
        resolve(JSON.parse(stdout || "{}")),
      );
    });

  const roster = async () => new Map(((await bloks("agents")) as any[]).map((a) => [a.id, a.engine]));
  const listed = await roster();
  assert.equal(listed.get(holder), "ready");
  assert.equal(listed.get(ready), "ready");
  assert.equal(listed.get(locked), "not signed in");
  assert.equal(listed.get(missing), "unavailable");
  assert.match(listed.get(resting) ?? "", /^out until \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  // its own engine is out, and its backup answers for it
  assert.equal(listed.get(covered), "ready");
  // what the issue saw: a login that lapsed, said only in the error
  assert.equal(listed.get(refused), "not signed in");

  // the same, as the route answers it, with nothing of the engines' own
  const raw = await fetch(`${h.url}/api/bots?messages=0`, { headers: { authorization: `Bearer ${credential}`, origin: h.url } });
  const engines = new Map(((await raw.json()).bots as any[]).map((b) => [b.id, b.engine]));
  assert.deepEqual(engines.get(locked), { state: "signedOut", name: "Claude" });
  assert.deepEqual(engines.get(missing), { state: "unavailable", name: "Claude" });
  assert.equal(engines.get(resting).state, "out");
  assert.equal(engines.get(resting).reason, "limit");
  assert.ok(engines.get(resting).until > Date.now() + 15 * 60_000, "it rests for the twenty minutes the engine said");
  const said = JSON.stringify([...engines.values()]);
  for (const secret of [home, "nowhere", "sk-test", "Rate limit reached", "Authentication required", "not found"]) {
    assert.ok(!said.includes(secret), `the roster gave away ${secret}`);
  }
  // the person's own app asks the engines itself
  assert.ok((await h.json("/api/bots?messages=0")).bots.every((b: any) => b.engine === undefined));

  // Saying something still goes, and says when nobody will answer it.
  const toReady = await bloks("say", ready, "a quick question");
  assert.equal(toReady.ok, true);
  assert.equal(toReady.engine, undefined, "a teammate who can answer was warned about");
  for (const [botId, warned] of [
    [locked, /Locked's engine, Claude, is not signed in, so Locked cannot answer this until the person signs it in/],
    [refused, /Refused's engine, Kimi, is not signed in/],
    [resting, /Resting's engine, DeepSeek, is out of usage until \d{4}-\d{2}-\d{2} \d{2}:\d{2}, so Resting cannot answer this before then/],
    [missing, /Missing's engine, Claude, is not available on this computer/],
  ] as const) {
    const sent = await bloks("say", botId, "status check");
    assert.equal(sent.ok, true, JSON.stringify(sent));
    assert.match(sent.engine ?? "", warned);
    assert.ok(!JSON.stringify(sent).includes(home), "a path reached the sender");
  }

  // A login that works again is believed the moment a turn answers.
  for (const botId of [ready, locked, missing, resting, refused]) await settled(botId, () => true);
  lapsed.reply.status = 200;
  lapsed.reply.body = { choices: [{ message: { role: "assistant", content: "Back again." } }] };
  await h.fetch(`/api/bots/${refused}/messages`, { method: "POST", body: JSON.stringify({ text: "Are you back?" }) });
  assert.ok(await settled(refused, (m) => m.some((x: any) => x.text === "Back again.")), "the engine never answered");
  assert.equal((await roster()).get(refused), "ready");
  assert.equal((await bloks("say", refused, "good")).engine, undefined);
});
