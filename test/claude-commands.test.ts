import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { agentCommands, claudeCommand, classifyClaudeCommands, readClaudeCommands } from "../server/agent-commands.ts";
import { startHarness, type Harness } from "./helpers/server.ts";

// Claude 2.1.291 marks bundled skills too. Its init lists distinguish them.
const bundled = ["batch", "claude-api", "code-review", "dataviz", "debug", "deep-research", "doctor", "fewer-permission-prompts", "loop", "plugin-authoring", "run", "run-skill-generator", "simplify", "update-config", "verify", "workflow-authoring"];
const terminal = ["doctor", "color", "focus", "reload-plugins"];
const builtins = ["compact", "context", "usage", "recap", "clear", "login", "logout", "permissions", "model", "future-command", ...terminal];
const rows = [...new Set([...bundled, ...builtins])].map((name) => ({ name, description: `Description of ${name}`, builtin: true }));
const catalog = { commands: rows, skills: bundled, terminal_slash_commands: terminal };

test("a classified report keeps bundled skills, only four built-ins, and no terminal command or loop", () => {
  const reported = classifyClaudeCommands(readClaudeCommands([...rows, { name: "plugin:review", description: "Plugin review" }, { name: "mcp__papers__find", description: "Find papers", builtin: false }, { name: "login", description: "External shadow" }]), bundled, terminal)!;
  assert.ok(reported);
  assert.deepEqual(reported.commands.filter((c) => c.kind === "command").map((c) => c.id), ["compact", "context", "usage", "recap"]);
  assert.deepEqual(reported.commands.filter((c) => c.kind === "skill").map((c) => c.id), [...bundled.filter((n) => n !== "loop" && n !== "doctor"), "plugin:review", "mcp__papers__find"]);
  const commands = agentCommands({ library: [{ id: "compact", name: "Collision", description: "Library" }, { id: "login", name: "Collision", description: "Library" }, { id: "debug", name: "Library debug", description: "Library" }], onClaudeCode: true, reported });
  assert.equal(commands.find((c) => c.id === "compact")?.kind, "command");
  assert.equal(commands.find((c) => c.id === "debug")?.source, "library");
  assert.ok(!commands.some((c) => c.id === "login" || c.id === "loop" || terminal.includes(c.id)));
  assert.ok(!classifyClaudeCommands(readClaudeCommands(rows), bundled, undefined)!.commands.some((c) => terminal.includes(c.id)), "known terminal panels also stay out when an older init omits its terminal list");
});

test("unclassified, missing-init, malformed and oversized reports cannot replace a prior classified report", () => {
  assert.equal(classifyClaudeCommands(readClaudeCommands(rows.map(({ name, description }) => ({ name, description }))), bundled, terminal), null);
  assert.equal(classifyClaudeCommands(readClaudeCommands(rows), undefined, terminal), null);
  assert.equal(classifyClaudeCommands(readClaudeCommands(rows), bundled, ["bad/name"]), null);
  assert.equal(readClaudeCommands([{ name: "bad/name", description: "Bad" }]), null);
  assert.equal(readClaudeCommands(Array.from({ length: 2049 }, () => rows[0])), null);
  assert.equal(readClaudeCommands([{ name: "x", description: "x".repeat(1024 * 1024) }]), null);
  assert.deepEqual(readClaudeCommands([{ name: "plugin:foo", description: "Line 1\nLine 2", account: "DO_NOT_KEEP" }]), [{ name: "plugin:foo", description: "Line 1 Line 2" }]);
  assert.equal(claudeCommand("/compact focus on the next step\nMore"), "compact");
  for (const text of [" /compact", "please /context", "/contextual", "/compact,", "/login"]) assert.equal(claudeCommand(text), null);
});

async function until<T>(check: () => T | Promise<T>, why: string, ms = 12000): Promise<NonNullable<T>> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value as NonNullable<T>;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(why);
}

