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
  "LANG", "TERM", "EDITOR", "VISUAL", "PAGER", "LESSOPEN", "LESSCLOSE",
  "SSH_AUTH_SOCK", "SSH_ASKPASS", "SUDO_ASKPASS", "SSL_CERT_FILE", "SSL_CERT_DIR",
  "BROWSER",
  "PERL5OPT", "PERL5LIB", "PERLLIB", "RUBYOPT", "RUBYLIB", "JAVA_TOOL_OPTIONS", "_JAVA_OPTIONS", "JDK_JAVA_OPTIONS",
  "GOFLAGS", "GOPROXY", "DOCKER_HOST", "PIP_INDEX_URL", "PIP_EXTRA_INDEX_URL", "UV_INDEX_URL",
]);

const PREFIXES = ["NODE_", "NPM_CONFIG_", "LD_", "DYLD_", "GIT_", "XDG_", "BLOKS_", "CLAUDE", "ANTHROPIC_", "CODEX_", "ELECTRON_"];

const SUFFIXES = ["_PROXY", "_BASE_URL"];

/** Python reads every PYTHONSOMETHING and PYTHON_SOMETHING it knows of
 * (PYTHONPATH, PYTHONWARNINGS, PYTHONSTARTUP, PYTHON_COLORS...), and new
 * ones arrive with each release, so the whole shape is reserved; a name
 * that only starts with the word, like PYTHONANYWHERE_TOKEN, is a key. */
const PYTHON = /^PYTHON(?:[A-Z]+|_[A-Z0-9_]+)$/;

/** Whether a secret may not be saved under this (already normalised,
 * upper case) environment variable name. */
export function reservedEnvName(name: string): boolean {
  return (
    EXACT.has(name) ||
    PYTHON.test(name) ||
    PREFIXES.some((p) => name.startsWith(p)) ||
    SUFFIXES.some((s) => name.endsWith(s))
  );
}

/** Saved secrets without any under a reserved name: one saved before the
 * names were checked still never reaches an agent's environment. */
export function usableSecrets(secrets: Record<string, string> | undefined): Record<string, string> {
  return Object.fromEntries(Object.entries(secrets ?? {}).filter(([name]) => !reservedEnvName(name)));
}
