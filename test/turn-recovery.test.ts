// A failed turn is asked again, then handed to the backup, without losing
// the session (GitHub 284). A fake Claude Code that keeps its sessions
// on disk and fails on cue, behind the real server: each test names a
// tag in its messages, and the CLI plays that tag's plan one call at a
// time ("ok", "fail", "refuse", "limit"), writing down which session
// each call was in and what it was told.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import { failureOf, isRefusal } from "../server/failover.ts";
import { startHarness, type Harness } from "./helpers/server.ts";

const WAIT_MS = 1_500;
const STAY_MS = 4_000;
const SHARED_ROOM = "backup-shared-fixture";

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
((go) => { let line = ""; const take = (c) => { line += c; while (line.includes(String.fromCharCode(10))) { const at = line.indexOf(String.fromCharCode(10)); const next = line.slice(0, at); line = line.slice(at + 1); if (!next.trim() || JSON.parse(next).type !== "user") continue; input = next; process.stdin.off("data", take); go(); return; } }; process.stdin.on("data", take); })(async () => {
  const content = JSON.parse(input).message.content;
  const text = typeof content === "string" ? content : JSON.stringify(content);
  const tag = text.match(/\\[(t[\\w-]+)\\]/)?.[1] ?? "none";
  const resumed = args.includes("--resume");
  const session = value(resumed ? "--resume" : "--session-id");
  const plan = read(home + "/plan-" + tag + ".json", []);
  let outcome = plan.shift() ?? "ok";
  write(home + "/plan-" + tag + ".json", plan);
  let reset;
  if (outcome === "held") {
    write(home + "/waiting-" + tag + ".json", true);
    const release = home + "/release-" + tag + ".json";
    const deadline = Date.now() + 30_000;
    while (!existsSync(release) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    const next = read(release, { outcome: "ok" });
    outcome = next.outcome;
    reset = next.until;
  }
  const calls = read(home + "/calls-" + tag + ".json", []);
  const until = outcome === "rest" || outcome === "credit" ? reset ?? Math.ceil((Date.now() + 12_000) / 1000) * 1000 : undefined;
  calls.push({ session, resumed, text, outcome, model: value("--model"), until });
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
  if (outcome === "rest" || outcome === "credit") {
    const said = (outcome === "rest" ? "Usage limit reached|" : "Insufficient credits|") + until / 1000;
    out({ type: "assistant", error: "rate_limit", session_id: session, message: { id: "m-" + calls.length, model: "<synthetic>", role: "assistant", content: [{ type: "text", text: said }], usage: { input_tokens: 0, output_tokens: 0 } } });
    return result(said, true);
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
  model: string;
  until?: number;
}

/** A chat engine with a fixed answer, or a fixed failure. */
function fakeEngine(answer: (asked: string) => { status: number; body: unknown }): Promise<{ server: Server; url: string; asked: string[]; inputs: string[] }> {
  const asked: string[] = [];
  const inputs: string[] = [];
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
      inputs.push(String(messages.at(-1)?.content ?? ""));
      const reply = answer(all);
      res.writeHead(reply.status, { "content-type": "application/json" });
      res.end(JSON.stringify(reply.body));
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${(server.address() as any).port}`, asked, inputs })),
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
    // Saved shared-room fixture, with members attached through the API
    // before it is used. No relay, licence, people or channel is contacted.
    writeFileSync(join(home, ".bloks", "bloks.json"), JSON.stringify([{
      id: SHARED_ROOM, name: "Workshop", memberIds: [], createdAt: 1,
      sharing: { since: 0, history: "all", tools: "conversation", collaboratorsInvite: false, activityDetail: false, spendCap: 0 },
    }]));
    spare = await fakeEngine((asked) => asked.includes("[t-latest] trip backup quota")
      ? { status: 429, body: { error: { message: "Rate limit reached. Try again in 20m" } } }
      : { status: 200, body: { choices: [{ message: { role: "assistant", content: "Done, from the spare." } }] } });
    broken = await fakeEngine(() => ({ status: 500, body: { error: { message: "Internal boom on the spare" } } }));
    h = await startHarness({ HOME: home, BLOKS_RETRY_WAIT_MS: String(WAIT_MS), BLOKS_BACKUP_STAY_MS: String(STAY_MS) });
    await h.fetch("/api/providers/kimi/connect", { method: "POST", body: JSON.stringify({ key: "sk-test-3333333333", url: spare.url }) });
    await h.fetch("/api/providers/deepseek/connect", { method: "POST", body: JSON.stringify({ key: "sk-test-4444444444", url: broken.url }) });
  });
  after(async () => {
    try {
      await h?.stop();
    } finally {
      spare?.server.closeAllConnections();
      spare?.server.close();
      broken?.server.closeAllConnections();
      broken?.server.close();
      if (home) rmSync(home, { recursive: true, force: true });
    }
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


  // A rebuild holds dispatch after the chat notice, so an action while
  // preparation is pending can be checked against the actual input.
  const holdPreparation = async (botId: string, tag: string, whileHeld: () => Promise<void>) => {
    const file = join(home, ".bloks", "config.json");
    const config = JSON.parse(readFileSync(file, "utf8"));
    const gate = join(home, `release-version-${tag}`);
    const started = join(home, `asked-version-${tag}`);
    const slow = join(home, `slow-version-${tag}.cjs`);
    writeFileSync(slow, `#!${process.execPath}
const fs = require("node:fs");
if (process.argv[2] !== "--version") process.exit(1);
fs.writeFileSync(${JSON.stringify(started)}, "");
const until = Date.now() + 7000;
const tick = () => fs.existsSync(${JSON.stringify(gate)}) || Date.now() > until
  ? (console.log("9.9.9 (Claude Code)"), process.exit(0)) : setTimeout(tick, 25);
tick();
`, { mode: 0o755 });
    config.instances.slow = { driver: "claudeAgent", config: { cli: slow } };
    writeFileSync(file, JSON.stringify(config));
    const reload = () => h.fetch("/api/providers/kimi/connect", { method: "POST", body: JSON.stringify({ key: "sk-test-3333333333", url: spare.url }) });
    const rebuilding = reload();
    try {
      assert.ok(await waitFor(async () => existsSync(started)), "the rebuild did not reach the version gate");
      await say(botId, `[${tag}] held preparation`);
      assert.ok(await waitFor(async () => {
        const found = await me(botId);
        return found.busy && found.messages.some((m: any) => m.kind === "notice" && /is answering/.test(m.text ?? ""));
      }), "the switch explanation was not prepared before Stop");
      await whileHeld();
      writeFileSync(gate, "");
      assert.equal((await rebuilding).status, 200);
      assert.ok(await waitFor(async () => !(await me(botId)).busy), "the held preparation did not settle");
    } finally {
      writeFileSync(gate, "");
      await rebuilding;
      const next = JSON.parse(readFileSync(file, "utf8"));
      delete next.instances.slow;
      writeFileSync(file, JSON.stringify(next));
      await reload();
    }
  };

  const stopPreparation = async (botId: string, tag: string) => {
    await holdPreparation(botId, tag, async () => {
      const lane = (await me(botId)).activeTaskId;
      assert.equal((await h.fetch(`/api/bots/${botId}/interrupt`, { method: "POST", body: JSON.stringify({ taskId: lane }) })).status, 200);
    });
    assert.ok(await settled(botId, (m) => m.some((x: any) => /Stopped before/.test(x.text ?? ""))));
    assert.ok(!spare.inputs.some((text) => text.endsWith(`[${tag}] held preparation`)), "the stopped preparation reached the backup");
  };

  const allCalls = (): Call[] => readdirSync(home)
    .filter((file) => file.startsWith("calls-") && file.endsWith(".json"))
    .flatMap((file) => JSON.parse(readFileSync(join(home, file), "utf8")));
  const roomMessages = async (id: string): Promise<any[]> => (await h.json(`/api/bloks/${id}/messages?limit=200`)).messages;
  const makeRoom = async (name: string, memberIds: string[]) => {
    const made = await h.json("/api/bloks", { method: "POST", body: JSON.stringify({ name, memberIds }) });
    const room = made.blok ?? made;
    assert.ok(room?.id, "the fixture room was not created");
    return room.id as string;
  };
  const roomSay = async (botId: string, name: string, roomId: string, text: string) => {
    const count = (messages: any[]) => answers(messages.filter((m) => m.from === botId)).length;
    const before = count(await roomMessages(roomId));
    assert.ok((await h.fetch(`/api/bloks/${roomId}/messages`, { method: "POST", body: JSON.stringify({ text: `@${name} ${text}` }) })).status < 300);
    assert.ok(await waitFor(async () => count(await roomMessages(roomId)) === before + 1 && !(await me(botId)).busy), "the room turn did not answer");
  };

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


  test("another conversation's rest is explained on the first backup turn and first return only", async () => {
    const existing = await agent("Birch", { instanceId: "claude-b", backup: true });
    const quiet = await agent("Pine", { instanceId: "claude-b", backup: true });
    plan("t-rest-existing", ["ok", "ok", "ok"]);
    await say(existing, "[t-rest-existing] remember the blue folder");
    assert.ok(await settled(existing, (m) => answers(m).length === 1));
    assert.doesNotMatch(calls("t-rest-existing")[0].text, /A note from Bloks/);

    const trigger = await agent("Cedar", { instanceId: "claude-b", backup: true });
    plan("t-rest-trigger", ["rest"]);
    await say(trigger, "[t-rest-trigger] begin");
    assert.ok(await settled(trigger, (m) => answers(m).includes("Done, from the spare.")));
    const until = calls("t-rest-trigger")[0].until!;
    const failure = spare.inputs.find((text) => text.endsWith("[t-rest-trigger] begin"))!.split("\n")[0];
    assert.match(failure, /^\(A note from Bloks: an earlier attempt in this conversation failed.*Usage limit reached/);
    await say(trigger, "[t-rest-trigger] next backup turn");
    assert.ok(await settled(trigger, (m) => answers(m).length === 2));
    assert.doesNotMatch(spare.inputs.find((text) => text.endsWith("[t-rest-trigger] next backup turn"))!, /A note from Bloks/, "the fallback turn was forgotten when the next turn took the rest path");
    const fresh = await agent("Alder", { instanceId: "claude-b", backup: true });
    await stopPreparation(existing, "t-rest-existing");

    for (const [id, tag, oldAnswers] of [[existing, "t-rest-existing", 1], [fresh, "t-rest-fresh", 0]] as const) {
      await say(id, `[${tag}] first backup message`);
      assert.ok(await settled(id, (m) => answers(m).length === oldAnswers + 1));
      const heard = spare.inputs.find((text) => text.endsWith(`[${tag}] first backup message`))!;
      assert.ok(heard, "the actual backup input was not captured");
      const line = heard.split("\n")[0];
      assert.match(line, /^\(A note from Bloks: .*Claude.*was out of usage/);
      assert.match(line, /Kimi.*backup engine/);
      assert.ok(line.includes(new Date(until).toISOString()), "the known retry time was not given");
      assert.match(line, /first turn after/);
      assert.match(line, /returns to it automatically/);
      assert.equal(line.match(/\d{4}-\d\d-\d\dT[\d:.]+Z/g)?.length, 2, "the switch and rest end need absolute clock times");
      assert.doesNotMatch(line, /an earlier attempt in this conversation failed/, "another conversation's failure was claimed as this one's");
      await say(id, `[${tag}] second backup message`);
      assert.ok(await settled(id, (m) => answers(m).length === oldAnswers + 2));
      const next = spare.inputs.find((text) => text.endsWith(`[${tag}] second backup message`))!;
      assert.doesNotMatch(next, /A note from Bloks/, "the reason was added again during the same stay");
      const notices = (await me(id)).messages.filter((m: any) => m.kind === "notice" && /is answering/.test(m.text ?? ""));
      assert.equal(notices.length, 1, "the once-per-rest chat notice changed");
      assert.match(notices[0].text, /is out of usage for about .*minutes?, so .* is answering/);
    }
    assert.equal(calls("t-rest-existing").length, 1, "the resting engine was attempted");
    assert.equal(calls("t-rest-fresh").length, 0, "a new conversation attempted the resting engine");
    await sleep(Math.max(0, until - Date.now()) + 150);
    for (const [id, tag, oldAnswers] of [[existing, "t-rest-existing", 1], [fresh, "t-rest-fresh", 0]] as const) {
      await say(id, `[${tag}] first return`);
      assert.ok(await settled(id, (m) => answers(m).length === oldAnswers + 3));
      const back = calls(tag).at(-1)!;
      const first = spare.inputs.find((text) => text.endsWith(`[${tag}] first backup message`))!;
      assert.equal(back.text.split("\n")[0], first.split("\n")[0], "the return lost or recomputed the original reason");
      assert.doesNotMatch(back.text.split("\n")[0], /for about/, "the return used a relative rest duration");
      assert.equal(back.resumed, id === existing);
      const returnNotices = (await me(id)).messages.filter((m: any) => m.kind === "notice" && /is back on this conversation/.test(m.text ?? ""));
      assert.equal(returnNotices.length, id === existing ? 1 : 0, "the return changed the base's chat notice behavior");
      if (id === existing) {
        assert.equal(back.session, calls(tag)[0].session, "the own session was replaced");
        assert.match(back.text, /first backup message/);
        assert.match(back.text, /second backup message/);
        assert.doesNotMatch(back.text, /remember the blue folder/, "the old session was replayed what it already knew");
      } else {
        assert.match(back.text, /The conversation so far/, "a lane without an own cursor lost the base's fresh story");
        assert.doesNotMatch(back.text, /What was said since/, "a lane without an own cursor entered the session catch-up path");
      }
      await say(id, `[${tag}] ordinary return`);
      assert.ok(await settled(id, (m) => answers(m).length === oldAnswers + 4));
      assert.doesNotMatch(calls(tag).at(-1)!.text, /A note from Bloks/, "the reason was repeated after the first return");
    }
    await say(trigger, "[t-rest-trigger] first return");
    assert.ok(await settled(trigger, (m) => answers(m).length === 3));
    assert.equal(calls("t-rest-trigger").at(-1)!.text.split("\n")[0], failure, "a failure-started rest lost the original longer line on return");
    await say(quiet, "[t-rest-quiet] first turn after the rest");
    assert.ok(await settled(quiet, (m) => answers(m).length === 1));
    assert.doesNotMatch(calls("t-rest-quiet")[0].text, /A note from Bloks/, "a lane that never switched received a switch reason");
  });

  test("a missing engine is explained once, including after a stopped preparation", async () => {
    const botId = await agent("Maple", { instanceId: "claude-b", backup: true });
    plan("t-missing", ["ok", "ok", "ok"]);
    await say(botId, "[t-missing] remember the red folder");
    assert.ok(await settled(botId, (m) => answers(m).length === 1));
    const file = join(home, ".bloks", "config.json");
    const config = JSON.parse(readFileSync(file, "utf8"));
    const own = config.instances["claude-b"];
    delete config.instances["claude-b"];
    writeFileSync(file, JSON.stringify(config));
    const reload = () => h.fetch("/api/providers/kimi/connect", { method: "POST", body: JSON.stringify({ key: "sk-test-3333333333", url: spare.url }) });
    assert.equal((await reload()).status, 200);

    await stopPreparation(botId, "t-missing");

    await say(botId, "[t-missing] first backup message");
    assert.ok(await settled(botId, (m) => answers(m).length === 2));
    const heard = spare.inputs.find((text) => text.endsWith("[t-missing] first backup message"))!;
    const note = heard.split("\n")[0];
    assert.match(note, /^\(A note from Bloks: .*claude-b.*was not available/);
    assert.match(note, /Kimi.*backup engine/);
    assert.match(note, /checks for .* on each new turn/);
    assert.match(note, /returns to it automatically when it is available/);
    assert.doesNotMatch(note, /first turn after/, "a missing engine was given an invented reset time");
    await say(botId, "[t-missing] second backup message");
    assert.ok(await settled(botId, (m) => answers(m).length === 3));
    assert.doesNotMatch(spare.inputs.find((text) => text.endsWith("[t-missing] second backup message"))!, /A note from Bloks/);
    config.instances["claude-b"] = own;
    delete config.instances.slow;
    writeFileSync(file, JSON.stringify(config));
    assert.equal((await reload()).status, 200);
    writeFileSync(join(home, ".bloks", "workspaces", botId, "MEMORY.md"), "A yellow notebook is used for notes.");
    await say(botId, "[t-missing] first return");
    assert.ok(await settled(botId, (m) => answers(m).length === 4));
    assert.equal(calls("t-missing")[1].text.split("\n")[0], note);
    assert.match(calls("t-missing")[1].text, /A yellow notebook is used for notes/, "the standing update was dropped to keep the reason first");
    assert.equal(calls("t-missing")[1].session, calls("t-missing")[0].session);
    assert.equal(calls("t-missing")[1].resumed, true);
    await say(botId, "[t-missing] ordinary return");
    assert.ok(await settled(botId, (m) => answers(m).length === 5));
    assert.doesNotMatch(calls("t-missing").at(-1)!.text, /A note from Bloks/);
    delete config.instances["claude-b"];
    writeFileSync(file, JSON.stringify(config));
    assert.equal((await reload()).status, 200);
    await say(botId, "[t-missing] missing again");
    assert.ok(await settled(botId, (m) => answers(m).length === 6));
    const again = spare.inputs.find((text) => text.endsWith("[t-missing] missing again"))!.split("\n")[0];
    assert.match(again, /^\(A note from Bloks: .*was not available/);
    assert.notEqual(again, note, "the second missing stay did not get its own start time");
    await say(botId, "[t-missing] still missing again");
    assert.ok(await settled(botId, (m) => answers(m).length === 7));
    assert.doesNotMatch(spare.inputs.find((text) => text.endsWith("[t-missing] still missing again"))!, /A note from Bloks/);
    config.instances["claude-b"] = own;
    writeFileSync(file, JSON.stringify(config));
    assert.equal((await reload()).status, 200);
    await say(botId, "[t-missing] second return");
    assert.ok(await settled(botId, (m) => answers(m).length === 8));
    assert.equal(calls("t-missing").at(-1)!.text.split("\n")[0], again);
  });

  test("a backup model on the same engine retains the failure line and returns without replaying its own session", async () => {
    const botId = await agent("Willow");
    assert.equal((await h.fetch(`/api/bots/${botId}`, { method: "PATCH", body: JSON.stringify({ backupSelection: { instanceId: "claude", model: "claude-haiku-5" } }) })).status, 200);
    plan("t-model", ["ok", "fail", "fail", "ok", "ok", "ok", "ok"]);
    await say(botId, "[t-model] remember the green folder");
    assert.ok(await settled(botId, (m) => answers(m).length === 1));
    await say(botId, "[t-model] first backup message");
    assert.ok(await settled(botId, (m) => answers(m).length === 2));
    const firstBackup = calls("t-model")[3];
    const line = firstBackup.text.split("\n")[0];
    assert.match(line, /^\(A note from Bloks: an earlier attempt in this conversation failed at .*Connection reset by peer/);
    assert.match(line, /Bloks handed the message to/);
    assert.match(line, /check what is already done before redoing anything/);
    assert.equal(firstBackup.model, "claude-haiku-5");
    await say(botId, "[t-model] second backup message");
    assert.ok(await settled(botId, (m) => answers(m).length === 3));
    assert.doesNotMatch(calls("t-model")[4].text, /A note from Bloks/);
    await sleep(STAY_MS + 150);
    await say(botId, "[t-model] first return");
    assert.ok(await settled(botId, (m) => answers(m).length === 4));
    const back = calls("t-model")[5];
    assert.equal(back.model, "claude-sonnet-5");
    assert.equal(back.session, calls("t-model")[0].session);
    assert.equal(back.resumed, true);
    assert.equal(back.text.split("\n")[0], line, "the first return lost the unchanged failure line");
    assert.doesNotMatch(back.text, /What was said since/, "one engine was replayed words already in its session");
    assert.equal((await me(botId)).messages.filter((m: any) => m.kind === "notice" && /is back on this conversation/.test(m.text ?? "")).length, 0, "a model-only return added a notice absent from the base");
    await say(botId, "[t-model] ordinary return");
    assert.ok(await settled(botId, (m) => answers(m).length === 5));
    assert.doesNotMatch(calls("t-model")[6].text, /A note from Bloks/);
  });


  test("a native command before the return does not consume its reason", async () => {
    const botId = await agent("Elm", { instanceId: "claude-b", backup: true });
    plan("t-command", ["ok", "ok", "ok"]);
    await say(botId, "[t-command] remember the orange folder");
    assert.ok(await settled(botId, (m) => answers(m).length === 1));
    const file = join(home, ".bloks", "config.json");
    const config = JSON.parse(readFileSync(file, "utf8"));
    const own = config.instances["claude-b"];
    const reload = () => h.fetch("/api/providers/kimi/connect", { method: "POST", body: JSON.stringify({ key: "sk-test-3333333333", url: spare.url }) });
    delete config.instances["claude-b"];
    writeFileSync(file, JSON.stringify(config));
    assert.equal((await reload()).status, 200);
    await say(botId, "[t-command] backup message");
    assert.ok(await settled(botId, (m) => answers(m).length === 2));
    const reason = spare.inputs.find((text) => text.endsWith("[t-command] backup message"))!.split("\n")[0];
    config.instances["claude-b"] = own;
    writeFileSync(file, JSON.stringify(config));
    assert.equal((await reload()).status, 200);
    const before = calls("none").length;
    const ownBefore = calls("t-command").length;
    await say(botId, "/compact");
    assert.ok(await waitFor(async () => calls("none").length + calls("t-command").length === before + ownBefore + 1 && !(await me(botId)).busy));
    const command = calls("none").length > before ? calls("none")[before] : calls("t-command")[ownBefore];
    assert.equal(command.text, "/compact", "a command acquired a recovery or context preamble");
    await say(botId, "[t-command] first return");
    assert.ok(await waitFor(async () => calls("t-command").length === 2 && !(await me(botId)).busy));
    assert.equal(calls("t-command")[1].text.split("\n")[0], reason, "the command consumed the first ordinary turn's reason");
    assert.equal(calls("t-command")[1].session, calls("t-command")[0].session);
    await say(botId, "[t-command] ordinary return");
    assert.ok(await waitFor(async () => calls("t-command").length === 3 && !(await me(botId)).busy));
    assert.doesNotMatch(calls("t-command")[2].text, /A note from Bloks/);
  });

  test("a changed rest gives one update for its time or reason and returns with absolute facts", async () => {
    const botId = await agent("Hazel", { instanceId: "claude-b", backup: true });
    plan("t-updated", ["ok", "ok"]);
    await say(botId, "[t-updated] remember the white folder");
    assert.ok(await settled(botId, (m) => answers(m).length === 1));
    const held = ["t-extend", "t-credit"];
    const release = (tag: string, outcome: string, until?: number) => writeFileSync(join(home, `release-${tag}.json`), JSON.stringify({ outcome, until }));
    try {
      for (const tag of held) {
        const busy = await agent(tag === "t-extend" ? "Spruce" : "Holly", { instanceId: "claude-b" });
        plan(tag, ["held"]);
        await say(busy, `[${tag}] already running`);
        assert.ok(await waitFor(async () => existsSync(join(home, `waiting-${tag}.json`))), "the earlier own-engine turn did not start");
      }
      const trigger = await agent("Larch", { instanceId: "claude-b", backup: true });
      plan("t-update-trigger", ["rest"]);
      await say(trigger, "[t-update-trigger] begin");
      assert.ok(await settled(trigger, (m) => answers(m).length === 1));
      const firstUntil = calls("t-update-trigger")[0].until!;
      const ask = async (label: string, count: number) => {
        const text = `[t-updated] ${label}`;
        await say(botId, text);
        assert.ok(await settled(botId, (m) => answers(m).length === count));
        return spare.inputs.find((input) => input.endsWith(text))!;
      };
      const first = (await ask("first backup", 2)).split("\n")[0];
      const began = first.match(/\d{4}-\d\d-\d\dT[\d:.]+Z/)?.[0];
      assert.ok(began, "the backup start clock time is missing");
      assert.ok(first.includes(new Date(firstUntil).toISOString()));
      assert.doesNotMatch(await ask("same rest", 3), /A note from Bloks/);
      const until = firstUntil + 6_000;
      release("t-extend", "rest", until);
      assert.ok(await waitFor(async () => calls("t-extend").length === 1));
      assert.ok(await waitFor(async () => (await h.json("/api/bots")).bots.some((b: any) => b.name === "Spruce" && !b.busy)));
      const extended = (await ask("new reset", 4)).split("\n")[0];
      assert.match(extended, /^\(A note from Bloks: .*was out of usage/);
      assert.ok(extended.includes(new Date(until).toISOString()), "the changed reset time was not sent");
      assert.ok(extended.includes(began), "a rest update changed when the backup began");
      assert.doesNotMatch(await ask("same new reset", 5), /A note from Bloks/);
      release("t-credit", "credit", until);
      assert.ok(await waitFor(async () => calls("t-credit").length === 1));
      assert.ok(await waitFor(async () => (await h.json("/api/bots")).bots.some((b: any) => b.name === "Holly" && !b.busy)));
      const credited = (await ask("new reason", 6)).split("\n")[0];
      assert.match(credited, /^\(A note from Bloks: .*was out of credit/);
      assert.ok(credited.includes(new Date(until).toISOString()));
      assert.ok(credited.includes(began));
      assert.doesNotMatch(await ask("same new reason", 7), /A note from Bloks/);
      await sleep(Math.max(0, until - Date.now()) + 150);
      await say(botId, "[t-updated] first return");
      assert.ok(await settled(botId, (m) => answers(m).length === 8));
      const back = calls("t-updated")[1];
      assert.equal(back.text.split("\n")[0], credited, "the return lost the last corrected cause");
      assert.doesNotMatch(back.text.split("\n")[0], /for about/);
      assert.equal(back.session, calls("t-updated")[0].session);
    } finally {
      for (const tag of held) release(tag, "ok");
    }
  });

  test("changing the own engine or backup drops a stale switch reason", async () => {
    for (const change of ["own", "backup"] as const) {
      const botId = await agent(change === "own" ? "Rowan" : "Juniper", { instanceId: "claude-b", backup: true });
      const tag = `t-choice-${change}`;
      plan(tag, ["ok", "fail", "fail", "ok", "ok"]);
      await say(botId, `[${tag}] remember the silver folder`);
      assert.ok(await settled(botId, (m) => answers(m).length === 1));
      await say(botId, `[${tag}] backup message`);
      assert.ok(await settled(botId, (m) => answers(m).length === 2));
      const patch = change === "own"
        ? { modelSelection: { instanceId: "kimi", model: "m-1" } }
        : { backupSelection: { instanceId: "claude-b", model: "claude-sonnet-5" } };
      assert.equal((await h.fetch(`/api/bots/${botId}`, { method: "PATCH", body: JSON.stringify(patch) })).status, 200);
      await say(botId, `[${tag}] chosen engine`);
      assert.ok(await settled(botId, (m) => answers(m).length === 3));
      const chosen = change === "own"
        ? spare.inputs.find((input) => input.endsWith(`[${tag}] chosen engine`))!
        : calls(tag).at(-1)!.text;
      assert.doesNotMatch(chosen, /A note from Bloks/, "the person's engine choice received the pending automatic-return note");
      if (change === "own") {
        assert.equal((await h.fetch(`/api/bots/${botId}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "claude-b", model: "claude-sonnet-5" } }) })).status, 200);
        await say(botId, `[${tag}] chosen back`);
        assert.ok(await settled(botId, (m) => answers(m).length === 4));
        assert.doesNotMatch(calls(tag).at(-1)!.text, /A note from Bloks/, "the old reason survived two explicit choices");
      }
      assert.equal((await me(botId)).messages.filter((m: any) => m.kind === "notice" && /is back on this conversation/.test(m.text ?? "")).length, 1, "an explicit engine choice changed the base's return notice");
    }
  });

  test("the reason uses the engine choice at dispatch, after preparation", async () => {
    const botId = await agent("Beech", { instanceId: "claude-b", backup: true });
    const file = join(home, ".bloks", "config.json");
    const config = JSON.parse(readFileSync(file, "utf8"));
    const own = config.instances["claude-b"];
    delete config.instances["claude-b"];
    writeFileSync(file, JSON.stringify(config));
    assert.equal((await h.fetch("/api/providers/kimi/connect", { method: "POST", body: JSON.stringify({ key: "sk-test-3333333333", url: spare.url }) })).status, 200);
    try {
      await holdPreparation(botId, "t-dispatch-choice", async () => {
        assert.equal((await h.fetch(`/api/bots/${botId}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "kimi", model: "m-1" } }) })).status, 200);
      });
      assert.ok(await settled(botId, (m) => answers(m).length === 1));
      const heard = spare.inputs.find((input) => input.endsWith("[t-dispatch-choice] held preparation"))!;
      assert.ok(heard, "the held turn did not dispatch to the chosen engine");
      assert.doesNotMatch(heard, /A note from Bloks/, "a choice made during preparation received a stale switch reason");
    } finally {
      const next = JSON.parse(readFileSync(file, "utf8"));
      next.instances["claude-b"] = own;
      writeFileSync(file, JSON.stringify(next));
      assert.equal((await h.fetch("/api/providers/kimi/connect", { method: "POST", body: JSON.stringify({ key: "sk-test-3333333333", url: spare.url }) })).status, 200);
    }
  });

  test("rooms receive a separate reason for each agent and room, independently of solo turns", async () => {
    const first = await agent("Oak", { instanceId: "claude-b", backup: true });
    const second = await agent("Fir", { instanceId: "claude-b", backup: true });
    const trigger = await agent("Poplar", { instanceId: "claude-b", backup: true });
    const other = await agent("Yew");
    const roomOne = await makeRoom("Garden", [first, second, trigger]);
    const roomTwo = SHARED_ROOM;
    assert.equal((await h.fetch(`/api/bloks/${roomTwo}`, { method: "PATCH", body: JSON.stringify({ memberIds: [first, other] }) })).status, 200);
    plan("t-room-trigger", ["held"]);
    assert.ok((await h.fetch(`/api/bloks/${roomOne}/messages`, { method: "POST", body: JSON.stringify({ text: "@Poplar [t-room-trigger] begin" }) })).status < 300);
    assert.ok(await waitFor(async () => existsSync(join(home, "waiting-t-room-trigger.json"))));
    const until = Math.ceil((Date.now() + 20_000) / 1000) * 1000;
    writeFileSync(join(home, "release-t-room-trigger.json"), JSON.stringify({ outcome: "rest", until }));
    assert.ok(await waitFor(async () => calls("t-room-trigger").length === 1 && !(await me(trigger)).busy));
    await sleep(WAIT_MS + 300);
    assert.equal(calls("t-room-trigger").length, 1, "the room's failed turn was retried");
    assert.ok(!spare.inputs.some((input) => input.endsWith("[t-room-trigger] begin")), "the room's failed turn was handed over automatically");

    const lanes = [
      { id: first, name: "Oak", room: roomOne, tag: "t-room-a1" },
      { id: second, name: "Fir", room: roomOne, tag: "t-room-b1" },
      { id: first, name: "Oak", room: roomTwo, tag: "t-room-a2" },
      { id: first, name: "Oak", room: null, tag: "t-room-solo" },
      { id: trigger, name: "Poplar", room: roomOne, tag: "t-room-failed" },
    ];
    const ask = async (lane: typeof lanes[number], label: string) => {
      const text = `[${lane.tag}] ${label}`;
      if (lane.room) await roomSay(lane.id, lane.name, lane.room, text);
      else {
        const before = answers((await me(lane.id)).messages).length;
        await say(lane.id, text);
        assert.ok(await settled(lane.id, (m) => answers(m).length === before + 1));
      }
      return text;
    };
    const notes = new Map<string, string>();
    for (const lane of lanes) {
      const text = await ask(lane, "first backup");
      const heard = spare.inputs.find((input) => input.endsWith(text));
      assert.ok(heard, "the actual backup input was not captured");
      const note = heard.split("\n")[0];
      if (lane.id === trigger) {
        assert.match(note, /^\(A note from Bloks: an earlier attempt in this conversation failed.*Usage limit reached/, "the room lost its longer own-failure line");
      } else {
        assert.match(note, /^\(A note from Bloks: .*was out of usage/, "another room or solo lane consumed this lane's reason");
        assert.ok(note.includes(new Date(until).toISOString()));
        assert.match(note, /returns to it automatically/);
      }
      notes.set(lane.tag, note);
      const next = await ask(lane, "later backup");
      assert.doesNotMatch(spare.inputs.find((input) => input.endsWith(next))!, /A note from Bloks/, "the room repeated its reason during the stay");
    }
    await sleep(Math.max(0, until - Date.now()) + 150);
    for (const lane of lanes) {
      const text = await ask(lane, "first return");
      const back = allCalls().find((call) => call.text.endsWith(text));
      assert.ok(back, "the actual return input was not captured");
      assert.equal(back.text.split("\n")[0], notes.get(lane.tag), "the room lost its stored return cause");
      if (lane.room) assert.doesNotMatch(back.text, /What was said since/, "a room entered the solo catch-up path");
      const next = await ask(lane, "ordinary return");
      assert.doesNotMatch(allCalls().find((call) => call.text.endsWith(next))!.text, /A note from Bloks/, "the room return consumed another lane's state");
    }
    for (const id of [roomOne, roomTwo]) {
      assert.equal((await roomMessages(id)).filter((m) => m.kind === "notice" && /is back on this conversation/.test(m.text ?? "")).length, 0, "a room return added a chat notice absent from the base");
    }
    const shared = JSON.parse(readFileSync(join(home, ".bloks", "bloks.json"), "utf8")).find((room: any) => room.id === roomTwo);
    assert.ok(shared.lanes?.[first], "the shared-room case did not use its own lane");
    assert.notEqual(shared.lanes[first], (await me(first)).threadId, "the shared room borrowed the solo lane");
  });

  test("a room joining a solo backup stay gets its actual failure cause", async () => {
    const botId = await agent("Cypress", { instanceId: "claude", backup: true });
    const other = await agent("Chestnut");
    const room = await makeRoom("Studio", [botId, other]);
    plan("t-room-stay", ["ok", "fail", "fail", "ok", "ok"]);
    await say(botId, "[t-room-stay] remember the black folder");
    assert.ok(await settled(botId, (m) => answers(m).length === 1));
    await say(botId, "[t-room-stay] solo backup");
    assert.ok(await settled(botId, (m) => answers(m).length === 2));
    const failure = spare.inputs.find((input) => input.endsWith("[t-room-stay] solo backup"))!.split("\n")[0];
    assert.match(failure, /an earlier attempt in this conversation failed.*Connection reset by peer/);
    await roomSay(botId, "Cypress", room, "[t-room-stay] first room backup");
    assert.equal(spare.inputs.find((input) => input.endsWith("[t-room-stay] first room backup"))!.split("\n")[0], failure, "the room replaced the actual failure cause with a generic missing-engine reason");
    await roomSay(botId, "Cypress", room, "[t-room-stay] later room backup");
    assert.doesNotMatch(spare.inputs.find((input) => input.endsWith("[t-room-stay] later room backup"))!, /A note from Bloks/);
    await sleep(STAY_MS + 150);
    await roomSay(botId, "Cypress", room, "[t-room-stay] room return");
    assert.equal(allCalls().find((call) => call.text.endsWith("[t-room-stay] room return"))!.text.split("\n")[0], failure);
    await say(botId, "[t-room-stay] solo return");
    assert.ok(await settled(botId, (m) => answers(m).length === 3));
    assert.equal(allCalls().find((call) => call.text.endsWith("[t-room-stay] solo return"))!.text.split("\n")[0], failure, "the room consumed the solo return reason");
  });

  test("a stopped first backup preserves the existing return notice and catch-up without a reason", async () => {
    const botId = await agent("Willow", { instanceId: "claude-b", backup: true });
    plan("t-stop-return", ["ok", "ok"]);
    await say(botId, "[t-stop-return] seed own session");
    assert.ok(await settled(botId, (m) => answers(m).length === 1));
    const file = join(home, ".bloks", "config.json");
    const config = JSON.parse(readFileSync(file, "utf8"));
    const own = config.instances["claude-b"];
    delete config.instances["claude-b"];
    writeFileSync(file, JSON.stringify(config));
    const reload = () => h.fetch("/api/providers/kimi/connect", { method: "POST", body: JSON.stringify({ key: "sk-test-3333333333", url: spare.url }) });
    assert.equal((await reload()).status, 200);
    await stopPreparation(botId, "t-stop-return");
    config.instances["claude-b"] = own;
    writeFileSync(file, JSON.stringify(config));
    assert.equal((await reload()).status, 200);
    await say(botId, "[t-stop-return] first own turn after Stop");
    assert.ok(await settled(botId, (m) => answers(m).length === 2));
    const back = calls("t-stop-return")[1];
    assert.ok(back);
    assert.equal(back.session, calls("t-stop-return")[0].session);
    assert.equal(back.resumed, true);
    assert.equal(spare.inputs.filter((text) => text.includes("[t-stop-return]")).length, 0, "the stopped backup heard a turn");
    assert.doesNotMatch(back.text, /A note from Bloks/, "a lane that never dispatched to its backup received a switch reason");
    assert.match(back.text, /What was said since/, "stopped preparation changed the base's catch-up");
    assert.match(back.text, /\[t-stop-return\] held preparation/);
    assert.equal((await me(botId)).messages.filter((m: any) => m.kind === "notice" && /is back on this conversation/.test(m.text ?? "")).length, 1, "stopped preparation changed the base's return notice");
  });

  test("a newer backup failure wins over the original handover reason", async () => {
    const botId = await agent("Ash", { backup: true });
    plan("t-latest", ["ok", "fail", "fail", "ok", "ok"]);
    await say(botId, "[t-latest] remember the purple folder");
    assert.ok(await settled(botId, (m) => answers(m).length === 1));
    await say(botId, "[t-latest] backup message");
    assert.ok(await settled(botId, (m) => answers(m).length === 2));
    const first = spare.inputs.find((text) => text.endsWith("[t-latest] backup message"))!;
    assert.match(first.split("\n")[0], /Connection reset by peer/);
    await say(botId, "[t-latest] trip backup quota");
    assert.ok(await settled(botId, (m) => m.some((x: any) => /could not answer either|has stopped here/.test(x.text ?? ""))));
    await say(botId, "[t-latest] first return");
    assert.ok(await waitFor(async () => calls("t-latest").length === 4 && !(await me(botId)).busy));
    const line = calls("t-latest")[3].text.split("\n")[0];
    assert.match(line, /an earlier attempt in this conversation failed at .*Kimi.*Rate limit reached/);
    assert.doesNotMatch(line, /Connection reset by peer/, "the original failure hid the newer one");
    await say(botId, "[t-latest] ordinary return");
    assert.ok(await waitFor(async () => calls("t-latest").length === 5 && !(await me(botId)).busy));
    assert.doesNotMatch(calls("t-latest")[4].text, /A note from Bloks/);
  });
});
