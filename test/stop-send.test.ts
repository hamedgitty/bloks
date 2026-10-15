import assert from "node:assert/strict";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { codexCommands, waitFor } from "./helpers/codex-commands.ts";

/** A real driver whose stand-in acknowledges steering but delays its exit
 * after SIGTERM. Stop's HTTP answer must not mean it can hear the follow-up. */
function delayedStop(root: string) {
  appendFileSync(join(root, "fake-codex.mjs"), `
import { writeFileSync as fixtureWrite } from "node:fs";
process.on("SIGTERM", () => {
  fixtureWrite(root + "/stop-requested", "");
  const timer = setInterval(() => {
    if (existsSync(root + "/stop-gate")) { clearInterval(timer); process.exit(0); }
  }, 10);
});
`);
}

test("a stop-and-send follow-up waits for the old process and starts once in its named lane", async t => {
  const s = await codexCommands(t);
  delayedStop(s.root);
  const created = await s.post(`/api/bots/${s.bot.id}/tasks`, { title: "Plans" });
  const lane = created.bot.threadId;
  assert.notEqual(lane, s.bot.threadId);
  s.spec({ hold: true, used: 0 });
  await s.say("HOLD the original task", { taskId: lane });
  await waitFor(() => s.calls().some(c => c.method === "turn/start"));
  try {
    const stopped = await s.post(`/api/bots/${s.bot.id}/interrupt`, { taskId: lane });
    assert.equal(stopped.ok, true);
    await waitFor(() => existsSync(join(s.root, "stop-requested")));
    s.spec({ hold: false, used: 0 });
    const sent = await s.say("Use the revised outline", { taskId: lane, steer: false });
    assert.equal(sent.queued, true, "it joined the dying turn instead of waiting");
    assert.equal(s.calls().filter(c => c.method === "turn/steer").length, 0);
    assert.equal(s.calls().filter(c => c.method === "turn/start").length, 1);
    writeFileSync(join(s.root, "stop-gate"), "");
    await waitFor(() => s.calls().filter(c => c.method === "turn/start").length === 2);
    await s.settled();
    const follow = (await s.messages(lane)).filter(m => m.role === "user" && m.text === "Use the revised outline");
    assert.equal(follow.length, 1);
    assert.notEqual(follow[0].midTurn, true);
    assert.equal(follow[0].queued, false);
    assert.equal((await s.messages()).filter(m => m.text === "Use the revised outline").length, 0);
    assert.equal(s.calls().filter(c => c.method === "turn/start").length, 2);
  } finally {
    writeFileSync(join(s.root, "stop-gate"), "");
  }
});

test("ordinary input still steers, and Stop alone starts no replacement turn", async t => {
  const s = await codexCommands(t);
  delayedStop(s.root);
  s.spec({ hold: true, used: 0 });
  await s.say("HOLD the original task");
  await waitFor(() => s.calls().some(c => c.method === "turn/start"));
  try {
    const sent = await s.say("Adjust the current task");
    assert.equal(sent.steered, true);
    assert.equal(s.calls().filter(c => c.method === "turn/steer").length, 1);
    assert.equal(s.calls().filter(c => c.method === "turn/start").length, 1);
    await s.post(`/api/bots/${s.bot.id}/interrupt`, { taskId: s.bot.threadId });
    await waitFor(() => existsSync(join(s.root, "stop-requested")));
    writeFileSync(join(s.root, "stop-gate"), "");
    await s.settled();
    assert.equal(s.calls().filter(c => c.method === "turn/start").length, 1);
  } finally {
    writeFileSync(join(s.root, "stop-gate"), "");
  }
});

test("a delayed answer to earlier steering cannot consume the stop-and-send follow-up", async t => {
  const s = await codexCommands(t);
  delayedStop(s.root);
  const cli = join(s.root, "fake-codex.mjs");
  const script = readFileSync(cli, "utf8");
  const marker = 'if(m.method==="turn/steer"){';
  assert.ok(script.includes(marker));
  writeFileSync(cli, script.replace(marker, marker + `
    await new Promise(resolve => {
      const timer = setInterval(() => {
        if (existsSync(root + "/steer-gate")) { clearInterval(timer); resolve(); }
      }, 10);
    });`));
  s.spec({ hold: true, used: 0 });
  await s.say("HOLD the original task");
  await waitFor(() => s.calls().some(c => c.method === "turn/start"));
  const earlier = s.say("Adjust the current task");
  try {
    await waitFor(() => s.calls().some(c => c.method === "turn/steer"));
    await s.post(`/api/bots/${s.bot.id}/interrupt`, { taskId: s.bot.threadId });
    await waitFor(() => existsSync(join(s.root, "stop-requested")));
    s.spec({ hold: false, used: 0 });
    const sent = await s.say("Start the replacement task", { steer: false });
    assert.equal(sent.queued, true);
    assert.equal(s.calls().filter(c => c.method === "turn/steer").length, 1);
    writeFileSync(join(s.root, "steer-gate"), "");
    assert.equal((await earlier).steered, true);
    assert.equal(s.calls().filter(c => c.method === "turn/start").length, 1);
    writeFileSync(join(s.root, "stop-gate"), "");
    await waitFor(() => s.calls().filter(c => c.method === "turn/start").length === 2);
    await s.settled();
    const follow = (await s.messages()).filter(m => m.role === "user" && m.text === "Start the replacement task");
    assert.equal(follow.length, 1);
    assert.notEqual(follow[0].midTurn, true);
    assert.equal(follow[0].queued, false);
  } finally {
    writeFileSync(join(s.root, "steer-gate"), "");
    writeFileSync(join(s.root, "stop-gate"), "");
    await earlier;
  }
});
