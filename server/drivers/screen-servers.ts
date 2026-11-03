// The browser and the computer, as the MCP servers an engine is handed.
//
// One shape for every driver that mounts them (Claude Code, the ACP
// agents), so an agent's browser and computer are the same tools
// whichever engine it runs on. Each driver only writes them down in its
// engine's own words: an MCP config file for Claude Code, session/new's
// mcpServers for ACP.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { SendTurnInput } from "../contracts.ts";

/** Our MCP entry points ship as TypeScript in development and as compiled
 * JavaScript inside the packaged app. Resolve whichever is actually there
 * rather than guessing from an env flag. */
export function helperEntry(name: string): string {
  const asTypeScript = join(dirname(fileURLToPath(import.meta.url)), "..", `${name}.ts`);
  return existsSync(asTypeScript) ? asTypeScript : asTypeScript.replace(/\.ts$/, ".js");
}

const COMPUTER_HELPER = helperEntry("computer-proxy");
const BROWSER_HELPER = helperEntry("browser-proxy");

/** In the packaged app `process.execPath` is Electron, not node. This makes
 * it behave as plain node for anything we spawn with it, and does nothing
 * in development where it already is node. */
export const RUN_AS_NODE = { ELECTRON_RUN_AS_NODE: "1" };

/** Where a browser's window can be shown, if anywhere. The browser proxy
 * decides from these whether Chrome opens a window or runs headless
 * (cdp.ts), and an engine that starts its MCP servers with only the
 * variables it was given would otherwise hide a display that is there. */
const DISPLAY_VARS = ["DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "XDG_RUNTIME_DIR"] as const;

export interface StdioServer {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/**
 * The agent's computer and browser, from a turn's integrations, under the
 * names they are published as. The cloud box and this Mac (or the Local
 * VM) are the same tool surface from the agent's side, so whichever it
 * was handed is its one computer, the cloud box first.
 */
export function screenServers(
  integrations: SendTurnInput["integrations"],
  env: NodeJS.ProcessEnv = process.env,
): { computer?: StdioServer; browser?: StdioServer } {
  const servers: { computer?: StdioServer; browser?: StdioServer } = {};
  if (integrations?.computer) {
    servers.computer = {
      command: process.execPath,
      args: [COMPUTER_HELPER],
      env: { ...RUN_AS_NODE, BLOKS_BOX_ID: integrations.computer.boxId, BLOKS_BOX_TOKEN: integrations.computer.token },
    };
  } else if (integrations?.localComputer) {
    // verbatim: the daemon has to be the one that holds the grants
    const { command, args, env: own } = integrations.localComputer;
    servers.computer = { command, args: [...args], env: { ...own } };
  }
  if (integrations?.browser) {
    const display: Record<string, string> = {};
    for (const name of DISPLAY_VARS) if (env[name]) display[name] = env[name]!;
    servers.browser = {
      command: process.execPath,
      args: [BROWSER_HELPER],
      env: { ...RUN_AS_NODE, ...display, BLOKS_BROWSER_PROFILE: integrations.browser.profileDir },
    };
  }
  return servers;
}
