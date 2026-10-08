// Backup engines: which failures mean "out", when it is usable again,
// and the whole round trip through a real server.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import { isLimitNotice } from "../server/drivers/claude.ts";
import { Cooldowns, describeRest, outReason, resetAt, restUntil } from "../server/failover.ts";
import { startHarness, type Harness } from "./helpers/server.ts";

const MIN = 60_000;

describe("what counts as out", () => {
  test("limits, overload, credit and sign-in, in the words providers use", () => {
    assert.equal(outReason("Claude AI usage limit reached|1790400000"), "limit");
    assert.equal(outReason("You've hit your limit · resets 3pm (Europe/London)"), "limit");
    assert.equal(outReason("You've hit your session limit · resets 3:20pm (Asia/Yerevan)"), "limit");
    assert.equal(outReason("You’ve reached your Opus limit · resets Oct 9, 3pm"), "limit");
    assert.equal(outReason("Grok HTTP 429: Too Many Requests"), "limit");
    assert.equal(outReason("You exceeded your current quota, please check your plan and billing details."), "limit");
    assert.equal(outReason("RESOURCE_EXHAUSTED: Quota exceeded for quota metric"), "limit");
    assert.equal(outReason("API Error: 529 {\"type\":\"overloaded_error\"}"), "overloaded");
    assert.equal(outReason("Your credit balance is too low to access the Anthropic API."), "credit");
    assert.equal(outReason("Invalid API key · Please run /login"), "signedOut");
    assert.equal(outReason("OAuth token has expired. Please obtain a new token."), "signedOut");
  });

  test("Claude Code's limit notice is told apart from an agent talking about limits", () => {
    for (const notice of [
      "Claude AI usage limit reached|1790400000",
      "You've hit your limit · resets 3pm (Europe/Berlin)",
      "You’ve hit your usage limit · resets 11pm",
      "5-hour limit reached ∙ resets 3pm",
      "Weekly limit reached ∙ resets Oct 9, 3pm",
      "Opus weekly limit reached ∙ resets Oct 9, 3pm",
      "You've hit your session limit · resets 3:20pm (Asia/Yerevan)",
    ]) {
      assert.ok(isLimitNotice(notice), notice);
      assert.equal(outReason(notice), "limit", notice);
    }
    // a reply that mentions limits is the agent's reply, not the CLI
    assert.ok(!isLimitNotice("Rate limit reached on the GitHub API, so I paused the sync."));
    assert.ok(!isLimitNotice("The deploy failed: weekly limit reached on the build minutes."));
    assert.ok(!isLimitNotice(`Here is the summary.\nYou've hit your limit · resets 3pm`));
    assert.ok(!isLimitNotice(`You've hit your limit · resets 3pm ${"and more ".repeat(40)}`));
    assert.ok(!isLimitNotice(null));
  });

  test("a failure about the work is not the engine running out", () => {
    assert.equal(outReason("npm test failed: 3 failing"), null);
    assert.equal(outReason("The command was refused by a rule"), null);
    assert.equal(outReason("This conversation is longer than the model will take"), null);
    assert.equal(outReason(""), null);
    assert.equal(outReason(null), null);
  });
});

