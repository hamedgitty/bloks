// Resolves the two Swift helpers to a path that is ready to spawn.
//
// Packaged: they ship pre-built in Resources, universal and signed as part
// of the app bundle. A signed bundle must never be written into, so they
// are used exactly as they are.
//
// Dev: compiled on first use and cached until the source changes. That
// keeps a clone one `pnpm install` away from a working desktop shell, and
// it keeps a Mach-O binary out of the repository, where it would go stale
// and quietly be the wrong architecture.
import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app } from "electron";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function nativeHelper(name) {
  if (app.isPackaged) return path.join(process.resourcesPath, name);

  const bin = path.join(__dirname, "resources", name);
  const src = `${bin}.swift`;
  const stale = !existsSync(bin) || statSync(bin).mtimeMs < statSync(src).mtimeMs;
  // Xcode command line tools required; about two seconds, once
  if (stale) execFileSync("swiftc", ["-O", src, "-o", bin], { stdio: "pipe", timeout: 120_000 });
  return bin;
}
