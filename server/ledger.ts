// The record: what agents did on your behalf, in an order nobody can
// quietly change.
//
// The product's whole claim is that agents act for you and stop for your
// approval. A record you can check is the other half of that claim, and a
// record that can be edited afterwards is not a record at all.
//
// So each entry carries the hash of the one before it. Change a word in
// an old entry and its own hash no longer matches; replace an entry and
// the next one's `prev` no longer matches; delete a line and the sequence
// skips. All three are what verify() looks for, and none of them can be
// repaired without rewriting every entry after the damage, which is
// exactly the property worth having.
//
// This is tamper evidence, not tamper proofing. Anyone who can write the
// file can rewrite the whole chain; what they cannot do is change one
// line and have it pass. Making that harder means signing entries with a
// key the app does not hold, which is a different feature.
//
// The rules are pure and live at the top. The file is at the bottom, and
// knows nothing about what an entry means.
import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, createReadStream, existsSync, mkdirSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";

import { DATA_DIR } from "./config.ts";
import { statementOf, verifyStatement } from "./identity.ts";

/** What the first entry points back at: nothing. */
export const GENESIS_PREV = "0".repeat(64);

/** How many entries the app keeps to hand. The file keeps all of them. */
export const RECENT_KEPT = 500;

export type LedgerKind =
  | "genesis"
  | "approval"
  | "agent.created"
  | "agent.imported"
  | "agent.exported"
  | "agent.archived"
  | "agent.restored"
  | "agent.deleted"
  | "skill.installed"
  | "skill.deleted"
  | "routine.ran"
  | "job.posted"
  | "workflow.ran"
  | "policy.changed"
  | "control.taken"
  | "control.released";

export interface LedgerEntry {
  /** Counts from zero, one per entry, no gaps. */
  seq: number;
  at: number;
  kind: LedgerKind;
  /** Who did it: a person, or the agent acting for them. */
  actor: string;
  /** One line, readable without decoding anything. */
  summary: string;
  /** Whatever else is worth keeping. Values only, no nesting: an entry
   * has to be hashable in one obvious canonical form. */
  detail?: Record<string, string | number | boolean>;
  prev: string;
  hash: string;
}

/** An entry before it is sealed: no seq, no prev, no hash. */
export interface LedgerDraft {
  at: number;
  kind: LedgerKind;
  actor: string;
  summary: string;
  detail?: Record<string, string | number | boolean>;
  /** The agent this is attributable to, when one is. Its fingerprint and
   * its signature go into the entry, so "Ivy did this" stops being a
   * claim by whatever wrote the entry and becomes something checkable. */
  by?: { fingerprint: string; signature: string };
}

/**
 * The exact bytes an entry hashes over.
 *
 * Written by hand rather than with JSON.stringify(entry), because that
 * serialises in insertion order: the same entry read back from disk and
 * re-stringified could produce different bytes and a different hash. Keys
 * are fixed here and detail's keys are sorted, so an entry has one
 * canonical form for as long as this function does not change.
 */
