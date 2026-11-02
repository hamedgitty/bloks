// What is a member's own in a workspace they joined (GitHub 386, 431).
//
// Two people in one household ask the same agent to "pull my email". Each
// should get their own account, never the owner's and never each other's,
// and neither should need a workspace of their own to have that. So a
// member keeps, here, the apps they connected and the keys they saved:
//
//   apps     their own Composio Connect key. Composio holds the accounts
//            they sign in to (Gmail, Calendar, and so on) under that key,
//            so the key is the member's identity there, and it is apart
//            from the owner's key in config.json.
//   secrets  keys of their own, by environment variable name, under the
//            same reserved names the owner's are (server/env-names.ts).
//
// Which turns get them is server/access.ts personalAccountsFor: a turn the
// member asked for, in their own private conversation or their own solo
// agent, and nothing else. Never a team conversation, a room, the owner's
// turns or another member's. Nothing here is ever sent back to anybody,
// the member included: a key is shown by its last four characters, a
// secret by its name.
//
// It is kept in people/<id>/own.json, 0600, beside the member's notes, so
// removing them from the workspace removes it (server/members.ts). The
// computer it lives on is the owner's, and the person who runs that
// computer can read any file on it; the app says so where a member
// connects anything.
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { isRecord, readSaved, writeFileAtomic } from "./atomic-write.ts";
import { reservedEnvName } from "./env-names.ts";
import { MAX_PERSONAL_SECRETS, MAX_PERSONAL_SECRET_CHARS } from "./limits.ts";

export interface PersonalFile {
  version: 1;
  /** When they saw the welcome, on any device of theirs. */
  welcomedAt?: number;
  apps?: { key: string; savedAt: number };
  secrets?: Record<string, { value: string; savedAt: number }>;
}

/** What a member is shown of their own: never a value. */
export interface PersonalView {
  apps: { connected: boolean; ending: string | null; savedAt: number | null };
  secrets: Array<{ name: string; savedAt: number }>;
}

const ID = /^[\w-]{1,64}$/;

/** A secret's name as an agent's shell will read it: "Transistor API
 * key" becomes TRANSISTOR_API_KEY. */
export function secretName(raw: unknown): string {
  return String(raw ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);
}

/** Why a name cannot hold a secret, or null when it can. */
export function secretNameRefusal(name: string): string | null {
  if (!name) return "Give the key a name, like TRANSISTOR_API_KEY.";
  if (/^[0-9]/.test(name)) return "A key's name starts with a letter.";
  if (reservedEnvName(name)) return `${name} is a name the system and the engines read for themselves. Choose a name for what the key is for.`;
  return null;
}

/** A Composio Connect key as pasted, or null when it is not one. Shape
 * only: whether Composio knows it is asked separately. */
export function appsKey(raw: unknown): string | null {
  const key = typeof raw === "string" ? raw.trim() : "";
  return /^ck_[A-Za-z0-9_-]{8,200}$/.test(key) ? key : null;
}

