// Running an agent's turns somewhere else (see server/workplace.ts for
// the why, and the exact command lines).
//
// Three jobs live here:
//
//   The place itself. A container Bloks made is made, started, reused and
//   stopped when idle; one the person runs is only ever execed into; a
//   host is reached afresh for each turn, so a dropped connection costs
//   the turn it dropped in and nothing more. Before every turn the place
//   is asked one quick question (its home, whether it has Node), which is
//   also how a place that has gone is found out before the engine is,
//   with a sentence rather than an engine's early exit.
//
//   A turn. Its engine is started there with its stdio carried here, its
//   files go ahead of it on that stdin, and Bloks is reached through the
//   gate. When it ends, what it saved in its outbox is brought back to
//   become file cards, and its run folder there is removed.
//
//   The Test, and copying a sign-in, which only ever happens on the
//   owner's word.
//
// docker and ssh are found on PATH, as a person's Terminal would find
// them; the tests put stand-ins there and never reach a real one.
import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, createReadStream, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import type { Readable } from "node:stream";

import type { PlaceRun } from "./contracts.ts";
import { signalGroup } from "./drivers/engine-processes.ts";
import { OWN_GROUP } from "./no-console.ts";
import type { Gate, GateServer, GateTurn } from "./workplace-gate.ts";
import { hostLine, type LineHost } from "./workplace-line.ts";
import {
  AGENT_LABEL,
  LINE_HOSTS,
  SPEC_LABEL,
  bootstrapArgv,
  containerSpec,
  copyPlan,
  dockerExecArgs,
  dockerRunArgs,
  mountRefusal,
  newRun,
  noVersionProbe,
  outboxDir,
  placeKey,
  placeLabel,
  preambleText,
  probeScript,
  readProbe,
  reaperScript,
  remoteCommand,
  runDir,
  shippedEnv,
  shQuote,
  signInAsk,
  signInFiles,
  sshArgs,
  sshProblem,
  testReport,
  type CopyPlan,
  type DockerImagePlace,
  type PlaceState,
  type PlaceStatus,
  type TestReport,
  type Workplace,
} from "./workplace.ts";

/** A sentence for the person: why a place could not be used. */
export class PlaceError extends Error {}

interface Ran {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: Buffer;
  stderr: string;
  /** The program itself could not be started (ENOENT: not installed). */
  missing?: boolean;
}

interface Tunnel {
  remotePort: number;
  gateHost: string;
  gatePort: number;
}

/** How long the quick question before a turn may take. */
const QUICK_MS = 30_000;
/** Making a container can mean pulling its image first. */
const CREATE_MS = 15 * 60_000;
/** Bringing a turn's files back, all of them. */
const FETCH_MS = 5 * 60_000;
/** The most a turn brings back. */
const FETCH_MAX_BYTES = 512 * 1024 * 1024;
const FETCH_MAX_FILES = 200;
/** One attached file, sent there for the turn. */
const ATTACH_MAX_BYTES = 50 * 1024 * 1024;

/** How ssh's own failures read on stderr, as against the engine's: the
 * engine there can exit 255 too. */
const SSH_DROPPED = /closed by remote host|client_loop:|Timeout, server .* not responding|Broken pipe|Connection reset|Connection to .* closed|port forwarding failed|Could not resolve hostname|Connection refused|timed out|Permission denied|Host key verification failed/i;

const randomPort = () => 20_000 + Math.floor(Math.random() * 40_000);

interface ActiveRun {
  botId: string;
  laneId: string;
  place: Workplace;
  runId: string;
  run: string;
  home: string;
  outbox: string;
  gateToken: string;
  turn: GateTurn;
  files: Array<{ path: string; content: string }>;
  spawned: Array<{ tag: string; child: ChildProcess }>;
  line?: { child: ChildProcess; host: LineHost; run: string; tag: string };
  /** Why the connection went, when it went rather than ended. */
  dropped?: string;
}

export interface WorkplaceDeps {
  gate: Gate;
  /** The agent's command line, as a file here. */
  cliFile: string;
  /** The network-off line, as a file here (bin/bloks-line.mjs). */
  lineFile: string;
  /** A place's state changed: tell the clients. */
  onStatus(botId: string): void;
  /** What a place said of itself, to keep with the agent. */
  onSeen?(botId: string, place: Workplace, seen: { home: string; node: boolean }): void;
  /** Overrides for the programs, for a test that wants a stand-in by
   * path; otherwise found on PATH by name. */
  docker?: string;
  ssh?: string;
}

export class Workplaces {
  private deps: WorkplaceDeps;
  private statuses = new Map<string, PlaceStatus>();
  private runs = new Map<string, ActiveRun>();
  private gateTokens = new Set<string>();
  private idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private locks = new Map<string, Promise<unknown>>();
  private dockerCheck: { at: number; problem: string | null } | null = null;

  constructor(deps: WorkplaceDeps) {
    this.deps = deps;
  }

  private get docker() {
    return this.deps.docker ?? "docker";
  }
  private get ssh() {
    return this.deps.ssh ?? "ssh";
  }

