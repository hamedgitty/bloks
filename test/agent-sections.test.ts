// Agents filing agents into sidebar sections: at hire, and for teammates.
// A section is only a label, so another agent may set that and nothing
// else; every other field stays the agent's own, or the person's.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startHarness } from "./helpers/server.ts";

test("an agent can hire into a section and file a teammate, and change nothing else of theirs", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "bloks-sections-"));
  const out = join(home, "answers.json");
  const cli = join(home, "fake-claude.mjs");
  // Told CALLS <base64 json>, makes each request with its turn credential and
  // writes down what came back.
  writeFileSync(
    cli,
    `#!${process.execPath}
import { renameSync, writeFileSync } from "node:fs";
const [first] = process.argv.slice(2);
if (first === "--version") { console.log("9.9.9 (Claude Code)"); process.exit(0); }
if (first === "auth") { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", async () => {
  const asked = input.match(/CALLS ([A-Za-z0-9+\\/=]+)/);
  if (asked) {
    const calls = JSON.parse(Buffer.from(asked[1], "base64").toString("utf8"));
    const answers = [];
    for (const [method, path, body] of calls) {
      const res = await fetch(process.env.BLOKS_URL + path, {
        method,
        headers: { authorization: "Bearer " + process.env.BLOKS_TOKEN, "content-type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      answers.push({ status: res.status, body: await res.json().catch(() => null) });
    }
    writeFileSync(${JSON.stringify(out)} + ".tmp", JSON.stringify(answers)); renameSync(${JSON.stringify(out)} + ".tmp", ${JSON.stringify(out)});
  }
  console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "done" }));
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

  const { bot: manager } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Travel Manager" }) });
  await h.fetch(`/api/bots/${manager.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } }) });
  const { bot: teammate } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Lisbon" }) });

  const run = async (calls: unknown[]) => {
    rmSync(out, { force: true });
    await h.fetch(`/api/bots/${manager.id}/messages`, { method: "POST", body: JSON.stringify({ text: `CALLS ${Buffer.from(JSON.stringify(calls)).toString("base64")}` }) });
    for (let i = 0; i < 200 && !existsSync(out); i++) await new Promise((r) => setTimeout(r, 50));
    assert.ok(existsSync(out), "the turn never ran");
    return JSON.parse(readFileSync(out, "utf8")) as Array<{ status: number; body: any }>;
  };
  const idle = async () => {
    for (let i = 0; i < 200; i++) {
      const { bots } = await h.json("/api/bots");
      if (!bots.find((b: any) => b.id === manager.id).busy) return;
      await new Promise((r) => setTimeout(r, 50));
    }
  };

  const [hired, filed, tooMuch, mixed] = await run([
    ["POST", "/api/bots", { name: "Porto", section: "  travel  " }],
    ["PATCH", `/api/bots/${teammate.id}`, { section: "travel" }],
    ["PATCH", `/api/bots/${teammate.id}`, { name: "Renamed" }],
    ["PATCH", `/api/bots/${teammate.id}`, { section: "x", approvals: "full" }],
  ]);
  assert.ok(hired.status < 300, JSON.stringify(hired.body));
  assert.equal(hired.body.bot.section, "travel", "a hire was not filed into its section");
  assert.ok(filed.status < 300, JSON.stringify(filed.body));
  assert.equal(tooMuch.status, 403, "an agent renamed a teammate");
  assert.equal(mixed.status, 403, "a section rode along with a field that is not one");

  await idle();
  const { bots } = await h.json("/api/bots");
  const lisbon = bots.find((b: any) => b.id === teammate.id);
  assert.equal(lisbon.section, "travel");
  assert.equal(lisbon.name, "Lisbon");
  assert.notEqual(lisbon.approvals, "full");
});

