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
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

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

test("the npm packages the server imports ship beside it, in the app and in bloks-server", () => {
  // From source the repository's node_modules answers every import, so a
  // package the server needs and neither packaging carries stops only the
  // packaged server, before it listens. scripts/stage-server-deps.mjs puts
  // them in dist-server/node_modules; both packagings have to take that.
  const manifest = JSON.parse(read("package.json")) as { scripts: Record<string, string>; dependencies: Record<string, string> };
  assert.match(manifest.scripts["build:server"], /stage-server-deps\.mjs/, "build:server no longer stages the server's packages");
  assert.equal(shippedAs("dist-server/node_modules"), "server/node_modules", "the packaged app leaves the server's packages behind");
  assert.match(read("scripts/pack-server.mjs"), /"dist-server\/node_modules"/, "bloks-server is packed without the server's packages");

  // And each one is a dependency, which the stage copies, never a
  // devDependency, which a release install may not have.
  const sources = (dir: string): string[] =>
    readdirSync(join(root, dir)).flatMap((name) => {
      const rel = join(dir, name);
      return statSync(join(root, rel)).isDirectory() ? sources(rel) : rel.endsWith(".ts") ? [rel] : [];
    });
  for (const file of sources("server")) {
    for (const { fileName } of ts.preProcessFile(read(file), true, true).importedFiles) {
      if (/^[./]|^node:/.test(fileName)) continue;
      const name = fileName.split("/").slice(0, fileName.startsWith("@") ? 2 : 1).join("/");
      assert.ok(manifest.dependencies[name], `${file} imports ${name}, which package.json does not list in dependencies`);
    }
  }
});

test("the English words the server names places in ship beside it, in the app and in bloks-server", () => {
  // server/where.ts reads the catalogue relative to its own module, and a
  // package without it fails nothing anyone sees: `bloks where` and the
  // card `bloks open` leaves call every Settings page "label", and a row
  // asked for by its English name is refused.
  const tried = [...read("server/where.ts").matchAll(/"(\.\.\/[^"]*en\.json)"/g)].map((m) => m[1]);
  assert.ok(tried.length, "server/where.ts no longer reads its catalogue by a literal relative path; update this test");
  const looksAt = (serverDir: string, file: string) => tried.some((at) => resolve(serverDir, at) === file);
  assert.ok(existsSync(join(root, "src/locales/en.json")), "src/locales/en.json is missing from the repository");

  // In the app the compiled server is Resources/server, and the
  // catalogues are copied to Resources/locales.
  assert.equal(shippedAs("dist-server"), "server");
  assert.equal(shippedAs("src/locales"), "locales", "the packaged app leaves the catalogues behind");
  assert.ok(looksAt("/Resources/server", "/Resources/locales/en.json"), "the app's server looks for its words where they are not");

  // In bloks-server it stays dist-server, with the catalogue copied to
  // locales/ beside it.
  assert.match(
    read("scripts/pack-server.mjs"),
    /cpSync\(join\(root, "src", "locales", "en\.json"\), join\(stage, "locales", "en\.json"\)\)/,
    "bloks-server is packed without the English catalogue",
  );
  assert.ok(looksAt("/bloks-server/dist-server", "/bloks-server/locales/en.json"), "bloks-server's server looks for its words where they are not");
});

test("the line a network-off container runs ships beside the server, in the app and in bloks-server", () => {
  // server/index.ts sends it into the container from beside its own
  // module. A package without it fails every turn in a Docker image place
  // with the network off, and nothing else.
  const at = read("server/index.ts").match(/LINE_SCRIPT\s*=\s*fileURLToPath\(new URL\("([^"]+)"/)?.[1];
  assert.ok(at, "LINE_SCRIPT is no longer a literal relative URL; update this test");
  assert.ok(existsSync(join(root, "bin/bloks-line.mjs")), "bin/bloks-line.mjs is missing from the repository");
  // In the app the compiled server is Resources/server, and bin/ is
  // copied to Resources/bin.
  assert.equal(shippedAs("dist-server"), "server");
  assert.equal(shippedAs("bin"), "bin", "the packaged app leaves bin/ behind");
  assert.equal(resolve("/Resources/server", at), "/Resources/bin/bloks-line.mjs");
  // In bloks-server it stays dist-server, with the line copied to bin/
  // beside it.
  assert.match(
    read("scripts/pack-server.mjs"),
    /cpSync\(join\(root, "bin", "bloks-line\.mjs"\), join\(stage, "bin", "bloks-line\.mjs"\)\)/,
    "bloks-server is packed without the line",
  );
  assert.equal(resolve("/bloks-server/dist-server", at), "/bloks-server/bin/bloks-line.mjs");
});
