// A data folder of this test file's own, for a test that runs server code
// in its own process rather than through a server it starts.
//
// server/config.ts settles the data folder once, when it is first loaded,
// from BLOKS_DATA_DIR or else the real home's .bloks. A driver run in the
// test process then writes its native copy there, which on a developer's
// machine is their own Bloks. Imported first, before anything that loads
// config.ts, this points it at a throwaway folder instead. A folder said
// already in the environment is a workspace's, inherited from the shell
// the tests were started in (GitHub 529), so it is dropped rather than
// used; servers started through helpers/server.ts choose their own
// regardless.
import "./isolated-env.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "bloks-test-data-"));
process.env.BLOKS_DATA_DIR = dir;
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
