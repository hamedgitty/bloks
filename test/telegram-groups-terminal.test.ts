// An owner group turn may ask while live, but its reply capability does
// not extend the lifetime of the turn. Keep an accepted socket in this
// test process so the ended CLI's cleanup cannot make the late probe vanish.
import assert from "node:assert/strict";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createConnection } from "node:net";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { personFixture, until, SAM } from "./helpers/telegram-person.ts";

const GROUP = -7001;
const rows = (path: string): any[] => {
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf8").split("\n");
  lines.pop();
  return lines.filter(Boolean).map(line => JSON.parse(line));
};

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    if (process.platform !== "linux") return true;
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return !["Z", "X"].includes(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0]);
  } catch { return false; }
}

test("Claude owner-with-reply asks while active; old connections and callbacks have no authority after completion or over a replacement", async t => {
  const f = await personFixture(t, "claude");
  const events = () => rows(join(f.root, ".bloks", "events", `${f.bot.threadId}.ndjson`));
  const attemptsFile = join(f.root, "terminal-attempts.jsonl");
  const attempt = (kind: string, extra: object = {}) => appendFileSync(attemptsFile, JSON.stringify({ kind, ...extra }) + "\n");
  f.say("@PlanningBot ACTIVE_OWNER FAKE_TERMINAL", SAM, {
    chat: { id: GROUP, type: "supergroup", title: "Planning group" },
    entities: [{ type: "mention", offset: 0, length: 12 }],
  });
  const active = await until(() => f.records().find(row => row.text?.includes("ACTIVE_OWNER")), "owner group engine did not start");
  const socketRecord = await until(() => f.records().find(row => row.terminalSocket), "owner broker socket was not recorded");
  const ask = await until(() => f.records().find(row => row.activeOwnerAsk), "active owner permission did not resolve");
  assert.equal(active.person, false);
  assert.equal(active.groupOwner, true);
  assert.equal(ask.activeOwnerAsk.behavior, "allow", "a reply callback must not make the full-access owner a person");
  assert.equal(readFileSync(join(f.root, "active-effect"), "utf8"), "active owner allowed");
  const activeAsk = await until(() => events().find(event => event.type === "request.opened" && event.tool === "Bash"), "active ask did not reach the real event path");
  assert.ok(events().some(event => event.type === "request.resolved" && event.requestId === activeAsk.requestId && event.behavior === "allow"));
  assert.equal((await f.messages()).some(message => message.card?.title === "Approval needed"), false, "an owner full-access ask unexpectedly needed a person approval");

  // An invalid no-send reply proves the server accepted this exact socket.
  const old = createConnection(socketRecord.terminalSocket);
  const replies: any[] = [];
  const lines = createInterface({ input: old });
  lines.on("line", line => {
    const frame = JSON.parse(line); replies.push(frame);
    attempt("answer", { frame });
    if (String(frame.id).endsWith("-late-ask") && frame.behavior === "allow") writeFileSync(join(f.root, "late-effect"), "must never happen");
  });
  old.on("error", error => attempt("socket-error", { message: error.message }));
  t.after(async () => {
    lines.close();
    const closed = new Promise<void>(resolve => { if (old.destroyed) resolve(); else old.once("close", () => resolve()); });
    old.destroy(); await closed;
  });
  await new Promise<void>((resolve, reject) => { old.once("connect", resolve); old.once("error", reject); });
  old.write(JSON.stringify({ t: "reply", id: "accepted-connection", input: {} }) + "\n");
  assert.equal((await until(() => replies.find(reply => reply.id === "accepted-connection"), "old connection was never accepted")).behavior, "deny");
  writeFileSync(join(f.root, "finish-terminal"), "1");
  await f.idle();
  assert.equal(alive(active.pid), false, "the completed owner's CLI survived cleanup");
  const end = events().filter(event => event.type === "turn.completed");
  assert.equal(end.length, 1);
  assert.equal(end[0].ok, true);
  assert.equal(f.sent(GROUP).filter(call => call.body.text === "Hello Lee").length, 1);
  const oldTurnId = end[0].turnId;
  const originalCursor = JSON.parse(readFileSync(join(f.root, ".bloks", "bots.json"), "utf8"))
    .find((bot: any) => bot.id === f.bot.id).tasks.find((task: any) => task.id === f.bot.threadId).resumeCursors.claude;
  const baseline = events().filter(event => event.turnId === oldTurnId);
  const callback = async () => {
    attempt("stale-response-callback", { requestId: activeAsk.requestId });
    const response = await f.h.fetch(`/api/bots/${f.bot.id}/respond`, {
      method: "POST", body: JSON.stringify({ requestId: activeAsk.requestId, behavior: "allow" }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: false, outcome: "unavailable" }, "a completed request callback was delivered again");
  };
  const inject = async (label: string) => {
    for (const frame of [
      { t: "ask", id: `${label}-late-ask`, tool: "Bash", input: { command: "touch synthetic-late-marker" } },
      { t: "reply", id: `${label}-late-reply`, input: { text: "LATE_GROUP_REPLY" } },
    ]) {
      // Persist before write, including when the socket has already closed.
      attempt("old-connection-write", { label, frame });
      old.write(JSON.stringify(frame) + "\n");
    }
    await until(() => replies.find(reply => reply.id === `${label}-late-ask`) && replies.find(reply => reply.id === `${label}-late-reply`), "post-terminal frames did not reach the old broker callbacks");
    assert.equal(replies.find(reply => reply.id === `${label}-late-ask`).behavior, "deny");
    assert.equal(replies.find(reply => reply.id === `${label}-late-reply`).behavior, "deny");
    attempt("old-token-steer", { label });
    const steer = await f.h.fetch(`/api/bots/${f.bot.id}/messages`, {
      method: "POST", headers: { authorization: `Bearer ${active.token}` }, body: JSON.stringify({ text: "STALE_OWNER_STEER", delivery: "now" }),
    });
    assert.equal(steer.status, 401, "revoked owner credential was accepted");
    attempt("old-reply-callback", { label });
    const reply = await f.h.fetch(active.replyPath, {
      method: "POST", headers: { authorization: `Bearer ${active.replyToken}` }, body: JSON.stringify({ text: "STALE_REPLY_CALLBACK" }),
    });
    assert.equal(reply.status, 403);
    await callback();
  };
  await inject("after-terminal");
  assert.deepEqual(events().filter(event => event.turnId === oldTurnId), baseline, "late callbacks published new old-turn events");
  assert.equal(existsSync(join(f.root, "late-effect")), false);
  assert.equal((await f.messages()).some(message => /STALE_|LATE_GROUP_REPLY/.test(message.text ?? "")), false);
  assert.equal(f.sent(GROUP).some(call => /LATE_|STALE_/.test(call.body.text)), false);

  await f.post(`/api/bots/${f.bot.id}/messages`, { text: "REPLACEMENT_OWNER FAKE_HOLD" });
  const replacement = await until(() => f.records().find(row => row.text?.endsWith("REPLACEMENT_OWNER FAKE_HOLD")), "replacement did not start");
  assert.notEqual(replacement.pid, active.pid);
  assert.notEqual(replacement.token, active.token);
  assert.equal(replacement.args[replacement.args.indexOf("--resume") + 1], originalCursor);
  const replacementCursor = JSON.parse(readFileSync(join(f.root, ".bloks", "bots.json"), "utf8"))
    .find((bot: any) => bot.id === f.bot.id).tasks.find((task: any) => task.id === f.bot.threadId).resumeCursors.claude;
  await inject("during-replacement");
  assert.equal(alive(replacement.pid), true, "stale cleanup stopped the replacement");
  assert.equal(f.records().filter(row => typeof row.text === "string").length, 2, "a stale callback started an extra process");
  assert.equal(f.records().some(row => JSON.stringify(row.steered ?? "").includes("STALE_")), false);
  assert.equal(events().filter(event => event.turnId === oldTurnId && event.type === "turn.completed").length, 1);
  assert.deepEqual(events().filter(event => event.turnId === oldTurnId), baseline);
  assert.equal(events().filter(event => event.type === "request.opened").length, 1, "an old connection opened a new ask");
  writeFileSync(join(f.root, "release"), "1");
  await f.idle();
  assert.equal(alive(replacement.pid), false, "replacement process was not cleaned up");
  assert.equal(events().filter(event => event.type === "turn.completed").length, 2);
  assert.equal(f.records().find(row => row.text?.endsWith("REPLACEMENT_OWNER FAKE_HOLD"))?.groupOwner, false);
  assert.equal(f.sent(GROUP).filter(call => call.body.text === "Hello Lee").length, 1);
  assert.equal(existsSync(join(f.root, "late-effect")), false);
  const afterCursor = JSON.parse(readFileSync(join(f.root, ".bloks", "bots.json"), "utf8"))
    .find((bot: any) => bot.id === f.bot.id).tasks.find((task: any) => task.id === f.bot.threadId).resumeCursors.claude;
  assert.equal(afterCursor, replacementCursor, "old callbacks changed the replacement session");
  const attempts = rows(attemptsFile);
  assert.equal(attempts.filter(row => row.kind === "old-connection-write").length, 4, "the injected attempts were not recorded");
  assert.equal(attempts.filter(row => row.kind === "stale-response-callback").length, 2);
});
