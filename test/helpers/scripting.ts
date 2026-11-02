// A workspace for the scripting commands (bloks-server run, team, chat;
// server/scripting-cli.ts), with a stand-in Claude Code that does what
// its prompt says, and a way to run bin/bloks-server.mjs against it.
//
// What the stand-in reads in a prompt:
//   PLAIN            answers PLAIN-REPLY, after running one tool
//   HANDOFF <id> <me>  asks agent <id> for help with its own credential,
//                    as `bloks say` does, and ends its turn saying so
//   HELP-ME <id>     (what a handoff says) helps, then reports back to <id>
//   REPORTED         (what the report says) answers FINAL-ANSWER
//   FAIL             ends its turn as an error
//   SLOW             works until the test or a stop ends it, leaving its
//                    credential in agent-token
//   MAKEFILE <id>    writes made/report.txt in its folder and summary.txt
//                    in agent <id>'s deliverables, then answers
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TestContext } from "node:test";

import { startHarness, type Harness } from "./server.ts";

export const CLI = fileURLToPath(new URL("../../bin/bloks-server.mjs", import.meta.url));

/** `extraConfig` goes into config.json beside the stand-in engine, for a
 * test that needs the workspace set up some way of its own first. */
export async function scriptingWorkspace(t: TestContext, extraEnv: Record<string, string> = {}, extraConfig: Record<string, unknown> = {}) {
  const home = mkdtempSync(join(tmpdir(), "bloks-scripting-"));
  mkdirSync(join(home, ".bloks"), { recursive: true });
  const fake = join(home, "fake-claude.mjs");
  writeFileSync(join(home, ".bloks", "config.json"), JSON.stringify({ ...extraConfig, instances: { claude: { driver: "claudeAgent", config: { cli: fake } } } }));
  writeFileSync(
    fake,
    `#!${process.execPath}
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("2.1.299 (Claude Code)"); process.exit(0); }
if (args[0] === "auth") { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
const home = ${JSON.stringify(home)};
const out = (frame) => console.log(JSON.stringify(frame));
const say = (text) => {
  out({ type: "assistant", message: { content: [{ type: "text", text }] } });
  out({ type: "result", subtype: "success", is_error: false, num_turns: 1, duration_api_ms: 100, total_cost_usd: 0.0125, usage: { input_tokens: 120, output_tokens: 30 }, session_id: "sess-script", result: text });
  setTimeout(() => process.exit(0), 20);
};
const as = (path, body) => fetch(process.env.BLOKS_URL + path, { method: "POST", headers: { authorization: "Bearer " + process.env.BLOKS_TOKEN, "content-type": "application/json" }, body: JSON.stringify(body) });
let buf = "";
let started = false;
process.stdin.on("data", (c) => {
  buf += c;
  for (let i = buf.indexOf("\\n"); i >= 0; i = buf.indexOf("\\n")) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim() || started) continue;
    const frame = JSON.parse(line);
    if (frame.type !== "user") continue;
    started = true;
    void go(JSON.stringify(frame.message?.content ?? ""));
  }
});
async function go(prompt) {
  out({ type: "system", subtype: "init", session_id: "sess-script", model: "claude-sonnet-5" });
  const handoff = prompt.match(/HANDOFF ([\\w-]+) ([\\w-]+)/);
  const help = prompt.match(/HELP-ME ([\\w-]+)/);
  if (prompt.includes("REPORTED")) return say("FINAL-ANSWER");
  if (help) {
    await new Promise((r) => setTimeout(r, 400));
    await as("/api/bots/" + help[1] + "/messages", { text: "REPORTED: the part you asked for is done" });
    return say("Helped.");
  }
  if (handoff) {
    const res = await as("/api/bots/" + handoff[1] + "/messages", { text: "HELP-ME " + handoff[2] });
    return say("Asked for help (" + res.status + ").");
  }
  if (prompt.includes("FAIL")) {
    out({ type: "result", subtype: "error_during_execution", is_error: true, num_turns: 1, session_id: "sess-script", result: "It broke" });
    setTimeout(() => process.exit(1), 20);
    return;
  }
  if (prompt.includes("SLOW")) {
    // its credential, for a test to try the owner's routes with
    writeFileSync(home + "/agent-token", process.env.BLOKS_TOKEN ?? "", { mode: 0o600 });
    setInterval(() => { if (existsSync(home + "/finish-all")) say("Late."); }, 50);
    return;
  }
  const make = prompt.match(/MAKEFILE ([\\w-]+)/);
  if (make) {
    mkdirSync("made", { recursive: true });
    writeFileSync("made/report.txt", "the report\\n");
    // and a deliverable, where the agent's own files go
    writeFileSync(home + "/.bloks/artifacts/" + make[1] + "/summary.txt", "the summary\\n");
    return say("Wrote it.");
  }
  out({ type: "assistant", message: { content: [{ type: "tool_use", id: "tool-1", name: "Bash", input: { command: "echo checking" } }] } });
  out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tool-1", content: "checking" }] } });
  return say("PLAIN-REPLY");
}
`,
    { mode: 0o755 },
  );
  const h = await startHarness({ HOME: home, ...extraEnv });
  t.after(async () => {
    writeFileSync(join(home, "finish-all"), "");
    await h.stop();
    rmSync(home, { recursive: true, force: true, maxRetries: 5 });
  });
  const folder = join(home, "work");
  mkdirSync(folder, { recursive: true });
  const hire = async (name: string, title = "") => {
    const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name, title }) });
    mkdirSync(join(folder, name.toLowerCase()), { recursive: true });
    const res = await h.fetch(`/api/bots/${bot.id}`, {
      method: "PATCH",
      body: JSON.stringify({ modelSelection: { instanceId: "claude", model: "claude-sonnet-5" }, approvals: "full", cwd: join(folder, name.toLowerCase()) }),
    });
    if (!res.ok) throw new Error(`could not set up ${name}: ${await res.text()}`);
    return bot as { id: string; threadId: string; name: string };
  };
  return { h, home, hire, folder };
}

