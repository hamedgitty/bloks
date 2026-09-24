// Rehearsals: an agent does the work on a copy, and you decide.
//
// Undo (server/checkpoints.ts) takes a mistake back after it landed. A
// rehearsal stops it landing at all. The agent's folder is cloned, the
// turn runs in the clone in a lane of its own, and what it changed comes
// back as the same card undo uses, with Apply and Discard instead of
// Undo. Apply writes the changes into the real folder file by file, and
// only onto files that are still as they were when the rehearsal began;
// anything you changed meanwhile is left alone and named. After that the
// card undoes like any other.
//
// Compare is the same thing more than once: the same task, in the same
// folder, handed to two or three agents at once, each in its own clone.
// Keeping one attempt discards the rest.
//
// The clone is copy-on-write where the filesystem can do it (APFS on a
// Mac, reflinks on Btrfs and XFS), so a large project copies in a moment
// and costs almost no disk until something changes. Elsewhere it is a
// plain copy, which the size limits in checkpoints.ts keep sane.
//
// What a rehearsal does not contain is anything outside the folder. A
// command that sends an email or pushes a branch is as real in a
// rehearsal as anywhere; the agent is told so, and approvals still ask.
import { execFile } from "node:child_process";
import { cp, rm } from "node:fs/promises";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { newId } from "./contracts.ts";

export type RehearsalState = "running" | "ready" | "empty" | "applied" | "discarded" | "failed";

export interface Rehearsal {
  id: string;
  /** Attempts at the same task share a group. */
  group: string;
  botId: string;
  /** The lane the attempt runs in. */
  taskId: string;
  /** The real folder, and the clone the agent works in. */
  dir: string;
  copy: string;
  text: string;
  state: RehearsalState;
  checkpointId?: string;
  at: number;
  settledAt?: number;
}

/** Past this many, the oldest settled ones are forgotten. */
const MAX_KEPT = 100;
/** A clone nobody applied or discarded is cleared after this long. */
const STALE_MS = 7 * 24 * 60 * 60 * 1000;

function run(file: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 120_000 }, (error) => (error ? reject(error) : resolve()));
  });
}

/**
 * Copies a folder, cheaply where the filesystem allows. Times are kept,
 * because the comparison that follows treats a file whose size and mtime
 * have not moved as unchanged.
 */
export async function cloneFolder(from: string, to: string): Promise<void> {
  if (process.platform === "darwin") {
    try {
      // -c asks for clonefile(2): APFS shares the blocks until a write
      await run("/bin/cp", ["-c", "-R", "-p", from, to]);
      return;
    } catch {
      await rm(to, { recursive: true, force: true });
    }
  } else if (process.platform === "linux") {
    try {
      await run("cp", ["-R", "-p", "--reflink=auto", from, to]);
      return;
    } catch {
      await rm(to, { recursive: true, force: true });
    }
  }
  await cp(from, to, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
}

export class Rehearsals {
  private readonly root: string;
  private readonly file: string;
  private list: Rehearsal[] = [];

  constructor(root: string) {
    this.root = root;
    this.file = join(root, "index.json");
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8"));
      if (Array.isArray(parsed)) this.list = parsed;
    } catch {
      /* none yet */
    }
    // a rehearsal cannot still be running across a restart: its turn died
    for (const r of this.list) if (r.state === "running") r.state = "failed";
    this.save();
  }

  /** A clone of `dir` to rehearse in. The caller photographs `dir` first. */
  async open(input: { group?: string; botId: string; taskId: string; dir: string; text: string }): Promise<Rehearsal> {
    const id = newId();
    const home = join(this.root, id);
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const copy = join(home, "copy");
    await cloneFolder(input.dir, copy);
    const rehearsal: Rehearsal = {
      id,
      group: input.group ?? id,
      botId: input.botId,
      taskId: input.taskId,
      dir: input.dir,
      copy,
      text: input.text.slice(0, 2000),
      state: "running",
      at: Date.now(),
    };
    this.list.push(rehearsal);
    this.save();
    return rehearsal;
  }

  get(id: string) {
    return this.list.find((r) => r.id === id);
  }

  byTask(taskId: string) {
    return this.list.find((r) => r.taskId === taskId && r.state === "running");
  }

  /** The newest rehearsal a lane belongs to, whatever state it is in. */
  forTask(taskId: string) {
    for (let i = this.list.length - 1; i >= 0; i--) if (this.list[i].taskId === taskId) return this.list[i];
    return undefined;
  }

  byCheckpoint(checkpointId: string) {
    return this.list.find((r) => r.checkpointId === checkpointId);
  }

  inGroup(group: string) {
    return this.list.filter((r) => r.group === group);
  }

  all(): Rehearsal[] {
    return [...this.list].reverse();
  }

  update(id: string, patch: Partial<Rehearsal>) {
    const r = this.get(id);
    if (!r) return;
    Object.assign(r, patch);
    this.save();
  }

  /** Settles an attempt and removes its clone; nothing is left to apply. */
  async settle(id: string, state: "applied" | "discarded" | "failed"): Promise<void> {
    const r = this.get(id);
    if (!r) return;
    r.state = state;
    r.settledAt = Date.now();
    this.save();
    await rm(join(this.root, r.id), { recursive: true, force: true }).catch(() => {});
  }

  /** Clears clones left waiting too long, and forgets the oldest settled. */
  async sweep(now = Date.now()): Promise<void> {
    for (const r of this.list) {
      if ((r.state === "ready" || r.state === "empty") && now - r.at > STALE_MS) await this.settle(r.id, "discarded");
      // cut off by a restart: nothing will ever come of its copy
      else if (r.state === "failed" && !r.settledAt) await this.settle(r.id, "failed");
    }
    const settled = this.list.filter((r) => r.settledAt);
    if (settled.length > MAX_KEPT) {
      const drop = new Set(settled.slice(0, settled.length - MAX_KEPT).map((r) => r.id));
      this.list = this.list.filter((r) => !drop.has(r.id));
      this.save();
    }
  }

  private save() {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const temp = `${this.file}.tmp`;
    writeFileSync(temp, JSON.stringify(this.list));
    renameSync(temp, this.file);
  }

  exists(r: Rehearsal) {
    return existsSync(r.copy);
  }
}
