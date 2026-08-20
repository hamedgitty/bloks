// Built-in driver registration: a static array, nothing more. The CLI
// and box drivers are hand-written; the API providers are generated from
// the catalog in providers.ts, so adding another lab is a spec rather
// than a driver.
import type { AnyProviderDriver } from "../contracts.ts";
import { PROVIDER_SPECS } from "../providers.ts";
import { acpDriver, ACP_SPECS } from "./acp.ts";
import { AntigravityDriver } from "./antigravity.ts";
import { BoxAgentDriver } from "./boxagent.ts";
import { ClaudeDriver } from "./claude.ts";
import { CodexDriver } from "./codex.ts";
import { openAiCompatDriver } from "./openai-compat.ts";

export const BUILT_IN_DRIVERS: readonly AnyProviderDriver[] = [
  ...PROVIDER_SPECS.map(openAiCompatDriver),
  ...ACP_SPECS.map(acpDriver),
  AntigravityDriver,
  ClaudeDriver,
  CodexDriver,
  BoxAgentDriver,
];