describe("when it is usable again", () => {
  const now = new Date(2026, 8, 26, 10, 0, 0).getTime();

  test("an epoch after a pipe, in seconds or milliseconds", () => {
    assert.equal(resetAt("Claude AI usage limit reached|1790600000", now), 1790600000_000);
    assert.equal(resetAt("limit|1790600000000", now), 1790600000_000);
  });

  test("a wait in hours, minutes and seconds", () => {
    assert.equal(resetAt("Rate limit reached. Please try again in 20m", now), now + 20 * MIN);
    assert.equal(resetAt("try again in 1 hour 5 minutes", now), now + 65 * MIN);
    assert.equal(resetAt("retry after 30 seconds", now), now + 30_000);
  });

  test("a clock time, today or tomorrow", () => {
    assert.equal(resetAt("resets 3pm", now), new Date(2026, 8, 26, 15, 0).getTime());
    assert.equal(resetAt("resets at 9:30am", now), new Date(2026, 8, 27, 9, 30).getTime());
    assert.equal(resetAt("usage limit reached", now), null);
  });

  test("Claude Code's own reset wording, with a zone or a date", () => {
    // 10am UTC is noon in Berlin, so 3pm there is 1pm UTC the same day
    assert.equal(resetAt("You've hit your limit · resets 3pm (Europe/Berlin)", Date.UTC(2026, 8, 26, 10, 0)), Date.UTC(2026, 8, 26, 13, 0));
    assert.equal(resetAt("5-hour limit reached ∙ resets 3pm", now), new Date(2026, 8, 26, 15, 0).getTime());
    assert.equal(resetAt("Weekly limit reached ∙ resets Oct 9, 3pm", now), new Date(2026, 9, 9, 15, 0).getTime());
    assert.equal(resetAt("Weekly limit reached ∙ resets Sep 1 at 9am", now), new Date(2027, 8, 1, 9, 0).getTime());
    // the zone named is the account's, not this computer's: 3:20pm in
    // Yerevan (UTC+4) is 11:20 UTC, wherever the server is
    const utcNoon = Date.UTC(2026, 9, 8, 9, 0);
    assert.equal(resetAt("You've hit your session limit · resets 3:20pm (Asia/Yerevan)", utcNoon), Date.UTC(2026, 9, 8, 11, 20));
    assert.equal(resetAt("You've hit your session limit · resets 3:20pm (Asia/Yerevan)", Date.UTC(2026, 9, 8, 12, 0)), Date.UTC(2026, 9, 9, 11, 20));
    assert.equal(resetAt("Weekly limit reached ∙ resets Oct 9, 3pm (America/New_York)", utcNoon), Date.UTC(2026, 9, 9, 19, 0));
    // a zone this runtime does not know falls back to the local clock
    assert.equal(resetAt("resets 3pm (Mars/Olympus_Mons)", now), new Date(2026, 8, 26, 15, 0).getTime());
    // the rate limit's own reset, appended by the driver, wins over the clock
    assert.equal(resetAt("You've hit your limit · resets 3pm|1790600000", now), 1790600000_000);
  });

  test("a sensible rest when nothing is said, and never absurdly long", () => {
    assert.equal(restUntil("limit", "rate limit", now), now + 30 * MIN);
    assert.equal(restUntil("overloaded", "overloaded", now), now + 10 * MIN);
    assert.equal(restUntil("limit", "limit|9999999999", now), now + 12 * 60 * MIN);
  });

  test("a rest ends by itself, and says how long it has left", () => {
    const table = new Cooldowns();
    const rest = table.rest("claude", "limit", "try again in 20m", now);
    assert.equal(table.of("claude", now + 5 * MIN)?.reason, "limit");
    assert.equal(describeRest(rest, now), "for about 20 minutes");
    assert.equal(table.of("claude", now + 21 * MIN), undefined);
    assert.deepEqual(table.all(now + 21 * MIN), {});
  });
});

