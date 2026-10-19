// An individual turn owns its process group until its leader and helpers
// have stopped. Sending SIGKILL is a request, not proof of that boundary.
import type { ChildProcess } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";

import { OWN_GROUP } from "../no-console.ts";
import { signalGroup } from "./engine-processes.ts";

/** Whether the old group has no executable members. Linux can retain dead
 * orphaned helpers as zombies until init reaps them; those cannot run or
 * keep a pipe open. Elsewhere require the group itself to disappear. */
function groupEnded(pid: number) {
  try {
    process.kill(-pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
  if (process.platform !== "linux") return false;
  try {
    for (const entry of readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      let stat: string;
      try {
        stat = readFileSync(`/proc/${entry}/stat`, "utf8");
      } catch (error) {
        if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) continue;
        return false; // cannot confirm what could not be inspected
      }
      // comm is parenthesized and may itself contain spaces or ')'.
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (Number(fields[2]) === pid && fields[0] !== "Z" && fields[0] !== "X") return false;
    }
    return true;
  } catch {
    return false;
  }
}

export class TurnProcess {
  private leaderEnded: boolean;
  private done = false;
  private stopping = false;
  private monitor?: ReturnType<typeof setInterval>;
  private deadline?: ReturnType<typeof setTimeout>;
  private result?: Promise<boolean>;
  private resolve?: (confirmed: boolean) => void;

  private child: ChildProcess;
  private options: { onConfirmed?: () => void };

  constructor(child: ChildProcess, options: { onConfirmed?: () => void } = {}) {
    this.child = child;
    this.options = options;
    this.leaderEnded = child.exitCode !== null || child.signalCode !== null;
    child.once("exit", () => {
      this.leaderEnded = true;
      this.check();
    });
    child.once("error", () => {
      // Failed spawn has no leader or group to clean up. An error from a
      // running child does not establish its exit.
      if (!child.pid) this.leaderEnded = true;
      this.check();
    });
  }

  get confirmed() {
    return this.done;
  }

  private check() {
    if (!this.stopping || this.done || !this.leaderEnded) return;
    if (OWN_GROUP && this.child.pid && !groupEnded(this.child.pid)) return;
    this.done = true;
    clearInterval(this.monitor);
    clearTimeout(this.deadline);
    this.resolve?.(true);
    this.options.onConfirmed?.();
  }

  /** Bounded TERM then KILL, scoped to this child, never another lane.
   * A false result leaves an unref'd confirmation monitor and ownership
   * barrier in place. onConfirmed releases only this old owner's barrier.
   * Windows has no owned process group: only leader exit is confirmed. */
  end(graceMs = 3_000): Promise<boolean> {
    if (this.result) return this.result;
    this.stopping = true;
    this.result = new Promise<boolean>((resolve) => (this.resolve = resolve));
    this.monitor = setInterval(() => this.check(), 50);
    this.monitor.unref();
    signalGroup(this.child, "SIGTERM");
    this.check();
    if (!this.done) {
      this.deadline = setTimeout(() => {
        // The leader may have exited while a helper retained its pipe.
        // Always finish the old group's cleanup before confirming reuse.
        signalGroup(this.child, "SIGKILL");
        this.check();
        if (!this.done) {
          this.deadline = setTimeout(() => {
            this.check();
            if (!this.done) this.resolve?.(false);
          }, graceMs);
        }
      }, graceMs);
    }
    return this.result;
  }
}
