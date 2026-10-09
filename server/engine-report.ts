// Engine scout: which engine does your work well, and which does it for
// less.
//
// Every benchmark measures somebody else's tasks. Bloks sees yours, and
// sees something no benchmark can: what you did with the result. A turn
// whose changes you undid, a conversation you rewound past it, a
// rehearsal you discarded rather than applied, a turn that failed. What
// was left alone was, as far as anyone can tell, kept.
//
// So each finished turn is logged with the engine and model that ran it,
// and when the report is read its outcome is worked out from the records
// that already exist (the checkpoint's undo, apply and discard marks, and
// rewound messages). From that: how often each engine's work is kept,
// how much it costs where the provider says, and for an agent that has
// used more than one, whether a lighter model has been doing as well.
//
// Nothing here leaves the machine, and nothing switches on its own: a
// suggestion is a sentence with a button.
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { readSaved } from "./atomic-write.ts";

export interface TurnLog {
  id: string;
  at: number;
  startedAt: number;
  botId: string;
  laneId: string;
  instanceId: string;
  model: string;
  ok: boolean;
  /** The engine ran out (a limit, credit, an outage): not its quality. */
  out?: boolean;
  input: number;
  output: number;
  cost: number | null;
  checkpointId?: string;
}

export type Outcome = "kept" | "undone" | "rewound" | "discarded" | "failed" | "out";

export const MAX_TURNS = 3_000;
/** Fewer turns than this on either side, and no suggestion is made. */
export const ENOUGH = 8;
/** How close, in kept percentage points, counts as "as well". */
export const CLOSE = 5;

export class TurnLogStore {
  private turns: TurnLog[] = [];
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
    this.turns = readSaved<TurnLog[]>(file, [], Array.isArray);
  }

  private save() {
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      const temp = `${this.file}.tmp`;
      writeFileSync(temp, JSON.stringify(this.turns), { mode: 0o600 });
      renameSync(temp, this.file);
    } catch {
      /* a report is a convenience */
    }
  }

  add(turn: TurnLog) {
    this.turns.push(turn);
    if (this.turns.length > MAX_TURNS) this.turns.splice(0, this.turns.length - MAX_TURNS);
    this.save();
  }

  /** The checkpoint a turn's changes card points at, once it exists. */
  attachCheckpoint(turnId: string, checkpointId: string) {
    const turn = this.turns.find((t) => t.id === turnId);
    if (!turn) return;
    turn.checkpointId = checkpointId;
    this.save();
  }

  all(): TurnLog[] {
    return this.turns;
  }

  forgetBot(botId: string) {
    const before = this.turns.length;
    this.turns = this.turns.filter((t) => t.botId !== botId);
    if (this.turns.length !== before) this.save();
  }
}

// ── how heavy a model is ───────────────────────────────────────────────

/** Families, lightest first. A model is placed by the first word of its
 * family that its id contains; unknown models are not ranked, and so are
 * never suggested as a lighter choice. */
const LADDERS: string[][] = [
  ["haiku", "sonnet", "opus", "fable"],
  ["luna", "terra", "sol", "astra"],
  ["flash-lite", "flash", "pro"],
  ["nano", "mini", "gpt"],
  ["small", "medium", "large"],
  ["fast", "grok"],
];

/** [family, rank] or null. Higher rank is heavier. */
export function weightOf(model: string): [number, number] | null {
  const id = model.toLowerCase();
  for (let family = 0; family < LADDERS.length; family++) {
    const ladder = LADDERS[family];
    // longest words first, so "flash-lite" is not read as "flash"
    const order = [...ladder].sort((a, b) => b.length - a.length);
    const word = order.find((w) => id.includes(w));
    if (word) return [family, ladder.indexOf(word)];
  }
  return null;
}

/** Whether `a` is a lighter model than `b` in the same family. */
export function lighter(a: string, b: string): boolean {
  const wa = weightOf(a);
  const wb = weightOf(b);
  return Boolean(wa && wb && wa[0] === wb[0] && wa[1] < wb[1]);
}

// ── the report ─────────────────────────────────────────────────────────

export interface EngineRow {
  key: string;
  instanceId: string;
  model: string;
  label: string;
  turns: number;
  kept: number;
  undone: number;
  rewound: number;
  discarded: number;
  failed: number;
  out: number;
  /** Of the turns that say anything about quality (not `out`). */
  keptRate: number | null;
  tokensPerTurn: number;
  /** USD over the turns whose provider reported a price. */
  cost: number;
  costTurns: number;
}

