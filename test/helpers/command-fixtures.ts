// Invented commands only. Codex commandExecution includes its shell wrapper.
export const shellWrappers = ["/bin/bash -lc", "/bin/zsh -lc", "/bin/sh -c", "/usr/bin/bash -lc"];
export const doubleWrapped = (command: string, wrapper = shellWrappers[0]) => wrapper + ' "' + command.replace(/[\\$\x60"]/g, "\\$&") + '"';
export const singleWrapped = (command: string, wrapper = shellWrappers[0]) => wrapper + " '" + command.replaceAll("'", "'\"'\"'") + "'";
export const commandForms = (command: string) => [command, ...shellWrappers.flatMap((wrapper) => [doubleWrapped(command, wrapper), singleWrapped(command, wrapper)])];
