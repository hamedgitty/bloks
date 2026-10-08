// What a turn carries when the engine behind a lane changes.
//
// Session-cursor engines remember a conversation by resuming a session;
// the session belongs to one engine. Switch the lane's model and the new
// engine either has no session (it sees one bare message) or, switching
// back, an old session that missed everything the other engine did. Both
// are silent context loss. The cure is cheap: detect the switch, replay
// the story inline once, and never trust a cursor across it.
export interface FreshnessInput {
  /** The instance about to serve this turn. */
  instanceId: string;
  /** The instance that served the lane last, when known. */
  lastInstanceId?: string;
  /** Cursors by instance id, for lanes older than the marker. */
  resumeCursors: Record<string, unknown>;
  /** A lane with no user turn yet has nothing worth replaying. */
  hasUserTurn: boolean;
}

/** True when the engine about to serve missed part of the conversation. */
export function engineIsFresh(input: FreshnessInput): boolean {
  if (!input.hasUserTurn) return false;
  if (input.lastInstanceId !== undefined) return input.lastInstanceId !== input.instanceId;
  // Legacy lanes predate the marker: the cursor map is the only witness.
  // Exactly our own cursor and nothing else means nobody else served it.
  const holders = Object.keys(input.resumeCursors).filter(
    (id) => input.resumeCursors[id] !== undefined,
  );
  return !(holders.length === 1 && holders[0] === input.instanceId);
}

/**
 * The inline replay a fresh session-cursor engine receives.
 *
 * The transcript is expected bounded already (boundHandoff in
 * server/context.ts); `left` is how many messages that left out, said so
 * the agent knows the story has a gap rather than assuming it has all of
 * it. `why` is what the opening line says happened: another engine had
 * the conversation, or the old session could not be carried on.
 */
export function freshTurnText(
  transcript: ReadonlyArray<{ role: "user" | "assistant"; text: string }>,
  turnText: string,
  opts: { left?: number; why?: "engine" | "session" } = {},
): string {
  if (transcript.length === 0) return turnText;
  const history = transcript
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.text}`)
    .join("\n\n");
  const opening =
    opts.why === "session"
      ? "You are picking up this conversation in a new session; the earlier one could not be carried on."
      : "You are picking up this conversation mid-thread; a different engine handled it until now.";
  const left = opts.left ?? 0;
  const gap =
    left > 0
      ? ` To keep this short, ${left === 1 ? "one earlier message is" : `${left} earlier messages are`} left out; ask if you need something from them.`
      : "";
  return `${opening}${gap} The conversation so far:\n\n${history}\n\n--- the new message ---\n\n${turnText}`;
}
