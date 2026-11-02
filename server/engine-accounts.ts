// More than one sign-in for an engine, and which one the next turn uses
// (GitHub 465).
//
// A Claude or ChatGPT plan stops at its limit until a reset hours away.
// An agent with a backup engine goes on there, which is a different model
// and can handle the same task differently. With a second account of the
// same engine signed in, the agent can keep its model, its effort, its
// tools and its approvals, and only the account under it changes.
//
// The accounts belong to the workspace, beneath one engine instance, and
// never to an agent: an agent is who it is and remembers what it
// remembers whichever account is paying for its turn. The engine's own
// sign-in (whatever ~/.claude or ~/.codex holds, or CLAUDE_CONFIG_DIR and
// CODEX_HOME when this machine sets them) is always the first account.
// Each added one is the engine's own config folder, under the data folder,
// signed in with the engine's own login in Terminal. Bloks never reads,
// copies or moves what the engine keeps there: it only points a turn's
// CLI at the folder, the way the engine's documentation says to.
//
// Which account a turn uses is decided when it starts, and a turn that is
// running keeps its account to the end. The workspace has one account in
// use per engine. It changes when that account is out (it ran out on a
// turn, its plan says it is at its limit, or its sign-in lapsed), to the
// next one in the list that is not, and it does not change back on its
// own when the first one resets: going back and forth is a new session
// each time for every conversation. The person can choose another in
// Settings whenever they like. When no account can take the turn, the
// turn goes to the account back soonest, and the engine's ordinary
// failure handling says why and when; nothing here ever picks another
// model.
//
// A conversation's session belongs to the account that made it: the
// engine keeps sessions in the account's own folder, so a session id from
// one account means nothing to another. A conversation whose account
// changes starts a new session on the new one, told the conversation so
// far, the way a move to another folder does (server/store.ts
// moveTaskAccount), and the chat says so. It is never called a seamless
// continuation, because it is not one.
//
// The list and the account in use are kept in their own small file; the
// rests are kept in memory, like the engine-wide ones in failover.ts.
import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { isRecord, readSaved, writeFileAtomic } from "./atomic-write.ts";
import { Cooldowns, type OutReason, type Rest } from "./failover.ts";
import type { PlanUsage } from "./contracts.ts";

/** The engine's own sign-in: the first account of every engine. */
export const MAIN_ACCOUNT = "main";
/** Added accounts per engine, the engine's own sign-in not counted. */
export const MAX_ACCOUNTS = 8;
const MAX_LABEL = 40;
const ACCOUNT_ID = /^[a-f0-9]{12}$/;

/** What each engine that takes accounts needs: the variable that points
 * its CLI at another config folder, where its own folder is otherwise,
 * and the parts of that folder that are the person's setup rather than
 * the sign-in. Those are linked into an added account, so a turn on it
 * has the same settings, permissions, skills and plugins as one on the
 * main sign-in. The sign-in itself and the sessions are never linked: an
 * account's credential is its own, and a session belongs to the account
 * that made it. Claude Code keeps user MCP servers in .claude.json, next
 * to which account is signed in, so those stay with the main sign-in. */
export const ACCOUNT_ENGINES: Record<string, { env: string; folder: string; shared: readonly string[]; signIn: string[]; signOut: string[] }> = {
  claudeAgent: {
    env: "CLAUDE_CONFIG_DIR",
    folder: ".claude",
    shared: ["settings.json", "CLAUDE.md", "agents", "commands", "skills", "plugins", "output-styles"],
    signIn: [],
    signOut: ["auth", "logout"],
  },
  codex: {
    env: "CODEX_HOME",
    folder: ".codex",
    shared: ["config.toml", "AGENTS.md", "skills", "prompts", "rules"],
    signIn: ["login"],
    signOut: ["logout"],
  },
};

/** Whether accounts can be added to an engine of this kind. */
export function takesAccounts(driverKind: string | undefined): boolean {
  return Boolean(driverKind && Object.hasOwn(ACCOUNT_ENGINES, driverKind));
}

