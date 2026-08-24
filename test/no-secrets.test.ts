// Nothing that looks like a credential may enter the tracked tree.
//
// The repo is public. .gitignore covers the files we thought of, which is
// a different thing from the files that exist: Wrangler calls its local
// secrets .dev.vars, Stripe's dashboard hands you a key with a copy
// button, and the gap between those two facts is how a live key gets
// committed by someone in a hurry.
//
// So this checks the thing that actually matters, which is not "is the
// ignore file right" but "is there a secret in what we are about to
// publish". It reads git's own index rather than the working tree,
// because an ignored file is not the risk; a tracked one is.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

/** Shapes that are a credential and nothing else. */
const SHAPES: [string, RegExp][] = [
  ["a Stripe secret key", /\b[sr]k_(?:live|test)_[A-Za-z0-9]{20,}/],
  ["a Stripe webhook signing secret", /\bwhsec_[A-Za-z0-9]{20,}/],
  ["a GitHub token", /\b(?:ghp|gho|ghs|ghr)_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{30,}/],
  ["an AWS access key id", /\bAKIA[0-9A-Z]{16}\b/],
  ["an OpenAI style key", /\bsk-[A-Za-z0-9]{32,}/],
  ["a private key block", /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/],
  ["a Bloks Cloud licence key", /\bblok_live_[0-9a-f]{32}\b/],
  ["an Apple app-specific password", /\b[a-z]{4}-[a-z]{4}-[a-z]{4}-[a-z]{4}\b/],
];

/** This file names every shape it hunts for, so it cannot audit itself. */
const EXEMPT = new Set(["test/no-secrets.test.ts"]);

const BINARY = /\.(png|jpg|jpeg|gif|ico|icns|webp|woff2?|ttf|otf|pdf|zip|mp4|mov)$/i;

function tracked(): string[] {
  return execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter((line) => line && !BINARY.test(line) && !EXEMPT.has(line));
}

test("no tracked file carries anything shaped like a credential", () => {
  const hits: string[] = [];
  for (const file of tracked()) {
    let body: string;
    try {
      body = readFileSync(new URL(file, new URL("..", import.meta.url)), "utf8");
    } catch {
      continue; // a path git knows about but the disk does not, mid-rebase
    }
    for (const [what, shape] of SHAPES) {
      const found = body.match(shape);
      if (found) hits.push(`${file}: ${what} (${found[0].slice(0, 12)}...)`);
    }
  }
  assert.deepEqual(hits, [], `credential-shaped strings in tracked files:\n${hits.join("\n")}`);
});

test("the ignore rules cover the file names secrets actually arrive in", () => {
  // Named rather than derived: the point is to notice when one goes
  // missing, and a rule that reads .gitignore to check .gitignore would
  // pass whatever it found.
  const ignore = readFileSync(new URL("../.gitignore", import.meta.url), "utf8");
  for (const rule of [".env", ".dev.vars", "*.p12", "*.p8", "*.pem"]) {
    assert.ok(ignore.includes(rule), `.gitignore no longer covers ${rule}`);
  }
});
