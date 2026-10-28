// Where an agent works, as data: the checks a place passes, the exact
// command lines Bloks runs, the shell its files travel in, the gate that
// is the only door back in, and the line a network-off container uses.
// The shell is run for real (it is this computer's own sh); docker and
// ssh never are.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, request, type IncomingMessage } from "node:http";
import { createServer as createTcpServer, connect, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";

import { redoLine } from "../src/lib/redo.ts";
import { placeLine, placeTrouble } from "../src/lib/workplace.ts";
import { signalGroup } from "../server/drivers/engine-processes.ts";
import { Gate } from "../server/workplace-gate.ts";
import { allowedTarget, frame, hostLine } from "../server/workplace-line.ts";
import { Workplaces } from "../server/workplace-run.ts";
import {
  bootstrapArgv,
  containerNameFor,
  containerSpec,
  copyPlan,
  dockerRunArgs,
  networkOffSupport,
  placeSupport,
  preambleText,
  readProbe,
  readSshHost,
  readWorkplace,
  reaperScript,
  remoteCommand,
  shippedEnv,
  shQuote,
  signedInThere,
  sshArgs,
  sshConfigHosts,
  sshProblem,
  testReport,
  type DockerImagePlace,
  type SshPlace,
} from "../server/workplace.ts";
import { fakePlaces } from "./helpers/fake-places.ts";

const LINE = fileURLToPath(new URL("../bin/bloks-line.mjs", import.meta.url));
const CLI = fileURLToPath(new URL("../bin/bloks.mjs", import.meta.url));

const image = (over: Partial<DockerImagePlace> = {}): DockerImagePlace => ({
  kind: "docker",
  source: "image",
  image: "node:22-bookworm",
  name: "bloks-scout",
  folder: "mount",
  path: "/work",
  network: true,
  idleMinutes: 15,
  autoRemove: false,
  ...over,
});

// ── reading a place ────────────────────────────────────────────────────

test("an SSH host is a name or user@host, never something ssh would read as an option", () => {
  for (const good of ["build-box", "gpu.lab.example.com", "deploy@build-box", "me@10.0.0.4", "[::1]", "ci_runner-2"]) {
    assert.equal(readSshHost(good), good, good);
  }
  // -oProxyCommand runs a command on this computer
  for (const bad of ["-oProxyCommand=sh", "-p", "me@-oProxyCommand=x", "-me@host", "two words", "host;rm -rf ~", "a\nb", "", "@host", "me@", "me@host@x"]) {
    assert.equal(readSshHost(bad), null, bad);
  }
});

test("a place a client sends is checked whole, and refused with what to fix", () => {
  assert.deepEqual(readWorkplace(null), { ok: true, place: null });
  const ssh = readWorkplace({ kind: "ssh", host: "build-box", port: "2222", path: "~/src/app/" });
  assert.deepEqual(ssh, { ok: true, place: { kind: "ssh", host: "build-box", port: 2222, path: "~/src/app", command: null } });
  assert.match((readWorkplace({ kind: "ssh", host: "build-box", port: 70_000 }) as any).error, /port/);
  assert.match((readWorkplace({ kind: "ssh", host: "build-box", path: "relative/dir" }) as any).error, /full path/);
  assert.match((readWorkplace({ kind: "ssh", host: "build-box", command: "claude --dangerously-skip-permissions" }) as any).error, /one program/);

  const made = readWorkplace({ kind: "docker", source: "image", image: "ghcr.io/me/tools:1.2", name: "bloks-scout", cpus: 2, memoryGb: "4", network: false, idleMinutes: 0, autoRemove: true });
  assert.ok(made.ok);
  assert.deepEqual(made.place, { kind: "docker", source: "image", image: "ghcr.io/me/tools:1.2", name: "bloks-scout", folder: "mount", path: "/work", cpus: 2, memoryGb: 4, network: false, idleMinutes: 0, autoRemove: true, command: null });
  // a container path is a container's, not a home's
  assert.equal(readWorkplace({ kind: "docker", source: "image", image: "x", name: "y", path: "~/w" }).ok, false);
  assert.equal(readWorkplace({ kind: "docker", source: "image", image: "x", name: "y", path: "/" }).ok, false);
  assert.equal(readWorkplace({ kind: "docker", source: "image", image: "--privileged", name: "y" }).ok, false);
  assert.equal(readWorkplace({ kind: "docker", source: "container", name: "-x" }).ok, false);
  assert.equal(readWorkplace({ kind: "docker", source: "image", image: "x", name: "y", cpus: 0 }).ok, false);
  assert.equal(readWorkplace({ kind: "docker", source: "container", name: "theirs", path: "/srv" }).ok, true);
  assert.equal(readWorkplace({ kind: "vm" }).ok, false);
});

test("a container's name starts from the agent's, and never lands on another agent's", () => {
  assert.equal(containerNameFor("Scout"), "bloks-scout");
  assert.equal(containerNameFor("Daily Brief!"), "bloks-daily-brief");
  assert.equal(containerNameFor("Scout", ["bloks-scout", "bloks-scout-2"]), "bloks-scout-3");
  assert.equal(containerNameFor("日本"), "bloks-agent");
});

test("only engines that run a program can work elsewhere, and only those with known hosts with the network off", () => {
  assert.deepEqual(placeSupport("claudeAgent"), { ok: true });
  assert.deepEqual(placeSupport("codex"), { ok: true });
  assert.deepEqual(placeSupport("geminiCli"), { ok: true });
  const api = placeSupport("grok", "Grok");
  assert.equal(api.ok, false);
  assert.match((api as any).why, /^Grok answers over the internet from Bloks itself/);
  assert.match((placeSupport("boxAgent", "Computer") as any).why, /own cloud computer/);
  assert.equal(networkOffSupport("claudeAgent").ok, true);
  assert.match((networkOffSupport("opencode", "OpenCode") as any).why, /whichever providers/);
});

// ── command lines ──────────────────────────────────────────────────────

test("docker run is made from the settings, and its spec label moves with anything that would change the container", () => {
  const on = dockerRunArgs(image({ cpus: 1.5, memoryGb: 2 }), "bot1", "/Users/me/app");
  const at = (args: string[], flag: string) => args[args.indexOf(flag) + 1];
  assert.equal(at(on, "--cpus"), "1.5");
  assert.equal(at(on, "--memory"), "2048m");
  assert.equal(at(on, "--volume"), "/Users/me/app:/work");
  assert.equal(at(on, "--add-host"), "host.docker.internal:host-gateway");
  assert.equal(at(on, "--entrypoint"), "sh");
  assert.ok(on.includes("dev.bloks.agent=bot1"));
  const off = dockerRunArgs(image({ network: false, folder: "copy" }), "bot1", "/Users/me/app");
  assert.equal(at(off, "--network"), "none");
  assert.ok(!off.includes("--add-host") && !off.includes("--volume"));
  // an idle setting does not remake the container; an image or a mount does
  const spec = containerSpec(image(), "/a");
  assert.equal(containerSpec(image({ idleMinutes: 60, autoRemove: true }), "/a"), spec);
  assert.notEqual(containerSpec(image({ image: "node:24" }), "/a"), spec);
  assert.notEqual(containerSpec(image(), "/b"), spec);
});

test("ssh is keys only, quiet links are noticed, the tunnel binds the far loopback, and the host comes after --", () => {
  const place: SshPlace = { kind: "ssh", host: "deploy@build-box", port: 2222, path: "~/app" };
  const args = sshArgs(place, ["printf", "%s"], { remotePort: 41_000, gateHost: "127.0.0.1", gatePort: 50_123 });
  assert.equal(args[0], "-T");
  for (const option of ["BatchMode=yes", "ServerAliveInterval=15", "ExitOnForwardFailure=yes"]) assert.ok(args.includes(option));
  assert.equal(args[args.indexOf("-R") + 1], "127.0.0.1:41000:127.0.0.1:50123");
  assert.equal(args[args.indexOf("-p") + 1], "2222");
  assert.equal(args.at(-3), "--");
  assert.equal(args.at(-2), "deploy@build-box");
  assert.equal(args.at(-1), "'printf' '%s'");
  assert.ok(!sshArgs({ ...place, port: null }, ["x"]).includes("-R"));
});

test("the remote command line survives the far shell exactly, whatever is in it", async () => {
  const nasty = ["it's", '"quoted"', "$(touch /tmp/never)", "`touch /tmp/never`", "a b\tc", "back\\slash", "new\nline", ""];
  const words = ["printf", "[%s]\\n", ...nasty];
  const line = words.map(shQuote).join(" ");
  const out = await run("sh", ["-c", line]);
  assert.equal(out.stdout, nasty.map((word) => `[${word}]\n`).join(""));
});

test("ssh failures read as what to do", () => {
  const place: SshPlace = { kind: "ssh", host: "build-box", path: "~" };
  assert.match(sshProblem("Host key verification failed.", place), /host key/);
  assert.match(sshProblem("me@build-box: Permission denied (publickey).", place), /keys only.*ssh-copy-id build-box/);
  assert.match(sshProblem("ssh: Could not resolve hostname build-box: nodename", place), /could not find build-box/);
  assert.match(sshProblem("ssh: connect to host build-box port 22: Connection refused", place), /refused the connection on port 22/);
  assert.match(sshProblem("Warning: remote port forwarding failed for listen port 41000", place), /AllowTcpForwarding/);
});

test("an ssh config's hosts are the ones that can be connected to", () => {
  const text = "Host build-box gpu\n  HostName 10.0.0.2\nHost *.internal !bad\nhost   lab # comment\nMatch host x\nHost -oProxyCommand=x\n";
  assert.deepEqual(sshConfigHosts(text), ["build-box", "gpu", "lab"]);
});

test("the engine's command there is its own name, not this computer's path to it", () => {
  assert.equal(remoteCommand({ kind: "ssh", host: "h", path: "~" }, "/Users/me/.local/bin/claude"), "claude");
  assert.equal(remoteCommand({ kind: "ssh", host: "h", path: "~" }, "C:\\npm\\codex.cmd"), "codex");
  assert.equal(remoteCommand({ kind: "ssh", host: "h", path: "~", command: "/opt/claude/bin/claude" }, "claude"), "/opt/claude/bin/claude");
});

// ── the environment ────────────────────────────────────────────────────

test("only the turn's own environment and the driver's switches cross, never a key or this computer's", () => {
  const shipped = shippedEnv(
    { BLOKS_TOKEN: "blk_1", BLOKS_URL: "http://127.0.0.1:4000", MY_SAVED_SECRET: "s", OPENAI_API_KEY: "sk-saved", "bad name": "x" },
    {
      PATH: "/here/only",
      HOME: "/Users/me",
      AWS_SECRET_ACCESS_KEY: "aws",
      ANTHROPIC_API_KEY: "sk-ant",
      BLOKS_COMPOSIO_KEY: "ck",
      CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
      CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1",
      NPM_CONFIG_LOGLEVEL: "error",
    },
    { PATH: "/here/only", HOME: "/Users/me", AWS_SECRET_ACCESS_KEY: "aws", NPM_CONFIG_LOGLEVEL: "error" },
  );
  assert.deepEqual(shipped, {
    BLOKS_TOKEN: "blk_1",
    BLOKS_URL: "http://127.0.0.1:4000",
    MY_SAVED_SECRET: "s",
    CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
    CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1",
  });
});

// ── the bootstrap, run for real ────────────────────────────────────────

test("files and environment travel ahead of the engine on its stdin, and the engine reads exactly what comes after", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "bloks-boot-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const sentinel = "__bloks_go_test__";
  const run = join(home, ".bloks", "run", "r1");
  const persona = [
    "You are Scout.",
    "it's $(touch " + join(home, "pwned") + ") and `touch " + join(home, "pwned2") + "`",
    "__bloks_go_not_this_one__",
    '"double" and \\ backslash',
    "",
    "last line without a newline",
  ].join("\n");
  const preamble = preambleText({
    tag: "r1-1",
    run,
    sentinel,
    files: [{ path: `${run}/system.md`, content: persona }],
    env: { BLOKS_TOKEN: "blk_x y'z", "not ok": "dropped" },
    folders: [`${home}/.bloks/outbox/lane`],
    cwd: join(home, "made", "here"),
  });
  const engine = [
    "const fs = require('node:fs');",
    "let input = '';",
    "process.stdin.on('data', (c) => (input += c));",
    "process.stdin.on('end', () => process.stdout.write(JSON.stringify({",
    "  file: fs.readFileSync(process.argv[1], 'utf8'), token: process.env.BLOKS_TOKEN, run: process.env.BLOKS_RUN,",
    "  cwd: process.cwd(), input, pid: process.pid })));",
  ].join("\n");
  // run exactly as ssh would hand it to the far login shell
  const argv = bootstrapArgv(sentinel, process.execPath, ["-e", engine, `${run}/system.md`]);
  const out = await run_("sh", ["-c", argv.map(shQuote).join(" ")], { HOME: home, PATH: process.env.PATH ?? "" }, preamble + '{"type":"user"}\nsecond line\n');
  const said = JSON.parse(out.stdout);
  assert.equal(said.file, persona);
  assert.equal(said.token, "blk_x y'z");
  assert.equal(said.run, "r1-1");
  assert.equal(said.input, '{"type":"user"}\nsecond line\n', "the engine lost or gained input");
  assert.ok(said.cwd.endsWith(join("made", "here")));
  assert.ok(!existsSync(join(home, "pwned")) && !existsSync(join(home, "pwned2")), "content in a file was run");
  assert.equal(Number(readFileSync(join(run, "pid-r1-1"), "utf8")), said.pid, "the bootstrap did not become the engine");
  assert.ok(existsSync(join(home, ".bloks", "outbox", "lane")));
});

