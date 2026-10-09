// Names a saved secret may not take.
//
// A secret an agent asks for is saved under an environment variable name
// of its choosing, and from then on it is set in every agent's turn, every
// engine and every watcher. Most names are just a value an agent's script
// reads. These are not: the shell, Node, Python, git and the engines read
// them to decide what runs, where it loads from, and where traffic goes.
// A card asking the person to "paste your proxy address" under one of
// these names would change every agent's behaviour, not hand one agent a
// key, so the name is refused before anyone is asked.

const EXACT = new Set([
  "PATH", "HOME", "SHELL", "USER", "LOGNAME", "PWD", "TMPDIR", "TMP", "TEMP",
  "BASH_ENV", "ENV", "ZDOTDIR", "IFS", "PS4", "PROMPT_COMMAND", "CDPATH",
  "LANG", "TERM", "EDITOR", "VISUAL", "PAGER", "SSH_AUTH_SOCK", "SSL_CERT_FILE", "SSL_CERT_DIR",
]);

const PREFIXES = ["NODE_", "NPM_CONFIG_", "LD_", "DYLD_", "PYTHON", "GIT_", "XDG_", "BLOKS_", "CLAUDE", "ANTHROPIC_", "CODEX_", "ELECTRON_"];

const SUFFIXES = ["_PROXY", "_BASE_URL"];

/** Whether a secret may not be saved under this (already normalised,
 * upper case) environment variable name. */
export function reservedEnvName(name: string): boolean {
  return EXACT.has(name) || PREFIXES.some((p) => name.startsWith(p)) || SUFFIXES.some((s) => name.endsWith(s));
}