interface Call { argv: string[]; persona: string; text: string; session: string; wire: any[] }
async function setup(t: TestContext, stallMinutes?: number, extraEnv: Record<string, string> = {}) {
  const home = mkdtempSync(join(tmpdir(), "bloks-commands-"));
  const cli = join(home, "fake-claude.mjs");
  let h: Harness;
  mkdirSync(join(home, ".bloks"), { recursive: true });
  writeFileSync(join(home, "catalog.json"), JSON.stringify(catalog));
  writeFileSync(join(home, ".bloks/config.json"), JSON.stringify({ instances: {
    claude: { driver: "claudeAgent", config: { cli, permissionMode: "acceptEdits" } },
    other: { driver: "claudeAgent", config: { cli, permissionMode: "acceptEdits" } },
  }, ...(stallMinutes === undefined ? {} : { turns: { stallMinutes } }) }));
  writeFileSync(cli, `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
const argv = process.argv.slice(2);
if (argv[0] === '--version') { console.log('2.1.291 (Claude Code)'); process.exit(0); }
if (argv[0] === 'auth') { console.log(JSON.stringify({loggedIn:true})); process.exit(0); }
const home = ${JSON.stringify(home)};
const spec = JSON.parse(readFileSync(home + '/catalog.json', 'utf8'));
const value = (flag) => argv[argv.indexOf(flag)+1];
const session = value(argv.includes('--resume') ? '--resume' : '--session-id');
const out = (frame) => console.log(JSON.stringify(frame));
let buf = '', heard = false, ended = false, finished = false, initializeId, didCompact = false;
const wire = [];
const end = () => {
  if (finished) return;
  finished = true;
  const text = spec.localError ? 'Error: No messages to compact' : spec.failure ? (spec.failureText ?? 'usage limit reached') : 'ANSWER';
  const used=didCompact ? 50000 : spec.used;
  const usage=used===undefined ? {} : {usage:{input_tokens:used-100,cache_creation_input_tokens:100,cache_creation:{ephemeral_1h_input_tokens:100},output_tokens:0}};
  if (!spec.failure) out({type:'assistant', message:{model:'claude-sonnet-5', content:[{type:'text',text}],...usage}});
  out({type:'result', subtype:spec.failure ? 'error_during_execution':'success', is_error:Boolean(spec.failure), num_turns:0, duration_api_ms:0, session_id:session, total_cost_usd:0, result:text,...(used===undefined ? {} : {modelUsage:{'claude-sonnet-5':{contextWindow:spec.window ?? 1000000}}})});
  if (ended) process.exit(0);
};
process.stdin.on('end', () => { ended=true; if (finished) process.exit(0); });
process.stdin.on('data', (c) => {
  buf += c;
  while (buf.includes(String.fromCharCode(10))) {
    const at = buf.indexOf(String.fromCharCode(10));
    const frame = JSON.parse(buf.slice(0,at)); buf=buf.slice(at+1); wire.push(frame);
    if (frame.type === 'control_request') {
      if (spec.ignoreInitialize) continue;
      if (spec.reportByText) {initializeId=frame.request_id;continue;}
      out({type:'control_response', response:{subtype:'success',request_id:'WRONG_ID',response:{commands:[{name:'wrong',description:'Wrong',builtin:true}],account:{email:'PRIVATE_ACCOUNT'}}}});
      out({type:'control_response', response:{subtype:'success',request_id:frame.request_id,response:{commands:spec.commands,account:{email:'PRIVATE_ACCOUNT'},models:['PRIVATE_MODEL'],pid:123,session_id:'PRIVATE_STATE'}}});
      continue;
    }
    if (frame.type !== 'user') continue;
    if (heard) { appendFileSync(home+'/steers.jsonl',JSON.stringify(frame.message.content)+'\\n'); continue; }
    heard=true;
    const text=frame.message.content;
    appendFileSync(home+'/calls.jsonl',JSON.stringify({argv,persona:readFileSync(value('--append-system-prompt-file'),'utf8'),text,session,wire})+'\\n');
    if(initializeId) out({type:'control_response',response:{subtype:'success',request_id:initializeId,response:{commands:text==='/compact' ? [{name:'compact',description:'Compact',builtin:true},{name:'maintenance:only',description:'Maintenance report'}] : spec.commands,account:'PRIVATE_ACCOUNT',models:['PRIVATE_MODEL'],pid:123,session_id:'PRIVATE_STATE'}}});
    out({type:'system',subtype:'init',session_id:session,model:'claude-sonnet-5',...(spec.noSkills ? {} : {skills:spec.skills}),terminal_slash_commands:spec.terminal_slash_commands});
    if (spec.writeChange) {
      const file=process.cwd()+'/change.txt';
      out({type:'assistant',message:{content:[{type:'tool_use',id:'edit-1',name:'Write',input:{file_path:file}}]}});
      writeFileSync(file,'after');
      out({type:'user',message:{content:[{type:'tool_result',tool_use_id:'edit-1',content:'ok'}]}});
    }
    if (spec.stall) {
      out({type:'assistant',message:{content:[{type:'tool_use',id:'stalled-1',name:'Bash',input:{command:'synthetic stalled call'}}]}});
      setInterval(()=>{},1000);continue;
    }
    if (spec.compact && text.startsWith('/compact')) {didCompact=true;out({type:'system',subtype:'compact_boundary',session_id:session,compact_metadata:{trigger:'manual',pre_tokens:spec.used ?? 176000,post_tokens:50000}});}
    if (spec.changed) out({type:'system',subtype:'commands_changed',commands:spec.changed,account:'PRIVATE_CHANGED'});
    if (didCompact && spec.holdCompact) {
      const wait=setInterval(() => {if(existsSync(home+'/compact-gate')){clearInterval(wait);end();}},25);
    } else if (text.includes('HOLD') || spec.hold) {
      out({type:'assistant',message:{content:[{type:'text',text:'WORKING'}]}});
      const wait=setInterval(() => { if(existsSync(home+'/gate')) {clearInterval(wait);end();} },25);
    } else end();
  }
});
`, { mode: 0o755 });
  h = await startHarness({ ...extraEnv, HOME: home });
  t.after(async () => { writeFileSync(join(home, "gate"), ""); await h.stop(); rmSync(home, { recursive: true, force: true }); });
  const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Keeper" }) });
  await h.json(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } }) });
  // Do not parse the child's currently unfinished JSONL frame.
  const calls = (): Call[] => existsSync(join(home, "calls.jsonl")) ? readFileSync(join(home, "calls.jsonl"), "utf8").split("\n").slice(0, -1).filter(Boolean).map((s) => JSON.parse(s)) : [];
  const busy = async () => (await h.json("/api/bots?messages=0")).bots.find((b: any) => b.id === bot.id)?.busy;
  const post = (path: string, body: unknown) => h.json(path, { method: "POST", body: JSON.stringify(body) });
  const s = {
    home, bot, calls, busy, post,
    get h() { return h; },
    spec: (change: Record<string, unknown>) => writeFileSync(join(home, "catalog.json"), JSON.stringify({ ...catalog, ...change })),
    say: (text: string, extra: Record<string, unknown> = {}) => post(`/api/bots/${bot.id}/messages`, { text, taskId: bot.threadId, ...extra }),
    messages: async (): Promise<any[]> => (await h.json(`/api/bots/${bot.id}/messages?thread=${bot.threadId}&limit=500`)).messages,
    commands: async (taskId = bot.threadId) => (await h.json(`/api/bots/${bot.id}/commands?taskId=${taskId}`)).commands as any[],
    gate: () => writeFileSync(join(home, "gate"), ""),
    async turn(text: string) { const n=calls().length+1; await s.say(text); await until(async () => calls().length >= n && !(await busy()), "turn did not settle"); return calls()[n-1]; },
    async reboot() { await h.stop(); h = await startHarness({ ...extraEnv, HOME: home }); },
  };
  return s;
}

