// Reasoning effort: how hard an agent's engine thinks before it answers.
//
// The levels are the engines' own words, from the least thinking to the
// most. Not every engine takes every level, and some take none: each
// driver says which it forwards (ProviderAdapter.capabilities.efforts),
// and an engine that lists its models with levels of their own (Codex's
// model/list) narrows that per model. An engine with no list has no dial,
// and its turns are sent no effort at all.
//
// An agent keeps the level it was given when it moves to an engine that
// does not have it, so moving back brings it back. A turn is sent the
// nearest level its engine has instead, never a level the engine would
// refuse, and the pickers show that level rather than the saved one.
//
// Settings, hiring and dispatch share these. No provider calls. The
// desktop keeps its own copy of the pure parts (src/lib/effort.ts), held
// to the same answers by test/effort-levels.test.ts.
import type { ModelCatalog } from "./contracts.ts";

export type Effort = "none" | "low" | "medium" | "high" | "xhigh" | "max";

/** Every level Bloks knows, from the least thinking to the most. */
export const EFFORTS: readonly Effort[] = ["none", "low", "medium", "high", "xhigh", "max"];

export const EFFORT_LABELS: Record<Effort, string> = {
  none: "No thinking",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

export const isEffort = (value: unknown): value is Effort => EFFORTS.includes(value as Effort);

/** Known levels out of an engine's own list, in Bloks's order. Anything
 * else the engine offers (Codex's "ultra", an older "minimal") is left
 * out rather than guessed at. */
export function knownEfforts(values: readonly unknown[]): Effort[] {
  return EFFORTS.filter((level) => values.includes(level));
}

/**
 * The level a turn is sent when the agent asked for `wanted` and its
 * engine takes `levels`: the same one when it is there, else the nearest,
 * and between two equally near the lower, so a turn never thinks harder
 * than it was asked to. Nothing when nothing was asked for or the engine
 * has no dial.
 */
export function clampEffort(wanted: unknown, levels: readonly Effort[] | undefined): Effort | undefined {
  if (!isEffort(wanted) || !levels?.length) return undefined;
  if (levels.includes(wanted)) return wanted;
  const at = EFFORTS.indexOf(wanted);
  let nearest: Effort | undefined;
  for (const level of EFFORTS) {
    if (!levels.includes(level)) continue;
    if (nearest === undefined || Math.abs(EFFORTS.indexOf(level) - at) < Math.abs(EFFORTS.indexOf(nearest) - at)) nearest = level;
  }
  return nearest;
}

/** What effortLevels reads from an engine: the levels its driver
 * forwards, and its catalog, whose models may narrow them. */
export interface EffortEngine {
  displayName?: string;
  driverKind?: string;
  adapter: { capabilities: { efforts?: readonly Effort[] } };
  models: Pick<ModelCatalog, "default" | "options">;
}

/** The levels a turn on this engine and model can be sent. A model the
 * engine listed with levels of its own has those, as far as the driver
 * forwards them; any other model has the engine's. Empty for an engine
 * with no dial, or one that is not here. */
export function effortLevels(instance: EffortEngine | null | undefined, model?: string): Effort[] {
  const engine = instance?.adapter.capabilities.efforts ?? [];
  const selected = instance?.models.options.find((option) => option.id === (model || instance.models.default))
    ?? (model === "auto" ? instance?.models.options.find((option) => option.id === instance.models.default) : undefined);
  const own = selected?.efforts;
  return EFFORTS.filter((level) => engine.includes(level) && (!own || own.includes(level)));
}

/** "low, medium or high". */
function either(levels: readonly string[]): string {
  return levels.length > 1 ? `${levels.slice(0, -1).join(", ")} or ${levels.at(-1)}` : (levels[0] ?? "");
}

export const EFFORT_SHAPE = `effort is ${either(EFFORTS)}`;

/**
 * Why an agent on this engine and model cannot be given `wanted`, said
 * for the person or the agent who asked, or null when it can. Only a
 * level being chosen is judged here: one already saved stays saved when
 * the agent moves, and dispatch sends the nearest level instead.
 *
 * An engine with no dial does nothing with any level, as it never has,
 * so whatever level it is given is kept for an engine that has one; the
 * pickers do not offer it there and say why. Refusing it would only
 * break a client that offers the dial everywhere, as every one did.
 */
export function effortRefusal(wanted: unknown, instance: EffortEngine | null | undefined, model?: string): string | null {
  if (!isEffort(wanted)) return EFFORT_SHAPE;
  // an engine that is not here cannot be asked, and its turns go nowhere
  if (!instance?.adapter.capabilities.efforts?.length) return null;
  const levels = effortLevels(instance, model);
  if (levels.includes(wanted)) return null;
  const name = instance.displayName ?? instance.driverKind ?? "This engine";
  const on = model || instance.models.default;
  if (!levels.length) return `${name} takes no reasoning effort on ${on}`;
  // the model is named when it, not the engine, has fewer
  const narrowed = levels.length < instance.adapter.capabilities.efforts.length;
  return `${name} takes effort ${either(levels)}${narrowed ? ` on ${on}` : ""}, not ${wanted}`;
}