test("the reaper ends the engine its run started and takes its folder, and leaves a pid that is no longer its alone", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "bloks-reap-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const run = join(home, "run");
  const sentinel = "__go__";
  const child = spawn("sh", bootstrapArgv(sentinel, process.execPath, ["-e", "setInterval(() => {}, 1000)"]).slice(1), {
    env: { HOME: home, PATH: process.env.PATH ?? "" },
    stdio: ["pipe", "ignore", "ignore"],
    detached: true,
  });
  child.stdin.write(preambleText({ tag: "t1", run, sentinel, files: [], env: {}, folders: [], cwd: home }));
  for (let i = 0; i < 100 && !existsSync(join(run, "pid-t1")); i++) await new Promise((r) => setTimeout(r, 30));
  const exited = new Promise((resolve) => child.once("exit", resolve));
  await run_("sh", ["-c", reaperScript(run, "t1", true)], { PATH: process.env.PATH ?? "" });
  await exited;
  assert.ok(!existsSync(run), "the run folder is still there");
});

// ── what a probe says ──────────────────────────────────────────────────

test("a probe reads as checks, and each problem as one thing to do", () => {
  const probe = readProbe(
    "home=/home/dev\nengine=/home/dev/.local/bin/claude\nversion=2.1.299 (Claude Code)\nnode=\ntar=/usr/bin/tar\nfolder=missing\nauth=" +
      JSON.stringify({ loggedIn: false }) +
      "\nbloks=yes\n",
  );
  assert.equal(signedInThere("claudeAgent", probe), false);
  const place: SshPlace = { kind: "ssh", host: "build-box", path: "~/app" };
  const report = testReport({ place, driverKind: "claudeAgent", engineName: "Claude Code", command: "claude", probe, localSignIn: true, line: "tunnel" });
  assert.equal(report.ok, false);
  assert.equal(report.signIn?.command, "ssh -t build-box 'claude'");
  assert.equal(report.canCopySignIn, true);
  assert.match(report.problems[0], /^Claude Code is installed on build-box but not signed in\. Sign in there \(ssh -t build-box 'claude'\), or copy your sign-in from this computer\.$/);
  assert.match(report.problems[1], /Node is not on build-box, so the agent's bloks command cannot run there/);
  assert.equal(report.checks.find((c) => c.id === "folder")?.ok, true, "a folder that is not there yet is made");
  assert.equal(report.checks.find((c) => c.id === "bloks")?.ok, true);

  const lineMode = testReport({ place: image({ network: false }), driverKind: "codex", engineName: "Codex", command: "codex", probe: readProbe("home=/root\nengine=\nfolder=ok\n"), install: "npm i -g @openai/codex", localSignIn: false, line: "line" });
  assert.match(lineMode.problems[0], /^Codex is not installed in container bloks-scout, or not as codex\. Install it there: docker exec -it bloks-scout sh -lc 'npm i -g @openai\/codex'$/);
  assert.match(lineMode.problems.join(" "), /With the network off, Bloks reaches the container through a small Node program/);
});

test("a copy plan names both ends, says what it means, and its fingerprint is the plan", () => {
  const place: SshPlace = { kind: "ssh", host: "build-box", path: "~" };
  const plan = copyPlan({ place, driverKind: "codex", engineName: "Codex", home: "/home/dev", found: [{ rel: ".codex/auth.json", bytes: 400 }] });
  assert.deepEqual(plan.files, [{ from: "~/.codex/auth.json", to: "/home/dev/.codex/auth.json", bytes: 400 }]);
  assert.match(plan.says, /^Bloks will copy ~\/\.codex\/auth\.json from this computer to \/home\/dev\/\.codex\/auth\.json on build-box over SSH\./);
  assert.match(plan.says, /anyone who can use build-box can then use it as you/);
  const other = copyPlan({ place, driverKind: "codex", engineName: "Codex", home: "/home/other", found: [{ rel: ".codex/auth.json", bytes: 400 }] });
  assert.notEqual(other.fingerprint, plan.fingerprint);
});

// ── the gate ───────────────────────────────────────────────────────────

async function mainStub() {
  const seen: Array<{ url: string; headers: IncomingMessage["headers"]; body: string }> = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ url: req.url ?? "", headers: req.headers, body });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { seen, port: (server.address() as AddressInfo).port, close: () => server.close() };
}

