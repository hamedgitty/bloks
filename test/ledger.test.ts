// The record, and what it takes to notice someone editing it.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { generateKeyPairSync, sign } from "node:crypto";

import { statementOf } from "../server/identity.ts";
import {
  GENESIS_PREV,
  Ledger,
  attribution,
  clamped,
  canonical,
  genesisDraft,
  hashEntry,
  parseEntry,
  seal,
  verifyChain,
  type LedgerEntry,
} from "../server/ledger.ts";

/** A chain of n entries after the genesis, sealed the way the store does. */
function chain(n: number): LedgerEntry[] {
  const out = [seal(genesisDraft(1_000), null)];
  for (let i = 0; i < n; i++) {
    out.push(
      seal(
        {
          at: 2_000 + i,
          kind: "approval",
          actor: "Ivy",
          summary: `did thing ${i}`,
          detail: { allowed: true, tool: "shell" },
        },
        out[out.length - 1],
      ),
    );
  }
  return out;
}

describe("hashing an entry", () => {
  test("the same entry hashes the same however its keys were ordered", () => {
    // an entry read back off disk is rebuilt in whatever order the JSON
    // had, so a hash that depends on insertion order would fail on
    // restart rather than on tampering
    const a = seal({ at: 1, kind: "approval", actor: "Ivy", summary: "x", detail: { b: 2, a: 1 } }, null);
    const b = { ...a, detail: { a: 1, b: 2 } };
    assert.equal(hashEntry({ ...b, hash: undefined } as never), a.hash);
    assert.equal(canonical({ ...a }), canonical(b));
  });

  test("changing any field changes the hash", () => {
    const base = seal({ at: 1, kind: "approval", actor: "Ivy", summary: "x" }, null);
    const { hash, ...body } = base;
    for (const edit of [
      { at: 2 },
      { actor: "Someone else" },
      { summary: "y" },
      { kind: "agent.deleted" as const },
      { seq: 4 },
      { prev: "f".repeat(64) },
      { detail: { added: true } },
    ]) {
      assert.notEqual(hashEntry({ ...body, ...edit }), hash, `${JSON.stringify(edit)} went unnoticed`);
    }
  });

  test("the first entry points at nothing and counts from zero", () => {
    const first = seal(genesisDraft(5), null);
    assert.equal(first.seq, 0);
    assert.equal(first.prev, GENESIS_PREV);
    assert.equal(first.kind, "genesis");
  });
});

describe("walking the chain", () => {
  test("an untouched record holds", () => {
    const result = verifyChain(chain(4));
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.entries, 5);
    assert.equal(result.ok && result.through, 4);
    assert.equal(verifyChain([]).ok, true);
  });

  test("editing an old entry is caught", () => {
    const entries = chain(4);
    entries[2] = { ...entries[2], summary: "did something else entirely" };
    const result = verifyChain(entries);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.seq, 2);
    assert.match(result.ok === false ? result.reason : "", /changed since it was written/);
  });

  test("editing an entry and re-hashing it breaks the next link", () => {
    // the patient version of the same attack: fix the entry's own hash so
    // it passes its own check, and the one after it stops matching
    const entries = chain(4);
    const { hash, ...body } = entries[2];
    const forged = { ...body, summary: "approved something I never approved" };
    entries[2] = { ...forged, hash: hashEntry(forged) };
    const result = verifyChain(entries);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.seq, 3);
    assert.match(result.ok === false ? result.reason : "", /does not follow the one before it/);
  });

  test("deleting an entry from the middle is caught", () => {
    const entries = chain(4);
    entries.splice(2, 1);
    const result = verifyChain(entries);
    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.reason : "", /missing from the middle/);
  });

  test("cutting the beginning off is caught", () => {
    const result = verifyChain(chain(4).slice(2));
    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.reason : "", /does not start at its beginning/);
  });

  test("a record that starts with something other than its genesis is caught", () => {
    const entries = chain(2);
    const forged = { ...entries[0], kind: "approval" as const, summary: "allowed everything" };
    entries[0] = { ...forged, hash: hashEntry({ ...forged }) };
    const result = verifyChain(entries);
    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.reason : "", /not the one the record began with/);
  });

  test("only the first break is reported, because the rest are downstream", () => {
    const entries = chain(6);
    entries[2] = { ...entries[2], summary: "one" };
    entries[5] = { ...entries[5], summary: "two" };
    const result = verifyChain(entries);
    assert.equal(result.ok === false && result.seq, 2);
  });
});

