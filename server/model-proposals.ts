// Models for several agents at once, changed on the owner's yes.
//
// An agent may change its own model on the engine it is on, and propose
// that much to the person (server/settings-proposals.ts). Another agent's
// model it could not touch at all: PATCH /api/bots/:id refuses everything
// but the sidebar for an agent that is not the caller, and that stays so.
// Restoring the models of a few agents after an accidental change was a
// list of instructions for the person to follow by hand (GitHub 497).
//
// Now an agent can put the list itself in front of the owner: one card
// naming each agent, the engine and model it is on, and the engine and
// model proposed, with Apply and Keep. Nothing changes until Apply, and
// then all of it changes or none of it does. A card that waited while
// somebody changed one of those agents' models is out of date, and
// applies nothing: the owner said yes to a list that no longer says what
// is there, so the agent is told to look again and ask again.
//
// Which engine is a matter of sign-ins and keys, and each engine has its
// own tools and safeguards, so a switch between engines is said on the
// card as plainly as a model, and only to an engine that is switched on.
// Nothing else about an agent is touched: its effort stays as it is, and
// its turns take the nearest level the new model offers, as they would
// after a change in its settings.
//
// Pure: reading a proposal against the agents and engines there are, and
// checking it again before it applies. The card, the waiting and the
// change itself are server/index.ts's.
import { MAX_MODEL_ID_CHARS } from "./limits.ts";

/** Agents one card may name. More than this is a migration, and wants
 * the person in the agents' settings rather than one tap. */
export const MAX_TARGETS = 20;

/** The characters a model id is made of, as the agent's settings hold it. */
const MODEL_ID = /^[\w.:@/\[\]+-]+$/;

/** An engine as the proposal reads it. */
export interface EngineView {
  id: string;
  name: string;
  enabled: boolean;
  /** The model it runs when an agent names none. */
  default: string;
  options: Array<{ id: string; label?: string }>;
}

/** An agent as the proposal reads it: its saved engine and model, as
 * saved, so a check later compares like with like. */
export interface AgentView {
  id: string;
  name: string;
  selection: { instanceId: string; model: string } | null;
}

export interface ModelWorld {
  agents: AgentView[];
  engines: EngineView[];
}

/** One side of a change: what is saved, and how the card says it. */
export interface ModelSide {
  instanceId: string;
  /** As saved: empty is the engine's default. */
  model: string;
  engine: string;
  label: string;
}

export interface ModelTarget {
  botId: string;
  name: string;
  from: ModelSide;
  to: ModelSide;
}

/** What a model proposal card carries (Message.card.modelProposal). */
export interface ModelProposalCard {
  id: string;
  /** The conversation the card is in, which its answer is posted against. */
  laneId: string;
  /** The agent that proposed it. */
  botId: string;
  agentName: string;
  targets: ModelTarget[];
  why?: string;
  /** Set once the agent has been told how it went. */
  told?: boolean;
  outcome?: "changed" | "kept" | "failed";
  /** Why nothing changed, when Apply could not. */
  error?: string;
}

const flat = (text: string) => text.trim().toLowerCase();

/** An engine's model, by id or by the name the picker shows. */
function modelOn(engine: EngineView, asked: string): { id: string; label?: string } | null {
  const want = flat(asked);
  const listed = engine.options.find((o) => o.id === asked.trim()) ?? engine.options.find((o) => flat(o.id) === want || (o.label && flat(o.label) === want));
  if (listed) return listed;
  return engine.default && flat(engine.default) === want ? { id: engine.default } : null;
}

/** How the card says a model on an engine. */
export function sideOf(engine: EngineView | undefined, instanceId: string, model: string): ModelSide {
  const id = model || engine?.default || "";
  const label = engine?.options.find((o) => o.id === id)?.label || id || "the engine's default";
  return { instanceId, model, engine: engine?.name ?? instanceId, label };
}

/** An agent by its id, or by its name when that names only one. */
function agentNamed(world: ModelWorld, asked: string): AgentView | string {
  const byId = world.agents.find((a) => a.id === asked.trim());
  if (byId) return byId;
  const named = world.agents.filter((a) => flat(a.name) === flat(asked));
  if (named.length === 1) return named[0]!;
  if (named.length > 1) return `more than one agent is called "${asked.slice(0, 60)}"; name it by its id from \`bloks agents\``;
  return `there is no agent "${asked.slice(0, 60)}" here; \`bloks agents\` lists them`;
}

/** An engine by its id or its name. */
function engineNamed(world: ModelWorld, asked: string): EngineView | null {
  return world.engines.find((e) => e.id === asked.trim()) ?? world.engines.find((e) => flat(e.name) === flat(asked)) ?? null;
}

const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

/**
 * A proposal as an agent sent it, read against what is there now. Every
 * line is checked before anything is refused, so one answer says all
 * that is wrong with it and the next try can be the right one.
 */