test("driver initializes without changing permission options, drops private response fields, and refreshes only the displayed lane", async (t) => {
  const s = await setup(t);
  assert.ok((await s.commands()).some((c) => c.id === "compact" && c.kind === "command"));
  const call = await s.turn("ordinary");
  assert.deepEqual(call.wire[0].request, { subtype: "initialize" });
  assert.equal(call.wire[1].type, "user");
  assert.ok(call.argv.includes("--permission-prompt-tool"));
  assert.equal(call.argv[call.argv.indexOf("--permission-mode") + 1], "acceptEdits");
  assert.ok((await s.commands()).some((c) => c.id === "debug" && c.kind === "skill"));
  assert.ok(!(await s.commands()).some((c) => c.id === "wrong"));
  const native = readFileSync(join(s.home, ".bloks/native", `${s.bot.threadId}.ndjson`), "utf8");
  assert.doesNotMatch(native + s.h.logs() + JSON.stringify(await s.commands()), /PRIVATE_ACCOUNT|PRIVATE_MODEL|PRIVATE_STATE|WRONG_ID/);
  s.spec({ commands: [{ name: "compact", description: "Compact", builtin: true }, { name: "plugin:review", description: "Review a change", builtin: false }] });
  await s.turn("another");
  assert.deepEqual((await s.commands()).map((c) => c.id), ["compact", "plugin:review"]);
  const { bot } = await s.post(`/api/bots/${s.bot.id}/tasks`, {});
  const lane = bot.tasks.at(-1);
  assert.ok(!(await s.commands(lane.id)).some((c) => c.id === "plugin:review"));
  const invalid = await s.h.fetch(`/api/bots/${s.bot.id}/commands?taskId=unknown`);
  assert.equal(invalid.status, 404);
  s.spec({ noSkills: true }); await s.turn("missing skills");
  assert.deepEqual((await s.commands()).map((c) => c.id), ["compact", "plugin:review"], "missing init cannot erase the prior classified report");
  s.spec({ commands: rows.map(({ name, description }) => ({ name, description })) }); await s.turn("unclassified");
  assert.deepEqual((await s.commands()).map((c) => c.id), ["compact", "plugin:review"]);
});

