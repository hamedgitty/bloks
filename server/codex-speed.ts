// Shared by settings, dispatch and the remote driver. No provider calls.
export type CodexSpeed = "standard" | "fast";
export interface CodexSpeedChoice {
  default: CodexSpeed;
  override: CodexSpeed | null;
  resolved: CodexSpeed;
  source: "workspace" | "agent";
}
/** Ephemeral metadata for the currently running dispatch, never a message. */
export interface CodexSpeedStatus {
  choice: CodexSpeedChoice;
  configuredTier: "default" | "priority";
  actualTier: null;
}
export const isCodexSpeed = (value: unknown): value is CodexSpeed => value === "standard" || value === "fast";
export function resolveCodexSpeed(config: { codex?: { speed?: unknown } }, bot?: { codexSpeed?: unknown } | null): CodexSpeedChoice {
  const workspace = isCodexSpeed(config.codex?.speed) ? config.codex.speed : "standard";
  const override = isCodexSpeed(bot?.codexSpeed) ? bot.codexSpeed : null;
  return { default: workspace, override, resolved: override ?? workspace, source: override ? "agent" : "workspace" };
}
export function codexSpeedRoute(driver: string | undefined, model: string): "native" | "remote-unsupported" | "not-codex" {
  if (driver === "codex") return "native";
  return driver === "boxAgent" && model.startsWith("gpt") ? "remote-unsupported" : "not-codex";
}
export const REMOTE_CODEX_SPEED_REASON = "This remote engine cannot yet apply Codex speed. Remote Codex is unavailable until supported tier enforcement exists.";
export interface CodexSpeedRefusal { kind: "codex-speed"; reason: string }
export class CodexSpeedUnavailable extends Error {
  readonly refusal: CodexSpeedRefusal;
  constructor(reason: string) {
    super(`The message was not sent to this engine: ${reason}`);
    this.name = "CodexSpeedUnavailable";
    this.refusal = { kind: "codex-speed", reason: this.message };
  }
}
export function codexTier(speed: CodexSpeed): "default" | "priority" { return speed === "fast" ? "priority" : "default"; }
export function requireCodexTier(response: unknown, speed: CodexSpeed) {
  if (!response || typeof response !== "object" || (response as { serviceTier?: unknown }).serviceTier !== codexTier(speed)) {
    throw new CodexSpeedUnavailable(`Codex did not acknowledge ${speed === "fast" ? "Fast (priority)" : "Standard (default)"}. Update Codex if this CLI cannot accept and acknowledge serviceTier; managed policy or disabled Fast may also prevent this choice.`);
  }
}
/** Old compatibility fallbacks must not strip the speed field or reset a session. */
export function codexTierError(error: unknown): boolean {
  if (error instanceof CodexSpeedUnavailable) return true;
  const message = error instanceof Error ? error.message : String(error);
  // A named legacy history flag may be omitted once. A generic field or
  // variant rejection cannot prove that this CLI accepted the tier.
  if (/exclude_?turns/i.test(message) && !/service[_ -]?tier|fast[_ -]?mode/i.test(message)) return false;
  if (error instanceof Error && (error as Error & { code?: unknown }).code === -32601) return true;
  return /service[_ -]?tier|fast[_ -]?mode|unknown field|unknown variant/i.test(message);
}
