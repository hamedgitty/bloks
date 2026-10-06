// `bloks fresh`: an agent starts a new engine session in the conversation
// it is in, keeping the transcript (GitHub 139).
//
// A long session costs more every turn and works worse. Clear is the
// person's and takes the transcript with it; this keeps the record and
// drops only the engine's memory of it. The reset waits for the turn that
// asked, because that turn is still writing its session; the next turn
// starts without --resume and without the old conversation replayed into
// the prompt. Only the conversation the agent is in.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startHarness } from "./helpers/server.ts";

const waitFor = async <T,>(check: () => Promise<T | null | undefined> | T | null | undefined, ms = 20_000): Promise<T | null> => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const value = await check();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
};

test("a fresh session after this turn: no resume, no replay, transcript kept, own conversation only", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "bloks-fresh-"));
  const log = join(home, "turns.jsonl");
  const answers = join(home, "answers.json");
  const cli = join(home, "fake-claude.mjs");
  // Records each turn's argv and prompt; told CALLS <base64 json>, makes
  // those requests with its turn credential. Each run is its own session.
  writeFileSync(
    cli,
    `#!${process.execPath}
import { appendFileSync, renameSync, writeFileSync } from "node:fs";
const argv = process.argv.slice(2);
if (argv[0] === "--version") { console.log("9.9.9 (Claude Code)"); process.exit(0); }
if (argv[0] === "auth") { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", async () => {
  const resume = argv.includes("--resume") ? argv[argv.indexOf("--resume") + 1] : null;
  const session = resume ?? "sess-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6);
  appendFileSync(${JSON.stringify(log)}, JSON.stringify({ resume, input }) + "\\n");
  console.log(JSON.stringify({ type: "system", subtype: "init", session_id: session, model: "claude-sonnet-5" }));
  const asked = input.match(/CALLS ([A-Za-z0-9+\\/=]+)/);
  if (asked) {
    const out = [];
    for (const [method, path] of JSON.parse(Buffer.from(asked[1], "base64").toString("utf8"))) {
      const res = await fetch(process.env.BLOKS_URL + path, { method, headers: { authorization: "Bearer " + process.env.BLOKS_TOKEN } });
      out.push({ status: res.status, body: await res.json().catch(() => null) });
    }
    writeFileSync(${JSON.stringify(answers)} + ".tmp", JSON.stringify(out)); renameSync(${JSON.stringify(answers)} + ".tmp", ${JSON.stringify(answers)});
  }
  console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Done." }] } }));
  console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 1, duration_api_ms: 300, session_id: session, result: "Done." }));
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

  const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Long runner" }) });
  await h.fetch(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } }) });
  const turns = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
  const say = async (text: string, n: number) => {
    await h.fetch(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text }) });
    await waitFor(() => (turns().length >= n ? true : null));
    await waitFor(async () => ((await h.json("/api/bots?messages=0")).bots.find((b: any) => b.id === bot.id)?.busy ? null : true));
  };

  await say("REMEMBER-THE-PELICAN plan for the launch", 1);
  await say("and the second step", 2);
  assert.ok(turns()[1].resume, "the second turn should resume the first session");

  // from inside a turn: its own conversation waits for the turn, another one is refused
  const { tasks } = (await h.json("/api/bots?messages=0")).bots.find((b: any) => b.id === bot.id);
  const general = tasks[0].id;
  const other = await h.json(`/api/bots/${bot.id}/tasks`, { method: "POST", body: JSON.stringify({ title: "Elsewhere" }) });
  const elsewhere = (other.bot?.tasks ?? []).find((task: any) => task.title === "Elsewhere")?.id;
  assert.ok(elsewhere, "could not make a second conversation for the test");
  // making one opens it; the person goes back to General
  await h.fetch(`/api/bots/${bot.id}/tasks/${general}/activate`, { method: "POST" });
  const calls = [
    ["POST", `/api/bots/${bot.id}/tasks/${general}/fresh`],
    ["POST", `/api/bots/${bot.id}/tasks/${elsewhere}/fresh`],
  ];
  await h.fetch(`/api/bots/${bot.id}/messages`, {
    method: "POST",
    body: JSON.stringify({ text: `CALLS ${Buffer.from(JSON.stringify(calls)).toString("base64")}`, taskId: general }),
  });
  assert.ok(await waitFor(() => (existsSync(answers) ? true : null)), "the turn never ran");
  await waitFor(async () => ((await h.json("/api/bots?messages=0")).bots.find((b: any) => b.id === bot.id)?.busy ? null : true));
  const [mine, theirs] = JSON.parse(readFileSync(answers, "utf8"));
  assert.equal(mine.status, 202, JSON.stringify(mine.body));
  assert.equal(mine.body.fresh, "when this turn ends");
  assert.equal(theirs.status, 403, "an agent reset a conversation it is not in");

  const before = turns().length;
  await say("what next?", before + 1);
  const next = turns()[before];
  assert.equal(next.resume, null, "the turn after a fresh session still resumed the old one");
  assert.doesNotMatch(next.input, /REMEMBER-THE-PELICAN/, "the old conversation was replayed into the new session");

  const { messages } = await h.json(`/api/bots/${bot.id}/messages?thread=${general}&limit=100`);
  assert.ok(messages.some((m: any) => /REMEMBER-THE-PELICAN/.test(m.text ?? "")), "the transcript lost the earlier turns");
  assert.ok(messages.some((m: any) => m.kind === "notice" && /fresh session/.test(m.text ?? "")), "the chat does not say a fresh session started");

  // and the session after that resumes the new one, as normal
  await say("one more", before + 2);
  assert.ok(turns()[before + 1].resume, "the new session is not resumed afterwards");
});
