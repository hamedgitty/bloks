// Safe observations over already-loaded settings. No stores, providers or IO.
import { agentTurnLimit } from "./agent-chain.ts";

export type InspectionScalar = string | number | boolean | null;
export type InspectionValue =
  | { status: "value"; value: InspectionScalar }
  | { status: "policy"; policy: string }
  | { status: "unknown"; reason: string }
  | { status: "values"; values: InspectionScalar[] }
  | { status: "absent" }
  | { status: "configured"; configured: boolean }
  | { status: "omitted"; reason: "size_limit" }
  | { status: "unsupported"; reason: "invalid_value" };

export interface InspectionField {
  id: string;
  scope: "workspace" | "agent" | "room" | "automation" | "project" | "skill";
  control: string;
  saved: InspectionValue;
  effective: InspectionValue;
}

export const INSPECTION_TEXT_CHARS = 256;
export const WORKSPACE_INSPECTION_BYTES = 16_384;

// Missing and malformed owner values are distinct. Never invoke a getter or
// follow inherited keys when projecting an object supplied by another owner.
export function ownAt(root: unknown, section: string, field: string): { present: boolean; value: unknown } {
  if (!root || typeof root !== "object" || Array.isArray(root)) return { present: false, value: undefined };
  const parent = Object.getOwnPropertyDescriptor(root, section);
  if (!parent || !("value" in parent) || !parent.value || typeof parent.value !== "object" || Array.isArray(parent.value)) {
    return { present: false, value: undefined };
  }
  const leaf = Object.getOwnPropertyDescriptor(parent.value, field);
  return leaf ? { present: true, value: "value" in leaf ? leaf.value : undefined } : { present: false, value: undefined };
}

export function scalar(value: unknown, redact: (text: string) => string): InspectionValue {
  if (value === null || typeof value === "boolean") return { status: "value", value };
  if (typeof value === "number" && Number.isFinite(value)) return { status: "value", value };
  if (typeof value !== "string") return { status: "unsupported", reason: "invalid_value" };
  // Omit oversized values whole, never cut through a protected value.
  if (Array.from(value).length > INSPECTION_TEXT_CHARS) return { status: "omitted", reason: "size_limit" };
  try {
    const safe = redact(value);
    if (typeof safe !== "string") return { status: "unsupported", reason: "invalid_value" };
    return Array.from(safe).length > INSPECTION_TEXT_CHARS
      ? { status: "omitted", reason: "size_limit" }
      : { status: "value", value: safe };
  } catch {
    return { status: "unsupported", reason: "invalid_value" };
  }
}

export interface WorkspaceInspectionInput {
  // Raw saved values are used only to distinguish what was saved. Runtime
  // values have already passed the owner's environment/legacy precedence.
  saved: unknown;
  runtime: unknown;
  resolved: { beforeTurn: number; beforeTurnAt: number; stallMinutes: number };
  redact: (text: string) => string;
}

/** First projection slice: workspace behavior, profile and credential status.
 * Other families, authenticated routing, continuation and devices are separate
 * integration work. This function does not claim complete settings coverage. */
export function inspectWorkspaceSettings(input: WorkspaceInspectionInput): InspectionField[] {
  const fields: InspectionField[] = [];
  const add = (section: string, key: string, control: string, effective: unknown, credential = false) => {
    const stored = ownAt(input.saved, section, key);
    fields.push({
      id: `${section}.${key}`,
      scope: "workspace",
      control,
      saved: !stored.present ? { status: "absent" } : credential
        ? { status: "configured", configured: Boolean(stored.value) }
        : scalar(stored.value, input.redact),
      effective: credential ? { status: "configured", configured: Boolean(effective) } : scalar(effective, input.redact),
    });
  };
  const value = (section: string, key: string) => ownAt(input.runtime, section, key).value;
  const general = "Settings > General > Working with agents";
  add("compaction", "micro", general, Boolean(value("compaction", "micro")));
  add("compaction", "idle", general, Boolean(value("compaction", "idle")));
  add("compaction", "beforeTurn", general, input.resolved.beforeTurn);
  add("compaction", "beforeTurnAt", "config.json > compaction.beforeTurnAt", input.resolved.beforeTurnAt);
  add("turns", "stallMinutes", general, input.resolved.stallMinutes);
  add("recall", "beforeTurn", general, value("recall", "beforeTurn") !== false);
  add("agents", "turnLimit", general, agentTurnLimit(value("agents", "turnLimit")));
  add("skills", "propose", general, Boolean(value("skills", "propose")));
  add("changes", "showShared", general, value("changes", "showShared") !== false);
  add("shortcuts", "quickAsk", "Settings > General > Quick ask shortcut", value("shortcuts", "quickAsk") ?? null);
  add("profile", "about", "Settings > About you", value("profile", "about") ?? "");
  const name = value("profile", "name");
  add("profile", "name", "Shared room > Your name", typeof name === "string" ? name.trim() || "The owner" : "The owner");
  for (const [section, key, control] of [
    ["composio", "key", "Settings > Apps and keys > Connect key"],
    ["composio", "apiKey", "Settings > Apps and keys > Project key"],
    ["speech", "elevenlabsKey", "Settings > Voices > Keys"],
    ["speech", "openaiKey", "Settings > Voices > Keys"],
    ["box", "token", "Settings > Apps and keys > Boat API key"],
  ] as const) add(section, key, control, value(section, key), true);
  // Finite fields and whole-value string bounds keep this slice bounded.
  return fields;
}