  // ── status ───────────────────────────────────────────────────────────

  status(botId: string): PlaceStatus | null {
    return this.statuses.get(botId) ?? null;
  }

  private setStatus(botId: string, place: Workplace, state: PlaceState, detail?: string) {
    const before = this.statuses.get(botId);
    if (before && before.state === state && before.detail === detail && before.label === placeLabel(place)) return;
    this.statuses.set(botId, { kind: place.kind, label: placeLabel(place), state, ...(detail ? { detail } : {}), at: Date.now() });
    this.deps.onStatus(botId);
  }

  /** The agent moved: what was said of its old place no longer is. */
  forget(botId: string) {
    this.statuses.delete(botId);
    const timer = this.idleTimers.get(botId);
    if (timer) clearTimeout(timer);
    this.idleTimers.delete(botId);
  }

  /** Whether a token is a running turn's gate token. */
  ownsGateToken(token: string): boolean {
    return this.gateTokens.has(token);
  }

  /** How many of this agent's turns are running somewhere else. */
  running(botId: string): number {
    return [...this.runs.values()].filter((run) => run.botId === botId).length;
  }

  /** The lane's run, if its turn works elsewhere. */
  runOf(laneId: string): { label: string; place: Workplace } | null {
    const run = this.runs.get(laneId);
    return run ? { label: placeLabel(run.place), place: run.place } : null;
  }

  // ── running a command there ──────────────────────────────────────────

  private start(place: Workplace, argv: readonly string[], tunnel?: Tunnel): ChildProcessWithoutNullStreams {
    const [program, args] = place.kind === "ssh" ? [this.ssh, sshArgs(place, argv, tunnel)] : [this.docker, dockerExecArgs(place.name, argv)];
    return spawn(program, args, {
      cwd: homedir(),
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: OWN_GROUP,
      windowsHide: true,
    });
  }

