// A turn's tool calls, in one line.
//
// An agent working through a skill can make twenty calls in a minute,
// and a line each pushes the reply people came for off the screen. So a
// run of them reads as what happened, counted: commands run, files read,
// searches, edits, anything else. The list is still there, one click
// away.
//
// Failures are not counted. A command exiting non-zero is ordinary work
// (a test that fails, a grep that finds nothing), and a red number on
// every turn would teach people to ignore it. They are still marked in
// the opened list.

export interface ToolLike {
  name: string;
  ok?: boolean;
  stopped?: boolean;
}

export type ToolKind = "command" | "read" | "search" | "edit" | "other";

const READ = /^(read|view|notebookread|read_file|cat)$/i;
const SEARCH = /^(grep|glob|ls|list|search|web_?search|websearch|webfetch|web_?fetch|find|codebase_search)$/i;
const EDIT = /^(edit|write|multiedit|multi_edit|notebookedit|create|str_replace(_editor)?|apply_patch|write_file|edit_file)$/i;
const COMMAND = /^(bash|shell|terminal|exec|run|sandbox_exec|run_shell_command|command)$/i;

/** What kind of call a chip is, from the only thing a chip carries: its
 * label. Engines that label a command by the command itself (Codex)
 * show a line with a space in it, which no tool name has. */
export function kindOf(name: string): ToolKind {
  const bare = name.trim().replace(/^mcp__[^_]+__/, "");
  if (COMMAND.test(bare)) return "command";
  if (READ.test(bare)) return "read";
  if (SEARCH.test(bare)) return "search";
  if (EDIT.test(bare)) return "edit";
  if (/\s/.test(bare) && !/^error:/i.test(bare)) return "command";
  return "other";
}

function count(n: number, one: string, many: string) {
  return `${n} ${n === 1 ? one : many}`;
}

/** "Ran 3 commands, read 5 files, used 2 other tools". */
export function summarize(tools: ToolLike[]): string {
  const by: Record<ToolKind, number> = { command: 0, read: 0, search: 0, edit: 0, other: 0 };
  for (const tool of tools) by[kindOf(tool.name)]++;
  const parts: string[] = [];
  if (by.command) parts.push(`ran ${count(by.command, "command", "commands")}`);
  if (by.read) parts.push(`read ${count(by.read, "file", "files")}`);
  if (by.search) parts.push(`searched ${by.search === 1 ? "once" : `${by.search} times`}`);
  if (by.edit) parts.push(`edited ${count(by.edit, "file", "files")}`);
  if (by.other) {
    const noun = parts.length ? "other tool" : "tool";
    parts.push(`used ${count(by.other, noun, `${noun}s`)}`);
  }
  const line = parts.join(", ");
  return line.charAt(0).toUpperCase() + line.slice(1);
}

/** Whether any call in the run is still going. */
export function running(tools: ToolLike[]): boolean {
  return tools.some((tool) => tool.ok === undefined && !tool.stopped);
}
