// A restore asked for before the last stop, put in place as Bloks starts.
//
// server/index.ts imports this first, ahead of every module that reads
// the data folder. A store reads its file once, when it is made, and a
// few are made as their module loads, so the swap has to come before all
// of them; otherwise the old workspace, held in memory, is written into
// the restored one on the first save. server/backup.ts has the rest.
import { existsSync } from "node:fs";

import { applyPendingRestore } from "./backup.ts";
import { DATA_DIR } from "./config.ts";

try {
  applyPendingRestore();
} catch (error) {
  console.error(`[bloks] ${(error as Error).message}`);
  // A swap that could not finish has put back what it moved, so the
  // folder is there and starting is safe. If it is not, starting would
  // make an empty one and run on it, which reads as everything gone;
  // stopping says what happened instead, and the next start tries again.
  if (!existsSync(DATA_DIR)) process.exit(1);
}