export function canonical(entry: Omit<LedgerEntry, "hash">): string {
  const detail = entry.detail ?? {};
  const parts = Object.keys(detail)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${JSON.stringify(detail[key])}`);
  return [
    `"seq":${JSON.stringify(entry.seq)}`,
    `"at":${JSON.stringify(entry.at)}`,
    `"kind":${JSON.stringify(entry.kind)}`,
    `"actor":${JSON.stringify(entry.actor)}`,
    `"summary":${JSON.stringify(entry.summary)}`,
    `"detail":{${parts.join(",")}}`,
    `"prev":${JSON.stringify(entry.prev)}`,
  ].join(",");
}

export function hashEntry(entry: Omit<LedgerEntry, "hash">): string {
  return createHash("sha256").update(canonical(entry), "utf8").digest("hex");
}

/** The detail an entry carries, with the signer's identity folded in, so
 * the chain's own hash covers who signed as well as what they signed. */
function detailOf(draft: LedgerDraft): { detail?: Record<string, string | number | boolean> } {
  const detail = { ...(draft.detail ?? {}) };
  if (draft.by?.fingerprint && draft.by.signature) {
    detail.by = draft.by.fingerprint;
    detail.sig = draft.by.signature;
  }
  return Object.keys(detail).length ? { detail } : {};
}

/** Link a draft onto the end of a chain. `previous` is null for the first. */
export function seal(draft: LedgerDraft, previous: Pick<LedgerEntry, "seq" | "hash"> | null): LedgerEntry {
  const body: Omit<LedgerEntry, "hash"> = {
    seq: previous ? previous.seq + 1 : 0,
    at: draft.at,
    kind: draft.kind,
    actor: draft.actor,
    summary: draft.summary,
    ...detailOf(draft),
    prev: previous ? previous.hash : GENESIS_PREV,
  };
  return { ...body, hash: hashEntry(body) };
}

export const genesisDraft = (at: number): LedgerDraft => ({
  at,
  kind: "genesis",
  actor: "Bloks",
  summary: "The record starts here.",
});

export type VerifyResult =
  | { ok: true; entries: number; through: number | null }
  | { ok: false; entries: number; seq: number | null; reason: string };

/**
 * Walk the chain and say whether it holds.
 *
 * Reports the first thing that is wrong rather than a list, because the
 * first break is the one that matters: everything after it is downstream
 * of the same edit.
 */
export function verifyChain(entries: LedgerEntry[]): VerifyResult {
  if (!entries.length) return { ok: true, entries: 0, through: null };

  let previous: LedgerEntry | null = null;
  for (const entry of entries) {
    const at = typeof entry?.seq === "number" ? entry.seq : null;

    if (!previous) {
      if (entry.seq !== 0) {
        return { ok: false, entries: entries.length, seq: at, reason: "the record does not start at its beginning" };
      }
      if (entry.kind !== "genesis" || entry.prev !== GENESIS_PREV) {
        return { ok: false, entries: entries.length, seq: at, reason: "the first entry is not the one the record began with" };
      }
    } else {
      if (entry.seq !== previous.seq + 1) {
        return { ok: false, entries: entries.length, seq: at, reason: "an entry is missing from the middle of the record" };
      }
      if (entry.prev !== previous.hash) {
        return { ok: false, entries: entries.length, seq: at, reason: "an entry does not follow the one before it" };
      }
    }

    const { hash, ...body } = entry;
    if (hash !== hashEntry(body)) {
      return { ok: false, entries: entries.length, seq: at, reason: "an entry has been changed since it was written" };
    }
    previous = entry;
  }

  return { ok: true, entries: entries.length, through: previous!.seq };
}

/** A line off disk, checked into shape before the chain rules see it. */
export function parseEntry(value: unknown): LedgerEntry | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.seq !== "number" || !Number.isInteger(v.seq) || v.seq < 0) return null;
  if (typeof v.at !== "number") return null;
  if (typeof v.kind !== "string" || typeof v.actor !== "string") return null;
  if (typeof v.summary !== "string") return null;
  if (typeof v.prev !== "string" || typeof v.hash !== "string") return null;
  let detail: LedgerEntry["detail"];
  if (v.detail !== undefined) {
    if (typeof v.detail !== "object" || v.detail === null || Array.isArray(v.detail)) return null;
    detail = {};
    for (const [key, item] of Object.entries(v.detail as Record<string, unknown>)) {
      if (typeof item !== "string" && typeof item !== "number" && typeof item !== "boolean") return null;
      detail[key] = item;
    }
  }
  return {
    seq: v.seq,
    at: v.at,
    kind: v.kind as LedgerKind,
    actor: v.actor,
    summary: v.summary,
    ...(detail && Object.keys(detail).length ? { detail } : {}),
    prev: v.prev,
    hash: v.hash,
  };
}

// ── the file ───────────────────────────────────────────────────────────

const LEDGER_FILE = join(DATA_DIR, "record.ndjson");

/** Caps on what one entry may carry, so a runaway caller cannot write a
 * line that makes the file unreadable. */
const MAX_SUMMARY = 300;
const MAX_DETAIL_KEYS = 12;
const MAX_DETAIL_VALUE = 300;

/**
 * A draft cut down to what an entry may hold.
 *
 * Exported because anything signing a draft has to sign what will
 * actually be written: clamping a long summary after signing it would
 * leave a signature that no longer holds over the entry carrying it.
 * Running this twice gives the same answer, so a caller that clamps first
 * loses nothing.
 */
export function clamped(draft: LedgerDraft): LedgerDraft {
  const detail: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(draft.detail ?? {})) {
    if (Object.keys(detail).length >= MAX_DETAIL_KEYS) break;
    if (value === undefined || value === null || value === "") continue;
    detail[key.slice(0, 40)] = typeof value === "string" ? value.slice(0, MAX_DETAIL_VALUE) : value;
  }
  return {
    at: draft.at,
    kind: draft.kind,
    actor: draft.actor.slice(0, 80) || "Bloks",
    summary: draft.summary.slice(0, MAX_SUMMARY),
    ...(Object.keys(detail).length ? { detail } : {}),
    // carried through, or clamping a signed draft would quietly throw the
    // signature away and leave an entry that merely claims what it says
    ...(draft.by ? { by: draft.by } : {}),
  };
}

/**
 * Which agent an entry is attributable to, if it checks out.
 *
 * Three answers, and the difference matters. "unsigned" is most entries:
 * things the person did, which nobody claimed. "ok" is an entry an agent
 * signed and the signature holds. "bad" is an entry claiming to be signed
 * by an identity that did not sign it, which is the only one worth
 * alarming about.
 */
export function attribution(entry: LedgerEntry): { state: "unsigned" | "ok" | "bad"; by?: string } {
  const by = entry.detail?.by;
  const sig = entry.detail?.sig;
  if (typeof by !== "string" || typeof sig !== "string") return { state: "unsigned" };
  const held = verifyStatement(by, statementOf(entry), sig);
  return { state: held ? "ok" : "bad", by };
}

/**
 * Append-only, one JSON document per line.
 *
 * The whole file is streamed once at startup, because the last hash is
 * the only thing a new entry needs and there is no way to know it without
 * reaching the end. The most recent entries are kept from that same pass,
 * so reading the record in the app costs nothing afterwards.
 */
export class Ledger {
  private last: LedgerEntry | null = null;
  private recent: LedgerEntry[] = [];
  /** Lines that were on disk but are not entries. Kept as a count so the
   * app can say the file has been touched by something else. */
  private unreadable = 0;
  private ready: Promise<void>;
  private file: string;

  constructor(file: string = LEDGER_FILE) {
    this.file = file;
    this.ready = this.load();
  }

  /** Resolves once the file has been read. Appends wait on it. */
  whenReady(): Promise<void> {
    return this.ready;
  }

  private async load() {
    if (!existsSync(this.file)) return;
    await this.eachLine((entry) => {
      if (!entry) {
        this.unreadable++;
        return;
      }
      this.last = entry;
      this.recent.push(entry);
      if (this.recent.length > RECENT_KEPT) this.recent.shift();
    });
  }

  private async eachLine(each: (entry: LedgerEntry | null) => void) {
    const lines = createInterface({
      input: createReadStream(this.file, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });
    for await (const line of lines) {
      if (!line.trim()) continue;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        each(null);
        continue;
      }
      each(parseEntry(value));
    }
  }

  /**
   * Write one entry. Returns it, or null if the write failed: the record
   * is worth having, and it is never worth failing an action over.
   */
  async append(draft: LedgerDraft): Promise<LedgerEntry | null> {
    await this.ready;
    try {
      mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
      // the first entry the file ever gets is the genesis it is anchored
      // to, written here rather than at install so a deleted file starts
      // a new record instead of an unanchored one
      if (!this.last) this.write(seal(genesisDraft(draft.at), null));
      const entry = seal(clamped(draft), this.last);
      this.write(entry);
      return entry;
    } catch {
      return null;
    }
  }

  private write(entry: LedgerEntry) {
    appendFileSync(this.file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    try {
      chmodSync(this.file, 0o600);
    } catch {
      /* non-POSIX filesystem */
    }
    this.last = entry;
    this.recent.push(entry);
    if (this.recent.length > RECENT_KEPT) this.recent.shift();
  }

  /** Newest first, which is the order anyone reads a log in. */
  list(limit = 100): LedgerEntry[] {
    return this.recent.slice(-Math.max(0, limit)).reverse();
  }

  get strayLines(): number {
    return this.unreadable;
  }

  /** Re-read the file from the beginning and walk the chain. */
  async verify(): Promise<VerifyResult> {
    await this.ready;
    if (!existsSync(this.file)) return { ok: true, entries: 0, through: null };
    const entries: LedgerEntry[] = [];
    let stray: number | null = null;
    await this.eachLine((entry) => {
      if (!entry) {
        if (stray === null) stray = entries.length;
        return;
      }
      entries.push(entry);
    });
    if (stray !== null) {
      return {
        ok: false,
        entries: entries.length,
        seq: null,
        reason: "the record has a line in it that is not an entry",
      };
    }
    const walked = verifyChain(entries);
    if (!walked.ok) return walked;
    // A chain that holds can still contain an entry claiming to be signed
    // by an identity that did not sign it. That is a different failure
    // from a broken chain and worth its own words.
    for (const entry of entries) {
      if (attribution(entry).state === "bad") {
        return {
          ok: false,
          entries: entries.length,
          seq: entry.seq,
          reason: "an entry claims to be signed by an agent that did not sign it",
        };
      }
    }
    return walked;
  }
}
