// Holds Claude Code's file tools to a room topic's folder (GitHub 523).
//
// A topic may say where its work goes (server/room-topics.ts). For a turn
// in such a topic, Bloks hands Claude Code this script as a PreToolUse
// hook on its own file tools, Write, Edit, MultiEdit and NotebookEdit, with
// the folders the turn may write in as its arguments: the topic's folder,
// the agent's own notes folder and the temp folder. Claude Code runs it
// before each of those calls with the call on stdin, in every permission
// mode, and a refusal (exit 2) stops the call and tells the agent why.
//
// It can only see what Claude Code shows it: a command run in the shell
// writes where it likes, which the agent is told in its brief. Paths are
// read through symbolic links as far as they exist, so a link inside the
// folder that points out of it does not carry a write out with it.
import { realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const FILE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

/** A path as it really is on disk: the longest part of it that exists,
 * through its links, with the rest as written. */
function real(path: string): string {
  let at = resolve(path);
  const rest: string[] = [];
  for (;;) {
    try {
      return rest.length ? resolve(realpathSync(at), ...rest.reverse()) : realpathSync(at);
    } catch {
      const up = dirname(at);
      if (up === at) return resolve(path);
      rest.push(at.slice(up.length).replace(/^[\\/]+/, ""));
      at = up;
    }
  }
}

function inside(path: string, dir: string): boolean {
  const rel = relative(dir, path);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep) && !isAbsolute(rel));
}

/**
 * Whether one call may run: a call that is not a file tool is not this
 * hook's to judge, and a file tool must name a path inside one of the
 * folders given. The reason is for the agent to act on.
 */
export function judgeWrite(call: { tool_name?: unknown; tool_input?: unknown; cwd?: unknown }, allowed: readonly string[]): { ok: true } | { ok: false; reason: string } {
  if (typeof call.tool_name !== "string" || !FILE_TOOLS.has(call.tool_name)) return { ok: true };
  const input = (call.tool_input ?? {}) as Record<string, unknown>;
  const named = input.file_path ?? input.notebook_path;
  const topic = allowed[0] ?? "the topic's folder";
  if (typeof named !== "string" || !named) {
    return { ok: false, reason: `Bloks could not tell where this ${call.tool_name} writes, so it was held. This room topic's files go in ${topic}.` };
  }
  const base = typeof call.cwd === "string" && call.cwd ? call.cwd : process.cwd();
  const path = real(resolve(base, named));
  if (allowed.some((dir) => inside(path, real(dir)))) return { ok: true };
  return { ok: false, reason: `This room topic's files go in ${topic}, and ${named} is outside it, so Bloks refused the ${call.tool_name}. Write it inside ${topic}, or ask the person to change the topic's folder.` };
}

async function main() {
  const allowed = process.argv.slice(2).filter(Boolean);
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  let call: Record<string, unknown>;
  try {
    call = JSON.parse(raw);
  } catch {
    // nothing readable came: hold the call rather than wave it through
    process.stderr.write("Bloks could not read this call, so it was held.\n");
    process.exit(2);
  }
  const verdict = judgeWrite(call, allowed);
  if (verdict.ok) process.exit(0);
  process.stderr.write(`${verdict.reason}\n`);
  process.exit(2);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main();
