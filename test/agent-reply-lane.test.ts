// A reply goes back to the conversation that asked, not to the sender's
// first one. An agent that hands work to another from a side tab should
// find the answer in that tab, and a message sent later in the same lane
// should keep going there. A tab that has been closed falls back to the
// first conversation, and says so.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { startHarness } from "./helpers/server.ts";

test("an agent's reply lands in the tab that asked, and a closed tab falls back with a word", async (t) => {
  // A stand-in for Claude Code. It answers two directives in the words it
  // is given: ASK <agent> writes PING to that agent, and PING <agent>
  // writes back. Every attempt is appended to one log, so the test can
  // read what the server said.
  const home = mkdtempSync(join(tmpdir(), "bloks-reply-lane-"));
  const log = join(home, "posts.ndjson");
  const cli = join(home, "fake-claude.mjs");
  writeFileSync(
    cli,
    `#!${process.execPath}
import { appendFileSync } from "node:fs";
const [first] = process.argv.slice(2);
if (first === "--version") { console.log("2.1.299 (Claude Code)"); process.exit(0); }
if (first === "auth") { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
let input = "";
process.stdin.on("data", (c) => (input += c));
((go) => { let line = ""; const take = (c) => { line += c; while (line.includes(String.fromCharCode(10))) { const at = line.indexOf(String.fromCharCode(10)); const next = line.slice(0, at); line = line.slice(at + 1); if (!next.trim() || JSON.parse(next).type !== "user") continue; input = next; process.stdin.off("data", take); go(); return; } }; process.stdin.on("data", take); })(async () => {
  const post = async (to, body) => {
    const res = await fetch(process.env.BLOKS_URL + "/api/bots/" + to + "/messages", {
      method: "POST",
      headers: { authorization: "Bearer " + process.env.BLOKS_TOKEN, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { to, status: res.status, body: await res.json() };
  };
  const me = await (await fetch(process.env.BLOKS_URL + "/api/agent/whoami", {
    headers: { authorization: "Bearer " + process.env.BLOKS_TOKEN },
  })).json();
  const ask = input.match(/ASK ([\\w-]+)/);
  if (ask) appendFileSync(${JSON.stringify(log)}, JSON.stringify(await post(ask[1], { text: "PING " + me.botId })) + String.fromCharCode(10));
  const ping = input.match(/PING ([\\w-]+)/);
  if (ping) appendFileSync(${JSON.stringify(log)}, JSON.stringify(await post(ping[1], { text: "pong from " + me.name })) + String.fromCharCode(10));
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
  const posts = () =>
    existsSync(log)
      ? readFileSync(log, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];
  const waitUntil = async (ok: () => boolean) => {
    for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 50));
    return posts();
  };
  const inLane = async (botId: string, lane: string, text: string) =>
    (await h.json(`/api/bots/${botId}/messages?thread=${lane}&limit=500`)).messages.some((m: any) => m.text === text);
  const idle = async (botId: string) => {
    for (let i = 0; i < 200; i++) {
      if (!(await h.json("/api/bots")).bots.find((b: any) => b.id === botId).busy) return;
      await new Promise((r) => setTimeout(r, 50));
    }
  };

  const sender = await hire("Planner");
  const recipient = await hire("Builder");
  const general = sender.tasks.find((x: any) => x.title === "General").id;

  // The person opens a side tab on the sender and asks it to hand work to
  // the recipient from there. The person's words name the lane, so the
  // sender's turn starts in it, and its message to the recipient is not a
  // reply: it goes to the recipient's General, as a new request should.
  const work = (
    await h.json(`/api/bots/${sender.id}/tasks`, { method: "POST", body: JSON.stringify({ title: "Invoice work" }) })
  ).bot.tasks.find((x: any) => x.title === "Invoice work").id;
  await h.json(`/api/bots/${sender.id}/messages`, {
    method: "POST",
    body: JSON.stringify({ text: `ASK ${recipient.id}`, taskId: work }),
  });

  let said = await waitUntil(() => posts().some((e: any) => e.status === 202 && e.to === recipient.id));
  const ask = said.find((e: any) => e.status === 202 && e.to === recipient.id);
  assert.ok(ask, "the sender's turn never ran");
  assert.equal(ask.body.taskId, recipient.threadId, `the request landed in ${ask.body.lane}`);

  // The recipient's turn was started by that message. Its reply is a
  // reply, and belongs in the sender's side tab, not its General.
  said = await waitUntil(() => posts().some((e: any) => e.to === sender.id));
  const reply = said.find((e: any) => e.to === sender.id);
  assert.ok(reply, "the recipient never answered");
  assert.equal(reply.status, 202, JSON.stringify(reply.body));
  assert.equal(reply.body.taskId, work, `the reply landed in ${reply.body.lane}`);
  assert.equal(await inLane(sender.id, work, "pong from Builder"), true);
  assert.equal(await inLane(sender.id, general, "pong from Builder"), false);

  // The person closes the side tab. The next message from the same lane
  // falls back to the first conversation and says the tab has gone.
  await idle(sender.id);
  await h.fetch(`/api/bots/${sender.id}/tasks/${work}`, { method: "DELETE" });
  const before = posts().filter((e: any) => e.to === sender.id).length;
  await h.json(`/api/bots/${recipient.id}/messages`, {
    method: "POST",
    body: JSON.stringify({ text: `PING ${sender.id}`, taskId: recipient.threadId }),
  });
  said = await waitUntil(() => posts().filter((e: any) => e.to === sender.id).length > before);
  const after = said.filter((e: any) => e.to === sender.id).at(-1);
  assert.ok(after, "the fallback message never went");
  assert.equal(after.status, 202, JSON.stringify(after.body));
  assert.equal(after.body.taskId, general, `the fallback landed in ${after.body.lane}`);
  assert.equal(after.body.laneClosed, true, "the receipt did not say the tab had gone");
});
