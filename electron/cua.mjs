// Letting an agent drive this Mac.
//
// Computer use runs through cua-driver, which has a daemon that does the
// actual clicking and typing. Who owns that daemon decides whose name is
// on the macOS permission prompt, which is the whole reason this lives in
// the Electron main process rather than in the harness.
//
// Two arrangements:
//
//   embedded    the packaged app starts its own private daemon as a child.
//               Accessibility and Screen Recording are then requested by
//               Bloks, granted to Bloks, and inherited by the daemon. One
//               prompt, correctly named.
//   standalone  a development machine where CuaDriver.app is installed and
//               already running with its own permissions. Attach instead
//               of starting a second one.
//
// Agents never speak to the daemon socket. They spawn cua-driver's own
// stdio MCP proxy, which forwards to the daemon this process owns. The
// proxy executes nothing itself, so an agent cannot reach the machine by
// any path except through the host that holds the grants.
//
// Whatever is arranged is written to a descriptor file that the harness
// reads when it builds a turn.
import { app, ipcMain } from "electron";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** Where a developer install of CuaDriver.app puts its binary and socket. */
const INSTALLED_BINARY = "/Applications/CuaDriver.app/Contents/MacOS/cua-driver";
const INSTALLED_SOCKET = path.join(app.getPath("home"), "Library/Caches/cua-driver/cua-driver.sock");

/** cua-driver reports usage upstream and checks GitHub for updates unless
 * told not to. Bloks keeps what happens on this machine on this machine,
 * and the copy it ships is signed into the app and updated with it, so
 * the daemon it starts and every MCP proxy an agent starts are told to do
 * neither. */
const QUIET = { CUA_DRIVER_RS_TELEMETRY_ENABLED: "0", CUA_DRIVER_RS_UPDATE_CHECK: "0" };

/** Identifies this app to the daemon as the holder of the TCC grants. */
const HOST_BUNDLE_ID = "dev.bloks.app";

const DESCRIPTOR_FILE = () => path.join(app.getPath("userData"), "cua-connection.json");

let host = null;
let descriptor = null;

/** The cua-driver binary to use: an explicit override, the copy shipped
 * inside the packaged app, or a developer's installed one. */
export function resolveDriverBinary() {
  if (process.env.CUA_DRIVER_PATH) return process.env.CUA_DRIVER_PATH;

  if (app.isPackaged) {
    const bundled = path.join(process.resourcesPath, "cua-driver");
    if (fs.existsSync(bundled)) return bundled;
  }
  return fs.existsSync(INSTALLED_BINARY) ? INSTALLED_BINARY : null;
}

/** Whether anything is actually listening on a socket path. The file
 * existing proves nothing: a daemon that crashed leaves one behind. */
function socketAnswers(socketPath) {
  return new Promise((resolve) => {
    if (!fs.existsSync(socketPath)) return resolve(false);

    const probe = net.createConnection(socketPath);
    const settle = (answered) => {
      probe.destroy();
      resolve(answered);
    };
    probe.once("connect", () => settle(true));
    probe.once("error", () => settle(false));
    setTimeout(() => settle(false), 1500).unref();
  });
}

/** Where the SDK is imported from. The packaged app carries its own small
 * node_modules for it in Resources (scripts/stage-cua.mjs says why), since
 * the asar holds none; from source it is the ordinary installed package. */
function sdkEntry(sub = "embedded") {
  if (!app.isPackaged) return sub === "index" ? "@trycua/cua-driver" : `@trycua/cua-driver/${sub}`;
  const entry = path.join(process.resourcesPath, "cua", "node_modules", "@trycua", "cua-driver", "dist", `${sub}.js`);
  return pathToFileURL(entry).href;
}

async function startEmbeddedHost(binary) {
  // Imported here rather than at module load: the SDK carries a native
  // library, and a machine where it will not load should lose computer
  // use, not the whole app.
  const { EmbeddedCuaDriverHost } = await import(sdkEntry());

  // The host spawns the daemon from this process, so it inherits this
  // environment; there is no other way to hand it one.
  Object.assign(process.env, QUIET);
  host = new EmbeddedCuaDriverHost(binary, HOST_BUNDLE_ID);
  const started = await host.start();

  // The SDK says how an agent reaches this daemon: command, arguments and
  // environment. Taken as given rather than rebuilt here, so the next
  // upgrade that changes them cannot leave agents knocking on the wrong
  // door. The fallback is what 0.23 needed, for a build that lacks it.
  const mcp = started.mcp;
  return {
    mode: "embedded",
    socketPath: started.socketPath,
    mcpCommand: mcp?.command || binary,
    mcpArgs: mcp?.args?.length ? mcp.args : ["mcp", "--embedded", "--socket", started.socketPath],
    mcpEnv: {
      CUA_DRIVER_EMBEDDED: "1",
      CUA_DRIVER_HOST_BUNDLE_ID: HOST_BUNDLE_ID,
      ...Object.fromEntries((mcp?.environment ?? []).map(({ name, value }) => [name, value])),
      ...QUIET,
    },
  };
}

