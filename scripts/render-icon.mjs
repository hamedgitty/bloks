// Generates the app icon from the brand mark.
//
// This exists because the icon silently went stale once already: the mark
// in public/brand was replaced and the icon files, being hand-made, kept
// the old art for weeks. Nobody noticed until the app was installed on a
// second Mac. Deriving the icon from the mark means that cannot recur.
//
// Two outputs, and both matter:
//   build/icon.png                   electron-builder converts this to
//                                    the .icns inside the bundle
//   electron/resources/app-icon.png  main.mjs passes this to
//                                    app.dock.setIcon() on every launch,
//                                    which overrides the bundle icon in
//                                    the Dock. Miss it and the Dock keeps
//                                    showing the old art forever.
//
// Run after any change to the mark:  node scripts/render-icon.mjs
import { chromium } from "playwright-core";
import { copyFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(root, "build", "icon.png");
const DOCK = path.join(root, "electron", "resources", "app-icon.png");

const mark = readFileSync(path.join(root, "public", "brand", "bloks-mark.svg"), "utf8");
const markData = `data:image/svg+xml;base64,${Buffer.from(mark).toString("base64")}`;

// The mark is portrait (1272 x 1483.5). It is sized by height and centred,
// never stretched to fill. Black tile: the coloured mark carries the
// identity and reads far better on dark than the old paper white did.
// The hairline ring keeps the tile edge visible against dark wallpapers.
const html = `<!doctype html><meta charset="utf-8"><style>
  *{margin:0;padding:0;box-sizing:border-box}
  html,body{width:1024px;height:1024px;background:transparent}
  .tile{position:relative;width:1024px;height:1024px;border-radius:224px;
        background:linear-gradient(160deg,#2a2a2f 0%,#0b0b0d 100%);
        display:flex;align-items:center;justify-content:center;overflow:hidden}
  .tile img{height:72%}
  .ring{position:absolute;inset:0;border-radius:224px;
        box-shadow:inset 0 0 0 16px rgba(255,255,255,.07)}
</style>
<div class="tile"><img src="${markData}"><div class="ring"></div></div>`;

// PLAYWRIGHT_BROWSERS_PATH points at the preinstalled Chromium in CI and in
// the dev container; fall back to Playwright's own lookup elsewhere.
const executablePath = process.env.CHROMIUM_PATH || undefined;
const browser = await chromium.launch(executablePath ? { executablePath } : {});
const page = await browser.newPage({ viewport: { width: 1024, height: 1024 }, deviceScaleFactor: 1 });
await page.setContent(html);
await page.waitForTimeout(150);
// omitBackground keeps the corners outside the rounded rect transparent,
// which is what macOS expects of an icon.
await page.screenshot({ path: OUT, omitBackground: true });
await browser.close();

copyFileSync(OUT, DOCK);
console.log(`wrote ${path.relative(root, OUT)} and ${path.relative(root, DOCK)}`);
