// Check-ins from the agent's command line: `bloks routine --every 30m
// --between 09:00-18:00`, read the ways somebody types an interval and
// refused there and then when it is not one the workspace runs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer, type IncomingMessage } from "node:http";
import { fileURLToPath } from "node:url";

const BLOKS = fileURLToPath(new URL("../bin/bloks.mjs", import.meta.url));

/** A stand-in workspace that writes down every request it is sent. */
async function workspace(t: { after: (fn: () => unknown) => void }) {
  const seen: Array<{ method: string; path: string; body: any }> = [];
  const server = createServer((req: IncomingMessage, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : null;
      seen.push({ method: req.method!, path: req.url!, body });
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/agent/whoami") return res.end(JSON.stringify({ botId: "bot-1", taskId: "task-1" }));
      if (req.url === "/api/routines" && req.method === "GET") {
        return res.end(JSON.stringify({
          routines: [
            { id: "r1", targetId: "bot-1", targetKind: "agent", prompt: "Inbox", time: "09:00", days: [], every: 30, activeHours: { from: "09:00", to: "18:00" }, quiet: true, enabled: true, summary: "Every 30 min, 09:00 to 18:00", nextRunAt: new Date(2030, 0, 7, 9, 30).getTime() },
          ],
        }));
      }
      res.end(JSON.stringify({ ok: true, routine: body }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const run = (...args: string[]) =>
    new Promise<{ code: number; out: any }>((resolve) => {
      execFile(process.execPath, [BLOKS, ...args], { env: { ...process.env, BLOKS_URL: url, BLOKS_TOKEN: "turn-token" } }, (error, stdout) => {
        resolve({ code: error ? Number((error as { code?: number }).code ?? 1) : 0, out: JSON.parse(stdout) });
      });
    });
  const filed = () => w.seen.filter((r) => r.method === "POST" && r.path === "/api/routines").map((r) => r.body);
  const w = { seen, run, filed };
  return w;
}

test("--every with --between files a check-in for yourself", async (t) => {
  const w = await workspace(t);
  const { code, out } = await w.run("routine", "--prompt", "Anything urgent in the inbox?", "--every", "30m", "--between", "9:00-18:00", "--days", "1,2,3,4,5");
  assert.equal(code, 0, JSON.stringify(out));
  const [body] = w.filed();
  assert.deepEqual(
    { targetId: body.targetId, every: body.every, activeHours: body.activeHours, days: body.days, time: body.time, quiet: body.quiet },
    { targetId: "bot-1", every: 30, activeHours: { from: "09:00", to: "18:00" }, days: [1, 2, 3, 4, 5], time: undefined, quiet: undefined },
  );
});

test("an interval is read the ways people write one", async (t) => {
  const w = await workspace(t);
  const cases: Array<[string, number]> = [["30m", 30], ["45", 45], ["90min", 90], ["2h", 120], ["1h30m", 90], ["24h", 1440], ["15 minutes", 15]];
  for (const [said] of cases) assert.equal((await w.run("routine", "--prompt", "Check", "--every", said)).code, 0, said);
  assert.deepEqual(w.filed().map((b) => b.every), cases.map(([, minutes]) => minutes));
  assert.ok(w.filed().every((b) => b.activeHours === undefined), "no hours means the whole day");
});

test("what the workspace would not run is refused before anything is filed", async (t) => {
  const w = await workspace(t);
  const refused: Array<[string[], RegExp]> = [
    [["--every", "5m"], /15m to 24h/],
    [["--every", "25h"], /15m to 24h/],
    [["--every", "soon"], /15m to 24h/],
    [["--every", "30m", "--between", "18:00-09:00"], /earlier first/],
    [["--every", "30m", "--between", "9-18"], /like 09:00-18:00/],
    [["--every", "30m", "--time", "09:00"], /not at a --time/],
    [["--between", "09:00-18:00", "--time", "09:00"], /give it --every too/],
    [[], /--time like 09:00, or --every like 30m/],
  ];
  for (const [flags, why] of refused) {
    const { code, out } = await w.run("routine", "--prompt", "Check", ...flags);
    assert.notEqual(code, 0, flags.join(" "));
    assert.match(out.error, why, flags.join(" "));
  }
  assert.equal(w.filed().length, 0);
});

test("--quiet lets a time-of-day routine answer QUIET, and the list says which are quiet", async (t) => {
  const w = await workspace(t);
  assert.equal((await w.run("routine", "--prompt", "Brief me if anything moved", "--time", "08:00", "--quiet")).code, 0);
  assert.equal((await w.run("routine", "--prompt", "Brief me", "--time", "08:00")).code, 0);
  const [quiet, plain] = w.filed();
  assert.equal(quiet.quiet, true);
  assert.equal(quiet.time, "08:00");
  assert.equal(plain.quiet, undefined, "a time of day speaks every time unless asked not to");
  const { out } = await w.run("routines");
  assert.equal(out[0].when, "Every 30 min, 09:00 to 18:00");
  assert.equal(out[0].quiet, true);
});
