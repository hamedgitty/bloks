// Where a Claude Code turn ends, and what it cost (GitHub 134 and 137).
//
// 134: on --resume Claude Code can settle something the last session left
// running with a result of its own (no model turns, no API time) before it
// answers. Taking that as the end of the turn revoked the agent's
// credential mid-answer and showed it idle. The turn ends on the result
// that follows the answer.
//
// 137: total_cost_usd is the session's running total. A turn is charged
// the difference from the session's last total, across restarts too.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { SessionCosts } from "../server/drivers/session-costs.ts";
import { startHarness } from "./helpers/server.ts";

const BLOKS = fileURLToPath(new URL("../bin/bloks.mjs", import.meta.url));

const waitFor = async <T,>(check: () => Promise<T | null | undefined> | T | null | undefined, ms = 20_000): Promise<T | null> => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const value = await check();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
};

function workspace(cli: string) {
  const home = mkdtempSync(join(tmpdir(), "bloks-claude-end-"));
  mkdirSync(join(home, ".bloks"), { recursive: true });
  writeFileSync(join(home, ".bloks", "config.json"), JSON.stringify({ instances: { claude: { driver: "claudeAgent", config: { cli: join(home, "fake-claude.mjs") } } } }));
  writeFileSync(join(home, "fake-claude.mjs"), cli.replaceAll("__HOME__", home), { mode: 0o755 });
  return home;
}

const header = `#!${process.execPath}
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("9.9.9 (Claude Code)"); process.exit(0); }
if (args[0] === "auth") { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
const out = (frame) => console.log(JSON.stringify(frame));
let input = "";
process.stdin.on("data", (c) => (input += c));
`;

