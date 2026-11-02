// What kind of machine this workspace runs on, said as four separate
// things rather than one flag (GitHub 442).
//
// BLOKS_HOSTED=1 used to answer every question about the machine at once:
// that it is reached from somewhere else, that somebody other than the
// person looks after it and its software, that it is the agents'
// computer, and that the owner's own devices may open its shell. A
// person running bloks-server on a Linux box of their own set it for the
// last of those and got all the others with it: the workspace said
// Hosted, updates were left to an image that does not exist there, and
// location and the Local VM went away for no reason that applied.
//
// So the questions are asked apart:
//
//   runs        inside the desktop app, or as a bloks-server of its own
//   managedBy   the person who runs it, or the provider who hosts it for
//               them (BLOKS_HOSTED=1, and nothing else, says the latter)
//   updates     how Bloks there gets a new version, which the install
//               decides (server/server-update.ts installOf)
//   capabilities, each from what it actually depends on:
//     ownerTerminal  the owner's own paired devices may open a terminal
//                    on this machine: always on a provider's machine,
//                    which nobody sits at, and on a server of the
//                    person's own only when they say so where it runs
//                    (BLOKS_OWNER_TERMINAL=1). Never in the desktop app:
//                    a paired phone is not a way into somebody's laptop.
//
// What stays the provider's alone, and why, is said where each is decided
// (server/hosted.ts and the routes in server/index.ts), and gathered in
// docs/SELF_HOSTING.md. Read once, at startup: a machine does not change
// kind while it runs.
import { isHosted } from "./hosted.ts";

export type Runs = "app" | "server";
export type ManagedBy = "owner" | "provider";

export interface Deployment {
  /** Inside the desktop app, or a bloks-server of its own. */
  runs: Runs;
  /** Who looks after the machine and the Bloks on it. */
  managedBy: ManagedBy;
  /** The owner's own paired devices may open a terminal here. */
  ownerTerminal: boolean;
  /** Why ownerTerminal is what it is, for Settings and the docs: the
   * provider's machine, the setting where it runs, or neither. */
  ownerTerminalFrom: "provider" | "setting" | null;
}

/** BLOKS_OWNER_TERMINAL=1 opens the terminal to the owner's own paired
 * devices on a server of the person's own. Anything else leaves it shut. */
export function ownerTerminalAsked(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.BLOKS_OWNER_TERMINAL === "1";
}

/** This machine's kind, from its environment and whether the desktop app
 * started it. */
export function deploymentOf(o: { inApp: boolean; env?: NodeJS.ProcessEnv }): Deployment {
  const env = o.env ?? process.env;
  const managedBy: ManagedBy = isHosted(env) ? "provider" : "owner";
  const runs: Runs = o.inApp ? "app" : "server";
  const ownerTerminalFrom = managedBy === "provider" ? "provider" : runs === "server" && ownerTerminalAsked(env) ? "setting" : null;
  return { runs, managedBy, ownerTerminal: ownerTerminalFrom !== null, ownerTerminalFrom };
}

/** What Settings calls the machine: the app on this computer, a server
 * the person runs, or managed hosting. */
export type DeploymentKind = "app" | "self-hosted" | "managed";

export function deploymentKind(d: Deployment): DeploymentKind {
  if (d.managedBy === "provider") return "managed";
  return d.runs === "server" ? "self-hosted" : "app";
}

/** What a terminal request from a paired device is told when the shell is
 * not open to it, in words that say the real reason. */
export function terminalRefusal(d: Deployment): string {
  if (d.runs === "app") {
    return "The terminal opens only on this computer itself. A paired device never gets a shell on a computer running the Bloks app.";
  }
  return "This server's terminal opens only on the server itself. To open it from your own paired devices, set BLOKS_OWNER_TERMINAL=1 where Bloks runs and restart it.";
}

/** The part /api/config says, for Settings. */
export function deploymentView(d: Deployment, computer: string) {
  return {
    kind: deploymentKind(d),
    runs: d.runs,
    managedBy: d.managedBy,
    computer,
    ownerTerminal: d.ownerTerminal,
    ownerTerminalFrom: d.ownerTerminalFrom,
  };
}