  private collect(child: ChildProcess, options: { input?: Buffer | Readable; timeoutMs?: number; stdoutLimit?: number } = {}): Promise<Ran> {
    return new Promise((resolve) => {
      const out: Buffer[] = [];
      let outSize = 0;
      let err = "";
      let done = false;
      const finish = (ran: Ran) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(ran);
      };
      const timer = setTimeout(() => {
        signalGroup(child, "SIGKILL");
      }, options.timeoutMs ?? QUICK_MS);
      timer.unref?.();
      child.stdout?.on("data", (chunk: Buffer) => {
        outSize += chunk.length;
        if (outSize > (options.stdoutLimit ?? 4 * 1024 * 1024)) {
          signalGroup(child, "SIGKILL");
          return;
        }
        out.push(chunk);
      });
      child.stderr?.on("data", (chunk: Buffer) => (err = (err + chunk.toString()).slice(-8_000)));
      child.once("error", (error: NodeJS.ErrnoException) =>
        finish({ code: null, signal: null, stdout: Buffer.alloc(0), stderr: error.message, missing: error.code === "ENOENT" }),
      );
      child.once("close", (code, signal) => finish({ code, signal, stdout: Buffer.concat(out), stderr: err }));
      child.stdin?.on("error", () => {});
      if (options.input && child.stdin) {
        if (Buffer.isBuffer(options.input)) child.stdin.end(options.input);
        else options.input.on("error", () => child.stdin?.end()).pipe(child.stdin);
      } else child.stdin?.end();
    });
  }

  /** One shell line there. */
  sh(place: Workplace, script: string, options: { input?: Buffer | Readable; timeoutMs?: number; stdoutLimit?: number; tunnel?: Tunnel } = {}): Promise<Ran> {
    return this.collect(this.start(place, ["sh", "-c", script], options.tunnel), options);
  }

  /** docker itself, with its own arguments. */
  private dockerRun(args: string[], timeoutMs = QUICK_MS): Promise<Ran> {
    let child: ChildProcess;
    try {
      child = spawn(this.docker, args, { cwd: homedir(), env: process.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    } catch (error) {
      return Promise.resolve({ code: null, signal: null, stdout: Buffer.alloc(0), stderr: String(error), missing: true });
    }
    return this.collect(child, { timeoutMs });
  }

  /** Why Docker cannot be used here, or null. Asked at most every half
   * minute: it is the first thing every turn in a container asks. */
  private async dockerProblem(): Promise<string | null> {
    if (this.dockerCheck && Date.now() - this.dockerCheck.at < 30_000 && !this.dockerCheck.problem) return null;
    const ran = await this.dockerRun(["version", "--format", "{{.Server.Version}}"], 20_000);
    const problem = ran.missing
      ? "Docker is not installed on this computer, or not where Bloks can find it. Install Docker Desktop, or Docker Engine on Linux."
      : ran.code !== 0
        ? "Docker is installed but not running. Open Docker, wait for it to start, and try again."
        : null;
    this.dockerCheck = { at: Date.now(), problem };
    return problem;
  }

  private async inspect(name: string): Promise<{ exists: boolean; running: boolean; agent: string; spec: string }> {
    const ran = await this.dockerRun(["inspect", "--type", "container", "--format", `{{.State.Running}}|{{index .Config.Labels "${AGENT_LABEL}"}}|{{index .Config.Labels "${SPEC_LABEL}"}}`, name]);
    if (ran.code !== 0) return { exists: false, running: false, agent: "", spec: "" };
    const [running, agent, spec] = ran.stdout.toString().trim().split("|");
    const value = (text: string | undefined) => (text && text !== "<no value>" ? text : "");
    return { exists: true, running: running === "true", agent: value(agent), spec: value(spec) };
  }

  /** One thing at a time per place: two lanes starting at once must not
   * both make the same container. */
  private serial<T>(key: string, work: () => Promise<T>): Promise<T> {
    const before = this.locks.get(key) ?? Promise.resolve();
    const next = before.catch(() => {}).then(work);
    this.locks.set(key, next);
    void next.finally(() => {
      if (this.locks.get(key) === next) this.locks.delete(key);
    }).catch(() => {});
    return next;
  }

  /**
   * The container there and running. A container Bloks makes is made from
   * the place as it is set now, and made again if the settings it was made
   * from have changed since; one that is somebody else's is never touched.
   */
  private ensureContainer(bot: { id: string; name: string }, place: Extract<Workplace, { kind: "docker" }>, localFolder: string): Promise<void> {
    return this.serial(placeKey(place), async () => {
      const problem = await this.dockerProblem();
      if (problem) throw new PlaceError(problem);
      const now = await this.inspect(place.name);
      if (place.source === "container") {
        if (!now.exists) throw new PlaceError(`There is no container named ${place.name}. Start it, or check the name.`);
        if (!now.running) throw new PlaceError(`The container ${place.name} is not running. Start it with docker start ${place.name}, then try again.`);
        return;
      }
      const spec = containerSpec(place, localFolder);
      if (now.exists && now.agent !== bot.id) {
        throw new PlaceError(
          `A container named ${place.name} already exists, and Bloks did not make it for ${bot.name}. Choose another name, or pick a container you run to use that one as it is.`,
        );
      }
      if (now.exists && now.spec === spec) {
        if (now.running) return;
        this.setStatus(bot.id, place, "starting");
        const started = await this.dockerRun(["start", place.name], 120_000);
        if (started.code !== 0) throw new PlaceError(`Docker could not start ${place.name}: ${tail(started.stderr)}`);
        return;
      }
      this.setStatus(bot.id, place, "starting");
      if (now.exists) await this.dockerRun(["rm", "-f", place.name], 60_000);
      await this.create(bot, place, localFolder);
    });
  }

  private async create(bot: { id: string }, place: DockerImagePlace, localFolder: string) {
    if (place.folder === "mount") {
      const refused = mountRefusal(localFolder);
      if (refused) throw new PlaceError(refused);
    }
    const made = await this.dockerRun(dockerRunArgs(place, bot.id, localFolder), CREATE_MS);
    if (made.code !== 0) {
      if (/Unable to find image|pull access denied|manifest unknown|not found/i.test(made.stderr)) {
        throw new PlaceError(`Docker could not find the image ${place.image}. Check its name, or sign in to its registry with docker login.`);
      }
      throw new PlaceError(`Docker could not make ${place.name}: ${tail(made.stderr)}`);
    }
    if (place.folder === "copy") {
      const copied = await this.dockerRun(["cp", `${localFolder}${sep}.`, `${place.name}:${place.path}`], CREATE_MS);
      if (copied.code !== 0) throw new PlaceError(`Docker could not copy the working folder into ${place.name}: ${tail(copied.stderr)}`);
    }
  }

  /** The quick question: is it there, and what is its home. */
  private async quick(bot: { id: string }, place: Workplace): Promise<{ home: string; node: boolean }> {
    const ran = await this.sh(place, `printf 'home=%s\\n' "$HOME"; command -v node >/dev/null 2>&1 && echo node=yes; true`);
    if (ran.missing) throw new PlaceError(place.kind === "ssh" ? "ssh is not on this computer, so Bloks cannot reach another machine." : "Docker is not installed on this computer.");
    if (ran.code !== 0) {
      if (place.kind === "ssh") throw new PlaceError(sshProblem(ran.stderr, place));
      throw new PlaceError(`Bloks could not run anything in ${place.name}: ${tail(ran.stderr)}`);
    }
    const probe = readProbe(ran.stdout.toString());
    const node = /(^|\n)node=yes/.test(ran.stdout.toString());
    if (!probe.home.startsWith("/")) throw new PlaceError(`${placeLabel(place)} has no home folder Bloks can use.`);
    this.deps.onSeen?.(bot.id, place, { home: probe.home, node });
    return { home: probe.home, node };
  }

  /** Ready for a turn, or a PlaceError that says why not. */
  async prepare(bot: { id: string; name: string }, place: Workplace, localFolder: string): Promise<{ home: string; node: boolean }> {
    const timer = this.idleTimers.get(bot.id);
    if (timer) clearTimeout(timer);
    this.idleTimers.delete(bot.id);
    try {
      if (place.kind === "docker") await this.ensureContainer(bot, place, localFolder);
      else this.setStatus(bot.id, place, this.statuses.get(bot.id)?.state === "dropped" ? "reconnecting" : "starting");
      const seen = await this.quick(bot, place);
      this.setStatus(bot.id, place, "ready");
      return seen;
    } catch (error) {
      const said = error instanceof PlaceError ? error.message : `Could not get ${placeLabel(place)} ready: ${(error as Error).message}`;
      this.setStatus(bot.id, place, "unreachable", said);
      throw error instanceof PlaceError ? error : new PlaceError(said);
    }
  }

  // ── a turn ───────────────────────────────────────────────────────────

  /** Where the gate is, as that side reaches it, listening first. */
  private async gateFor(place: Workplace): Promise<{ url: string; host: string; port: number; tunnel?: Tunnel; line?: boolean }> {
    if (place.kind === "ssh") {
      const port = await this.deps.gate.listen("127.0.0.1");
      const remotePort = randomPort();
      return { url: `http://127.0.0.1:${remotePort}`, host: "127.0.0.1", port, tunnel: { remotePort, gateHost: "127.0.0.1", gatePort: port } };
    }
    if (place.source === "image" && !place.network) {
      const port = await this.deps.gate.listen("127.0.0.1");
      return { url: "", host: "127.0.0.1", port, line: true };
    }
    // Docker Desktop hands host.docker.internal to the host's loopback.
    // Docker on Linux has no such hand-off: the container reaches the
    // bridge's own address here, so the gate listens there too.
    if (process.platform === "linux") {
      const bridge = await this.dockerRun(["network", "inspect", "bridge", "--format", "{{range .IPAM.Config}}{{.Gateway}}{{end}}"]);
      const ip = bridge.stdout.toString().trim();
      if (bridge.code === 0 && /^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
        const port = await this.deps.gate.listen(ip);
        return { url: `http://${ip}:${port}`, host: ip, port };
      }
    }
    const port = await this.deps.gate.listen("127.0.0.1");
    return { url: `http://host.docker.internal:${port}`, host: "127.0.0.1", port };
  }

  /**
   * A turn there: its gate opened, its line up if the network is off,
   * its attachments sent ahead, and a PlaceRun for the driver. `env` is
   * the turn's own environment as it would be here; its addresses are
   * rewritten for that side, and nothing else of this computer's goes.
   */
  async begin(input: {
    bot: { id: string; name: string };
    laneId: string;
    place: Workplace;
    driverKind: string;
    home: string;
    env: Record<string, string>;
    tokens: string[];
    texts: string[];
  }): Promise<{ run: PlaceRun; texts: string[]; outbox: string }> {
    const { place, home } = input;
    const { id: runId, sentinel } = newRun();
    const run = runDir(home, runId);
    const outbox = outboxDir(home, input.laneId);
    const gateToken = `blg_${randomBytes(24).toString("base64url")}`;
    const gate = await this.gateFor(place);
    const servers = new Map<string, GateServer>();
    const turn: GateTurn = { botId: input.bot.id, laneId: input.laneId, tokens: [...input.tokens.filter(Boolean), gateToken], servers };
    const active: ActiveRun = { botId: input.bot.id, laneId: input.laneId, place, runId, run, home, outbox, gateToken, turn, files: [], spawned: [] };

    // what the turn's environment says there
    const env: Record<string, string> = { ...input.env };
    // The agent's command line, read before the line below starts anything
    // there, so a file missing from this install leaves nothing running.
    const cli = env.BLOKS_TOKEN || env.BLOKS_REPLY_TOKEN ? readFileSync(this.deps.cliFile, "utf8") : null;
    let bloksUrl = gate.url;
    if (gate.line) {
      const hosts = LINE_HOSTS[input.driverKind] ?? [];
      const line = await this.openLine(place as DockerImagePlace, home, gate.port, hosts);
      active.line = line.line;
      bloksUrl = `http://127.0.0.1:${line.ports.bloksPort}`;
      const proxy = `http://127.0.0.1:${line.ports.proxyPort}`;
      Object.assign(env, {
        HTTPS_PROXY: proxy,
        https_proxy: proxy,
        HTTP_PROXY: proxy,
        http_proxy: proxy,
        NO_PROXY: "127.0.0.1,localhost",
        no_proxy: "127.0.0.1,localhost",
        NODE_USE_ENV_PROXY: "1",
      });
    }
    if (env.BLOKS_URL) env.BLOKS_URL = bloksUrl;
    if (cli !== null) {
      env.BLOKS_CLI = `${run}/bloks.mjs`;
      active.files.push({ path: env.BLOKS_CLI, content: cli });
    } else delete env.BLOKS_CLI;
    env.BLOKS_OUTBOX = outbox;

    this.gateTokens.add(gateToken);
    this.deps.gate.open(turn);
    this.runs.set(input.laneId, active);
    this.setStatus(input.bot.id, place, "working");

    let texts = input.texts;
    try {
      texts = await this.sendAttachments(active, input.texts);
    } catch (error) {
      await this.end(input.laneId, null).catch(() => {});
      throw error;
    }

    let slugs = 0;
    const self = this;
    const placeRun: PlaceRun = {
      label: placeLabel(place),
      cwd: place.path,
      file(name: string, content: string) {
        const safe = name.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || "file";
        const path = `${run}/${safe}`;
        active.files = active.files.filter((file) => file.path !== path);
        active.files.push({ path, content });
        return path;
      },
      mcp(name, server) {
        const slug = `${name.toLowerCase().replace(/[^a-z0-9_-]+/g, "_").slice(0, 40) || "server"}-${++slugs}`;
        if (server.transport === "http" || (!server.command && server.url)) {
          if (!server.url) return null;
          servers.set(slug, { transport: "http", url: server.url, ...(server.headers ? { headers: server.headers } : {}) });
        } else {
          if (!server.command) return null;
          servers.set(slug, { transport: "stdio", command: server.command, args: server.args ?? [], ...(server.env ? { env: server.env } : {}) });
        }
        if (!bloksUrl) return null;
        return { url: `${bloksUrl}/mcp/${slug}`, headers: { Authorization: `Bearer ${gateToken}` } };
      },
      // the engine there, as docker exec -i or ssh -T, which spawnThere
      // starts hidden like every other console program here
      spawn: (command, args, options) => self.spawnThere(active, command, args, shippedEnv(env, options?.env, process.env), gate.tunnel, sentinel),
    };
    return { run: placeRun, texts, outbox };
  }

  private spawnThere(active: ActiveRun, command: string, args: string[], env: Record<string, string>, tunnel: Tunnel | undefined, sentinel: string): ChildProcessWithoutNullStreams {
    const tag = `${active.runId}-${active.spawned.length + 1}`;
    const preamble = preambleText({ tag, run: active.run, sentinel, files: active.files, env, folders: [active.outbox], cwd: active.place.path });
    const child = this.start(active.place, bootstrapArgv(sentinel, remoteCommand(active.place, command), args), tunnel);
    active.spawned.push({ tag, child });
    child.stdin.on("error", () => {});
    child.stdin.write(preamble);
    let said = "";
    child.stderr.on("data", (chunk: Buffer) => (said = (said + chunk.toString()).slice(-4_000)));
    child.once("exit", (code, signal) => {
      // asked to end (Stop, the turn finishing) is not a drop
      if (signal) return void this.reap(active, tag);
      if (active.place.kind === "ssh" && code === 255 && SSH_DROPPED.test(said)) {
        active.dropped = `The connection to ${placeLabel(active.place)} dropped (${tail(said, 160)}), so this turn stopped.`;
        void this.reconnect(active.botId, active.place);
        return;
      }
      const place = active.place;
      if (place.kind === "docker" && code !== 0) {
        void this.inspect(place.name).then((now) => {
          if (!now.running) {
            active.dropped = `The container ${place.name} stopped during this turn.`;
            this.setStatus(active.botId, place, "stopped", active.dropped);
          }
        });
      }
      void this.reap(active, tag);
    });
    return child;
  }

  /** The engine there ended, however it ended: make sure it did. */
  private async reap(active: ActiveRun, tag: string) {
    await this.sh(active.place, reaperScript(active.run, tag, false), { timeoutMs: 15_000 }).catch(() => {});
  }

  /** After a drop: look again, a few times, so the header can say when
   * the next message would get through. */
  private async reconnect(botId: string, place: Workplace) {
    this.setStatus(botId, place, "dropped");
    for (let attempt = 0; attempt < 6; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, attempt === 0 ? 1_000 : 5_000).unref?.());
      if (this.runs.size && [...this.runs.values()].some((run) => run.botId === botId && !run.dropped)) return;
      this.setStatus(botId, place, "reconnecting");
      const ran = await this.sh(place, "true", { timeoutMs: 20_000 });
      if (ran.code === 0) {
        this.setStatus(botId, place, "ready");
        return;
      }
    }
    this.setStatus(botId, place, "unreachable", `Bloks could not reach ${placeLabel(place)} again. It tries again on the next message.`);
  }

  /** The line into a network-off container, up and listening. */
  private async openLine(place: DockerImagePlace, home: string, gatePort: number, hosts: readonly string[]) {
    const { id, sentinel } = newRun();
    const run = runDir(home, `line-${id}`);
    const tag = `line-${id}`;
    const script = `${run}/line.mjs`;
    const ports = { bloksPort: randomPort(), proxyPort: randomPort() };
    // Read before anything starts there: a file missing from this install
    // fails here, not after a docker exec is left waiting on its input.
    const content = readFileSync(this.deps.lineFile, "utf8");
    const child = this.start(place, bootstrapArgv(sentinel, "node", [script, String(ports.bloksPort), String(ports.proxyPort)]));
    child.stdin.write(preambleText({ tag, run, sentinel, files: [{ path: script, content }], env: {}, folders: [], cwd: "/" }));
    let said = "";
    child.stderr.on("data", (chunk: Buffer) => (said = (said + chunk.toString()).slice(-2_000)));
    const host = hostLine(child, { gate: { host: "127.0.0.1", port: gatePort }, hosts });
    const timer = setTimeout(() => signalGroup(child, "SIGKILL"), 20_000);
    try {
      const ready = await Promise.race([
        host.ready,
        new Promise<never>((_, reject) => child.once("exit", () => reject(new Error(tail(said) || "it stopped")))),
      ]);
      return { ports: ready, line: { child, host, run, tag } };
    } catch (error) {
      host.close();
      signalGroup(child, "SIGKILL");
      throw new PlaceError(
        /node: not found|node: No such file|exec: node/i.test(said)
          ? `With the network off, Bloks reaches ${place.name} through a small Node program, and Node is not in the container. Use an image with Node, like node:22-bookworm, or turn the network on.`
          : `Bloks could not open its line into ${place.name}: ${(error as Error).message}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /** Files the person attached, sent there for this turn, and the words
   * pointing at them there instead of here. */
  private async sendAttachments(active: ActiveRun, texts: string[]): Promise<string[]> {
    const tag = /<attached-(image|file)\s+path="([^"]*)"\s*\/>/g;
    const paths = new Set<string>();
    for (const text of texts) for (const [, , path] of text.matchAll(tag)) if (path) paths.add(path);
    if (!paths.size) return texts;
    const there = new Map<string, string>();
    let n = 0;
    for (const raw of paths) {
      const local = unescapeAttr(raw);
      let size = -1;
      try {
        const info = statSync(local);
        if (info.isFile()) size = info.size;
      } catch {
        /* gone, or never a file: the words keep naming it */
      }
      if (size < 0 || size > ATTACH_MAX_BYTES) continue;
      const name = (local.split(/[\\/]/).pop() ?? "file").replace(/[^A-Za-z0-9._-]/g, "_").slice(-80);
      const remote = `${active.run}/attached/${++n}-${name}`;
      await this.put(active.place, local, remote);
      there.set(raw, remote);
    }
    return texts.map((text) =>
      text.replace(tag, (whole, kind: string, path: string) => (there.has(path) ? `<attached-${kind} path="${escapeAttr(there.get(path)!)}" />` : whole)),
    );
  }

  /** One file from here to there, private to that side's user. */
  async put(place: Workplace, local: string, remote: string, mode = "600") {
    const dir = remote.slice(0, remote.lastIndexOf("/")) || "/";
    const ran = await this.sh(place, `umask 077; mkdir -p ${shQuote(dir)} && cat > ${shQuote(remote)} && chmod ${mode} ${shQuote(remote)}`, {
      input: createReadStream(local),
      timeoutMs: FETCH_MS,
    });
    if (ran.code !== 0) throw new PlaceError(`Bloks could not send ${local.split(/[\\/]/).pop()} to ${placeLabel(place)}: ${tail(ran.stderr)}`);
  }

  /**
   * The turn is over: the gate closes on its tokens, the line comes down,
   * what it saved in its outbox comes back into `into` (the agent's own
   * files here, which then become cards), and its run folder there goes.
   * `accept` says which names may land there.
   */
  async end(laneId: string, into: string | null, accept: (name: string) => boolean = () => true): Promise<{ dropped?: string; fetched: string[]; failed?: string }> {
    const active = this.runs.get(laneId);
    if (!active) return { fetched: [] };
    this.runs.delete(laneId);
    this.deps.gate.close(laneId);
    this.gateTokens.delete(active.gateToken);
    if (active.line) {
      active.line.host.close();
      signalGroup(active.line.child, "SIGTERM");
      void this.sh(active.place, reaperScript(active.line.run, active.line.tag, true), { timeoutMs: 15_000 }).catch(() => {});
    }
    // an engine whose connection here is still open has not finished
    for (const { child } of active.spawned) if (child.exitCode === null && child.signalCode === null) signalGroup(child, "SIGTERM");
    let fetched: string[] = [];
    let failed: string | undefined;
    if (into && !active.dropped) {
      try {
        fetched = await this.fetchOutbox(active, into, accept);
      } catch (error) {
        failed = (error as Error).message;
      }
    }
    if (!active.dropped) await this.sh(active.place, `rm -rf ${shQuote(active.run)}`, { timeoutMs: 15_000 }).catch(() => {});
    if (!active.dropped) this.setStatus(active.botId, active.place, this.running(active.botId) ? "working" : "ready");
    if (!this.running(active.botId)) this.scheduleIdle(active.botId, active.place);
    return { ...(active.dropped ? { dropped: active.dropped } : {}), fetched, ...(failed ? { failed } : {}) };
  }

  /** The outbox there, as a tar stream, unpacked into a private folder
   * here and walked by hand: only plain files under plain names, never a
   * link, so nothing in the archive can reach outside it. */
  private async fetchOutbox(active: ActiveRun, into: string, accept: (name: string) => boolean): Promise<string[]> {
    const listed = await this.sh(active.place, `[ -d ${shQuote(active.outbox)} ] && find ${shQuote(active.outbox)} -type f | head -n 1; true`);
    if (!listed.stdout.toString().trim()) return [];
    const packed = await this.sh(active.place, `cd ${shQuote(active.outbox)} && tar -cf - .`, { timeoutMs: FETCH_MS, stdoutLimit: FETCH_MAX_BYTES });
    if (packed.code !== 0) throw new Error(`the files there could not be packed: ${tail(packed.stderr)}`);
    const scratch = mkdtempSync(join(tmpdir(), "bloks-outbox-"));
    try {
      const unpack = spawn("tar", ["-xf", "-", "-C", scratch], { stdio: ["pipe", "ignore", "pipe"], windowsHide: true });
      const unpacked = await this.collect(unpack, { input: packed.stdout, timeoutMs: FETCH_MS });
      if (unpacked.code !== 0) throw new Error(`the files there could not be unpacked: ${tail(unpacked.stderr)}`);
      const landed: string[] = [];
      const walk = (dir: string, depth: number) => {
        if (depth > 4) return;
        for (const entry of readdirSync(dir)) {
          if (landed.length >= FETCH_MAX_FILES) return;
          if (entry.startsWith(".")) continue;
          const path = join(dir, entry);
          const info = lstatSync(path);
          if (info.isSymbolicLink()) continue;
          if (info.isDirectory()) walk(path, depth + 1);
          else if (info.isFile()) {
            const name = relative(scratch, path).split(sep).join("/");
            if (!accept(name)) continue;
            const dest = join(into, ...name.split("/"));
            mkdirSync(dirname(dest), { recursive: true });
            try {
              renameSync(path, dest);
            } catch {
              copyFileSync(path, dest);
            }
            landed.push(name);
          }
        }
      };
      walk(scratch, 0);
      await this.sh(active.place, `rm -rf ${shQuote(active.outbox)}`, { timeoutMs: 15_000 }).catch(() => {});
      return landed;
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  // ── idle and the owner's own buttons ─────────────────────────────────

  /** A container Bloks made, stopped (or removed) once it has gone a
   * while without a turn. */
  scheduleIdle(botId: string, place: Workplace) {
    const timer = this.idleTimers.get(botId);
    if (timer) clearTimeout(timer);
    this.idleTimers.delete(botId);
    if (place.kind !== "docker" || place.source !== "image" || place.idleMinutes <= 0) return;
    const next = setTimeout(() => {
      this.idleTimers.delete(botId);
      if (this.running(botId)) return;
      void (place.autoRemove ? this.remove(botId, place) : this.stop(botId, place)).catch(() => {});
    }, place.idleMinutes * 60_000);
    next.unref?.();
    this.idleTimers.set(botId, next);
  }

  /** Only a container Bloks made for this agent is stopped or removed. */
  private async mine(botId: string, place: DockerImagePlace): Promise<boolean> {
    const now = await this.inspect(place.name);
    return now.exists && now.agent === botId;
  }

  async stop(botId: string, place: Workplace): Promise<void> {
    if (place.kind !== "docker" || place.source !== "image") throw new PlaceError("Bloks only stops a container it made.");
    if (this.running(botId)) throw new PlaceError("It is working there right now. Stop its turn first.");
    if (!(await this.mine(botId, place))) return this.setStatus(botId, place, "stopped");
    const ran = await this.dockerRun(["stop", "--time", "10", place.name], 60_000);
    if (ran.code !== 0) throw new PlaceError(`Docker could not stop ${place.name}: ${tail(ran.stderr)}`);
    this.setStatus(botId, place, "stopped");
  }

  async remove(botId: string, place: Workplace): Promise<void> {
    if (place.kind !== "docker" || place.source !== "image") throw new PlaceError("Bloks only removes a container it made.");
    if (this.running(botId)) throw new PlaceError("It is working there right now. Stop its turn first.");
    if (await this.mine(botId, place)) {
      const ran = await this.dockerRun(["rm", "-f", place.name], 60_000);
      if (ran.code !== 0) throw new PlaceError(`Docker could not remove ${place.name}: ${tail(ran.stderr)}`);
    }
    this.setStatus(botId, place, "removed");
  }

  /** At start: a container left running when Bloks last stopped is put
   * back on its idle clock. */
  resume(botId: string, place: Workplace) {
    this.scheduleIdle(botId, place);
  }

  // ── the Test ─────────────────────────────────────────────────────────

  async test(input: {
    bot: { id: string; name: string };
    place: Workplace;
    driverKind: string;
    engineName: string;
    localCli: string;
    localFolder: string;
    install?: string;
  }): Promise<TestReport> {
    const { place } = input;
    const failed = (sentence: string): TestReport => ({ ok: false, checks: [{ id: "reach", ok: false, label: sentence }], problems: [sentence] });
    try {
      if (place.kind === "docker") await this.ensureContainer(input.bot, place, input.localFolder);
    } catch (error) {
      const said = error instanceof PlaceError ? error.message : (error as Error).message;
      this.setStatus(input.bot.id, place, "unreachable", said);
      return failed(said);
    }
    const gate = await this.gateFor(place);
    const command = remoteCommand(place, input.localCli);
    const ran = await this.sh(
      place,
      probeScript({ command, noVersion: noVersionProbe(input.driverKind), folder: place.path, signIn: signInAsk(input.driverKind), ...(gate.url ? { bloksUrl: gate.url } : {}) }),
      { timeoutMs: 60_000, ...(gate.tunnel ? { tunnel: gate.tunnel } : {}) },
    );
    if (ran.missing) return failed(place.kind === "ssh" ? "ssh is not on this computer, so Bloks cannot reach another machine." : "Docker is not installed on this computer.");
    if (ran.code !== 0) {
      const said = place.kind === "ssh" ? sshProblem(ran.stderr, place) : `Bloks could not run anything in ${place.name}: ${tail(ran.stderr)}`;
      this.setStatus(input.bot.id, place, "unreachable", said);
      return failed(said);
    }
    const probe = readProbe(ran.stdout.toString());
    if (probe.home.startsWith("/")) this.deps.onSeen?.(input.bot.id, place, { home: probe.home, node: Boolean(probe.node) });
    this.setStatus(input.bot.id, place, "ready");
    if (!this.running(input.bot.id)) this.scheduleIdle(input.bot.id, place);
    return testReport({
      place,
      driverKind: input.driverKind,
      engineName: input.engineName,
      command,
      probe,
      install: input.install,
      localSignIn: localSignInFiles(input.driverKind).length > 0,
      line: place.kind === "ssh" ? "tunnel" : gate.line ? "line" : "host",
    });
  }

  // ── copying a sign-in ────────────────────────────────────────────────

  /** What would be copied, for the consent card, or why nothing can be. */
  async signInCopy(input: { bot: { id: string; name: string }; place: Workplace; driverKind: string; engineName: string; localFolder: string }): Promise<{ plan: CopyPlan } | { why: string }> {
    const found = localSignInFiles(input.driverKind);
    if (!found.length) {
      return {
        why:
          input.driverKind === "claudeAgent" && process.platform === "darwin"
            ? `Your ${input.engineName} sign-in on this Mac is kept in the Keychain, not in a file, so Bloks cannot copy it. Sign in there instead.`
            : `There is no ${input.engineName} sign-in file on this computer to copy. Sign in there instead.`,
      };
    }
    try {
      const seen = await this.prepare(input.bot, input.place, input.localFolder);
      return { plan: copyPlan({ place: input.place, driverKind: input.driverKind, engineName: input.engineName, home: seen.home, found }) };
    } catch (error) {
      return { why: (error as Error).message };
    }
  }

  /** The copy itself, only for the plan the person was shown. */
  async copySignIn(input: { bot: { id: string; name: string }; place: Workplace; driverKind: string; engineName: string; localFolder: string; fingerprint: string }): Promise<CopyPlan> {
    const asked = await this.signInCopy(input);
    if ("why" in asked) throw new PlaceError(asked.why);
    if (asked.plan.fingerprint !== input.fingerprint) {
      throw new PlaceError("What would be copied has changed since you were shown it. Look at it again before copying.");
    }
    for (const file of asked.plan.files) {
      await this.put(input.place, join(homedir(), file.from.slice(2)), file.to);
    }
    return asked.plan;
  }

  async dispose() {
    for (const laneId of [...this.runs.keys()]) await this.end(laneId, null).catch(() => {});
    for (const timer of this.idleTimers.values()) clearTimeout(timer);
    this.idleTimers.clear();
  }
}

/** This computer's sign-in files for an engine, as they would be copied. */
export function localSignInFiles(driverKind: string): Array<{ rel: string; bytes: number }> {
  const found: Array<{ rel: string; bytes: number }> = [];
  for (const rel of signInFiles(driverKind)) {
    try {
      const info = lstatSync(join(homedir(), rel));
      if (info.isFile() && info.size > 0 && info.size < 1024 * 1024) found.push({ rel, bytes: info.size });
    } catch {
      /* not here */
    }
  }
  return found;
}

const tail = (text: string, max = 240) =>
  text.trim().split("\n").filter(Boolean).slice(-2).join(" ").slice(-max) || "it said nothing";

/** An attachment tag's path as the app wrote it (src/lib/attachments.ts). */
function unescapeAttr(text: string) {
  return text.replace(/&#10;/g, "\n").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}
function escapeAttr(text: string) {
  return text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "&#10;");
}

/** Whether a place has the agent's working folder here, mounted in,
 * where undo and rewind keep working on the files themselves. */
export function filesAreHere(place: Workplace | null | undefined): boolean {
  return !place || (place.kind === "docker" && place.source === "image" && place.folder === "mount");
}