export interface Suggestion {
  botId: string;
  from: { instanceId: string; model: string; label: string; keptRate: number; turns: number };
  to: { instanceId: string; model: string; label: string; keptRate: number; turns: number };
  /** USD a turn, where both sides report a price. */
  saves?: number;
  why: string;
}

export interface Report {
  engines: EngineRow[];
  agents: Array<{ botId: string; engines: EngineRow[] }>;
  suggestions: Suggestion[];
  turns: number;
}

function rows(turns: TurnLog[], outcomeOf: (t: TurnLog) => Outcome, labelOf: (instanceId: string, model: string) => string): EngineRow[] {
  const by = new Map<string, EngineRow & { tokens: number }>();
  for (const t of turns) {
    const key = `${t.instanceId}|${t.model}`;
    const row =
      by.get(key) ??
      ({
        key,
        instanceId: t.instanceId,
        model: t.model,
        label: labelOf(t.instanceId, t.model),
        turns: 0,
        kept: 0,
        undone: 0,
        rewound: 0,
        discarded: 0,
        failed: 0,
        out: 0,
        keptRate: null,
        tokensPerTurn: 0,
        cost: 0,
        costTurns: 0,
        tokens: 0,
      } as EngineRow & { tokens: number });
    row.turns++;
    row[outcomeOf(t)]++;
    row.tokens += t.input + t.output;
    if (t.cost !== null && Number.isFinite(t.cost)) {
      row.cost += t.cost;
      row.costTurns++;
    }
    by.set(key, row);
  }
  return [...by.values()]
    .map(({ tokens, ...row }) => {
      const judged = row.turns - row.out;
      return {
        ...row,
        keptRate: judged > 0 ? Math.round((row.kept / judged) * 100) : null,
        tokensPerTurn: row.turns ? Math.round(tokens / row.turns) : 0,
      };
    })
    .sort((a, b) => b.turns - a.turns);
}

export function engineReport(
  turns: TurnLog[],
  outcomeOf: (t: TurnLog) => Outcome,
  labelOf: (instanceId: string, model: string) => string,
  current: (botId: string) => { instanceId: string; model: string } | null,
): Report {
  const engines = rows(turns, outcomeOf, labelOf);
  const byBot = new Map<string, TurnLog[]>();
  for (const t of turns) byBot.set(t.botId, [...(byBot.get(t.botId) ?? []), t]);
  const agents = [...byBot.entries()].map(([botId, list]) => ({ botId, engines: rows(list, outcomeOf, labelOf) }));

  const suggestions: Suggestion[] = [];
  for (const agent of agents) {
    const now = current(agent.botId);
    if (!now) continue;
    const mine = agent.engines.find((e) => e.instanceId === now.instanceId && e.model === now.model);
    if (!mine || mine.keptRate === null || mine.turns - mine.out < ENOUGH) continue;
    const better = agent.engines
      .filter(
        (e) =>
          e !== mine &&
          e.keptRate !== null &&
          e.turns - e.out >= ENOUGH &&
          e.keptRate >= mine.keptRate! - CLOSE &&
          lighter(e.model, mine.model),
      )
      .sort((a, b) => b.keptRate! - a.keptRate!)[0];
    if (!better) continue;
    const perTurn = (e: EngineRow) => (e.costTurns ? e.cost / e.costTurns : null);
    const a = perTurn(mine);
    const b = perTurn(better);
    const saves = a !== null && b !== null && a > b ? Math.round((a - b) * 1000) / 1000 : undefined;
    suggestions.push({
      botId: agent.botId,
      from: { instanceId: mine.instanceId, model: mine.model, label: mine.label, keptRate: mine.keptRate!, turns: mine.turns },
      to: { instanceId: better.instanceId, model: better.model, label: better.label, keptRate: better.keptRate!, turns: better.turns },
      ...(saves ? { saves } : {}),
      why: `You kept ${better.keptRate}% of ${better.label}'s work and ${mine.keptRate}% of ${mine.label}'s, and ${better.label} is the lighter model.`,
    });
  }
  return { engines, agents, suggestions, turns: turns.length };
}
