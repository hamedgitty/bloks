// GitHub 525: the registry in the request path. An agent's `bloks say`
// and `bloks tab` go wherever they went before, with no hierarchy and
// with one alone; once the owner turns on "Ask their lead before reaching
// across teams", a message from an agent with a lead to one outside its
// team is refused before anything is written, naming the lead to go
// through, while its lead, its team, a reply and a shared room still go.
// Only the owner sets any of it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startHarness } from "./helpers/server.ts";

const waitFor = async <T,>(check: () => Promise<T | null | undefined> | T | null | undefined, ms = 30_000): Promise<T | null> => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const value = await check();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
};

test("agents message as before until the owner has them ask their lead, and then go through it", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "bloks-registry-route-"));
  const answers = join(home, "answers.json");
  const heard = join(home, "heard.log");
  const cli = join(home, "fake-claude.mjs");
  // Told CALLS <base64 json>, makes each request with its turn credential.
  // Every turn's prompt is written down, with what it was told about the
  // room (the persona file, where the room's recent lines go).
  writeFileSync(
    cli,
    `#!${process.execPath}
import { appendFileSync, readFileSync, renameSync, writeFileSync } from "node:fs";
const [first] = process.argv.slice(2);
if (first === "--version") { console.log("2.1.299 (Claude Code)"); process.exit(0); }
if (first === "auth") { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
let input = "";
process.stdin.on("data", (c) => (input += c));
((go) => { let line = ""; const take = (c) => { line += c; while (line.includes(String.fromCharCode(10))) { const at = line.indexOf(String.fromCharCode(10)); const next = line.slice(0, at); line = line.slice(at + 1); if (!next.trim() || JSON.parse(next).type !== "user") continue; if (typeof input !== "undefined") input = next; process.stdin.off("data", take); go(); return; } }; process.stdin.on("data", take); })(async () => {
  const persona = process.argv.indexOf("--append-system-prompt-file");
  const told = persona > 0 ? readFileSync(process.argv[persona + 1], "utf8") : "";
  appendFileSync(${JSON.stringify(heard)}, told + input + "\\n----\\n");
  console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "s-" + Math.random().toString(36).slice(2), model: "claude-sonnet-5" }));
  const asked = input.match(/CALLS ([A-Za-z0-9+\\/=]+)/);
  if (asked) {
    const out = [];
    for (const [method, path, body] of JSON.parse(Buffer.from(asked[1], "base64").toString("utf8"))) {
      const res = await fetch(process.env.BLOKS_URL + path, {
        method,
        headers: { authorization: "Bearer " + process.env.BLOKS_TOKEN, "content-type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      out.push({ status: res.status, body: await res.json().catch(() => null) });
    }
    writeFileSync(${JSON.stringify(answers)} + ".tmp", JSON.stringify(out)); renameSync(${JSON.stringify(answers)} + ".tmp", ${JSON.stringify(answers)});
  }
  console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Done." }] } }));
  console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 1, duration_api_ms: 100, result: "Done." }));
});
`,
    { mode: 0o755 },
  );
  mkdirSync(join(home, ".bloks"), { recursive: true });
  writeFileSync(join(home, ".bloks", "config.json"), JSON.stringify({ instances: { claude: { driver: "claudeAgent", config: { cli } } } }));
  const h = await startHarness({ HOME: home });
  t.after(async () => {
    await h.stop();
    rmSync(home, { recursive: true, force: true });
  });

  const claude = { modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } };
  const make = async (name: string) => {
    const made = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name }) });
    assert.ok(made.bot?.id, JSON.stringify(made));
    const bot = made.bot;
    await h.fetch(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify(claude) });
    return bot;
  };
  const busy = async (id: string) => (await h.json("/api/bots?messages=0")).bots.find((b: any) => b.id === id)?.busy;
  const idle = (id: string) => waitFor(async () => ((await busy(id)) ? null : true));
  const as = async (botId: string, calls: unknown[]) => {
    rmSync(answers, { force: true });
    await idle(botId);
    await h.fetch(`/api/bots/${botId}/messages`, { method: "POST", body: JSON.stringify({ text: `CALLS ${Buffer.from(JSON.stringify(calls)).toString("base64")}` }) });
    assert.ok(await waitFor(() => existsSync(answers)), "the turn never ran");
    const out = JSON.parse(readFileSync(answers, "utf8")) as Array<{ status: number; body: any }>;
    await idle(botId);
    return out;
  };
  const prompts = () => (existsSync(heard) ? readFileSync(heard, "utf8").split("\n----\n") : []);
  const owner = (path: string, body: unknown) => h.fetch(path, { method: "PATCH", body: JSON.stringify(body) });
  const say = (to: string, text: string) => ["POST", `/api/bots/${to}/messages`, { text }];

  const worker = await make("Wren");
  const lead = await make("Lark");
  const other = await make("Otto");
  const otherLead = await make("Opal");

  // nothing set: the chart is empty, the switch off, and a message goes
  const empty = await h.json("/api/registry");
  assert.equal(empty.leadFirst, false);
  assert.ok(empty.agents.every((a: any) => a.lead === null));
  const [before] = await as(worker.id, [say(other.id, "Can you check the invoice totals?")]);
  assert.equal(before.status, 202, JSON.stringify(before.body));

  // the owner sets who reports to whom; a loop is refused
  assert.equal((await owner(`/api/registry/agents/${worker.id}`, { lead: lead.id, contactFor: "Front of house" })).status, 200);
  assert.equal((await owner(`/api/registry/agents/${other.id}`, { lead: otherLead.id, contactFor: "Billing questions" })).status, 200);
  const loop = await owner(`/api/registry/agents/${lead.id}`, { lead: worker.id });
  assert.equal(loop.status, 400);
  assert.match((await loop.json()).error, /is already under/);
  const set = await h.json("/api/registry");
  assert.equal(set.agents.find((a: any) => a.id === worker.id).lead, lead.id);
  assert.deepEqual(set.agents.find((a: any) => a.id === lead.id).reports, [worker.id]);

  // a hierarchy alone holds nothing, and an agent cannot change any of it
  const [alone, notYours, notYoursEither] = await as(worker.id, [
    say(other.id, "One more on the totals."),
    ["PATCH", "/api/registry", { leadFirst: false }],
    ["PATCH", `/api/registry/agents/${worker.id}`, { lead: null }],
  ]);
  assert.equal(alone.status, 202, JSON.stringify(alone.body));
  assert.equal(notYours.status, 403);
  assert.equal(notYoursEither.status, 403);
  assert.equal((await h.json("/api/registry")).agents.find((a: any) => a.id === worker.id).lead, lead.id);
  // and the placed agent is told its place
  assert.ok(prompts().some((p) => p.includes(`you report to Lark (${lead.id})`)), "the worker was never told who it reports to");

  // the owner turns the rule on
  assert.equal((await owner("/api/registry", { leadFirst: true })).status, 200);
  const [across, up, tab, chart, who] = await as(worker.id, [
    say(other.id, "Across the teams."),
    say(lead.id, "Otto owns billing; can you ask him about the totals?"),
    ["POST", "/api/agent/conversations", { to: other.id, text: "A new tab across the teams." }],
    ["GET", "/api/agent/registry"],
    ["GET", "/api/agent/registry/contacts?q=billing"],
  ]);
  assert.equal(across.status, 403, JSON.stringify(across.body));
  assert.match(across.body.error, /outside your team/);
  assert.ok(across.body.error.includes(`bloks say ${lead.id}`), across.body.error);
  assert.equal(up.status, 202, JSON.stringify(up.body));
  assert.equal(tab.status, 403, JSON.stringify(tab.body));
  assert.equal(chart.status, 200, JSON.stringify(chart.body));
  assert.equal(chart.body.leadFirst, true);
  assert.equal(chart.body.you?.lead, lead.id);
  assert.equal(who.status, 200);
  assert.equal(who.body.contacts?.[0]?.id, other.id, JSON.stringify(who.body));
  assert.deepEqual(who.body.contacts[0].route, { direct: false, via: lead.id, viaName: "Lark" });

  // nothing of the held message was written where Otto would read it
  const { messages } = await h.json(`/api/bots/${other.id}/messages`);
  assert.equal(messages.some((m: any) => m.text === "Across the teams." || m.text === "A new tab across the teams."), false);

  // the lead is at the top of its tree and has nobody to ask first
  const [fromLead] = await as(lead.id, [say(other.id, "Wren needs the invoice totals checked.")]);
  assert.equal(fromLead.status, 202, JSON.stringify(fromLead.body));

  // a room the owner put them in together is a way to talk
  const made = await h.json("/api/bloks", { method: "POST", body: JSON.stringify({ name: "Invoices", memberIds: [worker.id, other.id] }) });
  assert.ok(made.blok?.id ?? made.id, JSON.stringify(made));
  const [inRoom] = await as(worker.id, [say(other.id, "Following up from the room.")]);
  assert.equal(inRoom.status, 202, JSON.stringify(inRoom.body));

  // and switched off again, everything goes as before
  assert.equal((await owner("/api/registry", { leadFirst: false })).status, 200);
  const [after] = await as(worker.id, [say(otherLead.id, "Across again, with the rule off.")]);
  assert.equal(after.status, 202, JSON.stringify(after.body));
});