const ECHO_MCP = `
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let at;
  while ((at = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.method === "initialize") process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { serverInfo: { name: "echo" }, capabilities: { tools: {} } } }) + "\\n");
    else if (m.method === "tools/list") process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "approve" }], env: process.env.ECHO_ENV ?? null } }) + "\\n");
    else if (m.method === "slow") setTimeout(() => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: "late" }) + "\\n"), 200);
  }
});`;

test("the gate answers only a running turn's own token, and passes on only what the CLI needs", async (t) => {
  const main = await mainStub();
  let alive = true;
  const gate = new Gate({ mainPort: () => main.port, live: () => alive });
  t.after(async () => {
    main.close();
    await gate.dispose();
  });
  const port = await gate.listen();
  gate.open({ botId: "b1", laneId: "lane1", tokens: ["blk_turn"], servers: new Map() });
  const call = (path: string, headers: Record<string, string> = {}, method = "GET", body?: string) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
      });
      req.on("error", reject);
      req.end(body);
    });

  assert.equal((await call("/api/gate/ping")).status, 200);
  assert.equal((await call("/api/bots")).status, 401, "no token");
  assert.equal((await call("/api/bots", { authorization: "Bearer blk_other" })).status, 401, "a token that is not this turn's");
  assert.equal((await call("/api/bots", {}, "OPTIONS")).status, 405);
  assert.equal(main.seen.length, 0, "a refused request reached the workspace");

  const passed = await call(
    "/api/bots/b1/memory",
    {
      authorization: "Bearer blk_turn",
      "content-type": "application/json",
      origin: "http://host.docker.internal:4000",
      cookie: "session=1",
      "x-forwarded-for": "10.0.0.9",
      "x-bloks-relay-device": "phone",
      host: "host.docker.internal:4000",
    },
    "PUT",
    '{"text":"hi"}',
  );
  assert.equal(passed.status, 200);
  const got = main.seen[0];
  assert.equal(got.url, "/api/bots/b1/memory");
  assert.equal(got.body, '{"text":"hi"}');
  assert.equal(got.headers.authorization, "Bearer blk_turn");
  assert.equal(got.headers.host, `127.0.0.1:${main.port}`);
  for (const dropped of ["origin", "cookie", "x-forwarded-for", "x-bloks-relay-device"]) assert.equal(got.headers[dropped], undefined, `${dropped} was passed on`);

  // not a path the gate serves, token or not
  assert.equal((await call("/", { authorization: "Bearer blk_turn" })).status, 404);
  // once the workspace says the turn is over, its token is spent here too
  alive = false;
  assert.equal((await call("/api/bots", { authorization: "Bearer blk_turn" })).status, 401);
  alive = true;
  gate.close("lane1");
  assert.equal((await call("/api/bots", { authorization: "Bearer blk_turn" })).status, 401, "a closed turn's token still worked");
});

