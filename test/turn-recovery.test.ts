// A failed turn is asked again, then handed to the backup, without losing
// the session (GitHub 284). A fake Claude Code that keeps its sessions
// on disk and fails on cue, behind the real server: each test names a
// tag in its messages, and the CLI plays that tag's plan one call at a
// time ("ok", "fail", "refuse", "limit"), writing down which session
// each call was in and what it was told.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import { failureOf, isRefusal } from "../server/failover.ts";
import { startHarness, type Harness } from "./helpers/server.ts";

const WAIT_MS = 1_500;
const STAY_MS = 4_000;

const FAKE_CLAUDE = `#!${process.execPath}
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("9.9.9 (Claude Code)"); process.exit(0); }
if (args[0] === "auth") { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
const home = "__HOME__";
const read = (file, otherwise) => existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : otherwise;
const write = (file, value) => { writeFileSync(file + ".tmp", JSON.stringify(value)); renameSync(file + ".tmp", file); };
const value = (flag) => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
let input = "";
((go) => { let line = ""; const take = (c) => { line += c; while (line.includes(String.fromCharCode(10))) { const at = line.indexOf(String.fromCharCode(10)); const next = line.slice(0, at); line = line.slice(at + 1); if (!next.trim() || JSON.parse(next).type !== "user") continue; input = next; process.stdin.off("data", take); go(); return; } }; process.stdin.on("data", take); })(() => {
  const content = JSON.parse(input).message.content;
  const text = typeof content === "string" ? content : JSON.stringify(content);
  const tag = text.match(/\\[(t[\\w-]+)\\]/)?.[1] ?? "none";
  const resumed = args.includes("--resume");
  const session = value(resumed ? "--resume" : "--session-id");
  const plan = read(home + "/plan-" + tag + ".json", []);
  const outcome = plan.shift() ?? "ok";
  write(home + "/plan-" + tag + ".json", plan);
  const calls = read(home + "/calls-" + tag + ".json", []);
  calls.push({ session, resumed, text, outcome });
  write(home + "/calls-" + tag + ".json", calls);
  const out = (frame) => console.log(JSON.stringify(frame));
  out({ type: "system", subtype: "init", session_id: session, model: "claude-sonnet-5" });
  const result = (said, failed) => out({ type: "result", subtype: "success", is_error: failed, num_turns: 1, duration_api_ms: 1, total_cost_usd: 0, session_id: session, result: said });
  if (outcome === "fail") return result("Connection reset by peer while reading the response", true);
  if (outcome === "refuse") {
    const said = "API Error: Our safeguards flagged this message. This sometimes happens with safe, normal conversations. Try rephrasing the request in a new session or change your model.";
    out({ type: "assistant", session_id: session, message: { id: "m-" + calls.length, model: "<synthetic>", role: "assistant", content: [{ type: "text", text: said }], usage: { input_tokens: 0, output_tokens: 0 } } });
    return result(said, false);
  }
  if (outcome === "limit") {
    const said = "You've hit your session limit · resets 3:20pm (Asia/Yerevan)";
    out({ type: "assistant", error: "rate_limit", session_id: session, message: { id: "m-" + calls.length, model: "<synthetic>", role: "assistant", content: [{ type: "text", text: said }], usage: { input_tokens: 0, output_tokens: 0 } } });
    return result(said, true);
  }
  const said = "Claude answered " + tag + " " + calls.length;
  out({ type: "assistant", session_id: session, message: { id: "m-" + calls.length, model: "claude-sonnet-5", role: "assistant", content: [{ type: "text", text: said }], usage: { input_tokens: 1, output_tokens: 1 } } });
  result(said, false);
});
`;

interface Call {
  session: string;
  resumed: boolean;
  text: string;
  outcome: string;
}

