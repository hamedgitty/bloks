// Reasoning effort, as the pickers need it.
//
// The server owns the rule (server/effort.ts) and says on /api/instances
// which levels each engine takes; the desktop keeps its own copy of the
// names and of the few answers it shows, rather than reaching into the
// server's code. test/effort-levels.test.ts holds the two to the same
// answers.
//
// A picker offers the levels the agent's engine and model have. A saved
// level they do not have is shown as the one its turns are sent, with a
// line saying so, because that is what the agent is really doing.
import { t } from "./i18n.ts";

export type Effort = "off" | "low" | "medium" | "high" | "xhigh" | "max";

/** Every level, from the least thinking to the most. */
export const EFFORTS: readonly Effort[] = ["off", "low", "medium", "high", "xhigh", "max"];

/** Each level's name, read when it is drawn so it follows the language. */
export const EFFORT_LABELS: Readonly<Record<Effort, string>> = {
  get off() {
    return t("effort.off");
  },
  get low() {
    return t("effort.low");
  },
  get medium() {
    return t("effort.medium");
  },
  get high() {
    return t("effort.high");
  },
  get xhigh() {
    return t("effort.xhigh");
  },
  get max() {
    return t("effort.max");
  },
};

/** What a server from before the levels were per engine took for every
 * engine, for one that does not say. */
const BEFORE_LEVELS: readonly Effort[] = ["low", "medium", "high"];

export const isEffort = (value: unknown): value is Effort => EFFORTS.includes(value as Effort);

/** The same answer as clampEffort in server/effort.ts. */
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

/** One engine as /api/instances describes it, as far as effort goes. */
export interface EffortEngine {
  efforts?: readonly Effort[];
  models: { default: string; options: Array<{ id: string; label?: string; efforts?: Effort[] }> };
}

/** The same answer as effortLevels in server/effort.ts, from what the
 * server said about the engine. */
export function effortLevels(instance: EffortEngine | undefined, model?: string): Effort[] {
  const engine = instance?.efforts ?? (instance ? BEFORE_LEVELS : []);
  const selected = instance?.models.options.find((option) => option.id === (model || instance.models.default))
    ?? (model === "auto" ? instance?.models.options.find((option) => option.id === instance.models.default) : undefined);
  const own = selected?.efforts;
  return EFFORTS.filter((level) => engine.includes(level) && (!own || own.includes(level)));
}

/** A picker's choices: the engine's own, then each level it has. */
export function effortOptions(levels: readonly Effort[]): Array<{ value: Effort | undefined; label: string }> {
  return [{ value: undefined, label: t("effort.useEngineSetting") }, ...levels.map((value) => ({ value, label: EFFORT_LABELS[value] }))];
}

/**
 * What a picker says about the levels on offer, or null when there is
 * nothing to say: an engine with no dial, or a saved level its engine
 * does not have ("Saved as Max. Grok CLI has no Max, so it runs at
 * High."). `who` is the engine's name.
 */
export function effortNote(saved: unknown, levels: readonly Effort[], who: string): string | null {
  const label = isEffort(saved) ? EFFORT_LABELS[saved] : null;
  if (!levels.length) {
    return label ? t("effort.noSettingKept", { who, label }) : t("effort.noSetting", { who });
  }
  if (!label || levels.includes(saved as Effort)) return null;
  return t("effort.runsAt", { who, label, runs: EFFORT_LABELS[clampEffort(saved, levels)!] });
}

/**
 * Everything a picker needs for a selection and the level saved with it:
 * the levels to offer, the one to show as chosen (the one turns are
 * sent), and the line about it. An engine the list does not have, yet or
 * any more, is not narrowed here; the server says so if it minds.
 */
export function effortChoice(
  instances: ReadonlyArray<EffortEngine & { instanceId: string; displayName: string }>,
  selection: { instanceId: string; model: string } | null | undefined,
  saved: unknown,
) {
  const engine = selection ? instances.find((instance) => instance.instanceId === selection.instanceId) : undefined;
  const levels = engine ? effortLevels(engine, selection?.model) : [...EFFORTS];
  // a model with levels of its own is the one that lacks the saved level
  const model = engine?.models.options.find((option) => option.id === (selection?.model || engine.models.default))
    ?? (selection?.model === "auto" ? engine?.models.options.find((option) => option.id === engine.models.default) : undefined);
  const who = model?.efforts && model.label ? model.label : engine?.displayName;
  return {
    levels,
    value: clampEffort(saved, levels),
    options: effortOptions(levels),
    note: who ? effortNote(saved, levels, who) : null,
  };
}
