// Stand-ins for docker and ssh, and an engine to run on their far side.
//
// The tests for agents that work elsewhere (test/workplace-*.test.ts)
// never reach a real container or a real host. These go first on the
// harness's PATH instead: each one writes down how it was called, and
// then does what the real one would, here, with this computer as the
// "other side". `docker exec -i` and `ssh -T` run the command they were
// given with their stdio passed straight through, which is the property
// the feature rests on; `ssh -R` opens the reverse tunnel as a plain
// local forward, so the engine on the far side reaches Bloks' gate the
// way it would through a real one.
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface FakePlaces {
  /** Folder of stand-ins to put first on PATH. */
  bin: string;
  /** Folder for the far side's programs (the fake engine, node). */
  there: string;
  /** The far side's home. */
  home: string;
  dockerLog: string;
  sshLog: string;
  dockerState: string;
  sshControl: string;
  /** Environment the harness passes on to the stand-ins. */
  env: Record<string, string>;
  dockerCalls(): string[][];
  sshCalls(): string[][];
  /** Set what the fake docker knows: containers and so on. */
  setDocker(state: Record<string, unknown>): void;
  docker(): any;
  /** Set how the fake ssh behaves on its next calls. */
  setSsh(control: { fail?: string; dropAfterMs?: number }): void;
}

const lines = (file: string) => {
  try {
    return readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]);
  } catch {
    return [];
  }
};

/** A stand-in docker: enough of `version`, `inspect`, `run`, `start`,
 * `stop`, `rm`, `cp`, `network inspect` and `exec -i` for Bloks. A
 * container's filesystem is this computer's; its home is FAKE_HOME. */
const DOCKER = (node: string) => `#!${node}
import { appendFileSync, cpSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_DOCKER_LOG, JSON.stringify(args) + "\\n");
const file = process.env.FAKE_DOCKER_STATE;
const read = () => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return { containers: {} }; } };
const save = (s) => writeFileSync(file, JSON.stringify(s));
const state = read();
state.containers ??= {};
const [verb] = args;
const fail = (text, code = 1) => { process.stderr.write(text + "\\n"); process.exit(code); };
if (verb === "version") { if (state.down) fail("Cannot connect to the Docker daemon"); console.log("27.0.0"); process.exit(0); }
if (verb === "inspect") {
  const name = args.at(-1);
  const c = state.containers[name];
  if (!c) fail("Error: No such container: " + name);
  const label = (k) => (c.labels ?? {})[k] ?? "<no value>";
  console.log([c.running ? "true" : "false", label("dev.bloks.agent"), label("dev.bloks.spec")].join("|"));
  process.exit(0);
}
if (verb === "network") { console.log(state.bridge ?? ""); process.exit(0); }
if (verb === "run") {
  let i = 1; const labels = {}; let name = ""; const flags = [];
  while (i < args.length && args[i].startsWith("--")) {
    const flag = args[i];
    if (flag === "--detach") { i++; continue; }
    const value = args[i + 1];
    flags.push([flag, value]);
    if (flag === "--name") name = value;
    if (flag === "--label") { const [k, v] = value.split("="); labels[k] = v; }
    i += 2;
  }
  const image = args[i];
  if ((state.missingImages ?? []).includes(image)) fail("Unable to find image '" + image + "' locally", 125);
  if (state.containers[name]) fail("Conflict. The container name is already in use", 125);
  state.containers[name] = { running: true, labels, image, flags };
  save(state);
  console.log("c0ffee");
  process.exit(0);
}
if (verb === "start") { const c = state.containers[args[1]]; if (!c) fail("No such container"); c.running = true; save(state); process.exit(0); }
if (verb === "stop") { const c = state.containers[args.at(-1)]; if (c) { c.running = false; save(state); } process.exit(0); }
if (verb === "rm") { delete state.containers[args.at(-1)]; save(state); process.exit(0); }
if (verb === "cp") {
  const [, from, to] = args;
  const at = to.indexOf(":");
  cpSync(from.replace(/[\\\\/]\\.$/, ""), to.slice(at + 1), { recursive: true });
  process.exit(0);
}
if (verb === "exec") {
  let i = 1;
  while (args[i] === "-i" || args[i] === "-it") i++;
  const name = args[i];
  const c = state.containers[name];
  if (!c || !c.running) fail("Error response from daemon: container " + name + " is not running");
  const child = spawn(args[i + 1], args.slice(i + 2), { stdio: "inherit", env: { PATH: process.env.FAKE_THERE_PATH, HOME: process.env.FAKE_HOME } });
  for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => child.kill(signal));
  child.on("exit", (code, signal) => process.exit(code ?? (signal ? 137 : 1)));
} else fail("fake docker does not know " + verb);
`;

