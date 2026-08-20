// End to end, past our own relay.
//
// The relay routes ciphertext and is written so it cannot do anything
// else: spaces.ts never sees a plaintext byte. That promise is only worth
// something if the two ends actually encrypt, which is what this file is.
//
// The shared secret already exists and neither end has to invent one. A
// paired phone holds its bearer token; the Mac keeps only sha256 of that
// token, on purpose, so a stolen config file is not a stolen credential.
// Both sides can therefore compute sha256(token), and the relay, which
// has neither, cannot. That digest is the key material.
//
// One key per paired device, so revoking a phone revokes its ability to
// read anything, and one phone can never decrypt another's traffic.
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";

/** Bumping this changes every derived key, which is the point: it is the
 * version number of the whole scheme. */
const INFO = "bloks-relay-v1";
const NONCE_BYTES = 12;

/** Which way a frame travels. Two keys per device, one per direction,
 * so nothing the phone sealed can ever be replayed back to it wearing a
 * response's clothes, and vice versa. The relay holds neither. */
export type Direction = "phone-to-mac" | "mac-to-phone";

/** The AES key for one paired device and one direction, from the digest
 * the Mac already stores. `hash` is hex sha256 of that device's bearer
 * token. */
export function deviceKey(hash: string, direction: Direction): Buffer {
  return Buffer.from(
    hkdfSync("sha256", Buffer.from(hash, "hex"), Buffer.alloc(0), `${INFO}:${direction}`, 32),
  );
}

/** The same key, computed from the token itself. The phone does this. */
export function keyFromToken(token: string, direction: Direction): Buffer {
  return deviceKey(createHash("sha256").update(token).digest("hex"), direction);
}

/** What travels through the relay. The device id is deliberately in the
 * clear: the Mac needs to know which key to try, and an opaque random id
 * tells an eavesdropper nothing it did not already know from routing. */
export interface Envelope {
  d: string;
  n: string;
  c: string;
}

export function seal(key: Buffer, deviceId: string, value: unknown): string {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const body = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(value), "utf8")),
    cipher.final(),
  ]);
  const envelope: Envelope = {
    d: deviceId,
    n: nonce.toString("base64"),
    // the tag rides with the ciphertext, as every sane AEAD framing does
    c: Buffer.concat([body, cipher.getAuthTag()]).toString("base64"),
  };
  return Buffer.from(JSON.stringify(envelope), "utf8").toString("base64");
}

/** Reads the device id without touching the ciphertext, so the caller can
 * choose a key. Returns null for anything malformed. */
export function peek(payload: string): Envelope | null {
  try {
    const raw = JSON.parse(Buffer.from(payload, "base64").toString("utf8"));
    if (typeof raw?.d !== "string" || typeof raw?.n !== "string" || typeof raw?.c !== "string") {
      return null;
    }
    return raw as Envelope;
  } catch {
    return null;
  }
}

/** Authenticated decryption. A wrong key or a flipped bit lands in the
 * same place: null, and the caller refuses. Note that GCM authenticates
 * but does not detect REPLAY of a byte-identical frame; freshness is the
 * caller's job (see the ts/nonce check in relay-link.ts). */
export function open(key: Buffer, envelope: Envelope): unknown | null {
  try {
    const nonce = Buffer.from(envelope.n, "base64");
    const blob = Buffer.from(envelope.c, "base64");
    if (nonce.length !== NONCE_BYTES || blob.length <= 16) return null;
    const tag = blob.subarray(blob.length - 16);
    const body = blob.subarray(0, blob.length - 16);
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(body), decipher.final()]);
    return JSON.parse(plain.toString("utf8"));
  } catch {
    return null;
  }
}

/** What a phone asks for, once decrypted. Mutating requests also carry a
 * timestamp and a fresh nonce so the Mac can refuse a replay; GETs may
 * omit them, which keeps a retried read after a dropped answer working. */
export interface RelayRequest {
  method: string;
  path: string;
  body?: unknown;
  ts?: number;
  nonce?: string;
}

/** And what it gets back. */
export interface RelayResponse {
  status: number;
  body?: unknown;
}
