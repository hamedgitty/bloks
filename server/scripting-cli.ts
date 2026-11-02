import { dismissedPreparation } from "./preparation-state.ts";
// Bloks from a script, a CI job and a terminal: `bloks-server run`,
// `bloks-server team apply` and `bloks-server chat` (bin/bloks-server.mjs).
//
// All three are the owner speaking, the same as typing in the app, and
// they reach the server the way the rest of bloks-server does: on this
// computer, over loopback, where being here is the credential
// (server/http-guard.ts). `--server` points them at another workspace,
// which then wants the bearer token of one of the owner's paired devices
// (server/pairing.ts) in BLOKS_SERVER_TOKEN or a file named by
// `--token-file`. Never on the command line, where every other account on
// the machine can read it in the process list. `bloks-server token`
// trades a pairing code for one.
//
// Nothing here is the server's: a run is followed through /api/runs
// (server/runs.ts), a team is applied by /api/teams/apply
// (server/team-apply.ts), and a card is answered by the route the app
// answers it with. This file only talks and prints, so the same rules
// hold whichever window the person uses.
//
// Kept free of anything that reads the workspace on import: it runs in a
// process of its own, beside a server that owns the data folder.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { createInterface, type Interface } from "node:readline";

import { planLines, type TeamPlan } from "./team-apply.ts";

/** What each ending exits with, for a script to branch on. */
export const EXIT = {
  done: 0,
  failed: 1,
  usage: 2,
  timedOut: 3,
  needsYou: 4,
  agentNotFound: 5,
  unreachable: 6,
  refused: 7,
  interrupted: 130,
} as const;

export interface Io {
  stdin: NodeJS.ReadableStream & { isTTY?: boolean };
  stdout: NodeJS.WritableStream & { isTTY?: boolean; columns?: number };
  stderr: NodeJS.WritableStream;
  env: NodeJS.ProcessEnv;
  /** Calls `handler` on Ctrl+C until the returned function is called. */
  onInterrupt(handler: () => void): () => void;
}

export interface Context extends Io {
  /** This computer's server, the way bloks-server found it. */
  base: string;
}

// ── talking to the server ─────────────────────────────────────────────

class Unreachable extends Error {}

interface Reply {
  status: number;
  body: any;
}

interface Client {
  base: string;
  remote: boolean;
  call(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<Reply>;
  raw(path: string): Promise<Response>;
  token: string | null;
}

function client(base: string, token: string | null, remote: boolean): Client {
  const headers = (json: boolean): Record<string, string> => ({
    ...(json ? { "content-type": "application/json" } : {}),
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    "x-bloks-client": "bloks-server",
  });
  return {
    base,
    remote,
    token,
    async call(method, path, body, signal) {
      let res: Response;
      try {
        res = await fetch(`${base}${path}`, { method, headers: headers(true), body: body === undefined ? undefined : JSON.stringify(body), signal });
      } catch (e) {
        if ((e as Error).name === "AbortError") throw e;
        throw new Unreachable(remote ? `Nothing answered at ${base}.` : `Bloks is not running on this machine (nothing answered at ${base}). Start it with: bloks-server`);
      }
      const text = await res.text().catch(() => "");
      let parsed: any = {};
      try {
        parsed = text ? JSON.parse(text) : {};
      } catch {
        parsed = { error: text.slice(0, 300) };
      }
      return { status: res.status, body: parsed };
    },
    async raw(path) {
      try {
        return await fetch(`${base}${path}`, { headers: headers(false) });
      } catch {
        throw new Unreachable(`Nothing answered at ${base}.`);
      }
    },
  };
}

/** The flags a command takes, read the plain way: `--name value`,
 * `--name=value`, or a bare switch. Anything else is a word. */
export function readArgs(args: string[], valued: readonly string[]): { words: string[]; flags: Record<string, string | true> } {
  const words: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      words.push(...args.slice(i + 1));
      break;
    }
    if (!arg.startsWith("--")) {
      words.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = eq > 0 ? arg.slice(2, eq) : arg.slice(2);
    if (eq > 0) flags[name] = arg.slice(eq + 1);
    else if (valued.includes(name)) {
      const value = args[i + 1];
      if (value === undefined || value.startsWith("--")) throw new UsageError(`--${name} needs a value.`);
      flags[name] = value;
      i++;
    } else flags[name] = true;
  }
  return { words, flags };
}

class UsageError extends Error {}

/** "90", "90s", "15m", "2h": seconds, minutes, hours. 0 is no limit. */
export function readDuration(value: string): number {
  const m = value.trim().match(/^(\d+(?:\.\d+)?)\s*(s|m|h)?$/i);
  if (!m) throw new UsageError(`--timeout is a length of time, like 90s, 15m or 2h, not "${value}".`);
  const unit = (m[2] ?? "s").toLowerCase();
  return Number(m[1]) * (unit === "h" ? 3_600_000 : unit === "m" ? 60_000 : 1000);
}

