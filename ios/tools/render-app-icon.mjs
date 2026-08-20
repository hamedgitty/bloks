#!/usr/bin/env node
// Generates the iOS app icon from the same brand mark the desktop icon uses.
//
//   node ios/tools/render-app-icon.mjs
//
// This is a sibling of scripts/render-icon.mjs rather than a flag on it,
// because the two platforms want opposite things and quietly shipping the
// macOS art to iOS is an App Store rejection rather than a cosmetic bug:
//
//   macOS  rounded tile, transparent corners. The system does not mask it.
//   iOS    full square, no rounded corners, NO alpha channel at all.
//          Transparency here is rejected as ITMS-90717, and the rounding
//          is applied by the system, so baking it in double-rounds.
//
// Deriving both from public/brand/bloks-mark.svg is what stops the icon
// going stale, which is the whole reason the desktop script exists.
import { chromium } from "playwright-core";
import { readFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = path.join(
  root,
  "ios",
  "Bloks",
  "Resources",
  "Assets.xcassets",
  "AppIcon.appiconset",
  "icon-1024.png",
);

const mark = readFileSync(path.join(root, "public", "brand", "bloks-mark.svg"), "utf8");
const markData = `data:image/svg+xml;base64,${Buffer.from(mark).toString("base64")}`;

// Same paper gradient and same 58% mark height as the desktop icon, so the
// two read as one product. Square and opaque, so iOS can mask it itself.
const html = `<!doctype html><meta charset="utf-8"><style>
  *{margin:0;padding:0;box-sizing:border-box}
  html,body{width:1024px;height:1024px;background:#f4f2ee}
  .tile{width:1024px;height:1024px;
        background:linear-gradient(160deg,#fdfdfb 0%,#f4f2ee 100%);
        display:flex;align-items:center;justify-content:center;overflow:hidden}
  .tile img{height:58%}
</style>
<div class="tile"><img src="${markData}"></div>`;

const executablePath = process.env.CHROMIUM_PATH || undefined;
const browser = await chromium.launch(executablePath ? { executablePath } : {});
const page = await browser.newPage({ viewport: { width: 1024, height: 1024 }, deviceScaleFactor: 1 });
await page.setContent(html);
await page.waitForTimeout(150);
mkdirSync(path.dirname(OUT), { recursive: true });
// No omitBackground: the alpha channel is exactly what iOS rejects.
await page.screenshot({ path: OUT });
await browser.close();

console.log(`wrote ${path.relative(root, OUT)}`);
