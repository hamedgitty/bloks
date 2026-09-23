// Stages the cua-driver SDK for the packaged Mac app.
//
// The packaged app ships no node_modules (electron-builder.yml says why),
// and this is the one exception that cannot be bundled into a single file
// the way electron-updater is: the SDK finds its native library by
// resolving a per-platform npm package at runtime, then loads a .node
// addon and a .dylib from beside it. So it gets a small, real
// node_modules of its own, copied here and shipped in Resources, outside
// the asar where a native library can actually be opened.
//
// The Mac build is universal, and the SDK picks its platform package by
// process.arch, so an Intel Mac asks for darwin-x64 and Apple silicon for
// darwin-arm64. Both packages hold the same universal binaries, byte for
// byte, so one real copy ships and the other name is a relative symlink
// to it: 50 MB saved, and whichever package pnpm skipped on this machine
// comes from the registry at the same version.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const OUT = "stage/cua/node_modules";
const ROOT = "@trycua/cua-driver";
const PLATFORMS = ["darwin-arm64", "darwin-x64"];

rmSync("stage/cua", { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

/** The package's own folder, found the way Node's resolver walks up
 * node_modules, then followed through pnpm's symlinks to the real one.
 * Not require.resolve: these packages' exports maps hide package.json. */
function packageDir(name, fromDir) {
  for (let dir = fromDir; ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", name, "package.json");
    if (existsSync(candidate)) return realpathSync(dirname(candidate));
    if (dirname(dir) === dir) throw new Error(`[stage-cua] cannot find ${name} from ${fromDir}`);
  }
}

const copied = new Set();
function stage(name, fromDir) {
  if (copied.has(name)) return;
  copied.add(name);
  const dir = packageDir(name, fromDir);
  cpSync(dir, join(OUT, name), { recursive: true, dereference: true });
  const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  for (const dep of Object.keys(manifest.dependencies ?? {})) stage(dep, dir);
}

stage(ROOT, process.cwd());
const version = JSON.parse(readFileSync(join(OUT, ROOT, "package.json"), "utf8")).version;

const [REAL, ...ALIASES] = PLATFORMS;
const realName = `${ROOT}-${REAL}`;
const realTarget = join(OUT, realName);
try {
  cpSync(packageDir(realName, packageDir(ROOT, process.cwd())), realTarget, { recursive: true, dereference: true });
} catch {
  // not installed on this machine's architecture: fetch the same version
  const scratch = mkdtempSync(join(tmpdir(), "stage-cua-"));
  const tarball = execFileSync("npm", ["pack", `${realName}@${version}`, "--silent", "--pack-destination", scratch], {
    encoding: "utf8",
  }).trim().split("\n").pop();
  mkdirSync(realTarget, { recursive: true });
  execFileSync("tar", ["-xzf", join(scratch, tarball), "-C", realTarget, "--strip-components=1"]);
  rmSync(scratch, { recursive: true, force: true });
}
const lipo = execFileSync("lipo", ["-archs", join(realTarget, "libcua_driver_sdk.dylib")], { encoding: "utf8" });
if (!/x86_64/.test(lipo) || !/arm64/.test(lipo)) {
  throw new Error(`[stage-cua] ${realName} is no longer universal (${lipo.trim()}); ship each platform package`);
}
for (const alias of ALIASES) symlinkSync(`${ROOT.split("/")[1]}-${REAL}`, join(OUT, `${ROOT}-${alias}`));

for (const triple of PLATFORMS) {
  const lib = join(OUT, `${ROOT}-${triple}`, "libcua_driver_sdk.dylib");
  if (!existsSync(lib)) throw new Error(`[stage-cua] missing ${lib}`);
}
console.log(`[stage-cua] ${ROOT}@${version} staged with ${[...copied].length} packages and ${PLATFORMS.join(", ")}`);