/** Which server, and how this command speaks for the owner there. */
function connect(ctx: Context, flags: Record<string, string | true>): Client {
  // An agent's turn hands its shell BLOKS_TOKEN. These commands speak as
  // the person, which an agent's turn may not, so they say no here rather
  // than let a turn borrow the loopback that makes this computer's owner
  // the owner. The server holds the same line for an agent's credential.
  if (ctx.env.BLOKS_TOKEN?.trim()) {
    throw new Refused("This runs as the owner of the workspace, and this shell belongs to an agent's turn. An agent hands work to another with `bloks say`.");
  }
  const server = typeof flags.server === "string" ? flags.server.trim().replace(/\/+$/, "") : "";
  let token: string | null = ctx.env.BLOKS_SERVER_TOKEN?.trim() || null;
  if (typeof flags["token-file"] === "string") {
    try {
      token = readFileSync(flags["token-file"], "utf8").trim() || null;
    } catch {
      throw new UsageError(`There is no token file at ${flags["token-file"]}.`);
    }
  }
  if (!server) return client(ctx.base, token, false);
  let url: URL;
  try {
    url = new URL(server);
  } catch {
    throw new UsageError(`--server is an address like http://192.168.1.20:8800, not "${server}".`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new UsageError("--server is an http or https address.");
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  // a plain http address on the network carries the token in the clear;
  // said once, since a home network may be exactly where that is fine
  if (!loopback && url.protocol === "http:" && token) ctx.stderr.write(`Note: ${url.host} is reached over plain http, so its token crosses the network unencrypted.\n`);
  if (!loopback && !token) {
    throw new Refused(
      `${url.host} is another computer, so this needs one of your paired devices' tokens: put it in BLOKS_SERVER_TOKEN, or name a file holding it with --token-file. Get one with: bloks-server token --server ${server} --code 123456`,
    );
  }
  return client(url.origin, token, !loopback);
}

class Refused extends Error {}

/** A refusal from the server, as the exit code it means. */
function exitFor(reply: Reply): number {
  if (reply.body?.code === "agent-not-found") return EXIT.agentNotFound;
  if (reply.status === 400 || reply.status === 413) return EXIT.usage;
  return EXIT.refused;
}

const errorOf = (reply: Reply) => String(reply.body?.error ?? `Bloks answered ${reply.status}.`);

// ── what a run looks like ─────────────────────────────────────────────

interface RunView {
  id: string;
  agent: { id: string; name: string };
  conversation: { id: string; title: string };
  status: "working" | "needs-you" | "done" | "failed" | "stopped";
  endedAt: number | null;
  duration: number;
  reply: string | null;
  error: string | null;
  turns: number;
  tokens: { input: number; output: number };
  cost: number | null;
  agents: Array<{ id: string; name: string }>;
  files: Array<
    | { kind: "artifact"; botId: string; agent: string; name: string; size: number; mime: string }
    | { kind: "change"; botId: string; agent: string; path: string; status: string; checkpointId: string }
  >;
  asks: Array<{ requestId: string; botId: string; agent: string; title: string; subtitle: string; options: string[]; approval: boolean }>;
  steps: Array<{ n: number; kind: string; agent: string; text: string }>;
  next: number;
}

/** One step as a line on the terminal: who, and what, compactly. */
export function stepLine(step: { kind: string; agent: string; text: string }): string | null {
  switch (step.kind) {
    case "started":
      return `  · ${step.agent} is working`;
    case "tool":
      return `  · ${step.agent}: ${step.text}`;
    case "handoff":
    case "file":
      return `  · ${step.agent} ${step.text}`;
    case "said":
      return `${step.agent}: ${step.text}`;
    case "notice":
      return `  ! ${step.text}`;
    default:
      return null;
  }
}

/** The card as a question a terminal can ask, and how its answer goes. */
function askLine(ask: RunView["asks"][number]): string {
  const what = [ask.title, ask.subtitle].filter(Boolean).join(": ");
  const choices = ask.approval ? "allow/deny" : ask.options.length ? ask.options.map((o, i) => `${i + 1}) ${o}`).join("  ") : "type your answer";
  return `? ${ask.agent} asks. ${what} [${choices}]`;
}

/** An answer typed at a card, as the respond route takes it, or null when
 * it does not answer it. An approval takes yes or no, never anything
 * read as one; a question with choices takes one by number or name. */
export function readAnswer(ask: { approval: boolean; options: string[] }, typed: string): { behavior: "allow" | "deny" | "answer"; message?: string } | null {
  const said = typed.trim();
  if (!said) return null;
  if (ask.approval) {
    if (/^(y|yes|allow)$/i.test(said)) return { behavior: "allow" };
    if (/^(n|no|deny)$/i.test(said)) return { behavior: "deny" };
    return null;
  }
  if (ask.options.length) {
    const n = Number(said);
    const picked = Number.isInteger(n) && n >= 1 && n <= ask.options.length ? ask.options[n - 1] : ask.options.find((o) => o.toLowerCase() === said.toLowerCase());
    return picked ? { behavior: "answer", message: picked } : null;
  }
  return { behavior: "answer", message: said };
}

/** Follows a run until it ends, needs the person, or `until` passes,
 * calling `step` for each new step. Long polls, so a step reaches the
 * terminal as soon as the server has it. */
async function follow(
  api: Client,
  run: RunView,
  opts: { until: number; step: (s: RunView["steps"][number]) => void; signal: AbortSignal; answered?: ReadonlySet<string> },
): Promise<{ run: RunView; why: "ended" | "needs-you" | "timeout" | "aborted" }> {
  let current = run;
  let after = 0;
  for (;;) {
    for (const s of current.steps) if (s.n > after) opts.step(s);
    after = Math.max(after, current.next);
    if (current.endedAt !== null) return { run: current, why: "ended" };
    // a card answered here is waited past until the server has it settled
    if (current.asks.some((a) => !opts.answered?.has(a.requestId))) return { run: current, why: "needs-you" };
    if (opts.signal.aborted) return { run: current, why: "aborted" };
    const left = opts.until - Date.now();
    if (left <= 0) return { run: current, why: "timeout" };
    const wait = Math.max(1, Math.min(20, Math.ceil(left / 1000)));
    let reply: Reply;
    try {
      reply = await api.call("GET", `/api/runs/${run.id}?after=${after}&wait=${wait}`, undefined, opts.signal);
    } catch (e) {
      if ((e as Error).name === "AbortError") return { run: current, why: "aborted" };
      throw e;
    }
    if (reply.status === 404) throw new LostRun(errorOf(reply));
    if (reply.status !== 200) throw new Refused(errorOf(reply));
    current = { ...reply.body.run, steps: reply.body.run.steps };
  }
}

class LostRun extends Error {}

/** Copies what a run made into `dir`: each deliverable by its name, each
 * file a turn changed by its path in the agent's folder, as the turn left
 * it. A deleted file is listed and not written. Never outside `dir`,
 * whatever a name says. */
async function exportFiles(api: Client, run: RunView, dir: string): Promise<{ written: string[]; skipped: Array<{ file: string; why: string }> }> {
  const root = resolve(dir);
  const written: string[] = [];
  const skipped: Array<{ file: string; why: string }> = [];
  for (const file of run.files) {
    const name = file.kind === "artifact" ? file.name : file.path;
    if (file.kind === "change" && file.status === "deleted") {
      skipped.push({ file: name, why: "deleted by the run" });
      continue;
    }
    const target = resolve(root, name);
    const inside = relative(root, target);
    if (!inside || inside.startsWith("..") || isAbsolute(inside)) {
      skipped.push({ file: name, why: "outside the export folder" });
      continue;
    }
    const res = await api.raw(
      file.kind === "artifact"
        ? `/api/bots/${encodeURIComponent(file.botId)}/artifacts/${encodeURIComponent(file.name)}`
        : `/api/runs/${run.id}/file?agent=${encodeURIComponent(file.botId)}&path=${encodeURIComponent(file.path)}`,
    );
    if (!res.ok) {
      const said = (await res.json().catch(() => null)) as { error?: string } | null;
      skipped.push({ file: name, why: said?.error ?? `answered ${res.status}` });
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, Buffer.from(await res.arrayBuffer()));
    written.push(inside);
  }
  return { written, skipped };
}

/** The one document `run --json` prints, whatever the ending. */
function runDocument(status: string, exitCode: number, run: RunView | null, extra: Record<string, unknown> = {}) {
  return {
    status,
    exitCode,
    reply: run?.reply ?? null,
    error: run?.error ?? null,
    run: run?.id ?? null,
    agent: run?.agent.name ?? null,
    conversation: run?.conversation ?? null,
    turns: run?.turns ?? 0,
    agents: run?.agents.map((a) => a.name) ?? [],
    files: (run?.files ?? []).map((f) =>
      f.kind === "artifact" ? { kind: f.kind, agent: f.agent, name: f.name, size: f.size } : { kind: f.kind, agent: f.agent, path: f.path, status: f.status },
    ),
    cost: run?.cost ?? null,
    tokens: run?.tokens ?? { input: 0, output: 0 },
    // seconds, to the tenth
    duration: run ? Math.round(run.duration / 100) / 10 : 0,
    asks: (run?.asks ?? []).map((a) => ({ agent: a.agent, title: a.title, subtitle: a.subtitle, options: a.options, approval: a.approval })),
    ...extra,
  };
}

// ── bloks-server run ──────────────────────────────────────────────────

const RUN_USAGE = `Usage: bloks-server run AGENT "TASK" [--conversation NAME|new] [--json] [--export DIR]
                       [--timeout 30m] [--approve never|ask] [--quiet] [--server URL]`;

async function runCommand(ctx: Context, args: string[]): Promise<number> {
  const { words, flags } = readArgs(args, ["conversation", "export", "timeout", "approve", "server", "token-file"]);
  const asJson = flags.json === true;
  const quiet = flags.quiet === true;
  const say = (line: string) => {
    if (!quiet) ctx.stderr.write(`${line}\n`);
  };
  const finish = (status: string, code: number, run: RunView | null, message?: string, extra: Record<string, unknown> = {}) => {
    if (asJson) ctx.stdout.write(`${JSON.stringify(runDocument(status, code, run, { ...(message && !run?.error ? { error: message } : {}), ...extra }), null, 2)}\n`);
    else if (message) ctx.stderr.write(`${message}\n`);
    return code;
  };
  const [agent, ...rest] = words;
  let text = rest.join(" ").trim();
  // "-" reads the task from stdin, for a prompt kept in a file
  if (text === "-") text = await readAll(ctx.stdin);
  if (!agent || !text.trim()) throw new UsageError(RUN_USAGE);
  const approve = flags.approve === undefined ? "never" : flags.approve;
  if (approve !== "never" && approve !== "ask") throw new UsageError("--approve is never or ask.");
  const limit = typeof flags.timeout === "string" ? readDuration(flags.timeout) : 30 * 60_000;
  const until = limit > 0 ? Date.now() + limit : Number.POSITIVE_INFINITY;
  const api = connect(ctx, flags);

  const started = await api.call("POST", "/api/runs", {
    agent,
    text,
    ...(typeof flags.conversation === "string" ? { conversation: flags.conversation } : {}),
  });
  if (started.status !== 201) {
    const code = exitFor(started);
    return finish(code === EXIT.agentNotFound ? "agent-not-found" : code === EXIT.usage ? "usage" : "refused", code, null, errorOf(started));
  }
  let run: RunView = started.body.run;
  say(`Asked ${run.agent.name} in "${run.conversation.title}".`);

  const stopping = new AbortController();
  let interrupted = false;
  const release = ctx.onInterrupt(() => {
    interrupted = true;
    stopping.abort();
  });
  const stop = async () => {
    const stopped = await api.call("POST", `/api/runs/${run.id}/stop`).catch(() => null);
    if (stopped?.status === 200) run = stopped.body.run;
  };
  const exportNow = async () => {
    if (typeof flags.export !== "string" || !run.files.length) return {};
    const done = await exportFiles(api, run, flags.export);
    if (done.written.length) say(`Exported ${done.written.length} ${done.written.length === 1 ? "file" : "files"} to ${resolve(flags.export)}.`);
    for (const s of done.skipped) say(`  Not exported: ${s.file} (${s.why})`);
    return { exported: done.written, notExported: done.skipped };
  };

  const answered = new Set<string>();
  try {
    for (;;) {
      const seen = await follow(api, run, { until, signal: stopping.signal, answered, step: (s) => {
        // the agent's own words end on stdout; a teammate's are progress
        const line = s.kind === "said" && s.agent === run.agent.name ? null : stepLine(s);
        if (line) say(line);
      } });
      run = seen.run;
      if (seen.why === "aborted" || interrupted) {
        await stop();
        return finish("stopped", EXIT.interrupted, run, "Stopped.", await exportNow());
      }
      if (seen.why === "timeout") {
        // a timeout is a bound on what a run may cost, so the work stops
        // with it rather than going on unwatched
        await stop();
        return finish("timed-out", EXIT.timedOut, run, `Out of time after ${Math.round(limit / 1000)} seconds. The run was stopped.`, await exportNow());
      }
      if (seen.why === "needs-you") {
        const ask = run.asks.find((a) => !answered.has(a.requestId))!;
        if (approve === "ask" && ctx.stdin.isTTY) {
          if (await answerAtTerminal(ctx, api, ask)) {
            answered.add(ask.requestId);
            continue;
          }
        }
        // Left open, not stopped: nothing runs while a card waits, so it
        // costs nothing, and the person can still answer it in the app.
        for (const a of run.asks) ctx.stderr.write(`${askLine(a)}\n`);
        return finish(
          "needs-you",
          EXIT.needsYou,
          run,
          `${ask.agent} is waiting on you in "${run.conversation.title}". Answer it in Bloks${approve === "ask" ? "" : ", or run with --approve ask in a terminal"}; the run carries on from there.`,
          await exportNow(),
        );
      }
      // ended
      const extra = await exportNow();
      if (run.status === "done") {
        if (!asJson) ctx.stdout.write(`${run.reply ?? ""}\n`);
        say(`Done in ${Math.round(run.duration / 100) / 10}s, ${run.turns} ${run.turns === 1 ? "turn" : "turns"}${run.cost !== null ? `, $${run.cost.toFixed(4)}` : ""}.`);
        return finish("done", EXIT.done, run, undefined, extra);
      }
      return finish(run.status, EXIT.failed, run, run.status === "stopped" ? "The run was stopped in Bloks." : (run.error ?? "The run failed."), extra);
    }
  } catch (e) {
    if (e instanceof LostRun) return finish("failed", EXIT.failed, run, "Bloks lost track of the run, which happens when it restarts. Look in the conversation for how it went.");
    throw e;
  } finally {
    release();
  }
}

async function answerAtTerminal(ctx: Context, api: Client, ask: RunView["asks"][number]): Promise<boolean> {
  const rl = createInterface({ input: ctx.stdin, output: ctx.stderr, terminal: true });
  try {
    for (;;) {
      const typed = await new Promise<string>((done) => rl.question(`${askLine(ask)} `, done));
      const answer = readAnswer(ask, typed);
      if (!answer) {
        ctx.stderr.write(ask.approval ? "Answer allow or deny.\n" : "That is not one of the choices.\n");
        continue;
      }
      const sent = await api.call("POST", `/api/bots/${ask.botId}/respond`, { requestId: ask.requestId, ...answer });
      return sent.status === 200 && sent.body?.ok !== false;
    }
  } finally {
    rl.close();
  }
}

function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((done, fail) => {
    let text = "";
    stream.setEncoding?.("utf8");
    stream.on("data", (c) => (text += c));
    stream.on("end", () => done(text));
    stream.on("error", fail);
  });
}

// ── bloks-server team apply ───────────────────────────────────────────

const TEAM_USAGE = "Usage: bloks-server team apply FILE [--dry-run] [--prune --yes] [--json] [--server URL]";

async function teamCommand(ctx: Context, args: string[]): Promise<number> {
  const { words, flags } = readArgs(args, ["server", "token-file"]);
  const [verb, file] = words;
  if (verb !== "apply" || !file) throw new UsageError(TEAM_USAGE);
  if (flags.prune === true && flags.yes !== true && flags["dry-run"] !== true) {
    throw new UsageError("--prune takes the agents the file does not list out of the room. Add --yes to say you mean it, or look first with --dry-run.");
  }
  let text: string;
  try {
    text = file === "-" ? await readAll(ctx.stdin) : readFileSync(file, "utf8");
  } catch {
    throw new UsageError(`There is no file at ${file}.`);
  }
  const api = connect(ctx, flags);
  const dryRun = flags["dry-run"] === true;
  const reply = await api.call("POST", "/api/teams/apply", { text, dryRun, prune: flags.prune === true });
  if (reply.status !== 200) {
    const code = reply.status === 409 ? EXIT.failed : exitFor(reply);
    if (flags.json === true) ctx.stdout.write(`${JSON.stringify({ applied: false, error: errorOf(reply), exitCode: code }, null, 2)}\n`);
    else ctx.stderr.write(`${errorOf(reply)}\n`);
    return code;
  }
  const plan: TeamPlan = reply.body.plan;
  if (flags.json === true) {
    ctx.stdout.write(`${JSON.stringify({ applied: reply.body.applied, dryRun, room: plan.room, changes: plan.changes, unchanged: plan.unchanged, extra: plan.extra }, null, 2)}\n`);
    return EXIT.done;
  }
  const lines = planLines(plan);
  if (!plan.changes.length) {
    ctx.stdout.write(`${plan.room.name} already matches the file. Nothing to change.\n`);
    for (const line of lines) ctx.stdout.write(`${line}\n`);
    return EXIT.done;
  }
  ctx.stdout.write(`${dryRun ? `Applying this file would change ${plan.room.name}:` : `${plan.room.name}:`}\n`);
  for (const line of lines) ctx.stdout.write(`${line}\n`);
  const count = plan.changes.length;
  ctx.stdout.write(dryRun ? `Dry run: nothing was changed. ${count} ${count === 1 ? "change" : "changes"} to apply.\n` : `Applied ${count} ${count === 1 ? "change" : "changes"}.\n`);
  return EXIT.done;
}

// ── bloks-server chat ─────────────────────────────────────────────────

const CHAT_HELP = [
  "/new          start a new conversation with your next message",
  "/stop         stop the turn that is running (Ctrl+C does too)",
  "/model        say which model this agent runs on; /model NAME switches it",
  "/help         this list",
  "/exit         leave (Ctrl+D does too)",
].join("\n");

/** Lines typed or piped in, handed out one at a time as they are asked
 * for. A line that arrives while nothing asks waits its turn, so a script
 * piped in is read in order, one message per turn. */
class Lines {
  private queue: string[] = [];
  private waiting: Array<(line: string | null) => void> = [];
  private ended = false;
  /** Lines that must not wait their turn: /stop, while a turn runs. */
  urgent: ((line: string) => boolean) | null = null;

  push(line: string) {
    if (this.urgent?.(line)) return;
    const next = this.waiting.shift();
    if (next) next(line);
    else this.queue.push(line);
  }

  end() {
    this.ended = true;
    for (const w of this.waiting.splice(0)) w(null);
  }

  next(): Promise<string | null> {
    if (this.queue.length) return Promise.resolve(this.queue.shift()!);
    if (this.ended) return Promise.resolve(null);
    return new Promise((done) => this.waiting.push(done));
  }
}

async function chatCommand(ctx: Context, args: string[]): Promise<number> {
  const { words, flags } = readArgs(args, ["conversation", "server", "token-file"]);
  const [asked] = words;
  if (!asked) throw new UsageError("Usage: bloks-server chat AGENT [--conversation NAME|new] [--server URL]");
  const api = connect(ctx, flags);
  const tty = Boolean(ctx.stdin.isTTY && ctx.stdout.isTTY);
  const out = (line: string) => ctx.stdout.write(`${line}\n`);

  const listed = await api.call("GET", "/api/bots?messages=0");
  if (listed.status !== 200) {
    ctx.stderr.write(`${errorOf(listed)}\n`);
    return exitFor(listed);
  }
  const want = asked.trim().toLowerCase();
  const bots: any[] = listed.body.bots ?? [];
  const bot = bots.find((b) => b.id === asked) ?? bots.find((b) => String(b.name).toLowerCase() === want);
  if (!bot) {
    ctx.stderr.write(`There is no agent called "${asked}" in this workspace.\n`);
    return EXIT.agentNotFound;
  }
  // the conversation each message goes to: as asked, then whichever the
  // first run went to, so "new" is new once and not on every line
  let conversation: string | undefined = typeof flags.conversation === "string" ? flags.conversation : undefined;
  const lane = conversation && conversation !== "new"
    ? (bot.tasks ?? []).find((t: any) => t.id === conversation || String(t.title).toLowerCase() === conversation!.toLowerCase())
    : !conversation
      ? (bot.tasks ?? []).find((t: any) => t.title === "General") ?? (bot.tasks ?? [])[0]
      : undefined;
  if (lane) conversation = lane.id;

  out(`${bot.name}${lane ? `, in "${lane.title}"` : ""}. Type a message, or /help.`);
  if (lane) {
    // where the conversation stands, so the first line typed is not a
    // reply to something unseen
    const history = await api.call("GET", `/api/bots/${bot.id}/messages?thread=${encodeURIComponent(lane.id)}&limit=40`);
    const said = ((history.body?.messages ?? []) as any[]).filter((m) => m.kind === "text" && m.text && !m.queued && !dismissedPreparation(m)).slice(-6);
    for (const m of said) out(`${m.role === "user" ? "you" : bot.name}: ${String(m.text).replace(/\s+/g, " ").slice(0, 300)}`);
    if (said.length) out("");
  }

  const lines = new Lines();
  let rl: Interface | null = null;
  let current: { id: string; stop: () => void } | null = null;
  if (tty) {
    rl = createInterface({ input: ctx.stdin, output: ctx.stdout, terminal: true, historySize: 200, prompt: "you> " });
    rl.on("line", (line) => lines.push(line));
    rl.on("close", () => lines.end());
    // Ctrl+C stops the turn, not the program
    rl.on("SIGINT", () => {
      if (current) current.stop();
      else {
        out("\n(Ctrl+C stops a turn. /exit or Ctrl+D leaves.)");
        rl?.prompt();
      }
    });
  } else {
    let buffer = "";
    ctx.stdin.setEncoding?.("utf8");
    ctx.stdin.on("data", (chunk: string) => {
      buffer += chunk;
      for (let i = buffer.indexOf("\n"); i >= 0; i = buffer.indexOf("\n")) {
        lines.push(buffer.slice(0, i).replace(/\r$/, ""));
        buffer = buffer.slice(i + 1);
      }
    });
    ctx.stdin.on("end", () => {
      if (buffer.trim()) lines.push(buffer);
      lines.end();
    });
  }
  const releaseInterrupt = ctx.onInterrupt(() => current?.stop());
  const stopOnly = (l: string) => {
    if (l.trim() !== "/stop") return false;
    current?.stop();
    return true;
  };

  /** One message, followed until the agent and whoever it handed work to
   * are done, with any card it raises asked here and answered. */
  const chatTurn = async (typed: string) => {
    const started = await api.call("POST", "/api/runs", { agent: bot.id, text: typed, ...(conversation ? { conversation } : {}) });
    if (started.status !== 201) {
      out(`! ${errorOf(started)}`);
      return;
    }
    let run: RunView = started.body.run;
    conversation = run.conversation.id;
    const stopper = new AbortController();
    current = {
      id: run.id,
      stop: () => {
        if (stopper.signal.aborted) return;
        stopper.abort();
        void api.call("POST", `/api/runs/${run.id}/stop`).catch(() => {});
      },
    };
    lines.urgent = stopOnly;
    const live = tty ? streamReplies(api, run.conversation.id, ctx.stdout, bot.name) : null;
    const answered = new Set<string>();
    try {
      for (;;) {
        const seen = await follow(api, run, {
          until: Number.POSITIVE_INFINITY,
          signal: stopper.signal,
          answered,
          step: (s) => {
            if (s.kind === "said" && s.agent === bot.name && live?.streamed()) return;
            const shown = stepLine(s);
            if (shown) out(shown);
          },
        });
        run = seen.run;
        if (seen.why === "aborted") return out("! Stopped.");
        if (seen.why === "needs-you") {
          const ask = run.asks.find((a) => !answered.has(a.requestId))!;
          out(askLine(ask));
          // the next line is the answer, not a message
          lines.urgent = null;
          for (;;) {
            const reply = await lines.next();
            if (reply === null) return out(`! ${ask.agent} is still waiting on you. Answer it in Bloks.`);
            if (reply.trim() === "/stop") {
              current?.stop();
              return out("! Stopped.");
            }
            const answer = readAnswer(ask, reply);
            if (!answer) {
              out(ask.approval ? "  Answer allow or deny." : "  That is not one of the choices.");
              continue;
            }
            const sent = await api.call("POST", `/api/bots/${ask.botId}/respond`, { requestId: ask.requestId, ...answer });
            if (sent.status !== 200 || sent.body?.ok === false) out("  ! That card had already closed.");
            answered.add(ask.requestId);
            break;
          }
          lines.urgent = stopOnly;
          continue;
        }
        if (run.status === "failed") out(`! ${run.error ?? "The turn did not finish."}`);
        else if (run.status === "stopped") out("! Stopped.");
        return;
      }
    } catch (e) {
      if (e instanceof LostRun) out("! Bloks lost track of this turn. It may have restarted.");
      else throw e;
    } finally {
      live?.close();
      current = null;
      lines.urgent = null;
    }
  };

  try {
    for (;;) {
      rl?.prompt();
      const line = await lines.next();
      if (line === null) break;
      const typed = line.trim();
      if (!typed) continue;
      const command = typed.startsWith("/") ? typed.slice(1).split(/\s+/)[0].toLowerCase() : null;
      if (command === "exit" || command === "quit") break;
      if (command === "help") out(CHAT_HELP);
      else if (command === "new") {
        conversation = "new";
        out("Your next message starts a new conversation.");
      } else if (command === "stop") out("Nothing is running.");
      else if (command === "model") await chatModel(api, bot, typed.slice(6).trim(), out);
      // anything else, a slash the engine knows included, is a message
      else await chatTurn(typed);
    }
  } finally {
    releaseInterrupt();
    rl?.close();
  }
  return EXIT.done;
}

/** /model: which model the agent runs on, or a switch to another the
 * same engines offer, matched by its id or its name. */
async function chatModel(api: Client, bot: any, asked: string, out: (line: string) => void) {
  const reply = await api.call("GET", "/api/instances");
  const instances: any[] = reply.body?.instances ?? [];
  const fresh = (await api.call("GET", "/api/bots?messages=0")).body?.bots?.find((b: any) => b.id === bot.id) ?? bot;
  const now = fresh.modelSelection ?? {};
  const engine = instances.find((i) => i.instanceId === now.instanceId);
  const label = (instance: any, id: string) => instance?.models?.options?.find((o: any) => o.id === id)?.label ?? id;
  if (!asked.trim()) {
    out(`${bot.name} runs on ${engine?.displayName ?? now.instanceId ?? "no engine"}${now.model ? `, ${label(engine, now.model)}` : ""}.`);
    const options: any[] = engine?.models?.options ?? [];
    if (options.length) out(`Models there: ${options.map((o) => o.id).join(", ")}`);
    return;
  }
  const want = asked.trim().toLowerCase();
  // the engine it is on first: a name two engines share means this one
  const ordered = [...instances].sort((a, b) => Number(b.instanceId === now.instanceId) - Number(a.instanceId === now.instanceId));
  for (const instance of ordered) {
    const option = (instance.models?.options ?? []).find((o: any) => o.id.toLowerCase() === want || String(o.label).toLowerCase() === want);
    if (!option) continue;
    const set = await api.call("PATCH", `/api/bots/${bot.id}`, { modelSelection: { instanceId: instance.instanceId, model: option.id } });
    if (set.status !== 200) out(`! ${errorOf(set)}`);
    else out(`${bot.name} now runs on ${instance.displayName}, ${option.label}.`);
    return;
  }
  out(`! No engine here offers a model called "${asked.trim()}". /model lists them.`);
}

/** A reply as it is written, from the event stream, for a terminal that
 * can show it word by word. Only the conversation the person is in; a
 * teammate's work shows as its steps. */
function streamReplies(api: Client, laneId: string, stdout: NodeJS.WritableStream, name: string) {
  const stop = new AbortController();
  let open = false;
  let any = false;
  void (async () => {
    try {
      const res = await fetch(`${api.base}/api/events`, {
        headers: { accept: "text/event-stream", ...(api.token ? { authorization: `Bearer ${api.token}` } : {}) },
        signal: stop.signal,
      });
      if (!res.ok || !res.body) return;
      const decoder = new TextDecoder();
      let buffer = "";
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });
        for (let i = buffer.indexOf("\n\n"); i >= 0; i = buffer.indexOf("\n\n")) {
          const frame = buffer.slice(0, i);
          buffer = buffer.slice(i + 2);
          const data = frame.split("\n").find((l) => l.startsWith("data: "));
          if (!data) continue;
          let parsed: any;
          try {
            parsed = JSON.parse(data.slice(6));
          } catch {
            continue;
          }
          const event = parsed?.kind === "runtime" ? parsed.event : null;
          if (!event || event.threadId !== laneId) continue;
          if (event.type === "content.delta" && event.streamKind === "assistant_text" && event.delta) {
            if (!open) stdout.write(`${name}: `);
            open = true;
            any = true;
            stdout.write(event.delta);
          } else if ((event.type === "item.completed" && event.itemType === "assistant_text") || event.type === "turn.completed") {
            if (open) stdout.write("\n");
            open = false;
          }
        }
      }
    } catch {
      /* the steps still say what was said */
    }
  })();
  return {
    /** Whether a reply has been shown as it was written, so the step that
     * carries the same words is not shown again. */
    streamed: () => {
      const was = any;
      any = false;
      return was;
    },
    close: () => {
      if (open) stdout.write("\n");
      stop.abort();
    },
  };
}