export function readModelProposal(raw: unknown, world: ModelWorld): { ok: true; targets: ModelTarget[] } | { ok: false; errors: string[] } {
  const changes = (raw as { changes?: unknown } | null)?.changes;
  if (!Array.isArray(changes) || !changes.length) {
    return { ok: false, errors: ["a proposal names at least one agent, with the engine and model for it"] };
  }
  if (changes.length > MAX_TARGETS) {
    return { ok: false, errors: [`one proposal names ${MAX_TARGETS} agents at most; propose the rest on another card`] };
  }
  const errors: string[] = [];
  const targets: ModelTarget[] = [];
  const seen = new Set<string>();
  for (const change of changes) {
    const asked = text((change as { agent?: unknown } | null)?.agent);
    const engineAsked = text((change as { engine?: unknown } | null)?.engine);
    const modelAsked = text((change as { model?: unknown } | null)?.model);
    if (!asked || !engineAsked || !modelAsked) {
      errors.push(`each change names an agent, an engine and a model${asked ? ` (${asked.slice(0, 60)} is missing one)` : ""}`);
      continue;
    }
    const agent = agentNamed(world, asked);
    if (typeof agent === "string") {
      errors.push(agent);
      continue;
    }
    if (seen.has(agent.id)) {
      errors.push(`${agent.name} is named twice; name each agent once`);
      continue;
    }
    seen.add(agent.id);
    const engine = engineNamed(world, engineAsked);
    if (!engine) {
      errors.push(`${agent.name}: there is no engine "${engineAsked.slice(0, 60)}" here. The engines are: ${world.engines.map((e) => `${e.id} (${e.name})`).join(", ") || "none"}`);
      continue;
    }
    const staying = agent.selection?.instanceId === engine.id;
    // moving is to an engine the person has switched on; one switched off
    // keeps the agents already on it, and nobody new
    if (!staying && !engine.enabled) {
      errors.push(`${agent.name}: the engine ${engine.name} is switched off, so no agent can be moved onto it`);
      continue;
    }
    const model = modelOn(engine, modelAsked);
    if (!model || model.id.length > MAX_MODEL_ID_CHARS || !MODEL_ID.test(model.id)) {
      const offered = [...new Set([engine.default, ...engine.options.map((o) => o.id)].filter(Boolean))];
      errors.push(`${agent.name}: ${engine.name} has no model "${modelAsked.slice(0, 60)}". It offers: ${offered.join(", ") || "none it lists"}`);
      continue;
    }
    const from = agent.selection;
    if (from && from.instanceId === engine.id && (from.model || engine.default) === model.id) {
      errors.push(`${agent.name} is on ${engine.name}, ${model.label || model.id} already`);
      continue;
    }
    const fromEngine = from ? world.engines.find((e) => e.id === from.instanceId) : undefined;
    targets.push({
      botId: agent.id,
      name: agent.name,
      from: from ? sideOf(fromEngine, from.instanceId, from.model) : { instanceId: "", model: "", engine: "none", label: "none" },
      to: sideOf(engine, engine.id, model.id),
    });
  }
  return errors.length ? { ok: false, errors } : { ok: true, targets };
}

/**
 * Why a card cannot be applied as it is now, one reason per agent, or
 * none. Each agent has to be where the card says it is: a model changed
 * since is a later choice the card knows nothing about, and the owner's
 * yes was to a list that said otherwise.
 */
export function blockers(card: Pick<ModelProposalCard, "targets">, world: ModelWorld): string[] {
  const out: string[] = [];
  for (const target of card.targets) {
    const agent = world.agents.find((a) => a.id === target.botId);
    if (!agent) {
      out.push(`${target.name} is no longer here`);
      continue;
    }
    const now = agent.selection;
    if (!now || now.instanceId !== target.from.instanceId || now.model !== target.from.model) {
      const engine = now ? world.engines.find((e) => e.id === now.instanceId) : undefined;
      const side = now ? sideOf(engine, now.instanceId, now.model) : null;
      out.push(`${target.name} is on ${side ? `${side.engine}, ${side.label}` : "no engine"} now, not ${target.from.engine}, ${target.from.label} as the card says`);
      continue;
    }
    const engine = world.engines.find((e) => e.id === target.to.instanceId);
    if (!engine) {
      out.push(`the engine ${target.to.engine} for ${target.name} is gone`);
      continue;
    }
    if (target.to.instanceId !== now.instanceId && !engine.enabled) {
      out.push(`the engine ${engine.name} for ${target.name} is switched off`);
      continue;
    }
    if (!modelOn(engine, target.to.model)) out.push(`${engine.name} no longer offers ${target.to.label} for ${target.name}`);
  }
  return out;
}

/** One change in words: "Ada from Claude, Claude Sonnet 5 to Codex, GPT-5". */
export function changeWords(target: ModelTarget): string {
  return `${target.name} from ${target.from.engine}, ${target.from.label} to ${target.to.engine}, ${target.to.label}`;
}