test("a stdio MCP server runs here and is spoken to the far side as streamable HTTP, sessions and all", async (t) => {
  const gate = new Gate({ mainPort: () => 9, live: () => true });
  t.after(() => gate.dispose());
  const port = await gate.listen();
  const servers = new Map([["echo-1", { transport: "stdio" as const, command: process.execPath, args: ["-e", ECHO_MCP], env: { ECHO_ENV: "kept here" } }]]);
  gate.open({ botId: "b1", laneId: "lane1", tokens: ["blg_gate"], servers });
  const base = `http://127.0.0.1:${port}/mcp/echo-1`;
  const post = (body: unknown, session?: string, token = "blg_gate") =>
    fetch(base, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream", ...(session ? { "mcp-session-id": session } : {}) }, body: JSON.stringify(body) });
  const events = async (res: Response) => (await res.text()).split("\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6)));

  assert.equal((await post({ jsonrpc: "2.0", id: 1, method: "tools/list" })).status, 404, "a request before initialize had a session");
  const init = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  assert.equal(init.headers.get("content-type"), "text/event-stream");
  const session = init.headers.get("mcp-session-id")!;
  assert.ok(session);
  assert.equal((await events(init))[0].result.serverInfo.name, "echo");
  assert.equal((await post({ jsonrpc: "2.0", method: "notifications/initialized" }, session)).status, 202);
  const listed = await events(await post({ jsonrpc: "2.0", id: 2, method: "tools/list" }, session));
  assert.deepEqual(listed[0].result.tools, [{ name: "approve" }]);
  assert.equal(listed[0].result.env, "kept here", "the server's own environment did not reach it");
  // two at once, answered on their own streams by id
  const [a, b] = await Promise.all([post({ jsonrpc: "2.0", id: "s", method: "slow" }, session), post({ jsonrpc: "2.0", id: 3, method: "tools/list" }, session)]);
  assert.equal((await events(a))[0].result, "late");
  assert.equal((await events(b))[0].id, 3);
  // a session is the token's own
  assert.equal((await post({ jsonrpc: "2.0", id: 4, method: "tools/list" }, session, "blg_other")).status, 401);
  // the turn ends: its sessions go with it
  gate.close("lane1");
  assert.equal((await post({ jsonrpc: "2.0", id: 5, method: "tools/list" }, session)).status, 401);
});

// ── the line ───────────────────────────────────────────────────────────

test("the proxy end of the line lets through only the engine's own hosts on 443", () => {
  const hosts = ["api.anthropic.com"];
  assert.equal(allowedTarget("api.anthropic.com:443", hosts), true);
  assert.equal(allowedTarget("API.ANTHROPIC.COM:443", hosts), true);
  assert.equal(allowedTarget("api.anthropic.com:80", hosts), false);
  assert.equal(allowedTarget("evil.com:443", hosts), false);
  assert.equal(allowedTarget("api.anthropic.com.evil.com:443", hosts), false);
  assert.equal(allowedTarget("127.0.0.1:443", hosts), false);
});

test("the line, run for real, carries Bloks' opening to the gate and refuses the proxy anywhere else", async (t) => {
  // the gate's stand-in: says who reached it
  const gate = createTcpServer((socket) => socket.end("gate here\n"));
  await new Promise<void>((r) => gate.listen(0, "127.0.0.1", r));
  // the engine's service's stand-in, reached only through an allowed CONNECT
  const service = createTcpServer((socket) => socket.end("service here\n"));
  await new Promise<void>((r) => service.listen(0, "127.0.0.1", r));
  const dialled: string[] = [];
  const bloksPort = 30_000 + Math.floor(Math.random() * 10_000);
  const proxyPort = bloksPort + 1;
  const child = spawn(process.execPath, [LINE, String(bloksPort), String(proxyPort)], { stdio: ["pipe", "pipe", "inherit"] });
  t.after(() => {
    child.kill();
    gate.close();
    service.close();
  });
  const line = hostLine(child, {
    gate: { host: "127.0.0.1", port: (gate.address() as AddressInfo).port },
    hosts: ["api.anthropic.com"],
    dial: ((options: { host: string; port: number }) => {
      dialled.push(`${options.host}:${options.port}`);
      // the allowed service is this computer's stand-in
      return options.host === "api.anthropic.com" ? connect((service.address() as AddressInfo).port, "127.0.0.1") : connect(options.port, options.host);
    }) as any,
  });
  assert.deepEqual(await line.ready, { bloksPort, proxyPort });
  const talk = (port: number, write?: string) =>
    new Promise<string>((resolve) => {
      const socket = connect(port, "127.0.0.1", () => write && socket.write(write));
      let said = "";
      socket.on("data", (d) => (said += d));
      socket.on("close", () => resolve(said));
      socket.on("error", () => resolve(said));
      setTimeout(() => socket.destroy(), 1_500);
    });
  assert.equal(await talk(bloksPort), "gate here\n");
  assert.match(await talk(proxyPort, "CONNECT evil.com:443 HTTP/1.1\r\n\r\n"), /^HTTP\/1\.1 403/);
  assert.match(await talk(proxyPort, "GET http://api.anthropic.com/ HTTP/1.1\r\n\r\n"), /^HTTP\/1\.1 403/);
  assert.match(await talk(proxyPort, "CONNECT api.anthropic.com:443 HTTP/1.1\r\n\r\n"), /^HTTP\/1\.1 200 Connection Established\r\n\r\nservice here\n/);
  assert.ok(!dialled.some((target) => target.startsWith("evil.com")), "the proxy dialled somewhere it refused");
  line.close();
});

test("frames carry their type, connection and length", () => {
  const bytes = frame(3, 7, Buffer.from("hi"));
  assert.deepEqual([...bytes], [3, 0, 0, 0, 7, 0, 0, 0, 2, 104, 105]);
  // a stream that never says READY is not ready
  const stdout = new PassThrough();
  const ready = hostLine({ stdin: new PassThrough(), stdout }, { gate: { host: "127.0.0.1", port: 9 }, hosts: [] }).ready;
  stdout.end(frame(5, 0, Buffer.from("EADDRINUSE")));
  return assert.rejects(ready, /EADDRINUSE/);
});

// ── a file missing from this install ───────────────────────────────────

/**
 * Turns in a container through docker's stand-in (test/helpers/
 * fake-places.ts), with the line and the agent's command line as files a
 * test can take away. Every command started there is written down as it
 * is started, before it could say so itself.
 */
function missingFileTurns(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "bloks-missing-"));
  const fake = fakePlaces(root, join(root, "seen.json"));
  fake.setDocker({ containers: { "bloks-quiet": { running: true } } });
  // the stand-in finds its state and the far side in the environment it
  // is started with, which is this process's
  const named = ["FAKE_DOCKER_LOG", "FAKE_DOCKER_STATE", "FAKE_HOME", "FAKE_THERE_PATH"];
  for (const name of named) process.env[name] = fake.env[name];
  const lineFile = join(root, "bloks-line.mjs");
  const cliFile = join(root, "bloks.mjs");
  copyFileSync(LINE, lineFile);
  copyFileSync(CLI, cliFile);
  const gate = new Gate({ mainPort: () => 9, live: () => true });
  const places = new Workplaces({ gate, lineFile, cliFile, docker: join(fake.bin, "docker"), onStatus: () => {} });
  const started: Array<{ argv: readonly string[]; child: ChildProcess }> = [];
  const start = places["start"].bind(places);
  places["start"] = (place, argv, tunnel) => {
    const child = start(place, argv, tunnel);
    started.push({ argv, child });
    return child;
  };
  t.after(async () => {
    // whatever was started there goes, and is waited for, however the test went
    await places.dispose();
    await Promise.all(
      started
        .filter(({ child }) => child.exitCode === null && child.signalCode === null)
        .map(({ child }) => {
          const gone = once(child, "exit");
          signalGroup(child, "SIGKILL");
          return gone;
        }),
    );
    await gate.dispose();
    for (const name of named) delete process.env[name];
    rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  });
  const begin = (env: Record<string, string>, network = false) =>
    places.begin({
      bot: { id: "b1", name: "Scout" },
      laneId: "lane1",
      place: image({ name: "bloks-quiet", folder: "copy", network, idleMinutes: 0 }),
      driverKind: "claudeAgent",
      home: fake.home,
      env: { BLOKS_URL: "http://127.0.0.1:9", ...env },
      tokens: ["blk_turn"],
      texts: ["Quietly."],
    });
  // nothing of the turn is left open: no gate to it, no run kept for it
  const closed = () => {
    assert.equal(gate.openTurns(), 0);
    assert.equal(places.running("b1"), 0);
    assert.equal(places.runOf("lane1"), null);
  };
  return { lineFile, cliFile, started, begin, closed, gate, places };
}

