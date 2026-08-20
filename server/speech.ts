// Agents get voices.
//
// One interface, several vendors: ElevenLabs when its key is present,
// OpenAI's speech API when that one is. The harness holds the keys and
// streams the audio through; a client never touches a vendor directly.
// Voices are listed live from vendors that have a catalog and from a
// fixed set where the vendor ships one, merged into a single picker.
//
// Text is capped before it becomes sound: TTS is billed per character,
// and a runaway reply should cost a sentence, not a chapter.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { AppConfig } from "./config.ts";

export interface Voice {
  provider: "elevenlabs" | "openai";
  id: string;
  name: string;
}

export interface BotVoice {
  provider: "elevenlabs" | "openai";
  id: string;
  name?: string;
}

export const SPEAK_MAX_CHARS = 2_500;

/** OpenAI ships a fixed cast; no listing round-trip needed. */
const OPENAI_VOICES = [
  "alloy",
  "ash",
  "coral",
  "echo",
  "fable",
  "nova",
  "onyx",
  "sage",
  "shimmer",
].map((id) => ({
  provider: "openai" as const,
  id,
  name: id[0].toUpperCase() + id.slice(1),
}));

/** An OpenAI key that already exists on this machine. The ChatGPT OAuth
 * Codex signs in with cannot call the speech API, but Codex's auth file
 * carries a real API key when the user linked one, and the environment
 * may too, either saves the user a paste. */
function discoveredOpenAIKey(): { key: string; source: "env" | "codex" } | null {
  if (process.env.OPENAI_API_KEY) return { key: process.env.OPENAI_API_KEY, source: "env" };
  try {
    const auth = JSON.parse(readFileSync(join(homedir(), ".codex", "auth.json"), "utf8"));
    if (typeof auth.OPENAI_API_KEY === "string" && auth.OPENAI_API_KEY) {
      return { key: auth.OPENAI_API_KEY, source: "codex" };
    }
  } catch {}
  return null;
}

function openaiKey(cfg: AppConfig): string | undefined {
  if (cfg.speech?.openaiKey) return cfg.speech.openaiKey;
  // a key found elsewhere is used only with explicit consent: it bills
  // an account the user set up for something else, and surprises about
  // money are the worst kind
  if (cfg.speech?.useDiscoveredOpenAI) return discoveredOpenAIKey()?.key;
  return undefined;
}

export function speechConfigured(cfg: AppConfig): {
  elevenlabs: boolean;
  openai: boolean;
  /** In use, from consented discovery: where it came from. */
  openaiSource?: "env" | "codex";
  /** Found but NOT in use: awaiting the user's yes. */
  openaiAvailable?: "env" | "codex";
} {
  const discovered = cfg.speech?.openaiKey ? null : discoveredOpenAIKey();
  const consented = Boolean(cfg.speech?.useDiscoveredOpenAI);
  return {
    elevenlabs: Boolean(cfg.speech?.elevenlabsKey),
    openai: Boolean(openaiKey(cfg)),
    ...(discovered && consented ? { openaiSource: discovered.source } : {}),
    ...(discovered && !consented ? { openaiAvailable: discovered.source } : {}),
  };
}

/** Every voice the current keys can actually produce. */
export async function listVoices(cfg: AppConfig): Promise<Voice[]> {
  const voices: Voice[] = [];
  if (cfg.speech?.elevenlabsKey) {
    try {
      const res = await fetch("https://api.elevenlabs.io/v1/voices", {
        headers: { "xi-api-key": cfg.speech.elevenlabsKey },
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) {
        const body: any = await res.json();
        for (const v of body.voices ?? []) {
          if (typeof v?.voice_id === "string" && typeof v?.name === "string") {
            voices.push({ provider: "elevenlabs", id: v.voice_id, name: v.name });
          }
        }
      }
    } catch {
      // the vendor being down should not empty the whole picker
    }
  }
  if (openaiKey(cfg)) voices.push(...OPENAI_VOICES);
  return voices;
}

/**
 * Text to a byte stream of speech. The vendor's own streaming endpoint
 * is used so playback can start before synthesis finishes.
 */
export async function speak(
  cfg: AppConfig,
  voice: BotVoice,
  text: string,
): Promise<{ stream: ReadableStream<Uint8Array>; mime: string }> {
  const clipped = text.slice(0, SPEAK_MAX_CHARS);
  if (voice.provider === "elevenlabs") {
    const key = cfg.speech?.elevenlabsKey;
    if (!key) throw new Error("no ElevenLabs key configured");
    const res = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice.id)}/stream?output_format=mp3_44100_128`,
      {
        method: "POST",
        headers: { "xi-api-key": key, "content-type": "application/json" },
        body: JSON.stringify({
          text: clipped,
          // the turbo model is the latency choice: a call that answers in
          // two seconds feels like a call, five feels like voicemail
          model_id: "eleven_turbo_v2_5",
        }),
        signal: AbortSignal.timeout(60_000),
      },
    );
    if (!res.ok || !res.body) {
      throw new Error(`ElevenLabs refused: ${res.status} ${(await res.text().catch(() => "")).slice(0, 140)}`);
    }
    return { stream: res.body, mime: "audio/mpeg" };
  }

  const key = openaiKey(cfg);
  if (!key) throw new Error("no OpenAI speech key configured");
  const res = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini-tts",
      voice: voice.id,
      input: clipped,
      response_format: "mp3",
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok || !res.body) {
    throw new Error(`OpenAI speech refused: ${res.status} ${(await res.text().catch(() => "")).slice(0, 140)}`);
  }
  return { stream: res.body, mime: "audio/mpeg" };
}

/** A client-supplied voice, shape-checked. */
export function parseBotVoice(raw: unknown): BotVoice | null | undefined {
  if (raw === null) return null;
  if (!raw || typeof raw !== "object") return undefined;
  const v = raw as Record<string, unknown>;
  if (v.provider !== "elevenlabs" && v.provider !== "openai") return undefined;
  if (typeof v.id !== "string" || !v.id || v.id.length > 120) return undefined;
  return {
    provider: v.provider,
    id: v.id,
    ...(typeof v.name === "string" ? { name: v.name.slice(0, 80) } : {}),
  };
}
