// Leaves nothing in this process's environment that names a real Bloks
// workspace.
//
// A shell opened inside Bloks (a terminal in the app, an agent's turn)
// carries the workspace it belongs to: its data folder, its port, its
// address and a token for it. Tests started from that shell inherit all
// of it, and so does every child they start with the parent's
// environment, which is how a fixture once replaced somebody's
// config.json (GitHub 529). Loaded first, this takes those variables out
// before any test or helper reads them, so a test's data folder is only
// ever the one it makes.
//
// `pnpm test` preloads it into every test file (--import in
// package.json). Helpers that start servers or children import it too,
// so a single file run by hand gets the same. A test that wants one of
// these set says so itself, after this has run.

/** Where a workspace keeps its data, which one it is, and how to reach
 * and speak to its server. */
export const WORKSPACE_VARS = [
  "BLOKS_DATA_DIR",
  "BLOKS_WORKSPACES_DIR",
  "BLOKS_WORKSPACE_ID",
  "BLOKS_WORKSPACE_NAME",
  "BLOKS_WORKSPACE_KIND",
  "BLOKS_WORKSPACE_COLOR",
  "BLOKS_WORKSPACE_PATTERN",
  "BLOKS_SERVER_HOME",
  "BLOKS_SERVER_ROOT",
  "BLOKS_SERVER_STATIC",
  "BLOKS_STATIC_DIR",
  "BLOKS_PORT",
  "BLOKS_LISTEN",
  "BLOKS_URL",
  "BLOKS_TOKEN",
  "BLOKS_SERVER_TOKEN",
  "BLOKS_REPLY_TOKEN",
  "BLOKS_REPLY_PATH",
  "BLOKS_LOCAL_KEY",
  "BLOKS_CLI",
  "BLOKS_OUTBOX",
] as const;

for (const name of WORKSPACE_VARS) delete process.env[name];