const LINE_STARTED = /\/line\.mjs \d+ \d+$/;

test("a missing line fails a network-off turn before anything starts there, and the lane works once it is back", async (t) => {
  const { lineFile, started, begin, closed, gate, places } = missingFileTurns(t);
  rmSync(lineFile);
  await assert.rejects(begin({ BLOKS_TOKEN: "blk_turn" }), { code: "ENOENT", path: lineFile });
  assert.equal(started.length, 0, "a docker exec was started for a turn that could not run");
  closed();
  // the same lane again with the file back: the line comes up, and goes with the turn
  copyFileSync(LINE, lineFile);
  await begin({ BLOKS_TOKEN: "blk_turn" });
  assert.equal(started.length, 1);
  assert.match(started[0].argv.join(" "), LINE_STARTED);
  assert.equal(gate.openTurns(), 1);
  assert.ok(places.runOf("lane1"));
  const gone = once(started[0].child, "exit");
  await places.end("lane1", null);
  closed();
  await gone;
});

test("a missing command line fails a turn that would carry it before anything starts there", async (t) => {
  const { cliFile, started, begin, closed } = missingFileTurns(t);
  rmSync(cliFile);
  // either of the turn's tokens takes the agent's command line along
  for (const env of [{ BLOKS_TOKEN: "blk_turn" }, { BLOKS_REPLY_TOKEN: "blk_reply" }] as Array<Record<string, string>>) {
    await assert.rejects(begin(env), { code: "ENOENT", path: cliFile });
    assert.equal(started.length, 0, "a docker exec was started for a turn that could not run");
    closed();
  }
});

