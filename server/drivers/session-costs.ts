// What a Claude Code session has cost so far, so one turn's cost can be
// told apart from the session's.
//
// Claude Code reports `total_cost_usd` on every result: the running total
// of the whole session, which carries on across `--resume`. Taken as the
// cost of the turn, a session's 166th turn was charged the price of all
// 166 (GitHub 137). A turn's own cost is the difference from the last
// total seen for the same session.
//
// The last totals are kept on disk, because a session outlives this
// process: the first turn after a restart would otherwise be charged the
// session's whole history again. A resumed session whose earlier total
// was never seen here (one that predates this file) gets no cost for that
// turn rather than a guess, and is exact from the next one on.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { DATA_DIR } from "../config.ts";
import { readSaved, isRecord } from "../atomic-write.ts";

/** Sessions remembered, most recent last. Enough for every lane in use. */
const MAX_SESSIONS = 2_000;

export class SessionCosts {
  private totals = new Map<string, number>();
  private readonly file: string;

  constructor(dir: string = DATA_DIR) {
    this.file = join(dir, "claude-session-costs.json");
    const saved = readSaved<Record<string, unknown>>(this.file, {}, isRecord);
    for (const [id, total] of Object.entries(saved)) {
      if (typeof total === "number" && Number.isFinite(total)) this.totals.set(id, total);
    }
  }

  /**
   * The cost of the turn that just reported `total` for `session`, and the
   * total remembered for next time. `resumed` says whether the turn
   * continued an earlier session (so an unknown baseline is a real gap)
   * rather than starting one (where the total is the turn).
   */
  turn(session: string, total: number, resumed: boolean): number | null {
    const before = this.totals.get(session);
    this.totals.delete(session);
    this.totals.set(session, total);
    while (this.totals.size > MAX_SESSIONS) this.totals.delete(this.totals.keys().next().value!);
    this.save();
    if (before === undefined) return resumed ? null : total;
    // a total that went down is a session that started its count again
    return total >= before ? Math.round((total - before) * 1e6) / 1e6 : total;
  }

  private save() {
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      writeFileSync(this.file, JSON.stringify(Object.fromEntries(this.totals)), { mode: 0o600 });
    } catch {
      /* kept in memory; written with the next turn */
    }
  }
}