describe("a line off disk", () => {
  test("anything that is not an entry is refused", () => {
    for (const bad of [
      null,
      7,
      "entry",
      [],
      {},
      { seq: -1, at: 1, kind: "approval", actor: "a", summary: "s", prev: "p", hash: "h" },
      { seq: 1.5, at: 1, kind: "approval", actor: "a", summary: "s", prev: "p", hash: "h" },
      { seq: 1, at: "yesterday", kind: "approval", actor: "a", summary: "s", prev: "p", hash: "h" },
      { seq: 1, at: 1, kind: "approval", actor: "a", summary: "s", prev: "p", hash: "h", detail: { nested: { no: 1 } } },
      { seq: 1, at: 1, kind: "approval", actor: "a", summary: "s", prev: "p", hash: "h", detail: [1] },
    ]) {
      assert.equal(parseEntry(bad), null, `${JSON.stringify(bad)} is not an entry`);
    }
  });

  test("a real entry survives the round trip byte for byte", () => {
    const entry = seal({ at: 9, kind: "approval", actor: "Ivy", summary: "ran a command", detail: { ok: true } }, null);
    const back = parseEntry(JSON.parse(JSON.stringify(entry)));
    assert.deepEqual(back, entry);
    assert.equal(verifyChain([back!]).ok, false, "a lone non-genesis entry is not a chain");
  });
});

describe("the file", () => {
  const fresh = () => new Ledger(join(mkdtempSync(join(tmpdir(), "bloks-ledger-")), "record.ndjson"));

  test("the first thing written anchors the record", async () => {
    const ledger = fresh();
    const entry = await ledger.append({ at: 10, kind: "agent.created", actor: "you", summary: "made Ivy" });
    assert.ok(entry);
    assert.equal(entry!.seq, 1, "the genesis took seq 0");
    const list = ledger.list();
    assert.equal(list.length, 2);
    assert.equal(list[0].kind, "agent.created", "newest first");
    assert.equal(list[1].kind, "genesis");
    assert.equal((await ledger.verify()).ok, true);
  });

  test("what was written is what a new process reads back", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bloks-ledger-"));
    const file = join(dir, "record.ndjson");
    const first = new Ledger(file);
    await first.append({ at: 1, kind: "agent.created", actor: "you", summary: "made Ivy" });
    await first.append({ at: 2, kind: "approval", actor: "Ivy", summary: "asked to run a command", detail: { allowed: true } });

    // a restart: the chain has to continue from a hash it only knows by
    // reading to the end of the file
    const second = new Ledger(file);
    await second.whenReady();
    const next = await second.append({ at: 3, kind: "skill.installed", actor: "you", summary: "added a skill" });
    assert.equal(next!.seq, 3);
    assert.equal((await second.verify()).ok, true);
    assert.equal(readFileSync(file, "utf8").trim().split("\n").length, 4);
  });

  test("a line edited on disk is caught by the check", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bloks-ledger-"));
    const file = join(dir, "record.ndjson");
    const ledger = new Ledger(file);
    await ledger.append({ at: 1, kind: "approval", actor: "Ivy", summary: "asked to send an email", detail: { allowed: false } });
    await ledger.append({ at: 2, kind: "approval", actor: "Ivy", summary: "asked to run a command", detail: { allowed: true } });
    assert.equal((await ledger.verify()).ok, true);

    const lines = readFileSync(file, "utf8").trim().split("\n");
    const edited = JSON.parse(lines[1]);
    edited.detail.allowed = true;
    lines[1] = JSON.stringify(edited);
    writeFileSync(file, `${lines.join("\n")}\n`);

    const result = await new Ledger(file).verify();
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.seq, 1);
  });

  test("rubbish appended to the file is noticed rather than skipped", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bloks-ledger-"));
    const file = join(dir, "record.ndjson");
    const ledger = new Ledger(file);
    await ledger.append({ at: 1, kind: "approval", actor: "Ivy", summary: "asked" });
    writeFileSync(file, `${readFileSync(file, "utf8")}not an entry at all\n`);

    const reopened = new Ledger(file);
    const result = await reopened.verify();
    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.reason : "", /not an entry/);
    assert.equal(reopened.strayLines, 1);
  });

  test("an oversized entry is trimmed rather than refused", async () => {
    const ledger = fresh();
    const entry = await ledger.append({
      at: 1,
      kind: "approval",
      actor: "a".repeat(500),
      summary: "s".repeat(5_000),
      detail: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, "v".repeat(1_000)])),
    });
    assert.ok(entry!.actor.length <= 80);
    assert.ok(entry!.summary.length <= 300);
    assert.ok(Object.keys(entry!.detail ?? {}).length <= 12);
    assert.ok(Object.values(entry!.detail ?? {}).every((v) => String(v).length <= 300));
    assert.equal((await ledger.verify()).ok, true);
  });

  test("a record that cannot be written does not throw at the caller", async () => {
    // the record is worth having and never worth failing an action over
    const ledger = new Ledger("/nonexistent-directory-for-bloks/record.ndjson");
    assert.equal(await ledger.append({ at: 1, kind: "approval", actor: "Ivy", summary: "x" }), null);
  });
});