/** The engine's own config folder: the main sign-in's. */
export function mainFolder(driverKind: string, env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string | null {
  const engine = ACCOUNT_ENGINES[driverKind];
  if (!engine) return null;
  return env[engine.env]?.trim() || join(home, engine.folder);
}

export interface EngineAccount {
  id: string;
  /** The engine instance the account is under. */
  instanceId: string;
  /** What the person calls it, to tell two sign-ins apart. */
  label: string;
  addedAt: number;
}

interface Saved {
  accounts: EngineAccount[];
  /** The account in use per engine instance; absent is the main sign-in. */
  current: Record<string, string>;
}

/** Why an account cannot take a turn right now, and until when if known. */
export interface Blocked {
  why: "rest" | "plan" | "signedOut";
  reason: OutReason;
  until: number | null;
}

/** The account a turn starts on. `from` says why it is not the one that
 * was in use; `eligible` false means no account could take it, and this
 * is the one back soonest. */
export interface AccountPick {
  id: string;
  label: string;
  /** The config folder to point the CLI at; null for the main sign-in. */
  dir: string | null;
  eligible: boolean;
  from?: { id: string; label: string; blocked: Blocked };
  /** With nothing eligible, when the soonest account is expected back. */
  backAt?: number | null;
}

/** A share used that means the window is spent, by the engine's own word
 * or the numbers. */
function spent(window: PlanUsage["windows"][number]): boolean {
  return window.status === "rejected" || (Number.isFinite(window.used) && window.used >= 1);
}

/** How long a spent window that names no reset is believed, from when it
 * was heard: the default rest for a limit in failover.ts. */
const UNDATED_PLAN_MS = 30 * 60_000;

/**
 * When a plan the engine described stops being at its limit, or null
 * when it is not at one. A window whose reset has passed says nothing
 * any more; one with no reset is believed for half an hour after it was
 * heard, as a limit with no reset is in failover.ts.
 */
export function planBlockedUntil(usage: PlanUsage | null | undefined, now = Date.now()): number | null {
  if (!usage || !Array.isArray(usage.windows)) return null;
  let until: number | null = null;
  for (const window of usage.windows) {
    if (!spent(window)) continue;
    const ends = window.resetsAt ?? usage.at + UNDATED_PLAN_MS;
    if (ends <= now) continue;
    until = until === null ? ends : Math.max(until, ends);
  }
  return until;
}

/** A name the person gave, or why it is not one. */
export function checkLabel(raw: unknown): { label: string } | { error: string } {
  if (typeof raw !== "string") return { error: "Give the account a name." };
  const label = raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").replace(/\s+/g, " ").trim();
  if (!label) return { error: "Give the account a name." };
  if (label.length > MAX_LABEL) return { error: `Keep the name to ${MAX_LABEL} characters.` };
  return { label };
}

/** A path as one word in a POSIX shell, or in PowerShell on Windows. */
function quoted(path: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? `"${path.replace(/"/g, '`"')}"` : `'${path.replace(/'/g, `'\\''`)}'`;
}

/** The command that signs an added account in, in Terminal: the engine's
 * own login, pointed at the account's folder. */