export class Personal {
  private cache = new Map<string, PersonalFile>();
  private readonly dataDir: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
  }

  private file(personId: string) {
    return join(this.dataDir, "people", personId, "own.json");
  }

  of(personId: string): PersonalFile {
    if (!ID.test(personId)) return { version: 1 };
    const cached = this.cache.get(personId);
    if (cached) return cached;
    const saved = readSaved<Record<string, unknown>>(this.file(personId), {}, isRecord);
    const next: PersonalFile = { version: 1 };
    if (typeof saved.welcomedAt === "number") next.welcomedAt = saved.welcomedAt;
    const apps = saved.apps as { key?: unknown; savedAt?: unknown } | undefined;
    if (isRecord(apps) && appsKey(apps.key)) next.apps = { key: appsKey(apps.key)!, savedAt: Number(apps.savedAt) || 0 };
    if (isRecord(saved.secrets)) {
      const secrets: NonNullable<PersonalFile["secrets"]> = {};
      for (const [name, entry] of Object.entries(saved.secrets)) {
        if (secretName(name) !== name || secretNameRefusal(name) || !isRecord(entry) || typeof entry.value !== "string") continue;
        secrets[name] = { value: entry.value, savedAt: Number(entry.savedAt) || 0 };
      }
      if (Object.keys(secrets).length) next.secrets = secrets;
    }
    this.cache.set(personId, next);
    return next;
  }

  private save(personId: string, next: PersonalFile) {
    if (!ID.test(personId)) throw new Error("not a person");
    mkdirSync(join(this.dataDir, "people", personId), { recursive: true, mode: 0o700 });
    writeFileAtomic(this.file(personId), JSON.stringify(next, null, 2), 0o600);
    this.cache.set(personId, next);
  }

  /** Their own Composio Connect key, for their own turns, or null. */
  appsKeyOf(personId: string): string | null {
    return this.of(personId).apps?.key ?? null;
  }

  setAppsKey(personId: string, key: string | null, now = Date.now()) {
    const { apps: _apps, ...rest } = this.of(personId);
    this.save(personId, key ? { ...rest, apps: { key, savedAt: now } } : rest);
  }

  /** Their own keys, by name, for their own turns' environment. A name
   * that became reserved since it was saved is left out. */
  secretsOf(personId: string): Record<string, string> {
    const secrets = this.of(personId).secrets ?? {};
    return Object.fromEntries(Object.entries(secrets).filter(([name]) => !reservedEnvName(name)).map(([name, entry]) => [name, entry.value]));
  }

  saveSecret(personId: string, rawName: unknown, rawValue: unknown, now = Date.now()): { name: string } | { error: string } {
    const name = secretName(rawName);
    const refused = secretNameRefusal(name);
    if (refused) return { error: refused };
    const value = typeof rawValue === "string" ? rawValue.trim() : "";
    if (!value) return { error: "Paste the value first." };
    if (value.length > MAX_PERSONAL_SECRET_CHARS) return { error: "That is longer than a key. Paste only the key itself." };
    const was = this.of(personId);
    const secrets = { ...(was.secrets ?? {}) };
    if (!secrets[name] && Object.keys(secrets).length >= MAX_PERSONAL_SECRETS) {
      return { error: `You have ${MAX_PERSONAL_SECRETS} keys here already. Forget one you no longer use first.` };
    }
    secrets[name] = { value, savedAt: now };
    this.save(personId, { ...was, secrets });
    return { name };
  }

  forgetSecret(personId: string, rawName: unknown): boolean {
    const name = secretName(rawName);
    const was = this.of(personId);
    if (!was.secrets?.[name]) return false;
    const { [name]: _gone, ...secrets } = was.secrets;
    const { secrets: _old, ...rest } = was;
    this.save(personId, Object.keys(secrets).length ? { ...rest, secrets } : rest);
    return true;
  }

  welcomed(personId: string): boolean {
    return typeof this.of(personId).welcomedAt === "number";
  }

  welcome(personId: string, now = Date.now()) {
    if (this.welcomed(personId)) return;
    this.save(personId, { ...this.of(personId), welcomedAt: now });
  }

  view(personId: string): PersonalView {
    const own = this.of(personId);
    return {
      apps: { connected: Boolean(own.apps), ending: own.apps ? own.apps.key.slice(-4) : null, savedAt: own.apps?.savedAt ?? null },
      secrets: Object.entries(own.secrets ?? {})
        .map(([name, entry]) => ({ name, savedAt: entry.savedAt }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  }

  /** Every value kept for these people, so nothing leaves in a message
   * or a log with one in it (redactSecrets). */
  values(personIds: readonly string[]): string[] {
    return personIds.flatMap((id) => {
      const own = this.of(id);
      return [own.apps?.key, ...Object.values(own.secrets ?? {}).map((entry) => entry.value)].filter((v): v is string => Boolean(v));
    });
  }

  /** A member gone: their folder is removed with them, and so is what is
   * remembered of it here. */
  forget(personId: string) {
    this.cache.delete(personId);
  }
}
