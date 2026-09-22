// Finding a model server that is already running here.
//
// The request this answers asked for Bloks to download a small model and
// start using it. We are not going to ship one: a bundled model is a
// licence, a few gigabytes, and a promise about hardware we cannot keep
// across every laptop this runs on. Ollama already does that job well,
// and plenty of people have it running before they ever open Bloks.
//
// What was missing is smaller and entirely ours. Ollama was in the
// engine list, needing nothing to sign in to, and still had to be
// connected by hand from Settings, which is a strange thing to ask of
// somebody whose model server is already answering on this machine. So
// we look, once, at boot.
//
// Only localhost, only the port Ollama documents, and only ever read. A
// probe that found nothing costs one refused connection.
import type { AppConfig } from "./config.ts";

/** Where Ollama listens unless its owner moved it. */
export const OLLAMA_URL = "http://127.0.0.1:11434";

export interface LocalModels {
  running: boolean;
  /** What it has pulled, which is the only honest model list for it. */
  models: string[];
}

/**
 * Ask a local Ollama what it has.
 *
 * Short timeout on purpose: this sits in the boot path, and somebody
 * without Ollama should not wait on it. Any failure at all means "not
 * running", because there is nothing here worth distinguishing.
 */
export async function probeOllama(baseUrl = OLLAMA_URL): Promise<LocalModels> {
  try {
    const response = await fetch(`${baseUrl}/v1/models`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) return { running: false, models: [] };
    const body = (await response.json()) as { data?: Array<{ id?: unknown }> };
    const models = (body.data ?? [])
      .map((entry) => (typeof entry.id === "string" ? entry.id : ""))
      .filter(Boolean)
      .slice(0, 50);
    // Answering but holding nothing is not useful yet: selecting it would
    // give somebody an engine with no model behind it.
    return { running: models.length > 0, models };
  } catch {
    return { running: false, models: [] };
  }
}

/**
 * Whether to connect it for them.
 *
 * Never over an entry that already exists, even an empty one: somebody
 * who disconnected Ollama on purpose should not find it back tomorrow,
 * and somebody who pointed it at another port should keep that.
 */
export function shouldAdopt(cfg: AppConfig, found: LocalModels): boolean {
  return found.running && !cfg.providers?.ollama;
}