/** A stand-in ssh: records argv, opens -R as a local forward, and runs
 * the remote command through sh here, with FAKE_HOME as the far home. */
const SSH = (node: string) => `#!${node}
import { appendFileSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createServer, connect } from "node:net";
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_SSH_LOG, JSON.stringify(args) + "\\n");
let control = {};
try { control = JSON.parse(readFileSync(process.env.FAKE_SSH_CONTROL, "utf8")); } catch {}
let i = 0; let forward = null;
while (i < args.length && args[i] !== "--") {
  if (args[i] === "-R") { forward = args[i + 1]; i += 2; continue; }
  if (args[i] === "-o" || args[i] === "-p") { i += 2; continue; }
  i++;
}
const host = args[i + 1];
const command = args[i + 2];
if (control.fail) { process.stderr.write(control.fail + "\\n"); process.exit(255); }
const run = () => {
  const child = spawn("sh", ["-c", command], { stdio: "inherit", env: { PATH: process.env.FAKE_THERE_PATH, HOME: process.env.FAKE_HOME } });
  for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => { child.kill(signal); process.exit(1); });
  if (control.dropAfterMs && command.includes("__bloks_go_")) {
    setTimeout(() => {
      child.kill("SIGKILL");
      process.stderr.write("Connection to " + host + " closed by remote host.\\n");
      process.exit(255);
    }, control.dropAfterMs);
  }
  child.on("exit", (code) => process.exit(code ?? 1));
};
if (forward) {
  const [bindHost, port, toHost, toPort] = forward.split(":");
  const server = createServer((socket) => {
    const out = connect(Number(toPort), toHost);
    socket.pipe(out).pipe(socket);
    out.on("error", () => socket.destroy());
    socket.on("error", () => out.destroy());
  });
  server.on("error", (e) => { process.stderr.write("Error: remote port forwarding failed for listen port " + port + "\\n"); process.exit(255); });
  server.listen(Number(port), bindHost, run);
} else run();
`;

/**
 * An engine for the far side, which answers like Claude Code's
 * stream-json: on its first user frame it writes down where it ran and
 * what it was handed, reaches Bloks through the gate the way an agent's
 * command line would, opens its MCP bridge, saves a deliverable to its
 * outbox, and answers.
 */
