// An agent as an identity rather than a row with a name on it.
//
// Until now "which agent did this" was a string in a record, and a string
// in a record is only as good as the thing that wrote it. A name can be
// edited, two agents can share one, and an entry saying "Ivy did this" is
// a claim by whatever appended the entry rather than by Ivy.
//
// So every agent holds a key. The private half never leaves this machine
// and is never shown; the public half is the agent's identity, and what
// it signs is checkable afterwards by anyone with the record. That is
// what turns "attributable" from a label into something a person can
// verify, and it is the half of the audit trail item 10 could not do on
// its own.
//
// Ed25519 because it is in the standard library, the keys are small
// enough to print, and there is nothing to configure. No passphrase: the
// key protects attribution inside a workspace, not the workspace itself,
// which is already only as private as the account it lives in.
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { DATA_DIR } from "./config.ts";

const IDENTITIES = join(DATA_DIR, "identities");

/** The public half, as something printable. */
export interface Identity {
  botId: string;
  /** Hex of the raw public key: 64 characters, and the thing signatures
   * are checked against. */
  fingerprint: string;
  createdAt: number;
}

/**
 * The one compact form.
 *
 * Both ends, never just the front. A prefix is cheap to grind out, so a
 * fingerprint shown as its first characters can be imitated by anybody
 * patient; showing both ends makes that impractical. It is still a
 * recognition aid rather than proof, which is why anything asking for a
 * decision should show the whole thing.
 */
export function short(fingerprint: string): string {
  const clean = (fingerprint ?? "").trim().toLowerCase();
  if (clean.length <= 12) return clean;
  return `${clean.slice(0, 8)}…${clean.slice(-4)}`;
}

/**
 * What an entry says happened, as the bytes that get signed.
 *
 * Deliberately not the whole entry: the signature ends up inside the
 * entry, so signing the entry would mean signing something that contains
 * the signature. This is the statement of fact, and the record's own hash
 * chain covers the signature afterwards.
 */
export function statementOf(entry: {
  kind: string;
  at: number;
  actor: string;
  summary: string;
}): string {
  // A separator that cannot occur in any of the fields, so a summary
  // with a space in it can never be read as a field boundary: without
  // that, two different entries could produce the same statement and
  // one signature would cover both.
  return [entry.kind, entry.at, entry.actor, entry.summary].join("\u0000");
}

// The public half, kept in memory: the roster asks for every agent's
// fingerprint on every broadcast, and that should not be a disk read per
// agent per message. The private half is never held here, only read when
// something is actually being signed.
const cache = new Map<string, Identity>();

function fileFor(botId: string): string {
  // ids come from newId(), but this builds a path, so it is checked here
  if (!/^[\w-]{1,64}$/.test(botId)) throw new Error("bad agent id");
  return join(IDENTITIES, `${botId}.pem`);
}

function rawPublic(publicKey: ReturnType<typeof createPublicKey>): string {
  // the DER of an ed25519 public key is a 12 byte header then the 32 raw
  // bytes, and the raw bytes are what a fingerprint should be
  const der = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  return der.subarray(der.length - 32).toString("hex");
}

/**
 * This agent's identity, made the first time it is asked for.
 *
 * Created lazily rather than at agent creation, so an install that
 * predates identities grows them as its agents act rather than needing a
 * migration.
 */
export function identityFor(botId: string, now: number = Date.now()): Identity {
  const known = cache.get(botId);
  if (known) return known;
  const file = fileFor(botId);
  let identity: Identity;
  try {
    const pem = readFileSync(file, "utf8");
    identity = { botId, fingerprint: rawPublic(createPublicKey(createPrivateKey(pem))), createdAt: now };
  } catch {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    mkdirSync(IDENTITIES, { recursive: true, mode: 0o700 });
    writeFileSync(file, privateKey.export({ format: "pem", type: "pkcs8" }) as string, { mode: 0o600 });
    try {
      chmodSync(file, 0o600);
    } catch {
      /* non-POSIX filesystem */
    }
    identity = { botId, fingerprint: rawPublic(publicKey), createdAt: now };
  }
  cache.set(botId, identity);
  return identity;
}

/** Sign a statement as this agent. Null when the key cannot be read,
 * because an unsigned entry is better than no entry. */
export function signAs(botId: string, statement: string): string | null {
  try {
    const key = createPrivateKey(readFileSync(fileFor(botId), "utf8"));
    return sign(null, Buffer.from(statement, "utf8"), key).toString("base64");
  } catch {
    return null;
  }
}

/**
 * Did this agent really say this.
 *
 * Takes the fingerprint rather than the agent id on purpose: checking a
 * record should not depend on the agent still existing, or on its key
 * still being the one it had. A renamed or deleted agent's past entries
 * stay verifiable against the fingerprint they were signed with.
 */
export function verifyStatement(fingerprint: string, statement: string, signature: string): boolean {
  try {
    const raw = Buffer.from(fingerprint, "hex");
    if (raw.length !== 32) return false;
    // rebuild the DER wrapper ed25519 public keys carry
    const der = Buffer.concat([
      Buffer.from("302a300506032b6570032100", "hex"),
      raw,
    ]);
    const key = createPublicKey({ key: der, format: "der", type: "spki" });
    return verify(null, Buffer.from(statement, "utf8"), key, Buffer.from(signature, "base64"));
  } catch {
    return false;
  }
}

/** An agent that is gone takes its key with it. Its past entries stay
 * verifiable, because they are checked against the fingerprint in the
 * record rather than against a key on disk. */
export function forget(botId: string) {
  cache.delete(botId);
  try {
    unlinkSync(fileFor(botId));
  } catch {
    /* never had one */
  }
}
