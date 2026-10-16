// Fixed native-owned review profile. HTTP transport and trusted turn-origin
// assembly are separate callers, never a caller-selected command endpoint.
import { createHash, randomBytes } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { realpathSync, readdirSync, statSync, readFileSync } from "node:fs";
import { isAbsolute, relative, sep, join } from "node:path";
import { EnginePauses, EnginePauseError, type EngineInvocation, type EngineRoute, type InvocationOrigin, type PauseStorage } from "./engine-pauses.ts";
import { writeFileAtomic } from "./atomic-write.ts";

export function helperFile(file: string): PauseStorage {
  return { load() {
    try { return JSON.parse(readFileSync(file, "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, reviews: [], operations: [] }; throw new HelperError("storage"); }
  }, save(value) { writeFileAtomic(file, JSON.stringify(value), 0o600, { fallbackInPlace: false }); } };
}

export interface HelperOrigin {
  id: string;
  invocation: InvocationOrigin;
  host: string;
  generation: string;
}
/** Supplied synchronously by authenticated native scope, never request JSON.
 * effectiveFullAccess includes sharing/guest/rehearsal/tool constraints. */
export interface ReviewProfile {
  host: string;
  originGeneration: string;
  permissionGeneration: string;
  configurationGeneration: string;
  effectiveFullAccess: boolean;
  cwd: string;
  roots: string[];
  executable: string;
  environment: NodeJS.ProcessEnv;
  projectsDirectory: string;
  instanceId: string;
}
export type HelperRequest = {
  version: 1; operationId: string; profile: "claude.review";
  reviewId: string; sessionId: string; resume: boolean;
  additionalDirectories: string[];
} & ({ phase: "auth" } | { phase: "model"; authRunId: string; prompt: string });
type RunState = "accepted" | "pending" | "running" | "cancel-requested" | "completed" | "failed" | "cancelled" | "residual";
interface ReviewRecord {
  id: string; owner: string; sessionId: string; resume: boolean; roots: string[];
  fingerprint: string; deadline: number; authId: string; modelId?: string;
}
interface OperationRecord {
  id: string; owner: string; reviewId: string; sessionId: string; phase: "auth" | "model";
  digest: string; state: RunState; acceptedAt: number; invocationId?: string;
  localClosed: boolean; descendants: "closed" | "unconfirmed"; remote: "none" | "unconfirmed";
  reason?: string;
  outputComplete?: boolean;
  cancelRequested?: boolean;
}
interface Ledger { version: 1; reviews: ReviewRecord[]; operations: OperationRecord[] }
export interface HelperEvent {
  version: 1; operationId: string; phase: "auth" | "model"; seq: number; type: string;
  [key: string]: unknown;
}
interface Capability { origin: HelperOrigin; owner: string; live: () => boolean }
interface Runtime {
  events: HelperEvent[]; bytes: number; subscribers: Set<() => void>;
  lease?: EngineInvocation; child?: ChildProcessWithoutNullStreams;
  attachTimer?: ReturnType<typeof setTimeout>; timeout?: ReturnType<typeof setTimeout>;
  hardStop?: ReturnType<typeof setTimeout>; observeStop?: ReturnType<typeof setTimeout>;
  cancel: boolean; overflow: boolean; inputFailed: boolean; attached: boolean; readers: number; stopReason?: string;
  auth?: { loggedIn: true; apiProvider: "firstParty"; authMethod: "claude.ai"; projectsDirectory: string };
  done: Promise<void>; resolveDone: () => void;
}
const uuid = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const within = (root: string, path: string) => { const r = relative(root, path); return r === "" || (!r.startsWith(`..${sep}`) && r !== ".." && !isAbsolute(r)); };
const limits = { body: 2_000_000, output: 8 * 1024 * 1024, chunk: 16 * 1024, records: 2_000 };
const envRemoved = new Set([
  "CLAUDECODE", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY",
  "ANTHROPIC_PROFILE", "ANTHROPIC_FEDERATION_RULE_ID", "ANTHROPIC_ORGANIZATION_ID",
  "ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_FABLE_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL",
]);
export function reviewEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // Parent owner/agent/helper credentials must not reach the model or tools.
  const env = Object.fromEntries(Object.entries(source).filter(([key]) => !envRemoved.has(key) && !key.startsWith("BLOKS_")));
  env.OMNI_CLAUDE_REVIEW = "1";
  return env;
}
export class HelperError extends Error {
  readonly code: "invalid" | "forbidden" | "conflict" | "pending" | "storage" | "cursor";
  constructor(code: HelperError["code"]) { super(`Engine helper ${code}.`); this.name = "HelperError"; this.code = code; }
}
function request(input: unknown): HelperRequest {
  if (!object(input) || Buffer.byteLength(JSON.stringify(input)) > limits.body || input.version !== 1 || input.profile !== "claude.review" ||
      !uuid(input.operationId) || !uuid(input.reviewId) || !uuid(input.sessionId) || typeof input.resume !== "boolean" ||
      !Array.isArray(input.additionalDirectories) || input.additionalDirectories.length > 32 ||
      !input.additionalDirectories.every(p => typeof p === "string" && Buffer.byteLength(p) <= 4096 && isAbsolute(p)) ||
      (input.phase !== "auth" && input.phase !== "model")) throw new HelperError("invalid");
  const allowed = ["version", "operationId", "profile", "reviewId", "sessionId", "resume", "additionalDirectories", "phase"];
  if (input.phase === "model") {
    allowed.push("authRunId", "prompt");
    if (!uuid(input.authRunId) || typeof input.prompt !== "string" || !input.prompt.trim()) throw new HelperError("invalid");
  }
  if (Object.keys(input).some(k => !allowed.includes(k))) throw new HelperError("invalid");
  return { version: 1, operationId: input.operationId, profile: "claude.review", reviewId: input.reviewId,
    sessionId: input.sessionId, resume: input.resume, additionalDirectories: [...new Set(input.additionalDirectories as string[])].sort(),
    ...(input.phase === "auth" ? { phase: "auth" } : { phase: "model", authRunId: input.authRunId as string, prompt: input.prompt as string }) };
}
function prepareProfile(origin: HelperOrigin, value: ReviewProfile | null, directories: string[]) {
  if (!value || !value.effectiveFullAccess || value.host !== origin.host || value.originGeneration !== origin.generation) throw new HelperError("pending");
  try {
    const cwd = realpathSync(value.cwd), roots = value.roots.map(p => realpathSync(p));
    if (!roots.some(root => within(root, cwd))) throw new Error();
    const additionalDirectories = directories.map(p => realpathSync(p));
    if (additionalDirectories.some(p => !statSync(p).isDirectory() || !roots.some(root => within(root, p)))) throw new Error();
    const profile = { ...value, cwd, roots, executable: realpathSync(value.executable),
      projectsDirectory: realpathSync(value.projectsDirectory), environment: reviewEnvironment(value.environment) };
    const executable = statSync(profile.executable);
    if (!isAbsolute(profile.executable) || !executable.isFile()) throw new Error();
    // A fixed alias/fallback/nested/resume profile has unknown exact models.
    // One conservative route prevents an allowed primary hiding a forbidden
    // internal fallback. The same profile builds the actual argv below.
    // Native settings/gateway provenance is not attested by an executable
    // name or an auth status result. An unknown family cannot fail open.
    const routes: EngineRoute[] = [{ instanceId: profile.instanceId, driverKind: "claudeAgent", family: null, model: null }];
    return { profile, additionalDirectories: [...new Set(additionalDirectories)].sort(), routes,
      fingerprint: digest({ ...profile, environment: profile.environment,
        executableIdentity: [executable.dev, executable.ino, executable.size, executable.mtimeMs, executable.ctimeMs] }) };
  } catch { throw new HelperError("pending"); }
}
export interface HelperTiming { attach: number; auth: number; model: number; hardStop: number; observeStop: number; lifetime: number }
const defaultTiming: HelperTiming = { attach: 10_000, auth: 10_000, model: 3_600_000, hardStop: 3_000, observeStop: 5_000, lifetime: 3_600_000 };

export class EngineHelperBroker {
  private ledger: Ledger = { version: 1, reviews: [], operations: [] };
  private fault = false;
  private serial: Promise<unknown> = Promise.resolve();
  private capabilities = new Map<string, Capability>();
  private runtime = new Map<string, Runtime>();
  private policy: EnginePauses;
  private storage: PauseStorage;
  private resolve: (origin: HelperOrigin) => ReviewProfile | null;
  private now: () => number;
  private timing: HelperTiming;
  constructor(policy: EnginePauses, storage: PauseStorage, resolve: (origin: HelperOrigin) => ReviewProfile | null,
    options: { now?: () => number; timing?: Partial<HelperTiming> } = {}) {
    this.policy = policy; this.storage = storage; this.resolve = resolve; this.now = options.now ?? Date.now;
    this.timing = { ...defaultTiming, ...options.timing };
    try {
      const saved = storage.load();
      if (!object(saved) || saved.version !== 1 || !Array.isArray(saved.reviews) || !Array.isArray(saved.operations) ||
          saved.reviews.length > limits.records || saved.operations.length > limits.records) throw new Error();
      for (const r of saved.reviews) if (!object(r) || !uuid(r.id) || !uuid(r.sessionId) || !uuid(r.authId) ||
        (r.modelId !== undefined && !uuid(r.modelId)) || typeof r.owner !== "string" || typeof r.fingerprint !== "string" ||
        typeof r.resume !== "boolean" || typeof r.deadline !== "number" || !Number.isFinite(r.deadline) ||
        !Array.isArray(r.roots) || r.roots.length > 32 || !r.roots.every(p => typeof p === "string")) throw new Error();
      for (const r of saved.operations) if (!object(r) || !uuid(r.id) || !uuid(r.reviewId) || !uuid(r.sessionId) ||
        typeof r.owner !== "string" || typeof r.digest !== "string" || typeof r.acceptedAt !== "number" || !Number.isFinite(r.acceptedAt) ||
        !["auth", "model"].includes(r.phase as string) || !["accepted", "pending", "running", "cancel-requested", "completed", "failed", "cancelled", "residual"].includes(r.state as string) ||
        typeof r.localClosed !== "boolean" || !["closed", "unconfirmed"].includes(r.descendants as string) ||
        !["none", "unconfirmed"].includes(r.remote as string) || (r.invocationId !== undefined && !uuid(r.invocationId))) throw new Error();
      if (new Set(saved.reviews.map(r => r.id)).size !== saved.reviews.length || new Set(saved.operations.map(r => r.id)).size !== saved.operations.length) throw new Error();
      // Never load prompts, output, capabilities or arbitrary saved metadata.
      this.ledger.reviews = saved.reviews.map(r => ({ id: r.id, owner: r.owner, sessionId: r.sessionId, resume: r.resume,
        roots: [...r.roots], fingerprint: r.fingerprint, deadline: r.deadline, authId: r.authId, ...(r.modelId ? { modelId: r.modelId } : {}) }));
      this.ledger.operations = saved.operations.map(r => ({ id: r.id, owner: r.owner, reviewId: r.reviewId, sessionId: r.sessionId,
        phase: r.phase, digest: r.digest, acceptedAt: r.acceptedAt, ...(r.invocationId ? { invocationId: r.invocationId } : {}),
        state: ["accepted", "running", "cancel-requested"].includes(r.state) ? "residual" : r.state,
        localClosed: r.localClosed, descendants: r.descendants, remote: r.remote,
        ...(typeof r.outputComplete === "boolean" ? { outputComplete: r.outputComplete } : {}),
        ...(typeof r.cancelRequested === "boolean" ? { cancelRequested: r.cancelRequested } : {}) }));
    } catch { this.fault = true; }
  }
  /** Native scope issuer only; never exposed as an owner-auth HTTP route. */
  issue(origin: HelperOrigin, live: () => boolean): string {
    if (this.fault) throw new HelperError("storage");
    if (this.capabilities.size >= 4_000) throw new HelperError("pending");
    const token = randomBytes(32).toString("base64url");
    this.capabilities.set(token, { origin: structuredClone(origin), owner: digest(token), live });
    return token;
  }
  private capability(token: string, launch = false): Capability {
    const cap = this.capabilities.get(token);
    if (!cap) throw new HelperError("forbidden");
    if (this.fault && launch) throw new HelperError("storage");
    return cap;
  }
  private mutate<T>(fn: (next: Ledger) => T): Promise<T> {
    const operation = this.serial.then(async () => {
      if (this.fault) throw new HelperError("storage");
      const next = structuredClone(this.ledger), result = fn(next);
      try { await this.storage.save(next); } catch { this.fault = true; throw new HelperError("storage"); }
      this.ledger = next; return result;
    });
    this.serial = operation.catch(() => {}); return operation;
  }
  private owned(cap: Capability, id: string): OperationRecord {
    const run = this.ledger.operations.find(r => r.id === id && r.owner === cap.owner);
    if (!run) throw new HelperError("forbidden"); return run;
  }
  private event(id: string, type: string, data: Record<string, unknown> = {}) {
    const rt = this.runtime.get(id), run = this.ledger.operations.find(r => r.id === id);
    if (!rt || !run) return;
    rt.events.push({ version: 1, operationId: id, phase: run.phase, seq: rt.events.length + 1, type, ...data });
    for (const notify of rt.subscribers) notify();
  }
  async start(token: string, input: unknown) {
    const cap = this.capability(token, true), req = request(input), bodyDigest = digest(req);
    const found = this.ledger.operations.find(r => r.id === req.operationId);
    if (found) {
      if (found.owner !== cap.owner || found.digest !== bodyDigest) throw new HelperError("conflict");
      return { version: 1 as const, operationId: found.id, phase: found.phase, state: "existing" as const };
    }
    const current = prepareProfile(cap.origin, this.resolve(cap.origin), req.additionalDirectories);
    this.policy.assertAllowed(cap.origin.invocation, current.routes);
    const at = this.now();
    // Reservation and model/auth binding are one durable serial transaction.
    const added = await this.mutate(next => {
      const old = next.operations.find(r => r.id === req.operationId);
      if (old) {
        if (old.owner !== cap.owner || old.digest !== bodyDigest) throw new HelperError("conflict");
        return false;
      }
      if (next.operations.length >= limits.records) throw new HelperError("pending");
      let review = next.reviews.find(r => r.id === req.reviewId);
      if (req.phase === "auth") {
        if (review) throw new HelperError("conflict");
        if (!cap.live() || next.reviews.length >= limits.records) throw new HelperError("pending");
        review = { id: req.reviewId, owner: cap.owner, sessionId: req.sessionId, resume: req.resume,
          roots: current.additionalDirectories, fingerprint: current.fingerprint, deadline: at + this.timing.lifetime, authId: req.operationId };
        next.reviews.push(review);
      } else {
        if (!review || review.owner !== cap.owner || review.authId !== req.authRunId || review.sessionId !== req.sessionId ||
            review.resume !== req.resume || JSON.stringify(review.roots) !== JSON.stringify(current.additionalDirectories)) throw new HelperError("conflict");
        if (review.modelId) throw new HelperError("conflict");
        const auth = next.operations.find(r => r.id === req.authRunId);
        if (!auth || auth.state !== "completed" || !this.runtime.get(auth.id)?.auth) throw new HelperError("pending");
        review.modelId = req.operationId;
      }
      if (this.now() >= review.deadline || review.fingerprint !== current.fingerprint) throw new HelperError("pending");
      next.operations.push({ id: req.operationId, owner: cap.owner, reviewId: req.reviewId, sessionId: req.sessionId,
        phase: req.phase, digest: bodyDigest, state: "accepted", acceptedAt: at, localClosed: false, descendants: "unconfirmed", remote: req.phase === "model" ? "unconfirmed" : "none" });
      return true;
    });
    if (added) {
      let resolveDone!: () => void;
      const done = new Promise<void>(resolve => { resolveDone = resolve; });
      const rt: Runtime = { events: [], bytes: 0, subscribers: new Set(), cancel: false, overflow: false, inputFailed: false, attached: false, readers: 0, done, resolveDone };
      this.runtime.set(req.operationId, rt);
      this.event(req.operationId, "accepted");
      rt.attachTimer = setTimeout(() => { if (!rt.attached) void this.cancel(token, req.operationId).catch(() => {}); }, this.timing.attach);
      void this.launch(cap, req, rt).catch(() => { this.fault = true; rt.resolveDone(); });
    }
    return { version: 1 as const, operationId: req.operationId, phase: req.phase, state: added ? "accepted" as const : "existing" as const };
  }
  private async launch(cap: Capability, req: HelperRequest, rt: Runtime) {
    let lease: EngineInvocation | undefined;
    try {
      let current = prepareProfile(cap.origin, this.resolve(cap.origin), req.additionalDirectories);
      lease = await this.policy.prepare(cap.origin.invocation, current.routes, `helper-${req.phase}:${req.operationId}`);
      rt.lease = lease;
      lease.onCancel(() => this.stop(req.operationId, rt));
      await this.mutate(next => { next.operations.find(r => r.id === req.operationId)!.invocationId = lease!.record.id; });
      current = prepareProfile(cap.origin, this.resolve(cap.origin), req.additionalDirectories);
      const review = this.ledger.reviews.find(r => r.id === req.reviewId)!;
      if (rt.cancel || lease.signal.aborted || current.fingerprint !== review.fingerprint ||
          JSON.stringify(current.additionalDirectories) !== JSON.stringify(review.roots) || this.now() >= review.deadline) throw new HelperError("pending");
      // Auth cannot authorize a changed account/config/permission generation.
      // Recheck canonical paths after all async intent writes, at actual spawn.
      if (req.phase === "model" && req.resume) {
        const projects = this.runtime.get(req.authRunId)?.auth?.projectsDirectory;
        if (!projects || readdirSync(projects, { withFileTypes: true }).filter(entry => entry.isDirectory() &&
          (() => { try { return statSync(join(projects, entry.name, `${req.sessionId}.jsonl`)).isFile(); } catch { return false; } })()).length !== 1) throw new HelperError("pending");
      }
      const { profile } = current;
      const args = req.phase === "auth" ? ["auth", "status", "--json"] : ["-p", "--model", "fable", "--fallback-model", "opus", "--effort", "max",
        "--tools", "default", "--permission-mode", "bypassPermissions", "--output-format", "stream-json", "--verbose",
        ...(req.resume ? ["--resume", req.sessionId] : ["--session-id", req.sessionId, "--name", "Claude collaboration"]),
        ...(current.additionalDirectories.length ? ["--add-dir", ...current.additionalDirectories] : [])];
      const child = lease.invoke(() => spawn(profile.executable, args, { cwd: profile.cwd, env: profile.environment,
        stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true }));
      rt.child = child;
      // No event-loop gap exists between actual spawn and installing its exact
      // child generation. Activation afterwards sees this registered lease.
      this.event(req.operationId, "launched");
      void this.mutate(next => { next.operations.find(r => r.id === req.operationId)!.state = "running"; }).catch(() => {
        void this.stop(req.operationId, rt).catch(() => { this.fault = true; });
      });
      let authBytes = Buffer.alloc(0), childError = false;
      child.on("error", () => { childError = true; });
      child.stdin.on("error", () => { rt.inputFailed = true; void this.stop(req.operationId, rt, "input-failed").catch(() => { this.fault = true; }); });
      for (const channel of ["stdout", "stderr"] as const) child[channel].on("data", (chunk: Buffer) => {
        if (rt.overflow) return;
        rt.bytes += chunk.length;
        if (rt.bytes > limits.output) { rt.overflow = true; void this.stop(req.operationId, rt, "output-limit").catch(() => { this.fault = true; }); return; }
        if (req.phase === "auth") { if (channel === "stdout") authBytes = Buffer.concat([authBytes, chunk]); return; }
        for (let at = 0; at < chunk.length; at += limits.chunk) this.event(req.operationId, channel, { dataBase64: chunk.subarray(at, at + limits.chunk).toString("base64") });
      });
      rt.timeout = setTimeout(() => { void this.stop(req.operationId, rt, "timeout").catch(() => { this.fault = true; }); }, Math.min(req.phase === "auth" ? this.timing.auth : this.timing.model, review.deadline - this.now()));
      const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child.once("close", (code, signal) => resolve({ code, signal })));
      child.stdin.end(req.phase === "model" ? req.prompt : undefined);
      const close = await closed;
      if (rt.timeout) clearTimeout(rt.timeout);
      if (rt.hardStop) clearTimeout(rt.hardStop);
      if (rt.observeStop) clearTimeout(rt.observeStop);
      let authValid = req.phase !== "auth";
      if (req.phase === "auth" && close.code === 0 && !rt.cancel && !rt.overflow && !childError) {
        try {
          const auth = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(authBytes));
          if (auth.loggedIn !== true || auth.apiProvider !== "firstParty" || auth.authMethod !== "claude.ai" ||
              (auth.projectsDirectory !== undefined && (typeof auth.projectsDirectory !== "string" || realpathSync(auth.projectsDirectory) !== profile.projectsDirectory))) throw new Error();
          // Existing subscription status may omit projectsDirectory. Its
          // fallback is the native profile's bound config/home directory,
          // never a client-supplied path or guessed remote filesystem.
          rt.auth = { loggedIn: true, apiProvider: "firstParty", authMethod: "claude.ai", projectsDirectory: profile.projectsDirectory };
          authValid = true; this.event(req.operationId, "auth", rt.auth);
        } catch { /* Safe failure, never forward credential-bearing auth output. */ }
      }
      // Native model close alone cannot prove nested/remote work ended. Keep
      // this conservative residual until a supported authoritative observation.
      const remote = req.phase === "model" ? "unconfirmed" as const : "none" as const;
      const descendants = !child.pid || this.groupClosed(child) ? "closed" as const : "unconfirmed" as const;
      const uncertain = remote === "unconfirmed" || descendants === "unconfirmed";
      const broken = rt.overflow || rt.inputFailed || childError;
      const outcome = broken ? "failed" : rt.cancel ? uncertain ? "residual" : "cancelled" :
        close.code !== 0 || !authValid ? "failed" : uncertain ? "residual" : "completed";
      await this.finish(req.operationId, outcome, { exitCode: close.code, signal: close.signal, localClosed: true, descendants, remote,
        outputComplete: !broken && !rt.cancel && close.code === 0 && authValid, cancelRequested: rt.cancel,
        ...(rt.stopReason ? { reason: rt.stopReason } : {}) });
      if (uncertain) await lease.residual(); else await lease.closed();
    } catch (error) {
      // An admission outcome never becomes an auth/provider retry/fallback.
      const reason = error instanceof EnginePauseError ? error.code : error instanceof HelperError ? error.code : "pending";
      if (rt.child) {
        // After spawn, a storage or lifecycle failure is not evidence that
        // the provider never ran or stopped. Fail closed and retain intent.
        this.fault = true;
        try { await this.stop(req.operationId, rt); } catch { /* The durable intent remains for restart. */ }
        try { await lease?.residual(); } catch { /* Both stores remain closed. */ }
      } else {
        await this.finish(req.operationId, rt.cancel ? "cancelled" : "pending", { reason, localClosed: true, descendants: "closed", remote: "none" });
        if (lease) await lease.closed();
      }
    } finally { if (rt.attachTimer && rt.readers === 0) clearTimeout(rt.attachTimer); rt.resolveDone(); }
  }
  private groupClosed(child: ChildProcessWithoutNullStreams) {
    if (process.platform === "win32" || !child.pid) return false;
    try { process.kill(-child.pid, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
  }
  private async stop(id: string, rt: Runtime, reason = "cancel-requested") {
    if (rt.cancel) return;
    rt.cancel = true;
    rt.stopReason = reason;
    const prior = this.ledger.operations.find(r => r.id === id)!;
    if (prior.localClosed) return; // A sent interrupt cannot settle remote uncertainty.
    const child = rt.child;
    const kill = (signal: NodeJS.Signals) => {
      // Only this retained child, while still observed active, never a stored
      // PID after restart or a later child using a lane's reused key.
      if (!child || child.exitCode !== null || child.signalCode !== null) return;
      try { if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal); else child.kill(signal); } catch { /* Remains unconfirmed until close. */ }
    };
    // Cancellation itself must still reach the retained process on a ledger
    // failure. Its already durable intent remains residual after restart.
    kill("SIGTERM");
    if (child && child.exitCode === null && child.signalCode === null) {
      rt.hardStop = setTimeout(() => kill("SIGKILL"), this.timing.hardStop);
      rt.observeStop = setTimeout(() => {
      void this.finish(id, "residual", { localClosed: false, descendants: "unconfirmed", remote: "unconfirmed", reason: "stop-unconfirmed" })
        .then(() => rt.lease?.residual()).catch(() => { this.fault = true; });
      }, this.timing.observeStop);
    }
    await this.mutate(next => { const run = next.operations.find(r => r.id === id)!;
      if (!["completed", "failed", "cancelled", "pending"].includes(run.state)) run.state = "cancel-requested"; });
    this.event(id, "cancel-requested");
  }
  private async finish(id: string, state: RunState, facts: Record<string, unknown>) {
    // Never-spawned and unconfirmed-close paths have no observed process exit.
    // The wire still carries explicit nulls, not missing lifecycle fields.
    const lifecycle: Record<string, unknown> = { exitCode: null, signal: null, outputComplete: false,
      cancelRequested: this.runtime.get(id)?.cancel === true, ...facts };
    await this.mutate(next => {
      const run = next.operations.find(r => r.id === id)!;
      run.state = state; run.localClosed = lifecycle.localClosed === true;
      run.descendants = lifecycle.descendants === "closed" ? "closed" : "unconfirmed";
      run.remote = lifecycle.remote === "none" ? "none" : "unconfirmed";
      if (typeof lifecycle.reason === "string") run.reason = lifecycle.reason;
      if (typeof lifecycle.outputComplete === "boolean") run.outputComplete = lifecycle.outputComplete;
      if (typeof lifecycle.cancelRequested === "boolean") run.cancelRequested = lifecycle.cancelRequested;
    });
    this.event(id, "terminal", { state, ...lifecycle });
  }
  async cancel(token: string, id: string) {
    const cap = this.capability(token), run = this.owned(cap, id), rt = this.runtime.get(id);
    if (rt && !["completed", "failed", "cancelled", "pending"].includes(run.state)) await this.stop(id, rt);
    return { version: 1 as const, operationId: id, state: this.owned(cap, id).state };
  }
  /** Transport calls attach after authenticating Host/Origin. First attachment
   * gets a grace period; subsequent disconnect cancellation is irreversible. */
  attach(token: string, id: string, after: number, notify: () => void) {
    const cap = this.capability(token); this.owned(cap, id);
    const rt = this.runtime.get(id);
    if (!rt || !Number.isSafeInteger(after) || after < 0 || after > rt.events.length) throw new HelperError("cursor");
    rt.attached = true; rt.readers++; if (rt.attachTimer) clearTimeout(rt.attachTimer);
    rt.subscribers.add(notify);
    let detached = false;
    return { read: () => rt.events.slice(after).map(e => structuredClone(e)),
      detach: () => { if (detached) return; detached = true; rt.subscribers.delete(notify); rt.readers--;
        if (rt.readers === 0) void this.cancel(token, id).catch(() => {}); } };
  }
  events(token: string, id: string, after = 0): HelperEvent[] {
    this.owned(this.capability(token), id);
    const rt = this.runtime.get(id);
    if (!rt || !Number.isSafeInteger(after) || after < 0 || after > rt.events.length) throw new HelperError("cursor");
    return rt.events.slice(after).map(e => structuredClone(e));
  }
  async settled(token: string, id: string) { this.owned(this.capability(token), id); await this.runtime.get(id)?.done; }
  /** Native authoritative completion observer only, never helper-submitted
   * lifecycle claims. No new launch and no change to an earlier content result.
   * Unsupported providers have no such observer and retain their residual. */
  async reconcile(id: string, observed: { localClosed: true; descendants: "closed"; remote: "none" }) {
    const run = this.ledger.operations.find(r => r.id === id);
    if (!run || (run.state !== "residual" && run.remote !== "unconfirmed" && run.descendants !== "unconfirmed") || observed.localClosed !== true || observed.descendants !== "closed" || observed.remote !== "none") throw new HelperError("conflict");
    const state = run.cancelRequested ? "cancelled" : run.outputComplete ? "completed" : "failed";
    await this.mutate(next => { const current = next.operations.find(r => r.id === id)!;
      current.localClosed = true; current.descendants = "closed"; current.remote = "none";
      // This settles outstanding activity with the original local outcome.
      // Adapter content validity is independent and is never changed here.
      current.state = state; current.reason = "residual-settled";
    });
    const lease = this.runtime.get(id)?.lease;
    if (lease) await lease.closed(); else if (run.invocationId) await this.policy.complete(run.invocationId);
    this.event(id, "reconciled", { state, reason: "residual-settled", ...observed });
  }
  /** Caller must authenticate native owner/agent access separately. No raw
   * prompt/output, roots, auth details or capability in this projection. */
  status() {
    return { unavailable: this.fault, operations: this.ledger.operations.map(({ id, reviewId, sessionId, phase, state,
      acceptedAt, invocationId, localClosed, descendants, remote, reason, outputComplete, cancelRequested }) =>
      ({ id, reviewId, sessionId, phase, state, acceptedAt, invocationId, localClosed, descendants, remote, reason, outputComplete, cancelRequested,
        outstanding: remote === "unconfirmed" || descendants === "unconfirmed" })) };
  }
}