test("a turn needs only the files it uses: no line with the network on, no command line without a token", async (t) => {
  const { lineFile, cliFile, started, begin, closed, places } = missingFileTurns(t);
  rmSync(lineFile);
  await begin({ BLOKS_TOKEN: "blk_turn" }, true);
  assert.equal(started.length, 0);
  await places.end("lane1", null);
  closed();
  copyFileSync(LINE, lineFile);
  rmSync(cliFile);
  await begin({});
  assert.match(started.at(-1)!.argv.join(" "), LINE_STARTED);
  await places.end("lane1", null);
  closed();
});

// ── the header's words ─────────────────────────────────────────────────

test("the header says where an agent works, and a lost connection as one", () => {
  const box = { kind: "docker" as const, label: "container bloks-scout", at: 0 };
  const host = { kind: "ssh" as const, label: "build-box", at: 0 };
  assert.equal(placeLine(null, true), null);
  assert.equal(placeLine({ ...box, state: "ready" }, true), "Working in container bloks-scout");
  assert.equal(placeLine({ ...box, state: "idle" }, false), "In container bloks-scout");
  assert.equal(placeLine({ ...box, state: "starting" }, true), "Starting container bloks-scout");
  assert.equal(placeLine({ ...box, state: "stopped" }, false), "Container bloks-scout is stopped");
  assert.equal(placeLine({ ...host, state: "working" }, true), "Working on build-box over SSH");
  assert.equal(placeLine({ ...host, state: "ready" }, false), "On build-box over SSH");
  assert.equal(placeLine({ ...host, state: "dropped" }, false), "Lost build-box, reconnecting");
  assert.equal(placeLine({ ...host, state: "unreachable" }, false), "Cannot reach build-box");
  assert.equal(placeTrouble({ ...host, state: "reconnecting" }), true);
  assert.equal(placeTrouble({ ...host, state: "ready" }), false);
});

test("taking a message back from an agent working elsewhere says its files there stay", () => {
  const offer = { offered: true as const, messages: 2, files: 0, sent: false, working: false, resend: 1, filesElsewhere: "on build-box over SSH" };
  assert.equal(redoLine(offer, "Scout"), "Removes 2 messages. Files it changed on build-box over SSH stay as they are.");
  assert.equal(redoLine({ ...offer, working: true }, "Scout"), "Stops Scout and removes 2 messages. Files it changed on build-box over SSH stay as they are.");
});

// ── helpers ────────────────────────────────────────────────────────────

function run_(command: string, args: string[], env?: Record<string, string>, input?: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env: env ?? process.env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.on("error", () => {});
    child.stdin.end(input ?? "");
  });
}
const run = (command: string, args: string[]) => run_(command, args);