// An entry saying "Ivy did this" is only a claim by whatever wrote the
// entry. A signature makes it Ivy's claim, and the difference is the
// whole reason the record is worth reading afterwards.
describe("who an entry is really from", () => {
  /** A key made here rather than on disk, so these stay pure. */
  function keypair() {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const der = publicKey.export({ format: "der", type: "spki" }) as Buffer;
    return { privateKey, fingerprint: der.subarray(der.length - 32).toString("hex") };
  }

  const draft = { at: 2_000, kind: "approval" as const, actor: "Ivy", summary: "ran a command" };

  function signedBy(key: ReturnType<typeof keypair>, over = draft) {
    const signature = sign(null, Buffer.from(statementOf(over), "utf8"), key.privateKey).toString("base64");
    return { ...draft, by: { fingerprint: key.fingerprint, signature } };
  }

  test("an entry nobody signed is unsigned, not suspicious", () => {
    // most entries are things the person did, and flagging those would
    // teach people to ignore the flag
    const entry = seal(draft, null);
    assert.equal(attribution(entry).state, "unsigned");
  });

  test("a signature that holds names the agent that made it", () => {
    const key = keypair();
    const entry = seal(signedBy(key), null);
    const who = attribution(entry);
    assert.equal(who.state, "ok");
    assert.equal(who.by, key.fingerprint);
  });

  test("a signature from one agent does not hold for another", () => {
    const mine = keypair();
    const theirs = keypair();
    const entry = seal(draft, null);
    const forged = {
      ...entry,
      detail: { ...entry.detail, by: theirs.fingerprint, sig: signedBy(mine).by.signature },
    };
    assert.equal(attribution(forged).state, "bad");
  });

  test("changing what the entry says breaks the signature on it", () => {
    const key = keypair();
    const entry = seal(signedBy(key), null);
    assert.equal(attribution({ ...entry, summary: "ran something else" }).state, "bad");
    assert.equal(attribution({ ...entry, actor: "Someone Else" }).state, "bad");
    assert.equal(attribution({ ...entry, at: entry.at + 1 }).state, "bad");
  });

  test("the signature travels in the detail, so the chain covers it", () => {
    const key = keypair();
    const entry = seal(signedBy(key), null);
    assert.equal(entry.detail?.by, key.fingerprint);
    assert.ok(String(entry.detail?.sig ?? "").length > 40);
    // and the hash is over the entry with those fields in it
    assert.equal(entry.hash, hashEntry({ ...entry, hash: undefined } as never));
  });

  test("nothing private ever reaches an entry", () => {
    const key = keypair();
    const entry = seal(signedBy(key), null);
    assert.doesNotMatch(JSON.stringify(entry), /PRIVATE KEY/);
  });

  test("a chain of signed entries still links up", () => {
    const key = keypair();
    const genesis = seal(genesisDraft(1_000), null);
    const one = seal(signedBy(key), genesis);
    const two = seal(signedBy(key, { ...draft, at: 3_000 }), one);
    assert.equal(verifyChain([genesis, one, two]).ok, true);
  });
});

// The entry that gets written is the clamped one. Anything that signs a
// draft has to sign what will actually be on disk, or the record ends up
// full of signatures that do not hold over the entries carrying them.
describe("signing what actually gets written", () => {
  function keypair() {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const der = publicKey.export({ format: "der", type: "spki" }) as Buffer;
    return { privateKey, fingerprint: der.subarray(der.length - 32).toString("hex") };
  }

  test("a summary too long to store is signed at the length it is stored", () => {
    const key = keypair();
    const draft = { at: 5_000, kind: "approval" as const, actor: "Ivy", summary: "x".repeat(5_000) };
    const cut = clamped(draft);
    assert.ok(cut.summary.length < draft.summary.length, "nothing was clamped, so this proves nothing");
    const signature = sign(null, Buffer.from(statementOf(cut), "utf8"), key.privateKey).toString("base64");
    const entry = seal({ ...cut, by: { fingerprint: key.fingerprint, signature } }, null);
    assert.equal(attribution(entry).state, "ok");
  });

  test("signing before the clamp would not have held", () => {
    const key = keypair();
    const draft = { at: 5_000, kind: "approval" as const, actor: "Ivy", summary: "x".repeat(5_000) };
    const signature = sign(null, Buffer.from(statementOf(draft), "utf8"), key.privateKey).toString("base64");
    const entry = seal({ ...clamped(draft), by: { fingerprint: key.fingerprint, signature } }, null);
    assert.equal(attribution(entry).state, "bad", "this is the mistake the clamp-first rule exists to stop");
  });

  test("clamping twice is clamping once", () => {
    const draft = {
      at: 1,
      kind: "approval" as const,
      actor: "A".repeat(200),
      summary: "s".repeat(5_000),
      detail: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, "v".repeat(500)])),
    };
    assert.deepEqual(clamped(clamped(draft)), clamped(draft));
  });
});

