// Is this engine out of date?
//
// The models an agent can pick come from the CLI that is installed: a
// model released last week is not in the list of a CLI from last month.
// From the outside that reads as Bloks not knowing about the new model,
// so this checks what each engine's latest release is and says so where
// the models are chosen, with a button that updates it.
//
// The latest version comes from npm, where every one of these is
// published. Updating uses the engine's own updater when it has one, and
// otherwise installs the new release into the same folder the old one
// lives in: an update written anywhere else would be a second copy that
// the one already on PATH shadows, and nothing would change.
export interface EnginePackage {
  /** The npm package whose `latest` is the newest release. */
  pkg: string;
  /** The command on PATH. */
  cli: string;
  /** How to update it in place. POSIX shell. */
  update: string;
}

/** Reinstall into the prefix the current binary sits in. */
const inPlace = (cli: string, packages: string) =>
  [
    `p="$(command -v ${cli})"`,
    `[ -n "$p" ] || { echo "BLOKS_NOT_INSTALLED"; exit 4; }`,
    `command -v npm >/dev/null 2>&1 || { echo "BLOKS_NEEDS_NODE"; exit 3; }`,
    `prefix="$(cd "$(dirname "$p")/.." && pwd)"`,
    `npm install -g --prefix "$prefix" ${packages}`,
  ].join("\n");

export const ENGINE_PACKAGES: Record<string, EnginePackage> = {
  claudeAgent: { pkg: "@anthropic-ai/claude-code", cli: "claude", update: "claude update" },
  codex: { pkg: "@openai/codex", cli: "codex", update: inPlace("codex", "@openai/codex@latest") },
  geminiCli: { pkg: "@google/gemini-cli", cli: "gemini", update: inPlace("gemini", "@google/gemini-cli@latest") },
  opencode: { pkg: "opencode-ai", cli: "opencode", update: inPlace("opencode", "opencode-ai@latest") },
  commandcode: { pkg: "command-code", cli: "command-code", update: inPlace("command-code", "command-code@latest") },
  // Cursor is not here: it is not on npm, and it updates itself
  cline: { pkg: "cline", cli: "cline", update: inPlace("cline", "cline@latest") },
  pi: {
    pkg: "@earendil-works/pi-coding-agent",
    cli: "pi",
    update: inPlace("pi", "--ignore-scripts @earendil-works/pi-coding-agent@latest pi-acp@latest"),
  },
};

/** The first x.y.z in whatever a CLI prints for --version. */
export function versionOf(text: string | null | undefined): string | null {
  return String(text ?? "").match(/\d+\.\d+\.\d+/)?.[0] ?? null;
}

/** Whether `latest` is a newer release than `installed`. Pre-release tags
 * are ignored: the comparison is on the three numbers. */
export function isNewer(latest: string, installed: string): boolean {
  const a = latest.split(".").map(Number);
  const b = installed.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
}

const CHECK_TTL_MS = 6 * 60 * 60_000;
const latestSeen = new Map<string, { at: number; version: string | null }>();

/** The newest release of one package, asked of npm at most every six
 * hours. Null when npm could not be reached: no answer is not an update. */
export async function latestVersion(pkg: string, now = Date.now()): Promise<string | null> {
  const cached = latestSeen.get(pkg);
  if (cached && now - cached.at < CHECK_TTL_MS) return cached.version;
  let version: string | null = null;
  try {
    const res = await fetch(`https://registry.npmjs.org/${pkg.replace("/", "%2F")}/latest`, {
      signal: AbortSignal.timeout(8_000),
    });
    if (res.ok) version = versionOf(((await res.json()) as { version?: string }).version);
  } catch {
    /* offline: try again next time */
  }
  // a failure is remembered briefly, so an offline machine does not ask
  // on every open of the model list
  latestSeen.set(pkg, { at: version ? now : now - CHECK_TTL_MS + 10 * 60_000, version });
  return version;
}

export interface EngineUpdate {
  installed: string;
  latest: string;
}

/** Which installed engines have a newer release, by driver kind. */
export async function engineUpdates(
  installed: Array<{ driverKind: string; version?: string | null; available: boolean }>,
): Promise<Record<string, EngineUpdate>> {
  const out: Record<string, EngineUpdate> = {};
  await Promise.all(
    installed.map(async (engine) => {
      const known = ENGINE_PACKAGES[engine.driverKind];
      const have = versionOf(engine.version);
      if (!known || !engine.available || !have) return;
      const latest = await latestVersion(known.pkg);
      if (latest && isNewer(latest, have)) out[engine.driverKind] = { installed: have, latest };
    }),
  );
  return out;
}
