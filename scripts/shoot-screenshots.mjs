#!/usr/bin/env node
// The README screenshots, made the same way every time.
//
//   node scripts/shoot-screenshots.mjs
//
// Why this exists: the shots in docs/screenshots are the first thing
// anybody sees, and hand-made ones drift. The sidebar grew three items
// and the palette changed underneath the old set, and nobody noticed
// until the README was read next to the running app.
//
// Three decisions worth keeping:
//
//   Retina. deviceScaleFactor 2 gives 2720x1760 from a 1360x880 window,
//   which is what GitHub is read at. A 1x capture scaled up looks worse
//   than the one it replaces.
//
//   The seeded workspace, not a real one. scripts/seed-demo.mjs writes a
//   transcript by hand, so a screenshot is reproducible and does not
//   depend on what a provider felt like saying that day, or on what
//   happens to be in the maintainer's install.
//
//   UTC. The seed writes its transcript at 09:00Z. Without pinning the
//   timezone the shot shows a launch standup happening at five in the
//   morning, wherever the machine happens to be.
import { chromium } from "playwright-core";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8813;
const URL = `http://127.0.0.1:${PORT}`;
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const home = mkdtempSync(join(tmpdir(), "bloks-shots-"));
let server;
try {
  execFileSync("node", [join(repo, "scripts", "seed-demo.mjs"), home], { stdio: "pipe" });
  execFileSync("pnpm", ["build"], { cwd: repo, stdio: "pipe" });

  server = spawn(process.execPath, [join(repo, "server", "index.ts")], {
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      BLOKS_PORT: String(PORT),
      BLOKS_STATIC_DIR: join(repo, "dist"),
    },
    stdio: "ignore",
  });

  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${URL}/api/health`)).ok) break;
    } catch {
      /* not listening yet */
    }
    await wait(500);
  }

  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  for (const [file, shot, dark] of [
    ["hero.png", "room", false],
    ["hero-dark.png", "room", true],
    ["engines.png", "engines", false],
  ]) {
    const page = await browser.newPage({
      viewport: { width: 1360, height: 880 },
      deviceScaleFactor: 2,
      colorScheme: dark ? "dark" : "light",
      timezoneId: "UTC",
    });
    await page.goto(URL, { waitUntil: "networkidle" });
    await wait(2500);

    // past the intro and the first run, whatever either offers
    for (let i = 0; i < 10; i++) {
      const clicked = await page.evaluate(() => {
        const words = ["Skip intro", "Skip this", "Skip for now", "Continue where I left off", "Continue", "Next", "Done", "Get started"];
        const b = [...document.querySelectorAll("button")].find((x) => words.includes((x.textContent || "").trim()));
        if (!b) return false;
        b.click();
        return true;
      });
      if (!clicked) break;
      await wait(800);
    }

    // the theme is the app's own setting, not only the media query
    await page.evaluate(async (wantDark) => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const byTitle = (t) => [...document.querySelectorAll("button")].find((x) => (x.getAttribute("title") || "") === t);
      const byText = (t) => [...document.querySelectorAll("button")].find((x) => (x.textContent || "").trim() === t);
      byTitle("Settings")?.click(); await sleep(900);
      byText("General")?.click(); await sleep(500);
      byText(wantDark ? "Dark" : "Light")?.click(); await sleep(800);
      [...document.querySelectorAll("button")].reverse()
        .find((x) => (x.getAttribute("aria-label") || "") === "Close" || (x.textContent || "").trim() === "Close")?.click();
      await sleep(700);
    }, dark);

    await page.evaluate(async (which) => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const byTitle = (t) => [...document.querySelectorAll("button")].find((x) => (x.getAttribute("title") || "") === t);
      const byText = (t) => [...document.querySelectorAll("button")].find((x) => (x.textContent || "").trim() === t);
      if (which === "engines") {
        byTitle("Settings")?.click(); await sleep(900);
        byText("Engines")?.click(); await sleep(900);
        return;
      }
      [...document.querySelectorAll("button")]
        .find((x) => (x.textContent || "").trim().startsWith("Launch week"))?.click();
      await sleep(1500);
      // the transcript reads best at the end, where the lead sums up
      const scrollers = [...document.querySelectorAll("*")].filter(
        (e) => e.scrollHeight > e.clientHeight + 40 && getComputedStyle(e).overflowY !== "visible",
      );
      const t = scrollers[scrollers.length - 1];
      if (t) t.scrollTop = t.scrollHeight;
      await sleep(700);
    }, shot);

    // Whatever was clicked to get here is still focused, and the app draws
    // a real focus ring on it. In a screenshot that reads as a UI bug.
    await page.evaluate(() =>
      document.activeElement instanceof HTMLElement ? document.activeElement.blur() : null,
    );
    await wait(1200);

    const out = join(repo, "docs", "screenshots", file);
    await page.screenshot({ path: out });
    await page.close();
    console.log("wrote docs/screenshots/" + file);
  }
  await browser.close();
} finally {
  server?.kill("SIGTERM");
  await wait(500);
  rmSync(home, { recursive: true, force: true });
}
