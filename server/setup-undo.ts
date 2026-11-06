// Taking an import back.
//
// Bringing a setup over writes in a dozen places at once: agents, their
// memory and pictures, files in their workspaces, the skill library, the
// server list, routines, rules, About you, a chat app. Getting one of those wrong should not mean finding and undoing
// each by hand, so every import keeps what it changed, a step at a time
// (server/setup-import.ts, UndoStep), and an undo walks them back,
// newest first.
//
// Each step goes back only if what is there is still what the import
// left. Something the person has changed since is theirs now: the undo
// says so for that step and carries on with the rest, the same rule the
// memory journal keeps for a night's tidy. An agent made by the import
// and talked to since is kept, for the same reason.
//
// Nothing here is a secret. A chat app's connection is known by a hash of
// its token, and a server's earlier shape is kept with its values blank.
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { isRecord, readSaved, writeFileAtomic } from "./atomic-write.ts";
import { bytesHash, type ImportDeps, type ImportOutcome, type ImportRecord, type McpEntry, type RecordEntry, type UndoStep } from "./setup-import.ts";

/** Imports kept for undoing. Older ones age out: by then what they added
 * has long been the person's own. */
export const MAX_RUNS = 20;

export interface ImportRun {
  id: string;
  at: number;
  /** How many items came over, for the line that offers the undo. */
  items: number;
  steps: UndoStep[];
  records: Array<{ key: string; before: RecordEntry | null }>;
  undoneAt?: number;
}

export interface UndoResult {
  undone: Array<{ key: string; title: string }>;
  kept: Array<{ key: string; title: string; why: string }>;
  /** What changed, so the caller can tell open windows. */
  touched: {
    agents: Set<string>;
    archived: Set<string>;
    memory: Set<string>;
    skills: boolean;
    mcp: boolean;
    rules: boolean;
    notes: boolean;
    channels: boolean;
    routines: boolean;
  };
}

/** The imports, newest last, in one small file beside the workspace. */
export class ImportRuns {
  private readonly file: string;
  private runs: ImportRun[];

  constructor(file: string) {
    this.file = file;
    const saved = readSaved<unknown[]>(file, [], Array.isArray);
    this.runs = saved.filter(
      (r): r is ImportRun => isRecord(r) && typeof r.id === "string" && typeof r.at === "number" && Array.isArray(r.steps) && Array.isArray(r.records),
    );
  }

  /** Keeps an import that changed something. One that changed nothing is
   * nothing to undo, and is not kept. */
  add(outcome: ImportOutcome, at: number): ImportRun | null {
    if (!outcome.steps.length) return null;
    const run: ImportRun = {
      id: randomUUID(),
      at,
      items: outcome.results.filter((r) => r.ok && r.did !== "unchanged").length,
      steps: outcome.steps,
      records: outcome.records,
    };
    this.runs = [...this.runs, run].slice(-MAX_RUNS);
    this.save();
    return run;
  }

  get(id: string): ImportRun | undefined {
    return this.runs.find((r) => r.id === id);
  }

  /** The newest import not yet undone, which is the one the page offers. */
  latest(): ImportRun | undefined {
    return [...this.runs].reverse().find((r) => !r.undoneAt);
  }

  markUndone(id: string, at: number) {
    const run = this.get(id);
    if (!run) return;
    run.undoneAt = at;
    this.save();
  }

