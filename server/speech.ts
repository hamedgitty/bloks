// Agents get voices.
//
// One interface, several vendors: ElevenLabs when its key is present,
// OpenAI's speech API when that one is, and on a Mac the voices macOS
// ships with, which need no key and no account, so every agent can talk
// from the first day. The harness holds the keys and
// streams the audio through; a client never touches a vendor directly.
// Voices are listed live from vendors that have a catalog and from a
// fixed set where the vendor ships one, merged into a single picker.
//
// Text is capped before it becomes sound: TTS is billed per character,
// and a runaway reply should cost a sentence, not a chapter.
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import type { AppConfig } from "./config.ts";

export interface Voice {
  provider: "elevenlabs" | "openai" | "system";
  id: string;
  name: string;
}

export interface BotVoice {
  provider: "elevenlabs" | "openai" | "system";
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

// ── the Mac's own voices ───────────────────────────────────────────────

/** The novelty voices macOS carries alongside the real ones. Offered to
 * nobody: an agent announcing a deploy in "Bubbles" is a joke once. */
const NOVELTY = new Set([
  "Albert", "Bad News", "Bahh", "Bells", "Boing", "Bubbles", "Cellos", "Good News", "Jester",
  "Organ", "Superstar", "Trinoids", "Whisper", "Wobble", "Zarvox", "Fred", "Junior", "Ralph", "Kathy",
]);

/** `say -v '?'` lines: "Samantha            en_US    # Hello! My name is Samantha." */
export function parseSayVoices(listing: string, languages = /^en_/): Voice[] {
  const voices: Voice[] = [];
  for (const line of listing.split("\n")) {
    const found = line.match(/^(.+?)\s+([a-z]{2,3}_[A-Za-z0-9]{2,4})\s+#/);
    if (!found) continue;
    const name = found[1].trim();
    if (!languages.test(found[2])) continue;
    if (NOVELTY.has(name) || NOVELTY.has(name.split(" (")[0])) continue;
    voices.push({ provider: "system", id: name, name: `${name} (${found[2].replace("_", "-")})` });
  }
  return voices;
}

let systemVoices: Promise<Voice[]> | null = null;

/** The Mac's voices, read once. Empty anywhere else. */
function macVoices(): Promise<Voice[]> {
  if (process.platform !== "darwin") return Promise.resolve([]);
  systemVoices ??= new Promise((resolve) => {
    execFile("/usr/bin/say", ["-v", "?"], { timeout: 10_000 }, (error, stdout) =>
      resolve(error ? [] : parseSayVoices(String(stdout))),
    );
  });
  return systemVoices;
}

/** Speech from `say`, as AAC in an M4A container every player takes. The
 * text goes in on stdin, so a reply never appears in a process listing. */
function sayToStream(voice: string, text: string): Promise<ReadableStream<Uint8Array>> {
  return new Promise((resolve, reject) => {
    const dir = mkdtempSync(join(tmpdir(), "bloks-say-"));
    const out = join(dir, "speech.m4a");
    const child = execFile(
      "/usr/bin/say",
      ["-v", voice, "-o", out, "--file-format=m4af", "--data-format=aac", "-f", "-"],
      { timeout: 60_000 },
      (error) => {
        try {
          if (error) throw error;
          const audio = readFileSync(out);
          resolve(Readable.toWeb(Readable.from([audio])) as ReadableStream<Uint8Array>);
        } catch (e) {
          reject(new Error(`the Mac voice could not speak: ${(e as Error).message}`));
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      },
    );
    child.stdin?.end(text);
  });
}

export function speechConfigured(cfg: AppConfig): {
  elevenlabs: boolean;
  openai: boolean;
  /** The Mac's own voices, which need nothing set up. */
  system: boolean;
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
    system: process.platform === "darwin",
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
  // last: the paid voices are the ones somebody set up on purpose
  voices.push(...(await macVoices()));
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
  if (voice.provider === "system") {
    if (process.platform !== "darwin") throw new Error("Mac voices only speak on a Mac");
    // only a voice the Mac actually lists, never an arbitrary argument
    if (!(await macVoices()).some((v) => v.id === voice.id)) throw new Error("that Mac voice is not installed");
    return { stream: await sayToStream(voice.id, clipped), mime: "audio/mp4" };
  }
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

// ── hearing, as well as speaking ──────────────────────────────────────
// The same keys turn speech into text, which is how a voice message sent
// from a phone becomes something an agent can read. Either vendor will
// do; ElevenLabs first, the same order as everything else here.

/** OpenAI's newer transcription model, which hears names and noisy
 * rooms better than whisper-1 does. */
export const OPENAI_TRANSCRIBE_MODEL = "gpt-transcribe";
export const ELEVENLABS_TRANSCRIBE_MODEL = "scribe_v2";

/** Who a voice message would be sent to, or null with no key at all. */
export function transcriptionVendor(cfg: AppConfig): "elevenlabs" | "openai" | null {
  if (cfg.speech?.elevenlabsKey) return "elevenlabs";
  if (openaiKey(cfg)) return "openai";
  return null;
}

/**
 * Audio to text. `name` matters more than it looks: the vendors read
 * the format from the filename, and refuse a Telegram voice note named
 * `.oga` though it is the same Ogg Opus they take as `.ogg`.
 */
export async function transcribe(cfg: AppConfig, audio: Uint8Array, name: string, mime: string): Promise<string> {
  const vendor = transcriptionVendor(cfg);
  if (!vendor) throw new Error("no speech key is set");
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(audio)], { type: mime }), name);
  let res: Response;
  if (vendor === "elevenlabs") {
    form.append("model_id", ELEVENLABS_TRANSCRIBE_MODEL);
    res = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
      method: "POST",
      headers: { "xi-api-key": cfg.speech!.elevenlabsKey! },
      body: form,
      signal: AbortSignal.timeout(120_000),
    });
  } else {
    form.append("model", OPENAI_TRANSCRIBE_MODEL);
    res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { authorization: `Bearer ${openaiKey(cfg)}` },
      body: form,
      signal: AbortSignal.timeout(120_000),
    });
  }
  // Only the status: this ends up in a reply on somebody's phone, and a
  // vendor's error body can echo more than belongs there.
  if (!res.ok) throw new Error(`${vendor === "elevenlabs" ? "ElevenLabs" : "OpenAI"} answered ${res.status}`);
  const body: any = await res.json().catch(() => null);
  return typeof body?.text === "string" ? body.text.trim() : "";
}

/** A client-supplied voice, shape-checked. */
export function parseBotVoice(raw: unknown): BotVoice | null | undefined {
  if (raw === null) return null;
  if (!raw || typeof raw !== "object") return undefined;
  const v = raw as Record<string, unknown>;
  if (v.provider !== "elevenlabs" && v.provider !== "openai" && v.provider !== "system") return undefined;
  if (typeof v.id !== "string" || !v.id || v.id.length > 120) return undefined;
  return {
    provider: v.provider,
    id: v.id,
    ...(typeof v.name === "string" ? { name: v.name.slice(0, 80) } : {}),
  };
}