/** A chat engine that always says the same thing, or always refuses. */
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
      const last = (() => {
        try {
          const messages = JSON.parse(body).messages ?? [];
          return String(messages[messages.length - 1]?.content ?? "");
        } catch {
          return "";
        }
      })();
      asked.push(last);
      const reply = answer(last);
      res.writeHead(reply.status, { "content-type": "application/json" });
      res.end(JSON.stringify(reply.body));
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${(server.address() as any).port}`, asked })),
  );
}

async function waitFor<T>(check: () => Promise<T | null | undefined>, timeoutMs = 15_000): Promise<T | null> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const result = await check();
    if (result) return result;
    await new Promise((r) => setTimeout(r, 150));
  }
  return null;
}

describe("a turn that runs out moves to the backup", () => {
  let h: Harness;
  before(async () => {
    h = await startHarness();
  });
  after(() => h.stop());

  test("the same message is answered by the backup, and later turns stay there while the main one rests", async (t) => {
    const main = await fakeEngine(() => ({
      status: 429,
      body: { error: { message: "Rate limit reached. Please try again in 20m" } },
    }));
    const spare = await fakeEngine(() => ({
      status: 200,
      body: { choices: [{ message: { role: "assistant", content: "Done, from the spare." } }] },
    }));
    t.after(() => {
      main.server.close();
      spare.server.close();
    });
    await h.fetch("/api/providers/grok/connect", { method: "POST", body: JSON.stringify({ key: "xai-test-0000000000", url: main.url }) });
    await h.fetch("/api/providers/kimi/connect", { method: "POST", body: JSON.stringify({ key: "sk-test-0000000000", url: spare.url }) });

    const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Relay" }) });
    const patched = await h.fetch(`/api/bots/${bot.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        modelSelection: { instanceId: "grok", model: "m-1" },
        backupSelection: { instanceId: "kimi", model: "m-1" },
      }),
    });
    assert.equal(patched.status, 200);
    assert.deepEqual((await patched.json()).bot.backupSelection, { instanceId: "kimi", model: "m-1" });

    await h.fetch(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: "Summarise the week" }) });
    const answered = await waitFor(async () => {
      const { bots } = await h.json("/api/bots");
      const me = bots.find((b: any) => b.id === bot.id);
      return !me.busy && me.messages.some((m: any) => m.text === "Done, from the spare.") ? me : null;
    });
    assert.ok(answered, "the backup never answered");
    assert.ok(main.asked.some((q) => q.includes("Summarise the week")), "the main engine is tried first");
    assert.ok(spare.asked.some((q) => q.includes("Summarise the week")), "the backup gets the same message");
    const notice = answered.messages.find((m: any) => m.kind === "notice" && /is picking this up/.test(m.text));
    assert.ok(notice, "the chat says the backup took over");
    assert.match(notice.text, /is out of usage for about 20 minutes/);
    // said once, in plain words: the raw error is not shown as well
    assert.ok(!answered.messages.some((m: any) => /HTTP 429/.test(m.text ?? "")), "the raw error stays out of the way");
    // the user's message is in the chat once, not twice
    assert.equal(answered.messages.filter((m: any) => m.role === "user" && m.text === "Summarise the week").length, 1);

    // the next turn goes straight to the backup: the main one is resting
    const triedBefore = main.asked.length;
    await h.fetch(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: "And next week?" }) });
    const second = await waitFor(async () => {
      const { bots } = await h.json("/api/bots");
      const me = bots.find((b: any) => b.id === bot.id);
      return !me.busy && me.messages.filter((m: any) => m.text === "Done, from the spare.").length === 2 ? me : null;
    });
    assert.ok(second, "the second turn never landed");
    assert.equal(main.asked.length, triedBefore, "a resting engine is not asked again");

    await h.fetch(`/api/bots/${bot.id}?forget=1`, { method: "DELETE" });
  });

  test("without a backup a turn that runs out fails the way it always did", async (t) => {
    const main = await fakeEngine(() => ({ status: 429, body: { error: { message: "Too Many Requests" } } }));
    t.after(() => main.server.close());
    await h.fetch("/api/providers/deepseek/connect", { method: "POST", body: JSON.stringify({ key: "sk-test-1111111111", url: main.url }) });
    const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Solo" }) });
    await h.fetch(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "deepseek", model: "m-1" } }) });
    await h.fetch(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: "Hello" }) });
    const settled = await waitFor(async () => {
      const { bots } = await h.json("/api/bots");
      const me = bots.find((b: any) => b.id === bot.id);
      return !me.busy && me.messages.some((m: any) => m.kind === "notice" || m.kind === "activity") ? me : null;
    });
    assert.ok(settled);
    assert.ok(!settled.messages.some((m: any) => /picking this up/.test(m.text ?? "")));
    assert.ok(settled.messages.some((m: any) => /429|Too Many Requests/.test(m.text ?? m.tool?.name ?? "")), "the error is shown");
    await h.fetch(`/api/bots/${bot.id}?forget=1`, { method: "DELETE" });
  });

  test("a backup that is not an engine and a model is refused", async () => {
    const { bots } = await h.json("/api/bots");
    const res = await h.fetch(`/api/bots/${bots[0].id}`, { method: "PATCH", body: JSON.stringify({ backupSelection: { instanceId: 4 } }) });
    assert.equal(res.status, 400);
    const cleared = await h.fetch(`/api/bots/${bots[0].id}`, { method: "PATCH", body: JSON.stringify({ backupSelection: null }) });
    assert.equal(cleared.status, 200);
  });
});

