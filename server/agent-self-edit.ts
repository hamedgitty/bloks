// What an agent may change about itself.
//
// PATCH /api/bots/:me is on the agent allowlist (agent-cli.ts) so an agent
// can rename itself, pick a colour or slow itself down. The same route
// also holds every setting that decides how far the agent reaches: the
// computer it works, the folder it starts in, the engine it runs on, the
// MCP servers and connected apps it is handed. A turn that read a page
// written to steer it could otherwise ask for the person's own screen or
// their home folder, and have it from its next turn on.
//
// So an agent may narrow its reach and never widen it. Each rule below
// lets an agent keep what it has, or give some of it up; anything more is
// the person's, from the agent's settings. The browser, approvals,
// seniority, delivery and background work keep their own refusals in the
// route itself.

export interface SelfEditCurrent {
  computer?: string | null;
  cwd?: string | null;
  modelSelection?: { instanceId: string } | null;
  backupSelection?: { instanceId: string } | null;
  mcpServers?: string[];
  composio?: boolean;
  engineHooks?: boolean;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Why an agent cannot make this change to itself, or null when it may. */
export function selfEditRefusal(body: Record<string, unknown>, current: SelfEditCurrent): string | null {
  // Off is the only computer an agent may choose: anything else is a
  // screen, maybe the person's own, and Automatic may fall back on it.
  if (body.computer !== undefined && body.computer !== "off" && !same(body.computer, current.computer)) {
    return "an agent can turn its own computer off, and nothing more; the person chooses which computer it works";
  }
  // where it starts is also the edge of what Codex lets it write unasked
  if (body.cwd !== undefined && !same(body.cwd, current.cwd)) {
    return "an agent cannot move its own working folder; the person chooses where it works";
  }
  // A model on the engine it already has, yes; another engine may be one
  // set up with fewer guards, so that is the person's.
  const instance = (pick: unknown) => (pick && typeof pick === "object" ? (pick as { instanceId?: unknown }).instanceId : undefined);
  if (body.modelSelection !== undefined && instance(body.modelSelection) !== current.modelSelection?.instanceId) {
    return "an agent can pick another model on its own engine, not another engine";
  }
  if (body.backupSelection !== undefined && body.backupSelection !== null) {
    const allowed = [current.modelSelection?.instanceId, current.backupSelection?.instanceId].filter(Boolean);
    if (!allowed.includes(instance(body.backupSelection) as string)) {
      return "an agent can fall back to its own engine, not another one";
    }
  }
  if (body.mcpServers !== undefined) {
    const had = new Set(current.mcpServers ?? []);
    if (!Array.isArray(body.mcpServers) || body.mcpServers.some((id) => !had.has(id as string))) {
      return "an agent can give up MCP servers it has, not take on new ones";
    }
  }
  if (body.composio === true && current.composio !== true) {
    return "an agent cannot connect itself to the person's apps";
  }
  // Bloks's own hooks in the engine are how its guards reach a turn
  if (body.engineHooks !== undefined && !same(body.engineHooks, current.engineHooks)) {
    return "an agent cannot change the hooks Bloks keeps in its engine";
  }
  return null;
}