// ── bloks-server token ────────────────────────────────────────────────

/** Trades a six digit pairing code, shown when someone presses Pair a
 * phone on the workspace's computer, for a device token: what `--server`
 * then speaks with. The same trade a phone makes, and the device shows
 * in the workspace's list of paired devices, where it can be removed. */
async function tokenCommand(ctx: Context, args: string[]): Promise<number> {
  const { flags } = readArgs(args, ["server", "code", "name"]);
  if (typeof flags.server !== "string" || typeof flags.code !== "string") {
    throw new UsageError("Usage: bloks-server token --server URL --code 123456 [--name NAME]");
  }
  const api = client(new URL(flags.server).origin, null, true);
  const name = typeof flags.name === "string" ? flags.name : `bloks-server on ${hostname()}`;
  const reply = await api.call("POST", "/api/pair/claim", { credential: flags.code.trim(), device: name });
  if (reply.status !== 200 || typeof reply.body?.token !== "string") {
    ctx.stderr.write(`${errorOf(reply)}\n`);
    return EXIT.refused;
  }
  ctx.stderr.write(`Paired as "${reply.body.device?.name ?? name}". The token is shown once; keep it where secrets go (a CI secret, a file only you can read) and pass it as BLOKS_SERVER_TOKEN.\n`);
  ctx.stdout.write(`${reply.body.token}\n`);
  return EXIT.done;
}

