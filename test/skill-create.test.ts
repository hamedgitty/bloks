// An agent asked to make a skill and use it (GitHub 455): `bloks skill
// create` sends the whole skill, its SKILL.md and the files beside it, and
// the person answers one card in the conversation that adds it to the
// library and gives it to the agent. Nothing is added before that, an id
// already in the library is never written over, the same request twice is
// one card, and the skill's files read back through the installed skill.
import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startHarness } from "./helpers/server.ts";
import { allows } from "../server/agent-cli.ts";

test("an agent asks for a skill with its files, the person adds it on one card, and the agent has it", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "bloks-skill-create-"));
  const out = join(home, "said.json");
  const cli = join(home, "fake-claude.mjs");
  // A stand-in for Claude Code that, told RUN <args>, runs the real
  // `bloks` with the turn's own credential and writes down its answer.
  writeFileSync(
    cli,
    `#!${process.execPath}
import { renameSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const [first] = process.argv.slice(2);
if (first === "--version") { console.log("2.1.299 (Claude Code)"); process.exit(0); }
if (first === "auth") { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
let input = "";
process.stdin.on("data", (c) => (input += c));
((go) => { let line = ""; const take = (c) => { line += c; while (line.includes(String.fromCharCode(10))) { const at = line.indexOf(String.fromCharCode(10)); const next = line.slice(0, at); line = line.slice(at + 1); if (!next.trim() || JSON.parse(next).type !== "user") continue; input = next; process.stdin.off("data", take); go(); return; } }; process.stdin.on("data", take); })(async () => {
  const asked = input.match(/RUN ([A-Za-z0-9+\\/=]+)/);
  if (asked) {
    const args = JSON.parse(Buffer.from(asked[1], "base64").toString("utf8"));
    const ran = spawnSync(process.execPath, [process.env.BLOKS_CLI, ...args], { env: process.env, encoding: "utf8", input: "" });
    writeFileSync(${JSON.stringify(out)} + ".tmp", ran.stdout || JSON.stringify({ error: ran.stderr })); renameSync(${JSON.stringify(out)} + ".tmp", ${JSON.stringify(out)});
  }
  console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "done" }));
});
`,
    { mode: 0o755 },
  );
  mkdirSync(join(home, ".bloks"), { recursive: true });
  writeFileSync(join(home, ".bloks", "config.json"), JSON.stringify({ instances: { claude: { driver: "claudeAgent", config: { cli } } } }));
  // the command waits this long for the answer before it says "waiting"
  const h = await startHarness({ HOME: home, BLOKS_SETTINGS_WAIT_MS: "300" });
  t.after(async () => {
    await h.stop();
    rmSync(home, { recursive: true, force: true });
  });

  const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Infrastructure" }) });
  await h.fetch(`/api/bots/${bot.id}`, {
    method: "PATCH",
    // a skill it already has, which must still be there afterwards
    body: JSON.stringify({ modelSelection: { instanceId: "claude", model: "claude-sonnet-5" }, skillIds: ["daily-brief"] }),
  });
  const lane = bot.threadId as string;

  const run = async (...args: string[]) => {
    rmSync(out, { force: true });
    await h.fetch(`/api/bots/${bot.id}/messages`, {
      method: "POST",
      body: JSON.stringify({ text: `RUN ${Buffer.from(JSON.stringify(args)).toString("base64")}` }),
    });
    for (let i = 0; i < 400 && !existsSync(out); i++) await new Promise((r) => setTimeout(r, 50));
    assert.ok(existsSync(out), `the turn never ran bloks ${args.join(" ")}`);
    const said = JSON.parse(readFileSync(out, "utf8"));
    // the next message starts a turn of its own once this one settles
    for (let i = 0; i < 200; i++) {
      const { bots } = await h.json("/api/bots");
      const me = bots.find((b: any) => b.id === bot.id);
      if (!me.busy && !me.tasks?.some((task: any) => task.settling)) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    return said;
  };
  const cards = async () =>
    ((await h.json(`/api/bots/${bot.id}/messages?thread=${lane}&limit=500`)).messages as any[]).filter((m) => m.card?.skillRequest);
  const library = async () => (await h.json("/api/skills")).skills as any[];

  // A folder made the way another tool makes a skill: a SKILL.md whose
  // name is the slug and whose title is what people read, a reference
  // and a helper script beside it.
  const folder = join(home, "work", "stremio");
  mkdirSync(join(folder, "references"), { recursive: true });
  mkdirSync(join(folder, "scripts"), { recursive: true });
  writeFileSync(
    join(folder, "SKILL.md"),
    "---\nname: stremio-rest\ndescription: Talk to the Stremio add-on API: search, streams and the library\nmetadata:\n  title: Stremio REST\n---\n\n# Stremio REST\n\nUse this when asked about Stremio.\n\n1. For an endpoint's shape, read references/api.md.\n2. To call it, save scripts/helper.py and run it.\n",
  );
  writeFileSync(join(folder, "references", "api.md"), "# API\n\nGET /catalog/{type}/{id}.json lists a catalogue.\n");
  writeFileSync(join(folder, "scripts", "helper.py"), "#!/usr/bin/env python3\nprint('stremio')\n");
  // a hidden file and a tool's folder are not the skill's
  writeFileSync(join(folder, ".DS_Store"), "x");
  mkdirSync(join(folder, "__pycache__"));
  writeFileSync(join(folder, "__pycache__", "helper.cpython.pyc"), "x");

  // Asked: a card, and nothing in the library yet.
  const asked = await run("skill", "create", "--from", folder, "--why", "You asked me to make it mine");
  assert.equal(asked.status, "waiting", JSON.stringify(asked));
  assert.equal(asked.skill, "stremio-rest");
  assert.match(asked.request, /^[\w-]{8,}$/);
  assert.ok(!(await library()).some((s) => s.id === "stremio-rest"), "nothing is added before the person says so");
  let shown = await cards();
  assert.equal(shown.length, 1);
  const plan = shown[0].card.skillRequest;
  assert.equal(plan.name, "Stremio REST", "the title people read, apart from the id");
  assert.equal(plan.skillId, "stremio-rest");
  assert.equal(plan.attach, true);
  assert.deepEqual(plan.files.map((f: any) => f.path), ["references/api.md", "scripts/helper.py"]);
  assert.equal(plan.why, "You asked me to make it mine");

  // The same request again, after an answer that never arrived: the
  // same card, not a second one.
  const again = await run("skill", "create", "--from", folder, "--why", "You asked me to make it mine");
  assert.equal(again.request, asked.request);
  assert.equal((await cards()).length, 1);

  // Only the person reviews and answers it; an agent's credential is
  // refused there, and the library's own install is still the person's.
  assert.equal(allows(bot.id, "POST", `/api/skill-requests/${lane}/${shown[0].id}/add`).ok, false);
  assert.equal(allows(bot.id, "GET", `/api/skill-requests/${lane}/${shown[0].id}`).ok, false);
  assert.equal(allows(bot.id, "POST", "/api/skills").ok, false);
  const review = await h.json(`/api/skill-requests/${lane}/${shown[0].id}`);
  assert.match(review.body, /Use this when asked about Stremio/);
  assert.deepEqual(review.files.map((f: any) => f.path), ["references/api.md", "scripts/helper.py"]);
  assert.match(review.files[0].text, /GET \/catalog/);

  const added = await h.json(`/api/skill-requests/${lane}/${shown[0].id}/add`, { method: "POST", body: "{}" });
  assert.equal(added.outcome, "added");
  const skill = (await library()).find((s) => s.id === "stremio-rest");
  assert.ok(skill, "in the library");
  assert.equal(skill.name, "Stremio REST");
  assert.deepEqual(skill.files.map((f: any) => f.path), ["references/api.md", "scripts/helper.py"]);
  const me = (await h.json("/api/bots")).bots.find((b: any) => b.id === bot.id);
  assert.deepEqual(me.skillIds, ["daily-brief", "stremio-rest"], "given to the agent, beside what it had");
  shown = await cards();
  assert.equal(shown[0].card.skillRequest.outcome, "added");
  assert.equal(shown[0].card.skillRequest.attached, true);
  // a second press is refused, not a second install
  assert.equal((await h.fetch(`/api/skill-requests/${lane}/${shown[0].id}/add`, { method: "POST", body: "{}" })).status, 409);

  // The agent hears how it went, and reads the skill and its files.
  const answer = await run("skill", "request", asked.request);
  assert.equal(answer.status, "added");
  assert.equal(answer.attached, true);
  assert.equal(answer.skill.id, "stremio-rest");
  const read = await run("skill", "stremio-rest");
  assert.deepEqual(read.skill.files.map((f: any) => f.path), ["references/api.md", "scripts/helper.py"]);
  const reference = await run("skill", "stremio-rest", "--file", "references/api.md");
  assert.match(reference.text, /GET \/catalog/);
  const saved = join(home, "work", "helper.py");
  const helper = await run("skill", "stremio-rest", "--file", "scripts/helper.py", "--save", saved);
  assert.equal(helper.saved, saved);
  assert.equal(readFileSync(saved, "utf8"), "#!/usr/bin/env python3\nprint('stremio')\n");
  assert.ok(statSync(saved).mode & 0o100, "a script stays runnable");
  const missing = await run("skill", "stremio-rest", "--file", "references/nope.md");
  assert.match(missing.error, /no file called references\/nope\.md.*references\/api\.md/);

  // Sent again once it is there: added already, no new card.
  const retried = await run("skill", "create", "--from", folder, "--why", "You asked me to make it mine");
  assert.equal(retried.status, "added");
  assert.equal(retried.already, true);
  assert.equal((await cards()).length, 1);

  // An id already in the library, with other words: never written over.
  writeFileSync(join(folder, "SKILL.md"), "---\nname: stremio-rest\ndescription: Something else\n---\n\nOther words.\n");
  const clash = await run("skill", "create", "--from", folder);
  assert.match(clash.error, /already a skill with the id stremio-rest: Stremio REST, version 1\. Nothing was changed/);
  assert.match(clash.error, /bloks skill revise stremio-rest/);
  const builtin = await run("skill", "create", "--file", join(folder, "SKILL.md"), "--id", "daily-brief", "--name", "Mine");
  assert.match(builtin.error, /already a built-in skill with the id daily-brief/);
  assert.equal((await library()).find((s) => s.id === "stremio-rest").description, "Talk to the Stremio add-on API: search, streams and the library");

  // Instructions past the limit are refused with the way out: files.
  writeFileSync(join(home, "long.md"), `---\nname: long-one\ndescription: Long\n---\n\n${"x".repeat(16_500)}\n`);
  const long = await run("skill", "create", "--file", join(home, "long.md"));
  assert.match(long.error, /16,500 characters; a skill's are at most 16,000.*supporting files/);

  // Not now: nothing added, and the agent is told.
  writeFileSync(join(home, "small.md"), "---\nname: tidy-notes\ndescription: Tidy a page of notes\n---\n\nSort the notes by date.\n");
  const second = await run("skill", "create", "--file", join(home, "small.md"), "--name", "Tidy notes", "--no-attach");
  assert.equal(second.status, "waiting");
  const secondCard = (await cards()).find((m) => m.card.skillRequest.id === second.request);
  assert.equal(secondCard.card.skillRequest.attach, false);
  await h.json(`/api/skill-requests/${lane}/${secondCard.id}/decline`, { method: "POST", body: "{}" });
  const declined = await run("skill", "request", second.request);
  assert.equal(declined.status, "declined");
  assert.ok(!(await library()).some((s) => s.id === "tidy-notes"));

  // A newer version of its own waiting request replaces the older card.
  writeFileSync(join(home, "v1.md"), "---\nname: garden-log\ndescription: Keep the garden log\n---\n\nVersion one.\n");
  writeFileSync(join(home, "v2.md"), "---\nname: garden-log\ndescription: Keep the garden log\n---\n\nVersion two.\n");
  const v1 = await run("skill", "create", "--file", join(home, "v1.md"), "--name", "Garden log");
  const v2 = await run("skill", "create", "--file", join(home, "v2.md"), "--name", "Garden log");
  assert.equal(v1.status, "waiting", JSON.stringify(v1));
  assert.equal(v2.status, "waiting", JSON.stringify(v2));
  assert.notEqual(v1.request, v2.request);
  const replaced = await run("skill", "request", v1.request);
  assert.equal(replaced.status, "replaced");
  assert.equal(replaced.replacedBy, v2.request);
  const live = (await cards()).filter((m) => m.card.skillRequest.skillId === "garden-log" && !m.card.skillRequest.outcome);
  assert.equal(live.length, 1);

  // The skill and its files go together.
  assert.equal((await h.fetch("/api/skills/stremio-rest", { method: "DELETE" })).status, 200);
  assert.equal(existsSync(join(home, ".bloks", "skill-files", "stremio-rest")), false);
});
