// The bug-report bundle.
//
// When something breaks on a stranger's machine, the distance between
// "it doesn't work" and a fix is exactly the facts in this file. The
// report is built to be pasted into a public GitHub issue, which sets
// the bar: nothing personal, nothing secret, ever.
//
// Safety is layered rather than trusted to care. The report is
// assembled only from booleans, numbers and version strings, so there
// is no field a credential could ride in; and the finished text is
// scrubbed for credential-shaped tokens anyway, so a future mistake in
// the assembly still cannot leak one.

/** Unmistakable credential formats, masked wherever they appear. The
 * list favors false positives: masking a harmless string costs nothing,
 * missing a real key costs someone their account. */
const TOKEN_FORMATS = [
  /\bsk-[A-Za-z0-9_-]{16,}/g, // OpenAI and friends
  /\bxai-[A-Za-z0-9]{16,}/g,
  /\bck_[A-Za-z0-9_-]{10,}/g, // Composio Connect
  /\bak_[A-Za-z0-9_-]{10,}/g, // Composio API
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abposr]-[A-Za-z0-9-]{20,}/g, // Slack
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS
  /\bAIza[0-9A-Za-z_-]{30,}/g, // Google
  /\bnpm_[A-Za-z0-9]{20,}/g,
];

const KEYED_VALUE =
  /\b([A-Za-z0-9_.-]*(?:api[_-]?key|apikey|secret|token|password|credential)s?)\s*[:=]\s*("[^"]*"|'[^']*'|[^\s"',;)\]}]+)/gi;

const BEARER = /(\bbearer\s+)([A-Za-z0-9._~+/=-]{8,})/gi;

const mask = () => "«redacted»";

/** Every layer of the report passes through here on its way out. */
export function scrubSecrets(text: string): string {
  let out = String(text ?? "");
  out = out.replace(KEYED_VALUE, (_whole, key: string) => `${key}=${mask()}`);
  out = out.replace(BEARER, (_whole, lead: string) => `${lead}${mask()}`);
  for (const format of TOKEN_FORMATS) out = out.replace(format, mask);
  return out;
}

export interface DiagnosticsFacts {
  version: string;
  platform: string;
  arch: string;
  node: string;
  uptimeSeconds: number;
  /** configStatus() output: which credentials exist, as booleans. */
  config: unknown;
  /** Engine rows reduced to name and connection state. */
  engines: Array<{ name: string; connected: boolean; agentic: boolean }>;
  counts: { agents: number; rooms: number; skills: number };
}

/** The report itself: markdown, because its destination is an issue. */
export function diagnosticsReport(facts: DiagnosticsFacts): string {
  const lines = [
    "## Bloks diagnostics",
    "",
    `- Version: ${facts.version}`,
    `- Platform: ${facts.platform} ${facts.arch}, Node ${facts.node}`,
    `- Server uptime: ${Math.round(facts.uptimeSeconds)}s`,
    `- Agents: ${facts.counts.agents}, rooms: ${facts.counts.rooms}, skills: ${facts.counts.skills}`,
    "",
    "### Engines",
    ...facts.engines.map(
      (engine) =>
        `- ${engine.name}: ${engine.connected ? "connected" : "not connected"}${engine.agentic ? "" : " (chat only)"}`,
    ),
    "",
    "### Configured credentials (presence only, never values)",
    "```json",
    JSON.stringify(facts.config, null, 2),
    "```",
  ];
  return scrubSecrets(lines.join("\n"));
}
