// What moves a row up the sidebar, decided on the server (GitHub 156): the
// person's own messages, replies to them, and anything asking something of
// them. An agent being messaged by another agent, or a routine waking it,
// must not, or a team that talks among itself all day reshuffles the list
// all day.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startHarness } from "./helpers/server.ts";

test("the person's messages and the replies to them move a row; agents among themselves and routines do not; a question does", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "bloks-with-you-"));
  const cli = join(home, "fake-claude.mjs");
  // A stand-in for Claude Code. Told TELL <id> <word>, it says the word to
  // that agent with its turn credential, as `bloks say` does; told
  // ROOMSAY <room>, it speaks in that room; told ASKME, it puts a decision
  // to the person. Then it answers "Done."
  writeFileSync(
    cli,
    `#!${process.execPath}
const [first] = process.argv.slice(2);
if (first === "--version") { console.log("9.9.9 (Claude Code)"); process.exit(0); }
if (first === "auth") { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", async () => {
  const call = (method, path, body) => fetch(process.env.BLOKS_URL + path, {
    method,
    headers: { authorization: "Bearer " + process.env.BLOKS_TOKEN, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const tell = input.match(/TELL ([\\w-]+) (\\w+)/);
  const roomSay = input.match(/ROOMSAY ([\\w-]+)/);
  if (tell) await call("POST", "/api/bots/" + tell[1] + "/messages", { text: tell[2] });
  else if (roomSay) await call("POST", "/api/bloks/" + roomSay[1] + "/messages", { text: "@Teammate notes for the room" });
  else if (input.includes("ASKME")) {
    const me = await (await call("GET", "/api/agent/whoami")).json();
    await call("POST", "/api/bots/" + me.botId + "/show", {
      kind: "decision",
      data: { question: "Which one?", options: [{ label: "This one" }, { label: "That one" }] },
    });
  }
  console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Done." }] } }));
  console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Done." }));
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

  const hire = async (name: string) => {
    const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name }) });
    await h.fetch(`/api/bots/${bot.id}`, {
      method: "PATCH",
      body: JSON.stringify({ modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } }),
    });
    return bot;
  };
  const manager = await hire("Manager");
  const teammate = await hire("Teammate");
  const scheduled = await hire("Scheduled");

  const agent = async (id: string) => (await h.json("/api/bots?messages=0")).bots.find((b: any) => b.id === id);
  const room = async (id: string) => (await h.json("/api/bloks")).bloks.find((b: any) => b.id === id);
  const said = async (id: string, lane?: string) =>
    (await h.json(`/api/bots/${id}/messages?limit=500${lane ? `&thread=${lane}` : ""}`)).messages as any[];
  const until = async <T,>(check: () => Promise<T | undefined | null | false>, what: string): Promise<T> => {
    for (let i = 0; i < 300; i++) {
      const found = await check();
      if (found) return found;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`never saw ${what}`);
  };
  const idle = (...ids: string[]) =>
    until(async () => {
      const { bots } = await h.json("/api/bots?messages=0");
      return ids.every((id) => !bots.find((b: any) => b.id === id).busy);
    }, "the agents settle");
  const tick = () => new Promise((r) => setTimeout(r, 20));

  // Made by the person, so each starts with the moment it was made.
  const start = {
    manager: (await agent(manager.id)).activeWithYouAt,
    teammate: (await agent(teammate.id)).activeWithYouAt,
    scheduled: (await agent(scheduled.id)).activeWithYouAt,
  };
  assert.ok(start.manager > 0 && start.teammate > 0, "an agent the person made had nothing with them");
  await tick();

  // The person writes to the manager, which passes a word on to its
  // teammate, which answers it.
  await h.fetch(`/api/bots/${manager.id}/messages`, { method: "POST", body: JSON.stringify({ text: `TELL ${teammate.id} hello` }) });
  await until(async () => (await said(teammate.id)).find((m) => m.role === "bot" && m.afterAgent), "the teammate answer");
  await idle(manager.id, teammate.id);
  const managerReply = (await said(manager.id)).filter((m) => m.role === "bot" && m.kind === "text").at(-1);
  assert.equal((await agent(manager.id)).activeWithYouAt, managerReply.at, "the reply to the person did not move the manager");
  assert.equal((await agent(teammate.id)).activeWithYouAt, start.teammate, "a message between agents moved the teammate");

  // A routine wakes the third, and its answer is to nobody in particular.
  const { routine } = await h.json("/api/routines", {
    method: "POST",
    body: JSON.stringify({ targetId: scheduled.id, targetKind: "agent", prompt: "the morning digest", time: "09:00", days: [1] }),
  });
  assert.equal((await h.fetch(`/api/routines/${routine.id}/run`, { method: "POST" })).status, 202);
  const lanes = await until(async () => {
    const tasks = (await agent(scheduled.id)).tasks as any[];
    const lane = tasks.find((x) => x.title === "Routines");
    return lane && (await said(scheduled.id, lane.id)).some((m) => m.role === "bot" && m.text === "Done.") ? lane : null;
  }, "the routine's answer");
  assert.ok(lanes);
  await idle(scheduled.id);
  assert.equal((await agent(scheduled.id)).activeWithYouAt, start.scheduled, "a routine moved its agent");

  // A question put to the person moves the teammate, though another agent
  // started the turn it was asked in.
  await tick();
  await h.fetch(`/api/bots/${manager.id}/messages`, { method: "POST", body: JSON.stringify({ text: `TELL ${teammate.id} ASKME` }) });
  const decision = await until(
    async () => (await said(teammate.id)).find((m) => m.kind === "component" && m.component?.kind === "decision"),
    "the decision",
  );
  await idle(manager.id, teammate.id);
  assert.equal((await agent(teammate.id)).activeWithYouAt, decision.at, "a question to the person did not move the row");

  // A room: the person's message and the members' answers to it move the
  // room; an agent speaking in it, and the answers to that, do not. An
  // agent's line wakes only who it names, so it names the teammate.
  const { blok } = await h.json("/api/bloks", {
    method: "POST",
    body: JSON.stringify({ name: "Crew", memberIds: [manager.id, teammate.id] }),
  });
  await tick();
  await h.fetch(`/api/bloks/${blok.id}/messages`, { method: "POST", body: JSON.stringify({ text: "morning, both" }) });
  const roomSaid = async () => (await h.json(`/api/bloks/${blok.id}/messages?limit=500`)).messages as any[];
  await until(async () => {
    const list = await roomSaid();
    return [manager.id, teammate.id].every((id) => list.some((m) => m.from === id && m.text === "Done."));
  }, "both members answer the person");
  await idle(manager.id, teammate.id);
  const answered = (await roomSaid()).filter((m) => m.from && m.text === "Done.").at(-1);
  const withRoom = (await room(blok.id)).activeWithYouAt;
  assert.equal(withRoom, answered.at, "the members' answers to the person did not move the room");

  await h.fetch(`/api/bots/${manager.id}/messages`, { method: "POST", body: JSON.stringify({ text: `ROOMSAY ${blok.id}` }) });
  await until(async () => {
    const list = await roomSaid();
    const at = list.findIndex((m) => m.text === "@Teammate notes for the room");
    return at >= 0 && list.slice(at).some((m) => m.from === teammate.id && m.text === "Done.");
  }, "the room answers an agent");
  await idle(manager.id, teammate.id);
  // the manager's own turn on the room line, once its solo turn is done
  await new Promise((r) => setTimeout(r, 500));
  await idle(manager.id, teammate.id);
  assert.equal((await room(blok.id)).activeWithYouAt, withRoom, "an agent speaking in a room moved it");
});
