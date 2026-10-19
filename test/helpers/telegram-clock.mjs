// Only the fixture server's wall clock moves. Timers and the fake engine
// keep real time; no production clock option or external service is involved.
import { readFileSync } from "node:fs";
import { join } from "node:path";
if (process.argv[1]?.endsWith("/server/index.ts")) {
  const now = Date.now;
  const file = join(process.env.HOME, "telegram-clock-offset");
  Date.now = () => {
    let offset = 0;
    try { offset = Number(readFileSync(file, "utf8")) || 0; } catch {}
    return now() + offset;
  };
}
