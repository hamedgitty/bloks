// Capture the app at 2x for the site, from the same seeded demo home the
// README screenshots use, with the computer panel open on a real VM.
import { chromium } from "playwright-core";

const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 2 });
await page.goto("http://localhost:5210", { waitUntil: "networkidle" });
await page.evaluate(() => {
  localStorage.setItem("bloks-setup-done", "1");
  localStorage.setItem("bloks-intro-done", "1");
});
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(1200);

// open the agent, then its computer
await page.evaluate(() => {
  const b = [...document.querySelectorAll("aside button")].find((x) => x.textContent.includes("Head of Marketing"));
  b?.click();
});
await page.waitForTimeout(900);
await page.evaluate(() => {
  const c = [...document.querySelectorAll("button")].find((x) => (x.title || "") === "Agent computer");
  c?.click();
});
// the first frame takes a moment to arrive from the VM
await page.waitForFunction(
  () => [...document.querySelectorAll("aside img")].some((i) => (i.alt || "").includes("Local VM")),
  { timeout: 30000 },
);
await page.waitForTimeout(1500);
await page.screenshot({ path: process.argv[2] });
await browser.close();
console.log("captured", process.argv[2]);
