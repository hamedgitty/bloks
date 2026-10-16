// A temporary admission restriction, never a rewrite of model preferences.
// Load before driver creation. Drivers must call lease.invoke at each actual
// provider boundary, not reuse an earlier admission after an await.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { writeFileAtomic } from "./atomic-write.ts";

export type PauseActor = { kind: "owner" } | { kind: "agent"; id: string };
/** Derived by the harness, never from a helper's submitted agent id. Shared
 * factory work cannot exempt itself by having no agent attribution. */
export type InvocationOrigin = { kind: "agent"; agentId: string; laneId?: string } | { kind: "service" };
/** Resolve once in the driver and use that same result in wire arguments.
 * null means unknown, including a mutable alias without authoritative ids. */
export interface EngineRoute {
  instanceId: string;
  driverKind: string;
  family: string | null;
  model: string | null;
}
export interface PauseRequest {
  id: string;
  agents: "all" | string[];
  selector: { family?: string; driverKind?: string; instanceId?: string; model?: string };
  until: number;
  timeZone: string;
}
export interface EnginePause extends PauseRequest {
  creator: PauseActor;
  createdAt: number;
  activatedAt: number;
  cancelledAt?: number;
}
export type InvocationState = "registered" | "running" | "cancelRequested" | "residual";
export interface InvocationRecord {
  id: string;
  origin: InvocationOrigin;
  routes: EngineRoute[];
  purpose: string;
  registeredAt: number;
  state: InvocationState;
  /** Durable policy cancellation provenance survives residual/restart/expiry. */
  cancelRequestedAt?: number;
}
interface SavedPauses { version: 1; pauses: EnginePause[]; invocations: InvocationRecord[] }
/** Async only to make the persistence boundary explicit and testable. The
 * production store uses a flushed atomic rename, with no in-place fallback. */
export interface PauseStorage { load(): unknown; save(state: unknown): void | Promise<void> }
export function pauseFile(file: string): PauseStorage {
  return {
    load() {
      try { return JSON.parse(readFileSync(file, "utf8")); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, pauses: [], invocations: [] };
        throw new Error("Engine pause state could not be read.");
      }
    },
    save(state) { writeFileAtomic(file, JSON.stringify(state), 0o600, { fallbackInPlace: false }); },
  };
}

export class EnginePauseError extends Error {
  readonly code: "invalid" | "conflict" | "forbidden" | "paused" | "activating" | "storage" | "closed";
  constructor(code: EnginePauseError["code"]) {
    const words = {
      invalid: "Invalid engine pause request.", conflict: "This operation id already has a different request.",
      forbidden: "Only the owner or this pause's creator may cancel it.",
      paused: "This engine route is paused or its identity is unresolved under a pause.",
      activating: "An engine pause is being saved; this invocation remains pending.",
      storage: "Engine pause state is unavailable; engine work remains pending.",
      closed: "This invocation has ended or was cancelled; it cannot be reused.",
    };
    super(words[code]); this.name = "EnginePauseError"; this.code = code;
  }
}

