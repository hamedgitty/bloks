// Where one agent's message to another lands. It used to follow whichever
// conversation the person last opened on the recipient, so a person reading
// a side lane pulled agents' messages out of General and split the context.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startHarness } from "./helpers/server.ts";

test("an agent's message goes to the recipient's General, whatever the person has open", async (t) => {
  // A stand-in for Claude Code that, told PING <id>, says hello to that
  // agent with its own turn credential, the way `bloks say` does.
  const home = mkdtempSync(join(tmpdir(), "bloks-dm-"));
  const out = join(home, "said.json");
  const cli = join(home, "fake-claude.mjs");
  writeFileSync(
    cli,
    `#!${process.execPath}
import { writeFileSync } from "node:fs";
const [first] = process.argv.slice(2);
if (first === "--version") { console.log("9.9.9 (Claude Code)"); process.exit(0); }
if (first === "auth") { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", async () => {
  const ping = input.match(/PING ([\\w-]+)/);
  if (ping) {
    const res = await fetch(process.env.BLOKS_URL + "/api/bots/" + ping[1] + "/messages", {
      method: "POST",
      headers: { authorization: "Bearer " + process.env.BLOKS_TOKEN, "content-type": "application/json" },
      body: JSON.stringify({ text: "hello from the other agent" }),
    });
    writeFileSync(${JSON.stringify(out)}, JSON.stringify({ status: res.status, body: await res.json() }));
  }
  console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "done" }));
});
`,
    { mode: 0o755 },
  );
  mkdirSync(join(home, ".bloks"), { recursive: true });
  writeFileSync(
    join(home, ".bloks", "config.json"),
    JSON.stringify({ instances: { claude: { driver: "claudeAgent", config: { cli } } } }),
  );
  const h = await startHarness({ HOME: home });
  t.after(async () => {
    await h.stop();
    rmSync(home, { recursive: true, force: true });
  });

  const hire = async (name: string) => {
    const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name }) });
    await h.fetch(`/api/bots/${bot.id}`, {
      method: "PATCH",
      body: JSON.stringify({ modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } }),
    });
    return bot;
  };
  const sender = await hire("Sender");
  const recipient = await hire("Recipient");
  const general = recipient.tasks.find((x: any) => x.title === "General").id;

  // the person opens a side conversation on the recipient and reads it
  const side = (await h.json(`/api/bots/${recipient.id}/tasks`, { method: "POST", body: JSON.stringify({ title: "Rehearsal" }) })).bot
    .tasks.find((x: any) => x.title === "Rehearsal").id;
  await h.fetch(`/api/bots/${recipient.id}/tasks/${side}/activate`, { method: "POST" });

  const ping = async () => {
    rmSync(out, { force: true });
    await h.fetch(`/api/bots/${sender.id}/messages`, { method: "POST", body: JSON.stringify({ text: `PING ${recipient.id}` }) });
    for (let i = 0; i < 200; i++) {
      if (existsSync(out)) return JSON.parse(readFileSync(out, "utf8")) as { status: number; body: any };
      await new Promise((r) => setTimeout(r, 50));
    }
    return undefined;
  };
  let said = await ping();
  assert.ok(said, "the sender's turn never ran");
  assert.ok(said.status < 300, JSON.stringify(said));
  assert.equal(said.body.taskId, general, `landed in ${said.body.lane}`);

  const inLane = async (lane: string) =>
    (await h.json(`/api/bots/${recipient.id}/messages?thread=${lane}&limit=500`)).messages.some(
      (m: any) => m.text === "hello from the other agent",
    );
  assert.equal(await inLane(general), true);
  assert.equal(await inLane(side), false);

  // an agent renames its own conversation (`bloks rename`), as one renamed
  // General to "Team Leads": a lookup by title would miss it
  await h.fetch(`/api/bots/${recipient.id}/tasks/${general}`, { method: "PATCH", body: JSON.stringify({ title: "Team Leads" }) });
  // and a later lane takes the name, so the title now points elsewhere
  const impostor = (await h.json(`/api/bots/${recipient.id}/tasks`, { method: "POST", body: JSON.stringify({ title: "General" }) })).bot
    .activeTaskId as string;
  said = await ping();
  assert.ok(said, "the second turn never ran");
  assert.equal(said.body.taskId, general, `after the rename it landed in ${said.body.lane}`);

  // the person's own words still go to what they have open (the new lane)
  const mine = await h.json(`/api/bots/${recipient.id}/messages`, { method: "POST", body: JSON.stringify({ text: "and this is me" }) });
  assert.equal(mine.taskId, impostor);
});
