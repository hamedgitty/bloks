// Bring your setup, the parts of the review that are not drawing: how
// items group by what they become, and what one choice sends back.
//
// The server reads every file again on import and takes from the window
// only which items, where, how a clash is settled and the values the
// person typed or said to copy (server/setup-import.ts). So what is
// built here is a list of decisions, never content.
//
// The lines the review says are said in the reader's language; the
// items' own titles and previews are the files' words and stay as read.
import { t, type MessageKey } from "./i18n.ts";

export type SetupKind = "agent" | "instructions" | "memory" | "skill" | "mcp" | "setting" | "rule" | "fact" | "channel" | "files" | "routine";
export type SetupDestination = "agent" | "brief" | "memory" | "skills" | "mcp" | "engine" | "rules" | "about" | "channel" | "files" | "routine";

export interface SecretSlot {
  id: string;
  name: string;
  where: "env" | "header" | "token";
  copyFrom?: string;
  ref?: string;
  required?: boolean;
}

export interface SetupItem {
  key: string;
  source: string;
  kind: SetupKind;
  title: string;
  from: string;
  preview: string;
  chars: number;
  digest: string;
  notes: string[];
  status: "new" | "changed" | "imported";
  destinations: SetupDestination[];
  suggested: { to: SetupDestination; botId?: string };
  picked: boolean;
  conflict?: { kind: "skill" | "agent" | "mcp"; name: string; canReplace: boolean };
  secrets?: SecretSlot[];
  sameAs?: string;
  skill?: { name: string; description: string };
  mcp?: { name: string; transport: "stdio" | "http"; needs: string[] };
  rule?: { effect: "allow" | "deny"; summary: string };
  agent?: { name: string; title: string; model?: string; skills: string[]; servers: string[]; refuses: string[]; photo?: string };
  setting?: { engine: string; engineName: string; model?: string; effort?: string };
  channel?: { platform: string; name: string; perAgent: boolean };
  files?: { count: number; bytes: number };
  routine?: { summary: string; scheduled: boolean };
  /** The agent it came with, in a tool whose agents bring their own
   * parts; `here` when an earlier import of it is still here. */
  owner?: { key: string; name: string; here?: boolean };
}

export interface SetupSource {
  id: string;
  name: string;
  folder: string;
  agentName: string;
  items: SetupItem[];
  skipped: Array<{ from: string; why: string }>;
}

export interface SetupRun {
  id: string;
  at: number;
  items: number;
}

/** An OpenBot transfer file the server is reading, as it says it. */
export interface SetupTransfer {
  name: string;
  bytes: number;
  at: number;
}

export interface SetupReview {
  sources: SetupSource[];
  fresh: number;
  /** The newest import that can still be undone. Absent from an older server. */
  lastRun?: SetupRun | null;
  /** The transfer file being read, if one was picked. Absent from an older server. */
  transfer?: SetupTransfer | null;
}

/** What the person has chosen for one item. */
export interface Choice {
  on: boolean;
  to: SetupDestination;
  botId?: string;
  /** For an item whose name is taken. */
  conflict?: "both" | "replace";
  /** By slot: what they typed, and whether they said to copy the other tool's. */
  typed?: Record<string, string>;
  copy?: Record<string, boolean>;
}

/** The groups, in the order a person would set things up by hand: who
 * the agents are, what they know and keep, what they can use, when they
 * work on their own, what they may do, what they know about you, and
 * where they can be reached. */
export const GROUPS: Array<{ id: string; label: MessageKey; kinds: SetupKind[] }> = [
  { id: "agents", label: "setupReview.group.agents", kinds: ["agent"] },
  { id: "knowledge", label: "setupReview.group.knowledge", kinds: ["instructions", "memory"] },
  { id: "files", label: "setupReview.group.files", kinds: ["files"] },
  { id: "skills", label: "setupReview.group.skills", kinds: ["skill"] },
  { id: "servers", label: "setupReview.group.servers", kinds: ["mcp"] },
  { id: "models", label: "setupReview.group.models", kinds: ["setting"] },
  { id: "routines", label: "setupReview.group.routines", kinds: ["routine"] },
  { id: "rules", label: "setupReview.group.rules", kinds: ["rule"] },
  { id: "about", label: "setupReview.group.about", kinds: ["fact"] },
  { id: "chat", label: "setupReview.group.chat", kinds: ["channel"] },
];