// A Claude Code subscription limit, as the CLI actually reports it in
// stream-json. Seen in the wild: the notice arrives as an assistant
// message (spoken as "<synthetic>", sometimes marked error: "rate_limit")
// and the result frame says success with is_error false. Read as a
// normal reply, that ended the turn well: the notice was posted as the
// agent's answer, no backup was asked, and the engine was not rested, so
// the next message hit the same limit again.
const CLAUDE_SHAPES = `#!${process.execPath}
import { existsSync, readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("9.9.9 (Claude Code)"); process.exit(0); }
if (args[0] === "auth") { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
const out = (frame) => console.log(JSON.stringify(frame));
let input = "";
process.stdin.on("data", (c) => (input += c));
((go) => { let line = ""; const take = (c) => { line += c; if (!line.includes(String.fromCharCode(10))) return; process.stdin.off("data", take); go(); }; process.stdin.on("data", take); })(async () => {
  // one agent writing to another, the way the CLI does
  const ping = input.match(/PING ([\\w-]+)/);
  if (ping) {
    await fetch(process.env.BLOKS_URL + "/api/bots/" + ping[1] + "/messages", {
      method: "POST",
      headers: { authorization: "Bearer " + process.env.BLOKS_TOKEN, "content-type": "application/json" },
      body: JSON.stringify({ text: "SHAPE relay can you check the deploy" }),
    });
    out({ type: "result", subtype: "success", is_error: false, num_turns: 1, duration_api_ms: 120, total_cost_usd: 0, session_id: "sess-ping", result: "asked" });
    return;
  }
  const shape = input.match(/SHAPE (\\w+)/)?.[1] ?? "none";
  const tally = "__HOME__/asked-" + shape;
  writeFileSync(tally, String((existsSync(tally) ? Number(readFileSync(tally, "utf8")) : 0) + 1));
  const session = "sess-" + shape;
  out({ type: "system", subtype: "init", session_id: session, model: "claude-sonnet-5" });
  const reply = (text, extra = {}, model = "<synthetic>") =>
    out({ type: "assistant", ...extra, session_id: session, message: { id: "msg-" + shape, model, role: "assistant", content: [{ type: "text", text }], usage: { input_tokens: 0, output_tokens: 0 } } });
  const result = (text) =>
    out({ type: "result", subtype: "success", is_error: false, num_turns: 1, duration_api_ms: 120, total_cost_usd: 0, session_id: session, result: text });
  if (shape === "synthetic") {
    const resetsAt = Math.floor(Date.now() / 1000) + 40 * 60;
    out({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt, rateLimitType: "five_hour" }, session_id: session });
    reply("You've hit your limit · resets 3pm (Europe/Berlin)");
    result("You've hit your limit · resets 3pm (Europe/Berlin)");
  } else if (shape === "flagged") {
    reply("5-hour limit reached ∙ resets 3pm", { error: "rate_limit" });
    result("5-hour limit reached ∙ resets 3pm");
  } else if (shape === "session" || shape === "relay") {
    // what 2.1.29x says now: the limit named, the account's zone after
    // the time, flagged on the reply and failed on the result
    reply("You've hit your session limit · resets 3:20pm (Asia/Yerevan)", { error: "rate_limit" });
    out({ type: "result", subtype: "success", is_error: true, num_turns: 1, duration_api_ms: 120, total_cost_usd: 0, session_id: session, result: "You've hit your session limit · resets 3:20pm (Asia/Yerevan)" });
  } else if (shape === "bare") {
    const at = Math.floor(Date.now() / 1000) + 3 * 3600;
    reply("Claude AI usage limit reached|" + at, {}, "claude-sonnet-5");
    result("Claude AI usage limit reached|" + at);
  } else {
    reply("Rate limit reached on the GitHub API, so I paused the sync.", {}, "claude-sonnet-5");
    result("Rate limit reached on the GitHub API, so I paused the sync.");
  }
});
`;

