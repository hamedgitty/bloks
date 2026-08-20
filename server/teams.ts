// Team formation: a senior agent that needs more hands proposes one.
//
// The agent never hires anyone by itself. It emits a plan, the user sees
// exactly who would be created and why, and only an approval turns that
// into real agents and a real room. Spawning agents spends the user's
// tokens, so consent is the whole design.
export interface ProposedMember {
  name: string;
  title: string;
  description: string;
  skills: string[];
}

export interface TeamPlan {
  room: string;
  brief: string;
  members: ProposedMember[];
}

/** A team is a huddle, not a department. */
export const MAX_HIRES = 4;

/** How a lead is told to ask for help. Kept verbatim in the persona so
 * the fence and the shape are unambiguous. */
export const TEAM_PROTOCOL = `When a request genuinely needs more hands than you have, you may propose a small team instead of doing everything yourself. Only do this when the work splits cleanly into different specialisms; never for a task you can finish alone.

To propose one, end your reply with a fenced block exactly like this:

\`\`\`bloks-team
{
  "room": "Short room name",
  "brief": "What the team is being asked to deliver, in your own words, with the standard you expect.",
  "members": [
    {
      "name": "Content Strategist",
      "title": "One line on what they own",
      "description": "Standing instructions for this agent, written in the second person.",
      "skills": ["Skill name: when to use it, the sequence, what to return"]
    }
  ]
}
\`\`\`

Rules: two to ${MAX_HIRES} members, each a distinct specialism, no duplicates of agents that already exist. Give every member two to four real skills. Say in plain prose what you are proposing and why before the block. The user approves or declines it; hiring is never automatic. Once a team exists you brief them, delegate with @name, review what comes back, and report to the user yourself.`;

/**
 * Pulls a team plan out of an agent's reply, returning the plan and the
 * prose with the block removed (the block itself is machinery, not
 * something the user should have to read).
 */
export function extractTeamPlan(text: string): { plan: TeamPlan | null; text: string } {
  const fence = text.match(/```(?:bloks-team|json)?\s*\n([\s\S]*?)```/);
  if (!fence) return { plan: null, text };

  let parsed: unknown;
  try {
    parsed = JSON.parse(fence[1]);
  } catch {
    return { plan: null, text };
  }

  const plan = normalizePlan(parsed);
  if (!plan) return { plan: null, text };

  const stripped = text.replace(fence[0], "").replace(/\n{3,}/g, "\n\n").trim();
  return { plan, text: stripped };
}

function str(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/** Clamps whatever a model (or an old card on disk) claims a team is into
 * something we are willing to create. Everything is capped; a team under
 * two members or over the cap is not a team. */
export function normalizePlan(raw: unknown): TeamPlan | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.members)) return null;

  const members: ProposedMember[] = [];
  for (const entry of obj.members) {
    if (!entry || typeof entry !== "object") continue;
    const m = entry as Record<string, unknown>;
    const name = str(m.name, 40);
    if (!name) continue;
    members.push({
      name,
      title: str(m.title, 80),
      description: str(m.description, 2_000),
      skills: Array.isArray(m.skills)
        ? (m.skills as unknown[]).map((s) => str(s, 400)).filter(Boolean).slice(0, 6)
        : [],
    });
    if (members.length >= MAX_HIRES) break;
  }
  if (members.length < 2) return null;

  return {
    room: str(obj.room, 60) || "New team",
    brief: str(obj.brief, 4_000),
    members,
  };
}