test("commands reach stdin alone, keep the session and defer memory, personal notes and moved-CLI bookkeeping", async (t) => {
  const s = await setup(t);
  const memory = join(s.home, ".bloks/workspaces", s.bot.id, "MEMORY.md");
  mkdirSync(join(s.home, ".bloks/workspaces", s.bot.id), { recursive: true });
  writeFileSync(memory, "OLD_MEMORY");
  const first = await s.turn("hello");
  writeFileSync(memory, "NEW_MEMORY");
  await s.post("/api/profile/notes", { text: "NEW_NOTE" });
  const beforeRestart = await s.turn("/context with EXACT_ARGS");
  assert.equal(beforeRestart.text, "/context with EXACT_ARGS");
  assert.equal(beforeRestart.persona, first.persona);
  assert.equal(beforeRestart.session, first.session);
  const deferred = await s.turn("ordinary after command");
  assert.match(deferred.text, /your memory changed/);
  assert.match(deferred.text, /NEW_MEMORY/);
  assert.match(deferred.text, /NEW_NOTE/);
  assert.equal((await s.turn("ordinary once more")).text, "ordinary once more");
  // Persisted briefedCli is deliberately stale, before this command starts.
  await s.reboot();
  const botsFile = join(s.home, ".bloks/bots.json");
  await s.h.stop();
  const bots = JSON.parse(readFileSync(botsFile, "utf8"));
  const lane = bots.find((b: any) => b.id === s.bot.id).tasks.find((l: any) => l.id === s.bot.threadId);
  lane.briefedCli = "old-cli";
  writeFileSync(botsFile, JSON.stringify(bots));
  await s.reboot();
  const command = await s.turn("/compact focus on NEXT\nKeep this argument.");
  assert.equal(command.text, "/compact focus on NEXT\nKeep this argument.");
  assert.equal(command.session, first.session);
  const after = JSON.parse(readFileSync(botsFile, "utf8")).find((b: any) => b.id === s.bot.id).tasks.find((l: any) => l.id === s.bot.threadId);
  assert.equal(after.briefedCli, "old-cli");
  assert.match((await s.turn("now ordinary")).text, /old-cli/);
  const final = await s.turn("next ordinary");
  assert.equal(final.text, "next ordinary");
});

test("a local /compact error is shown, frees the lane, and never hands over", async (t) => {
  const s = await setup(t);
  s.spec({ localError: true });
  assert.equal((await s.turn("/compact")).text, "/compact");
  assert.equal(s.calls().length, 1);
  assert.equal(await s.busy(), false);
  assert.ok((await s.messages()).some((m) => m.role === "bot" && m.text === "Error: No messages to compact"));
});

test("a command leaves an undo notice for the next ordinary turn, once", async (t) => {
  const s = await setup(t);
  const desk = join(s.home, "desk");
  mkdirSync(desk);writeFileSync(join(desk, "change.txt"), "before");
  const set = await s.h.fetch(`/api/bots/${s.bot.id}`, { method: "PATCH", body: JSON.stringify({ cwd: desk }) });
  assert.equal(set.status, 200);
  s.spec({ writeChange: true });await s.turn("change the file");
  const card = await until(async () => (await s.messages()).find((m) => m.changes)?.changes, "no change card");
  const undo = await s.post(`/api/checkpoints/${card.checkpointId}/revert`, {});
  assert.deepEqual(undo.restored, ["change.txt"]);
  s.spec({});
  assert.equal((await s.turn("/context with undo pending")).text, "/context with undo pending");
  assert.match((await s.turn("ordinary after undo")).text, /the user undid your changes to: change.txt/);
  assert.equal((await s.turn("following ordinary")).text, "following ordinary");
});

test("a command leaves a stopped-tool notice for the next ordinary turn, once", async (t) => {
  const s = await setup(t, 0.05);
  s.spec({ stall: true });await s.say("start a synthetic tool");
  await until(async () => s.calls().length === 1 && !(await s.busy()), "stalled tool never settled", 20000);
  assert.ok((await s.messages()).some((m) => /synthetic stalled call.*made no progress/.test(m.text ?? "")));
  s.spec({});
  assert.equal((await s.turn("/context with stall pending")).text, "/context with stall pending");
  assert.match((await s.turn("ordinary after stall")).text, /Bloks stopped your last turn: Bash \(synthetic stalled call\)/);
  assert.equal((await s.turn("following ordinary")).text, "following ordinary");
});

test("a command whose CLI cannot start clears its guard and lets ordinary work run", async (t) => {
  const s = await setup(t);
  await s.turn("ordinary");
  const cli = join(s.home, "fake-claude.mjs");
  const source = readFileSync(cli, "utf8");rmSync(cli);
  await s.say("/context");
  await until(async () => !(await s.busy()) && (await s.messages()).some((m) => m.kind === "notice" && /is not installed/.test(m.text ?? "")), "missing CLI did not settle");
  writeFileSync(cli, source, { mode: 0o755 });
  assert.equal((await s.turn("ordinary after missing CLI")).text, "ordinary after missing CLI");
  assert.equal(s.calls().length, 2);
});

