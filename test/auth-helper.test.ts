// The Touch ID helper's contract, checked without raising a prompt.
//
// `ask` is deliberately not exercised here: it puts a system dialog on
// whoever is running the tests, and a suite that interrupts you is a
// suite you stop running. What can be checked is everything around it,
// which is where the mistakes would be: the vocabulary the helper
// answers in, that it is built and shipped, and that an unknown mode
// cannot be made to prompt.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const source = join(root, "electron/resources/auth-helper.swift");
const binary = join(root, "electron/resources/auth-helper");
const onMac = process.platform === "darwin";

/** Every word the helper is allowed to print. The renderer switches on
 * these, so a new one added to the Swift without a home here is a bug. */
const VOCABULARY = ["biometry", "password", "unavailable", "granted", "denied", "cancelled"];

describe("the Touch ID helper", () => {
  test("its source ships and the build script knows about it", () => {
    assert.ok(existsSync(source), "auth-helper.swift is missing");
    const build = readFileSync(join(root, "scripts/build-helpers.sh"), "utf8");
    assert.match(build, /auth-helper/, "build-helpers.sh does not build it");
  });

  test("it is packaged for macOS and kept out of the asar", () => {
    const yml = readFileSync(join(root, "electron-builder.yml"), "utf8");
    assert.match(yml, /from: electron\/resources\/auth-helper\n\s+to: auth-helper/);
    assert.match(yml, /"!electron\/resources\/auth-helper"/);
  });

  test("it prints only words the renderer understands", () => {
    const swift = readFileSync(source, "utf8");
    for (const printed of [...swift.matchAll(/print\("([a-z]+)"\)/g)].map((m) => m[1])) {
      assert.ok(VOCABULARY.includes(printed), `helper prints "${printed}", which nothing handles`);
    }
  });

  test("it falls back to the password rather than insisting on a sensor", () => {
    // deviceOwnerAuthenticationWithBiometrics would refuse outright on a
    // Mac whose Touch ID is not set up, which is not the point.
    const swift = readFileSync(source, "utf8");
    assert.match(swift, /LAPolicy\.deviceOwnerAuthentication\b/);
    assert.doesNotMatch(swift, /deviceOwnerAuthenticationWithBiometrics/);
  });

  test("a prompt nobody answers gives up rather than hanging the turn", () => {
    assert.match(readFileSync(source, "utf8"), /semaphore\.wait\(timeout:/);
  });

  (onMac && existsSync(binary) ? test : test.skip)("check answers without prompting", () => {
    const said = execFileSync(binary, ["check"], { encoding: "utf8", timeout: 20_000 }).trim();
    assert.ok(["biometry", "password", "unavailable"].includes(said), `check said "${said}"`);
  });

  (onMac && existsSync(binary) ? test : test.skip)("an unknown mode cannot be made to prompt", () => {
    const said = execFileSync(binary, ["wat"], { encoding: "utf8", timeout: 20_000 }).trim();
    assert.equal(said, "unavailable");
  });
});
