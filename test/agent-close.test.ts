// An agent closing its own conversation. It asks from inside its turn
// there, which is exactly what keeps the conversation busy, so the close
// waits for the turn to end rather than being refused.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startHarness } from "./helpers/server.ts";

test("an agent can close its own conversation, and it closes when the turn ends", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "bloks-close-"));
  const out = join(home, "said.json");
  const cli = join(home, "fake-claude.mjs");
  // a stand-in for Claude Code that, told CLOSE, runs `bloks close`'s request
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
  const asked = input.match(/CLOSE(?: (lane-[\\w-]+))?/);
  if (asked) {
    const auth = { authorization: "Bearer " + process.env.BLOKS_TOKEN, "content-type": "application/json" };
    const me = await (await fetch(process.env.BLOKS_URL + "/api/agent/whoami", { headers: auth })).json();
    const res = await fetch(process.env.BLOKS_URL + "/api/bots/" + me.botId + "/tasks/" + (asked[1] ? asked[1].slice(5) : me.taskId), { method: "DELETE", headers: auth });
    writeFileSync(${JSON.stringify(out)} + ".tmp", JSON.stringify({ status: res.status, body: await res.json(), taskId: me.taskId })); renameSync(${JSON.stringify(out)} + ".tmp", ${JSON.stringify(out)});
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

  const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Checker" }) });
  await h.fetch(`/api/bots/${bot.id}`, {
    method: "PATCH",
    body: JSON.stringify({ modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } }),
  });
  const general = bot.tasks[0].id;
  const checkIn = (await h.json(`/api/bots/${bot.id}/tasks`, { method: "POST", body: JSON.stringify({ title: "Check-in" }) })).bot
    .activeTaskId as string;
  const run = async (lane: string, target?: string) => {
    rmSync(out, { force: true });
    const text = target ? `CLOSE lane-${target}` : "CLOSE";
    await h.fetch(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text, taskId: lane }) });
    for (let i = 0; i < 200 && !existsSync(out); i++) await new Promise((r) => setTimeout(r, 50));
    return existsSync(out) ? (JSON.parse(readFileSync(out, "utf8")) as { status: number; body: any; taskId: string }) : undefined;
  };
  const lanes = async () => (await h.json("/api/bots")).bots.find((b: any) => b.id === bot.id).tasks.map((x: any) => x.id) as string[];

  const said = await run(checkIn);
  assert.ok(said, "the turn never ran");
  assert.equal(said.taskId, checkIn);
  assert.equal(said.status, 202, JSON.stringify(said.body));
  let gone = false;
  for (let i = 0; i < 200 && !gone; i++) {
    gone = !(await lanes()).includes(checkIn);
    if (!gone) await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(gone, "the conversation stayed open after its turn ended");

  // only the conversation it is in: naming another one is refused
  const other = (await h.json(`/api/bots/${bot.id}/tasks`, { method: "POST", body: JSON.stringify({ title: "Other" }) })).bot
    .activeTaskId as string;
  const reach = await run(general, other);
  assert.equal(reach?.status, 403, "an agent closed a conversation it was not in");
  assert.ok((await lanes()).includes(other));

  // General is cleared by the person, never closed by anyone
  const fromGeneral = await run(general);
  assert.equal(fromGeneral?.status, 409);
  assert.ok((await lanes()).includes(general));
});