test("a native command failure cannot become a backup prompt, and its live guard clears", async (t) => {
  const s = await setup(t);
  await s.h.json(`/api/bots/${s.bot.id}`, { method: "PATCH", body: JSON.stringify({ backupSelection: { instanceId: "other", model: "claude-sonnet-5" } }) });
  s.spec({ failure: true });
  await s.turn("/context");
  assert.equal(s.calls().length, 1, "the failed command went to a backup");
  s.spec({});
  assert.ok((await s.turn("ordinary after failure")).text.endsWith("ordinary after failure"));
  assert.equal(s.calls().length, 2);
});

test("follow-ups during a command wait, while ordinary turns still accept normal steering", async (t) => {
  const s = await setup(t);
  s.spec({ hold: true });
  await s.say("/context"); await until(() => s.calls().length === 1, "command never started");
  assert.equal((await s.say("FOLLOW_UP")).queued, true);
  assert.ok(!existsSync(join(s.home, "steers.jsonl")));
  s.spec({}); s.gate();
  await until(async () => s.calls().length === 2 && !(await s.busy()), "follow-up never ran");
  assert.ok(s.calls()[1].text.endsWith("FOLLOW_UP"));
  assert.match(s.calls()[1].text, /Run the bloks command/, "the first ordinary turn gets the CLI note that the command deferred");
  rmSync(join(s.home, "gate"));
  await s.say("HOLD ordinary"); await until(() => s.calls().length === 3, "ordinary hold never started");
  assert.equal((await s.say("CHANGE_COURSE")).steered, true);
  await until(() => existsSync(join(s.home, "steers.jsonl")), "ordinary steer never reached stdin");
  assert.match(readFileSync(join(s.home, "steers.jsonl"), "utf8"), /CHANGE_COURSE/);
  s.gate();
  await until(async () => !(await s.busy()), "ordinary turn never ended");
  assert.equal(s.calls().length, 3);
});

test("a missing initialize reply does not hold the turn, and a later commands_changed replaces only command metadata", async (t) => {
  const s = await setup(t);
  s.spec({ ignoreInitialize: true }); await s.turn("no initialize reply");
  assert.ok((await s.commands()).some((c) => c.id === "compact"));
  s.spec({ changed: [{ name: "context", description: "Context", builtin: true }, { name: "new:skill", description: "Line 1\nLine 2" }] });
  await s.turn("changed catalog");
  assert.deepEqual((await s.commands()).map((c) => c.id), ["context", "new:skill"]);
  assert.equal((await s.commands()).find((c) => c.id === "new:skill").description, "Line 1 Line 2");
  assert.doesNotMatch(readFileSync(join(s.home, ".bloks/native", `${s.bot.threadId}.ndjson`), "utf8"), /PRIVATE_CHANGED/);
});

test("busy built-ins never steer and split ordinary messages into FIFO turn segments", async (t) => {
  const s = await setup(t);
  await s.say("HOLD the first turn");
  await until(() => s.calls().length === 1, "hold never started");
  for (const text of ["/context", "A", "B", "/compact args", "/usage", "D", "E"]) assert.equal((await s.say(text)).queued, true);
  assert.ok(!existsSync(join(s.home, "steers.jsonl")), "a built-in or later words were steered");
  s.gate();
  await until(async () => s.calls().length === 6 && !(await s.busy()), "segments did not drain");
  assert.deepEqual(s.calls().slice(1).map((c) => c.text), ["/context", "A\nB", "/compact args", "/usage", "D\nE"]);
  assert.equal((await s.messages()).filter((m) => m.queued && !m.deleted).length, 0);
});

test("edits derive dispatch from current text, clients cannot forge the accepting instance, and taken-back commands do not run", async (t) => {
  const s = await setup(t);
  await s.say("HOLD"); await until(() => s.calls().length === 1, "hold never started");
  for (const text of ["/compact", "words", "/usage"]) await s.say(text, { commandInstance: "other" });
  const list = await s.messages();
  const queued = list.filter((m) => m.queued);
  assert.ok(queued.every((m) => m.commandInstance === "claude"));
  const path = (m: any) => `/api/threads/${s.bot.threadId}/messages/${m.id}`;
  await s.h.json(path(queued[0]), { method: "PATCH", body: JSON.stringify({ text: "ordinary edited", commandInstance: "other" }) });
  await s.h.json(path(queued[1]), { method: "PATCH", body: JSON.stringify({ text: "/context args", commandInstance: "other" }) });
  await s.h.json(path(queued[2]), { method: "DELETE" });
  s.gate(); await until(async () => s.calls().length === 3 && !(await s.busy()), "edited turns did not drain");
  assert.deepEqual(s.calls().slice(1).map((c) => c.text), ["ordinary edited", "/context args"]);
});

