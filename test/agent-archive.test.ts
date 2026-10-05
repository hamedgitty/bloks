// An agent archiving a teammate it hired, once that teammate's work is
// done (GitHub 148).
//
// The hire is the delegation, as it is for `bloks stop`; nothing else
// grants this. Anything still running, waiting or scheduled refuses the
// archive and says so, instead of being cancelled. What is archived keeps
// everything, records who archived it and why, and the person restores it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startHarness } from "./helpers/server.ts";

const waitFor = async <T,>(check: () => Promise<T | null | undefined> | T | null | undefined, ms = 30_000): Promise<T | null> => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const value = await check();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
};

test("a manager archives only an agent it hired, only when its work is done, and the person can restore it", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "bloks-agent-archive-"));
  const answers = join(home, "answers.json");
  const cli = join(home, "fake-claude.mjs");
  // Told CALLS <base64 json>, makes each request with its turn credential.
  // Told WORK-SLOWLY, keeps working until it is stopped.
  writeFileSync(
    cli,
    `#!${process.execPath}
import { writeFileSync } from "node:fs";
const [first] = process.argv.slice(2);
if (first === "--version") { console.log("9.9.9 (Claude Code)"); process.exit(0); }
if (first === "auth") { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
process.on("SIGTERM", () => process.exit(143));
let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", async () => {
  console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "s-" + Math.random().toString(36).slice(2), model: "claude-sonnet-5" }));
  if (input.includes("WORK-SLOWLY")) await new Promise((r) => setTimeout(r, 60_000));
  const asked = input.match(/CALLS ([A-Za-z0-9+\\/=]+)/);
  if (asked) {
    const out = [];
    for (const [method, path, body] of JSON.parse(Buffer.from(asked[1], "base64").toString("utf8"))) {
      const res = await fetch(process.env.BLOKS_URL + path, {
        method,
        headers: { authorization: "Bearer " + process.env.BLOKS_TOKEN, "content-type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      out.push({ status: res.status, body: await res.json().catch(() => null) });
    }
    writeFileSync(${JSON.stringify(answers)}, JSON.stringify(out));
  }
  console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Done." }] } }));
  console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 1, duration_api_ms: 100, result: "Done." }));
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

  const claude = { modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } };
  const make = async (name: string) => {
    const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name }) });
    await h.fetch(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify(claude) });
    return bot;
  };
  const find = async (id: string) => (await h.json("/api/bots?messages=0")).bots.find((b: any) => b.id === id);
  const idle = (id: string) => waitFor(async () => ((await find(id))?.busy ? null : true));
  const as = async (botId: string, calls: unknown[]) => {
    rmSync(answers, { force: true });
    await idle(botId);
    await h.fetch(`/api/bots/${botId}/messages`, { method: "POST", body: JSON.stringify({ text: `CALLS ${Buffer.from(JSON.stringify(calls)).toString("base64")}` }) });
    assert.ok(await waitFor(() => existsSync(answers)), "the turn never ran");
    const out = JSON.parse(readFileSync(answers, "utf8")) as Array<{ status: number; body: any }>;
    await idle(botId);
    return out;
  };

  const lead = await make("Lead");
  const stranger = await make("Stranger");
  const [hired] = await as(lead.id, [["POST", "/api/bots", { name: "Temp" }]]);
  assert.ok(hired.status < 300, JSON.stringify(hired.body));
  const temp = hired.body.bot;
  await h.fetch(`/api/bots/${temp.id}`, { method: "PATCH", body: JSON.stringify(claude) });

  // nobody else may, not even itself, and the person uses the agent's menu
  const [notMine, itself] = await as(stranger.id, [
    ["POST", `/api/bots/${temp.id}/archive`, {}],
    ["POST", `/api/bots/${stranger.id}/archive`, {}],
  ]);
  assert.equal(notMine.status, 403);
  assert.equal(itself.status, 403);
  assert.equal((await h.fetch(`/api/bots/${temp.id}/archive`, { method: "POST", body: "{}" })).status, 403);

  // scheduled work refuses it, says what, and changes nothing
  const { routine } = await h.json("/api/routines", {
    method: "POST",
    body: JSON.stringify({ targetId: temp.id, targetKind: "agent", name: "Daily check", prompt: "Check.", time: "09:00", days: [1, 2, 3, 4, 5] }),
  });
  const [scheduled] = await as(lead.id, [["POST", `/api/bots/${temp.id}/archive`, { note: "launch done" }]]);
  assert.equal(scheduled.status, 409);
  assert.match(scheduled.body.error, /routine is on for it/);
  assert.equal((await find(temp.id)).archivedAt ?? null, null);
  await h.fetch(`/api/routines/${routine.id}`, { method: "DELETE" });

  // work in progress refuses it too, and is not interrupted
  await h.fetch(`/api/bots/${temp.id}/messages`, { method: "POST", body: JSON.stringify({ text: "WORK-SLOWLY on the last bit" }) });
  assert.ok(await waitFor(async () => (await find(temp.id))?.busy), "the temp never started");
  const [working] = await as(lead.id, [["POST", `/api/bots/${temp.id}/archive`, {}]]);
  assert.equal(working.status, 409);
  assert.match(working.body.error, /it is working in/);
  assert.equal((await find(temp.id)).busy, true, "the archive attempt stopped its work");
  await h.fetch(`/api/bots/${temp.id}/interrupt`, { method: "POST", body: "{}" });
  await idle(temp.id);

  // done: archived, with who and why kept
  const [archived, again] = await as(lead.id, [
    ["POST", `/api/bots/${temp.id}/archive`, { note: "Launch copy delivered and approved" }],
    ["POST", `/api/bots/${temp.id}/archive`, { note: "a second note" }],
  ]);
  assert.equal(archived.status, 200, JSON.stringify(archived.body));
  assert.equal(archived.body.archived, true);
  assert.equal(again.status, 200);
  assert.equal(again.body.archived, false, "a second archive reports, not repeats");
  const kept = await find(temp.id);
  assert.ok(kept.archivedAt);
  assert.equal(kept.hidden, true);
  assert.equal(kept.archivedBy, lead.id);
  assert.equal(kept.archiveNote, "Launch copy delivered and approved", "the second ask replaced the evidence");

  // it takes no work while archived, and the person brings it back
  const refused = await h.fetch(`/api/bots/${temp.id}/messages`, { method: "POST", body: JSON.stringify({ text: "one more thing" }) });
  assert.ok(refused.status >= 400, "an archived agent took a message");
  const restored = await h.fetch(`/api/bots/${temp.id}/restore`, { method: "POST" });
  assert.equal(restored.status, 200);
  const back = await find(temp.id);
  assert.ok(!back.archivedAt && !back.hidden);
  assert.equal(back.archivedBy, undefined);
  assert.equal(back.archiveNote, undefined);
});
