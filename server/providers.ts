// The provider catalog: every engine Bloks knows how to talk to, and how
// you sign in to each one.
//
// Almost every major lab now speaks OpenAI's /chat/completions shape, so
// these are data, not code. One generic driver (drivers/openai-compat.ts)
// reads a spec and becomes that provider.
//
// `auth` is the honest part. "oauth" means a real browser sign-in that
// hands back a credential; "key" means paste a key; "cli" means another
// tool already holds the login and we ride along; "none" means it runs on
// this machine and asks for nothing.
import type { ModelCatalog } from "./contracts.ts";

export type AuthKind = "oauth" | "key" | "cli" | "none";

export interface ProviderSpec {
  /** driverKind, and the default instance id. */
  kind: string;
  name: string;
  /** OpenAI-compatible base, no trailing slash. */
  url: string;
  auth: AuthKind;
  /** Where the key comes from, shown next to the field. */
  keyHint: string;
  /** Prefix a valid key starts with, used only as a typo warning. */
  keyPrefix?: string;
  docsUrl: string;
  /** Fallback catalog. The live /models list replaces this when it loads,
   * so these only have to be plausible, not current. */
  models: ModelCatalog;
  /** Model ids worth surfacing first, in order. Everything else is
   * dropped once the list is longer than `limit`. */
  prefer?: RegExp[];
  limit?: number;
  /** Extra request headers (attribution, routing). */
  headers?: Record<string, string>;
  /** A cheap model for one-shot calls: names, titles, summaries. */
  small?: string;
  /** Whether this provider reliably speaks OpenAI function calling. Flags
   * the engine as agentic and turns the tool loop on for its turns. Off
   * for providers where support depends on which model is loaded. */
  tools?: boolean;
}