const token = (v: unknown, max = 128): v is string => typeof v === "string" && v.length > 0 && v.length <= max && /^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/.test(v);
const stamp = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 8.64e15;
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
function actorValid(v: unknown): v is PauseActor {
  return record(v) && (v.kind === "owner" || (v.kind === "agent" && token(v.id)));
}
function originValid(v: unknown): v is InvocationOrigin {
  return record(v) && (v.kind === "service" || (v.kind === "agent" && token(v.agentId) && (v.laneId === undefined || token(v.laneId))));
}
function routeValid(v: unknown): v is EngineRoute {
  return record(v) && token(v.instanceId) && token(v.driverKind) && (v.family === null || token(v.family)) && (v.model === null || token(v.model, 256));
}
function normalize(input: PauseRequest): PauseRequest {
  if (!record(input) || !token(input.id) || !stamp(input.until) || !record(input.selector) ||
      (input.agents !== "all" && (!Array.isArray(input.agents) || !input.agents.length || input.agents.length > 1_000 || !input.agents.every(id => token(id)))) ||
      typeof input.timeZone !== "string" || input.timeZone.length > 100) throw new EnginePauseError("invalid");
  const selector: PauseRequest["selector"] = {};
  for (const key of Object.keys(input.selector)) {
    if (!["family", "driverKind", "instanceId", "model"].includes(key)) throw new EnginePauseError("invalid");
  }
  for (const key of ["family", "driverKind", "instanceId", "model"] as const) {
    const value = input.selector[key];
    if (value !== undefined) {
      if (!token(value, key === "model" ? 256 : 128)) throw new EnginePauseError("invalid");
      selector[key] = value;
    }
  }
  if (!Object.keys(selector).length) throw new EnginePauseError("invalid");
  try { new Intl.DateTimeFormat("en", { timeZone: input.timeZone }); } catch { throw new EnginePauseError("invalid"); }
  return { id: input.id, agents: input.agents === "all" ? "all" : [...new Set(input.agents)].sort(), selector, until: input.until, timeZone: input.timeZone };
}
const sameActor = (a: PauseActor, b: PauseActor) => a.kind === b.kind && (a.kind === "owner" || (b.kind === "agent" && a.id === b.id));
const copyActor = (a: PauseActor): PauseActor => a.kind === "owner" ? { kind: "owner" } : { kind: "agent", id: a.id };
const copyOrigin = (o: InvocationOrigin): InvocationOrigin => o.kind === "service" ? { kind: "service" } : { kind: "agent", agentId: o.agentId, ...(o.laneId ? { laneId: o.laneId } : {}) };
const copyRoutes = (routes: readonly EngineRoute[]) => routes.map(({ instanceId, driverKind, family, model }) => ({ instanceId, driverKind, family, model }));
function sameRequest(a: PauseRequest, b: PauseRequest): boolean { return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b)); }
function selected(pause: PauseRequest, origin: InvocationOrigin, routes: readonly EngineRoute[]): boolean {
  if (origin.kind === "agent" && pause.agents !== "all" && !pause.agents.includes(origin.agentId)) return false;
  const wanted = pause.selector;
  return routes.some(route => (!wanted.instanceId || route.instanceId === wanted.instanceId) &&
    (!wanted.driverKind || route.driverKind === wanted.driverKind) &&
    (!wanted.family || route.family === null || route.family === wanted.family) &&
    (!wanted.model || route.model === null || route.model === wanted.model));
}

/** One physical invocation, retained until observed close or an explicit
 * residual. A parent turn ending, instance reload or sent interrupt is not a
 * close. Every generation has a new id and its own cancellation callback. */
export class EngineInvocation {
  private value: InvocationRecord;
  readonly signal: AbortSignal;
  private abort = new AbortController();
  private cancel: (() => void | Promise<void>) | undefined;
  private ended = false;
  private uncertain = false;
  private cancelSent = false;
  private owner: EnginePauses;
  constructor(owner: EnginePauses, value: InvocationRecord) {
    this.owner = owner; this.value = structuredClone(value); this.signal = this.abort.signal;
  }
  get record(): InvocationRecord { return structuredClone(this.value); }
  /** Install against the exact child/session, never a later lane or PID. */
  onCancel(cancel: () => void | Promise<void>) {
    if (this.ended) return;
    this.cancel = cancel;
    if (this.signal.aborted) this.requestCancel();
  }
  requestCancel() {
    if (this.ended) return;
    if (this.value.state !== "residual") this.value.state = "cancelRequested";
    this.abort.abort();
    if (!this.cancel || this.cancelSent) return;
    this.cancelSent = true;
    try {
      void Promise.resolve(this.cancel()).catch(() => this.residual()).catch(() => {});
    } catch { void this.residual().catch(() => {}); }
  }
  /** Synchronous check and actual provider operation in the same JS step.
   * An earlier call never permits the next RPC after an await. */
  invoke<T>(operation: () => T): T {
    if (this.ended || this.uncertain || this.signal.aborted) throw new EnginePauseError("closed");
    this.owner.assertAllowed(this.value.origin, this.value.routes);
    this.value.state = "running";
    return operation();
  }
  async closed(): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    await this.owner.complete(this.value.id);
  }
  async residual(): Promise<void> {
    if (this.ended) return;
    this.uncertain = true;
    this.value.state = "residual";
    await this.owner.noteResidual(this.value.id);
  }
}

