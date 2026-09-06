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

/**
 * `from: X` / `to: Y` pairs under the top-level extraResources.
 *
 * A line walk rather than one regex: the platform sections carry their
 * own indented `extraResources:`, and a pattern loose enough to span
 * blank lines will happily run past `mac:` and pick those up too. The
 * block ends at the first line that starts in column zero.
 */
function extraResources(): Array<{ from: string; to: string }> {
  const lines = read("electron-builder.yml").split("\n");
  const start = lines.findIndex((line) => line === "extraResources:");
  if (start === -1) return [];
  const block: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    block.push(line);
  }
  const pairs: Array<{ from: string; to: string }> = [];
  for (let i = 0; i < block.length; i++) {
    const from = block[i].match(/^\s*-\s*from:\s*(\S+)/)?.[1];
    if (!from) continue;
    const to = block[i + 1]?.match(/^\s*to:\s*(\S+)/)?.[1];
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
  const entries = extraResources();
  assert.ok(entries.length >= 3, "the top-level block should hold ui, server and the CLI");
  for (const entry of entries) {
    // dist and dist-server are build outputs, absent until a build runs.
    // Everything else in this block is checked in, and a reference to a
    // path that is neither is the mistake worth catching.
    if (entry.from.startsWith("dist")) continue;
    assert.ok(
      existsSync(join(root, entry.from)),
      `electron-builder copies ${entry.from}, which does not exist`,
    );
  }
});

test("the platform sections are not read as top-level entries", () => {
  // A looser parser here swallowed `mac:` and asserted the Swift helpers
  // existed in a fresh checkout, which they never do: they are built.
  for (const entry of extraResources()) {
    assert.ok(
      !entry.from.startsWith("electron/resources/"),
      `${entry.from} belongs to a platform section, not the top-level block`,
    );
  }
});