export const FAKE_ENGINE = (node: string, seen: string) => `#!${node}
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("2.1.299 (Claude Code)"); process.exit(0); }
const signedOut = existsSync(join(process.env.HOME ?? "", ".signed-out"));
if (args[0] === "auth") { console.log(JSON.stringify({ loggedIn: !signedOut })); process.exit(signedOut ? 1 : 0); }
const value = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : null);
const near = (url) => url.replace("host.docker.internal", "127.0.0.1");
const sse = async (response) => {
  const text = await response.text();
  return text.split("\\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6)));
};
let buffer = "";
let done = false;
process.stdin.on("data", async (chunk) => {
  buffer += chunk;
  if (done || !buffer.split("\\n").some((l) => { try { return JSON.parse(l).type === "user"; } catch { return false; } })) return;
  done = true;
  const out = { args, cwd: process.cwd(), env: {
    BLOKS_URL: process.env.BLOKS_URL ?? null,
    BLOKS_CLI: process.env.BLOKS_CLI ?? null,
    BLOKS_OUTBOX: process.env.BLOKS_OUTBOX ?? null,
    HTTPS_PROXY: process.env.HTTPS_PROXY ?? null,
    token: Boolean(process.env.BLOKS_TOKEN),
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? null,
    BLOKS_COMPOSIO_KEY: process.env.BLOKS_COMPOSIO_KEY ?? null,
    FAKE_SECRET_HERE: process.env.FAKE_SECRET_HERE ?? null,
  } };
  const mcpFile = value("--mcp-config");
  out.mcp = mcpFile && existsSync(mcpFile) ? JSON.parse(readFileSync(mcpFile, "utf8")) : null;
  out.persona = value("--append-system-prompt-file") ? readFileSync(value("--append-system-prompt-file"), "utf8") : null;
  out.cliThere = process.env.BLOKS_CLI ? existsSync(process.env.BLOKS_CLI) : false;
  out.input = buffer;
  try {
    const base = near(process.env.BLOKS_URL ?? "");
    const who = await fetch(base + "/api/agent/whoami", { headers: { authorization: "Bearer " + process.env.BLOKS_TOKEN } });
    out.whoami = { status: who.status, body: await who.json() };
    const bare = await fetch(base + "/api/bots");
    out.bare = bare.status;
    const forged = await fetch(base + "/api/bots", { headers: { authorization: "Bearer blk_not_a_real_token" } });
    out.forged = forged.status;
    const bridge = out.mcp?.mcpServers?.bloks;
    if (bridge?.url) {
      const post = (body, session) => fetch(near(bridge.url), { method: "POST", headers: { ...bridge.headers, "content-type": "application/json", accept: "application/json, text/event-stream", ...(session ? { "mcp-session-id": session } : {}) }, body: JSON.stringify(body) });
      const init = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake", version: "1" } } });
      const session = init.headers.get("mcp-session-id");
      out.init = (await sse(init))[0] ?? null;
      const listed = await post({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, session);
      out.tools = ((await sse(listed))[0]?.result?.tools ?? []).map((t) => t.name);
      const stranger = await fetch(near(bridge.url), { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      out.bridgeWithoutToken = stranger.status;
    }
    // an agent moving itself somewhere else
    const moved = await fetch(base + "/api/bots/" + out.whoami.body.botId + "/workplace", { method: "PUT", headers: { authorization: "Bearer " + process.env.BLOKS_TOKEN, "content-type": "application/json" }, body: JSON.stringify({ workplace: null }) });
    out.selfMove = moved.status;
    // the network-off proxy, asked for somewhere that is not the engine's
    if (process.env.HTTPS_PROXY) {
      const { connect } = await import("node:net");
      const proxy = new URL(process.env.HTTPS_PROXY);
      const ask = (target) => new Promise((resolve) => {
        const socket = connect(Number(proxy.port), proxy.hostname, () => socket.write("CONNECT " + target + " HTTP/1.1\\r\\nHost: " + target + "\\r\\n\\r\\n"));
        let said = "";
        socket.on("data", (d) => { said += d; if (said.includes("\\r\\n")) { socket.destroy(); resolve(said.split("\\r\\n")[0]); } });
        socket.on("error", (e) => resolve("error " + e.message));
        socket.on("close", () => resolve(said.split("\\r\\n")[0] || "closed"));
      });
      out.proxyElsewhere = await ask("example.com:443");
      out.proxyPort80 = await ask("api.anthropic.com:80");
    }
  } catch (error) { out.error = String(error?.stack ?? error); }
  if (process.env.BLOKS_OUTBOX) {
    mkdirSync(process.env.BLOKS_OUTBOX, { recursive: true });
    writeFileSync(join(process.env.BLOKS_OUTBOX, "report.md"), "# Made over there\\n");
    mkdirSync(join(process.env.BLOKS_OUTBOX, ".hidden"), { recursive: true });
    writeFileSync(join(process.env.BLOKS_OUTBOX, ".hidden", "x"), "no");
  }
  writeFileSync(${JSON.stringify(seen)}, JSON.stringify(out));
  const hold = existsSync(join(process.env.HOME ?? "", ".hold")) ? Number(readFileSync(join(process.env.HOME ?? "", ".hold"), "utf8")) : 0;
  if (hold) await new Promise((r) => setTimeout(r, hold));
  console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "sess-there", model: "claude-sonnet-5" }));
  console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Done there." }] } }));
  console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 1, duration_api_ms: 1, total_cost_usd: 0, session_id: "sess-there", result: "Done there." }));
});
`;