test("an empty result before the answer does not end the turn or the agent's credential", async (t) => {
  const home = workspace(
    header +
      `process.stdin.on("end", async () => {
  const target = input.match(/SAY ([\\w-]+)/)?.[1];
  out({ type: "system", subtype: "init", session_id: "sess-134", model: "claude-sonnet-5" });
  // what the last session left behind, settled first
  out({ type: "system", subtype: "task_notification", task_id: "bash-1", status: "killed" });
  out({ type: "result", subtype: "success", is_error: false, num_turns: 0, duration_api_ms: 0, total_cost_usd: 0, session_id: "sess-134", result: "" });
  await new Promise((r) => setTimeout(r, 1500));
  let said;
  try {
    said = { code: 0, out: execFileSync(process.execPath, [${JSON.stringify(BLOKS)}, "say", target, "hello from the real answer"], { encoding: "utf8" }) };
  } catch (e) {
    said = { code: e.status ?? 1, out: String(e.stdout ?? e.message) };
  }
  writeFileSync("__HOME__/said.json", JSON.stringify(said));
  out({ type: "assistant", message: { content: [{ type: "text", text: "Sent." }] } });
  out({ type: "result", subtype: "success", is_error: false, num_turns: 2, duration_api_ms: 900, total_cost_usd: 0.25, session_id: "sess-134", result: "Sent." });
});
`,
  );
  const h = await startHarness({ HOME: home });
  t.after(async () => {
    await h.stop();
    rmSync(home, { recursive: true, force: true });
  });
  const { bot: alpha } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Alpha" }) });
  await h.fetch(`/api/bots/${alpha.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } }) });
  const { bot: bravo } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Bravo" }) });

  await h.fetch(`/api/bots/${alpha.id}/messages`, { method: "POST", body: JSON.stringify({ text: `SAY ${bravo.id}` }) });
  // past the empty result, before the answer: still working
  await waitFor(async () => {
    const { bots } = await h.json("/api/bots?messages=0");
    return bots.find((b: any) => b.id === alpha.id)?.busy ? true : null;
  });
  await new Promise((r) => setTimeout(r, 600));
  const { bots } = await h.json("/api/bots?messages=0");
  assert.equal(bots.find((b: any) => b.id === alpha.id).busy, true, "the agent showed idle while it was still answering");

  const said = await waitFor(() => (existsSync(join(home, "said.json")) ? JSON.parse(readFileSync(join(home, "said.json"), "utf8")) : null));
  assert.ok(said, "the answer never ran");
  assert.equal(said.code, 0, `bloks say failed: ${said.out}`);
  const heard = await waitFor(async () => {
    const { messages } = await h.json(`/api/bots/${bravo.id}/messages?limit=50`);
    return messages.find((m: any) => m.text === "hello from the real answer");
  });
  assert.ok(heard, "the other agent never got the message");
  // and the turn did end, on the answer's own result
  assert.ok(
    await waitFor(async () => {
      const { bots: now } = await h.json("/api/bots?messages=0");
      return now.find((b: any) => b.id === alpha.id)?.busy ? null : true;
    }),
    "the turn never ended",
  );
});

test("a turn that was only the empty result still ends when the process does", async (t) => {
  const home = workspace(
    header +
      `process.stdin.on("end", () => {
  out({ type: "system", subtype: "init", session_id: "sess-quiet", model: "claude-sonnet-5" });
  out({ type: "result", subtype: "success", is_error: false, num_turns: 0, duration_api_ms: 0, total_cost_usd: 0, session_id: "sess-quiet", result: "" });
});
`,
  );
  const h = await startHarness({ HOME: home });
  t.after(async () => {
    await h.stop();
    rmSync(home, { recursive: true, force: true });
  });
  const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Quiet" }) });
  await h.fetch(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } }) });
  await h.fetch(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: "/cost" }) });
  const ended = await waitFor(async () => {
    const { messages } = await h.json(`/api/bots/${bot.id}/messages?limit=50`);
    const { bots } = await h.json("/api/bots?messages=0");
    return !bots.find((b: any) => b.id === bot.id)?.busy && messages.length ? messages : null;
  });
  assert.ok(ended, "a turn with nothing but an empty result never ended");
  assert.ok(!ended.some((m: any) => /exit_before_result|before it answered/i.test(m.text ?? "")), "it was reported as a crash");
});

test("each turn is charged its own cost, not the session's running total, across a restart", async (t) => {
  const home = workspace(
    header +
      `process.stdin.on("end", () => {
  const file = "__HOME__/turns.txt";
  const n = (existsSync(file) ? Number(readFileSync(file, "utf8")) : 0) + 1;
  writeFileSync(file, String(n));
  out({ type: "system", subtype: "init", session_id: "sess-137", model: "claude-sonnet-5" });
  out({ type: "assistant", message: { content: [{ type: "text", text: "Turn " + n }] } });
  out({ type: "result", subtype: "success", is_error: false, num_turns: 1, duration_api_ms: 500, total_cost_usd: n, session_id: "sess-137", result: "Turn " + n });
});
`,
  );
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const cost = async (h: Awaited<ReturnType<typeof startHarness>>) => (await h.json("/api/usage?days=1")).total.cost;
  const turn = async (h: Awaited<ReturnType<typeof startHarness>>, botId: string, n: number) => {
    await h.fetch(`/api/bots/${botId}/messages`, { method: "POST", body: JSON.stringify({ text: `turn ${n}` }) });
    await waitFor(async () => {
      const { messages } = await h.json(`/api/bots/${botId}/messages?limit=50`);
      const { bots } = await h.json("/api/bots?messages=0");
      return messages.some((m: any) => m.text === `Turn ${n}`) && !bots.find((b: any) => b.id === botId)?.busy ? true : null;
    });
  };

  const first = await startHarness({ HOME: home });
  const { bot } = await first.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Spender" }) });
  await first.fetch(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } }) });
  for (const n of [1, 2, 3]) await turn(first, bot.id, n);
  assert.equal(await cost(first), 3, "three turns at 1 each, reported as running totals 1, 2 and 3");
  await first.stop();

  const second = await startHarness({ HOME: home });
  t.after(() => second.stop());
  await turn(second, bot.id, 4);
  assert.equal(await cost(second), 4, "the first turn after a restart was charged the whole session again");
});

test("the session bookkeeping on its own", () => {
  const dir = mkdtempSync(join(tmpdir(), "bloks-session-costs-"));
  try {
    const costs = new SessionCosts(dir);
    assert.equal(costs.turn("a", 0.4, false), 0.4, "a new session's first total is its first turn");
    assert.equal(costs.turn("a", 1.1, true), 0.7);
    assert.equal(costs.turn("b", 5, true), null, "a resumed session never seen before has no knowable turn cost");
    assert.equal(costs.turn("b", 5.5, true), 0.5);
    assert.equal(costs.turn("a", 0.2, true), 0.2, "a total that went down started counting again");
    assert.equal(new SessionCosts(dir).turn("b", 6, true), 0.5, "the totals outlive the process");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