test("an engine change refuses the waiting command without rerouting it, then drains ordinary words", async (t) => {
  const s = await setup(t);
  await s.say("HOLD"); await until(() => s.calls().length === 1, "hold never started");
  await s.say("/compact"); await s.say("AFTER_COMMAND");
  await s.h.json(`/api/bots/${s.bot.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "other", model: "claude-sonnet-5" } }) });
  s.gate(); await until(async () => s.calls().length === 2 && !(await s.busy()), "refusal left the suffix waiting");
  assert.ok(s.calls()[1].text.endsWith("AFTER_COMMAND"));
  assert.ok((await s.messages()).some((m) => m.kind === "notice" && m.text.includes("no longer selected")));
  assert.ok(!s.calls().some((c) => c.text === "/compact"));
});

test("drain called off without a restart dispatches each command separately", async (t) => {
  const s = await setup(t);
  assert.equal((await s.post("/api/maintenance/drain", { seconds: 60 })).draining, true);
  for (const text of ["A", "/context", "B"]) assert.equal((await s.say(text)).queued, true);
  assert.equal(s.calls().length, 0);
  await s.h.json("/api/maintenance/drain", { method: "DELETE" });
  await until(async () => s.calls().length === 3 && !(await s.busy()), "called-off drain never ran");
  assert.deepEqual(s.calls().map((c) => c.text), ["A", "/context", "B"]);
});

test("after a restart a queued command stays out of the cut-off continuation and runs once after it", async (t) => {
  const s = await setup(t);
  s.spec({ hold: true });
  await s.say("HOLD ORIGINAL"); await until(() => s.calls().length === 1, "hold never started");
  await s.say("/context ORIGINAL_ARG");
  await s.reboot();
  await until(() => s.calls().length >= 2, "pickup never ran");
  // Stop again before the queued command can run. The continuation now
  // waits for Continue, but the separately queued command still goes once.
  await s.reboot();
  await until(() => s.calls().length === 3, "command never started after the second restart");
  s.gate();
  await until(async () => s.calls().length === 3 && !(await s.busy()), "command never followed pickup");
  assert.doesNotMatch(s.calls()[1].text, /\/context/);
  assert.equal(s.calls()[2].text, "/context ORIGINAL_ARG");
  await s.reboot();
  assert.equal(s.calls().length, 3, "settled command was replayed on the next restart");
});

test("sleep pickup leaves commands separate, including words edited into a command during the pickup delay", async (t) => {
  const s = await setup(t);
  s.spec({ hold: true, failure: true, failureText: "synthetic connection closed" });
  await s.say("HOLD ORIGINAL");await until(() => s.calls().length === 1, "hold never started");
  await s.say("/context TEMP_COMMAND");
  await s.say("/compact FIRST_COMMAND");
  const words = (await s.messages()).find((m) => m.queued && m.text === "/context TEMP_COMMAND");
  assert.ok(words);
  const path = `/api/threads/${s.bot.threadId}/messages/${words.id}`;
  assert.equal((await s.h.fetch(path, { method: "PATCH", body: JSON.stringify({ text: "ordinary waiting words" }) })).status, 200);
  await s.post("/api/power", { state: "suspend" });
  await s.post("/api/power", { state: "resume" });
  s.spec({});s.gate();
  await until(async () => !(await s.busy()), "sleep failure did not settle");
  const edit = await s.h.fetch(path, { method: "PATCH", body: JSON.stringify({ text: "/usage EDITED_COMMAND" }) });
  assert.equal(edit.status, 200);
  await until(async () => s.calls().length === 4 && !(await s.busy()), "commands did not follow sleep pickup");
  assert.match(s.calls()[1].text, /computer went to sleep/i);
  assert.doesNotMatch(s.calls()[1].text, /\/context|\/usage/);
  assert.deepEqual(s.calls().slice(2).map((c) => c.text), ["/usage EDITED_COMMAND", "/compact FIRST_COMMAND"]);
  assert.equal((await s.messages()).filter((m) => m.id === words.id).length, 1);
});

test("a room command defers the room transcript until the next ordinary turn", async (t) => {
  const s = await setup(t);
  const { bot: other } = await s.post("/api/bots", { name: "Bystander" });
  const { blok } = await s.post("/api/bloks", { name: "Command room", memberIds: [s.bot.id, other.id] });
  const roomSay = async (text: string, count: number) => {
    await s.post(`/api/bloks/${blok.id}/messages`, { text });
    await until(async () => s.calls().length === count && !(await s.busy()), "room turn never ended");
    return s.calls()[count - 1];
  };
  const first = await roomSay("@Keeper FIRST_ROOM_LINE", 1);
  const command = await roomSay("/context @Keeper EXACT_ROOM_ARG", 2);
  assert.equal(command.text, "/context @Keeper EXACT_ROOM_ARG");
  assert.equal(command.persona, first.persona);
  assert.equal(command.session, first.session);
  const ordinary = await roomSay("@Keeper SECOND_ROOM_LINE", 3);
  assert.match(ordinary.text, /In this room since your last turn here/);
  assert.match(ordinary.text, /EXACT_ROOM_ARG/);
  assert.doesNotMatch(ordinary.text, /FIRST_ROOM_LINE/);
  const following = await roomSay("@Keeper THIRD_ROOM_LINE", 4);
  assert.doesNotMatch(following.text, /EXACT_ROOM_ARG|SECOND_ROOM_LINE/);
});

test("manual compact uses the original session and produces the existing compaction marker", async (t) => {
  const s = await setup(t);
  const first = await s.turn("ordinary");
  s.spec({ compact: true });
  const command = await s.turn("/compact Keep the next action");
  assert.equal(command.text, "/compact Keep the next action");
  assert.equal(command.session, first.session);
  const marker = (await s.messages()).find((m) => m.compaction);
  assert.equal(marker?.kind, "notice");
  assert.equal(marker?.text, "Compacted · 176k → 50k");
  assert.deepEqual(marker?.compaction, { before: 176000, after: 50000 });
});

test("a queued command older than the recovery window remains not sent across restarts", async (t) => {
  const s = await setup(t);
  await s.post("/api/maintenance/drain", { seconds: 60 });
  await s.say("/context STALE_COMMAND");
  await s.h.stop();
  const file = join(s.home, ".bloks", `messages-${s.bot.threadId}.json`);
  const messages = JSON.parse(readFileSync(file, "utf8"));
  const command = messages.find((m: any) => m.text === "/context STALE_COMMAND");
  command.queuedAt = Date.now() - 24 * 60 * 60_000;
  writeFileSync(file, JSON.stringify(messages));
  await s.reboot();
  const stale = (await s.messages()).find((m) => m.id === command.id);
  assert.equal(stale.unsent, true);
  assert.equal(stale.queued, false);
  assert.equal(s.calls().length, 0);
  await s.reboot();
  assert.equal(s.calls().length, 0);
});

for (const [window, used] of [[200000, 130000], [1000000, 210000]]) test(`explicit commands on a ${used}/${window} lane skip automatic compaction and keep the session`, async (t) => {
  const s = await setup(t);
  s.spec({ used, window });
  const first = await s.turn("ordinary with a full context");
  const bot = (await s.h.json("/api/bots?messages=0")).bots.find((b: any) => b.id === s.bot.id);
  assert.equal(bot.tasks.find((l: any) => l.id === s.bot.threadId).context.used, used);
  s.spec({ used, window, compact: true });
  const context = await s.turn("/context EXACT_ARG");
  assert.equal(context.text, "/context EXACT_ARG");
  assert.equal(context.session, first.session);
  assert.equal(s.calls().length, 2);
  assert.equal((await s.messages()).filter((m) => m.compaction).length, 0);
  const compact = await s.turn("/compact EXACT_ARG");
  assert.equal(compact.text, "/compact EXACT_ARG");
  assert.equal(compact.session, first.session);
  assert.equal(s.calls().length, 3, "automatic compaction ran before explicit compact");
  assert.equal((await s.messages()).filter((m) => m.compaction).length, 1);
});

const noPrivateMetadata = async (s: Awaited<ReturnType<typeof setup>>) => {
  const native = readFileSync(join(s.home, ".bloks/native", `${s.bot.threadId}.ndjson`), "utf8");
  assert.doesNotMatch(native + s.h.logs() + JSON.stringify(await s.messages()), /PRIVATE_ACCOUNT|PRIVATE_MODEL|PRIVATE_STATE/);
};

test("automatic compaction before ordinary words initializes and settles without replacing the command catalog", async (t) => {
  const s = await setup(t);
  s.spec({ used: 210000, window: 1000000 });
  const first = await s.turn("first ordinary");
  const catalog = await s.commands();
  s.spec({ used: 210000, window: 1000000, compact: true, holdCompact: true, reportByText: true });
  await s.say("ordinary after pressure");
  await until(() => s.calls().length === 2, "automatic compact never started");
  assert.equal(s.calls()[1].text, "/compact");
  assert.equal(s.calls()[1].session, first.session);
  assert.deepEqual(s.calls()[1].wire[0].request, { subtype: "initialize" });
  await until(async () => (await s.messages()).some((m) => m.compaction), "no compaction marker");
  assert.deepEqual(await s.commands(), catalog);
  await noPrivateMetadata(s);
  writeFileSync(join(s.home, "compact-gate"), "");
  await until(async () => s.calls().length === 3 && !(await s.busy()), "ordinary words did not follow compaction");
  assert.equal(s.calls()[2].text, "ordinary after pressure");
  assert.equal(s.calls()[2].session, first.session);
  assert.equal((await s.messages()).filter((m) => m.compaction).length, 1);
  assert.ok(!(await s.messages()).some((m) => m.role === "user" && m.text === "/compact"));
});

test("idle compaction initializes and settles without replacing the command catalog", async (t) => {
  const s = await setup(t, undefined, { BLOKS_IDLE_CACHE_MS: "6000" });
  await s.h.json("/api/config", { method: "PUT", body: JSON.stringify({ compaction: { idle: true, beforeTurn: 0 } }) });
  s.spec({ used: 150000, window: 1000000, compact: true, holdCompact: true, reportByText: true });
  const first = await s.turn("ordinary before idle");
  const catalog = await s.commands();
  await until(() => s.calls().length === 2, "idle compact never started", 15000);
  assert.equal(s.calls()[1].text, "/compact");
  assert.equal(s.calls()[1].session, first.session);
  assert.deepEqual(s.calls()[1].wire[0].request, { subtype: "initialize" });
  await until(async () => (await s.messages()).some((m) => m.compaction?.idle), "no idle marker");
  assert.deepEqual(await s.commands(), catalog);
  await noPrivateMetadata(s);
  writeFileSync(join(s.home, "compact-gate"), "");
  await until(async () => !(await s.busy()), "idle compact did not settle");
  assert.equal((await s.messages()).filter((m) => m.compaction?.idle).length, 1);
});

test("a fresh Claude session retains the prior report until it gets its own classified report and accepts its own queued commands", async (t) => {
  const s = await setup(t);
  const before = [{ name: "compact", description: "Compact", builtin: true }, { name: "plugin:old", description: "Old skill" }];
  s.spec({ commands: before });await s.turn("ordinary before fresh");
  assert.deepEqual((await s.commands()).map((c) => c.id), ["compact", "plugin:old"]);
  const fresh = await s.h.fetch(`/api/bots/${s.bot.id}/tasks/${s.bot.threadId}/fresh`, { method: "POST", body: "{}" });
  assert.equal(fresh.status, 200);
  s.spec({ noSkills: true });
  const next = await s.turn("ordinary in a new session");
  assert.ok(!next.argv.includes("--resume"));
  assert.deepEqual((await s.commands()).map((c) => c.id), ["compact", "plugin:old"]);
  s.spec({ commands: [{ name: "compact", description: "Compact", builtin: true }, { name: "plugin:new", description: "New skill" }] });
  await s.turn("classified new session report");
  assert.deepEqual((await s.commands()).map((c) => c.id), ["compact", "plugin:new"]);
  s.spec({ hold: true });await s.say("/context");
  await until(() => s.calls().length === 4, "command never started");
  await s.say("/usage");
  const queued = (await s.messages()).find((m) => m.queued && m.text === "/usage");
  assert.equal(queued.commandInstance, "claude");
  s.spec({});s.gate();
  await until(async () => s.calls().length === 5 && !(await s.busy()), "queued fresh-session command never ran");
  assert.equal(s.calls()[4].text, "/usage");
});

test("a command after an engine switch leaves the conversation handoff for the next ordinary turn", async (t) => {
  const s = await setup(t);
  const first = await s.turn("FIRST_ENGINE_WORK");
  await s.h.json(`/api/bots/${s.bot.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "other", model: "claude-sonnet-5" } }) });
  await s.turn("SECOND_ENGINE_WORK");
  await s.h.json(`/api/bots/${s.bot.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } }) });
  const command = await s.turn("/context");
  assert.equal(command.text, "/context");assert.equal(command.session, first.session);
  const next = await s.turn("ordinary after the switch");
  assert.match(next.text, /You are picking up this conversation mid-thread/);
  assert.match(next.text, /SECOND_ENGINE_WORK/);
  assert.doesNotMatch((await s.turn("following ordinary")).text, /SECOND_ENGINE_WORK/);
});

test("a Claude command queued with PR 1's persisted instance marker remains readable", async (t) => {
  const s = await setup(t);
  await s.say("HOLD"); await until(() => s.calls().length === 1, "the first turn did not start");
  await s.say("/compact");
  const file = join(s.home, ".bloks", `messages-${s.bot.threadId}.json`);
  const messages = JSON.parse(readFileSync(file, "utf8"));
  const queued = messages.find((m: any) => m.queued && m.text === "/compact");
  assert.equal(queued.commandInstance, "claude");
  delete queued.namedSkills; // PR 1 has only the durable instance id.
  writeFileSync(file, JSON.stringify(messages));
  s.spec({ compact: true });
  await s.reboot();
  await until(() => s.calls().some((c) => c.text === "/compact"), "the legacy queued command was not dispatched");
  assert.equal(s.calls().filter((c) => c.text === "/compact").length, 1);
});
