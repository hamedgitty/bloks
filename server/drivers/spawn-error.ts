// Turning a failed spawn into something a person can act on.
//
// Node reports a missing executable as "spawn claude ENOENT", which is
// precise and useless. This is the first thing a new user sees if they
// open Bloks before installing an engine, so it should read like a
// sentence and say what to do next.

export interface SpawnContext {
  /** How the engine is named in the UI, e.g. "Claude Code". */
  name: string;
  /** The executable we tried to run. */
  command: string;
  /** The command that installs it, if there is one. */
  install?: string;
  /** What to do once it is installed, e.g. "run claude to sign in". */
  signIn?: string;
}

/** True when the failure is "there is no such program". */
function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

export function describeSpawnError(error: unknown, ctx: SpawnContext): string {
  const code = (error as NodeJS.ErrnoException)?.code;

  if (isMissing(error)) {
    const next = ctx.install
      ? ` Install it with ${ctx.install}${ctx.signIn ? `, then ${ctx.signIn}` : ""}.`
      : "";
    return (
      `${ctx.name} is not installed, so this agent has nothing to think with.` +
      `${next} You can also connect a different engine in Settings.`
    );
  }

  if (code === "EACCES" || code === "EPERM") {
    return `${ctx.name} is installed but not runnable: \`${ctx.command}\` was found and permission was denied.`;
  }

  if (code === "EMFILE" || code === "ENFILE") {
    return `This machine is out of file handles, so ${ctx.name} could not start. Closing some apps usually fixes it.`;
  }

  const detail = error instanceof Error ? error.message : String(error);
  return `${ctx.name} could not start: ${detail}`;
}

/**
 * The other way a turn dies: the process launched and then quit before
 * saying anything. The exit code alone means nothing to a reader, so the
 * agent's own stderr is the useful part when there is any.
 */
export function describeEarlyExit(
  code: number | null,
  stderr: string,
  ctx: Pick<SpawnContext, "name" | "signIn">,
): string {
  const said = stderr.trim().split("\n").filter(Boolean).slice(-3).join(" ").slice(-300);

  // the overwhelmingly common cause, and the one with an obvious fix
  if (/not logged in|unauthor|authenticat|api key|credential|sign in/i.test(said)) {
    return `${ctx.name} is not signed in.${ctx.signIn ? ` To fix it, ${ctx.signIn}.` : ""}${
      said ? ` It said: ${said}` : ""
    }`;
  }

  if (said) return `${ctx.name} stopped early: ${said}`;
  return `${ctx.name} stopped early with exit code ${code ?? "unknown"} and said nothing.`;
}