export function fakePlaces(root: string, seen: string): FakePlaces {
  const bin = join(root, "fake-bin");
  const there = join(root, "there-bin");
  const home = join(root, "there-home");
  for (const dir of [bin, there, home]) mkdirSync(dir, { recursive: true });
  const node = process.execPath;
  writeFileSync(join(bin, "docker"), DOCKER(node), { mode: 0o755 });
  writeFileSync(join(bin, "ssh"), SSH(node), { mode: 0o755 });
  writeFileSync(join(there, "claude"), FAKE_ENGINE(node, seen), { mode: 0o755 });
  chmodSync(join(there, "claude"), 0o755);
  try {
    symlinkSync(node, join(there, "node"));
  } catch {
    /* already there */
  }
  // Give the fake far side only the ordinary tools its shell scripts use.
  // Neither PATH may fall through to this computer's Docker or SSH when
  // a test removes a stand-in to exercise a missing-program error.
  for (const name of ["sh", "cat", "chmod", "mkdir", "rm", "tar", "find", "head", "tr", "grep", "sleep", "curl"]) {
    const source = ["/usr/bin", "/bin"].map((dir) => join(dir, name)).find(existsSync);
    if (source) symlinkSync(source, join(there, name));
  }
  // The real bootstrap prepends the far home's .local/bin and
  // /usr/local/bin. Keep the far side from finding host programs there.
  const guards = join(home, ".local", "bin");
  mkdirSync(guards, { recursive: true });
  for (const name of ["docker", "ssh"]) {
    writeFileSync(join(guards, name), `#!${node}\nprocess.stderr.write("Blocked host program in fake workplace.\\n");\nprocess.exit(127);\n`, { mode: 0o755 });
  }
  const dockerLog = join(root, "docker.log");
  const sshLog = join(root, "ssh.log");
  const dockerState = join(root, "docker.json");
  const sshControl = join(root, "ssh.json");
  writeFileSync(dockerLog, "");
  writeFileSync(sshLog, "");
  writeFileSync(dockerState, JSON.stringify({ containers: {} }));
  writeFileSync(sshControl, "{}");
  return {
    bin,
    there,
    home,
    dockerLog,
    sshLog,
    dockerState,
    sshControl,
    env: {
      PATH: `${bin}:${there}`,
      FAKE_DOCKER_LOG: dockerLog,
      FAKE_DOCKER_STATE: dockerState,
      FAKE_SSH_LOG: sshLog,
      FAKE_SSH_CONTROL: sshControl,
      FAKE_HOME: home,
      FAKE_THERE_PATH: there,
    },
    dockerCalls: () => lines(dockerLog),
    sshCalls: () => lines(sshLog),
    setDocker: (state) => writeFileSync(dockerState, JSON.stringify(state)),
    docker: () => JSON.parse(readFileSync(dockerState, "utf8")),
    setSsh: (control) => writeFileSync(sshControl, JSON.stringify(control)),
  };
}