// ── the door ──────────────────────────────────────────────────────────

export async function main(command: string, args: string[], ctx: Context): Promise<number> {
  try {
    if (command === "run") return await runCommand(ctx, args);
    if (command === "team") return await teamCommand(ctx, args);
    if (command === "chat") return await chatCommand(ctx, args);
    if (command === "token") return await tokenCommand(ctx, args);
    throw new UsageError(`Unknown command ${command}.`);
  } catch (e) {
    const json = args.includes("--json") && command === "run";
    const [status, code] =
      e instanceof UsageError ? ["usage", EXIT.usage] : e instanceof Unreachable ? ["unreachable", EXIT.unreachable] : e instanceof Refused ? ["refused", EXIT.refused] : [null, 0];
    if (status === null) throw e;
    if (json) ctx.stdout.write(`${JSON.stringify(runDocument(status as string, code as number, null, { error: (e as Error).message }), null, 2)}\n`);
    else ctx.stderr.write(`${(e as Error).message}\n`);
    return code as number;
  }
}

/** For the tests and the docs: every exit code, said once. */
export const EXIT_MEANING: Record<number, string> = {
  [EXIT.done]: "done: the agent and every teammate it handed work to finished",
  [EXIT.failed]: "failed: the turn failed, or the run was stopped in Bloks",
  [EXIT.usage]: "usage: a flag or the task was missing or wrong",
  [EXIT.timedOut]: "timed out: --timeout passed, and the run was stopped",
  [EXIT.needsYou]: "needs you: an approval or a question is waiting in Bloks",
  [EXIT.agentNotFound]: "agent not found",
  [EXIT.unreachable]: "server unreachable",
  [EXIT.refused]: "refused: not the owner, a bad token, an archived agent, or Bloks finishing up to restart",
  [EXIT.interrupted]: "interrupted: Ctrl+C stopped the run",
};
