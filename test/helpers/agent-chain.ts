// A controllable local CLI. Each turn stays open until its test finishes it.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { startHarness } from "./server.ts";
import { waitFor } from "./turns.ts";

export interface ChainTurn { pid: number; text: string; token: string }
export interface ChainBot { id: string; threadId: string; name: string }

export async function controlledChain(t: TestContext, config: Record<string, unknown> = {}, extraEnv: Record<string, string> = {}) {
  const home = mkdtempSync(join(tmpdir(), "bloks-chain-setting-"));
  const cli = join(home, "claude.mjs");
  mkdirSync(join(home, ".bloks"));
  writeFileSync(join(home, ".bloks/config.json"), JSON.stringify({
    instances: { claude: { driver: "claudeAgent", config: { cli } } }, ...config,
  }));
  writeFileSync(cli, `#!${process.execPath}
import { appendFileSync, existsSync } from "node:fs";
if (process.argv[2] === "--version") { console.log("2.1.299 (Claude Code)"); process.exit(0); }
if (process.argv[2] === "auth") { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
const home = ${JSON.stringify(home)};
const out = (frame) => console.log(JSON.stringify(frame));
let input = "", started = false;
process.stdin.on("data", (chunk) => {
  input += chunk;
  for (let i = input.indexOf("\\n"); i >= 0; i = input.indexOf("\\n")) {
    const line = input.slice(0, i); input = input.slice(i + 1);
    if (!line.trim() || started) continue;
    const frame = JSON.parse(line);
    if (frame.type !== "user") continue;
    started = true;
    out({ type: "system", subtype: "init", session_id: "chain-session", model: "claude-sonnet-5" });
    appendFileSync(home + "/turns.jsonl", JSON.stringify({ pid: process.pid, text: String(frame.message?.content ?? ""), token: process.env.BLOKS_TOKEN }) + "\\n", { mode: 0o600 });
  }
});
setInterval(() => {
  if (!started || !(existsSync(home + "/finish-" + process.pid) || existsSync(home + "/finish-all"))) return;
  out({ type: "assistant", message: { content: [{ type: "text", text: "Complete" }] } });
  out({ type: "result", subtype: "success", is_error: false, num_turns: 1, session_id: "chain-session", result: "Complete" });
  setTimeout(() => process.exit(0), 10);
}, 20);
`, { mode: 0o755 });
  let h = await startHarness({ HOME: home, ...extraEnv });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    writeFileSync(join(home, "finish-all"), "");
    await h.stop();
    rmSync(home, { recursive: true, force: true });
  };
  t.after(close);
  const turns = (): ChainTurn[] => existsSync(join(home, "turns.jsonl"))
    ? readFileSync(join(home, "turns.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  const turnAfter = async (n: number) => {
    const turn = await waitFor(() => turns()[n] ?? null, 15_000);
    assert.ok(turn, "the controlled CLI did not receive the accepted turn");
    return turn;
  };
  const hire = async (name: string) => {
    const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name }) });
    await h.json(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "claude", model: "claude-sonnet-5" }, approvals: "full" }) });
    return bot as ChainBot;
  };
  const begin = async (bot: { id: string }, text = "Begin the example") => {
    const n = turns().length;
    const res = await h.fetch(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text }) });
    assert.ok(res.ok);
    return turnAfter(n);
  };
  const agent = (turn: ChainTurn, path: string, body?: unknown, method = "POST") => h.fetch(path, {
    method, headers: { authorization: `Bearer ${turn.token}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const finish = async (turn: ChainTurn, bot: { id: string }) => {
    writeFileSync(join(home, `finish-${turn.pid}`), "");
    assert.ok(await waitFor(async () => {
      const { bots } = await h.json("/api/bots?messages=0");
      return bots.find((b: any) => b.id === bot.id)?.busy ? null : true;
    }), "the controlled turn did not finish");
  };
  const depth = async (a: ChainBot, b: ChainBot, n: number) => {
    let bot = a, other = b, turn = await begin(a);
    for (let i = 1; i <= n; i++) {
      const before = turns().length;
      const res = await agent(turn, `/api/bots/${other.id}/messages`, { text: `Example handoff ${i}` });
      assert.ok(res.ok, `handoff ${i} was refused`);
      const next = await turnAfter(before);
      await finish(turn, bot);
      [bot, other, turn] = [other, bot, next];
    }
    return { bot, other, turn };
  };
  return {
    home, get h() { return h; }, close, turns, turnAfter, hire, begin, agent, finish, depth,
    async restart(beforeStart?: () => void) { await h.stop(); beforeStart?.(); h = await startHarness({ HOME: home, ...extraEnv }); },
    async limit(value: number) {
      const res = await h.fetch("/api/config", { method: "PUT", body: JSON.stringify({ agents: { turnLimit: value } }) });
      assert.equal(res.status, 200);
      assert.equal((await res.json()).agents.turnLimit, value);
    },
    async messages(bot: { id: string }) { return (await h.json(`/api/bots/${bot.id}/messages?limit=200`)).messages as any[]; },
  };
}