// Pins and places (GitHub 156) go by the same rule as sections: an agent
// may say where a teammate, or a room it is in, sits in the sidebar, may
// read how the sidebar is arranged first, and may not touch the order of
// the headings, which is the person's.
test("an agent can pin and place teammates and its rooms, read the arrangement first, and nothing more", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "bloks-pins-"));
  const out = join(home, "answers.json");
  const cli = join(home, "fake-claude.mjs");
  // Told TURN <base64 json>, makes each raw request with its turn
  // credential, then runs each line of the real command line, and writes
  // down what came back from both.
  writeFileSync(
    cli,
    `#!${process.execPath}
import { renameSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const [first] = process.argv.slice(2);
if (first === "--version") { console.log("9.9.9 (Claude Code)"); process.exit(0); }
if (first === "auth") { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", async () => {
  const asked = input.match(/TURN ([A-Za-z0-9+\\/=]+)/);
  if (asked) {
    const { calls = [], lines = [] } = JSON.parse(Buffer.from(asked[1], "base64").toString("utf8"));
    const answers = [];
    for (const [method, path, body] of calls) {
      const res = await fetch(process.env.BLOKS_URL + path, {
        method,
        headers: { authorization: "Bearer " + process.env.BLOKS_TOKEN, "content-type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      answers.push({ status: res.status, body: await res.json().catch(() => null) });
    }
    for (const args of lines) {
      const run = spawnSync(process.execPath, [process.env.BLOKS_CLI, ...args], { encoding: "utf8", env: process.env });
      let body = null;
      try { body = JSON.parse(run.stdout); } catch { body = run.stdout + run.stderr; }
      answers.push({ status: run.status, body });
    }
    writeFileSync(${JSON.stringify(out)} + ".tmp", JSON.stringify(answers)); renameSync(${JSON.stringify(out)} + ".tmp", ${JSON.stringify(out)});
  }
  console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "done" }));
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

  const hire = async (name: string) => (await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name }) })).bot;
  const manager = await hire("Crew Lead");
  await h.fetch(`/api/bots/${manager.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } }) });
  const teammate = await hire("Deckhand");
  const outsiderA = await hire("Outsider A");
  const outsiderB = await hire("Outsider B");
  const open = async (name: string, memberIds: string[]) =>
    (await h.json("/api/bloks", { method: "POST", body: JSON.stringify({ name, memberIds }) })).blok;
  const crew = await open("Crew room", [manager.id, teammate.id]);
  const theirs = await open("Their room", [outsiderA.id, outsiderB.id]);

  const run = async (turn: { calls?: unknown[]; lines?: string[][] }) => {
    rmSync(out, { force: true });
    await h.fetch(`/api/bots/${manager.id}/messages`, { method: "POST", body: JSON.stringify({ text: `TURN ${Buffer.from(JSON.stringify(turn)).toString("base64")}` }) });
    for (let i = 0; i < 300 && !existsSync(out); i++) await new Promise((r) => setTimeout(r, 50));
    assert.ok(existsSync(out), "the turn never ran");
    return JSON.parse(readFileSync(out, "utf8")) as Array<{ status: number; body: any }>;
  };
  const idle = async () => {
    for (let i = 0; i < 200; i++) {
      const { bots } = await h.json("/api/bots?messages=0");
      if (!bots.find((b: any) => b.id === manager.id).busy) return;
      await new Promise((r) => setTimeout(r, 50));
    }
  };

  const [read, pinned, tooMuch, crewLoose, notTheirs, headings, hired, nowhere] = await run({
    calls: [
      ["GET", "/api/sidebar"],
      ["PATCH", `/api/bots/${teammate.id}`, { pinned: true, position: 1 }],
      ["PATCH", `/api/bots/${teammate.id}`, { pinned: true, title: "Captain" }],
      ["PATCH", `/api/bloks/${crew.id}`, { pinned: false }],
      ["PATCH", `/api/bloks/${theirs.id}`, { pinned: false }],
      ["PUT", "/api/sidebar/sections", { order: ["Crew"] }],
      ["POST", "/api/bots", { name: "Rigger", section: "Crew", pinned: true, position: 1 }],
      ["PATCH", `/api/bots/${teammate.id}`, { position: 0 }],
    ],
  });
  assert.equal(read.status, 200, "an agent could not read the arrangement");
  assert.ok(Array.isArray(read.body.sections));
  assert.equal(pinned.status, 200, JSON.stringify(pinned.body));
  assert.equal(tooMuch.status, 403, "a pin rode along with a field that is not one");
  assert.equal(crewLoose.status, 200, JSON.stringify(crewLoose.body));
  assert.equal(notTheirs.status, 403, "an agent changed a room it is not in");
  assert.equal(headings.status, 403, "an agent reordered the person's headings");
  assert.equal(hired.status, 201, JSON.stringify(hired.body));
  assert.deepEqual([hired.body.bot.section, hired.body.bot.pinned, hired.body.bot.pinOrder], ["Crew", true, 1]);
  assert.equal(hired.body.bot.activeWithYouAt, 0, "a hire by an agent counted as time with the person");
  assert.equal(nowhere.status, 400);
  await idle();
  const rigger = hired.body.bot.id;

  // the same, through the command line itself
  const lines = await run({
    lines: [
      ["pin", teammate.id, "--section", "Crew", "--at", "2"],
      ["file", crew.id, "Crew"],
      ["pin", crew.id, "--at", "1"],
      ["unpin", rigger],
      ["pin", theirs.id],
      ["pin", teammate.id, "--at", "first"],
      ["sidebar"],
    ],
  });
  const [deck, filed, crewPinned, loose, refused, typo, sidebar] = lines;
  assert.deepEqual([deck.status, deck.body.section, deck.body.pinned, deck.body.position], [0, "Crew", true, 2], JSON.stringify(deck.body));
  assert.deepEqual([filed.status, filed.body.kind, filed.body.section, filed.body.pinned], [0, "room", "Crew", false], JSON.stringify(filed.body));
  assert.deepEqual([crewPinned.status, crewPinned.body.position], [0, 1], JSON.stringify(crewPinned.body));
  assert.deepEqual([loose.status, loose.body.pinned], [0, false], JSON.stringify(loose.body));
  assert.equal(refused.status, 1, "the command line pinned a room its agent is not in");
  assert.match(refused.body.error, /rooms it is in/);
  assert.equal(typo.status, 1);
  assert.match(typo.body.error, /--at/);
  const crewSection = sidebar.body.find((s: any) => s.section === "Crew");
  assert.deepEqual(
    crewSection.pinned.map((p: any) => [p.name, p.position]),
    [
      ["Crew room", 1],
      ["Deckhand", 2],
    ],
  );
  assert.deepEqual(crewSection.others.map((o: any) => o.name), ["Rigger"]);
  await idle();

  // nothing else of the teammate's moved, and the headings are untouched
  const { bots } = await h.json("/api/bots?messages=0");
  const deckhand = bots.find((b: any) => b.id === teammate.id);
  assert.equal(deckhand.name, "Deckhand");
  assert.equal(deckhand.title, "");
  assert.equal((await h.json("/api/sidebar")).sectionOrderSaved, false);
});
