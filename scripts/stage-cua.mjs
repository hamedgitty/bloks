// Stages computer use for the packaged Mac app: the cua-driver SDK the
// main process imports, and the cua-driver program it starts as a child.
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
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { createHash } from "node:crypto";
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
// ── the program ────────────────────────────────────────────────────────
// The SDK does not carry the daemon. electron/cua.mjs starts it from
// Resources/cua-driver as a direct child, which is what makes macOS
// attribute its Accessibility and Screen Recording grants to Bloks. It
// comes from upstream's own release at the SDK's exact version, since the
// two speak one protocol over the socket, and its checksum is pinned here
// so a replaced download fails the build instead of shipping. A new SDK
// version fails here too, until its checksum is added.
const BINARY_SHA256 = {
  "0.28.2": "386db225a3080714a0f9f935525e61efaf46709587ef8b94dd2df81aeb2f6daa",
};
const BINARY_OUT = "stage/cua-driver";
rmSync(BINARY_OUT, { force: true });
const pinned = BINARY_SHA256[version];
if (!pinned) throw new Error(`[stage-cua] no pinned checksum for the cua-driver ${version} binary`);
const asset = `cua-driver-rs-${version}-darwin-universal-binary.tar.gz`;
const url = `https://github.com/trycua/cua/releases/download/cua-driver-rs-v${version}/${asset}`;
const scratch = mkdtempSync(join(tmpdir(), "stage-cua-bin-"));
try {
  const archive = join(scratch, asset);
  execFileSync("curl", ["-fsSL", "--retry", "3", "-o", archive, url]);
  const actual = createHash("sha256").update(readFileSync(archive)).digest("hex");
  if (actual !== pinned) throw new Error(`[stage-cua] ${asset} checksum ${actual} does not match the pinned ${pinned}`);
  execFileSync("tar", ["-xzf", archive, "-C", scratch]);
  const find = (dir) =>
    readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      return statSync(full).isDirectory() ? find(full) : name === "cua-driver" ? [full] : [];
    });
  const [binary] = find(scratch);
  if (!binary) throw new Error(`[stage-cua] ${asset} has no cua-driver in it`);
  cpSync(binary, BINARY_OUT);
  chmodSync(BINARY_OUT, 0o755);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
// MIT asks for its notice to travel with the program, so it ships beside it.
execFileSync("curl", [
  "-fsSL",
  "--retry",
  "3",
  "-o",
  "stage/cua-driver-LICENSE.md",
  `https://raw.githubusercontent.com/trycua/cua/cua-driver-rs-v${version}/LICENSE.md`,
]);
if (!/MIT License/.test(readFileSync("stage/cua-driver-LICENSE.md", "utf8"))) {
  throw new Error("[stage-cua] the cua-driver licence did not download as expected");
}
const binArchs = execFileSync("lipo", ["-archs", BINARY_OUT], { encoding: "utf8" });
if (!/x86_64/.test(binArchs) || !/arm64/.test(binArchs)) {
  throw new Error(`[stage-cua] the cua-driver binary is not universal (${binArchs.trim()})`);
}

console.log(`[stage-cua] ${ROOT}@${version} staged with ${[...copied].length} packages and ${PLATFORMS.join(", ")}, and the cua-driver binary`);