export function signInCommand(driverKind: string, cli: string, dir: string, platform: NodeJS.Platform = process.platform): string | null {
  const engine = ACCOUNT_ENGINES[driverKind];
  if (!engine) return null;
  const run = [/[\s'"]/.test(cli) ? quoted(cli, platform) : cli, ...engine.signIn].join(" ");
  return platform === "win32" ? `$env:${engine.env}=${quoted(dir, platform)}; ${run}` : `${engine.env}=${quoted(dir, platform)} ${run}`;
}

/**
 * Makes an added account's folder, private, if it is not there, and links
 * the person's setup from the main sign-in's folder into it: the parts
 * ACCOUNT_ENGINES names and nothing else. A part
 * already there (linked before, or written by the engine itself) is left
 * as it is, and a link that cannot be made (a filesystem without them) is
 * skipped: the account still works, with the engine's defaults. Returns
 * what was linked this time.
 */
export function linkSetup(driverKind: string, dir: string, main: string | null): string[] {
  const engine = ACCOUNT_ENGINES[driverKind];
  if (!engine) return [];
  // made again if it went (a workspace moved without its sign-ins): the
  // engine then asks for a sign-in rather than failing to start
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!main || main === dir) return [];
  const linked: string[] = [];
  for (const name of engine.shared) {
    const from = join(main, name);
    const to = join(dir, name);
    if (!existsSync(from)) continue;
    try {
      lstatSync(to);
      continue;
    } catch {
      /* not there yet */
    }
    try {
      symlinkSync(from, to);
      linked.push(name);
    } catch {
      /* no links here; the engine's defaults it is */
    }
  }
  return linked;
}

const restKey = (instanceId: string, accountId: string) => `${instanceId}\u0000${accountId}`;

export class EngineAccounts {
  private readonly file: string;
  private readonly root: string;
  private saved: Saved;
  /** Accounts resting after a turn on them ran out, as engines do in
   * failover.ts, keyed by instance and account. */
  private rests = new Cooldowns();
  /** What each added account's CLI last said about its sign-in. */
  private signedIn = new Map<string, boolean>();

  constructor(opts: { file: string; root: string }) {
    this.file = opts.file;
    this.root = opts.root;
    const raw = readSaved<Record<string, unknown>>(this.file, {}, isRecord);
    const accounts = Array.isArray(raw.accounts)
      ? raw.accounts.filter(
          (a): a is EngineAccount =>
            isRecord(a) && typeof a.id === "string" && ACCOUNT_ID.test(a.id) && typeof a.instanceId === "string" && a.instanceId !== "" && typeof a.label === "string",
        ).map((a) => ({ id: a.id, instanceId: a.instanceId, label: a.label, addedAt: typeof a.addedAt === "number" ? a.addedAt : 0 }))
      : [];
    const current: Record<string, string> = {};
    if (isRecord(raw.current)) {
      for (const [instanceId, id] of Object.entries(raw.current)) {
        if (typeof id === "string" && accounts.some((a) => a.id === id && a.instanceId === instanceId)) current[instanceId] = id;
      }
    }
    this.saved = { accounts, current };
  }

  private keep() {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    writeFileAtomic(this.file, JSON.stringify(this.saved, null, 2), 0o600);
  }

  /** An added account's config folder. Never handed to a client or a
   * prompt: it is where the engine keeps the account's credential. */
  dir(id: string): string {
    return join(this.root, id);
  }

  /** The added accounts of one engine instance, in the order they are tried. */
  list(instanceId: string): EngineAccount[] {
    return this.saved.accounts.filter((a) => a.instanceId === instanceId);
  }

  get(id: string): EngineAccount | undefined {
    return this.saved.accounts.find((a) => a.id === id);
  }

  /** Whether an engine instance has any account besides its own sign-in. */
  has(instanceId: string): boolean {
    return this.saved.accounts.some((a) => a.instanceId === instanceId);
  }

  /** Every account of an engine, the main sign-in first. */
  order(instanceId: string): string[] {
    return [MAIN_ACCOUNT, ...this.list(instanceId).map((a) => a.id)];
  }

  /** An account as a person reads it in a notice. */
  label(id: string): string {
    return id === MAIN_ACCOUNT ? "the main sign-in" : (this.get(id)?.label ?? "a removed account");
  }

  current(instanceId: string): string {
    const id = this.saved.current[instanceId];
    return id && this.get(id)?.instanceId === instanceId ? id : MAIN_ACCOUNT;
  }

  /** The person chose the account in use. */
  choose(instanceId: string, id: string): boolean {
    if (id !== MAIN_ACCOUNT && this.get(id)?.instanceId !== instanceId) return false;
    this.setCurrent(instanceId, id);
    return true;
  }

  private setCurrent(instanceId: string, id: string) {
    if (this.current(instanceId) === id) return;
    if (id === MAIN_ACCOUNT) delete this.saved.current[instanceId];
    else this.saved.current[instanceId] = id;
    this.keep();
  }

  /** A new account under an engine instance, its folder made and private,
   * not yet signed in. */
  add(instanceId: string, label: string, now = Date.now()): EngineAccount {
    if (this.list(instanceId).length >= MAX_ACCOUNTS) throw Object.assign(new Error(`An engine can have ${MAX_ACCOUNTS} accounts besides its own sign-in.`), { status: 409 });
    let id = randomBytes(6).toString("hex");
    while (this.get(id)) id = randomBytes(6).toString("hex");
    mkdirSync(this.dir(id), { recursive: true, mode: 0o700 });
    const account = { id, instanceId, label, addedAt: now };
    this.saved.accounts.push(account);
    this.keep();
    return account;
  }

  rename(id: string, label: string): EngineAccount | null {
    const account = this.get(id);
    if (!account) return null;
    account.label = label;
    this.keep();
    return account;
  }

  /** Forgets an account and deletes its folder, the sign-in in it too.
   * The engine's own sign-out is the caller's to run first, while the
   * folder is still there to say whose sign-in it is. */
  remove(id: string): EngineAccount | null {
    const account = this.get(id);
    if (!account) return null;
    this.saved.accounts = this.saved.accounts.filter((a) => a.id !== id);
    if (this.saved.current[account.instanceId] === id) delete this.saved.current[account.instanceId];
    this.rests.clear(restKey(account.instanceId, id));
    this.signedIn.delete(id);
    this.keep();
    try {
      rmSync(this.dir(id), { recursive: true, force: true, maxRetries: 3 });
    } catch {
      /* gone from the list either way; the folder is only a sign-in nobody uses */
    }
    return account;
  }

  /** What an account's CLI said about its sign-in. Signing in clears a
   * rest that a lapsed sign-in put it on. */
  noteSignedIn(instanceId: string, id: string, signedIn: boolean, now = Date.now()) {
    if (id === MAIN_ACCOUNT) return;
    this.signedIn.set(id, signedIn);
    if (signedIn && this.rests.of(restKey(instanceId, id), now)?.reason === "signedOut") this.rests.clear(restKey(instanceId, id));
  }

  /** A turn on this account ran out. */
  markOut(instanceId: string, id: string, reason: OutReason, text: string, now = Date.now()): Rest {
    return this.rests.rest(restKey(instanceId, id), reason, text, now);
  }

  /** A turn on this account answered: it is not out, if the turn began
   * after it last was. */
  answered(instanceId: string, id: string, startedAt: number, now = Date.now()) {
    const key = restKey(instanceId, id);
    if (this.rests.of(key, now)?.reason === "signedOut") this.rests.clear(key);
    else this.rests.answered(key, startedAt);
  }

  restOf(instanceId: string, id: string, now = Date.now()): Rest | undefined {
    return this.rests.of(restKey(instanceId, id), now);
  }

  /** Why an account cannot take a turn now, or null when it can. */
  blocked(instanceId: string, id: string, planOf: (id: string) => PlanUsage | null, now = Date.now()): Blocked | null {
    const rest = this.restOf(instanceId, id, now);
    if (rest) return { why: rest.reason === "signedOut" ? "signedOut" : "rest", reason: rest.reason, until: rest.until };
    if (id !== MAIN_ACCOUNT && this.signedIn.get(id) === false) return { why: "signedOut", reason: "signedOut", until: null };
    const plan = planBlockedUntil(planOf(id), now);
    if (plan !== null) return { why: "plan", reason: "limit", until: plan };
    return null;
  }

  private choice(id: string): Pick<AccountPick, "id" | "label" | "dir"> {
    return { id, label: this.label(id), dir: id === MAIN_ACCOUNT ? null : this.dir(id) };
  }

  /**
   * The account a turn on this engine starts on. The one in use while it
   * can take it; otherwise the next in the list after it that can, which
   * becomes the one in use; otherwise, with none able, the one expected
   * back soonest, left as it is. An engine with no added accounts is
   * always its own sign-in, as it was before there were accounts.
   */
  pick(instanceId: string, planOf: (id: string) => PlanUsage | null, now = Date.now()): AccountPick {
    const order = this.order(instanceId);
    const current = this.current(instanceId);
    if (order.length === 1) return { ...this.choice(current), eligible: true };
    const here = this.blocked(instanceId, current, planOf, now);
    if (!here) return { ...this.choice(current), eligible: true };
    const start = order.indexOf(current);
    for (let step = 1; step < order.length; step++) {
      const id = order[(start + step) % order.length];
      if (this.blocked(instanceId, id, planOf, now)) continue;
      this.setCurrent(instanceId, id);
      return { ...this.choice(id), eligible: true, from: { id: current, label: this.label(current), blocked: here } };
    }
    // none can: the one back soonest, an unknown return last
    let soonest = current;
    let backAt = here.until;
    for (const id of order) {
      const until = this.blocked(instanceId, id, planOf, now)?.until ?? null;
      if (until !== null && (backAt === null || until < backAt)) {
        soonest = id;
        backAt = until;
      }
    }
    return { ...this.choice(soonest), eligible: false, backAt };
  }

  /** Whether another account than `id` could take a turn now. */
  anotherEligible(instanceId: string, id: string, planOf: (id: string) => PlanUsage | null, now = Date.now()): boolean {
    return this.order(instanceId).some((other) => other !== id && !this.blocked(instanceId, other, planOf, now));
  }

  /** When the first account of an engine is expected back, or null when
   * none says. */
  firstBack(instanceId: string, planOf: (id: string) => PlanUsage | null, now = Date.now()): number | null {
    let first: number | null = null;
    for (const id of this.order(instanceId)) {
      const until = this.blocked(instanceId, id, planOf, now)?.until ?? null;
      if (until !== null && (first === null || until < first)) first = until;
    }
    return first;
  }
}

/** Why an account was left, as a notice says it. */
export function blockedWords(blocked: Blocked): string {
  if (blocked.why === "signedOut") return "is not signed in";
  if (blocked.reason === "limit") return "is at its usage limit";
  if (blocked.reason === "credit") return "is out of credit";
  if (blocked.reason === "overloaded") return "is overloaded";
  return "is not available";
}
