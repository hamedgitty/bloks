// An agent's settings as the people in a workspace change them: the owner
// looking after an agent a member made, an admin any agent, a member the
// agents they made (server/access.ts, mayChangeSettings; the route is
// agentSettingsRoute in server/index.ts). The owner's own agents keep the
// whole settings page; this is the part people share.
//
// The server says what each person may not widen, and why; this file
// turns that into what the dialog offers, and works out what changed, so
// the rules can be tested without a window.
import { effortOptions, type Effort } from "./effort.ts";

export type ApprovalLevel = "ask" | "edits" | "auto" | "full";
export const APPROVAL_LEVELS: readonly ApprovalLevel[] = ["ask", "edits", "auto", "full"];

export interface SettingsEngine {
  id: string;
  name: string;
  default: string;
  models: Array<{ id: string; label: string; efforts: Effort[] }>;
  /** Whether this person may move an agent onto it. One somebody else
   * chose is listed so the picker can say it, and may be kept. */
  allowed: boolean;
}

export interface AgentSettingsView {
  agent: {
    id: string;
    name: string;
    title: string;
    description: string;
    color: string;
    shape: string | null;
    solo: boolean;
    mine: boolean;
    /** Whose it is, for somebody looking after an agent a member made. */
    madeBy?: { id: string; name: string };
  };
  settings: {
    modelSelection: { instanceId: string; model: string } | null;
    effort: Effort | null;
    approvals: ApprovalLevel;
    browser: boolean;
    computer: string | null;
  };
  engines: SettingsEngine[];
  computers: Array<{ id: string; label: string }>;
  /** What this person cannot widen: approvals past this level, and the
   * computer. Absent, nothing is held. */
  held: { approvals?: ApprovalLevel; computer?: boolean };
  owner: { name: string };
}

/** What the dialog edits: the view's own fields, flattened. */
export interface SettingsDraft {
  name: string;
  title: string;
  description: string;
  engine: string | null;
  model: string | null;
  effort: Effort | null;
  approvals: ApprovalLevel;
  browser: boolean;
  computer: string | null;
}

export function draftOf(view: AgentSettingsView): SettingsDraft {
  return {
    name: view.agent.name,
    title: view.agent.title,
    description: view.agent.description,
    engine: view.settings.modelSelection?.instanceId ?? null,
    model: view.settings.modelSelection?.model ?? null,
    effort: view.settings.effort,
    approvals: view.settings.approvals,
    browser: view.settings.browser,
    computer: view.settings.computer,
  };
}

/** Only what changed, in the shape the route takes. An engine changed
 * carries its model; an effort the new model has no use for goes back to
 * the engine's own. */
export function changesOf(view: AgentSettingsView, draft: SettingsDraft): Record<string, unknown> {
  const was = draftOf(view);
  const out: Record<string, unknown> = {};
  if (draft.name.trim() !== was.name) out.name = draft.name.trim();
  if (draft.title.trim() !== was.title) out.title = draft.title.trim();
  if (draft.description !== was.description) out.description = draft.description;
  if (draft.engine && draft.model && (draft.engine !== was.engine || draft.model !== was.model)) {
    out.modelSelection = { instanceId: draft.engine, model: draft.model };
  }
  if (draft.effort !== was.effort || (out.modelSelection && draft.effort && !effortsFor(view, draft).includes(draft.effort))) {
    out.effort = draft.effort && effortsFor(view, draft).includes(draft.effort) ? draft.effort : null;
  }
  if (draft.approvals !== was.approvals) out.approvals = draft.approvals;
  if (draft.browser !== was.browser) out.browser = draft.browser;
  if (draft.computer !== was.computer) out.computer = draft.computer;
  return out;
}

/** The effort levels the drafted engine and model take. */
export function effortsFor(view: AgentSettingsView, draft: Pick<SettingsDraft, "engine" | "model">): Effort[] {
  const engine = view.engines.find((e) => e.id === draft.engine);
  return engine?.models.find((m) => m.id === draft.model)?.efforts ?? [];
}

/** The effort picker's choices for the drafted model. */
export function effortChoices(view: AgentSettingsView, draft: Pick<SettingsDraft, "engine" | "model">) {
  return effortOptions(effortsFor(view, draft));
}

/** Whether this person may pick an approval level. What the agent has
 * now may always stay, and asking more often is always allowed. */
export function approvalAllowed(view: AgentSettingsView, level: ApprovalLevel): boolean {
  const most = view.held.approvals;
  if (!most || level === view.settings.approvals) return true;
  return APPROVAL_LEVELS.indexOf(level) <= APPROVAL_LEVELS.indexOf(most);
}

/** Whether this person may pick a computer: any, or for a member only
 * taking it away (off) or leaving it to the workspace (null). */
export function computerAllowed(view: AgentSettingsView, value: string | null): boolean {
  return !view.held.computer || value === null || value === "off" || value === view.settings.computer;
}

/** Where the route is: the owner's way in, or a member's (an admin is one). */
export function settingsPath(via: "owner" | "member", agentId: string): string {
  return via === "owner" ? `/api/workspace/agents/${agentId}/settings` : `/api/member/agents/${agentId}/settings`;
}
