// A shell opened inside Bloks names its workspace in the environment:
// the data folder, the port, a token. Tests started from it must never
// write there (GitHub 529). Each check here uses a disposable stand-in
// workspace with made-up remote devices and credentials, and compares its
// bytes before and after.
import "./helpers/isolated-env.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { testDataDirRefusal } from "../server/config.ts";
import { WORKSPACE_VARS } from "./helpers/isolated-env.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CONFIG_URL = new URL("../server/config.ts", import.meta.url).href;

/** A workspace that is somebody's own: remote access on with a paired
 * device, a Cloud licence and a provider key, all synthetic. */
function standIn(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), "bloks-inherited-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const bytes = JSON.stringify({
    remote: { enabled: true, devices: [{ name: "SENTINEL-PHONE", digest: "SENTINEL-DIGEST" }] },
    credits: { licence: "SENTINEL-LICENCE", token: "SENTINEL-CLOUD-TOKEN" },
    providers: { grok: { key: "SENTINEL-PROVIDER-KEY" } },
    secrets: { SENTINEL: "SENTINEL-SECRET" },
  }, null, 2);
  writeFileSync(join(workspace, "config.json"), bytes);
  return { root, workspace, bytes };
}

/** The environment of a terminal inside that workspace. */
function workspaceShell(workspace: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  for (const name of WORKSPACE_VARS) env[name] = `SENTINEL-${name}`;
  return { ...env, BLOKS_DATA_DIR: workspace, BLOKS_PORT: "9", BLOKS_URL: "http://127.0.0.1:9", BLOKS_LOCAL_KEY: "SENTINEL-LOCAL-KEY" };
}

test("the saved config tests, run from a workspace's shell, leave that workspace byte for byte", (t) => {
  const { workspace, bytes } = standIn(t);
  const ran = spawnSync(process.execPath, ["--test", "--test-reporter=dot", "test/settings-saved-config.test.ts"], {
    cwd: ROOT, env: workspaceShell(workspace), encoding: "utf8", timeout: 240_000,
  });
  assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  assert.equal(readFileSync(join(workspace, "config.json"), "utf8"), bytes);
  assert.deepEqual(readdirSync(workspace), ["config.json"]);
});

test("the test preload takes every workspace variable out and leaves the rest", (t) => {
  const { workspace } = standIn(t);
  const ran = spawnSync(process.execPath, [
    "--import", "./test/helpers/isolated-env.ts", "--input-type=module", "--eval",
    "console.log(JSON.stringify(Object.keys(process.env).filter((k) => k.startsWith('BLOKS_')).sort()))",
  ], { cwd: ROOT, env: { ...workspaceShell(workspace), BLOKS_TEST_KEPT: "1" }, encoding: "utf8" });
  assert.equal(ran.status, 0, ran.stderr);
  assert.deepEqual(JSON.parse(ran.stdout), ["BLOKS_TEST_KEPT"]);
  const scripts = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).scripts;
  for (const name of ["test", "test:watch"]) assert.match(scripts[name], /--import \.\/test\/helpers\/isolated-env\.ts --test /);
});

test("under the test runner, config refuses an inherited data folder outside the temp folder before writing anything", (t) => {
  const { root, workspace, bytes } = standIn(t);
  // The child's temp folder is a corner of this test's, so the stand-in
  // sits outside it the way a real workspace sits outside the real one.
  const temp = join(root, "tmp");
  const home = join(root, "home");
  mkdirSync(temp);
  mkdirSync(home);
  const script = [
    `const c = await import(${JSON.stringify(CONFIG_URL)});`,
    "c.saveConfig({ remote: { enabled: false, devices: [] } });",
    "console.log(c.DATA_DIR);",
  ].join("\n");
  const env = { ...workspaceShell(workspace), HOME: home, USERPROFILE: home, TMPDIR: temp, TMP: temp, TEMP: temp };
  const refused = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    env: { ...env, NODE_TEST_CONTEXT: "child-v8" }, encoding: "utf8",
  });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /refusing data folder/);
  assert.equal(readFileSync(join(workspace, "config.json"), "utf8"), bytes);

  // Outside a test run the same folder is used as named: nothing about
  // how the app finds its data changes.
  const used = spawnSync(process.execPath, ["--input-type=module", "--eval", `const c = await import(${JSON.stringify(CONFIG_URL)}); console.log(c.DATA_DIR);`], {
    env, encoding: "utf8",
  });
  assert.equal(used.status, 0, used.stderr);
  assert.equal(used.stdout.trim(), workspace);
});

test("the refusal names only a test run with a data folder outside the temp folder", () => {
  const runner = { NODE_TEST_CONTEXT: "child-v8" };
  assert.match(testDataDirRefusal({ ...runner, BLOKS_DATA_DIR: "/Users/someone/.bloks" }, "/Users/someone/.bloks", "/tmp")!, /refusing data folder/);
  assert.match(testDataDirRefusal({ ...runner, BLOKS_DATA_DIR: "/tmp" }, "/tmp", "/tmp")!, /refusing/);
  assert.match(testDataDirRefusal({ ...runner, BLOKS_DATA_DIR: "/tmp/../work" }, "/work", "/tmp")!, /refusing/);
  assert.equal(testDataDirRefusal({ ...runner, BLOKS_DATA_DIR: "/tmp/bloks-x/.bloks" }, "/tmp/bloks-x/.bloks", "/tmp"), null);
  // no folder named: the home's .bloks, and the test's own HOME decides it
  assert.equal(testDataDirRefusal({ ...runner }, "/Users/someone/.bloks", "/tmp"), null);
  assert.equal(testDataDirRefusal({ ...runner, BLOKS_DATA_DIR: "  " }, "/Users/someone/.bloks", "/tmp"), null);
  // not a test run: the app as it always was
  assert.equal(testDataDirRefusal({ BLOKS_DATA_DIR: "/Users/someone/.bloks" }, "/Users/someone/.bloks", "/tmp"), null);
});
