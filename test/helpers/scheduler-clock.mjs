// Only the isolated child receives this preload. No production clock changes.
import { readFileSync } from "node:fs";
const file = process.env.BLOKS_TEST_CLOCK_FILE;
if (file) {
  const RealDate = Date;
  globalThis.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : [Date.now()])); }
    static now() { return RealDate.now() + Number(readFileSync(file, "utf8")); }
  };
  const every = globalThis.setInterval;
  // Drive the actual scheduler callbacks; the test advances their clock.
  globalThis.setInterval = (callback, ms, ...args) => every(callback, ms === 30_000 || ms === 60_000 ? 20 : ms, ...args);
}
