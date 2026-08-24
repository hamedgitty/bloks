// The packaged app ships no node_modules, by design (electron-builder.yml
// explains why). electron-updater is the one npm package the main process
// needs at runtime, so it is bundled into a single vendored file that
// travels inside electron/ like any other entry code. Anything else the
// main process ever imports from npm must come through here too, or it
// will crash on launch in the packaged app while working fine in dev.
import { build } from "esbuild";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

await build({
  entryPoints: [require.resolve("electron-updater")],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: "electron/vendor/electron-updater.cjs",
  // provided by the Electron runtime itself, never bundled
  external: ["electron"],
  minify: true,
  logLevel: "warning",
});
console.log("[bundle-updater] electron/vendor/electron-updater.cjs written");