const OPENROUTER: ProviderSpec = {
  kind: "openrouter",
  tools: true,
  name: "OpenRouter",
  url: "https://openrouter.ai/api/v1",
  auth: "oauth",
  keyHint: "Sign in and OpenRouter issues a key you control",
  keyPrefix: "sk-or-",
  docsUrl: "https://openrouter.ai/docs/use-cases/oauth-pkce",
  headers: { "HTTP-Referer": "https://bloks.local", "X-Title": "Bloks" },
  models: {
    default: "google/gemini-2.5-flash",
    options: [
      { id: "google/gemini-2.5-flash", label: "Gemini 2.5 Flash" },
      { id: "anthropic/claude-sonnet-4.5", label: "Claude Sonnet 4.5" },
      { id: "x-ai/grok-4", label: "Grok 4" },
      { id: "moonshotai/kimi-k2", label: "Kimi K2" },
      { id: "meta-llama/llama-4-maverick", label: "Llama 4 Maverick" },
      { id: "deepseek/deepseek-chat", label: "DeepSeek Chat" },
    ],
  },
  // one sign-in reaches every lab, so the list is long. Keep the families
  // people actually reach for.
  prefer: [/^google\//, /^anthropic\//, /^x-ai\//, /^openai\//, /^moonshotai\//, /^meta-llama\//, /^deepseek\//, /^qwen\//, /^mistralai\//],
  limit: 28,
  small: "google/gemini-2.5-flash",
};

const GEMINI: ProviderSpec = {
  kind: "gemini",
  tools: true,
  name: "Gemini",
  url: "https://generativelanguage.googleapis.com/v1beta/openai",
  auth: "key",
  keyHint: "API key from Google AI Studio",
  docsUrl: "https://ai.google.dev/gemini-api/docs/openai",
  models: {
    default: "gemini-2.5-flash",
    options: [
      { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
      { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
      { id: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash Lite" },
    ],
  },
  prefer: [/^(models\/)?gemini/],
  small: "gemini-2.5-flash-lite",
};

const XAI: ProviderSpec = {
  // kept as "grok" so instances configured before the catalog existed
  // keep resolving to a live driver instead of a shadow
  kind: "grok",
  tools: true,
  name: "Grok",
  url: "https://api.x.ai/v1",
  auth: "key",
  keyHint: "API key from console.x.ai",
  keyPrefix: "xai-",
  docsUrl: "https://docs.x.ai/docs/api-reference",
  models: {
    default: "grok-4",
    options: [
      { id: "grok-4", label: "Grok 4" },
      { id: "grok-4-fast", label: "Grok 4 Fast" },
      { id: "grok-3-mini", label: "Grok 3 Mini" },
    ],
  },
  prefer: [/^grok/],
  small: "grok-3-mini",
};

const MOONSHOT: ProviderSpec = {
  kind: "kimi",
  tools: true,
  name: "Kimi",
  url: "https://api.moonshot.ai/v1",
  auth: "key",
  keyHint: "API key from platform.moonshot.ai",
  keyPrefix: "sk-",
  docsUrl: "https://platform.moonshot.ai/docs/guide/migrating-from-openai-to-kimi",
  models: {
    default: "kimi-k2-turbo-preview",
    options: [
      { id: "kimi-k2-turbo-preview", label: "Kimi K2 Turbo" },
      { id: "kimi-k2-0905-preview", label: "Kimi K2" },
      { id: "moonshot-v1-32k", label: "Moonshot v1 32k" },
    ],
  },
  prefer: [/^kimi/, /^moonshot/],
};

const LLAMA: ProviderSpec = {
  kind: "llama",
  name: "Llama",
  url: "https://api.llama.com/compat/v1",
  auth: "key",
  keyHint: "API key from llama.developer.meta.com",
  keyPrefix: "LLM|",
  docsUrl: "https://llama.developer.meta.com/docs/features/compatibility/",
  models: {
    default: "Llama-4-Maverick-17B-128E-Instruct-FP8",
    options: [
      { id: "Llama-4-Maverick-17B-128E-Instruct-FP8", label: "Llama 4 Maverick" },
      { id: "Llama-4-Scout-17B-16E-Instruct-FP8", label: "Llama 4 Scout" },
    ],
  },
  prefer: [/llama/i],
};

const DEEPSEEK: ProviderSpec = {
  kind: "deepseek",
  tools: true,
  name: "DeepSeek",
  url: "https://api.deepseek.com/v1",
  auth: "key",
  keyHint: "API key from platform.deepseek.com",
  keyPrefix: "sk-",
  docsUrl: "https://api-docs.deepseek.com/",
  models: {
    default: "deepseek-chat",
    options: [
      { id: "deepseek-chat", label: "DeepSeek Chat" },
      { id: "deepseek-reasoner", label: "DeepSeek Reasoner" },
    ],
  },
  prefer: [/^deepseek/],
};

const MISTRAL: ProviderSpec = {
  kind: "mistral",
  tools: true,
  name: "Mistral",
  url: "https://api.mistral.ai/v1",
  auth: "key",
  keyHint: "API key from console.mistral.ai",
  docsUrl: "https://docs.mistral.ai/api/",
  models: {
    default: "mistral-large-latest",
    options: [
      { id: "mistral-large-latest", label: "Mistral Large" },
      { id: "mistral-small-latest", label: "Mistral Small" },
    ],
  },
  prefer: [/^mistral/, /^magistral/, /^codestral/],
  limit: 16,
  small: "mistral-small-latest",
};

const GROQ: ProviderSpec = {
  kind: "groq",
  tools: true,
  name: "Groq",
  url: "https://api.groq.com/openai/v1",
  auth: "key",
  keyHint: "API key from console.groq.com",
  keyPrefix: "gsk_",
  docsUrl: "https://console.groq.com/docs/openai",
  models: {
    default: "llama-3.3-70b-versatile",
    options: [
      { id: "llama-3.3-70b-versatile", label: "Llama 3.3 70B" },
      { id: "moonshotai/kimi-k2-instruct", label: "Kimi K2" },
    ],
  },
  prefer: [/llama/i, /kimi/i, /qwen/i, /gpt-oss/i],
  limit: 16,
};

const OLLAMA: ProviderSpec = {
  kind: "ollama",
  name: "Ollama",
  url: "http://127.0.0.1:11434/v1",
  auth: "none",
  keyHint: "Runs on this machine, nothing to sign in to",
  docsUrl: "https://ollama.com/",
  // whatever you have pulled; the live list is the real answer here
  models: { default: "llama3.2", options: [{ id: "llama3.2", label: "llama3.2" }] },
  limit: 24,
};

/** Every provider that speaks the OpenAI chat shape. */
export const PROVIDER_SPECS: readonly ProviderSpec[] = [
  OPENROUTER,
  GEMINI,
  XAI,
  MOONSHOT,
  LLAMA,
  DEEPSEEK,
  MISTRAL,
  GROQ,
  OLLAMA,
];

/** A user-added OpenAI-compatible host. The URL and keys live in
 * config.json, not here: this is only the driver shape, so one generic
 * instance can point at any /v1 that speaks chat completions. Tools stay
 * off because support depends on whatever is loaded behind that URL. */
export const CUSTOM_SPEC: ProviderSpec = {
  kind: "custom",
  name: "Custom",
  url: "",
  auth: "key",
  keyHint: "API key from your OpenAI-compatible endpoint",
  docsUrl: "https://platform.openai.com/docs/api-reference/models",
  models: { default: "", options: [] },
  limit: 32,
};

export function specFor(kind: string): ProviderSpec | undefined {
  if (kind === CUSTOM_SPEC.kind) return CUSTOM_SPEC;
  return PROVIDER_SPECS.find((s) => s.kind === kind);
}

/** The OpenAI-compatible root a person meant. Trailing slashes and a
 * pasted /chat/completions path are the two ways a working host becomes
 * a 404 on /models, so both get folded here rather than stored as typed. */
export function normalizeCompatUrl(url: string): string | undefined {
  const trimmed = url.trim();
  if (!/^https?:\/\//i.test(trimmed) || trimmed.length > 400) return undefined;
  try {
    const parsed = new URL(trimmed);
    if (parsed.username || parsed.password) return undefined;
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    let path = parsed.pathname.replace(/\/+$/, "");
    path = path.replace(/\/(chat\/)?completions$/i, "");
    return `${parsed.protocol}//${parsed.host}${path}`;
  } catch {
    return undefined;
  }
}

/** Engines that come from a CLI on this machine. They are not configured
 * here, only described, so the connections screen can tell you why one is
 * dark and what to install. */
// Two hints, not one: telling somebody to install a CLI they already
// have is the fastest way to look like nothing is listening.
export const CLI_PROVIDERS = [
  {
    kind: "claudeAgent",
    name: "Claude Code",
    auth: "cli" as const,
    keyHint: "Install with npm i -g @anthropic-ai/claude-code",
    signInHint: "Run claude once in a terminal to sign in",
    docsUrl: "https://claude.com/claude-code",
  },
  {
    kind: "codex",
    name: "Codex",
    auth: "cli" as const,
    keyHint: "Install with npm i -g @openai/codex",
    signInHint: "Run codex login in a terminal",
    docsUrl: "https://developers.openai.com/codex/cli",
  },
  {
    kind: "grokCli",
    name: "Grok CLI",
    auth: "cli" as const,
    keyHint: "Install with: curl -fsSL https://x.ai/cli/install.sh | bash",
    signInHint: "Run grok login to bind your grok.com subscription",
    docsUrl: "https://x.ai/cli",
  },
  {
    kind: "antigravity",
    name: "Antigravity",
    auth: "cli" as const,
    keyHint: "Install with: curl -fsSL https://antigravity.google/cli/install.sh | bash",
    signInHint: "Run agy once to sign in with Google",
    docsUrl: "https://github.com/google-antigravity/antigravity-cli",
  },
  {
    kind: "opencode",
    name: "OpenCode",
    auth: "cli" as const,
    keyHint: "Install with npm i -g opencode-ai",
    signInHint: "Run opencode auth login to connect a provider",
    docsUrl: "https://opencode.ai/docs",
  },
  {
    kind: "geminiCli",
    name: "Gemini CLI",
    auth: "cli" as const,
    keyHint: "Install with npm i -g @google/gemini-cli",
    // it reads GEMINI_API_KEY, so connecting Gemini below is enough; a
    // Google account sign-in through the CLI works too
    signInHint: "Connect a Gemini key below, or run gemini to sign in with Google",
    docsUrl: "https://geminicli.com/docs/",
  },
];