export interface Group {
  id: string;
  label: string;
  entries: Array<{ item: SetupItem; source: SetupSource }>;
}

/** Every item, grouped by what it becomes, each group in source order.
 * Groups with nothing in them are left out. A group's label is read as
 * it is drawn, so a grouping kept from before a change of language
 * still says the new one. */
export function groupReview(review: SetupReview): Group[] {
  return GROUPS.map((group) => ({
    id: group.id,
    get label() {
      return t(group.label);
    },
    entries: review.sources.flatMap((source) => source.items.filter((item) => group.kinds.includes(item.kind)).map((item) => ({ item, source }))),
  })).filter((group) => group.entries.length > 0);
}

export function choicesFrom(review: SetupReview): Record<string, Choice> {
  const out: Record<string, Choice> = {};
  for (const source of review.sources) {
    for (const item of source.items) {
      out[item.key] = {
        on: item.picked,
        to: item.suggested.to,
        botId: item.suggested.botId,
        // never over somebody else's thing unless they say so
        ...(item.conflict ? { conflict: "both" as const } : {}),
      };
    }
  }
  return out;
}

/** A slot a ticked item cannot go without and that has no answer yet. */
export function missingSecrets(item: SetupItem, choice: Choice): SecretSlot[] {
  return (item.secrets ?? []).filter((slot) => slot.required && !choice.copy?.[slot.id] && !choice.typed?.[slot.id]?.trim());
}

/**
 * The agent a ticked part goes with, by name, when that agent is neither
 * ticked nor brought over before: the import would refuse the part, so
 * the window says so first. Null when there is nothing to say.
 */
export function ownerMissing(item: SetupItem, choice: Choice, choices: Record<string, Choice>): string | null {
  if (!choice.on || choice.botId !== "owner" || !item.owner || item.owner.here) return null;
  return choices[item.owner.key]?.on ? null : item.owner.name;
}

/** What the window sends for one ticked item. A typed value goes only
 * when it has something in it; a copy only when its box was ticked. */
export function pickFor(item: SetupItem, choice: Choice) {
  const secrets: Record<string, { copy: true } | { value: string }> = {};
  for (const slot of item.secrets ?? []) {
    if (choice.copy?.[slot.id] && slot.copyFrom) secrets[slot.id] = { copy: true };
    else if (choice.typed?.[slot.id]?.trim()) secrets[slot.id] = { value: choice.typed[slot.id].trim() };
  }
  return {
    key: item.key,
    digest: item.digest,
    to: choice.to,
    ...(choice.botId ? { botId: choice.botId } : {}),
    ...(item.conflict && choice.conflict ? { conflict: choice.conflict } : {}),
    ...(Object.keys(secrets).length ? { secrets } : {}),
  };
}

/** The line a clash is introduced with. */
export function conflictLine(item: SetupItem): string {
  const c = item.conflict;
  if (!c) return "";
  const key = c.kind === "skill" ? "setupReview.conflict.skill" : c.kind === "agent" ? "setupReview.conflict.agent" : "setupReview.conflict.mcp";
  return t(key, { name: c.name });
}

/** Where a ticked item ends up, in a line, for the kinds with nothing to choose. */
export function landingLine(item: SetupItem): string {
  switch (item.kind) {
    case "skill":
      return t("setupReview.landing.skill");
    case "mcp":
      return t("setupReview.landing.mcp");
    case "rule":
      return t("setupReview.landing.rule", { rule: item.rule?.summary ?? item.preview });
    case "fact":
      return t("setupReview.landing.fact");
    case "agent": {
      const a = item.agent;
      const skills = a?.skills.length ?? 0;
      if (a?.model && skills) return t("setupReview.landing.agentModelSkills", { model: a.model, count: skills });
      if (a?.model) return t("setupReview.landing.agentModel", { model: a.model });
      if (skills) return t("setupReview.landing.agentSkills", { count: skills });
      return t("setupReview.landing.agent");
    }
    case "channel":
      if (item.channel?.perAgent) return "";
      return item.channel?.name ? t("setupReview.landing.channel", { name: item.channel.name }) : t("setupReview.landing.channelUnnamed");
    default:
      return "";
  }
}