export class EnginePauses {
  private state: SavedPauses = { version: 1, pauses: [], invocations: [] };
  private fault = false;
  private pending: PauseRequest[] = [];
  private serial: Promise<unknown> = Promise.resolve();
  private live = new Map<string, EngineInvocation>();
  private storage: PauseStorage;
  private now: () => number;
  constructor(storage: PauseStorage, now: () => number = Date.now) {
    this.storage = storage; this.now = now;
    try {
      const saved = storage.load();
      if (!record(saved) || saved.version !== 1 || !Array.isArray(saved.pauses) || !Array.isArray(saved.invocations) || saved.pauses.length > 1_000 || saved.invocations.length > 4_000) throw new Error();
      const pauses = saved.pauses as EnginePause[];
      const runs = saved.invocations as InvocationRecord[];
      for (const p of pauses) {
        normalize(p);
        if (!actorValid(p.creator) || !stamp(p.createdAt) || !stamp(p.activatedAt) || (p.cancelledAt !== undefined && !stamp(p.cancelledAt))) throw new Error();
      }
      for (const run of runs) {
        if (!record(run) || !token(run.id) || !originValid(run.origin) || !token(run.purpose) || !stamp(run.registeredAt) ||
            !Array.isArray(run.routes) || !run.routes.length || run.routes.length > 32 || !run.routes.every(routeValid) ||
            !["registered", "running", "cancelRequested", "residual"].includes(run.state) ||
            (run.cancelRequestedAt !== undefined && !stamp(run.cancelRequestedAt))) throw new Error();
      }
      if (new Set(pauses.map(p => p.id)).size !== pauses.length || new Set(runs.map(r => r.id)).size !== runs.length) throw new Error();
      // A crash does not prove whether the registered operation started or
      // stopped. Keep it until authoritative completion is reconciled.
      this.state = {
        version: 1,
        pauses: pauses.map(p => ({ ...normalize(p), creator: copyActor(p.creator), createdAt: p.createdAt, activatedAt: p.activatedAt, ...(p.cancelledAt !== undefined ? { cancelledAt: p.cancelledAt } : {}) })),
        invocations: runs.map(r => ({ id: r.id, origin: copyOrigin(r.origin), routes: copyRoutes(r.routes), purpose: r.purpose, registeredAt: r.registeredAt, state: "residual",
          ...(r.cancelRequestedAt !== undefined ? { cancelRequestedAt: r.cancelRequestedAt } : r.state === "cancelRequested" ? { cancelRequestedAt: r.registeredAt } : {}) })),
      };
    } catch { this.fault = true; }
  }
  assertAllowed(origin: InvocationOrigin, routes: readonly EngineRoute[]) {
    if (!originValid(origin) || !routes.length || routes.length > 32 || !routes.every(routeValid)) throw new EnginePauseError("invalid");
    if (this.fault) throw new EnginePauseError("storage");
    if (this.pending.some(p => p.until > this.now() && selected(p, origin, routes))) throw new EnginePauseError("activating");
    if (this.state.pauses.some(p => p.cancelledAt === undefined && p.until > this.now() && selected(p, origin, routes))) throw new EnginePauseError("paused");
  }
  allowed(origin: InvocationOrigin, routes: readonly EngineRoute[]): boolean {
    try { this.assertAllowed(origin, routes); return true; } catch { return false; }
  }
  /** Callers supply their already configured routes in existing preference
   * order. Same-instance alternatives remain eligible for model-only pauses. */
  choose<T extends { routes: EngineRoute[] }>(origin: InvocationOrigin, candidates: readonly T[]): T | null {
    return candidates.find(candidate => this.allowed(origin, candidate.routes)) ?? null;
  }
  private mutate<T>(change: (next: SavedPauses) => T): Promise<T> {
    const operation = this.serial.then(async () => {
      if (this.fault) throw new EnginePauseError("storage");
      const next = structuredClone(this.state);
      const result = change(next);
      try { await this.storage.save(next); }
      catch { this.fault = true; throw new EnginePauseError("storage"); }
      this.state = next;
      return result;
    });
    this.serial = operation.catch(() => {});
    return operation;
  }
  async activate(actor: PauseActor, value: PauseRequest): Promise<EnginePause> {
    if (!actorValid(actor)) throw new EnginePauseError("forbidden");
    if (this.fault) throw new EnginePauseError("storage");
    const input = normalize(value);
    const found = this.state.pauses.find(p => p.id === input.id);
    if (found && (!sameActor(found.creator, actor) || !sameRequest(found, input))) throw new EnginePauseError("conflict");
    if (found) return structuredClone(found);
    if (!found && input.until <= this.now()) throw new EnginePauseError("invalid");
    // Fence matching dispatches before the first persistence await. Even a
    // concurrent activation cannot leave an async permission-to-launch gap.
    this.pending.push(input);
    try {
      const result = await this.mutate(next => {
        const prior = next.pauses.find(p => p.id === input.id);
        if (prior) {
          if (!sameActor(prior.creator, actor) || !sameRequest(prior, input)) throw new EnginePauseError("conflict");
          return prior;
        }
        if (next.pauses.length >= 1_000) throw new EnginePauseError("invalid");
        const at = this.now();
        const added: EnginePause = { ...input, creator: copyActor(actor), createdAt: at, activatedAt: at };
        next.pauses.push(added);
        if (added.until > at) for (const run of next.invocations) if (selected(added, run.origin, run.routes)) {
          run.state = "cancelRequested";
          run.cancelRequestedAt ??= at;
        }
        return added;
      });
      // Restriction is now durable and published, before cancellation. Never
      // await a driver's cancellation to make safe status available.
      if (result.cancelledAt === undefined && result.until > this.now()) {
        for (const run of this.live.values()) if (selected(result, run.record.origin, run.record.routes)) run.requestCancel();
      }
      return structuredClone(result);
    } finally { this.pending.splice(this.pending.indexOf(input), 1); }
  }
  cancel(actor: PauseActor, id: string): Promise<EnginePause> {
    if (!actorValid(actor) || !token(id)) return Promise.reject(new EnginePauseError("forbidden"));
    return this.mutate(next => {
      const p = next.pauses.find(p => p.id === id);
      if (!p || (actor.kind !== "owner" && !sameActor(actor, p.creator))) throw new EnginePauseError("forbidden");
      p.cancelledAt ??= this.now();
      return structuredClone(p);
    });
  }
  /** Persist the uncertain intent before any native/remote side effect. The
   * driver then uses invoke, which rechecks after this persistence await. */
  async prepare(origin: InvocationOrigin, routes: EngineRoute[], purpose: string): Promise<EngineInvocation> {
    this.assertAllowed(origin, routes);
    if (!token(purpose)) throw new EnginePauseError("invalid");
    const value: InvocationRecord = { id: randomUUID(), origin: copyOrigin(origin), routes: copyRoutes(routes), purpose, registeredAt: this.now(), state: "registered" };
    const lease = new EngineInvocation(this, value);
    this.live.set(value.id, lease);
    try {
      await this.mutate(next => {
        if (next.invocations.length >= 4_000) throw new EnginePauseError("invalid");
        next.invocations.push(value);
      });
      return lease;
    } catch (error) { this.live.delete(value.id); throw error; }
  }
  async complete(id: string): Promise<void> {
    await this.mutate(next => { next.invocations = next.invocations.filter(r => r.id !== id); });
    this.live.delete(id);
  }
  noteResidual(id: string): Promise<void> {
    return this.mutate(next => { const run = next.invocations.find(r => r.id === id); if (run) run.state = "residual"; });
  }
  /** Source recovery must not turn an uncertain cancelled invocation into
   * an automatic resend just because its restriction later expired. */
  interruptedLane(agentId: string, laneId: string, since: number): boolean {
    return this.state.invocations.some(run => run.cancelRequestedAt !== undefined && run.registeredAt >= since &&
      run.origin.kind === "agent" && run.origin.agentId === agentId && run.origin.laneId === laneId);
  }
  status() {
    const now = this.now();
    return {
      unavailable: this.fault,
      activating: this.pending.map(p => p.id),
      pauses: structuredClone(this.state.pauses).map(p => ({ ...p, state: p.cancelledAt !== undefined ? "cancelled" : p.until <= now ? "expired" : "active" })),
      // Expiry/deletion never clears outstanding uncertainty.
      invocations: this.state.invocations.map(r => ({ ...structuredClone(r), state: this.live.get(r.id)?.record.state ?? r.state })),
    };
  }
}
