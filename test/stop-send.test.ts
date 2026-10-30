import assert from "node:assert/strict";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { sendMessage } from "../src/lib/sendMessage.ts";
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

// GitHub 452: message A already waits when the person presses
// Command-Enter on draft B. B starts the next turn alone, then A, each once,
// whether the stopped turn ends at once or only after the request is done.
for (const quick of [true, false]) {
  test(`stop and send now starts the draft alone, ahead of what already waits (${quick ? "turn ends at once" : "turn ends later"})`, async t => {
    const s = await codexCommands(t);
    delayedStop(s.root);
    if (quick) writeFileSync(join(s.root, "stop-gate"), "");
    s.spec({ hold: true, used: 0 });
    await s.say("HOLD the original task");
    await waitFor(() => s.count("turn/start") === 1);
    try {
      const waiting = await s.say("A: the separate follow-up", { delivery: "wait" });
      assert.equal(waiting.queued, true);
      s.spec({ hold: false, used: 0 });
      // the composer's own path, against the real server
      const api = (path: string, init?: RequestInit) => s.post(path, JSON.parse(String(init?.body ?? "{}")));
      await sendMessage(api, { botId: s.bot.id, taskId: s.bot.threadId, text: "B: the revised plan", stopFirst: true });
      writeFileSync(join(s.root, "stop-gate"), "");
      const input = (n: number) => s.calls().filter(c => c.method === "turn/start")[n].params.input
        .filter((i: { type: string }) => i.type === "text").map((i: { text: string }) => i.text).join("");
      await waitFor(() => s.count("turn/start") >= 2);
      assert.match(input(1), /B: the revised plan/);
      assert.doesNotMatch(input(1), /A: the separate follow-up/, "A went in the turn meant for B");
      await waitFor(() => s.count("turn/start") >= 3);
      await s.settled();
      assert.match(input(2), /A: the separate follow-up/);
      assert.doesNotMatch(input(2), /B: the revised plan/);
      assert.equal(s.count("turn/start"), 3);
      const said = (await s.messages()).filter(m => m.role === "user" && /^[AB]: /.test(m.text ?? ""));
      assert.deepEqual(said.map(m => [m.text, m.queued]), [["B: the revised plan", false], ["A: the separate follow-up", false]]);
    } finally {
      writeFileSync(join(s.root, "stop-gate"), "");
    }
  });
}