  private save() {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    writeFileAtomic(this.file, JSON.stringify(this.runs, null, 2), 0o600);
  }
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** Takes every step of one import back that can still go back, newest
 * first, and puts the record of what came from where as it was. */
export function undoRun(run: ImportRun, deps: ImportDeps, record: ImportRecord): UndoResult {
  const result: UndoResult = {
    undone: [],
    kept: [],
    touched: { agents: new Set(), archived: new Set(), memory: new Set(), skills: false, mcp: false, rules: false, notes: false, channels: false, routines: false },
  };
  const keep = (step: UndoStep, why: string) => result.kept.push({ key: step.key, title: step.title, why });
  const done = (step: UndoStep) => result.undone.push({ key: step.key, title: step.title });
  // keys any step of which stayed, so the record keeps saying they came over
  const stayed = new Set<string>();

  for (const step of [...run.steps].reverse()) {
    try {
      const why = undoStep(step, deps, result);
      if (why) {
        keep(step, why);
        stayed.add(step.key);
      } else done(step);
    } catch (error) {
      keep(step, error instanceof Error ? error.message : String(error));
      stayed.add(step.key);
    }
  }

  // The record goes back to what it said before this import, for every
  // item that went back whole and that no later import has touched since.
  for (const { key, before } of run.records) {
    if (stayed.has(key)) continue;
    const now = record.get(key);
    if (now && now.at !== run.at) continue;
    if (before) record.set(key, before);
    else record.delete(key);
  }
  return result;
}

/** One step back, or why it stays. */
function undoStep(step: UndoStep, deps: ImportDeps, result: UndoResult): string | null {
  switch (step.kind) {
    case "agent-created": {
      const outcome = deps.retireAgent(step.botId);
      if (outcome === "talked") return `you have talked with ${step.name} since, so it stays. Archive it yourself if you want it gone.`;
      if (outcome === "archived") result.touched.archived.add(step.botId);
      return null;
    }
    case "agent-patched": {
      const now = deps.agentSettings(step.botId);
      if (!now) return null;
      if (JSON.stringify(now) !== JSON.stringify(step.after)) return `${step.name} has changed since, so it was left as it is.`;
      deps.patchAgent(step.botId, step.before);
      result.touched.agents.add(step.botId);
      return null;
    }
    case "brief": {
      const bot = deps.agent(step.botId);
      if (!bot) return null;
      if (bot.description !== step.after) return `${bot.name}'s instructions have changed since, so they were left as they are.`;
      deps.setInstructions(step.botId, step.before);
      result.touched.agents.add(step.botId);
      return null;
    }
    case "memory": {
      const bot = deps.agent(step.botId);
      if (!bot) return null;
      if (bot.busy) return `${bot.name} is working right now. Undo again once it has finished.`;
      const now = deps.readMemory(step.botId, step.file);
      if (now !== step.after) return `${step.file} has changed since, so it was left as it is.`;
      // through the journal, as the import was: the Memory place shows it
      deps.writeMemory(step.botId, step.file, now, step.before ?? "");
      result.touched.memory.add(step.botId);
      return null;
    }
    case "skill-added": {
      const now = deps.skill(step.id);
      if (!now || now.source !== "user") return null;
      if (sha256(now.body) !== step.body) return "the skill has been edited since, so it was kept.";
      deps.removeSkill(step.id);
      result.touched.skills = true;
      return null;
    }
    case "skill-replaced": {
      const now = deps.skill(step.id);
      if (now && sha256(now.body) !== step.body) return "the skill has been edited since, so it was kept.";
      deps.installSkill({ id: step.id, ...step.before });
      result.touched.skills = true;
      return null;
    }
    case "mcp-added": {
      const list = deps.mcpServers();
      if (!list.some((s) => s.id === step.id)) return null;
      deps.saveMcpServers(list.filter((s) => s.id !== step.id));
      result.touched.mcp = true;
      return null;
    }
    case "mcp-updated": {
      const list = deps.mcpServers();
      const now = list.find((s) => s.id === step.id);
      if (!now) return null;
      // its earlier shape, with whatever values the person has filled in
      // since for the names it had then
      const keepValues = (names?: Record<string, string>, had?: Record<string, string>) =>
        names ? Object.fromEntries(Object.keys(names).map((n) => [n, had?.[n] ?? ""])) : undefined;
      const back: McpEntry = {
        ...step.before,
        ...(step.before.env ? { env: keepValues(step.before.env, now.env) } : {}),
        ...(step.before.headers ? { headers: keepValues(step.before.headers, now.headers) } : {}),
      };
      deps.saveMcpServers(list.map((s) => (s.id === step.id ? back : s)));
      result.touched.mcp = true;
      return null;
    }
    case "rule-added": {
      if (deps.removeRule(step.id)) result.touched.rules = true;
      return null;
    }
    case "note-added": {
      const note = deps.notes().find((n) => n.id === step.id);
      if (!note) return null;
      if (note.state !== "suggested") return "you kept it in About you, so it stays.";
      if (deps.removeNote(step.id)) result.touched.notes = true;
      return null;
    }
    case "channel": {
      const now = deps.channel(step.platform, step.botId);
      if (!now) return null;
      if (now.tokenHash !== step.tokenHash) return "its token has changed since, so the connection was kept.";
      deps.disconnectChannel(step.platform, step.botId);
      result.touched.channels = true;
      return null;
    }
    case "avatar-set": {
      if (!deps.agent(step.botId)) return null;
      if (deps.avatarHash(step.botId) !== step.hash) return `${step.name} has another picture since, so it was kept.`;
      deps.clearAvatar(step.botId);
      result.touched.agents.add(step.botId);
      return null;
    }
    case "files-added": {
      // each file goes only while it is still what was copied; one the
      // person has changed is theirs, and the rest still go
      if (!deps.agent(step.botId)) return null;
      let kept = 0;
      for (const file of step.files) {
        const now = deps.readWorkspaceFile(step.botId, file.path);
        if (!now) continue;
        if (bytesHash(now) !== file.hash) kept++;
        else deps.removeWorkspaceFile(step.botId, file.path);
      }
      result.touched.agents.add(step.botId);
      return kept ? `${kept} of its files ${kept === 1 ? "has" : "have"} changed since, so ${kept === 1 ? "it was" : "they were"} kept.` : null;
    }
    case "routine-added": {
      const now = deps.routine(step.id);
      if (!now) return null;
      if (now.enabled) return "you switched it on since, so it stays.";
      if (deps.removeRoutine(step.id)) result.touched.routines = true;
      return null;
    }
  }
}