/** A chat engine with a fixed answer, or a fixed failure. */
function fakeEngine(answer: (asked: string) => { status: number; body: unknown }): Promise<{ server: Server; url: string; asked: string[] }> {
  const asked: string[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.url?.endsWith("/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ data: [{ id: "m-1" }] }));
      }
      const messages = (() => {
        try {
          return JSON.parse(body).messages ?? [];
        } catch {
          return [];
        }
      })();
      const all = messages.map((m: any) => String(m.content ?? "")).join("\n\n");
      asked.push(all);
      const reply = answer(all);
      res.writeHead(reply.status, { "content-type": "application/json" });
      res.end(JSON.stringify(reply.body));
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${(server.address() as any).port}`, asked })),
  );
}

async function waitFor<T>(check: () => Promise<T | null | undefined | false>, timeoutMs = 20_000): Promise<T | null> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const result = await check();
    if (result) return result;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("what a failed turn is", () => {
  test("a safety refusal is told apart from an engine that is out and from the work", () => {
    assert.ok(isRefusal("API Error: Our safeguards flagged this message. Try rephrasing the request in a new session"));
    assert.ok(isRefusal("Claude Code is unable to respond to this request, which appears to violate our Usage Policy"));
    assert.ok(isRefusal("The provider declined this message (stop reason: refusal)."));
    assert.equal(failureOf("Our safeguards flagged this message"), "refusal");
    assert.equal(failureOf("You've hit your session limit · resets 3pm"), "out");
    assert.equal(failureOf("Connection reset by peer"), "other");
    assert.equal(failureOf("npm test failed: 3 tests"), "other");
    assert.ok(!isRefusal("I paused the sync because the API refused the token."));
  });
});

describe("a failed turn is asked again", () => {
  let h: Harness;
  let home: string;
  let spare: Awaited<ReturnType<typeof fakeEngine>>;
  let broken: Awaited<ReturnType<typeof fakeEngine>>;
  before(async () => {
    home = mkdtempSync(join(tmpdir(), "bloks-recovery-"));
    mkdirSync(join(home, ".bloks"), { recursive: true });
    const cli = join(home, "fake-claude.mjs");
    writeFileSync(cli, FAKE_CLAUDE.replaceAll("__HOME__", home), { mode: 0o755 });
    // a limit rests the whole engine, so the test that hits one has its own
    writeFileSync(
      join(home, ".bloks", "config.json"),
      JSON.stringify({
        instances: {
          claude: { driver: "claudeAgent", config: { cli, permissionMode: "bypassPermissions" } },
          "claude-limit": { driver: "claudeAgent", config: { cli, permissionMode: "bypassPermissions" } },
          "claude-b": { driver: "claudeAgent", config: { cli, permissionMode: "bypassPermissions" } },
        },
      }),
    );
    spare = await fakeEngine(() => ({
      status: 200,
      body: { choices: [{ message: { role: "assistant", content: "Done, from the spare." } }] },
    }));
    broken = await fakeEngine(() => ({ status: 500, body: { error: { message: "Internal boom on the spare" } } }));
    h = await startHarness({ HOME: home, BLOKS_RETRY_WAIT_MS: String(WAIT_MS), BLOKS_BACKUP_STAY_MS: String(STAY_MS) });
    await h.fetch("/api/providers/kimi/connect", { method: "POST", body: JSON.stringify({ key: "sk-test-3333333333", url: spare.url }) });
    await h.fetch("/api/providers/deepseek/connect", { method: "POST", body: JSON.stringify({ key: "sk-test-4444444444", url: broken.url }) });
  });
  after(async () => {
    await h.stop();
    spare.server.close();
    broken.server.close();
    rmSync(home, { recursive: true, force: true });
  });

  const plan = (tag: string, outcomes: string[]) => writeFileSync(join(home, `plan-${tag}.json`), JSON.stringify(outcomes));
  const calls = (tag: string): Call[] => {
    const file = join(home, `calls-${tag}.json`);
    return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
  };
  const agent = async (name: string, opts: { instanceId?: string; backup?: boolean | "broken" } = {}) => {
    const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name }) });
    const patched = await h.fetch(`/api/bots/${bot.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        modelSelection: { instanceId: opts.instanceId ?? "claude", model: "claude-sonnet-5" },
        ...(opts.backup ? { backupSelection: { instanceId: opts.backup === "broken" ? "deepseek" : "kimi", model: "m-1" } } : {}),
      }),
    });
    assert.equal(patched.status, 200);
    return bot.id as string;
  };
  const me = async (botId: string) => (await h.json("/api/bots")).bots.find((b: any) => b.id === botId);
  const say = async (botId: string, text: string) => {
    const res = await h.fetch(`/api/bots/${botId}/messages`, { method: "POST", body: JSON.stringify({ text }) });
    assert.ok(res.status < 300, `the message was refused: ${res.status}`);
  };
  /** Waits for the agent to be idle with `ready` true of its messages. */
  const settled = (botId: string, ready: (messages: any[]) => boolean, timeoutMs?: number) =>
    waitFor(async () => {
      const found = await me(botId);
      return !found.busy && ready(found.messages) ? found.messages : null;
    }, timeoutMs);
  // what an engine said, not the greeting a new agent opens with
  const answers = (messages: any[]) =>
    messages.filter((m) => m.role === "bot" && m.kind === "text" && /^(Claude answered|Done, from the spare)/.test(m.text ?? "")).map((m) => m.text);

  test("a safety refusal is asked again at once, in a new session told the conversation so far", async () => {
    const botId = await agent("Refused");
    plan("t1", ["ok", "refuse", "ok", "ok"]);
    await say(botId, "[t1] remember the word heron");
    assert.ok(await settled(botId, (m) => answers(m).length === 1));
    await say(botId, "[t1] now plan the trip");
    const messages = await settled(botId, (m) => answers(m).length === 2);
    assert.ok(messages, "the retry never answered");
    const [first, refused, retried] = calls("t1");
    assert.equal(refused.outcome, "refuse");
    assert.equal(refused.session, first.session, "the refused turn was in the conversation's session");
    assert.notEqual(retried.session, first.session, "the retry resumed the refused session");
    assert.equal(retried.resumed, false);
    assert.match(retried.text, /The conversation so far/, "the new session was not told the conversation");
    assert.match(retried.text, /remember the word heron/);
    assert.match(retried.text, /now plan the trip/);
    // told what failed, in the turn's own words
    assert.match(retried.text, /^\(A note from Bloks: an earlier attempt in this conversation failed at .+ on .+, saying: "API Error: Our safeguards flagged/);
    assert.match(retried.text, /started this new session/);
    const notice = messages.find((m: any) => m.kind === "notice" && /declined this message/.test(m.text));
    assert.ok(notice, "the chat does not say what happened");
    assert.match(notice.text, /Trying again in a new session/);
    // the next message goes on in the new session, never the refused one
    await say(botId, "[t1] and the hotel?");
    assert.ok(await settled(botId, (m) => answers(m).length === 3));
    const next = calls("t1")[3];
    assert.equal(next.resumed, true);
    assert.equal(next.session, retried.session);
  });

  test("a refusal in a session that was already new is not asked again in another", async () => {
    const botId = await agent("Refused twice");
    plan("t2", ["refuse"]);
    await say(botId, "[t2] first words");
    const messages = await settled(botId, (m) => m.some((x: any) => x.kind === "notice" && /safeguards/.test(x.text ?? "")));
    assert.ok(messages, "the refusal was not shown");
    await sleep(500);
    assert.equal(calls("t2").length, 1, "a refusal in a new session was asked again");
    assert.ok(!messages.some((m: any) => /Trying again/.test(m.text ?? "")));
  });

  test("anything else is asked again after the wait, in the same session, and the lane stays busy meanwhile", async () => {
    const botId = await agent("Flaky");
    plan("t3", ["ok", "fail", "ok", "ok"]);
    await say(botId, "[t3] hello");
    assert.ok(await settled(botId, (m) => answers(m).length === 1));
    await say(botId, "[t3] summarise the notes");
    const waiting = await waitFor(async () => {
      const found = await me(botId);
      return found.messages.some((m: any) => m.kind === "notice" && /Trying again in a minute/.test(m.text)) ? found : null;
    });
    assert.ok(waiting, "the wait was not said");
    assert.equal(waiting.busy, true, "the conversation is free while it waits");
    assert.match(waiting.messages.find((m: any) => /Trying again/.test(m.text ?? "")).text, /Connection reset by peer/);
    // said meanwhile, it waits its turn like any message behind a turn
    await say(botId, "[t3] also the dates");
    const mid = await me(botId);
    assert.ok(mid.messages.some((m: any) => m.text === "[t3] also the dates" && m.queued), "the new message did not queue");
    assert.equal(calls("t3").length, 2, "it was asked again before the wait");
    const messages = await settled(botId, (m) => answers(m).length === 3);
    assert.ok(messages, "the retry and the queued message never answered");
    const [first, failed, retried, queued] = calls("t3");
    assert.equal(failed.session, first.session);
    assert.equal(retried.resumed, true, "the retry did not resume the session");
    assert.equal(retried.session, first.session);
    assert.match(retried.text, /summarise the notes/);
    assert.doesNotMatch(retried.text, /The conversation so far/, "a resumed session was told the story");
    assert.match(retried.text, /^\(A note from Bloks: an earlier attempt in this conversation failed at .+, saying: "Connection reset by peer/);
    assert.match(retried.text, /asking again, in the same session/);
    assert.match(retried.text, /check what is already done before redoing anything/);
    assert.doesNotMatch(queued.text, /A note from Bloks/, "a turn after a good one was told of a failure");
    assert.match(queued.text, /also the dates/);
    // shown once, in the notice, not again as a raw error
    assert.equal(messages.filter((m: any) => /Connection reset/.test(m.text ?? "")).length, 1);
  });

  test("an engine out of usage is not asked again", async () => {
    const botId = await agent("Out", { instanceId: "claude-limit" });
    plan("t4", ["limit", "ok"]);
    await say(botId, "[t4] hello");
    const messages = await settled(botId, (m) => m.some((x: any) => x.kind === "notice"));
    assert.ok(messages);
    await sleep(WAIT_MS + 500);
    assert.equal(calls("t4").length, 1, "an engine that is out was asked again");
    assert.ok(messages.some((m: any) => /session limit/.test(m.text ?? "")), "the error is shown");
    assert.ok(!messages.some((m: any) => /Trying again/.test(m.text ?? "")));
  });

  test("Stop cancels a retry that is waiting", async () => {
    const botId = await agent("Stopped");
    plan("t5", ["fail", "ok"]);
    await say(botId, "[t5] hello");
    const waiting = await waitFor(async () => {
      const found = await me(botId);
      return found.busy && found.messages.some((m: any) => /Trying again/.test(m.text ?? "")) ? found : null;
    });
    assert.ok(waiting, "the retry was not waiting");
    const lane = waiting.tasks?.[0]?.id ?? waiting.threadId;
    const stopped = await h.fetch(`/api/bots/${botId}/interrupt`, { method: "POST", body: JSON.stringify({ taskId: lane }) });
    assert.equal(stopped.status, 200);
    const after = await settled(botId, (m) => m.some((x: any) => x.kind === "notice" && /Stopped/.test(x.text ?? "")), 5_000);
    assert.ok(after, "the lane did not come free with a word about it");
    await sleep(WAIT_MS + 500);
    assert.equal(calls("t5").length, 1, "the retry ran after Stop");
    // the next turn is told what failed, and that it was stopped
    await say(botId, "[t5] once more");
    assert.ok(await settled(botId, (m) => answers(m).length === 1));
    const next = calls("t5")[1];
    assert.match(next.text, /^\(A note from Bloks: .+Connection reset.+it was stopped/s);
  });

  test("when asking again fails, the backup takes the message once, with the conversation so far", async () => {
    const botId = await agent("Handed", { backup: true });
    plan("t7", ["ok", "fail", "fail"]);
    await say(botId, "[t7] the budget is forty");
    assert.ok(await settled(botId, (m) => answers(m).length === 1));
    await say(botId, "[t7] draft the email");
    const messages = await settled(botId, (m) => answers(m).includes("Done, from the spare."));
    assert.ok(messages, "the backup never answered");
    assert.equal(calls("t7").length, 3, "the own engine was asked more than once again");
    const heard = spare.asked.find((a) => a.includes("[t7] draft the email"));
    assert.ok(heard, "the backup was not given the message");
    assert.match(heard!, /the budget is forty/, "the backup was not told the conversation so far");
    assert.match(heard!, /A note from Bloks: an earlier attempt in this conversation failed .+Connection reset.+handed the message to/s);
    const notice = messages.find((m: any) => m.kind === "notice" && /is picking this up/.test(m.text));
    assert.ok(notice, "the chat does not say the backup took over");
    assert.match(notice.text, /failed again: Connection reset/);
    assert.equal(messages.filter((m: any) => m.role === "user" && m.text === "[t7] draft the email").length, 1);
  });

  test("with no backup the error shows, says where to set one, and the conversation needs the person", async () => {
    const botId = await agent("Alone");
    plan("t8", ["fail", "fail", "ok"]);
    await say(botId, "[t8] hello");
    const messages = await settled(botId, (m) => m.some((x: any) => /No backup engine/.test(x.text ?? "")));
    assert.ok(messages, "the agent did not stop with a word about it");
    assert.equal(calls("t8").length, 2);
    assert.ok(messages.some((m: any) => m.kind === "notice" && /^Connection reset/.test(m.text ?? "")), "the last error is not shown");
    assert.match(messages.find((m: any) => /No backup engine/.test(m.text)).text, /Backup engine/);
    const found = await me(botId);
    assert.equal(found.unread, true, "the conversation is not marked for the person");
    await sleep(WAIT_MS + 300);
    assert.equal(calls("t8").length, 2, "it went on after stopping");
    // the next message starts again, in the same session
    await say(botId, "[t8] again");
    assert.ok(await settled(botId, (m) => answers(m).length === 1));
    const [first, , next] = calls("t8");
    assert.equal(next.resumed, true);
    assert.equal(next.session, first.session);
  });

  test("a backup that fails too shows both errors", async () => {
    const botId = await agent("Both", { backup: "broken" });
    plan("t9", ["fail", "fail"]);
    await say(botId, "[t9] hello");
    const messages = await settled(botId, (m) => m.some((x: any) => /could not answer either/.test(x.text ?? "")));
    assert.ok(messages, "the agent did not stop with a word about it");
    assert.ok(broken.asked.some((a) => a.includes("[t9] hello")), "the backup was not asked");
    assert.ok(messages.some((m: any) => /Internal boom on the spare/.test(m.text ?? "")), "the backup's error is not shown");
    const last = messages.find((m: any) => /could not answer either/.test(m.text));
    assert.match(last.text, /Connection reset/, "the own engine's error is not shown");
    assert.equal(calls("t9").length, 2);
  });

  test("the conversation stays on the backup a while, then the own engine resumes its own session, told what it missed", async () => {
    const botId = await agent("Returning", { backup: true });
    plan("t10", ["ok", "fail", "fail", "ok"]);
    await say(botId, "[t10] the venue is the boathouse");
    assert.ok(await settled(botId, (m) => answers(m).length === 1));
    await say(botId, "[t10] book the caterer");
    assert.ok(await settled(botId, (m) => answers(m).length === 2), "the backup never answered");
    const handedAt = Date.now();
    // the next message stays on the backup
    await say(botId, "[t10] and the flowers");
    assert.ok(await settled(botId, (m) => answers(m).length === 3));
    assert.equal(calls("t10").length, 3, "the own engine was tried during the stay");
    assert.ok(spare.asked.some((a) => a.includes("[t10] and the flowers")));
    // after the stay, the own engine's own session, with only what it missed
    await sleep(Math.max(0, STAY_MS - (Date.now() - handedAt)) + 300);
    await say(botId, "[t10] what is left?");
    const messages = await settled(botId, (m) => answers(m).length === 4);
    assert.ok(messages, "the own engine never answered");
    const [first, , , back] = calls("t10");
    assert.equal(back.resumed, true, "the own engine started a new session");
    assert.equal(back.session, first.session);
    assert.doesNotMatch(back.text, /The conversation so far/);
    assert.doesNotMatch(back.text, /the venue is the boathouse/, "it was told what its session already has");
    assert.match(back.text, /answered in your place/);
    assert.match(back.text, /book the caterer/);
    assert.match(back.text, /and the flowers/);
    assert.match(back.text, /Done, from the spare/);
    assert.match(back.text, /what is left\?/);
    assert.match(back.text, /^\(A note from Bloks: an earlier attempt in this conversation failed/, "the first turn back was not told what failed");
    assert.ok(messages.some((m: any) => m.kind === "notice" && /is back on this conversation, in its own session/.test(m.text)));
  });

  test("the person changing the engine ends the stay", async () => {
    const botId = await agent("Switched", { backup: true });
    plan("t11", ["fail", "fail", "ok"]);
    await say(botId, "[t11] hello");
    assert.ok(await settled(botId, (m) => answers(m).includes("Done, from the spare.")));
    const patched = await h.fetch(`/api/bots/${botId}`, {
      method: "PATCH",
      body: JSON.stringify({ modelSelection: { instanceId: "claude-b", model: "claude-sonnet-5" } }),
    });
    assert.equal(patched.status, 200);
    await say(botId, "[t11] again");
    assert.ok(await settled(botId, (m) => answers(m).some((a) => /^Claude answered/.test(a))), "the stay outlived the person's choice");
    assert.equal(calls("t11").length, 3);
  });

  test("after a refusal the own engine comes back in a new session told the conversation", async () => {
    const botId = await agent("Refused back", { backup: true });
    plan("t12", ["ok", "refuse", "refuse", "ok"]);
    await say(botId, "[t12] the code word is lark");
    assert.ok(await settled(botId, (m) => answers(m).length === 1));
    await say(botId, "[t12] go on");
    assert.ok(await settled(botId, (m) => answers(m).includes("Done, from the spare.")), "the backup never answered");
    assert.equal(calls("t12").length, 3, "a refusal in a new session was asked again");
    await sleep(STAY_MS + 300);
    await say(botId, "[t12] next");
    assert.ok(await settled(botId, (m) => answers(m).length === 3));
    const [first, , retried, back] = calls("t12");
    assert.equal(back.resumed, false, "a refused session was resumed");
    assert.notEqual(back.session, first.session);
    assert.notEqual(back.session, retried.session);
    assert.match(back.text, /The conversation so far/);
    assert.match(back.text, /the code word is lark/);
  });

  test("a room's turn is not asked again or handed over", async () => {
    const botId = await agent("Roomie", { backup: true });
    const otherId = await agent("Bystander");
    const made = await h.json("/api/bloks", { method: "POST", body: JSON.stringify({ name: "Ops", memberIds: [botId, otherId] }) });
    const blok = made.blok ?? made;
    assert.ok(blok?.id, `the room was not made: ${JSON.stringify(made)}`);
    plan("t6", ["fail", "ok"]);
    await h.fetch(`/api/bloks/${blok.id}/messages`, { method: "POST", body: JSON.stringify({ text: "@Roomie [t6] status?" }) });
    assert.ok(await waitFor(async () => calls("t6").length >= 1 && !(await me(botId)).busy));
    await sleep(WAIT_MS + 500);
    assert.equal(calls("t6").length, 1, "a room's turn was asked again");
    const room = (await h.json(`/api/bloks/${blok.id}/messages?limit=50`)).messages as any[];
    assert.ok(!room.some((m) => /Trying again|picking this up/.test(m.text ?? "")));
    assert.ok(!spare.asked.some((a) => a.includes("[t6]")), "the backup answered in a room");
  });
});