describe("a Claude Code subscription limit moves to the backup", () => {
  let h: Harness;
  let home: string;
  let spare: Awaited<ReturnType<typeof fakeEngine>>;
  const shapes = ["synthetic", "flagged", "session", "relay", "bare", "talk"];
  before(async () => {
    home = mkdtempSync(join(tmpdir(), "bloks-claude-limit-"));
    mkdirSync(join(home, ".bloks"), { recursive: true });
    const cli = join(home, "fake-claude.mjs");
    writeFileSync(cli, CLAUDE_SHAPES.replaceAll("__HOME__", home), { mode: 0o755 });
    // one Claude engine per shape: a limit rests the whole engine
    const instances = Object.fromEntries(shapes.map((s) => [`claude-${s}`, { driver: "claudeAgent", config: { cli } }]));
    writeFileSync(join(home, ".bloks", "config.json"), JSON.stringify({ instances }));
    spare = await fakeEngine(() => ({
      status: 200,
      body: { choices: [{ message: { role: "assistant", content: "Done, from the spare." } }] },
    }));
    h = await startHarness({ HOME: home });
    await h.fetch("/api/providers/kimi/connect", { method: "POST", body: JSON.stringify({ key: "sk-test-2222222222", url: spare.url }) });
  });
  after(async () => {
    await h.stop();
    spare.server.close();
    rmSync(home, { recursive: true, force: true });
  });

  const asked = (shape: string) => {
    const file = join(home, `asked-${shape}`);
    return existsSync(file) ? Number(readFileSync(file, "utf8")) : 0;
  };
  const agentOn = async (shape: string) => {
    const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: `Limit ${shape}` }) });
    const patched = await h.fetch(`/api/bots/${bot.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        modelSelection: { instanceId: `claude-${shape}`, model: "claude-sonnet-5" },
        backupSelection: { instanceId: "kimi", model: "m-1" },
      }),
    });
    assert.equal(patched.status, 200);
    return bot.id as string;
  };
  const settled = (botId: string, ready: (messages: any[]) => boolean) =>
    waitFor(async () => {
      const me = (await h.json("/api/bots")).bots.find((b: any) => b.id === botId);
      return !me.busy && ready(me.messages) ? me.messages : null;
    });

  for (const shape of ["synthetic", "flagged", "session", "bare"]) {
    test(`${shape}: the notice is not the agent's reply, the backup answers, and Claude rests`, async () => {
      const botId = await agentOn(shape);
      await h.fetch(`/api/bots/${botId}/messages`, { method: "POST", body: JSON.stringify({ text: `SHAPE ${shape} summarise the week` }) });
      const first = await settled(botId, (m) => m.some((x) => x.text === "Done, from the spare."));
      assert.ok(first, "the backup never answered");
      assert.equal(asked(shape), 1, "Claude is tried first, once");
      assert.ok(
        !first.some((m: any) => m.role === "bot" && m.kind === "text" && /limit/i.test(m.text ?? "")),
        "the CLI's limit notice was posted as the agent's reply",
      );
      const notice = first.find((m: any) => m.kind === "notice" && /is picking this up/.test(m.text));
      assert.ok(notice, "the chat says the backup took over");
      assert.match(notice.text, /is out of usage/);
      // the rate limit's own reset is used when it gave one
      if (shape === "synthetic") assert.match(notice.text, /for about (39|40) minutes/);
      if (shape === "bare") assert.match(notice.text, /until /);
      // said once, as the handover, not once per frame that carried it
      assert.ok(!first.some((m: any) => m.kind === "notice" && /hit your/.test(m.text ?? "")), "the raw limit notice was shown");

      // the next message goes straight to the backup: Claude is resting
      await h.fetch(`/api/bots/${botId}/messages`, { method: "POST", body: JSON.stringify({ text: `SHAPE ${shape} and next week?` }) });
      const second = await settled(botId, (m) => m.filter((x) => x.text === "Done, from the spare.").length === 2);
      assert.ok(second, "the second turn never landed");
      assert.equal(asked(shape), 1, "a resting Claude was asked again");
    });
  }

  test("a message from another agent is still theirs on the backup", async () => {
    const botId = await agentOn("relay");
    const { bot: sender } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Assistant" }) });
    await h.fetch(`/api/bots/${sender.id}`, {
      method: "PATCH",
      body: JSON.stringify({ modelSelection: { instanceId: "claude-talk", model: "claude-sonnet-5" }, approvals: "auto" }),
    });
    await h.fetch(`/api/bots/${sender.id}/messages`, { method: "POST", body: JSON.stringify({ text: `PING ${botId}` }) });
    const messages = await settled(botId, (m) => m.some((x) => x.text === "Done, from the spare."));
    assert.ok(messages, "the backup never answered the other agent");
    assert.equal(asked("relay"), 1, "Claude is tried first, once");
    const heard = spare.asked.find((a) => a.includes("SHAPE relay"));
    assert.match(heard ?? "", /A message from Assistant, another agent/, "the backup was not told who wrote it");
  });

  test("an agent that only talks about a limit is answering, not out", async () => {
    const botId = await agentOn("talk");
    await h.fetch(`/api/bots/${botId}/messages`, { method: "POST", body: JSON.stringify({ text: "SHAPE talk sync the repo" }) });
    const messages = await settled(botId, (m) => m.some((x) => x.role === "bot" && x.kind === "text"));
    assert.ok(messages, "the turn never ended");
    assert.ok(messages.some((m: any) => m.role === "bot" && m.kind === "text" && /GitHub API/.test(m.text)), "the reply was not shown");
    assert.ok(!messages.some((m: any) => /picking this up/.test(m.text ?? "")), "a reply about limits handed the turn over");
  });
});
