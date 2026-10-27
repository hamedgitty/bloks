// The workplace fixture must never fall through to this computer's Docker
// or SSH, even when a test removes one of its stand-ins.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { probeScript } from "../server/workplace.ts";
import { fakePlaces } from "./helpers/fake-places.ts";

test("fake workplaces cannot fall through to Docker or SSH on the host", (t) => {
  const root = mkdtempSync(join(tmpdir(), "bloks-place-isolation-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const host = join(root, "host-bin");
  const marker = join(root, "host-called");
  mkdirSync(host);
  for (const name of ["docker", "ssh"]) {
    writeFileSync(join(host, name), `#!${process.execPath}\nrequire("node:fs").appendFileSync(process.env.SENTINEL_LOG, ${JSON.stringify(name + "\n")});\n`, { mode: 0o755 });
  }
  // Both harmless host stand-ins would run if their directory were used.
  const inherited = { ...process.env, PATH: host, SENTINEL_LOG: marker };
  for (const name of ["docker", "ssh"]) assert.equal(spawnSync(name, [], { env: inherited }).status, 0);
  assert.equal(readFileSync(marker, "utf8"), "docker\nssh\n");
  rmSync(marker);

  const fake = fakePlaces(root, join(root, "seen.json"));
  const env = { ...inherited, ...fake.env };
  assert.equal(spawnSync("docker", ["version"], { env }).status, 0);
  assert.equal(spawnSync("ssh", ["--", "fake-host", "true"], { env }).status, 0);
  assert.equal(fake.dockerCalls().length, 1);
  assert.equal(fake.sshCalls().length, 1);
  assert.equal(existsSync(marker), false);

  // The real far-side probe widens PATH to /usr/local/bin. Its fake home
  // must put the guards first, even if that directory has host programs.
  for (const name of ["docker", "ssh"]) {
    const script = probeScript({ command: name, folder: fake.home, noVersion: true, signIn: null });
    const probe = spawnSync("ssh", ["--", "fake-host", script], { env, encoding: "utf8" });
    assert.equal(probe.status, 0);
    assert.ok(probe.stdout.includes(`engine=${join(fake.home, ".local", "bin", name)}\n`));
    const guarded = spawnSync("ssh", ["--", "fake-host", `${script}; ${name}`], { env, encoding: "utf8" });
    assert.equal(guarded.status, 127);
    assert.match(guarded.stderr, /Blocked host program in fake workplace/);
  }
  assert.equal(existsSync(marker), false);

  rmSync(join(fake.bin, "docker"));
  rmSync(join(fake.bin, "ssh"));
  for (const name of ["docker", "ssh"]) {
    assert.equal((spawnSync(name, [], { env }).error as NodeJS.ErrnoException | undefined)?.code, "ENOENT");
    assert.equal((spawnSync(name, [], { env: { ...env, PATH: fake.env.FAKE_THERE_PATH } }).error as NodeJS.ErrnoException | undefined)?.code, "ENOENT");
  }
  assert.equal(existsSync(marker), false);
});
