// Invented commands only. Codex commandExecution includes its shell wrapper.
export const doubleWrapped = (command: string) => '/bin/bash -lc "' + command.replace(/[\\$\x60"]/g, "\\$&") + '"';
export const singleWrapped = (command: string) => "/bin/bash -lc '" + command.replaceAll("'", "'\"'\"'") + "'";
export const commandForms = (command: string) => [command, doubleWrapped(command), singleWrapped(command)];