// The unit tests above seal drafts by hand. This one goes the way the
// server actually goes, because the bug worth catching here was exactly
// the gap between the two: clamping rebuilt the draft and dropped the
// signature, so everything sealed by hand stayed signed and everything
// the server wrote did not.
describe("a signed entry, through the door the server uses", () => {
  function keypair() {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const der = publicKey.export({ format: "der", type: "spki" }) as Buffer;
    return { privateKey, fingerprint: der.subarray(der.length - 32).toString("hex") };
  }

  /** What the server does before it appends: clamp, then sign the clamp. */
  function signedDraft(key: ReturnType<typeof keypair>, draft: Parameters<typeof clamped>[0]) {
    const cut = clamped(draft);
    const signature = sign(null, Buffer.from(statementOf(cut), "utf8"), key.privateKey).toString("base64");
    return { ...cut, by: { fingerprint: key.fingerprint, signature } };
  }

  const fresh = () => new Ledger(join(mkdtempSync(join(tmpdir(), "bloks-ledger-")), "record.ndjson"));

  test("appending a signed draft writes an entry that still checks out", async () => {
    const key = keypair();
    const ledger = fresh();
    await ledger.append(
      signedDraft(key, { at: 2_000, kind: "approval", actor: "Ivy", summary: "ran a command" }),
    );
    const [entry] = ledger.list(10);
    assert.equal(attribution(entry).state, "ok");
    assert.equal(attribution(entry).by, key.fingerprint);
  });

  test("a summary too long to store is still signed once it is stored", async () => {
    const key = keypair();
    const ledger = fresh();
    await ledger.append(
      signedDraft(key, { at: 2_000, kind: "approval", actor: "Ivy", summary: "x".repeat(5_000) }),
    );
    assert.equal(attribution(ledger.list(10)[0]).state, "ok");
  });

  test("unsigned entries alongside signed ones, and the chain over both", async () => {
    const key = keypair();
    const ledger = fresh();
    await ledger.append({ at: 1_500, kind: "agent.created", actor: "you", summary: "Made Ivy" });
    await ledger.append(
      signedDraft(key, { at: 2_000, kind: "approval", actor: "Ivy", summary: "ran a command" }),
    );
    const states = ledger.list(10).map((e) => attribution(e).state);
    assert.deepEqual(states, ["ok", "unsigned", "unsigned"], "newest first, genesis last");
    assert.equal((await ledger.verify()).ok, true);
  });

  test("a signature survives the trip through the file", async () => {
    // the entry is read back off disk by parseEntry, and a signature that
    // did not survive parsing would be a signature nobody could check
    // after a restart
    const key = keypair();
    const dir = mkdtempSync(join(tmpdir(), "bloks-ledger-"));
    const file = join(dir, "record.ndjson");
    await new Ledger(file).append(
      signedDraft(key, { at: 2_000, kind: "approval", actor: "Ivy", summary: "ran a command" }),
    );
    const reopened = new Ledger(file);
    await reopened.whenReady();
    assert.equal(attribution(reopened.list(10)[0]).state, "ok");
    assert.equal((await reopened.verify()).ok, true);
  });

  test("the check refuses a record whose signature was tampered with", async () => {
    const key = keypair();
    const ledger = fresh();
    await ledger.append(
      signedDraft(key, { at: 2_000, kind: "approval", actor: "Ivy", summary: "ran a command" }),
    );
    assert.equal((await ledger.verify()).ok, true);

    // rewrite the file with somebody else's fingerprint on the entry, and
    // rebuild the chain over it, so the hashes are honest and only the
    // signature is a lie
    const file = (ledger as unknown as { file: string }).file;
    const lines = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const other = keypair();
    lines[1].detail.by = other.fingerprint;
    let previous = { seq: lines[0].seq as number, hash: lines[0].hash as string };
    for (let i = 1; i < lines.length; i++) {
      const { hash: _drop, ...body } = lines[i];
      const rebuilt = { ...body, prev: previous.hash };
      lines[i] = { ...rebuilt, hash: hashEntry(rebuilt) };
      previous = { seq: lines[i].seq, hash: lines[i].hash };
    }
    writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);

    const result = await new Ledger(file).verify();
    assert.equal(result.ok, false, "a chain that links up is not the same as a record that is true");
    assert.match((result as { reason: string }).reason, /did not sign it/);
  });
});
