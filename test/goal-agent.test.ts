// A goal from the agent's side, on a stand-in Claude Code: `/goal` never
// reaches the engine, where a command of that name would run as one, the
// turns it starts arrive as notes, and the agent can read its goal with
// its credential but cannot set or change one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startHarness } from "./helpers/server.ts";
import { waitFor } from "./helpers/turns.ts";

test("a Claude Code agent is never sent /goal, reads its goal, and cannot set one", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "bloks-goal-agent-"));
  const frames = join(home, "frames.jsonl");
  const out = join(home, "tried.json");
  const cli = join(home, "fake-claude.mjs");
  // Every user frame it is sent is kept. Told READ-GOAL, it reads its goal
  // and then tries to change it, both with the turn's own credential. A
  // one-shot call (plain text out, where a turn streams JSON) is the
  // judge, and it says done.
  writeFileSync(
    cli,
    `#!${process.execPath}
import { appendFileSync, renameSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("9.9.9 (Claude Code)"); process.exit(0); }
if (args[0] === "auth") { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
if (args[args.indexOf("--output-format") + 1] === "text") {
  let asked = "";
  process.stdin.on("data", (c) => (asked += c));
  process.stdin.on("end", () => console.log(JSON.stringify({ status: "done", reason: "it read its goal" })));
} else {
  let line = "";
  const take = async (c) => {
    line += c;
    while (line.includes(String.fromCharCode(10))) {
      const at = line.indexOf(String.fromCharCode(10));
      const next = line.slice(0, at);
      line = line.slice(at + 1);
      if (!next.trim()) continue;
      const frame = JSON.parse(next);
      if (frame.type !== "user") continue;
      process.stdin.off("data", take);
      const content = frame.message?.content;
      const text = typeof content === "string" ? content : JSON.stringify(content);
      appendFileSync(${JSON.stringify(frames)}, JSON.stringify(text) + String.fromCharCode(10));
      if (text.includes("READ-GOAL")) {
        const auth = { authorization: "Bearer " + process.env.BLOKS_TOKEN, "content-type": "application/json" };
        const me = await (await fetch(process.env.BLOKS_URL + "/api/agent/whoami", { headers: auth })).json();
        const read = await fetch(process.env.BLOKS_URL + "/api/agent/goal", { headers: auth });
        const goalPath = process.env.BLOKS_URL + "/api/bots/" + me.botId + "/tasks/" + me.taskId + "/goal";
        const set = await fetch(goalPath, { method: "PUT", headers: auth, body: JSON.stringify({ text: "something else", check: "rm -rf /" }) });
        const pause = await fetch(goalPath, { method: "PATCH", headers: auth, body: JSON.stringify({ budget: 100 }) });
        writeFileSync(${JSON.stringify(out)} + ".tmp", JSON.stringify({ read: { status: read.status, body: await read.json() }, set: set.status, pause: pause.status }));
        renameSync(${JSON.stringify(out)} + ".tmp", ${JSON.stringify(out)});
      }
      console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Read it.\\nGoal: done" }] } }));
      console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Read it.\\nGoal: done" }));
      return;
    }
  };
  process.stdin.on("data", take);
}
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

  const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Juno" }) });
  await h.fetch(`/api/bots/${bot.id}`, {
    method: "PATCH",
    body: JSON.stringify({ modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } }),
  });
  const res = await h.fetch(`/api/bots/${bot.id}/messages`, {
    method: "POST",
    body: JSON.stringify({ text: "/goal READ-GOAL and report back\nturns: 4" }),
  });
  assert.equal(res.status, 202);
  assert.ok(await waitFor(() => existsSync(out)), `the agent's turn never ran: ${h.logs().slice(-800)}`);
  const tried = JSON.parse(readFileSync(out, "utf8"));

  assert.equal(tried.read.status, 200);
  assert.equal(tried.read.body.goal.text, "READ-GOAL and report back");
  assert.equal(tried.read.body.goal.status, "active");
  assert.equal(tried.read.body.goal.turn, 1);
  assert.equal(tried.read.body.goal.budget, 4);
  // reading is all: setting or changing a goal is the person's
  assert.equal(tried.set, 403);
  assert.equal(tried.pause, 403);

  const done = await waitFor(async () => {
    const lane = (await h.json("/api/bots")).bots.find((b: any) => b.id === bot.id).tasks[0];
    return lane.goal?.status === "done" ? lane.goal : null;
  });
  assert.ok(done, "the goal did not finish");
  assert.equal(done.text, "READ-GOAL and report back");
  assert.equal(done.budget, 4);

  const sent = readFileSync(frames, "utf8").trim().split("\n").map((l) => JSON.parse(l) as string);
  assert.equal(sent.length, 1);
  // the engine heard the goal as a note, never the command
  assert.ok(!sent.some((s) => s.includes("/goal")), `the engine was sent /goal: ${sent[0].slice(0, 200)}`);
  assert.match(sent[0], /not typed by the person/);
});
