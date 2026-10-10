// Making sure no engine outlives the server.
//
// Each engine runs in a process group of its own (see no-console.ts), so
// that stopping it reaches the MCP servers and tools it started as well
// as the engine itself. Stopping a turn sends the group SIGTERM, and that
// was all a shutdown did: the drivers asked and returned, the server
// exited at once, and the SIGKILL meant for a process that would not
// listen sat on a timer that went with it. An engine stuck in a tool
// call, or a connector that ignores SIGTERM, kept running after Bloks
// quit, and the next start resumed its session beside it. A process still
// running after its turn had ended was not even asked.
//
// So each instance keeps the engine processes it started, and disposing
// it ends them: SIGTERM to each group, a short wait, then SIGKILL to each
// group whether or not its leader has gone, since what ignored SIGTERM may
// be something it left in the group. The wait fits inside the two seconds
// Electron gives the server once it kills it.
import type { ChildProcess } from "node:child_process";

import { OWN_GROUP } from "../no-console.ts";

/** How long engines get to end on their own before they are made to. */
export const SHUTDOWN_GRACE_MS = 1_500;

/** A signal to a child's whole process group where it has one, or to the
 * child alone. */
export function signalGroup(child: ChildProcess, signal: NodeJS.Signals) {
  if (OWN_GROUP && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      /* no group left to signal; the child alone, below */
    }
  }
  try {
    child.kill(signal);
  } catch {
    /* already gone */
  }
}

const exited = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null;

/** The engine processes one instance has started and not yet seen exit. */
export class EngineProcesses {
  private live = new Set<ChildProcess>();

  add(child: ChildProcess) {
    this.live.add(child);
    child.once("exit", () => this.live.delete(child));
    // one that never started has no exit to wait for
    child.once("error", () => {
      if (!child.pid) this.live.delete(child);
    });
  }

  /** Ends every one still running, as above. Resolves once each has
   * exited, or its group has been sent SIGKILL. */
  async end(graceMs = SHUTDOWN_GRACE_MS) {
    const children = [...this.live].filter((child) => child.pid);
    if (!children.length) return;
    for (const child of children) signalGroup(child, "SIGTERM");
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.all(children.map((child) => (exited(child) ? null : new Promise((resolve) => child.once("exit", resolve))))),
      new Promise((resolve) => (timer = setTimeout(resolve, graceMs))),
    ]);
    clearTimeout(timer);
    for (const child of children) signalGroup(child, "SIGKILL");
  }
}
