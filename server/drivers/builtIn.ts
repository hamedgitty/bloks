// Built-in driver registration: a static array, nothing more. The CLI
// and box drivers are hand-written; the API providers are generated from
// the catalog in providers.ts, so adding another lab is a spec rather
// than a driver.
import type { AnyProviderDriver } from "../contracts.ts";
import { CUSTOM_SPEC, PROVIDER_SPECS } from "../providers.ts";
import { CREDITS_SPEC, creditsAccess } from "../credits.ts";
import { acpDriver, ACP_SPECS } from "./acp.ts";
import { BoxAgentDriver } from "./boxagent.ts";
import { ClaudeDriver } from "./claude.ts";
import { CodexDriver } from "./codex.ts";
import { openAiCompatDriver } from "./openai-compat.ts";

export const BUILT_IN_DRIVERS: readonly AnyProviderDriver[] = [
  ...PROVIDER_SPECS.map((spec) => openAiCompatDriver(spec)),
  openAiCompatDriver(CUSTOM_SPEC),
  // Bloks credits: the same driver, with a token that can be renewed
  openAiCompatDriver(CREDITS_SPEC, creditsAccess),
  ...ACP_SPECS.map(acpDriver),
  ClaudeDriver,
  CodexDriver,
  BoxAgentDriver,
];
