// Borrowing a sign-in: which cookies are in scope, and the crypto.
//
// The real jar cannot be read in a test: the keychain lookup raises the
// operating system's own approval dialog, which is the whole consent
// gate and correctly has nobody to answer it here. So the scheme is
// tested against values encrypted the same way Chrome encrypts them.
import assert from "node:assert/strict";
import { createCipheriv, createHash, pbkdf2Sync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, describe, test } from "node:test";

import { decryptValue, matchesSite, readCookies } from "../server/cookie-import.ts";

/** Chrome's own scheme, from the writing side. */
function encryptLikeChrome(plain: string | Buffer, passphrase: string): Buffer {
  const key = pbkdf2Sync(passphrase, "saltysalt", process.platform === "darwin" ? 1003 : 1, 16, "sha1");
  const cipher = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
  return Buffer.concat([Buffer.from("v10"), cipher.update(Buffer.from(plain)), cipher.final()]);
}

const scratch = mkdtempSync(join(tmpdir(), "bloks-cookies-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

/**
 * A jar shaped like Chrome's, at a given schema version. From version 24
 * Chrome puts the SHA-256 of the host_key in front of each value before
 * encrypting it. The passphrase is the one a browser without a keychain
 * entry gets, so no test ever reaches the real keychain.
 */
function jar(name: string, version: number, cookies: Array<{ host: string; name: string; value: string }>) {
  const path = join(scratch, name);
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE meta (key TEXT NOT NULL UNIQUE PRIMARY KEY, value TEXT)");
  db.prepare("INSERT INTO meta (key, value) VALUES ('version', ?)").run(String(version));
  db.exec(
    "CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, path TEXT, is_secure INTEGER, is_httponly INTEGER, expires_utc INTEGER)",
  );
  const insert = db.prepare("INSERT INTO cookies VALUES (?, ?, '', ?, '/', 1, 1, 0)");
  for (const cookie of cookies) {
    const plain = version >= 24 ? Buffer.concat([createHash("sha256").update(cookie.host).digest(), Buffer.from(cookie.value)]) : cookie.value;
    insert.run(cookie.host, cookie.name, encryptLikeChrome(plain, "peanuts"));
  }
  db.close();
  return path;
}

describe("readCookies", () => {
  test("a current Chrome jar gives back the value, without the site's digest in front", async () => {
    const path = jar("v24.sqlite", 24, [
      { host: ".github.com", name: "user_session", value: "session-token-abc123" },
      { host: "evil.com", name: "other", value: "not asked for" },
    ]);
    const cookies = await readCookies(path, "Test", ["github.com"]);
    assert.deepEqual(
      cookies.map((c) => [c.domain, c.name, c.value]),
      [[".github.com", "user_session", "session-token-abc123"]],
    );
  });

  test("an older jar, without the digest, still reads as it did", async () => {
    const path = jar("v23.sqlite", 23, [{ host: "github.com", name: "user_session", value: "older-token" }]);
    const cookies = await readCookies(path, "Test", ["github.com"]);
    assert.deepEqual(cookies.map((c) => c.value), ["older-token"]);
  });
});

describe("decryptValue", () => {
  test("a value encrypted the way Chrome does it comes back", () => {
    const secret = "session-token-abc123";
    assert.equal(decryptValue(encryptLikeChrome(secret, "hunter2"), "hunter2"), secret);
  });

  test("a value exactly one block long survives the padding", () => {
    const secret = "0123456789abcdef";
    assert.equal(decryptValue(encryptLikeChrome(secret, "k"), "k"), secret);
  });

  test("an unencrypted value is passed through", () => {
    assert.equal(decryptValue(Buffer.from("plain-value"), "anything"), "plain-value");
  });

  test("an empty value stays empty rather than throwing", () => {
    assert.equal(decryptValue(Buffer.alloc(0), "k"), "");
  });

  test("the wrong passphrase gives nothing usable, and never throws", () => {
    const out = decryptValue(encryptLikeChrome("secret", "right"), "wrong");
    assert.notEqual(out, "secret");
  });

  test("in a current jar, a value that does not open with its own site's digest is refused", () => {
    const digest = createHash("sha256").update("github.com").digest();
    const sealed = encryptLikeChrome(Buffer.concat([digest, Buffer.from("token")]), "k");
    assert.equal(decryptValue(sealed, "k", "github.com"), "token");
    assert.equal(decryptValue(sealed, "k", "evil.com"), null);
  });
});

describe("matchesSite", () => {
  test("the site itself and its subdomains are in scope", () => {
    assert.equal(matchesSite("github.com", "github.com"), true);
    assert.equal(matchesSite(".github.com", "github.com"), true);
    assert.equal(matchesSite("api.github.com", "github.com"), true);
  });

  test("a site given as a URL still matches", () => {
    assert.equal(matchesSite("github.com", "https://github.com/hamedgitty"), true);
  });

  test("a different site is out of scope, including a lookalike", () => {
    assert.equal(matchesSite("evil.com", "github.com"), false);
    assert.equal(matchesSite("notgithub.com", "github.com"), false);
    assert.equal(matchesSite("github.com.evil.com", "github.com"), false);
  });

  test("the bank is not swept in with the shop", () => {
    for (const domain of ["chase.com", "mail.google.com", "myhealth.example"]) {
      assert.equal(matchesSite(domain, "amazon.com"), false, `${domain} should be out of scope`);
    }
  });

  test("empty inputs match nothing", () => {
    assert.equal(matchesSite("", "github.com"), false);
    assert.equal(matchesSite("github.com", ""), false);
  });
});