export async function startCua() {
  const binary = resolveDriverBinary();
  if (!binary) {
    return publish({ mode: "unavailable", reason: "cua-driver binary not found" });
  }

  // Packaged builds always own their daemon. The env var is for testing
  // that path from a development build.
  if (app.isPackaged || process.env.BLOKS_CUA_EMBEDDED === "1") {
    try {
      return publish(await startEmbeddedHost(binary));
    } catch (error) {
      return publish({
        mode: "unavailable",
        reason: `embedded host failed: ${error?.message ?? error}`,
      });
    }
  }

  if (await socketAnswers(INSTALLED_SOCKET)) {
    return publish({
      mode: "standalone",
      socketPath: INSTALLED_SOCKET,
      mcpCommand: binary,
      mcpArgs: ["mcp"],
      mcpEnv: { ...QUIET },
    });
  }

  return publish({
    mode: "unavailable",
    reason:
      "no running cua-driver daemon; run `cua-driver serve` or grant via `cua-driver permissions grant`",
  });
}

/** Record the arrangement where the harness will look for it. */
function publish(next) {
  descriptor = next;
  try {
    fs.writeFileSync(DESCRIPTOR_FILE(), JSON.stringify(descriptor, null, 2));
  } catch {
    // Unwritable userData is worth surviving: computer use will report
    // itself unavailable, which is the honest outcome anyway.
  }
  return descriptor;
}

/** Whether this process owns the daemon, and so owns the grants: the
 * packaged app always does, and a development build can be told to. */
const ownsDaemon = () => app.isPackaged || process.env.BLOKS_CUA_EMBEDDED === "1";

/**
 * Accessibility and Screen Recording, as macOS sees them for computer use.
 *
 * When Bloks starts the daemon itself, the grants that matter are Bloks'
 * own, and only a probe run inside this process reads those: asking the
 * cua-driver binary instead reports on the standalone CuaDriver app,
 * which here is usually not installed, so it only ever said "unknown".
 * The SDK's probe runs in the importing process and never prompts.
 */
export async function cuaPermissionsStatus() {
  if (process.platform !== "darwin") return { available: false };
  if (ownsDaemon()) {
    try {
      const { currentMacOsPermissionStatus } = await import(sdkEntry("index"));
      const { accessibility, screenRecording } = currentMacOsPermissionStatus();
      return { available: true, owner: "bloks", accessibility, screenRecording };
    } catch (error) {
      return { available: false, reason: `permission check failed: ${error?.message ?? error}` };
    }
  }

  // Attached to a developer's own CuaDriver.app: its grants, its answer.
  const binary = resolveDriverBinary();
  if (!binary) return { available: false };

  const result = spawnSync(binary, ["permissions", "status", "--json"], {
    env: { ...process.env, ...QUIET },
    encoding: "utf8",
    timeout: 5000,
  });
  try {
    return { available: true, owner: "cua-driver", ...JSON.parse(result.stdout) };
  } catch {
    // An older binary, or one that printed something unparseable. The raw
    // text still tells a person more than a bare failure would.
    return { available: true, raw: result.stdout?.trim() };
  }
}

export async function stopCua() {
  if (!host) return;
  try {
    await host.stop();
    host.uniffiDestroy?.();
  } catch {
    // The daemon also watches a parent-liveness pipe, so it exits when
    // this process does regardless of whether this succeeded.
  }
  host = null;
}

/**
 * Ask macOS for both grants on Bloks' behalf. The SDK makes the request
 * from this process, so the prompt and the System Settings entry both
 * name Bloks. macOS only ever asks once; after a refusal the answer is
 * System Settings, which the panel links to.
 */
async function cuaRequestPermissions() {
  if (process.platform !== "darwin" || !ownsDaemon()) return cuaPermissionsStatus();
  try {
    const { requestMacOsPermissions } = await import(sdkEntry("index"));
    requestMacOsPermissions();
  } catch {
    // Report what macOS believes now rather than failing the click.
  }
  return cuaPermissionsStatus();
}

export function registerCuaIpc() {
  ipcMain.handle("cua:connection", () => descriptor);
  ipcMain.handle("cua:permissions", () => cuaPermissionsStatus());
  ipcMain.handle("cua:request-permissions", () => cuaRequestPermissions());
}
