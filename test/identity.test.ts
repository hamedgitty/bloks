// An agent's own key, and what it makes checkable.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { short, statementOf, verifyStatement } from "../server/identity.ts";
import { generateKeyPairSync, sign } from "node:crypto";

/** A key made here rather than on disk, so these stay pure. */
function keypair() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const der = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  return { privateKey, fingerprint: der.subarray(der.length - 32).toString("hex") };
}

describe("showing a fingerprint", () => {
  test("both ends, never just the front", () => {
    // a prefix is cheap to grind out, so a fingerprint shown as its first
    // characters can be imitated by anybody patient
    const key = "a".repeat(8) + "b".repeat(52) + "cdef";
    const shown = short(key);
    assert.equal(shown, `${"a".repeat(8)}…cdef`);
    assert.ok(shown.includes("…"));
    assert.ok(shown.endsWith("cdef"), "the tail is what a prefix grinder cannot cheaply match");
  });

  test("something already short is left alone", () => {
    assert.equal(short("abc"), "abc");
    assert.equal(short(""), "");
  });

  test("case and whitespace do not make a different identity", () => {
    assert.equal(short("  ABCDEF0123456789ABCDEF  "), short("abcdef0123456789abcdef"));
  });
});

describe("what gets signed", () => {
  test("the statement of fact, not the entry that will carry it", () => {
    // the signature ends up inside the entry, so signing the entry would
    // mean signing something that contains the signature
    const statement = statementOf({ kind: "approval", at: 12, actor: "Ivy", summary: "ran a command" });
    assert.equal(statement, "approval\u000012\u0000Ivy\u0000ran a command");
  });

  test("no two different entries can produce the same statement", () => {
    // the separator cannot occur in any field, so a summary with a space
    // in it is never read as a field boundary
    const a = statementOf({ kind: "approval", at: 1, actor: "Ivy Smith", summary: "did it" });
    const b = statementOf({ kind: "approval", at: 1, actor: "Ivy", summary: "Smith did it" });
    assert.notEqual(a, b);
  });

  test("a different fact is a different statement", () => {
    const base = { kind: "approval", at: 12, actor: "Ivy", summary: "ran a command" };
    for (const change of [
      { kind: "job.posted" },
      { at: 13 },
      { actor: "Rae" },
      { summary: "ran a different command" },
    ]) {
      assert.notEqual(statementOf({ ...base, ...change }), statementOf(base));
    }
  });
});

describe("checking who said something", () => {
  test("a real signature checks out", () => {
    const { privateKey, fingerprint } = keypair();
    const statement = statementOf({ kind: "approval", at: 1, actor: "Ivy", summary: "did it" });
    const signature = sign(null, Buffer.from(statement, "utf8"), privateKey).toString("base64");
    assert.equal(verifyStatement(fingerprint, statement, signature), true);
  });

  test("a statement changed after signing does not", () => {
    const { privateKey, fingerprint } = keypair();
    const statement = statementOf({ kind: "approval", at: 1, actor: "Ivy", summary: "denied it" });
    const signature = sign(null, Buffer.from(statement, "utf8"), privateKey).toString("base64");
    const tampered = statementOf({ kind: "approval", at: 1, actor: "Ivy", summary: "allowed it" });
    assert.equal(verifyStatement(fingerprint, tampered, signature), false);
  });

  test("one agent cannot sign as another", () => {
    const ivy = keypair();
    const rae = keypair();
    const statement = statementOf({ kind: "approval", at: 1, actor: "Ivy", summary: "did it" });
    const raeSigned = sign(null, Buffer.from(statement, "utf8"), rae.privateKey).toString("base64");
    assert.equal(verifyStatement(ivy.fingerprint, statement, raeSigned), false);
    assert.equal(verifyStatement(rae.fingerprint, statement, raeSigned), true);
  });

  test("nonsense is false rather than an exception", () => {
    const { privateKey, fingerprint } = keypair();
    const statement = "anything";
    const signature = sign(null, Buffer.from(statement, "utf8"), privateKey).toString("base64");
    for (const bad of ["", "not-hex", "ab", "f".repeat(64)]) {
      assert.equal(verifyStatement(bad, statement, signature), false, bad);
    }
    for (const bad of ["", "not base64 at all!", "aaaa"]) {
      assert.equal(verifyStatement(fingerprint, statement, bad), false, bad);
    }
  });
});
