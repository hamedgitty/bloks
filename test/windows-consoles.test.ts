// Console windows on Windows, kept from coming back.
//
// The server has no console there (it runs under a GUI app), so every
// console program it starts without `windowsHide: true` pops up a window
// of its own, and one started with `detached: true` has no console at
// all, so whatever it runs pops up instead. Codex flashed a window on
// every turn this way. See server/no-console.ts.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SERVER = fileURLToPath(new URL("../server/", import.meta.url));

/** Programs these files start are either not console programs, or never
 * started on Windows, or started by a process that already has a hidden
 * console. Each one says which in its own code. */
const EXEMPT = new Set([
  "cdp.ts", // Chrome is a GUI app, and its window is the point
  "engine-setup.ts", // refuses to run on Windows
  "speech.ts", // macOS only
  "cookie-import.ts", // macOS only
  "rehearsals.ts", // macOS and Linux only
  "terminal.ts", // sets windowsHide itself, with its own plan per platform
  "sandbox-proxy.ts", // an MCP server started by an agent CLI
  "local-vm-mcp.ts", // likewise
]);

function sources(dir: string, base = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = join(base, entry.name);
    if (entry.isDirectory()) out.push(...sources(join(dir, entry.name), rel));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) out.push(rel);
  }
  return out;
}

/** The argument text of every spawn( and execFile( call in `code`,
 * comment lines left out. */
function calls(source: string): string[] {
  const code = source
    .split("\n")
    .map((line) => (/^\s*(\/\/|\/?\*)/.test(line) ? "" : line))
    .join("\n");
  const out: string[] = [];
  for (const match of code.matchAll(/(?<![\w.$"'`])(spawn|execFile)\(/g)) {
    let depth = 0;
    let end = match.index! + match[0].length - 1;
    for (; end < code.length; end++) {
      if (code[end] === "(") depth++;
      else if (code[end] === ")" && --depth === 0) break;
    }
    out.push(code.slice(match.index!, end + 1));
  }
  return out;
}

test("every console program the server starts is hidden on Windows", () => {
  let seen = 0;
  for (const file of sources(SERVER)) {
    if (EXEMPT.has(file)) continue;
    for (const call of calls(readFileSync(join(SERVER, file), "utf8"))) {
      seen++;
      assert.match(call, /windowsHide:\s*true/, `${file}: ${call.split("\n")[0]} needs windowsHide: true`);
      assert.doesNotMatch(call, /detached:\s*true/, `${file}: detached: true on Windows brings the windows back; use OWN_GROUP`);
    }
  }
  assert.ok(seen >= 15, `found only ${seen} calls; the scan itself is broken`);
});

test("engines keep their own process group only where process groups exist", async () => {
  const { OWN_GROUP } = await import("../server/no-console.ts");
  assert.equal(OWN_GROUP, process.platform !== "win32");
});
