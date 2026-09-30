// Marks the compiled server as ES modules. Run by `pnpm build:server`,
// right after tsc.
//
// tsc emits ES module syntax into plain .js files, and nothing in
// dist-server said so: Node decided by the nearest package.json above the
// file, wherever the app happened to be installed. With none, it detects
// the syntax and all is well. With one that says "type": "commonjs" (npm
// 11's `npm init -y` writes that, and a package.json in a home folder is
// common; on Windows the app is installed under the home folder) the
// server and every helper it spawns failed to load with "Failed to load
// the ES module". This file makes the answer the same on every machine.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
writeFileSync(join(root, "dist-server", "package.json"), `${JSON.stringify({ type: "module" }, null, 2)}\n`);
