// Borrowing a sign-in: which cookies are in scope, and the crypto.
//
// The real jar cannot be read in a test: the keychain lookup raises the
// operating system's own approval dialog, which is the whole consent
// gate and correctly has nobody to answer it here. So the scheme is
// tested against values encrypted the same way Chrome encrypts them.
import assert from "node:assert/strict";
import { createCipheriv, pbkdf2Sync } from "node:crypto";
import { describe, test } from "node:test";

import { decryptValue, matchesSite } from "../server/cookie-import.ts";

/** Chrome's own scheme, from the writing side. */
function encryptLikeChrome(plain: string, passphrase: string): Buffer {
  const key = pbkdf2Sync(passphrase, "saltysalt", process.platform === "darwin" ? 1003 : 1, 16, "sha1");
  const cipher = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
  return Buffer.concat([Buffer.from("v10"), cipher.update(plain, "utf8"), cipher.final()]);
}

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