export interface Ran {
  code: number | null;
  out: string;
  err: string;
}

/** bin/bloks-server.mjs against `h`, with `input` piped in when given. */
export function cli(h: Harness, args: string[], opts: { input?: string; env?: Record<string, string>; home?: string } = {}): Promise<Ran> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: {
        ...process.env,
        HOME: opts.home ?? h.home,
        USERPROFILE: opts.home ?? h.home,
        BLOKS_PORT: new URL(h.url).port,
        BLOKS_DATA_DIR: "",
        // a test run from inside an agent's turn must not look like one
        BLOKS_TOKEN: "",
        BLOKS_SERVER_TOKEN: "",
        ...opts.env,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.on("exit", (code) => resolve({ code, out, err }));
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

/** The same, with lines fed one at a time as the output asks for them:
 * each `[waitFor, line]` sends `line` once `waitFor` has been printed. */
export function chatScript(h: Harness, args: string[], script: Array<[RegExp | null, string]>, ms = 60_000): Promise<Ran> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, HOME: h.home, USERPROFILE: h.home, BLOKS_PORT: new URL(h.url).port, BLOKS_DATA_DIR: "", BLOKS_TOKEN: "", BLOKS_SERVER_TOKEN: "" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    let at = 0;
    let from = 0;
    const feed = () => {
      while (at < script.length) {
        const [wait, line] = script[at];
        if (wait) {
          const found = wait.exec(out.slice(from));
          if (!found) return;
          from += found.index + found[0].length;
        }
        at++;
        if (line === "<end>") child.stdin.end();
        else child.stdin.write(`${line}\n`);
      }
    };
    child.stdout.on("data", (c) => {
      out += c;
      feed();
    });
    child.stderr.on("data", (c) => (err += c));
    const timer = setTimeout(() => child.kill("SIGKILL"), ms);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, out, err });
    });
    feed();
  });
}
