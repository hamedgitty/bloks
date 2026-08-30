// What the app reaches for at runtime, and what actually ships.
//
// This is the bug class our other gates cannot see. Every test here runs
// from source, where the repo layout happens to satisfy a relative path
// like `../bin/bloks.mjs`. The packaged app has a different shape: the
// server is copied to Resources/server and only what electron-builder
// was told to copy exists beside it. A path that resolves in development
// and not in the build produces no error anyone reads, only a feature
// that quietly does nothing.
//
// So these tests model the packaged layout from electron-builder.yml and
// check the runtime paths against it, rather than against the checkout.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (relative: string) => readFileSync(join(root, relative), "utf8");

/** `from: X` / `to: Y` pairs under extraResources, in order. */
function extraResources(): Array<{ from: string; to: string }> {
  const yml = read("electron-builder.yml");
  const block = yml.match(/^extraResources:\n((?:\s+.*\n)+?)(?=^\S)/m)?.[1] ?? "";
  const pairs: Array<{ from: string; to: string }> = [];
  const lines = block.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const from = lines[i].match(/^\s*-\s*from:\s*(\S+)/)?.[1];
    if (!from) continue;
    const to = lines[i + 1]?.match(/^\s*to:\s*(\S+)/)?.[1];
    if (to) pairs.push({ from, to });
  }
  return pairs;
}

/** Where a source directory lands inside the packaged Resources dir. */
function shippedAs(sourceDir: string): string | undefined {
  return extraResources().find((entry) => entry.from === sourceDir)?.to;
}

test("the agent's command line ships where the server looks for it", () => {
  // server/index.ts resolves it relative to its own module URL.
  const expression = read("server/index.ts").match(
    /AGENT_CLI\s*=\s*fileURLToPath\(new URL\("([^"]+)"/,
  )?.[1];
  assert.ok(expression, "AGENT_CLI is no longer a literal relative URL; update this test");

  // In the packaged app the compiled server sits at Resources/<to>.
  const serverTo = shippedAs("dist-server");
  assert.equal(serverTo, "server", "the compiled server is no longer copied to Resources/server");

  // Resolve the same expression against that packaged location.
  const packagedServerDir = join("/Resources", serverTo!);
  const wanted = resolve(packagedServerDir, expression!); // e.g. /Resources/bin/bloks.mjs
  const topLevel = wanted.slice("/Resources/".length).split("/")[0]; // e.g. "bin"

  const shipped = extraResources().some((entry) => entry.to === topLevel);
  assert.ok(
    shipped,
    `the server resolves its CLI to Resources/${topLevel}, which electron-builder does not copy: ` +
      `add it to extraResources or every agent command fails in the packaged app`,
  );

  // And the file has to exist in the checkout for the copy to carry it.
  const source = extraResources().find((entry) => entry.to === topLevel)!.from;
  const relative = wanted.slice(`/Resources/${topLevel}/`.length);
  assert.ok(
    existsSync(join(root, source, relative)),
    `${join(source, relative)} is missing from the repository`,
  );
});

test("every extraResources entry has something to copy", () => {
  for (const entry of extraResources()) {
    // dist and dist-server are build outputs, absent until a build runs.
    if (entry.from.startsWith("dist")) continue;
    assert.ok(
      existsSync(join(root, entry.from)),
      `electron-builder copies ${entry.from}, which does not exist`,
    );
  }
});
