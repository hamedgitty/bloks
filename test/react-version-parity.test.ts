// react and react-dom must resolve to the exact same version.
//
// React 19.3 turned a long-standing warning into a hard throw: if the two
// packages disagree by so much as a patch, `createRoot().render()` raises
// invariant #527 before it paints anything. In a browser tab that shows up
// in the console. In Electron there is no console in front of the user, so
// the whole app is a blank white window with no error, no menu and no way
// forward, which is exactly what 1.7.0 shipped as.
//
// Nothing upstream of here catches it. `react-dom@19.2.8` declares its peer
// as `react: ^19.2.8`, and `19.3.0` satisfies that range, so pnpm installs
// the pair without a murmur; the build succeeds; the bundle is valid; and
// the failure only exists at the moment React compares the two strings at
// runtime. A caret on one package that is not the caret on the other is
// enough to reintroduce it, so the ranges are checked as well as the lock.
//
// That is how it arrived: 5562742 bumped react alone and left react-dom on
// its own range, which is the shape a grouped dependency bump takes when
// only one of the two packages has a release that day.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (relative: string) => readFileSync(join(root, relative), "utf8");

/**
 * Resolved versions from the root importer of pnpm-lock.yaml.
 *
 * The `packages:` section further down can legitimately hold more than one
 * react-dom (a transitive dependency may pull its own), so only the root
 * importer is read: those are the copies that end up in the bundle. A peer
 * suffix like `19.3.0(react@19.3.0)` is trimmed to the bare version.
 */
function lockedVersions(): Record<string, string> {
  const lines = read("pnpm-lock.yaml").split("\n");
  const start = lines.findIndex((line) => line.trim() === "importers:");
  const end = lines.findIndex((line) => /^packages:/.test(line));
  const versions: Record<string, string> = {};
  for (let i = start; i < (end === -1 ? lines.length : end); i++) {
    const name = lines[i].match(/^\s+(react|react-dom):\s*$/)?.[1];
    if (!name) continue;
    // `specifier:` then `version:`, both indented under the name.
    const version = lines[i + 2]?.match(/^\s+version:\s*([^\s(]+)/)?.[1];
    if (version) versions[name] = version;
  }
  return versions;
}

test("package.json asks for react and react-dom on the same range", () => {
  const { dependencies } = JSON.parse(read("package.json")) as {
    dependencies: Record<string, string>;
  };
  assert.equal(
    dependencies["react-dom"],
    dependencies.react,
    "react and react-dom must carry identical ranges, or a resolution can drift between them",
  );
});

test("the lockfile resolves react and react-dom to the same version", () => {
  const locked = lockedVersions();
  assert.ok(locked.react, "react not found in the lockfile's root importer");
  assert.ok(locked["react-dom"], "react-dom not found in the lockfile's root importer");
  assert.equal(
    locked["react-dom"],
    locked.react,
    `react ${locked.react} against react-dom ${locked["react-dom"]}: React throws #527 on this pair and the window renders empty`,
  );
});
